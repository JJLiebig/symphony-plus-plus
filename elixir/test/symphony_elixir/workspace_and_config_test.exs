defmodule SymphonyElixir.WorkspaceAndConfigTest do
  use SymphonyElixir.TestSupport
  alias SymphonyElixir.Config.Schema

  test "workspace rejects symlink escapes under the configured root" do
    if symlink_supported?() do
      test_root = unique_tmp_path("symphony-elixir-workspace-symlink")

      try do
        workspace_root = Path.join(test_root, "workspaces")
        outside_root = Path.join(test_root, "outside")
        symlink_path = Path.join(workspace_root, "MT-SYM")

        File.mkdir_p!(workspace_root)
        File.mkdir_p!(outside_root)
        File.ln_s!(outside_root, symlink_path)

        write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

        assert {:ok, canonical_outside_root} = SymphonyElixir.PathSafety.canonicalize(outside_root)
        assert {:ok, canonical_workspace_root} = SymphonyElixir.PathSafety.canonicalize(workspace_root)

        assert {:error, {:workspace_outside_root, ^canonical_outside_root, ^canonical_workspace_root}} =
                 Workspace.create_for_issue("MT-SYM")
      after
        File.rm_rf(test_root)
      end
    end
  end

  test "workspace canonicalizes symlinked workspace roots before creating issue directories" do
    if symlink_supported?() do
      test_root = unique_tmp_path("symphony-elixir-workspace-root-symlink")

      try do
        actual_root = Path.join(test_root, "actual-workspaces")
        linked_root = Path.join(test_root, "linked-workspaces")

        File.mkdir_p!(actual_root)
        File.ln_s!(actual_root, linked_root)

        write_workflow_file!(Workflow.workflow_file_path(), workspace_root: linked_root)

        assert {:ok, canonical_workspace} =
                 SymphonyElixir.PathSafety.canonicalize(Path.join(actual_root, "MT-LINK"))

        assert {:ok, workspace} = Workspace.create_for_issue("MT-LINK")
        assert workspace == canonical_workspace
        assert File.dir?(workspace)
      after
        File.rm_rf(test_root)
      end
    end
  end

  test "workspace remove rejects the workspace root itself with a distinct error" do
    workspace_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-workspace-root-remove-#{System.unique_integer([:positive])}"
      )

    try do
      File.mkdir_p!(workspace_root)
      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

      assert {:ok, canonical_workspace_root} =
               SymphonyElixir.PathSafety.canonicalize(workspace_root)

      assert {:error, {:workspace_equals_root, ^canonical_workspace_root, ^canonical_workspace_root}, ""} =
               Workspace.remove(workspace_root)
    after
      File.rm_rf(workspace_root)
    end
  end

  test "workspace surfaces after_create hook timeouts" do
    workspace_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-workspace-hook-timeout-#{System.os_time(:nanosecond)}"
      )

    try do
      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_timeout_ms: 10,
        hook_after_create: "sleep 0.05"
      )

      assert {:error, {:workspace_hook_timeout, "after_create", 10}} =
               Workspace.create_for_issue("MT-TIMEOUT")

      assert {:error, {:workspace_hook_timeout, "after_create", 10}} =
               Workspace.create_for_issue("MT-TIMEOUT")
    after
      File.rm_rf(workspace_root)
    end
  end

  test "workspace does not rerun after_create hook while one is in flight" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-workspace-hook-in-flight-#{System.os_time(:nanosecond)}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")
      counter = Path.join(test_root, "after_create.count")
      gate = Path.join(test_root, "after_create.release")

      File.mkdir_p!(test_root)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_timeout_ms: 5_000,
        hook_after_create: "echo call >> #{shell_path(counter)}\nwhile [ ! -f #{shell_path(gate)} ]; do sleep 0.05; done"
      )

      task = Task.async(fn -> Workspace.create_for_issue("MT-CONCURRENT") end)
      assert_eventually(fn -> File.exists?(counter) end)

      workspace = Path.join(workspace_root, "MT-CONCURRENT")
      assert {:ok, canonical_workspace} = SymphonyElixir.PathSafety.canonicalize(workspace)
      assert {:ok, ^canonical_workspace} = Workspace.create_for_issue("MT-CONCURRENT")

      File.write!(gate, "go")
      assert {:ok, ^canonical_workspace} = Task.await(task, 5_000)

      assert File.read!(counter) |> String.trim() |> String.split("\n") |> length() == 1
    after
      File.rm_rf(test_root)
    end
  end

  test "workspace failed after_create retry is claimed once" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-workspace-hook-retry-claim-#{System.os_time(:nanosecond)}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")
      counter = Path.join(test_root, "after_create.count")
      block_retry = Path.join(test_root, "block_retry")
      gate = Path.join(test_root, "after_create.release")

      File.mkdir_p!(test_root)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_timeout_ms: 5_000,
        hook_after_create: "echo call >> #{shell_path(counter)}\nif [ -f #{shell_path(block_retry)} ]; then while [ ! -f #{shell_path(gate)} ]; do sleep 0.05; done; fi\nexit 17"
      )

      assert {:error, {:workspace_hook_failed, "after_create", 17, _output}} =
               Workspace.create_for_issue("MT-RETRY-CLAIM")

      File.write!(block_retry, "block")

      first_retry = Task.async(fn -> Workspace.create_for_issue("MT-RETRY-CLAIM") end)
      assert_eventually(fn -> after_create_call_count(counter) == 2 end)
      second_retry = Task.async(fn -> Workspace.create_for_issue("MT-RETRY-CLAIM") end)

      workspace = Path.join(workspace_root, "MT-RETRY-CLAIM")
      assert {:ok, canonical_workspace} = SymphonyElixir.PathSafety.canonicalize(workspace)
      assert {:ok, ^canonical_workspace} = Task.await(second_retry, 5_000)

      File.write!(gate, "go")

      assert {:error, {:workspace_hook_failed, "after_create", 17, _output}} =
               Task.await(first_retry, 5_000)

      assert after_create_call_count(counter) == 2
    after
      File.rm_rf(test_root)
    end
  end

  test "dispatch revalidation skips stale todo issue once a non-terminal blocker appears" do
    stale_issue = %Issue{
      id: "blocked-2",
      identifier: "MT-1005",
      title: "Stale blocked work",
      state: "Todo",
      blocked_by: []
    }

    refreshed_issue = %Issue{
      id: "blocked-2",
      identifier: "MT-1005",
      title: "Stale blocked work",
      state: "Todo",
      blocked_by: [%{id: "blocker-3", identifier: "MT-1006", state: "In Progress"}]
    }

    fetcher = fn ["blocked-2"] -> {:ok, [refreshed_issue]} end

    assert {:skip, %Issue{} = skipped_issue} =
             Orchestrator.revalidate_issue_for_dispatch_for_test(stale_issue, fetcher)

    assert skipped_issue.identifier == "MT-1005"
    assert skipped_issue.blocked_by == [%{id: "blocker-3", identifier: "MT-1006", state: "In Progress"}]
  end

  test "workspace remove continues when before_remove hook fails with large output" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-workspace-hooks-large-fail-#{System.unique_integer([:positive])}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")

      File.mkdir_p!(workspace_root)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_before_remove: "i=0; while [ $i -lt 3000 ]; do printf a; i=$((i+1)); done; exit 17"
      )

      assert {:ok, workspace} = Workspace.create_for_issue("MT-HOOKS-LARGE-FAIL")
      assert :ok = Workspace.remove_issue_workspaces("MT-HOOKS-LARGE-FAIL")
      refute File.exists?(workspace)
    after
      File.rm_rf(test_root)
    end
  end

  test "workspace remove continues when before_remove hook times out" do
    previous_timeout = Application.get_env(:symphony_elixir, :workspace_hook_timeout_ms)

    on_exit(fn ->
      if is_nil(previous_timeout) do
        Application.delete_env(:symphony_elixir, :workspace_hook_timeout_ms)
      else
        Application.put_env(:symphony_elixir, :workspace_hook_timeout_ms, previous_timeout)
      end
    end)

    Application.put_env(:symphony_elixir, :workspace_hook_timeout_ms, 10)

    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-workspace-hooks-timeout-#{System.unique_integer([:positive])}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")

      File.mkdir_p!(workspace_root)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        hook_before_remove: "sleep 0.05"
      )

      assert {:ok, workspace} = Workspace.create_for_issue("MT-HOOKS-TIMEOUT")
      assert :ok = Workspace.remove_issue_workspaces("MT-HOOKS-TIMEOUT")
      refute File.exists?(workspace)
    after
      File.rm_rf(test_root)
    end
  end

  test "schema keeps workspace roots raw while sandbox helpers expand only for local use" do
    assert {:ok, settings} =
             Schema.parse(%{
               workspace: %{root: "~/.symphony-workspaces"},
               codex: %{}
             })

    assert settings.workspace.root == "~/.symphony-workspaces"

    assert Schema.resolve_turn_sandbox_policy(settings) == %{
             "type" => "workspaceWrite",
             "writableRoots" => [Path.expand("~/.symphony-workspaces")],
             "readOnlyAccess" => %{"type" => "fullAccess"},
             "networkAccess" => false,
             "excludeTmpdirEnvVar" => false,
             "excludeSlashTmp" => false
           }

    assert {:ok, remote_policy} =
             Schema.resolve_runtime_turn_sandbox_policy(settings, nil, remote: true)

    assert remote_policy == %{
             "type" => "workspaceWrite",
             "writableRoots" => ["~/.symphony-workspaces"],
             "readOnlyAccess" => %{"type" => "fullAccess"},
             "networkAccess" => false,
             "excludeTmpdirEnvVar" => false,
             "excludeSlashTmp" => false
           }
  end

  test "path safety returns errors for invalid path segments" do
    invalid_segment = String.duplicate("a", 300)
    path = Path.join(System.tmp_dir!(), invalid_segment)
    expanded_path = Path.expand(path)

    assert {:error, {:path_canonicalize_failed, ^expanded_path, :enametoolong}} =
             SymphonyElixir.PathSafety.canonicalize(path)
  end

  test "path safety does not reject valid Windows unicode segments by byte length" do
    if match?({:win32, _}, :os.type()) do
      unicode_segment = String.duplicate("ü", 200)
      path = Path.join(System.tmp_dir!(), unicode_segment)
      expanded_path = Path.expand(path)

      assert {:ok, ^expanded_path} = SymphonyElixir.PathSafety.canonicalize(path)
    end
  end

  test "path safety rejects Windows segments beyond UTF-16 code unit limits" do
    if match?({:win32, _}, :os.type()) do
      invalid_segment = String.duplicate("😀", 200)
      path = Path.join(System.tmp_dir!(), invalid_segment)
      expanded_path = Path.expand(path)

      assert {:error, {:path_canonicalize_failed, ^expanded_path, :enametoolong}} =
               SymphonyElixir.PathSafety.canonicalize(path)
    end
  end

  test "remote workspace lifecycle uses ssh host aliases from worker config" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-remote-workspace-#{System.unique_integer([:positive])}"
      )

    previous_path = System.get_env("PATH")
    previous_trace = System.get_env("SYMP_TEST_SSH_TRACE")

    on_exit(fn ->
      restore_env("PATH", previous_path)
      restore_env("SYMP_TEST_SSH_TRACE", previous_trace)
    end)

    try do
      trace_file = Path.join(test_root, "ssh.trace")
      fake_ssh = fake_ssh_path(test_root)
      workspace_root = "~/.symphony-remote-workspaces"
      workspace_path = "/remote/home/.symphony-remote-workspaces/MT-SSH-WS"

      File.mkdir_p!(test_root)
      System.put_env("SYMP_TEST_SSH_TRACE", trace_file)
      System.put_env("PATH", path_with_prepended(test_root, previous_path))

      write_remote_workspace_fake_ssh!(fake_ssh, workspace_path)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        worker_ssh_hosts: ["worker-01:2200"],
        hook_before_run: "echo before-run",
        hook_after_run: "echo after-run",
        hook_before_remove: "echo before-remove"
      )

      assert Config.settings!().worker.ssh_hosts == ["worker-01:2200"]
      assert Config.settings!().workspace.root == workspace_root
      assert {:ok, ^workspace_path} = Workspace.create_for_issue("MT-SSH-WS", "worker-01:2200")
      assert :ok = Workspace.run_before_run_hook(workspace_path, "MT-SSH-WS", "worker-01:2200")
      assert :ok = Workspace.run_after_run_hook(workspace_path, "MT-SSH-WS", "worker-01:2200")
      assert :ok = Workspace.remove_issue_workspaces("MT-SSH-WS", "worker-01:2200")

      trace = File.read!(trace_file)
      assert trace =~ "-p 2200 worker-01"
      assert trace =~ "bash -lc"
      assert trace =~ "__SYMPHONY_WORKSPACE__"
      assert trace =~ "~/.symphony-remote-workspaces/MT-SSH-WS"
      assert trace =~ workspace_path

      unless match?({:win32, _}, :os.type()) do
        assert trace =~ "${workspace#~/}"
        assert trace =~ "echo before-run"
        assert trace =~ "echo after-run"
        assert trace =~ "echo before-remove"
        assert trace =~ "rm -rf"
      end
    after
      File.rm_rf(test_root)
    end
  end

  defp assert_eventually(fun, attempts_remaining \\ 100)

  defp assert_eventually(_fun, 0), do: flunk("condition was not met before timeout")

  defp assert_eventually(fun, attempts_remaining) when is_function(fun, 0) do
    if fun.() do
      :ok
    else
      Process.sleep(20)
      assert_eventually(fun, attempts_remaining - 1)
    end
  end

  defp after_create_call_count(path) do
    if File.exists?(path) do
      path
      |> File.read!()
      |> String.trim()
      |> String.split("\n", trim: true)
      |> length()
    else
      0
    end
  end

  defp fake_ssh_path(root) do
    if match?({:win32, _}, :os.type()), do: Path.join(root, "ssh.cmd"), else: Path.join(root, "ssh")
  end

  defp write_remote_workspace_fake_ssh!(path, workspace_path) do
    if match?({:win32, _}, :os.type()) do
      File.write!(path, """
      @echo off
      setlocal EnableDelayedExpansion
      set "ARGS=%*"
      echo ARGV:!ARGS!>>"%SYMP_TEST_SSH_TRACE%"
      echo __SYMPHONY_WORKSPACE__>>"%SYMP_TEST_SSH_TRACE%"
      echo #{workspace_path}>>"%SYMP_TEST_SSH_TRACE%"
      echo __SYMPHONY_WORKSPACE__	1	#{workspace_path}
      exit /b 0
      """)
    else
      File.write!(path, """
      #!/bin/sh
      trace_file="${SYMP_TEST_SSH_TRACE:-/tmp/symphony-fake-ssh.trace}"
      printf 'ARGV:%s\\n' "$*" >> "$trace_file"

      case "$*" in
        *"__SYMPHONY_WORKSPACE__"*)
          printf '%s\\t%s\\t%s\\n' '__SYMPHONY_WORKSPACE__' '1' '#{workspace_path}'
          ;;
      esac

      exit 0
      """)

      File.chmod!(path, 0o755)
    end
  end
end
