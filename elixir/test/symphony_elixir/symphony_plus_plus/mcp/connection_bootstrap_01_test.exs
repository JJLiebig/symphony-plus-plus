Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.ConnectionBootstrap01Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  test "session grant validation accepts nil expiry and rejects inactive or unclaimed grants" do
    now = ~U[2026-05-04 12:00:00Z]

    grant = %AccessGrant{
      id: "grant-1",
      work_package_id: "SYMPP-SESSION-GRANT",
      display_key: "ABCD",
      grant_role: "worker",
      capabilities: ["read:own"],
      expires_at: DateTime.add(now, 60, :second),
      claimed_at: now,
      claimed_by: "worker-1"
    }

    scopes = [Scope.work_package(grant.work_package_id)]

    assert {:ok, session} = Session.from_grant(grant, now, proof_hash: "proof", scopes: scopes)
    assert session.assignment.work_package_id == "SYMPP-SESSION-GRANT"
    assert session.assignment.scopes == scopes

    assert Session.from_grant(grant, now, proof_hash: "proof") == {:error, :missing_grant_scopes}
    assert Session.from_grant(%{grant | revoked_at: now}, now, scopes: scopes) == {:error, :revoked}
    assert Session.from_grant(%{grant | expires_at: now}, now, scopes: scopes) == {:error, :expired}
    assert {:ok, nil_expiry_session} = Session.from_grant(%{grant | expires_at: nil}, now, scopes: scopes)
    assert nil_expiry_session.assignment.grant_id == grant.id
    assert Session.from_grant(%{grant | claimed_at: nil}, now, scopes: scopes) == {:error, :unclaimed}
    assert Session.from_grant(%{grant | claimed_by: " "}, now, scopes: scopes) == {:error, :missing_claim_identity}
  end

  test "auth helpers reject missing invalid and mismatched sessions" do
    session =
      Session.new(%Assignment{
        grant_id: "grant-1",
        work_package_id: "SYMPP-AUTH",
        display_key: "ABCD",
        grant_role: "worker",
        capabilities: [],
        claimed_at: ~U[2026-05-04 12:00:00Z],
        claimed_by: "worker-1"
      })

    assert Auth.require_work_package(session, "SYMPP-OTHER", UnexpectedAuthRepo) ==
             {:error, {:service_unavailable, {:unexpected_grant_lookup_result, :tuple}}}
  end

  test "direct raw-proof session validation retires terminal worker authority", %{repo: repo} do
    assert {:ok, package} =
             WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-AUTH-TERMINAL", kind: "mcp", status: "ready_for_worker"))

    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    assert {:ok, _terminal_package} = WorkPackageRepository.update(repo, package.id, %{status: "merged"})

    assert Auth.require_session(session, repo) == {:error, {:unauthorized, :work_package_terminal}}
  end

  test "direct phase architect proof retires with its anchor while WorkRequest handoff authority is separate", %{repo: repo} do
    {package, session, _grant} = create_phase_architect_session(repo, "SYMPP-AUTH-ARCH-TERMINAL", ["read:phase"])

    assert {:ok, _live_session} = Auth.require_session(session, repo)

    assert {:ok, _terminal_package} = WorkPackageRepository.update(repo, package.id, %{status: "merged"})

    assert Auth.require_session(session, repo) == {:error, {:unauthorized, :work_package_terminal}}
  end

  test "WorkRequest architect sessions follow handoff authority instead of anchor terminality", %{repo: repo} do
    work_request = create_work_request!(repo, id: "WR-AUTH-ARCH-HANDOFF", status: "sliced")

    {anchor, session, grant} =
      create_work_request_handoff_architect_session(repo, work_request, ArchitectHandoff.capabilities())

    assert {:ok, _terminal_anchor} = WorkPackageRepository.update(repo, anchor.id, %{status: "merged"})
    assert {:ok, live_session} = Auth.require_session(session, repo)
    assert live_session.assignment.grant_id == grant.id

    completed_at = DateTime.utc_now(:microsecond)

    assert {1, nil} =
             repo.update_all(
               from(request in WorkRequest, where: request.id == ^work_request.id),
               set: [completed_at: completed_at, completion_source: "operator"]
             )

    assert Auth.require_session(session, repo) ==
             {:error, {:unauthorized, {:work_request_terminal, :completed}}}

    assert {1, nil} =
             repo.update_all(
               from(request in WorkRequest, where: request.id == ^work_request.id),
               set: [completed_at: nil, completion_source: nil]
             )

    assert {1, nil} =
             repo.update_all(
               from(access_grant in AccessGrant, where: access_grant.id == ^grant.id),
               set: [expires_at: DateTime.add(completed_at, -1, :second)]
             )

    assert Auth.require_session(session, repo) == {:error, {:unauthorized, :expired}}

    assert {1, nil} =
             repo.update_all(
               from(access_grant in AccessGrant, where: access_grant.id == ^grant.id),
               set: [expires_at: nil]
             )

    assert {:ok, _revoked} = AccessGrantService.revoke(repo, grant.id)
    assert Auth.require_session(session, repo) == {:error, {:unauthorized, :revoked}}
  end

  test "database-scoped repo binding reaches the requested ledger while the default repo is running" do
    database_path = WorkPackageFactory.database_path()
    original_repo = Repo.get_dynamic_repo()

    {:ok, pid} =
      Repo.start_link(database: database_path, name: Repo.process_name(database_path), pool_size: 1, log: false)

    try do
      Repo.put_dynamic_repo(pid)

      assert {:ok, %{rows: rows}} = Repo.query("PRAGMA database_list", [], log: false)
      assert Enum.any?(rows, &main_database_row_matches?(&1, database_path))
    after
      Repo.put_dynamic_repo(original_repo)
      GenServer.stop(pid)
      File.rm(database_path)
    end
  end

  test "health and explicit state keys follow atom-valued dynamic repos" do
    database_path = WorkPackageFactory.database_path()
    original_repo = Repo.get_dynamic_repo()
    repo_name = :"sympp_mcp_named_dynamic_#{System.unique_integer([:positive])}"

    {:ok, pid} =
      Repo.start_link(database: database_path, name: repo_name, pool_size: 1, log: false)

    try do
      Repo.put_dynamic_repo(repo_name)
      assert :ok = WorkPackageRepository.migrate(Repo)

      health_response =
        MCPHarness.request(
          %{
            "jsonrpc" => "2.0",
            "id" => "named-health",
            "method" => "tools/call",
            "params" => %{"name" => "sympp.health", "arguments" => %{}}
          },
          config: Config.default(repo: Repo)
        )

      {_initialize_response, _server} =
        Server.handle_response_state(
          %{"jsonrpc" => "2.0", "id" => "named-init", "method" => "initialize", "params" => initialize_params()},
          Server.new(Config.default(repo: Repo), state_key: "named-dynamic-ledger-state")
        )

      {tools_response, _server} =
        Server.handle_response_state(
          %{"jsonrpc" => "2.0", "id" => "named-tools", "method" => "tools/list", "params" => %{}},
          Server.new(Config.default(repo: Repo), state_key: "named-dynamic-ledger-state")
        )

      assert get_in(health_response, ["result", "structuredContent", "ledger", "reachable"]) == true
      assert is_list(get_in(tools_response, ["result", "tools"]))
    after
      Repo.put_dynamic_repo(original_repo)
      if Process.alive?(pid), do: GenServer.stop(pid)
      File.rm(database_path)
    end
  end

  test "health distinguishes configured-default identity from mismatched live sqlite storage", %{repo: repo} do
    database_path = current_main_database_path(repo)

    default_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "default-health",
          "method" => "tools/call",
          "params" => %{"name" => "sympp.health", "arguments" => %{}}
        },
        config: Config.default(repo: repo)
      )

    default_identity = get_in(default_response, ["result", "structuredContent", "ledger", "identity"])

    assert get_in(default_response, ["result", "structuredContent", "ledger", "reachable"]) == true
    assert default_identity["kind"] == "sqlite"
    assert default_identity["source"] == "default"
    assert is_binary(default_identity["display_path"])
    assert is_boolean(default_identity["default_home"])
    assert String.ends_with?(default_identity["display_path"], Path.basename(database_path))

    mismatched_database_path = WorkPackageFactory.database_path()

    mismatched_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "mismatched-explicit-health",
          "method" => "tools/call",
          "params" => %{"name" => "sympp.health", "arguments" => %{}}
        },
        config: Config.default(repo: repo, database: mismatched_database_path)
      )

    assert get_in(mismatched_response, ["result", "structuredContent", "status"]) == "degraded"
    assert get_in(mismatched_response, ["result", "structuredContent", "ledger", "reachable"]) == false
    assert get_in(mismatched_response, ["result", "structuredContent", "ledger", "identity", "kind"]) == "sqlite"
    assert get_in(mismatched_response, ["result", "structuredContent", "ledger", "identity", "source"]) == "explicit"
    assert get_in(mismatched_response, ["result", "structuredContent", "ledger", "error"]) == "ledger_unavailable"

    File.rm(mismatched_database_path)
  end

  test "health redacts credential-bearing ledger identity values", %{repo: repo} do
    sqlite_secret = "sqlite_password_that_must_not_echo"
    sqlite_uri = sqlite_file_uri(current_main_database_path(repo), "password=#{sqlite_secret}&cache=shared")

    sqlite_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "sqlite-health",
          "method" => "tools/call",
          "params" => %{"name" => "sympp.health", "arguments" => %{}}
        },
        config: Config.default(repo: repo, database: sqlite_uri)
      )

    assert get_in(sqlite_response, ["result", "structuredContent", "ledger", "identity", "kind"]) == "sqlite"
    assert get_in(sqlite_response, ["result", "structuredContent", "ledger", "identity", "source"]) == "explicit"
    assert get_in(sqlite_response, ["result", "structuredContent", "ledger", "reachable"]) == true
    refute inspect(sqlite_response) =~ sqlite_secret
    refute inspect(sqlite_response) =~ "password="

    remote_secret = "remote_secret_that_must_not_echo"
    remote_database = "https://worker:#{remote_secret}@ledger-prod.example.test:9443/mcp?token=#{remote_secret}"

    remote_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "remote-health",
          "method" => "tools/call",
          "params" => %{"name" => "sympp.health", "arguments" => %{}}
        },
        config: Config.default(repo: FailingHealthRepo, database: remote_database)
      )

    assert get_in(remote_response, ["result", "structuredContent", "ledger", "reachable"]) == false

    assert get_in(remote_response, ["result", "structuredContent", "ledger", "identity"]) == %{
             "kind" => "server",
             "source" => "explicit",
             "endpoint" => "https://ledger-prod.example.test:9443"
           }

    refute inspect(remote_response) =~ remote_secret
    refute inspect(remote_response) =~ "worker:"
    refute inspect(remote_response) =~ "token="

    dsn_secret = "dsn_password_that_must_not_echo"
    dsn_database = "Server=tcp:ledger-dsn.example.test,1433;Database=sympp;Password=#{dsn_secret}"

    dsn_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "dsn-health",
          "method" => "tools/call",
          "params" => %{"name" => "sympp.health", "arguments" => %{}}
        },
        config: Config.default(repo: FailingHealthRepo, database: dsn_database)
      )

    assert get_in(dsn_response, ["result", "structuredContent", "ledger", "identity"]) == %{
             "kind" => "server",
             "source" => "explicit",
             "endpoint" => "server://ledger-dsn.example.test:1433"
           }

    refute inspect(dsn_response) =~ dsn_secret
    refute inspect(dsn_response) =~ "Password="
    refute inspect(dsn_response) =~ "Server="
  end

  test "health uses default remote repo config as safe server identity" do
    Code.ensure_loaded!(DefaultRemoteHealthRepo)
    assert {:ok, _result} = DefaultRemoteHealthRepo.query("SELECT 1", [], [])

    response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "default-remote-health",
          "method" => "tools/call",
          "params" => %{"name" => "sympp.health", "arguments" => %{}}
        },
        config: Config.default(repo: DefaultRemoteHealthRepo)
      )

    result = get_in(response, ["result", "structuredContent"])

    assert result["status"] == "ok"
    assert result["ledger"]["reachable"] == true

    assert result["ledger"]["identity"] == %{
             "kind" => "server",
             "source" => "default",
             "endpoint" => "server://ledger-prod.example.test:15432"
           }

    refute inspect(response) =~ "dbname=sympp"
    refute inspect(response) =~ "host="

    explicit_name_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "explicit-remote-name-health",
          "method" => "tools/call",
          "params" => %{"name" => "sympp.health", "arguments" => %{}}
        },
        config: Config.default(repo: DefaultRemoteHealthRepo, database: "sympp")
      )

    assert get_in(explicit_name_response, ["result", "structuredContent", "ledger", "reachable"]) == true

    assert get_in(explicit_name_response, ["result", "structuredContent", "ledger", "identity"]) == %{
             "kind" => "server",
             "source" => "explicit",
             "endpoint" => "server://ledger-prod.example.test:15432"
           }

    ipv6_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "default-remote-ipv6-health",
          "method" => "tools/call",
          "params" => %{"name" => "sympp.health", "arguments" => %{}}
        },
        config: Config.default(repo: DefaultRemoteIpv6HealthRepo)
      )

    assert get_in(ipv6_response, ["result", "structuredContent", "ledger", "identity"]) == %{
             "kind" => "server",
             "source" => "default",
             "endpoint" => "server://[::1]:15432"
           }

    dbname_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "default-remote-dbname-health",
          "method" => "tools/call",
          "params" => %{"name" => "sympp.health", "arguments" => %{}}
        },
        config: Config.default(repo: DefaultRemoteDbnameHealthRepo)
      )

    assert get_in(dbname_response, ["result", "structuredContent", "ledger", "reachable"]) == true

    assert get_in(dbname_response, ["result", "structuredContent", "ledger", "identity"]) == %{
             "kind" => "server",
             "source" => "default",
             "endpoint" => "server"
           }

    explicit_dbname_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "explicit-remote-dbname-health",
          "method" => "tools/call",
          "params" => %{"name" => "sympp.health", "arguments" => %{}}
        },
        config: Config.default(repo: DefaultRemoteDbnameHealthRepo, database: "dbname=sympp")
      )

    assert get_in(explicit_dbname_response, ["result", "structuredContent", "ledger", "reachable"]) == true

    assert get_in(explicit_dbname_response, ["result", "structuredContent", "ledger", "identity"]) == %{
             "kind" => "server",
             "source" => "explicit",
             "endpoint" => "server"
           }
  end

  test "mix task database option reaches the requested ledger while the default repo is running" do
    database_path = WorkPackageFactory.database_path()
    original_repo = Repo.get_dynamic_repo()
    original_logger_config = Application.fetch_env(:logger, :console)

    input =
      [
        Jason.encode!(%{"jsonrpc" => "2.0", "id" => 1, "method" => "initialize", "params" => initialize_params()}),
        Jason.encode!(%{"jsonrpc" => "2.0", "id" => 2, "method" => "tools/call", "params" => %{"name" => "sympp.health", "arguments" => %{}}})
      ]
      |> Enum.join("\n")
      |> Kernel.<>("\n")

    output =
      capture_io(input, fn ->
        McpTask.run(["--database", database_path])
      end)

    responses = decode_json_lines(output)

    assert Enum.any?(responses, fn response ->
             get_in(response, ["result", "structuredContent", "ledger", "reachable"]) == true
           end)

    assert Repo.get_dynamic_repo() == original_repo
    assert :global.whereis_name(Repo.process_key(database_path)) == :undefined
    assert Application.fetch_env(:logger, :console) == original_logger_config
    File.rm(database_path)
  end

  test "mix task without database option reuses the current dynamic repo" do
    database_path = WorkPackageFactory.database_path()
    original_repo = Repo.get_dynamic_repo()

    {:ok, pid} =
      Repo.start_link(database: database_path, name: Repo.process_name(database_path), pool_size: 1, log: false)

    try do
      Repo.put_dynamic_repo(pid)
      assert :ok = WorkPackageRepository.migrate(Repo)

      assert {:ok, package} =
               WorkPackageRepository.create(
                 Repo,
                 WorkPackageFactory.attrs(id: "SYMPP-P3-001", status: "ready_for_worker")
               )

      assert {:ok, _minted} = AccessGrantService.mint_worker_grant(Repo, package.id)

      input =
        [
          Jason.encode!(%{"jsonrpc" => "2.0", "id" => "init", "method" => "initialize", "params" => initialize_params()}),
          Jason.encode!(%{
            "jsonrpc" => "2.0",
            "id" => "claim",
            "method" => "tools/call",
            "params" => %{
              "name" => "claim_local_assignment",
              "arguments" => %{"work_package_id" => package.id, "claimed_by" => "worker-1"}
            }
          }),
          Jason.encode!(%{
            "jsonrpc" => "2.0",
            "id" => 1,
            "method" => "resources/read",
            "params" => %{"uri" => "sympp://assignment/current"}
          })
        ]
        |> Enum.join("\n")
        |> Kernel.<>("\n")

      output =
        capture_io(input, fn ->
          McpTask.run([])
        end)

      [_init_response, _claim_response, response] = decode_json_lines(output)
      text = get_in(response, ["result", "contents", Access.at(0), "text"])

      assert Jason.decode!(text)["work_package_id"] == "SYMPP-P3-001"
      assert Repo.get_dynamic_repo() == pid
    after
      Repo.put_dynamic_repo(original_repo)
      GenServer.stop(pid)
      File.rm(database_path)
    end
  end

  test "mix task rejects removed work key secret environment options" do
    env_var = "SYMPP_MCP_TEST_SECRET_#{System.unique_integer([:positive])}"

    try do
      System.put_env(env_var, "removed-secret-bootstrap")

      assert_raise Mix.Error, ~r/Usage: mix sympp\.mcp/, fn ->
        capture_io("", fn ->
          McpTask.run(["--work-key-secret-env", env_var])
        end)
      end

      assert {:error, usage} = Config.parse(["--work-key-secret-env", env_var, "--claimed-by", "  "])
      assert usage =~ "Usage: mix sympp.mcp"
      assert {:error, usage} = Config.parse(["--work-key-secret-env", env_var, "--claimed-by", "worker-1"])
      assert usage =~ "Usage: mix sympp.mcp"
    after
      System.delete_env(env_var)
    end
  end

  test "mix task migrates legacy access grant expiry before serving a database-scoped session" do
    database_path = WorkPackageFactory.database_path()
    original_repo = Repo.get_dynamic_repo()

    {:ok, pid} =
      Repo.start_link(database: database_path, name: Repo.process_name(database_path), pool_size: 1, log: false)

    try do
      Repo.put_dynamic_repo(pid)
      assert :ok = WorkPackageRepository.migrate(Repo)
      assert {:ok, package} = WorkPackageRepository.create(Repo, WorkPackageFactory.attrs(id: "SYMPP-MCP-LEGACY-ENV"))

      assert {:ok, _minted} =
               AccessGrantService.mint_worker_grant(Repo, package.id, expires_at: ~U[2030-01-01 00:00:00Z])

      rebuild_access_grants_with_not_null_expiry!(pid)
      remove_null_expiry_migration_version!(pid)
      assert access_grant_expiry_not_null?(pid)

      input =
        [
          Jason.encode!(%{"jsonrpc" => "2.0", "id" => "init", "method" => "initialize", "params" => initialize_params()}),
          Jason.encode!(%{
            "jsonrpc" => "2.0",
            "id" => "health",
            "method" => "tools/call",
            "params" => %{"name" => "sympp.health", "arguments" => %{}}
          })
        ]
        |> Enum.join("\n")
        |> Kernel.<>("\n")

      output =
        capture_io(input, fn ->
          McpTask.run(["--database", database_path])
        end)

      [_init_response, response] = decode_json_lines(output)

      assert get_in(response, ["result", "structuredContent", "ledger", "reachable"]) == true
      refute access_grant_expiry_not_null?(pid)
      assert schema_migration_recorded?(pid, 20_260_519_120_000)
    after
      Repo.put_dynamic_repo(original_repo)
      GenServer.stop(pid)
      File.rm(database_path)
    end
  end

  test "MCP repository preparation is cached after a successful migration" do
    database_path = WorkPackageFactory.database_path()
    original_repo = Repo.get_dynamic_repo()

    {:ok, pid} =
      Repo.start_link(database: database_path, name: Repo.process_name(database_path), pool_size: 1, log: false)

    try do
      Repo.put_dynamic_repo(pid)
      assert :ok = MCPRepository.ensure_migrated(Repo)

      assert :ets.info(MCPRepository, :owner) ==
               Process.whereis(SymphonyElixir.SymphonyPlusPlus.MCP.HTTPStateStore)

      handler_id = {__MODULE__, self(), :migration_query_probe}
      event = Repo.config()[:telemetry_prefix] ++ [:query]

      :ok =
        :telemetry.attach(
          handler_id,
          event,
          fn _event, _measurements, metadata, test_pid -> send(test_pid, {:migration_query, metadata.query}) end,
          self()
        )

      on_exit(fn -> :telemetry.detach(handler_id) end)

      parent = self()

      lock_task =
        Task.async(fn ->
          TrackerAdapter.migration_file_lock_for_test(database_path, fn ->
            send(parent, :migration_file_lock_acquired)

            receive do
              :release_migration_file_lock -> :ok
            end
          end)
        end)

      assert_receive :migration_file_lock_acquired, 1_000

      ensure_task =
        Task.async(fn ->
          task_original_repo = Repo.get_dynamic_repo()

          try do
            Repo.put_dynamic_repo(pid)
            MCPRepository.ensure_migrated(Repo)
          after
            Repo.put_dynamic_repo(task_original_repo)
          end
        end)

      ensure_result = Task.yield(ensure_task, 500) || Task.shutdown(ensure_task, :brutal_kill)

      send(lock_task.pid, :release_migration_file_lock)
      assert :ok = Task.await(lock_task)
      assert {:ok, :ok} = ensure_result
      refute_receive {:migration_query, _query}
    after
      Repo.put_dynamic_repo(original_repo)
      GenServer.stop(pid)
      File.rm(database_path)
    end
  end

  test "MCP repository preparation cache does not cross live repo processes" do
    first_database = WorkPackageFactory.database_path()
    second_database = WorkPackageFactory.database_path()
    original_repo = Repo.get_dynamic_repo()

    try do
      {:ok, first_pid} =
        Repo.start_link(database: first_database, name: Repo.process_name(first_database), pool_size: 1, log: false)

      Repo.put_dynamic_repo(first_pid)
      assert :ok = MCPRepository.ensure_migrated(Repo)
      GenServer.stop(first_pid)

      {:ok, second_pid} =
        Repo.start_link(database: second_database, name: Repo.process_name(second_database), pool_size: 1, log: false)

      Repo.put_dynamic_repo(second_pid)
      assert :ok = MCPRepository.ensure_migrated(Repo)

      assert {:ok, %{rows: [[1]]}} =
               Repo.query(
                 "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sympp_mcp_session_bindings'",
                 [],
                 log: false
               )

      GenServer.stop(second_pid)
    after
      Repo.put_dynamic_repo(original_repo)
      File.rm(first_database)
      File.rm(second_database)
    end
  end
end
