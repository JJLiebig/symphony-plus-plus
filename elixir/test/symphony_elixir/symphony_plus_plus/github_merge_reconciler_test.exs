defmodule SymphonyElixir.SymphonyPlusPlus.GitHubMergeReconcilerTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.FakeGitHubClient
  alias SymphonyElixir.GitHubPullRequestFixtures
  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.AccessGrant
  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.Service, as: AccessGrantService

  alias SymphonyElixir.SymphonyPlusPlus.GitHub.{MergeReconciler, PullRequestProgress}

  alias SymphonyElixir.SymphonyPlusPlus.Lifecycle.Service, as: LifecycleService
  alias SymphonyElixir.SymphonyPlusPlus.Phases.Phase
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Artifact
  alias SymphonyElixir.SymphonyPlusPlus.Planning.ProgressEvent
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Repository, as: PlanningRepository
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackageDelivery
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest
  alias SymphonyElixir.TestSupport
  alias SymphonyElixir.WorkPackageFactory

  setup_all do
    database_path = WorkPackageFactory.database_path()

    start_supervised!({Repo, database: database_path, pool_size: 1})
    assert :ok = WorkPackageRepository.migrate(Repo)

    on_exit(fn -> File.rm(database_path) end)

    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    repo.delete_all(Artifact)
    repo.delete_all(ProgressEvent)
    repo.delete_all(AccessGrant)
    repo.delete_all(WorkPackageDelivery)
    repo.delete_all(WorkPackage)
    repo.delete_all(WorkRequest)
    repo.delete_all(Phase)
    FakeGitHubClient.clear()
    :ok
  end

  test "PR progress helpers preserve created_at precedence over legacy sequences" do
    old_event = %ProgressEvent{
      id: "old-pr",
      sequence: 200,
      created_at: ~U[2026-05-20 12:00:00Z],
      payload: %{
        "type" => "pr",
        "source_tool" => "attach_pr",
        "url" => "https://github.com/nextide/repo/pull/1",
        "repository" => "nextide/repo",
        "number" => 1,
        "head_sha" => "old-head"
      }
    }

    new_event = %ProgressEvent{
      id: "new-pr",
      sequence: 1,
      created_at: ~U[2026-05-21 12:00:00Z],
      payload: %{
        "type" => "pr",
        "source_tool" => "attach_pr",
        "url" => "https://github.com/nextide/repo/pull/2",
        "repository" => "nextide/repo",
        "number" => 2,
        "head_sha" => "new-head"
      }
    }

    assert {:ok, %{ref: %{number: 2}, payload: %{"head_sha" => "new-head"}}} =
             PullRequestProgress.current_pr_state([new_event, old_event], ["attach_pr"])
  end

  test "merged PR matches a package scoped to its local checkout", %{repo: repo} do
    repo_path = TestSupport.git_repo_with_origin_fixture!("https://github.com/nextide/repo.git", prefix: "sympp-sync-pr-repo")
    assert {:ok, package} = create_package(repo, id: "SYMPP-GH-LOCAL-REPO", repo: repo_path, status: "ready_for_merge")
    append_pr_evidence(repo, package, 27, "head-local")
    FakeGitHubClient.put_response("nextide/repo", 27, GitHubPullRequestFixtures.metadata(27, "head-local", merged?: true))

    assert {:ok, result} = MergeReconciler.reconcile(repo, client: FakeGitHubClient)
    assert [%{status: "merged", reason: "github_pr_merged"}] = result.results
    assert repo.get!(WorkPackage, package.id).status == "merged"
  end

  test "merge transition rolls back when merge evidence cannot be recorded", %{repo: repo} do
    assert {:ok, package} = create_package(repo, id: "SYMPP-GH-EVIDENCE-FAIL", status: "ready_for_merge")
    append_pr_evidence(repo, package, 9, "head-a")

    assert {:ok, _existing_event} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: package.id,
               summary: "Pre-existing merge reconciliation key",
               status: "test_merge_evidence_collision",
               idempotency_key: "operator_github_merge:#{package.id}:head-a",
               payload: %{type: "test_collision"}
             })

    FakeGitHubClient.put_response("nextide/repo", 9, GitHubPullRequestFixtures.metadata(9, "head-a", merged?: true))

    assert {:ok, result} = MergeReconciler.reconcile(repo, client: FakeGitHubClient)

    assert result.error_count == 1
    assert result.dashboard_changed
    assert [%{status: "error", reason: "merge_evidence_conflict"}] = result.results
    assert {:ok, updated} = WorkPackageRepository.get(repo, package.id)
    assert updated.status == "ready_for_merge"

    assert {:ok, events} = PlanningRepository.list_progress_events(repo, package.id)
    refute Enum.any?(events, &match?(%ProgressEvent{status: "github_pr_merged"}, &1))
  end

  test "worker grant still cannot mark a package merged", %{repo: repo} do
    assert {:ok, package} = create_package(repo, id: "SYMPP-GH-WORKER-DENIED", status: "ready_for_merge")
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")

    assert {:error, :worker_cannot_mark_merged} =
             LifecycleService.transition(repo, package.id, "merged", Map.from_struct(assignment))
  end

  defp create_package(repo, overrides) do
    attrs =
      overrides
      |> Keyword.put_new(:kind, "hotfix")
      |> Keyword.put_new(:repo, "nextide/repo")
      |> Keyword.put_new(:base_branch, "main")
      |> WorkPackageFactory.attrs()

    WorkPackageRepository.create(repo, attrs)
  end

  defp append_pr_evidence(repo, package, number, head_sha) do
    append_branch_evidence(repo, package, head_sha)
    append_attached_pr_evidence(repo, package, number, head_sha)
  end

  defp append_branch_evidence(repo, package, head_sha) do
    assert {:ok, _branch} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: package.id,
               summary: "Branch attached",
               status: "branch_attached",
               payload: %{type: "branch", source_tool: "attach_branch", branch: "agent/#{package.id}", head_sha: head_sha}
             })
  end

  defp append_attached_pr_evidence(repo, package, number, head_sha) do
    assert {:ok, _pr} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: package.id,
               summary: "PR attached",
               status: "pr_attached",
               payload: %{type: "pr", source_tool: "attach_pr", url: "https://github.com/nextide/repo/pull/#{number}", head_sha: head_sha}
             })
  end
end
