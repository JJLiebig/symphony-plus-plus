"""Consistent SQLite backup and atomic publication for the offline beta launcher."""

import argparse
from contextlib import closing
from pathlib import Path
import os
import sqlite3
import subprocess
import tempfile


MARKER = "sympp_offline_sandbox"


def readonly(database):
    return sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True)


def marked(database):
    with closing(readonly(database)) as connection:
        return connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (MARKER,)
        ).fetchone() is not None


def verify(database, offline):
    database = Path(database)
    if not database.is_file() or database.stat().st_size == 0:
        raise ValueError("Ledger is missing or empty. Run -Action Snapshot first.")
    if marked(database) != offline:
        raise ValueError(
            "Offline beta requires a marked snapshot; a marked snapshot cannot use -LiveLedger."
        )


def validate_destination(source, destination, sandbox_root, replace):
    source = Path(source).resolve(strict=True)
    destination = Path(destination)
    root = Path(sandbox_root).resolve()
    resolved = destination.resolve()
    if not resolved.is_relative_to(root) or resolved == root:
        raise ValueError("Snapshot destination must be inside the beta ledger directory.")
    if resolved == source or (destination.exists() and os.path.samefile(source, destination)):
        raise ValueError("Snapshot source and destination must be different files.")
    if destination.exists() and not replace:
        raise ValueError("Sandbox ledger already exists. Use -ReplaceSnapshot to replace it.")
    # Replacing a database with sidecars can replay an old WAL into the new copy.
    if any(Path(str(destination) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise ValueError("Sandbox ledger has SQLite sidecars. Stop it cleanly before replacing it.")
    if not source.is_file() or source.stat().st_size == 0:
        raise ValueError("Snapshot source is missing or empty.")
    return source, resolved


def snapshot(source, destination, sandbox_root, replace, migrate):
    source, destination = validate_destination(source, destination, sandbox_root, replace)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, stage = tempfile.mkstemp(prefix=".beta-snapshot-", suffix=".sqlite3", dir=destination.parent)
    os.close(descriptor)
    stage = Path(stage)
    try:
        with closing(readonly(source)) as source_connection, closing(sqlite3.connect(stage)) as target:
            source_connection.backup(target)
            target.execute(f"CREATE TABLE IF NOT EXISTS {MARKER} (created_at TEXT NOT NULL)")
            target.execute(f"DELETE FROM {MARKER}")
            target.execute(f"INSERT INTO {MARKER} VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")
            target.commit()
        migrate(stage)
        verify(stage, offline=True)
        # The migrator is closed; fold only the staged database's WAL before publication.
        with closing(sqlite3.connect(stage)) as target:
            if target.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise ValueError("Migrated sandbox ledger failed SQLite integrity_check.")
            target.execute("PRAGMA journal_mode=DELETE")
        validate_destination(source, destination, sandbox_root, replace)
        with stage.open("rb+") as stream:
            os.fsync(stream.fileno())
        if replace:
            os.replace(stage, destination)
        else:
            # A concurrent creation must not be overwritten between validation and publication.
            os.link(stage, destination)
            stage.unlink()
    finally:
        for path in (stage, *(Path(str(stage) + suffix) for suffix in ("-wal", "-shm", "-journal"))):
            path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    check = commands.add_parser("verify")
    check.add_argument("database")
    check.add_argument("--live", action="store_true")
    copy = commands.add_parser("snapshot")
    copy.add_argument("source")
    copy.add_argument("destination")
    copy.add_argument("--sandbox-root", required=True)
    copy.add_argument("--replace", action="store_true")
    copy.add_argument("--migrate", nargs=argparse.REMAINDER, required=True)
    args = parser.parse_args()
    try:
        if args.action == "verify":
            verify(args.database, offline=not args.live)
        else:
            if not args.migrate:
                raise ValueError("A migration command is required before publishing a snapshot.")
            snapshot(
                args.source, args.destination, args.sandbox_root, args.replace,
                lambda stage: subprocess.run([*args.migrate, "--database", str(stage)], check=True),
            )
    except (OSError, ValueError, sqlite3.Error, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Beta snapshot refused: {error}\n")


if __name__ == "__main__":
    main()
