param(
    [Parameter(Mandatory = $true)][ValidatePattern('^emulator-\d+$')][string]$Serial,
    [string[]]$Profiles = @(),
    [string[]]$FontScales = @('1.0', '1.3'),
    [ValidateSet('gestural', 'threebutton')][string[]]$NavigationModes = @('gestural', 'threebutton'),
    [string]$OutputDirectory,
    [string]$AdbPath
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not $AdbPath) { $AdbPath = Join-Path $repoRoot 'dist/android-tools/sdk/platform-tools/adb.exe' }
function Invoke-Adb {
    param([string[]]$Arguments)
    $output = & $AdbPath -s $Serial @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "ADB failed ($LASTEXITCODE): $($Arguments -join ' ')`n$($output -join "`n")" }
    return $output
}
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'build/modern-settings-qa/matrix' }
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
if ((Invoke-Adb -Arguments @('shell', 'getprop', 'ro.kernel.qemu') | Out-String).Trim() -ne '1') { throw 'A disposable emulator is required.' }
$catalog = Get-Content -LiteralPath (Join-Path $repoRoot 'android/test-devices/modern-phones-2025-2026.json') -Raw | ConvertFrom-Json
$devices = @($catalog.profiles | Where-Object { -not $Profiles.Count -or $_.id -in $Profiles })
if (-not $devices.Count) { throw 'No matching modern screen profiles.' }
if (-not $FontScales.Count -or -not $NavigationModes.Count) { throw 'At least one font scale and navigation mode is required.' }
foreach ($profile in $Profiles) {
    if ($profile -notin $devices.id) { throw "Unknown modern screen profile: $profile" }
}
foreach ($font in $FontScales) {
    if ($font -notmatch '^\d+(\.\d+)?$' -or [double]::Parse($font, [cultureinfo]::InvariantCulture) -le 0) { throw "Invalid font scale: $font" }
}
$originalSize = (Invoke-Adb -Arguments @('shell', 'wm', 'size') | Out-String)
$originalSize = if ($originalSize -match 'Override size:\s*(\d+x\d+)') { $Matches[1] } else { 'reset' }
$originalDensity = (Invoke-Adb -Arguments @('shell', 'wm', 'density') | Out-String)
$originalDensity = if ($originalDensity -match 'Override density:\s*(\d+)') { $Matches[1] } else { 'reset' }
$originalFont = (Invoke-Adb -Arguments @('shell', 'settings', 'get', 'system', 'font_scale') | Out-String).Trim()
if ($originalFont -ne 'null' -and $originalFont -notmatch '^\d+(\.\d+)?$') { throw 'Cannot read the original font scale.' }
$originalNav = @(Invoke-Adb -Arguments @('shell', 'cmd', 'overlay', 'list') | ForEach-Object {
    if ($_ -match '^\s*\[([x ])\]\s+(com\.android\.internal\.systemui\.navbar\.\S+)\s*$') {
        [pscustomobject]@{ overlay = $Matches[2]; enabled = $Matches[1] -eq 'x' }
    }
})
foreach ($mode in $NavigationModes) {
    if ("com.android.internal.systemui.navbar.$mode" -notin $originalNav.overlay) { throw "Navigation overlay is unavailable: $mode" }
}
$records = @()
'[]' | Set-Content -LiteralPath (Join-Path $OutputDirectory 'results.json') -Encoding utf8
$failure = $null
try {
    foreach ($device in $devices) {
        Invoke-Adb -Arguments @('shell', 'wm', 'size', "$($device.width)x$($device.height)") | Out-Null
        Invoke-Adb -Arguments @('shell', 'wm', 'density', "$($device.density)") | Out-Null
        foreach ($font in $FontScales) {
            Invoke-Adb -Arguments @('shell', 'settings', 'put', 'system', 'font_scale', $font) | Out-Null
            foreach ($mode in $NavigationModes) {
                Invoke-Adb -Arguments @('shell', 'cmd', 'overlay', 'enable-exclusive', '--category', '--user', '0', "com.android.internal.systemui.navbar.$mode") | Out-Null
                Start-Sleep -Milliseconds 300
                $id = "$($device.id)-fs$font-$mode"
                $folder = Join-Path $OutputDirectory $id
                New-Item -ItemType Directory -Force $folder | Out-Null
                $result = Invoke-Adb -Arguments @('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.camellia.mobile.ModernSettingsLayoutTest', 'app.camellia.mobile.test/android.test.InstrumentationTestRunner')
                $result | Set-Content -LiteralPath (Join-Path $folder 'instrumentation.log') -Encoding utf8
                $passed = ($result -join "`n") -match 'OK \(1 test\)'
                if ($passed) { Invoke-Adb -Arguments @('pull', '/sdcard/Android/data/app.camellia.mobile/files/modern-settings-visuals/.', $folder) | Out-Null }
                $records += [pscustomobject]@{ profile = $device.id; width = $device.width; height = $device.height; density = $device.density; fontScale = $font; navigation = $mode; appearances = 2; passed = $passed }
                ConvertTo-Json -InputObject @($records) -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'results.json') -Encoding utf8
                if (-not $passed) { $result | Out-Host; throw "Modern settings checks failed: $id" }
                Write-Output "PASS $id (light/dark, final note and bottom-edge pixels)"
            }
        }
    }
} catch {
    $failure = $_
    throw
} finally {
    $restore = @(
        @('shell', 'wm', 'size', $originalSize),
        @('shell', 'wm', 'density', $originalDensity),
        $(if ($originalFont -eq 'null') { ,@('shell', 'settings', 'delete', 'system', 'font_scale') } else { ,@('shell', 'settings', 'put', 'system', 'font_scale', $originalFont) })
    )
    foreach ($entry in $originalNav) {
        $operation = if ($entry.enabled) { 'enable' } else { 'disable' }
        $restore += ,@('shell', 'cmd', 'overlay', $operation, '--user', '0', $entry.overlay)
    }
    $restoreErrors = @()
    foreach ($command in $restore) {
        try { Invoke-Adb -Arguments $command | Out-Null } catch { $restoreErrors += $_; Write-Warning $_ }
    }
    if ($restoreErrors.Count -and -not $failure) { throw 'Failed to restore the emulator configuration.' }
}
Write-Output "PASS: $($records.Count) viewport/font/navigation configurations, $($records.Count * 2) light/dark presentations."
