defmodule SymphonyElixir.SymphonyPlusPlus.WorkRequests.DeliveryResolution do
  @moduledoc false

  @delivered_outcomes ["pr_merged", "completed_no_pr"]
  @retired_statuses ["skipped", "merged", "closed", "abandoned"]

  @spec resolved?(String.t(), map(), map()) :: boolean()
  @spec resolved?(String.t(), map(), map(), map()) :: boolean()
  def resolved?(work_package_id, work_packages_by_id, deliveries_by_id, successors_by_id \\ %{}) do
    resolve(work_package_id, work_packages_by_id, deliveries_by_id, successors_by_id, MapSet.new())
  end

  @spec successor_ids(String.t(), map(), map()) :: [String.t()]
  def successor_ids(work_package_id, deliveries_by_id, successors_by_id) do
    delivery = Map.get(deliveries_by_id, work_package_id, %{})
    pointer = if value(delivery, :outcome) == "superseded", do: value(delivery, :successor_work_package_id)

    (List.wrap(pointer) ++ Map.get(successors_by_id, work_package_id, [])) |> Enum.uniq()
  end

  defp resolve(id, packages, deliveries, successors, visited) do
    package = Map.get(packages, id)
    delivery = Map.get(deliveries, id)

    cond do
      is_nil(package) ->
        false

      value(delivery, :outcome) in @delivered_outcomes ->
        true

      MapSet.member?(visited, id) ->
        false

      value(delivery, :outcome) == "superseded" or value(package, :status) in @retired_statuses ->
        resolve_successors(package, packages, deliveries, successors, MapSet.put(visited, id))

      true ->
        false
    end
  end

  defp resolve_successors(package, packages, deliveries, successors, visited) do
    ids = successor_ids(value(package, :id), deliveries, successors)

    ids != [] and
      Enum.all?(ids, fn id ->
        successor = Map.get(packages, id)

        not is_nil(successor) and value(successor, :work_request_id) == value(package, :work_request_id) and
          resolve(id, packages, deliveries, successors, visited)
      end)
  end

  defp value(map, key) when is_map(map), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))
  defp value(_map, _key), do: nil
end
