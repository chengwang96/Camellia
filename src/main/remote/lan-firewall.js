'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { DISCOVERY_PORT } = require('./lan');

// A stable Windows HTTPS port lets the same narrow rules survive app restarts.
const WINDOWS_LAN_PORT = 42639;
const encode = script => Buffer.from(script, 'utf16le').toString('base64');
const quote = value => "'" + value.replaceAll("'", "''") + "'";

function createLanFirewall({ platform = process.platform, executable = process.execPath,
  systemRoot = process.env.SystemRoot || 'C:\\Windows', run = promisify(execFile) } = {}) {
  if (platform !== 'win32') return null;
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const application = path.win32.normalize(executable);
  const id = createHash('sha256').update(application.toLowerCase()).digest('hex').slice(0, 16);
  const setup = `
$ErrorActionPreference = 'Stop'
$policy = New-Object -ComObject HNetCfg.FwPolicy2
$application = ${quote(application)}
$prefix = 'Camellia Local Network ${id}'
$rules = @(
    @{ Name = "$prefix HTTPS"; Protocol = 6; Ports = '${WINDOWS_LAN_PORT}' },
    @{ Name = "$prefix Discovery"; Protocol = 17; Ports = '5353,${DISCOVERY_PORT}' }
)
function Test-Rule($spec, $rule) {
    return $rule.Enabled -and $rule.Action -eq 1 -and $rule.Direction -eq 1 -and
        $rule.ApplicationName -eq $application -and $rule.Protocol -eq $spec.Protocol -and
        $rule.LocalPorts -eq $spec.Ports -and $rule.RemoteAddresses -eq 'LocalSubnet' -and
        $rule.Profiles -eq 2147483647 -and -not $rule.EdgeTraversal
}
`;
  const read = `
$present = 0
$matching = 0
foreach ($spec in $rules) {
    foreach ($rule in $policy.Rules) {
        if ($rule.Name -ne $spec.Name) { continue }
        $present++
        if (Test-Rule $spec $rule) { $matching++ }
    }
}
if ($present -eq 2 -and $matching -eq 2) { 'ready' }
elseif ($present -eq 0) { 'absent' }
else { 'incomplete' }
`;
  async function invoke(script, timeout = 15_000) {
    const { stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encode(script)],
      { windowsHide: true, timeout });
    return stdout.trim();
  }
  async function configure(enable, { prompt = false } = {}) {
    const desired = enable ? 'ready' : 'absent';
    if (await invoke(setup + read) === desired) return true;
    if (!prompt) return false;
    const change = setup + `
foreach ($spec in $rules) {
    foreach ($rule in @($policy.Rules | Where-Object Name -eq $spec.Name)) {
        $policy.Rules.Remove($rule.Name)
    }
    if (${enable ? '$true' : '$false'}) {
        $rule = New-Object -ComObject HNetCfg.FWRule
        $rule.Name = $spec.Name
        $rule.Grouping = 'Camellia Local Network'
        $rule.ApplicationName = $application
        $rule.Protocol = $spec.Protocol
        $rule.LocalPorts = $spec.Ports
        $rule.RemoteAddresses = 'LocalSubnet'
        $rule.Direction = 1
        $rule.Action = 1
        $rule.Profiles = 2147483647
        $rule.Enabled = $true
        $policy.Rules.Add($rule)
    }
}
`;
    await invoke(`
$ErrorActionPreference = 'Stop'
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = ${quote(powershell)}
$start.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ${encode(change)}'
$start.UseShellExecute = $true
$start.Verb = 'runas'
$start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($start)
$process.WaitForExit()
exit $process.ExitCode
`, 0);
    return await invoke(setup + read) === desired;
  }
  return { port: WINDOWS_LAN_PORT, configure };
}

module.exports = { createLanFirewall };
