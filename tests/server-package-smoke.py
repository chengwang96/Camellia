import argparse
import hashlib
import json
from pathlib import Path
import select
import subprocess
import tarfile
import tempfile

parser = argparse.ArgumentParser(description="Validate a Linux server archive without tailnet or model requests")
parser.add_argument("archive")
args = parser.parse_args()
archive = Path(args.archive).resolve()
expected = Path(str(archive) + ".sha256").read_text().split()[0]
assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected
with tempfile.TemporaryDirectory(prefix="camellia-dist-test-") as temporary:
    directory = Path(temporary)
    with tarfile.open(archive) as package:
        for member in package.getmembers():
            assert not member.name.startswith("/") and ".." not in Path(member.name).parts
            assert "node_modules/electron/" not in member.name
        package.extractall(directory, filter="data")
    root = directory / "camellia-server"
    executable = root / "camellia"
    assert (root / "runtime/NODE-LICENSE").is_file()
    assert (root / "build/runtime-assets/TAILNET-NOTICES.txt").is_file()
    result = subprocess.run([str(executable), "--help"], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert "Camellia" in result.stdout
    helper = subprocess.run([str(root / "build/runtime-assets/camellia-tailnet")], input='{"id":1,"action":"status"}\n', capture_output=True, text=True, timeout=20)
    assert helper.returncode == 0
    assert "network not initialized" in helper.stdout
    data = directory / "data"
    service = subprocess.Popen([str(executable), "serve", "--data-dir", str(data)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        output = b""
        while b"Local control ready" not in output:
            assert select.select([service.stdout], [], [], 20)[0], "Server did not become ready"
            chunk = service.stdout.read1(8192)
            assert chunk, service.stderr.read().decode()
            output += chunk
        def command(action, payload=None):
            arguments = [str(executable), action, "--data-dir", str(data)]
            if payload:
                arguments += ["--payload", json.dumps(payload)]
            result = subprocess.run(arguments, capture_output=True, text=True, timeout=20)
            assert result.returncode == 0, result.stderr
            return json.loads(result.stdout)
        settings = command("settings")["result"]
        assert settings["network"]["state"] == "Stopped"
        assert set(engine["id"] for engine in settings["engines"]) == {"claude", "codex", "kimi", "dsh", "antigravity"}
        assert command("create-conversation", {"engine": "codex"})["ok"]
        assert len(command("conversations")["result"]) == 1
    finally:
        service.terminate()
        try:
            service.wait(timeout=15)
        except subprocess.TimeoutExpired:
            service.kill()
            service.wait(timeout=5)
    assert service.returncode == 0
    assert not (data / "server.lock").exists()
print("Linux archive: checksum, no Electron, bundled Node/helper, control and shutdown passed")
