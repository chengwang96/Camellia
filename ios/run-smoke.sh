#!/bin/bash
# Builds the S1 smoke test and runs it in the iOS Simulator.
#
# Answers the one question the desktop could not: does the embedded tsnet node
# start and reach the Tailscale control plane inside the iOS sandbox?
#
#   ./ios/run-smoke.sh                          first run, drives the sign-in
#   ./ios/run-smoke.sh --reset                  forget the stored node first
#   CAMELLIA_SMOKE_TARGET=http://100.x.x.x:43127/v1/status \
#   CAMELLIA_SMOKE_TOKEN=<43 chars> ./ios/run-smoke.sh
#                                               also dial the desktop gateway
#
# A run that needs a sign-in prints the authorisation URL and then keeps the
# node up for two minutes so the sign-in can be completed while it waits:
#
#   xcrun simctl openurl booted <the printed login-url>
#
# CAMELLIA_SMOKE_LOGIN_WAIT changes that window. CAMELLIA_INJECT_INTERFACES=1
# switches the node to the Android interface injection path for comparison.
set -euo pipefail
cd "$(dirname "$0")"

DEVICE_NAME="${CAMELLIA_SMOKE_DEVICE:-iPhone 16 Pro}"
BUNDLE_ID="app.camellia.mobile.smoke"
FRAMEWORK="Frameworks/tailnet.xcframework/ios-arm64_x86_64-simulator"

RESET=0
for argument in "$@"; do
  case "$argument" in
    --reset) RESET=1 ;;
    *) echo "error: unknown argument $argument" >&2; exit 2 ;;
  esac
done

if [ ! -d "$FRAMEWORK/Tailnet.framework" ]; then
  echo "error: $FRAMEWORK is missing; run ./ios/build-tailnet-ios.sh first." >&2
  exit 1
fi

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path 2>/dev/null)" || {
  echo "error: the iOS simulator SDK is unavailable; install Xcode." >&2
  exit 1
}
VERSION="$(basename "$SDK" | sed -n 's/^iPhoneSimulator\([0-9][0-9.]*\)\.sdk$/\1/p')"
TARGET="arm64-apple-ios${VERSION}-simulator"

UDID="${CAMELLIA_SMOKE_UDID:-}"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
wanted = sys.argv[1]
listing = json.load(sys.stdin)
for runtime, devices in sorted(listing["devices"].items()):
    if "iOS" not in runtime:
        continue
    for device in devices:
        if device["name"] == wanted and device.get("isAvailable"):
            print(device["udid"])
            raise SystemExit
raise SystemExit("no available simulator named " + wanted)
' "$DEVICE_NAME")" || {
    echo "error: no available simulator named \"$DEVICE_NAME\"." >&2
    echo "       set CAMELLIA_SMOKE_DEVICE to one of:" >&2
    xcrun simctl list devices available | sed -n 's/^ *\(.*\) ([0-9A-F-]*).*/         \1/p' >&2
    exit 1
  }
fi

echo "device: $DEVICE_NAME ($UDID)"
echo "target: $TARGET"

BUILD="${TMPDIR:-/tmp}/camellia-smoke"
rm -rf "$BUILD"
mkdir -p "$BUILD"

echo "compiling"
swiftc -o "$BUILD/CamelliaSmoke" \
  -target "$TARGET" \
  -sdk "$SDK" \
  -F "$FRAMEWORK" \
  CamelliaCore/Sources/*.swift CamelliaCore/Remote/*.swift CamelliaCore/LocalChat/*.swift CamelliaCore/Networking/*.swift Support/*.swift SmokeTest/Sources/*.swift

APP="$BUILD/CamelliaSmoke.app"
mkdir -p "$APP"
cp "$BUILD/CamelliaSmoke" "$APP/CamelliaSmoke"
cp SmokeTest/Info.plist "$APP/Info.plist"

# The bundle is deliberately left unsigned.
#
# Signing it ad-hoc with the `application-identifier` entitlement the Keychain
# wants makes the simulator refuse to launch it ("denied by service delegate
# SBMainWorkspace"), because a restricted entitlement needs a provisioning
# profile and this machine has no signing identity. Launching then only works
# unsigned, and an unsigned bundle cannot use the Keychain — which is why the
# harness swaps in FileNodeStateStore and the Keychain stays the shipping store.
# `SmokeTest/CamelliaSmoke.entitlements` records the entitlement a signed build
# gets for free.

echo "booting"
xcrun simctl boot "$UDID" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$UDID" -b >/dev/null

echo "installing"
# Always replace: a bundle left over from an earlier signature can make the
# launch fail in a way that looks like a code problem.
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl install "$UDID" "$APP"

# simctl forwards SIMCTL_CHILD_-prefixed variables into the app's environment.
if [ "$RESET" = "1" ]; then
  export SIMCTL_CHILD_CAMELLIA_SMOKE_RESET=1
  echo "reset:   yes (the stored node identity will be discarded)"
else
  unset SIMCTL_CHILD_CAMELLIA_SMOKE_RESET || true
fi
if [ -n "${CAMELLIA_SMOKE_TARGET:-}" ]; then
  export SIMCTL_CHILD_CAMELLIA_SMOKE_TARGET="$CAMELLIA_SMOKE_TARGET"
fi
if [ -n "${CAMELLIA_SMOKE_TOKEN:-}" ]; then
  export SIMCTL_CHILD_CAMELLIA_SMOKE_TOKEN="$CAMELLIA_SMOKE_TOKEN"
fi
if [ -n "${CAMELLIA_INJECT_INTERFACES:-}" ]; then
  export SIMCTL_CHILD_CAMELLIA_INJECT_INTERFACES="$CAMELLIA_INJECT_INTERFACES"
fi
# Only a run that has to wait for an interactive sign-in needs this.
if [ -n "${CAMELLIA_SMOKE_LOGIN_WAIT:-}" ]; then
  export SIMCTL_CHILD_CAMELLIA_SMOKE_LOGIN_WAIT="$CAMELLIA_SMOKE_LOGIN_WAIT"
fi

echo "running"
echo "---"
set +e
OUTPUT="$(xcrun simctl launch --console "$UDID" "$BUNDLE_ID" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT"
echo "---"
echo "simctl exit status: $STATUS"

# `simctl launch --console` reports whether the launch succeeded, not how the
# app exited, so the app's own verdict line decides this script's status.
if printf '%s' "$OUTPUT" | grep -q "verdict=PASS"; then
  echo "verdict: PASS"
  exit 0
fi
echo "verdict: FAIL"
exit 1
