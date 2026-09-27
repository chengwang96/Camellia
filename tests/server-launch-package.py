import argparse
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import tarfile
import tempfile
import time

parser = argparse.ArgumentParser(description="Validate packaged one-terminal launch using an offline helper fixture")
parser.add_argument("archive")
args = parser.parse_args()
archive = Path(args.archive).resolve()
assert hashlib.sha256(archive.read_bytes()).hexdigest() == Path(str(archive) + ".sha256").read_text().split()[0]


def wait_text(descriptor, expected):
    output = b""
    deadline = time.monotonic() + 20
    while expected not in output:
        remaining = deadline - time.monotonic()
        assert remaining > 0 and select.select([descriptor], [], [], remaining)[0], output.decode(errors="replace")
        output += os.read(descriptor, 8192)
    return output


with tempfile.TemporaryDirectory(prefix="camellia-package-launch-") as temporary:
    folder = Path(temporary)
    with tarfile.open(archive) as package:
        package.extractall(folder, filter="data")
    executable = folder / "camellia-server" / "camellia"
    helper = folder / "offline-helper"
    helper.write_text('''#!/usr/bin/python3
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    result = {"state":"Running","address":"100.80.1.2","loginUrl":None} if request["action"] == "status" else {}
    print(json.dumps({"id":request["id"],"result":result}), flush=True)
''')
    helper.chmod(0o700)
    data = folder / "data"
    master, slave = pty.openpty()
    service = subprocess.Popen([str(executable), "--data-dir", str(data), "--helper", str(helper), "--lang", "en"],
                               stdin=slave, stdout=slave, stderr=slave, env={**os.environ, "NO_COLOR": "1"})
    os.close(slave)
    attached = None
    attached_master = None
    try:
        output = wait_text(master, b"q: exit")
        assert b"One-time pairing code:" in output
        assert b"http://100.80.1.2:43127" in output
        assert b"server runs in this terminal" in output
        settings = subprocess.run([str(executable), "settings", "--data-dir", str(data)], capture_output=True, text=True, timeout=15)
        assert settings.returncode == 0, settings.stderr
        assert json.loads(settings.stdout)["result"]["running"]
        attached_master, attached_slave = pty.openpty()
        attached = subprocess.Popen([str(executable), "launch", "--data-dir", str(data), "--lang", "en"],
                                    stdin=attached_slave, stdout=attached_slave, stderr=attached_slave)
        os.close(attached_slave)
        output = wait_text(attached_master, b"q: exit")
        assert b"Attached to the existing server" in output
        os.write(attached_master, b"q\n")
        assert attached.wait(timeout=15) == 0
        assert service.poll() is None
        os.write(master, b"q\n")
        assert service.wait(timeout=15) == 0
        assert not (data / "server.lock").exists()
    finally:
        for process in [attached, service]:
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        os.close(master)
        if attached_master is not None:
            os.close(attached_master)
print("PASS: packaged launch PTY, pairing invitation, existing service reuse and clean quit (offline network fixture)")
