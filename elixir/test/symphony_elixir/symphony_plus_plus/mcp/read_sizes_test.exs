Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.ReadSizesTest do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  alias SymphonyElixir.SymphonyPlusPlus.Comments.Service, as: CommentService
  alias SymphonyElixir.SymphonyPlusPlus.GuidanceRequests.Service, as: GuidanceService
  alias SymphonyElixir.SymphonyPlusPlus.MCP.WorkRequestPayloads
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository, as: RequestRepository

  test "large delivery reads retain full detail with a usable compact default", %{repo: repo} do
    request =
      create_work_request!(repo,
        id: "wr_read_sizes_fixture",
        repo: "nextide/symphony-plus-plus",
        base_branch: "symphony-plus-plus/beta",
        title: "Native delivery cockpit",
        human_description: description(),
        desired_dispatch_shape: "architect_led_feature_branch",
        status: "sliced"
      )

    {anchor, architect, _grant} = create_work_request_handoff_architect_session(repo, request, ["read:work_request", "read:guidance_request"])

    packages =
      for index <- 1..28 do
        assert {:ok, package} =
                 CanonicalWorkPackageFixtures.add_work_package(
                   repo,
                   request.id,
                   work_request_work_package_attrs(
                     id: "wp_00000000000000#{String.pad_leading(to_string(index), 2, "0")}",
                     title: "Native delivery surface #{index}",
                     goal: description(),
                     phase_id: anchor.phase_id,
                     acceptance_criteria: acceptance(),
                     validation_steps: ["Run the owning MCP tests with a disposable ledger.", "Verify the candidate head and complete fast review."],
                     stop_conditions: ["Ask the parent before changing the delivery contract or runtime defaults."],
                     review_requirement: %{"type" => "review-suite", "args" => %{"mode" => "fast"}}
                   )
                 )

        package
      end

    for index <- 1..16 do
      assert {:ok, _decision} =
               RequestRepository.record_decision(
                 repo,
                 request.id,
                 work_request_decision_attrs(
                   id: "decision_fixture_#{index}",
                   decision: "Decision #{index}: keep native delivery on the shared ledger. " <> description(),
                   rationale: "The operator needs current evidence, explicit ownership and reliable next actions.",
                   scope_impact: "Keep the installed runtime separate from candidate verification."
                 )
               )
    end

    assert {:ok, _question} = RequestRepository.ask_question(repo, request.id, work_request_question_attrs([]))

    package = repo.update!(Ecto.Changeset.change(hd(packages), status: "ready_for_worker"))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "fixture-worker")
    worker = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    guidance_requests =
      for index <- 1..4 do
        assert {:ok, _comment} =
                 CommentService.create(repo, %{
                   "target_kind" => "work_request",
                   "target_id" => request.id,
                   "body" => "Review note #{index}: " <> description(),
                   "source_type" => "operator",
                   "author_name" => "fixture-operator"
                 })

        assert {:ok, guidance} =
                 GuidanceService.create_for_assignment(repo, assignment, %{
                   "summary" => "Delivery decision #{index}",
                   "question" => "Which candidate should the worker consume?",
                   "context" => description(),
                   "idempotency_key" => "fixture-guidance-#{index}"
                 })

        guidance
      end

    for index <- 1..12 do
      response = mcp_tool(repo, worker, "append_progress", %{"summary" => "Validation checkpoint #{index}", "body" => description(), "idempotency_key" => "fixture-progress-#{index}"})
      refute response["error"]
    end

    reads =
      [
        {"read_work_request", architect, %{"work_request_id" => request.id}},
        {"list_work_requests", architect, %{}},
        {"read_plan", architect, %{"work_request_id" => request.id}},
        {"read_context", worker, %{}},
        {"read_task_plan", worker, %{}},
        {"read_task_plan", architect, %{"work_package_id" => package.id}},
        {"get_current_assignment", worker, %{}},
        {"get_current_assignment", architect, %{}},
        {"read_guidance_request", architect, %{"guidance_request_id" => hd(guidance_requests).id}},
        {"read_guidance_request", worker, %{"guidance_request_id" => hd(guidance_requests).id}},
        {"list_comments", architect, %{"target_kind" => "work_request", "target_id" => request.id}},
        {"list_guidance_requests", architect, %{"work_request_id" => request.id}},
        {"read_delivery_board", architect, %{"work_request_id" => request.id}}
      ] ++
        Enum.map(~w(context.md task_plan.md findings.md progress.md acceptance.md review.md handoff.md), fn document ->
          {"read_work_package_document", worker, %{"document" => document}}
        end)

    sizes =
      for {name, session, arguments} <- reads do
        response = mcp_tool(repo, session, name, arguments)
        refute response["error"], inspect(response["error"])
        result = response["result"]

        full =
          if name in ~w(read_work_request read_plan read_work_package_document) do
            full_response = mcp_tool(repo, session, name, Map.put(arguments, "detail", "full"))
            refute full_response["error"]
            full_response["result"]
          else
            result
          end

        if name == "read_work_package_document" and arguments["document"] != "progress.md", do: assert(full == result)

        %{
          tool: name,
          role: session.assignment.grant_role,
          document: arguments["document"],
          after: measure(result),
          before: measure(full)
        }
      end

    IO.puts("READ_SIZES=" <> Jason.encode!(sizes))

    summary_result = mcp_tool(repo, architect, "read_work_request", %{"work_request_id" => request.id})["result"]
    assert String.length(Jason.encode!(summary_result)) < 8_000
    summary = summary_result["structuredContent"]
    assert String.length(Jason.encode!(summary)) < 8_000
    assert summary["work_request"]["human_description"] == description()
    assert summary["work_request"]["execution_status"] == "open"
    assert length(summary["work_packages"]) == 28
    assert hd(summary["work_packages"])["next_action"] == "answer_guidance"
    assert List.last(summary["work_packages"])["next_action"] == "dispatch_work_package"
    refute Map.has_key?(hd(summary["work_packages"]), "goal")
    assert length(summary["clarification_questions"]) == 1
    assert Enum.map(summary["decision_log_entries"], & &1["sequence"]) == Enum.to_list(12..16)
    assert summary["omitted"] == %{"package_contracts" => 28, "resolved_questions" => 0, "older_decisions" => 11, "decision_details" => 16}
    assert {:ok, original} = WorkRequestPayloads.work_request_detail(repo, request, [])
    full = mcp_tool(repo, architect, "read_work_request", %{"work_request_id" => request.id, "detail" => "full"})["result"]["structuredContent"]
    assert Map.delete(full, "scope") == original

    local =
      Server.handle(
        %{"jsonrpc" => "2.0", "id" => "local-summary", "method" => "tools/call", "params" => %{"name" => "read_work_request", "arguments" => %{"work_request_id" => request.id}}},
        local_mcp_server(local_mcp_config(repo), "read-sizes-local")
      )

    assert local["result"]["structuredContent"]["work_packages"] == summary["work_packages"]

    plan = mcp_tool(repo, architect, "read_plan", %{"work_request_id" => request.id})["result"]["structuredContent"]
    full_plan = mcp_tool(repo, architect, "read_plan", %{"work_request_id" => request.id, "detail" => "full"})["result"]["structuredContent"]
    assert plan["product_tree"]["execution_graph"] == full_plan["product_tree"]["execution_graph"]
    assert length(plan["product_tree"]["work_package_refs"]) == 28
    assert full_plan["product_tree"]["work_package_refs"] |> hd() |> Map.has_key?("operational_state")
    refute plan["product_tree"]["work_package_refs"] |> hd() |> Map.has_key?("operational_state")

    progress = mcp_tool(repo, worker, "read_work_package_document", %{"document" => "progress.md"})["result"]["structuredContent"]
    full_progress = mcp_tool(repo, worker, "read_work_package_document", %{"document" => "progress.md", "detail" => "full"})["result"]["structuredContent"]
    assert length(progress["progress_events"]) == 5
    assert length(full_progress["progress_events"]) == 12
    assert progress["summary_omitted"] == %{"progress_events" => 7, "event_details" => 12}
    assert List.last(full_progress["progress_events"])["body"] == description()
    assert progress["omitted"] == full_progress["omitted"]

    for {tool, session, arguments} <- reads, tool in ~w(read_work_request read_plan read_work_package_document) do
      invalid = mcp_tool(repo, session, tool, Map.put(arguments, "detail", "invalid"))
      assert get_in(invalid, ["error", "data", "reason"]) == "invalid_detail"
    end

    # Existing delivery evidence must still drive the architect's next action.
    attach_tool(repo, worker, "attach_pr", %{"url" => "https://github.com/nextide/symphony-plus-plus/pull/123", "head_sha" => "abc123"})
    repo.update!(Ecto.Changeset.change(Enum.at(packages, 1), status: "merged"))
    changed = mcp_tool(repo, architect, "read_work_request", %{"work_request_id" => request.id})["result"]["structuredContent"]
    assert hd(changed["work_packages"])["pr_url"] == "https://github.com/nextide/symphony-plus-plus/pull/123"
    assert Enum.at(changed["work_packages"], 1)["next_action"] == "reconcile_work_request"
  end

  defp measure(result) do
    %{
      structured: result["structuredContent"] |> Jason.encode!() |> String.length(),
      text: result["content"] |> hd() |> Map.fetch!("text") |> String.length(),
      result: result |> Jason.encode!() |> String.length()
    }
  end

  defp description do
    "The human overseer needs to see current ownership, dependencies, reviews and delivery progress in the native cockpit. " <>
      "Use the same ledger as the web board and preserve upstream behavior. Candidate verification must use disposable homes and databases. " <>
      "Show active workers, waiting reasons, pull requests and the next action without requiring transcript inspection. " <>
      "Keep full contracts and evidence available for the owning worker, while ordinary architecture reads summarize the current delivery state. " <>
      "A completed source change does not qualify installed runtimes or live external providers. Record exact tested revisions and outstanding limits."
  end

  defp acceptance do
    [
      "The operator can identify active, waiting and completed packages using current ledger evidence.",
      "The worker receives the complete allowed scope, acceptance outcomes, validation and stopping conditions.",
      "Architecture reads preserve request identity, open questions, decisions, PR presence and next actions.",
      "No production ledger, installed plugin cache, provider credentials or live terminal session is changed."
    ]
  end
end
