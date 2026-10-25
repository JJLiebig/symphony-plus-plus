defmodule SymphonyElixir.SymphonyPlusPlus.Chiefs.Registration do
  @moduledoc false
  use Ecto.Schema

  @primary_key {:id, :string, autogenerate: false}
  @type t :: %__MODULE__{}
  schema "sympp_chief_registrations" do
    field(:domain, :string)
    field(:domain_key, :string)
    field(:session_key, :string)
    field(:repos, SymphonyElixir.SymphonyPlusPlus.WorkPackages.StringList, default: [])
    field(:registered_at, :utc_datetime_usec)
    field(:superseded_at, :utc_datetime_usec)
  end
end
