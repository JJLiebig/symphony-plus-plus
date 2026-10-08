defmodule SymphonyElixir.SymphonyPlusPlus.MCPClientLeasesTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.SymphonyPlusPlus.MCP.ClientLeases
  alias SymphonyElixir.SymphonyPlusPlus.OperatorDashboardOpener

  test "tracks clients by lease id" do
    server = start_supervised!({ClientLeases, name: :"#{__MODULE__}.tracks"})

    assert {:ok, %{active_client_count: 1}} = ClientLeases.attach("client-a", server)
    assert {:ok, %{active_client_count: 1}} = ClientLeases.heartbeat("client-a", server)
    assert {:ok, %{active_client_count: 2}} = ClientLeases.attach("client-b", server)
    assert {:ok, %{active_client_count: 1}} = ClientLeases.detach("client-a", server)
    assert ClientLeases.active_count(server) == 1
  end

  test "opens the dashboard once when the first client attaches after idle" do
    parent = self()

    opener = start_opener("once", parent)

    server =
      start_lease_server("dashboard-once",
        dashboard_opener: opener,
        ttl_ms: 1_000
      )

    assert {:ok, %{active_client_count: 1}} = ClientLeases.attach("client-a", server)
    assert_receive :dashboard_opened, 100

    assert {:ok, %{active_client_count: 2}} = ClientLeases.attach("client-b", server)
    refute_receive :dashboard_opened, 20

    assert {:ok, %{active_client_count: 1}} = ClientLeases.detach("client-a", server)
    assert {:ok, %{active_client_count: 0}} = ClientLeases.detach("client-b", server)
    assert {:ok, %{active_client_count: 1}} = ClientLeases.attach("client-c", server)
    assert_receive :dashboard_opened, 100
  end

  test "does not open when a dashboard event stream is already connected" do
    parent = self()

    opener = start_opener("connected", parent)

    server =
      start_lease_server("dashboard-connected",
        dashboard_opener: opener,
        ttl_ms: 1_000
      )

    OperatorDashboardOpener.dashboard_connected(self(), opener)
    :sys.get_state(opener)

    assert {:ok, %{active_client_count: 1}} = ClientLeases.attach("client-a", server)
    refute_receive :dashboard_opened, 20
  end

  test "stale leases are pruned without runtime shutdown authority" do
    server = start_lease_server("stale-prune")

    assert {:ok, %{active_client_count: 1}} = ClientLeases.attach("client-a", server)
    Process.sleep(10)
    send(server, :sweep)

    assert ClientLeases.active_count(server) == 0
  end

  test "stale leases stop runtime when shutdown-on-idle is enabled" do
    parent = self()

    server =
      start_lease_server("shutdown",
        shutdown_fun: fn -> send(parent, :shutdown_requested) end,
        shutdown_delay_ms: 1,
        shutdown_on_idle: true
      )

    assert {:ok, %{active_client_count: 1}} = ClientLeases.attach("client-a", server)
    Process.sleep(10)
    send(server, :sweep)

    assert_receive :shutdown_requested, 100
  end

  test "shutdown-on-idle waits for the first lease before stopping runtime" do
    parent = self()

    server =
      start_lease_server("no-lease-yet",
        shutdown_fun: fn -> send(parent, :shutdown_requested) end,
        shutdown_delay_ms: 1,
        shutdown_on_idle: true
      )

    send(server, :sweep)
    refute_receive :shutdown_requested, 30

    assert {:ok, %{active_client_count: 1}} = ClientLeases.attach("client-a", server)
    assert {:ok, %{active_client_count: 0}} = ClientLeases.detach("client-a", server)
    assert_receive :shutdown_requested, 100
  end

  test "shutdown-on-idle remains telemetry without runtime policy" do
    parent = self()

    server =
      start_lease_server("client-requested-shutdown",
        shutdown_fun: fn -> send(parent, :shutdown_requested) end,
        shutdown_delay_ms: 1
      )

    assert {:ok, %{active_client_count: 1}} = ClientLeases.attach("client-a", server)
    Process.sleep(10)
    send(server, :sweep)

    refute_receive :shutdown_requested, 30
    assert ClientLeases.active_count(server) == 0
  end

  test "new client cancels pending idle shutdown" do
    parent = self()

    server =
      start_lease_server("cancel-shutdown",
        shutdown_fun: fn -> send(parent, :shutdown_requested) end,
        shutdown_delay_ms: 30,
        shutdown_on_idle: true
      )

    assert {:ok, %{active_client_count: 1}} = ClientLeases.attach("client-a", server)
    assert {:ok, %{active_client_count: 0}} = ClientLeases.detach("client-a", server)
    assert {:ok, %{active_client_count: 1}} = ClientLeases.attach("client-b", server)

    refute_receive :shutdown_requested, 50

    assert {:ok, %{active_client_count: 0}} = ClientLeases.detach("client-b", server)
    assert_receive :shutdown_requested, 100
  end

  test "stale idle shutdown messages do not bypass the current grace period" do
    parent = self()

    server =
      start_lease_server("stale-shutdown-message",
        shutdown_fun: fn -> send(parent, :shutdown_requested) end,
        shutdown_delay_ms: 40,
        shutdown_on_idle: true
      )

    assert {:ok, %{active_client_count: 1}} = ClientLeases.attach("client-a", server)
    assert {:ok, %{active_client_count: 0}} = ClientLeases.detach("client-a", server)

    send(server, {:shutdown_on_idle, make_ref()})
    refute_receive :shutdown_requested, 30
    assert_receive :shutdown_requested, 100
  end

  test "heartbeats without shutdown authority remain telemetry only" do
    server = start_lease_server("telemetry")

    assert {:ok, %{active_client_count: 1}} = ClientLeases.attach("client-a", server)
    Process.sleep(10)
    send(server, :sweep)

    assert {:ok, %{active_client_count: 1}} = ClientLeases.attach("client-a", server)
    Process.sleep(10)
    send(server, :sweep)

    Process.sleep(10)
    send(server, :sweep)
    assert ClientLeases.active_count(server) == 0
  end

  @tag skip: match?({:unix, _}, :os.type())
  test "sweep removes dead local instances while preserving live, direct and unknown clients" do
    directory = bridge_directory()
    dead = start_bridge(directory, "dead")
    live = start_bridge(directory, "live")
    start_bridge(directory, "mismatch", "mismatch")
    start_bridge(directory, "reused-pid", "reused-pid")
    unknown = start_bridge(directory, "unknown", "unknown")
    parent = self()

    server =
      start_lease_server("local-bridges",
        bridge_lease_dir: Path.join(directory, "codex-plugin-leases"),
        ttl_ms: 600_000,
        shutdown_on_idle: true,
        shutdown_delay_ms: 1,
        shutdown_fun: fn -> send(parent, :shutdown_requested) end
      )

    for id <- ["dead", "live", "mismatch", "reused-pid", "unknown", "direct"] do
      assert {:ok, _} = ClientLeases.attach(id, server)
    end

    stop_bridge(dead)
    stop_bridge(unknown)
    # Other launcher cleanup can remove a dead file before the backend sweep.
    lease_directory = Path.join(directory, "codex-plugin-leases")

    lease_directory
    |> File.ls!()
    |> Enum.map(&Path.join(lease_directory, &1))
    |> Enum.filter(&(Jason.decode!(File.read!(&1))["client_id"] == "dead"))
    |> Enum.each(&File.rm!/1)

    send(server, :sweep)
    assert ClientLeases.active_count(server) == 3
    assert Map.keys(:sys.get_state(server).leases) |> Enum.sort() == ["direct", "live", "unknown"]
    refute_receive :shutdown_requested, 20

    ClientLeases.detach("direct", server)
    ClientLeases.detach("unknown", server)
    stop_bridge(live)
    send(server, :sweep)
    assert_receive :shutdown_requested, 1_500
    assert ClientLeases.active_count(server) == 0
  end

  @tag skip: match?({:unix, _}, :os.type())
  test "missing probe preserves a correlated client until its ordinary TTL" do
    directory = bridge_directory()
    owner = start_bridge(directory, "unprobed")

    server =
      start_lease_server("missing-probe",
        bridge_lease_dir: Path.join(directory, "codex-plugin-leases"),
        bridge_probe: Path.join(directory, "missing.js"),
        ttl_ms: 600_000
      )

    assert {:ok, _} = ClientLeases.attach("unprobed", server)
    stop_bridge(owner)
    send(server, :sweep)
    assert ClientLeases.active_count(server) == 1
  end

  @tag skip: match?({:unix, _}, :os.type())
  test "stalled pipe preserves its lease and the store stays responsive after the probe timeout" do
    directory = bridge_directory()
    owner = start_bridge(directory, "stalled", "stalled")

    server =
      start_lease_server("stalled-bridge",
        bridge_lease_dir: Path.join(directory, "codex-plugin-leases"),
        ttl_ms: 600_000
      )

    assert {:ok, _} = ClientLeases.attach("stalled", server)
    send(server, :sweep)
    assert {:ok, %{active_client_count: 2}} = GenServer.call(server, {:attach, "direct"}, 2_500)
    assert {:ok, %{active_client_count: 2}} = ClientLeases.heartbeat("stalled", server)
    stop_bridge(owner)
    send(server, :sweep)
    assert ClientLeases.active_count(server) == 1
  end

  defp bridge_directory do
    directory = Path.join(System.tmp_dir!(), "sympp-client-leases-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf!(directory) end)
    directory
  end

  defp start_bridge(directory, client_id, mode \\ "live") do
    fixture = Path.expand("../../../../plugins/symphony-plus-plus-mcp/tests/launcher/client-lease-owner.js", __DIR__)
    node = System.find_executable("node") || flunk("Node is required for Windows bridge lease checks")
    port = Port.open({:spawn_executable, node}, [:binary, :exit_status, :hide, args: [fixture, directory, client_id, mode]])
    on_exit(fn -> if Port.info(port), do: Port.close(port) end)
    assert_receive {^port, {:data, "ready\n"}}, 5_000
    port
  end

  defp stop_bridge(port) do
    Port.command(port, "kill\n")
    assert_receive {^port, {:exit_status, _}}, 5_000
  end

  defp start_lease_server(name, extra_opts \\ []) do
    opts =
      [
        name: :"#{__MODULE__}.#{name}",
        bridge_probe: Path.expand("../../../../plugins/symphony-plus-plus-mcp/scripts/start-sympp-mcp-bridge.js", __DIR__),
        ttl_ms: 5,
        sweep_ms: 60_000
      ]
      |> Keyword.merge(extra_opts)

    start_supervised!({ClientLeases, opts})
  end

  defp start_opener(name, parent) do
    opts = [
      name: :"#{__MODULE__}.opener.#{name}",
      open_delay_ms: 1,
      open_fun: fn -> send(parent, :dashboard_opened) end
    ]

    start_supervised!({OperatorDashboardOpener, opts})
  end
end
