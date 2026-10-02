"""Copy persisted SDK sessions without sharing mutable database files."""

from contextlib import closing
from pathlib import Path
import shutil
import sqlite3
import tempfile
import time


def copy_session(source: Path, destination: Path):
    source, destination = Path(source), Path(destination)
    if destination.exists():
        raise FileExistsError(destination)
    native = source / "native"

    def ignore_sidecars(directory, names):
        if Path(directory) != native:
            return []
        return [name for name in names if name.endswith((".db-wal", ".db-shm", ".db-journal"))]

    def copy_file(src, dst):
        file = Path(src)
        if file.parent != native or file.suffix != ".db":
            return shutil.copy2(src, dst)
        # The SDK can checkpoint and remove its WAL/SHM files while closing.
        # SQLite reads the committed WAL itself and returns one consistent
        # snapshot; copying or simply excluding sidecars cannot do that.
        deadline = time.monotonic() + 10

        def progress(_status, _remaining, _total):
            if time.monotonic() > deadline:
                raise TimeoutError("Antigravity session snapshot timed out")

        with closing(sqlite3.connect(file.resolve().as_uri() + "?mode=ro", uri=True, timeout=1)) as original:
            with closing(sqlite3.connect(dst)) as snapshot:
                original.backup(snapshot, pages=256, progress=progress, sleep=0.05)
                snapshot.execute("PRAGMA journal_mode=DELETE")
        shutil.copystat(src, dst)
        return dst

    # Publish only a complete copy. A corrupt or busy database must not leave
    # a resumable session.json pointing at an incomplete native conversation.
    with tempfile.TemporaryDirectory(prefix=".antigravity-fork-", dir=destination.parent) as temporary:
        staged = Path(temporary) / "session"
        shutil.copytree(source, staged, ignore=ignore_sidecars, copy_function=copy_file)
        staged.rename(destination)
