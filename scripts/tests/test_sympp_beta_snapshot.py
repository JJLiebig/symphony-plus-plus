"""Hosted regression proof for online copies and failed/unsafe publication."""

from contextlib import closing
from pathlib import Path
import importlib.util
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request


spec = importlib.util.spec_from_file_location("snapshot", Path(__file__).parents[1] / "sympp_beta_snapshot.py")
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SnapshotTest(unittest.TestCase):
    def test_force_stopped_sandbox_can_refresh_but_busy_or_failed_refresh_preserves_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.sqlite3"
            destination = root / "beta.sqlite3"
            with closing(sqlite3.connect(source)) as live:
                live.execute("CREATE TABLE goals (title TEXT)")
                live.execute("INSERT INTO goals VALUES ('Example source goal')")
                live.commit()
            source_bytes = source.read_bytes()
            snapshot.snapshot(source, destination, root, False, lambda _stage: None)
            writer = subprocess.Popen(
                [sys.executable, "-c", """
import sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.execute('PRAGMA journal_mode=WAL')
connection.execute('PRAGMA wal_autocheckpoint=0')
connection.execute("INSERT INTO goals VALUES ('Example local edit')")
connection.commit()
print('ready', flush=True)
sys.stdin.read()
""", str(destination)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
            )
            try:
                self.assertEqual(writer.stdout.readline().strip(), "ready")
                with self.assertRaisesRegex(ValueError, "stopped, marked"):
                    snapshot.snapshot(source, destination, root, True, lambda _stage: self.fail("busy migration ran"))
            finally:
                writer.kill()
                writer.wait(timeout=10)
                writer.stdin.close()
                writer.stdout.close()
            self.assertTrue(Path(str(destination) + "-wal").exists())

            def fail_migration(_stage):
                raise RuntimeError("migration failed")

            with self.assertRaisesRegex(RuntimeError, "migration failed"):
                snapshot.snapshot(source, destination, root, True, fail_migration)
            with closing(snapshot.readonly(destination)) as previous:
                self.assertEqual(previous.execute("SELECT title FROM goals").fetchall(),
                                 [("Example source goal",), ("Example local edit",)])
            snapshot.snapshot(source, destination, root, True, lambda _stage: None)
            snapshot.verify(destination, offline=True)
            with closing(snapshot.readonly(destination)) as refreshed:
                self.assertEqual(refreshed.execute("SELECT title FROM goals").fetchall(), [("Example source goal",)])
            self.assertEqual(source.read_bytes(), source_bytes)

    def test_refused_aliases_and_failed_migration_preserve_both_ledgers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.sqlite3"
            with closing(sqlite3.connect(source)) as live:
                live.execute("CREATE TABLE goals (title TEXT)")
                live.commit()
            alias = root / "hardlink.sqlite3"
            os.link(source, alias)
            for destination in (source, alias):
                with self.assertRaisesRegex(ValueError, "different files"):
                    snapshot.snapshot(source, destination, root, True, lambda _stage: self.fail("migration ran"))
            source_bytes = source.read_bytes()
            destination = root / "beta.sqlite3"
            destination.write_bytes(b"previous sandbox")
            with self.assertRaisesRegex(ValueError, "already exists"):
                snapshot.snapshot(source, destination, root, False, lambda _stage: self.fail("migration ran"))

            def fail_migration(_stage):
                raise RuntimeError("migration failed")

            with self.assertRaisesRegex(RuntimeError, "migration failed"):
                snapshot.snapshot(source, destination, root, True, fail_migration)
            self.assertEqual(destination.read_bytes(), b"previous sandbox")
            self.assertEqual(source.read_bytes(), source_bytes)
            self.assertFalse(any(root.glob(".beta-snapshot-*")))
            Path(str(destination) + "-wal").touch()
            with self.assertRaisesRegex(ValueError, "sidecars"):
                snapshot.snapshot(source, destination, root, True, lambda _stage: self.fail("migration ran"))
            with self.assertRaises(ValueError):
                snapshot.snapshot(source, root.parent / "outside.sqlite3", root, False, lambda _stage: self.fail("migration ran"))
            with self.assertRaises(ValueError):
                snapshot.verify(root / "missing.sqlite3", offline=True)


@unittest.skipUnless(os.environ.get("SYMPP_OFFLINE_SKILL"), "installed Windows artifact qualification only")
class InstalledSnapshotTest(unittest.TestCase):
    def test_published_copy_view_and_console_stop_are_isolated(self):
        """Exercise the installed entrypoint, actual release eval, and a real Ctrl+C console event."""
        skill = Path(os.environ["SYMPP_OFFLINE_SKILL"])
        artifact = Path(os.environ["SYMPP_OFFLINE_ARTIFACT"])
        with tempfile.TemporaryDirectory(prefix="sympp-offline-") as directory:
            root = Path(directory)
            source = root / "source ledger.sqlite3"
            viewer_home = root / "viewer home"
            destination = viewer_home / "ledger" / "snapshot.sqlite3"
            fixture_repo = root / "external repository"
            fixture_repo.mkdir()
            sentinel = fixture_repo / "preserve.txt"
            sentinel.write_text("do not change\n")
            command_log = root / "external-commands.log"
            fake_bin = root / "bin"
            fake_bin.mkdir()
            for command in ("git", "gh", "herdr", "codex", "claude", "review-suite"):
                (fake_bin / (command + ".cmd")).write_text(f'@echo {command}>>"{command_log}"\n@exit /b 93\n')
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("SYMPP_", "HERDR_", "RELEASE_"))}
            env.update(PATH=str(fake_bin) + os.pathsep + env["PATH"], SYMPP_DATABASE=str(source),
                       SYMPP_RUNTIME_ARTIFACT="1", SYMPP_RUNTIME_ARTIFACT_ACKNOWLEDGED="1",
                       SYMPP_LOGS_ROOT=str(root / "seed logs"), SYMPP_BACKEND_PORT="0",
                       RELEASE_TMP=str(root / "release tmp"))
            Path(env["RELEASE_TMP"]).mkdir()
            eval_script = root / "seed.ps1"
            eval_script.write_text("& $env:SYMPP_TEST_RELEASE eval 'Code.eval_file(System.get_env(~s(SYMPP_TEST_EXPRESSION_FILE)))'\nexit $LASTEXITCODE\n")
            env["SYMPP_TEST_RELEASE"] = str(artifact / "bin" / "symphony_elixir.bat")
            env["SYMPP_TEST_EXPRESSION_FILE"] = str(root / "seed.exs")
            Path(env["SYMPP_TEST_EXPRESSION_FILE"]).write_text(
                "{:ok, _} = Application.ensure_all_started(:ecto_sql); "
                "alias SymphonyElixir.SymphonyPlusPlus.Repo; "
                "{:ok, repo} = Repo.start_link(Repo.child_options(database: System.fetch_env!(~s(SYMPP_DATABASE)))); "
                "Ecto.Migrator.run(Repo, Repo.Migrations.all(), :up, to: 20261005040000, log: false); "
                "GenServer.stop(repo); "
                "false = Enum.any?(Application.started_applications(), fn {app, _, _} -> app == :symphony_elixir end)"
            )

            def run(arguments, **kwargs):
                result = subprocess.run(["pwsh", "-NoProfile", "-File", *map(str, arguments)],
                                        env=env, capture_output=True, text=True, timeout=600, **kwargs)
                if result.returncode:
                    for log in (viewer_home / "logs").glob("*.log"):
                        result.stderr += f"\n{log.name}:\n{log.read_text(errors='replace')}"
                return result

            seeded = run([eval_script])
            self.assertEqual(seeded.returncode, 0, seeded.stdout + seeded.stderr)
            helper = skill / "scripts" / "sympp-offline.ps1"
            copy_args = [helper, "-Action", "Snapshot", "-SymppHome", viewer_home, "-SourceDatabase", source]
            with closing(sqlite3.connect(source)) as live:
                live.execute("PRAGMA journal_mode=WAL")
                live.execute("PRAGMA wal_autocheckpoint=0")
                now = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
                live.execute("INSERT INTO sympp_work_requests (id,title,repo,base_branch,work_type,human_description,desired_dispatch_shape,status,inserted_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                             ("wr_offline", "Copied example goal", "example/widget", "main", "feature", "Synthetic offline proof", "single_package", "sliced", now, now))
                live.execute("INSERT INTO sympp_work_packages (id,work_request_id,kind,title,repo,base_branch,status,worktree_path,inserted_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                             ("WP-OFFLINE", "wr_offline", "standard_pr", "Copied example package", "example/widget", "main", "active", str(fixture_repo), now, now))
                live.execute("INSERT INTO sympp_operator_settings (id,work_request_archive_after_days,inserted_at,updated_at) VALUES (?,?,?,?)",
                             ("local_operator", 14, now, now))
                live.commit()
                originals = {path: path.read_bytes() for path in (source, Path(str(source) + "-wal"))}
                copied = run(copy_args)
                self.assertEqual(copied.returncode, 0, copied.stdout + copied.stderr)
                self.assertIn("87d828d528b68e7b35ebb94d307a96b6f2c556ed", copied.stdout)
                with closing(snapshot.readonly(destination)) as copied_db:
                    self.assertEqual(copied_db.execute("SELECT work_request_archive_after_days,work_request_never_started_archive_after_days FROM sympp_operator_settings").fetchall(), [(3, 30)])
                    self.assertEqual(copied_db.execute("SELECT title FROM sympp_work_requests").fetchall(), [("Copied example goal",)])
                self.assertTrue(snapshot.marked(destination))
                self.assertFalse(snapshot.marked(source))
                self.assertNotEqual(run(copy_args).returncode, 0, "replacement requires explicit consent")

                with socket.socket() as port_probe:
                    port_probe.bind(("127.0.0.1", 0))
                    port = port_probe.getsockname()[1]
                origin = f"http://127.0.0.1:{port}"

                def request(path, payload=None):
                    headers = {"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty", "Content-Type": "application/json"}
                    req = urllib.request.Request(origin + path, data=None if payload is None else json.dumps(payload).encode(), headers=headers)
                    try:
                        with urllib.request.urlopen(req, timeout=10) as response:
                            return response.status, response.read().decode()
                    except urllib.error.HTTPError as error:
                        return error.code, error.read().decode()

                output_file = root / "viewer-output.log"
                startup = subprocess.STARTUPINFO()
                startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startup.wShowWindow = 0
                sibling = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
                with output_file.open("w") as output:
                    viewer = subprocess.Popen(["pwsh", "-NoProfile", "-File", str(helper), "-Action", "View", "-SymppHome", str(viewer_home), "-Port", str(port)],
                                              env=env, stdout=output, stderr=subprocess.STDOUT,
                                              creationflags=subprocess.CREATE_NEW_CONSOLE, startupinfo=startup)
                    try:
                        deadline = time.monotonic() + 120
                        while time.monotonic() < deadline:
                            try:
                                if request("/sympp/board")[0] == 200:
                                    break
                            except (OSError, urllib.error.URLError):
                                pass
                            self.assertIsNone(viewer.poll(), output_file.read_text())
                            time.sleep(0.3)
                        else:
                            self.fail("Offline board did not start: " + output_file.read_text() + "\n" + (viewer_home / "logs/viewer.log").read_text())
                        status, hydrated = request("/api/v1/sympp/operator/dashboard/hydrated")
                        self.assertEqual(status, 200, hydrated)
                        self.assertIn("Copied example goal", hydrated)
                        self.assertIn("Copied example package", hydrated)
                        for route, body in (
                            ("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize"}),
                            ("/mcp/client-lease", {}),
                            ("/api/v1/sympp/operator/work-requests/wr_offline/work-packages/WP-OFFLINE/dispatch", {}),
                            ("/api/v1/sympp/operator/work-packages/WP-OFFLINE/focus", {}),
                        ):
                            self.assertEqual(request(route, body)[0], 403, route)
                        self.assertNotEqual(run([*copy_args, "-ReplaceSnapshot"]).returncode, 0, "active viewer must exclude replacement")
                        # Send an actual Ctrl+C only to the viewer's separate console, never the runner's.
                        interrupted = subprocess.run([sys.executable, "-c", """
import ctypes, sys, time
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.FreeConsole()
assert kernel.AttachConsole(int(sys.argv[1]))
assert kernel.SetConsoleCtrlHandler(None, True)
assert kernel.GenerateConsoleCtrlEvent(0, 0)
time.sleep(0.5)
kernel.FreeConsole()
""", str(viewer.pid)], capture_output=True, text=True, timeout=15)
                        self.assertEqual(interrupted.returncode, 0, interrupted.stderr)
                        viewer.wait(timeout=30)
                        self.assertIsNone(sibling.poll(), "Ctrl+C stopped an unrelated process")
                        with socket.socket() as stopped:
                            self.assertNotEqual(stopped.connect_ex(("127.0.0.1", port)), 0, "viewer listener survived Ctrl+C")
                    finally:
                        if viewer.poll() is None:
                            subprocess.run(["taskkill", "/PID", str(viewer.pid), "/T", "/F"], capture_output=True, timeout=30)
                        sibling.kill()
                        sibling.wait(timeout=10)

                refreshed = run([*copy_args, "-ReplaceSnapshot"])
                self.assertEqual(refreshed.returncode, 0, refreshed.stdout + refreshed.stderr)
                # The ordinary published entrypoint must reject the marked copy with offline mode absent.
                env["SYMPP_DATABASE"] = str(destination)
                online = run([artifact / "start-runtime.ps1", "-IUnderstandThatThisWillBeRunningWithoutTheUsualGuardrails", "-LogsRoot", root / "refused logs", "-Port", str(port)])
                self.assertNotEqual(online.returncode, 0)
                self.assertIn("offline beta snapshot", online.stdout + online.stderr)
                for path, original in originals.items():
                    self.assertEqual(path.read_bytes(), original, f"source changed: {path.name}")
                self.assertEqual(live.execute("SELECT work_request_archive_after_days FROM sympp_operator_settings").fetchall(), [(14,)])
                self.assertEqual(sentinel.read_text(), "do not change\n")
                self.assertFalse(command_log.exists(), "offline runtime invoked an external command")
                self.assertFalse(any((viewer_home / "ledger").glob(".beta-snapshot-*")))
                print("Installed beta.2 offline proof: old-schema WAL copy, marker, populated board, denied MCP/dispatch/focus, untouched source/commands, Ctrl+C isolation, refresh, online-start refusal.")


if __name__ == "__main__":
    unittest.main()
