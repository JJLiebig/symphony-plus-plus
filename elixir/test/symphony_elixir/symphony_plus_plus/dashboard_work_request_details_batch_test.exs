defmodule SymphonyElixir.SymphonyPlusPlus.DashboardWorkRequestDetailsBatchTest do
  use ExUnit.Case, async: false

  import Phoenix.ConnTest
  import Plug.Conn, only: [put_req_header: 3]

  alias SymphonyElixir.SymphonyPlusPlus.Comments.Comment
  alias SymphonyElixir.SymphonyPlusPlus.Comments.Service, as: CommentService
  alias SymphonyElixir.SymphonyPlusPlus.Dashboard
  alias SymphonyElixir.SymphonyPlusPlus.OperatorSettings.Settings, as: OperatorSettings
  alias SymphonyElixir.SymphonyPlusPlus.Planning.ProgressEvent
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Repository, as: PlanningRepository
  alias SymphonyElixir.SymphonyPlusPlus.ProductTree.DependencyEdge
  alias SymphonyElixir.SymphonyPlusPlus.ProductTree.Repository, as: ProductTreeRepository
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackageDelivery
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.ClarificationQuestion
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.DecisionLogEntry
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.DeliveryBoard
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
    repo.delete_all(ProgressEvent)
    repo.delete_all(DependencyEdge)
    repo.delete_all(WorkPackageDelivery)
    repo.delete_all(WorkPackage)
    repo.delete_all(DecisionLogEntry)
    repo.delete_all(ClarificationQuestion)
    repo.delete_all(Comment)
    repo.delete_all(WorkRequest)
    repo.delete_all(WorkPackage)
    repo.delete_all(OperatorSettings)
    :ok
  end

  test "batch API preserves input order and single-detail payloads", %{repo: repo} do
    first = create_work_request!(repo, id: "WR-DASH-DETAIL-BATCH-1", status: "ready_for_slicing")
    second = create_work_request!(repo, id: "WR-DASH-DETAIL-BATCH-2", status: "ready_for_slicing")

    assert {:ok, _question} =
             WorkRequestRepository.ask_question(repo, first.id, question_attrs(id: "WRQ-DASH-DETAIL-BATCH-1"))

    assert {:ok, _decision} =
             WorkRequestRepository.record_decision(repo, second.id, decision_attrs(id: "WRD-DASH-DETAIL-BATCH-1"))

    assert {:ok, _slice} =
             CanonicalWorkPackageFixtures.add_work_package(repo, second.id, work_package_attrs(id: "WRS-DASH-DETAIL-BATCH-1"))

    assert {:ok, _first_comment} =
             CommentService.create(repo, %{
               target_kind: "work_request",
               target_id: first.id,
               body: "First note",
               source_type: "operator",
               author_name: "operator"
             })

    assert {:ok, _second_comment} =
             CommentService.create(repo, %{
               target_kind: "work_request",
               target_id: second.id,
               body: "Second note",
               source_type: "operator",
               author_name: "operator"
             })

    assert {:ok, [second_detail, first_detail]} = Dashboard.work_request_details(repo, [second.id, first.id])
    assert Enum.map([second_detail, first_detail], & &1.work_request.id) == [second.id, first.id]
    assert first_detail.summary.comment_count == 1
    assert second_detail.summary.comment_count == 1

    assert {:ok, single_first_detail} = Dashboard.work_request_detail(repo, first.id)
    assert {:ok, single_second_detail} = Dashboard.work_request_detail(repo, second.id)
    assert first_detail == single_first_detail
    assert second_detail == single_second_detail
  end

  test "local operator dashboard returns multiple WorkRequest details in card order", %{repo: repo} do
    with_local_operator_endpoint(fn ->
      first = create_work_request!(repo, id: "WR-OPERATOR-BATCH-1", status: "ready_for_clarification")
      second = create_work_request!(repo, id: "WR-OPERATOR-BATCH-2", status: "ready_for_slicing")

      payload = local_operator_dashboard_payload()

      work_request_ids = Enum.map(payload["work_requests"]["work_requests"], & &1["id"])
      detail_ids = Enum.map(payload["work_request_details"], &get_in(&1, ["work_request", "id"]))
      assert payload["work_requests"]["total_count"] == 2
      assert work_request_ids == [first.id, second.id]
      assert detail_ids == work_request_ids
    end)
  end

  test "full and compact packages forward canonical integration eligibility within board budgets", %{repo: repo} do
    request = create_work_request!(repo, status: "sliced")
    backend = eligibility_package!(repo, request, "BACKEND", "ready_for_merge")
    ui = eligibility_package!(repo, request, "UI", "ready_for_merge")
    stale = eligibility_package!(repo, request, "STALE", "ready_for_merge")
    missing_backend = eligibility_package!(repo, request, "MISSING-BACKEND", "reviewing")
    missing = eligibility_package!(repo, request, "MISSING", "reviewing")
    backend_head = String.duplicate("a", 40)
    ui_head = String.duplicate("b", 40)
    stale_head = String.duplicate("c", 40)

    record_head!(repo, backend, backend_head)
    record_head!(repo, ui, ui_head)
    record_head!(repo, stale, stale_head)
    ui_edge = pinned_dependency!(repo, ui, backend, backend_head)
    stale_edge = pinned_dependency!(repo, stale, backend, backend_head)
    pinned_dependency!(repo, missing, missing_backend, backend_head)
    consume_input!(repo, ui, ui_edge, ui_head, backend_head)
    consume_input!(repo, stale, stale_edge, stale_head, backend_head)
    record_head!(repo, stale, String.duplicate("d", 40))

    assert {:ok, canonical} = DeliveryBoard.project(repo, request.id)
    {{:ok, [full]}, full_queries} = capture_queries(fn -> Dashboard.work_request_details(repo, [request.id]) end)
    {{:ok, [compact]}, compact_queries} = capture_queries(fn -> Dashboard.work_request_board_details(repo, [request.id]) end)
    compact_bytes = byte_size(Jason.encode!(compact))
    full_bytes = byte_size(Jason.encode!(full))

    IO.puts("ELIGIBILITY_BOARD_BUDGET " <> Jason.encode!(%{queries: length(compact_queries), bytes: compact_bytes, full_queries: length(full_queries), full_bytes: full_bytes}))
    assert length(compact_queries) <= 24
    assert compact_bytes <= 15_000
    assert compact_bytes < full_bytes

    for item <- canonical.work_packages do
      expected = Dashboard.redacted_json(item.merge_eligibility)
      assert Enum.find(full.work_packages, &(&1.id == item.id)).merge_eligibility == expected
      assert Enum.find(compact.work_packages, &(&1.id == item.id)).merge_eligibility == expected
      assert Enum.find(full.delivery_board["work_packages"], &(&1["id"] == item.id))["merge_eligibility"] == expected
    end

    by_id = Map.new(compact.work_packages, &{&1.id, &1.merge_eligibility})
    assert by_id[backend.id]["eligible"]
    assert by_id[backend.id]["reason_codes"] == []
    refute by_id[ui.id]["eligible"]
    assert by_id[ui.id]["reason_codes"] == ["dependency_not_delivered"]
    assert "dependency_inputs_stale" in by_id[stale.id]["reason_codes"]
    refute by_id[stale.id]["eligible"]
    assert "not_ready" in by_id[missing.id]["reason_codes"]
    assert "candidate_pin_stale" in by_id[missing.id]["reason_codes"]
    assert "dependency_inputs_stale" in by_id[missing.id]["reason_codes"]
    refute by_id[missing.id]["eligible"]

    with_local_operator_endpoint(fn ->
      [api_detail] = local_operator_dashboard_payload()["work_request_details"]
      assert Enum.sort(Enum.map(api_detail["work_packages"], & &1["id"])) == Enum.sort(Map.keys(by_id))

      for package <- api_detail["work_packages"] do
        assert package["merge_eligibility"] == by_id[package["id"]]
      end
    end)
  end

  defp eligibility_package!(repo, request, suffix, status) do
    assert {:ok, package} = CanonicalWorkPackageFixtures.add_work_package(repo, request.id, work_package_attrs(id: "#{request.id}-#{suffix}", status: status))
    package
  end

  defp record_head!(repo, package, head) do
    for {type, source} <- [{"branch", "attach_branch"}, {"pr", "attach_pr"}] do
      assert {:ok, _event} =
               PlanningRepository.append_progress_event(repo, %{
                 work_package_id: package.id,
                 summary: "Fixture current #{type}",
                 payload: %{"type" => type, "source_tool" => source, "head_sha" => head, "url" => "https://github.com/nextide/symphony-plus-plus/pull/#{package.sequence}"}
               })
    end
  end

  defp pinned_dependency!(repo, dependent, prerequisite, head) do
    assert {:ok, edge} =
             ProductTreeRepository.create_dependency_edge(repo, %{
               work_request_id: dependent.work_request_id,
               source_kind: "work_package",
               source_id: dependent.id,
               target_kind: "work_package",
               target_id: prerequisite.id,
               kind: "depends_on",
               reason: "Consume qualified backend",
               candidate_head_sha: head
             })

    edge
  end

  defp consume_input!(repo, package, edge, head, input_head) do
    assert {:ok, _event} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: package.id,
               summary: "Qualified wiring fixture",
               payload: %{"head_sha" => head, "dependency_inputs" => [%{"dependency_id" => edge.id, "prerequisite_work_package_id" => edge.target_id, "candidate_head_sha" => input_head}]}
             })
  end

  defp capture_queries(fun) do
    handler_id = {__MODULE__, self(), make_ref()}
    :ok = :telemetry.attach(handler_id, Repo.config()[:telemetry_prefix] ++ [:query], fn _event, _measurements, metadata, test_pid -> send(test_pid, {handler_id, metadata.query}) end, self())

    try do
      {fun.(), drain_queries(handler_id, [])}
    after
      :telemetry.detach(handler_id)
    end
  end

  defp drain_queries(handler_id, queries) do
    receive do
      {^handler_id, query} -> drain_queries(handler_id, [query | queries])
    after
      0 -> queries
    end
  end

  defp create_work_request!(repo, overrides) do
    assert {:ok, work_request} = WorkRequestRepository.create(repo, work_request_attrs(overrides))
    work_request
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

  defp question_attrs(overrides) do
    defaults = %{
      category: "scope",
      question: "Which branch should this target?",
      why_needed: "The architect needs the target before slicing."
    }

    Enum.into(overrides, defaults)
  end

  defp decision_attrs(overrides) do
    defaults = %{
      source_type: "architect",
      decision: "Keep this WorkRequest narrow.",
      rationale: "The next slice owns broader orchestration.",
      scope_impact: "No new runtime tools.",
      created_by: "architect-1"
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
      validation_steps: ["mix test test/symphony_elixir/symphony_plus_plus/dashboard_api_test.exs"],
      review_requirement: %{"type" => "review-suite", "args" => %{"mode" => "normal"}},
      stop_conditions: ["Stop before UI or dispatch wiring."]
    }

    Enum.into(overrides, defaults)
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

  defp with_local_operator_endpoint(fun) when is_function(fun, 0) do
    endpoint_config = Application.get_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, [])

    Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, Keyword.put(endpoint_config, :sympp_local_operator, true))

    try do
      fun.()
    after
      Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, endpoint_config)
    end
  end

  defp start_test_endpoint do
    endpoint_config =
      :symphony_elixir
      |> Application.get_env(SymphonyElixirWeb.Endpoint, [])
      |> Keyword.merge(server: false, secret_key_base: String.duplicate("s", 64), sympp_repo: Repo)

    Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, endpoint_config)
    start_supervised!({SymphonyElixirWeb.Endpoint, []})
  end
end
