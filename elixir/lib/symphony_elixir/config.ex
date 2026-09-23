defmodule SymphonyElixir.Config do
  @moduledoc """
  Runtime configuration loaded from `WORKFLOW.md`.
  """

  alias SymphonyElixir.Config.Schema
  alias SymphonyElixir.SymphonyPlusPlus.Lifecycle.StateMachine
  alias SymphonyElixir.SymphonyPlusPlus.TrackerStates
  alias SymphonyElixir.Workflow

  @default_prompt_template """
  You are working on a Linear issue.

  Identifier: {{ issue.identifier }}
  Title: {{ issue.title }}

  Body:
  {% if issue.description %}
  {{ issue.description }}
  {% else %}
  No description provided.
  {% endif %}
  """

  @type codex_runtime_settings :: %{
          approval_policy: String.t() | map(),
          thread_sandbox: String.t(),
          turn_sandbox_policy: map()
        }

  @settings_cache_key {__MODULE__, :settings_cache}
  @fallback_environment_names ["LINEAR_API_KEY", "LINEAR_ASSIGNEE"]
  @environment_reference_pattern ~r/^\$([A-Za-z_][A-Za-z0-9_]*)$/

  @spec settings() :: {:ok, Schema.t()} | {:error, term()}
  def settings do
    case Workflow.current() do
      {:ok, %{config: config}} when is_map(config) ->
        cached_settings(config)

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec settings!() :: Schema.t()
  def settings! do
    case settings() do
      {:ok, settings} ->
        settings

      {:error, reason} ->
        raise ArgumentError, message: format_config_error(reason)
    end
  end

  @spec max_concurrent_agents_for_state(term()) :: pos_integer()
  def max_concurrent_agents_for_state(state_name) when is_binary(state_name) do
    config = settings!()

    Map.get(
      config.agent.max_concurrent_agents_by_state,
      Schema.normalize_issue_state(state_name),
      config.agent.max_concurrent_agents
    )
  end

  def max_concurrent_agents_for_state(_state_name), do: settings!().agent.max_concurrent_agents

  @spec codex_turn_sandbox_policy(Path.t() | nil) :: map()
  def codex_turn_sandbox_policy(workspace \\ nil) do
    case Schema.resolve_runtime_turn_sandbox_policy(settings!(), workspace) do
      {:ok, policy} ->
        policy

      {:error, reason} ->
        raise ArgumentError, message: "Invalid codex turn sandbox policy: #{inspect(reason)}"
    end
  end

  @spec workflow_prompt() :: String.t()
  def workflow_prompt do
    case Workflow.current() do
      {:ok, %{prompt_template: prompt}} ->
        if String.trim(prompt) == "", do: @default_prompt_template, else: prompt

      _ ->
        @default_prompt_template
    end
  end

  @spec server_port() :: non_neg_integer() | nil
  def server_port do
    case Application.get_env(:symphony_elixir, :server_port_override) do
      port when is_integer(port) and port >= 0 -> port
      _ -> settings!().server.port
    end
  end

  @spec validate!() :: :ok | {:error, term()}
  def validate! do
    with {:ok, settings} <- settings() do
      validate_semantics(settings)
    end
  end

  @spec codex_runtime_settings(Path.t() | nil, keyword()) ::
          {:ok, codex_runtime_settings()} | {:error, term()}
  def codex_runtime_settings(workspace \\ nil, opts \\ []) do
    with {:ok, settings} <- settings() do
      with {:ok, turn_sandbox_policy} <-
             Schema.resolve_runtime_turn_sandbox_policy(settings, workspace, opts) do
        {:ok,
         %{
           approval_policy: settings.codex.approval_policy,
           thread_sandbox: settings.codex.thread_sandbox,
           turn_sandbox_policy: turn_sandbox_policy
         }}
      end
    end
  end

  defp cached_settings(config) do
    case :persistent_term.get(@settings_cache_key, nil) do
      {^config, environment_names, environment_values, {:ok, settings}} ->
        if environment_values == current_environment_values(environment_names) do
          {:ok, settings}
        else
          parse_and_cache_settings(config, environment_names)
        end

      _cache_miss ->
        parse_and_cache_settings(config, environment_names(config))
    end
  end

  defp parse_and_cache_settings(config, environment_names) do
    environment_values = current_environment_values(environment_names)
    result = Schema.parse(config)

    if match?({:ok, _settings}, result) do
      :persistent_term.put(@settings_cache_key, {config, environment_names, environment_values, result})
    end

    result
  end

  defp environment_names(config) do
    @fallback_environment_names
    |> Enum.concat(environment_reference_names(config))
    |> Enum.uniq()
    |> Enum.sort()
  end

  defp current_environment_values(environment_names), do: Enum.map(environment_names, &System.get_env/1)

  defp environment_reference_names(value) when is_map(value) do
    value
    |> Map.values()
    |> Enum.flat_map(&environment_reference_names/1)
  end

  defp environment_reference_names(value) when is_list(value), do: Enum.flat_map(value, &environment_reference_names/1)

  defp environment_reference_names(value) when is_binary(value) do
    case Regex.run(@environment_reference_pattern, value) do
      [_match, env_name] -> [env_name]
      nil -> []
    end
  end

  defp environment_reference_names(_value), do: []

  defp validate_semantics(settings) do
    cond do
      is_nil(settings.tracker.kind) ->
        {:error, :missing_tracker_kind}

      settings.tracker.kind not in (["linear", "memory"] ++ TrackerStates.tracker_kinds()) ->
        {:error, {:unsupported_tracker_kind, settings.tracker.kind}}

      settings.tracker.kind == "linear" and not is_binary(settings.tracker.api_key) ->
        {:error, :missing_linear_api_token}

      settings.tracker.kind == "linear" and not is_binary(settings.tracker.project_slug) ->
        {:error, :missing_linear_project_slug}

      TrackerStates.tracker_kind?(settings.tracker.kind) ->
        validate_symphony_plus_plus_tracker(settings.tracker)

      true ->
        :ok
    end
  end

  defp validate_symphony_plus_plus_tracker(tracker) do
    with :ok <- validate_symphony_plus_plus_tracker_secrets(tracker),
         :ok <- validate_symphony_plus_plus_tracker_assignee(tracker),
         :ok <- validate_symphony_plus_plus_tracker_states(tracker) do
      validate_symphony_plus_plus_dispatch_filters(tracker.filters)
    end
  end

  defp validate_symphony_plus_plus_tracker_assignee(%{assignee: assignee}) when is_binary(assignee) do
    if String.trim(assignee) == "" do
      {:error, :missing_symphony_plus_plus_assignee}
    else
      :ok
    end
  end

  defp validate_symphony_plus_plus_tracker_assignee(_tracker), do: {:error, :missing_symphony_plus_plus_assignee}

  defp validate_symphony_plus_plus_tracker_secrets(tracker) do
    secret_placeholders =
      [tracker.api_key, tracker.assignee]
      |> Enum.filter(&secret_placeholder?/1)

    case secret_placeholders do
      [] -> :ok
      _ -> {:error, {:unsupported_symphony_plus_plus_secret_placeholders, secret_placeholders}}
    end
  end

  defp secret_placeholder?("$" <> rest), do: String.trim(rest) != ""
  defp secret_placeholder?(_value), do: false

  defp validate_symphony_plus_plus_tracker_states(tracker) do
    terminal_states = TrackerStates.terminal_state_names(nil) |> MapSet.new()
    tracker_active_states = TrackerStates.active_state_names(nil) |> MapSet.new()
    valid_states = MapSet.union(tracker_active_states, terminal_states)

    invalid_states =
      (tracker.active_states ++ tracker.terminal_states)
      |> Enum.reject(&MapSet.member?(valid_states, &1))

    invalid_active_states =
      tracker.active_states
      |> Enum.reject(&MapSet.member?(tracker_active_states, &1))

    invalid_terminal_states =
      tracker.terminal_states
      |> Enum.reject(&MapSet.member?(terminal_states, &1))

    overlapping_states =
      tracker.active_states
      |> Enum.filter(&(&1 in tracker.terminal_states))
      |> Enum.uniq()

    cond do
      invalid_states != [] ->
        {:error, {:unsupported_symphony_plus_plus_tracker_states, Enum.uniq(invalid_states)}}

      overlapping_states != [] ->
        {:error, {:overlapping_symphony_plus_plus_tracker_states, overlapping_states}}

      invalid_active_states != [] ->
        {:error, {:unsupported_symphony_plus_plus_active_states, Enum.uniq(invalid_active_states)}}

      invalid_terminal_states != [] ->
        {:error, {:unsupported_symphony_plus_plus_terminal_states, Enum.uniq(invalid_terminal_states)}}

      true ->
        :ok
    end
  end

  defp validate_symphony_plus_plus_dispatch_filters(nil), do: :ok

  defp validate_symphony_plus_plus_dispatch_filters(filters) do
    with :ok <- validate_dispatch_filter_values(:repos, filters.repos),
         :ok <- validate_dispatch_filter_values(:base_branches, filters.base_branches),
         :ok <- validate_dispatch_filter_values(:work_kinds, filters.work_kinds) do
      validate_dispatch_filter_work_kinds(filters.work_kinds)
    end
  end

  defp validate_dispatch_filter_values(field, values) when is_list(values) do
    invalid_values =
      values
      |> Enum.reject(&(is_binary(&1) and String.trim(&1) != ""))

    case invalid_values do
      [] -> :ok
      _ -> {:error, {:invalid_symphony_plus_plus_dispatch_filter, field, invalid_values}}
    end
  end

  defp validate_dispatch_filter_values(field, value),
    do: {:error, {:invalid_symphony_plus_plus_dispatch_filter, field, value}}

  defp validate_dispatch_filter_work_kinds(work_kinds) do
    invalid_kinds = Enum.reject(work_kinds, &StateMachine.supported_kind?/1)

    case invalid_kinds do
      [] -> :ok
      _ -> {:error, {:unsupported_symphony_plus_plus_work_kinds, invalid_kinds}}
    end
  end

  defp format_config_error(reason) do
    case reason do
      {:invalid_workflow_config, message} ->
        "Invalid WORKFLOW.md config: #{message}"

      {:missing_workflow_file, path, raw_reason} ->
        "Missing WORKFLOW.md at #{path}: #{inspect(raw_reason)}"

      {:workflow_parse_error, raw_reason} ->
        "Failed to parse WORKFLOW.md: #{inspect(raw_reason)}"

      :workflow_front_matter_not_a_map ->
        "Failed to parse WORKFLOW.md: workflow front matter must decode to a map"

      other ->
        "Invalid WORKFLOW.md config: #{inspect(other)}"
    end
  end
end
