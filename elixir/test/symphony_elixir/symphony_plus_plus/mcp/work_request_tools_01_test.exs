Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.WorkRequestTools01Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository, as: WorkRequestRepository

  test "create_work_request requires trusted local HTTP with explicit state", %{repo: repo} do
    arguments = %{
      "repo" => "nextide/symphony-plus-plus",
      "base_branch" => "main",
      "title" => "Denied WorkRequest",
      "description" => "This should not be created outside trusted local HTTP.",
      "request_kind" => "investigation"
    }

    stdio_response =
      Server.handle(
        %{
          "jsonrpc" => "2.0",
          "id" => "stdio-create-work-request-denied",
          "method" => "tools/call",
          "params" => %{"name" => "create_work_request", "arguments" => arguments}
        },
        Server.new(Config.default(repo: repo), initialized: true)
      )

    assert get_in(stdio_response, ["error", "code"]) == -32_001
    assert get_in(stdio_response, ["error", "data", "tool"]) == "create_work_request"
    assert get_in(stdio_response, ["error", "data", "reason"]) == "local_mcp_required"
    assert Enum.any?(tools_for_server(Server.new(Config.default(repo: repo), initialized: true)), &(&1["name"] == "create_work_request"))

    implicit_state_response =
      Server.handle(
        %{
          "jsonrpc" => "2.0",
          "id" => "implicit-state-create-work-request-denied",
          "method" => "tools/call",
          "params" => %{"name" => "create_work_request", "arguments" => arguments}
        },
        Server.new(local_mcp_config(repo), initialized: true, local_daemon_trusted: true)
      )

    assert get_in(implicit_state_response, ["error", "code"]) == -32_001
    assert get_in(implicit_state_response, ["error", "data", "reason"]) == "local_mcp_session_required"

    assert Enum.any?(
             tools_for_server(Server.new(local_mcp_config(repo), initialized: true, local_daemon_trusted: true)),
             &(&1["name"] == "create_work_request")
           )

    remote_config = %{local_mcp_config(repo) | database: "https://ledger.example.test/mcp?token=ghp_createworksecret"}

    remote_response =
      Server.handle(
        %{
          "jsonrpc" => "2.0",
          "id" => "remote-create-work-request-denied",
          "method" => "tools/call",
          "params" => %{"name" => "create_work_request", "arguments" => arguments}
        },
        local_mcp_server(remote_config, "remote-create-work-request-state")
      )

    assert get_in(remote_response, ["error", "code"]) == -32_001
    assert get_in(remote_response, ["error", "data", "reason"]) == "local_database_required"
    refute inspect(remote_response) =~ "ghp_createworksecret"
    assert Enum.any?(tools_for_server(local_mcp_server(remote_config, "remote-create-work-request-tools-state")), &(&1["name"] == "create_work_request"))

    memory_response =
      Server.handle(
        %{
          "jsonrpc" => "2.0",
          "id" => "memory-create-work-request-denied",
          "method" => "tools/call",
          "params" => %{"name" => "create_work_request", "arguments" => arguments}
        },
        local_mcp_server(%{local_mcp_config(repo) | database: ":memory:"}, "memory-create-work-request-state")
      )

    assert get_in(memory_response, ["error", "code"]) == -32_001
    assert get_in(memory_response, ["error", "data", "reason"]) == "file_backed_database_required"

    pre_initialize_response =
      Server.handle(
        %{
          "jsonrpc" => "2.0",
          "id" => "pre-init-create-work-request-denied",
          "method" => "tools/call",
          "params" => %{"name" => "create_work_request", "arguments" => arguments}
        },
        Server.new(local_mcp_config(repo), local_daemon_trusted: true, state_key: "pre-init-create-work-request-state")
      )

    assert get_in(pre_initialize_response, ["error", "code"]) == -32_000
    assert get_in(pre_initialize_response, ["error", "data", "reason"]) == "server_not_initialized"
  end

  test "architect WorkRequest read tools are scoped, filtered, redacted, and read-only", %{repo: repo} do
    {anchor, session, _grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-READ", [
        "read:work_request"
      ])

    in_scope =
      create_work_request!(repo,
        id: "WR-MCP-WR-IN",
        title: "Read WorkRequests",
        repo: anchor.repo,
        base_branch: anchor.base_branch,
        status: "ready_for_slicing",
        human_description: "Use Bearer raw-secret-value for validation",
        constraints: %{"safe" => "visible", "token" => "raw-secret-value"}
      )

    _other_repo =
      create_work_request!(repo,
        id: "WR-MCP-WR-OTHER-REPO",
        repo: "nextide/other",
        base_branch: anchor.base_branch,
        status: "ready_for_slicing"
      )

    other_branch =
      create_work_request!(repo,
        id: "WR-MCP-WR-OTHER-BRANCH",
        repo: anchor.repo,
        base_branch: "main",
        status: "ready_for_slicing"
      )

    _other_status =
      create_work_request!(repo,
        id: "WR-MCP-WR-OTHER-STATUS",
        repo: anchor.repo,
        base_branch: anchor.base_branch,
        status: "draft"
      )

    assert {:ok, _open_question} =
             WorkRequestRepository.ask_question(repo, in_scope.id, work_request_question_attrs(id: "WRQ-MCP-WR-OPEN"))

    assert {:ok, answered_question} =
             WorkRequestRepository.ask_question(repo, in_scope.id, work_request_question_attrs(id: "WRQ-MCP-WR-ANSWERED"))

    assert {:ok, _answered} =
             WorkRequestRepository.answer_question(repo, answered_question.id, "open", %{
               answer: "Bearer raw-secret-value",
               answered_by: "operator-1"
             })

    assert {:ok, closed_question} =
             WorkRequestRepository.ask_question(repo, in_scope.id, work_request_question_attrs(id: "WRQ-MCP-WR-CLOSED"))

    assert {:ok, _closed} = WorkRequestRepository.close_question(repo, closed_question.id, "open")

    assert {:ok, _decision} =
             WorkRequestRepository.record_decision(
               repo,
               in_scope.id,
               work_request_decision_attrs(id: "WRD-MCP-WR-1", decision: "Use https://example.test/path?sig=raw-secret-value")
             )

    assert {:ok, _planned} = CanonicalWorkPackageFixtures.add_work_package(repo, in_scope.id, work_request_work_package_attrs(id: "WRS-MCP-WR-PLANNED"))
    assert {:ok, approved} = CanonicalWorkPackageFixtures.add_work_package(repo, in_scope.id, work_request_work_package_attrs(id: "WRS-MCP-WR-APPROVED"))
    assert {:ok, skipped} = CanonicalWorkPackageFixtures.add_work_package(repo, in_scope.id, work_request_work_package_attrs(id: "WRS-MCP-WR-SKIPPED"))
    repo.update!(Ecto.Changeset.change(approved, status: "approved"))
    repo.update!(Ecto.Changeset.change(skipped, status: "skipped"))

    counts_before = {
      repo.aggregate(WorkRequest, :count),
      repo.aggregate(WorkPackage, :count),
      repo.aggregate(AccessGrant, :count),
      repo.aggregate(ProgressEvent, :count),
      repo.aggregate(Artifact, :count)
    }

    list_response = mcp_tool(repo, session, "list_work_requests", %{"status" => "ready_for_slicing"})
    list_payload = get_in(list_response, ["result", "structuredContent"])

    assert list_payload["scope"] == %{"repo" => anchor.repo, "base_branch" => anchor.base_branch}
    assert list_payload["filters"] == %{"status" => "ready_for_slicing"}
    assert list_payload["total_count"] == 1

    assert [
             %{
               "id" => "WR-MCP-WR-IN",
               "title" => "Read WorkRequests",
               "repo" => "nextide/symphony-plus-plus",
               "base_branch" => "symphony-plus-plus/beta",
               "status" => "ready_for_slicing"
             } = listed_work_request
           ] = list_payload["work_requests"]

    refute Map.has_key?(listed_work_request, "open_question_count")
    refute Map.has_key?(listed_work_request, "decision_count")
    refute Map.has_key?(listed_work_request, "work_package_count")

    read_response = mcp_tool(repo, session, "read_work_request", %{"work_request_id" => in_scope.id})
    read_payload = get_in(read_response, ["result", "structuredContent"])

    assert read_payload["work_request"]["id"] == in_scope.id
    assert read_payload["work_request"]["constraints"]["safe"] == "visible"
    assert read_payload["work_request"]["constraints"]["token"] == "[REDACTED]"
    assert Enum.map(read_payload["clarification_questions"], & &1["id"]) == ["WRQ-MCP-WR-OPEN", "WRQ-MCP-WR-ANSWERED", "WRQ-MCP-WR-CLOSED"]
    assert Enum.at(read_payload["clarification_questions"], 1)["answer"] == "[REDACTED]"
    assert Enum.map(read_payload["decision_log_entries"], & &1["id"]) == ["WRD-MCP-WR-1"]
    assert Enum.at(read_payload["decision_log_entries"], 0)["decision"] =~ "[REDACTED]"

    assert Enum.map(read_payload["work_packages"], & &1["id"]) == [
             "WRS-MCP-WR-PLANNED",
             "WRS-MCP-WR-APPROVED",
             "WRS-MCP-WR-SKIPPED"
           ]

    assert Enum.at(read_payload["work_packages"], 0)["review"] == nil

    assert read_payload["summary"] == %{
             "open_question_count" => 1,
             "answered_question_count" => 1,
             "closed_question_count" => 1,
             "decision_count" => 1,
             "work_package_count" => 3,
             "planned_work_package_count" => 1,
             "dispatched_work_package_count" => 0,
             "skipped_work_package_count" => 1
           }

    refute inspect(list_response) =~ "WR-MCP-WR-OTHER-REPO"
    refute inspect(read_response) =~ "raw-secret-value"

    out_of_scope_response = mcp_tool(repo, session, "read_work_request", %{"work_request_id" => other_branch.id})

    assert get_in(out_of_scope_response, ["error", "code"]) == -32_004
    assert get_in(out_of_scope_response, ["error", "data", "reason"]) == "not_found"
    refute inspect(out_of_scope_response) =~ other_branch.id

    assert {
             repo.aggregate(WorkRequest, :count),
             repo.aggregate(WorkPackage, :count),
             repo.aggregate(AccessGrant, :count),
             repo.aggregate(ProgressEvent, :count),
             repo.aggregate(Artifact, :count)
           } == counts_before
  end

  test "WorkRequest MCP reads require dedicated capability and fixed scope arguments", %{repo: repo} do
    {insufficient_anchor, insufficient_session, _grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-AUTHZ", ["read:phase"])

    insufficient_target =
      create_work_request!(repo,
        id: "WR-MCP-WR-AUTHZ",
        repo: insufficient_anchor.repo,
        base_branch: insufficient_anchor.base_branch
      )

    list_denied = mcp_tool(repo, insufficient_session, "list_work_requests", %{})
    assert get_in(list_denied, ["error", "code"]) == -32_003
    assert get_in(list_denied, ["error", "data", "reason"]) == "insufficient_capability"
    assert get_in(list_denied, ["error", "data", "reason_code"]) == "insufficient_capability"

    read_denied = mcp_tool(repo, insufficient_session, "read_work_request", %{"work_request_id" => insufficient_target.id})
    assert get_in(read_denied, ["error", "code"]) == -32_003
    assert get_in(read_denied, ["error", "data", "reason"]) == "insufficient_capability"
    assert get_in(read_denied, ["error", "data", "reason_code"]) == "insufficient_capability"

    missing_read_denied = mcp_tool(repo, insufficient_session, "read_work_request", %{"work_request_id" => "WR-MCP-WR-AUTHZ-MISSING"})
    assert get_in(missing_read_denied, ["error", "code"]) == -32_003
    assert get_in(missing_read_denied, ["error", "data", "reason"]) == "insufficient_capability"
    assert get_in(missing_read_denied, ["error", "data", "reason_code"]) == "insufficient_capability"

    board_denied =
      mcp_tool(repo, insufficient_session, "read_delivery_board", %{"work_request_id" => insufficient_target.id})

    assert get_in(board_denied, ["error", "code"]) == -32_003
    assert get_in(board_denied, ["error", "data", "reason"]) == "insufficient_capability"
    assert get_in(board_denied, ["error", "data", "reason_code"]) == "insufficient_capability"

    missing_board_denied =
      mcp_tool(repo, insufficient_session, "read_delivery_board", %{"work_request_id" => "WR-MCP-WR-AUTHZ-MISSING"})

    assert get_in(missing_board_denied, ["error", "code"]) == -32_003
    assert get_in(missing_board_denied, ["error", "data", "reason"]) == "insufficient_capability"
    assert get_in(missing_board_denied, ["error", "data", "reason_code"]) == "insufficient_capability"

    {_package, session, _grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-STRICT", ["read:work_request"])

    repo_argument_response = mcp_tool(repo, session, "list_work_requests", %{"repo" => "nextide/other"})
    assert get_in(repo_argument_response, ["error", "data", "reason"]) == "unexpected_argument"
    assert get_in(repo_argument_response, ["error", "data", "arguments"]) == ["repo"]

    branch_argument_response = mcp_tool(repo, session, "list_work_requests", %{"base_branch" => "other"})
    assert get_in(branch_argument_response, ["error", "data", "reason"]) == "unexpected_argument"
    assert get_in(branch_argument_response, ["error", "data", "arguments"]) == ["base_branch"]

    invalid_status_response = mcp_tool(repo, session, "list_work_requests", %{"status" => "merged"})
    assert get_in(invalid_status_response, ["error", "data", "reason"]) == "invalid_status"
  end

  test "WorkRequest MCP list narrows to explicit WorkRequest read scopes", %{repo: repo} do
    {anchor, session, _grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-LIST-SCOPED", [
        "read:work_request"
      ])

    visible =
      create_work_request!(repo,
        id: "WR-MCP-WR-LIST-SCOPED",
        repo: anchor.repo,
        base_branch: anchor.base_branch,
        status: "ready_for_slicing"
      )

    hidden =
      create_work_request!(repo,
        id: "WR-MCP-WR-LIST-HIDDEN",
        repo: anchor.repo,
        base_branch: anchor.base_branch,
        status: "ready_for_slicing"
      )

    grant_work_request_scope!(repo, session, visible.id)
    remove_grant_scope_type!(repo, session, "repo")

    list_response = mcp_tool(repo, session, "list_work_requests", %{"status" => "ready_for_slicing"})
    list_payload = get_in(list_response, ["result", "structuredContent"])

    assert Enum.map(list_payload["work_requests"], & &1["id"]) == [visible.id]
    refute inspect(list_response) =~ hidden.id

    hidden_read_response = mcp_tool(repo, session, "read_work_request", %{"work_request_id" => hidden.id})
    assert get_in(hidden_read_response, ["error", "code"]) == -32_004
    assert get_in(hidden_read_response, ["error", "data", "reason"]) == "not_found"
    refute inspect(hidden_read_response) =~ hidden.id

    hidden_board_response = mcp_tool(repo, session, "read_delivery_board", %{"work_request_id" => hidden.id})
    assert get_in(hidden_board_response, ["error", "code"]) == -32_004
    assert get_in(hidden_board_response, ["error", "data", "reason"]) == "not_found"
    refute inspect(hidden_board_response) =~ hidden.id
  end

  test "WorkRequest architect grants require phase scope before MCP use", %{repo: repo} do
    assert {:ok, package} =
             WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-ARCHITECT-WR-LEGACY", kind: "mcp"))

    assert {:error, %Ecto.Changeset{} = changeset} = create_architect_work_key(repo, package.id, ["read:work_request"])
    assert {"architect phase-scoped grants require phase scope", []} in Keyword.get_values(changeset.errors, :phase_id)
  end

  test "WorkRequest MCP reads fail closed when architect scope snapshot is missing", %{repo: repo} do
    {_anchor, session, grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-MISSING-SCOPE", [
        "read:work_request"
      ])

    repo.update_all(
      from(access_grant in AccessGrant, where: access_grant.id == ^grant.id),
      set: [scope_base_branch: nil]
    )

    list_response = mcp_tool(repo, session, "list_work_requests", %{})
    assert get_in(list_response, ["error", "code"]) == -32_003
    assert get_in(list_response, ["error", "data", "reason"]) == "outside_session_scope"

    read_response = mcp_tool(repo, session, "read_work_request", %{"work_request_id" => "WR-MCP-WR-IN"})
    assert get_in(read_response, ["error", "code"]) == -32_003
    assert get_in(read_response, ["error", "data", "reason"]) == "outside_session_scope"
  end

  test "WorkRequest MCP reads reject drifted architect scope snapshots", %{repo: repo} do
    {anchor, session, grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-DRIFTED-SCOPE", [
        "read:work_request"
      ])

    sibling =
      create_work_request!(repo,
        id: "WR-MCP-WR-DRIFTED-SIBLING",
        repo: "nextide/other",
        base_branch: anchor.base_branch,
        status: "ready_for_slicing"
      )

    repo.update_all(
      from(access_grant in AccessGrant, where: access_grant.id == ^grant.id),
      set: [scope_repo: sibling.repo]
    )

    list_response = mcp_tool(repo, session, "list_work_requests", %{"status" => "ready_for_slicing"})
    assert get_in(list_response, ["error", "code"]) == -32_003
    assert get_in(list_response, ["error", "data", "reason"]) == "outside_session_scope"
    refute inspect(list_response) =~ sibling.id

    read_response = mcp_tool(repo, session, "read_work_request", %{"work_request_id" => sibling.id})
    assert get_in(read_response, ["error", "code"]) == -32_003
    assert get_in(read_response, ["error", "data", "reason"]) == "outside_session_scope"
    refute inspect(read_response) =~ sibling.id

    missing_read_response = mcp_tool(repo, session, "read_work_request", %{"work_request_id" => "WR-MCP-WR-DRIFTED-MISSING"})
    assert get_in(missing_read_response, ["error", "code"]) == -32_003
    assert get_in(missing_read_response, ["error", "data", "reason"]) == "outside_session_scope"
  end
end
