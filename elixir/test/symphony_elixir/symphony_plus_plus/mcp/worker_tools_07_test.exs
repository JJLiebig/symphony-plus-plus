Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.WorkerTools07Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  alias SymphonyElixir.SymphonyPlusPlus.ProductTree
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.DeliveryBoard

  test "qualified pins support wiring, successor replacement and explicit affected input requalification", %{repo: repo} do
    request = create_work_request!(repo, id: "WR-CANDIDATE", status: "sliced")

    {_anchor, architect, _grant} =
      create_work_request_handoff_architect_session(repo, request, ArchitectHandoff.capabilities())

    a = candidate_package(repo, request, "BACKEND-A")
    ui = candidate_package(repo, request, "UI")
    unrelated = candidate_package(repo, request, "OTHER")
    head_a = String.duplicate("a", 40)
    head_b = String.duplicate("b", 40)
    head_ui = String.duplicate("c", 40)
    head_other = String.duplicate("d", 40)
    worker_a = candidate_worker(repo, a, head_a, 1001)
    worker_ui = candidate_worker(repo, ui, head_ui, 1002)
    worker_other = candidate_worker(repo, unrelated, head_other, 1003)
    assert candidate_call(repo, worker_a, "mark_ready", %{})["ready"]
    assert candidate_call(repo, worker_other, "mark_ready", %{})["ready"]

    dependency = candidate_pin(repo, architect, request, ui, a, head_a)
    other_dependency = candidate_pin(repo, architect, request, ui, unrelated, head_other)
    assert {:ok, graph} = ProductTree.execution_graph(repo, request.id)
    assert :ok = ProductTree.ExecutionGraph.require_ready(graph, ui.id)
    refute candidate_eligibility(repo, request, ui).eligible
    assert "dependency_not_delivered" in candidate_eligibility(repo, request, ui).reason_codes

    candidate_inputs(
      repo,
      worker_ui,
      head_ui,
      [
        candidate_input(dependency, a, head_a),
        candidate_input(other_dependency, unrelated, head_other)
      ],
      "consumed-a"
    )

    refute "dependency_inputs_stale" in candidate_eligibility(repo, request, ui).reason_codes

    # A ready candidate is immutable. B is a real new assignment, created before A retires.
    denied = candidate_response(repo, worker_a, "attach_branch", %{"branch" => "agent/#{a.id}/worker", "head_sha" => head_b})
    assert get_in(denied, ["error", "data", "reason"]) == "already_ready"
    b = candidate_package(repo, request, "BACKEND-B")
    worker_b = candidate_worker(repo, b, head_b, 1004)
    assert candidate_call(repo, worker_b, "mark_ready", %{})["ready"]

    candidate_call(repo, architect, "record_work_package_delivery", %{
      "work_request_id" => request.id,
      "work_package_id" => a.id,
      "outcome" => "superseded",
      "evidence" => %{"superseded" => %{"successor_work_package_id" => b.id, "superseded_reason" => "Backend contract changed."}},
      "idempotency_key" => "retire-a"
    })

    assert "candidate_pin_stale" in candidate_eligibility(repo, request, ui).reason_codes
    candidate_pin(repo, architect, request, ui, b, head_b, dependency)
    assert "dependency_inputs_stale" in candidate_eligibility(repo, request, ui).reason_codes

    stale =
      candidate_response(repo, worker_ui, "append_progress", %{
        "summary" => "Old inputs",
        "idempotency_key" => "old-inputs",
        "payload" => %{"head_sha" => head_ui, "dependency_inputs" => [candidate_input(dependency, a, head_a)]}
      })

    assert get_in(stale, ["error", "code"]) == -32_602
    candidate_inputs(repo, worker_ui, head_ui, [candidate_input(dependency, b, head_b)], "requalified-b")
    refute "dependency_inputs_stale" in candidate_eligibility(repo, request, ui).reason_codes
    assert candidate_call(repo, worker_ui, "mark_ready", %{})["ready"]

    Enum.each([b, unrelated], fn backend ->
      candidate_call(repo, architect, "record_work_package_delivery", %{
        "work_request_id" => request.id,
        "work_package_id" => backend.id,
        "outcome" => "pr_merged",
        "evidence" => %{
          "pr_merged" => %{
            "pr_url" => "https://github.com/nextide/symphony-plus-plus/pull/#{if(backend.id == b.id, do: 1004, else: 1003)}",
            "pr_merged_at" => DateTime.to_iso8601(DateTime.utc_now()),
            "merge_commit_sha" => "merged-#{backend.id}"
          }
        },
        "idempotency_key" => "delivered-#{backend.id}"
      })
    end)

    assert candidate_eligibility(repo, request, ui).eligible

    candidate_call(repo, architect, "upsert_dependency", %{
      "work_request_id" => request.id,
      "dependency_id" => dependency,
      "dependent" => %{"kind" => "work_package", "id" => ui.id},
      "prerequisite" => %{"kind" => "work_package", "id" => b.id},
      "candidate_head_sha" => head_b,
      "reason" => "Clarified reason; the selected input is unchanged."
    })

    assert candidate_eligibility(repo, request, ui).eligible

    # A delivered prerequisite still cannot satisfy an obsolete pin.
    candidate_pin(repo, architect, request, ui, b, head_a, dependency)
    refute candidate_eligibility(repo, request, ui).eligible
    assert "candidate_pin_stale" in candidate_eligibility(repo, request, ui).reason_codes
    candidate_pin(repo, architect, request, ui, b, head_b, dependency)
    refute candidate_eligibility(repo, request, ui).eligible
    assert "dependency_inputs_stale" in candidate_eligibility(repo, request, ui).reason_codes
  end

  defp candidate_package(repo, request, id) do
    assert {:ok, package} =
             CanonicalWorkPackageFixtures.add_work_package(repo, request.id, work_request_work_package_attrs(id: id, kind: "docs", status: "reviewing", branch_pattern: "agent/#{id}/worker"))

    package
  end

  defp candidate_worker(repo, package, head, number) do
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: package.id)
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)
    attach_tool(repo, session, "attach_branch", %{"branch" => "agent/#{package.id}/worker", "head_sha" => head})
    url = "https://github.com/nextide/symphony-plus-plus/pull/#{number}"
    attach_tool(repo, session, "attach_pr", %{"url" => url, "head_sha" => head})
    sync_pr_state(repo, session, url, head)
    session
  end

  defp candidate_pin(repo, architect, request, ui, backend, head, dependency_id \\ nil) do
    result =
      candidate_call(
        repo,
        architect,
        "upsert_dependency",
        %{
          "work_request_id" => request.id,
          "dependency_id" => dependency_id,
          "dependent" => %{"kind" => "work_package", "id" => ui.id},
          "prerequisite" => %{"kind" => "work_package", "id" => backend.id},
          "candidate_head_sha" => head,
          "reason" => "Caller qualified the current native backend checks and review."
        }
        |> Map.reject(fn {_key, value} -> is_nil(value) end)
      )

    assert result["dependency"]["candidate_head_sha"] == head
    result["dependency"]["id"]
  end

  defp candidate_input(dependency_id, backend, head),
    do: %{
      "dependency_id" => dependency_id,
      "prerequisite_work_package_id" => backend.id,
      "candidate_head_sha" => head
    }

  defp candidate_inputs(repo, worker, head, selections, key) do
    candidate_call(repo, worker, "append_progress", %{"summary" => "Qualified affected wiring inputs", "idempotency_key" => key, "payload" => %{"head_sha" => head, "dependency_inputs" => selections}})
  end

  defp candidate_eligibility(repo, request, package) do
    assert {:ok, board} = DeliveryBoard.project(repo, request.id)
    Enum.find(board.work_packages, &(&1.id == package.id)).merge_eligibility
  end

  defp candidate_response(repo, session, name, args),
    do:
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => name, "method" => "tools/call", "params" => %{"name" => name, "arguments" => args}},
        repo: repo,
        session: session
      )

  defp candidate_call(repo, session, name, args) do
    response = candidate_response(repo, session, name, args)
    refute response["error"], inspect(response)
    get_in(response, ["result", "structuredContent"])
  end

  test "docs mark_ready does not require manufactured delivery evidence", %{repo: repo} do
    assert {:ok, package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-READY-DOCS", kind: "docs", status: "reviewing"))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "docs-worker")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    ready_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "ready-docs", "method" => "tools/call", "params" => %{"name" => "mark_ready"}},
        repo: repo,
        session: session
      )

    assert get_in(ready_response, ["result", "structuredContent", "ready"]) == true
    assert get_in(ready_response, ["result", "structuredContent", "work_package", "kind"]) == "docs"
    assert get_in(ready_response, ["result", "structuredContent", "work_package", "status"]) == "ready_for_merge"
  end

  test "hotfix mark_ready uses provider-backed delivery evidence", %{repo: repo} do
    assert {:ok, package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-READY-HOTFIX", kind: "hotfix", status: "ci_waiting"))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    attach_tool(repo, session, "attach_branch", %{"branch" => "agent/SYMPP-READY-HOTFIX/worker", "head_sha" => "hotfix-head"})
    attach_tool(repo, session, "attach_pr", %{"url" => "https://github.com/example/repo/pull/812", "head_sha" => "hotfix-head"})
    sync_pr_state(repo, session, "https://github.com/example/repo/pull/812", "hotfix-head")

    ready_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "ready-hotfix", "method" => "tools/call", "params" => %{"name" => "mark_ready"}},
        repo: repo,
        session: session
      )

    assert get_in(ready_response, ["result", "structuredContent", "ready"]) == true
    assert get_in(ready_response, ["result", "structuredContent", "work_package", "status"]) == "ready_for_merge"
  end

  test "investigation accepts headless evidence and findings without manufacturing a recommendation artifact", %{repo: repo} do
    assert {:ok, package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-INVESTIGATION-READY", kind: "investigation", status: "ci_waiting"))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    blocked_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "ready-without-findings", "method" => "tools/call", "params" => %{"name" => "mark_ready"}},
        repo: repo,
        session: session
      )

    assert blocked_response["error"] == %{
             "code" => -32_602,
             "message" => "Investigation findings are missing.",
             "data" => %{
               "tool" => "mark_ready",
               "reason" => "readiness_failed",
               "missing" => ["findings_documented"],
               "reasons" => [
                 %{"gate" => "findings_documented", "code" => "findings_documented", "message" => "Investigation findings are missing."}
               ]
             }
           }

    finding_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "finding",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_finding",
            "arguments" => %{"title" => "Recommendation", "body" => "No code change needed.", "idempotency_key" => "investigation-finding"}
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(finding_response, ["result", "structuredContent", "finding", "title"]) == "Recommendation"

    ready_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "ready", "method" => "tools/call", "params" => %{"name" => "mark_ready"}},
        repo: repo,
        session: session
      )

    assert get_in(ready_response, ["result", "structuredContent", "ready"]) == true
  end

  test "mark_ready rejects spoofed provider metadata", %{repo: repo} do
    assert {:ok, package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-READY-SPOOF", kind: "mcp", status: "ci_waiting"))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    Enum.each(["branch", "pr"], fn type ->
      response =
        MCPHarness.request(
          %{
            "jsonrpc" => "2.0",
            "id" => "spoof-#{type}",
            "method" => "tools/call",
            "params" => %{
              "name" => "append_progress",
              "arguments" => %{
                "summary" => "Spoof #{type}",
                "idempotency_key" => "spoof-#{type}",
                "payload" => %{"type" => type, "source_tool" => "attach_#{type}"}
              }
            }
          },
          repo: repo,
          session: session
        )

      assert get_in(response, ["result", "structuredContent", "progress_event", "id"])
    end)

    ready_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "ready", "method" => "tools/call", "params" => %{"name" => "mark_ready"}},
        repo: repo,
        session: session
      )

    assert get_in(ready_response, ["error", "data", "reason"]) == "readiness_failed"
    assert get_in(ready_response, ["error", "message"]) == "Current branch metadata is missing. Current PR metadata is missing."

    assert get_in(ready_response, ["error", "data", "missing"]) == [
             "branch_attached",
             "pr_attached"
           ]
  end

  test "append_progress rejects non-map payloads", %{repo: repo} do
    assert {:ok, package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-PAYLOAD", kind: "mcp"))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    invalid_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "bad-payload",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_progress",
            "arguments" => %{"summary" => "Bad", "idempotency_key" => "bad-payload", "payload" => false}
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(invalid_response, ["error", "code"]) == -32_602
    assert get_in(invalid_response, ["error", "data", "reason"]) == "invalid_payload"
  end

  test "mark_ready uses lifecycle capability checks", %{repo: repo} do
    assert {:ok, package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-READY-CAP", kind: "mcp", status: "ci_waiting"))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id, capabilities: ["worker:claim"])
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    attach_tool(repo, session, "attach_branch", %{"branch" => "agent/SYMPP-READY-CAP/worker", "head_sha" => "abc124"})
    attach_tool(repo, session, "attach_pr", %{"url" => "https://github.com/example/repo/pull/124", "head_sha" => "abc124"})
    sync_pr_state(repo, session, "https://github.com/example/repo/pull/124", "abc124")

    response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "ready", "method" => "tools/call", "params" => %{"name" => "mark_ready"}},
        repo: repo,
        session: session
      )

    assert get_in(response, ["error", "data", "reason"]) == "missing_lifecycle_capability"
  end

  test "worker surface omits general lifecycle mutation, grant minting, and package listing", %{repo: repo} do
    assert {:ok, package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-DENIALS", kind: "adapter", status: "ready_for_merge"))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    tools_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "worker-tools",
          "method" => "tools/list",
          "params" => %{}
        },
        repo: repo,
        session: session
      )

    refute Enum.any?(get_in(tools_response, ["result", "tools"]), &(&1["name"] == "set_status"))

    Enum.each(["mint_worker_grant", "list_work_packages"], fn tool ->
      response =
        MCPHarness.request(
          %{"jsonrpc" => "2.0", "id" => tool, "method" => "tools/call", "params" => %{"name" => tool, "arguments" => %{}}},
          repo: repo,
          session: session
        )

      assert get_in(response, ["error", "code"]) == -32_601
    end)
  end
end
