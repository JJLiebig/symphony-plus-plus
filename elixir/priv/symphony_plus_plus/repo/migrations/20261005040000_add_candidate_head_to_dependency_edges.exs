defmodule SymphonyElixir.SymphonyPlusPlus.Repo.Migrations.AddCandidateHeadToDependencyEdges do
  use Ecto.Migration

  def change do
    alter table(:sympp_product_tree_dependency_edges) do
      add(:candidate_head_sha, :string)
    end
  end
end
