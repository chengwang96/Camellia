$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $modules = (go list -m -json all) -join "`n"
    if ($LASTEXITCODE) { throw 'Cannot list dependencies' }
    $entries = ('[' + ($modules -replace '}\s*\{', '},{') + ']') | ConvertFrom-Json
    $output = [System.Text.StringBuilder]::new()
    [void]$output.AppendLine('Camellia embedded networking — third-party notices')
    [void]$output.AppendLine('Tailscale is a separate service. Camellia is not an official Tailscale application.')
    foreach ($entry in $entries) {
        if ($entry.Main -or -not $entry.Dir) { continue }
        $licenses = Get-ChildItem -LiteralPath $entry.Dir -File | Where-Object Name -Match '^(LICENSE|COPYING|NOTICE)(\..*)?$'
        foreach ($license in $licenses) {
            [void]$output.AppendLine("`n=== $($entry.Path) $($entry.Version) / $($license.Name) ===")
            [void]$output.AppendLine([System.IO.File]::ReadAllText($license.FullName))
        }
    }
    $target = Join-Path $PSScriptRoot '../app/src/main/assets/third-party-notices.txt'
    New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
    [System.IO.File]::WriteAllText($target, $output.ToString(), [System.Text.UTF8Encoding]::new($false))
} finally { Pop-Location }
