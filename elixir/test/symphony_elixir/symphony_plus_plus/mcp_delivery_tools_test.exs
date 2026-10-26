Code.require_file("../../support/mcp_harness.exs", __DIR__)
Code.require_file("../../support/symphony_plus_plus/mcp_session_helpers.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCPDeliveryToolsTest do
  use ExUnit.Case, async: false

  import SymphonyElixir.SymphonyPlusPlus.MCPCase.SessionHelpers,
    only: [create_phase_architect_session: 4, create_work_request_handoff_architect_session: 3]

  alias SymphonyElixir.MCPHarness
  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.AccessGrant
  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.GrantScope
  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.Service, as: AccessGrantService
  alias SymphonyElixir.SymphonyPlusPlus.ClaimLeases.ClaimLease
  alias SymphonyElixir.SymphonyPlusPlus.Dashboard
  alias SymphonyElixir.SymphonyPlusPlus.MCP.{Config, Session}
  alias SymphonyElixir.SymphonyPlusPlus.Phases.Phase
  alias SymphonyElixir.SymphonyPlusPlus.Phases.Repository, as: PhaseRepository
  alias SymphonyElixir.SymphonyPlusPlus.Planning.ProgressEvent
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Repository, as: PlanningRepository
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackageDelivery

  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.{
    ArchitectHandoff,
    WorkRequest
  }

  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository, as: WorkRequestRepository
  alias SymphonyElixir.WorkPackageFactory

  setup_all do
    database_path = WorkPackageFactory.database_path()

    start_supervised!({Repo, database: database_path, pool_size: 1})
    assert :ok = WorkPackageRepository.migrate(Repo)

    on_exit(fn -> File.rm(database_path) end)

    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    schemas = [
      ProgressEvent,
      WorkPackageDelivery,
      WorkPackage,
      ClaimLease,
      GrantScope,
      AccessGrant,
      WorkRequest,
      WorkPackage,
      Phase
    ]

    for schema <- schemas do
      repo.delete_all(schema)
    end

    :ok
  end

  test "closed execution reads consistently without fulfilling abandoned scope and reconciliation keeps full evidence on demand", %{repo: repo} do
    work_request = create_work_request!(repo, id: "WR-CLOSED-EXECUTION", status: "sliced")
    session = create_work_request_architect_session(repo, work_request, ArchitectHandoff.capabilities())

    read = fn tool, args ->
      response = mcp_tool(repo, session, tool, args)
      assert response["error"] == nil
      get_in(response, ["result", "structuredContent"])
    end

    assert read.("read_work_request", %{"detail" => "full", "work_request_id" => work_request.id})["work_request"]["execution_status"] == "open"

    packages =
      for index <- 1..25 do
        status = if index == 25, do: "planned", else: if(index == 2, do: "ready_for_worker", else: "reviewing")
        create_work_package!(repo, work_request, id: "WP-CLOSED-#{index}", status: status)
      end

    for {package, index} <- Enum.with_index(Enum.take(packages, 24), 1) do
      args =
        case index do
          2 ->
            abandoned_args(work_request, package, "close-#{index}", "The operator dropped this scope.")

          3 ->
            superseded_args(work_request, package, "close-#{index}", hd(packages).id, "Covered by the first package.")

          4 ->
            pr_merged_args(work_request, package, "close-#{index}")
            |> put_in(["evidence", "pr_merged", "pr_repository"], work_request.repo)
            |> put_in(["evidence", "pr_merged", "pr_url"], "https://github.com/#{work_request.repo}/pull/24")

          _ ->
            no_pr_args(work_request, package, "close-#{index}", "Accepted investigation evidence.")
        end

      read.("record_work_package_delivery", args)
    end

    assert read.("read_work_request", %{"detail" => "full", "work_request_id" => work_request.id})["work_request"]["execution_status"] == "open"
    active = read.("read_delivery_board", %{"work_request_id" => work_request.id})["delivery_board"]["work_packages"] |> List.last()
    assert active["merge_eligibility"]["next_action"] == "finish_worker_qualification"

    read.("skip_work_package", %{"work_request_id" => work_request.id, "work_package_id" => List.last(packages).id, "current_status" => "planned"})

    for detail <- ["summary", "full"] do
      board = read.("read_delivery_board", %{"work_request_id" => work_request.id, "detail" => detail})
      assert board["work_request"]["status"] == "sliced"
      assert board["work_request"]["execution_status"] == "closed"
      assert board["delivery_board"]["execution_status"] == "closed"
      assert length(board["delivery_board"]["work_packages"]) == 25
      assert Enum.all?(board["delivery_board"]["work_packages"], &is_nil(&1["merge_eligibility"]["next_action"]))
    end

    request = read.("read_work_request", %{"detail" => "full", "work_request_id" => work_request.id})["work_request"]
    assert request["execution_status"] == "closed"
    assert request["status"] == "sliced"
    listed = read.("list_work_requests", %{})["work_requests"] |> Enum.find(&(&1["id"] == work_request.id))
    assert listed["execution_status"] == "closed"
    assert listed["status"] == "sliced"
    assert {:ok, native} = Dashboard.work_request_detail(repo, work_request.id)
    assert native.work_request.execution_status == "closed"
    assert native.work_request.completed_at == nil
    assert repo.get!(WorkRequest, work_request.id).completed_at == nil

    summary_response = mcp_tool(repo, session, "reconcile_work_request", %{"work_request_id" => work_request.id})
    full_response = mcp_tool(repo, session, "reconcile_work_request", %{"work_request_id" => work_request.id, "detail" => "full"})
    summary = get_in(summary_response, ["result", "structuredContent"])
    full = get_in(full_response, ["result", "structuredContent"])
    assert summary["reconciliation"]["results"] == []
    assert summary["reconciliation"]["total_count"] == 25
    assert summary["reconciliation"]["skipped_count"] == 25
    assert summary["reconciliation"]["error_count"] == 0
    assert length(full["reconciliation"]["results"]) == 25
    assert length(full["delivery_board"]["work_packages"]) == 25
    assert Map.delete(summary["reconciliation"], "results") == Map.delete(full["reconciliation"], "results")
    assert Enum.count(full["reconciliation"]["results"], &(&1["reason"] == "already_closeout")) == 24
    assert get_in(full, ["delivery_board", "work_packages", Access.at(0), "delivery", "no_pr_evidence"]) == "Accepted investigation evidence."
    IO.puts("25-package reconciliation JSON chars: rows_full=#{String.length(Jason.encode!(full["reconciliation"]))} rows_summary=#{String.length(Jason.encode!(summary["reconciliation"]))}")

    invalid = mcp_tool(repo, session, "reconcile_work_request", %{"work_request_id" => work_request.id, "detail" => "invalid"})
    assert invalid["error"]
  end

  test "WR architect stale capabilities still read the delivery board and record closeout", %{
    repo: repo
  } do
    {work_request, work_package, linked_package} =
      linked_slice!(repo, work_request_id: "WR-MCP-DELIVERY-READ-CLOSE")

    session =
      repo
      |> create_work_request_architect_session(work_request, ArchitectHandoff.capabilities())
      |> stale_session_capabilities(limited_work_request_architect_capabilities())

    board_response =
      mcp_tool(repo, session, "read_delivery_board", %{"detail" => "full", "work_request_id" => work_request.id})

    board_payload = get_in(board_response, ["result", "structuredContent"])

    assert get_in(board_payload, ["delivery_board", "work_packages", Access.at(0), "work_package", "id"]) ==
             linked_package.id

    evidence_url = "https://example.invalid/delivery?token=placeholder"
    evidence_query_value = "placeholder"

    closeout_args =
      no_pr_args(
        work_request,
        work_package,
        "delivery-mcp-no-pr",
        "Operator confirmed #{evidence_url} completed without a PR."
      )

    closeout_response = record_delivery(repo, session, closeout_args)
    closeout_payload = get_in(closeout_response, ["result", "structuredContent"])

    assert closeout_payload["work_package_delivery"]["outcome"] == "completed_no_pr"
    refute Map.has_key?(closeout_payload["work_package_delivery"], "no_pr_evidence")
    refute inspect(closeout_response) =~ evidence_query_value

    read_closed_response =
      mcp_tool(repo, session, "read_delivery_board", %{"detail" => "full", "work_request_id" => work_request.id})

    assert get_in(read_closed_response, [
             "result",
             "structuredContent",
             "delivery_board",
             "counts",
             "completed_no_pr"
           ]) == 1

    assert get_in(read_closed_response, [
             "result",
             "structuredContent",
             "delivery_board",
             "work_packages",
             Access.at(0),
             "operational_state",
             "key"
           ]) == "completed_no_pr"

    delivery_evidence_path = [
      "delivery_board",
      "work_packages",
      Access.at(0),
      "delivery",
      "no_pr_evidence"
    ]

    assert get_in(read_closed_response, ["result", "structuredContent" | delivery_evidence_path]) =~ "[REDACTED]"
    refute get_in(read_closed_response, ["result", "structuredContent" | delivery_evidence_path]) =~ evidence_query_value
    assert repo.get!(WorkPackage, linked_package.id).status == "closed"

    replay_response = record_delivery(repo, session, closeout_args)

    assert get_in(replay_response, ["result", "structuredContent", "work_package_delivery", "id"]) ==
             closeout_payload["work_package_delivery"]["id"]

    refute get_in(read_closed_response, ["result", "structuredContent" | delivery_evidence_path]) =~
             evidence_query_value

    assert repo.aggregate(WorkPackageDelivery, :count, :id) == 1
  end

  test "WR architect reconciles merged PR evidence over stale package grant state", %{repo: repo} do
    {work_request, work_package, linked_package} =
      linked_slice!(repo,
        work_request_id: "WR-MCP-DELIVERY-RECONCILE-MERGED-STALE",
        work_package_status: "ready_for_merge"
      )

    session =
      create_work_request_architect_session(repo, work_request, [
        "read:work_request",
        "write:work_request"
      ])

    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, linked_package.id)

    assert {:ok, _assignment} =
             AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-stale-after-merge")

    assert {:ok, _pr} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: linked_package.id,
               summary: "Merged PR attached",
               status: "pr_attached",
               payload: %{
                 type: "pr",
                 source_tool: "attach_pr",
                 url: "https://github.com/#{linked_package.repo}/pull/91",
                 repository: linked_package.repo,
                 number: 91,
                 base_branch: linked_package.base_branch,
                 head_sha: "head-dogfood",
                 merged: true,
                 merged_at: "2026-05-28T12:00:00Z",
                 merge_commit_sha: "merge-91"
               }
             })

    dry_run_response = reconcile_request(repo, session, %{"work_request_id" => work_request.id})
    dry_run_payload = get_in(dry_run_response, ["result", "structuredContent", "reconciliation"])

    assert dry_run_payload["mode"] == "dry_run"
    assert dry_run_payload["proposed_count"] == 1

    assert [
             %{
               "work_package_id" => proposed_slice_id,
               "status" => "proposed",
               "reason" => "github_pr_merged"
             }
           ] = dry_run_payload["results"]

    assert proposed_slice_id == work_package.id
    assert repo.aggregate(WorkPackageDelivery, :count, :id) == 0
    refute repo.get!(AccessGrant, minted.grant.id).revoked_at

    apply_response =
      reconcile_request(repo, session, %{"work_request_id" => work_request.id, "apply" => true})

    apply_payload = get_in(apply_response, ["result", "structuredContent"])

    assert get_in(apply_payload, ["reconciliation", "mode"]) == "apply"
    assert get_in(apply_payload, ["reconciliation", "applied_count"]) == 1
    assert get_in(apply_payload, ["delivery_board", "counts", "delivered"]) == 1
    refute Map.has_key?(apply_payload["delivery_board"], "work_packages")
    assert repo.get!(WorkPackage, linked_package.id).status == "merged"
    assert repo.get!(AccessGrant, minted.grant.id).revoked_at
  end

  test "WR architect read-only grants cannot mutate delivery closeout state", %{repo: repo} do
    {work_request, work_package, linked_package} =
      linked_slice!(repo,
        work_request_id: "WR-MCP-DELIVERY-READONLY",
        work_package_status: "ready_for_merge"
      )

    session = create_work_request_architect_session(repo, work_request, ["read:work_request"])
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, linked_package.id)

    dry_run_response = reconcile_request(repo, session, %{"work_request_id" => work_request.id})

    assert get_in(dry_run_response, ["result", "structuredContent", "reconciliation", "mode"]) ==
             "dry_run"

    apply_response =
      reconcile_request(repo, session, %{"work_request_id" => work_request.id, "apply" => true})

    assert insufficient_capability?(apply_response)

    invalid_closeout_response = record_delivery(repo, session, %{})
    assert insufficient_capability?(invalid_closeout_response)

    closeout_response =
      record_delivery(
        repo,
        session,
        no_pr_args(
          work_request,
          work_package,
          "delivery-mcp-readonly-closeout",
          "Read-only architects cannot close delivery."
        )
      )

    assert insufficient_capability?(closeout_response)

    revoke_response =
      revoke_worker_key(
        repo,
        session,
        revoke_args(
          work_request,
          work_package,
          minted.grant.id,
          "Read-only architects cannot revoke worker grants."
        )
      )

    assert insufficient_capability?(revoke_response)
    refute repo.get!(AccessGrant, minted.grant.id).revoked_at
    assert repo.aggregate(WorkPackageDelivery, :count, :id) == 0
  end

  test "WR architect live grant narrowing overrides stale session write capabilities", %{
    repo: repo
  } do
    {work_request, work_package, linked_package} =
      linked_slice!(repo,
        work_request_id: "WR-MCP-DELIVERY-LIVE-NARROWED",
        work_package_status: "ready_for_merge"
      )

    session =
      create_work_request_architect_session(repo, work_request, [
        "read:work_request",
        "write:work_request"
      ])

    assert :ok =
             update_grant_capabilities(repo, session.assignment.grant_id, ["read:work_request"])

    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, linked_package.id)

    dry_run_response = reconcile_request(repo, session, %{"work_request_id" => work_request.id})

    assert get_in(dry_run_response, ["result", "structuredContent", "reconciliation", "mode"]) ==
             "dry_run"

    apply_response =
      reconcile_request(repo, session, %{"work_request_id" => work_request.id, "apply" => true})

    assert insufficient_capability?(apply_response)

    closeout_response =
      record_delivery(
        repo,
        session,
        no_pr_args(
          work_request,
          work_package,
          "delivery-mcp-live-narrowed-closeout",
          "Live grant narrowing blocks stale write sessions."
        )
      )

    assert insufficient_capability?(closeout_response)

    revoke_response =
      revoke_worker_key(
        repo,
        session,
        revoke_args(
          work_request,
          work_package,
          minted.grant.id,
          "Live grant narrowing blocks stale write sessions."
        )
      )

    assert insufficient_capability?(revoke_response)

    invalid_revoke_response = revoke_worker_key(repo, session, %{})
    assert insufficient_capability?(invalid_revoke_response)

    refute repo.get!(AccessGrant, minted.grant.id).revoked_at
    assert repo.aggregate(WorkPackageDelivery, :count, :id) == 0
  end

  test "WR architect write-only grants can apply reconciliation without dry-run read", %{
    repo: repo
  } do
    {work_request, _work_package, linked_package} =
      linked_slice!(repo,
        work_request_id: "WR-MCP-DELIVERY-RECONCILE-WRITEONLY",
        work_package_status: "ready_for_merge"
      )

    session = create_work_request_architect_session(repo, work_request, ["write:work_request"])

    assert {:ok, _pr} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: linked_package.id,
               summary: "Merged PR attached",
               status: "pr_attached",
               payload: %{
                 type: "pr",
                 source_tool: "attach_pr",
                 url: "https://github.com/#{linked_package.repo}/pull/92",
                 repository: linked_package.repo,
                 number: 92,
                 base_branch: linked_package.base_branch,
                 head_sha: "head-writeonly",
                 merged: true,
                 merged_at: "2026-05-28T12:00:00Z",
                 merge_commit_sha: "merge-92"
               }
             })

    dry_run_response = reconcile_request(repo, session, %{"work_request_id" => work_request.id})
    assert insufficient_capability?(dry_run_response)

    apply_response =
      reconcile_request(repo, session, %{"work_request_id" => work_request.id, "apply" => true})

    assert get_in(apply_response, [
             "result",
             "structuredContent",
             "reconciliation",
             "applied_count"
           ]) == 1

    assert repo.get!(WorkPackage, linked_package.id).status == "merged"
  end

  test "WR architect abandons no-code failed dispatch after replacement delivery without explicit revoke or unrelated grants",
       %{repo: repo} do
    {work_request, failed_slice, failed_package} =
      linked_slice!(repo,
        work_request_id: "WR-MCP-DELIVERY-ABANDON-FAILED-DISPATCH",
        work_package_status: "ready_for_worker"
      )

    session = create_work_request_architect_session(repo, work_request, ["write:work_request"])

    assert {:ok, failed_minted} = AccessGrantService.mint_worker_grant(repo, failed_package.id)

    oracle_slice = create_work_package!(repo, work_request, id: "WRS-MCP-DELIVERY-ORACLE-ACTIVE")

    assert {:ok, approved_oracle} =
             CanonicalWorkPackageFixtures.approve_work_package(
               repo,
               work_request.id,
               oracle_slice.id,
               "planned"
             )

    oracle_package =
      create_matching_work_package!(repo, work_request, approved_oracle,
        id: "WP-MCP-DELIVERY-ORACLE-ACTIVE",
        status: "ready_for_worker"
      )

    assert {:ok, _oracle_dispatch} =
             CanonicalWorkPackageFixtures.dispatch_work_package(
               repo,
               work_request.id,
               approved_oracle.id,
               "approved",
               oracle_package.id
             )

    assert {:ok, oracle_minted} = AccessGrantService.mint_worker_grant(repo, oracle_package.id)

    assert {:ok, _oracle_assignment} =
             AccessGrantService.claim(repo, oracle_minted.work_key.secret, claimed_by: "oracle-worker")

    replacement_slice =
      create_work_package!(repo, work_request, id: "WRS-MCP-DELIVERY-REPLACEMENT")

    assert {:ok, approved_replacement} =
             CanonicalWorkPackageFixtures.approve_work_package(
               repo,
               work_request.id,
               replacement_slice.id,
               "planned"
             )

    replacement_package =
      create_matching_work_package!(repo, work_request, approved_replacement,
        id: "WP-MCP-DELIVERY-REPLACEMENT",
        status: "ready_for_merge"
      )

    assert {:ok, dispatched_replacement} =
             CanonicalWorkPackageFixtures.dispatch_work_package(
               repo,
               work_request.id,
               approved_replacement.id,
               "approved",
               replacement_package.id
             )

    replacement_response =
      record_delivery(
        repo,
        session,
        pr_merged_args(work_request, dispatched_replacement, "delivery-mcp-replacement-pr")
      )

    assert get_in(replacement_response, [
             "result",
             "structuredContent",
             "work_package_delivery",
             "outcome"
           ]) == "pr_merged"

    assert repo.get!(WorkPackage, replacement_package.id).status == "merged"

    revoke_response =
      revoke_worker_key(
        repo,
        session,
        revoke_args(
          work_request,
          failed_slice,
          failed_minted.grant.id,
          "Failed bootstrap before implementation."
        )
      )

    assert get_in(revoke_response, ["error", "data", "reason"]) ==
             "work_package_not_closeout_ready"

    refute repo.get!(AccessGrant, failed_minted.grant.id).revoked_at

    abandon_response =
      record_delivery(
        repo,
        session,
        abandoned_args(
          work_request,
          failed_slice,
          "delivery-mcp-abandoned-failed-dispatch",
          "Wildcard branch dispatch failed before implementation; replacement slice already delivered."
        )
      )

    assert get_in(abandon_response, [
             "result",
             "structuredContent",
             "work_package_delivery",
             "outcome"
           ]) == "abandoned"

    assert repo.get!(WorkPackage, failed_package.id).status == "abandoned"
    assert repo.get!(AccessGrant, failed_minted.grant.id).revoked_at

    refute repo.get!(AccessGrant, oracle_minted.grant.id).revoked_at
    assert repo.get!(WorkPackage, oracle_package.id).status == "ready_for_worker"
  end

  test "abandoned delivery closeout accepts terminal packages with worker lifecycle history",
       %{repo: repo} do
    {work_request, work_package, linked_package} =
      linked_slice!(
        repo,
        work_request_id: "WR-MCP-DELIVERY-ABANDONED-HISTORY",
        work_package_status: "ready_for_worker"
      )

    for status <- ["blocked", "implementing", "reviewing", "abandoned"] do
      assert {:ok, _event} =
               PlanningRepository.append_progress_event(repo, %{
                 work_package_id: linked_package.id,
                 summary: "Worker lifecycle reached #{status}.",
                 status: status,
                 idempotency_key: "abandoned-worker-history-#{status}",
                 payload: %{"next_status" => status}
               })
    end

    assert {:ok, _abandoned_package} =
             WorkPackageRepository.update(repo, linked_package.id, %{
               status: "abandoned",
               worktree_path: nil
             })

    session =
      create_work_request_architect_session(repo, work_request, ArchitectHandoff.capabilities())

    assert "terminal_package_without_delivery_outcome" in slice_by_id(delivery_board_payload_for(repo, session, work_request), work_package.id)[
             "attention_reason_codes"
           ]

    response =
      record_delivery(
        repo,
        session,
        abandoned_args(
          work_request,
          work_package,
          "delivery-mcp-abandoned-worker-history",
          "The worker stopped and the package is already abandoned."
        )
      )

    assert response["error"] == nil
    payload = get_in(response, ["result", "structuredContent"])
    assert payload["work_package_delivery"]["outcome"] == "abandoned"

    assert slice_by_id(
             delivery_board_payload_for(repo, session, work_request),
             work_package.id
           )["attention_reason_codes"] == []

    assert repo.get!(WorkPackage, linked_package.id).status == "abandoned"
  end

  defp linked_slice!(repo, overrides) do
    request_id = Keyword.fetch!(overrides, :work_request_id)
    work_package_status = Keyword.get(overrides, :work_package_status, "reviewing")
    work_request = create_work_request!(repo, id: request_id, status: "ready_for_slicing")
    work_package = create_work_package!(repo, work_request, id: "WRS-#{request_id}")

    assert {:ok, approved_slice} =
             CanonicalWorkPackageFixtures.approve_work_package(
               repo,
               work_request.id,
               work_package.id,
               "planned"
             )

    linked_package =
      create_matching_work_package!(repo, work_request, approved_slice,
        id: "WP-#{request_id}",
        status: work_package_status
      )

    assert {:ok, dispatched_slice} =
             CanonicalWorkPackageFixtures.dispatch_work_package(
               repo,
               work_request.id,
               approved_slice.id,
               "approved",
               linked_package.id
             )

    {work_request, dispatched_slice, linked_package}
  end

  defp create_work_request!(repo, overrides) do
    assert {:ok, work_request} = WorkRequestRepository.create(repo, work_request_attrs(overrides))
    work_request
  end

  defp sibling_work_request!(repo, work_request, id) do
    create_work_request!(repo,
      id: id,
      repo: work_request.repo,
      base_branch: work_request.base_branch,
      status: "ready_for_slicing"
    )
  end

  defp create_work_package!(repo, work_request, overrides) do
    assert {:ok, work_package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               work_request.id,
               work_package_attrs(overrides)
             )

    work_package
  end

  defp approve_slice!(%WorkPackage{} = work_package, repo, %WorkRequest{} = work_request) do
    assert {:ok, approved_slice} =
             CanonicalWorkPackageFixtures.approve_work_package(
               repo,
               work_request.id,
               work_package.id,
               "planned"
             )

    approved_slice
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

  defp create_work_request_architect_session(repo, %WorkRequest{} = work_request, capabilities) do
    phase_id = ArchitectHandoff.phase_id_for_work_request(work_request)

    assert {:ok, _phase} =
             PhaseRepository.create(repo, %{
               id: phase_id,
               title: "Architect handoff for #{work_request.id}"
             })

    anchor_attrs =
      [
        id: ArchitectHandoff.anchor_id_for_work_request(work_request),
        kind: "delegation",
        title: "Architect handoff: #{work_request.title}",
        repo: work_request.repo,
        base_branch: work_request.base_branch,
        phase_id: phase_id,
        status: "planning",
        allowed_file_globs: ["elixir/lib", "elixir/lib/**"],
        acceptance_criteria: ["Own the WorkRequest architecture."]
      ]
      |> WorkPackageFactory.attrs()

    assert {:ok, anchor} = WorkPackageRepository.create(repo, anchor_attrs)

    assert {:ok, minted} =
             AccessGrantService.mint_architect_grant(repo, phase_id,
               work_package_id: anchor.id,
               capabilities: capabilities
             )

    assert {:ok, assignment} =
             AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "architect-1")

    MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)
  end

  defp update_grant_capabilities(repo, grant_id, capabilities) do
    grant = repo.get!(AccessGrant, grant_id)

    case repo.update(AccessGrant.changeset(grant, %{capabilities: capabilities})) do
      {:ok, _grant} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  defp stale_session_capabilities(%Session{} = session, capabilities) do
    %{session | assignment: %{session.assignment | capabilities: capabilities}}
  end

  defp create_worker_session(repo, %WorkPackage{} = work_package) do
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, work_package.id)

    assert {:ok, assignment} =
             AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")

    MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)
  end

  defp no_pr_args(work_request, work_package, idempotency_key, evidence) do
    %{
      "work_request_id" => work_request.id,
      "work_package_id" => work_package.id,
      "outcome" => "completed_no_pr",
      "idempotency_key" => idempotency_key,
      "evidence" => %{"completed_no_pr" => %{"no_pr_evidence" => evidence}}
    }
  end

  defp pr_merged_args(work_request, work_package, idempotency_key) do
    %{
      "work_request_id" => work_request.id,
      "work_package_id" => work_package.id,
      "outcome" => "pr_merged",
      "idempotency_key" => idempotency_key,
      "evidence" => %{
        "pr_merged" => %{
          "pr_url" => "https://github.com/nextide/symphony-plus-plus/pull/24",
          "pr_number" => 24,
          "pr_repository" => "nextide/symphony-plus-plus",
          "pr_merged_at" => "2026-05-28T12:00:00Z",
          "merge_commit_sha" => "abc24"
        }
      }
    }
  end

  defp abandoned_args(work_request, work_package, idempotency_key, rationale) do
    %{
      "work_request_id" => work_request.id,
      "work_package_id" => work_package.id,
      "outcome" => "abandoned",
      "idempotency_key" => idempotency_key,
      "evidence" => %{"abandoned" => %{"abandoned_rationale" => rationale}}
    }
  end

  defp revoke_args(work_request, work_package, grant_id, reason) do
    %{
      "work_request_id" => work_request.id,
      "work_package_id" => work_package.id,
      "grant_id" => grant_id,
      "reason" => reason
    }
  end

  defp limited_work_request_architect_capabilities, do: ["read:work_request", "write:work_request"]

  defp superseded_args(work_request, work_package, idempotency_key, successor_work_package_id, reason) do
    %{
      "work_request_id" => work_request.id,
      "work_package_id" => work_package.id,
      "outcome" => "superseded",
      "idempotency_key" => idempotency_key,
      "evidence" => %{
        "superseded" => %{
          "superseded_reason" => reason,
          "successor_work_package_id" => successor_work_package_id
        }
      }
    }
  end

  defp work_request_attrs(overrides) do
    defaults = %{
      id: "WR-MCP-DELIVERY-#{System.unique_integer([:positive])}",
      title: "Expose delivery MCP tools",
      repo: "nextide/example",
      base_branch: "main",
      work_type: "feature",
      human_description: "Expose delivery-board and closeout through MCP.",
      constraints: %{
        "allowed_paths" => ["elixir/lib"],
        "forbidden_paths" => [],
        "requires_secret" => false
      },
      desired_dispatch_shape: "architect_led_feature_branch"
    }

    Enum.into(overrides, defaults)
  end

  defp work_package_attrs(overrides) do
    defaults = %{
      id: "WRS-MCP-DELIVERY-#{System.unique_integer([:positive])}",
      title: "Delivery MCP slice",
      goal: "Close delivered WorkPackages through MCP.",
      kind: "mcp",
      base_branch: "main",
      branch_pattern: "feat/mcp-delivery",
      allowed_file_globs: ["elixir/lib/symphony_elixir/symphony_plus_plus/work_requests/**"],
      forbidden_file_globs: ["elixir/assets/**"],
      acceptance_criteria: ["Delivery MCP tools are scoped."],
      validation_steps: [
        "mix test test/symphony_elixir/symphony_plus_plus/mcp_delivery_tools_test.exs"
      ],
      review_requirement: %{"type" => "review-suite", "args" => %{"mode" => "normal"}},
      stop_conditions: ["Do not expose broad package visibility."]
    }

    Enum.into(overrides, defaults)
  end

  defp record_delivery(repo, session, arguments),
    do: mcp_tool(repo, session, "record_work_package_delivery", arguments)

  defp reconcile_request(repo, session, arguments),
    do: mcp_tool(repo, session, "reconcile_work_request", arguments)

  defp revoke_worker_key(repo, session, arguments),
    do: mcp_tool(repo, session, "revoke_work_package_worker_key", arguments)

  defp delivery_board_payload_for(repo, session, %WorkRequest{} = work_request) do
    response =
      mcp_tool(repo, session, "read_delivery_board", %{"detail" => "full", "work_request_id" => work_request.id})

    assert response["error"] == nil
    get_in(response, ["result", "structuredContent"])
  end

  defp slice_work_package(payload, work_package_id) do
    payload
    |> slice_by_id(work_package_id)
    |> Map.get("work_package")
  end

  defp slice_by_id(payload, work_package_id) do
    payload
    |> get_in(["delivery_board", "work_packages"])
    |> Enum.find(&(&1["id"] == work_package_id))
  end

  defp insufficient_capability?(response) do
    get_in(response, ["error", "code"]) in [-32_001, -32_003] and
      get_in(response, ["error", "data", "reason"]) == "insufficient_capability" and
      get_in(response, ["error", "data", "reason_code"]) in [nil, "insufficient_capability"]
  end

  defp mcp_tool(repo, %Session{} = session, name, arguments) do
    MCPHarness.request(
      %{
        "jsonrpc" => "2.0",
        "id" => name,
        "method" => "tools/call",
        "params" => %{"name" => name, "arguments" => arguments}
      },
      config: Config.default(repo: repo, repo_root: test_repo_root()),
      session: session
    )
  end

  defp test_repo_root do
    Path.expand("../../../..", __DIR__)
  end
end
