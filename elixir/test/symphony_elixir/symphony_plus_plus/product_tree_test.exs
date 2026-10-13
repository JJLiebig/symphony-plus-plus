defmodule SymphonyElixir.SymphonyPlusPlus.ProductTreeTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.SymphonyPlusPlus.ProductTree
  alias SymphonyElixir.SymphonyPlusPlus.ProductTree.{DependencyEdge, Node, Revision}
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository, as: WorkRequestRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest
  alias SymphonyElixir.WorkPackageFactory

  setup_all do
    database_path = WorkPackageFactory.database_path()
    start_supervised!({Repo, database: database_path, pool_size: 1})
    assert :ok = WorkRequestRepository.migrate(Repo)
    on_exit(fn -> File.rm(database_path) end)
    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    repo.delete_all(Revision)
    repo.delete_all(DependencyEdge)
    repo.delete_all(WorkPackage)
    repo.delete_all(Node)
    repo.delete_all(WorkRequest)
    :ok
  end

  test "normalizes atom-keyed goals into worker engineering scope", %{repo: repo} do
    work_request = create_work_request!(repo, id: "WR-ATOM-GOAL")

    assert {:ok, %{work_packages: [package]}} =
             WorkRequestRepository.slice_work_request(repo, work_request.id, [
               %{
                 id: "wp_atom_goal",
                 title: "Atom-keyed package",
                 goal: "Own the canonical package boundary.",
                 kind: "mcp",
                 base_branch: " refs/remotes/origin/main ",
                 branch_pattern: "refactor/canonical-work-packages",
                 allowed_file_globs: ["elixir/lib/**"],
                 acceptance_criteria: ["The package has one identity."]
               }
             ])

    assert package.goal == "Own the canonical package boundary."
    assert package.engineering_scope == package.goal
    assert package.base_branch == "main"
  end

  test "visible-only projection keeps the owned node path without leaking hidden nodes", %{repo: repo} do
    work_request = create_work_request!(repo, id: "WR-VISIBLE-TREE")
    parent = create_node!(repo, work_request, id: "node_visible_parent")
    visible_node = create_node!(repo, work_request, id: "node_visible", parent_id: parent.id)
    hidden_node = create_node!(repo, work_request, id: "node_hidden")
    visible = add_work_package!(repo, work_request, id: "wp_visible", product_tree_node_id: visible_node.id)
    _hidden = add_work_package!(repo, work_request, id: "wp_hidden", product_tree_node_id: hidden_node.id)

    projection = ProductTree.project(repo, work_request.id, [payload(visible)], visible_only?: true)

    assert MapSet.new(Enum.map(projection.nodes, & &1.id)) == MapSet.new([parent.id, visible_node.id])
    refute Enum.any?(projection.nodes, &(&1.id == hidden_node.id))
  end

  test "rejects cross-WorkRequest node ownership and dependency endpoints", %{repo: repo} do
    left = create_work_request!(repo, id: "WR-LEFT")
    right = create_work_request!(repo, id: "WR-RIGHT")
    left_node = create_node!(repo, left, id: "node_left")
    left_package = add_work_package!(repo, left, id: "wp_left")
    right_package = add_work_package!(repo, right, id: "wp_right")

    assert {:error, :not_found} =
             WorkRequestRepository.update_work_package(
               repo,
               right.id,
               right_package.id,
               right_package.contract_revision,
               %{product_tree_node_id: left_node.id}
             )

    assert {:error, {:constraint_failed, "product_tree_dependency_target_scope"}} =
             ProductTree.create_dependency_edge(repo, %{
               work_request_id: left.id,
               source_kind: "product_node",
               source_id: left_node.id,
               target_kind: "work_package",
               target_id: right_package.id
             })

    assert {:ok, edge} =
             ProductTree.create_dependency_edge(repo, %{
               work_request_id: left.id,
               source_kind: "product_node",
               source_id: left_node.id,
               target_kind: "work_package",
               target_id: left_package.id,
               kind: "depends_on",
               reason: "Scoped dependency fixture"
             })

    assert {:error, {:constraint_failed, "product_tree_dependency_target_scope"}} =
             ProductTree.upsert_dependency_edge(repo, %{
               id: edge.id,
               work_request_id: left.id,
               target_id: right_package.id
             })

    assert repo.get!(DependencyEdge, edge.id).target_id == left_package.id
  end

  test "dependency updates preserve hard-edge context invariants", %{repo: repo} do
    work_request = create_work_request!(repo, id: "WR-DEPENDENCY-CONTEXT")
    source = add_work_package!(repo, work_request, id: "wp_context_source")
    target = add_work_package!(repo, work_request, id: "wp_context_target")

    assert {:ok, edge} =
             ProductTree.create_dependency_edge(repo, %{
               work_request_id: work_request.id,
               source_kind: "work_package",
               source_id: source.id,
               target_kind: "work_package",
               target_id: target.id,
               kind: "depends_on",
               decision_ref: %{"id" => "WRD-CONTEXT"}
             })

    assert {:error, changeset} =
             ProductTree.upsert_dependency_edge(repo, %{
               id: edge.id,
               work_request_id: work_request.id,
               source_kind: edge.source_kind,
               source_id: edge.source_id,
               target_kind: edge.target_kind,
               target_id: edge.target_id,
               kind: edge.kind,
               reason: "",
               decision_ref: %{}
             })

    assert {"hard dependency edges require a reason or decision reference", _metadata} = changeset.errors[:kind]
    assert repo.get!(DependencyEdge, edge.id).decision_ref == %{"id" => "WRD-CONTEXT"}
  end

  defp create_work_request!(repo, overrides) do
    attrs =
      %{
        id: "WR-#{System.unique_integer([:positive])}",
        title: "Canonical product tree",
        repo: "symphony-plus-plus",
        base_branch: "main",
        work_type: "feature",
        human_description: "Project canonical WorkPackages.",
        constraints: %{},
        desired_dispatch_shape: "single_package",
        status: "sliced"
      }
      |> Map.merge(Map.new(overrides))

    assert {:ok, work_request} = WorkRequestRepository.create(repo, attrs)
    work_request
  end

  defp create_node!(repo, work_request, overrides) do
    attrs =
      %{work_request_id: work_request.id, title: "Product node"}
      |> Map.merge(Map.new(overrides))

    assert {:ok, node} = ProductTree.create_node(repo, attrs)
    node
  end

  defp add_work_package!(repo, work_request, overrides) do
    attrs =
      %{
        title: "Canonical WorkPackage",
        goal: "Deliver a product boundary.",
        kind: "mcp",
        base_branch: work_request.base_branch,
        branch_pattern: "refactor/canonical-work-packages",
        allowed_file_globs: ["elixir/lib/**"],
        forbidden_file_globs: [],
        acceptance_criteria: ["The package has one identity."],
        validation_steps: ["mix test"],
        review_requirement: %{"type" => "review-suite", "args" => %{"mode" => "normal"}},
        stop_conditions: ["Stop on scope mismatch."]
      }
      |> Map.merge(Map.new(overrides))

    assert {:ok, package} = CanonicalWorkPackageFixtures.add_work_package(repo, work_request.id, attrs)
    package
  end

  defp payload(%WorkPackage{} = package) do
    %{
      "id" => package.id,
      "product_tree_node_id" => package.product_tree_node_id,
      "sequence" => package.sequence,
      "status" => package.status
    }
  end
end
