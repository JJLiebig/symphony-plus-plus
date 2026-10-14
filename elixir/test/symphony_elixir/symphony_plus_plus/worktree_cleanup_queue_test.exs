defmodule SymphonyElixir.SymphonyPlusPlus.WorktreeCleanupQueueTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorktreeCleanupQueue
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorktreeCleanupQueue.Entry
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorktreeLifecycle
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository, as: WorkRequestRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Service, as: WorkRequestService
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest
  alias SymphonyElixir.TestSupport
  alias SymphonyElixir.WorkPackageFactory

  setup_all do
    database_path = WorkPackageFactory.database_path()
    start_supervised!({Repo, database: database_path, pool_size: 1})
    assert :ok = WorkPackageRepository.migrate(Repo)
    on_exit(fn -> File.rm(database_path) end)
    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    repo.delete_all(Entry)
    repo.delete_all(WorkPackage)
    repo.delete_all(WorkRequest)
    :ok
  end

  test "transient filesystem obstruction stays queued and clears after recovery", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-cleanup-queue-retry")
    codex_home = use_codex_home!(fixture.root)
    package = prepared_package!(repo, fixture.repo_root, codex_home, "WP-CLEANUP-RETRY", "fix/cleanup-retry")

    assert {:ok, _terminal} = WorkPackageRepository.update_status(repo, package.id, "created", "merged")
    assert [%Entry{attempts: 0}] = repo.all(Entry)

    unavailable_root = fixture.repo_root <> "-unavailable"
    File.rename!(fixture.repo_root, unavailable_root)

    assert :ok = WorktreeCleanupQueue.reconcile(repo, codex_home: codex_home, base_backoff_ms: 1, max_backoff_ms: 1)
    assert [%Entry{attempts: 1}] = repo.all(Entry)
    assert File.dir?(package.worktree_path)

    File.rename!(unavailable_root, fixture.repo_root)
    Process.sleep(5)

    assert :ok = WorktreeCleanupQueue.reconcile(repo, codex_home: codex_home, base_backoff_ms: 1, max_backoff_ms: 1)
    assert repo.all(Entry) == []
    refute File.exists?(package.worktree_path)
    assert repo.get!(WorkPackage, package.id).worktree_path == nil
  end

  test "supervised startup resumes an archived request cleanup", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-cleanup-queue-startup")
    codex_home = use_codex_home!(fixture.root)
    {request, package} = prepared_linked_package!(repo, fixture.repo_root, codex_home, "WR-CLEANUP-STARTUP", "fix/cleanup-startup")

    repo.update!(Ecto.Changeset.change(package, status: "merged"))

    assert {:ok, _delivery} =
             WorkRequestRepository.record_work_package_delivery(repo, request.id, package.id, %{
               outcome: "completed_no_pr",
               idempotency_key: "cleanup-startup-delivered",
               no_pr_evidence: "Completed work resumes queued cleanup after archive."
             })

    assert {:ok, _archived} = WorkRequestService.archive(repo, request.id)
    assert [%Entry{}] = repo.all(Entry)

    name = Module.concat(__MODULE__, StartupReconciler)

    reconciler_opts =
      [repo: repo, name: name, cleanup_opts: [codex_home: codex_home], base_backoff_ms: 1]

    start_supervised!({WorktreeCleanupQueue, reconciler_opts})

    assert_eventually(fn ->
      assert repo.all(Entry) == []
      refute File.exists?(package.worktree_path)
    end)
  end

  test "request deletion keeps cleanup after the owning rows are gone", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-cleanup-queue-delete")
    codex_home = use_codex_home!(fixture.root)
    {request, package} = prepared_linked_package!(repo, fixture.repo_root, codex_home, "WR-CLEANUP-DELETE", "fix/cleanup-delete")

    assert {:ok, deleted_id} = WorkRequestService.delete(repo, request.id)
    assert deleted_id == request.id
    assert repo.get(WorkRequest, request.id) == nil
    assert repo.get(WorkPackage, package.id) == nil
    assert [%Entry{work_package_id: package_id}] = repo.all(Entry)
    assert package_id == package.id

    assert :ok = WorktreeCleanupQueue.reconcile(repo, codex_home: codex_home)
    assert repo.all(Entry) == []
    refute File.exists?(package.worktree_path)
  end

  test "never-started archive, refresh and later retention leave a prepared worktree and history intact", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-never-started-cleanup")
    codex_home = use_codex_home!(fixture.root)
    {request, package} = prepared_linked_package!(repo, fixture.repo_root, codex_home, "WR-NEVER-CLEANUP", "fix/never-started")
    repo.update!(Ecto.Changeset.change(package, status: "skipped"))
    now = DateTime.utc_now(:microsecond)
    repo.update!(Ecto.Changeset.change(request, inserted_at: DateTime.add(now, -90, :day)))

    assert {:ok, %{archived_ids: [id]}} = WorkRequestService.retention_pass(repo, now: now, delete_after_days: 1)
    assert id == request.id
    assert {:ok, archived} = WorkRequestService.refresh_completion(repo, id)
    assert archived.completed_at == nil
    assert archived.archive_reason == "never_started"

    assert {:ok, %{deleted_ids: []}} = WorkRequestService.retention_pass(repo, now: DateTime.add(now, 100, :day), delete_after_days: 1)
    assert repo.get!(WorkRequest, id).archive_reason == "never_started"
    assert repo.get!(WorkPackage, package.id).worktree_path == package.worktree_path
    assert repo.all(Entry) == []
    assert :ok = WorktreeCleanupQueue.reconcile(repo, codex_home: codex_home)
    assert File.dir?(package.worktree_path)

    assert {:ok, restored} = WorkRequestService.restore(repo, id)
    assert restored.completed_at == nil
    assert restored.archived_at == nil
    assert repo.all(Entry) == []
    assert File.dir?(package.worktree_path)
  end

  test "active packages do not create cleanup obligations", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-cleanup-queue-active")
    codex_home = use_codex_home!(fixture.root)
    package = prepared_package!(repo, fixture.repo_root, codex_home, "WP-CLEANUP-ACTIVE", "fix/cleanup-active")
    active = repo.update!(Ecto.Changeset.change(package, status: "active"))

    assert :ok = WorktreeCleanupQueue.enqueue_terminal(repo, active, codex_home: codex_home)
    assert repo.all(Entry) == []
    assert File.dir?(package.worktree_path)
  end

  test "manual retryable cleanup persists its obligation before reporting queued", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-cleanup-queue-manual")
    codex_home = use_codex_home!(fixture.root)
    package = prepared_package!(repo, fixture.repo_root, codex_home, "WP-CLEANUP-MANUAL", "fix/cleanup-manual")
    failure = {:git_failed, 1, %{stage: "git_worktree_remove", rule: "durable_preflight_proof"}}

    assert {:ok, queued} = WorktreeCleanupQueue.queue_retryable_cleanup(repo, package, failure, codex_home: codex_home)
    assert queued.status == "cleanup_queued"
    assert [%Entry{work_package_id: package_id, worktree_path: worktree_path}] = repo.all(Entry)
    assert package_id == package.id
    assert worktree_path == package.worktree_path
  end

  test "offline background reconciliation preserves existing cleanup obligations and source trees", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-offline-cleanup")
    codex_home = use_codex_home!(fixture.root)
    {_request, package} = prepared_linked_package!(repo, fixture.repo_root, codex_home, "WR-OFFLINE", "fix/offline")
    repo.update!(Ecto.Changeset.change(package, status: "merged"))
    assert :ok = WorktreeCleanupQueue.enqueue_terminal(repo, %{package | status: "merged"}, codex_home: codex_home)
    [obligation] = repo.all(Entry)
    before = File.ls!(package.worktree_path)
    previous = System.get_env("SYMPP_OFFLINE_SANDBOX")
    System.put_env("SYMPP_OFFLINE_SANDBOX", "1")

    try do
      assert :ok = WorktreeCleanupQueue.reconcile(repo, codex_home: codex_home)
      assert repo.all(Entry) == [obligation]
      assert File.ls!(package.worktree_path) == before

      assert {:error, :offline_sandbox} = WorktreeLifecycle.prepare(repo, "missing", %{}, [])
      assert {:error, :offline_sandbox} = WorktreeLifecycle.cleanup(repo, "missing", [])
      assert {:error, :offline_sandbox} = WorktreeLifecycle.validate_cleanup(repo, "missing", [])
      assert {:error, :offline_sandbox} = WorktreeLifecycle.cleanup_obligation(package, [])
      assert {:error, :offline_sandbox} = WorktreeLifecycle.cleanup_obligation(repo, obligation, [])
    after
      if previous, do: System.put_env("SYMPP_OFFLINE_SANDBOX", previous), else: System.delete_env("SYMPP_OFFLINE_SANDBOX")
    end
  end

  defp prepared_linked_package!(repo, repo_root, codex_home, request_id, branch) do
    assert {:ok, request} = WorkRequestRepository.create(repo, work_request_attrs(request_id))
    package = prepared_package!(repo, repo_root, codex_home, "#{request_id}-WP", branch, work_request_id: request.id)
    {request, package}
  end

  defp prepared_package!(repo, repo_root, codex_home, id, branch, overrides \\ []) do
    assert {:ok, package} =
             WorkPackageRepository.create(repo, WorkPackageFactory.attrs(Keyword.merge([id: id], overrides)))

    assert {:ok, prepared} =
             WorktreeLifecycle.prepare(
               repo,
               package.id,
               %{"repo_root" => repo_root, "base_branch" => "main", "branch" => branch},
               codex_home: codex_home
             )

    prepared.work_package
  end

  defp work_request_attrs(id) do
    %{
      id: id,
      title: id,
      repo: "nextide/example",
      base_branch: "main",
      work_type: "feature",
      human_description: "Test durable cleanup.",
      constraints: %{},
      desired_dispatch_shape: "single_package",
      status: "ready_for_slicing"
    }
  end

  defp use_codex_home!(root) do
    codex_home = Path.join(root, "codex-home")
    previous = System.get_env("CODEX_HOME")
    System.put_env("CODEX_HOME", codex_home)
    on_exit(fn -> if(previous, do: System.put_env("CODEX_HOME", previous), else: System.delete_env("CODEX_HOME")) end)
    codex_home
  end

  defp assert_eventually(assertion, attempts \\ 80)
  defp assert_eventually(_assertion, 0), do: flunk("condition was not met before timeout")

  defp assert_eventually(assertion, attempts) do
    assertion.()
  rescue
    ExUnit.AssertionError ->
      Process.sleep(25)
      assert_eventually(assertion, attempts - 1)
  end
end
