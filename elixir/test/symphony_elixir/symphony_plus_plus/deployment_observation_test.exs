defmodule SymphonyElixir.SymphonyPlusPlus.DeploymentObservationTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.SymphonyPlusPlus.DeploymentObservation

  @repo "acme-labs/compass"
  @sha_a String.duplicate("a", 40)
  @sha_b String.duplicate("b", 40)
  @sha_c String.duplicate("c", 40)
  @sha_d String.duplicate("d", 40)
  @config %{"repos" => %{@repo => %{"deploy_workflows" => %{"dev" => "deploy-dev.yml"}}}}

  setup do
    %{table: :ets.new(:deployment_observation_test, [:set, :public])}
  end

  test "all delivered revisions must be present and observations do not change completion", %{table: table} do
    payload = payload([package(@sha_a), package(@sha_b)])
    responses = responses([run(1, @sha_c, "success")], %{{@sha_a, @sha_c} => "ahead", {@sha_b, @sha_c} => "ahead"})
    result = enrich(payload, responses, table)

    assert result.work_request_details |> hd() |> get_in([:work_request, :deployments, @repo, "dev", :status]) == "ok"
    assert [card] = result.work_requests.work_requests
    assert card.default_branch == "trunk"
    assert card.completed_at == "2026-10-10T10:00:00Z"
    assert card.deployments[@repo]["dev"].revision == @sha_c
    assert card.deployments[@repo]["dev"].at == "2026-10-10T11:00:00Z"
    assert card.deployments[@repo]["dev"].observed_at
    assert Map.drop(card, [:deployments, :default_branch]) == hd(payload.work_requests.work_requests)

    # A second merge that is absent prevents a whole-goal deployment claim.
    result = enrich(payload, responses([run(1, @sha_c, "success")], %{{@sha_a, @sha_c} => "ahead", {@sha_b, @sha_c} => "diverged"}))
    assert status(result) == "pending"
  end

  test "rollback supersedes old success while a later failed unrelated run leaves the current deployment", %{table: table} do
    old = run(1, @sha_a, "success")
    rollback = run(2, @sha_b, "success", "2026-10-10T12:00:00Z")
    failed = run(3, @sha_c, "failure", "2026-10-10T13:00:00Z")

    result = enrich(payload(), responses([failed, rollback, old], %{{@sha_a, @sha_b} => "behind", {@sha_a, @sha_c} => "ahead"}), table)
    assert status(result) == "failed"

    result = enrich(payload(), responses([failed, old], %{}))
    assert status(result) == "ok"
    assert deployment(result).run_id == 1

    result = enrich(payload(), responses([rollback, old], %{{@sha_a, @sha_b} => "diverged"}))
    assert status(result) == "pending"
    assert deployment(result).at == nil
  end

  test "retry update time beats creation order and foreign or PR runs cannot claim deployment" do
    retry = run(1, @sha_b, "success", "2026-10-10T14:00:00Z") |> Map.put("run_attempt", 2)
    old = run(2, @sha_a, "success", "2026-10-10T12:00:00Z")
    foreign = run(3, @sha_a, "success", "2026-10-10T15:00:00Z") |> Map.put("head_repository", %{"full_name" => "outsider/compass"})
    pr = run(4, @sha_a, "success", "2026-10-10T16:00:00Z") |> Map.put("event", "pull_request")
    result = enrich(payload(), responses([pr, foreign, old, retry], %{{@sha_a, @sha_b} => "behind"}))
    assert status(result) == "pending"
    assert deployment(result).at == nil
  end

  test "pending work and no-PR delivery never fabricate a deployed revision" do
    unfinished = payload() |> put_in([:work_request_details, Access.at(0), :work_request, :completed_at], nil)
    assert status(enrich(unfinished, responses([run(1, @sha_a, "success")], %{}))) == "pending"

    no_pr = package(@sha_a) |> put_in([:delivery], %{"outcome" => "completed_no_pr"})
    mixed = payload([package(@sha_a), no_pr, package(@sha_b, "abandoned"), package(@sha_c, "superseded")])
    assert status(enrich(mixed, responses([run(1, @sha_a, "success")], %{}))) == "ok"
    result = enrich(payload([no_pr]), responses([], %{}))
    refute Map.has_key?(hd(result.work_requests.work_requests), :deployments)

    result = DeploymentObservation.enrich(payload(), %{}, fetch: fn _, _ -> flunk("untagged repo must not make requests") end)
    refute Map.has_key?(hd(result.work_requests.work_requests), :deployments)
    refute Map.has_key?(hd(result.work_requests.work_requests), :default_branch)
  end

  test "permission, missing comparison, incomplete pagination and exhausted budget stay pending" do
    error = fn _, _ -> {:error, :forbidden} end
    result = DeploymentObservation.enrich(payload(), @config, fetch: error, cache_table: :ets.new(:permission, [:set, :public]))
    assert status(result) == "pending"
    assert deployment(result).at == nil

    assert status(enrich(payload(), responses([run(1, @sha_b, "success")], %{}))) == "pending"

    fetch = fn path, _ ->
      if String.contains?(path, "/runs?"),
        do: {:ok, %{"workflow_runs" => [run(1, @sha_a, "success")], "total_count" => 1001}},
        else: {:ok, %{"default_branch" => "trunk"}}
    end

    result = DeploymentObservation.enrich(payload(), @config, fetch: fetch, cache_table: :ets.new(:pages, [:set, :public]))
    assert status(result) == "pending"
    assert deployment(result).reason == "unavailable"

    result = DeploymentObservation.enrich(payload(), @config, fetch: error, request_limit: 0, cache_table: :ets.new(:budget, [:set, :public]))
    assert status(result) == "pending"
    assert deployment(result).observed_at == nil
  end

  test "complete pagination sees later reruns and shared repo observations use one cached response", %{table: table} do
    first_page = Enum.map(1..100, &run(&1, @sha_a, "success"))
    retry = run(101, @sha_b, "success", "2026-10-10T15:00:00Z")
    caller = self()

    fetch = fn path, _ ->
      send(caller, {:fetch, path})

      cond do
        String.ends_with?(path, "page=1") -> {:ok, %{"workflow_runs" => first_page, "total_count" => 101}}
        String.ends_with?(path, "page=2") -> {:ok, %{"workflow_runs" => [retry], "total_count" => 101}}
        String.contains?(path, "/compare/") -> {:ok, %{"status" => "behind"}}
        true -> {:ok, %{"default_branch" => "trunk"}}
      end
    end

    result = DeploymentObservation.enrich(payload(), @config, fetch: fetch, cache_table: table)
    assert status(result) == "pending"
    assert_receive {:fetch, "repos/" <> _}

    result = DeploymentObservation.enrich(payload(), @config, fetch: fn _, _ -> flunk("cache should satisfy repeat read") end, cache_table: table)
    assert status(result) == "pending"
  end

  test "repos remain independent and live attempts carry their own start time" do
    other = "acme-labs/atlas"
    other_package = package(@sha_d) |> Map.put(:repo_remote, other) |> put_in([:delivery, "pr_repository"], other)
    config = put_in(@config, ["repos", other], %{"deploy_workflows" => %{"prod" => "release.yml"}})
    live = run(5, @sha_d, nil) |> Map.merge(%{"status" => "in_progress", "run_started_at" => "2026-10-10T10:30:00Z", "repository" => %{"full_name" => other}, "head_repository" => %{"full_name" => other}})

    fetch = fn path, _ ->
      cond do
        String.contains?(path, "release.yml") -> {:ok, %{"workflow_runs" => [live], "total_count" => 1}}
        String.contains?(path, "deploy-dev.yml") -> {:ok, %{"workflow_runs" => [run(1, @sha_a, "success")], "total_count" => 1}}
        true -> {:ok, %{"default_branch" => "trunk"}}
      end
    end

    result = DeploymentObservation.enrich(payload([package(@sha_a), other_package]), config, fetch: fetch, cache_table: :ets.new(:multiple, [:set, :public]))
    assert deployment(result).status == "ok"
    assert [card] = result.work_requests.work_requests
    assert card.deployments[other]["prod"].status == "pending"
    assert card.deployments[other]["prod"].at == "2026-10-10T10:30:00Z"
    refute Map.has_key?(card.deployments[other], "dev")
  end

  defp enrich(payload, responses, table \\ :ets.new(:observation, [:set, :public])) do
    DeploymentObservation.enrich(payload, @config, cache_table: table, fetch: fn path, _ -> Map.get(responses, path, {:error, :not_found}) end)
  end

  defp status(result), do: deployment(result).status
  defp deployment(result), do: hd(result.work_requests.work_requests).deployments[@repo]["dev"]

  defp payload(packages \\ [package(@sha_a)]) do
    request = %{id: "WR-COMPASS", repo_remote: @repo, completed_at: "2026-10-10T10:00:00Z", base_branch: "beta"}
    %{work_requests: %{work_requests: [request]}, work_request_details: [%{work_request: request, work_packages: packages}]}
  end

  defp package(sha, outcome \\ "pr_merged") do
    %{repo_remote: @repo, status: "merged", delivery: %{"outcome" => outcome, "pr_repository" => @repo, "merge_commit_sha" => sha}}
  end

  defp responses(runs, comparisons) do
    comparisons
    |> Map.new(fn {{base, head}, status} -> {"repos/#{@repo}/compare/#{base}...#{head}?per_page=1", {:ok, %{"status" => status}}} end)
    |> Map.put("repos/#{@repo}/actions/workflows/deploy-dev.yml/runs?per_page=100&page=1", {:ok, %{"workflow_runs" => runs, "total_count" => length(runs)}})
    |> Map.put("repos/#{@repo}", {:ok, %{"default_branch" => "trunk"}})
  end

  defp run(id, head, conclusion, updated_at \\ "2026-10-10T11:00:00Z") do
    %{"id" => id, "head_sha" => head, "conclusion" => conclusion, "status" => "completed", "event" => "push", "updated_at" => updated_at,
      "repository" => %{"full_name" => @repo}, "head_repository" => %{"full_name" => @repo}}
  end
end
