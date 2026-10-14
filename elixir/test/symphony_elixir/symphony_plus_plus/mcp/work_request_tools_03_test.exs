Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.WorkRequestTools03Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  test "claim_local_architect_assignment recovers bare WorkRequest id claim when grant scope rows are stale", %{repo: repo} do
    work_request =
      create_work_request!(repo,
        id: "WR-MCP-LOCAL-ARCHITECT-BARE-STALE-SCOPE",
        status: "ready_for_clarification"
      )

    handoff = create_architect_handoff!(repo, work_request)
    assert {:ok, [grant]} = AccessGrantRepository.list_for_work_package(repo, handoff.anchor_package.id)

    repo.delete_all(
      from(scope in GrantScope,
        where: scope.access_grant_id == ^grant.id,
        where: scope.scope_type == "work_request"
      )
    )

    {response, claimed_server} =
      claim_local_architect(
        repo,
        %{"work_request_id" => work_request.id, "claimed_by" => "architect-bare"},
        "local-architect-bare-stale-scope"
      )

    assert get_in(response, ["result", "structuredContent", "assignment", "grant_id"]) == grant.id
    assert Scope.work_request(work_request.id) in claimed_server.session.assignment.scopes
  end

  test "claim_local_architect_assignment recovers when a singleton grant scope row is stale", %{repo: repo} do
    work_request =
      create_work_request!(repo,
        id: "WR-MCP-LOCAL-ARCHITECT-STALE-SINGLETON-SCOPE",
        status: "ready_for_clarification"
      )

    sibling =
      create_work_request!(repo,
        id: "WR-MCP-LOCAL-ARCHITECT-STALE-SINGLETON-SIBLING",
        status: "ready_for_clarification"
      )

    handoff = create_architect_handoff!(repo, work_request)
    assert {:ok, [grant]} = AccessGrantRepository.list_for_work_package(repo, handoff.anchor_package.id)

    repo.update_all(
      from(scope in GrantScope,
        where: scope.access_grant_id == ^grant.id,
        where: scope.scope_type == "work_request"
      ),
      set: [scope_id: sibling.id]
    )

    {response, claimed_server} =
      claim_local_architect(
        repo,
        %{"work_request_id" => work_request.id, "claimed_by" => "architect-stale-singleton"},
        "local-architect-stale-singleton-scope"
      )

    assert get_in(response, ["result", "structuredContent", "assignment", "grant_id"]) == grant.id
    assert Scope.work_request(work_request.id) in claimed_server.session.assignment.scopes

    assert {:ok, scopes} = AccessGrantRepository.list_scopes(repo, grant.id)

    assert scopes
           |> Enum.filter(&(&1.scope_type == "work_request"))
           |> Enum.map(& &1.scope_id) == [work_request.id]
  end

  test "claim_local_architect_assignment prunes stale additive grant scope rows", %{repo: repo} do
    work_request =
      create_work_request!(repo,
        id: "WR-MCP-LOCAL-ARCHITECT-STALE-ADDITIVE-SCOPE",
        status: "ready_for_clarification"
      )

    sibling =
      create_work_request!(repo,
        id: "WR-MCP-LOCAL-ARCHITECT-STALE-ADDITIVE-SIBLING",
        status: "ready_for_clarification"
      )

    handoff = create_architect_handoff!(repo, work_request)
    assert {:ok, [grant]} = AccessGrantRepository.list_for_work_package(repo, handoff.anchor_package.id)

    assert {:ok, _scope} =
             GrantScope.create_changeset(%{
               access_grant_id: grant.id,
               scope_type: "work_request",
               scope_id: sibling.id
             })
             |> repo.insert()

    {response, claimed_server} =
      claim_local_architect(
        repo,
        %{"work_request_id" => work_request.id, "claimed_by" => "architect-stale-additive"},
        "local-architect-stale-additive-scope"
      )

    assert get_in(response, ["result", "structuredContent", "assignment", "grant_id"]) == grant.id
    assert Scope.work_request(work_request.id) in claimed_server.session.assignment.scopes
    refute Scope.work_request(sibling.id) in claimed_server.session.assignment.scopes

    assert {:ok, scopes} = AccessGrantRepository.list_scopes(repo, grant.id)

    assert scopes
           |> Enum.filter(&(&1.scope_type == "work_request"))
           |> Enum.map(& &1.scope_id) == [work_request.id]
  end

  test "WorkRequest MCP work-package writes honor work-package scope without parent WorkRequest scope", %{repo: repo} do
    {anchor, session, _grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-SLICE-EXPLICIT", [
        "write:work_request"
      ])

    work_request =
      create_work_request!(repo,
        id: "WR-MCP-WR-SLICE-EXPLICIT",
        repo: anchor.repo,
        base_branch: anchor.base_branch,
        status: "ready_for_slicing"
      )

    assert {:ok, work_package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               work_request.id,
               work_request_work_package_attrs(
                 id: "WRS-MCP-WR-SLICE-EXPLICIT",
                 base_branch: anchor.base_branch
               )
             )

    grant_work_package_scope!(repo, session, work_package.id)
    remove_grant_scope_type!(repo, session, "repo")

    for patch <- [
          %{"goal" => nil},
          %{"goal" => "  "},
          %{"acceptance_criteria" => ["  "]},
          %{"validation_steps" => nil},
          %{"stop_conditions" => [nil]}
        ] do
      invalid_response =
        mcp_tool(repo, session, "update_work_package", %{
          "work_request_id" => work_request.id,
          "work_package_id" => work_package.id,
          "expected_contract_revision" => work_package.contract_revision,
          "patch" => patch
        })

      assert get_in(invalid_response, ["error", "code"]) == -32_602
      assert get_in(invalid_response, ["error", "data", "reason"]) == "invalid_work_packages"
    end

    response =
      mcp_tool(repo, session, "update_work_package", %{
        "work_request_id" => work_request.id,
        "work_package_id" => work_package.id,
        "expected_contract_revision" => work_package.contract_revision,
        "patch" => %{"title" => "Updated explicit package"}
      })

    assert get_in(response, ["result", "structuredContent", "work_package_id"]) == work_package.id,
           inspect(response)

    assert get_in(response, ["result", "structuredContent", "contract_revision"]) == 2
    text = assert_toon_tool_text!(response)
    assert text =~ "work_package_id: #{work_package.id}"
    assert text =~ "contract_revision: 2"

    assert {:ok, persisted_package} = WorkRequestRepository.get_work_package(repo, work_request.id, work_package.id)
    assert persisted_package.title == "Updated explicit package"
  end

  test "WorkRequest MCP mutations require write capability and explicit live phase scope", %{repo: repo} do
    {read_anchor, read_session, _read_grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-MUTATE-READONLY", [
        "read:work_request"
      ])

    read_only_work_request =
      create_work_request!(repo,
        id: "WR-MCP-WR-MUTATE-READONLY",
        repo: read_anchor.repo,
        base_branch: read_anchor.base_branch,
        status: "ready_for_slicing"
      )

    assert {:ok, read_only_slice} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               read_only_work_request.id,
               work_request_work_package_attrs(
                 id: "WRS-MCP-WR-MUTATE-READONLY",
                 base_branch: read_anchor.base_branch
               )
             )

    read_only_response =
      mcp_tool(repo, read_session, "ask_question", %{
        "work_request_id" => read_only_work_request.id,
        "category" => "scope",
        "question" => "Question?",
        "why_needed" => "Capability check."
      })

    assert get_in(read_only_response, ["error", "code"]) == -32_003
    assert get_in(read_only_response, ["error", "data", "reason"]) == "insufficient_capability"
    assert get_in(read_only_response, ["error", "data", "reason_code"]) == "insufficient_capability"

    read_only_slice_response =
      mcp_tool(repo, read_session, "slice_work_request", %{
        "work_request_id" => read_only_work_request.id,
        "work_packages" => [%{}]
      })

    assert get_in(read_only_slice_response, ["error", "code"]) == -32_003
    assert get_in(read_only_slice_response, ["error", "data", "reason"]) == "insufficient_capability"
    assert get_in(read_only_slice_response, ["error", "data", "reason_code"]) == "insufficient_capability"

    read_only_dispatch_response =
      mcp_tool(repo, read_session, "dispatch_work_package", %{
        "work_request_id" => read_only_work_request.id,
        "work_package_id" => read_only_slice.id,
        "claimed_by" => "worker-1"
      })

    assert get_in(read_only_dispatch_response, ["error", "code"]) == -32_003
    assert get_in(read_only_dispatch_response, ["error", "data", "reason"]) == "insufficient_capability"
    assert get_in(read_only_dispatch_response, ["error", "data", "reason_code"]) == "insufficient_capability"

    read_only_prepare_response =
      mcp_tool(repo, read_session, "prepare_work_package_worktree", %{
        "work_package_id" => "wp-missing"
      })

    assert get_in(read_only_prepare_response, ["error", "code"]) == -32_001
    assert get_in(read_only_prepare_response, ["error", "data", "reason"]) == "insufficient_capability"

    read_only_tools =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "read-only-tools", "method" => "tools/list", "params" => %{}},
        repo: repo,
        session: read_session
      )
      |> get_in(["result", "tools"])
      |> Map.new(&{&1["name"], &1})

    for tool <- @architect_tool_names do
      assert Map.has_key?(read_only_tools, tool)
    end

    assert {:ok, legacy_package} =
             WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-ARCHITECT-WR-MUTATE-LEGACY", kind: "mcp"))

    assert {:error, %Ecto.Changeset{} = legacy_changeset} =
             create_architect_work_key(repo, legacy_package.id, ["write:work_request"])

    assert {"architect phase-scoped grants require phase scope", []} in Keyword.get_values(legacy_changeset.errors, :phase_id)

    {drift_anchor, drift_session, _drift_grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-MUTATE-DRIFT", [
        "write:work_request",
        "dispatch:work_request"
      ])

    drift_work_request =
      create_work_request!(repo,
        id: "WR-MCP-WR-MUTATE-DRIFT",
        repo: drift_anchor.repo,
        base_branch: drift_anchor.base_branch,
        status: "draft"
      )

    grant_work_request_scope!(repo, drift_session, drift_work_request.id)

    assert {:ok, drift_work_package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               drift_work_request.id,
               work_request_work_package_attrs(
                 id: "WRS-MCP-WR-MUTATE-DRIFT",
                 base_branch: drift_anchor.base_branch
               )
             )

    assert {:ok, _drifted_anchor} = WorkPackageRepository.update(repo, drift_anchor.id, %{repo: "nextide/other"})

    drift_response =
      mcp_tool(repo, drift_session, "set_work_request_status", %{
        "work_request_id" => drift_work_request.id,
        "current_status" => "draft",
        "next_status" => "ready_for_clarification"
      })

    assert get_in(drift_response, ["error", "code"]) == -32_003
    assert get_in(drift_response, ["error", "data", "reason"]) == "outside_session_scope"

    drift_slice_response =
      mcp_tool(repo, drift_session, "slice_work_request", %{
        "work_request_id" => drift_work_request.id,
        "work_packages" => [%{}]
      })

    assert get_in(drift_slice_response, ["error", "code"]) == -32_003
    assert get_in(drift_slice_response, ["error", "data", "reason"]) == "outside_session_scope"

    drift_dispatch_response =
      mcp_tool(repo, drift_session, "dispatch_work_package", %{
        "work_request_id" => drift_work_request.id,
        "work_package_id" => drift_work_package.id,
        "claimed_by" => "worker-1"
      })

    assert get_in(drift_dispatch_response, ["error", "code"]) == -32_003
    assert get_in(drift_dispatch_response, ["error", "data", "reason"]) == "outside_session_scope"

    {revoked_anchor, revoked_session, revoked_grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-MUTATE-REVOKED", [
        "write:work_request",
        "dispatch:work_request"
      ])

    revoked_work_request =
      create_work_request!(repo,
        id: "WR-MCP-WR-MUTATE-REVOKED",
        repo: revoked_anchor.repo,
        base_branch: revoked_anchor.base_branch,
        status: "draft"
      )

    assert {:ok, _revoked} = AccessGrantService.revoke(repo, revoked_grant.id)

    revoked_response =
      mcp_tool(repo, revoked_session, "set_work_request_status", %{
        "work_request_id" => revoked_work_request.id,
        "current_status" => "draft",
        "next_status" => "ready_for_clarification"
      })

    assert get_in(revoked_response, ["error", "code"]) == -32_001
    assert get_in(revoked_response, ["error", "data", "reason"]) == "revoked"

    revoked_slice_response =
      mcp_tool(repo, revoked_session, "slice_work_request", %{
        "work_request_id" => revoked_work_request.id,
        "work_packages" => [%{}]
      })

    assert get_in(revoked_slice_response, ["error", "code"]) == -32_001
    assert get_in(revoked_slice_response, ["error", "data", "reason"]) == "revoked"

    revoked_dispatch_response =
      mcp_tool(repo, revoked_session, "dispatch_work_package", %{
        "work_request_id" => revoked_work_request.id,
        "work_package_id" => "WRS-MCP-WR-MUTATE-REVOKED",
        "claimed_by" => "worker-1"
      })

    assert get_in(revoked_dispatch_response, ["error", "code"]) == -32_001
    assert get_in(revoked_dispatch_response, ["error", "data", "reason"]) == "revoked"

    assert {:ok, worker_package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WR-MUTATE-WORKER", kind: "mcp"))
    assert {:ok, worker_minted} = AccessGrantService.mint_worker_grant(repo, worker_package.id)
    assert {:ok, worker_assignment} = AccessGrantService.claim(repo, worker_minted.work_key.secret, claimed_by: "worker-1")
    worker_session = MCPHarness.session(worker_assignment, proof_hash: worker_minted.grant.secret_hash)

    worker_work_request =
      create_work_request!(repo,
        id: "WR-MCP-WR-MUTATE-WORKER",
        repo: "nextide/symphony-plus-plus",
        base_branch: "symphony-plus-plus/beta",
        status: "ready_for_slicing"
      )

    assert {:ok, worker_work_package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               worker_work_request.id,
               work_request_work_package_attrs(
                 id: "WRS-MCP-WR-MUTATE-WORKER",
                 base_branch: "symphony-plus-plus/beta"
               )
             )

    worker_response =
      mcp_tool(repo, worker_session, "set_work_request_status", %{
        "work_request_id" => worker_work_request.id,
        "current_status" => "draft",
        "next_status" => "ready_for_clarification"
      })

    assert get_in(worker_response, ["error", "code"]) == -32_003
    assert get_in(worker_response, ["error", "data", "reason_code"]) == "insufficient_role"

    worker_slice_response =
      mcp_tool(repo, worker_session, "slice_work_request", %{
        "work_request_id" => worker_work_request.id,
        "work_packages" => [%{}]
      })

    assert get_in(worker_slice_response, ["error", "code"]) == -32_003
    assert get_in(worker_slice_response, ["error", "data", "reason_code"]) == "insufficient_role"

    worker_dispatch_response =
      mcp_tool(repo, worker_session, "dispatch_work_package", %{
        "work_request_id" => worker_work_request.id,
        "work_package_id" => worker_work_package.id,
        "claimed_by" => "worker-1"
      })

    assert get_in(worker_dispatch_response, ["error", "code"]) == -32_003
    assert get_in(worker_dispatch_response, ["error", "data", "reason_code"]) == "insufficient_role"

    anonymous_response =
      mcp_tool(repo, nil, "set_work_request_status", %{
        "work_request_id" => "WR-MCP-WR-MISSING",
        "current_status" => "draft",
        "next_status" => "ready_for_clarification"
      })

    assert get_in(anonymous_response, ["error", "code"]) == -32_001
    assert get_in(anonymous_response, ["error", "data", "reason"]) == "claim_required"
    assert get_in(anonymous_response, ["error", "data", "action"]) == "claim_local_architect_assignment"

    anonymous_slice_response =
      mcp_tool(repo, nil, "slice_work_request", %{
        "work_request_id" => "WR-MCP-WR-MISSING",
        "work_packages" => [%{}]
      })

    assert get_in(anonymous_slice_response, ["error", "code"]) == -32_001
    assert get_in(anonymous_slice_response, ["error", "data", "reason"]) == "claim_required"
    assert get_in(anonymous_slice_response, ["error", "data", "action"]) == "claim_local_architect_assignment"

    anonymous_dispatch_response =
      mcp_tool(repo, nil, "dispatch_work_package", %{
        "work_request_id" => "WR-MCP-WR-MISSING",
        "work_package_id" => "WRS-MCP-WR-MISSING",
        "claimed_by" => "worker-1"
      })

    assert get_in(anonymous_dispatch_response, ["error", "code"]) == -32_001
    assert get_in(anonymous_dispatch_response, ["error", "data", "reason"]) == "claim_required"
    assert get_in(anonymous_dispatch_response, ["error", "data", "action"]) == "claim_local_architect_assignment"
  end

  test "WorkRequest MCP work-package mutations require an authoring parent status", %{repo: repo} do
    {anchor, session, _grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-AUTHORING-STATUS", [
        "write:work_request"
      ])

    work_request =
      create_work_request!(repo,
        id: "WR-MCP-WR-AUTHORING-STATUS",
        repo: anchor.repo,
        base_branch: anchor.base_branch,
        status: "ready_for_slicing"
      )

    grant_work_request_scope!(repo, session, work_request.id)

    assert {:ok, work_package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               work_request.id,
               work_request_work_package_attrs(id: "WP-MCP-WR-AUTHORING-STATUS")
             )

    repo.update_all(from(request in WorkRequest, where: request.id == ^work_request.id), set: [status: "completed"])

    update_response =
      mcp_tool(repo, session, "update_work_package", %{
        "work_request_id" => work_request.id,
        "work_package_id" => work_package.id,
        "expected_contract_revision" => work_package.contract_revision,
        "patch" => %{"title" => "Must not persist"}
      })

    assert get_in(update_response, ["error", "code"]) == -32_009
    assert get_in(update_response, ["error", "data", "reason"]) == "work_request_terminal"
    assert get_in(update_response, ["error", "data", "recovery", "next_action"]) == "no_change"

    skip_response =
      mcp_tool(repo, session, "skip_work_package", %{
        "work_request_id" => work_request.id,
        "work_package_id" => work_package.id,
        "current_status" => "planned"
      })

    assert get_in(skip_response, ["error", "code"]) == -32_009
    assert get_in(skip_response, ["error", "data", "reason"]) == "work_request_terminal"
    assert get_in(skip_response, ["error", "data", "recovery", "next_action"]) == "no_change"

    persisted = repo.get!(WorkPackage, work_package.id)
    assert persisted.title == work_package.title
    assert persisted.status == "planned"
  end

  defp create_architect_handoff!(repo, work_request) do
    assert {:ok, handoff} =
             ArchitectHandoff.create_or_replay(repo, work_request.id,
               local_operator?: true,
               handoff_opts: local_architect_handoff_opts(repo)
             )

    handoff
  end

  defp local_architect_handoff_opts(repo) do
    [claimed_by: ArchitectHandoff.claimed_by(), database: repo.database_path(), local_architect_claim?: true]
  end

  defp claim_local_architect(repo, arguments, id) do
    Server.handle_state(
      %{
        "jsonrpc" => "2.0",
        "id" => id,
        "method" => "tools/call",
        "params" => %{"name" => "claim_local_architect_assignment", "arguments" => arguments}
      },
      local_mcp_server(local_mcp_config(repo), "#{id}-state")
    )
  end
end
