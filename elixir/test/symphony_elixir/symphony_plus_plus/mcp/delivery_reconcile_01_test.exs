Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.DeliveryReconcile01Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  alias SymphonyElixir.FakeGitHubClient
  alias SymphonyElixir.GitHubPullRequestFixtures
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackageDelivery

  test "unbound reads redact historical credential-bearing request and delivery scope", %{repo: repo} do
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
  end

  test "architect handoff redacts secrets and refuses retained worker authority", %{repo: repo} do
    repo_path = TestSupport.git_repo_with_origin_fixture!("https://github.com/nextide/repo.git", prefix: "sympp-architect-handoff")

    {anchor, session, _grant} =
      create_phase_architect_session(
        repo,
        "SYMPP-ARCHITECT-WR-SLICE-DISPATCH",
        [
          "dispatch:work_request",
          "write:work_request",
          "read:work_request"
        ],
        repo: repo_path
      )

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
    Application.put_env(:symphony_elixir, :sympp_github_client, FakeGitHubClient)

    try do
      head = String.duplicate("a", 40)
      metadata = GitHubPullRequestFixtures.metadata(412, head, base_branch: anchor.base_branch)
      FakeGitHubClient.put_response("nextide/repo", 412, metadata)
      handoff = %{"work_package_id" => approved_slice.id, "url" => "https://github.com/nextide/repo/pull/412", "head_sha" => head}

      assert {:ok, other_owner} =
               ClaimLeaseService.claim(repo, approved_slice.id, %{"actor_kind" => "agent", "actor_id" => "another-worker"},
                 now: DateTime.add(DateTime.utc_now(:microsecond), -1, :hour),
                 stale_after_ms: 1
               )

      for ownership <- [:stale, :paused] do
        if ownership == :paused do
          assert {:ok, _paused} =
                   ClaimLeaseService.pause(repo, other_owner.id, %{"actor_id" => "operator"},
                     reason: "Owner paused",
                     now: other_owner.last_seen_at
                   )
        end

        refused = mcp_tool(repo, session, "sync_pr", handoff)
        assert refused["error"]
        assert repo.get!(WorkPackage, approved_slice.id).status == "ready_for_worker"
        assert {:ok, unchanged} = PlanningRepository.get_state(repo, approved_slice.id)
        refute Enum.any?(unchanged.progress_events, &(&1.payload["source_tool"] == "sync_pr"))
      end

      assert {:ok, _released} = ClaimLeaseService.release(repo, other_owner.id, reason: "Architect confirmed the owner finished")

      assert {:ok, claimed_grant} = AccessGrantService.claim_local_worker_grant(repo, approved_slice.id, claimed_by: "grant-only-worker")
      grant_owned = mcp_tool(repo, session, "sync_pr", handoff)
      assert grant_owned["error"]
      assert repo.get!(WorkPackage, approved_slice.id).status == "ready_for_worker"
      assert {:ok, _revoked} = AccessGrantService.revoke(repo, claimed_grant.id)

      mismatch = mcp_tool(repo, session, "sync_pr", Map.put(handoff, "head_sha", String.duplicate("b", 40)))
      assert get_in(mismatch, ["error", "data", "reason"]) =~ "provider_head_mismatch"
      assert repo.get!(WorkPackage, approved_slice.id).status == "ready_for_worker"

      url_only = Map.delete(handoff, "head_sha")
      accepted = mcp_tool(repo, session, "sync_pr", url_only)
      assert get_in(accepted, ["result", "structuredContent", "work_package", "status"]) == "ready_for_merge"
      assert repo.get!(ClaimLease, other_owner.id).status == "released"

      FakeGitHubClient.put_response(
        "nextide/repo",
        413,
        GitHubPullRequestFixtures.metadata(413, head, base_branch: anchor.base_branch, merged?: true)
      )
      different_pr = mcp_tool(repo, session, "sync_pr", Map.put(url_only, "url", "https://github.com/nextide/repo/pull/413"))
      assert get_in(different_pr, ["error", "data", "reason"]) == "pr_reference_mismatch"
      assert repo.get!(WorkPackage, approved_slice.id).status == "ready_for_merge"

      merged_metadata =
        GitHubPullRequestFixtures.metadata(412, String.duplicate("c", 40), base_branch: anchor.base_branch, merged?: true)

      FakeGitHubClient.put_response("nextide/repo", 412, merged_metadata)
      landed = mcp_tool(repo, session, "sync_pr", %{"work_package_id" => approved_slice.id, "number" => 412, "repository" => "nextide/repo"})
      assert get_in(landed, ["result", "structuredContent", "work_package", "status"]) == "merged"
      assert repo.get_by!(WorkPackageDelivery, work_package_id: approved_slice.id).outcome == "pr_merged"
    after
      restore_app_env(:sympp_github_client, original_client)
      FakeGitHubClient.clear()
    end
  end

  test "dispatch uses configured storage and rejects persisted delivery scope drift", %{repo: repo} do
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

    assert {:ok, _work_package} =
             CanonicalWorkPackageFixtures.add_work_package(
               repo,
               in_scope.id,
               work_request_work_package_attrs(id: "WRS-MCP-WR-DISPATCH-PLANNED", base_branch: anchor.base_branch)
             )

    assert {:ok, _work_request} = CanonicalWorkPackageFixtures.mark_sliced(repo, in_scope.id, "ready_for_slicing")

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
