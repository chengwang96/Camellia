// Windows 10+ process containment helper. Loaded into a private PowerShell
// process from app-owned source. Target settings and credentials arrive only
// over the private control pipe. This is lifetime control, not a file sandbox.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Camellia.Discussions {
  public sealed class WindowsJob {
    [StructLayout(LayoutKind.Sequential)] struct Security { public int size; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential)] struct Startup {
      public int size; public IntPtr reserved, desktop, title;
      public int x, y, width, height, charsX, charsY, fill, flags;
      public short show, reservedSize; public IntPtr reservedBytes, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
      public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking;
      public uint maxProcesses; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
      public BasicLimit basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
      public long userTime, kernelTime, periodUser, periodKernel;
      public uint pageFaults, total, active, terminated;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string exe, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
      bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    public sealed class Command {
      public string type, nonce, exe, cwd, data, jobName, lockFile, sealFile;
      public string[] args;
      public Dictionary<string, string> env;
    }
    readonly object gate = new object(), outputGate = new object();
    readonly BlockingCollection<byte[]> inputQueue = new BlockingCollection<byte[]>(256);
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16777216 };
    IntPtr job, process;
    FileStream input;
    Task stdoutTask, stderrTask;
    string nonce, lockFile, sealFile;
    bool started;
    volatile bool stopping;
    int exitSent;

    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    FileStream LaunchLock() {
      var deadline = System.Diagnostics.Stopwatch.StartNew();
      while (true) {
        try { return new FileStream(lockFile, FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException error) {
          // Only a sharing/lock violation is transient. Missing or unreadable
          // launch records cannot authorize either launch or recovery.
          int code = error.HResult & 0xFFFF;
          if ((code != 32 && code != 33) || deadline.ElapsedMilliseconds > 10000) throw;
          Thread.Sleep(10);
        }
      }
    }
    void AssertUnsealed() {
      // File.Exists hides access errors. Only confirmed absence permits launch.
      try { File.GetAttributes(sealFile); }
      catch (FileNotFoundException) { return; }
      throw new InvalidOperationException("Delivery launch has been sealed for recovery");
    }
    static Accounting TerminateAndCheck(IntPtr handle) {
      Check(TerminateJobObject(handle, 1));
      var deadline = System.Diagnostics.Stopwatch.StartNew(); Accounting accounting;
      do {
        Check(QueryInformationJobObject(handle, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        if (accounting.active == 0) return accounting;
        if (deadline.ElapsedMilliseconds > 15000) throw new TimeoutException("Job processes have not stopped");
        Thread.Sleep(10);
      } while (true);
    }
    void Recover(string jobName) {
      // Serialize with both job creation and target launch. Flush the durable
      // seal BEFORE checking the kernel so a late old helper cannot start work
      // after an absent/empty-job observation, even after this verifier exits.
      using (LaunchLock()) {
        using (var seal = new FileStream(sealFile, FileMode.OpenOrCreate, FileAccess.Write, FileShare.None)) {
          var data = Encoding.UTF8.GetBytes("sealed\n"); seal.SetLength(0); seal.Write(data, 0, data.Length); seal.Flush(true);
        }
        IntPtr existing = OpenJobObject(0xC, false, jobName); int error = Marshal.GetLastWin32Error();
        if (existing == IntPtr.Zero) {
          if (error != 2) throw new Win32Exception(error);
          Send("recovered", "sealed", true, "activeProcesses", 0, "jobAbsent", true, "totalProcesses", 0);
        } else {
          try {
            var accounting = TerminateAndCheck(existing);
            Send("recovered", "sealed", true, "activeProcesses", accounting.active, "jobAbsent", false, "totalProcesses", accounting.total);
          } finally { Close(ref existing); }
        }
      }
    }
    void Send(string type, params object[] fields) {
      lock (outputGate) {
        var message = new Dictionary<string, object> { { "type", type }, { "nonce", nonce } };
        for (int index = 0; index < fields.Length; index += 2) message[(string)fields[index]] = fields[index + 1];
        Console.WriteLine(new JavaScriptSerializer().Serialize(message)); Console.Out.Flush();
      }
    }
    static string Quote(string value) {
      var result = new StringBuilder("\""); int slashes = 0;
      foreach (char c in value) {
        if (c == '\\') { slashes++; continue; }
        result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); slashes = 0; result.Append(c);
      }
      return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    Task Pump(IntPtr handle, string channel) {
      return Task.Factory.StartNew(() => {
        using (var stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read, 16384, false)) {
          var buffer = new byte[16384]; int size;
          while ((size = stream.Read(buffer, 0, buffer.Length)) > 0) Send(channel, "data", Convert.ToBase64String(buffer, 0, size));
        }
      }, TaskCreationOptions.LongRunning);
    }
    void Launch(Command command) {
      lock (gate) using (LaunchLock()) {
        AssertUnsealed();
        if (started || stopping) throw new InvalidOperationException("Job launch is already sealed");
        started = true;
        IntPtr childIn = IntPtr.Zero, parentIn = IntPtr.Zero, parentOut = IntPtr.Zero, childOut = IntPtr.Zero;
        IntPtr parentErr = IntPtr.Zero, childErr = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero, env = IntPtr.Zero;
        bool initialized = false;
        var info = new ProcessInfo();
        try {
          var security = new Security { size = Marshal.SizeOf(typeof(Security)), inherit = 1 };
          Check(CreatePipe(out childIn, out parentIn, ref security, 0)); Check(SetHandleInformation(parentIn, 1, 0));
          Check(CreatePipe(out parentOut, out childOut, ref security, 0)); Check(SetHandleInformation(parentOut, 1, 0));
          Check(CreatePipe(out parentErr, out childErr, ref security, 0)); Check(SetHandleInformation(parentErr, 1, 0));
          IntPtr bytes = IntPtr.Zero;
          InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
          if (bytes == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
          attributes = Marshal.AllocHGlobal(bytes); Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref bytes)); initialized = true;
          handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
          Marshal.WriteIntPtr(handles, 0, childIn); Marshal.WriteIntPtr(handles, IntPtr.Size, childOut); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, childErr);
          Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
          jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
          // Assign at creation, not after spawn: no uncontained execution or
          // suspended orphan gap if the supervisor dies during CreateProcess.
          Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
          env = Marshal.StringToHGlobalUni(string.Join("\0", command.env.OrderBy(row => row.Key, StringComparer.OrdinalIgnoreCase).Select(row => row.Key + "=" + row.Value)) + "\0\0");
          var startup = new StartupEx { attributes = attributes, info = new Startup {
            size = Marshal.SizeOf(typeof(StartupEx)), flags = 0x100, input = childIn, output = childOut, error = childErr } };
          var line = new StringBuilder(string.Join(" ", new [] { command.exe }.Concat(command.args).Select(Quote)));
          Check(CreateProcess(command.exe, line, IntPtr.Zero, IntPtr.Zero, true, 0x08080400, env, command.cwd, ref startup, out info));
          process = info.process; info.process = IntPtr.Zero;
          Close(ref childIn); Close(ref childOut); Close(ref childErr);
          input = new FileStream(new SafeFileHandle(parentIn, true), FileAccess.Write, 16384, false); parentIn = IntPtr.Zero;
          // Announce the root before any data or exit event; all streams use a
          // framed control channel, so target stdout cannot forge stop proof.
          Send("spawned", "pid", info.pid);
          stdoutTask = Pump(parentOut, "stdout"); parentOut = IntPtr.Zero;
          stderrTask = Pump(parentErr, "stderr"); parentErr = IntPtr.Zero;
          Task.Factory.StartNew(() => {
            try { foreach (var chunk in inputQueue.GetConsumingEnumerable()) { input.Write(chunk, 0, chunk.Length); input.Flush(); } }
            catch (IOException) { /* child closed stdin; stop still checks job */ }
            finally { input.Dispose(); }
          }, TaskCreationOptions.LongRunning);
          Task.Factory.StartNew(() => {
            try { if (WaitForSingleObject(process, 0xFFFFFFFF) != 0) throw new Win32Exception(Marshal.GetLastWin32Error()); ReportExit(); Stop(); }
            catch (Exception error) { Send("failure", "message", error.Message); }
          }, TaskCreationOptions.LongRunning);
        } finally {
          Close(ref childIn); Close(ref childOut); Close(ref childErr); Close(ref parentIn); Close(ref parentOut); Close(ref parentErr);
          Close(ref info.thread); Close(ref info.process);
          if (initialized) DeleteProcThreadAttributeList(attributes);
          foreach (var pointer in new [] { attributes, handles, jobs, env }) if (pointer != IntPtr.Zero) Marshal.FreeHGlobal(pointer);
        }
      }
    }
    void ReportExit() {
      lock (outputGate) {
        if (process == IntPtr.Zero || Interlocked.CompareExchange(ref exitSent, 1, 0) != 0) return;
        uint code; Check(GetExitCodeProcess(process, out code)); Send("exit", "code", code);
      }
    }
    void Stop() {
      lock (gate) { if (stopping) return; stopping = true; }
      // Neither root exit nor a successful termination request is the proof.
      // Seal launch first, then query OS accounting until the entire job is empty.
      var accounting = TerminateAndCheck(job);
      if (process != IntPtr.Zero) { if (WaitForSingleObject(process, 5000) != 0) throw new TimeoutException("Root process has not exited"); ReportExit(); }
      inputQueue.CompleteAdding();
      var pumps = new [] { stdoutTask, stderrTask }.Where(task => task != null).ToArray();
      if (!Task.WaitAll(pumps, 5000)) throw new TimeoutException("Job output handles have not closed");
      Send("stopped", "sealed", true, "activeProcesses", accounting.active, "totalProcesses", accounting.total);
    }
    public static void Run() {
      var supervisor = new WindowsJob();
      try {
        var first = supervisor.json.Deserialize<Command>(Console.ReadLine()); supervisor.nonce = first.nonce;
        if (string.IsNullOrEmpty(supervisor.nonce)) throw new InvalidOperationException("Missing supervisor identity");
        supervisor.lockFile = first.lockFile; supervisor.sealFile = first.sealFile;
        if (first.type == "recover") { supervisor.Recover(first.jobName); return; }
        using (supervisor.LaunchLock()) {
          supervisor.AssertUnsealed();
          supervisor.job = CreateJobObject(IntPtr.Zero, first.jobName); int error = Marshal.GetLastWin32Error();
          if (supervisor.job == IntPtr.Zero) throw new Win32Exception(error);
          if (error == 183) { Close(ref supervisor.job); throw new InvalidOperationException("Delivery job already exists"); }
          // No breakaway flags. The non-inheritable job handle stays in this helper.
          var limit = new ExtendedLimit { basic = new BasicLimit { flags = 0x2000 } };
          Check(SetInformationJobObject(supervisor.job, 9, ref limit, Marshal.SizeOf(typeof(ExtendedLimit))));
        }
        supervisor.Send("ready");
        string line;
        while ((line = Console.ReadLine()) != null) {
          var command = supervisor.json.Deserialize<Command>(line);
          if (command.nonce != supervisor.nonce) throw new InvalidOperationException("Supervisor identity mismatch");
          if (command.type == "stop") { supervisor.Stop(); continue; }
          if (supervisor.stopping) continue;
          if (command.type == "spawn") supervisor.Launch(command);
          else if (command.type == "input") {
            var data = Convert.FromBase64String(command.data);
            try {
              if (data.Length > 65536 || supervisor.inputQueue.IsAddingCompleted || !supervisor.inputQueue.TryAdd(data)) throw new InvalidOperationException("Job input queue unavailable");
            } catch (InvalidOperationException) { if (!supervisor.stopping) throw; }
          } else if (command.type == "end") supervisor.inputQueue.CompleteAdding();
          else throw new InvalidOperationException("Invalid supervisor command");
        }
        supervisor.Stop();
      } catch (Exception error) {
        try { supervisor.Send("failure", "message", error.Message); } catch { }
        try { if (supervisor.job != IntPtr.Zero) supervisor.Stop(); } catch { }
      } finally {
        // Also kills descendants when the app's control pipe disappears. A
        // missing acknowledgement still cannot be used as a positive proof.
        Close(ref supervisor.job); Close(ref supervisor.process);
      }
    }
  }
}
