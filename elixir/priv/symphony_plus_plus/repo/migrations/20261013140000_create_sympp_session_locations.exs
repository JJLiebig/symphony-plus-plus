defmodule SymphonyElixir.SymphonyPlusPlus.Repo.Migrations.CreateSymppSessionLocations do
  use Ecto.Migration

  def change do
    create table(:sympp_session_locations, primary_key: false) do
      add :id, :string, primary_key: true
      add :target_kind, :string, null: false
      add :target_id, :string, null: false
      add :role, :string, null: false
      add :client_id, :string, null: false
      add :machine_id, :string
      add :machine_label, :string
      add :source, :string, null: false
      add :description, :text
      add :herdr, :map, null: false, default: %{}
      add :last_seen_at, :utc_datetime_usec, null: false
    end

    create unique_index(:sympp_session_locations, [:target_kind, :target_id, :role])
    create index(:sympp_session_locations, [:client_id])
  end
end
