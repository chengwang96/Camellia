param([string]$Targets = 'android/arm64,android/amd64')
$ErrorActionPreference = 'Stop'
if (-not $env:ANDROID_HOME -or -not $env:JAVA_HOME) { throw 'Set ANDROID_HOME and JAVA_HOME (JDK 17) first.' }
if (-not $env:ANDROID_NDK_HOME -or
    -not (Test-Path -LiteralPath (Join-Path $env:ANDROID_NDK_HOME 'meta/platforms.json') -PathType Leaf)) {
    $env:ANDROID_NDK_HOME = Join-Path $env:ANDROID_HOME 'ndk/27.2.12479018'
}
$env:PATH = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:PATH
$module = Join-Path $PSScriptRoot 'tailnet'
$library = Join-Path $PSScriptRoot 'app/libs/tailnet.aar'
New-Item -ItemType Directory -Force (Split-Path $library) | Out-Null
$originalCgoLdflags = $env:CGO_LDFLAGS
Push-Location $module
try {
    $env:CGO_LDFLAGS = '-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384'
    $toolchain = go env GOROOT
    if ($LASTEXITCODE) { throw 'Could not resolve the Go toolchain required by android/tailnet/go.mod' }
    $env:PATH = (Join-Path $toolchain 'bin') + ';' + $env:PATH
    go install golang.org/x/mobile/cmd/gomobile@v0.0.0-20260908204917-8b95e45f8d3e
    if ($LASTEXITCODE) { throw 'gomobile install failed' }
    go install golang.org/x/mobile/cmd/gobind@v0.0.0-20260908204917-8b95e45f8d3e
    if ($LASTEXITCODE) { throw 'gobind install failed' }
    $goBin = Join-Path (go env GOPATH) 'bin'
    $env:PATH = $goBin + ';' + $env:PATH
    go test ./...
    if ($LASTEXITCODE) { throw 'Embedded network tests failed' }
    # The mobile node is a private Tailnet transport. A phone's system proxy
    # (for example a failed VPN or model proxy) must not take remote control
    # down with it, so omit Tailscale's system proxy feature in the same way
    # as the desktop helper.
    & (Join-Path $goBin 'gomobile') bind "-target=$Targets" -androidapi 26 -tags ts_omit_useproxy -ldflags '-s -w' -o $library .
    if ($LASTEXITCODE) { throw 'Embedded network build failed' }
    & (Join-Path $module 'notices.ps1')
} finally {
    if ($null -eq $originalCgoLdflags) { Remove-Item Env:CGO_LDFLAGS -ErrorAction SilentlyContinue }
    else { $env:CGO_LDFLAGS = $originalCgoLdflags }
    Pop-Location
}
