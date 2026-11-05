defmodule SymphonyElixir.SymphonyPlusPlus.FactoryServiceTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.SymphonyPlusPlus.FactoryService
  alias SymphonyElixir.SymphonyPlusPlus.MCP.ClientLeases

  test "service creates a private persistent token and cannot inherit idle shutdown" do
    home = Path.join(System.tmp_dir!(), "sympp-service-#{System.unique_integer([:positive])}")
    old_home = System.get_env("SYMPP_HOME")
    old_idle = System.get_env("SYMPP_MCP_SHUTDOWN_ON_IDLE")
    keys = [:sympp_service, :sympp_remote_token_hash, :mcp_client_shutdown_on_idle]
    previous = Map.new(keys, &{&1, Application.get_env(:symphony_elixir, &1)})

    on_exit(fn ->
      if old_home, do: System.put_env("SYMPP_HOME", old_home), else: System.delete_env("SYMPP_HOME")

      if old_idle do
        System.put_env("SYMPP_MCP_SHUTDOWN_ON_IDLE", old_idle)
      else
        System.delete_env("SYMPP_MCP_SHUTDOWN_ON_IDLE")
      end

      for {key, value} <- previous do
        if is_nil(value) do
          Application.delete_env(:symphony_elixir, key)
        else
          Application.put_env(:symphony_elixir, key, value)
        end
      end

      File.rm_rf!(home)
    end)

    System.put_env("SYMPP_HOME", home)
    System.put_env("SYMPP_MCP_SHUTDOWN_ON_IDLE", "1")
    Application.put_env(:symphony_elixir, :sympp_service, true)
    results = Task.async_stream(1..12, fn _ -> FactoryService.initialize!() end, max_concurrency: 12)
    assert Enum.all?(results, &(&1 == {:ok, :ok}))
    file = Path.join(home, "remote-token")
    token = File.read!(file)
    assert byte_size(String.trim(token)) == 43
    if match?({:unix, _}, :os.type()), do: assert(Bitwise.band(File.stat!(file).mode, 0o777) == 0o600)
    assert :ok = FactoryService.initialize!()
    assert File.read!(file) == token

    caller = self()
    name = __MODULE__.Leases
    start_supervised!({ClientLeases, name: name, shutdown_delay_ms: 1, shutdown_fun: fn -> send(caller, :shutdown) end})
    assert {:ok, _} = ClientLeases.attach("service-test", name)
    assert {:ok, _} = ClientLeases.detach("service-test", name)
    refute_receive :shutdown, 50
  end
end
