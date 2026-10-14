Code.require_file("work_packages_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.WorkPackagesCleanupForeignOwnershipTest do
  use SymphonyElixir.SymphonyPlusPlus.WorkPackagesCase

  test "cleanup rejects worktrees that belong to another repository", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-worktree-lifecycle")
    other_fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-worktree-lifecycle-other")
    codex_home = Path.join(fixture.root, "codex-home")

    assert {:ok, package} =
             Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WT-014", kind: "mcp", base_branch: "main"))

    assert {:ok, other_package} =
             Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WT-015", kind: "mcp", base_branch: "main"))

    assert {:ok, other_prepared} =
             WorktreeLifecycle.prepare(
               repo,
               other_package.id,
               %{"repo_root" => other_fixture.repo_root, "base_branch" => "main", "branch" => "feat/other-repo"},
               codex_home: codex_home
             )

    assert {:ok, _corrupted} = Repository.update(repo, package.id, %{worktree_path: other_prepared.worktree_path})

    assert {:error, :invalid_worktree_path} =
             WorktreeLifecycle.cleanup(repo, package.id, codex_home: codex_home, repo_root: fixture.repo_root)

    assert File.dir?(other_prepared.worktree_path)
    assert {:ok, recorded} = Repository.get(repo, package.id)
    assert recorded.worktree_path == other_prepared.worktree_path
  end
end
