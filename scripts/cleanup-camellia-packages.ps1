$ErrorActionPreference = 'Stop'

$dist = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist'))
$keepDirectories = @(
  [System.IO.Path]::GetFullPath((Join-Path $dist 'Camellia-current')),
  [System.IO.Path]::GetFullPath((Join-Path $dist 'release-current'))
)

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'Camellia.exe' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Sleep -Milliseconds 800

$packageDirectories = Get-ChildItem -LiteralPath $dist -Directory | Where-Object {
  $directory = [System.IO.Path]::GetFullPath($_.FullName)
  if ($keepDirectories -contains $directory) { return $false }
  Test-Path -LiteralPath (Join-Path $directory 'win-unpacked\Camellia.exe')
}

$legacyUnpackedDirectories = Get-ChildItem -LiteralPath $dist -Directory | Where-Object {
  $directory = [System.IO.Path]::GetFullPath($_.FullName)
  if ($keepDirectories -contains $directory) { return $false }
  Test-Path -LiteralPath (Join-Path $directory 'Camellia.exe')
}

$releaseFiles = Get-ChildItem -LiteralPath $dist -File | Where-Object {
  $_.Name -match '^Camellia-.*\.(exe|zip|blockmap)$' -or
  $_.Name -in @('latest.yml', 'builder-debug.yml', 'builder-effective-config.yaml')
}

$targets = @($packageDirectories.FullName) + @($legacyUnpackedDirectories.FullName) + @($releaseFiles.FullName)
foreach ($target in $targets | Sort-Object -Unique) {
  $resolved = [System.IO.Path]::GetFullPath($target)
  if (-not $resolved.StartsWith($dist + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe cleanup target: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
  Write-Output "Removed: $resolved"
}

$shortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Camellia.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
  Write-Output "Removed: $shortcutPath"
}
