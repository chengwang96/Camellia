param(
    [string]$Serial,
    [int[]]$Dps = @(360, 393, 412),
    [string[]]$FontScales = @('1.0', '1.3')
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$adb = Join-Path $repoRoot 'dist/android-tools/sdk/platform-tools/adb.exe'
$debugApk = Join-Path $repoRoot 'android/app/build/outputs/apk/debug/app-debug.apk'
$testApk = Join-Path $repoRoot 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'
$output = Join-Path $repoRoot 'build/android-workbench-screens'
$runner = 'app.camellia.mobile.test/android.test.InstrumentationTestRunner'

if (-not (Test-Path -LiteralPath $adb)) { throw 'adb was not found in the local Android SDK.' }
if (-not (Test-Path -LiteralPath $debugApk)) { throw 'Build the debug APK first.' }
if (-not (Test-Path -LiteralPath $testApk)) { throw 'Build the AndroidTest APK first.' }

$sizes = @($Dps | ForEach-Object { @{ Dp = $_; Pixels = [int]($_ * 3); Height = [int][Math]::Round($_ * 3 * 20 / 9) } })

New-Item -ItemType Directory -Force $output | Out-Null
$deviceArgs = @()
if ($Serial) { $deviceArgs = @('-s', $Serial) }

& $adb @deviceArgs install -r $debugApk | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Could not install the debug APK.' }
& $adb @deviceArgs install -r $testApk | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Could not install the AndroidTest APK.' }

try {
    foreach ($size in $sizes) {
        foreach ($fontScale in $fontScales) {
            & $adb @deviceArgs shell wm size "$($size.Pixels)x$($size.Height)" | Out-Host
            & $adb @deviceArgs shell wm density 480 | Out-Host
            & $adb @deviceArgs shell settings put system font_scale $fontScale | Out-Host
            & $adb @deviceArgs shell pm clear app.camellia.mobile | Out-Host
            $destination = Join-Path $output ("{0}dp-font{1}" -f $size.Dp, $fontScale)
            New-Item -ItemType Directory -Force $destination | Out-Null
            $instrument = & $adb @deviceArgs shell am instrument -w -r `
                -e class app.camellia.mobile.WorkbenchVisualCaptureTest $runner
            $instrument | Out-Host
            if ($LASTEXITCODE -ne 0 -or ($instrument -join "`n") -notmatch 'OK \(') {
                throw "Workbench visual capture failed at $($size.Dp)dp / font $fontScale."
            }
            & $adb @deviceArgs pull '/sdcard/Android/data/app.camellia.mobile/files/workbench-visuals/.' $destination | Out-Host
            if ($LASTEXITCODE -ne 0) { throw "Could not pull screenshots for $($size.Dp)dp." }
        }
    }
} finally {
    & $adb @deviceArgs shell settings put system font_scale 1.0 | Out-Null
    & $adb @deviceArgs shell wm size reset | Out-Null
    & $adb @deviceArgs shell wm density reset | Out-Null
}

Write-Output "Workbench screenshots: $output"
