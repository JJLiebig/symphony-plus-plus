Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.ClaimSessionTransport01Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  test "health tool reaches the test ledger without exposing package rows", %{repo: repo} do
    assert {:ok, _work_package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-P3-001"))

    response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "health",
          "method" => "tools/call",
          "params" => %{"name" => "sympp.health", "arguments" => %{}}
        },
        config: Config.default(repo: repo, source_revision: "ABCDEF1234567890ABCDEF1234567890ABCDEF12")
      )

    result = get_in(response, ["result", "structuredContent"])
    text = get_in(response, ["result", "content", Access.at(0), "text"])

    assert result["status"] == "ok"
    assert result["ledger"]["reachable"] == true
    assert get_in(result, ["ledger", "identity", "kind"]) == "sqlite"
    assert get_in(result, ["ledger", "identity", "source"]) == "default"
    assert result["mode"] == "stdio"
    assert result["source"]["revision"] == "abcdef1234567890abcdef1234567890abcdef12"
    assert result["source"]["mcp_contract"] == Server.mcp_contract_identity()
    assert result["source"]["mcp_contract"]["fingerprint"] =~ ~r/\A[0-9a-f]{64}\z/
    refute text =~ "SYMPP-P3-001"
  end

  test "health tool hides raw ledger failure details" do
    response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "health",
          "method" => "tools/call",
          "params" => %{"name" => "sympp.health", "arguments" => %{}}
        },
        config: Config.default(repo: FailingHealthRepo)
      )

    result = get_in(response, ["result", "structuredContent"])
    text = get_in(response, ["result", "content", Access.at(0), "text"])

    assert result["status"] == "degraded"
    assert result["ledger"]["reachable"] == false
    assert result["ledger"]["error"] == "ledger_unavailable"
    assert get_in(result, ["ledger", "identity"]) == %{"kind" => "unknown", "source" => "default"}
    refute text =~ "C:/secret/path.sqlite"
    refute text =~ "RuntimeError"
  end

  test "stdio read errors keep expected disconnects graceful" do
    assert :ok = Stdio.handle_read_error(:terminated)
    assert :ok = Stdio.handle_read_error(:closed)

    assert_raise IO.StreamError, fn ->
      Stdio.handle_read_error(:eperm)
    end
  end

  test "stdio decoded payload helper retains response-only initialized state", %{repo: repo} do
    server = Server.new(Config.default(repo: repo))

    init_response =
      Stdio.handle_payload(
        %{"jsonrpc" => "2.0", "id" => "init", "method" => "initialize", "params" => initialize_params()},
        server
      )

    tools_response =
      Stdio.handle_payload(
        %{"jsonrpc" => "2.0", "id" => "tools", "method" => "tools/list", "params" => %{}},
        server
      )

    assert get_in(init_response, ["result", "serverInfo", "name"]) == "symphony-plus-plus"
    assert is_list(get_in(tools_response, ["result", "tools"]))
  end

  test "one of 100 simultaneous owners atomically claims and activates the package", %{repo: repo} do
    package = create_local_claim_package!(repo, "SYMPP-ATOMIC-CLAIM-100")
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)

    responses =
      1..100
      |> Task.async_stream(
        fn attempt ->
          arguments = local_assignment_claim_args(package, %{"claimed_by" => "claimant-#{attempt}"})

          Server.handle_state(
            %{
              "jsonrpc" => "2.0",
              "id" => "claim-#{attempt}",
              "method" => "tools/call",
              "params" => %{"name" => "claim_local_assignment", "arguments" => arguments}
            },
            local_mcp_server(local_mcp_config(repo), "atomic-claim-#{attempt}")
          )
        end,
        max_concurrency: 100,
        ordered: false,
        timeout: 30_000
      )
      |> Enum.map(fn {:ok, response} -> response end)

    successful = Enum.filter(responses, fn {response, _server} -> get_in(response, ["result", "structuredContent", "assignment"]) end)
    assert length(successful) == 1

    assert Enum.all?(responses -- successful, fn {response, server} ->
             get_in(response, ["result", "structuredContent", "assignment"]) == nil and server.session == nil
           end)

    assert [{_response, winning_server}] = successful
    assert winning_server.session.assignment.work_package_id == package.id

    assert {:ok, active_package} = WorkPackageRepository.get(repo, package.id)
    assert active_package.status == "active"

    assert [active_lease] =
             repo.all(
               from(claim_lease in ClaimLease,
                 where: claim_lease.work_package_id == ^package.id and claim_lease.status == "active"
               )
             )

    assert active_lease.actor_display_name =~ "claimant-"

    assert [claimed_grant] =
             repo.all(
               from(grant in AccessGrant,
                 where: grant.work_package_id == ^package.id and not is_nil(grant.claimed_at) and is_nil(grant.revoked_at)
               )
             )

    assert claimed_grant.id == minted.grant.id
    assert repo.aggregate(from(grant in AccessGrant, where: grant.work_package_id == ^package.id), :count) == 1
    assert repo.aggregate(from(claim_lease in ClaimLease, where: claim_lease.work_package_id == ^package.id), :count) == 1
  end

  test "claim_local_assignment rejects active orphaned claim lease before grant binding", %{repo: repo} do
    package = create_local_claim_package!(repo, "SYMPP-LOCAL-CALLER-IN-FLIGHT")
    assert {:ok, _minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    arguments = local_assignment_claim_args(package)

    assert {:ok, %ClaimLease{id: lease_id}} =
             ClaimLeaseService.claim(
               repo,
               package.id,
               local_assignment_claim_actor(arguments),
               stale_after_ms: :timer.minutes(5)
             )

    {other_caller_response, _server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "local-caller-in-flight-other",
          "method" => "tools/call",
          "params" => %{
            "name" => "claim_local_assignment",
            "arguments" => Map.put(arguments, "claimed_by", "local-worker-2")
          }
        },
        local_mcp_server(local_mcp_config(repo), "local-caller-in-flight-other-state")
      )

    assert get_in(other_caller_response, ["error", "data", "reason"]) == "claim_lease_active_for_other_actor"

    assert {:ok, %ClaimLease{id: ^lease_id, status: "active", actor_display_name: "local-worker-1"}} =
             ClaimLeaseService.current_for_work_package(repo, package.id)

    assert repo.aggregate(
             from(claim_lease in ClaimLease, where: claim_lease.work_package_id == ^package.id and claim_lease.status != "active"),
             :count
           ) == 0

    assert %ClaimLease{id: ^lease_id, status: "active", release_reason: nil} = repo.get(ClaimLease, lease_id)
  end

  test "claim_local_assignment claims the newest live worker grant", %{repo: repo} do
    package = create_local_claim_package!(repo, "SYMPP-LOCAL-NEWEST-GRANT")
    assert {:ok, older} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, newer} = AccessGrantService.mint_worker_grant(repo, package.id)

    repo.update!(
      Ecto.Changeset.change(older.grant,
        inserted_at: ~U[2026-01-01 00:00:00.000000Z],
        updated_at: ~U[2026-01-01 00:00:00.000000Z]
      )
    )

    repo.update!(
      Ecto.Changeset.change(newer.grant,
        inserted_at: ~U[2026-01-02 00:00:00.000000Z],
        updated_at: ~U[2026-01-02 00:00:00.000000Z]
      )
    )

    {response, _server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "local-newest-grant",
          "method" => "tools/call",
          "params" => %{"name" => "claim_local_assignment", "arguments" => local_assignment_claim_args(package)}
        },
        local_mcp_server(local_mcp_config(repo), "local-newest-grant-state")
      )

    assert get_in(response, ["result", "structuredContent", "assignment", "grant_id"]) == newer.grant.id
    assert {:ok, unclaimed_older} = AccessGrantRepository.get(repo, older.grant.id)
    assert unclaimed_older.claimed_at == nil
  end
end
