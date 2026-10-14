defmodule Mix.Tasks.Workspace.BeforeRemoveTest do
  use ExUnit.Case, async: false

  alias Mix.Tasks.Workspace.BeforeRemove

  import ExUnit.CaptureIO

  setup do
    Mix.Task.reenable("workspace.before_remove")
    previous_path = System.get_env("PATH")
    System.put_env("PATH", "")

    on_exit(fn ->
      if previous_path, do: System.put_env("PATH", previous_path), else: System.delete_env("PATH")
    end)
  end

  test "no-ops when branch is unavailable" do
    assert capture_io(fn -> BeforeRemove.run([]) end) == ""
  end

  test "no-ops when gh is unavailable" do
    assert capture_io(fn -> BeforeRemove.run(["--branch", "feature/no-gh"]) end) == ""
  end
end
