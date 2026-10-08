#!/bin/bash
# Type-checks both user-facing apps against the iOS deployment target.
#
# SwiftUI and UIKit are device-only frameworks, so unlike check-protocol.sh this
# cannot run for the host: it needs the simulator SDK and therefore Xcode. The
# embedded framework is linked rather than merely referenced — every app here
# reaches it through CamelliaCore/Networking — so the simulator slice of the
# xcframework must exist first.
#
# The check is pinned to 15.0 rather than to the installed SDK on purpose: an
# API that only exists on a newer iOS is an error here instead of a crash on the
# oldest device this ships to.
set -euo pipefail
cd "$(dirname "$0")"

FRAMEWORK="Frameworks/tailnet.xcframework/ios-arm64_x86_64-simulator"
if [ ! -d "$FRAMEWORK/Tailnet.framework" ]; then
  echo "error: $FRAMEWORK is missing; run ./ios/build-tailnet-ios.sh first." >&2
  exit 1
fi

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path 2>/dev/null)" || {
  echo "error: the iOS simulator SDK is unavailable; install Xcode." >&2
  exit 1
}
VERSION="$(basename "$SDK" | sed -n 's/^iPhoneSimulator\([0-9][0-9.]*\)\.sdk$/\1/p')"
MINIMUM_IOS="15.0"
TARGET="arm64-apple-ios${MINIMUM_IOS}-simulator"

echo "sdk:    $SDK (${VERSION})"
echo "target: $TARGET"
echo "swiftc: $(swiftc --version | head -1)"
echo

# The shared layer is identical for both; only the entry point and the screens
# differ, and each is checked so a change that only breaks one is still caught.
for pair in \
  "client:CamelliaApp" \
  "diagnostics:CamelliaTestApp"
do
  label="${pair%%:*}"
  directory="${pair##*:}"
  echo "checking $label ($directory)"
  if [ "$label" = "client" ]; then
    sources=(CamelliaApp/Sources/*.swift CamelliaApp/Sources/Shared/*.swift)
  else
    sources=(CamelliaTestApp/Sources/*.swift)
  fi
  swiftc -typecheck \
    -target "$TARGET" \
    -sdk "$SDK" \
    -F "$FRAMEWORK" \
    CamelliaCore/Sources/*.swift \
    CamelliaCore/Remote/*.swift \
    CamelliaCore/LocalChat/*.swift \
    CamelliaCore/Camera/*.swift \
    CamelliaCore/Location/*.swift \
    CamelliaCore/Networking/*.swift \
    Support/*.swift \
    "${sources[@]}"
done

echo
echo "PASS: both apps type-check for iOS ${MINIMUM_IOS}"
