defmodule SymphonyElixir.SymphonyPlusPlus.ProductTree.DependencyInputs do
  @moduledoc false

  import Ecto.Query, only: [from: 2]

  alias SymphonyElixir.SymphonyPlusPlus.Dashboard.MetadataProjection
  alias SymphonyElixir.SymphonyPlusPlus.GitHub.PullRequestProgress
  alias SymphonyElixir.SymphonyPlusPlus.OperationalLineage
  alias SymphonyElixir.SymphonyPlusPlus.Planning.ProgressEvent
  alias SymphonyElixir.SymphonyPlusPlus.ProductTree.ExecutionGraph
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.DeliveryResolution

  @spec context(module(), [map()], boolean()) :: {:ok, map()} | {:error, term()}
  def context(repo, work_packages, candidates?) do
    retired =
      work_packages
      |> Enum.filter(&((value(&1, :status) || value(&1, :raw_status)) in ["skipped", "merged", "closed", "abandoned"]))
      |> Enum.map(&%{id: value(&1, :id), work_request_id: value(&1, :work_request_id)})

    result = if retired == [], do: {:ok, %{}}, else: OperationalLineage.delivery_successors(repo, retired)

    with {:ok, successors} <- result do
      events =
        if(candidates?, do: work_packages, else: [])
        |> Enum.map(&value(&1, :id))
        |> Enum.chunk_every(400)
        |> Enum.flat_map(fn ids ->
          repo.all(from(event in ProgressEvent, where: event.work_package_id in ^ids, order_by: [asc: event.sequence]))
        end)
        |> Enum.group_by(& &1.work_package_id)

      {:ok, %{successors: successors, events: events}}
    end
  end

  @spec evaluate([map()], map(), map(), map()) :: [map()]
  def evaluate(edges, packages, deliveries, context) do
    successors = Map.get(context, :successors, %{})
    events = Map.get(context, :events, %{})
    metadata = Map.new(events, fn {id, events} -> {id, candidate_metadata(events)} end)

    Enum.map(edges, fn edge ->
      prerequisite = edge.prerequisite_work_package_id
      dependent = edge.dependent_work_package_id
      delivered = DeliveryResolution.resolved?(prerequisite, packages, deliveries, successors)
      head = metadata |> Map.get(prerequisite, %{}) |> value(:pr) |> value(:head_sha)
      dependent_head = current_head(Map.get(metadata, dependent, %{}))
      consumed = consumed_inputs(Map.get(events, dependent, []), dependent_head)
      delivery = Map.get(deliveries, dependent)
      delivered_before = delivered_before?(prerequisite, delivery, packages, deliveries, successors)

      constraints =
        Enum.map(edge.constraints, fn constraint ->
          pin = constraint.candidate_head_sha
          state = candidate_state(pin, Map.get(packages, prerequisite), Map.get(metadata, prerequisite, %{}), Map.get(deliveries, prerequisite))
          selection = Map.get(consumed, {constraint.dependency_id, prerequisite})

          selected = selection_matches?(selection, prerequisite, pin)
          selected_at = selected_after_update?(selection, constraint.selection_updated_at)
          input_current = (is_nil(constraint.selection_updated_at) and is_nil(pin)) or (selected and selected_at)

          Map.merge(constraint, %{
            current_head_sha: head,
            candidate_state: state,
            available: if(is_nil(pin), do: delivered, else: state == "current"),
            delivered: delivered,
            input_current: input_current,
            delivered_before: delivered_before
          })
        end)

      Map.put(edge, :constraints, constraints)
    end)
  end

  @spec merge_eligibility([String.t()], [map()], [map()], list()) :: [map()]
  def merge_eligibility(ids, edges, resolutions, cycles) do
    incoming = Enum.group_by(edges, & &1.dependent_work_package_id)
    states = Map.new(resolutions, &{&1.work_package_id, &1})

    Enum.map(ids, fn id ->
      constraints = incoming |> Map.get(id, []) |> Enum.flat_map(& &1.constraints)
      state = Map.fetch!(states, id)

      reasons =
        []
        |> reason(cycles != [], "dependency_cycle")
        |> reason(Enum.any?(constraints, &(not &1.delivered)), "dependency_not_delivered")
        |> reason(Enum.any?(constraints, &(&1.candidate_state not in [nil, "current"])), "candidate_pin_stale")
        |> reason(Enum.any?(constraints, &(not &1.input_current)), "dependency_inputs_stale")
        |> reason(Enum.any?(constraints, &(not &1.delivered_before)), "delivery_order_violation")

      ready = state.status == "ready_for_merge"

      %{
        work_package_id: id,
        eligible: ready and reasons == [],
        reason_codes: if(ready or state.delivery_outcome == "pr_merged", do: reasons, else: ["not_ready" | reasons]),
        next_action: next_action(reasons, ready)
      }
    end)
  end

  @spec validate_progress(module(), String.t(), map()) :: :ok | {:tool_error, String.t()} | {:error, term()}
  def validate_progress(repo, work_package_id, attrs) do
    payload = value(attrs, :payload) || %{}

    if Map.has_key?(payload, "dependency_inputs") do
      validate_selection(repo, work_package_id, payload)
    else
      :ok
    end
  end

  defp validate_selection(repo, id, payload) do
    with {:ok, package} <- WorkPackageRepository.get(repo, id),
         work_request_id when is_binary(work_request_id) <- package.work_request_id,
         {:ok, graph} <- ExecutionGraph.evaluate(repo, work_request_id),
         {:ok, context} <- context(repo, [package], true) do
      metadata = candidate_metadata(Map.get(context.events, id, []))
      head = current_head(metadata)
      selections = value(payload, :dependency_inputs)
      edges = Enum.filter(graph.effective_edges, &(&1.dependent_work_package_id == id))

      if is_binary(head) and value(payload, :head_sha) == head and is_list(selections) and selections != [] and
           Enum.all?(selections, &valid_selection?(&1, edges)) do
        :ok
      else
        {:tool_error, "dependency_inputs must select current available dependency selections and the current dependent head_sha"}
      end
    else
      nil -> {:tool_error, "dependency_inputs requires a WorkRequest dependency"}
      error -> error
    end
  end

  defp valid_selection?(selection, edges) when is_map(selection) do
    Enum.any?(edges, fn edge ->
      Enum.any?(edge.constraints, fn constraint ->
        not is_nil(constraint.selection_updated_at) and constraint.available and
          value(selection, :dependency_id) == constraint.dependency_id and
          selection_matches?(selection, edge.prerequisite_work_package_id, constraint.candidate_head_sha)
      end)
    end)
  end

  defp valid_selection?(_selection, _edges), do: false

  defp consumed_inputs(events, head) do
    events |> Enum.flat_map(&consumed_event_inputs(&1, head)) |> Map.new()
  end

  defp consumed_event_inputs(event, head) do
    payload = value(event, :payload) || %{}
    selections = value(payload, :dependency_inputs)

    if is_binary(head) and value(payload, :head_sha) == head and is_list(selections) do
      selections
      |> Enum.filter(&is_map/1)
      |> Enum.map(&{{value(&1, :dependency_id), value(&1, :prerequisite_work_package_id)}, Map.put(&1, :consumed_at, value(event, :created_at))})
    else
      []
    end
  end

  defp selection_matches?(selection, prerequisite, pin) do
    value(selection, :prerequisite_work_package_id) == prerequisite and value(selection, :candidate_head_sha) == pin
  end

  defp selected_after_update?(selection, updated_at) do
    consumed_at = timestamp(value(selection, :consumed_at))
    changed_at = timestamp(updated_at)
    is_integer(consumed_at) and is_integer(changed_at) and consumed_at >= changed_at
  end

  defp candidate_state(nil, _package, _metadata, _delivery), do: nil

  defp candidate_state(pin, package, metadata, delivery) do
    cond do
      current_head(metadata) != pin -> "stale_head"
      value(package, :status) == "ready_for_merge" or value(delivery, :outcome) == "pr_merged" -> "current"
      true -> "not_ready"
    end
  end

  defp candidate_metadata(events) do
    pr =
      with {:ok, attached} <- PullRequestProgress.current_pr_state(events),
           {:ok, current} <-
             events
             |> Enum.filter(&PullRequestProgress.same_pr?(value(&1, :payload), attached.ref))
             |> PullRequestProgress.current_pr_state(["attach_pr", "sync_pr"]) do
        current.payload
      else
        _missing -> nil
      end

    %{branch: %{head_sha: MetadataProjection.latest_current_head_sha(events)}, pr: pr}
  end

  defp current_head(metadata) do
    branch = value(metadata, :branch)
    pr = value(metadata, :pr)
    head = value(branch, :head_sha)
    if is_binary(head) and value(pr, :head_sha) == head and is_binary(value(pr, :url)), do: head
  end

  defp delivered_before?(_id, nil, _packages, _deliveries, _successors), do: true

  defp delivered_before?(id, delivery, packages, deliveries, successors) do
    if value(delivery, :outcome) == "pr_merged" do
      merged_at = timestamp(value(delivery, :pr_merged_at))

      prior_deliveries =
        Map.filter(deliveries, fn {_id, prerequisite} ->
          delivered_at = timestamp(value(prerequisite, :pr_merged_at) || value(prerequisite, :recorded_at))
          is_integer(merged_at) and is_integer(delivered_at) and delivered_at <= merged_at
        end)

      DeliveryResolution.resolved?(id, packages, prior_deliveries, successors)
    else
      true
    end
  end

  defp timestamp(%DateTime{} = time), do: DateTime.to_unix(time, :microsecond)

  defp timestamp(time) when is_binary(time) do
    case DateTime.from_iso8601(time) do
      {:ok, time, _offset} -> timestamp(time)
      _invalid -> nil
    end
  end

  defp timestamp(_time), do: nil
  defp reason(reasons, true, reason), do: reasons ++ [reason]
  defp reason(reasons, false, _reason), do: reasons
  defp next_action([], true), do: "verify_native_checks_and_review_then_merge"
  defp next_action([], false), do: "finish_worker_qualification"

  defp next_action(reasons, _ready) do
    cond do
      "delivery_order_violation" in reasons -> "resolve_delivery_order_violation"
      "candidate_pin_stale" in reasons or "dependency_inputs_stale" in reasons -> "select_current_candidate_and_requalify_affected_work"
      true -> "deliver_prerequisites"
    end
  end

  defp value(map, key) when is_map(map), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))
  defp value(_map, _key), do: nil
end
