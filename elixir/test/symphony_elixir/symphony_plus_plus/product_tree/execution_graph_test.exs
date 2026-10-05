defmodule SymphonyElixir.SymphonyPlusPlus.ProductTree.ExecutionGraphTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.SymphonyPlusPlus.Planning.ProgressEvent
  alias SymphonyElixir.SymphonyPlusPlus.ProductTree.{DependencyEdge, ExecutionGraph, Node}
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.{WorkPackage, WorkPackageDelivery}

  test "expands every WorkPackage and Group endpoint combination into deterministic WorkPackage edges" do
    groups = [group("group_a"), group("group_b"), group("group_c")]

    work_packages = [
      work_package("wp_a1", "group_a"),
      work_package("wp_a2", "group_a"),
      work_package("wp_b1", "group_b"),
      work_package("wp_b2", "group_b"),
      work_package("wp_c1", "group_c"),
      work_package("wp_direct_1"),
      work_package("wp_direct_2"),
      work_package("wp_direct_3")
    ]

    edges = [
      dependency("dep_wp_wp", "work_package", "wp_direct_2", "work_package", "wp_direct_1"),
      dependency("dep_wp_group", "work_package", "wp_direct_3", "product_node", "group_a"),
      dependency("dep_group_wp", "product_node", "group_b", "work_package", "wp_direct_2"),
      dependency("dep_group_group", "product_node", "group_c", "product_node", "group_b")
    ]

    graph = ExecutionGraph.evaluate(%{nodes: groups, dependency_edges: edges}, work_packages, [])

    assert Enum.map(graph.effective_edges, &{&1.prerequisite_work_package_id, &1.dependent_work_package_id}) == [
             {"wp_a1", "wp_direct_3"},
             {"wp_a2", "wp_direct_3"},
             {"wp_b1", "wp_c1"},
             {"wp_b2", "wp_c1"},
             {"wp_direct_1", "wp_direct_2"},
             {"wp_direct_2", "wp_b1"},
             {"wp_direct_2", "wp_b2"}
           ]

    assert graph.cycles == []
    assert topological?(graph.topological_order, graph.effective_edges)

    assert graph ==
             ExecutionGraph.evaluate(
               %{nodes: Enum.reverse(groups), dependency_edges: Enum.reverse(edges)},
               Enum.reverse(work_packages),
               []
             )
  end

  test "reports cycles and exact unmet prerequisite WorkPackage ids" do
    work_packages = [work_package("wp_a"), work_package("wp_b"), work_package("wp_c")]

    edges = [
      dependency("dep_a", "work_package", "wp_a", "work_package", "wp_b"),
      dependency("dep_b", "work_package", "wp_b", "work_package", "wp_a"),
      dependency("dep_c", "work_package", "wp_c", "work_package", "wp_b")
    ]

    graph = ExecutionGraph.evaluate(%{nodes: [], dependency_edges: edges}, work_packages, [])

    assert graph.cycles == [["wp_a", "wp_b"]]
    assert graph.topological_order == []
    assert graph.dependency_ready_work_package_ids == []

    assert graph.unmet_dependencies == [
             %{work_package_id: "wp_a", prerequisite_work_package_ids: ["wp_b"]},
             %{work_package_id: "wp_b", prerequisite_work_package_ids: ["wp_a"]},
             %{work_package_id: "wp_c", prerequisite_work_package_ids: ["wp_b"]}
           ]

    assert {:error, {:execution_graph_cycle, [["wp_a", "wp_b"]]}} = ExecutionGraph.require_ready(graph, "wp_c")
  end

  test "nested Group dependencies omit overlapping identity pairs" do
    groups = [group("parent_group"), %Node{id: "child_group", parent_id: "parent_group"}]

    work_packages = [
      work_package("wp_parent", "parent_group"),
      work_package("wp_child_a", "child_group"),
      work_package("wp_child_b", "child_group")
    ]

    graph =
      ExecutionGraph.evaluate(
        %{
          nodes: groups,
          dependency_edges: [
            dependency("dep_nested_groups", "product_node", "child_group", "product_node", "parent_group")
          ]
        },
        work_packages,
        []
      )

    assert Enum.map(graph.effective_edges, &Map.drop(&1, [:constraints])) == [
             %{
               dependent_work_package_id: "wp_child_a",
               dependency_ids: ["dep_nested_groups"],
               prerequisite_work_package_id: "wp_parent"
             },
             %{
               dependent_work_package_id: "wp_child_b",
               dependency_ids: ["dep_nested_groups"],
               prerequisite_work_package_id: "wp_parent"
             }
           ]

    assert graph.cycles == []
    assert graph.topological_order == ["wp_parent", "wp_child_a", "wp_child_b"]
  end

  test "retired attempts do not resolve required scope without a delivered successor" do
    group = group("resolved_group")

    work_packages = [
      work_package("wp_abandoned", "resolved_group", "abandoned"),
      work_package("wp_closed", "resolved_group", "closed"),
      work_package("wp_delivery_abandoned", "resolved_group"),
      work_package("wp_merged", "resolved_group", "merged"),
      work_package("wp_pr_merged", "resolved_group"),
      work_package("wp_skipped", "resolved_group", "skipped"),
      work_package("wp_superseded", "resolved_group"),
      work_package("wp_target")
    ]

    deliveries = [
      delivery("wp_delivery_abandoned", "abandoned"),
      delivery("wp_pr_merged", "pr_merged"),
      delivery("wp_superseded", "superseded")
    ]

    graph =
      ExecutionGraph.evaluate(
        %{nodes: [group], dependency_edges: [dependency("dep_group", "work_package", "wp_target", "product_node", group.id)]},
        work_packages,
        deliveries
      )

    assert [%{work_package_id: "wp_target", prerequisite_work_package_ids: unmet}] = graph.unmet_dependencies
    assert unmet == ["wp_abandoned", "wp_closed", "wp_delivery_abandoned", "wp_merged", "wp_skipped", "wp_superseded"]
    refute "wp_target" in graph.dependency_ready_work_package_ids

    delivered = delivery("wp_successor", "completed_no_pr")
    packages = work_packages ++ [work_package("wp_successor")]
    superseded = %{delivery("wp_superseded", "superseded") | successor_work_package_id: "wp_successor"}

    graph =
      ExecutionGraph.evaluate(
        %{nodes: [group], dependency_edges: [dependency("dep_successor", "work_package", "wp_target", "work_package", "wp_superseded")]},
        packages,
        [superseded, delivered]
      )

    assert :ok = ExecutionGraph.require_ready(graph, "wp_target")
  end

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

  test "requires canonical delivery evidence rather than a projected outcome label" do
    graph =
      ExecutionGraph.evaluate(
        %{
          nodes: [group("group_source")],
          dependency_edges: [dependency("dep_projected", "work_package", "wp_target", "product_node", "group_source")]
        },
        [
          %{id: "wp_source", group_id: "group_source", raw_status: "planned", operational_state: %{delivery_outcome: "pr_merged"}},
          %{id: "wp_target", group_id: nil, raw_status: "planned"}
        ],
        []
      )

    assert {:error, {:unmet_work_package_dependencies, "wp_target", ["wp_source"]}} = ExecutionGraph.require_ready(graph, "wp_target")
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

  test "expanded overlapping constraints are ANDed and pins never bypass current-head matching" do
    head = String.duplicate("a", 40)
    other_head = String.duplicate("b", 40)
    packages = [work_package("backend", nil, "ready_for_merge"), work_package("ui", "uis")]
    pin = %{dependency("pin", "product_node", "uis", "work_package", "backend") | candidate_head_sha: head}
    ordinary = dependency("delivered", "work_package", "ui", "work_package", "backend")
    other_pin = %{pin | id: "other-pin", candidate_head_sha: other_head}
    context = %{events: %{"backend" => candidate_events(head)}}

    evaluate = fn edges, deliveries ->
      ExecutionGraph.evaluate(%{nodes: [group("uis")], dependency_edges: edges}, packages, deliveries, context)
    end

    assert :ok = ExecutionGraph.require_ready(evaluate.([pin], []), "ui")

    assert {:error, {:unmet_work_package_dependencies, "ui", ["backend"]}} =
             ExecutionGraph.require_ready(evaluate.([pin, ordinary], []), "ui")

    assert [%{constraints: constraints}] = evaluate.([pin, ordinary], []).effective_edges
    assert length(constraints) == 2
    assert {:error, _} = ExecutionGraph.require_ready(evaluate.([pin, other_pin], []), "ui")
    assert :ok = ExecutionGraph.require_ready(evaluate.([pin, ordinary], [delivery("backend", "pr_merged")]), "ui")
    assert {:error, _} = ExecutionGraph.require_ready(evaluate.([pin, other_pin], [delivery("backend", "pr_merged")]), "ui")

    changed = %{events: %{"backend" => candidate_events(other_head)}}
    stale = ExecutionGraph.evaluate(%{nodes: [group("uis")], dependency_edges: [pin]}, packages, [], changed)
    assert {:error, _} = ExecutionGraph.require_ready(stale, "ui")
    assert [%{constraints: [%{candidate_state: "stale_head"}]}] = stale.effective_edges

    # A later provider observation wins over the display projection's older matching head.
    events =
      candidate_events(head) ++
        [
          %ProgressEvent{
            sequence: 3,
            payload: %{"type" => "pr", "source_tool" => "sync_pr", "head_sha" => other_head, "url" => "https://github.com/example/repo/pull/1"}
          }
        ]

    observed_change =
      ExecutionGraph.evaluate(%{nodes: [group("uis")], dependency_edges: [pin]}, packages, [], %{events: %{"backend" => events}})

    assert {:error, _} = ExecutionGraph.require_ready(observed_change, "ui")
    assert [%{constraints: [%{current_head_sha: ^other_head, candidate_state: "stale_head"}]}] = observed_change.effective_edges

    group_pin =
      DependencyEdge.create_changeset(%{
        id: "bad",
        work_request_id: "wr",
        source_kind: "work_package",
        source_id: "ui",
        target_kind: "product_node",
        target_id: "uis",
        kind: "depends_on",
        reason: "Backend",
        candidate_head_sha: head
      })

    refute group_pin.valid?
    assert Keyword.has_key?(group_pin.errors, :candidate_head_sha)
  end

  test "cleared candidate expanded to a Group retains qualification for each prerequisite" do
    head = String.duplicate("c", 40)
    changed_at = DateTime.utc_now()
    pin = %{dependency("expanded", "work_package", "ui", "product_node", "backends") | selection_updated_at: changed_at}
    packages = [work_package("a", "backends"), work_package("b", "backends"), work_package("ui", nil, "ready_for_merge")]

    selections =
      for {id, sequence} <- [{"a", 3}, {"b", 4}] do
        %ProgressEvent{
          sequence: sequence,
          created_at: DateTime.add(changed_at, sequence, :second),
          payload: %{
            "head_sha" => head,
            "dependency_inputs" => [%{"dependency_id" => pin.id, "prerequisite_work_package_id" => id, "candidate_head_sha" => nil}]
          }
        }
      end

    graph =
      ExecutionGraph.evaluate(
        %{nodes: [group("backends")], dependency_edges: [pin]},
        packages,
        [delivery("a", "completed_no_pr"), delivery("b", "completed_no_pr")],
        %{events: %{"ui" => candidate_events(head) ++ selections}}
      )

    assert Enum.all?(graph.effective_edges, fn edge -> Enum.all?(edge.constraints, & &1.input_current) end)
    assert Enum.find(graph.merge_eligibility, &(&1.work_package_id == "ui")).eligible
  end

  defp candidate_events(head) do
    [
      %ProgressEvent{sequence: 1, payload: %{"type" => "branch", "source_tool" => "attach_branch", "head_sha" => head}},
      %ProgressEvent{sequence: 2, payload: %{"type" => "pr", "source_tool" => "attach_pr", "head_sha" => head, "url" => "https://github.com/example/repo/pull/1"}}
    ]
  end

  defp group(id), do: %Node{id: id, parent_id: nil}

  defp work_package(id, group_id \\ nil, status \\ "planned") do
    %WorkPackage{id: id, product_tree_node_id: group_id, status: status}
  end

  defp delivery(work_package_id, outcome) do
    %WorkPackageDelivery{work_package_id: work_package_id, outcome: outcome}
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

  defp topological?(order, edges) do
    positions = order |> Enum.with_index() |> Map.new()

    Enum.all?(edges, fn edge ->
      positions[edge.prerequisite_work_package_id] < positions[edge.dependent_work_package_id]
    end)
  end
end
