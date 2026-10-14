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
