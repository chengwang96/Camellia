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
set +e
OUTPUT="$(perl -e 'alarm shift; exec @ARGV' 120 xcrun simctl launch --console "$CAMELLIA_DOCK_UDID" app.camellia.mobile.dockchecks 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT"
if [ "$STATUS" -ne 0 ] || [[ "$OUTPUT" != *"chat-dock layout/pixel assertions; controlled hosting, not touch input"* ]]; then
  echo 'verdict: FAIL' >&2; exit 1
fi
echo 'verdict: PASS'
