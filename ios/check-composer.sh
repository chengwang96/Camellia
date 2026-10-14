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
codesign --force --sign - "$APP" >/dev/null

LOGS="$PWD/dist/simulator-checks"
mkdir -p "$LOGS"

xcrun simctl boot "$UDID" >/dev/null 2>&1 || true
perl -e 'alarm shift; exec @ARGV' 60 xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl install "$UDID" "$APP"

for ATTEMPT in 1 2; do
  set +e
  OUTPUT="$(perl -e 'alarm shift; exec @ARGV' 120 xcrun simctl launch --console "$UDID" app.camellia.mobile.composercheck 2>&1)"
  STATUS=$?
  set -e
  printf '%s\n' "$OUTPUT" | tee "$LOGS/composer-attempt-$ATTEMPT.log"
  if [ "$STATUS" -eq 0 ] && [[ "$OUTPUT" == *"verdict=PASS"* ]]; then
    echo "verdict: PASS"
    exit 0
  fi
  echo "simulator launch exit code: $STATUS" >&2
  perl -e 'alarm shift; exec @ARGV' 15 xcrun simctl io "$UDID" screenshot "$LOGS/composer-attempt-$ATTEMPT.png" || true
  perl -e 'alarm shift; exec @ARGV' 15 xcrun simctl spawn "$UDID" log show --last 3m --style compact \
    --predicate 'process == "CamelliaComposerCheck"' > "$LOGS/composer-attempt-$ATTEMPT-system.log" 2>&1 || true
  # Retry only a launch timeout before the app returned its verdict. Assertion
  # failures and crashes remain failures; a second missing verdict is fatal.
  if [ "$ATTEMPT" -eq 2 ] || [ "$STATUS" -ne 142 ] \
    || [[ "$OUTPUT" == *"[composer-check] starting"* ]] || [[ "$OUTPUT" == *"[composer-check] verdict="* ]]; then
    break
  fi
  echo "No composer-check verdict received; restarting the isolated simulator once." >&2
  perl -e 'alarm shift; exec @ARGV' 15 xcrun simctl terminate "$UDID" app.camellia.mobile.composercheck >/dev/null 2>&1 || true
  perl -e 'alarm shift; exec @ARGV' 30 xcrun simctl shutdown "$UDID"
  xcrun simctl boot "$UDID"
  perl -e 'alarm shift; exec @ARGV' 240 xcrun simctl bootstatus "$UDID" -b
done
echo "verdict: FAIL" >&2
exit 1
