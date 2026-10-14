defmodule SymphonyElixir.SymphonyPlusPlus.OperationalLineageTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.SymphonyPlusPlus.Dashboard
  alias SymphonyElixir.SymphonyPlusPlus.OperationalLineage
  alias SymphonyElixir.SymphonyPlusPlus.Planning.ProgressEvent
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Repository, as: PlanningRepository
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.WorkPackageFactory

  setup_all do
    database_path = WorkPackageFactory.database_path()

    start_supervised!({Repo, database: database_path, pool_size: 5})
    assert :ok = WorkPackageRepository.migrate(Repo)

    on_exit(fn -> File.rm(database_path) end)

    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    repo.delete_all(ProgressEvent)
    repo.delete_all(WorkPackage)
    :ok
  end

  test "stored recut, successor and oracle lineage preserve branch snapshots and dashboard attention", %{repo: repo} do
    original = create_package!(repo, id: "SYMPP-LINEAGE-ORIGINAL", status: "planning", branch_pattern: "agent/original")
    recut = create_package!(repo, id: "SYMPP-LINEAGE-RECUT", status: "implementing", branch_pattern: "agent/recut")
    replacement = create_package!(repo, id: "SYMPP-LINEAGE-REPLACEMENT", status: "ready_for_worker", branch_pattern: "agent/replacement")
    original_id = original.id
    recut_id = recut.id
    replacement_id = replacement.id

    assert {:ok, recut_relation} =
             OperationalLineage.record_recut_as(repo, original.id, recut.id, %{
               reason: "Original package stopped after implementation direction changed.",
               decision: %{work_request_id: "wr-lineage", decision_id: "decision-recut"},
               oracle_preserved: true
             })

    assert recut_relation.decision["decision_id"] == "decision-recut"

    assert {:ok, _superseded_relation} =
             OperationalLineage.record_superseded_by(repo, original.id, replacement.id, %{
               reason: "Original branch is superseded by a smaller replacement package.",
               decision: %{work_request_id: "wr-lineage", decision_id: "decision-superseded"}
             })

    assert {:ok, _updated_recut} = WorkPackageRepository.update(repo, recut.id, %{"branch_pattern" => "agent/recut-renamed"})

    assert {:ok, original_lineage} = OperationalLineage.get(repo, original.id)
    assert [%{work_package_id: ^recut_id, branch: "agent/recut", oracle_preserved: true}] = original_lineage.recut_as
    assert [%{work_package_id: ^replacement_id, branch: "agent/replacement"}] = original_lineage.superseded_by
    assert Enum.map(original_lineage.successor_work, & &1.work_package_id) == [recut.id, replacement.id]

    assert [
             %{
               key: "original_work_still_open",
               successor_work_package_ids: successor_ids
             }
           ] = original_lineage.cleanup_attention

    assert successor_ids == [recut.id, replacement.id]

    assert {:ok, successor_lineage} = OperationalLineage.get(repo, recut.id)
    assert [%{work_package_id: ^original_id, branch: "agent/original", relationship: "recut_as"}] = successor_lineage.original_work
    assert [%{key: "successor_original_work_still_open", original_work_package_ids: [^original_id]}] = successor_lineage.cleanup_attention

    assert {:ok, _oracle} =
             OperationalLineage.record_oracle_for(repo, original.id, recut.id, %{
               reason: "Preserve original work as the comparison oracle.",
               decision: %{work_request_id: "wr-lineage", decision_id: "decision-oracle"}
             })

    assert {:ok, oracle_lineage} = OperationalLineage.get(repo, original.id)
    assert [%{work_package_id: ^recut_id}] = oracle_lineage.oracle_for
    assert {:ok, target_lineage} = OperationalLineage.get(repo, recut.id)
    assert [%{work_package_id: ^original_id}] = target_lineage.oracle_work

    assert {:ok, card} = Dashboard.card(repo, original)
    assert %{key: "original_work_still_open"} = Enum.find(card.operational_state.attention_items, &(&1.key == "original_work_still_open"))
  end

  test "batched lineage projection only exposes relationships inside the visible package set", %{repo: repo} do
    original =
      create_package!(repo,
        id: "SYMPP-LINEAGE-VISIBLE-ORIGINAL",
        status: "planning",
        branch_pattern: "agent/visible-original"
      )

    successor =
      create_package!(repo,
        id: "SYMPP-LINEAGE-VISIBLE-SUCCESSOR",
        status: "implementing",
        branch_pattern: "agent/visible-successor"
      )

    hidden_successor =
      create_package!(repo,
        id: "SYMPP-LINEAGE-HIDDEN-SUCCESSOR",
        branch_pattern: "agent/hidden-successor",
        base_branch: "hidden"
      )

    hidden_original =
      create_package!(repo,
        id: "SYMPP-LINEAGE-HIDDEN-ORIGINAL",
        branch_pattern: "agent/hidden-original",
        base_branch: "hidden"
      )

    original_id = original.id
    successor_id = successor.id

    assert {:ok, _relation} =
             OperationalLineage.record_recut_as(repo, original.id, successor.id, %{
               reason: "Visible board lineage should stay visible.",
               decision: %{work_request_id: "wr-visible", decision_id: "decision-visible"}
             })

    assert {:ok, _relation} =
             OperationalLineage.record_superseded_by(repo, original.id, hidden_successor.id, %{
               reason: "Hidden successor must not be serialized into scoped boards.",
               decision: %{work_request_id: "wr-visible", decision_id: "decision-hidden-successor"}
             })

    assert {:ok, _relation} =
             OperationalLineage.record_recut_as(repo, hidden_original.id, successor.id, %{
               reason: "Hidden original must not be serialized into scoped boards.",
               decision: %{work_request_id: "wr-visible", decision_id: "decision-hidden-original"}
             })

    assert {:ok, lineages} = OperationalLineage.for_work_packages(repo, [original, successor])
    original_lineage = Map.fetch!(lineages, original.id)
    successor_lineage = Map.fetch!(lineages, successor.id)

    assert [%{work_package_id: ^successor_id}] = original_lineage.successor_work
    assert [%{work_package_id: ^successor_id}] = original_lineage.recut_as
    assert original_lineage.superseded_by == []

    assert [%{work_package_id: ^original_id}] = successor_lineage.original_work
    assert Enum.all?(successor_lineage.original_work, &(&1.work_package_id != hidden_original.id))
  end

  test "scoped lineage reads include backfilled payload source ids", %{repo: repo} do
    source = create_package!(repo, id: "SYMPP-LINEAGE-BACKFILLED-SOURCE", branch_pattern: "agent/backfilled-source")
    target = create_package!(repo, id: "SYMPP-LINEAGE-BACKFILLED-TARGET", branch_pattern: "agent/backfilled-target")
    holder = create_package!(repo, id: "SYMPP-LINEAGE-BACKFILLED-HOLDER", branch_pattern: "agent/backfilled-holder")

    assert {:ok, _event} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: holder.id,
               summary: "Recorded recut_as lineage from backfilled source",
               status: "operational_lineage_recorded",
               idempotency_key: "operational_lineage:recut_as:#{source.id}:#{target.id}:backfilled",
               payload: %{
                 "type" => "operational_lineage",
                 "source_tool" => "record_operational_lineage",
                 "relationship" => "recut_as",
                 "source_work_package_id" => source.id,
                 "source_branch" => source.branch_pattern,
                 "target_work_package_id" => target.id,
                 "target_branch" => target.branch_pattern,
                 "reason" => "Backfilled lineage should be visible from payload source.",
                 "decision" => %{"decision_id" => "decision-backfilled"},
                 "oracle_preserved" => "true"
               }
             })

    assert {:ok, lineage} = OperationalLineage.get(repo, source.id)
    assert [%{work_package_id: target_id, oracle_preserved: true}] = lineage.recut_as
    assert target_id == target.id
  end

  test "redacts token-like reason text before persisting lineage events", %{repo: repo} do
    source = create_package!(repo, id: "SYMPP-LINEAGE-REDACT-SOURCE")
    target = create_package!(repo, id: "SYMPP-LINEAGE-REDACT-TARGET")

    assert {:ok, relationship} =
             OperationalLineage.record_recut_as(repo, source.id, target.id, %{
               reason: "Recut after operator pasted sk-12345678 in context.",
               decision: %{work_request_id: "wr-redact", decision_id: "decision-redact"}
             })

    assert relationship.reason == "Recut after operator pasted [REDACTED] in context."
    assert [%ProgressEvent{payload: %{"reason" => persisted_reason}}] = repo.all(ProgressEvent)
    assert persisted_reason == "Recut after operator pasted [REDACTED] in context."
  end

  test "does not project cleanup attention when related original status is unavailable", %{repo: repo} do
    target = create_package!(repo, id: "SYMPP-LINEAGE-MISSING-TARGET", status: "implementing")

    assert {:ok, _event} =
             PlanningRepository.append_progress_event(repo, %{
               work_package_id: target.id,
               summary: "Recorded recut_as lineage from unavailable original",
               status: "operational_lineage_recorded",
               idempotency_key: "operational_lineage:recut_as:SYMPP-LINEAGE-MISSING-ORIGINAL:#{target.id}",
               payload: %{
                 "type" => "operational_lineage",
                 "source_tool" => "record_operational_lineage",
                 "relationship" => "recut_as",
                 "source_work_package_id" => "SYMPP-LINEAGE-MISSING-ORIGINAL",
                 "source_branch" => "agent/missing-original",
                 "target_work_package_id" => target.id,
                 "target_branch" => target.branch_pattern,
                 "reason" => "Legacy lineage points at missing original package.",
                 "decision" => %{"decision_id" => "decision-missing-original"},
                 "oracle_preserved" => false
               }
             })

    assert {:ok, lineage} = OperationalLineage.get(repo, target.id)
    assert [%{work_package_id: "SYMPP-LINEAGE-MISSING-ORIGINAL", status: nil}] = lineage.original_work
    assert lineage.cleanup_attention == []
  end

  defp create_package!(repo, overrides) do
    assert {:ok, work_package} =
             WorkPackageRepository.create(
               repo,
               WorkPackageFactory.attrs(
                 Keyword.merge(
                   [
                     kind: "mcp",
                     title: "Lineage package",
                     repo: "symphony-plus-plus",
                     base_branch: "main",
                     status: "ready_for_worker",
                     policy_template: "mcp"
                   ],
                   overrides
                 )
               )
             )

    work_package
  end
end
