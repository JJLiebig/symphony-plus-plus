defmodule SymphonyElixir.SymphonyPlusPlus.Repo.Migrations.ShortenDefaultWorkRequestArchiveWindow do
  use Ecto.Migration

  def up do
    execute("""
    UPDATE sympp_operator_settings
    SET work_request_archive_after_days = 1
    WHERE work_request_archive_after_days = 14
    """)
  end

  def down do
    raise Ecto.MigrationError,
      message: "archive window migration cannot distinguish converted defaults from custom one-day settings"
  end
end
