defmodule SymphonyElixir.SymphonyPlusPlus.OperatorSettings.RetentionThrottle do
  @moduledoc false

  alias SymphonyElixir.SymphonyPlusPlus.OperatorSettings.Settings
  alias SymphonyElixir.SymphonyPlusPlus.Repo

  @default_window_ms 30_000

  @type retention_fun :: (DateTime.t() -> :ok | {:error, term()})

  @spec run(module(), Settings.t(), retention_fun(), keyword()) :: :ok | {:error, term()}
  def run(repo, %Settings{} = settings, retention_fun, opts \\ [])
      when is_atom(repo) and is_function(retention_fun, 1) and is_list(opts) do
    key = cache_key(repo, settings)

    :global.trans(
      {__MODULE__, key},
      fn -> maybe_run_retention(key, retention_fun, opts) end,
      [node()],
      :infinity
    )
  end

  @spec reset(module()) :: :ok
  def reset(repo) when is_atom(repo) do
    repo_key = repo_key(repo)

    :persistent_term.get()
    |> Enum.each(fn
      {{__MODULE__, ^repo_key, _settings_key} = key, _value} -> :persistent_term.erase(key)
      _entry -> :ok
    end)

    :ok
  end

  defp run_retention(retention_fun, %DateTime{} = now), do: retention_fun.(now)

  defp maybe_run_retention(key, retention_fun, opts) do
    now_ms = Keyword.get_lazy(opts, :monotonic_ms, &monotonic_ms/0)

    if Keyword.get(opts, :force, false) or retention_due?(key, now_ms, throttle_window_ms(opts)) do
      retention_fun
      |> run_retention(Keyword.get_lazy(opts, :now, fn -> DateTime.utc_now(:microsecond) end))
      |> cache_success(key, now_ms)
    else
      :ok
    end
  end

  defp cache_success(:ok, key, now_ms) do
    :persistent_term.put(key, now_ms)
    :ok
  end

  defp cache_success({:error, _reason} = error, _key, _now_ms), do: error

  defp retention_due?(key, _now_ms, window_ms) when window_ms <= 0 do
    :persistent_term.erase(key)
    true
  end

  defp retention_due?(key, now_ms, window_ms) do
    case :persistent_term.get(key, nil) do
      nil -> true
      last_ms -> now_ms - last_ms >= window_ms
    end
  end

  defp throttle_window_ms(opts) do
    Keyword.get_lazy(opts, :window_ms, fn ->
      Application.get_env(:symphony_elixir, :sympp_operator_retention_throttle_ms, @default_window_ms)
    end)
  end

  defp monotonic_ms, do: System.monotonic_time(:millisecond)

  defp cache_key(repo, %Settings{} = settings) do
    {__MODULE__, repo_key(repo), {settings.work_request_archive_after_days, settings.work_request_never_started_archive_after_days, settings.solo_session_delete_after_days}}
  end

  defp repo_key(repo) do
    repo
    |> Repo.operator_database_path()
    |> Repo.database_key()
  end
end
