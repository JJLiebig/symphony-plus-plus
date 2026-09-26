Code.require_file("work_packages_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.WorkPackagesCleanupOwnershipTest do
  use SymphonyElixir.SymphonyPlusPlus.WorkPackagesCase

  test "cleanup removes disposable dirty worktrees and clears their records", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-worktree-lifecycle")
    codex_home = Path.join(fixture.root, "codex-home")

    assert {:ok, package} =
             Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WT-002", kind: "mcp", base_branch: "main"))

    assert {:ok, prepared} =
             WorktreeLifecycle.prepare(
               repo,
               package.id,
               %{"repo_root" => fixture.repo_root, "base_branch" => "main", "branch" => "feat/cleanup"},
               codex_home: codex_home
             )

    dirty_path = Path.join(prepared.worktree_path, "dirty.txt")
    File.write!(dirty_path, "dirty")

    assert {:ok, cleaned} = WorktreeLifecycle.cleanup(repo, package.id, codex_home: codex_home)
    assert cleaned.status == "cleaned"
    assert cleaned.worktree_path == prepared.worktree_path
    refute File.exists?(prepared.worktree_path)

    assert {:ok, fetched} = Repository.get(repo, package.id)
    assert fetched.worktree_path == nil
    assert fetched.worktree_target_repo_root == nil

    assert {:ok, replayed} = WorktreeLifecycle.cleanup(repo, package.id, codex_home: codex_home)
    assert replayed.status == "already_clean"

    assert {:ok, prepared_again} =
             WorktreeLifecycle.prepare(
               repo,
               package.id,
               %{"repo_root" => fixture.repo_root, "base_branch" => "main", "branch" => "feat/cleanup"},
               codex_home: codex_home
             )

    assert prepared_again.status == "prepared"
    assert File.dir?(prepared_again.worktree_path)
  end

  test "cleanup best-effort cleans private Cargo builds without wiping a shared target", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-cargo-cleanup")
    codex_home = Path.join(fixture.root, "codex-home")

    for {layout, number} <- Enum.with_index([:local, :central_private, :central_shared]) do
      assert {:ok, package} =
               Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WT-CARGO-#{number}", kind: "mcp", base_branch: "main"))

      assert {:ok, prepared} =
               WorktreeLifecycle.prepare(
                 repo,
                 package.id,
                 %{"repo_root" => fixture.repo_root, "base_branch" => "main", "branch" => "feat/cargo-cleanup-#{number}"},
                 codex_home: codex_home
               )

      File.write!(Path.join(prepared.worktree_path, "Cargo.toml"), "[workspace]\n")
      TestSupport.git_output!(prepared.worktree_path, ["add", "Cargo.toml"])
      target = if layout == :local, do: Path.join(prepared.worktree_path, "target"), else: Path.join(fixture.root, "central-target-#{layout}")
      base_target = if layout == :central_shared, do: target, else: Path.join(fixture.root, "base-target")
      build = Path.join(fixture.root, ".cargo/build/worktree-#{number}")
      base_build = Path.join(fixture.root, ".cargo/build/base")
      test_pid = self()

      cargo = fn path, [command | _args] ->
        send(test_pid, {:cargo, command, path, File.dir?(path)})

        case command do
          "metadata" ->
            {target_dir, build_dir} =
              if normalized_path(path) == normalized_path(fixture.repo_root) do
                {base_target, base_build}
              else
                {target, build}
              end

            {Jason.encode!(%{target_directory: target_dir, build_directory: build_dir}), 0}

          "clean" ->
            {"simulated Cargo failure", 101}
        end
      end

      assert {:ok, cleaned} = WorktreeLifecycle.cleanup(repo, package.id, codex_home: codex_home, cargo: cargo)
      assert cleaned.status == "cleaned"
      assert_received {:cargo, "metadata", _, true}
      assert_received {:cargo, "metadata", base_path, true}
      assert normalized_path(base_path) == normalized_path(fixture.repo_root)

      if layout == :central_shared do
        refute_received {:cargo, "clean", _, _}
      else
        assert_received {:cargo, "clean", _, true}
      end

      refute File.exists?(prepared.worktree_path)
    end
  end

  test "cleanup recovers a stale recorded path after persistence failure", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-worktree-lifecycle")
    codex_home = Path.join(fixture.root, "codex-home")

    assert {:ok, package} =
             Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WT-005", kind: "mcp", base_branch: "main"))

    assert {:ok, prepared} =
             WorktreeLifecycle.prepare(
               repo,
               package.id,
               %{"repo_root" => fixture.repo_root, "base_branch" => "main", "branch" => "feat/cleanup-persistence"},
               codex_home: codex_home
             )

    assert {:error, :database_busy} =
             WorktreeLifecycle.cleanup(UpdateFailsWorkPackageRepo, package.id,
               codex_home: codex_home,
               repo_root: fixture.repo_root
             )

    assert File.exists?(prepared.worktree_path)

    assert {:ok, fetched} = Repository.get(repo, package.id)
    assert fetched.worktree_path == prepared.worktree_path

    assert {:ok, recovered} = WorktreeLifecycle.cleanup(repo, package.id, codex_home: codex_home, repo_root: fixture.repo_root)
    assert recovered.status == "cleaned"

    assert {:ok, cleared} = Repository.get(repo, package.id)
    assert cleared.worktree_path == nil
  end
end
