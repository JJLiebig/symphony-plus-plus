root = System.fetch_env!("PERF_SOURCE")
home = System.fetch_env!("SYMPP_HOME")
File.mkdir_p!(home)
{:ok, _} = Application.ensure_all_started(:ecto_sqlite3)
Code.require_file(root <> "/elixir/test/support/canonical_work_package_fixtures.ex")
Code.require_file(root <> "/elixir/test/support/symphony_plus_plus/dashboard_fixture_database_test.exs")
SymphonyElixir.SymphonyPlusPlus.DashboardFixtureDatabase.export!(home <> "/ledger.sqlite3")
Logger.configure(level: :warning)
{:ok, _} = Application.ensure_all_started(:symphony_elixir)

alias SymphonyElixir.SymphonyPlusPlus.Repo

for n <- 1..60 do
  {:ok, _} =
    CanonicalWorkPackageFixtures.add_work_package(Repo, "WR-FIXTURE-FANOUT", %{
      id: "WP-PERF-#{n}",
      title: "Perf #{n}",
      goal: "Scratch dispatch",
      kind: "standard_pr",
      repo: "example/symphony-graph-fixtures",
      base_branch: "main",
      sequence: 100 + n,
      branch_pattern: "feat/perf-#{n}",
      allowed_file_globs: ["fixture/**"],
      forbidden_file_globs: [],
      acceptance_criteria: ["Scratch"],
      validation_steps: ["Scratch"],
      stop_conditions: [],
      status: "planned"
    })
end

:telemetry.attach(
  "perf-query",
  [:symphony_elixir, :symphony_plus_plus, :repo, :query],
  fn _, _, _, _ ->
    if Process.get(:perf_active), do: Process.put(:perf_queries, Process.get(:perf_queries, 0) + 1)
  end,
  nil
)

defmodule FactoryPerfPlug do
  def init(opts), do: opts

  def call(conn, _) do
    Process.put(:perf_active, true)
    Process.put(:perf_queries, 0)

    conn =
      Plug.Conn.register_before_send(conn, fn conn ->
        Plug.Conn.put_resp_header(conn, "x-perf-queries", Integer.to_string(Process.get(:perf_queries, 0)))
      end)

    SymphonyElixirWeb.Endpoint.call(conn, SymphonyElixirWeb.Endpoint.init([]))
  end
end

{:ok, _} = Bandit.start_link(plug: FactoryPerfPlug, ip: {127, 0, 0, 1}, port: String.to_integer(System.fetch_env!("PERF_PORT")))
IO.puts("PERF_READY")
Process.sleep(:infinity)
