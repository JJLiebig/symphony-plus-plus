defmodule SymphonyElixir.SymphonyPlusPlus.ReviewObservationTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.SymphonyPlusPlus.ReviewObservation
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage

  test "literal declared bases isolate grouping and cached outcomes in one worktree", %{test: test} do
    %{codex_home: codex_home, worktree: worktree, plugin: plugin, package: package} = fixture(test)
    frozen_base = String.duplicate("a", 40)
    frozen = %{package | id: "frozen", review_requirement: %{type: "review-suite", args: %{base: frozen_base}}}
    {:ok, calls} = Agent.start_link(fn -> [] end)

    runner = fn
      _, ["plugin", "list", "--json"], _, _ ->
        {:ok, plugin_json(plugin)}

      _, [_script, "--status", "--json", "--cd", ^worktree, "--base", base], _, _ ->
        Agent.update(calls, &[base | &1])
        status = if base == frozen_base, do: "done", else: "stale"
        {:ok, Jason.encode!(%{review: "rvw_" <> base, status: status})}
    end

    opts = test_opts(runner, codex_home)
    observed = ReviewObservation.observe([package, frozen], opts)
    assert observed[package.id].status == "failed"
    assert observed[frozen.id].status == "passed"
    assert Enum.sort(Agent.get(calls, & &1)) == Enum.sort(["origin/beta", frozen_base])
    assert ReviewObservation.cached([package, frozen], opts) == observed
    assert ReviewObservation.observe([package, frozen], opts) == observed
    assert length(Agent.get(calls, & &1)) == 2
  end

  test "concurrent refreshes share one provider invocation", %{test: test} do
    %{codex_home: codex_home, worktree: worktree, plugin: plugin, package: package} = fixture(test)
    {:ok, calls} = Agent.start_link(fn -> 0 end)

    runner = fn _, args, _, _ ->
      Agent.update(calls, &(&1 + 1))

      case args do
        ["plugin", "list", "--json"] ->
          Process.sleep(50)
          {:ok, plugin_json(plugin)}

        [_script, "--status", "--json", "--cd", ^worktree, "--base", "origin/beta"] ->
          {:ok, Jason.encode!(%{"review" => "rvw_shared", "status" => "reviewing"})}
      end
    end

    table = :ets.new(:review_observation_test, [:set, :public])
    opts = Keyword.put(test_opts(runner, codex_home), :cache_table, table)
    tasks = for _ <- 1..2, do: Task.async(fn -> ReviewObservation.observe([package], opts) end)
    results = Enum.map(tasks, &Task.await/1)

    assert Enum.any?(results, &(&1 != %{}))
    assert Agent.get(calls, & &1) == 2
  end

  test "forced refresh cleanup removes only the killed owner lock" do
    table = :ets.new(:review_observation_test, [:set, :public])
    owner = spawn(fn -> Process.sleep(:infinity) end)
    other = spawn(fn -> Process.sleep(:infinity) end)
    true = :ets.insert(table, {:refreshing, owner})

    assert ReviewObservation.release_refresh(other, table) == :ok
    assert :ets.lookup(table, :refreshing) == [{:refreshing, owner}]
    assert ReviewObservation.release_refresh(owner, table) == :ok
    assert :ets.lookup(table, :refreshing) == []

    Process.exit(owner, :kill)
    Process.exit(other, :kill)
  end

  defp fixture(test) do
    root = Path.join(System.tmp_dir!(), "sympp-review-observation-#{test}")
    worktree = Path.join(root, "worktree")
    plugin = Path.join([root, "plugins", "cache", "review-suite", "review-suite", "1.2.3"])
    File.mkdir_p!(worktree)
    File.mkdir_p!(Path.join(plugin, "scripts"))
    File.write!(Path.join([plugin, "scripts", "review.py"]), "# fixture\n")

    on_exit(fn -> File.rm_rf!(root) end)

    %{
      codex_home: root,
      worktree: Path.expand(worktree),
      plugin: plugin,
      package: %WorkPackage{
        id: "wp-observed",
        status: "reviewing",
        base_branch: "beta",
        worktree_path: worktree,
        review_requirement: %{"type" => "review-suite", "args" => %{"mode" => "fast"}}
      }
    }
  end

  defp test_opts(runner, codex_home) do
    [
      cache_table: :ets.new(:review_observation_test, [:set, :public]),
      runner: runner,
      codex_home: codex_home,
      find_executable: fn name -> name end,
      now_ms: 10_000
    ]
  end

  defp plugin_json(plugin), do: Jason.encode!(%{"installed" => [installed_plugin(plugin)]})

  defp installed_plugin(_plugin) do
    %{
      "pluginId" => "review-suite@review-suite",
      "enabled" => true,
      "version" => "1.2.3",
      "source" => %{"source" => "git-subdir", "path" => "plugins/review-suite", "url" => "https://example.invalid/review-suite.git"}
    }
  end
end
