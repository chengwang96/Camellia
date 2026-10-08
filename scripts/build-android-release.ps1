param([switch]$SkipTailnet, [switch]$SizeBaseline, [switch]$ReleaseTests, [string]$OutputDirectory)

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
if ($SizeBaseline -and $ReleaseTests) { throw 'Baseline measurement and optimized Release tests are separate builds.' }
if ($SizeBaseline -and -not $OutputDirectory) { throw 'A baseline requires an explicit output directory.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'dist' }
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
    $arguments = @('assembleRelease', "-PcamelliaSplitApks=$(-not $SizeBaseline)", "-PcamelliaSizeBaseline=$([bool]$SizeBaseline)")
    if ($ReleaseTests) { $arguments += @('-PcamelliaReleaseSmoke=true', ':app:assembleReleaseAndroidTest') }
    & (Join-Path $androidDir 'gradlew.bat') @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Android release build failed.' }
} finally { Pop-Location }

$releaseDir = Join-Path $androidDir 'app/build/outputs/apk/release'
$metadata = Get-Content -LiteralPath (Join-Path $releaseDir 'output-metadata.json') -Raw | ConvertFrom-Json
if ($metadata.variantName -ne 'release' -or $metadata.elements.Count -ne $(if ($SizeBaseline) { 1 } else { 2 })) { throw 'Unexpected Android release output metadata.' }

$buildTools = Join-Path $env:ANDROID_HOME 'build-tools/35.0.0'
$apksigner = Join-Path $buildTools 'apksigner.bat'
$aapt = Join-Path $buildTools 'aapt.exe'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$outputs = @()
$releaseCertificate = $null
foreach ($element in $metadata.elements) {
    $source = Join-Path $releaseDir $element.outputFile
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Release APK was not produced.' }
    $signingDetails = & $apksigner verify --print-certs $source
    if ($LASTEXITCODE -ne 0) { throw 'Release APK signature verification failed.' }
    $certificate = $signingDetails | Where-Object { $_ -match '^Signer #1 certificate SHA-256 digest:' } | Select-Object -First 1
    if (-not $certificate -or ($releaseCertificate -and $releaseCertificate -ne $certificate)) { throw 'Release APK certificates are missing or inconsistent.' }
    $releaseCertificate = $certificate
    $badging = & $aapt dump badging $source
    if ($LASTEXITCODE -ne 0 -or $badging -match 'application-debuggable') { throw 'Release APK is debuggable or could not be inspected.' }
    & $zipalign -c -P 16 4 $source
    if ($LASTEXITCODE -ne 0) { throw 'Release APK does not meet native-library alignment requirements.' }
    $audit = & (Join-Path $PSScriptRoot 'measure-android-apk.ps1') -Path $source
    if ($audit.unreferencedBytes -lt 0 -or $audit.unreferencedBytes -gt 1MB) { throw 'Release APK contains unexpected unused ZIP payloads.' }
    if (@($audit.nativeLibraries | Where-Object compression -ne 0).Count) { throw 'Native libraries must remain uncompressed for direct loading.' }
    $abis = @($element.filters | Where-Object filterType -eq 'ABI' | ForEach-Object value)
    $abi = if ($SizeBaseline) { 'universal' } elseif ($abis.Count -eq 1 -and $abis[0] -in @('arm64-v8a', 'x86_64')) { $abis[0] } else { throw 'Unexpected release ABI output.' }
    $nativeAbis = @($audit.nativeLibraries.name | ForEach-Object { ($_ -split '/')[1] } | Sort-Object -Unique)
    if (-not $SizeBaseline -and ($nativeAbis.Count -ne 1 -or $nativeAbis[0] -ne $abi)) { throw 'Release APK contains the wrong native architecture.' }
    $outputs += [pscustomobject]@{ source = $source; abi = $abi; element = $element; audit = $audit }
}
if (-not $SizeBaseline -and (@($outputs.abi | Sort-Object -Unique).Count -ne 2)) { throw 'An architecture-specific release APK is missing.' }
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
$distDir = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $distDir | Out-Null
$existing = Join-Path $distDir "Camellia-Android-$version.apk"
if (-not $SizeBaseline -and (Test-Path -LiteralPath $existing -PathType Leaf)) {
    $existingDetails = & $apksigner verify --print-certs $existing
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify the existing release before replacing it.' }
    $existingCertificate = $existingDetails | Where-Object { $_ -match '^Signer #1 certificate SHA-256 digest:' } | Select-Object -First 1
    if ($existingCertificate -ne $releaseCertificate) { throw 'The release signing key changed; the existing APK was preserved.' }
}
foreach ($output in $outputs) {
    if ($output.element.versionName -ne $version -or $output.element.versionCode -ne $metadata.elements[0].versionCode) { throw 'Release versions are inconsistent.' }
    $filename = "Camellia-Android-$version-$($output.abi).apk"
    $destination = Join-Path $distDir $filename
    Copy-Item -LiteralPath $output.source -Destination $destination -Force
    $checksum = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath ($destination + '.sha256') -Encoding ascii -Value "$checksum  $filename"
    $output.audit.path = $destination
    $output.audit | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath ($destination + '.size.json') -Encoding utf8
    Write-Output "Release APK: $destination ($($output.audit.bytes) bytes)"
    if ($output.abi -eq 'arm64-v8a') {
        $canonical = "Camellia-Android-$version.apk"
        Copy-Item -LiteralPath $destination -Destination (Join-Path $distDir $canonical) -Force
        Set-Content -LiteralPath (Join-Path $distDir ($canonical + '.sha256')) -Encoding ascii -Value "$checksum  $canonical"
    }
}
$mapping = Join-Path $androidDir 'app/build/outputs/mapping/release/mapping.txt'
if (-not $SizeBaseline -and (Test-Path -LiteralPath $mapping -PathType Leaf)) {
    Copy-Item -LiteralPath $mapping -Destination (Join-Path $distDir "Camellia-Android-$version-build$($metadata.elements[0].versionCode)-mapping.txt") -Force
}
Write-Output $releaseCertificate
} finally {
    $env:PATH = $originalPath
    if ($null -eq $originalGoPath) { Remove-Item Env:GOPATH -ErrorAction SilentlyContinue }
    else { $env:GOPATH = $originalGoPath }
    if ($loadedLocalSigning) {
        foreach ($name in $required) { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue }
    }
}
