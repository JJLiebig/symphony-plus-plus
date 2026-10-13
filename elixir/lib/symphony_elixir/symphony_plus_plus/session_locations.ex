defmodule SymphonyElixir.SymphonyPlusPlus.SessionLocations do
  @moduledoc false

  import Ecto.Query, only: [from: 2]

  alias SymphonyElixir.SymphonyPlusPlus.Dashboard.Sanitizer
  alias SymphonyElixir.SymphonyPlusPlus.DashboardPubSub
  alias SymphonyElixir.SymphonyPlusPlus.MCP.{HerdrBinding, Server}
  alias SymphonyElixir.SymphonyPlusPlus.OperatorConfig
  alias SymphonyElixir.SymphonyPlusPlus.SessionLocations.Location

  @herdr_fields ~w(workspace_id workspace_label tab_id tab_label pane_id session socket_path native_session_id native_session_agent)
  @public_herdr_fields ~w(workspace_id workspace_label tab_id tab_label pane_id)

  @spec observe(term(), term(), Server.t()) :: Server.t()
  def observe(%{"method" => "initialize", "params" => params}, %{"result" => _result}, server) when is_map(params) do
    %{server | client_location: metadata(params, server)}
  end

  def observe(%{"method" => "tools/call", "params" => params} = payload, %{"result" => result} = response, server)
      when is_map(params) and is_map(result) do
    if result["isError"] != true do
      case metadata(params, server) do
        metadata when is_map(metadata) ->
          observe_location(payload, response, server, metadata)
          %{server | client_location: metadata}

        _missing -> server
      end
    else
      server
    end
  end

  def observe(_payload, _response, server), do: server

  defp observe_location(payload, response, server, metadata) do
    with client_id when is_binary(client_id) <- text(metadata["client_id"]),
         binding when is_map(binding) <- HerdrBinding.response_binding(payload, response, server),
         {target_kind, target_id, role} <- target(binding, payload, server.config.repo, client_id) do
      repo = server.config.repo
      existing = repo.get_by(Location, target_kind: target_kind, target_id: target_id, role: role)
      description = description(payload, existing, client_id)
      herdr = herdr_location(metadata["herdr"])

      location = %Location{
        id: Ecto.UUID.generate(),
        target_kind: target_kind,
        target_id: target_id,
        role: role,
        client_id: client_id,
        machine_id: text(metadata["machine_id"]),
        machine_label: text(metadata["machine_label"]),
        source: source(herdr, description),
        description: description,
        herdr: herdr,
        last_seen_at: DateTime.utc_now(:microsecond)
      }

      case repo.insert(location,
             conflict_target: [:target_kind, :target_id, :role],
             on_conflict: {:replace_all_except, [:id]}
           ) do
        {:ok, _location} -> DashboardPubSub.broadcast_changed()
        {:error, _changeset} -> :ok
      end
    else
      _unlocated -> :ok
    end
  end

  defp target(%{"role" => "worker", "work_package_id" => id}, _payload, _repo, _client_id) when is_binary(id),
    do: {"work_package", id, "worker"}

  defp target(%{"role" => "architect", "work_request_id" => id}, _payload, _repo, _client_id) when is_binary(id),
    do: {"work_request", id, "architect"}

  defp target(%{"role" => "coordinator", "work_request_id" => id}, %{"params" => %{"name" => "create_work_request"}}, _repo, _client_id)
       when is_binary(id),
       do: {"work_request", id, "coordinator"}

  defp target(%{"role" => "coordinator", "work_request_id" => id}, _payload, repo, client_id) when is_binary(id) do
    if repo.get_by(Location, target_kind: "work_request", target_id: id, role: "coordinator", client_id: client_id),
      do: {"work_request", id, "coordinator"}
  end

  defp target(_binding, _payload, _repo, _client_id), do: nil

  defp metadata(params, server) do
    case params["_meta"] do
      %{"sympp_session_location" => metadata} when is_map(metadata) -> metadata
      _missing -> server.client_location || described_metadata(params, server)
    end
  end

  defp described_metadata(params, server) do
    if text(get_in(params, ["arguments", "session_description"])) do
      client_id = :crypto.hash(:sha256, :erlang.term_to_binary(server.state_key)) |> Base.encode16(case: :lower)
      %{"client_id" => client_id}
    end
  end

  defp description(payload, existing, client_id) do
    text(get_in(payload, ["params", "arguments", "session_description"])) ||
      if(existing && existing.client_id == client_id, do: existing.description)
  end

  defp herdr_location(metadata) when is_map(metadata) do
    metadata
    |> Map.take(@herdr_fields)
    |> Map.new(fn {key, value} -> {key, text(value)} end)
    |> Map.reject(fn {_key, value} -> is_nil(value) end)
  end

  defp herdr_location(_metadata), do: %{}

  defp source(%{"pane_id" => _pane_id}, _description), do: "herdr"
  defp source(_herdr, description) when is_binary(description), do: "agent"
  defp source(_herdr, _description), do: "machine"

  @spec get(module(), String.t(), String.t()) :: Location.t() | nil
  def get(repo, target_kind, target_id) do
    repo.all(from(location in Location, where: location.target_kind == ^target_kind and location.target_id == ^target_id))
    |> preferred()
  end

  @spec for_targets(module(), String.t(), [String.t()]) :: map()
  def for_targets(repo, target_kind, target_ids) do
    repo.all(from(location in Location, where: location.target_kind == ^target_kind and location.target_id in ^target_ids))
    |> Enum.group_by(& &1.target_id)
    |> Map.new(fn {id, locations} -> {id, preferred(locations)} end)
  end

  defp preferred(locations) do
    Enum.find(locations, &(&1.role == "architect")) || List.first(locations)
  end

  @spec public(Location.t() | nil, map()) :: map() | nil
  def public(nil, _config), do: nil

  def public(%Location{} = location, config) do
    machine = OperatorConfig.machine(config, location.machine_id, location.machine_label)

    Map.merge(machine, %{
      machine_id: location.machine_id,
      role: location.role,
      source: location.source,
      description: location.description,
      last_seen_at: DateTime.to_iso8601(location.last_seen_at),
      herdr: Map.take(location.herdr, @public_herdr_fields)
    })
    |> Sanitizer.redacted_json()
  end

  defp text(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      value -> Sanitizer.redacted_text(value)
    end
  end

  defp text(_value), do: nil
end
