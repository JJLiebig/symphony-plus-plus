Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.DeliveryReconcile01Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  test "trusted local HTTP browses without claiming and auto-claims a scoped mutation", %{repo: repo} do
    work_request =
      create_work_request!(
        repo,
        id: "WR-MCP-LOCAL-READ",
        title: "Trusted local ghp_localreadsecret discovery",
        repo: "https://example.test/repo?token=ghp_localreadsecret",
        base_branch: "feature/raw-secret-localreadbranch",
        status: "ready_for_slicing",
        human_description: "Do not expose Bearer localreadsecretvalue."
      )

    _other_status =
      create_work_request!(
        repo,
        id: "WR-MCP-LOCAL-READ-DRAFT",
        repo: work_request.repo,
        base_branch: work_request.base_branch,
        status: "draft"
      )

    assert {:ok, work_package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               work_request.id,
               work_request_work_package_attrs(
                 id: "WRS-MCP-LOCAL-READ",
                 base_branch: work_request.base_branch
               )
             )

    local_server = local_mcp_server(local_mcp_config(repo), "local-work-request-read-state")
    tools_by_name = tools_for_server(local_server) |> Map.new(&{&1["name"], &1})

    assert Map.has_key?(tools_by_name, "list_work_requests")
    assert Map.has_key?(tools_by_name, "read_work_request")
    assert Map.has_key?(tools_by_name, "read_delivery_board")
    assert Map.has_key?(tools_by_name, "get_current_assignment")
    assert Map.has_key?(tools_by_name, "claim_local_architect_assignment")

    {list_response, list_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "local-list-work-requests",
          "method" => "tools/call",
          "params" => %{"name" => "list_work_requests", "arguments" => %{"status" => "ready_for_slicing"}}
        },
        local_server
      )

    assert list_server.session == nil

    list_payload = get_in(list_response, ["result", "structuredContent"])
    assert list_payload["scope"] == %{"visibility" => "local_ledger"}
    assert list_payload["filters"] == %{"status" => "ready_for_slicing"}
    assert list_payload["total_count"] == 1
    assert [%{"id" => "WR-MCP-LOCAL-READ", "title" => listed_title} = listed] = list_payload["work_requests"]
    assert listed_title == "Trusted local [REDACTED] discovery"
    assert listed["repo"] == "https://example.test/repo?token=[REDACTED]"
    assert listed["base_branch"] == "feature/[REDACTED]"
    refute inspect(list_response) =~ "ghp_localreadsecret"
    refute inspect(list_response) =~ "localreadsecretvalue"
    refute inspect(list_response) =~ "raw-secret-localreadbranch"

    {read_response, read_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "local-read-work-request",
          "method" => "tools/call",
          "params" => %{"name" => "read_work_request", "arguments" => %{"work_request_id" => work_request.id}}
        },
        list_server
      )

    assert read_server.session == nil
    assert get_in(read_response, ["result", "structuredContent", "work_request", "id"]) == work_request.id
    assert get_in(read_response, ["result", "structuredContent", "work_packages", Access.at(0), "id"]) == work_package.id

    assert get_in(read_response, ["result", "structuredContent", "scope"]) == %{
             "repo" => "https://example.test/repo?token=[REDACTED]",
             "base_branch" => "feature/[REDACTED]"
           }

    refute inspect(read_response) =~ "ghp_localreadsecret"
    refute inspect(read_response) =~ "localreadsecretvalue"
    refute inspect(read_response) =~ "raw-secret-localreadbranch"

    board_response =
      Server.handle(
        %{
          "jsonrpc" => "2.0",
          "id" => "local-read-delivery-board",
          "method" => "tools/call",
          "params" => %{
            "name" => "read_delivery_board",
            "arguments" => %{"work_request_id" => work_request.id}
          }
        },
        read_server
      )

    assert get_in(board_response, ["result", "structuredContent", "work_request", "id"]) == work_request.id
    assert get_in(board_response, ["result", "structuredContent", "delivery_board", "work_packages", Access.at(0), "id"]) == work_package.id

    assert get_in(board_response, ["result", "structuredContent", "scope"]) == %{
             "repo" => "https://example.test/repo?token=[REDACTED]",
             "base_branch" => "feature/[REDACTED]"
           }

    refute inspect(board_response) =~ "ghp_localreadsecret"
    refute inspect(board_response) =~ "localreadsecretvalue"
    refute inspect(board_response) =~ "raw-secret-localreadbranch"

    {mutation_response, mutation_server} =
      Server.handle_state(
        %{
          "jsonrpc" => "2.0",
          "id" => "local-read-then-mutate",
          "method" => "tools/call",
          "params" => %{
            "name" => "slice_work_request",
            "arguments" => %{
              "work_request_id" => work_request.id,
              "work_packages" => [
                %{
                  "title" => "Automatically claimed local mutation",
                  "goal" => "Acquire architect ownership before writing.",
                  "kind" => "mcp",
                  "base_branch" => work_request.base_branch,
                  "allowed_file_globs" => ["elixir/lib/symphony_elixir/symphony_plus_plus/mcp/server.ex"],
                  "forbidden_file_globs" => [],
                  "acceptance_criteria" => ["Mutation acquires architect ownership automatically."],
                  "validation_steps" => ["mix test test/symphony_elixir/symphony_plus_plus/mcp"],
                  "review" => %{"type" => "review-suite", "args" => %{"mode" => "normal"}},
                  "stop_conditions" => ["Stop after the single scoped mutation."]
                }
              ]
            }
          }
        },
        read_server
      )

    assert get_in(mutation_response, ["result", "structuredContent", "status", "work_request_status"]) == "sliced"
    assert mutation_server.session.assignment.grant_role == "architect"
    assert {:ok, persisted_slices} = WorkRequestRepository.list_work_packages(repo, work_request.id)
    assert length(persisted_slices) == 2
    assert Enum.any?(persisted_slices, &(&1.id == work_package.id))
  end

  test "claimed architect syncs only an explicit descendant PR through the merge reconciler", %{repo: repo} do
    original_client = Application.get_env(:symphony_elixir, :sympp_github_client)
    Application.put_env(:symphony_elixir, :sympp_github_client, SymphonyElixir.FakeGitHubClient)
    SymphonyElixir.FakeGitHubClient.clear()

    on_exit(fn ->
      SymphonyElixir.FakeGitHubClient.clear()

      case original_client do
        nil -> Application.delete_env(:symphony_elixir, :sympp_github_client)
        client -> Application.put_env(:symphony_elixir, :sympp_github_client, client)
      end
    end)

    {anchor, session, _grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-SYNC-PR", ["write:work_request"],
        repo: "nextide/repo",
        base_branch: "main"
      )

    work_request =
      create_work_request!(repo,
        id: "WR-MCP-ARCHITECT-SYNC-PR",
        repo: anchor.repo,
        base_branch: anchor.base_branch,
        status: "sliced"
      )

    grant_work_request_scope!(repo, session, work_request.id)

    assert {:ok, package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               work_request.id,
               work_request_work_package_attrs(
                 id: "WRS-MCP-ARCHITECT-SYNC-PR",
                 repo: work_request.repo,
                 base_branch: work_request.base_branch,
                 status: "ready_for_merge"
               )
             )

    assert {:ok, _attached_pr} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: package.id,
               summary: "PR attached",
               status: "pr_attached",
               payload: %{
                 type: "pr",
                 source_tool: "attach_pr",
                 url: "https://github.com/nextide/repo/pull/411",
                 head_sha: "head-411"
               }
             })

    SymphonyElixir.FakeGitHubClient.put_response(
      "nextide/repo",
      411,
      SymphonyElixir.GitHubPullRequestFixtures.metadata(411, "head-411",
        merged?: true,
        base_branch: work_request.base_branch
      )
    )

    tools =
      %{test_mcp_config(repo) | surface_profile: :architect}
      |> Server.new(initialized: true, session: session)
      |> tools_for_server()
      |> Map.new(&{&1["name"], &1})

    full_tools =
      test_mcp_config(repo)
      |> Server.new(initialized: true, session: session)
      |> tools_for_server()
      |> Map.new(&{&1["name"], &1})

    refute Map.has_key?(tools, "attach_pr")
    assert get_in(tools, ["sync_pr", "inputSchema", "required"]) == ["work_package_id"]
    assert get_in(tools, ["sync_pr", "inputSchema", "additionalProperties"]) == true
    assert full_tools["sync_pr"] == tools["sync_pr"]

    other_work_request =
      create_work_request!(repo,
        id: "WR-MCP-ARCHITECT-SYNC-PR-OTHER",
        repo: anchor.repo,
        base_branch: anchor.base_branch
      )

    assert {:ok, other_package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               other_work_request.id,
               work_request_work_package_attrs(id: "WRS-MCP-ARCHITECT-SYNC-PR-OTHER")
             )

    outside_scope =
      mcp_tool(repo, session, "sync_pr", %{
        "work_request_id" => work_request.id,
        "work_package_id" => other_package.id
      })

    assert get_in(outside_scope, ["error", "data", "reason"]) == "not_found"

    synced = mcp_tool(repo, session, "sync_pr", %{"work_package_id" => package.id})

    assert get_in(synced, ["result", "structuredContent", "work_package", "status"]) == "merged"
    assert get_in(synced, ["result", "structuredContent", "pr_sync", "status"]) == "merged"

    assert get_in(synced, ["result", "structuredContent", "scope"]) == %{
             "repo" => work_request.repo,
             "base_branch" => work_request.base_branch
           }

    assert {:ok, persisted_package} = WorkPackageRepository.get(repo, package.id)
    assert persisted_package.status == "merged"
  end

  test "claimed architect repairs a descendant branch head visible on the delivery board", %{repo: repo} do
    {anchor, session, _grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-ATTACH-BRANCH", ["read:work_request", "write:work_request"],
        repo: "nextide/repo",
        base_branch: "main"
      )

    work_request =
      create_work_request!(repo,
        id: "WR-MCP-ARCHITECT-ATTACH-BRANCH",
        repo: anchor.repo,
        base_branch: anchor.base_branch,
        status: "sliced"
      )

    grant_work_request_scope!(repo, session, work_request.id)

    assert {:ok, package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               work_request.id,
               work_request_work_package_attrs(id: "WRS-MCP-ARCHITECT-ATTACH-BRANCH")
             )

    assert {:ok, _stale_branch} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: package.id,
               summary: "Branch attached",
               status: "branch_attached",
               payload: %{type: "branch", source_tool: "attach_branch", branch: "feat/repair", head_sha: "stale-head"}
             })

    tools =
      %{test_mcp_config(repo) | surface_profile: :architect}
      |> Server.new(initialized: true, session: session)
      |> tools_for_server()
      |> Map.new(&{&1["name"], &1})

    full_tools =
      test_mcp_config(repo)
      |> Server.new(initialized: true, session: session)
      |> tools_for_server()
      |> Map.new(&{&1["name"], &1})

    assert get_in(tools, ["attach_branch", "inputSchema", "required"]) == ["work_package_id", "head_sha"]
    assert full_tools["attach_branch"] == tools["attach_branch"]

    repaired =
      mcp_tool(repo, session, "attach_branch", %{
        "work_package_id" => package.id,
        "branch" => "feat/repair",
        "head_sha" => "current-head"
      })

    assert get_in(repaired, ["result", "structuredContent", "progress_event", "status"]) == "branch_attached"

    board = mcp_tool(repo, session, "read_delivery_board", %{"work_request_id" => work_request.id})
    [board_package] = get_in(board, ["result", "structuredContent", "delivery_board", "work_packages"])
    assert board_package["work_package"]["branch"]["head_sha"] == "current-head"
  end

  test "architect dispatch and normal PR handoff need no worker MCP calls", %{repo: repo} do
    {anchor, session, _grant} =
      create_phase_architect_session(
        repo,
        "SYMPP-ARCHITECT-WR-SLICE-DISPATCH",
        [
          "dispatch:work_request",
          "write:work_request",
          "read:work_request"
        ], repo: "nextide/repo")

    work_request =
      create_work_request!(repo,
        id: "WR-MCP-WR-SLICE-DISPATCH",
        repo: anchor.repo,
        base_branch: anchor.base_branch,
        status: "ready_for_slicing",
        human_description: "Do not return raw_secret_value."
      )

    grant_work_request_scope!(repo, session, work_request.id)

    secret_title_token = "raw_secret_bootstrap_title"

    assert {:ok, work_package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               work_request.id,
               work_request_work_package_attrs(
                 id: "WRS-MCP-WR-SLICE-DISPATCH",
                 title: "Dispatch #{secret_title_token}",
                 base_branch: anchor.base_branch,
                 goal: "Dispatch without leaking raw_secret_value.",
                 allowed_file_globs: ["elixir/lib/symphony_elixir/symphony_plus_plus/mcp/server.ex"]
               )
             )

    assert {:ok, approved_slice} = CanonicalWorkPackageFixtures.approve_work_package(repo, work_request.id, work_package.id, "planned")
    assert {:ok, _work_request} = CanonicalWorkPackageFixtures.mark_sliced(repo, work_request.id, "ready_for_slicing")

    live_database_path = current_main_database_path(repo)
    configured_database = sqlite_file_uri(live_database_path, "mode=rwc&cache=shared")

    response =
      mcp_tool(
        repo,
        session,
        "dispatch_work_package",
        %{
          "work_request_id" => work_request.id,
          "work_package_id" => approved_slice.id,
          "claimed_by" => "worker-dispatch-1"
        },
        config: Config.default(repo: repo, database: configured_database)
      )

    payload = get_in(response, ["result", "structuredContent"])
    serialized_response = inspect(response)
    assert payload["scope"] == %{"repo" => anchor.repo, "base_branch" => anchor.base_branch}
    assert payload["work_request"] == %{"id" => work_request.id}
    assert payload["work_package"]["id"] == approved_slice.id
    assert payload["work_package"]["status"] == "ready_for_worker"
    assert is_binary(payload["work_package"]["dispatched_at"])
    assert payload["worker_grant"]["secret_in_response"] == false
    refute Map.has_key?(payload["worker_grant"], "display_key")
    refute Map.has_key?(payload["worker_grant"], "secret_handoff")
    refute Map.has_key?(payload["worker_grant"], "secret")
    refute Map.has_key?(payload["worker_grant"], "secret_hash")
    refute Map.has_key?(payload, "worker_handoff")
    assignment = payload["worker_bootstrap"]["assignment"]
    assert assignment["work_package"]["id"] == approved_slice.id
    assert assignment["work_package"]["allowed_file_globs"] == work_package.allowed_file_globs
    assert assignment["work_package"]["acceptance_criteria"] == work_package.acceptance_criteria
    assert assignment["work_package"]["validation_steps"] == work_package.validation_steps
    assert assignment["parent_work_request"]["id"] == work_request.id
    refute Map.has_key?(payload["worker_bootstrap"], "claim")
    assert payload["worker_bootstrap"]["launch_prompt"] =~ "No worker MCP calls"
    refute Map.has_key?(payload["worker_bootstrap"], "prompt")
    refute Map.has_key?(payload["worker_bootstrap"], "legacy_private_handoff")
    refute serialized_response =~ "raw_secret_value"
    refute serialized_response =~ "secret_hash"
    refute serialized_response =~ secret_title_token
    refute serialized_response =~ "run_mcp_command"
    refute serialized_response =~ "local-private-file"
    refute serialized_response =~ ".secret"

    assert {:ok, persisted_slice} = WorkRequestRepository.get_work_package(repo, work_request.id, approved_slice.id)
    assert persisted_slice.status == "ready_for_worker"
    assert persisted_slice.id == payload["work_package"]["id"]

    assert {:ok, worker_grants} = AccessGrantRepository.list_for_work_package(repo, payload["work_package"]["id"])
    assert [%AccessGrant{grant_role: "worker", secret_hash: secret_hash}] = worker_grants
    refute serialized_response =~ secret_hash

    original_client = Application.get_env(:symphony_elixir, :sympp_github_client)
    Application.put_env(:symphony_elixir, :sympp_github_client, SymphonyElixir.FakeGitHubClient)

    try do
      head = String.duplicate("a", 40)
      metadata = SymphonyElixir.GitHubPullRequestFixtures.metadata(412, head, base_branch: anchor.base_branch)
      SymphonyElixir.FakeGitHubClient.put_response("nextide/repo", 412, metadata)
      handoff = %{"work_package_id" => approved_slice.id, "url" => "https://github.com/nextide/repo/pull/412", "head_sha" => head}

      mismatch = mcp_tool(repo, session, "sync_pr", %{handoff | "head_sha" => String.duplicate("b", 40)})
      assert get_in(mismatch, ["error", "code"]) == -32_602
      assert repo.get!(WorkPackage, approved_slice.id).status == "ready_for_worker"

      assert {:ok, other_owner} =
               ClaimLeaseService.claim(repo, approved_slice.id, %{"actor_kind" => "agent", "actor_id" => "another-worker"},
                 now: DateTime.add(DateTime.utc_now(:microsecond), -1, :hour),
                 stale_after_ms: 1
               )

      for ownership <- [:stale, :paused] do
        if ownership == :paused do
          assert {:ok, _paused} = ClaimLeaseService.pause(repo, other_owner.id, %{"actor_id" => "operator"}, reason: "Owner paused")
        end

        refused = mcp_tool(repo, session, "sync_pr", handoff)
        assert refused["error"]
        assert repo.get!(WorkPackage, approved_slice.id).status == "ready_for_worker"
        assert {:ok, unchanged} = PlanningRepository.get_state(repo, approved_slice.id)
        refute Enum.any?(unchanged.progress_events, &(&1.payload["source_tool"] == "sync_pr"))
      end

      assert {:ok, _released} = ClaimLeaseService.release(repo, other_owner.id, reason: "Architect confirmed the owner finished")

      declared =
        mcp_tool(repo, session, "append_progress", %{
          "work_package_id" => approved_slice.id,
          "summary" => "Architect needs an affected-scope decision",
          "idempotency_key" => "explicit-work-blocker",
          "payload" => %{"type" => "blocker", "active" => true, "blocker_id" => "decision"}
        })

      refute declared["error"]

      waiting = mcp_tool(repo, session, "sync_pr", handoff)
      assert get_in(waiting, ["result", "structuredContent", "work_package", "status"]) == "ready_for_worker"
      assert "no_active_blockers" in get_in(waiting, ["result", "structuredContent", "pr_sync", "readiness_reasons"])

      resolved =
        mcp_tool(repo, session, "resolve_blocker", %{
          "work_package_id" => approved_slice.id,
          "blocker_id" => "decision",
          "resolution" => "Architect resolved the scope decision",
          "summary" => "Work may finish",
          "idempotency_key" => "explicit-work-blocker-resolved"
        })

      refute resolved["error"]

      assert {:ok, prerequisite} =
               CanonicalWorkPackageFixtures.add_work_package(repo, work_request.id, work_request_work_package_attrs(id: "WRS-MCP-DISPATCH-PREREQUISITE", base_branch: anchor.base_branch))

      assert {:ok, _edge} =
               SymphonyElixir.SymphonyPlusPlus.ProductTree.create_dependency_edge(repo, %{
                 id: "dep_handoff",
                 work_request_id: work_request.id,
                 source_kind: "work_package",
                 source_id: approved_slice.id,
                 target_kind: "work_package",
                 target_id: prerequisite.id,
                 kind: "depends_on",
                 reason: "Architect added a prerequisite after dispatch."
               })

      pending_dependency = mcp_tool(repo, session, "sync_pr", handoff)
      assert "dependencies_unavailable" in get_in(pending_dependency, ["result", "structuredContent", "pr_sync", "readiness_reasons"])
      assert repo.get!(WorkPackage, approved_slice.id).status == "ready_for_worker"

      completed_dependency =
        mcp_tool(repo, session, "record_work_package_delivery", %{
          "work_request_id" => work_request.id,
          "work_package_id" => prerequisite.id,
          "outcome" => "completed_no_pr",
          "idempotency_key" => "handoff-prerequisite-completed",
          "evidence" => %{"completed_no_pr" => %{"no_pr_evidence" => "Architect accepted the contract investigation findings."}}
        })

      refute completed_dependency["error"]

      accepted = mcp_tool(repo, session, "sync_pr", Map.put(handoff, "future_provider_field", true))
      assert get_in(accepted, ["result", "structuredContent", "work_package", "status"]) == "ready_for_merge"
      assert repo.get!(ClaimLease, other_owner.id).status == "released"
      assert {:ok, state} = PlanningRepository.get_state(repo, approved_slice.id)
      snapshot = state.progress_events |> Enum.filter(&(&1.payload["source_tool"] == "sync_pr")) |> List.last()
      assert snapshot.payload["check_summary"]["status"] == "unknown"
      assert snapshot.payload["review_state"]["status"] == "unknown"
      assert snapshot.payload["head_sha"] == head

      # Readiness records the architect's acceptance; it does not invent native check/review results.
      SymphonyElixir.FakeGitHubClient.put_response("nextide/repo", 412, SymphonyElixir.GitHubPullRequestFixtures.metadata(412, head, merged?: true, base_branch: anchor.base_branch))
      merged = mcp_tool(repo, session, "sync_pr", %{"work_package_id" => approved_slice.id})
      assert get_in(merged, ["result", "structuredContent", "work_package", "status"]) == "merged"
    after
      restore_app_env(:sympp_github_client, original_client)
      SymphonyElixir.FakeGitHubClient.clear()
    end
  end

  test "architect dispatch ignores unknown request fields", %{repo: repo} do
    {anchor, session, _grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-SLICE-DISPATCH-IGNORED-LEGACY", [
        "dispatch:work_request"
      ])

    work_request =
      create_work_request!(repo,
        id: "WR-MCP-WR-SLICE-DISPATCH-IGNORED-LEGACY",
        repo: anchor.repo,
        base_branch: anchor.base_branch,
        status: "ready_for_slicing"
      )

    grant_work_request_scope!(repo, session, work_request.id)

    assert {:ok, work_package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               work_request.id,
               work_request_work_package_attrs(
                 id: "WRS-MCP-WR-SLICE-DISPATCH-IGNORED-LEGACY",
                 base_branch: anchor.base_branch
               )
             )

    assert {:ok, approved_slice} = CanonicalWorkPackageFixtures.approve_work_package(repo, work_request.id, work_package.id, "planned")
    assert {:ok, _work_request} = CanonicalWorkPackageFixtures.mark_sliced(repo, work_request.id, "ready_for_slicing")

    response =
      mcp_tool(repo, session, "dispatch_work_package", %{
        "work_request_id" => work_request.id,
        "work_package_id" => approved_slice.id,
        "claimed_by" => "worker-dispatch-removed-legacy",
        "removed_handoff_arg" => "auto"
      })

    assert get_in(response, ["result", "structuredContent", "work_package", "status"]) == "ready_for_worker"
    refute inspect(response) =~ "removed_handoff_arg"
  end

  test "WorkRequest MCP work-package dispatch fails closed for scope and invalid slice cases", %{repo: repo} do
    {anchor, session, _grant} =
      create_phase_architect_session(repo, "SYMPP-ARCHITECT-WR-SLICE-DISPATCH-GUARD", [
        "dispatch:work_request"
      ])

    in_scope =
      create_work_request!(repo,
        id: "WR-MCP-WR-DISPATCH-GUARD",
        repo: anchor.repo,
        base_branch: anchor.base_branch,
        status: "ready_for_slicing"
      )

    grant_work_request_scope!(repo, session, in_scope.id)

    sibling =
      create_work_request!(repo,
        id: "WR-MCP-WR-DISPATCH-SIBLING",
        repo: "nextide/other",
        base_branch: anchor.base_branch,
        status: "ready_for_slicing"
      )

    assert {:ok, _work_package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               in_scope.id,
               work_request_work_package_attrs(id: "WRS-MCP-WR-DISPATCH-PLANNED", base_branch: anchor.base_branch)
             )

    assert {:ok, sibling_slice} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               sibling.id,
               work_request_work_package_attrs(id: "WRS-MCP-WR-DISPATCH-SIBLING", base_branch: anchor.base_branch)
             )

    assert {:ok, _work_request} = CanonicalWorkPackageFixtures.mark_sliced(repo, in_scope.id, "ready_for_slicing")

    out_of_scope_response =
      mcp_tool(repo, session, "dispatch_work_package", %{
        "work_request_id" => sibling.id,
        "work_package_id" => sibling_slice.id,
        "claimed_by" => "worker-dispatch-1"
      })

    assert get_in(out_of_scope_response, ["error", "code"]) == -32_004
    assert get_in(out_of_scope_response, ["error", "data", "reason"]) == "not_found"
    refute inspect(out_of_scope_response) =~ sibling.id
    refute inspect(out_of_scope_response) =~ sibling_slice.id

    missing_slice_response =
      mcp_tool(repo, session, "dispatch_work_package", %{
        "work_request_id" => in_scope.id,
        "work_package_id" => "WRS-MCP-WR-DISPATCH-MISSING",
        "claimed_by" => "worker-dispatch-1"
      })

    assert get_in(missing_slice_response, ["error", "code"]) == -32_004
    assert get_in(missing_slice_response, ["error", "data", "reason"]) == "not_found"

    assert {:ok, live_database_slice} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               in_scope.id,
               work_request_work_package_attrs(id: "WRS-MCP-WR-DISPATCH-LIVE-DATABASE", base_branch: anchor.base_branch)
             )

    assert {:ok, approved_live_database_slice} =
             CanonicalWorkPackageFixtures.approve_work_package(repo, in_scope.id, live_database_slice.id, "planned")

    live_database = current_main_database_path(repo)
    configured_live_database = sqlite_file_uri(live_database, "mode=rwc&cache=shared")
    original_database = Application.get_env(:symphony_elixir, :sympp_repo_database)

    live_database_response =
      try do
        Application.put_env(:symphony_elixir, :sympp_repo_database, configured_live_database)

        mcp_tool(repo, session, "dispatch_work_package", %{
          "work_request_id" => in_scope.id,
          "work_package_id" => approved_live_database_slice.id,
          "claimed_by" => "worker-dispatch-1"
        })
      after
        restore_app_env(:sympp_repo_database, original_database)
      end

    live_database_payload = get_in(live_database_response, ["result", "structuredContent"])
    assert live_database_payload["work_package"]["status"] == "ready_for_worker"
    refute Map.has_key?(live_database_payload, "worker_handoff")
    assert live_database_payload["worker_bootstrap"]["assignment"]["work_package"]["id"] == approved_live_database_slice.id
    refute inspect(live_database_response) =~ "run_mcp_command"

    assert {:ok, blank_database_slice} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               in_scope.id,
               work_request_work_package_attrs(id: "WRS-MCP-WR-DISPATCH-BLANK-DATABASE", base_branch: anchor.base_branch)
             )

    assert {:ok, approved_blank_database_slice} =
             CanonicalWorkPackageFixtures.approve_work_package(repo, in_scope.id, blank_database_slice.id, "planned")

    blank_database_response =
      mcp_tool(
        repo,
        session,
        "dispatch_work_package",
        %{
          "work_request_id" => in_scope.id,
          "work_package_id" => approved_blank_database_slice.id,
          "claimed_by" => "worker-dispatch-1"
        },
        config: Config.default(repo: repo, repo_root: test_repo_root(), database: "   ")
      )

    blank_database_payload = get_in(blank_database_response, ["result", "structuredContent"])
    assert blank_database_payload["work_package"]["status"] == "ready_for_worker"
    refute Map.has_key?(blank_database_payload, "worker_handoff")
    assert blank_database_payload["worker_bootstrap"]["assignment"]["work_package"]["id"] == approved_blank_database_slice.id
    refute inspect(blank_database_response) =~ "run_mcp_command"

    delivery_base = "feature/integration-base"

    assert {:ok, delivery_base_slice} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               in_scope.id,
               work_request_work_package_attrs(
                 id: "WRS-MCP-WR-DISPATCH-DELIVERY-BASE",
                 base_branch: delivery_base
               )
             )

    assert {:ok, approved_delivery_base_slice} =
             CanonicalWorkPackageFixtures.approve_work_package(repo, in_scope.id, delivery_base_slice.id, "planned")

    delivery_base_response =
      mcp_tool(repo, session, "dispatch_work_package", %{
        "work_request_id" => in_scope.id,
        "work_package_id" => approved_delivery_base_slice.id,
        "claimed_by" => "worker-dispatch-delivery-base"
      })

    assert get_in(delivery_base_response, ["error", "code"]) == -32_602

    assert get_in(delivery_base_response, ["error", "data", "reason"]) ==
             "work_package_delivery_scope_out_of_scope"

    persisted_delivery_base = repo.get!(WorkPackage, approved_delivery_base_slice.id)
    assert persisted_delivery_base.status == "planned"
    assert persisted_delivery_base.dispatched_at == nil
  end
end
