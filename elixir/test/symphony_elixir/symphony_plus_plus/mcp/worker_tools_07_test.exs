Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.WorkerTools07Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  alias SymphonyElixir.SymphonyPlusPlus.ProductTree
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.DeliveryBoard

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
        |> Map.reject(fn {key, value} -> key == "dependency_id" and is_nil(value) end)
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
end
