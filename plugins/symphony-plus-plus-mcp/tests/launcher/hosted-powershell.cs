// Hosted qualification only: keep installed launcher bytes unchanged while
// preloading the existing WindowsBackend class seam in each preparation process.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

class HostedPowerShell {
  static string Literal(string value) { return "'" + value.Replace("'", "''") + "'"; }
  static int Main(string[] args) {
    if (File.Exists(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "untrusted-project"))) {
      Console.Error.WriteLine("Project-local PowerShell shadow was executed.");
      return 93;
    }
    int file = Array.FindIndex(args, value => value.Equals("-File", StringComparison.OrdinalIgnoreCase));
    if (file < 0 || file + 1 >= args.Length) return 2;
    var command = new StringBuilder("$ErrorActionPreference = 'Stop'; try { . " + Literal(Environment.GetEnvironmentVariable("SYMPP_TEST_BACKEND_PRELOAD")) + "; & ");
    command.Append(Literal(args[file + 1]));
    for (int i = file + 2; i < args.Length; i++) {
      if (args[i] == "-CleanupRuntimeKey" && i + 1 < args.Length) {
        command.Append(" -CleanupRuntimeKey ").Append(Literal(args[++i]));
        continue;
      }
      if (args[i] != "-PrepareRuntimeOnly" && args[i] != "-TryPreparedRuntime") return 2;
      command.Append(' ').Append(args[i]);
    }
    command.Append("; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_); exit 1 }");
    var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("SYMPP_TEST_REAL_POWERSHELL"),
      "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(command.ToString())));
    start.UseShellExecute = false;
    start.CreateNoWindow = true;
    start.RedirectStandardOutput = true;
    start.RedirectStandardError = true;
    using (var child = Process.Start(start)) {
      child.OutputDataReceived += (sender, line) => { if (line.Data != null) Console.Out.WriteLine(line.Data); };
      child.ErrorDataReceived += (sender, line) => { if (line.Data != null) Console.Error.WriteLine(line.Data); };
      child.BeginOutputReadLine(); child.BeginErrorReadLine();
      // The fixture backend inherits runner handles. Wait for preparation exit,
      // not EOF on streams still held by that long-lived backend.
      child.WaitForExit(Int32.MaxValue);
      // Failed preparation has no surviving backend; retain its complete error.
      if (child.ExitCode != 0) child.WaitForExit();
      return child.ExitCode;
    }
  }
}
