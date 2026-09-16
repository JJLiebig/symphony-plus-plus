# Backend processes inherit the interactive shell's token and job, never the
# client's elevation or kill-on-close job. Frontend/setup processes are unchanged.
function Initialize-SymppWindowsBackend {
  if ('Sympp.WindowsBackend' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Text;

namespace Sympp {
  public static class WindowsBackend {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
      public int cb; public string reserved, desktop, title;
      public int x, y, width, height, charsX, charsY, fill, flags;
      public short show, reservedSize; public IntPtr reservedBytes, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx { public StartupInfo startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, out int value, int size, out int needed);
    [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr block, IntPtr token, bool inherit);
    [DllImport("userenv.dll")] static extern bool DestroyEnvironmentBlock(IntPtr block);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder command, ref SecurityAttributes processSecurity, ref SecurityAttributes threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);

    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }

    static Dictionary<string, string> ReadEnvironment(IntPtr block) {
      var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      for (IntPtr next = block; ; ) {
        string entry = Marshal.PtrToStringUni(next);
        if (entry.Length == 0) return result;
        int separator = entry.IndexOf('=', 1);
        if (separator > 0) result[entry.Substring(0, separator)] = entry.Substring(separator + 1);
        next = IntPtr.Add(next, (entry.Length + 1) * 2);
      }
    }

    public static Process Start(string application, string command, string directory, string stdin, string stdout, string stderr) {
      int shellPid;
      GetWindowThreadProcessId(GetShellWindow(), out shellPid);
      if (shellPid == 0) throw new InvalidOperationException("Cannot start the backend without the logged-in user's desktop shell.");
      // Only process creation, handle duplication, and limited token inspection.
      IntPtr shell = OpenProcess(0x80 | 0x40 | 0x1000, false, shellPid);
      if (shell == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr token = IntPtr.Zero, userEnvironment = IntPtr.Zero, environment = IntPtr.Zero;
      IntPtr securityDescriptor = IntPtr.Zero;
      IntPtr attributes = IntPtr.Zero, parentValue = IntPtr.Zero, handleValues = IntPtr.Zero;
      bool initialized = false;
      var remoteHandles = new List<IntPtr>();
      try {
        Check(OpenProcessToken(shell, 0x8, out token)); // TOKEN_QUERY
        int elevated, needed;
        Check(GetTokenInformation(token, 20, out elevated, sizeof(int), out needed));
        if (elevated != 0) throw new InvalidOperationException("The desktop shell is elevated; refusing to start an elevated backend.");
        Check(CreateEnvironmentBlock(out userEnvironment, token, false));
        var shellEnvironment = ReadEnvironment(userEnvironment);
        var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) values[(string)entry.Key] = (string)entry.Value;
        // Preserve explicit configuration for UAC elevation of the same account.
        // An alternate administrator must not redirect the shell user to its profile.
        string shellSid;
        using (var caller = WindowsIdentity.GetCurrent())
        using (var shellIdentity = new WindowsIdentity(token)) {
          shellSid = shellIdentity.User.Value;
          if (caller.User != shellIdentity.User) {
            foreach (string name in new[] { "USERPROFILE", "USERNAME", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP" }) {
              string value;
              if (shellEnvironment.TryGetValue(name, out value)) values[name] = value;
              else values.Remove(name);
            }
            if (values.ContainsKey("HOME")) values["HOME"] = shellEnvironment["USERPROFILE"];
          }
        }
        var block = new StringBuilder();
        foreach (var entry in values) block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
        block.Append('\0');
        environment = Marshal.StringToHGlobalUni(block.ToString());

        // The explicit list inherits only our redirects from the shell. See
        // https://devblogs.microsoft.com/oldnewthing/20260511-00/?p=112313
        foreach (string path in new[] { stdin, stdout, stderr }) {
          bool input = remoteHandles.Count == 0;
          using (var file = new FileStream(path, input ? FileMode.Open : FileMode.Create, input ? FileAccess.Read : FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) {
            IntPtr remote;
            Check(DuplicateHandle(GetCurrentProcess(), file.SafeFileHandle.DangerousGetHandle(), shell, out remote, 0, true, 2));
            remoteHandles.Add(remote);
          }
        }
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
        attributes = Marshal.AllocHGlobal(size);
        Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size));
        initialized = true;
        parentValue = Marshal.AllocHGlobal(IntPtr.Size);
        Marshal.WriteIntPtr(parentValue, shell);
        Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20000), parentValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
        handleValues = Marshal.AllocHGlobal(IntPtr.Size * remoteHandles.Count);
        for (int i = 0; i < remoteHandles.Count; i++) Marshal.WriteIntPtr(handleValues, i * IntPtr.Size, remoteHandles[i]);
        Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handleValues, new IntPtr(IntPtr.Size * remoteHandles.Count), IntPtr.Zero, IntPtr.Zero));
        var startup = new StartupInfoEx();
        startup.startup.cb = Marshal.SizeOf(typeof(StartupInfoEx));
        startup.startup.flags = 0x101; // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
        startup.startup.stdin = remoteHandles[0]; startup.startup.stdout = remoteHandles[1]; startup.startup.stderr = remoteHandles[2];
        startup.attributes = attributes;
        ProcessInfo child;
        uint flags = 0x08000000 | 0x00080000 | 0x400 | (uint)Process.GetCurrentProcess().PriorityClass;
        // Parent selection does not lower the process/thread object's security.
        // Elevated defaults can prevent the child from querying its own priority.
        // Grant control to its desktop user, SYSTEM and administrators only.
        var descriptor = new RawSecurityDescriptor("D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;" + shellSid + ")S:(ML;;NW;;;ME)");
        var securityBytes = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(securityBytes, 0);
        securityDescriptor = Marshal.AllocHGlobal(securityBytes.Length);
        Marshal.Copy(securityBytes, 0, securityDescriptor, securityBytes.Length);
        var security = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = securityDescriptor };
        Check(CreateProcessW(application, new StringBuilder(command), ref security, ref security, true,
          flags, environment, directory, ref startup, out child));
        try { return Process.GetProcessById(child.pid); }
        finally { CloseHandle(child.thread); CloseHandle(child.process); }
      } finally {
        foreach (IntPtr handle in remoteHandles) {
          IntPtr local;
          if (DuplicateHandle(shell, handle, GetCurrentProcess(), out local, 0, false, 3)) CloseHandle(local);
        }
        if (initialized) DeleteProcThreadAttributeList(attributes);
        Marshal.FreeHGlobal(attributes); Marshal.FreeHGlobal(parentValue); Marshal.FreeHGlobal(handleValues); Marshal.FreeHGlobal(environment);
        Marshal.FreeHGlobal(securityDescriptor);
        if (userEnvironment != IntPtr.Zero) DestroyEnvironmentBlock(userEnvironment);
        if (token != IntPtr.Zero) CloseHandle(token);
        CloseHandle(shell);
      }
    }
  }
}
'@
}

function Start-SymppWindowsBackend($Command, [string]$WorkingDirectory, [string]$StdinPath, [string]$StdoutPath, [string]$StderrPath) {
  Initialize-SymppWindowsBackend
  $executable = (Get-Command $Command.file -ErrorAction Stop | Select-Object -First 1).Source
  $arguments = @($Command.args)
  if ([IO.Path]::GetExtension($executable) -in @('.bat', '.cmd')) {
    $batchCommand = Join-ProcessArgumentList (@($executable) + $arguments)
    $executable = Join-Path $env:SystemRoot 'System32/cmd.exe'
    $commandLine = (ConvertTo-ProcessArgument $executable) + ' /d /s /c "' + $batchCommand + '"'
  } else {
    $commandLine = (ConvertTo-ProcessArgument $executable) + ' ' + (Join-ProcessArgumentList $arguments)
  }
  return [Sympp.WindowsBackend]::Start($executable, $commandLine, $WorkingDirectory, $StdinPath, $StdoutPath, $StderrPath)
}
