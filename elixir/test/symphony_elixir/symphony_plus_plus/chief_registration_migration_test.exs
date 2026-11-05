defmodule SymphonyElixir.SymphonyPlusPlus.ChiefRegistrationMigrationTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.Repo.Migrations
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest
  alias SymphonyElixir.WorkPackageFactory

  test "chief migration preserves existing work and creator provenance without inventing attribution" do
    database = WorkPackageFactory.database_path()
    {:ok, pid} = Repo.start_link(database: database, name: nil, pool_size: 1, log: false)
    original_repo = Repo.put_dynamic_repo(pid)

    try do
      Ecto.Migrator.run(Repo, Migrations.all(), :up, to: 20_261_013_140_000, log: false)
      now = DateTime.utc_now(:microsecond)

      request = %{
        id: "WR-BEFORE-CHIEFS",
        title: "Existing work",
        repo: "nextide/example",
        base_branch: "main",
        work_type: "docs",
        human_description: "Existing description",
        constraints: "{}",
        desired_dispatch_shape: "single_package",
        status: "sliced",
        creator_kind: "agent",
        creator_name: "original-agent",
        created_via: "mcp",
        inserted_at: now,
        updated_at: now
      }

      package = %{
        id: "WP-BEFORE-CHIEFS",
        work_request_id: request.id,
        kind: "docs",
        title: "Existing package",
        repo: request.repo,
        base_branch: "main",
        status: "planned",
        acceptance_criteria: "[]",
        inserted_at: now,
        updated_at: now
      }

      assert {1, _} = Repo.insert_all("sympp_work_requests", [request])
      assert {1, _} = Repo.insert_all("sympp_work_packages", [package])
      assert [20_261_025_160_000] = Ecto.Migrator.run(Repo, Migrations.all(), :up, all: true, log: false)

      stored = Repo.get!(WorkRequest, request.id)
      assert stored.title == request.title
      assert {stored.creator_kind, stored.creator_name, stored.created_via} == {"agent", "original-agent", "mcp"}
      assert stored.dispatched_by == nil
      assert Repo.get!(WorkPackage, package.id).dispatched_by == nil
      assert [] = Ecto.Migrator.run(Repo, Migrations.all(), :up, all: true, log: false)
    after
      Repo.put_dynamic_repo(original_repo)
      GenServer.stop(pid)
      File.rm(database)
    end
  end
end
