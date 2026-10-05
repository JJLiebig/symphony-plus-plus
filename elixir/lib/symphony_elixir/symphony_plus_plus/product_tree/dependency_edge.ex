defmodule SymphonyElixir.SymphonyPlusPlus.ProductTree.DependencyEdge do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  alias SymphonyElixir.SymphonyPlusPlus.Planning.Redactor
  alias SymphonyElixir.SymphonyPlusPlus.ProductTree.Attrs

  @primary_key {:id, :string, autogenerate: false}
  @foreign_key_type :string

  @ref_kinds ["product_node", "work_package"]
  @edge_kinds ["depends_on", "blocks", "enables", "validates", "replaces", "supersedes", "recut_from", "related"]
  @hard_edge_kinds ["depends_on", "blocks"]

  @type t :: %__MODULE__{
          id: String.t() | nil,
          work_request_id: String.t() | nil,
          source_kind: String.t() | nil,
          source_id: String.t() | nil,
          target_kind: String.t() | nil,
          target_id: String.t() | nil,
          kind: String.t() | nil,
          reason: String.t() | nil,
          candidate_head_sha: String.t() | nil,
          selection_updated_at: DateTime.t() | nil,
          decision_ref: map() | nil,
          created_by: String.t() | nil,
          created_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "sympp_product_tree_dependency_edges" do
    field(:work_request_id, :string)
    field(:source_kind, :string)
    field(:source_id, :string)
    field(:target_kind, :string)
    field(:target_id, :string)
    field(:kind, :string)
    field(:reason, :string)
    field(:candidate_head_sha, :string)
    field(:selection_updated_at, :utc_datetime_usec)
    field(:decision_ref, :map)
    field(:created_by, :string)
    field(:created_at, :utc_datetime_usec)

    timestamps(type: :utc_datetime_usec)
  end

  @spec edge_kinds() :: [String.t()]
  def edge_kinds, do: @edge_kinds

  @spec create_changeset(map()) :: Ecto.Changeset.t()
  def create_changeset(attrs) do
    attrs =
      attrs
      |> Attrs.normalize_keys()
      |> redact_attrs()
      |> Attrs.put_new_value("id", Attrs.stable_id("ptde"))
      |> Attrs.put_new_value("created_at", DateTime.utc_now(:microsecond))

    changeset(%__MODULE__{}, attrs)
  end

  @spec update_changeset(t(), map()) :: Ecto.Changeset.t()
  def update_changeset(%__MODULE__{} = edge, attrs) do
    edge
    |> changeset(attrs |> Attrs.normalize_keys() |> redact_attrs())
  end

  defp changeset(edge, attrs) do
    edge
    |> cast(attrs, [
      :id,
      :work_request_id,
      :source_kind,
      :source_id,
      :target_kind,
      :target_id,
      :kind,
      :reason,
      :candidate_head_sha,
      :decision_ref,
      :created_by,
      :created_at
    ])
    |> validate_required([
      :id,
      :work_request_id,
      :source_kind,
      :source_id,
      :target_kind,
      :target_id,
      :kind,
      :created_at
    ])
    |> validate_inclusion(:source_kind, @ref_kinds)
    |> validate_inclusion(:target_kind, @ref_kinds)
    |> validate_inclusion(:kind, @edge_kinds)
    |> validate_format(:candidate_head_sha, ~r/\A[0-9a-fA-F]{40}\z/)
    |> validate_candidate_prerequisite()
    |> validate_hard_edge_context()
    |> validate_not_self_edge()
    |> stamp_selection_change()
    |> foreign_key_constraint(:work_request_id)
  end

  defp stamp_selection_change(changeset) do
    if Enum.any?([:source_kind, :source_id, :target_kind, :target_id, :kind, :candidate_head_sha], &changed?(changeset, &1)) do
      put_change(changeset, :selection_updated_at, DateTime.utc_now(:microsecond))
    else
      changeset
    end
  end

  defp validate_candidate_prerequisite(changeset) do
    kind = get_field(changeset, :kind)
    prerequisite_kind = get_field(changeset, if(kind == "blocks", do: :source_kind, else: :target_kind))

    if get_field(changeset, :candidate_head_sha) && (kind not in @hard_edge_kinds or prerequisite_kind != "work_package") do
      add_error(changeset, :candidate_head_sha, "requires one concrete prerequisite WorkPackage")
    else
      changeset
    end
  end

  defp redact_attrs(attrs) do
    attrs
    |> Map.update("reason", nil, &Redactor.redact_text/1)
    |> Map.update("created_by", nil, &Redactor.redact_text/1)
    |> Map.update("decision_ref", nil, &(Redactor.redact(&1) |> Redactor.json_safe()))
  end

  defp validate_hard_edge_context(changeset) do
    kind = get_field(changeset, :kind)
    reason = get_field(changeset, :reason)
    decision_ref = get_field(changeset, :decision_ref)

    if kind in @hard_edge_kinds and blank?(reason) and blank?(decision_ref) do
      add_error(changeset, :kind, "hard dependency edges require a reason or decision reference")
    else
      changeset
    end
  end

  defp validate_not_self_edge(changeset) do
    source = {get_field(changeset, :source_kind), get_field(changeset, :source_id)}
    target = {get_field(changeset, :target_kind), get_field(changeset, :target_id)}

    if source == target, do: add_error(changeset, :target_id, "cannot point at the same item"), else: changeset
  end

  defp blank?(value), do: value in [nil, "", %{}]
end
