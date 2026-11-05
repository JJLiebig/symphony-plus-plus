defmodule SymphonyElixir.SymphonyPlusPlus.Repo.Migrations.AddSymppChiefs do
  use Ecto.Migration

  def change do
    create table(:sympp_chief_registrations, primary_key: false) do
      add(:id, :string, primary_key: true)
      add(:domain, :string, null: false)
      add(:domain_key, :string, null: false)
      add(:session_key, :string, null: false)
      add(:repos, :text, null: false, default: "[]")
      add(:registered_at, :utc_datetime_usec, null: false)
      add(:superseded_at, :utc_datetime_usec)
    end

    create(unique_index(:sympp_chief_registrations, [:domain_key], where: "superseded_at IS NULL"))
    create(index(:sympp_chief_registrations, [:session_key]))

    alter table(:sympp_work_requests) do
      add(:dispatched_by, :map)
    end

    alter table(:sympp_work_packages) do
      add(:dispatched_by, :map)
    end
  end
end
