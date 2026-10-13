defmodule SymphonyElixir.SymphonyPlusPlus.GitHubPullRequestTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.SymphonyPlusPlus.GitHub.{Client, DryClient, PullRequest, PullRequestProgress}
  alias SymphonyElixir.SymphonyPlusPlus.Planning.ProgressEvent

  test "historical head abbreviations and check aliases preserve observation instants" do
    payload = %{"repository" => "example-org/widget-service", "number" => 42, "head_sha" => "head-a", "check_summary" => %{"status" => "pending"}}
    first_at = ~U[2026-10-01 09:00:00Z]
    later_at = DateTime.add(first_at, 60, :second)
    spelling = %{payload | "repository" => "Example-Org/Widget-Service", "head_sha" => "abcdef0", "check_summary" => %{"conclusion" => "success"}}
    observed = PullRequestProgress.stamp_observation(spelling, nil, first_at)
    canonical = %{payload | "head_sha" => "abcdef0123456789abcdef0123456789abcdef0123", "check_summary" => %{"status" => "passing"}}
    same_result = PullRequestProgress.stamp_observation(canonical, observed, later_at)
    assert same_result["head_changed_at"] == observed["head_changed_at"]
    assert same_result["checks_changed_at"] == observed["checks_changed_at"]
  end

  test "orders provider head evidence by the DateTime instant across second boundaries" do
    earlier = %ProgressEvent{
      id: "earlier",
      sequence: 1,
      created_at: ~U[2026-08-17 11:44:17.975000Z],
      payload: %{"type" => "branch", "source_tool" => "attach_branch", "head_sha" => "head-a"}
    }

    later = %ProgressEvent{
      id: "later",
      sequence: 2,
      created_at: ~U[2026-08-17 11:44:18.427000Z],
      payload: %{"type" => "branch", "source_tool" => "attach_branch", "head_sha" => "head-b"}
    }

    assert PullRequestProgress.chronological_events([later, earlier]) == [earlier, later]
    assert PullRequestProgress.expected_head_sha([later, earlier], %{}) == "head-b"

    subsecond_earlier = %{earlier | id: "subsecond-earlier", sequence: 4, created_at: ~U[2026-08-17 11:44:17.427000Z]}
    subsecond_later = %{later | id: "subsecond-later", sequence: 3, created_at: ~U[2026-08-17 11:44:17.975000Z]}

    assert PullRequestProgress.chronological_events([subsecond_later, subsecond_earlier]) ==
             [subsecond_earlier, subsecond_later]
  end

  test "maps dry metadata into a redaction-friendly PR payload" do
    assert {:ok, ref} = PullRequest.parse(%{"url" => "https://github.com/nextide/symphony-plus-plus/pull/42"}, nil)

    metadata = %{
      "head_sha" => "abc123",
      "branch" => "agent/SYMPP-P6-001/github-pr-attachment-sync",
      "base_branch" => "symphony-plus-plus/beta",
      "changed_files" => [%{"filename" => "elixir/lib/example.ex", "status" => "modified"}],
      "check_summary" => %{"state" => "success", "token" => "ghp_should_not_surface"},
      "review_state" => %{"state" => "approved", "authorization" => "Bearer secret"},
      "merge_state" => %{"state" => "clean", "client_secret" => "secret"}
    }

    assert {:ok, fetched} = Client.fetch_pull_request(DryClient, ref, metadata: metadata)
    assert {:ok, payload} = PullRequest.metadata(fetched, ref, nil)

    assert payload["repository"] == "nextide/symphony-plus-plus"
    assert payload["number"] == 42
    assert payload["head_sha"] == "abc123"
    assert payload["base_branch"] == "symphony-plus-plus/beta"
    assert payload["changed_files"] == [%{"path" => "elixir/lib/example.ex", "status" => "modified"}]
    assert payload["changed_files_count"] == 1
    assert payload["changed_files_available"] == true
    assert payload["changed_files_count_available"] == true
    assert payload["check_summary"] == %{"state" => "success", "token" => "[REDACTED]"}
    assert payload["review_state"] == %{"state" => "approved", "authorization" => "[REDACTED]"}
    assert payload["merge_state"] == %{"state" => "clean", "client_secret" => "[REDACTED]"}
    refute Map.has_key?(payload, "authorization")
  end
end
