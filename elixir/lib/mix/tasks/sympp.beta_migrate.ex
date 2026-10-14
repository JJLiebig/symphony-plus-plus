defmodule Mix.Tasks.Sympp.BetaMigrate do
  @moduledoc false

  use Mix.Task

  alias SymphonyElixir.SymphonyPlusPlus.OfflineSandbox
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository

  @shortdoc "Migrates a staged offline beta snapshot without starting the application"

  @impl Mix.Task
  def run(["--database", database]) do
    Mix.Task.run("app.config")
    :ok = OfflineSandbox.verify!(database)

    unless OfflineSandbox.enabled?(), do: Mix.raise("Offline snapshot migration requires SYMPP_OFFLINE_SANDBOX=1.")

    {:ok, _started} = Application.ensure_all_started(:ecto_sql)
    {:ok, repo} = Repo.start_link(Repo.child_options(database: database))

    try do
      case Repository.migrate(Repo) do
        :ok -> :ok
        {:error, reason} -> Mix.raise("Beta snapshot migration failed: #{inspect(reason)}")
      end
    after
      GenServer.stop(repo)
    end
  end

  def run(_args), do: Mix.raise("Usage: mix sympp.beta_migrate --database <staged-snapshot>")
end
