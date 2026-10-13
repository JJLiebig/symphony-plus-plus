defmodule SymphonyElixir.SymphonyPlusPlus.SessionLocations.Location do
  @moduledoc false
  use Ecto.Schema

  @primary_key {:id, :string, autogenerate: false}
  schema "sympp_session_locations" do
    field :target_kind, :string
    field :target_id, :string
    field :role, :string
    field :client_id, :string
    field :machine_id, :string
    field :machine_label, :string
    field :source, :string
    field :description, :string
    field :herdr, :map, default: %{}
    field :last_seen_at, :utc_datetime_usec
  end

  @type t :: %__MODULE__{}
end
