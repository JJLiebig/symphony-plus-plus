defmodule SymphonyElixir.SymphonyPlusPlus.GitHub.ChecksBackstop do
  @moduledoc false

  use GenServer

  alias SymphonyElixir.SymphonyPlusPlus.DashboardPubSub
  alias SymphonyElixir.SymphonyPlusPlus.GitHub.{DefaultClient, PullRequest, PullRequestProgress}
  alias SymphonyElixir.SymphonyPlusPlus.OfflineSandbox
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Repository, as: PlanningRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository

  @interval_ms 60_000

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts)

  @impl true
  def init(opts) do
    Process.send_after(self(), :poll, @interval_ms)
    {:ok, %{repo: Keyword.fetch!(opts, :repo), cache: %{}, opts: Keyword.drop(opts, [:repo])}}
  end

  @impl true
  def handle_info(:poll, state) do
    cache = poll(state.repo, state.cache, state.opts)
    Process.send_after(self(), :poll, @interval_ms)
    {:noreply, %{state | cache: cache}}
  end

  @spec poll(module(), map(), keyword()) :: map()
  def poll(repo, cache, opts \\ []) do
    client = Keyword.get(opts, :client, DefaultClient)

    with :ok <- OfflineSandbox.require_online(),
         :ok <- client.auth_status(Keyword.put(opts, :local_auth_only?, true)),
         {:ok, packages} <- WorkPackageRepository.list(repo) do
      Enum.reduce(packages, %{}, fn package, next_cache ->
        with {:ok, observation} <- pending_observation(repo, package.id) do
          key = {observation.ref.repository, observation.ref.number, observation.payload["head_sha"]}
          previous = Map.get(next_cache, key, Map.get(cache, key, %{}))
          {summary, fetched} = fetch_checks(client, observation, previous, opts)
          if summary, do: record_checks(repo, package.id, observation, summary)
          Map.put(next_cache, key, fetched)
        else
          _not_pending -> next_cache
        end
      end)
    else
      _unavailable -> %{}
    end
  end

  defp pending_observation(repo, package_id) do
    with {:ok, events} <- PlanningRepository.list_progress_events(repo, package_id),
         {:ok, %{payload: payload} = observation} <- PullRequestProgress.current_pr_state(events, ["attach_pr", "sync_pr"]),
         %{"status" => "pending"} <- payload["check_summary"],
         head when is_binary(head) and head != "" <- payload["head_sha"],
         false <- PullRequest.stale?(payload, PullRequestProgress.expected_head_sha(events, observation.ref)) do
      {:ok, observation}
    else
      _not_pending -> :ignore
    end
  end

  defp fetch_checks(client, observation, cache, opts) do
    prefix = "repos/#{observation.ref.repository}/commits/#{URI.encode_www_form(observation.payload["head_sha"])}"

    with {:ok, runs, cache} <- fetch_pages(client, prefix <> "/check-runs", "check_runs", cache, opts),
         {:ok, statuses, cache} <- fetch_pages(client, prefix <> "/status", "statuses", cache, opts) do
      checks = runs ++ statuses
      values = Enum.map(checks, &check_status/1)

      status =
        cond do
          "failing" in values -> "failing"
          "pending" in values -> "pending"
          values != [] and Enum.all?(values, &(&1 == "passing")) -> "passing"
          true -> nil
        end

      {if(status, do: %{"status" => status}), cache}
    else
      _unavailable -> {nil, cache}
    end
  end

  defp fetch_pages(client, path, field, cache, opts, page \\ 1, rows \\ []) do
    path_with_page = path <> "?per_page=100&page=#{page}"
    previous = Map.get(cache, path_with_page, %{})

    response =
      case client.conditional_json(path_with_page, Map.get(previous, :etag), opts) do
        :not_modified ->
          case previous do
            %{body: body} -> {:ok, body, Map.get(previous, :etag)}
            _missing -> {:error, :missing_cached_response}
          end

        result ->
          result
      end

    with {:ok, body, etag} <- response,
         batch when is_list(batch) <- Map.get(body, field) do
      cache = Map.put(cache, path_with_page, %{body: body, etag: etag})

      if length(batch) == 100,
        do: fetch_pages(client, path, field, cache, opts, page + 1, rows ++ batch),
        else: {:ok, rows ++ batch, cache}
    else
      _invalid -> {:error, :checks_unavailable}
    end
  end

  defp check_status(check) when is_map(check) do
    conclusion = check["conclusion"] || check["state"]

    cond do
      conclusion in ~w(success neutral skipped) -> "passing"
      conclusion in ~w(failure error cancelled timed_out startup_failure action_required stale) -> "failing"
      conclusion == "pending" or check["status"] in ~w(queued in_progress pending requested waiting) -> "pending"
      true -> "unknown"
    end
  end

  defp check_status(_unusable), do: "unknown"

  defp record_checks(repo, package_id, observation, summary) do
    result =
      repo.transaction(fn ->
        # A worker may report a new head or completed checks during the HTTP calls.
        case pending_observation(repo, package_id) do
          {:ok, ^observation} -> append_checks(repo, package_id, observation, summary)
          _changed -> :unchanged
        end
      end)

    case result do
      {:ok, :changed} -> DashboardPubSub.broadcast_changed()
      _unchanged -> :ok
    end
  end

  defp append_checks(repo, package_id, observation, summary) do
    if observation.payload["check_summary"] == summary do
      :unchanged
    else
      payload = observation.payload |> Map.put("source_tool", "sync_pr") |> Map.put("check_summary", summary)

      case PlanningRepository.append_progress_event(repo, %{
             "work_package_id" => package_id,
             "summary" => "GitHub checks updated",
             "status" => "pr_synced",
             "idempotency_key" => "ci_backstop:#{package_id}:#{observation.sequence}",
             "payload" => payload
           }) do
        {:ok, _event} -> :changed
        {:error, reason} -> repo.rollback(reason)
      end
    end
  end
end
