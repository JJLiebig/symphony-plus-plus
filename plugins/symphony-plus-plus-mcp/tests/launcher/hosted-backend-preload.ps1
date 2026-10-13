# GitHub's elevated desktop cannot qualify desktop token/job inheritance.
# Substitute only native process creation; all artifact, runtime and MCP code is real.
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
namespace Sympp {
  public static class WindowsBackend {
    public static Process Start(string application, string command, string directory, string stdin, string stdout, string stderr) {
      var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec"),
        "/d /s /c \"" + command + " <\"" + stdin + "\" >\"" + stdout + "\" 2>\"" + stderr + "\"\"");
      start.WorkingDirectory = directory;
      start.UseShellExecute = false;
      start.CreateNoWindow = true;
      return Process.Start(start);
    }
  }
}
'@
