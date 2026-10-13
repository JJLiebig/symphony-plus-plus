// Hosted qualification only: keep installed launcher bytes unchanged while
// preloading the existing WindowsBackend class seam in each preparation process.
using System;
using System.Diagnostics;
using System.Text;

class HostedPowerShell {
  static string Literal(string value) { return "'" + value.Replace("'", "''") + "'"; }
  static int Main(string[] args) {
    int file = Array.FindIndex(args, value => value.Equals("-File", StringComparison.OrdinalIgnoreCase));
    if (file < 0 || file + 1 >= args.Length) return 2;
    var command = new StringBuilder(". " + Literal(Environment.GetEnvironmentVariable("SYMPP_TEST_BACKEND_PRELOAD")) + "; & ");
    command.Append(Literal(args[file + 1]));
    for (int i = file + 2; i < args.Length; i++) {
      if (args[i] != "-PrepareRuntimeOnly" && args[i] != "-TryPreparedRuntime") return 2;
      command.Append(' ').Append(args[i]);
    }
    command.Append("; if (-not $?) { exit 1 }");
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
      child.WaitForExit(); return child.ExitCode;
    }
  }
}
