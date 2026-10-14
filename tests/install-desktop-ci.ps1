param([Parameter(Mandatory = $true)][string]$Installer)

$ErrorActionPreference = 'Stop'
# NSIS registration and desktop shortcuts belong to the disposable runner.
# Local acceptance can target an existing bundle without installing over it.
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) {
    throw 'Run NSIS installation acceptance on a disposable GitHub Actions runner.'
}
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$runnerRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
$target = [IO.Path]::GetFullPath((Join-Path $runnerRoot ('Camellia Install ' + [guid]::NewGuid().ToString('N'))))
if (-not $target.StartsWith($runnerRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The test installation must stay inside RUNNER_TEMP.'
}
# NSIS /D is last and takes the remainder verbatim, including spaces.
$installed = Start-Process -FilePath $installerPath -ArgumentList "/S /currentuser /D=$target" -WindowStyle Hidden -PassThru
if (-not $installed.WaitForExit(180000)) {
    & taskkill /PID $installed.Id /T /F | Out-Null
    throw 'NSIS did not complete within three minutes.'
}
if ($installed.ExitCode -ne 0) { throw "NSIS exited with $($installed.ExitCode)." }
foreach ($file in @('Camellia.exe', 'resources/app.asar', 'resources/runtime/node.exe', 'Uninstall Camellia.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $target $file) -PathType Leaf)) { throw "Missing installed file: $file" }
}
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Camellia.lnk'
if (-not (Test-Path -LiteralPath $shortcut -PathType Leaf)) { throw 'The installer did not create its desktop shortcut.' }
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
if ([IO.Path]::GetFullPath($link.TargetPath) -ine (Join-Path $target 'Camellia.exe')) {
    throw 'The installed shortcut points to another executable.'
}
"bundle=$target" | Out-File -LiteralPath $env:GITHUB_OUTPUT -Encoding utf8 -Append
"shortcut=$shortcut" | Out-File -LiteralPath $env:GITHUB_OUTPUT -Encoding utf8 -Append
Write-Output "PASS: NSIS installed the release artifact and created its desktop shortcut at $target"
