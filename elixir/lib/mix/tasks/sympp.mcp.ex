defmodule Mix.Tasks.Sympp.Mcp do
  @moduledoc false

  use Mix.Task

  alias Ecto.Adapters.SQL
  alias SymphonyElixir.SymphonyPlusPlus.MCP.{Config, Repository, Stdio}
  alias SymphonyElixir.SymphonyPlusPlus.Repo

  @shortdoc "Starts the sympp MCP server"

  @impl Mix.Task
  def run(args) do
    case Config.parse(args) do
      {:ok, %Config{mode: :stdio} = config} ->
        original_repo = Repo.get_dynamic_repo()

        run_stdio(config, original_repo)

      :help ->
        Mix.shell().info(Config.usage())

      {:error, message} ->
        Mix.raise(message)
    end
  end

  defp run_stdio(%Config{} = config, original_repo) do
    Process.delete(:sympp_mcp_repo_ownership)

    try do
      case setup_repo(config) do
        {:ok, _repo_ownership} ->
          case Repository.ensure_migrated(Repo) do
            :ok ->
              Stdio.run(config, [])

            {:error, reason} ->
              Mix.raise("Failed to start sympp MCP server: #{inspect(reason)}")
          end

        {:error, reason} ->
          Mix.raise("Failed to start sympp MCP server: #{inspect(reason)}")
      end
    after
      stop_owned_repo(Process.delete(:sympp_mcp_repo_ownership))
      Repo.put_dynamic_repo(original_repo)
    end
  end

  defp setup_repo(%Config{database: database}) do
    case Application.ensure_all_started(:ecto_sql) do
      {:ok, _started} -> setup_started_repo(database)
      {:error, reason} -> {:error, {:ecto_start_failed, reason}}
    end
  rescue
    error -> {:error, {:repo_setup_failed, error.__struct__}}
  end

  defp setup_started_repo(nil) do
    case Repo.get_dynamic_repo() do
      pid when is_pid(pid) ->
        if Process.alive?(pid), do: {:ok, {:existing, pid}}, else: start_repo(resolved_database(nil), false)

      Repo ->
        case Process.whereis(Repo) do
          pid when is_pid(pid) -> {:ok, {:existing, pid}}
          _not_started -> start_repo(resolved_database(nil), false)
        end

      _repo ->
        start_repo(resolved_database(nil), false)
    end
  end

  defp setup_started_repo(database) when is_binary(database) do
    database = resolved_database(database)
    start_repo(database, true)
  end

  defp start_repo(database, requested_database?) do
    repo_options = Repo.child_options(database: database, name: Repo.process_name(database), log: false)

    case Repo.start_link(repo_options) do
      {:ok, pid} ->
        Repo.put_dynamic_repo(pid)
        Process.put(:sympp_mcp_repo_ownership, {:owned, pid})
        {:ok, {:owned, pid}}

      {:error, {:already_started, pid}} ->
        Repo.put_dynamic_repo(pid)
        Process.put(:sympp_mcp_repo_ownership, {:existing, pid})

        if requested_database? do
          ensure_started_repo_uses_database(database, pid)
        else
          {:ok, {:existing, pid}}
        end

      {:error, reason} ->
        {:error, {:repo_start_failed, reason}}
    end
  end

  defp ensure_started_repo_uses_database(database, pid) do
    case SQL.query(pid, "PRAGMA database_list", [], log: false) do
      {:ok, %{rows: rows}} ->
        if Enum.any?(rows, &main_database_row_matches?(&1, database)) do
          {:ok, {:existing, pid}}
        else
          {:error, {:repo_already_started_with_different_database, database}}
        end

      {:error, reason} ->
        {:error, {:repo_database_check_failed, reason}}
    end
  rescue
    error -> {:error, {:repo_database_check_failed, error.__struct__}}
  end

  defp main_database_row_matches?([_seq, "main", path], database) when is_binary(path) and is_binary(database) do
    cond do
      # Reaching this branch means Repo.start_link/1 collided on Repo.process_name(database),
      # whose key includes the full SQLite URI and sorted query params.
      sqlite_file_uri?(database) -> true
      Repo.memory_database?(database) -> path == ""
      Repo.filesystem_database_path?(database) -> Repo.same_database_path?(path, database)
      true -> path == database
    end
  end

  defp main_database_row_matches?(_row, _database), do: false

  defp stop_owned_repo({:owned, pid}) when is_pid(pid) do
    if Process.alive?(pid) do
      GenServer.stop(pid)
    else
      :ok
    end
  catch
    :exit, _reason -> :ok
  end

  defp stop_owned_repo(_repo_ownership), do: :ok

  defp resolved_database(nil), do: Repo.database_path()

  defp resolved_database(database) when is_binary(database) do
    cond do
      Repo.filesystem_database_path?(database) ->
        database = Path.expand(database)
        File.mkdir_p!(Path.dirname(database))
        database

      sqlite_file_uri?(database) and not Repo.memory_database?(database) ->
        prepare_sqlite_file_uri(database)
        database

      true ->
        database
    end
  end

  defp sqlite_file_uri?("file:" <> _uri), do: true
  defp sqlite_file_uri?(_database), do: false

  defp prepare_sqlite_file_uri(database) do
    case Repo.sqlite_file_uri_path(database) do
      uri_path when is_binary(uri_path) and uri_path != "" ->
        uri_path
        |> Path.expand()
        |> Path.dirname()
        |> File.mkdir_p!()

      _path ->
        :ok
    end
  end
end
