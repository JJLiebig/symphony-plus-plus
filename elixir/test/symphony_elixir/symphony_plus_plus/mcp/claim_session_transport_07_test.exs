Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.ClaimSessionTransport07Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  alias SymphonyElixir.SymphonyPlusPlus.ClaimLeases.ClaimLease
  alias SymphonyElixir.SymphonyPlusPlus.MCP.{HTTPStateStore, HTTPTransport}

  test "HTTP architect auto-claims once, excludes live owners, and reclaims stale ownership", %{repo: repo} do
    work_request =
      create_work_request!(repo,
        id: "WR-HTTP-STABLE-ARCHITECT-CATALOG",
        status: "ready_for_slicing"
      )

    assert {:ok, handoff} =
             ArchitectHandoff.create_or_replay(repo, work_request.id,
               local_operator?: true,
               handoff_opts: [
                 claimed_by: ArchitectHandoff.claimed_by(),
                 database: repo.database_path(),
                 local_architect_claim?: true
               ]
             )

    config = %{local_mcp_config(repo) | surface_profile: :architect}
    client_key = "client-http-stable-architect-catalog"

    {:ok, init_result} =
      HTTPTransport.handle(
        config,
        %{"jsonrpc" => "2.0", "id" => "init-stable-architect", "method" => "initialize", "params" => initialize_params()},
        client_key: client_key
      )

    state_key = init_result.state_key
    startup_tools = http!(config, client_key, state_key, "architect-tools", "tools/list", %{})
    startup_names = tool_names(startup_tools)

    assert MapSet.member?(startup_names, "slice_work_request")
    refute MapSet.member?(startup_names, "read_context")

    slice_arguments = %{
      "work_packages" => [
        %{
          "title" => "Stable catalog regression",
          "goal" => "Prove claim authorizes the startup catalog.",
          "kind" => "mcp",
          "allowed_file_globs" => ["elixir/lib/**"],
          "acceptance_criteria" => ["Slice succeeds without another tools/list."],
          "validation_steps" => ["mix test test/symphony_elixir/symphony_plus_plus/mcp/claim_session_transport_07_test.exs"],
          "stop_conditions" => ["Stop after the regression proves the flow."]
        }
      ]
    }

    unclaimed_slice =
      http!(config, client_key, state_key, "unclaimed-slice", "tools/call", %{
        "name" => "slice_work_request",
        "arguments" => slice_arguments
      })

    assert get_in(unclaimed_slice.response, ["error", "data", "reason"]) == "claim_required"

    slice =
      http!(config, client_key, state_key, "slice-without-relist", "tools/call", %{
        "name" => "slice_work_request",
        "arguments" => Map.put(slice_arguments, "work_request_id", work_request.id)
      })

    assert get_in(slice.response, ["result", "structuredContent", "status", "work_request_status"]) == "sliced"
    assert [_work_package_id] = get_in(slice.response, ["result", "structuredContent", "work_package_ids"])

    assert {:ok, rebound} =
             HTTPTransport.handle(
               config,
               [
                 %{"jsonrpc" => "2.0", "id" => "release-before-auto-claim", "method" => "tools/call", "params" => %{"name" => "release_current_assignment", "arguments" => %{}}},
                 %{"jsonrpc" => "2.0", "id" => "batch-auto-claim", "method" => "tools/call", "params" => %{"name" => "list_guidance_requests", "arguments" => %{"work_request_id" => work_request.id}}}
               ],
               client_key: client_key,
               state_key: state_key
             )

    assert get_in(Enum.at(rebound.response, 1), ["result", "structuredContent", "guidance_requests"]) == []
    HTTPStateStore.reset!()
    recovered = http!(config, client_key, state_key, "batch-binding-recovered", "tools/call", %{"name" => "list_guidance_requests", "arguments" => %{}})
    assert get_in(recovered.response, ["result", "structuredContent", "guidance_requests"]) == []
    assert {:ok, lease} = ClaimLeaseService.current_for_work_package(repo, handoff.anchor_package.id)

    assert {:ok, competing_init} =
             HTTPTransport.handle(
               config,
               %{"jsonrpc" => "2.0", "id" => "competing-init", "method" => "initialize", "params" => initialize_params()},
               client_key: "competing-architect"
             )

    guidance_params = %{"name" => "list_guidance_requests", "arguments" => %{"work_request_id" => work_request.id}}

    conflict = http!(config, "competing-architect", competing_init.state_key, "live-owner", "tools/call", guidance_params)
    assert get_in(conflict.response, ["error", "data", "reason"]) == "claim_lease_active_for_other_actor"
    assert {:ok, unchanged_lease} = ClaimLeaseService.current_for_work_package(repo, handoff.anchor_package.id)
    assert unchanged_lease == lease

    lease
    |> ClaimLease.update_changeset(%{last_seen_at: DateTime.add(DateTime.utc_now(:microsecond), -6, :minute)})
    |> repo.update!()

    reclaimed = http!(config, "competing-architect", competing_init.state_key, "stale-owner", "tools/call", guidance_params)
    assert get_in(reclaimed.response, ["result", "structuredContent", "guidance_requests"]) == []
    assert {:ok, replacement} = ClaimLeaseService.current_for_work_package(repo, handoff.anchor_package.id)
    refute replacement.id == lease.id
    refute replacement.actor_id == lease.actor_id

    HTTPStateStore.reset!()
    omitted_scope_params = %{"name" => "list_guidance_requests", "arguments" => %{}}
    recovered_conflict = http!(config, client_key, state_key, "known-scope-live-owner", "tools/call", omitted_scope_params)
    assert get_in(recovered_conflict.response, ["error", "data", "reason"]) == "claim_lease_active_for_other_actor"

    replacement
    |> ClaimLease.update_changeset(%{last_seen_at: DateTime.add(DateTime.utc_now(:microsecond), -6, :minute)})
    |> repo.update!()

    recovered_owner = http!(config, client_key, state_key, "known-scope-expired-owner", "tools/call", omitted_scope_params)
    assert get_in(recovered_owner.response, ["result", "structuredContent", "guidance_requests"]) == []
    assert {:ok, current_lease} = ClaimLeaseService.current_for_work_package(repo, handoff.anchor_package.id)
    assert current_lease.actor_display_name == lease.actor_display_name

    assert {:ok, _paused} = ClaimLeaseService.pause(repo, current_lease.id, %{"actor_id" => "operator"}, reason: "operator pause")
    blocked = http!(config, client_key, state_key, "paused-owner", "tools/call", guidance_params)
    assert get_in(blocked.response, ["error", "data", "reason"]) == "claim_lease_lost"
    still_blocked = http!(config, client_key, state_key, "paused-retry", "tools/call", guidance_params)
    assert get_in(still_blocked.response, ["error", "data", "reason"]) == "claim_lease_paused"

    assert 1 == repo.aggregate(from(package in WorkPackage, where: package.work_request_id == ^work_request.id and package.id != ^handoff.anchor_package.id), :count)
  end

  defp http!(config, client_key, state_key, id, method, params) do
    assert {:ok, result} =
             HTTPTransport.handle(
               config,
               %{"jsonrpc" => "2.0", "id" => id, "method" => method, "params" => params},
               client_key: client_key,
               state_key: state_key
             )

    result
  end

  defp tool_names(result) do
    result
    |> tool_specs()
    |> Enum.map(& &1["name"])
    |> MapSet.new()
  end

  defp tool_specs(result), do: get_in(result.response, ["result", "tools"])

  defp create_http_local_claim_package!(repo, id) do
    package = create_local_claim_package!(repo, id, base_branch: "main")

    work_request =
      create_work_request!(repo,
        id: "WR-#{id}",
        repo: package.repo,
        base_branch: package.base_branch,
        status: "ready_for_slicing"
      )

    package =
      repo.update!(
        Ecto.Changeset.change(package,
          work_request_id: work_request.id,
          sequence: 1,
          goal: package.engineering_scope,
          status: "ready_for_worker",
          dispatched_at: DateTime.utc_now(:microsecond)
        )
      )

    assert {:ok, _minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    {package, work_request}
  end
end
