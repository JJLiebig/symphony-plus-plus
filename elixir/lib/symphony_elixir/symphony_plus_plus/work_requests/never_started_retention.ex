defmodule SymphonyElixir.SymphonyPlusPlus.WorkRequests.NeverStartedRetention do
  @moduledoc false

  import Ecto.Query, only: [from: 2, exclude: 2]

  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.{ArchitectHandoff, Repository, WorkRequest}

  # Legacy dispatches may predate dispatched_at; these states already imply execution.
  @execution_statuses ["ready_for_worker", "active", "claimed", "implementing", "reviewing", "ci_waiting", "ready_for_merge", "merged"]

  @spec archive(Repository.repo(), DateTime.t(), pos_integer()) :: {:ok, [String.t()]} | {:error, Repository.error()}
  def archive(repo, now, days) do
    cutoff = DateTime.add(now, -days * 24 * 60 * 60, :second)

    repo.transaction(fn ->
      query = candidates(cutoff)
      requests = repo.all(query)
      ids = never_started_ids(repo, requests)

      if ids != [] do
        repo.update_all(from(request in exclude(query, :order_by), where: request.id in ^ids),
          set: [archived_at: now, archive_reason: "never_started", updated_at: now]
        )
      end

      ids
    end)
  rescue
    error in Exqlite.Error ->
      message = Exception.message(error)
      normalized = String.downcase(message)

      if String.contains?(normalized, "locked") or String.contains?(normalized, "busy"),
        do: {:error, :database_busy},
        else: {:error, {:storage_failed, message}}
  end

  defp candidates(cutoff) do
    from(request in WorkRequest,
      where: is_nil(request.archived_at) and is_nil(request.completed_at),
      where: fragment("COALESCE(?, ?)", request.never_started_restored_at, request.inserted_at) <= type(^cutoff, :utc_datetime_usec),
      where: fragment("NOT EXISTS (SELECT 1 FROM sympp_work_package_deliveries WHERE work_request_id = ?)", request.id),
      order_by: [asc: request.inserted_at, asc: request.id]
    )
  end

  defp never_started_ids(_repo, []), do: []

  defp never_started_ids(repo, requests) do
    ids = Enum.map(requests, & &1.id)
    anchors = Map.new(requests, &{ArchitectHandoff.anchor_id_for_work_request(&1), &1.id})
    anchor_ids = Map.keys(anchors)

    started_ids =
      repo.all(
        from(package in WorkPackage,
          where: package.work_request_id in ^ids or package.id in ^anchor_ids,
          where:
            not is_nil(package.dispatched_at) or package.status in ^@execution_statuses or
              fragment("EXISTS (SELECT 1 FROM sympp_agent_runs WHERE work_package_id = ?)", package.id) or
              fragment("EXISTS (SELECT 1 FROM sympp_claim_leases WHERE work_package_id = ?)", package.id) or
              fragment("EXISTS (SELECT 1 FROM sympp_access_grants WHERE work_package_id = ? AND claimed_at IS NOT NULL)", package.id),
          select: {package.work_request_id, package.id}
        )
      )
      |> MapSet.new(fn {request_id, package_id} -> request_id || Map.fetch!(anchors, package_id) end)

    Enum.reject(ids, &MapSet.member?(started_ids, &1))
  end
end
