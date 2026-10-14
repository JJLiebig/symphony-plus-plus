Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.ClaimSessionTransport06Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  defmodule FailingRebindValidationRepo do
    alias SymphonyElixir.SymphonyPlusPlus.Repo

    def database_path, do: Repo.database_path()
    def query(sql, params, opts), do: Repo.query(sql, params, opts)
    def get(_schema, _id), do: raise(RuntimeError, "grant lookup unavailable")
  end

  test "claim_local_assignment reclaims a stale bound local session for the same package with a new owner label", %{repo: repo} do
    package = create_local_claim_package!(repo, "SYMPP-STALE-BOUND-WORKER")
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    old_arguments = local_assignment_claim_args(package, %{"claimed_by" => "worker-before-reboot"})
    new_arguments = local_assignment_claim_args(package, %{"claimed_by" => "worker-after-reboot"})

    {_stale_claim_response, stale_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "claim-stale-bound-worker",
          "method" => "tools/call",
          "params" => %{"name" => "claim_local_assignment", "arguments" => old_arguments}
        },
        local_mcp_server(local_mcp_config(repo), "claim-stale-bound-worker-state")
      )

    assert {:ok, stale_lease} = ClaimLeaseService.current_for_work_package(repo, package.id)

    stale_lease
    |> ClaimLease.update_changeset(%{last_seen_at: DateTime.add(DateTime.utc_now(:microsecond), -6, :minute)})
    |> repo.update!()

    {reclaim_response, reclaimed_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "reclaim-stale-bound-worker",
          "method" => "tools/call",
          "params" => %{"name" => "claim_local_assignment", "arguments" => new_arguments}
        },
        stale_server
      )

    assert get_in(reclaim_response, ["result", "structuredContent", "assignment", "grant_id"]) == minted.grant.id
    assert get_in(reclaim_response, ["result", "structuredContent", "assignment", "claimed_by"]) == "worker-after-reboot"
    assert get_in(reclaim_response, ["result", "structuredContent", "local_claim", "claim_lease_action"]) == "reclaimed"
    assert reclaimed_server.session.assignment.work_package_id == package.id
  end

  test "claim_local_assignment does not recover unrelated active worker grants after stale lease reclaim", %{repo: repo} do
    package = create_local_claim_package!(repo, "SYMPP-UNRELATED-ACTIVE-WORKER")
    assert {:ok, _old_minted} = AccessGrantService.mint_worker_grant(repo, package.id)

    {_claim_response, stale_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "claim-stale-worker-owner",
          "method" => "tools/call",
          "params" => %{
            "name" => "claim_local_assignment",
            "arguments" => local_assignment_claim_args(package, %{"claimed_by" => "worker-before-reboot"})
          }
        },
        local_mcp_server(local_mcp_config(repo), "claim-unrelated-worker-state")
      )

    assert {:ok, stale_lease} = ClaimLeaseService.current_for_work_package(repo, package.id)

    stale_lease
    |> ClaimLease.update_changeset(%{last_seen_at: DateTime.add(DateTime.utc_now(:microsecond), -6, :minute)})
    |> repo.update!()

    assert {:ok, _revoked} = AccessGrantService.revoke(repo, stale_server.session.assignment.grant_id)
    assert {:ok, unrelated_minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, unrelated_grant} = AccessGrantService.claim(repo, unrelated_minted.work_key.secret, claimed_by: "unrelated-worker")

    {response, server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "reclaim-must-not-steal-unrelated-worker",
          "method" => "tools/call",
          "params" => %{
            "name" => "claim_local_assignment",
            "arguments" => local_assignment_claim_args(package, %{"claimed_by" => "worker-after-reboot"})
          }
        },
        stale_server
      )

    assert get_in(response, ["error", "data", "reason"]) == "already_claimed"
    assert repo.get!(AccessGrant, unrelated_grant.grant_id).claimed_by == "unrelated-worker"
    assert server.session.assignment.claimed_by == "worker-before-reboot"
  end

  test "claim_local_assignment switches after another active owner reclaims the old lease", %{repo: repo} do
    stale_package = create_local_claim_package!(repo, "SYMPP-MISMATCHED-BOUND-WORKER")
    next_package = create_local_claim_package!(repo, "SYMPP-MISMATCHED-BOUND-WORKER-NEXT")
    assert {:ok, _stale_minted} = AccessGrantService.mint_worker_grant(repo, stale_package.id)
    assert {:ok, _next_minted} = AccessGrantService.mint_worker_grant(repo, next_package.id)

    {_stale_claim_response, stale_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "claim-mismatched-bound-worker",
          "method" => "tools/call",
          "params" => %{"name" => "claim_local_assignment", "arguments" => local_assignment_claim_args(stale_package)}
        },
        local_mcp_server(local_mcp_config(repo), "claim-mismatched-bound-worker-state")
      )

    assert {:ok, stale_lease} = ClaimLeaseService.current_for_work_package(repo, stale_package.id)

    stale_lease
    |> ClaimLease.update_changeset(%{last_seen_at: DateTime.add(DateTime.utc_now(:microsecond), -6, :minute)})
    |> repo.update!()

    assert {:ok, replacement_lease} =
             ClaimLeaseService.reclaim_stale(
               repo,
               stale_package.id,
               %{"actor_kind" => "agent", "actor_id" => "local:replacement", "actor_display_name" => "replacement"},
               reason: "test replacement",
               stale_after_ms: :timer.minutes(5)
             )

    assert replacement_lease.previous_claim_id == stale_lease.id

    {next_claim_response, next_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "claim-after-mismatched-bound-worker",
          "method" => "tools/call",
          "params" => %{
            "name" => "claim_local_assignment",
            "arguments" => local_assignment_claim_args(next_package, %{"claimed_by" => "worker-after-reboot"})
          }
        },
        stale_server
      )

    assert get_in(next_claim_response, ["result", "structuredContent", "assignment", "work_package_id"]) == next_package.id
    assert next_server.session.assignment.work_package_id == next_package.id
    assert {:ok, ^replacement_lease} = ClaimLeaseService.current_for_work_package(repo, stale_package.id)
  end

  test "claim_local_assignment blocks different claims when current session validation fails", %{repo: repo} do
    package = create_local_claim_package!(repo, "SYMPP-BOUND-VALIDATION-FAIL")
    next_package = create_local_claim_package!(repo, "SYMPP-BOUND-VALIDATION-FAIL-NEXT")
    assert {:ok, _minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, _next_minted} = AccessGrantService.mint_worker_grant(repo, next_package.id)

    {_claim_response, claimed_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "claim-bound-validation-fail",
          "method" => "tools/call",
          "params" => %{"name" => "claim_local_assignment", "arguments" => local_assignment_claim_args(package)}
        },
        local_mcp_server(local_mcp_config(repo), "claim-bound-validation-fail-state")
      )

    {next_claim_response, next_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "claim-after-bound-validation-fail",
          "method" => "tools/call",
          "params" => %{"name" => "claim_local_assignment", "arguments" => local_assignment_claim_args(next_package)}
        },
        %{claimed_server | config: local_mcp_config(FailingRebindValidationRepo)}
      )

    assert get_in(next_claim_response, ["error", "code"]) == -32_000
    assert get_in(next_claim_response, ["error", "data", "reason"]) == "ledger_unavailable"
    refute get_in(next_claim_response, ["result", "structuredContent", "assignment", "work_package_id"]) == next_package.id
    assert next_server.session.assignment.work_package_id == package.id
  end

  test "batch final state keeps refreshed local claim session after later non-claim items", %{repo: repo} do
    package = create_local_claim_package!(repo, "SYMPP-BATCH-REFRESHED-CLAIM")
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    stale_assignment = %{assignment | capabilities: []}
    stale_session = Session.new(stale_assignment, proof_hash: minted.grant.secret_hash)

    {responses, server} =
      Server.handle_state(
        [
          %{
            "jsonrpc" => "2.0",
            "id" => "claim",
            "method" => "tools/call",
            "params" => %{"name" => "claim_local_assignment", "arguments" => local_assignment_claim_args(package, %{"claimed_by" => "worker-1"})}
          },
          %{"jsonrpc" => "2.0", "id" => "assignment", "method" => "tools/call", "params" => %{"name" => "get_current_assignment"}}
        ],
        %{local_mcp_server(local_mcp_config(repo), "local-refreshed-batch-claim-state") | session: stale_session}
      )

    assert Enum.map(responses, & &1["id"]) == ["claim", "assignment"]
    assert get_in(Enum.at(responses, 0), ["result", "structuredContent", "assignment", "capabilities"]) == minted.grant.capabilities
    assert server.session.assignment.capabilities == minted.grant.capabilities
  end
end
