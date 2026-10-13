defmodule SymphonyElixir.SymphonyPlusPlus.Repo.Migrations.AddNeverStartedWorkRequestRetention do
  use Ecto.Migration

  def change do
    alter table(:sympp_operator_settings) do
      add(:work_request_never_started_archive_after_days, :integer, null: false, default: 30)
    end

    alter table(:sympp_work_requests) do
      add(:never_started_restored_at, :utc_datetime_usec)
    end
  end
end
