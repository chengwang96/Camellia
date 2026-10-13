#!/bin/bash
# Exercise the production model in an isolated iOS Simulator container.
set -euo pipefail
cd "$(dirname "$0")"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DEVICE_NAME="${CAMELLIA_REMEDIATION_DEVICE:-iPhone 16 Pro}"
UDID="${CAMELLIA_REMEDIATION_UDID:-}"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices available -j | python3 -c '
import json,sys
for runtime,devices in json.load(sys.stdin)["devices"].items():
    if "iOS" in runtime:
        for device in devices:
            if device["name"] == sys.argv[1] and device.get("isAvailable"):
                print(device["udid"]); raise SystemExit
raise SystemExit("no available simulator named " + sys.argv[1])
' "$DEVICE_NAME")"
fi
BUILD="$(mktemp -d "${TMPDIR:-/tmp}/camellia-remediation-check.XXXXXX")"
trap 'rm -rf "$BUILD"' EXIT
APP="$BUILD/CamelliaRemediationCheck.app"
FRAMEWORK="Frameworks/tailnet.xcframework/ios-arm64_x86_64-simulator"
mkdir -p "$APP"
swiftc -o "$APP/CamelliaRemediationCheck" -target arm64-apple-ios15.0-simulator -sdk "$SDK" \
  -D CAMELLIA_REMEDIATION_CHECK -parse-as-library -F "$FRAMEWORK" \
  CamelliaCore/Sources/*.swift CamelliaCore/Remote/*.swift CamelliaCore/LocalChat/*.swift \
  CamelliaCore/Camera/*.swift CamelliaCore/Location/*.swift CamelliaCore/Networking/*.swift \
  Support/*.swift CamelliaApp/Sources/*.swift CamelliaApp/Sources/Shared/*.swift RemediationCheck/main.swift
cp RemediationCheck/Info.plist "$APP/Info.plist"
cp -R CamelliaApp/Resources/. "$APP/"
cp ../assets/icon-1024.png "$APP/CamelliaBrand.png"
cp ../assets/icon-1024.png "$APP/AppIcon60x60@3x.png"
# Tailnet is a static archive, already linked into the executable. Embedding it
# as a runtime framework causes iOS 26's installer to reject the test bundle.
codesign --force --sign - "$APP" >/dev/null
if [ -n "${CAMELLIA_REMEDIATION_APP_OUT:-}" ]; then
  if [ -e "$CAMELLIA_REMEDIATION_APP_OUT" ]; then
    echo "refusing to overwrite $CAMELLIA_REMEDIATION_APP_OUT" >&2
    exit 1
  fi
  cp -R "$APP" "$CAMELLIA_REMEDIATION_APP_OUT"
fi
xcrun simctl boot "$UDID" >/dev/null 2>&1 || true
# Keep an unavailable simulator from leaving the regression job waiting forever.
perl -e 'alarm shift; exec @ARGV' 60 xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$APP"
set +e
OUTPUT="$(perl -e 'alarm shift; exec @ARGV' 240 xcrun simctl launch --console "$UDID" app.camellia.mobile.remediationcheck 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT"
if [ "$STATUS" -eq 0 ] && [[ "$OUTPUT" == *"verdict=PASS"* ]]; then
  echo "verdict: PASS"
else
  echo "verdict: FAIL" >&2
  exit 1
fi
