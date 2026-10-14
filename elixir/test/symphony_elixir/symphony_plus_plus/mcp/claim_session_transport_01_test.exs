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

  test "version resource includes source revision for stale daemon diagnostics", %{repo: repo} do
    response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "version", "method" => "resources/read", "params" => %{"uri" => "sympp://health/version"}},
        config: Config.default(repo: repo, source_revision: "0123456789abcdef0123456789abcdef01234567")
      )

    assert %{"result" => %{"contents" => [%{"text" => text}]}} = response
    payload = Jason.decode!(text)

    assert payload["mode"] == "stdio"
    assert payload["source"]["revision"] == "0123456789abcdef0123456789abcdef01234567"
    assert payload["source"]["mcp_contract"] == Server.mcp_contract_identity()
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

  test "injected session exposes only current assignment and denies sibling package scope", %{repo: repo} do
    assert {:ok, own_package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-P3-001"))
    assert {:ok, _sibling_package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-P3-002"))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, own_package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")

    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    assignment_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => 5, "method" => "resources/read", "params" => %{"uri" => "sympp://assignment/current"}},
        repo: repo,
        session: session
      )

    assignment_payload =
      assignment_response
      |> get_in(["result", "contents", Access.at(0), "text"])
      |> Jason.decode!()

    assert assignment_payload["work_package_id"] == "SYMPP-P3-001"
    assert assignment_payload["claimed_by"] == "worker-1"
    refute inspect(assignment_payload) =~ minted.work_key.secret

    own_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => 6,
          "method" => "resources/read",
          "params" => %{"uri" => "sympp://work-packages/SYMPP-P3-001/task_plan.md"}
        },
        repo: repo,
        session: session
      )

    own_text = get_in(own_response, ["result", "contents", Access.at(0), "text"])
    assert own_text =~ "file: task_plan.md"
    assert own_text =~ "SYMPP-P3-001"

    sibling_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => 7,
          "method" => "resources/read",
          "params" => %{"uri" => "sympp://work-packages/SYMPP-P3-002/task_plan.md"}
        },
        repo: repo,
        session: session
      )

    assert get_in(sibling_response, ["error", "code"]) == -32_003
    assert get_in(sibling_response, ["error", "data", "reason"]) == "outside_session_scope"
  end

  test "claim_local_assignment binds the server session for worker lifecycle tools", %{repo: repo} do
    package = create_local_claim_package!(repo, "SYMPP-P3-002")
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    arguments = local_assignment_claim_args(package)

    server = Server.new(Config.default(repo: repo), initialized: true)

    {extra_argument_response, _server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "claim-extra-argument",
          "method" => "tools/call",
          "params" => %{
            "name" => "claim_local_assignment",
            "arguments" => Map.put(arguments, "unexpected", "value")
          }
        },
        server
      )

    assert get_in(extra_argument_response, ["error", "data", "reason"]) == "unexpected_argument"

    {claim_response, claimed_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "claim",
          "method" => "tools/call",
          "params" => %{
            "name" => "claim_local_assignment",
            "arguments" => arguments
          }
        },
        server
      )

    refute inspect(claim_response) =~ minted.work_key.secret
    assert get_in(claim_response, ["result", "structuredContent", "assignment", "work_package_id"]) == "SYMPP-P3-002"
    assert get_in(claim_response, ["result", "structuredContent", "local_claim", "lifecycle_state"]) == "active"
    assert {:ok, active_package} = WorkPackageRepository.get(repo, package.id)
    assert active_package.status == "active"

    {retry_claim_response, retry_claimed_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "claim-retry",
          "method" => "tools/call",
          "params" => %{
            "name" => "claim_local_assignment",
            "arguments" => arguments
          }
        },
        server
      )

    assert get_in(retry_claim_response, ["result", "structuredContent", "assignment", "work_package_id"]) == "SYMPP-P3-002"
    assert retry_claimed_server.session.assignment.work_package_id == "SYMPP-P3-002"
    assert {:ok, reconnected_package} = WorkPackageRepository.get(repo, package.id)
    assert reconnected_package.status == "active"

    assignment_response =
      Server.handle(
        %{"jsonrpc" => "2.0", "id" => "assignment", "method" => "tools/call", "params" => %{"name" => "get_current_assignment"}},
        claimed_server
      )

    assert get_in(assignment_response, ["result", "structuredContent", "assignment", "claimed_by"]) == "local-worker-1"

    abandon_response =
      Server.handle(
        %{
          "jsonrpc" => "2.0",
          "id" => "abandon",
          "method" => "tools/call",
          "params" => %{"name" => "abandon", "arguments" => %{"reason" => "Intentional worker closeout"}}
        },
        claimed_server
      )

    assert get_in(abandon_response, ["result", "structuredContent", "work_package", "status"]) == "abandoned"
    assert {:ok, abandoned_package} = WorkPackageRepository.get(repo, package.id)
    assert abandoned_package.status == "abandoned"
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

  test "claim_local_assignment claims and reconnects a worker session from scoped local identity", %{repo: repo} do
    package = create_local_claim_package!(repo, "SYMPP-LOCAL-RECONNECT")
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    arguments = local_assignment_claim_args(package)
    config = local_mcp_config(repo)

    work_request =
      create_work_request!(repo,
        id: "WR-MCP-LOCAL-RECONNECT",
        repo: package.repo,
        base_branch: package.base_branch,
        status: "ready_for_slicing"
      )

    assert {:ok, work_package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               work_request.id,
               work_request_work_package_attrs(
                 id: "WRS-MCP-LOCAL-RECONNECT",
                 base_branch: package.base_branch,
                 branch_pattern: package.branch_pattern
               )
             )

    assert {:ok, _canonical_package} =
             CanonicalWorkPackageFixtures.dispatch_work_package(
               repo,
               work_request.id,
               work_package.id,
               "planned",
               package.id
             )

    {claim_response, claimed_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "local-claim",
          "method" => "tools/call",
          "params" => %{"name" => "claim_local_assignment", "arguments" => arguments}
        },
        local_mcp_server(config, "local-claim-state")
      )

    assert get_in(claim_response, ["result", "structuredContent", "assignment", "work_package_id"]) == package.id
    assert get_in(claim_response, ["result", "structuredContent", "assignment", "claimed_by"]) == "local-worker-1"
    assert get_in(claim_response, ["result", "structuredContent", "local_claim", "mode"]) == "local-http"
    claim_text = assert_toon_tool_text!(claim_response)
    assert claim_text =~ "status: ok"
    assert claim_text =~ "work_package_id: #{package.id}"
    refute claim_text =~ "grant_id"
    refute claim_text =~ "claim_lease_id"
    refute claim_text =~ "caller_id"
    refute inspect(claim_response) =~ minted.work_key.secret
    assert claimed_server.session.assignment.work_package_id == package.id
    assert claimed_server.session.proof_hash == minted.grant.secret_hash

    assert {:ok, claimed_grant} = AccessGrantRepository.get(repo, minted.grant.id)
    assert claimed_grant.claimed_by == "local-worker-1"

    assert %ClaimLease{actor_display_name: "local-worker-1"} =
             repo.one(from(claim_lease in ClaimLease, where: claim_lease.work_package_id == ^package.id))

    {reconnect_response, reconnected_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "local-reconnect",
          "method" => "tools/call",
          "params" => %{
            "name" => "claim_local_assignment",
            "arguments" =>
              arguments
              |> Map.put("work_request_id", work_request.id)
          }
        },
        local_mcp_server(config, "local-reconnect-state")
      )

    assert get_in(reconnect_response, ["result", "structuredContent", "assignment", "grant_id"]) == minted.grant.id
    assert get_in(reconnect_response, ["result", "structuredContent", "local_claim", "claim_lease_action"]) == "heartbeat"

    assignment_response =
      Server.handle(
        %{"jsonrpc" => "2.0", "id" => "assignment", "method" => "tools/call", "params" => %{"name" => "get_current_assignment"}},
        reconnected_server
      )

    assert get_in(assignment_response, ["result", "structuredContent", "assignment", "work_package_id"]) == package.id
  end

  test "claim_local_assignment reconnects same owner across a different caller_id", %{repo: repo} do
    package = create_local_claim_package!(repo, "SYMPP-LOCAL-CALLER-ISOLATION")
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    arguments = local_assignment_claim_args(package)

    {claim_response, _claimed_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "local-caller-isolation-initial",
          "method" => "tools/call",
          "params" => %{"name" => "claim_local_assignment", "arguments" => arguments}
        },
        local_mcp_server(local_mcp_config(repo), "local-caller-isolation-initial-state")
      )

    assert get_in(claim_response, ["result", "structuredContent", "local_claim", "claim_lease_action"]) == "created"
    assert {:ok, %ClaimLease{id: lease_id, last_seen_at: last_seen_at}} = ClaimLeaseService.current_for_work_package(repo, package.id)

    {other_caller_response, other_caller_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "local-caller-isolation-other",
          "method" => "tools/call",
          "params" => %{
            "name" => "claim_local_assignment",
            "arguments" => Map.put(arguments, "caller_id", "codex-local-other")
          }
        },
        local_mcp_server(local_mcp_config(repo), "local-caller-isolation-other-state")
      )

    assert get_in(other_caller_response, ["result", "structuredContent", "assignment", "grant_id"]) == minted.grant.id
    assert get_in(other_caller_response, ["result", "structuredContent", "local_claim", "caller_id"]) == "codex-local-other"
    assert get_in(other_caller_response, ["result", "structuredContent", "local_claim", "claim_lease_action"]) == "heartbeat"
    assert other_caller_server.session.assignment.work_package_id == package.id

    assert {:ok, %ClaimLease{id: ^lease_id, status: "active", last_seen_at: refreshed_at}} =
             ClaimLeaseService.current_for_work_package(repo, package.id)

    assert DateTime.compare(refreshed_at, last_seen_at) != :lt

    assert repo.aggregate(
             from(claim_lease in ClaimLease, where: claim_lease.work_package_id == ^package.id and claim_lease.status != "active"),
             :count
           ) == 0
  end

  test "claim_local_assignment reconnects implicit same owner across local MCP states", %{repo: repo} do
    package = create_local_claim_package!(repo, "SYMPP-LOCAL-IMPLICIT-CALLER")
    assert {:ok, _minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    arguments = package |> local_assignment_claim_args() |> Map.delete("caller_id")
    config = local_mcp_config(repo)

    {claim_response, _claimed_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "local-implicit-caller-initial",
          "method" => "tools/call",
          "params" => %{"name" => "claim_local_assignment", "arguments" => arguments}
        },
        local_mcp_server(config, "local-implicit-caller-initial-state")
      )

    assert get_in(claim_response, ["result", "structuredContent", "local_claim", "claim_lease_action"]) == "created"
    initial_caller_id = get_in(claim_response, ["result", "structuredContent", "local_claim", "caller_id"])

    {other_state_response, _server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "local-implicit-caller-other",
          "method" => "tools/call",
          "params" => %{"name" => "claim_local_assignment", "arguments" => arguments}
        },
        local_mcp_server(config, "local-implicit-caller-other-state")
      )

    assert get_in(other_state_response, ["result", "structuredContent", "assignment", "work_package_id"]) == package.id
    assert get_in(other_state_response, ["result", "structuredContent", "local_claim", "claim_lease_action"]) == "heartbeat"
    other_caller_id = get_in(other_state_response, ["result", "structuredContent", "local_claim", "caller_id"])
    assert is_binary(initial_caller_id)
    assert is_binary(other_caller_id)
    refute initial_caller_id == other_caller_id
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
