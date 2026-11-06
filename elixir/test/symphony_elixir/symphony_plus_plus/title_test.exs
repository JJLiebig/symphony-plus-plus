defmodule SymphonyElixir.SymphonyPlusPlus.TitleTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest

  test "task titles reject excess detail, accept the trimmed limit and preserve legacy titles" do
    limit = String.duplicate("é", 40)
    overlong = limit <> "!"
    guidance = "Title is 41 characters; keep it to 2–5 words (max 40) and put detail in the description."

    for schema <- [WorkRequest, WorkPackage] do
      attrs = %{
        title: "  " <> limit <> "  ",
        kind: "standard_pr",
        repo: "example/repo",
        base_branch: "main",
        work_type: "feature",
        human_description: "Details belong here",
        desired_dispatch_shape: "single_package",
        acceptance_criteria: ["Done"]
      }

      accepted = schema.create_changeset(attrs)
      assert accepted.valid?, inspect(accepted.errors)
      assert Ecto.Changeset.get_change(accepted, :title) == limit

      rejected = schema.create_changeset(%{attrs | title: "  " <> overlong <> "  "})
      assert {^guidance, _} = Keyword.fetch!(rejected.errors, :title)

      stored = Ecto.Changeset.apply_changes(accepted)
      assert {^guidance, _} = stored |> schema.update_changeset(%{title: overlong}) |> Map.fetch!(:errors) |> Keyword.fetch!(:title)

      legacy = %{stored | title: overlong}
      unchanged = schema.update_changeset(legacy, %{})
      assert unchanged.valid?
      assert Ecto.Changeset.get_field(unchanged, :title) == overlong
    end
  end
end
