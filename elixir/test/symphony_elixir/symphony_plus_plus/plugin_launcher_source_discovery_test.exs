defmodule SymphonyElixir.SymphonyPlusPlus.PluginLauncherSourceDiscoveryTest do
  use ExUnit.Case, async: true

  @moduletag :ci_slow

  @repo_root Path.expand("../../../../", __DIR__)
  @plugin_manifest_path Path.join(@repo_root, "packages/sympp/package.json")
  @plugin_version @plugin_manifest_path |> File.read!() |> Jason.decode!() |> Map.fetch!("version")
  @mcp_plugin_start_script_path Path.join(@repo_root, "packages/sympp/scripts/start-sympp-mcp.ps1")

  test "installed launchers default to mise for source checkouts with mise config" do
    powershell = System.find_executable("pwsh")
    temp_codex_home = unique_temp_path("sympp-plugin-marketplace-mise-default")

    if powershell do
      fake_mise = fake_mise_executable(temp_codex_home)
      source_root = write_minimal_source(temp_codex_home)
      File.write!(Path.join(source_root, "elixir/mise.toml"), "[tools]\nelixir = \"1.19.5-otp-28\"\n")
      mcp_cache_root = plugin_cache_path(temp_codex_home, ["1.0.0"], "symphony-plus-plus-mcp")
      sympp_home = Path.join(temp_codex_home, "sympp-home")

      try do
        launchers = [
          {write_cached_script(mcp_cache_root, @mcp_plugin_start_script_path), "sympp MCP launcher validation passed."}
        ]

        for {script_path, expected} <- launchers do
          {output, status} =
            System.cmd(
              powershell,
              ["-NoProfile", "-File", script_path, "-ValidateOnly"],
              cd: Path.dirname(Path.dirname(script_path)),
              stderr_to_stdout: true,
              env: [
                {"SYMPP_MISE", fake_mise},
                {"SYMPP_REPO_ROOT", source_root},
                {"SYMPP_HOME", sympp_home},
                {"SYMPP_SOURCE_FALLBACK", "1"}
              ]
            )

          assert status == 0, output
          assert output =~ expected
          assert output =~ "Mix 1.98.0 mise"
          assert output =~ "launcher: mise"
          assert normalize_path_fragment(output) =~ "mixbuildroot: #{normalize_path_fragment(sympp_home)}"
        end
      after
        File.rm_rf!(temp_codex_home)
      end
    end
  end

  test "MCP launcher keeps direct default for source checkouts without mise config" do
    powershell = System.find_executable("pwsh")
    temp_codex_home = unique_temp_path("sympp-plugin-marketplace-direct-default")

    if powershell do
      fake_mix = fake_mix_executable(temp_codex_home)
      source_root = write_minimal_source(temp_codex_home)
      mcp_cache_root = plugin_cache_path(temp_codex_home, ["1.0.0"], "symphony-plus-plus-mcp")
      sympp_home = Path.join(temp_codex_home, "sympp-home")

      try do
        script_path = write_cached_script(mcp_cache_root, @mcp_plugin_start_script_path)

        {output, status} =
          System.cmd(
            powershell,
            ["-NoProfile", "-File", script_path, "-ValidateOnly"],
            cd: Path.dirname(Path.dirname(script_path)),
            stderr_to_stdout: true,
            env: [{"SYMPP_MIX", fake_mix}, {"SYMPP_REPO_ROOT", source_root}, {"SYMPP_HOME", sympp_home}, {"SYMPP_SOURCE_FALLBACK", "1"}]
          )

        assert status == 0, output
        assert output =~ "sympp MCP launcher validation passed."
        assert output =~ "Mix 1.99.0 test"
        assert output =~ "launcher: direct"
        assert normalize_path_fragment(output) =~ "mixbuildroot: #{normalize_path_fragment(sympp_home)}"
      after
        File.rm_rf!(temp_codex_home)
      end
    end
  end

  test "installed launchers fall back to direct when mise config cannot run" do
    powershell = System.find_executable("pwsh")
    temp_codex_home = unique_temp_path("sympp-plugin-marketplace-mise-probe-fails")

    if powershell do
      fake_mix = fake_mix_executable(temp_codex_home)
      fake_mise = fake_failing_mise_executable(temp_codex_home)
      source_root = write_minimal_source(temp_codex_home)
      File.write!(Path.join(source_root, "elixir/mise.toml"), "[tools]\nelixir = \"1.19.5-otp-28\"\n")
      mcp_cache_root = plugin_cache_path(temp_codex_home, ["1.0.0"], "symphony-plus-plus-mcp")
      sympp_home = Path.join(temp_codex_home, "sympp-home")

      try do
        script_path = write_cached_script(mcp_cache_root, @mcp_plugin_start_script_path)

        {output, status} =
          System.cmd(
            powershell,
            ["-NoProfile", "-File", script_path, "-ValidateOnly"],
            cd: Path.dirname(Path.dirname(script_path)),
            stderr_to_stdout: true,
            env: [
              {"SYMPP_MISE", fake_mise},
              {"SYMPP_MIX", fake_mix},
              {"SYMPP_REPO_ROOT", source_root},
              {"SYMPP_HOME", sympp_home},
              {"SYMPP_SOURCE_FALLBACK", "1"}
            ]
          )

        assert status == 0, output
        assert output =~ "sympp MCP launcher validation passed."
        assert output =~ "Mix 1.99.0 test"
        assert output =~ "launcher: direct"
        assert normalize_path_fragment(output) =~ "mixbuildroot: #{normalize_path_fragment(sympp_home)}"
      after
        File.rm_rf!(temp_codex_home)
      end
    end
  end

  defp write_cached_script(cache_root, source_script_path) do
    target = Path.join([cache_root, "scripts", Path.basename(source_script_path)])
    File.mkdir_p!(Path.dirname(target))
    File.write!(Path.join(cache_root, ".sympp-source-revision"), "#{String.duplicate("b", 40)}\n")
    File.cp!(source_script_path, target)

    for helper_name <-
          ~w(sympp-launcher-runtime.ps1 sympp-mcp-launcher-helpers.ps1 sympp-mcp-artifact-manifest.ps1 sympp-mcp-artifact-channel.ps1 sympp-mcp-artifact-runtime.ps1 sympp-mcp-process-runtime.ps1 ) do
      source_helper = Path.join(Path.dirname(source_script_path), helper_name)

      if File.exists?(source_helper) do
        File.cp!(source_helper, Path.join(Path.dirname(target), helper_name))
      end
    end

    target
  end

  defp write_cache_manifest(cache_root, plugin_name, _opts \\ []) do
    File.mkdir_p!(cache_root)
    File.write!(Path.join(cache_root, "package.json"), Jason.encode!(%{"name" => plugin_name, "version" => @plugin_version}))
  end

  defp write_minimal_source(codex_home) do
    source_root = Path.join(codex_home, "source-checkout")
    File.mkdir_p!(source_root)
    File.mkdir_p!(Path.join(source_root, "elixir"))
    File.write!(Path.join(source_root, "elixir/mix.exs"), "defmodule SymphonyElixir.MixProject do\nend\n")
    File.mkdir_p!(Path.join(source_root, "elixir/lib/mix/tasks"))
    File.mkdir_p!(Path.join(source_root, "scripts"))
    File.write!(Path.join(source_root, "scripts/smoke-sympp-mcp-http.ps1"), "")
    File.mkdir_p!(Path.join(source_root, "elixir/priv/symphony_plus_plus"))

    File.cp!(
      Path.join(@repo_root, "elixir/priv/symphony_plus_plus/mcp_contract.json"),
      Path.join(source_root, "elixir/priv/symphony_plus_plus/mcp_contract.json")
    )

    File.mkdir_p!(Path.join(source_root, "packages/sympp/scripts"))

    File.cp!(
      @mcp_plugin_start_script_path,
      Path.join(source_root, "packages/sympp/scripts/start-sympp-mcp.ps1")
    )

    for helper_name <-
          ~w(sympp-launcher-runtime.ps1 sympp-mcp-launcher-helpers.ps1 sympp-mcp-artifact-manifest.ps1 sympp-mcp-artifact-channel.ps1 sympp-mcp-artifact-runtime.ps1 sympp-mcp-process-runtime.ps1) do
      File.cp!(
        Path.join(Path.dirname(@mcp_plugin_start_script_path), helper_name),
        Path.join(source_root, "packages/sympp/scripts/#{helper_name}")
      )
    end

    write_cache_manifest(Path.join(source_root, "packages/sympp"), "symphony-plus-plus-mcp", mcp?: true)

    source_root
  end

  defp fake_mix_executable(temp_root) do
    path = Path.join(temp_root, if(windows?(), do: "mix.cmd", else: "mix"))
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, fake_mix_script())

    unless windows?() do
      File.chmod!(path, 0o755)
    end

    path
  end

  defp fake_mise_executable(temp_root) do
    path = Path.join(temp_root, if(windows?(), do: "mise.cmd", else: "mise"))
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, fake_mise_script())

    unless windows?() do
      File.chmod!(path, 0o755)
    end

    path
  end

  defp fake_failing_mise_executable(temp_root) do
    path = Path.join(temp_root, if(windows?(), do: "failing-mise.cmd", else: "failing-mise"))
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, fake_failing_mise_script())

    unless windows?() do
      File.chmod!(path, 0o755)
    end

    path
  end

  defp fake_mix_script do
    if windows?() do
      """
      @echo off
      if not "%SYMPP_FAKE_MIX_LOG%"=="" echo %*>>"%SYMPP_FAKE_MIX_LOG%"
      if "%~1"=="--version" (
        echo Mix 1.99.0 test
        exit /b 0
      )
      if "%~1"=="deps.get" (
        if "%~2"=="--check-locked" exit /b 0
        exit /b 3
      )
      if "%~1"=="compile" (
        exit /b 0
      )
      if "%~1"=="sympp.mcp" (
        exit /b 0
      )
      echo unexpected mix args: %*
      exit /b 2
      """
    else
      """
      #!/usr/bin/env sh
      if [ -n "$SYMPP_FAKE_MIX_LOG" ]; then
        printf '%s\\n' "$*" >> "$SYMPP_FAKE_MIX_LOG"
      fi
      if [ "$1" = "--version" ]; then
        echo "Mix 1.99.0 test"
        exit 0
      fi
      if [ "$1" = "deps.get" ]; then
        if [ "$2" = "--check-locked" ]; then
          exit 0
        fi
        exit 3
      fi
      if [ "$1" = "compile" ]; then
        exit 0
      fi
      if [ "$1" = "sympp.mcp" ]; then
        exit 0
      fi
      echo "unexpected mix args: $*" >&2
      exit 2
      """
    end
  end

  defp fake_mise_script do
    if windows?() do
      """
      @echo off
      if not "%SYMPP_FAKE_MISE_LOG%"=="" echo %*>>"%SYMPP_FAKE_MISE_LOG%"
      if "%~1"=="exec" if "%~2"=="--" if "%~3"=="mix" if "%~4"=="--version" (
        echo Mix 1.98.0 mise
        exit /b 0
      )
      if "%~1"=="exec" if "%~2"=="--" if "%~3"=="mix" if "%~4"=="deps.get" if "%~5"=="--check-locked" (
        exit /b 0
      )
      echo unexpected mise args: %*
      exit /b 2
      """
    else
      """
      #!/usr/bin/env sh
      if [ -n "$SYMPP_FAKE_MISE_LOG" ]; then
        printf '%s\\n' "$*" >> "$SYMPP_FAKE_MISE_LOG"
      fi
      if [ "$1" = "exec" ] && [ "$2" = "--" ] && [ "$3" = "mix" ] && [ "$4" = "--version" ]; then
        echo "Mix 1.98.0 mise"
        exit 0
      fi
      if [ "$1" = "exec" ] && [ "$2" = "--" ] && [ "$3" = "mix" ] && [ "$4" = "deps.get" ] && [ "$5" = "--check-locked" ]; then
        exit 0
      fi
      echo "unexpected mise args: $*" >&2
      exit 2
      """
    end
  end

  defp fake_failing_mise_script do
    if windows?() do
      """
      @echo off
      echo failing mise args: %* 1>&2
      exit /b 2
      """
    else
      """
      #!/usr/bin/env sh
      echo "failing mise args: $*" >&2
      exit 2
      """
    end
  end

  defp windows?, do: match?({:win32, _name}, :os.type())

  defp normalize_path_fragment(value) do
    value
    |> String.replace("\\", "/")
    |> String.downcase()
  end

  defp unique_temp_path(prefix) do
    Path.join(System.tmp_dir!(), "#{prefix}-#{unique_id()}")
  end

  defp unique_id do
    id = "#{System.pid()}-#{System.os_time(:nanosecond)}-#{System.unique_integer([:positive])}"
    String.replace(id, ~r/[^A-Za-z0-9_.-]/, "-")
  end

  defp plugin_cache_path(codex_home, suffix, plugin_name \\ "symphony-plus-plus") do
    Path.join([codex_home, "installed", plugin_name] ++ suffix)
  end
end
