Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.ConnectionBootstrap02Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  alias SymphonyElixir.SymphonyPlusPlus.MCP.ToolCatalog

  @repo_root Path.expand("../../../../../", __DIR__)
  @contract_path Path.join(@repo_root, "elixir/priv/symphony_plus_plus/mcp_contract.json")

  test "published MCP contract identity matches the runtime" do
    contract = @contract_path |> File.read!() |> Jason.decode!()
    tool_sets = Map.fetch!(contract, "tool_sets")

    assert Map.keys(contract) |> Enum.sort() == ["mcp_contract_fingerprint", "tool_sets", "version"]
    assert Map.fetch!(contract, "version") == 7
    assert Map.fetch!(contract, "mcp_contract_fingerprint") == Server.mcp_contract_identity()["fingerprint"]
    assert Map.fetch!(tool_sets, "unbound_tools") == ToolCatalog.contract_unbound_tools()
    assert Map.fetch!(tool_sets, "trusted_local_http_extra_tools") == ToolCatalog.contract_trusted_local_http_extra_tools()
    assert Map.fetch!(tool_sets, "worker_tools") == ToolCatalog.worker_tools()
    assert Map.fetch!(tool_sets, "architect_tools") == ToolCatalog.architect_tools()
    assert Map.fetch!(tool_sets, "shared_worker_architect_tools") == ToolCatalog.shared_worker_architect_tools()
  end

  test "mix task reuses an already-started repo for the exact SQLite URI" do
    database = "file:sympp_mcp_#{System.unique_integer([:positive])}?mode=memory&cache=shared"
    original_repo = Repo.get_dynamic_repo()
    original_logger_config = Application.fetch_env(:logger, :console)
    {:ok, pid} = Repo.start_link(database: database, name: Repo.process_name(database), pool_size: 1, log: false)

    input =
      [
        Jason.encode!(%{"jsonrpc" => "2.0", "id" => "init", "method" => "initialize", "params" => initialize_params()}),
        Jason.encode!(%{
          "jsonrpc" => "2.0",
          "id" => 1,
          "method" => "tools/call",
          "params" => %{"name" => "sympp.health", "arguments" => %{}}
        })
      ]
      |> Enum.join("\n")
      |> Kernel.<>("\n")

    try do
      output =
        capture_io(input, fn ->
          McpTask.run(["--database", database])
        end)

      responses = decode_json_lines(output)

      assert Enum.any?(responses, fn response ->
               get_in(response, ["result", "structuredContent", "ledger", "reachable"]) == true
             end)

      assert Process.alive?(pid)
      assert Repo.get_dynamic_repo() == original_repo
      assert Application.fetch_env(:logger, :console) == original_logger_config
    after
      GenServer.stop(pid)
    end
  end

  test "harness config override does not require a repo option" do
    config = Config.default(repo: Repo, version: "test-version")

    response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => 1, "method" => "resources/read", "params" => %{"uri" => "sympp://health/version"}},
        config: config
      )

    text = get_in(response, ["result", "contents", Access.at(0), "text"])
    assert Jason.decode!(text)["version"] == "test-version"
  end

  test "tools list returns Codex-compatible top-level input schemas for every surface", %{repo: repo} do
    assert {:ok, worker_package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-CODEX-SCHEMA-WORKER", kind: "mcp"))
    assert {:ok, worker_minted} = AccessGrantService.mint_worker_grant(repo, worker_package.id)
    assert {:ok, worker_assignment} = AccessGrantService.claim(repo, worker_minted.work_key.secret, claimed_by: "worker-1")
    worker_session = MCPHarness.session(worker_assignment, proof_hash: worker_minted.grant.secret_hash)

    {_anchor, architect_session, _grant} = create_phase_architect_session(repo, "SYMPP-CODEX-SCHEMA-ARCHITECT", ["read:phase"])

    surfaces = [
      {"unbound", Server.new(Config.default(repo: repo), initialized: true)},
      {"worker", Server.new(Config.default(repo: repo), initialized: true, session: worker_session)},
      {"architect", Server.new(test_mcp_config(repo), initialized: true, session: architect_session)}
    ]

    for {surface, server} <- surfaces,
        tool <- tools_for_server(server) do
      schema = Map.fetch!(tool, "inputSchema")

      assert schema["type"] == "object", "#{surface} #{tool["name"]} inputSchema must be a top-level object"

      forbidden = Map.take(schema, @codex_forbidden_top_level_schema_keys)
      assert forbidden == %{}, "#{surface} #{tool["name"]} has Codex-rejected top-level schema keys: #{inspect(Map.keys(forbidden))}"
    end
  end
end
