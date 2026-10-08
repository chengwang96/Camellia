#!/bin/bash
# Regenerates the bundled third-party notices from the verified module cache.
#
# The macOS counterpart of tailnet/notices.ps1. It reads the same
# `go list -m -json all` output and writes the same
# app/src/main/assets/third-party-notices.txt, so the notice text does not
# depend on which machine built the AAR. Run from build-tailnet.sh; the only
# reason it is a separate file is that it needs no Android toolchain and is
# occasionally useful on its own.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODULE="$ROOT/tailnet"
TARGET="$ROOT/app/src/main/assets/third-party-notices.txt"

export PATH="$HOME/sdk/go1.26.3/bin:$HOME/go/bin:$PATH"
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
export GOSUMDB=off
export GOTOOLCHAIN=local
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy

cd "$MODULE"

# One JSON object per line. The license file names are matched the way the
# PowerShell version matches them: LICENSE / COPYING / NOTICE with any
# extension, at the top of the module directory only.
python3 - "$TARGET" <<'PYTHON'
import json
import os
import re
import subprocess
import sys

target = sys.argv[1]
pattern = re.compile(r"^(LICENSE|COPYING|NOTICE)(\..*)?$", re.IGNORECASE)

# `go list -m -json all` prints one pretty-printed JSON object per module with
# no separator between them, so the stream has to be closed and reopened into a
# single array. The PowerShell original does the same with a `},{` replace;
# doing it with a string replace would corrupt any `},{` that appeared inside a
# path or a version, so the boundary is matched on a `}` at the start of a line.
raw = subprocess.check_output(["go", "list", "-m", "-json", "all"], text=True)
modules = json.loads("[" + re.sub(r"\}\s*\n\s*\{", "},{", raw.strip()) + "]")

out = [
    "Camellia embedded networking — third-party notices",
    "Tailscale is a separate service. Camellia is not an official Tailscale application.",
]

# The license file names are matched the way the PowerShell version matches
# them: LICENSE / COPYING / NOTICE with any extension, at the top of the module
# directory only.
count = 0
for module in modules:
    if module.get("Main") or not module.get("Dir"):
        continue
    for name in sorted(os.listdir(module["Dir"])):
        if not pattern.match(name):
            continue
        path = os.path.join(module["Dir"], name)
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8", errors="replace") as handle:
            out.append(f"\n=== {module['Path']} {module.get('Version', '')} / {name} ===")
            out.append(handle.read())
        count += 1

os.makedirs(os.path.dirname(target), exist_ok=True)
# A trailing newline, because the PowerShell original ends every line it appends
# with one and the file is committed: without it the same build produces a
# one-byte diff on a 460 KB file, which reads as a change to a license text.
with open(target, "w", encoding="utf-8") as handle:
    handle.write("\n".join(out) + "\n")

print(f"notices: {len(modules)} modules, {count} license files -> {target}")
PYTHON
