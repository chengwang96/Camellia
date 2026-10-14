$ErrorActionPreference = 'Stop'

# WScript.Shell converts shortcut arguments through the current ANSI code page.
# Use the Unicode interface so CI also covers paths outside that code page.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
internal class CamelliaShellLink {}

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface CamelliaShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count, IntPtr data, int flags);
    void GetIDList(out IntPtr value);
    void SetIDList(IntPtr value);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetHotkey(out short value);
    void SetHotkey(short value);
    void GetShowCmd(out int value);
    void SetShowCmd(int value);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string value, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string value, int reserved);
    void Resolve(IntPtr window, int flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string value);
}

public sealed class CamelliaShortcutInfo {
    public string Target { get; set; }
    public string Arguments { get; set; }
    public string WorkingDirectory { get; set; }
}

public static class CamelliaUnicodeShortcut {
    public static CamelliaShortcutInfo Read(string file) {
        object instance = new CamelliaShellLink();
        try {
            ((IPersistFile)instance).Load(file, 0);
            var link = (CamelliaShellLinkW)instance;
            var target = new StringBuilder(32768);
            var arguments = new StringBuilder(32768);
            var directory = new StringBuilder(32768);
            link.GetPath(target, target.Capacity, IntPtr.Zero, 0);
            link.GetArguments(arguments, arguments.Capacity);
            link.GetWorkingDirectory(directory, directory.Capacity);
            return new CamelliaShortcutInfo { Target = target.ToString(), Arguments = arguments.ToString(), WorkingDirectory = directory.ToString() };
        } finally { Marshal.FinalReleaseComObject(instance); }
    }

    public static CamelliaShortcutInfo CopyWithArguments(string source, string destination, string expected, string arguments) {
        if (String.Equals(Path.GetFullPath(source), Path.GetFullPath(destination), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The installed desktop shortcut must remain unchanged.");
        var original = Read(source);
        if (!String.Equals(Path.GetFullPath(original.Target), Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The installed desktop shortcut points to another application.");
        object instance = new CamelliaShellLink();
        try {
            ((IPersistFile)instance).Load(source, 0);
            ((CamelliaShellLinkW)instance).SetArguments(arguments);
            ((IPersistFile)instance).Save(destination, true);
        } finally { Marshal.FinalReleaseComObject(instance); }
        var saved = Read(destination);
        if (saved.Arguments != arguments) throw new InvalidOperationException("The temporary shortcut did not retain its Unicode arguments.");
        return saved;
    }
}
'@

$saved = [CamelliaUnicodeShortcut]::CopyWithArguments($env:CAMELLIA_QA_SOURCE_LINK,
    $env:CAMELLIA_QA_LINK, $env:CAMELLIA_QA_EXE, $env:CAMELLIA_QA_ARGS)
$launched = Start-Process -FilePath $env:CAMELLIA_QA_LINK -WindowStyle Hidden -PassThru
[IO.File]::WriteAllText($env:CAMELLIA_QA_PID, [string]$launched.Id)
$native = Get-CimInstance Win32_Process -Filter "ProcessId=$($launched.Id)" -OperationTimeoutSec 5 -ErrorAction SilentlyContinue
[IO.File]::WriteAllText($env:CAMELLIA_QA_LAUNCH_LOG, (@{
    target = $saved.Target; arguments = $saved.Arguments; workingDirectory = $saved.WorkingDirectory
    processId = $launched.Id; commandLine = $native.CommandLine
} | ConvertTo-Json))
$launched.WaitForExit()
exit $launched.ExitCode
