defmodule SymphonyElixir.SymphonyPlusPlus.SoloSessionsTest do
  use ExUnit.Case, async: false

  alias Ecto.Changeset
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.SoloSessions.Repository
  alias SymphonyElixir.SymphonyPlusPlus.SoloSessions.Service
  alias SymphonyElixir.SymphonyPlusPlus.SoloSessions.SoloSession
  alias SymphonyElixir.SymphonyPlusPlus.SoloSessions.SoloSessionEntry
  alias SymphonyElixir.WorkPackageFactory

  defmodule BusyOnceRepo do
    alias SymphonyElixir.SymphonyPlusPlus.Repo

    def transaction(fun) do
      if Process.get(:sympp_solo_busy_once) do
        Repo.transaction(fun)
      else
        Process.put(:sympp_solo_busy_once, true)
        raise %Exqlite.Error{message: "database is locked"}
      end
    end

    def rollback(reason), do: Repo.rollback(reason)
    def one(query), do: Repo.one(query)
    def all(query), do: Repo.all(query)
    def get(schema, id), do: Repo.get(schema, id)
    def get!(schema, id), do: Repo.get!(schema, id)
    def insert(changeset), do: Repo.insert(changeset)
    def update_all(query, updates), do: Repo.update_all(query, updates)
  end

  defmodule StaleCurrentReadRepo do
    alias SymphonyElixir.SymphonyPlusPlus.Repo

    def transaction(fun), do: Repo.transaction(fun)
    def rollback(reason), do: Repo.rollback(reason)

    def one(query) do
      if Process.get(:sympp_solo_stale_current_read) do
        Repo.one(query)
      else
        Process.put(:sympp_solo_stale_current_read, true)
        nil
      end
    end

    def all(query), do: Repo.all(query)
    def get(schema, id), do: Repo.get(schema, id)
    def get!(schema, id), do: Repo.get!(schema, id)
    def insert(changeset), do: Repo.insert(changeset)
    def update_all(query, updates), do: Repo.update_all(query, updates)
  end

  defmodule StaleEntryIdempotencyReadRepo do
    alias SymphonyElixir.SymphonyPlusPlus.Repo

    def transaction(fun), do: Repo.transaction(fun)
    def rollback(reason), do: Repo.rollback(reason)

    def one(query) do
      if Process.get(:sympp_solo_stale_entry_idempotency_read) do
        Repo.one(query)
      else
        Process.put(:sympp_solo_stale_entry_idempotency_read, true)
        nil
      end
    end

    def all(query), do: Repo.all(query)
    def get(schema, id), do: Repo.get(schema, id)
    def get!(schema, id), do: Repo.get!(schema, id)
    def insert(changeset), do: Repo.insert(changeset)
    def update_all(query, updates), do: Repo.update_all(query, updates)
  end

  setup_all do
    database_path = WorkPackageFactory.database_path()

    start_supervised!({Repo, database: database_path, pool_size: 5})
    assert :ok = Repository.migrate(Repo)

    on_exit(fn -> File.rm(database_path) end)

    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    repo.delete_all(SoloSessionEntry)
    repo.delete_all(SoloSession)
    Process.delete(:sympp_solo_busy_once)
    Process.delete(:sympp_solo_stale_current_read)
    Process.delete(:sympp_solo_stale_entry_idempotency_read)
    :ok
  end

  test "active and paused uniqueness is enforced at the SQLite index", %{repo: repo} do
    attrs = session_attrs()
    assert {:ok, current} = Service.create_or_attach_current(repo, attrs)

    duplicate_attrs = %{
      repo: current.repo,
      base_branch: current.base_branch,
      workspace_path: current.workspace_path,
      caller_id: current.caller_id,
      title: "Duplicate current"
    }

    assert {:error, %Changeset{} = changeset} = Repo.insert(SoloSession.create_changeset(duplicate_attrs))
    assert "has already been taken" in errors_on(changeset).repo
  end

  test "retention archives active, paused, and completed sessions at seven inactive days", %{repo: repo} do
    now = ~U[2026-05-15 12:00:00.000000Z]
    cutoff = DateTime.add(now, -7 * 24 * 60 * 60, :second)
    fresh = DateTime.add(cutoff, 1, :second)

    assert {:ok, old_active} = Service.create_or_attach_current(repo, session_attrs(caller_id: "old-active"))
    old_active = set_last_activity!(repo, old_active, cutoff)

    assert {:ok, old_paused} = Service.create_or_attach_current(repo, session_attrs(caller_id: "old-paused"))
    assert {:ok, old_paused} = Service.pause(repo, old_paused.id, "active")
    old_paused = set_last_activity!(repo, old_paused, cutoff)

    assert {:ok, fresh_session} = Service.create_or_attach_current(repo, session_attrs(caller_id: "fresh"))
    fresh_session = set_last_activity!(repo, fresh_session, fresh)

    assert {:ok, completed} = Service.create_or_attach_current(repo, session_attrs(caller_id: "completed-old"))
    assert {:ok, completed} = Service.complete(repo, completed.id, "active")
    completed = set_last_activity!(repo, completed, cutoff)

    assert {:ok, %{archived: 3, deleted: 0}} = Service.retention_pass(repo, now)

    assert {:ok, old_active} = Service.get(repo, old_active.id)
    assert {:ok, old_paused} = Service.get(repo, old_paused.id)
    assert {:ok, fresh_session} = Service.get(repo, fresh_session.id)
    assert {:ok, completed} = Service.get(repo, completed.id)

    assert old_active.status == "archived"
    assert old_active.last_activity_at == cutoff
    assert old_active.archived_at == now
    assert old_paused.status == "archived"
    assert old_paused.archived_at == now
    assert fresh_session.status == "active"
    assert completed.status == "archived"
  end

  test "retention deletes at fourteen inactive days, including late archives, and cascades entries", %{repo: repo} do
    now = ~U[2026-05-15 12:00:00.000000Z]
    cutoff = DateTime.add(now, -14 * 24 * 60 * 60, :second)
    fresh = DateTime.add(cutoff, 1, :second)

    assert {:ok, late} = Service.create_or_attach_current(repo, session_attrs(caller_id: "late-completed"))
    assert {:ok, late_entry} = Service.append_progress(repo, late.id, %{summary: "Late note"})
    assert {:ok, late} = Service.complete(repo, late.id, "active")
    late = set_last_activity!(repo, late, cutoff)

    assert {:ok, archived} = Service.create_or_attach_current(repo, session_attrs(caller_id: "boundary-archived"))
    assert {:ok, archived_entry} = Service.append_progress(repo, archived.id, %{summary: "Old note"})
    assert {:ok, archived} = Service.archive(repo, archived.id, "active")
    archived = set_last_activity!(repo, archived, cutoff)
    archived = set_archived_at!(repo, archived, now)

    assert {:ok, recent} = Service.create_or_attach_current(repo, session_attrs(caller_id: "recent-archived"))
    assert {:ok, recent} = Service.archive(repo, recent.id, "active")
    recent = set_last_activity!(repo, recent, fresh)
    recent = set_archived_at!(repo, recent, DateTime.add(now, -30 * 24 * 60 * 60, :second))

    assert {:ok, %{archived: 1, deleted: 2}} = Service.retention_pass(repo, now)

    assert late.last_activity_at == cutoff
    assert archived.last_activity_at == cutoff
    assert {:error, :not_found} = Service.get(repo, late.id)
    assert {:error, :not_found} = Service.get(repo, archived.id)
    refute Enum.any?(repo.all(SoloSessionEntry), &(&1.id in [late_entry.id, archived_entry.id]))

    assert {:ok, ^recent} = Service.get(repo, recent.id)
  end

  test "resolves historical blocker entries without a modern blocker id payload", %{repo: repo} do
    assert {:ok, session} = Service.create_or_attach_current(repo, session_attrs())

    assert {:ok, legacy_blocker} =
             Service.append_entry(repo, session.id, %{
               entry_kind: "blocker",
               title: "Legacy blocker row",
               status: "blocked"
             })

    assert {:ok, resolved} =
             Service.resolve_blocker(repo, session.id, %{
               blocker_id: legacy_blocker.id,
               resolution: "Resolved historical blocker by row id"
             })

    assert resolved.payload["blocker_id"] == legacy_blocker.id
    assert resolved.payload["blocker_status"] == "resolved"
  end

  test "idempotent replays survive completed and archived session transitions", %{repo: repo} do
    assert {:ok, session} =
             Service.create_or_attach_current(
               repo,
               session_attrs(workspace_path: workspace_path("idempotent-lifecycle"))
             )

    assert {:ok, entry} =
             Service.append_entry(repo, session.id, %{
               entry_kind: "validation_note",
               title: "Validated once",
               idempotency_key: "lifecycle-entry-key"
             })

    assert {:ok, completed} = Service.complete(repo, session.id, "active")
    Process.sleep(5)

    assert {:ok, completed_replay} =
             Service.append_entry(repo, session.id, %{
               entry_kind: "validation_note",
               title: "Retry after complete",
               idempotency_key: "lifecycle-entry-key"
             })

    assert completed_replay.id == entry.id
    assert {:ok, completed_after_replay} = Service.get(repo, session.id)
    assert completed_after_replay.last_activity_at == completed.last_activity_at

    Process.delete(:sympp_solo_stale_entry_idempotency_read)
    Process.sleep(5)

    assert {:ok, stale_completed_replay} =
             Service.append_entry(StaleEntryIdempotencyReadRepo, session.id, %{
               entry_kind: "validation_note",
               title: "Stale retry after complete",
               idempotency_key: "lifecycle-entry-key"
             })

    assert stale_completed_replay.id == entry.id
    assert {:ok, completed_after_stale_replay} = Service.get(repo, session.id)
    assert completed_after_stale_replay.last_activity_at == completed.last_activity_at

    assert {:ok, archived} = Service.archive(repo, session.id, "completed")
    Process.delete(:sympp_solo_stale_entry_idempotency_read)
    Process.sleep(5)

    assert {:ok, archived_replay} =
             Service.append_entry(StaleEntryIdempotencyReadRepo, session.id, %{
               entry_kind: "validation_note",
               title: "Stale retry after archive",
               idempotency_key: "lifecycle-entry-key"
             })

    assert archived_replay.id == entry.id
    assert {:ok, archived_after_replay} = Service.get(repo, session.id)
    assert archived_after_replay.last_activity_at == archived.last_activity_at
    assert {:ok, [only_entry]} = Service.list_entries(repo, session.id)
    assert only_entry.id == entry.id
  end

  test "idempotent append conflict replays from a fresh read path", %{repo: repo} do
    assert {:ok, session} = Service.create_or_attach_current(repo, session_attrs(workspace_path: workspace_path("entry-conflict")))

    assert {:ok, existing} =
             Service.append_entry(repo, session.id, %{
               entry_kind: "finding",
               title: "Already persisted",
               idempotency_key: "entry-conflict-key"
             })

    assert {:ok, replayed} =
             Service.append_entry(StaleEntryIdempotencyReadRepo, session.id, %{
               entry_kind: "finding",
               title: "Retry after stale read",
               idempotency_key: "entry-conflict-key"
             })

    assert replayed.id == existing.id
    assert {:ok, [only_entry]} = Service.list_entries(repo, session.id)
    assert only_entry.id == existing.id
  end

  test "concurrent appends allocate unique monotonically increasing sequences", %{repo: repo} do
    assert {:ok, session} = Service.create_or_attach_current(repo, session_attrs(workspace_path: workspace_path("concurrent-entries")))

    results =
      1..20
      |> Task.async_stream(
        fn index ->
          Service.append_entry(repo, session.id, %{
            entry_kind: "progress",
            title: "Concurrent #{index}",
            idempotency_key: "concurrent-entry-#{index}"
          })
        end,
        max_concurrency: 20,
        timeout: 15_000
      )
      |> Enum.to_list()

    assert Enum.all?(results, fn
             {:ok, {:ok, %SoloSessionEntry{}}} -> true
             _result -> false
           end)

    assert {:ok, entries} = Service.list_entries(repo, session.id)
    assert Enum.map(entries, & &1.sequence) == Enum.to_list(1..20)
    assert entries |> Enum.map(& &1.id) |> Enum.uniq() |> length() == 20
  end

  test "concurrent first attaches converge on one active session", %{repo: repo} do
    attrs = session_attrs(workspace_path: workspace_path("concurrent"))

    results =
      1..20
      |> Task.async_stream(fn _index -> Service.create_or_attach_current(repo, attrs) end,
        max_concurrency: 20,
        timeout: 15_000
      )
      |> Enum.to_list()

    assert Enum.all?(results, fn
             {:ok, {:ok, %SoloSession{}}} -> true
             _result -> false
           end)

    sessions = Enum.map(results, fn {:ok, {:ok, session}} -> session end)
    assert sessions |> Enum.map(& &1.id) |> Enum.uniq() |> length() == 1

    assert {:ok, [current]} =
             Service.list(repo, %{
               repo: attrs.repo,
               base_branch: attrs.base_branch,
               workspace_path: attrs.workspace_path,
               caller_id: attrs.caller_id,
               status: "active"
             })

    assert current.id == hd(sessions).id
  end

  test "insert conflicts replay by reading the current session in a fresh transaction", %{repo: repo} do
    attrs = session_attrs(workspace_path: workspace_path("insert-conflict"))
    assert {:ok, existing} = Service.create_or_attach_current(repo, attrs)
    Process.sleep(5)

    assert {:ok, attached} = Service.create_or_attach_current(StaleCurrentReadRepo, attrs)

    assert attached.id == existing.id
    assert DateTime.compare(attached.last_activity_at, existing.last_activity_at) == :gt
  end

  test "database busy during create attach is retried", %{repo: repo} do
    attrs = session_attrs(workspace_path: workspace_path("busy-retry"))

    assert {:ok, session} = Service.create_or_attach_current(BusyOnceRepo, attrs)
    assert {:ok, [listed]} = Service.list(repo, %{workspace_path: attrs.workspace_path})
    assert listed.id == session.id
  end

  defp set_last_activity!(repo, %SoloSession{} = session, timestamp) do
    session
    |> Changeset.change(last_activity_at: timestamp, updated_at: timestamp)
    |> repo.update!()
  end

  defp set_archived_at!(repo, %SoloSession{} = session, timestamp) do
    session
    |> Changeset.change(archived_at: timestamp, updated_at: timestamp)
    |> repo.update!()
  end

  test "entry text and nested payload are redacted in SQLite before any MCP rendering", %{repo: repo} do
    assert {:ok, session} = Service.create_or_attach_current(repo, session_attrs())

    assert {:ok, entry} =
             Service.append_entry(repo, session.id, %{
               entry_kind: "progress",
               title: "Plan bearer abcdefghijkl",
               body: "Use ghp_abcdefgh as a fake token",
               payload: %{token: "ghp_abcdefgh", nested: [%{url: "https://example.test/path?token=ghp_abcdefgh"}]}
             })

    stored = repo.get!(SoloSessionEntry, entry.id)
    assert stored.title == "Plan [REDACTED]"
    assert stored.body == "Use [REDACTED] as a fake token"
    assert stored.payload["token"] == "[REDACTED]"
    assert stored.payload["nested"] == [%{"url" => "https://example.test/path?token=[REDACTED]"}]
  end

  defp session_attrs(overrides \\ []) do
    defaults = %{
      repo: "nextide/example",
      base_branch: "main",
      workspace_path: workspace_path("default"),
      caller_id: "codex-local",
      title: "Local planning"
    }

    Enum.into(overrides, defaults)
  end

  defp workspace_path(name) do
    path = Path.join(System.tmp_dir!(), "sympp-solo-session-#{name}-#{System.unique_integer([:positive])}")
    File.mkdir_p!(path)
    path
  end

  defp errors_on(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {message, options} ->
      Enum.reduce(options, message, fn {key, value}, acc ->
        String.replace(acc, "%{#{key}}", inspect(value))
      end)
    end)
  end
end
