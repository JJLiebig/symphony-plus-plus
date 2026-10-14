defmodule SymphonyElixir.SymphonyPlusPlus.WorkRequestWorkPackageDeliveriesTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackageDelivery
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest

  defmodule UniqueConflictRepo do
    alias Ecto.Changeset

    def transaction(fun) do
      {:ok, fun.()}
    catch
      {:rollback, reason} -> {:error, reason}
    end

    def exists?(_query), do: true
    def all(_query), do: []
    def delete_all(_query), do: {0, nil}
    def update_all(_query, _updates), do: {0, nil}

    def get(WorkPackage, "WRS-RACE") do
      %WorkPackage{id: "WRS-RACE", work_request_id: "WR-RACE", status: "closed"}
    end

    def one(_query) do
      if Process.get(:delivery_unique_conflict_insert_attempted) do
        Process.get(:delivery_unique_conflict_existing)
      end
    end

    def insert(%Changeset{} = changeset) do
      Process.put(:delivery_unique_conflict_insert_attempted, true)

      {:error,
       Changeset.add_error(changeset, :work_package_id, "has already been taken",
         constraint: :unique,
         constraint_name: "sympp_work_request_work_package_deliveries_work_package_id_unique_index"
       )}
    end

    def rollback(reason), do: throw({:rollback, reason})
  end

  setup_all do
    database_path = database_path()

    start_supervised!({Repo, database: database_path, pool_size: 1})
    assert :ok = Repository.migrate(Repo)

    on_exit(fn -> File.rm(database_path) end)

    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    repo.delete_all(WorkPackageDelivery)
    repo.delete_all(WorkPackage)
    repo.delete_all(WorkRequest)
    :ok
  end

  test "accepts exact replay after a concurrent unique conflict" do
    existing = %WorkPackageDelivery{
      work_request_id: "WR-RACE",
      work_package_id: "WRS-RACE",
      outcome: "completed_no_pr",
      idempotency_key: "delivery-race",
      recorded_by: "delivery-worker",
      no_pr_evidence: "Same no-PR evidence."
    }

    Process.put(:delivery_unique_conflict_existing, existing)
    Process.delete(:delivery_unique_conflict_insert_attempted)

    try do
      assert {:ok, ^existing} =
               Repository.record_work_package_delivery(
                 UniqueConflictRepo,
                 "WR-RACE",
                 "WRS-RACE",
                 delivery_attrs(%{
                   outcome: "completed_no_pr",
                   idempotency_key: "delivery-race",
                   no_pr_evidence: "Same no-PR evidence."
                 })
               )
    after
      Process.delete(:delivery_unique_conflict_existing)
      Process.delete(:delivery_unique_conflict_insert_attempted)
    end
  end

  test "delivery outcomes are scoped to their WorkPackage WorkRequest", %{repo: repo} do
    work_request = create_work_request!(repo)
    sibling_request = create_work_request!(repo, id: "WR-DELIVERY-SIBLING")
    work_package = create_work_package!(repo, work_request, id: "WRS-DELIVERY-SCOPED")

    assert {:error, :not_found} =
             Repository.record_work_package_delivery(
               repo,
               sibling_request.id,
               work_package.id,
               delivery_attrs(%{
                 outcome: "completed_no_pr",
                 no_pr_evidence: "Wrong WorkRequest must not claim this slice."
               })
             )

    assert repo.aggregate(WorkPackageDelivery, :count, :id) == 0

    successor_slice = create_work_package!(repo, sibling_request, id: "WRS-DELIVERY-CROSS-SUCCESSOR")

    assert {:error, :not_found} =
             Repository.record_work_package_delivery(
               repo,
               work_request.id,
               work_package.id,
               delivery_attrs(%{
                 outcome: "superseded",
                 successor_work_package_id: successor_slice.id,
                 superseded_reason: "Wrong WorkRequest successor must not be linked."
               })
             )

    assert repo.aggregate(WorkPackageDelivery, :count, :id) == 0
  end

  test "superseded delivery rejects successor packages from another WorkRequest", %{repo: repo} do
    work_request = create_work_request!(repo, id: "WR-DELIVERY-SUCCESSOR-PACKAGE-SCOPE", status: "ready_for_slicing")
    work_package = create_work_package!(repo, work_request, id: "WRS-DELIVERY-SUCCESSOR-PACKAGE-SCOPED")

    other_request = create_work_request!(repo, id: "WR-DELIVERY-OTHER-SUCCESSOR", status: "ready_for_slicing")
    other_successor = create_dispatched_successor_slice!(repo, other_request, "OTHER-SUCCESSOR")

    assert {:error, :not_found} =
             Repository.record_work_package_delivery(
               repo,
               work_request.id,
               work_package.id,
               delivery_attrs(%{
                 outcome: "superseded",
                 successor_work_package_id: other_successor.id,
                 superseded_reason: "A successor must belong to the same WorkRequest."
               })
             )

    assert repo.aggregate(WorkPackageDelivery, :count, :id) == 0
  end

  defp create_work_request!(repo, overrides \\ []) do
    assert {:ok, work_request} = Repository.create(repo, work_request_attrs(overrides))
    work_request
  end

  defp create_work_package!(repo, work_request, overrides) do
    assert {:ok, work_package} = CanonicalWorkPackageFixtures.add_work_package(repo, work_request.id, work_package_attrs(overrides))
    work_package
  end

  defp create_dispatched_successor_slice!(repo, work_request, suffix) do
    work_request
    |> then(&create_work_package!(repo, &1, id: "SYMPP-DELIVERY-#{suffix}"))
    |> then(&dispatch_work_package!(repo, &1))
  end

  defp dispatch_work_package!(repo, work_package) do
    repo.update!(
      Ecto.Changeset.change(work_package,
        status: "ready_for_worker",
        dispatched_at: DateTime.utc_now(:microsecond)
      )
    )
  end

  defp work_request_attrs(overrides) do
    defaults = %{
      id: "WR-#{System.unique_integer([:positive])}",
      title: "Improve work-package delivery",
      repo: "nextide/example",
      base_branch: "main",
      work_type: "feature",
      human_description: "Record work-package delivery truth.",
      constraints: %{"allowed_paths" => ["elixir/lib"], "forbidden_paths" => [], "requires_secret" => false},
      desired_dispatch_shape: "architect_led_feature_branch"
    }

    Enum.into(overrides, defaults)
  end

  defp work_package_attrs(overrides) do
    defaults = %{
      title: "Add work-package delivery storage",
      goal: "Persist one authoritative delivery outcome for the WorkPackage.",
      kind: "mcp",
      base_branch: "main",
      branch_pattern: "feat/del-01-work-package-delivery-schema",
      allowed_file_globs: ["elixir/lib/symphony_elixir/symphony_plus_plus/work_requests/*.ex"],
      forbidden_file_globs: ["elixir/assets/**"],
      acceptance_criteria: ["Delivery outcome persists independently of raw work-package status."],
      validation_steps: ["mix test test/symphony_elixir/symphony_plus_plus/work_request_work_package_deliveries_test.exs"],
      review_requirement: %{"type" => "review-suite", "args" => %{"mode" => "normal"}},
      stop_conditions: ["Do not add terminal work-package statuses."]
    }

    Enum.into(overrides, defaults)
  end

  defp delivery_attrs(overrides) do
    defaults = %{
      idempotency_key: "delivery-#{System.unique_integer([:positive])}",
      recorded_by: "delivery-worker"
    }

    Enum.into(overrides, defaults)
  end

  defp database_path do
    Path.join(
      System.tmp_dir!(),
      "sympp-work-request-work-package-deliveries-#{System.os_time(:nanosecond)}-#{System.unique_integer([:positive])}.sqlite3"
    )
  end
end
