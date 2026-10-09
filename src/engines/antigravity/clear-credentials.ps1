$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CamelliaGoogleCredentials {
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool Delete(string target, uint type, uint flags);
}
'@
# go-keyring identifies this one CLI credential as service:account. Never read
# credential blobs or enumerate/delete other Google or Gemini credentials.
if (-not [CamelliaGoogleCredentials]::Delete('gemini:antigravity', 1, 0)) {
    $credentialError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($credentialError -ne 1168) {
        throw [ComponentModel.Win32Exception]::new($credentialError)
    }
}
