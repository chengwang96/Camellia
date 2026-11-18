$ErrorActionPreference = 'Stop'

function Wait-FixtureExit([int]$fixtureId) {
    $process = Get-Process -Id $fixtureId -ErrorAction SilentlyContinue
    if (!$process) { return }
    try {
        if (!$process.WaitForExit(10000)) { throw "Fixture process $fixtureId did not exit" }
    } finally {
        $process.Dispose()
    }
}

function Read-FixtureText([string]$file) {
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ($true) {
        try {
            $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
            $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
            try {
                $reader = [IO.StreamReader]::new($stream, $utf8, $false)
                try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
            } finally {
                $stream.Dispose()
            }
        } catch {
            $failure = $_.Exception.GetBaseException()
            if ($failure -isnot [IO.IOException] -or ($failure.HResult -band 0xffff) -notin @(32, 33) -or
                [DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 50
        }
    }
}

$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$launcher = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../src/engines/background-process.cjs')).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ('camellia launch 中文 & % ' + [Guid]::NewGuid().ToString('N'))
$target = Join-Path $work 'child.cjs'
$result = Join-Path $work 'argv.json'
$logFile = Join-Path $work 'helper.log'
$specFile = Join-Path $work 'launch.json'
$expected = @('space value', '中文 & %TEMP% ^', 'a"b', 'C:\trailing space\', '')
$utf8 = [Text.UTF8Encoding]::new($false, $true)
[void][IO.Directory]::CreateDirectory($work)
try {
    [IO.File]::WriteAllText($target, @'
'use strict';
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, workerPid: process.ppid, args: process.argv.slice(3) }));
console.log('stdout captured');
console.error('stderr captured');
'@, $utf8)
    $spec = @{ file = $node; cwd = $work; logFile = $logFile; args = @($target, $result) + $expected }
    [IO.File]::WriteAllText($specFile, (ConvertTo-Json -InputObject $spec -Depth 4 -Compress), $utf8)

    Write-Host 'Running the Windows launcher with literal arguments'
    $reply = & $node $launcher $specFile
    if ($LASTEXITCODE -ne 0) { throw "Native launcher exited with code $LASTEXITCODE" }
    $launched = $reply | ConvertFrom-Json
    if ($launched.pid -le 0 -or $launched.logFile -cne $logFile) { throw 'Unexpected launcher receipt' }
    Wait-FixtureExit $launched.pid
    $record = Read-FixtureText $result | ConvertFrom-Json
    if ($record.pid -ne $launched.pid -or $record.workerPid -le 0 -or $record.workerPid -eq $record.pid) {
        throw 'The launcher must report its target PID, not the hidden worker PID'
    }
    Wait-FixtureExit $record.workerPid

    if ($record.args.Count -ne $expected.Count) { throw 'The launcher changed the argument count' }
    for ($index = 0; $index -lt $expected.Count; $index++) {
        if (![string]::Equals($record.args[$index], $expected[$index], [StringComparison]::Ordinal)) {
            throw "The launcher changed argument at index $index"
        }
    }
    $logged = Read-FixtureText $logFile
    if (!$logged.Contains('stdout captured') -or !$logged.Contains('stderr captured')) {
        throw 'The background process did not write both streams to its log'
    }
    Write-Host 'PASS: real Windows launcher preserves argv and both log streams, and its processes exit'
} finally {
    foreach ($file in @($target, $result, $logFile, $specFile)) {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
    try { [IO.Directory]::Delete($work) } catch { Write-Warning "Fixture cleanup: $($_.Exception.Message)" }
}
