#!/bin/bash
# Builds an unsigned .ipa of one of the two iOS apps.
#
#   ./ios/build-ipa.sh              # the client (default)
#   ./ios/build-ipa.sh client
#   ./ios/build-ipa.sh diagnostics  # the three-page harness
#
# The .ipa is unsigned on purpose, because that is what both distribution paths
# this project uses need:
#
#   * TrollStore installs it as-is, checking no signature at all;
#   * Sideloadly and SideStore re-sign it with the installer's own Apple ID.
#
# Signing it here would break the first and be discarded by the second, and
# ad-hoc signing it with a restricted entitlement is worse than either: a bundle
# that claims `application-identifier` without a provisioning profile is refused
# at launch, which was measured on the simulator. See
# CamelliaTestApp/CamelliaTestApp.entitlements.
#
# Output lands in ios/dist: the .ipa, the unpacked .app (for `xcrun devicectl
# device install` or Xcode's Devices window), and a checksum file.
set -euo pipefail
cd "$(dirname "$0")"

KIND="${1:-client}"
case "$KIND" in
  client)
    EXECUTABLE="CamelliaApp"
    BUNDLE="Camellia.app"
    BUNDLE_ID="app.camellia.mobile"
    PLIST="CamelliaApp/Info.plist"
    IPA_STEM="Camellia"
    IPA_GLOB="Camellia-[0-9]*.ipa"
    # Two globs rather than one: the shared views live in a subdirectory, and a
    # single `Sources/*.swift` would silently leave every one of them out.
    SOURCES=(CamelliaApp/Sources/*.swift CamelliaApp/Sources/Shared/*.swift)
    ;;
  diagnostics)
    EXECUTABLE="CamelliaTestApp"
    BUNDLE="CamelliaTestApp.app"
    BUNDLE_ID="app.camellia.mobile.diagnostics"
    PLIST="CamelliaTestApp/Info.plist"
    IPA_STEM="Camellia-Diagnostics"
    IPA_GLOB="Camellia-Diagnostics-[0-9]*.ipa"
    SOURCES=(CamelliaTestApp/Sources/*.swift)
    ;;
  *)
    echo "error: unknown target \"$KIND\"; expected client or diagnostics." >&2
    exit 1
    ;;
esac

MINIMUM_IOS="15.0"
FRAMEWORK="Frameworks/tailnet.xcframework/ios-arm64"
ICON_SOURCE="../assets/icon-1024.png"
OUT="${CAMELLIA_IPA_OUT:-$PWD/dist}"

export DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null || true)}"

if [ ! -d "$FRAMEWORK/Tailnet.framework" ]; then
  echo "error: $FRAMEWORK is missing; run ./ios/build-tailnet-ios.sh first." >&2
  exit 1
fi

SDK="$(xcrun --sdk iphoneos --show-sdk-path 2>/dev/null)" || {
  echo "error: a full Xcode installation with the iOS device SDK is required." >&2
  echo "  active developer directory: ${DEVELOPER_DIR:-none}" >&2
  echo "  select Xcode with xcode-select or DEVELOPER_DIR." >&2
  exit 1
}
TARGET="arm64-apple-ios${MINIMUM_IOS}"

# The version comes from the repository rather than from the app's own plist:
# every Camellia client ships the same one, and a second copy of the number
# would only drift out of step with the desktop and Android releases. The
# plist keeps a placeholder, which is overwritten below.
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' ../package.json | head -1)"
if [ -z "$VERSION" ]; then
  echo "error: could not read the version from ../package.json." >&2
  exit 1
fi

echo "app:    $KIND ($EXECUTABLE)"
echo "bundle: $BUNDLE_ID $VERSION"
echo "sdk:    $SDK"
echo "target: $TARGET"
echo

BUILD="$OUT/build-$KIND"
APP="$BUILD/Payload/$BUNDLE"
rm -rf "$BUILD"
mkdir -p "$APP"

echo "compiling"
# `-parse-as-library` is required for `@main`: without it swiftc treats a file
# holding the entry point as a script and refuses the attribute.
swiftc -o "$APP/$EXECUTABLE" \
  -target "$TARGET" \
  -sdk "$SDK" \
  -F "$FRAMEWORK" \
  -O \
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
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Info.plist"
printf 'APPL????' > "$APP/PkgInfo"
if [ "$KIND" = "client" ]; then
  swift tools/generate-localizations.swift "$PWD/.."
  cp -R CamelliaApp/Resources/en.lproj "$APP/en.lproj"
  cp -R CamelliaApp/Resources/zh-Hans.lproj "$APP/zh-Hans.lproj"
  cp ../assets/icon-1024.png "$APP/CamelliaBrand.png"
  cp ../android/app/src/main/assets/third-party-notices.txt "$APP/third-party-notices.txt"
  cp ../android/app/src/main/assets/markdown-notices.txt "$APP/markdown-notices.txt"
fi

echo "icons"
if [ ! -f "$ICON_SOURCE" ]; then
  echo "error: $ICON_SOURCE is missing; refusing to package a blank icon." >&2
  exit 1
fi
# The shared artwork is a rounded square sitting inside a transparent canvas,
# which is what a launcher that composites its own background wants. iOS does
# not: it draws the icon as an opaque square and fills every transparent pixel
# with black, so the canvas margin shows up as a black ring around the icon.
# It is composited over its own background once, here, and the resize is done
# from that instead. `sips` cannot flatten, so the helper does it. A failed
# flatten must fail the package rather than silently reintroduce that bug.
swiftc -O -o "$BUILD/flatten-icon" tools/flatten-icon.swift
"$BUILD/flatten-icon" "$ICON_SOURCE" "$BUILD/icon-opaque.png"
# Loose PNGs rather than an asset catalog: assembling a `Assets.car` needs
# actool and an Xcode project, and iOS still honours the older
# `CFBundleIconFiles` layout for a sideloaded bundle.
sips -s format png -z 120 120 "$BUILD/icon-opaque.png" --out "$APP/AppIcon60x60@2x.png" >/dev/null
sips -s format png -z 180 180 "$BUILD/icon-opaque.png" --out "$APP/AppIcon60x60@3x.png" >/dev/null
sips -s format png -z 152 152 "$BUILD/icon-opaque.png" --out "$APP/AppIcon76x76@2x~ipad.png" >/dev/null

echo "verifying"
# A simulator or macOS binary would install nowhere, and the failure at that
# point is a silent refusal on the device rather than an error here.
PLATFORM="$(vtool -show-build "$APP/$EXECUTABLE" 2>/dev/null | awk '/platform/ {print $2}' | head -1)"
if [ "$PLATFORM" != "IOS" ]; then
  echo "error: the binary is not a device build (platform=${PLATFORM:-unknown})." >&2
  exit 1
fi
if [ "$(lipo -archs "$APP/$EXECUTABLE")" != "arm64" ]; then
  echo "error: unexpected architectures: $(lipo -archs "$APP/$EXECUTABLE")" >&2
  exit 1
fi
if [ -e "$APP/_CodeSignature" ]; then
  echo "error: the bundle is signed; this script produces an unsigned .ipa." >&2
  exit 1
fi

echo "packaging"
IPA="$OUT/$IPA_STEM-$VERSION.ipa"
# Older builds would otherwise sit beside the new one carrying a stale number,
# which is the confusion a single shared version is meant to prevent.
#
# The glob is anchored on a digit rather than left as `Camellia-*.ipa`, because
# that looser pattern also matches `Camellia-Diagnostics-0.4.0.ipa` and building
# the client would delete the harness build sitting beside it.
shopt -s nullglob
old_ipas=("$OUT"/$IPA_GLOB)
shopt -u nullglob
if ((${#old_ipas[@]})); then rm -f -- "${old_ipas[@]}"; fi
# `-y` keeps symlinks as symlinks; the payload of this app has none, but a
# zip that follows them would silently duplicate a large framework into any
# future build that embeds one.
(cd "$BUILD" && zip -qry "$IPA" Payload)

rm -rf "$OUT/$BUNDLE"
cp -R "$APP" "$OUT/$BUNDLE"

echo
echo "done"
echo "  ipa:  $IPA"
echo "  app:  $OUT/$BUNDLE"
du -h "$IPA" | awk '{print "  size: " $1}'
(cd "$OUT" && shasum -a 256 "$IPA_STEM-$VERSION.ipa") \
  | tee "$OUT/SHA256-$KIND.txt" | awk '{print "  sha256: " $1}'
