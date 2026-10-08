#!/bin/bash
# Compiles and runs the CamelliaCore protocol checks.
#
# Deliberately drives swiftc instead of SwiftPM: the SwiftPM manifest step
# shells out to sandbox-exec, which fails in restricted shells with
# "sandbox_apply: Operation not permitted". The Command Line Tools alone are
# enough for this, so the ported rules stay verifiable without Xcode.
set -euo pipefail
cd "$(dirname "$0")"

OUT="${TMPDIR:-/tmp}/camellia-protocol-checks"
mkdir -p "$OUT"

echo "swiftc: $(swiftc --version | head -1)"
# `Sources` is the protocol surface, `Remote` is everything built on top of it
# and `LocalChat` is the direct-to-provider chat that never touches the tunnel.
# All three are host-compilable, which is the point: the rules the desktop talks
# by get checked without a device. Anything needing the embedded Tailnet
# framework lives in `Networking` instead and is checked by check-network.sh.
# No `-O`: these checks are run on every edit and the optimiser is most of the
# wall-clock time. Nothing here is performance-sensitive.
swiftc -o "$OUT/protocol-checks" \
  CamelliaCore/Sources/*.swift \
  CamelliaCore/Remote/*.swift \
  CamelliaCore/LocalChat/*.swift \
  CamelliaCore/Tests/ProtocolChecks/main.swift

# The Office extraction is checked against archives a real ZIP writer produced,
# which needs a generator. Without python3 those checks are skipped rather than
# quietly passing.
if command -v python3 >/dev/null 2>&1; then
  export CAMELLIA_FIXTURES="$OUT/fixtures"
  python3 fixtures/office-fixtures.py "$CAMELLIA_FIXTURES"
else
  echo "note: python3 is unavailable; the Office fixture checks will be skipped"
fi

"$OUT/protocol-checks"
