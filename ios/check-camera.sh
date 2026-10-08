#!/bin/bash
# Type-checks the device-only layers that need no project: camera and location.
#
# AVFoundation, CoreLocation and SwiftUI are device-only frameworks, so unlike
# check-protocol.sh this cannot run for the host: it needs the simulator SDK and
# therefore Xcode. Nothing here touches the embedded network, so it is checked
# separately from check-network.sh rather than pulling that framework in.
set -euo pipefail
cd "$(dirname "$0")"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path 2>/dev/null)" || {
  echo "error: the iOS simulator SDK is unavailable; install Xcode." >&2
  exit 1
}

VERSION="$(basename "$SDK" | sed -n 's/^iPhoneSimulator\([0-9][0-9.]*\)\.sdk$/\1/p')"
if [ -z "$VERSION" ]; then
  echo "error: cannot read the SDK version from $SDK" >&2
  exit 1
fi

# Pinned to the deployment target rather than to the installed SDK, so an API
# that only exists on a newer iOS is an error here instead of a crash on the
# oldest device this ships to.
MINIMUM_IOS="15.0"
TARGET="arm64-apple-ios${MINIMUM_IOS}-simulator"

echo "sdk:    $SDK (${VERSION})"
echo "target: $TARGET"
echo "swiftc: $(swiftc --version | head -1)"

swiftc -typecheck \
  -target "$TARGET" \
  -sdk "$SDK" \
  CamelliaCore/Sources/*.swift CamelliaCore/Remote/*.swift CamelliaCore/LocalChat/*.swift \
  CamelliaCore/Camera/*.swift CamelliaCore/Location/*.swift

echo "PASS: the camera and location layers type-check for iOS"
