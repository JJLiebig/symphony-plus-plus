defmodule SymphonyElixir.SymphonyPlusPlus.HttpMcpSmokeTest do
  use ExUnit.Case, async: true

  @smoke_script_path Path.expand("../../../../scripts/smoke-sympp-mcp-http.ps1", __DIR__)

  @tag :ci_slow
  test "HTTP MCP smoke self-test covers source revision validation" do
    powershell =
      System.find_executable("powershell.exe") || System.find_executable("pwsh") ||
        System.find_executable("powershell")

    if powershell do
      {output, status} =
        System.cmd(
          powershell,
          ["-NoProfile", "-File", @smoke_script_path, "-SelfTest"],
          stderr_to_stdout: true
        )

      assert status == 0, output

      assert output =~
               "PowerShell header normalization, source revision, redaction, and bound argument validation self-test passed."
    end
  end
end
