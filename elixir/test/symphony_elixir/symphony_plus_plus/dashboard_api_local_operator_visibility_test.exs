defmodule SymphonyElixir.SymphonyPlusPlus.DashboardApiLocalOperatorVisibilityTest do
  use ExUnit.Case, async: false

  import Phoenix.ConnTest
  import Plug.Conn, only: [put_req_header: 3]

  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.AccessGrant
  alias SymphonyElixir.SymphonyPlusPlus.AgentRuns.AgentRun
  alias SymphonyElixir.SymphonyPlusPlus.Comments.Comment
  alias SymphonyElixir.SymphonyPlusPlus.GuidanceRequests.GuidanceRequest
  alias SymphonyElixir.SymphonyPlusPlus.OperatorAudit
  alias SymphonyElixir.SymphonyPlusPlus.OperatorConfig
  alias SymphonyElixir.SymphonyPlusPlus.OperatorSettings.Settings, as: OperatorSettings
  alias SymphonyElixir.SymphonyPlusPlus.Phases.Phase
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Artifact
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Finding
  alias SymphonyElixir.SymphonyPlusPlus.Planning.PlanNode
  alias SymphonyElixir.SymphonyPlusPlus.Planning.ProgressEvent
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.SoloSessions.SoloSession
  alias SymphonyElixir.SymphonyPlusPlus.SoloSessions.SoloSessionEntry
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackageDelivery
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.ClarificationQuestion
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.DecisionLogEntry
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository, as: WorkRequestRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest
  alias SymphonyElixir.WorkPackageFactory

  @endpoint SymphonyElixirWeb.Endpoint

  setup_all do
    database_path = WorkPackageFactory.database_path()
    original_database = Application.get_env(:symphony_elixir, :sympp_repo_database)

    start_supervised!({Repo, database: database_path, pool_size: 5})
    assert :ok = WorkPackageRepository.migrate(Repo)
    Application.put_env(:symphony_elixir, :sympp_repo_database, database_path)
    start_test_endpoint()

    on_exit(fn ->
      case original_database do
        nil -> Application.delete_env(:symphony_elixir, :sympp_repo_database)
        value -> Application.put_env(:symphony_elixir, :sympp_repo_database, value)
      end

      File.rm(database_path)
    end)

    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    repo.delete_all(OperatorAudit)
    repo.delete_all(AgentRun)
    repo.delete_all(Artifact)
    repo.delete_all(ProgressEvent)
    repo.delete_all(Finding)
    repo.delete_all(PlanNode)
    repo.delete_all(SoloSessionEntry)
    repo.delete_all(SoloSession)
    repo.delete_all(GuidanceRequest)
    repo.delete_all(Comment)
    repo.delete_all(AccessGrant)
    repo.delete_all(WorkPackageDelivery)
    repo.delete_all(WorkPackage)
    repo.delete_all(WorkPackage)
    repo.delete_all(Phase)
    repo.delete_all(DecisionLogEntry)
    repo.delete_all(ClarificationQuestion)
    repo.delete_all(WorkRequest)
    repo.delete_all(OperatorSettings)
    :ok
  end

  test "operator labels follow repository identity and only current configured worker sessions", %{repo: repo} do
    config_path = Path.join(System.tmp_dir!(), "operator-board-#{System.unique_integer([:positive])}.json")
    original_config_path = System.get_env("SYMPP_OPERATOR_CONFIG")
    System.put_env("SYMPP_OPERATOR_CONFIG", config_path)

    on_exit(fn ->
      if original_config_path,
        do: System.put_env("SYMPP_OPERATOR_CONFIG", original_config_path),
        else: System.delete_env("SYMPP_OPERATOR_CONFIG")

      File.rm(config_path)
    end)

    config = %{
      "repos" => %{"example-org/widget-service" => %{"area" => ["Example Company", "Widgets"], "deploy_workflows" => %{"dev" => "deploy-dev.yml"}}},
      "machines" => %{"build-desk" => %{"label" => "Build Desk", "kind" => "desktop", "future_field" => true}},
      "future_field" => true
    }

    File.write!(config_path, Jason.encode!(config))
    assert OperatorConfig.load()["repos"]["example-org/widget-service"]["deploy_workflows"] == %{"dev" => "deploy-dev.yml"}

    with_local_operator_endpoint(fn ->
      request = create_work_request!(repo, repo: "https://github.com/Example-Org/Widget-Service.git", status: "sliced")
      unmapped = create_work_request!(repo, repo: "example-org/unmapped-service", status: "sliced")
      now = DateTime.utc_now(:microsecond)

      packages =
        for {suffix, run_attrs} <- [
              {"CURRENT", %{worker_host: "build-desk", session_id: "session-current"}},
              {"UNKNOWN", %{worker_host: "unknown-host", session_id: "session-unknown"}},
              {"NO-HOST", %{worker_host: nil, session_id: "session-no-host"}},
              {"NO-SESSION", %{worker_host: "build-desk", session_id: nil}},
              {"STALE", %{worker_host: "build-desk", session_id: "session-stale", last_seen_at: DateTime.add(now, -301, :second)}},
              {"FINISHED", %{worker_host: "build-desk", session_id: "session-finished", status: "completed", finished_at: now}}
            ], into: %{} do
          package = create_dispatched_package!(repo, request, slice_id: "WRS-LABEL-#{suffix}", package_id: "WP-LABEL-#{suffix}", status: "implementing")
          attrs = Map.merge(%{work_package_id: package.id, status: "running", last_seen_at: now}, run_attrs)
          attrs |> AgentRun.create_changeset() |> repo.insert!()
          {suffix, package}
        end

      payload = json_response(get(local_operator_conn(), "/api/v1/sympp/operator/dashboard/hydrated"), 200)
      detail = work_request_detail(payload, request.id)
      card = Enum.find(payload["work_requests"]["work_requests"], &(&1["id"] == request.id))
      assert detail["work_request"]["area_path"] == ["Example Company", "Widgets"]
      assert card["area_path"] == detail["work_request"]["area_path"]
      assert work_request_detail(payload, unmapped.id)["work_request"]["area_path"] == nil
      by_id = Map.new(detail["work_packages"], &{&1["id"], &1})
      assert by_id[packages["CURRENT"].id]["session_location"] == %{"label" => "Build Desk", "kind" => "desktop"}

      for suffix <- ["UNKNOWN", "NO-HOST", "NO-SESSION", "STALE", "FINISHED"] do
        refute Map.has_key?(by_id[packages[suffix].id], "session_location")
      end

      packages["CURRENT"] |> Ecto.Changeset.change(status: "merged") |> repo.update!()
      terminal = json_response(get(local_operator_conn(), "/api/v1/sympp/operator/dashboard/hydrated"), 200)
      terminal_package = Enum.find(work_request_detail(terminal, request.id)["work_packages"], &(&1["id"] == packages["CURRENT"].id))
      refute Map.has_key?(terminal_package, "session_location")

      File.write!(config_path, Jason.encode!(%{"repos" => %{"example-org/widget-service" => %{"area" => ["A", "B", "C", "D"]}}, "machines" => %{"build-desk" => %{"label" => "Build Desk", "kind" => "guessed"}}}))
      invalid = json_response(get(local_operator_conn(), "/api/v1/sympp/operator/dashboard/hydrated"), 200)
      invalid_detail = work_request_detail(invalid, request.id)
      assert invalid_detail["work_request"]["area_path"] == nil
      assert Enum.all?(invalid_detail["work_packages"], &(not Map.has_key?(&1, "session_location")))

      for contents <- ["{invalid", "[]", ~s({"repos":[],"machines":false})] do
        File.write!(config_path, contents)
        fallback = json_response(get(local_operator_conn(), "/api/v1/sympp/operator/dashboard/hydrated"), 200)
        assert work_request_detail(fallback, request.id)["work_request"]["area_path"] == nil
        assert File.read!(config_path) == contents
      end

      File.rm!(config_path)
      missing = json_response(get(local_operator_conn(), "/api/v1/sympp/operator/dashboard/hydrated"), 200)
      assert work_request_detail(missing, request.id)["work_request"]["area_path"] == nil
      refute File.exists?(config_path)
    end)
  end

  test "local operator dashboard hides packages linked only from archived WorkRequests", %{repo: repo} do
    with_local_operator_endpoint(fn ->
      archived_request =
        create_work_request!(repo,
          id: "WR-LOCAL-ARCHIVED-LINKS",
          status: "ready_for_slicing",
          repo: "nextide/symphony-plus-plus",
          base_branch: "main"
        )

      terminal_package =
        create_dispatched_package!(repo, archived_request,
          slice_id: "WRS-LOCAL-ARCHIVED-TERMINAL",
          package_id: "WP-LOCAL-ARCHIVED-TERMINAL",
          status: "merged"
        )

      stale_package =
        create_dispatched_package!(repo, archived_request,
          slice_id: "WRS-LOCAL-ARCHIVED-STALE",
          package_id: "WP-LOCAL-ARCHIVED-STALE",
          status: "ready_for_worker"
        )

      active_request =
        create_work_request!(repo,
          id: "WR-LOCAL-ACTIVE-LINK",
          status: "ready_for_slicing",
          repo: archived_request.repo,
          base_branch: archived_request.base_branch
        )

      active_package =
        create_dispatched_package!(repo, active_request,
          slice_id: "WRS-LOCAL-ACTIVE-LINK",
          package_id: "WP-LOCAL-ACTIVE-LINK",
          status: "ready_for_worker"
        )

      archived_at = DateTime.utc_now(:microsecond)

      archived_request
      |> Ecto.Changeset.change(completed_at: archived_at, completion_source: "operator", archived_at: archived_at)
      |> repo.update!()

      payload = local_operator_dashboard_payload()

      package_ids = dashboard_work_package_ids(payload)

      refute terminal_package.id in package_ids
      refute stale_package.id in package_ids
      assert active_package.id in package_ids

      refute Map.has_key?(payload, "work_request_work_package_ids")
      assert payload["linked_work_package_ids"] == [active_package.id]

      refute Enum.any?(payload["work_request_details"], &(get_in(&1, ["work_request", "id"]) == archived_request.id))

      active_detail = work_request_detail(payload, active_request.id)
      assert get_in(active_detail, ["work_packages", Access.at(0), "work_package_id"]) == active_package.id
    end)
  end

  test "local operator dashboard omits unowned execution records", %{repo: repo} do
    with_local_operator_endpoint(fn ->
      anchor =
        create_work_package!(repo,
          id: "SYMPP-WR-ARCH-DASHBOARD-ANCHOR",
          kind: "delegation",
          title: "Architect handoff: Dashboard cleanup",
          status: "planning",
          repo: "nextide/symphony-plus-plus",
          base_branch: "main"
        )

      ordinary_delegation =
        create_work_package!(repo,
          id: "WP-LOCAL-DELEGATION-NONANCHOR",
          kind: "delegation",
          title: "Delegation delivery package",
          status: "planning",
          repo: anchor.repo,
          base_branch: anchor.base_branch
        )

      prefixed_delivery_package =
        create_work_package!(repo,
          id: "SYMPP-WR-ARCH-DASHBOARD-DELIVERY",
          kind: "mcp",
          title: "Prefix-like delivery package",
          status: "planning",
          repo: anchor.repo,
          base_branch: anchor.base_branch
        )

      payload = local_operator_dashboard_payload()

      package_ids = dashboard_work_package_ids(payload)

      refute anchor.id in package_ids
      refute ordinary_delegation.id in package_ids
      refute prefixed_delivery_package.id in package_ids
    end)
  end

  test "local operator can archive delivered unlinked WorkPackages without deleting them", %{repo: repo} do
    with_local_operator_endpoint(fn ->
      delivered_package =
        create_work_package!(repo,
          id: "WP-LOCAL-ARCHIVE-UNLINKED",
          status: "merged",
          repo: "nextide/symphony-plus-plus",
          base_branch: "main"
        )

      active_package =
        create_work_package!(repo,
          id: "WP-LOCAL-ARCHIVE-ACTIVE",
          status: "implementing",
          repo: delivered_package.repo,
          base_branch: delivered_package.base_branch
        )

      archive_payload =
        local_operator_conn()
        |> post("/api/v1/sympp/operator/work-packages/#{delivered_package.id}/archive", %{})
        |> json_response(200)

      refute Map.has_key?(archive_payload, "dashboard")
      assert archive_payload["ok"] == true
      assert archive_payload["work_package_id"] == delivered_package.id
      assert get_in(archive_payload, ["refresh", "dashboard"]) == true
      assert get_in(archive_payload, ["refresh", "work_package_id"]) == delivered_package.id

      dashboard_payload = local_operator_dashboard_payload()

      assert get_in(dashboard_payload, ["settings", "hidden_work_package_ids"]) == [delivered_package.id]
      refute active_package.id in dashboard_work_package_ids(dashboard_payload)
      refute delivered_package.id in dashboard_work_package_ids(dashboard_payload)

      assert {:ok, persisted_package} = WorkPackageRepository.get(repo, delivered_package.id)
      assert persisted_package.status == "merged"
    end)
  end

  defp create_work_request!(repo, overrides) do
    assert {:ok, work_request} = WorkRequestRepository.create(repo, work_request_attrs(overrides))
    work_request
  end

  defp create_dispatched_package!(repo, work_request, opts) do
    assert {:ok, work_package} =
             CanonicalWorkPackageFixtures.add_work_package(repo, work_request.id, work_package_attrs(id: Keyword.fetch!(opts, :slice_id), base_branch: work_request.base_branch))

    assert {:ok, approved} = CanonicalWorkPackageFixtures.approve_work_package(repo, work_request.id, work_package.id, "planned")

    package =
      create_matching_work_package!(repo, work_request, approved,
        id: Keyword.fetch!(opts, :package_id),
        status: Keyword.fetch!(opts, :status)
      )

    assert {:ok, _dispatched} =
             CanonicalWorkPackageFixtures.dispatch_work_package(repo, work_request.id, approved.id, "approved", package.id)

    package
  end

  defp create_work_package!(repo, overrides) do
    overrides
    |> WorkPackageFactory.attrs()
    |> then(&WorkPackageRepository.create(repo, &1))
    |> case do
      {:ok, work_package} -> work_package
      {:error, reason} -> flunk("failed to create WorkPackage: #{inspect(reason)}")
    end
  end

  defp create_matching_work_package!(repo, work_request, work_package, overrides) do
    attrs =
      [
        kind: work_package.kind,
        title: work_package.title,
        repo: work_request.repo,
        base_branch: work_package.base_branch,
        branch_pattern: work_package.branch_pattern,
        product_description: work_request.human_description,
        allowed_file_globs: work_package.allowed_file_globs,
        acceptance_criteria: work_package.acceptance_criteria
      ]
      |> Keyword.merge(overrides)

    create_work_package!(repo, attrs)
  end

  defp work_request_attrs(overrides) do
    defaults = %{
      id: "WR-DASH-#{System.unique_integer([:positive])}",
      title: "Improve intake flow",
      repo: "nextide/symphony-plus-plus",
      base_branch: "main",
      work_type: "feature",
      human_description: "Record the human's desired outcome before slicing.",
      constraints: %{"allowed_paths" => ["elixir/lib"], "requires_secret" => false},
      desired_dispatch_shape: "single_package",
      status: "draft"
    }

    Enum.into(overrides, defaults)
  end

  defp work_package_attrs(overrides) do
    defaults = %{
      title: "Add WorkRequest dashboard API",
      goal: "Expose read-only dashboard view models.",
      kind: "mcp",
      base_branch: "main",
      branch_pattern: "agent/SYMPP-V2-WR-004/workrequest-read-api",
      allowed_file_globs: ["elixir/lib/symphony_elixir/symphony_plus_plus/dashboard.ex"],
      forbidden_file_globs: ["elixir/lib/symphony_elixir_web/live/**"],
      acceptance_criteria: ["WorkRequest dashboard API reads are scoped and redacted."],
      validation_steps: ["mix test test/symphony_elixir/symphony_plus_plus/dashboard_api_local_operator_visibility_test.exs"],
      review_requirement: %{"type" => "review-suite", "args" => %{"mode" => "normal"}},
      stop_conditions: ["Stop before UI or dispatch wiring."]
    }

    Enum.into(overrides, defaults)
  end

  defp work_request_detail(dashboard, work_request_id) do
    dashboard
    |> get_in(["work_request_details"])
    |> Kernel.||([])
    |> Enum.find(&(get_in(&1, ["work_request", "id"]) == work_request_id))
  end

  defp dashboard_work_package_ids(dashboard) do
    dashboard
    |> Map.get("work_packages", [])
    |> Enum.map(& &1["id"])
  end

  defp local_operator_conn do
    build_conn()
    |> Map.put(:host, "localhost")
    |> Map.put(:remote_ip, {127, 0, 0, 1})
    |> put_req_header("origin", "http://localhost")
  end

  defp local_operator_dashboard_payload do
    initial = json_response(get(local_operator_conn(), "/api/v1/sympp/operator/dashboard"), 200)
    deferred = json_response(get(local_operator_conn(), "/api/v1/sympp/operator/dashboard/deferred"), 200)

    Map.merge(initial, deferred)
  end

  defp start_test_endpoint do
    endpoint_config =
      :symphony_elixir
      |> Application.get_env(SymphonyElixirWeb.Endpoint, [])
      |> Keyword.merge(server: false, secret_key_base: String.duplicate("s", 64), sympp_repo: Repo)

    Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, endpoint_config)
    start_supervised!({SymphonyElixirWeb.Endpoint, []})
  end

  defp with_local_operator_endpoint(fun) when is_function(fun, 0) do
    endpoint_config = Application.get_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, [])

    Application.put_env(
      :symphony_elixir,
      SymphonyElixirWeb.Endpoint,
      Keyword.put(endpoint_config, :sympp_local_operator, true)
    )

    try do
      fun.()
    after
      Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, endpoint_config)
    end
  end
end
