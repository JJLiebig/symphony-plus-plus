defmodule SymphonyElixir.SymphonyPlusPlus.SessionFocus do
  @moduledoc false

  alias SymphonyElixir.SymphonyPlusPlus.SessionLocations

  @spec focus(module(), String.t(), String.t()) :: map()
  def focus(repo, target_kind, target_id) do
    focus_location(SessionLocations.get(repo, target_kind, target_id))
  end

  @doc false
  @spec focus_location(map() | nil, keyword()) :: map()
  def focus_location(location, opts \\ [])
  def focus_location(nil, _opts), do: result(:session_gone)

  def focus_location(location, opts) do
    cond do
      location.machine_id != Keyword.get(opts, :machine_id, machine_id()) -> result(:other_machine)
      location.source != "herdr" -> result(:not_in_herdr)
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

  defp identity?(pane, location) when is_map(pane) do
    session = pane["agent_session"] || %{}
    tokens = pane["tokens"] || %{}
    native_id = location.herdr["native_session_id"]
    native_agent = location.herdr["native_session_agent"]

    live_agent? = is_binary(pane["agent"]) and pane["agent"] != ""

    if is_binary(native_id) and native_id != "" do
      live_agent? and pane["agent"] == native_agent and session["agent"] == native_agent and
        session["kind"] == "id" and session["value"] == native_id
    else
      target_key = if location.target_kind == "work_package", do: "sympp_work_package_id", else: "sympp_work_request_id"

      live_agent? and is_binary(location.client_id) and location.client_id != "" and
        tokens["sympp_session_location_id"] == location.client_id and tokens["sympp_role"] == location.role and
        tokens[target_key] == location.target_id
    end
  end

  defp identity?(_pane, _location), do: false

  defp result(nil), do: %{ok: true, status: "focused", reason: nil}
  defp result(reason), do: %{ok: true, status: "not_focused", reason: Atom.to_string(reason)}

  defp machine_id do
    case :inet.gethostname() do
      {:ok, hostname} -> hostname |> to_string() |> String.trim() |> String.downcase()
      _ -> nil
    end
  end

  defp request(selector, args) do
    executable = System.get_env("HERDR_BIN_PATH") || System.find_executable("herdr")

    if is_binary(executable) do
      env =
        Enum.map([{"HERDR_SESSION", "session"}, {"HERDR_SOCKET_PATH", "socket_path"}], fn {key, field} ->
          {String.to_charlist(key), if(is_binary(selector[field]), do: String.to_charlist(selector[field]), else: false)}
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
