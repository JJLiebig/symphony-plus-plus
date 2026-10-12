"""Hosted regression proof for online copies and failed/unsafe publication."""

from contextlib import closing
from pathlib import Path
import importlib.util
import os
import sqlite3
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("snapshot", Path(__file__).parents[1] / "sympp_beta_snapshot.py")
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SnapshotTest(unittest.TestCase):
    def test_online_wal_copy_is_marked_migrated_and_does_not_write_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "live.sqlite3"
            destination = root / "beta" / "ledger.sqlite3"
            with closing(sqlite3.connect(source)) as live:
                live.execute("PRAGMA journal_mode=WAL")
                live.execute("PRAGMA wal_autocheckpoint=0")
                live.execute("CREATE TABLE goals (title TEXT)")
                live.execute("INSERT INTO goals VALUES ('Example goal')")
                live.commit()
                originals = {path: path.read_bytes() for path in (source, Path(str(source) + "-wal"))}

                def migrate(stage):
                    self.assertTrue(snapshot.marked(stage))
                    with closing(sqlite3.connect(stage)) as copy:
                        self.assertEqual(copy.execute("SELECT title FROM goals").fetchall(), [("Example goal",)])
                        copy.execute("ALTER TABLE goals ADD COLUMN migrated INTEGER DEFAULT 1")
                        copy.commit()

                snapshot.snapshot(source, destination, destination.parent, False, migrate)
                for path, before in originals.items():
                    self.assertEqual(path.read_bytes(), before)
                self.assertFalse(snapshot.marked(source))
                snapshot.verify(destination, offline=True)
                with self.assertRaises(ValueError):
                    snapshot.verify(destination, offline=False)
                with closing(sqlite3.connect(destination)) as copy:
                    self.assertEqual(copy.execute("SELECT migrated FROM goals").fetchall(), [(1,)])
                self.assertFalse(any(destination.parent.glob(".beta-snapshot-*")))

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


if __name__ == "__main__":
    unittest.main()
