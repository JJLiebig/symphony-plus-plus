defmodule SymphonyElixir.SymphonyPlusPlus.SessionFocus do
  @moduledoc false

  alias SymphonyElixir.SymphonyPlusPlus.SessionLocations
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest

  @spec focus(module(), String.t(), String.t()) :: map()
  def focus(repo, target_kind, target_id) do
    schema = if target_kind == "work_package", do: WorkPackage, else: WorkRequest
    location = if repo.get(schema, target_id), do: SessionLocations.get(repo, target_kind, target_id)
    focus_location(location, [])
  end

  @doc false
  @spec focus_location(map() | nil, keyword()) :: map()
  def focus_location(nil, _opts), do: result(:session_gone)

  def focus_location(location, opts) do
    cond do
      location.source != "herdr" -> result(:not_in_herdr)
      location.machine_id != Keyword.get(opts, :machine_id, machine_id()) -> result(:other_machine)
      true -> focus_herdr(location, Keyword.get(opts, :request, &request/2))
    end
  end

  defp focus_herdr(location, request) do
    with {:ok, %{"snapshot" => %{"panes" => panes}}} when is_list(panes) <- request.(location.herdr, ["api", "snapshot"]),
         {:ok, pane} <- exact_pane(panes, location),
         pane_id when is_binary(pane_id) and pane_id != "" <- pane["pane_id"],
         {:ok, %{"agent" => focused}} <- request.(location.herdr, ["agent", "focus", pane_id]) do
      if identity?(focused, location) and focused["terminal_id"] == pane["terminal_id"], do: result(nil), else: result(:identity_mismatch)
    else
      {:error, :session_gone} -> result(:session_gone)
      {:error, :identity_mismatch} -> result(:identity_mismatch)
      _ -> result(:herdr_unreachable)
    end
  end

  defp exact_pane(panes, location) do
    case Enum.filter(panes, &identity?(&1, location)) do
      [pane] -> {:ok, pane}
      [] -> {:error, :session_gone}
      _ -> {:error, :identity_mismatch}
    end
  end

  defp identity?(%{"agent" => agent} = pane, location) when is_binary(agent) and agent != "" do
    case location.herdr do
      %{"native_session_id" => id} when is_binary(id) and id != "" ->
        native_identity?(pane["agent_session"], agent, id, location.herdr["native_session_agent"])

      _ ->
        binding?(pane["tokens"], location)
    end
  end

  defp identity?(_pane, _location), do: false

  defp native_identity?(%{"kind" => "id", "agent" => agent, "value" => id}, agent, id, agent), do: true
  defp native_identity?(_session, _agent, _id, _native_agent), do: false

  defp binding?(tokens, location) when is_map(tokens) do
    target_key = if location.target_kind == "work_package", do: "sympp_work_package_id", else: "sympp_work_request_id"

    is_binary(location.client_id) and location.client_id != "" and
      tokens["sympp_session_location_id"] == location.client_id and tokens["sympp_role"] == location.role and
      tokens[target_key] == location.target_id
  end

  defp binding?(_tokens, _location), do: false

  defp result(nil), do: %{ok: true, status: "focused", reason: nil}
  defp result(reason), do: %{ok: true, status: "not_focused", reason: Atom.to_string(reason)}

  defp machine_id do
    {:ok, hostname} = :inet.gethostname()
    hostname |> to_string() |> String.trim() |> String.downcase()
  end

  defp request(selector, args) do
    executable = System.get_env("HERDR_BIN_PATH") || System.find_executable("herdr")

    if is_binary(executable) do
      env =
        Enum.map([{"HERDR_SESSION", "session"}, {"HERDR_SOCKET_PATH", "socket_path"}], fn {key, field} ->
          value = if is_binary(selector[field]), do: String.to_charlist(selector[field]), else: false
          {String.to_charlist(key), value}
        end)

      port = Port.open({:spawn_executable, executable}, [:binary, :exit_status, :stderr_to_stdout, :hide, args: args, env: env])
      collect(port, "", System.monotonic_time(:millisecond) + 5_000)
    else
      {:error, :herdr_unreachable}
    end
  rescue
    _ -> {:error, :herdr_unreachable}
  end

  defp collect(port, output, deadline) do
    receive do
      {^port, {:data, data}} -> collect(port, output <> data, deadline)
      {^port, {:exit_status, _status}} -> decode(output)
    after
      max(deadline - System.monotonic_time(:millisecond), 0) ->
        Port.close(port)
        {:error, :herdr_unreachable}
    end
  end

  defp decode(output) do
    case Jason.decode(output) do
      {:ok, %{"result" => result}} -> {:ok, result}
      {:ok, %{"error" => %{"code" => code}}} when code in ["pane_not_found", "agent_not_found"] -> {:error, :session_gone}
      _ -> {:error, :herdr_unreachable}
    end
  end
end
