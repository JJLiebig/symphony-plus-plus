defmodule SymphonyElixir.SymphonyPlusPlus.SessionFocusTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.SymphonyPlusPlus.SessionFocus

  test "missing, remote and described sessions are normal outcomes without probing Herdr" do
    opts = [machine_id: "host-a", request: fn _, _ -> flunk("unexpected Herdr probe") end]
    assert SessionFocus.focus_location(nil, opts).reason == "session_gone"
    assert SessionFocus.focus_location(%{location() | machine_id: "host-b"}, opts).reason == "other_machine"
    assert SessionFocus.focus_location(%{location() | source: "agent"}, opts).reason == "not_in_herdr"
  end

  test "focus follows the uniquely identified current terminal and sends no input" do
    pane = pane()
    request = fn
      _, ["api", "snapshot"] -> {:ok, %{"snapshot" => %{"panes" => [%{pane | "pane_id" => "w2:p9"}]}}}
      _, ["agent", "focus", "w2:p9"] -> {:ok, %{"agent" => pane}}
    end

    assert SessionFocus.focus_location(location(), machine_id: "host-a", request: request) == %{ok: true, status: "focused", reason: nil}
  end

  test "client token fallback requires the exact role and target binding" do
    location = %{location() | herdr: %{}}
    tokens = %{"sympp_session_location_id" => location.client_id, "sympp_role" => "worker", "sympp_work_package_id" => location.target_id}
    pane = %{pane() | "agent_session" => nil} |> Map.put("tokens", tokens)

    assert focus_with_panes(location, [pane]).status == "focused"
    assert focus_with_panes(location, [put_in(pane, ["tokens", "sympp_role"], "architect")]).reason == "session_gone"
    assert focus_with_panes(location, [put_in(pane, ["tokens", "sympp_work_package_id"], "package-other")]).reason == "session_gone"

    architect = %{location | target_kind: "work_request", target_id: "goal-a", role: "architect"}
    architect_pane = put_in(pane, ["tokens"], %{"sympp_session_location_id" => location.client_id, "sympp_role" => "architect", "sympp_work_request_id" => "goal-a"})
    assert focus_with_panes(architect, [architect_pane]).status == "focused"
    coordinator = %{architect | role: "coordinator"}
    assert focus_with_panes(coordinator, [put_in(architect_pane, ["tokens", "sympp_role"], "coordinator")]).status == "focused"
  end

  test "gone, ended, reused and ambiguous panes never get focused" do
    location = location()
    pane = pane()
    assert focus_with_panes(location, []).reason == "session_gone"
    assert focus_with_panes(location, [%{pane | "agent" => nil}]).reason == "session_gone"
    assert focus_with_panes(location, [put_in(pane, ["agent_session", "value"], "replacement-session")]).reason == "session_gone"
    assert focus_with_panes(location, [put_in(pane, ["agent_session", "agent"], "claude")]).reason == "session_gone"
    assert focus_with_panes(location, [pane, %{pane | "terminal_id" => "duplicate"}]).reason == "identity_mismatch"
  end

  test "unreachable Herdr and a terminal disappearing during focus are normal outcomes" do
    assert SessionFocus.focus_location(location(), machine_id: "host-a", request: fn _, _ -> {:error, :unreachable} end).reason == "herdr_unreachable"

    request = fn
      _, ["api", "snapshot"] -> {:ok, %{"snapshot" => %{"panes" => [pane()]}}}
      _, ["agent", "focus", "w1:p1"] -> {:error, :session_gone}
    end

    assert SessionFocus.focus_location(location(), machine_id: "host-a", request: request).reason == "session_gone"
  end

  test "an occupant changing during focus cannot be reported as success" do
    request = fn
      _, ["api", "snapshot"] -> {:ok, %{"snapshot" => %{"panes" => [pane()]}}}
      _, ["agent", "focus", "w1:p1"] -> {:ok, %{"agent" => %{pane() | "terminal_id" => "replacement"}}}
    end

    assert SessionFocus.focus_location(location(), machine_id: "host-a", request: request).reason == "identity_mismatch"
  end

  @tag skip: match?({:win32, _}, :os.type())
  test "CLI adapter scopes both calls to the stored selector and sends only snapshot and focus" do
    path = Path.join(System.tmp_dir!(), "sympp-focus-cli-#{System.unique_integer([:positive])}")
    previous = Map.new(["HERDR_BIN_PATH", "HERDR_SESSION", "HERDR_SOCKET_PATH"], &{&1, System.get_env(&1)})

    File.write!(path, """
    #!/bin/sh
    test "$HERDR_SESSION" = "recorded-session" || exit 1
    test -z "$HERDR_SOCKET_PATH" || exit 1
    case "$*" in
      'api snapshot') printf '%s\\n' '#{Jason.encode!(%{result: %{snapshot: %{panes: [pane()]}}})}' ;;
      'agent focus w1:p1') printf '%s\\n' '#{Jason.encode!(%{result: %{agent: pane()}})}' ;;
      *) exit 1 ;;
    esac
    """)

    File.chmod!(path, 0o755)
    System.put_env("HERDR_BIN_PATH", path)
    System.put_env("HERDR_SESSION", "inherited-session")
    System.put_env("HERDR_SOCKET_PATH", "inherited-socket")

    try do
      location = %{location() | herdr: Map.put(location().herdr, "session", "recorded-session")}
      assert SessionFocus.focus_location(location, machine_id: "host-a").status == "focused"

      File.write!(path, "#!/bin/sh\nprintf '%s\\n' '{\"error\":{\"code\":\"agent_not_found\"}}' >&2\nexit 1\n")
      assert SessionFocus.focus_location(location, machine_id: "host-a").reason == "session_gone"

      File.write!(path, "#!/bin/sh\nprintf '%s\\n' 'not JSON'\nexit 1\n")
      assert SessionFocus.focus_location(location, machine_id: "host-a").reason == "herdr_unreachable"
    after
      Enum.each(previous, fn
        {key, nil} -> System.delete_env(key)
        {key, value} -> System.put_env(key, value)
      end)

      File.rm(path)
    end
  end

  defp focus_with_panes(location, panes) do
    request = fn
      _, ["api", "snapshot"] -> {:ok, %{"snapshot" => %{"panes" => panes}}}
      _, ["agent", "focus", id] -> {:ok, %{"agent" => Enum.find(panes, &(&1["pane_id"] == id))}}
    end

    SessionFocus.focus_location(location, machine_id: "host-a", request: request)
  end

  defp location do
    %{
      target_kind: "work_package",
      target_id: "package-a",
      role: "worker",
      client_id: "client-a",
      machine_id: "host-a",
      source: "herdr",
      herdr: %{"pane_id" => "w1:p1", "native_session_id" => "native-session", "native_session_agent" => "codex"}
    }
  end

  defp pane do
    %{
      "pane_id" => "w1:p1",
      "terminal_id" => "terminal-unique",
      "agent" => "codex",
      "agent_session" => %{"agent" => "codex", "kind" => "id", "value" => "native-session"}
    }
  end
end
