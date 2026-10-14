Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.ClaimSessionTransport05Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackageActivity

  test "claim_local_assignment keeps the old binding when the new target has no claimable grant", %{repo: repo} do
    first_package = create_local_claim_package!(repo, "SYMPP-LOCAL-REBIND-GRANT-OLD")
    second_package = create_local_claim_package!(repo, "SYMPP-LOCAL-REBIND-GRANT-MISSING")
    assert {:ok, _first_minted} = AccessGrantService.mint_worker_grant(repo, first_package.id)

    {_first_response, claimed_server} =
      Server.handle_response_state(
        tool_call("claim-grant-old", "claim_local_assignment", local_assignment_claim_args(first_package)),
        local_mcp_server(local_mcp_config(repo), "local-rebind-grant-missing-state")
      )

    {rebind_response, server} =
      Server.handle_response_state(
        tool_call("claim-grant-missing", "claim_local_assignment", local_assignment_claim_args(second_package, %{"claimed_by" => "local-worker-2"})),
        claimed_server
      )

    assert get_in(rebind_response, ["error", "data", "reason"]) == "worker_grant_required"
    assert get_in(rebind_response, ["error", "message"]) == "Worker grant required for WorkPackage #{second_package.id}"
    assert get_in(rebind_response, ["error", "data", "work_package_id"]) == second_package.id
    assert get_in(rebind_response, ["error", "data", "action"]) == "dispatch_work_package"
    assert get_in(rebind_response, ["error", "data", "remediation"]) =~ second_package.id
    assert server.session.assignment.work_package_id == first_package.id
    assert {:ok, _lease} = ClaimLeaseService.current_for_work_package(repo, first_package.id)
    assert {:error, :not_found} = ClaimLeaseService.current_for_work_package(repo, second_package.id)
    assert is_nil(WorkPackageActivity.context(repo, second_package.id).worker_signal)
  end

  defp tool_call(id, name, arguments) do
    %{"jsonrpc" => "2.0", "id" => id, "method" => "tools/call", "params" => %{"name" => name, "arguments" => arguments}}
  end
end
