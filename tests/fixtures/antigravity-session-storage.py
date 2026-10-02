"""Exercise native SQLite session forks without an SDK or model connection."""

import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

module_file = Path(__file__).resolve().parents[2] / "src/engines/antigravity/session_storage.py"
spec = importlib.util.spec_from_file_location("session_storage", module_file)
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class SessionStorageTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="camellia-sdk-snapshot-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.source = self.root / "source"
        self.native = self.source / "native"
        self.native.mkdir(parents=True)
        self.database = self.native / ("a" * 32 + ".db")
        self.writer = sqlite3.connect(self.database)
        self.addCleanup(self.writer.close)
        self.writer.execute("PRAGMA journal_mode=WAL")
        self.writer.execute("PRAGMA wal_autocheckpoint=0")
        self.writer.execute("CREATE TABLE messages(text TEXT)")
        self.writer.execute("INSERT INTO messages VALUES ('committed in WAL')")
        self.writer.commit()
        self.assertGreater(Path(str(self.database) + "-wal").stat().st_size, 0)
        (self.source / "session.json").write_text(json.dumps({"conversationId": "a" * 32}), encoding="utf-8")
        (self.source / "attachment.txt").write_text("keep attachment", encoding="utf-8")

    def read_messages(self, database):
        connection = sqlite3.connect(database)
        try:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            return connection.execute("SELECT text FROM messages").fetchall()
        finally:
            connection.close()

    def test_wal_snapshot_preserves_committed_messages_and_fork_independence(self):
        destination = self.root / "fork"
        storage.copy_session(self.source, destination)
        copied = destination / "native" / self.database.name
        self.assertEqual(self.read_messages(copied), [("committed in WAL",)])
        self.assertEqual((destination / "attachment.txt").read_text(encoding="utf-8"), "keep attachment")
        self.assertEqual(json.loads((destination / "session.json").read_text()), {"conversationId": "a" * 32})
        self.assertFalse(Path(str(copied) + "-wal").exists())
        self.assertFalse(Path(str(copied) + "-shm").exists())
        fork = sqlite3.connect(copied)
        try:
            fork.execute("INSERT INTO messages VALUES ('only in fork')")
            fork.commit()
        finally:
            fork.close()
        self.writer.execute("INSERT INTO messages VALUES ('only in original')")
        self.writer.commit()
        self.assertEqual(self.read_messages(copied), [("committed in WAL",), ("only in fork",)])
        self.assertEqual(self.read_messages(self.database), [("committed in WAL",), ("only in original",)])

    def test_source_closing_during_copy_does_not_require_disappearing_sidecars(self):
        original_copytree = shutil.copytree
        closed = False

        def racing_copytree(src, dst, symlinks=False, ignore=None, copy_function=shutil.copy2,
                            ignore_dangling_symlinks=False, dirs_exist_ok=False):
            def copy_and_close(source_file, destination_file):
                nonlocal closed
                result = copy_function(source_file, destination_file)
                if Path(source_file) == self.database and not closed:
                    closed = True
                    self.writer.close()
                    self.assertFalse(Path(str(self.database) + "-wal").exists())
                    self.assertFalse(Path(str(self.database) + "-shm").exists())
                return result

            return original_copytree(src, dst, symlinks=symlinks, ignore=ignore,
                                     copy_function=copy_and_close,
                                     ignore_dangling_symlinks=ignore_dangling_symlinks,
                                     dirs_exist_ok=dirs_exist_ok)

        destination = self.root / "fork-during-close"
        with patch.object(storage.shutil, "copytree", racing_copytree):
            storage.copy_session(self.source, destination)
        self.assertTrue(closed, "The source must close after its database was copied")
        self.assertEqual(self.read_messages(destination / "native" / self.database.name), [("committed in WAL",)])

    def test_invalid_database_does_not_publish_a_partial_fork(self):
        self.writer.close()
        self.database.write_bytes(b"not a SQLite database")
        destination = self.root / "invalid-fork"
        with self.assertRaises(sqlite3.DatabaseError):
            storage.copy_session(self.source, destination)
        self.assertFalse(destination.exists())
        self.assertEqual(self.database.read_bytes(), b"not a SQLite database")


if __name__ == "__main__":
    unittest.main(verbosity=2)
