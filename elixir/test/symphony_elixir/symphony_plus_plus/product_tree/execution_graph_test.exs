defmodule SymphonyElixir.SymphonyPlusPlus.ProductTree.ExecutionGraphTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.SymphonyPlusPlus.ProductTree.{DependencyEdge, ExecutionGraph}
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage

  test "recomputes derived evidence when scoping graph visibility" do
    work_packages = [work_package("wp_hidden_a"), work_package("wp_hidden_b"), work_package("wp_visible")]

    graph =
      ExecutionGraph.evaluate(
        %{
          nodes: [],
          dependency_edges: [
            dependency("dep_cycle_a", "work_package", "wp_hidden_a", "work_package", "wp_hidden_b"),
            dependency("dep_cycle_b", "work_package", "wp_hidden_b", "work_package", "wp_hidden_a"),
            dependency("dep_visible", "work_package", "wp_visible", "work_package", "wp_hidden_a")
          ]
        },
        work_packages,
        []
      )

    assert graph.cycles == [["wp_hidden_a", "wp_hidden_b"]]

    assert %{
             cycles: [],
             dependency_ready_work_package_ids: ["wp_visible"],
             effective_edges: [],
             topological_order: ["wp_visible"],
             unmet_dependencies: [],
             work_package_ids: ["wp_visible"]
           } = ExecutionGraph.scope(graph, ["wp_visible"])
  end

  test "drops dependency endpoints outside the projected WorkPackage set" do
    graph =
      ExecutionGraph.evaluate(
        %{
          nodes: [],
          dependency_edges: [dependency("dep_hidden", "work_package", "wp_hidden", "work_package", "wp_visible")]
        },
        [%{id: "wp_visible", raw_status: "skipped"}],
        []
      )

    assert graph.effective_edges == []
    assert graph.topological_order == ["wp_visible"]
    assert [%{status: "skipped", resolved: false}] = graph.resolutions
  end

  defp work_package(id) do
    %WorkPackage{id: id, status: "planned"}
  end

  defp dependency(id, source_kind, source_id, target_kind, target_id) do
    %DependencyEdge{
      id: id,
      source_kind: source_kind,
      source_id: source_id,
      target_kind: target_kind,
      target_id: target_id,
      kind: "depends_on"
    }
  end
end
