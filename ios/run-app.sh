#!/bin/bash
# Builds one of the two iOS apps for the simulator and runs it there.
#
#   ./ios/run-app.sh              # the client (default)
#   ./ios/run-app.sh client
#   ./ios/run-app.sh diagnostics  # the three-page harness
#
# Verifying the .ipa itself needs a device. This exercises the same sources on
# the simulator, which is where everything that can be checked without one is
# checked: that the app launches, that the Keychain probe reaches an answer,
# that the node starts, and that the screens draw.
#
# The Keychain probe is expected to fail here. A bundle installed on the
# simulator is not signed with `application-identifier`, so the app falls back
# to the file store and says so on the log tab. That is the fallback path being
# exercised, not a fault — a sideloaded build on a device may take the same
# branch, which is why it exists.
set -euo pipefail
cd "$(dirname "$0")"

KIND="${1:-client}"
case "$KIND" in
  client)
    EXECUTABLE="CamelliaApp"
    BUNDLE="Camellia.app"
    BUNDLE_ID="app.camellia.mobile"
    PLIST="CamelliaApp/Info.plist"
    SOURCES=(CamelliaApp/Sources/*.swift CamelliaApp/Sources/Shared/*.swift)
    ;;
  diagnostics)
    EXECUTABLE="CamelliaTestApp"
    BUNDLE="CamelliaTestApp.app"
    BUNDLE_ID="app.camellia.mobile.diagnostics"
    PLIST="CamelliaTestApp/Info.plist"
    SOURCES=(CamelliaTestApp/Sources/*.swift)
    ;;
  *)
    echo "error: unknown target \"$KIND\"; expected client or diagnostics." >&2
    exit 1
    ;;
esac

DEVICE_NAME="${CAMELLIA_APP_DEVICE:-iPhone 16 Pro}"
FRAMEWORK="Frameworks/tailnet.xcframework/ios-arm64_x86_64-simulator"

if [ ! -d "$FRAMEWORK/Tailnet.framework" ]; then
  echo "error: $FRAMEWORK is missing; run ./ios/build-tailnet-ios.sh first." >&2
  exit 1
fi

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path 2>/dev/null)" || {
  echo "error: the iOS simulator SDK is unavailable; install Xcode." >&2
  exit 1
}
TARGET="arm64-apple-ios15.0-simulator"

UDID="${CAMELLIA_APP_UDID:-}"
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
    echo "       set CAMELLIA_APP_DEVICE to one of:" >&2
    xcrun simctl list devices available | sed -n 's/^ *\(.*\) ([0-9A-F-]*).*/         \1/p' >&2
    exit 1
  }
else
  # The explicit UDID wins over the default device name in the status line.
  DEVICE_NAME="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
wanted = sys.argv[1]
for devices in json.load(sys.stdin)["devices"].values():
    for device in devices:
        if device["udid"] == wanted and device.get("isAvailable"):
            print(device["name"])
            raise SystemExit
raise SystemExit("no available simulator with UDID " + wanted)
' "$UDID")" || exit 1
fi

echo "app:    $KIND ($EXECUTABLE)"
echo "device: $DEVICE_NAME ($UDID)"
echo "target: $TARGET"

BUILD="${TMPDIR:-/tmp}/camellia-app-$KIND"
APP="$BUILD/$BUNDLE"
rm -rf "$BUILD"
mkdir -p "$APP"

echo "compiling"
swiftc -o "$APP/$EXECUTABLE" \
  -target "$TARGET" \
  -sdk "$SDK" \
  -F "$FRAMEWORK" \
  -parse-as-library \
  CamelliaCore/Sources/*.swift \
  CamelliaCore/Remote/*.swift \
  CamelliaCore/LocalChat/*.swift \
  CamelliaCore/Camera/*.swift \
  CamelliaCore/Location/*.swift \
  CamelliaCore/Networking/*.swift \
  Support/*.swift \
  "${SOURCES[@]}"

cp "$PLIST" "$APP/Info.plist"
printf 'APPL????' > "$APP/PkgInfo"
if [ "$KIND" = "client" ]; then
  swift tools/generate-localizations.swift "$PWD/.."
  cp -R CamelliaApp/Resources/en.lproj "$APP/en.lproj"
  cp -R CamelliaApp/Resources/zh-Hans.lproj "$APP/zh-Hans.lproj"
  cp ../assets/icon-1024.png "$APP/CamelliaBrand.png"
  cp ../android/app/src/main/assets/third-party-notices.txt "$APP/third-party-notices.txt"
  cp ../android/app/src/main/assets/markdown-notices.txt "$APP/markdown-notices.txt"
fi
ICON_SOURCE="../assets/icon-1024.png"
if [ ! -f "$ICON_SOURCE" ]; then
  echo "error: $ICON_SOURCE is missing; the simulator would show a blank icon." >&2
  exit 1
fi
# Match the device IPA: iOS icons must be opaque, and iPad needs its own
# 76-point asset. Without the latter the simulator shows a grey placeholder.
swiftc -O -o "$BUILD/flatten-icon" tools/flatten-icon.swift
"$BUILD/flatten-icon" "$ICON_SOURCE" "$BUILD/icon-opaque.png"
sips -s format png -z 120 120 "$BUILD/icon-opaque.png" --out "$APP/AppIcon60x60@2x.png" >/dev/null
sips -s format png -z 180 180 "$BUILD/icon-opaque.png" --out "$APP/AppIcon60x60@3x.png" >/dev/null
sips -s format png -z 152 152 "$BUILD/icon-opaque.png" --out "$APP/AppIcon76x76@2x~ipad.png" >/dev/null

# Left unsigned for the same reason the device build is: a bundle that claims a
# restricted entitlement without a provisioning profile is refused at launch,
# and this machine has no signing identity to give it a profile.
echo "booting"
xcrun simctl boot "$UDID" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$UDID" -b >/dev/null

echo "installing"
# Updating in place preserves the simulator's pairings, drafts and local
# conversations, so a visual smoke run can also catch migration regressions.
xcrun simctl install "$UDID" "$APP"

echo "running (Ctrl-C to stop; the app stays up)"
echo "---"
exec xcrun simctl launch --console "$UDID" "$BUNDLE_ID"
