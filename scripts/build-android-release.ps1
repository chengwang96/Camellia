param([switch]$SkipTailnet)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$androidDir = Join-Path $repoRoot 'android'
$localSigningDir = Join-Path $env:USERPROFILE '.camellia/android-signing'
$localKeystore = Join-Path $localSigningDir 'camellia-release.p12'
$localPassword = Join-Path $localSigningDir 'password.dpapi'
$required = @('CAMELLIA_ANDROID_KEYSTORE', 'CAMELLIA_ANDROID_KEYSTORE_PASSWORD', 'CAMELLIA_ANDROID_KEY_ALIAS', 'CAMELLIA_ANDROID_KEY_PASSWORD')
$loadedLocalSigning = $false
$originalPath = $env:PATH
$originalGoPath = $env:GOPATH
if ($required.Where({ [Environment]::GetEnvironmentVariable($_) }).Count -eq 0 -and
    (Test-Path -LiteralPath $localKeystore -PathType Leaf) -and
    (Test-Path -LiteralPath $localPassword -PathType Leaf)) {
    $securePassword = Get-Content -LiteralPath $localPassword -Raw | ConvertTo-SecureString
    $password = [System.Net.NetworkCredential]::new('', $securePassword).Password
    $env:CAMELLIA_ANDROID_KEYSTORE = $localKeystore
    $env:CAMELLIA_ANDROID_KEYSTORE_PASSWORD = $password
    $env:CAMELLIA_ANDROID_KEY_ALIAS = 'camellia'
    $env:CAMELLIA_ANDROID_KEY_PASSWORD = $password
    $password = $null
    $loadedLocalSigning = $true
}
try {
foreach ($name in $required) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
        throw "Set $name before building a release APK."
    }
}
if (-not (Test-Path -LiteralPath $env:CAMELLIA_ANDROID_KEYSTORE -PathType Leaf)) { throw 'Release keystore file not found.' }
if ((Split-Path $env:CAMELLIA_ANDROID_KEYSTORE -Leaf) -ieq 'debug.keystore') { throw 'A debug keystore cannot sign the release APK.' }
if (-not $env:ANDROID_HOME -or -not $env:JAVA_HOME) { throw 'Set ANDROID_HOME and JAVA_HOME (JDK 17) first.' }

if (-not $SkipTailnet) {
    if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
        $localGoBin = Join-Path $repoRoot 'dist/android-tools/go/bin'
        if (-not (Test-Path -LiteralPath (Join-Path $localGoBin 'go.exe') -PathType Leaf)) {
            throw 'Go is required to rebuild Tailnet. Install Go or provide the local dist/android-tools/go toolchain.'
        }
        $env:PATH = $localGoBin + ';' + $env:PATH
        $env:GOPATH = Join-Path $repoRoot 'dist/android-tools/gopath'
    }
    & (Join-Path $androidDir 'build-tailnet.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Tailnet build failed.' }
}

Push-Location $androidDir
try {
    & (Join-Path $androidDir 'gradlew.bat') assembleRelease
    if ($LASTEXITCODE -ne 0) { throw 'Android release build failed.' }
} finally { Pop-Location }

$releaseDir = Join-Path $androidDir 'app/build/outputs/apk/release'
$metadata = Get-Content -LiteralPath (Join-Path $releaseDir 'output-metadata.json') -Raw | ConvertFrom-Json
if ($metadata.variantName -ne 'release' -or $metadata.elements.Count -ne 1) { throw 'Unexpected Android release output metadata.' }
$source = Join-Path $releaseDir $metadata.elements[0].outputFile
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Release APK was not produced.' }

$buildTools = Join-Path $env:ANDROID_HOME 'build-tools/35.0.0'
$apksigner = Join-Path $buildTools 'apksigner.bat'
$aapt = Join-Path $buildTools 'aapt.exe'
$signingDetails = & $apksigner verify --print-certs $source
if ($LASTEXITCODE -ne 0) { throw 'Release APK signature verification failed.' }
$badging = & $aapt dump badging $source
if ($LASTEXITCODE -ne 0 -or $badging -match 'application-debuggable') { throw 'Release APK is debuggable or could not be inspected.' }

$releaseCertificate = $signingDetails | Where-Object { $_ -match '^Signer #1 certificate SHA-256 digest:' } | Select-Object -First 1
if (-not $releaseCertificate) { throw 'Could not read the release signing certificate.' }
$debugApk = Join-Path $androidDir 'app/build/outputs/apk/debug/app-debug.apk'
if (Test-Path -LiteralPath $debugApk) {
    # Capture the full output before filtering: piping straight into Select-Object
    # -First 1 stops the pipeline early, which can leave $LASTEXITCODE unset and
    # make the check below fail even when apksigner succeeded.
    $debugSigningDetails = & $apksigner verify --print-certs $debugApk
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the debug APK certificate.' }
    $debugCertificate = $debugSigningDetails |
        Where-Object { $_ -match '^Signer #1 certificate SHA-256 digest:' } | Select-Object -First 1
    if (-not $debugCertificate) { throw 'Could not read the debug signing certificate.' }
    if ($releaseCertificate -and $releaseCertificate -eq $debugCertificate) { throw 'Release APK uses the debug signing certificate.' }
}

$version = $metadata.elements[0].versionName
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$') { throw 'Unexpected Android version name.' }
$filename = "Camellia-Android-$version.apk"
$distDir = Join-Path $repoRoot 'dist'
New-Item -ItemType Directory -Force $distDir | Out-Null
$destination = Join-Path $distDir $filename
Copy-Item -LiteralPath $source -Destination $destination -Force
$checksum = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath ($destination + '.sha256') -Encoding ascii -Value "$checksum  $filename"
Write-Output "Release APK: $destination"
Write-Output "SHA-256: $checksum"
Write-Output $releaseCertificate
} finally {
    $env:PATH = $originalPath
    if ($null -eq $originalGoPath) { Remove-Item Env:GOPATH -ErrorAction SilentlyContinue }
    else { $env:GOPATH = $originalGoPath }
    if ($loadedLocalSigning) {
        foreach ($name in $required) { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue }
    }
}
