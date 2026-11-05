defmodule SymphonyElixir.SymphonyPlusPlus.ReviewObservationTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.SymphonyPlusPlus.ReviewObservation
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.DeliveryBoard.Signals

  test "skills bundle in the user home supplies review status when no marketplace plugin is enabled", %{test: test} do
    %{codex_home: codex_home, plugin: plugin, package: package} = fixture(test)
    script = portable_script(codex_home)
    File.mkdir_p!(Path.dirname(script))
    File.write!(script, "# portable fixture\n")

    for installed <- [[], [Map.put(installed_plugin(plugin), "enabled", false)]] do
      runner = fn
        _, ["plugin", "list", "--json"], _, _ -> {:ok, Jason.encode!(%{installed: installed})}
        _, [^script, "--status" | _args], _, _ -> {:ok, Jason.encode!(%{review: "rvw_portable", status: "running", rounds: 3})}
      end

      observation = ReviewObservation.observe([package], test_opts(runner, codex_home))[package.id]
      assert observation.evidence_id == "rvw_portable"
      assert observation.round == 3
    end
  end

  test "marketplace plugin keeps precedence over the skills bundle", %{test: test} do
    %{codex_home: codex_home, plugin: plugin, package: package} = fixture(test)
    portable = portable_script(codex_home)
    File.mkdir_p!(Path.dirname(portable))
    File.write!(portable, "# portable fixture\n")
    script = Path.join([plugin, "scripts", "review.py"])

    runner = fn
      _, ["plugin", "list", "--json"], _, _ -> {:ok, plugin_json(plugin)}
      _, [^script, "--status" | _args], _, _ -> {:ok, Jason.encode!(%{review: "rvw_plugin", status: "done"})}
      _, [_other_script, "--status" | _args], _, _ -> {:ok, Jason.encode!(%{review: "rvw_unexpected", status: "done"})}
    end

    assert ReviewObservation.observe([package], test_opts(runner, codex_home))[package.id].evidence_id == "rvw_plugin"
    File.rm!(script)
    assert ReviewObservation.observe([package], test_opts(runner, codex_home)) == %{}
  end

  test "portable discovery requires a regular file at the fixed user-home location", %{test: test} do
    %{codex_home: codex_home, worktree: worktree, package: package} = fixture(test)
    File.write!(Path.join(worktree, "review.py"), "# untrusted fixture\n")

    runner = fn
      _, ["plugin", "list", "--json"], _, _ -> {:ok, Jason.encode!(%{installed: []})}
      _, _unexpected_command, _, _ -> {:ok, Jason.encode!(%{review: "rvw_unexpected", status: "done"})}
    end

    assert ReviewObservation.observe([package], test_opts(runner, codex_home)) == %{}
    File.mkdir_p!(portable_script(codex_home))
    assert ReviewObservation.observe([package], test_opts(runner, codex_home)) == %{}
  end

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
        {:ok, Jason.encode!(%{review: "rvw_" <> base, status: status, rounds: 0})}
    end

    opts = test_opts(runner, codex_home)
    observed = ReviewObservation.observe([package, frozen], opts)
    assert observed[package.id].status == "failed"
    assert observed[frozen.id].status == "passed"
    signal = Signals.review(package, %{}, observed[package.id])
    assert signal.round == 0
    assert signal.provider_status == "stale"
    refute Map.has_key?(signal, :steps)
    refute Map.has_key?(signal, :round_history)
    assert Enum.sort(Agent.get(calls, & &1)) == Enum.sort(["origin/beta", frozen_base])
    assert ReviewObservation.cached([package, frozen], opts) == observed
    assert ReviewObservation.observe([package, frozen], opts) == observed
    assert length(Agent.get(calls, & &1)) == 2

    unobserved = %{frozen | id: "other", review_requirement: %{type: "review-suite", args: %{base: "beta"}}}
    true = :ets.insert(opts[:cache_table], {:refreshing, self()})
    assert ReviewObservation.observe([package, frozen, unobserved], opts) == observed
    assert ReviewObservation.cached([unobserved], opts) == %{}
  end

  test "provider rounds, ladder and history reach the review signal without changing normalized status", %{test: test} do
    %{codex_home: codex_home, plugin: plugin, package: package} = fixture(test)

    steps = [
      %{index: 1, name: "initial", state: "done"},
      %{index: 2, name: "correctness", state: "current"},
      %{index: 3, name: "final", state: "pending"}
    ]

    history = [
      %{
        number: 1,
        round_id: "round_1",
        lane: "local",
        step: "initial",
        status: "done",
        outcome: "findings",
        findings: 2,
        started_at: "2026-10-01T09:00:00Z",
        finished_at: "2026-10-01T09:05:00Z"
      },
      %{
        number: 2,
        round_id: "round_2",
        lane: "local",
        step: "correctness",
        status: "running",
        outcome: nil,
        findings: nil,
        started_at: "2026-10-01T09:10:00Z",
        finished_at: nil
      }
    ]

    payload = %{
      review: "rvw_progress",
      status: "fix-pending",
      rounds: 3,
      round: "99",
      progress: "2/3",
      current: "correctness",
      mode: "fast",
      head: "abc123",
      next_action: "fix",
      started_at: "2026-10-01T11:00:00+02:00",
      round_started_at: "2026-10-01T09:10:00Z",
      steps: steps,
      round_history: history,
      future_field: true
    }

    runner = fn
      _, ["plugin", "list", "--json"], _, _ -> {:ok, plugin_json(plugin)}
      _, [_script, "--status" | _args], _, _ -> {:ok, Jason.encode!(payload)}
    end

    observation = ReviewObservation.observe([package], test_opts(runner, codex_home))[package.id]
    signal = Signals.review(package, %{}, observation)
    assert signal.round == 3
    assert signal.steps == steps
    assert signal.round_history == history
    assert signal.status == "failed"
    assert signal.provider_status == "fix-pending"
    assert signal.current == 2
    assert signal.total == 3
    assert signal.step == "correctness"
    assert signal.mode == "fast"
    assert signal.reviewed_head == "abc123"
    assert signal.next_action == "fix"
    assert signal.started_at == "2026-10-01T09:00:00Z"
    assert signal.round_started_at == "2026-10-01T09:10:00Z"
  end

  test "provider collections are bounded and sanitize malformed fields", %{test: test} do
    %{codex_home: codex_home, plugin: plugin, package: package} = fixture(test)
    long_name = String.duplicate("x", 300)

    history =
      for number <- 1..22 do
        %{
          number: number,
          round_id: "  " <> long_name,
          lane: %{invalid: true},
          step: " correctness ",
          status: " running ",
          outcome: " ",
          findings: -1,
          started_at: "invalid",
          finished_at: "2026-10-01T11:05:00+02:00",
          future: true
        }
      end

    payload = %{
      review: "rvw_bounded",
      status: "running",
      rounds: "3",
      started_at: "invalid",
      round_started_at: 123,
      steps: [nil, %{index: -1, name: "  " <> long_name, state: " current ", future: true}] ++ List.duplicate(%{index: 3}, 25),
      round_history: history
    }

    runner = fn
      _, ["plugin", "list", "--json"], _, _ -> {:ok, plugin_json(plugin)}
      _, [_script, "--status" | _args], _, _ -> {:ok, Jason.encode!(payload)}
    end

    observation = ReviewObservation.observe([package], test_opts(runner, codex_home))[package.id]
    refute Map.has_key?(observation, :round)
    refute Map.has_key?(observation, :started_at)
    refute Map.has_key?(observation, :round_started_at)
    assert length(observation.steps) <= 20
    assert hd(observation.steps) == %{name: String.duplicate("x", 240), state: "current"}
    assert Enum.map(observation.round_history, & &1.number) == Enum.to_list(3..22)

    assert hd(observation.round_history) == %{
             number: 3,
             round_id: String.duplicate("x", 240),
             lane: nil,
             step: "correctness",
             status: "running",
             outcome: nil,
             findings: nil,
             started_at: nil,
             finished_at: "2026-10-01T09:05:00Z"
           }
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
      user_home: Path.join(codex_home, "home"),
      find_executable: fn name -> name end,
      now_ms: 10_000
    ]
  end

  defp portable_script(codex_home) do
    Path.join([codex_home, "home", ".agents", "skills", "review-suite", "plugins", "review-suite", "scripts", "review.py"])
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
