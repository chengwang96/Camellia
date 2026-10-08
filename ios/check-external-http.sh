#!/bin/bash
# Runs the system-VPN HTTP transport against a URLProtocol stub on the host.
set -euo pipefail
cd "$(dirname "$0")"

OUT="${TMPDIR:-/tmp}/camellia-external-http-checks"
mkdir -p "$OUT"
swiftc -o "$OUT/external-http-checks" \
  CamelliaCore/Networking/ExternalHTTP.swift \
  CamelliaCore/Tests/ExternalHTTPChecks/main.swift
"$OUT/external-http-checks"
