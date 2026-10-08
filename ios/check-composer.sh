#!/bin/bash
# Run the production UITextView delegate's send/newline cases in an iOS Simulator.
set -euo pipefail
cd "$(dirname "$0")"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
TARGET="arm64-apple-ios15.0-simulator"
DEVICE_NAME="${CAMELLIA_COMPOSER_DEVICE:-iPhone 16 Pro}"
UDID="${CAMELLIA_COMPOSER_UDID:-}"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
wanted = sys.argv[1]
for runtime, devices in json.load(sys.stdin)["devices"].items():
    if "iOS" in runtime:
        for device in devices:
            if device["name"] == wanted and device.get("isAvailable"):
                print(device["udid"])
                raise SystemExit
raise SystemExit("no available simulator named " + wanted)
' "$DEVICE_NAME")"
fi

BUILD="$(mktemp -d "${TMPDIR:-/tmp}/camellia-composer-check.XXXXXX")"
trap 'rm -rf "$BUILD"' EXIT
APP="$BUILD/CamelliaComposerCheck.app"
mkdir -p "$APP"

swiftc -o "$APP/CamelliaComposerCheck" -target "$TARGET" -sdk "$SDK" \
  CamelliaApp/Sources/Shared/Palette.swift \
  CamelliaApp/Sources/Shared/ComposerField.swift \
  ComposerCheck/main.swift
cp ComposerCheck/Info.plist "$APP/Info.plist"

xcrun simctl boot "$UDID" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl install "$UDID" "$APP"

set +e
OUTPUT="$(xcrun simctl launch --console "$UDID" app.camellia.mobile.composercheck 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT"
if [ "$STATUS" -eq 0 ] && [[ "$OUTPUT" == *"verdict=PASS"* ]]; then
  echo "verdict: PASS"
  exit 0
fi
echo "verdict: FAIL" >&2
exit 1
