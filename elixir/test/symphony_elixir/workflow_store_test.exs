defmodule SymphonyElixir.WorkflowStoreTest do
  use SymphonyElixir.TestSupport

  test "unverified matching metadata still reads contents to catch same-size edits" do
    path = Workflow.workflow_file_path()
    unresolved_second = System.system_time(:second) + 60

    unresolved_stat = fn _path, _opts ->
      {:ok, %{mtime: unresolved_second, ctime: unresolved_second, size: 1, time_unit: :posix}}
    end

    with_isolated_workflow_store(tracked_file_ops(self(), stat: unresolved_stat), fn ->
      drain_workflow_store_messages()

      File.write!(path, "Same-size metadata edit\n")
      send(WorkflowStore, :poll)

      assert_receive {:workflow_store_read, ^path}, 1_000

      assert_eventually(fn ->
        :sys.get_state(WorkflowStore).workflow.prompt == "Same-size metadata edit"
      end)
    end)
  end

  test "current POSIX ctime keeps matching metadata unverified" do
    path = Workflow.workflow_file_path()
    current_second = System.system_time(:second)

    current_ctime_stat = fn _path, _opts ->
      {:ok, %{mtime: current_second - 10, ctime: current_second, size: 1, time_unit: :posix}}
    end

    with_isolated_workflow_store(tracked_file_ops(self(), stat: current_ctime_stat), fn ->
      drain_workflow_store_messages()

      send(WorkflowStore, :poll)
      assert_receive {:workflow_store_read, ^path}, 1_000
      drain_workflow_store_messages()

      send(WorkflowStore, :poll)
      assert_receive {:workflow_store_read, ^path}, 1_000
    end)
  end

  test "force reload reads current workflow even when metadata is unchanged" do
    path = Workflow.workflow_file_path()

    constant_stat = fn _path, _opts ->
      {:ok, %{mtime: 1, ctime: 1, size: 1, time_unit: :constant}}
    end

    with_isolated_workflow_store(tracked_file_ops(self(), stat: constant_stat), fn ->
      drain_workflow_store_messages()

      File.write!(path, "Explicit reload prompt\n")

      assert :ok = WorkflowStore.force_reload()
      assert_receive {:workflow_store_read, ^path}, 1_000
      assert :sys.get_state(WorkflowStore).workflow.prompt == "Explicit reload prompt"
    end)
  end

  defp with_isolated_workflow_store(file_ops, fun) do
    previous_pid = Process.whereis(WorkflowStore)
    workflow_path = Workflow.workflow_file_path()
    original_workflow = File.read(workflow_path)

    if is_pid(previous_pid) do
      :ok = Supervisor.terminate_child(SymphonyElixir.Supervisor, WorkflowStore)
    end

    {:ok, pid} = WorkflowStore.start_link(poll_interval_ms: 60_000, file_ops: file_ops)

    try do
      fun.()
    after
      if Process.alive?(pid), do: GenServer.stop(pid)
      assert_eventually(fn -> is_nil(Process.whereis(WorkflowStore)) end)

      case original_workflow do
        {:ok, content} -> File.write!(workflow_path, content)
        {:error, _reason} -> File.rm(workflow_path)
      end

      if is_pid(previous_pid) do
        {:ok, _pid} = Supervisor.restart_child(SymphonyElixir.Supervisor, WorkflowStore)
      end
    end
  end

  defp tracked_file_ops(owner, opts \\ []) do
    stat_fun = Keyword.get(opts, :stat, &File.stat/2)

    %{
      read: fn path ->
        send(owner, {:workflow_store_read, path})
        File.read(path)
      end,
      stat: fn path, opts ->
        send(owner, {:workflow_store_stat, path, opts})
        stat_fun.(path, opts)
      end
    }
  end

  defp drain_workflow_store_messages do
    receive do
      {:workflow_store_read, _path} -> drain_workflow_store_messages()
      {:workflow_store_stat, _path, _opts} -> drain_workflow_store_messages()
    after
      0 -> :ok
    end
  end

  defp assert_eventually(fun, attempts \\ 20)

  defp assert_eventually(fun, attempts) when attempts > 0 do
    if fun.() do
      true
    else
      Process.sleep(25)
      assert_eventually(fun, attempts - 1)
    end
  end

  defp assert_eventually(_fun, 0), do: flunk("condition not met in time")
end
