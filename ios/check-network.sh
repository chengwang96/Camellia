#!/bin/bash
# Type-checks the networking layer against tailnet.xcframework.
#
# Split from check-protocol.sh on purpose. The protocol layer is pure Swift and
# compiles for the host; this layer imports the iOS-only Tailnet framework, so
# it can only be checked against an iOS simulator target.
#
# Needs the xcframework, and therefore Xcode:
#   ./ios/build-tailnet-ios.sh && ./ios/check-network.sh
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

# Match the target to the SDK actually installed, so a newer Xcode does not
# need this script edited.
VERSION="$(basename "$SDK" | sed -n 's/^iPhoneSimulator\([0-9][0-9.]*\)\.sdk$/\1/p')"
if [ -z "$VERSION" ]; then
  echo "error: cannot read the SDK version from $SDK" >&2
  exit 1
fi
TARGET="arm64-apple-ios${VERSION}-simulator"

echo "sdk:    $SDK"
echo "target: $TARGET"
echo "swiftc: $(swiftc --version | head -1)"

# `Remote` is host-compilable and is also checked by check-protocol.sh, but this
# layer references it and only builds against the framework, so it has to come
# along here too.
swiftc -typecheck \
  -target "$TARGET" \
  -sdk "$SDK" \
  -F "$FRAMEWORK" \
  CamelliaCore/Sources/*.swift CamelliaCore/Remote/*.swift CamelliaCore/LocalChat/*.swift CamelliaCore/Networking/*.swift

echo "PASS: the networking layer type-checks against tailnet.xcframework"
