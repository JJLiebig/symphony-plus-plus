Code.require_file("work_packages_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.WorkPackagesPrepareFailureTest do
  use SymphonyElixir.SymphonyPlusPlus.WorkPackagesCase

  test "prepare returns sanitized git command failures", %{repo: repo} do
    non_repo_root =
      Path.join(System.tmp_dir!(), "sympp-worktree-secret-token-#{System.unique_integer([:positive])}")

    File.mkdir_p!(non_repo_root)
    on_exit(fn -> File.rm_rf(non_repo_root) end)

    sensitive_ref = "raw_secret_abcd1234"
    base_branch = "main-#{sensitive_ref}"
    branch = "feat/#{sensitive_ref}"

    assert {:ok, package} =
             Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WT-012", kind: "mcp", base_branch: base_branch))

    attrs = %{"target_repo_root" => non_repo_root, "base_branch" => base_branch, "branch" => branch}

    assert {:error, {:git_failed, status, details} = reason} =
             WorktreeLifecycle.prepare(repo, package.id, attrs, codex_home: Path.join(non_repo_root, "codex-home"))

    assert is_integer(status)
    assert details.status == status
    assert details.target_repo_root == "[REDACTED]"
    assert details.base_branch == "main-[REDACTED]"
    assert details.branch == "feat/[REDACTED]"
    assert is_binary(details.stderr)
    assert details.stderr =~ "fatal"
    refute inspect(details.git_args) =~ sensitive_ref
    refute inspect(reason) =~ "secret-token"
    refute inspect(reason) =~ sensitive_ref
  end

  test "prepare rollback deletes the local branch it created when persistence fails", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-worktree-lifecycle")
    codex_home = Path.join(fixture.root, "codex-home")

    assert {:ok, package} =
             Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WT-007", kind: "mcp", base_branch: "main"))

    assert {:error, {:worktree_record_failed, :database_busy}} =
             WorktreeLifecycle.prepare(
               UpdateFailsWorkPackageRepo,
               package.id,
               %{"repo_root" => fixture.repo_root, "base_branch" => "main", "branch" => "feat/rollback"},
               codex_home: codex_home
             )

    assert TestSupport.git_output!(fixture.repo_root, ["branch", "--list", "feat/rollback"]) == ""
  end

  test "prepare rejects existing unrecorded worktree target path", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-worktree-lifecycle")
    codex_home = Path.join(fixture.root, "codex-home")

    assert {:ok, package} =
             Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WT-004", kind: "mcp", base_branch: "main"))

    assert {:ok, prepared} =
             WorktreeLifecycle.prepare(
               repo,
               package.id,
               %{"repo_root" => fixture.repo_root, "base_branch" => "main", "branch" => "feat/collision"},
               codex_home: codex_home
             )

    assert File.dir?(prepared.worktree_path)
    assert {:ok, _cleared} = Repository.update(repo, package.id, %{worktree_path: nil})

    assert {:error, :worktree_path_exists} =
             WorktreeLifecycle.prepare(
               repo,
               package.id,
               %{"repo_root" => fixture.repo_root, "base_branch" => "main", "branch" => "feat/collision"},
               codex_home: codex_home
             )
  end
end
