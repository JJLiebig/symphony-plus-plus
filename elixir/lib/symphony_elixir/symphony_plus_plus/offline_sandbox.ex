defmodule SymphonyElixir.SymphonyPlusPlus.OfflineSandbox do
  @moduledoc false

  alias Exqlite.Sqlite3
  alias SymphonyElixir.SymphonyPlusPlus.Repo

  @spec enabled?() :: boolean()
  def enabled?, do: System.get_env("SYMPP_OFFLINE_SANDBOX") == "1"

  @spec require_online() :: :ok | {:error, :offline_sandbox}
  def require_online, do: if(enabled?(), do: {:error, :offline_sandbox}, else: :ok)

  @spec verify!(String.t() | nil) :: :ok
  def verify!(database) do
    marked? = marked?(database)

    cond do
      marked? and not enabled?() ->
        raise "This ledger is an offline beta snapshot. Start it with scripts/sympp-beta.ps1 -Action Start."

      enabled?() and not marked? ->
        raise "Offline beta requires a marked snapshot. Run scripts/sympp-beta.ps1 -Action Snapshot first."

      true ->
        :ok
    end
  end

  defp marked?(nil), do: false

  defp marked?(database) do
    path = Repo.sqlite_file_uri_path(database) || database

    if Repo.memory_database?(database) or not File.regular?(path) do
      false
    else
      {:ok, connection} = Sqlite3.open(path, mode: :readonly)

      try do
        {:ok, statement} =
          Sqlite3.prepare(connection, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sympp_offline_sandbox'")

        try do
          case Sqlite3.step(connection, statement) do
            {:row, [1]} -> true
            :done -> false
            {:error, reason} -> raise "Cannot verify offline snapshot protection: #{inspect(reason)}"
          end
        after
          Sqlite3.release(connection, statement)
        end
      after
        Sqlite3.close(connection)
      end
    end
  end
end
