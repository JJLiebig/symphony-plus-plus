defmodule SymphonyElixir.SymphonyPlusPlus.OperatorSettingsMigrationTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.SymphonyPlusPlus.OperatorSettings.Repository
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.Repo.Migrations

  @previous_version 20_261_005_040_000
  @migration_version 20_261_013_120_000

  for {stored_days, expected_days} <- [{14, 1}, {7, 7}, {1, 1}] do
    test "archive window upgrade handles stored #{stored_days} days without resetting other settings" do
      database_path = Path.join(System.tmp_dir!(), "sympp-archive-upgrade-#{System.unique_integer([:positive])}.sqlite3")
      {:ok, pid} = Repo.start_link(database: database_path, name: nil, pool_size: 1, log: false)
      original_repo = Repo.put_dynamic_repo(pid)

      try do
        Ecto.Migrator.run(Repo, Migrations.all(), :up, to: @previous_version, log: false)

        assert {:ok, before} =
                 Repository.update(Repo, %{
                   "work_request_archive_after_days" => unquote(stored_days),
                   "solo_session_delete_after_days" => 45,
                   "open_dashboard_on_boot" => false,
                   "capture_failed_mcp_calls" => true,
                   "hidden_work_package_ids" => ["WP-ARCHIVE-UPGRADE"]
                 })

        assert @migration_version in Ecto.Migrator.run(Repo, Migrations.all(), :up, all: true, log: false)
        assert {:ok, after_upgrade} = Repository.get(Repo)
        assert after_upgrade == %{before | work_request_archive_after_days: unquote(expected_days)}

        assert {:ok, _custom} = Repository.update(Repo, %{"work_request_archive_after_days" => 14})
        assert [] == Ecto.Migrator.run(Repo, Migrations.all(), :up, all: true, log: false)
        assert {:ok, %{work_request_archive_after_days: 14}} = Repository.get(Repo)
      after
        Repo.put_dynamic_repo(original_repo)
        GenServer.stop(pid)
        File.rm(database_path)
      end
    end
  end
end
