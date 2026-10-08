#!/bin/bash
# Builds the embedded-network framework for iOS from the shared Go source.
#
# The Go bridge lives in ../android/tailnet and is selected by build constraint
# (platform_android.go / platform_ios.go), so Android and iOS never diverge.
#
# Requires a full Xcode installation: gomobile refuses to build for iOS with the
# Command Line Tools alone ("-target=ios,iossimulator requires Xcode"), because
# it needs the iOS SDK to compile the Objective-C stubs and assemble the
# xcframework.
#
# The generated framework and tool binaries stay in ios/Frameworks, outside Git.
# CI rebuilds the device and simulator slices from the shared Go source.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODULE="$ROOT/../android/tailnet"
GOMOBILE_VERSION="v0.0.0-20260908204917-8b95e45f8d3e"

export GOTOOLCHAIN=local

export DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null || true)}"
if ! xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1 || \
   ! xcrun --sdk iphonesimulator --show-sdk-path >/dev/null 2>&1; then
  echo "error: gomobile needs a full Xcode installation with both iOS SDKs." >&2
  echo "  active developer directory: ${DEVELOPER_DIR:-none}" >&2
  echo "  select Xcode with xcode-select or DEVELOPER_DIR." >&2
  exit 1
fi

echo "go: $(go version)"

# Always install both tools at the pinned version. An unrelated gomobile on PATH
# must not change the generated bindings or leave gobind missing on a clean runner.
TOOLS="$ROOT/Frameworks/tools"
mkdir -p "$TOOLS"
echo "installing gomobile and gobind $GOMOBILE_VERSION"
GOBIN="$TOOLS" go install "golang.org/x/mobile/cmd/gomobile@$GOMOBILE_VERSION"
GOBIN="$TOOLS" go install "golang.org/x/mobile/cmd/gobind@$GOMOBILE_VERSION"
export PATH="$TOOLS:$PATH"
cd "$MODULE"

gomobile bind \
  -target=ios,iossimulator \
  -ldflags="-s -w" \
  -o "$ROOT/Frameworks/tailnet.xcframework" \
  .

TAILSCALE_VERSION="$(go list -m -f '{{.Version}}' tailscale.com)"
printf '{"platform":"ios","tailscale":"%s","gomobile":"%s"}\n' \
  "$TAILSCALE_VERSION" "$GOMOBILE_VERSION" \
  > "$ROOT/Frameworks/tailnet-ios-version.json"

echo
echo "done: ios/Frameworks/tailnet.xcframework"
ls -la "$ROOT/Frameworks"
