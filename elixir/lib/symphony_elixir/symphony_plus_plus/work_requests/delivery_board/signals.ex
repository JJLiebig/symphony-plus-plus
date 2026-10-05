defmodule SymphonyElixir.SymphonyPlusPlus.WorkRequests.DeliveryBoard.Signals do
  @moduledoc false

  import Ecto.Query, only: [from: 2]

  alias SymphonyElixir.SymphonyPlusPlus.Dashboard.Sanitizer
  alias SymphonyElixir.SymphonyPlusPlus.GitHub.PullRequest
  alias SymphonyElixir.SymphonyPlusPlus.GitHub.PullRequestProgress
  alias SymphonyElixir.SymphonyPlusPlus.ProductTree.{DependencyEdge, DependencyInputs, ExecutionGraph, Node}
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackageActivity
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest

  @request_chunk_size 400
  @string_limit 240

  @spec execution_graphs(module(), [WorkRequest.t()], map(), map(), keyword()) :: {:ok, map()} | {:error, term()}
  def execution_graphs(_repo, [], _work_packages_by_request, _deliveries_by_slice_id, _opts), do: {:ok, %{}}

  def execution_graphs(repo, work_requests, work_packages_by_request, deliveries_by_slice_id, opts) do
    load_execution_graphs(repo, work_requests, work_packages_by_request, deliveries_by_slice_id, opts)
  end

  defp load_execution_graphs(repo, work_requests, work_packages_by_request, deliveries_by_slice_id, opts) do
    work_request_ids = Enum.map(work_requests, & &1.id)
    product_trees_by_request = preloaded_product_trees(opts)
    missing_work_request_ids = Enum.reject(work_request_ids, &Map.has_key?(product_trees_by_request, &1))

    nodes_by_request = execution_nodes_by_request(repo, missing_work_request_ids)
    edges_by_request = execution_edges_by_request(repo, missing_work_request_ids)

    deliveries_by_request =
      deliveries_by_slice_id
      |> Map.values()
      |> Enum.group_by(& &1.work_request_id)

    Enum.reduce_while(work_requests, {:ok, %{}}, fn %WorkRequest{} = work_request, {:ok, graphs} ->
      work_packages = Map.get(work_packages_by_request, work_request.id, [])
      deliveries = Map.get(deliveries_by_request, work_request.id, [])

      product_tree =
        product_tree_for_request(
          work_request.id,
          product_trees_by_request,
          nodes_by_request,
          edges_by_request
        )

      candidates? = Enum.any?(product_tree.dependency_edges, &(&1.candidate_head_sha || &1.selection_updated_at))

      case DependencyInputs.context(repo, work_packages, candidates?) do
        {:ok, input_context} ->
          graph = ExecutionGraph.evaluate(product_tree, work_packages, deliveries, input_context)
          {:cont, {:ok, Map.put(graphs, work_request.id, scope_execution_graph(graph, work_packages, opts))}}

        {:error, _reason} = error ->
          {:halt, error}
      end
    end)
  rescue
    error in Exqlite.Error ->
      if missing_product_tree_schema_error?(error), do: {:ok, %{}}, else: normalize_exqlite_error(error)
  end

  defp preloaded_product_trees(opts) do
    case Keyword.fetch(opts, :product_trees_by_request) do
      {:ok, product_trees} when is_map(product_trees) -> product_trees
      :error -> %{}
      {:ok, _other} -> %{}
    end
  end

  defp product_tree_for_request(work_request_id, product_trees_by_request, nodes_by_request, edges_by_request) do
    case Map.fetch(product_trees_by_request, work_request_id) do
      {:ok, {:ok, product_tree}} ->
        product_tree

      {:ok, {:error, _reason}} ->
        %{nodes: [], dependency_edges: []}

      :error ->
        %{
          nodes: Map.get(nodes_by_request, work_request_id, []),
          dependency_edges: Map.get(edges_by_request, work_request_id, [])
        }
    end
  end

  defp execution_nodes_by_request(_repo, []), do: %{}

  defp execution_nodes_by_request(repo, work_request_ids) do
    work_request_ids
    |> Enum.chunk_every(@request_chunk_size)
    |> Enum.flat_map(fn request_id_chunk ->
      repo.all(
        from(node in Node,
          where: node.work_request_id in ^request_id_chunk,
          order_by: [asc: node.work_request_id, asc: node.parent_id, asc: node.position, asc: node.created_at, asc: node.id]
        )
      )
    end)
    |> Enum.group_by(& &1.work_request_id)
  end

  defp execution_edges_by_request(_repo, []), do: %{}

  defp execution_edges_by_request(repo, work_request_ids) do
    work_request_ids
    |> Enum.chunk_every(@request_chunk_size)
    |> Enum.flat_map(fn request_id_chunk ->
      repo.all(
        from(edge in DependencyEdge,
          where: edge.work_request_id in ^request_id_chunk,
          order_by: [asc: edge.work_request_id, asc: edge.kind, asc: edge.created_at, asc: edge.id]
        )
      )
    end)
    |> Enum.group_by(& &1.work_request_id)
  end

  @spec pr(map(), map() | nil) :: map()
  def pr(metadata, delivery \\ nil) do
    case map_value(metadata, "pr") do
      nil ->
        %{status: "none"}

      %{} = pr ->
        raw_head_sha = map_value(pr, "head_sha")

        raw_current_head_sha =
          map_value(pr, "current_head_sha") ||
            metadata |> map_value("branch") |> map_value("head_sha")

        head_sha = bounded_string(raw_head_sha)
        current_head_sha = bounded_string(raw_current_head_sha)

        %{
          status: pr_status(pr),
          url: bounded_string(map_value(pr, "url")),
          number: integer_value(first_map_value(pr, ["number", "pr_number"])),
          repository: bounded_string(first_map_value(pr, ["repository", "pr_repository"])),
          head_sha: head_sha,
          current_head_sha: current_head_sha,
          head_matches:
            if(filled_string?(raw_head_sha) and filled_string?(raw_current_head_sha),
              do: PullRequest.head_sha_matches?(raw_head_sha, raw_current_head_sha)
            ),
          checks: checks(map_value(pr, "check_summary"))
        }
        |> reject_nil_values()

      _invalid ->
        %{status: "unavailable"}
    end
    |> override_pr_status(delivery)
  end

  @spec review(WorkPackage.t(), map()) :: map() | nil
  def review(work_package, metadata), do: review(work_package, metadata, nil)

  @spec review(WorkPackage.t(), map(), map() | nil) :: map() | nil
  def review(%WorkPackage{review_requirement: nil}, _metadata, _observation), do: nil

  def review(%WorkPackage{review_requirement: requirement}, _metadata, observation) when is_map(requirement) do
    type = bounded_string(map_value(requirement, "type"))
    args = map_value(requirement, "args")
    evidence = [observation, args]

    %{
      type: type,
      args: if(is_map(args), do: Sanitizer.redacted_json(args)),
      status: map_value(observation, "status") || if(filled_string?(type), do: "pending", else: "unavailable"),
      current: evidence |> signal_value(["current", "completed", "completed_count"]) |> integer_value(),
      total: evidence |> signal_value(["total", "total_count"]) |> integer_value(),
      step: evidence |> signal_value(["step", "stage"]) |> bounded_string(),
      evidence_id: evidence |> signal_value(["evidence_id", "reference", "id"]) |> bounded_string(),
      reviewed_head: evidence |> signal_value(["head_sha", "reviewed_head"]) |> bounded_string(),
      provider_status: observation |> map_value("provider_status") |> bounded_string(),
      next_action: observation |> map_value("next_action") |> bounded_string(),
      round: observation |> map_value("round") |> bounded_string(),
      started_at: map_value(observation, "started_at"),
      round_started_at: map_value(observation, "round_started_at"),
      observed_at: map_value(observation, "observed_at"),
      observation_state: review_observation_state(observation)
    }
    |> reject_nil_values()
  end

  def review(%WorkPackage{}, _metadata, _observation), do: %{status: "unavailable"}

  defp review_observation_state(nil), do: "unknown"

  defp review_observation_state(observation) do
    if map_value(observation, "provider_status") in ["stale", "invalidated", "head_changed_after_review"], do: "stale", else: "current"
  end

  @spec activity(WorkPackage.t(), map(), map(), [map()], [map()]) :: map()
  def activity(work_package, summary, operational_state, events, guidance) do
    worker = map_value(summary, "worker_signal") || %{}
    review = map_value(summary, "review_signal") || %{}
    stage = activity_stage(work_package, operational_state, review)
    latest_event = List.last(events)
    started_at = review_started_at(stage, review)
    {waiting_reason, next_actor, next_action} = next_activity(work_package, summary, guidance, review, worker)

    %{
      work_package_id: work_package.id,
      accountable_owner: accountable_owner(work_package.owner_id),
      current_actor: worker[:current_actor],
      stage: stage,
      started_at: started_at,
      elapsed_seconds: elapsed_seconds(started_at),
      waiting_reason: waiting_reason,
      next_actor: next_actor,
      next_action: next_action,
      last_update_at: latest_timestamp([work_package.updated_at, map_value(latest_event, "created_at"), worker[:last_activity]]),
      last_update: latest_event |> map_value("summary") |> bounded_string(),
      observation_state: observation_state(worker),
      observed_at: review[:observed_at]
    }
    |> reject_nil_values()
    |> Sanitizer.redacted_json()
  end

  defp accountable_owner(nil), do: nil
  defp accountable_owner(id), do: %{id: id, source: "work_package"}

  defp activity_stage(%{status: status}, _operational_state, %{status: "in_progress"})
       when status not in ["ready_for_merge", "skipped", "merged", "closed", "abandoned"], do: "reviewing"

  defp activity_stage(%{status: status}, _operational_state, _review)
       when status in ["planning", "implementing", "reviewing", "ci_waiting", "ready_for_merge"], do: status

  defp activity_stage(_work_package, operational_state, _review), do: operational_state.key

  defp review_started_at("reviewing", review), do: review[:round_started_at] || review[:started_at]
  defp review_started_at(_stage, _review), do: nil

  defp elapsed_seconds(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, datetime, _offset} -> max(DateTime.diff(DateTime.utc_now(), datetime, :second), 0)
      _invalid -> nil
    end
  end

  defp elapsed_seconds(_value), do: nil

  defp latest_timestamp(values) do
    values
    |> Enum.reject(&is_nil/1)
    |> Enum.max_by(&Sanitizer.timestamp_sort_value/1, fn -> nil end)
    |> Sanitizer.timestamp()
  end

  defp next_activity(work_package, summary, guidance, review, worker) do
    guidance_wait = guidance_wait(guidance)
    dependency = map_value(summary, "dependency_signal") || %{}
    eligibility = Map.get(summary, :merge_eligibility, %{})
    dependency_reason = Enum.find(Map.get(eligibility, :reason_codes, []), &(&1 != "not_ready"))

    cond do
      work_package.status in ["skipped", "merged", "closed", "abandoned"] -> {nil, nil, nil}
      guidance_wait -> guidance_wait
      dependency_reason -> {dependency_reason, "architect", eligibility[:next_action]}
      Map.get(dependency, :unmet_work_package_ids, []) != [] -> {"unmet_dependencies", "prerequisite_owner", "resolve_dependencies"}
      get_in(summary, [:blocker_state, :active?]) -> {"active_blocker", nil, "resolve_blocker"}
      true -> next_runtime_activity(work_package, review, worker)
    end
  end

  defp guidance_wait(guidance) do
    human = Enum.find(guidance, &(&1.status == "human_info_needed"))
    open = Enum.find(guidance, &(&1.status == "open"))

    cond do
      human -> {human.human_info_reason || human.summary, "human", "answer_guidance"}
      open -> {open.summary, "architect", "answer_guidance"}
      true -> nil
    end
  end

  defp next_runtime_activity(work_package, review, worker) do
    cond do
      worker[:status] == "paused" -> {"worker_paused", "worker", "resume"}
      worker[:status] == "stale" -> {"runtime_stale", nil, "inspect_runtime"}
      work_package.status == "ready_for_merge" -> {"awaiting_integration", "architect", "integrate"}
      review[:next_action] not in [nil, "none"] -> {if(review[:next_action] == "wait", do: "review_in_progress"), "worker", review[:next_action]}
      work_package.status == "ci_waiting" -> {"validation_pending", "worker", "check_validation"}
      true -> {nil, nil, nil}
    end
  end

  defp observation_state(%{status: "stale"}), do: "stale"
  defp observation_state(%{status: "paused"}), do: "paused"
  defp observation_state(%{current_actor: actor}) when is_map(actor), do: "current"
  defp observation_state(_worker), do: "unknown"

  @spec dependency_context(map()) :: map()
  def dependency_context(execution_graphs) when is_map(execution_graphs) do
    effective_edges =
      execution_graphs
      |> Map.values()
      |> Enum.flat_map(&(map_value(&1, "effective_edges") |> List.wrap()))

    unmet_dependencies =
      execution_graphs
      |> Map.values()
      |> Enum.flat_map(&(map_value(&1, "unmet_dependencies") |> List.wrap()))

    %{
      incoming_by_work_package_id:
        effective_edges
        |> Enum.group_by(&map_value(&1, "dependent_work_package_id"))
        |> Map.new(fn {work_package_id, edges} ->
          incoming_ids =
            edges
            |> Enum.map(&map_value(&1, "prerequisite_work_package_id"))
            |> Enum.filter(&filled_string?/1)
            |> Enum.uniq()
            |> Enum.sort()

          {work_package_id, incoming_ids}
        end),
      unmet_by_work_package_id:
        unmet_dependencies
        |> Map.new(fn dependency ->
          {map_value(dependency, "work_package_id"), dependency |> map_value("prerequisite_work_package_ids") |> List.wrap() |> MapSet.new()}
        end)
    }
  end

  @spec dependency(WorkPackage.t(), map()) :: map() | nil
  def dependency(%WorkPackage{} = work_package, context) do
    dependency_indexes =
      Map.get(context, :dependency_indexes) ||
        context
        |> Map.get(:execution_graphs, %{})
        |> dependency_context()

    incoming_ids =
      dependency_indexes
      |> Map.get(:incoming_by_work_package_id, %{})
      |> Map.get(work_package.id, [])

    unmet_ids =
      dependency_indexes
      |> Map.get(:unmet_by_work_package_id, %{})
      |> Map.get(work_package.id, MapSet.new())

    if incoming_ids == [] do
      nil
    else
      inputs =
        Enum.map(incoming_ids, fn prerequisite_id ->
          %{
            work_package_id: prerequisite_id,
            status: dependency_input_status(prerequisite_id, unmet_ids, context)
          }
        end)

      %{
        satisfied: Enum.count(inputs, &(&1.status == "satisfied")),
        required: length(inputs),
        active: Enum.count(inputs, &(&1.status == "active")),
        blocked: Enum.count(inputs, &(&1.status == "blocked")),
        unmet_work_package_ids:
          inputs
          |> Enum.reject(&(&1.status == "satisfied"))
          |> Enum.map(& &1.work_package_id),
        inputs: inputs
      }
    end
  end

  defp scope_execution_graph(graph, work_packages, opts) do
    case Keyword.get(opts, :visible_work_package_ids, :all) do
      visible_ids when is_list(visible_ids) ->
        visible_ids = MapSet.new(visible_ids)

        work_packages
        |> Enum.map(& &1.id)
        |> Enum.filter(&MapSet.member?(visible_ids, &1))
        |> then(&ExecutionGraph.scope(graph, &1))

      _all ->
        graph
    end
  end

  defp pr_status(pr) do
    cond do
      PullRequestProgress.merged?(pr) -> "merged"
      filled_string?(map_value(pr, "url")) or is_integer(first_map_value(pr, ["number", "pr_number"])) -> "open"
      true -> "unavailable"
    end
  end

  defp override_pr_status(signal, %{outcome: "pr_merged"}), do: %{signal | status: "merged"}
  defp override_pr_status(signal, _delivery), do: signal

  defp checks(nil), do: nil
  defp checks(value) when not is_map(value), do: %{status: "unavailable"}

  defp checks(value) do
    %{
      status: value |> first_map_value(["conclusion", "state", "status"]) |> check_status(),
      current: integer_value(first_map_value(value, ["current", "completed", "completed_count"])),
      total: integer_value(first_map_value(value, ["total", "total_count", "check_count"]))
    }
    |> reject_nil_values()
  end

  defp check_status(value) when is_binary(value) do
    case value |> String.trim() |> String.downcase() do
      status when status in ["success", "succeeded", "passed", "passing", "complete", "completed"] -> "passing"
      status when status in ["failure", "failed", "failing", "error", "cancelled", "timed_out"] -> "failing"
      status when status in ["pending", "queued", "running", "in_progress", "in progress", "waiting"] -> "pending"
      _status -> "unavailable"
    end
  end

  defp check_status(_value), do: "unavailable"

  defp dependency_input_status(work_package_id, unmet_ids, context) do
    activity = get_in(context, [:activity_contexts, work_package_id]) || WorkPackageActivity.empty_context()

    cond do
      not MapSet.member?(unmet_ids, work_package_id) -> "satisfied"
      get_in(activity, [:blocker_state, :active?]) == true -> "blocked"
      get_in(activity, [:runtime_state, :active?]) == true -> "active"
      true -> "waiting"
    end
  end

  defp signal_value(maps, keys) do
    Enum.find_value(maps, fn
      %{} = map -> first_map_value(map, keys)
      _value -> nil
    end)
  end

  defp bounded_string(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> String.slice(trimmed, 0, @string_limit)
    end
  end

  defp bounded_string(_value), do: nil
  defp integer_value(value) when is_integer(value), do: value
  defp integer_value(_value), do: nil

  defp first_map_value(map, keys), do: Enum.find_value(keys, &map_value(map, &1))

  defp map_value(%{} = map, key) when is_binary(key) do
    case Map.fetch(map, key) do
      {:ok, value} -> value
      :error -> atom_map_value(map, key)
    end
  end

  defp map_value(_value, _key), do: nil

  defp atom_map_value(map, key) do
    Map.get(map, String.to_existing_atom(key))
  rescue
    _error in ArgumentError -> nil
  end

  defp reject_nil_values(map), do: Map.reject(map, fn {_key, value} -> is_nil(value) end)
  defp filled_string?(value), do: is_binary(value) and String.trim(value) != ""

  defp missing_product_tree_schema_error?(error) do
    error
    |> Exception.message()
    |> String.downcase()
    |> String.contains?("no such table: sympp_product_tree_")
  end

  defp normalize_exqlite_error(error) do
    message = Exception.message(error)
    normalized_message = String.downcase(message)

    if String.contains?(normalized_message, "busy") or String.contains?(normalized_message, "locked") do
      {:error, :database_busy}
    else
      {:error, {:storage_failed, message}}
    end
  end
end
