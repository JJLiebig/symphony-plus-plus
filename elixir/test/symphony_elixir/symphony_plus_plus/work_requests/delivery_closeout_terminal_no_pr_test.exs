defmodule SymphonyElixir.SymphonyPlusPlus.WorkRequests.DeliveryCloseoutTerminalNoPrTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.AccessGrant
  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.Service, as: AccessGrantService
  alias SymphonyElixir.SymphonyPlusPlus.AgentRuns.AgentRun
  alias SymphonyElixir.SymphonyPlusPlus.AgentRuns.Repository, as: AgentRunRepository
  alias SymphonyElixir.SymphonyPlusPlus.ClaimLeases.ClaimLease
  alias SymphonyElixir.SymphonyPlusPlus.ClaimLeases.Service, as: ClaimLeaseService
  alias SymphonyElixir.SymphonyPlusPlus.Planning.ProgressEvent
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Repository, as: PlanningRepository
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackageDelivery
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorktreeCleanupQueue
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorktreeLifecycle
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.DeliveryBoard
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Service
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest
  alias SymphonyElixir.TestSupport
  alias SymphonyElixir.WorkPackageFactory

  setup_all do
    database_path = database_path()

    start_supervised!({Repo, database: database_path, pool_size: 1})
    assert :ok = Repository.migrate(Repo)

    on_exit(fn -> File.rm(database_path) end)

    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    repo.delete_all(AgentRun)
    repo.delete_all(ClaimLease)
    repo.delete_all(AccessGrant)
    repo.delete_all(ProgressEvent)
    repo.delete_all(WorkPackageDelivery)
    repo.delete_all(WorkPackage)
    repo.delete_all(WorkPackage)
    repo.delete_all(WorkRequest)
    :ok
  end

  test "superseded closeout retires unclaimed worker authority and stale claim lease", %{repo: repo} do
    {work_request, work_package, linked_package} = linked_slice!(repo, status: "implementing")
    successor_slice = create_work_package!(repo, work_request, id: "WRS-DELIVERY-UNCLAIMED-SUCCESSOR")

    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, linked_package.id)
    assert {:ok, _whitespace_claim_metadata} = minted.grant |> AccessGrant.changeset(%{claimed_by: "   "}) |> repo.update()

    assert {:ok, claim_lease} =
             ClaimLeaseService.claim(
               repo,
               linked_package.id,
               %{
                 "actor_kind" => "agent",
                 "actor_id" => "local:stale-superseded-claim",
                 "actor_display_name" => "stale-worker"
               },
               now: DateTime.add(DateTime.utc_now(:microsecond), -10, :second),
               stale_after_ms: 1
             )

    assert {:ok, delivery} =
             Service.record_work_package_delivery(
               repo,
               work_request.id,
               work_package.id,
               delivery_attrs(%{
                 outcome: "superseded",
                 idempotency_key: "delivery-superseded-unclaimed-worker-authority",
                 successor_work_package_id: successor_slice.id,
                 superseded_reason: "Recut onto a concrete branch after the old worker authority went stale."
               })
             )

    assert delivery.outcome == "superseded"
    assert repo.get!(WorkPackage, linked_package.id).status == "closed"
    assert %AccessGrant{revoked_at: %DateTime{}, claimed_at: nil} = repo.get!(AccessGrant, minted.grant.id)
    assert %ClaimLease{status: "released", release_reason: "superseded_delivery_closeout"} = repo.get!(ClaimLease, claim_lease.id)

    events = repo.all(ProgressEvent)
    closeout_event = Enum.find(events, &(&1.payload["type"] == "work_request_delivery_closeout"))
    assert closeout_event.payload["retired_worker_grant_ids"] == [minted.grant.id]
    assert closeout_event.payload["retired_claim_lease_ids"] == [claim_lease.id]
    assert "claim_lease_stale" in closeout_event.payload["runtime_reason_codes_before_closeout"]

    assert {:ok, %{counts: %{"superseded" => 1}, work_packages: [slice, _successor]}} = DeliveryBoard.project(repo, work_request.id)
    assert slice.operational_state.key == "superseded"
    refute "work_package_active_after_delivery" in slice.attention_reason_codes
  end

  test "repository blocker exception still rejects active runtime at closeout mutation", %{repo: repo} do
    {work_request, work_package, linked_package} = linked_slice!(repo, status: "implementing")

    assert {:ok, _blocker} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: linked_package.id,
               summary: "Scope blocker still active",
               status: "blocked",
               idempotency_key: "delivery-recheck-active-blocker",
               payload: %{
                 type: "blocker",
                 source_tool: "report_blocker",
                 blocker_id: "spec-md-review-scope",
                 active: true,
                 reason: "Review scope was blocked before recut."
               }
             })

    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, linked_package.id)
    assert {:ok, _assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "active-worker")

    assert {:error, :active_runtime} =
             WorkPackageRepository.close_delivery_work_package(
               repo,
               work_request,
               work_package,
               "closed",
               allow_active_blockers?: true
             )

    assert repo.get!(WorkPackage, linked_package.id).status == "implementing"
    assert %AccessGrant{revoked_at: nil} = repo.get!(AccessGrant, minted.grant.id)
  end

  test "abandoned closeout clears missing managed worktree after durable closeout", %{repo: repo} do
    {work_request, work_package, linked_package} =
      linked_slice!(
        repo,
        work_request_id: "WR-DELIVERY-ABANDONED-STALE-RUNTIME",
        status: "ready_for_worker"
      )

    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-closeout-missing-worktree")
    codex_home = Path.join(fixture.root, "codex-home")
    previous_codex_home = System.get_env("CODEX_HOME")

    try do
      System.put_env("CODEX_HOME", codex_home)

      assert {:ok, prepared} =
               WorktreeLifecycle.prepare(
                 repo,
                 linked_package.id,
                 %{
                   "repo_root" => fixture.repo_root,
                   "base_branch" => "main",
                   "branch" => "feat/abandoned-stale-runtime"
                 },
                 codex_home: codex_home
               )

      File.rm_rf!(prepared.worktree_path)

      assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, linked_package.id)

      assert {:ok, claim_lease} =
               ClaimLeaseService.claim(
                 repo,
                 linked_package.id,
                 %{
                   "actor_kind" => "agent",
                   "actor_id" => "local:stale-abandoned-claim",
                   "actor_display_name" => "stale-abandoned-worker"
                 },
                 now: DateTime.add(DateTime.utc_now(:microsecond), -10, :second),
                 stale_after_ms: 1
               )

      assert {:ok, agent_run} =
               AgentRunRepository.start_run(repo, %{
                 work_package_id: linked_package.id,
                 status: "running",
                 last_seen_at: DateTime.add(DateTime.utc_now(:microsecond), -301, :second)
               })

      attrs =
        delivery_attrs(%{
          outcome: "abandoned",
          idempotency_key: "delivery-abandoned-stale-runtime",
          abandoned_rationale: "Worker bootstrap failed before implementation; operator cleaned the worktree."
        })

      assert {:ok, delivery} = Service.record_work_package_delivery(repo, work_request.id, work_package.id, attrs)
      assert delivery.outcome == "abandoned"
      assert repo.get!(WorkPackage, linked_package.id).status == "abandoned"
      assert :ok = WorktreeCleanupQueue.reconcile(repo, codex_home: codex_home)
      assert repo.get!(WorkPackage, linked_package.id).worktree_path == nil
      assert %AccessGrant{revoked_at: %DateTime{}, claimed_at: nil} = repo.get!(AccessGrant, minted.grant.id)
      assert %ClaimLease{status: "released", release_reason: "abandoned_delivery_closeout"} = repo.get!(ClaimLease, claim_lease.id)

      events = repo.all(ProgressEvent)
      closeout_event = Enum.find(events, &(&1.payload["type"] == "work_request_delivery_closeout"))
      assert closeout_event.payload["retired_worker_grant_ids"] == [minted.grant.id]
      assert closeout_event.payload["retired_claim_lease_ids"] == [claim_lease.id]
      assert closeout_event.payload["ignored_stale_agent_run_ids"] == [agent_run.id]
      assert "claim_lease_stale" in closeout_event.payload["runtime_reason_codes_before_closeout"]
      assert "agent_run_stale" in closeout_event.payload["runtime_reason_codes_before_closeout"]
    after
      restore_env("CODEX_HOME", previous_codex_home)
    end
  end

  test "abandoned closeout retires claimed worker authority", %{repo: repo} do
    {work_request, work_package, linked_package} =
      linked_slice!(
        repo,
        work_request_id: "WR-DELIVERY-ABANDONED-CLAIMED-WORKER",
        status: "ready_for_worker"
      )

    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, linked_package.id)
    assert {:ok, _assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "active-worker")

    assert {:ok, delivery} =
             Service.record_work_package_delivery(
               repo,
               work_request.id,
               work_package.id,
               delivery_attrs(%{
                 outcome: "abandoned",
                 idempotency_key: "delivery-abandoned-claimed-worker",
                 abandoned_rationale: "No code was produced; the architect is retiring the worker authority."
               })
             )

    assert delivery.outcome == "abandoned"
    assert repo.get!(WorkPackage, linked_package.id).status == "abandoned"
    assert %AccessGrant{revoked_at: %DateTime{}} = repo.get!(AccessGrant, minted.grant.id)
  end

  test "abandoned closeout rejects packages that reached implementation states", %{repo: repo} do
    for {status, request_id} <- [
          {"blocked", "WR-DELIVERY-ABANDONED-BLOCKED"},
          {"implementing", "WR-DELIVERY-ABANDONED-IMPLEMENTING"},
          {"ready_for_merge", "WR-DELIVERY-ABANDONED-MERGE-READY"}
        ] do
      {work_request, work_package, linked_package} =
        linked_slice!(
          repo,
          work_request_id: request_id,
          status: status
        )

      assert {:error, :work_package_not_abandonable} =
               Service.record_work_package_delivery(
                 repo,
                 work_request.id,
                 work_package.id,
                 delivery_attrs(%{
                   outcome: "abandoned",
                   idempotency_key: "delivery-abandoned-#{status}",
                   abandoned_rationale: "No-code abandoned repair must not hide implementation state."
                 })
               )

      assert repo.get!(WorkPackage, linked_package.id).status == status
    end

    assert repo.aggregate(WorkPackageDelivery, :count, :id) == 0
  end

  defp linked_slice!(repo, overrides) do
    kind = Keyword.get(overrides, :kind, "mcp")
    status = Keyword.get(overrides, :status, "reviewing")
    request_id = Keyword.get_lazy(overrides, :work_request_id, fn -> "WR-DELIVERY-#{System.unique_integer([:positive])}" end)

    work_request = create_work_request!(repo, id: request_id, status: "ready_for_slicing")
    work_package = create_work_package!(repo, work_request, id: "WRS-#{request_id}", kind: kind)
    assert {:ok, approved_slice} = CanonicalWorkPackageFixtures.approve_work_package(repo, work_request.id, work_package.id, "planned")
    work_package_id = Keyword.get(overrides, :work_package_id, "WP-#{request_id}")

    work_package =
      create_matching_work_package!(repo, work_request, approved_slice,
        id: work_package_id,
        status: status
      )

    assert {:ok, dispatched_slice} = CanonicalWorkPackageFixtures.dispatch_work_package(repo, work_request.id, approved_slice.id, "approved", work_package.id)

    {work_request, dispatched_slice, work_package}
  end

  defp create_work_request!(repo, overrides) do
    assert {:ok, work_request} = Repository.create(repo, work_request_attrs(overrides))
    work_request
  end

  defp create_work_package!(repo, work_request, overrides) do
    attrs = work_package_attrs(overrides)
    assert {:ok, work_package} = CanonicalWorkPackageFixtures.add_work_package(repo, work_request.id, attrs)
    work_package
  end

  defp create_matching_work_package!(repo, work_request, work_package, overrides) do
    attrs =
      [
        kind: work_package.kind,
        title: work_package.title,
        repo: work_request.repo,
        base_branch: work_package.base_branch,
        branch_pattern: work_package.branch_pattern,
        product_description: work_request.human_description,
        allowed_file_globs: work_package.allowed_file_globs,
        acceptance_criteria: work_package.acceptance_criteria
      ]
      |> Keyword.merge(overrides)
      |> WorkPackageFactory.attrs()

    assert {:ok, work_package} = WorkPackageRepository.create(repo, attrs)
    work_package
  end

  defp work_request_attrs(overrides) do
    defaults = %{
      id: "WR-DELIVERY-#{System.unique_integer([:positive])}",
      title: "Close delivered WorkRequest slices",
      repo: "nextide/example",
      base_branch: "main",
      work_type: "feature",
      human_description: "Record closeout truth for delivered slices.",
      constraints: %{"allowed_paths" => ["elixir/lib"], "forbidden_paths" => [], "requires_secret" => false},
      desired_dispatch_shape: "architect_led_feature_branch"
    }

    Enum.into(overrides, defaults)
  end

  defp work_package_attrs(overrides) do
    defaults = %{
      title: "Close delivered slice",
      goal: "Record terminal delivery state.",
      kind: "mcp",
      base_branch: "main",
      branch_pattern: "feat/delivery-closeout",
      allowed_file_globs: ["elixir/lib/symphony_elixir/symphony_plus_plus/work_requests/**"],
      forbidden_file_globs: ["elixir/assets/**"],
      acceptance_criteria: ["Delivery closeout is transactional."],
      validation_steps: ["mix test test/symphony_elixir/symphony_plus_plus/work_request_delivery_closeout_test.exs"],
      review_requirement: %{"type" => "review-suite", "args" => %{"mode" => "normal"}},
      stop_conditions: ["Do not bypass delivery semantics."]
    }

    Enum.into(overrides, defaults)
  end

  defp delivery_attrs(overrides) do
    defaults = %{
      idempotency_key: "delivery-#{System.unique_integer([:positive])}",
      recorded_by: "delivery-closeout-test"
    }

    Enum.into(overrides, defaults)
  end

  defp database_path do
    Path.join(System.tmp_dir!(), "sympp-work-request-delivery-closeout-#{System.os_time(:nanosecond)}-#{System.unique_integer([:positive])}.sqlite3")
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)
end
