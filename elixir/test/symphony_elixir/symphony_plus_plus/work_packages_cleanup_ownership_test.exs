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

  test "cleanup cleans private Cargo builds without touching external targets or shared builds", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-cargo-cleanup")
    codex_home = Path.join(fixture.root, "codex-home")
    layouts = [:local, :central_private, :shared_build]
    layouts = if TestSupport.symlink_supported?(), do: layouts ++ [:symlink_target], else: layouts

    for {layout, number} <- Enum.with_index(layouts) do
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
      local_target = Path.join(prepared.worktree_path, "target")
      shared_target = Path.join(fixture.root, "shared-target")

      if layout == :symlink_target do
        File.mkdir_p!(shared_target)
        File.ln_s!(shared_target, local_target)
      end

      target = if layout in [:local, :shared_build, :symlink_target], do: local_target, else: Path.join(fixture.root, "central-target-#{layout}")
      private_build = Path.join(fixture.root, ".cargo/build/worktree-#{number}")
      build = if layout == :shared_build, do: Path.join(fixture.root, ".cargo/build/shared"), else: private_build
      test_pid = self()

      cargo = fn path, [command | args] ->
        send(test_pid, {:cargo, command, args, path, File.dir?(path)})

        case command do
          "metadata" ->
            target_dir = if Enum.any?(args, &String.starts_with?(&1, "build.target-dir=")), do: Path.join(prepared.worktree_path, ".sympp-cargo-clean-target"), else: target
            build_dir = if Enum.any?(args, &String.starts_with?(&1, "build.build-dir=")), do: private_build, else: build
            {Jason.encode!(%{workspace_root: prepared.worktree_path, target_directory: target_dir, build_directory: build_dir}), 0}

          "clean" ->
            {"simulated Cargo failure", 101}
        end
      end

      assert {:ok, cleaned} = WorktreeLifecycle.cleanup(repo, package.id, codex_home: codex_home, cargo: cargo)
      assert cleaned.status == "cleaned"
      assert_received {:cargo, "metadata", _, _, true}

      if layout == :shared_build do
        refute_received {:cargo, "clean", _, _, _}
      else
        assert_received {:cargo, "clean", clean_args, _, true}
        assert "--target-dir" in clean_args == (layout != :local)
      end

      refute File.exists?(prepared.worktree_path)
      if layout == :symlink_target, do: assert(File.dir?(shared_target))
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
