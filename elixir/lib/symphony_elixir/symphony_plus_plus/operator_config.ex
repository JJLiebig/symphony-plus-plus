defmodule SymphonyElixir.SymphonyPlusPlus.OperatorConfig do
  @moduledoc false

  alias SymphonyElixir.SymphonyPlusPlus.RepoIdentity

  @spec load() :: map()
  def load do
    with {:ok, contents} <- File.read(config_path()),
         {:ok, config} when is_map(config) <- Jason.decode(contents) do
      config
      |> Map.take(["repos", "machines"])
      |> Map.update("repos", %{}, &normalize_repos/1)
    else
      _result -> %{}
    end
  end

  defp normalize_repos(repos) when is_map(repos), do: Map.new(repos, fn {key, value} -> {String.downcase(key), value} end)
  defp normalize_repos(_repos), do: %{}

  @spec area_path(map(), map()) :: [String.t()] | nil
  def area_path(config, repo_identity) do
    with remote when is_binary(remote) <- Map.get(repo_identity, :repo_remote),
         identity <- RepoIdentity.fields(%{}, remote),
         repo_key when is_binary(repo_key) <- identity.repo_key,
         %{"area" => area} when is_list(area) <- entry(config, "repos", repo_key),
         true <- length(area) in 1..3 and Enum.all?(area, &filled_string?/1) do
      area
    else
      _result -> nil
    end
  end

  @spec session_location(map(), map() | nil) :: map() | nil
  def session_location(config, %{worker_host: host, session_id: session_id}) do
    with true <- filled_string?(host) and filled_string?(session_id),
         %{"label" => label, "kind" => kind} <- entry(config, "machines", host),
         true <- filled_string?(label) and kind in ["desktop", "laptop", "server"] do
      %{label: label, kind: kind}
    else
      _result -> nil
    end
  end

  def session_location(_config, _session), do: nil

  @spec machine(map(), String.t() | nil, String.t() | nil) :: map()
  def machine(config, machine_id, fallback_label) do
    configured =
      case entry(config, "machines", machine_id) do
        value when is_map(value) -> value
        _other -> %{}
      end
    label = Map.get(configured, "label")
    kind = Map.get(configured, "kind")

    %{
      label: if(filled_string?(label), do: label, else: fallback_label || machine_id || "Unknown machine"),
      kind: if(kind in ["desktop", "laptop", "server"], do: kind)
    }
  end

  defp config_path do
    System.get_env("SYMPP_OPERATOR_CONFIG") ||
      Path.join(System.get_env("SYMPP_HOME") || Path.expand("~/.agents/splusplus"), "operator-board.json")
  end

  defp entry(config, section, key) do
    case Map.get(config, section) do
      entries when is_map(entries) -> Map.get(entries, key)
      _other -> nil
    end
  end

  defp filled_string?(value), do: is_binary(value) and String.trim(value) != ""
end
