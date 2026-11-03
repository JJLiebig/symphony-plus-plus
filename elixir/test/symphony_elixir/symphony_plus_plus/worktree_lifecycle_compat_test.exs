defmodule SymphonyElixir.SymphonyPlusPlus.WorktreeLifecycleCompatTest do
  use SymphonyElixir.TestSupport

  @moduletag :ci_slow

  alias SymphonyElixir.PathSafety
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorktreeLifecycle
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorktreePath
  alias SymphonyElixir.TestSupport
  alias SymphonyElixir.WorkPackageFactory

  setup_all do
    database_path = WorkPackageFactory.database_path()

    start_supervised!({Repo, database: database_path, pool_size: 1})
    assert :ok = Repository.migrate(Repo)

    on_exit(fn -> File.rm(database_path) end)

    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    repo.delete_all(WorkPackage)
    :ok
  end

  test "prepare replays immediately previous managed worktree paths", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-worktree-lifecycle")
    codex_home = Path.join(fixture.root, "codex-home")
    branch = "feat/previous-prepare-replay"

    assert {:ok, package} =
             Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WT-PREVIOUS-001", kind: "mcp", base_branch: "main"))

    previous_path = previous_worktree_path(codex_home, fixture.repo_root, package.id, branch)
    File.mkdir_p!(Path.dirname(previous_path))
    TestSupport.git_output!(fixture.repo_root, ["worktree", "add", "-b", branch, previous_path, "origin/main"])

    assert {:ok, _updated} = Repository.update(repo, package.id, %{worktree_path: previous_path})

    assert {:ok, replayed} =
             WorktreeLifecycle.prepare(
               repo,
               package.id,
               %{"repo_root" => fixture.repo_root, "base_branch" => "main", "branch" => branch},
               codex_home: codex_home
             )

    assert replayed.status == "already_prepared"
    assert replayed.worktree_path == Path.expand(previous_path)
  end

  test "prepares legacy frozen origin/main contracts without rewriting them", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-worktree-legacy-base")
    codex_home = Path.join(fixture.root, "codex-home")

    assert {:ok, package} =
             Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WT-LEGACY-BASE", kind: "mcp", base_branch: "main"))

    package = repo.update!(Ecto.Changeset.change(package, base_branch: "origin/main", status: "active"))

    assert {:ok, prepared} =
             WorktreeLifecycle.prepare(
               repo,
               package.id,
               %{"repo_root" => fixture.repo_root, "base_branch" => "origin/main", "branch" => "feat/legacy-base"},
               codex_home: codex_home
             )

    assert prepared.status == "prepared"
    assert prepared.base_branch == "main"
    assert File.exists?(Path.join(prepared.worktree_path, "README.md"))
    assert repo.get!(WorkPackage, package.id).base_branch == "origin/main"
  end

  test "cleanup retries a proven Windows partial worktree removal", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-worktree-recovery")
    codex_home = Path.join(fixture.root, "codex-home")

    assert {:ok, package} =
             Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WT-RECOVERY", kind: "mcp", base_branch: "main"))

    assert {:ok, prepared} =
             WorktreeLifecycle.prepare(
               repo,
               package.id,
               %{"repo_root" => fixture.repo_root, "base_branch" => "main", "branch" => "feat/partial-remove"},
               codex_home: codex_home
             )

    fake_git = partial_remove_git(prepared.worktree_path)

    assert {:error, {:git_failed, 255, details}} =
             WorktreeLifecycle.cleanup(repo, package.id, codex_home: codex_home, git: fake_git)

    assert details.stage == "git_worktree_remove"
    assert details.rule == "durable_preflight_proof"
    assert Path.expand(details.recorded_worktree_path) == Path.expand(prepared.worktree_path)
    assert Path.expand(details.resolved_worktree_path) == Path.expand(prepared.worktree_path)
    assert File.exists?(Path.join(prepared.worktree_path, "README.md"))
    refute File.exists?(Path.join(prepared.worktree_path, ".git"))

    assert {:ok, failed_package} = Repository.get(repo, package.id)
    assert is_binary(failed_package.worktree_cleanup_proof)

    assert {:ok, recovered} =
             File.cd!(fixture.root, fn ->
               WorktreeLifecycle.cleanup(repo, package.id, codex_home: codex_home, git: fake_git)
             end)

    assert recovered.stage == "residue_removal"
    assert recovered.rule == "durable_preflight_proof"
    refute File.exists?(prepared.worktree_path)

    assert {:ok, cleaned_package} = Repository.get(repo, package.id)
    assert cleaned_package.worktree_path == nil
    assert cleaned_package.worktree_target_repo_root == nil
    assert cleaned_package.worktree_cleanup_proof == nil
  end

  test "cleanup removes residue after Git reports successful worktree removal", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-worktree-residue")
    codex_home = Path.join(fixture.root, "codex-home")

    assert {:ok, package} =
             Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WT-RESIDUE", kind: "mcp", base_branch: "main"))

    assert {:ok, prepared} =
             WorktreeLifecycle.prepare(
               repo,
               package.id,
               %{"repo_root" => fixture.repo_root, "base_branch" => "main", "branch" => "feat/residue-remove"},
               codex_home: codex_home
             )

    residue = Path.join([prepared.worktree_path, "node_modules", "residue"])
    File.mkdir_p!(residue)

    preserved_target =
      if match?({:win32, _name}, :os.type()) do
        target = Path.join(fixture.root, "broken-junction-target")
        preserved_target = Path.join(fixture.root, "preserved-junction-target")
        File.mkdir_p!(target)
        File.mkdir_p!(preserved_target)
        File.write!(Path.join(preserved_target, "sentinel"), "keep")
        junction = Path.join(residue, "broken")
        preserved_junction = Path.join(residue, "preserved")
        script = Path.join(fixture.root, "junction.ps1")
        File.write!(script, "param($Path, $Target)\nNew-Item -ItemType Junction -Path $Path -Target $Target | Out-Null\n")

        {_output, 0} =
          System.cmd("powershell.exe", ["-NoProfile", "-File", script, "-Path", junction, "-Target", target], stderr_to_stdout: true)

        {_output, 0} =
          System.cmd("powershell.exe", ["-NoProfile", "-File", script, "-Path", preserved_junction, "-Target", preserved_target], stderr_to_stdout: true)

        File.rmdir!(target)

        on_exit(fn ->
          for path <- [junction, preserved_junction], match?({:ok, %File.Stat{type: :symlink}}, File.lstat(path)), do: File.rmdir(path)
        end)

        preserved_target
      else
        File.write!(Path.join(residue, "leftover"), "ignored")
        nil
      end

    assert {:ok, cleaned} =
             WorktreeLifecycle.cleanup(repo, package.id,
               codex_home: codex_home,
               git: partial_remove_git(prepared.worktree_path, 0)
             )

    assert cleaned.status == "cleaned"
    refute File.exists?(prepared.worktree_path)
    if preserved_target, do: assert(File.read!(Path.join(preserved_target, "sentinel")) == "keep")

    assert {:ok, cleaned_package} = Repository.get(repo, package.id)
    assert cleaned_package.worktree_path == nil
    assert cleaned_package.worktree_target_repo_root == nil
    assert cleaned_package.worktree_cleanup_proof == nil
  end

  test "cleanup runs before_remove inside the worktree after persisting proof", %{repo: repo} do
    {fixture, package, prepared, opts} = prepare_hook_worktree(repo)
    marker = Path.join(fixture.root, "hook-result")

    write_workflow_file!(Workflow.workflow_file_path(),
      hook_before_remove: "cat README.md > #{TestSupport.shell_path(marker)}"
    )

    git = System.find_executable("git")

    checked_git = fn repo_root, args ->
      if args == ["worktree", "remove", "--force", prepared.worktree_path] do
        assert is_binary(repo.get!(WorkPackage, package.id).worktree_cleanup_proof)
        assert File.read!(marker) == File.read!(Path.join(prepared.worktree_path, "README.md"))
      end

      System.cmd(git, ["-C", repo_root | args], stderr_to_stdout: true)
    end

    assert {:ok, %{status: "cleaned"}} = WorktreeLifecycle.cleanup(repo, package.id, Keyword.put(opts, :git, checked_git))
    refute File.exists?(prepared.worktree_path)
  end

  test "cleanup logs before_remove failure and still removes the worktree", %{repo: repo} do
    {_fixture, package, prepared, opts} = prepare_hook_worktree(repo)
    write_workflow_file!(Workflow.workflow_file_path(), hook_before_remove: "exit 17")

    log =
      capture_log(fn ->
        assert {:ok, %{status: "cleaned"}} = WorktreeLifecycle.cleanup(repo, package.id, opts)
      end)

    assert log =~ "Workspace hook failed hook=before_remove"
    assert log =~ "status=17"
    refute File.exists?(prepared.worktree_path)
    assert repo.get!(WorkPackage, package.id).worktree_path == nil
  end

  test "cleanup logs before_remove timeout and still removes the worktree", %{repo: repo} do
    {_fixture, package, prepared, opts} = prepare_hook_worktree(repo)
    write_workflow_file!(Workflow.workflow_file_path(), hook_before_remove: "sleep 0.2", hook_timeout_ms: 10)

    log =
      capture_log(fn ->
        assert {:ok, %{status: "cleaned"}} = WorktreeLifecycle.cleanup(repo, package.id, opts)
      end)

    assert log =~ "Workspace hook timed out hook=before_remove"
    refute File.exists?(prepared.worktree_path)
    assert repo.get!(WorkPackage, package.id).worktree_path == nil
  end

  test "cleanup removes the worktree without a configured hook", %{repo: repo} do
    {_fixture, package, prepared, opts} = prepare_hook_worktree(repo)

    assert {:ok, %{status: "cleaned"}} = WorktreeLifecycle.cleanup(repo, package.id, opts)
    refute File.exists?(prepared.worktree_path)
    assert repo.get!(WorkPackage, package.id).worktree_path == nil
  end

  test "cleanup logs unavailable workflow configuration and still removes worktrees", %{repo: repo} do
    workflow_path = Workflow.workflow_file_path()
    store_running? = is_pid(Process.whereis(WorkflowStore))
    if store_running?, do: Supervisor.terminate_child(SymphonyElixir.Supervisor, WorkflowStore)

    try do
      for content <- ["---\n- invalid\n---\n", nil] do
        {fixture, package, prepared, opts} = prepare_hook_worktree(repo)
        unavailable_workflow = Path.join(fixture.root, "WORKFLOW.md")
        if content, do: File.write!(unavailable_workflow, content)
        Workflow.set_workflow_file_path(unavailable_workflow)
        assert {:error, _reason} = Config.settings()

        log =
          capture_log(fn ->
            assert {:ok, %{status: "cleaned"}} = WorktreeLifecycle.cleanup(repo, package.id, opts)
          end)

        assert log =~ "Skipping before_remove hook: workflow configuration is unavailable"
        refute File.exists?(prepared.worktree_path)
        assert repo.get!(WorkPackage, package.id).worktree_path == nil
        repo.delete!(repo.get!(WorkPackage, package.id))
      end
    after
      Workflow.set_workflow_file_path(workflow_path)
      if store_running?, do: Supervisor.restart_child(SymphonyElixir.Supervisor, WorkflowStore)
    end
  end

  test "cleanup skips before_remove when the checkout is already gone", %{repo: repo} do
    {fixture, package, prepared, opts} = prepare_hook_worktree(repo)
    marker = Path.join(fixture.root, "unexpected-hook")
    write_workflow_file!(Workflow.workflow_file_path(), hook_before_remove: "touch #{TestSupport.shell_path(marker)}")
    TestSupport.git_output!(fixture.repo_root, ["worktree", "remove", "--force", prepared.worktree_path])

    assert {:ok, %{status: "stale_record_cleared"}} = WorktreeLifecycle.cleanup(repo, package.id, opts)
    refute File.exists?(marker)
    assert repo.get!(WorkPackage, package.id).worktree_path == nil
  end

  defp prepare_hook_worktree(repo) do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-worktree-hooks")
    opts = [codex_home: Path.join(fixture.root, "codex-home")]

    assert {:ok, package} =
             Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WT-HOOK", kind: "mcp", base_branch: "main"))

    assert {:ok, prepared} =
             WorktreeLifecycle.prepare(
               repo,
               package.id,
               %{"repo_root" => fixture.repo_root, "base_branch" => "main", "branch" => "feat/cleanup-hook"},
               opts
             )

    {fixture, package, prepared, opts}
  end

  defp partial_remove_git(worktree_path, status \\ 255) do
    git = System.find_executable("git") || flunk("git executable is required")

    fn repo_root, args ->
      case args do
        ["worktree", "remove", "--force", ^worktree_path] ->
          File.rm!(Path.join(worktree_path, ".git"))
          {_output, 0} = System.cmd(git, ["-C", repo_root, "worktree", "prune"], stderr_to_stdout: true)
          {"simulated Windows partial worktree removal\n", status}

        _args ->
          System.cmd(git, ["-C", repo_root | args], stderr_to_stdout: true)
      end
    end
  end

  defp previous_worktree_path(codex_home, repo_root, package_id, branch) do
    {:ok, worktree_root} = WorktreeLifecycle.worktree_root(codex_home: codex_home)
    {:ok, repo_root} = PathSafety.canonicalize(repo_root)
    {:ok, repo_segment} = WorktreePath.previous_unique_segment(Path.basename(repo_root), repo_root)
    {:ok, package_segment} = WorktreePath.previous_unique_segment(package_id, package_id)
    {:ok, branch_segment} = WorktreePath.previous_unique_segment(branch, branch)

    Path.join([worktree_root, repo_segment, "#{package_segment}-#{branch_segment}"])
  end
end
