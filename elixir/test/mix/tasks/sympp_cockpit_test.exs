defmodule Mix.Tasks.Sympp.CockpitTest do
  use ExUnit.Case, async: false

  alias Mix.Tasks.Sympp.BetaMigrate
  alias Mix.Tasks.Sympp.Cockpit, as: CockpitTask
  alias SymphonyElixir.SymphonyPlusPlus.GitHub.DefaultClient
  alias SymphonyElixir.SymphonyPlusPlus.MCP.{Config, Server, Stdio}
  alias SymphonyElixir.SymphonyPlusPlus.OfflineSandbox
  alias SymphonyElixir.SymphonyPlusPlus.OperatorDashboardOpener
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.RepoIdentity
  alias SymphonyElixir.SymphonyPlusPlus.ReviewObservation
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository, as: WorkRequestRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest
  alias SymphonyElixir.WorkPackageFactory
  alias SymphonyElixirWeb.Endpoint

  setup do
    Mix.Task.reenable("sympp.cockpit")
    previous_shell = Mix.shell()
    previous_database = Application.get_env(:symphony_elixir, :sympp_repo_database)
    previous_endpoint_config = Application.get_env(:symphony_elixir, Endpoint, [])
    previous_dashboard_origin = System.get_env("SYMPP_DASHBOARD_ORIGIN")
    previous_open_dashboard = System.get_env("SYMPP_OPEN_DASHBOARD")
    previous_defer_dashboard_open = System.get_env("SYMPP_DEFER_DASHBOARD_OPEN")

    Mix.shell(Mix.Shell.Process)
    System.delete_env("SYMPP_DASHBOARD_ORIGIN")
    System.delete_env("SYMPP_OPEN_DASHBOARD")
    System.delete_env("SYMPP_DEFER_DASHBOARD_OPEN")
    ensure_cockpit_dashboard_asset!()

    on_exit(fn ->
      Mix.shell(previous_shell)
      restore_env(:sympp_repo_database, previous_database)
      Application.put_env(:symphony_elixir, Endpoint, previous_endpoint_config)
      restore_system_env("SYMPP_DASHBOARD_ORIGIN", previous_dashboard_origin)
      restore_system_env("SYMPP_OPEN_DASHBOARD", previous_open_dashboard)
      restore_system_env("SYMPP_DEFER_DASHBOARD_OPEN", previous_defer_dashboard_open)
      stop_endpoint()
    end)

    :ok
  end

  test "marked snapshots refuse an unprotected boot and serve local actions with MCP and probes disabled" do
    database = WorkPackageFactory.database_path()
    previous = System.get_env("SYMPP_OFFLINE_SANDBOX")
    {:ok, connection} = Exqlite.Sqlite3.open(database)
    :ok = Exqlite.Sqlite3.execute(connection, "CREATE TABLE sympp_offline_sandbox (created_at TEXT NOT NULL)")
    :ok = Exqlite.Sqlite3.close(connection)

    try do
      System.delete_env("SYMPP_OFFLINE_SANDBOX")
      assert {:ok, opts} = CockpitTask.parse_args_for_test(["--database", database, "--port", "0", "--open-dashboard"])

      assert_raise RuntimeError, ~r/offline beta snapshot/, fn ->
        CockpitTask.run_cockpit_for_test(opts, fn -> flunk("unprotected HTTP server started") end)
      end

      assert_raise RuntimeError, ~r/offline beta snapshot/, fn ->
        Repo.init(:supervisor, database: database)
      end

      assert_raise RuntimeError, ~r/offline beta snapshot/, fn ->
        OfflineSandbox.verify!("file:#{URI.encode(database)}?mode=rwc")
      end

      System.put_env("SYMPP_OFFLINE_SANDBOX", "1")
      assert_raise RuntimeError, ~r/requires a marked snapshot/, fn -> OfflineSandbox.verify!(database <> ".missing") end
      BetaMigrate.run(["--database", database])
      assert :ok = OfflineSandbox.verify!(database)

      opts = Keyword.put(opts, :operator_dashboard_opener, fn _url -> flunk("browser opened") end)

      CockpitTask.run_cockpit_for_test(opts, fn ->
        assert is_list(Repo.config())
        port = wait_for_bound_port()
        origin = "http://127.0.0.1:#{port}"
        assert Req.get!(origin <> "/api/v1/sympp/operator/dashboard", headers: browser_api_headers()).status == 200
        assert Req.post!(origin <> "/mcp", json: %{jsonrpc: "2.0", id: 1, method: "initialize"}).status == 403
        assert Req.post!(origin <> "/mcp/client-lease", json: %{}).status == 403
        assert Req.get!(origin <> "/mcp/readiness").status == 200

        assert {:ok, request} =
                 WorkRequestRepository.create(Repo, %{
                   title: "Copied goal",
                   repo: "example/widget",
                   base_branch: "main",
                   work_type: "feature",
                   human_description: "Exercise a copied goal.",
                   desired_dispatch_shape: "single_package"
                 })

        path = origin <> "/api/v1/sympp/operator/work-requests/#{request.id}"
        assert Req.post!(path <> "/state", json: %{state: "completed"}, headers: browser_api_headers()).status == 200
        assert Req.post!(path <> "/archive", json: %{}, headers: browser_api_headers()).status == 200
        assert Req.post!(path <> "/delete", json: %{}, headers: browser_api_headers()).status == 200
        assert Repo.get(WorkRequest, request.id) == nil
        assert Req.post!(path <> "/architect-handoff", json: %{}, headers: browser_api_headers()).status == 403

        server = Server.new(Config.default())
        response = Stdio.handle_payload(%{"jsonrpc" => "2.0", "id" => 1, "method" => "initialize"}, server)
        assert response["error"]["data"]["reason"] == "offline_sandbox"

        package = %WorkPackage{id: "WP-OFFLINE", status: "active", worktree_path: File.cwd!(), review_requirement: %{"type" => "review-suite"}}

        assert ReviewObservation.observe([package],
                 find_executable: fn _name -> "/unused/probe" end,
                 runner: fn _, _, _, _ -> flunk("review probe") end
               ) == %{}

        assert RepoIdentity.local_git_origin_remote(File.cwd!()) == nil
        assert {:error, :offline_sandbox} = DefaultClient.auth_status()
        assert {:error, :offline_sandbox} = DefaultClient.get_json("repos/example/widget", [])
        assert :ok = OperatorDashboardOpener.open_once(opener: fn _url -> flunk("browser opened") end)
      end)
    after
      restore_system_env("SYMPP_OFFLINE_SANDBOX", previous)
      File.rm(database)
    end
  end

  test "serves the local operator cockpit before WorkRequest retention runs" do
    database_path = WorkPackageFactory.database_path()
    original_dynamic_repo = Repo.get_dynamic_repo()

    try do
      pid = start_supervised!({Repo, database: database_path, name: Repo.process_name(database_path), pool_size: 1})
      Repo.put_dynamic_repo(pid)
      assert :ok = WorkRequestRepository.migrate(Repo)
      request = completed_skipped_request!(~U[2026-05-01 00:00:00Z])

      assert {:ok, opts} =
               CockpitTask.parse_args_for_test([
                 "--database",
                 database_path,
                 "--port",
                 "0",
                 "--dashboard-origin",
                 "http://127.0.0.1:5174",
                 "--no-open-dashboard"
               ])

      opts =
        Keyword.put(opts, :operator_dashboard_opener, fn url ->
          send(self(), {:operator_dashboard_opened, url})
          :ok
        end)

      CockpitTask.run_cockpit_for_test(opts, fn ->
        port = wait_for_bound_port()

        config_response =
          Req.get!(operator_config_url(port),
            headers: configured_dashboard_api_headers(nil, "http://127.0.0.1:5174")
          )

        api_response =
          Req.get!("http://127.0.0.1:#{port}/api/v1/sympp/operator/dashboard",
            headers: configured_dashboard_api_headers(local_operator_session_cookie(config_response), "http://127.0.0.1:5174")
          )

        send(self(), {:retention_payload, config_response.status, api_response.status, api_response.body})
      end)

      refute_received {:operator_dashboard_opened, _url}
      assert_received {:retention_payload, 200, 200, payload}
      assert [%{"id" => request_id}] = payload["work_requests"]["work_requests"]
      assert request_id == request.id

      assert %WorkRequest{archived_at: nil} = Repo.get!(WorkRequest, request.id)
      assert [_slice] = Repo.all(WorkPackage)
    after
      Repo.put_dynamic_repo(original_dynamic_repo)
      File.rm(database_path)
    end
  end

  test "managed backend defers the immediate dashboard open" do
    database_path = WorkPackageFactory.database_path()
    System.put_env("SYMPP_DEFER_DASHBOARD_OPEN", "1")

    try do
      assert {:ok, opts} = CockpitTask.parse_args_for_test(["--database", database_path, "--port", "0", "--open-dashboard"])

      opts =
        Keyword.put(opts, :operator_dashboard_opener, fn url ->
          send(self(), {:operator_dashboard_opened, url})
          :ok
        end)

      CockpitTask.run_cockpit_for_test(opts, fn -> :ok end)

      refute_received {:operator_dashboard_opened, _url}
      assert_received {:mix_shell, :info, ["Dashboard browser open deferred until an MCP client connects."]}
    after
      File.rm(database_path)
    end
  end

  test "uses operator settings to suppress dashboard browser opening" do
    database_path = WorkPackageFactory.database_path()
    original_dynamic_repo = Repo.get_dynamic_repo()
    System.put_env("SYMPP_DEFER_DASHBOARD_OPEN", "1")

    try do
      pid = start_supervised!({Repo, database: database_path, name: Repo.process_name(database_path), pool_size: 1})
      Repo.put_dynamic_repo(pid)
      assert :ok = WorkRequestRepository.migrate(Repo)
      assert {:ok, _settings} = SymphonyElixir.SymphonyPlusPlus.OperatorSettings.Repository.update(Repo, %{"open_dashboard_on_boot" => false})

      assert {:ok, opts} = CockpitTask.parse_args_for_test(["--database", database_path, "--port", "0"])

      opts =
        Keyword.put(opts, :operator_dashboard_opener, fn url ->
          send(self(), {:operator_dashboard_opened, url})
          :ok
        end)

      CockpitTask.run_cockpit_for_test(opts, fn -> :ok end)

      refute_received {:operator_dashboard_opened, _url}
      assert_received {:mix_shell, :info, ["Dashboard browser auto-open disabled; pass --open-dashboard or set SYMPP_OPEN_DASHBOARD=1 to open it."]}
    after
      Repo.put_dynamic_repo(original_dynamic_repo)
      File.rm(database_path)
    end
  end

  test "reports an actionable error when WorkRequest retention cannot use the ledger" do
    database_path =
      System.tmp_dir!()
      |> Path.join("sympp-cockpit-missing-#{System.unique_integer([:positive])}")
      |> Path.join("ledger.sqlite3")

    assert {:ok, opts} =
             CockpitTask.parse_args_for_test([
               "--database",
               database_path,
               "--port",
               "0",
               "--dashboard-origin",
               "http://127.0.0.1:5174"
             ])

    try do
      File.mkdir_p!(database_path)

      assert_raise Mix.Error, ~r/Symphony\+\+ cockpit WorkRequest ledger (open|migration) failed:/, fn ->
        CockpitTask.run_cockpit_for_test(opts, fn ->
          assert is_integer(wait_for_bound_port())
        end)
      end
    after
      File.rm_rf(database_path)
    end
  end

  test "reports an actionable error when the configured port is already occupied" do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
    {:ok, port} = :inet.port(socket)
    database_path = WorkPackageFactory.database_path()

    try do
      assert {:ok, opts} = CockpitTask.parse_args_for_test(["--database", database_path, "--port", Integer.to_string(port)])

      assert_raise Mix.Error, ~r/could not bind http:\/\/127\.0\.0\.1:#{port}/, fn ->
        CockpitTask.run_cockpit_for_test(opts, fn -> :ok end)
      end
    after
      :gen_tcp.close(socket)
      File.rm(database_path)
    end
  end

  test "cleans up the owned endpoint so the cockpit can restart in the same runtime" do
    database_path = WorkPackageFactory.database_path()

    try do
      assert {:ok, opts} = CockpitTask.parse_args_for_test(["--database", database_path, "--port", "0"])

      CockpitTask.run_cockpit_for_test(opts, fn ->
        assert is_integer(wait_for_bound_port())
      end)

      CockpitTask.run_cockpit_for_test(opts, fn ->
        assert is_integer(wait_for_bound_port())
      end)
    after
      File.rm(database_path)
    end
  end

  test "starts and stops only its own task supervisor" do
    database_path = WorkPackageFactory.database_path()
    application_supervisor = Process.whereis(SymphonyElixir.TaskSupervisor)

    {child_id, ^application_supervisor, _type, _modules} =
      Enum.find(Supervisor.which_children(SymphonyElixir.Supervisor), fn {_id, pid, _type, _modules} ->
        pid == application_supervisor
      end)

    try do
      assert is_pid(application_supervisor)
      assert {:ok, opts} = CockpitTask.parse_args_for_test(["--database", database_path, "--port", "0"])

      CockpitTask.run_cockpit_for_test(opts, fn ->
        assert Process.whereis(SymphonyElixir.TaskSupervisor) == application_supervisor
      end)

      assert Process.whereis(SymphonyElixir.TaskSupervisor) == application_supervisor
      assert :ok = Supervisor.terminate_child(SymphonyElixir.Supervisor, child_id)
      refute Process.whereis(SymphonyElixir.TaskSupervisor)

      CockpitTask.run_cockpit_for_test(opts, fn ->
        assert is_pid(Process.whereis(SymphonyElixir.TaskSupervisor))
      end)

      refute Process.whereis(SymphonyElixir.TaskSupervisor)
    after
      Supervisor.restart_child(SymphonyElixir.Supervisor, child_id)
      File.rm(database_path)
    end
  end

  defp wait_for_bound_port do
    Enum.reduce_while(1..500, nil, fn _attempt, _port ->
      case SymphonyElixir.HttpServer.bound_port() do
        port when is_integer(port) and port > 0 ->
          {:halt, port}

        _port ->
          Process.sleep(20)
          {:cont, nil}
      end
    end)
  end

  defp operator_config_url(port) do
    "http://127.0.0.1:#{port}/api/v1/sympp/operator/config"
  end

  defp browser_navigation_headers do
    [{"sec-fetch-site", "none"}, {"sec-fetch-mode", "navigate"}]
  end

  defp browser_api_headers(cookie_header \\ nil) do
    [
      {"sec-fetch-site", "same-origin"},
      {"sec-fetch-mode", "cors"},
      {"sec-fetch-dest", "empty"}
    ]
    |> maybe_put_cookie_header(cookie_header)
  end

  defp configured_dashboard_api_headers(cookie_header, origin) do
    [
      {"origin", origin},
      {"sec-fetch-site", "same-site"},
      {"sec-fetch-mode", "cors"},
      {"sec-fetch-dest", "empty"}
    ]
    |> maybe_put_cookie_header(cookie_header)
  end

  defp maybe_put_cookie_header(headers, cookie_header) when is_binary(cookie_header) and cookie_header != "" do
    [{"cookie", cookie_header} | headers]
  end

  defp maybe_put_cookie_header(headers, _cookie_header), do: headers

  defp local_operator_session_cookie(response) do
    response.headers
    |> Map.get("set-cookie", [])
    |> List.wrap()
    |> Enum.map_join("; ", &(&1 |> String.split(";", parts: 2) |> hd()))
  end

  defp ensure_cockpit_dashboard_asset! do
    index_path =
      :symphony_elixir
      |> :code.priv_dir()
      |> Path.join("static/index.html")

    File.mkdir_p!(Path.dirname(index_path))
    File.write!(index_path, "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>")
  end

  defp completed_skipped_request!(completed_at) do
    assert {:ok, request} =
             WorkRequestRepository.create(Repo, %{
               title: "Finished request",
               repo: "symphony-plus-plus",
               base_branch: "main",
               work_type: "feature",
               human_description: "Already done.",
               constraints: %{},
               desired_dispatch_shape: "single_package",
               status: "ready_for_slicing"
             })

    assert {:ok, slice} =
             CanonicalWorkPackageFixtures.add_work_package(Repo, request.id, %{
               title: "Done slice",
               goal: "Finish the request.",
               kind: "mcp",
               base_branch: "main",
               allowed_file_globs: ["elixir/lib/symphony_elixir/symphony_plus_plus/work_requests/**"],
               forbidden_file_globs: [],
               acceptance_criteria: ["Done."],
               validation_steps: ["mix test"],
               review_requirement: %{"type" => "review-suite", "args" => %{"mode" => "normal"}},
               stop_conditions: []
             })

    assert {:ok, _skipped} = WorkRequestRepository.skip_work_package(Repo, request.id, slice.id, "planned")

    assert {:ok, _delivery} =
             WorkRequestRepository.record_work_package_delivery(Repo, request.id, slice.id, %{
               outcome: "abandoned",
               idempotency_key: "cockpit-retention-skipped-delivery",
               recorded_by: "cockpit-test",
               abandoned_rationale: "Skipped retention fixture has a terminal delivery record."
             })

    request
    |> Ecto.Changeset.change(completed_at: utc_usec(completed_at))
    |> Repo.update!()
  end

  defp utc_usec(%DateTime{} = datetime), do: %{datetime | microsecond: {elem(datetime.microsecond, 0), 6}}

  defp restore_env(key, nil), do: Application.delete_env(:symphony_elixir, key)
  defp restore_env(key, value), do: Application.put_env(:symphony_elixir, key, value)
  defp restore_system_env(key, nil), do: System.delete_env(key)
  defp restore_system_env(key, value), do: System.put_env(key, value)

  defp stop_endpoint do
    case Process.whereis(Endpoint) do
      pid when is_pid(pid) -> GenServer.stop(pid)
      nil -> :ok
    end
  catch
    :exit, _reason -> :ok
  end
end
