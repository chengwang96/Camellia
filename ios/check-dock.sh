#!/bin/bash
# Isolated layout/pixel tests: no network, production store or touch injection.
set -euo pipefail
cd "$(dirname "$0")"
: "${CAMELLIA_DOCK_UDID:?Set CAMELLIA_DOCK_UDID to an available simulator}"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
BUILD="$(mktemp -d "${TMPDIR:-/tmp}/camellia-dock-check.XXXXXX")"
trap 'rm -rf "$BUILD"' EXIT
APP="$BUILD/CamelliaDockCheck.app"
mkdir -p "$APP"
swiftc -o "$APP/CamelliaDockCheck" -target arm64-apple-ios15.0-simulator -sdk "$SDK" \
  -parse-as-library CamelliaApp/Sources/Shared/{Palette,PlainPage,ChatDock,MobileLineIcon,ComposerPressStyle,ScrollFollowViews}.swift \
  CamelliaCore/Sources/ScrollFollow.swift DockCheck/main.swift
cp DockCheck/Info.plist "$APP/Info.plist"
codesign --force --sign - "$APP" >/dev/null
xcrun simctl install "$CAMELLIA_DOCK_UDID" "$APP"
LOGS="$PWD/dist/simulator-checks"
mkdir -p "$LOGS"
CONTAINER="$(xcrun simctl get_app_container "$CAMELLIA_DOCK_UDID" app.camellia.mobile.dockchecks data)"
RESULT="$CONTAINER/Documents/dock-result.json"
# Reinstall keeps the data container. Accept only this launch's verdict.
rm -f "$RESULT"
set +e
OUTPUT="$(perl -e 'alarm shift; exec @ARGV' 120 xcrun simctl launch --terminate-running-process --console "$CAMELLIA_DOCK_UDID" app.camellia.mobile.dockchecks 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT" | tee "$LOGS/dock-console.log"
if [ "$STATUS" -eq 0 ]; then
  for _ in {1..100}; do
    [ -f "$RESULT" ] && break
    sleep 0.1
  done
fi
if [ -f "$RESULT" ]; then cp "$RESULT" "$LOGS/dock-result.json"; fi
if [ "$STATUS" -eq 0 ] && python3 - "$RESULT" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as source:
        result = json.load(source)
    passed = isinstance(result, dict) and result.get("version") == 1 and result.get("verdict") == "PASS" \
        and isinstance(result.get("checks"), int) and result["checks"] >= 140 \
        and result.get("failures") == []
except (OSError, ValueError, TypeError):
    passed = False
raise SystemExit(0 if passed else 1)
PY
then
  echo 'verdict: PASS'
else
  echo "simulator launch exit code: $STATUS" >&2
  perl -e 'alarm shift; exec @ARGV' 15 xcrun simctl io "$CAMELLIA_DOCK_UDID" screenshot "$LOGS/dock-failure.png" || true
  perl -e 'alarm shift; exec @ARGV' 15 xcrun simctl spawn "$CAMELLIA_DOCK_UDID" log show --last 3m --style compact \
    --predicate 'process == "CamelliaDockCheck"' > "$LOGS/dock-system.log" 2>&1 || true
  echo 'verdict: FAIL' >&2
  exit 1
fi
