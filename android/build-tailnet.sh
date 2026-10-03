#!/usr/bin/env bash
set -euo pipefail
: "${ANDROID_HOME:?Set ANDROID_HOME first}"
: "${JAVA_HOME:?Set JAVA_HOME to JDK 17}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/27.2.12479018}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/tailnet"
export PATH="$JAVA_HOME/bin:$(go env GOPATH)/bin:$PATH"
go install golang.org/x/mobile/cmd/gomobile@v0.0.0-20260908204917-8b95e45f8d3e
go install golang.org/x/mobile/cmd/gobind@v0.0.0-20260908204917-8b95e45f8d3e
go test ./...
mkdir -p "$script_dir/app/libs"
gomobile bind -target="${TARGETS:-android/arm64,android/amd64}" -androidapi 26 -ldflags '-s -w' -o "$script_dir/app/libs/tailnet.aar" .
pwsh -NoProfile -File "$script_dir/tailnet/notices.ps1"
