defmodule SymphonyElixir.SymphonyPlusPlus.WorkRequestDeliveryBoardTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.SymphonyPlusPlus.AgentRuns.AgentRun
  alias SymphonyElixir.SymphonyPlusPlus.AgentRuns.Repository, as: AgentRunRepository
  alias SymphonyElixir.SymphonyPlusPlus.Planning.ProgressEvent
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Repository, as: PlanningRepository
  alias SymphonyElixir.SymphonyPlusPlus.ProductTree.DependencyEdge
  alias SymphonyElixir.SymphonyPlusPlus.ProductTree.Node
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackageActivity
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackageDelivery
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.DeliveryBoard
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.DeliveryBoard.Signals
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest

  defmodule MissingProductTreeRepo do
    def all(_query), do: raise(%Exqlite.Error{message: "no such table: sympp_product_tree_nodes"})
  end

  defmodule LockedLineageRepo do
    def all(_query), do: raise(%Exqlite.Error{message: "database is locked"})
  end

  setup_all do
    database_path = database_path()

    start_supervised!({Repo, database: database_path, pool_size: 1})
    assert :ok = Repository.migrate(Repo)

    on_exit(fn -> File.rm(database_path) end)

    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    repo.delete_all(AgentRun)
    repo.delete_all(ProgressEvent)
    repo.delete_all(WorkPackageDelivery)
    repo.delete_all(DependencyEdge)
    repo.delete_all(Node)
    repo.delete_all(WorkPackage)
    repo.delete_all(WorkRequest)
    :ok
  end

  test "keeps delivery signals available before product-tree migrations" do
    work_request = %WorkRequest{id: "WR-BOARD-LEGACY"}

    assert {:ok, %{}} =
             Signals.execution_graphs(
               MissingProductTreeRepo,
               [work_request],
               %{work_request.id => []},
               %{},
               []
             )
  end

  test "live architect runs project actors without becoming worker activity" do
    now = DateTime.utc_now(:microsecond)
    package = %WorkPackage{id: "WP-ARCHITECT-ACTOR", kind: "delegation", status: "planning", owner_id: "accountable-owner"}
    grant = %SymphonyElixir.SymphonyPlusPlus.AccessGrants.AccessGrant{id: "architect-grant", grant_role: "architect", claimed_at: now}
    run = %AgentRun{id: "architect-run", status: "running", access_grant_id: grant.id, actor_id: "live-architect", started_at: now, last_seen_at: now}
    context = WorkPackageActivity.project_context([grant], [run], [], [], package)
    assert context.worker_signal == nil
    assert context.runtime_state.active?
    activity = Signals.activity(package, context, %{key: "active"}, [], [])
    assert activity["current_actor"]["id"] == "live-architect"
    assert activity["current_actor"]["role"] == "architect"
    assert activity["accountable_owner"]["id"] == "accountable-owner"
    assert activity["observation_state"] == "current"
  end

  test "returns lineage read failures from graph construction" do
    request = %WorkRequest{id: "WR-LOCKED-LINEAGE"}
    package = %WorkPackage{id: "WP-RETIRED", work_request_id: request.id, status: "skipped"}
    trees = %{request.id => {:ok, %{nodes: [], dependency_edges: []}}}

    assert {:error, {:storage_failed, "database is locked"}} =
             Signals.execution_graphs(LockedLineageRepo, [request], %{request.id => [package]}, %{}, product_trees_by_request: trees)
  end

  test "terminal delivery outcome suppresses stale blocked attention while preserving raw detail", %{repo: repo} do
    work_request = create_work_request!(repo, id: "WR-BOARD-STALE")

    {work_package, linked_package} =
      linked_slice!(repo, work_request,
        id: "WRS-BOARD-STALE",
        work_package_id: "WP-BOARD-STALE",
        status: "blocked"
      )

    assert {:ok, _blocker} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: linked_package.id,
               summary: "Still appears blocked",
               status: "blocked",
               idempotency_key: "delivery-board-stale-blocker",
               payload: %{type: "blocker", source_tool: "report_blocker", blocker_id: "stale", active: true}
             })

    assert {:ok, _pr} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: linked_package.id,
               summary: "PR attached",
               status: "pr_attached",
               payload: %{
                 type: "pr",
                 source_tool: "attach_pr",
                 url: "https://github.com/nextide/symphony-plus-plus/pull/901",
                 number: 901,
                 repository: "nextide/symphony-plus-plus",
                 head_sha: "head-901",
                 check_summary: %{status: "completed", conclusion: "success", completed: 3, total: 3},
                 provider: "github"
               }
             })

    assert {:ok, _delivery} =
             Repository.record_work_package_delivery(
               repo,
               work_request.id,
               work_package.id,
               delivery_attrs(%{
                 outcome: "pr_merged",
                 idempotency_key: "delivery-board-pr-merged",
                 pr_url: "https://github.com/nextide/symphony-plus-plus/pull/901",
                 pr_number: 901,
                 pr_repository: "nextide/symphony-plus-plus",
                 pr_merged_at: ~U[2026-05-24 12:00:00.000000Z],
                 merge_commit_sha: "abc901"
               })
             )

    assert {:ok, %{work_packages: [slice]}} = DeliveryBoard.project(repo, work_request.id)
    assert slice.operational_state.key == "delivered"
    assert slice.operational_state.raw_status == "blocked"
    assert slice.work_package.raw_status == "blocked"

    assert %{
             status: "merged",
             url: "https://github.com/nextide/symphony-plus-plus/pull/901",
             number: 901,
             repository: "nextide/symphony-plus-plus",
             head_sha: "head-901",
             checks: %{status: "passing", current: 3, total: 3}
           } = slice.work_package.pr_signal

    assert slice.attention_reason_codes == []
    assert slice.operational_state.attention_items == []
    refute WorkPackageActivity.context(repo, linked_package.id).blocker_state.active?
  end

  test "terminal delivery retains pre-existing live runtime attention", %{repo: repo} do
    work_request = create_work_request!(repo, id: "WR-BOARD-LIVE-RUNTIME")

    {work_package, linked_package} =
      linked_slice!(repo, work_request,
        id: "WRS-BOARD-LIVE-RUNTIME",
        work_package_id: "WP-BOARD-LIVE-RUNTIME",
        status: "ready_for_merge"
      )

    assert {:ok, _run} =
             AgentRunRepository.start_run(repo, %{
               work_package_id: linked_package.id,
               status: "running",
               attempt: 1,
               worker_task_handle: "pre-delivery-runtime",
               started_at: DateTime.utc_now(:microsecond),
               last_seen_at: DateTime.utc_now(:microsecond)
             })

    assert {:ok, _delivery} =
             Repository.record_work_package_delivery(
               repo,
               work_request.id,
               work_package.id,
               delivery_attrs(%{
                 outcome: "completed_no_pr",
                 idempotency_key: "delivery-board-live-runtime",
                 no_pr_evidence: "The package was completed without a pull request."
               })
             )

    assert {:ok, %{work_packages: [slice]}} = DeliveryBoard.project(repo, work_request.id)
    assert slice.operational_state.key == "completed_no_pr"
    assert slice.attention_reason_codes == ["work_package_active_after_delivery"]
  end

  test "progress metadata projects as allowlisted summaries", %{repo: repo} do
    work_request = create_work_request!(repo, id: "WR-BOARD-PROGRESS-SUMMARIES")

    {_work_package, linked_package} =
      linked_slice!(repo, work_request,
        id: "WRS-BOARD-PROGRESS-SUMMARIES",
        work_package_id: "WP-BOARD-PROGRESS-SUMMARIES",
        status: "reviewing",
        review_requirement: %{"type" => "human"}
      )

    assert {:ok, _branch} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: linked_package.id,
               summary: "Branch attached",
               status: "branch_attached",
               payload: %{
                 type: "branch",
                 source_tool: "attach_branch",
                 branch: "feat/delivery-board",
                 head_sha: "branch-head",
                 raw_context: "do not expose"
               }
             })

    assert {:ok, _pr} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: linked_package.id,
               summary: "PR synced",
               status: "pr_synced",
               payload: %{
                 type: "pr",
                 source_tool: "sync_pr",
                 url: "https://github.com/nextide/symphony-plus-plus/pull/906",
                 head_sha: "pr-head",
                 merge_state: %{merged: false, raw_payload: "do not expose"},
                 raw_context: "do not expose"
               }
             })

    assert {:ok, %{work_packages: [slice]}} = DeliveryBoard.project(repo, work_request.id)

    assert slice.work_package.branch == %{
             type: "branch",
             source_tool: "attach_branch",
             branch: "feat/delivery-board",
             head_sha: "branch-head"
           }

    assert slice.work_package.pr.url == "https://github.com/nextide/symphony-plus-plus/pull/906"
    assert slice.work_package.pr.merge_state == %{merged: false}
    refute Map.has_key?(slice.work_package.branch, :raw_context)
    refute Map.has_key?(slice.work_package.pr, :raw_context)
    refute Map.has_key?(slice.work_package.pr.merge_state, :raw_payload)
  end

  test "scoped projection treats filtered linked packages as hidden instead of missing", %{repo: repo} do
    work_request = create_work_request!(repo, id: "WR-BOARD-HIDDEN-PACKAGE")

    {work_package, _linked_package} =
      linked_slice!(repo, work_request,
        id: "WRS-BOARD-HIDDEN-PACKAGE",
        work_package_id: "WP-BOARD-HIDDEN-PACKAGE",
        status: "ready_for_merge"
      )

    assert {:ok, %{work_packages: [slice]}} = DeliveryBoard.project(repo, work_request.id, visible_work_package_ids: [])
    assert slice.work_package == nil
    assert slice.work_package_hidden? == true
    assert slice.operational_state.key == "dispatched"
    assert slice.attention_reason_codes == []

    assert {:ok, _delivery} =
             Repository.record_work_package_delivery(
               repo,
               work_request.id,
               work_package.id,
               delivery_attrs(%{
                 outcome: "completed_no_pr",
                 idempotency_key: "delivery-board-hidden-package",
                 no_pr_evidence: "The hidden package was completed without a pull request."
               })
             )

    assert {:ok, %{work_packages: [delivered_slice]}} =
             DeliveryBoard.project(repo, work_request.id, visible_work_package_ids: [])

    assert delivered_slice.work_package == nil
    assert delivered_slice.work_package_hidden? == true
    assert delivered_slice.operational_state.key == "completed_no_pr"
    assert delivered_slice.attention_reason_codes == []
  end

  test "preloaded blocked raw state does not imply active blocker evidence", %{repo: repo} do
    work_request = create_work_request!(repo, id: "WR-BOARD-RESOLVED-BLOCKER")

    {_work_package, linked_package} =
      linked_slice!(repo, work_request,
        id: "WRS-BOARD-RESOLVED-BLOCKER",
        work_package_id: "WP-BOARD-RESOLVED-BLOCKER",
        status: "blocked"
      )

    work_package_contexts = %{
      linked_package.id => %{
        work_package: linked_package,
        card: %{operational_state: %{key: "blocked", attention_items: []}}
      }
    }

    assert {:ok, %{work_packages: [slice]}} =
             DeliveryBoard.project(repo, work_request.id, work_package_contexts: work_package_contexts)

    assert slice.operational_state.key == "blocked"
    assert slice.attention_reason_codes == []
  end

  defp linked_slice!(repo, work_request, overrides) do
    work_package_id = Keyword.fetch!(overrides, :work_package_id)
    status = Keyword.get(overrides, :status, "ready_for_worker")

    work_package =
      create_work_package!(
        repo,
        work_request,
        overrides
        |> Keyword.drop([:work_package_id])
        |> Keyword.put(:id, work_package_id)
        |> Keyword.put(:status, status)
        |> Keyword.put(:dispatched_at, DateTime.utc_now(:microsecond))
      )

    {work_package, work_package}
  end

  defp create_work_request!(repo, overrides) do
    assert {:ok, work_request} = Repository.create(repo, work_request_attrs(overrides))
    work_request
  end

  defp create_work_package!(repo, work_request, overrides) do
    assert {:ok, work_package} = CanonicalWorkPackageFixtures.add_work_package(repo, work_request.id, work_package_attrs(overrides))
    work_package
  end

  defp work_request_attrs(overrides) do
    defaults = %{
      id: "WR-BOARD-#{System.unique_integer([:positive])}",
      title: "Project WorkRequest delivery board",
      repo: "nextide/example",
      base_branch: "main",
      work_type: "feature",
      human_description: "Expose delivery-board truth.",
      constraints: %{"allowed_paths" => ["elixir/lib"], "forbidden_paths" => [], "requires_secret" => false},
      desired_dispatch_shape: "architect_led_feature_branch",
      status: "ready_for_slicing"
    }

    Enum.into(overrides, defaults)
  end

  defp work_package_attrs(overrides) do
    defaults = %{
      id: "WRS-BOARD-#{System.unique_integer([:positive])}",
      title: "Add delivery-board projection",
      goal: "Project slice delivery state.",
      kind: "mcp",
      base_branch: "main",
      branch_pattern: "feat/delivery-board",
      allowed_file_globs: ["elixir/lib/symphony_elixir/symphony_plus_plus/work_requests/**"],
      forbidden_file_globs: ["elixir/assets/**"],
      acceptance_criteria: ["Projection is shared."],
      validation_steps: ["mix test test/symphony_elixir/symphony_plus_plus/work_request_delivery_board_test.exs"],
      review_requirement: %{"type" => "review-suite", "args" => %{"mode" => "normal"}},
      stop_conditions: ["Do not parse decision text."]
    }

    Enum.into(overrides, defaults)
  end

  defp delivery_attrs(overrides) do
    defaults = %{
      idempotency_key: "delivery-board-#{System.unique_integer([:positive])}",
      recorded_by: "delivery-board-test"
    }

    Enum.into(overrides, defaults)
  end

  defp database_path do
    Path.join(System.tmp_dir!(), "sympp-work-request-delivery-board-#{System.os_time(:nanosecond)}-#{System.unique_integer([:positive])}.sqlite3")
  end
end
