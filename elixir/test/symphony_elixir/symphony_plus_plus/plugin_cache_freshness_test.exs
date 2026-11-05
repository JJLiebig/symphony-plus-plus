defmodule SymphonyElixir.SymphonyPlusPlus.PluginCacheFreshnessTest do
  use ExUnit.Case, async: true

  @repo_root Path.expand("../../../../", __DIR__)
  @mcp_manifest_path Path.join(@repo_root, "plugins/symphony-plus-plus-mcp/.codex-plugin/plugin.json")
  @mcp_plugin_version @mcp_manifest_path |> File.read!() |> Jason.decode!() |> Map.fetch!("version")
  @diagnostic_path Path.join(@repo_root, "plugins/symphony-plus-plus/scripts/diagnose-mcp-lifecycle.ps1")
  @refresh_script_path Path.join(@repo_root, "scripts/refresh-local-plugin.ps1")
  @marketplace_name "symphony-plus-plus"

  @tag :ci_slow
  test "lifecycle diagnostic flags same-version stale MCP companion cache contents" do
    powershell = System.find_executable("powershell.exe") || System.find_executable("pwsh") || System.find_executable("powershell")
    temp_codex_home = Path.join(System.tmp_dir!(), "sympp-plugin-stale-mcp-cache-#{System.unique_integer([:positive])}")

    if powershell do
      try do
        {refresh_output, refresh_status} =
          run(
            powershell,
            [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              @refresh_script_path,
              "-CodexHome",
              temp_codex_home
            ]
          )

        assert refresh_status == 0, refresh_output

        stale_launcher_path =
          Path.join([
            temp_codex_home,
            "plugins",
            "cache",
            @marketplace_name,
            "symphony-plus-plus-mcp",
            @mcp_plugin_version,
            "scripts",
            "start-sympp-mcp.ps1"
          ])

        File.write!(stale_launcher_path, "# stale launcher with the same manifest version\n")

        {doctor_output, doctor_status} =
          run(
            powershell,
            [
              "-NoProfile",
              "-File",
              @diagnostic_path,
              "-CodexHome",
              temp_codex_home,
              "-MarketplaceName",
              @marketplace_name,
              "-SkipProcessScan",
              "-Json"
            ]
          )

        assert doctor_status == 0, doctor_output

        readiness = doctor_output |> Jason.decode!() |> Map.fetch!("readiness")
        assert readiness["workrequest_mcp"]["cache_freshness"]["status"] == "content_mismatch"
        assert Enum.any?(readiness["warnings"], &(&1["code"] == "mcp_companion_cache_stale"))

        assert Enum.any?(
                 readiness["next_actions"],
                 &(&1["code"] == "upgrade_mcp_companion_cache" and
                     &1["command"] =~ "codex plugin marketplace upgrade" and
                     &1["command"] =~ @marketplace_name and
                     &1["command"] =~ "CODEX_HOME")
               )
      after
        File.rm_rf!(temp_codex_home)
      end
    end
  end

  defp run(powershell, args) do
    System.cmd(powershell, args, stderr_to_stdout: true)
  end
end
