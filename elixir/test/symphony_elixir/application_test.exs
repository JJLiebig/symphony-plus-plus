defmodule SymphonyElixir.ApplicationTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.SymphonyPlusPlus.OfflineSandbox
  alias SymphonyElixir.SymphonyPlusPlus.OperatorSettings.Repository, as: OperatorSettingsRepository
  alias SymphonyElixir.SymphonyPlusPlus.OperatorSettings.Retention
  alias SymphonyElixir.SymphonyPlusPlus.OperatorSettings.RetentionThrottle
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository, as: WorkRequestRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Service, as: WorkRequestService
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest

  test "artifact runtime archives overdue WorkRequests without dashboard visits and reloads the cutoff" do
    database = Path.join(System.tmp_dir!(), "sympp-retention-#{System.unique_integer([:positive])}.sqlite3")
    on_exit(fn -> File.rm(database) end)

    with_env("SYMPP_RUNTIME_ARTIFACT", "1", fn ->
      children = SymphonyElixir.Application.children()
      {Repo, repo_opts} = Enum.find(children, &match?({Repo, _}, &1))
      start_supervised!({Repo, Keyword.put(repo_opts, :database, database)})
      assert :ok = WorkRequestRepository.migrate(Repo)
      assert {:ok, _settings} = OperatorSettingsRepository.update(Repo, %{"work_request_archive_after_days" => 7})

      overdue = completed_work_request!("overdue", 8)
      recent = completed_work_request!("recent", 2)
      assert {:ok, active} = WorkRequestRepository.create(Repo, work_request_attrs("active"))

      {Retention, retention_opts} = Enum.find(children, &match?({Retention, _}, &1))
      start_supervised!({Retention, Keyword.put(retention_opts, :interval_ms, 20)})

      assert %DateTime{} = wait_for_archive(overdue.id)
      assert Repo.get!(WorkRequest, recent.id).archived_at == nil
      assert Repo.get!(WorkRequest, active.id).archived_at == nil

      assert {:ok, _settings} = OperatorSettingsRepository.update(Repo, %{"work_request_archive_after_days" => 1})
      assert %DateTime{} = wait_for_archive(recent.id)
      assert Repo.get!(WorkRequest, active.id).archived_at == nil
      assert {:ok, [^active]} = WorkRequestRepository.list(Repo)
      stop_supervised!(Retention)
      RetentionThrottle.reset(Repo)
    end)
  end

  test "offline application boot refuses an unmarked ledger before starting legacy services" do
    database = Path.join(System.tmp_dir!(), "sympp-offline-boot-#{System.unique_integer([:positive])}.sqlite3")
    previous_database = Application.get_env(:symphony_elixir, :sympp_repo_database)
    Application.put_env(:symphony_elixir, :sympp_repo_database, database)

    try do
      with_envs([{"SYMPP_OFFLINE_SANDBOX", "1"}, {"SYMPP_RUNTIME_ARTIFACT", nil}], fn ->
        assert_raise RuntimeError, ~r/requires a marked snapshot/, fn -> OfflineSandbox.verify!(nil) end
        assert_raise RuntimeError, ~r/requires a marked snapshot/, fn -> SymphonyElixir.Application.start(:normal, []) end
        refute File.exists?(database)
        children = SymphonyElixir.Application.children()
        refute SymphonyElixir.WorkflowStore in children
        refute SymphonyElixir.Orchestrator in children
        refute SymphonyElixir.SymphonyPlusPlus.MCP.ClientLeases in children
        refute Enum.any?(children, &match?({SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorktreeCleanupQueue, _}, &1))
        assert {Repo, Repo.child_options()} in children
        assert {Retention, repo: Repo} in children
      end)
    after
      if previous_database do
        Application.put_env(:symphony_elixir, :sympp_repo_database, previous_database)
      else
        Application.delete_env(:symphony_elixir, :sympp_repo_database)
      end
    end
  end

  defp with_env(name, value, fun) do
    with_envs([{name, value}], fun)
  end

  defp completed_work_request!(id, days_ago) do
    assert {:ok, request} = WorkRequestRepository.create(Repo, work_request_attrs(id))
    assert {:ok, completed} = WorkRequestService.force_complete(Repo, request.id)

    completed
    |> Ecto.Changeset.change(completed_at: DateTime.add(DateTime.utc_now(:microsecond), -days_ago * 86_400, :second))
    |> Repo.update!()
  end

  defp work_request_attrs(id) do
    %{
      id: id,
      title: id,
      repo: "test/retention",
      base_branch: "main",
      work_type: "hotfix",
      human_description: "Verify automatic retention.",
      desired_dispatch_shape: "single_package"
    }
  end

  defp wait_for_archive(id, attempts \\ 100) do
    case Repo.get!(WorkRequest, id).archived_at do
      nil when attempts > 0 ->
        Process.sleep(20)
        wait_for_archive(id, attempts - 1)

      archived_at ->
        archived_at
    end
  end

  defp with_envs(values, fun) do
    previous_values = Enum.map(values, fn {name, _value} -> {name, System.get_env(name)} end)

    try do
      for {name, value} <- values do
        if is_nil(value), do: System.delete_env(name), else: System.put_env(name, value)
      end

      fun.()
    after
      for {name, previous} <- previous_values do
        if is_nil(previous), do: System.delete_env(name), else: System.put_env(name, previous)
      end
    end
  end
end
