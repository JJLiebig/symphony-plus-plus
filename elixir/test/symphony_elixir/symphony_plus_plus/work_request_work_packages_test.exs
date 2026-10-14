defmodule SymphonyElixir.SymphonyPlusPlus.WorkRequestWorkPackagesTest do
  use ExUnit.Case, async: false

  defmodule ContractUpdateRaceRepo do
    alias SymphonyElixir.SymphonyPlusPlus.Repo

    @race_key {__MODULE__, :race?}

    def arm, do: Process.put(@race_key, true)
    def get(schema, id), do: Repo.get(schema, id)
    def all(query), do: Repo.all(query)

    def update(changeset) do
      if Process.delete(@race_key) do
        changeset.data
        |> Ecto.Changeset.change(status: "ready_for_worker")
        |> Repo.update!()
      end

      Repo.update(changeset)
    end
  end

  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.AccessGrant
  alias SymphonyElixir.SymphonyPlusPlus.CreateWork
  alias SymphonyElixir.SymphonyPlusPlus.Planning.{Artifact, Finding, PlanNode, ProgressEvent}
  alias SymphonyElixir.SymphonyPlusPlus.ProductTree.Node
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackageDelivery
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.ClarificationQuestion
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest

  setup_all do
    database_path = database_path()
    start_supervised!({Repo, database: database_path, pool_size: 1})
    assert :ok = Repository.migrate(Repo)
    on_exit(fn -> File.rm(database_path) end)
    {:ok, repo: Repo, database_path: database_path}
  end

  setup %{repo: repo} do
    repo.delete_all(Artifact)
    repo.delete_all(ProgressEvent)
    repo.delete_all(Finding)
    repo.delete_all(PlanNode)
    repo.delete_all(AccessGrant)
    repo.delete_all(WorkPackageDelivery)
    repo.delete_all(ClarificationQuestion)
    repo.delete_all(WorkPackage)
    repo.delete_all(Node)
    repo.delete_all(WorkRequest)
    :ok
  end

  test "rejects a contract update that races with dispatch", %{repo: repo} do
    work_request = create_work_request!(repo)
    package = slice_one!(repo, work_request.id)
    ContractUpdateRaceRepo.arm()

    assert {:error, :stale_status} =
             Repository.update_work_package(
               ContractUpdateRaceRepo,
               work_request.id,
               package.id,
               package.contract_revision,
               %{title: "Racing contract"}
             )

    assert {:ok, persisted} = WorkPackageRepository.get(repo, package.id)
    assert persisted.status == "ready_for_worker"
    assert persisted.title == package.title
    assert persisted.contract_revision == package.contract_revision
  end

  test "activation returns a stale-status error when the planned package changed", %{repo: repo} do
    work_request = create_work_request!(repo)
    package = slice_one!(repo, work_request.id)

    assert {:ok, skipped} = WorkPackageRepository.update_status(repo, package.id, "planned", "skipped")
    assert skipped.status == "skipped"
    assert {:error, :stale_status} = CreateWork.activate(repo, package)
  end

  test "activation rejects a contract revision changed after dispatch validation", %{repo: repo} do
    work_request = create_work_request!(repo)
    package = slice_one!(repo, work_request.id)

    assert {:ok, updated} =
             Repository.update_work_package(repo, work_request.id, package.id, package.contract_revision, %{
               title: "Newer contract"
             })

    assert updated.contract_revision == package.contract_revision + 1
    assert {:error, :stale_status} = CreateWork.activate(repo, package)

    assert {:ok, persisted} = WorkPackageRepository.get(repo, package.id)
    assert persisted.status == "planned"
    assert persisted.title == "Newer contract"
    assert Repo.aggregate(AccessGrant, :count) == 0
  end

  defp slice_one!(repo, work_request_id, attrs \\ package_attrs()) do
    assert {:ok, %{work_packages: [package]}} = Repository.slice_work_request(repo, work_request_id, [attrs])
    package
  end

  defp create_work_request!(repo, overrides \\ []) do
    attrs =
      Enum.into(overrides, %{
        id: "WR-#{System.unique_integer([:positive])}",
        title: "Canonical package cutover",
        repo: "nextide/example",
        base_branch: "main",
        work_type: "feature",
        human_description: "Create one canonical package identity.",
        constraints: %{"allowed_paths" => ["elixir/lib"], "forbidden_paths" => [], "requires_secret" => false},
        desired_dispatch_shape: "single_package",
        status: "ready_for_slicing"
      })

    assert {:ok, work_request} = Repository.create(repo, attrs)
    work_request
  end

  defp package_attrs(overrides \\ []) do
    Enum.into(overrides, %{
      id: "wp_#{System.unique_integer([:positive])}",
      title: "Canonical WorkPackage",
      goal: "Execute the package without a second identity.",
      kind: "mcp",
      branch_pattern: "refactor/canonical-work-packages",
      allowed_file_globs: ["elixir/lib/**"],
      forbidden_file_globs: [],
      acceptance_criteria: ["One WorkPackage id is used end to end."],
      validation_steps: ["mix test"],
      review: %{"type" => "review-suite", "args" => %{"mode" => "normal"}},
      stop_conditions: ["Stop on migration data loss."]
    })
  end

  defp database_path do
    Path.join(
      System.tmp_dir!(),
      "sympp-canonical-work-packages-#{System.os_time(:nanosecond)}-#{System.unique_integer([:positive])}.sqlite3"
    )
  end
end
