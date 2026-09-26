import argparse
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import tempfile
import time


parser = argparse.ArgumentParser(description="Linux PTY smoke test for live Camellia settings; no network or model calls")
parser.add_argument("--node", required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
entry = root / "scripts" / "camellia-server.cjs"


def wait_text(descriptor, expected, timeout=15):
    data = b""
    deadline = time.monotonic() + timeout
    while expected.encode() not in data:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([descriptor], [], [], remaining)[0]:
            raise AssertionError(f"Did not see {expected!r}: {data.decode(errors='replace')}")
        chunk = os.read(descriptor, 8192)
        if not chunk:
            raise AssertionError(f"Closed before {expected!r}: {data!r}")
        data += chunk
    return data


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


with tempfile.TemporaryDirectory(prefix="camellia-menu-") as directory:
    command = [args.node, str(entry)]
    server = subprocess.Popen(command + ["serve", "--data-dir", directory], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    menu = None
    master = slave = None
    try:
        wait_text(server.stdout.fileno(), "Local control ready")
        master, slave = pty.openpty()
        menu = subprocess.Popen(command + ["menu", "--data-dir", directory, "--lang", "en", "--ascii"],
                                stdin=slave, stdout=slave, stderr=slave, env={**os.environ, "NO_COLOR": "1"})
        os.close(slave)
        slave = None
        initial = wait_text(master, "Choose >")
        assert b"Live server settings" in initial
        assert b"\x1b[38;2" not in initial
        os.write(master, b"1\n")
        network = wait_text(master, "Choose (Enter to cancel) >")
        assert b"Tailscale: Stopped" in network
        os.write(master, b"8\n")
        warning = wait_text(master, "Type YES to confirm >")
        assert b"does not stop the service" in warning
        os.write(master, b"no\n")
        result = wait_text(master, "Choose >")
        assert b"Cancelled. No changes sent." in result
        os.write(master, b"q\n")
        assert menu.wait(timeout=10) == 0
        assert server.poll() is None
        result = subprocess.run(command + ["settings", "--data-dir", directory], capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stderr
        assert '"enabled": false' in result.stdout
        assert '"hostname": "camellia-server"' in result.stdout
        os.close(master)
        master = None
        editor = Path(directory) / 'fixture-editor'
        editor.write_text('#!/bin/sh\nprintf \'web_search="disabled"\\n\' > "$1"\n')
        editor.chmod(0o700)
        master, slave = pty.openpty()
        menu = subprocess.Popen(command + ['native-edit', '--data-dir', directory, '--editor', str(editor), '--payload', '{"engine":"codex","id":"settings"}'],
                                stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        slave = None
        wait_text(master, 'Type YES:')
        os.write(master, b'YES\n')
        wait_text(master, 'Native settings saved.')
        assert menu.wait(timeout=10) == 0
        assert 'web_search = "disabled"' in (Path(directory) / 'codex' / 'config.toml').read_text()
        server.send_signal(signal.SIGTERM)
        assert server.wait(timeout=10) == 0
        assert not (Path(directory) / "server.lock").exists()
    finally:
        if menu is not None:
            stop(menu)
        stop(server)
        if master is not None:
            os.close(master)
        if slave is not None:
            os.close(slave)
print("Linux PTY: live settings, native editor confirmation, menu exit and service shutdown passed")
