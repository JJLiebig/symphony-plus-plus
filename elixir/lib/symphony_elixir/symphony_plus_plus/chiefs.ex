defmodule SymphonyElixir.SymphonyPlusPlus.Chiefs do
  @moduledoc false

  import Ecto.Changeset
  import Ecto.Query, only: [from: 2]

  alias SymphonyElixir.SymphonyPlusPlus.Chiefs.Registration
  alias SymphonyElixir.SymphonyPlusPlus.Dashboard.Sanitizer
  alias SymphonyElixir.SymphonyPlusPlus.DashboardPubSub
  alias SymphonyElixir.SymphonyPlusPlus.SessionLocations

  @spec register(module(), term(), map()) :: {:ok, Registration.t()} | {:error, term()}
  def register(repo, state_key, arguments) do
    arguments = Map.put(arguments, "repos", Map.get(arguments, "repos") || [])

    changeset =
      %Registration{id: Ecto.UUID.generate(), session_key: session_key(state_key)}
      |> cast(Map.take(arguments, ["domain", "repos"]), [:domain, :repos])
      |> update_change(:domain, &(String.trim(&1) |> Sanitizer.redacted_text()))
      |> update_change(:repos, &Enum.map(&1, fn value -> Sanitizer.redacted_text(value) end))
      |> validate_required([:domain])

    if changeset.valid? do
      domain_key = changeset |> get_field(:domain) |> String.downcase()
      changeset = put_change(changeset, :domain_key, domain_key)

      repo.transaction(fn -> supersede_and_insert(repo, changeset, domain_key) end, mode: :immediate)
      |> DashboardPubSub.broadcast_changed_on_success()
    else
      {:error, changeset}
    end
  end

  defp supersede_and_insert(repo, changeset, domain_key) do
    now = DateTime.utc_now(:microsecond)
    changeset = put_change(changeset, :registered_at, now)
    current = from(chief in Registration, where: chief.domain_key == ^domain_key and is_nil(chief.superseded_at))
    repo.update_all(current, set: [superseded_at: now])

    case repo.insert(changeset) do
      {:ok, registration} -> registration
      {:error, reason} -> repo.rollback(reason)
    end
  end

  @spec attribution(map() | nil) :: map() | nil
  def attribution(nil), do: nil

  def attribution(%{config: %{repo: repo}, state_key: state_key}) do
    key = session_key(state_key)

    case repo.one(from(chief in Registration, where: chief.session_key == ^key and is_nil(chief.superseded_at), order_by: [desc: chief.registered_at, desc: chief.id], limit: 1)) do
      nil -> nil
      chief -> %{"kind" => "chief", "domain" => chief.domain}
    end
  end

  @spec public_current(module(), map()) :: [map()]
  def public_current(repo, operator_config) do
    chiefs = repo.all(from(chief in Registration, where: is_nil(chief.superseded_at), order_by: [asc: chief.domain_key]))
    locations = SessionLocations.for_targets(repo, "chief", Enum.map(chiefs, & &1.id))

    Enum.map(chiefs, fn chief ->
      %{
        domain: chief.domain,
        repos: chief.repos,
        registered_at: DateTime.to_iso8601(chief.registered_at),
        session_location: SessionLocations.public(locations[chief.id], operator_config)
      }
    end)
  end

  @spec put_attribution(map(), atom() | String.t(), map() | nil) :: map()
  def put_attribution(payload, _key, nil), do: payload
  def put_attribution(payload, key, attribution), do: Map.put(payload, key, Sanitizer.redacted_json(attribution))

  defp session_key(state_key), do: :crypto.hash(:sha256, :erlang.term_to_binary(state_key)) |> Base.encode16(case: :lower)
end
