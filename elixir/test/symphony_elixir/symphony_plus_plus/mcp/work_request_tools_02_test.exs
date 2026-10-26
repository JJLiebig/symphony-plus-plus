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

    sibling_read_response = mcp_tool(repo, session, "read_work_request", %{"detail" => "full", "work_request_id" => equivalent_sibling.id})
    assert get_in(sibling_read_response, ["result", "structuredContent", "work_request", "id"]) == equivalent_sibling.id

    sibling_board_response = mcp_tool(repo, session, "read_delivery_board", %{"work_request_id" => equivalent_sibling.id})
    assert get_in(sibling_board_response, ["result", "structuredContent", "work_request", "id"]) == equivalent_sibling.id

    other_repo_read_response = mcp_tool(repo, session, "read_work_request", %{"detail" => "full", "work_request_id" => other_repo.id})
    assert get_in(other_repo_read_response, ["error", "code"]) == -32_004
    assert get_in(other_repo_read_response, ["error", "data", "reason"]) == "not_found"
    refute inspect(other_repo_read_response) =~ other_repo.id

    other_base_read_response = mcp_tool(repo, session, "read_work_request", %{"detail" => "full", "work_request_id" => other_base.id})
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
