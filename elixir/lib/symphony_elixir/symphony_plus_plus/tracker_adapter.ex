defmodule SymphonyElixir.SymphonyPlusPlus.TrackerAdapter do
  @moduledoc """
  Tracker adapter exposing sympp WorkPackages as normalized issues.
  """

  @behaviour SymphonyElixir.Tracker

  import Ecto.Query, only: [from: 2]

  alias Ecto.Adapters.SQL
  alias SymphonyElixir.Config
  alias SymphonyElixir.Linear.Issue
  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.AccessGrant
  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.Assignment
  alias SymphonyElixir.SymphonyPlusPlus.AgentRuns.Service, as: AgentRunService
  alias SymphonyElixir.SymphonyPlusPlus.Lifecycle.Service, as: LifecycleService
  alias SymphonyElixir.SymphonyPlusPlus.Lifecycle.StateMachine
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Repository, as: PlanningRepository
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.Repo.Migrations
  alias SymphonyElixir.SymphonyPlusPlus.TrackerStates
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage

  @acceptance_criteria_limit 25
  @description_limit 16_000
  @external_text_limit 4_000
  @inline_text_limit 500
  @migration_file_lock_heartbeat_ms 1_000
  @migration_file_lock_stale_seconds 30
  @migration_lock_retries :infinity
  @migration_lock_retry_delay_ms 100
  @local_lock_retry_delay_ms 100
  @lock_wait_observer_key :sympp_tracker_adapter_lock_wait_observer
  @local_lock_owner :symphony_plus_plus_tracker_adapter_lock_owner
  @local_lock_owner_timeout_ms 1_000
  @local_lock_table :symphony_plus_plus_tracker_adapter_locks
  @repo_access_lock_retries :infinity
  @repo_shutdown_poll_ms 10
  @repo_shutdown_timeout_ms 1_000
  @truncated_notice "[truncated]"
  @spec fetch_candidate_issues() :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_candidate_issues do
    tracker = Config.settings!().tracker
    active_states = tracker.active_states |> TrackerStates.active_state_names() |> MapSet.new()
    terminal_states = tracker.terminal_states |> TrackerStates.terminal_state_names() |> MapSet.new()
    candidate_states = active_states |> MapSet.difference(terminal_states) |> MapSet.to_list()
    filters = tracker.filters

    fetch_work_package_issues(
      fn -> list_work_packages_by_statuses(candidate_states) end,
      &dispatchable_work_package?(&1, filters)
    )
  end

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_states(state_names) when is_list(state_names) do
    normalized_states =
      state_names
      |> Enum.map(&TrackerStates.canonical_state_name/1)
      |> MapSet.new()
      |> MapSet.delete("")

    if MapSet.size(normalized_states) == 0 do
      {:ok, []}
    else
      states = MapSet.to_list(normalized_states)

      fetch_work_package_issues(fn -> list_work_packages_by_statuses(states) end, &dispatchable_kind?/1)
    end
  end

  @spec fetch_issue_states_by_ids([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issue_states_by_ids(issue_ids) when is_list(issue_ids) do
    wanted_ids =
      issue_ids
      |> Enum.filter(&is_binary/1)
      |> MapSet.new()

    if MapSet.size(wanted_ids) == 0 do
      {:ok, []}
    else
      ids = MapSet.to_list(wanted_ids)

      fetch_work_package_issues(fn -> list_work_packages_by_ids(ids) end, &dispatchable_kind?/1)
    end
  end

  @spec create_comment(String.t(), String.t()) :: :ok | {:error, term()}
  def create_comment(issue_id, body) when is_binary(issue_id) and is_binary(body) do
    with_repo_access(fn ->
      bounded_body = bound_external_text(body)

      with {:ok, grant} <- claimed_comment_grant(issue_id),
           {:ok, _event} <-
             PlanningRepository.append_audit_progress_event(repo(), assignment_from_grant(grant), %{
               summary: comment_summary(bounded_body),
               body: bounded_body
             }) do
        :ok
      else
        {:error, reason} -> {:error, reason}
      end
    end)
  end

  @spec update_issue_state(String.t(), String.t()) :: :ok | {:error, term()}
  def update_issue_state(issue_id, state_name) when is_binary(issue_id) and is_binary(state_name) do
    with_repo_access(fn -> do_update_issue_state(issue_id, state_name) end)
  end

  @spec start_agent_run(Issue.t(), keyword()) :: {:ok, term()} | {:error, term()}
  def start_agent_run(%Issue{} = issue, opts) when is_list(opts) do
    with_repo_access(fn -> AgentRunService.start_dispatch(repo(), issue, opts) end)
  end

  @spec list_active_agent_runs() :: {:ok, [term()]} | {:error, term()}
  def list_active_agent_runs do
    with_repo_access(fn -> AgentRunService.list_active(repo()) end)
  end

  @spec heartbeat_agent_run(String.t(), map()) :: {:ok, term()} | {:error, term()}
  def heartbeat_agent_run(agent_run_id, attrs) when is_binary(agent_run_id) and is_map(attrs) do
    with_repo_access(fn -> AgentRunService.heartbeat(repo(), agent_run_id, attrs) end)
  end

  @spec mark_agent_run_retrying(String.t(), String.t() | nil) :: {:ok, term()} | {:error, term()}
  def mark_agent_run_retrying(agent_run_id, reason) when is_binary(agent_run_id) do
    with_repo_access(fn -> AgentRunService.mark_retrying(repo(), agent_run_id, reason) end)
  end

  @spec mark_agent_run_running(String.t(), String.t() | nil) :: {:ok, term()} | {:error, term()}
  def mark_agent_run_running(agent_run_id, reason) when is_binary(agent_run_id) do
    with_repo_access(fn -> AgentRunService.mark_running(repo(), agent_run_id, reason) end)
  end

  @spec mark_agent_run_completed(String.t(), String.t() | nil) :: {:ok, term()} | {:error, term()}
  def mark_agent_run_completed(agent_run_id, reason) when is_binary(agent_run_id) do
    with_repo_access(fn -> AgentRunService.mark_completed(repo(), agent_run_id, reason) end)
  end

  @spec mark_agent_run_failed(String.t(), String.t() | nil) :: {:ok, term()} | {:error, term()}
  def mark_agent_run_failed(agent_run_id, reason) when is_binary(agent_run_id) do
    with_repo_access(fn -> AgentRunService.mark_failed(repo(), agent_run_id, reason) end)
  end

  @spec mark_agent_run_stopped(String.t(), String.t() | nil) :: {:ok, term()} | {:error, term()}
  def mark_agent_run_stopped(agent_run_id, reason) when is_binary(agent_run_id) do
    with_repo_access(fn -> AgentRunService.mark_stopped(repo(), agent_run_id, reason) end)
  end

  defp do_update_issue_state(issue_id, state_name) do
    canonical_state_name = TrackerStates.canonical_state_name(state_name)

    with {:ok, work_package} <- Repository.get(repo(), issue_id),
         {:ok, grants} <- claimed_transition_grants(work_package, canonical_state_name) do
      transition_issue_with_grants(issue_id, canonical_state_name, grants, nil)
    end
  end

  defp transition_issue(issue_id, state_name, %AccessGrant{} = grant) do
    case LifecycleService.transition(repo(), issue_id, state_name, %{grant_id: grant.id}) do
      {:ok, %WorkPackage{}} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  defp transition_issue_with_grants(issue_id, state_name, [grant | grants], _last_error) do
    case transition_issue(issue_id, state_name, grant) do
      :ok -> :ok
      {:error, reason} -> transition_issue_with_grants(issue_id, state_name, grants, reason)
    end
  end

  defp transition_issue_with_grants(_issue_id, _state_name, [], nil), do: {:error, :actor_scope_mismatch}
  defp transition_issue_with_grants(_issue_id, _state_name, [], reason), do: {:error, reason}

  @doc false
  @spec to_issue(WorkPackage.t()) :: Issue.t()
  def to_issue(%WorkPackage{} = work_package) do
    to_issue(work_package, nil)
  end

  @doc false
  @spec dispatch_filters_match?(Issue.t()) :: boolean()
  def dispatch_filters_match?(%Issue{} = issue) do
    filters = Config.settings!().tracker.filters

    matches_issue_dispatch_filters?(issue, filters)
  end

  defp to_issue(%WorkPackage{} = work_package, worker_grants_by_work_package_id) do
    worker_assignment = worker_assignment(work_package, worker_grants_by_work_package_id)

    %Issue{
      id: work_package.id,
      identifier: work_package.id,
      title: work_package.title,
      description: description(work_package),
      priority: nil,
      state: TrackerStates.canonical_state_name(work_package.status),
      branch_name: work_package.branch_pattern,
      url: nil,
      assignee_id: issue_assignee_id(work_package, worker_assignment),
      blocked_by: [],
      labels: labels(work_package),
      assigned_to_worker: match?({:ok, %AccessGrant{}}, worker_assignment),
      created_at: work_package.inserted_at,
      updated_at: work_package.updated_at
    }
  end

  @doc false
  @spec global_transaction_for_test(term(), (-> term()), non_neg_integer() | :infinity) :: term()
  def global_transaction_for_test(lock_id, fun, retries) when is_function(fun, 0) do
    global_transaction(lock_id, fun, retries)
  end

  @doc false
  @spec repo_access_lock_retries_for_test() :: non_neg_integer() | :infinity
  def repo_access_lock_retries_for_test, do: @repo_access_lock_retries

  @doc false
  @spec migration_lock_retries_for_test() :: non_neg_integer() | :infinity
  def migration_lock_retries_for_test, do: @migration_lock_retries

  @doc false
  @spec migration_file_lock_for_test(Path.t(), (-> term())) :: term()
  def migration_file_lock_for_test(database_path, fun) when is_binary(database_path) and is_function(fun, 0) do
    with_migration_file_lock(database_path, fun)
  end

  @doc false
  @spec run_with_migration_file_lock(Path.t(), (-> term())) :: term()
  def run_with_migration_file_lock(database_path, fun) when is_binary(database_path) and is_function(fun, 0) do
    with_migration_file_lock(database_path, fun)
  end

  @doc false
  @spec migration_file_lock_for_test(Path.t(), (-> term()), non_neg_integer() | :infinity) :: term()
  def migration_file_lock_for_test(database_path, fun, retries) when is_binary(database_path) and is_function(fun, 0) do
    with_migration_file_lock(database_path, fun, retries)
  end

  @doc false
  @spec main_database_row_matches_for_test([term()], term()) :: boolean()
  def main_database_row_matches_for_test(row, database_path) do
    main_database_row?(row, database_path)
  end

  defp list_work_packages_by_statuses(statuses) when is_list(statuses) do
    state_query_names = TrackerStates.lookup_state_query_names(statuses)

    work_packages =
      repo().all(
        from(work_package in WorkPackage,
          where: fragment("lower(trim(?))", work_package.status) in ^state_query_names,
          order_by: [asc: work_package.inserted_at, asc: work_package.id]
        )
      )

    {:ok, work_packages}
  rescue
    error -> {:error, error}
  end

  defp list_work_packages_by_ids(ids) when is_list(ids) do
    work_packages =
      repo().all(
        from(work_package in WorkPackage,
          where: work_package.id in ^ids,
          order_by: [asc: work_package.inserted_at, asc: work_package.id]
        )
      )

    {:ok, work_packages}
  rescue
    error -> {:error, error}
  end

  defp fetch_work_package_issues(list_fun, filter_fun) when is_function(list_fun, 0) and is_function(filter_fun, 1) do
    with_repo_access(fn ->
      with {:ok, work_packages} <- list_fun.(),
           filtered_work_packages = Enum.filter(work_packages, filter_fun),
           {:ok, worker_grants_by_work_package_id} <-
             claimed_worker_grants_by_work_package_ids(Enum.map(filtered_work_packages, & &1.id)) do
        issues = Enum.map(filtered_work_packages, &to_issue(&1, worker_grants_by_work_package_id))
        {:ok, issues}
      end
    end)
  end

  defp repo, do: Repo

  defp with_repo_access(fun) when is_function(fun, 0) do
    database_path = Repo.database_path()
    lock_id = {{__MODULE__, :repo_access}, Repo.database_key(database_path)}

    case repo_access_transaction(lock_id, fn -> with_dynamic_repo(database_path, fun) end) do
      :aborted -> {:error, :repo_access_lock_busy}
      result -> result
    end
  rescue
    error -> {:error, error}
  end

  defp with_dynamic_repo(database_path, fun) do
    with {:ok, pid, ownership} <- ensure_repo_started(database_path) do
      original_repo = Repo.put_dynamic_repo(pid)

      try do
        with :ok <- ensure_repo_migrated(database_path) do
          safe_repo_call(fun)
        end
      after
        Repo.put_dynamic_repo(original_repo)
        stop_owned_repo(ownership, database_path)
      end
    end
  end

  defp repo_access_transaction(lock_id, fun) do
    global_transaction(lock_id, fun, @repo_access_lock_retries)
  end

  defp safe_repo_call(fun) do
    fun.()
  rescue
    error -> {:error, error}
  end

  defp ensure_repo_started(database_path) do
    case repo_pid(database_path) do
      pid when is_pid(pid) ->
        {:ok, pid, :existing}

      _not_started ->
        start_repo(database_path)
    end
  end

  defp repo_pid(database_path) do
    global_repo_pid(database_path) || default_repo_pid(database_path)
  end

  defp global_repo_pid(database_path) do
    case :global.whereis_name(Repo.process_key(database_path)) do
      pid when is_pid(pid) -> pid
      :undefined -> nil
    end
  end

  defp default_repo_pid(database_path) do
    case Process.whereis(Repo) do
      pid when is_pid(pid) ->
        if repo_process_uses_database?(pid, database_path), do: pid

      nil ->
        nil
    end
  end

  defp repo_process_uses_database?(pid, database_path) do
    case SQL.query(pid, "PRAGMA database_list", []) do
      {:ok, %{rows: rows}} -> Enum.any?(rows, &main_database_row?(&1, database_path))
      {:error, _reason} -> false
    end
  end

  defp main_database_row?([_seq, "main", path], database_path) when is_binary(path) and is_binary(database_path) do
    if Repo.filesystem_database_path?(database_path) do
      Repo.same_database_path?(path, database_path)
    else
      sqlite_special_database_matches_path?(database_path, path)
    end
  end

  defp main_database_row?(_row, _database_path), do: false

  defp sqlite_special_database_matches_path?(":memory:", ""), do: true

  defp sqlite_special_database_matches_path?("file:" <> _uri = database_path, path) do
    if path == "" do
      Repo.memory_database?(database_path)
    else
      sqlite_file_uri_matches_path?(database_path, path)
    end
  end

  defp sqlite_special_database_matches_path?(_database_path, _path), do: false

  defp sqlite_file_uri_matches_path?(database_path, path) do
    case Repo.sqlite_file_uri_path(database_path) do
      uri_path when is_binary(uri_path) and uri_path != "" -> Repo.same_database_path?(uri_path, path)
      _missing -> false
    end
  end

  defp start_repo(database_path) do
    child_spec = repo_child_spec(database_path)

    case Process.whereis(SymphonyElixir.Supervisor) do
      pid when is_pid(pid) -> start_repo_child(child_spec)
      _no_supervisor -> start_repo_directly(database_path)
    end
  end

  defp repo_child_spec(database_path) do
    Supervisor.child_spec(
      {Repo, Repo.child_options(database: database_path, name: Repo.process_name(database_path))},
      id: Repo.child_id(database_path)
    )
  end

  defp start_repo_child(child_spec) do
    case Supervisor.start_child(SymphonyElixir.Supervisor, child_spec) do
      {:ok, pid} -> {:ok, pid, {:supervised, child_spec.id, pid}}
      {:ok, pid, _info} -> {:ok, pid, {:supervised, child_spec.id, pid}}
      {:error, {:already_started, pid}} -> {:ok, pid, :existing}
      {:error, reason} -> {:error, reason}
    end
  end

  defp start_repo_directly(database_path) do
    caller = self()
    ref = make_ref()
    options = Repo.child_options(database: database_path, name: Repo.process_name(database_path))

    # A normal exit from this starter does not terminate the linked Repo; it keeps
    # abnormal request-process exits from owning the fallback Repo lifecycle.
    starter = spawn(fn -> send(caller, {ref, self(), Repo.start_link(options)}) end)

    receive do
      {^ref, ^starter, result} -> repo_start_result(result)
    after
      5_000 ->
        Process.exit(starter, :kill)
        {:error, :repo_start_timeout}
    end
  end

  defp repo_start_result(result) do
    case result do
      {:ok, pid} -> {:ok, pid, {:direct, pid}}
      {:error, {:already_started, pid}} -> {:ok, pid, :existing}
      {:error, reason} -> {:error, reason}
    end
  end

  defp stop_owned_repo(ownership, database_path) do
    if Repo.memory_database?(database_path) do
      :ok
    else
      stop_adapter_owned_repo(ownership, database_path)
    end
  end

  defp stop_adapter_owned_repo(:existing, _database_path), do: :ok

  defp stop_adapter_owned_repo({:supervised, child_id, pid}, database_path) do
    case Process.whereis(SymphonyElixir.Supervisor) do
      supervisor when is_pid(supervisor) ->
        _ = Supervisor.terminate_child(supervisor, child_id)
        _ = Supervisor.delete_child(supervisor, child_id)
        wait_for_repo_unregistered(pid, database_path)

      _no_supervisor ->
        stop_direct_repo(pid, database_path)
    end

    :ok
  end

  defp stop_adapter_owned_repo({:direct, pid}, database_path) when is_pid(pid), do: stop_direct_repo(pid, database_path)

  defp stop_direct_repo(pid, database_path) do
    ref = Process.monitor(pid)
    Process.exit(pid, :shutdown)

    receive do
      {:DOWN, ^ref, :process, ^pid, _reason} -> :ok
    after
      1_000 ->
        Process.demonitor(ref, [:flush])
        :ok
    end

    wait_for_repo_unregistered(pid, database_path)
  end

  defp wait_for_repo_unregistered(pid, database_path) do
    deadline = System.monotonic_time(:millisecond) + @repo_shutdown_timeout_ms
    wait_for_repo_unregistered(pid, database_path, deadline)
  end

  defp wait_for_repo_unregistered(pid, database_path, deadline) do
    case global_repo_pid(database_path) do
      ^pid ->
        if System.monotonic_time(:millisecond) >= deadline do
          :ok
        else
          Process.sleep(@repo_shutdown_poll_ms)
          wait_for_repo_unregistered(pid, database_path, deadline)
        end

      _unregistered_or_replaced ->
        :ok
    end
  end

  defp ensure_repo_migrated(database_path) do
    with_migration_file_lock(database_path, fn ->
      ensure_repo_migrated_under_process_lock(database_path, @migration_lock_retries)
    end)
  end

  defp ensure_repo_migrated_under_process_lock(database_path, :infinity) do
    lock_id = {{__MODULE__, :repo_migration}, Repo.database_key(database_path)}

    case global_transaction(
           lock_id,
           fn -> ensure_repo_migrated_under_lock(database_path) end,
           :infinity
         ) do
      :aborted ->
        {:error, :repo_migration_lock_busy}

      result ->
        result
    end
  end

  defp with_migration_file_lock(database_path, fun, retries \\ @migration_lock_retries)

  defp with_migration_file_lock(_database_path, _fun, 0), do: {:error, :repo_migration_lock_busy}

  defp with_migration_file_lock(database_path, fun, retries) do
    lock_path = migration_file_lock_path(database_path)

    case acquire_migration_file_lock(lock_path) do
      {:ok, io_device, heartbeat, token} ->
        try do
          fun.()
        after
          stop_migration_file_lock_heartbeat(heartbeat)
          File.close(io_device)
          remove_owned_migration_file_lock(lock_path, token)
        end

      :busy ->
        case remove_stale_migration_file_lock(lock_path) do
          :removed ->
            with_migration_file_lock(database_path, fun, retries)

          :ok ->
            notify_lock_wait(:migration_file_lock, lock_path)
            Process.sleep(migration_lock_retry_delay_ms())
            with_migration_file_lock(database_path, fun, next_lock_retry(retries))
        end

      {:error, reason} ->
        {:error, {:repo_migration_file_lock_failed, reason}}
    end
  end

  defp next_lock_retry(:infinity), do: :infinity
  defp next_lock_retry(retries), do: retries - 1

  defp migration_lock_retry_delay_ms do
    configured_retry_delay_ms(
      :sympp_tracker_adapter_migration_lock_retry_delay_ms,
      @migration_lock_retry_delay_ms
    )
  end

  defp local_lock_retry_delay_ms do
    configured_retry_delay_ms(:sympp_tracker_adapter_local_lock_retry_delay_ms, @local_lock_retry_delay_ms)
  end

  defp local_lock_owner_timeout_ms do
    configured_retry_delay_ms(
      :sympp_tracker_adapter_local_lock_owner_timeout_ms,
      @local_lock_owner_timeout_ms
    )
  end

  defp notify_lock_wait(kind, identifier) do
    case Application.get_env(:symphony_elixir, @lock_wait_observer_key) do
      pid when is_pid(pid) ->
        send(pid, {:tracker_adapter_lock_wait, kind, identifier, self()})

      _other ->
        :ok
    end
  end

  defp configured_retry_delay_ms(key, default) do
    case Application.get_env(:symphony_elixir, key, default) do
      value when is_integer(value) and value >= 0 -> value
      _other -> default
    end
  end

  defp migration_file_lock_path(database_path) do
    if Repo.filesystem_database_path?(database_path) do
      database_path <> ".migration.lock"
    else
      lock_name =
        database_path
        |> Repo.database_key()
        |> :erlang.term_to_binary()
        |> then(&:crypto.hash(:sha256, &1))
        |> Base.encode16(case: :lower)

      Path.join([System.tmp_dir() || ".", "symphony_plus_plus_migration_locks", lock_name <> ".lock"])
    end
  end

  defp acquire_migration_file_lock(lock_path) do
    case File.mkdir_p(Path.dirname(lock_path)) do
      :ok ->
        open_migration_file_lock(lock_path)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp open_migration_file_lock(lock_path) do
    case File.open(lock_path, [:write, :exclusive]) do
      {:ok, io_device} ->
        token = migration_file_lock_token()
        IO.write(io_device, "#{token}\n#{node()} #{inspect(self())}\n")
        heartbeat = start_migration_file_lock_heartbeat(lock_path)
        {:ok, io_device, heartbeat, token}

      {:error, :eexist} ->
        :busy

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp migration_file_lock_token do
    16
    |> :crypto.strong_rand_bytes()
    |> Base.encode16(case: :lower)
  end

  defp start_migration_file_lock_heartbeat(lock_path) do
    spawn_link(fn -> migration_file_lock_heartbeat(lock_path) end)
  end

  defp migration_file_lock_heartbeat(lock_path) do
    receive do
      :stop -> :ok
    after
      @migration_file_lock_heartbeat_ms ->
        File.touch(lock_path)
        migration_file_lock_heartbeat(lock_path)
    end
  end

  defp stop_migration_file_lock_heartbeat(pid) when is_pid(pid) do
    ref = Process.monitor(pid)
    send(pid, :stop)

    receive do
      {:DOWN, ^ref, :process, ^pid, _reason} ->
        :ok
    after
      1_000 ->
        Process.demonitor(ref, [:flush])
        Process.unlink(pid)
        Process.exit(pid, :kill)
        :ok
    end
  end

  defp remove_stale_migration_file_lock(lock_path) do
    case File.stat(lock_path, time: :posix) do
      {:ok, %{mtime: mtime}} when is_integer(mtime) ->
        remove_stale_migration_file_lock(lock_path, mtime)

      _missing_or_unreadable ->
        :ok
    end
  end

  defp remove_stale_migration_file_lock(lock_path, mtime) do
    if System.os_time(:second) - mtime > @migration_file_lock_stale_seconds do
      remove_migration_file_lock(lock_path)
    else
      :ok
    end
  end

  defp remove_migration_file_lock(lock_path) do
    case File.rm(lock_path) do
      :ok -> :removed
      {:error, _reason} -> :ok
    end
  end

  @doc false
  @spec remove_owned_migration_file_lock_for_test(Path.t(), String.t()) :: :removed | :ok
  def remove_owned_migration_file_lock_for_test(lock_path, token) do
    remove_owned_migration_file_lock(lock_path, token)
  end

  defp remove_owned_migration_file_lock(lock_path, token) do
    case File.read(lock_path) do
      {:ok, contents} ->
        if lock_file_token(contents) == token do
          remove_migration_file_lock(lock_path)
        else
          :ok
        end

      {:error, _reason} ->
        :ok
    end
  end

  defp lock_file_token(contents) do
    contents
    |> String.split("\n", parts: 2)
    |> List.first()
  end

  defp global_transaction(lock_id, fun, retries) do
    if Node.alive?() do
      :global.trans(lock_id, fun, connected_nodes(), retries)
    else
      # This replaces local :global.trans/2 with in-VM coordination.
      # Separate OS processes rely on SQLite WAL and busy_timeout serialization.
      local_transaction(lock_id, fun, retries)
    end
  end

  defp connected_nodes, do: Enum.uniq([node() | Node.list()])

  defp local_transaction(_lock_id, _fun, 0), do: :aborted

  defp local_transaction(lock_id, fun, :infinity) do
    case acquire_local_lock(lock_id) do
      :ok ->
        try do
          fun.()
        after
          release_local_lock(lock_id)
        end

      :busy ->
        notify_lock_wait(:local_lock, lock_id)
        Process.sleep(local_lock_retry_delay_ms())
        local_transaction(lock_id, fun, :infinity)

      :unavailable ->
        :aborted
    end
  end

  defp local_transaction(lock_id, fun, retries) do
    case acquire_local_lock(lock_id) do
      :ok ->
        try do
          fun.()
        after
          release_local_lock(lock_id)
        end

      :busy ->
        notify_lock_wait(:local_lock, lock_id)
        Process.sleep(local_lock_retry_delay_ms())
        local_transaction(lock_id, fun, retries - 1)

      :unavailable ->
        :aborted
    end
  end

  defp acquire_local_lock(lock_id) do
    case ensure_local_lock_table() do
      :ok ->
        try do
          case :ets.insert_new(@local_lock_table, {lock_id, self()}) do
            true -> :ok
            false -> acquire_existing_local_lock(lock_id)
          end
        rescue
          ArgumentError -> :unavailable
        end

      _not_ready ->
        :unavailable
    end
  end

  defp acquire_existing_local_lock(lock_id) do
    case :ets.lookup(@local_lock_table, lock_id) do
      [{^lock_id, pid}] when is_pid(pid) ->
        if Process.alive?(pid) do
          :busy
        else
          :ets.delete(@local_lock_table, lock_id)
          acquire_local_lock(lock_id)
        end

      _entry ->
        :busy
    end
  end

  defp release_local_lock(lock_id) do
    :ets.delete(@local_lock_table, lock_id)
  rescue
    ArgumentError -> :ok
  end

  defp ensure_local_lock_table do
    case :ets.whereis(@local_lock_table) do
      :undefined ->
        @local_lock_owner
        |> ensure_local_lock_owner()
        |> request_local_lock_table()

      _table ->
        :ok
    end
  end

  defp ensure_local_lock_owner(name) do
    case Process.whereis(name) do
      pid when is_pid(pid) ->
        pid

      nil ->
        parent = self()
        pid = spawn(fn -> local_lock_owner(parent, name) end)

        receive do
          {:local_lock_owner_ready, ^pid} -> pid
          {:local_lock_owner_exists, ^pid, owner_pid} -> owner_pid || ensure_local_lock_owner(name)
        after
          local_lock_owner_timeout_ms() ->
            case Process.whereis(name) do
              owner_pid when is_pid(owner_pid) -> owner_pid
              nil -> ensure_local_lock_owner(name)
            end
        end
    end
  end

  defp local_lock_owner(parent, name) do
    Process.register(self(), name)
    ensure_local_lock_table_owned()
    send(parent, {:local_lock_owner_ready, self()})
    local_lock_owner_loop()
  rescue
    ArgumentError ->
      send(parent, {:local_lock_owner_exists, self(), Process.whereis(name)})
  end

  defp local_lock_owner_loop do
    receive do
      {:ensure_local_lock_table, caller, ref} ->
        ensure_local_lock_table_owned()
        send(caller, {:local_lock_table_ready, ref})
        local_lock_owner_loop()

      _message ->
        local_lock_owner_loop()
    end
  end

  defp request_local_lock_table(owner_pid) when is_pid(owner_pid) do
    ref = make_ref()
    send(owner_pid, {:ensure_local_lock_table, self(), ref})

    receive do
      {:local_lock_table_ready, ^ref} -> :ok
    after
      local_lock_owner_timeout_ms() -> :error
    end
  end

  defp ensure_local_lock_table_owned do
    case :ets.whereis(@local_lock_table) do
      :undefined -> :ets.new(@local_lock_table, [:named_table, :public, :set])
      _table -> :ok
    end
  end

  defp ensure_repo_migrated_under_lock(_database_path) do
    if migrated_schema?() do
      :ok
    else
      migrate_repo()
    end
  end

  defp migrate_repo do
    Ecto.Migrator.run(Repo, Migrations.all(), :up,
      all: true,
      dynamic_repo: Repo.get_dynamic_repo(),
      log: false
    )

    :ok
  rescue
    error -> {:error, {:migration_failed, error}}
  end

  defp migrated_schema? do
    expected_versions = migration_versions()

    case repo().query("SELECT version FROM schema_migrations", []) do
      {:ok, %{rows: rows}} ->
        migrated_versions =
          rows
          |> Enum.map(fn [version] -> to_string(version) end)
          |> MapSet.new()

        expected_versions != [] and MapSet.subset?(MapSet.new(expected_versions), migrated_versions)

      {:error, _reason} ->
        false
    end
  end

  defp migration_versions do
    Migrations.version_strings()
  end

  defp description(%WorkPackage{} = work_package) do
    [
      section("Product description", work_package.product_description),
      section("Engineering scope", work_package.engineering_scope),
      acceptance_criteria(work_package.acceptance_criteria),
      metadata(work_package)
    ]
    |> Enum.reject(&(&1 in [nil, ""]))
    |> bounded_description()
  end

  defp section(_heading, value) when value in [nil, ""], do: nil
  defp section(heading, value), do: "## #{heading}\n\n#{source_block(value)}"

  defp acceptance_criteria(criteria) when is_list(criteria) and criteria != [] do
    {rendered_criteria, omitted_count} = capped_head_items(criteria, @acceptance_criteria_limit)

    body =
      rendered_criteria
      |> Enum.map(&("- " <> source_inline(&1, @inline_text_limit)))
      |> maybe_append_omission(omitted_count, "acceptance criteria")
      |> Enum.join("\n")

    "## Acceptance criteria\n\n#{body}"
  end

  defp acceptance_criteria(_criteria), do: nil

  defp metadata(%WorkPackage{} = work_package) do
    [
      "- Repo: #{source_inline(work_package.repo)}",
      "- Base branch: #{source_inline(work_package.base_branch)}",
      branch_line(work_package.branch_pattern),
      parent_line(work_package.parent_id),
      "- Kind: #{source_inline(work_package.kind)}"
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.join("\n")
    |> then(&"## Work package metadata\n\n#{&1}")
  end

  defp branch_line(nil), do: nil
  defp branch_line(""), do: nil
  defp branch_line(branch_pattern), do: "- Branch pattern: #{source_inline(branch_pattern)}"

  defp parent_line(nil), do: nil
  defp parent_line(""), do: nil
  defp parent_line(parent_id), do: "- Parent: #{source_inline(parent_id)}"

  defp capped_head_items(items, limit) do
    item_count = length(items)
    omitted_count = max(item_count - limit, 0)

    {Enum.take(items, limit), omitted_count}
  end

  defp maybe_append_omission(lines, 0, _label), do: lines
  defp maybe_append_omission(lines, omitted_count, label), do: lines ++ ["- [#{omitted_count} #{label} truncated]"]

  defp bounded_description(sections) do
    sections
    |> Enum.reduce_while("", fn section, acc ->
      candidate = join_sections(acc, section)

      if String.length(candidate) <= @description_limit do
        {:cont, candidate}
      else
        {:halt, append_truncation_notice(acc)}
      end
    end)
  end

  defp join_sections("", section), do: section
  defp join_sections(acc, section), do: acc <> "\n\n" <> section

  defp append_truncation_notice(""), do: @truncated_notice
  defp append_truncation_notice(markdown), do: markdown <> "\n\n" <> @truncated_notice

  defp source_inline(value, limit \\ @inline_text_limit) do
    value =
      value
      |> inline_text()
      |> bound_inline_text(limit)

    delimiter = backtick_delimiter(value)

    delimiter <> " " <> value <> " " <> delimiter
  end

  defp inline_text(value) do
    value
    |> to_string()
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
  end

  defp source_block(value) do
    value = value |> to_string() |> bound_external_text()
    fence = backtick_delimiter(value, 3)

    fence <> "\n" <> value <> "\n" <> fence
  end

  defp bound_external_text(value, limit \\ @external_text_limit) do
    if String.length(value) <= limit do
      value
    else
      String.slice(value, 0, limit) <> "\n" <> @truncated_notice
    end
  end

  defp bound_inline_text(value, limit) do
    if String.length(value) <= limit do
      value
    else
      String.slice(value, 0, limit) <> " [truncated]"
    end
  end

  defp backtick_delimiter(value, minimum_length \\ 1) do
    longest_run =
      ~r/`+/
      |> Regex.scan(value)
      |> Enum.map(fn [match] -> String.length(match) end)
      |> Enum.max(fn -> 0 end)

    String.duplicate("`", max(longest_run + 1, minimum_length))
  end

  defp labels(%WorkPackage{} = work_package) do
    [
      label("kind", work_package.kind),
      label("repo", work_package.repo),
      label("base", work_package.base_branch),
      label("parent", work_package.parent_id)
    ]
    |> Enum.reject(&is_nil/1)
  end

  defp label(_name, nil), do: nil
  defp label(_name, ""), do: nil

  defp label(name, value) do
    value =
      value
      |> inline_text()
      |> bound_inline_text(@inline_text_limit)

    if value == "" do
      nil
    else
      "#{name}:#{value}"
    end
  end

  defp dispatchable_work_package?(%WorkPackage{} = work_package, filters) do
    dispatchable_kind?(work_package) and matches_dispatch_filters?(work_package, filters)
  end

  defp dispatchable_kind?(%WorkPackage{kind: kind}), do: StateMachine.supported_kind?(kind)

  defp matches_dispatch_filters?(%WorkPackage{}, nil), do: true

  defp matches_dispatch_filters?(%WorkPackage{} = work_package, filters) do
    dispatch_filter_match?(filters.repos, work_package.repo) and
      dispatch_filter_match?(filters.base_branches, work_package.base_branch) and
      dispatch_filter_match?(filters.work_kinds, work_package.kind)
  end

  defp matches_issue_dispatch_filters?(%Issue{}, nil), do: true

  defp matches_issue_dispatch_filters?(%Issue{} = issue, filters) do
    dispatch_filter_match?(filters.repos, issue_label_value(issue, "repo")) and
      dispatch_filter_match?(filters.base_branches, issue_label_value(issue, "base")) and
      dispatch_filter_match?(filters.work_kinds, issue_label_value(issue, "kind"))
  end

  defp dispatch_filter_match?([], _value), do: true
  defp dispatch_filter_match?(nil, _value), do: true

  defp dispatch_filter_match?(allowed_values, value) when is_list(allowed_values) and is_binary(value) do
    String.trim(value) in allowed_values
  end

  defp dispatch_filter_match?(_allowed_values, _value), do: false

  defp issue_label_value(%Issue{labels: labels}, name) when is_list(labels) and is_binary(name) do
    prefix = name <> ":"

    Enum.find_value(labels, fn
      label when is_binary(label) ->
        if String.starts_with?(label, prefix) do
          String.trim(String.replace_prefix(label, prefix, ""))
        end

      _label ->
        nil
    end)
  end

  defp issue_label_value(_issue, _name), do: nil

  defp issue_assignee_id(%WorkPackage{}, {:ok, %AccessGrant{claimed_by: claimed_by}}) when is_binary(claimed_by) do
    claimed_by
  end

  defp issue_assignee_id(%WorkPackage{owner_id: owner_id}, _worker_assignment), do: owner_id

  defp worker_assignment(work_package, nil), do: worker_assignment(work_package)

  defp worker_assignment(%WorkPackage{id: work_package_id, status: status}, worker_grants_by_work_package_id) do
    if worker_dispatchable_status?(status) and is_binary(configured_assignee_id()) do
      case Map.get(worker_grants_by_work_package_id, work_package_id, []) do
        [grant | _grants] -> {:ok, grant}
        [] -> :none
      end
    else
      :none
    end
  end

  defp worker_assignment(%WorkPackage{id: work_package_id, status: status}) do
    if worker_dispatchable_status?(status) and is_binary(configured_assignee_id()) do
      case claimed_worker_grants(work_package_id) do
        {:ok, [grant | _grants]} -> {:ok, grant}
        _ -> :none
      end
    else
      :none
    end
  end

  defp worker_assignment(_work_package), do: :none

  defp worker_dispatchable_status?(status) do
    status
    |> TrackerStates.canonical_state_name()
    |> then(&(&1 in TrackerStates.worker_dispatchable_state_names()))
  end

  defp configured_assignee_id do
    Config.settings!().tracker.assignee
    |> normalize_owner_id()
  end

  defp normalize_owner_id(owner_id) when is_binary(owner_id) do
    owner_id
    |> String.trim()
    |> case do
      "" -> nil
      trimmed -> String.downcase(trimmed)
    end
  end

  defp normalize_owner_id(_owner_id), do: nil

  defp comment_summary(body) do
    body
    |> String.split("\n")
    |> Enum.map(&String.trim/1)
    |> Enum.find(&(&1 != ""))
    |> case do
      nil -> "Tracker comment"
      summary -> String.slice(summary, 0, 160)
    end
  end

  defp claimed_comment_grant(work_package_id) do
    case claimed_worker_grants(work_package_id) do
      {:ok, [grant]} -> {:ok, grant}
      {:ok, []} -> claimed_single_grant(work_package_id)
      {:ok, _grants} -> {:error, :ambiguous_actor_scope}
      {:error, reason} -> {:error, reason}
    end
  end

  defp claimed_single_grant(work_package_id) do
    case claimed_grants(work_package_id) do
      {:ok, [grant]} -> {:ok, grant}
      {:ok, []} -> {:error, :actor_scope_mismatch}
      {:ok, _grants} -> {:error, :ambiguous_actor_scope}
      {:error, reason} -> {:error, reason}
    end
  end

  defp claimed_transition_grants(%WorkPackage{} = work_package, next_status) do
    with {:ok, grants} <- claimed_grants(work_package.id) do
      grants
      |> transition_candidate_grants(work_package, next_status)
      |> Enum.group_by(& &1.grant_role)
      |> disambiguate_transition_grants()
    end
  end

  defp transition_candidate_grants(grants, %WorkPackage{} = work_package, next_status) do
    case Enum.filter(grants, &transition_grant_valid?(work_package, next_status, &1)) do
      [] -> grants
      candidate_grants -> candidate_grants
    end
  end

  defp transition_grant_valid?(%WorkPackage{} = work_package, next_status, %AccessGrant{} = grant) do
    StateMachine.validate_transition(work_package, next_status, assignment_from_grant(grant)) == :ok
  end

  defp disambiguate_transition_grants(%{"worker" => [_, _ | _]}), do: {:error, :ambiguous_actor_scope}
  defp disambiguate_transition_grants(%{"architect" => [_, _ | _]}), do: {:error, :ambiguous_actor_scope}

  defp disambiguate_transition_grants(grants_by_role) do
    grants =
      [List.first(Map.get(grants_by_role, "worker", [])), List.first(Map.get(grants_by_role, "architect", []))]
      |> Enum.reject(&is_nil/1)

    if grants == [] do
      {:error, :actor_scope_mismatch}
    else
      {:ok, grants}
    end
  end

  defp claimed_worker_grants(work_package_id) do
    with {:ok, grants} <- claimed_grants(work_package_id) do
      {:ok, Enum.filter(grants, &worker_grant?/1)}
    end
  end

  defp claimed_worker_grants_by_work_package_ids([]), do: {:ok, %{}}

  defp claimed_worker_grants_by_work_package_ids(work_package_ids) when is_list(work_package_ids) do
    case configured_assignee_id() do
      nil ->
        {:ok, %{}}

      actor_id ->
        now = DateTime.utc_now(:microsecond)

        grants =
          repo().all(
            from(grant in AccessGrant,
              where: grant.work_package_id in ^work_package_ids,
              where: grant.grant_role == "worker",
              where: not is_nil(grant.claimed_at),
              where: is_nil(grant.revoked_at),
              where: is_nil(grant.expires_at) or grant.expires_at > ^now,
              order_by: [desc: grant.claimed_at, asc: grant.id]
            )
          )
          |> Enum.filter(&(normalize_owner_id(&1.claimed_by) == actor_id))
          |> Enum.group_by(& &1.work_package_id)

        {:ok, grants}
    end
  rescue
    error -> {:error, error}
  end

  defp worker_grant?(%AccessGrant{grant_role: "worker"}), do: true
  defp worker_grant?(_grant), do: false

  defp claimed_grants(work_package_id) do
    now = DateTime.utc_now(:microsecond)

    grants =
      repo().all(
        from(grant in AccessGrant,
          where: grant.work_package_id == ^work_package_id,
          where: not is_nil(grant.claimed_at),
          where: is_nil(grant.revoked_at),
          where: is_nil(grant.expires_at) or grant.expires_at > ^now,
          order_by: [desc: grant.claimed_at, asc: grant.id]
        )
      )
      |> filter_grants_for_configured_actor()

    {:ok, grants}
  rescue
    error -> {:error, error}
  end

  defp filter_grants_for_configured_actor(grants) do
    case configured_assignee_id() do
      nil -> []
      actor_id -> Enum.filter(grants, &(normalize_owner_id(&1.claimed_by) == actor_id))
    end
  end

  defp assignment_from_grant(%AccessGrant{} = grant) do
    %Assignment{
      grant_id: grant.id,
      work_package_id: grant.work_package_id,
      display_key: grant.display_key,
      grant_role: grant.grant_role,
      capabilities: grant.capabilities,
      claimed_at: grant.claimed_at,
      claimed_by: grant.claimed_by
    }
  end
end
