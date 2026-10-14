Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.SoloSchema01Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  test "release clears local binding without releasing an unidentified legacy lease", %{repo: repo} do
    assert {:ok, package} =
             WorkPackageRepository.create(
               repo,
               WorkPackageFactory.attrs(id: "SYMPP-SOLO-RELEASE-LEGACY", kind: "mcp", status: "ready_for_worker")
             )

    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)

    {_claim_response, claimed_server} =
      Server.handle_response_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "claim-legacy-release",
          "method" => "tools/call",
          "params" => %{"name" => "claim_local_assignment", "arguments" => %{"work_package_id" => package.id, "claimed_by" => "worker-1"}}
        },
        Server.new(Config.default(repo: repo), initialized: true)
      )

    assert {:ok, %ClaimLease{}} = ClaimLeaseService.current_for_work_package(repo, package.id)

    legacy_session = %{
      claimed_server.session
      | claim_lease_id: nil,
        claim_actor_kind: nil,
        claim_actor_id: nil,
        claim_actor_display_name: nil
    }

    {release_response, still_bound_server} =
      Server.handle_response_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "release-legacy-current-assignment",
          "method" => "tools/call",
          "params" => %{"name" => "release_current_assignment", "arguments" => %{"reason" => "done"}}
        },
        %{claimed_server | session: legacy_session}
      )

    payload = get_in(release_response, ["result", "structuredContent"])

    assert payload["binding_cleared"] == true
    assert payload["solo_tools_available"] == true
    assert payload["fresh_mcp_session_required"] == false
    assert get_in(payload, ["claim_lease_release", "status"]) == "skipped"
    assert get_in(payload, ["claim_lease_release", "reason"]) == "claim_lease_identity_unavailable"
    assert get_in(payload, ["recovery", "next_action"]) == "retry_solo_tool"
    assert get_in(payload, ["recovery", "fresh_mcp_session_required"]) == false
    assert still_bound_server.session == nil
    assert still_bound_server.session_refresh_required == false
    assert {:ok, %ClaimLease{status: "active"}} = ClaimLeaseService.current_for_work_package(repo, package.id)
    refute inspect(release_response) =~ minted.work_key.secret
  end

  test "release clears local binding without releasing an expired lease", %{repo: repo} do
    {package, _work_request, _minted, claim_response, claimed_server} = claim_local_bound_assignment!(repo, "SYMPP-SOLO-RELEASE-STALE")
    lease_id = get_in(claim_response, ["result", "structuredContent", "local_claim", "claim_lease_id"])

    assert {1, nil} =
             repo.update_all(
               from(claim_lease in ClaimLease, where: claim_lease.id == ^lease_id),
               set: [last_seen_at: DateTime.add(DateTime.utc_now(:microsecond), -2, :second), stale_after_ms: 1]
             )

    stale_claimed_server = %{claimed_server | session_refresh_required: true}

    {release_response, still_bound_server} =
      Server.handle_response_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "release-stale-current-assignment",
          "method" => "tools/call",
          "params" => %{"name" => "release_current_assignment", "arguments" => %{"reason" => "done"}}
        },
        stale_claimed_server
      )

    payload = get_in(release_response, ["result", "structuredContent"])

    assert payload["binding_cleared"] == true
    assert payload["solo_tools_available"] == true
    assert get_in(payload, ["claim_lease_release", "status"]) == "skipped"
    assert get_in(payload, ["claim_lease_release", "reason"]) == "claim_stale"
    assert get_in(payload, ["recovery", "next_action"]) == "retry_solo_tool"
    assert get_in(payload, ["recovery", "fresh_mcp_session_required"]) == false
    assert still_bound_server.session == nil
    assert still_bound_server.session_refresh_required == false
    assert {:ok, %ClaimLease{id: ^lease_id, status: "active"}} = ClaimLeaseService.current_for_work_package(repo, package.id)
  end

  test "release_current_assignment never releases a newer active lease for a stale bound session", %{repo: repo} do
    {package, _work_request, _minted, claim_response, claimed_server} = claim_local_bound_assignment!(repo, "SYMPP-SOLO-RELEASE-MISMATCH")
    old_lease_id = get_in(claim_response, ["result", "structuredContent", "local_claim", "claim_lease_id"])
    assert {:ok, %ClaimLease{status: "released"}} = ClaimLeaseService.release(repo, old_lease_id, reason: "simulate_reclaim")

    assert {:ok, %ClaimLease{} = newer_lease} =
             ClaimLeaseService.claim(
               repo,
               package.id,
               %{
                 "actor_kind" => "agent",
                 "actor_id" => "local:new-owner:new-actor",
                 "actor_display_name" => "local-worker-1"
               },
               stale_after_ms: 86_400_000
             )

    newer_lease_id = newer_lease.id

    {release_response, still_bound_server} =
      Server.handle_response_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "release-mismatched-current-assignment",
          "method" => "tools/call",
          "params" => %{"name" => "release_current_assignment", "arguments" => %{"reason" => "done"}}
        },
        claimed_server
      )

    payload = get_in(release_response, ["result", "structuredContent"])

    assert payload["binding_cleared"] == true
    assert payload["solo_tools_available"] == true
    assert payload["fresh_mcp_session_required"] == false
    assert get_in(payload, ["claim_lease_release", "status"]) == "skipped"
    assert get_in(payload, ["claim_lease_release", "reason"]) == "claim_lease_mismatch"
    assert get_in(payload, ["recovery", "next_action"]) == "retry_solo_tool"
    assert still_bound_server.session == nil
    assert still_bound_server.session_refresh_required == false
    assert {:ok, %ClaimLease{id: ^newer_lease_id, status: "active"}} = ClaimLeaseService.current_for_work_package(repo, package.id)
  end

  defp claim_local_bound_assignment!(repo, id) do
    package = create_local_claim_package!(repo, id, base_branch: "main")

    work_request =
      create_work_request!(repo,
        id: "WR-#{id}",
        repo: package.repo,
        base_branch: package.base_branch,
        status: "ready_for_slicing"
      )

    contract =
      work_request_work_package_attrs(
        base_branch: package.base_branch,
        branch_pattern: package.branch_pattern
      )

    package =
      repo.update!(
        Ecto.Changeset.change(
          package,
          Map.merge(contract, %{
            work_request_id: work_request.id,
            sequence: 1,
            status: "ready_for_worker",
            dispatched_at: DateTime.utc_now(:microsecond)
          })
        )
      )

    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)

    {claim_response, claimed_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "claim-#{id}",
          "method" => "tools/call",
          "params" => %{
            "name" => "claim_local_assignment",
            "arguments" => local_assignment_claim_args(package, %{"work_request_id" => work_request.id})
          }
        },
        local_mcp_server(local_mcp_config(repo), "state-#{id}")
      )

    assert get_in(claim_response, ["result", "structuredContent", "assignment", "work_package_id"]) == package.id
    refute inspect(claim_response) =~ minted.work_key.secret
    {package, work_request, minted, claim_response, claimed_server}
  end
end
