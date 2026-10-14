Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.WorkerTools04Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  defmodule RecordingProvider do
    @behaviour SymphonyElixir.SymphonyPlusPlus.GitHub.Client

    @impl true
    def fetch_pull_request(ref, opts) do
      send(self(), {:provider_fetch, ref.repository, ref.number})
      SymphonyElixir.FakeGitHubClient.fetch_pull_request(ref, opts)
    end
  end

  setup do
    original_client = Application.get_env(:symphony_elixir, :sympp_github_client)
    Application.put_env(:symphony_elixir, :sympp_github_client, RecordingProvider)
    SymphonyElixir.FakeGitHubClient.clear()

    on_exit(fn ->
      SymphonyElixir.FakeGitHubClient.clear()

      case original_client do
        nil -> Application.delete_env(:symphony_elixir, :sympp_github_client)
        client -> Application.put_env(:symphony_elixir, :sympp_github_client, client)
      end
    end)

    :ok
  end

  test "attach_pr idempotency replay accepts stored URL-only and full payloads", %{repo: repo} do
    assert {:ok, package} =
             WorkPackageRepository.create(
               repo,
               WorkPackageFactory.attrs(id: "SYMPP-PR-LEGACY-REPLAY", kind: "mcp", repo: "example-org/widget-service", status: "ci_waiting")
             )

    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)
    idempotency_key = "attach_pr:#{package.id}:legacy-pr-key"

    assert {:ok, legacy_event} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: package.id,
               summary: "pr_attached",
               status: "pr_attached",
               idempotency_key: idempotency_key,
               payload: %{
                 type: "pr",
                 source_tool: "attach_pr",
                 url: "https://github.com/example-org/widget-service/pull/42",
                 head_sha: "legacy-head"
               }
             })

    response =
      attach_tool(repo, session, "attach_pr", %{
        "number" => 42,
        "head_sha" => "legacy-head",
        "idempotency_key" => "legacy-pr-key"
      })

    assert get_in(response, ["result", "structuredContent", "progress_event", "id"]) == legacy_event.id

    assert {:ok, events} = PlanningRepository.list_progress_events(repo, package.id)
    assert Enum.count(events, &(&1.idempotency_key == idempotency_key)) == 1

    full_arguments = %{
      "number" => 42,
      "head_sha" => "legacy-head",
      "idempotency_key" => "full-pr-key",
      "metadata" => %{"head_sha" => "legacy-head", "created_at" => "2026-10-01T09:00:00Z", "updated_at" => "2026-10-01T10:00:00Z"}
    }

    full_response = attach_tool(repo, session, "attach_pr", full_arguments)
    full_id = get_in(full_response, ["result", "structuredContent", "progress_event", "id"])
    full_event = repo.get!(ProgressEvent, full_id)

    # A persisted full attachment from before provider dates and observation stamps were added.
    full_event
    |> Ecto.Changeset.change(payload: Map.drop(full_event.payload, ~w(created_at updated_at head_changed_at checks_changed_at)))
    |> repo.update!()

    replay = attach_tool(repo, session, "attach_pr", full_arguments)
    assert get_in(replay, ["result", "structuredContent", "progress_event", "id"]) == full_id

    changed_arguments = put_in(full_arguments, ["metadata", "check_summary"], %{"status" => "failing"})

    conflict =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "conflict", "method" => "tools/call", "params" => %{"name" => "attach_pr", "arguments" => changed_arguments}},
        repo: repo,
        session: session
      )

    assert get_in(conflict, ["error", "data", "reason"]) == "idempotency_conflict"
  end

  defp sync_package(repo, id, number, head_sha, overrides \\ []) do
    attrs =
      [id: id, kind: "mcp", repo: "nextide/repo", status: "ci_waiting"]
      |> Keyword.merge(overrides)

    assert {:ok, package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(attrs))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "provider-owner")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    attach_tool(repo, session, "attach_branch", %{"branch" => "agent/#{id}/worker", "head_sha" => head_sha})
    attach_tool(repo, session, "attach_pr", %{"number" => number, "head_sha" => head_sha})
    {package, session}
  end

  defp provider_metadata(number, head_sha) do
    SymphonyElixir.GitHubPullRequestFixtures.metadata(number, head_sha)
    |> Map.put("check_summary", %{"status" => "passing"})
    |> Map.put("review_state", %{"status" => "approved"})
  end
end
