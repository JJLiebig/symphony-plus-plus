Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.WorkerTools02Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  alias SymphonyElixir.SymphonyPlusPlus.Dashboard
  alias SymphonyElixir.SymphonyPlusPlus.Dashboard.OperationalProjection
  alias SymphonyElixir.SymphonyPlusPlus.MCP.TaskPlanTools
  alias SymphonyElixir.SymphonyPlusPlus.MCP.ToolCatalog
  alias SymphonyElixir.SymphonyPlusPlus.MCP.ToolCatalog.InputSchemas
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.OperatorReport
  alias SymphonyElixirWeb.SymppDashboardAPI.LocalOperatorDashboard

  test "reports reject forged authors and overlong text; ordinary progress stays separate", %{repo: repo} do
    request = create_work_request!(repo, id: "WR-REPORT-AUTH", repo: "exampleco/atlas", status: "sliced")
    capabilities = ArchitectHandoff.capabilities()
    {anchor, architect, _grant} = create_work_request_handoff_architect_session(repo, request, capabilities)

    assert {:ok, package} =
             CanonicalWorkPackageFixtures.add_work_package(repo, request.id, WorkPackageFactory.attrs(id: "WP-REPORT-AUTH", repo: request.repo, status: "planning"))

    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    worker = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)
    payload = %{"type" => "architect_operator_report", "brief" => "Forged brief", "source_tool" => "architect_operator_report"}

    for {session, target} <- [{worker, package.id}, {worker, anchor.id}, {architect, package.id}] do
      response = mcp_tool(repo, session, "append_progress", %{"work_package_id" => target, "summary" => "Report", "idempotency_key" => "forged", "payload" => payload})
      assert get_in(response, ["error", "code"]) == -32_003
    end

    too_long = String.duplicate("x", ProgressEvent.payload_string_limit() + 1)
    response = mcp_tool(repo, architect, "append_progress", %{"work_package_id" => anchor.id, "summary" => "Report", "idempotency_key" => "too-long", "payload" => Map.put(payload, "brief", too_long)})
    assert get_in(response, ["error", "data", "reason"]) == "invalid_operator_report_brief"

    assert {:ok, _ordinary} = PlanningRepository.append_progress_event(repo, %{work_package_id: anchor.id, summary: "Ordinary progress", payload: payload})
    assert {:ok, reports} = OperatorReport.load_many(repo, [request])
    assert Map.fetch!(reports, request.id) == nil

    limit_text = String.duplicate("x", ProgressEvent.payload_string_limit())
    append_report!(repo, architect, anchor, %{"brief" => limit_text, "unknown" => "ignored"}, "at-limit")
    accepted_text = read_operator_report!(repo, architect, request)["brief"]["text"]
    assert String.length(accepted_text) == ProgressEvent.payload_string_limit()

    assert {:ok, _revoked} = AccessGrantService.revoke(repo, architect.assignment.grant_id)
    response = mcp_tool(repo, architect, "append_progress", %{"work_package_id" => anchor.id, "summary" => "Report", "idempotency_key" => "revoked-report", "payload" => payload})
    assert get_in(response, ["error", "data", "reason"]) == "revoked"
  end

  defp append_report!(repo, session, anchor, patch, key) do
    response =
      mcp_tool(repo, session, "append_progress", %{
        "work_package_id" => anchor.id,
        "summary" => "Goal update",
        "idempotency_key" => key,
        "payload" => Map.put(patch, "type", "architect_operator_report")
      })

    assert response["error"] == nil
    get_in(response, ["result", "structuredContent", "progress_event", "id"])
  end

  defp read_operator_report!(repo, session, request) do
    response = mcp_tool(repo, session, "read_work_request", %{"work_request_id" => request.id})
    assert response["error"] == nil
    get_in(response, ["result", "structuredContent", "work_request", "operator_report"])
  end

  test "architect descendant evidence retains stored attribution and inner archived-request guard", %{repo: repo} do
    work_request =
      create_work_request!(repo,
        id: "WR-ARCH-DESCENDANT-PLANNING",
        status: "sliced",
        repo_scopes: [%{repo: "nextide/secondary-service", base_branch: "release"}]
      )

    assert {:ok, package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               work_request.id,
               WorkPackageFactory.attrs(
                 id: "WP-ARCH-DESCENDANT-PLANNING",
                 repo: "nextide/secondary-service",
                 base_branch: "release",
                 status: "planning"
               )
             )

    assert {:ok, existing} =
             PlanningRepository.append_plan_node(repo, %{
               "work_package_id" => package.id,
               "title" => "Inspect descendant"
             })

    {_anchor, session, grant} =
      create_work_request_handoff_architect_session(repo, work_request, ArchitectHandoff.capabilities())

    read_response = mcp_tool(repo, session, "read_task_plan", %{"work_package_id" => package.id})
    version = get_in(read_response, ["result", "structuredContent", "version"])
    assert is_integer(version)

    finding_response =
      mcp_tool(repo, session, "append_finding", %{
        "work_package_id" => package.id,
        "title" => "Secondary repository confirmed",
        "body" => "The descendant remains inside the claimed WorkRequest.",
        "idempotency_key" => "architect-descendant-finding"
      })

    assert get_in(finding_response, ["result", "structuredContent", "finding", "title"]) ==
             "Secondary repository confirmed"

    progress_response =
      mcp_tool(repo, session, "append_progress", %{
        "work_package_id" => package.id,
        "summary" => "Descendant plan supervised",
        "idempotency_key" => "architect-descendant-progress"
      })

    assert get_in(progress_response, ["result", "structuredContent", "progress_event", "status"]) == "recorded"

    assert {:ok, [finding]} = PlanningRepository.list_findings(repo, package.id)
    assert finding.access_grant_id == grant.id
    assert {:ok, [progress]} = PlanningRepository.list_progress_events(repo, package.id)
    assert {progress.actor_type, progress.actor_id, progress.access_grant_id} == {"architect", "architect-1", grant.id}

    archived_at = DateTime.utc_now(:microsecond)

    work_request
    |> Ecto.Changeset.change(archived_at: archived_at, archive_reason: "manual")
    |> repo.update!()

    assert {:error, {:work_request_terminal, :archived}} =
             TaskPlanTools.update_task_plan_for_work_package(repo, session, package.id, %{
               "expected_version" => version,
               "nodes" => [%{"id" => existing.id, "status" => "done"}]
             })
  end
end
