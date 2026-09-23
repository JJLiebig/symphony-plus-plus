[database] = System.argv()

{:ok, _} = Application.ensure_all_started(:ecto_sqlite3)

Code.require_file(Path.expand("../../../elixir/test/support/canonical_work_package_fixtures.ex", __DIR__))

Code.require_file(Path.expand("../../../elixir/test/support/symphony_plus_plus/dashboard_fixture_database_test.exs", __DIR__))

SymphonyElixir.SymphonyPlusPlus.DashboardFixtureDatabase.export!(database)
