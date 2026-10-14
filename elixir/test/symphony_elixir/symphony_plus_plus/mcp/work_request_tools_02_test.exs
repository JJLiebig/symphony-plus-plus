Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.WorkRequestTools02Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  test "legacy recovered handoff architects read same repo/base without persisted repo scope", %{repo: repo} do
    handoff_work_request =
      create_work_request!(repo,
        id: "WR-MCP-WR-LEGACY-HANDOFF",
        repo: "symphony-plus-plus",
        base_branch: "main",
        status: "ready_for_slicing"
      )

    equivalent_sibling =
      create_work_request!(repo,
        id: "WR-MCP-WR-LEGACY-HANDOFF-SIBLING",
        repo: "JJLiebig/symphony-plus-plus",
        base_branch: handoff_work_request.base_branch,
        status: "ready_for_slicing"
      )

    other_repo =
      create_work_request!(repo,
        id: "WR-MCP-WR-LEGACY-HANDOFF-OTHER-REPO",
        repo: "Elsewhere/symphony-plus-plus",
        base_branch: handoff_work_request.base_branch,
        status: "ready_for_slicing"
      )

    other_base =
      create_work_request!(repo,
        id: "WR-MCP-WR-LEGACY-HANDOFF-OTHER-BASE",
        repo: equivalent_sibling.repo,
        base_branch: "release/legacy-handoff",
        status: "ready_for_slicing"
      )

    assert {:ok, sibling_slice} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               equivalent_sibling.id,
               work_request_work_package_attrs(id: "WRS-MCP-WR-LEGACY-HANDOFF-SIBLING", base_branch: equivalent_sibling.base_branch)
             )

    {anchor, session, grant} =
      create_work_request_handoff_architect_session(repo, handoff_work_request, [
        "read:work_request",
        "write:work_request",
        "dispatch:work_request"
      ])

    session = legacy_handoff_session_without_repo_scope!(repo, session, grant)

    list_response = mcp_tool(repo, session, "list_work_requests", %{"status" => "ready_for_slicing"})
    list_payload = get_in(list_response, ["result", "structuredContent"])

    assert list_payload["scope"] == %{
             "repo" => anchor.repo,
             "base_branch" => anchor.base_branch
           }

    assert Enum.map(list_payload["work_requests"], & &1["id"]) == [handoff_work_request.id, equivalent_sibling.id]
    refute inspect(list_response) =~ other_repo.id
    refute inspect(list_response) =~ other_base.id

    sibling_read_response = mcp_tool(repo, session, "read_work_request", %{"work_request_id" => equivalent_sibling.id})
    assert get_in(sibling_read_response, ["result", "structuredContent", "work_request", "id"]) == equivalent_sibling.id

    sibling_board_response = mcp_tool(repo, session, "read_delivery_board", %{"work_request_id" => equivalent_sibling.id})
    assert get_in(sibling_board_response, ["result", "structuredContent", "work_request", "id"]) == equivalent_sibling.id

    other_repo_read_response = mcp_tool(repo, session, "read_work_request", %{"work_request_id" => other_repo.id})
    assert get_in(other_repo_read_response, ["error", "code"]) == -32_004
    assert get_in(other_repo_read_response, ["error", "data", "reason"]) == "not_found"
    refute inspect(other_repo_read_response) =~ other_repo.id

    other_base_read_response = mcp_tool(repo, session, "read_work_request", %{"work_request_id" => other_base.id})
    assert get_in(other_base_read_response, ["error", "code"]) == -32_004
    assert get_in(other_base_read_response, ["error", "data", "reason"]) == "not_found"
    refute inspect(other_base_read_response) =~ other_base.id

    sibling_status_response =
      mcp_tool(repo, session, "set_work_request_status", %{
        "work_request_id" => equivalent_sibling.id,
        "current_status" => "ready_for_slicing",
        "next_status" => "sliced"
      })

    assert get_in(sibling_status_response, ["error", "code"]) == -32_004
    assert get_in(sibling_status_response, ["error", "data", "reason"]) == "not_found"

    sibling_update_response =
      mcp_tool(repo, session, "update_work_package", %{
        "work_request_id" => equivalent_sibling.id,
        "work_package_id" => sibling_slice.id,
        "expected_contract_revision" => sibling_slice.contract_revision,
        "patch" => %{"title" => "Out of scope"}
      })

    assert get_in(sibling_update_response, ["error", "code"]) == -32_004
    assert get_in(sibling_update_response, ["error", "data", "reason"]) == "not_found"

    assert {:ok, persisted_sibling} = WorkRequestRepository.get(repo, equivalent_sibling.id)
    assert persisted_sibling.status == "ready_for_slicing"
    assert {:ok, [persisted_sibling_slice]} = WorkRequestRepository.list_work_packages(repo, equivalent_sibling.id)
    assert persisted_sibling_slice.id == sibling_slice.id
    assert persisted_sibling_slice.status == "planned"
  end

  test "legacy recovered handoff architects fail closed with partial frozen repo scope", %{repo: repo} do
    handoff_work_request =
      create_work_request!(repo,
        id: "WR-MCP-WR-LEGACY-HANDOFF-PARTIAL",
        repo: "symphony-plus-plus",
        base_branch: "main",
        status: "ready_for_slicing"
      )

    sibling =
      create_work_request!(repo,
        id: "WR-MCP-WR-LEGACY-HANDOFF-PARTIAL-SIBLING",
        repo: handoff_work_request.repo,
        base_branch: handoff_work_request.base_branch,
        status: "ready_for_slicing"
      )

    {_anchor, session, grant} =
      create_work_request_handoff_architect_session(repo, handoff_work_request, [
        "read:work_request"
      ])

    repo_only_session =
      legacy_handoff_session_with_scope_fields!(repo, session, grant, handoff_work_request.repo, nil)

    repo_only_response = mcp_tool(repo, repo_only_session, "list_work_requests", %{"status" => "ready_for_slicing"})
    assert get_in(repo_only_response, ["error", "code"]) == -32_001
    refute inspect(repo_only_response) =~ sibling.id

    base_only_session =
      legacy_handoff_session_with_scope_fields!(repo, repo_only_session, grant, nil, handoff_work_request.base_branch)

    base_only_response = mcp_tool(repo, base_only_session, "list_work_requests", %{"status" => "ready_for_slicing"})
    assert get_in(base_only_response, ["error", "code"]) == -32_001
    refute inspect(base_only_response) =~ sibling.id
  end

  test "WorkRequest MCP scope is not pinned for normal non-handoff phases", %{repo: repo} do
    first =
      create_work_request!(repo,
        id: "WR-MCP-WR-PREFIX-FIRST",
        repo: "nextide/symphony-plus-plus",
        base_branch: "main",
        status: "ready_for_slicing"
      )

    second =
      create_work_request!(repo,
        id: "WR-MCP-WR-PREFIX-SECOND",
        repo: first.repo,
        base_branch: first.base_branch,
        status: "ready_for_slicing"
      )

    phase_id = "phase-manual-work-request-scope"
    assert {:ok, _phase} = PhaseRepository.create(repo, %{id: phase_id, title: "Manual WorkRequest phase"})

    {_anchor, session, _grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-PREFIX-NON-HANDOFF", ["read:work_request"],
        phase_id: phase_id,
        repo: first.repo,
        base_branch: first.base_branch
      )

    list_response = mcp_tool(repo, session, "list_work_requests", %{"status" => "ready_for_slicing"})
    list_payload = get_in(list_response, ["result", "structuredContent"])

    assert list_payload["scope"] == %{"repo" => first.repo, "base_branch" => first.base_branch}
    assert Enum.map(list_payload["work_requests"], & &1["id"]) == [first.id, second.id]
  end

  test "WorkRequest MCP tools fail closed for partial handoff provenance", %{repo: repo} do
    first =
      create_work_request!(repo,
        id: "WR-MCP-WR-PARTIAL-HANDOFF-FIRST",
        repo: "nextide/symphony-plus-plus",
        base_branch: "main",
        status: "ready_for_slicing"
      )

    sibling =
      create_work_request!(repo,
        id: "WR-MCP-WR-PARTIAL-HANDOFF-SIBLING",
        repo: first.repo,
        base_branch: first.base_branch,
        status: "ready_for_slicing"
      )

    phase_id = "phase-wr-architect-partial-provenance"
    assert {:ok, _phase} = PhaseRepository.create(repo, %{id: phase_id, title: "Partial handoff phase"})

    {_anchor, session, _grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-PARTIAL-HANDOFF", ["read:work_request"],
        phase_id: phase_id,
        repo: first.repo,
        base_branch: first.base_branch
      )

    list_response = mcp_tool(repo, session, "list_work_requests", %{"status" => "ready_for_slicing"})
    assert get_in(list_response, ["error", "code"]) == -32_001
    assert get_in(list_response, ["error", "data", "reason"]) == "phase_scope_not_available"
    refute inspect(list_response) =~ sibling.id
  end

  test "WorkRequest MCP tools fail closed when handoff provenance no longer matches a WorkRequest", %{repo: repo} do
    handoff_work_request =
      create_work_request!(repo,
        id: "WR-MCP-WR-HANDOFF-DRIFTED",
        repo: "nextide/symphony-plus-plus",
        base_branch: "main",
        status: "ready_for_slicing"
      )

    sibling =
      create_work_request!(repo,
        id: "WR-MCP-WR-HANDOFF-DRIFTED-SIBLING",
        repo: handoff_work_request.repo,
        base_branch: handoff_work_request.base_branch,
        status: "ready_for_slicing"
      )

    {_anchor, session, _grant} =
      create_work_request_handoff_architect_session(repo, handoff_work_request, [
        "read:work_request"
      ])

    assert {:ok, _drifted} =
             WorkRequestRepository.update(repo, handoff_work_request.id, %{"repo" => "nextide/drifted"})

    list_response = mcp_tool(repo, session, "list_work_requests", %{"status" => "ready_for_slicing"})
    assert get_in(list_response, ["error", "code"]) == -32_001
    refute inspect(list_response) =~ sibling.id
  end

  test "architect WorkRequest mutation tools update scoped clarification state and redact responses", %{repo: repo} do
    {anchor, session, _grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-MUTATE", [
        "write:work_request"
      ])

    work_request =
      create_work_request!(repo,
        id: "WR-MCP-WR-MUTATE",
        repo: anchor.repo,
        base_branch: anchor.base_branch,
        status: "ready_for_clarification"
      )

    grant_work_request_scope!(repo, session, work_request.id)

    status_response =
      mcp_tool(repo, session, "set_work_request_status", %{
        "work_request_id" => work_request.id,
        "current_status" => "ready_for_clarification",
        "next_status" => "clarifying"
      })

    status_payload = get_in(status_response, ["result", "structuredContent"])
    assert status_payload["work_request"]["status"] == "clarifying"
    assert MapSet.new(Map.keys(status_payload["work_request"])) == MapSet.new(["id", "status", "updated_at"])
    assert status_payload["status"] == %{"previous_status" => "ready_for_clarification", "current_status" => "clarifying"}
    assert status_payload["scope"] == %{"repo" => anchor.repo, "base_branch" => anchor.base_branch}

    assert {:ok, persisted_work_request} = WorkRequestRepository.get(repo, work_request.id)
    assert persisted_work_request.status == "clarifying"

    ask_response =
      mcp_tool(repo, session, "ask_question", %{
        "work_request_id" => work_request.id,
        "category" => "scope",
        "question" => "Can the implementation use Bearer raw_secret_value?",
        "why_needed" => "The architect needs to avoid raw_secret_value leakage.",
        "decision_prompt" => %{
          "tl_dr" => "Choose whether to continue.",
          "details" => "The architect needs a human-readable option picker.",
          "options" => [
            %{
              "id" => "continue",
              "label" => "Continue",
              "description" => "Proceed with the safe path.",
              "pros" => ["Fastest path"],
              "cons" => ["Leaves polish for later"],
              "answer" => "Continue without raw_secret_value."
            }
          ],
          "custom_redirect_label" => "No, and tell the agent what to do differently"
        },
        "asked_by_agent_run_id" => "raw_secret_value"
      })

    ask_payload = get_in(ask_response, ["result", "structuredContent"])
    question_id = get_in(ask_payload, ["clarification_question", "id"])
    assert is_binary(question_id)
    assert get_in(ask_payload, ["clarification_question", "status"]) == "open"
    refute Map.has_key?(ask_payload["clarification_question"], "asked_by_agent_run_id")
    refute Map.has_key?(ask_payload["clarification_question"], "decision_prompt")
    assert MapSet.new(Map.keys(ask_payload["work_request"])) == MapSet.new(["id", "status", "updated_at"])
    refute inspect(ask_response) =~ "raw_secret_value"

    wrong_status_response =
      mcp_tool(repo, session, "answer_question", %{
        "work_request_id" => work_request.id,
        "question_id" => question_id,
        "expected_question_status" => "ready_for_slicing",
        "answer" => "Wrong status domain."
      })

    assert get_in(wrong_status_response, ["error", "data", "reason"]) == "invalid_question_status"
    assert get_in(wrong_status_response, ["error", "data", "status_domain"]) == "clarification_question"
    assert get_in(wrong_status_response, ["error", "data", "expected_statuses"]) == ["open"]
    assert get_in(wrong_status_response, ["error", "data", "got"]) == "ready_for_slicing"

    malformed_status_response =
      mcp_tool(repo, session, "answer_question", %{
        "work_request_id" => work_request.id,
        "question_id" => question_id,
        "expected_question_status" => 123,
        "answer" => "Malformed status guard."
      })

    assert get_in(malformed_status_response, ["error", "data", "reason"]) == "invalid_question_status"
    assert get_in(malformed_status_response, ["error", "data", "got"]) == "non_string"

    answer_response =
      mcp_tool(repo, session, "answer_question", %{
        "work_request_id" => work_request.id,
        "question_id" => question_id,
        "answer" => "Use signed URL https://example.test/path?sig=raw_secret_value instead."
      })

    answer_payload = get_in(answer_response, ["result", "structuredContent"])
    assert get_in(answer_payload, ["clarification_question", "status"]) == "answered"
    refute Map.has_key?(answer_payload["clarification_question"], "answered_by")
    refute inspect(answer_response) =~ "raw_secret_value"

    close_ask_response =
      mcp_tool(repo, session, "ask_question", %{
        "work_request_id" => work_request.id,
        "category" => "acceptance",
        "question" => "Can the stale branch be ignored?",
        "why_needed" => "The architect needs an explicit closure reason."
      })

    close_question_id = get_in(close_ask_response, ["result", "structuredContent", "clarification_question", "id"])

    close_response =
      mcp_tool(repo, session, "close_question", %{
        "work_request_id" => work_request.id,
        "question_id" => close_question_id,
        "current_status" => "open"
      })

    assert get_in(close_response, ["result", "structuredContent", "clarification_question", "status"]) == "closed"

    combined_ask_response =
      mcp_tool(repo, session, "ask_question", %{
        "work_request_id" => work_request.id,
        "category" => "product",
        "question" => "Should we keep this backend-only?",
        "why_needed" => "The answer should become decision-log truth."
      })

    combined_question_id = get_in(combined_ask_response, ["result", "structuredContent", "clarification_question", "id"])

    combined_response =
      mcp_tool(repo, session, "answer_question_and_record_decision", %{
        "work_request_id" => work_request.id,
        "question_id" => combined_question_id,
        "answer" => "Keep it backend-only.",
        "source_type" => "architect",
        "decision" => "Keep the WorkRequest backend-only.",
        "rationale" => "The UI is out of scope.",
        "scope_impact" => "No dashboard changes."
      })

    combined_payload = get_in(combined_response, ["result", "structuredContent"])
    assert get_in(combined_payload, ["clarification_question", "status"]) == "answered"
    assert is_binary(get_in(combined_payload, ["decision_log_entry", "id"]))
    assert get_in(combined_payload, ["decision_log_entry", "source_id"]) == combined_question_id

    default_decision_response =
      mcp_tool(repo, session, "record_decision", %{
        "work_request_id" => work_request.id,
        "source_type" => "architect",
        "source_id" => "comment-default",
        "decision" => "Use the claimed architect as provenance by default.",
        "rationale" => "The live claim already identifies the actor.",
        "scope_impact" => "No scope change."
      })

    assert get_in(default_decision_response, ["result", "structuredContent", "decision_log_entry", "created_by"]) == "architect-1"

    decision_response =
      mcp_tool(repo, session, "record_decision", %{
        "work_request_id" => work_request.id,
        "source_type" => "architect",
        "source_id" => "comment-1",
        "decision" => "Keep this WorkRequest backend-only with token raw_secret_value excluded.",
        "rationale" => "Dashboard work is out of scope.",
        "scope_impact" => "No dashboard changes.",
        "created_by" => "architect-override"
      })

    decision_payload = get_in(decision_response, ["result", "structuredContent"])
    assert is_binary(get_in(decision_payload, ["decision_log_entry", "id"]))
    assert get_in(decision_payload, ["decision_log_entry", "source_id"]) == "comment-1"
    assert get_in(decision_payload, ["decision_log_entry", "created_by"]) == "architect-override"
    assert decision_payload["status"] == %{"work_request_status" => "clarifying"}
    refute inspect(decision_response) =~ "raw_secret_value"

    assert {:ok, questions} = WorkRequestRepository.list_questions(repo, work_request.id)
    assert Enum.map(questions, & &1.status) == ["answered", "closed", "answered"]
    assert {:ok, decisions} = WorkRequestRepository.list_decisions(repo, work_request.id)
    assert Enum.map(decisions, & &1.source_id) == [combined_question_id, "comment-default", "comment-1"]
  end

  test "ask_question rejects malformed decision prompts without echoing nested input", %{repo: repo} do
    {anchor, session, _grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-BAD-PROMPT", [
        "write:work_request"
      ])

    work_request =
      create_work_request!(repo,
        id: "WR-MCP-BAD-DECISION-PROMPT",
        repo: anchor.repo,
        base_branch: anchor.base_branch,
        status: "clarifying"
      )

    grant_work_request_scope!(repo, session, work_request.id)

    response =
      mcp_tool(repo, session, "ask_question", %{
        "work_request_id" => work_request.id,
        "category" => "scope",
        "question" => "Can the implementation continue?",
        "why_needed" => "The architect needs a human answer.",
        "decision_prompt" => %{
          "tl_dr" => "Do not leak raw_secret_value.",
          "details" => "This malformed prompt is missing options."
        }
      })

    assert get_in(response, ["error", "code"]) == -32_602
    assert get_in(response, ["error", "data", "reason"]) == "decision_prompt must contain 1 to 4 options"
    refute inspect(response) =~ "raw_secret_value"
  end

  defp legacy_handoff_session_without_repo_scope!(repo, session, grant) do
    legacy_handoff_session_with_scope_fields!(repo, session, grant, nil, nil)
  end

  defp legacy_handoff_session_with_scope_fields!(repo, session, grant, scope_repo, scope_base_branch) do
    repo.update_all(
      from(access_grant in AccessGrant, where: access_grant.id == ^grant.id),
      set: [scope_repo: scope_repo, scope_base_branch: scope_base_branch]
    )

    remove_grant_scope_type!(repo, session, "repo")

    %{
      session
      | assignment: %{
          session.assignment
          | scopes: Enum.reject(session.assignment.scopes, &match?(%Scope{type: :repo}, &1))
        }
    }
  end
end
