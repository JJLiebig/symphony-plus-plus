defmodule SymphonyElixir.SymphonyPlusPlus.FactoryService do
  @moduledoc """
  Startup configuration for an always-on factory with an additional private-network listener.
  """

  alias SymphonyElixir.Config
  alias SymphonyElixirWeb.Endpoint

  @spec enabled?() :: boolean()
  def enabled?, do: Application.get_env(:symphony_elixir, :sympp_service, false)

  @spec initialize!() :: :ok
  def initialize! do
    if enabled?() do
      home = System.get_env("SYMPP_HOME") || Path.join(System.user_home!(), ".agents/splusplus")
      token_file = Path.join(home, "remote-token")
      File.mkdir_p!(home)

      case File.open(token_file, [:write, :exclusive]) do
        {:ok, file} ->
          try do
            File.chmod!(token_file, 0o600)
            :ok = IO.binwrite(file, Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false) <> "\n")
          after
            File.close(file)
          end

        {:error, :eexist} ->
          File.chmod!(token_file, 0o600)

        {:error, reason} ->
          raise File.Error, reason: reason, action: "create service token", path: token_file
      end

      token = token_file |> File.read!() |> String.trim()
      if token == "", do: raise("Factory service token file is empty")
      Application.put_env(:symphony_elixir, :sympp_remote_token_hash, :crypto.hash(:sha256, token))
      Application.put_env(:symphony_elixir, :mcp_client_shutdown_on_idle, false)
    end

    :ok
  end

  @spec listener_children() :: [Supervisor.child_spec()]
  def listener_children do
    if enabled?() do
      host = Application.fetch_env!(:symphony_elixir, :sympp_service_host)
      {:ok, ip} = :inet.parse_address(String.to_charlist(host))

      [Supervisor.child_spec({Bandit, plug: Endpoint, ip: ip, port: Config.server_port()}, id: __MODULE__)]
    else
      []
    end
  end
end
