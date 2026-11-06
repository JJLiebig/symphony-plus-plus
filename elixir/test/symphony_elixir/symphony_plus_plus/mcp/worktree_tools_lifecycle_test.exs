Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.WorktreeToolsLifecycleTest do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  alias SymphonyElixir.SymphonyPlusPlus.ClaimLeases.ClaimLease
  alias SymphonyElixir.SymphonyPlusPlus.ClaimLeases.Service, as: ClaimLeaseService
  alias SymphonyElixir.SymphonyPlusPlus.MCP.SessionBinding

  @moduletag :ci_slow

  test "fork checkout preparation explains recovery and keeps origin scope" do
    alias SymphonyElixir.SymphonyPlusPlus.MCP.WorktreeScope
    alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage

    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-fork-scope")
    TestSupport.git_output!(fixture.repo_root, ["remote", "set-url", "origin", "https://github.com/fork/project.git"])
    TestSupport.git_output!(fixture.repo_root, ["remote", "add", "upstream", "https://github.com/owner/project.git"])
    config = Config.default(repo_root: fixture.repo_root)
    package = %WorkPackage{repo: "owner/project"}

    for explicit_root <- [nil, fixture.repo_root] do
      assert {:tool_error, reason, details} = WorktreeScope.prepare_target_repo_root(explicit_root, package, config)
      assert reason in ["target_repo_root_scope_mismatch", "target_repo_root_required"]
      assert details["expected_repo"] == "owner/project"
      assert details["target_repo_root"] == fixture.repo_root
      assert details["recovery"] =~ "Pass target_repo_root"
      assert details["recovery"] =~ "origin"
    end

    secret = "ghp_" <> String.duplicate("x", 32)
    historical_package = %{package | repo: "https://#{secret}@github.com/owner/project.git"}
    result = WorktreeScope.prepare_target_repo_root(fixture.repo_root, historical_package, config)
    assert {:tool_error, _, redacted} = result
    refute Jason.encode!(redacted) =~ secret
    assert redacted["expected_repo"] =~ "owner/project"

    TestSupport.git_output!(fixture.repo_root, ["remote", "set-url", "origin", "https://github.com/owner/project.git"])
    assert {:ok, root} = WorktreeScope.prepare_target_repo_root(nil, package, config)
    assert root == fixture.repo_root
  end

  test "repo CI signal observes existing checkouts and caches per repo and root" do
    alias SymphonyElixir.SymphonyPlusPlus.FactoryRepos

    fixture = TestSupport.git_repo_fixture!("beta", prefix: "sympp-repo-ci")
    root = Path.join(fixture.root, "factory[ci]")
    checkout = Path.join([root, "example", "project"])
    previous = System.get_env("SYMPP_REPOS_ROOT")
    on_exit(fn -> restore_env("SYMPP_REPOS_ROOT", previous) end)
    System.put_env("SYMPP_REPOS_ROOT", root)
    File.mkdir_p!(Path.dirname(checkout))
    {_, 0} = System.cmd("git", ["clone", fixture.origin, checkout], stderr_to_stdout: true)
    {_, 0} = System.cmd("git", ["-C", checkout, "remote", "set-url", "origin", "git@github.com:example/project.git"])
    workflows = Path.join(checkout, ".github/workflows")
    File.mkdir_p!(workflows)
    File.write!(Path.join(workflows, "ci.yml"), "name: CI")

    assert %{has_ci: true} = FactoryRepos.repo_signal("example/project", now_ms: 0)
    File.rm!(Path.join(workflows, "ci.yml"))
    assert %{has_ci: true} = FactoryRepos.repo_signal("https://github.com/EXAMPLE/project.git", now_ms: 29_999)
    File.mkdir_p!(Path.join(workflows, "directory.yml"))
    File.write!(Path.join(workflows, "README.md"), "no workflows")
    assert %{has_ci: false} = FactoryRepos.repo_signal("example/project", now_ms: 30_000)
    File.write!(Path.join(workflows, "ci.yaml"), "name: CI")
    assert %{has_ci: true} = FactoryRepos.repo_signal("example/project", now_ms: 60_000)

    assert %{} == FactoryRepos.repo_signal("example/missing", now_ms: 60_000)
    refute File.exists?(Path.join(root, "missing"))
    System.put_env("SYMPP_REPOS_ROOT", Path.join(fixture.root, "other-factory"))
    assert %{} == FactoryRepos.repo_signal("example/project", now_ms: 60_001)
    System.delete_env("SYMPP_REPOS_ROOT")
    assert %{} == FactoryRepos.repo_signal("example/project", now_ms: 60_001)
  end

  test "factory clone preserves remote paths and uses factory authentication" do
    alias SymphonyElixir.SymphonyPlusPlus.FactoryRepos

    fixture = TestSupport.git_repo_fixture!("beta", prefix: "sympp-factory-ssh")
    root = Path.join(fixture.root, "factory")
    name = Path.basename(fixture.repo_root)
    peer = Path.join(fixture.root, "ssh-peer.js")
    node = System.find_executable("node")

    command = Enum.map_join([node, peer], " ", fn value -> "'" <> String.replace(value, "'", "'\"'\"'") <> "'" end)
    keys = ["SYMPP_REPOS_ROOT", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"]
    previous = Map.new(keys, &{&1, System.get_env(&1)})
    on_exit(fn -> Enum.each(previous, fn {key, value} -> restore_env(key, value) end) end)
    System.put_env("SYMPP_REPOS_ROOT", root)
    System.put_env("GIT_SSH_COMMAND", command)
    System.put_env("GIT_SSH_VARIANT", "ssh")

    for suffix <- ["", "#literal", "?literal"] do
      repo_name = name <> suffix
      remote = "deploy@git.example:team/#{repo_name}.git"

      File.write!(peer, """
      const {spawnSync} = require("node:child_process");
      if (process.argv.at(-1) !== #{Jason.encode!("git-upload-pack 'team/#{repo_name}.git'")}) process.exit(2);
      const result = spawnSync("git", ["upload-pack", #{Jason.encode!(fixture.origin)}], {stdio: "inherit"});
      process.exit(result.status ?? 1);
      """)

      assert {:ok, checkout} = FactoryRepos.resolve(remote)
      assert checkout == Path.join(root, repo_name)
      assert {origin, 0} = System.cmd("git", ["-C", checkout, "remote", "get-url", "origin"])
      assert String.trim(origin) == remote
      assert {:ok, ^checkout} = FactoryRepos.resolve(remote)
    end

    refute FactoryRepos.matches?(Path.join(root, name), "ssh://deploy@git.example/team/#{name}.git")

    for {scheme, path, suffix} <- [{"https", "/team/ü", "http"}, {"https", "/team/%2e%2e", "http-encoded"}, {"HTTPS", "/team", "http-uppercase"}] do
      remote = "#{scheme}://fixture-account-or-token@git.example#{path}/#{name}-#{suffix}.git"
      clean_remote = String.replace(remote, "fixture-account-or-token@", "")
      # Both URLs reach the disposable origin, so the regression never contacts
      # a provider. Inspect Git's stored clone argument, not get-url's rewrite.
      System.put_env("GIT_CONFIG_COUNT", "2")
      System.put_env("GIT_CONFIG_KEY_0", "url.#{fixture.origin}.insteadOf")
      System.put_env("GIT_CONFIG_VALUE_0", clean_remote)
      System.put_env("GIT_CONFIG_KEY_1", "url.#{fixture.origin}.insteadOf")
      System.put_env("GIT_CONFIG_VALUE_1", remote)
      assert {:ok, checkout} = FactoryRepos.resolve(remote)
      assert {stored_origin, 0} = System.cmd("git", ["-C", checkout, "config", "--get", "remote.origin.url"])
      assert String.trim(stored_origin) == clean_remote
    end
  end

  test "factory prefers shallow matches and refuses equally shallow checkouts" do
    alias SymphonyElixir.SymphonyPlusPlus.FactoryRepos
    fixture = TestSupport.git_repo_fixture!("beta", prefix: "sympp-factory-ambiguity")
    root = Path.join(fixture.root, "factory")
    remote = "https://github.com/example/project.git"
    previous = System.get_env("SYMPP_REPOS_ROOT")
    System.put_env("SYMPP_REPOS_ROOT", root)
    on_exit(fn -> restore_env("SYMPP_REPOS_ROOT", previous) end)

    for group <- ["one", "two", ".worktrees/ignored"] do
      path = Path.join([root, group, "project"])
      File.mkdir_p!(Path.dirname(path))
      {_, 0} = System.cmd("git", ["clone", fixture.origin, path], stderr_to_stdout: true)
      {_, 0} = System.cmd("git", ["-C", path, "remote", "set-url", "origin", remote])
    end

    assert {:error, :ambiguous_factory_repo_checkout} = FactoryRepos.resolve("example/project")
    shallow = Path.join(root, "project")
    {_, 0} = System.cmd("git", ["clone", fixture.origin, shallow], stderr_to_stdout: true)
    {_, 0} = System.cmd("git", ["-C", shallow, "remote", "set-url", "origin", remote])
    assert {:ok, ^shallow} = FactoryRepos.resolve("git@github.com:EXAMPLE/project.git")
  end

  test "factory clones missing repositories beside owner siblings and serializes resolves" do
    alias SymphonyElixir.SymphonyPlusPlus.FactoryRepos
    fixture = TestSupport.git_repo_fixture!("beta", prefix: "sympp-factory-siblings")
    root = Path.join(fixture.root, "factory")
    sibling = Path.join([root, "group", "sibling"])
    File.mkdir_p!(Path.dirname(sibling))
    {_, 0} = System.cmd("git", ["clone", fixture.origin, sibling], stderr_to_stdout: true)
    {_, 0} = System.cmd("git", ["-C", sibling, "remote", "set-url", "origin", "git@github.com:example/sibling.git"])
    peer = Path.join(fixture.root, "ssh-peer.js")

    File.write!(peer, """
    const {spawnSync} = require("node:child_process");
    const result = spawnSync("git", ["upload-pack", #{Jason.encode!(fixture.origin)}], {stdio: "inherit"});
    process.exit(result.status ?? 1);
    """)

    node = System.find_executable("node")
    command = Enum.map_join([node, peer], " ", fn value -> "'" <> String.replace(value, "'", "'\"'\"'") <> "'" end)
    keys = ["SYMPP_REPOS_ROOT", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT"]
    previous = Map.new(keys, &{&1, System.get_env(&1)})
    on_exit(fn -> Enum.each(previous, fn {key, value} -> restore_env(key, value) end) end)
    System.put_env("SYMPP_REPOS_ROOT", root)
    System.put_env("GIT_SSH_COMMAND", command)
    System.put_env("GIT_SSH_VARIANT", "ssh")
    expected = Path.join([root, "group", "missing"])
    tasks = for _ <- 1..2, do: Task.async(fn -> FactoryRepos.resolve("git@github.com:example/missing.git") end)
    assert Enum.map(tasks, &Task.await(&1, 15_000)) == [{:ok, expected}, {:ok, expected}]
    refute File.exists?(Path.join(root, "missing"))
  end

  test "nested factory checkout is reused and owns prepare, replay and cleanup", %{repo: repo} do
    alias SymphonyElixir.SymphonyPlusPlus.FactoryRepos
    alias SymphonyElixir.SymphonyPlusPlus.MCP.WorktreeScope
    alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorktreeLifecycle

    fixture = TestSupport.git_repo_fixture!("beta", prefix: "sympp-factory-repos")
    repos_root = Path.join(fixture.root, "factory")
    nested = Path.join([repos_root, "group", Path.basename(fixture.repo_root)])
    File.mkdir_p!(Path.dirname(nested))
    {_, 0} = System.cmd("git", ["-C", fixture.repo_root, "worktree", "add", "--detach", nested, "beta"], stderr_to_stdout: true)
    fixture = %{fixture | repo_root: nested}
    remote = "https://github.com/factory/#{Path.basename(fixture.repo_root)}.git"
    {_, 0} = System.cmd("git", ["-C", fixture.repo_root, "remote", "set-url", "origin", remote])
    previous = System.get_env("SYMPP_REPOS_ROOT")
    System.put_env("SYMPP_REPOS_ROOT", repos_root)

    on_exit(fn ->
      if previous, do: System.put_env("SYMPP_REPOS_ROOT", previous), else: System.delete_env("SYMPP_REPOS_ROOT")
    end)

    assert {:ok, checkout} = FactoryRepos.resolve(remote)
    assert checkout == fixture.repo_root

    name = Path.basename(checkout)
    ssh_remote = "ssh://deploy@git.example/team/#{name}.git"
    {_, 0} = System.cmd("git", ["-C", checkout, "remote", "set-url", "origin", "deploy@git.example:team/#{name}.git"])
    assert {:ok, ^checkout} = FactoryRepos.resolve("deploy@git.example:team/#{name}.git")
    refute FactoryRepos.matches?(checkout, ssh_remote)
    {_, 0} = System.cmd("git", ["-C", checkout, "remote", "set-url", "origin", ssh_remote])
    assert {:ok, ^checkout} = FactoryRepos.resolve(ssh_remote)
    refute FactoryRepos.matches?(checkout, String.replace_suffix(ssh_remote, ".git", ""))
    refute FactoryRepos.matches?(checkout, "ssh://other-user@git.example/team/#{name}.git")
    assert FactoryRepos.matches?(checkout, "ssh://deploy@git.example:22/team/#{name}.git")
    refute FactoryRepos.matches?(checkout, "ssh://deploy@git.example:443/team/#{name}.git")
    {_, 0} = System.cmd("git", ["-C", checkout, "remote", "set-url", "origin", "ssh://git@git.example/team/#{name}.git"])
    refute FactoryRepos.matches?(checkout, "ssh://git.example/team/#{name}.git")
    {_, 0} = System.cmd("git", ["-C", checkout, "remote", "set-url", "origin", "git.example:team/#{name}.git"])
    assert {:ok, ^checkout} = FactoryRepos.resolve("git.example:team/#{name}.git")
    refute FactoryRepos.matches?(checkout, "git@git.example:team/#{name}.git")
    {_, 0} = System.cmd("git", ["-C", checkout, "remote", "set-url", "origin", ssh_remote])
    assert {:error, :invalid_target_repo_root} = FactoryRepos.resolve("ssh://deploy:password@git.example/team/#{name}.git")

    http_remote = "https://alice@git.example/team/#{name}.git"
    {_, 0} = System.cmd("git", ["-C", checkout, "remote", "set-url", "origin", http_remote])
    assert FactoryRepos.matches?(checkout, "https://git.example/team/#{name}.git")
    refute FactoryRepos.matches?(checkout, "https://git.example:444/team/#{name}.git")

    for protocol <- ["http", "git"] do
      network_remote = "#{protocol}://git.example/team/#{name}.git"
      {_, 0} = System.cmd("git", ["-C", checkout, "remote", "set-url", "origin", network_remote])
      assert {:ok, ^checkout} = FactoryRepos.resolve(network_remote)
      refute FactoryRepos.matches?(checkout, "#{protocol}://git.example:443/team/#{name}.git")
    end

    {_, 0} = System.cmd("git", ["-C", checkout, "remote", "set-url", "origin", remote])
    File.mkdir_p!(Path.join(repos_root, name))
    refute FactoryRepos.matches?(checkout, String.replace(remote, "/factory/", "/other/"))
    assert {:error, :target_repo_root_scope_mismatch} = FactoryRepos.resolve(String.replace(remote, "/factory/", "/other/"))
    assert {:error, :invalid_target_repo_root} = FactoryRepos.resolve("C:\\Code\\client")
    assert {:ok, package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(repo: remote, base_branch: "beta"))
    config = Config.default(repo: repo)
    assert {:ok, ^checkout} = WorktreeScope.target_repo_root_argument("C:\\Code\\client", package, config)

    # Fetch from the disposable fixture without contacting a provider.
    {_, 0} = System.cmd("git", ["-C", checkout, "remote", "set-url", "origin", fixture.origin])
    attrs = %{"target_repo_root" => checkout, "base_branch" => "beta", "branch" => "fix/login"}
    assert {:ok, prepared} = WorktreeLifecycle.prepare(repo, package.id, attrs)
    assert Path.dirname(prepared.worktree_path) == Path.join([repos_root, ".worktrees", Path.basename(checkout)])
    assert Path.basename(prepared.worktree_path) =~ "fix-login-"
    # A later shallow duplicate must not redirect an already prepared package.
    flat = Path.join(repos_root, name)
    {_, 0} = System.cmd("git", ["clone", fixture.origin, flat], stderr_to_stdout: true)

    for path <- [flat, checkout] do
      {_, 0} = System.cmd("git", ["-C", path, "remote", "set-url", "origin", remote])
    end

    assert {:ok, ^flat} = FactoryRepos.resolve(remote)
    assert {:ok, recorded} = WorkPackageRepository.get(repo, package.id)
    assert {:ok, ^checkout} = WorktreeScope.target_repo_root_argument(nil, recorded, config)
    {_, 0} = System.cmd("git", ["-C", checkout, "remote", "set-url", "origin", fixture.origin])
    assert {:ok, replay} = WorktreeLifecycle.prepare(repo, package.id, attrs)
    assert replay.worktree_path == prepared.worktree_path
    assert {:ok, _} = WorktreeLifecycle.cleanup(repo, package.id, target_repo_root: checkout)
    refute File.exists?(prepared.worktree_path)

    long_branch = String.duplicate("component/", 40) <> "login"
    assert {:ok, long_prepared} = WorktreeLifecycle.prepare(repo, package.id, Map.put(attrs, "branch", long_branch))
    assert byte_size(Path.basename(long_prepared.worktree_path)) <= 255
    assert {branch, 0} = System.cmd("git", ["-C", long_prepared.worktree_path, "branch", "--show-current"])
    assert String.trim(branch) == long_branch
    assert {:ok, _} = WorktreeLifecycle.cleanup(repo, package.id, target_repo_root: checkout)
  end

  test "historical worktree roots and lease bindings preserve scoped cleanup and stored audit redaction", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("symphony-plus-plus/beta", prefix: "sympp-mcp-worktree")
    other_fixture = TestSupport.git_repo_fixture!("symphony-plus-plus/beta", prefix: "sympp-mcp-other-worktree")
    same_origin_repo_root = TestSupport.git_repo_with_origin_fixture!(fixture.origin, prefix: "sympp-mcp-same-origin-worktree")
    codex_home = Path.join(fixture.root, "codex-home")
    config = Config.default(repo: repo, repo_root: test_repo_root())

    {anchor, session, _grant} =
      create_phase_architect_session(
        repo,
        "SYMPP-ARCHITECT-WORKTREE-LIFECYCLE",
        [
          "dispatch:work_request"
        ],
        repo: fixture.origin
      )

    work_request =
      create_work_request!(repo,
        id: "WR-MCP-WORKTREE-LIFECYCLE",
        repo: anchor.repo,
        base_branch: anchor.base_branch,
        status: "sliced"
      )

    assert {:ok, work_package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               work_request.id,
               work_request_work_package_attrs(
                 id: "WRS-MCP-WORKTREE-LIFECYCLE",
                 title: "Prepare package worktree",
                 base_branch: anchor.base_branch,
                 branch_pattern: "feat/worktree-lifecycle",
                 allowed_file_globs: ["elixir/lib/symphony_elixir/symphony_plus_plus/work_packages/**"],
                 acceptance_criteria: ["Prepare and clean worktrees."]
               )
             )

    assert {:ok, package} =
             WorkPackageRepository.create(
               repo,
               WorkPackageFactory.attrs(
                 id: "SYMPP-WORKTREE-LIFECYCLE",
                 kind: work_package.kind,
                 title: work_package.title,
                 repo: work_request.repo,
                 base_branch: work_package.base_branch,
                 branch_pattern: work_package.branch_pattern,
                 product_description: work_request.human_description,
                 allowed_file_globs: work_package.allowed_file_globs,
                 acceptance_criteria: work_package.acceptance_criteria,
                 status: "ready_for_worker"
               )
             )

    assert {:ok, approved_slice} = CanonicalWorkPackageFixtures.approve_work_package(repo, work_request.id, work_package.id, "planned")
    assert {:ok, _linked_slice} = CanonicalWorkPackageFixtures.dispatch_work_package(repo, work_request.id, approved_slice.id, "approved", package.id)

    previous_codex_home = System.get_env("CODEX_HOME")

    try do
      System.put_env("CODEX_HOME", codex_home)

      prepare_response =
        mcp_tool(
          repo,
          session,
          "prepare_work_package_worktree",
          %{
            "work_package_id" => package.id,
            "target_repo_root" => fixture.repo_root
          },
          config: config
        )

      prepare_payload = get_in(prepare_response, ["result", "structuredContent"])
      assert prepare_payload["worktree"]["status"] == "prepared"
      assert prepare_payload["work_package"]["worktree_path"] == prepare_payload["worktree"]["path"]
      assert comparable_path(prepare_payload["worktree"]["target_repo_root"]) == comparable_path(fixture.repo_root)
      assert prepare_payload["worker_launch"]["workspace_path"] == prepare_payload["worktree"]["path"]
      assert prepare_payload["worker_launch"]["instruction"] =~ "Use this worktree only"
      assert is_binary(prepare_payload["audit_event"]["id"])
      refute Map.has_key?(prepare_payload["audit_event"], "payload")
      assert File.dir?(prepare_payload["worktree"]["path"])

      assert {:ok, _foreign_root_package} =
               WorkPackageRepository.update(repo, package.id, %{worktree_target_repo_root: other_fixture.repo_root})

      stored_scope_mismatch_response =
        mcp_tool(
          repo,
          session,
          "cleanup_work_package_worktree",
          %{
            "work_package_id" => package.id
          },
          config: config
        )

      assert get_in(stored_scope_mismatch_response, ["error", "data", "reason"]) == "target_repo_root_scope_mismatch"
      assert File.dir?(prepare_payload["worktree"]["path"])
      assert {:ok, _restored_root_package} = WorkPackageRepository.update(repo, package.id, %{worktree_target_repo_root: fixture.repo_root})

      assert {:ok, cleanup_claim_lease} =
               ClaimLeaseService.claim(
                 repo,
                 package.id,
                 %{"actor_kind" => "agent", "actor_id" => "local:worktree-cleanup", "actor_display_name" => "worktree-cleanup"},
                 stale_after_ms: 60_000
               )

      cleanup_binding_id = SessionBinding.binding_id("cleanup-client", "cleanup-state")

      assert {:ok, cleanup_binding} =
               %SessionBinding{}
               |> SessionBinding.changeset(%{
                 id: cleanup_binding_id,
                 client_key_hash: SessionBinding.client_key_hash("cleanup-client"),
                 initialized: true,
                 recoverable: true,
                 claim_lease_id: cleanup_claim_lease.id,
                 work_package_id: package.id,
                 grant_role: "worker",
                 claimed_by: "worktree-cleanup",
                 last_seen_at: DateTime.utc_now(:microsecond)
               })
               |> repo.insert()

      cleanup_response =
        mcp_tool(
          repo,
          session,
          "cleanup_work_package_worktree",
          %{
            "work_package_id" => package.id
          },
          config: config
        )

      cleanup_payload = get_in(cleanup_response, ["result", "structuredContent"])
      assert cleanup_payload["worktree"]["status"] == "cleaned"
      assert cleanup_payload["audit_event"]["summary"] == "Success removing worktree. Subagent can be closed now."
      assert cleanup_payload["work_package"]["worktree_path"] == nil
      assert is_binary(cleanup_payload["audit_event"]["id"])
      refute Map.has_key?(cleanup_payload["audit_event"], "payload")
      refute File.exists?(prepare_payload["worktree"]["path"])
      assert %ClaimLease{status: "released", release_reason: "work_request_runtime_cleanup"} = repo.get!(ClaimLease, cleanup_claim_lease.id)
      refute repo.get(SessionBinding, cleanup_binding.id)

      stale_prepare_response =
        mcp_tool(
          repo,
          session,
          "prepare_work_package_worktree",
          %{
            "work_package_id" => package.id,
            "target_repo_root" => fixture.repo_root
          },
          config: config
        )

      stale_prepare_payload = get_in(stale_prepare_response, ["result", "structuredContent"])
      assert stale_prepare_payload["worktree"]["status"] == "prepared"
      assert {:ok, _legacy_package} = WorkPackageRepository.update(repo, package.id, %{worktree_target_repo_root: nil})
      File.rm_rf!(stale_prepare_payload["worktree"]["path"])

      wrong_stale_cleanup_response =
        mcp_tool(
          repo,
          session,
          "cleanup_work_package_worktree",
          %{
            "work_package_id" => package.id
          },
          config: Config.default(repo: repo, repo_root: same_origin_repo_root)
        )

      assert get_in(wrong_stale_cleanup_response, ["error", "data", "reason"]) == "target_repo_root_required"

      assert {:ok, stale_cleanup_claim_lease} =
               ClaimLeaseService.claim(
                 repo,
                 package.id,
                 %{"actor_kind" => "agent", "actor_id" => "local:stale-worktree-cleanup", "actor_display_name" => "stale-worktree-cleanup"},
                 stale_after_ms: 60_000
               )

      assert {:ok, paused_stale_cleanup_claim_lease} =
               ClaimLeaseService.pause(
                 repo,
                 stale_cleanup_claim_lease.id,
                 %{"actor_kind" => "operator", "actor_id" => "operator:pause"},
                 reason: "operator pause"
               )

      stale_cleanup_response =
        mcp_tool(
          repo,
          session,
          "cleanup_work_package_worktree",
          %{
            "work_package_id" => package.id
          },
          config: Config.default(repo: repo, repo_root: fixture.repo_root)
        )

      stale_cleanup_payload = get_in(stale_cleanup_response, ["result", "structuredContent"])
      assert stale_cleanup_payload["worktree"]["status"] == "stale_record_cleared"
      assert stale_cleanup_payload["work_package"]["worktree_path"] == nil
      assert is_binary(stale_cleanup_payload["audit_event"]["id"])
      refute Map.has_key?(stale_cleanup_payload["audit_event"], "payload")
      assert %ClaimLease{status: "paused"} = repo.get!(ClaimLease, paused_stale_cleanup_claim_lease.id)
    after
      restore_env("CODEX_HOME", previous_codex_home)
    end

    assert {:ok, cleaned_package} = WorkPackageRepository.get(repo, package.id)
    assert cleaned_package.worktree_path == nil

    events =
      repo.all(
        from(progress_event in ProgressEvent,
          where: progress_event.work_package_id == ^package.id,
          order_by: [asc: progress_event.sequence]
        )
      )

    assert %{
             "source_tool" => "prepare_work_package_worktree",
             "worktree_path" => "[REDACTED]",
             "target_repo_root" => "[REDACTED]"
           } = Enum.find(events, &(&1.payload["source_tool"] == "prepare_work_package_worktree")).payload

    assert %{
             "source_tool" => "cleanup_work_package_worktree",
             "worktree_path" => "[REDACTED]",
             "target_repo_root" => "[REDACTED]"
           } = Enum.find(events, &(&1.payload["source_tool"] == "cleanup_work_package_worktree" and &1.status == "cleaned")).payload

    assert %{
             "source_tool" => "cleanup_work_package_worktree",
             "status" => "stale_record_cleared"
           } =
             Enum.find(
               events,
               &(&1.payload["source_tool"] == "cleanup_work_package_worktree" and &1.status == "stale_record_cleared")
             ).payload
  end
end
