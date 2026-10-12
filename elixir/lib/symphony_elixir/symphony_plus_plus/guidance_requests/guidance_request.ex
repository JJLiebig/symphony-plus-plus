defmodule SymphonyElixir.SymphonyPlusPlus.GuidanceRequests.GuidanceRequest do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  alias SymphonyElixir.SymphonyPlusPlus.HumanDecisionPrompt
  alias SymphonyElixir.SymphonyPlusPlus.Id

  @primary_key {:id, :string, autogenerate: false}
  @foreign_key_type :string

  @statuses ["open", "answered", "human_info_needed"]
  @create_required_fields [
    :id,
    :work_package_id,
    :requester_grant_id,
    :requested_by,
    :idempotency_key,
    :summary,
    :question,
    :context,
    :status
  ]

  @type t :: %__MODULE__{
          id: String.t() | nil,
          work_package_id: String.t() | nil,
          requester_grant_id: String.t() | nil,
          requested_by: String.t() | nil,
          idempotency_key: String.t() | nil,
          summary: String.t() | nil,
          question: String.t() | nil,
          context: String.t() | nil,
          status: String.t() | nil,
          answer: String.t() | nil,
          answered_by: String.t() | nil,
          answered_at: DateTime.t() | nil,
          human_info_reason: String.t() | nil,
          recommended_language: String.t() | nil,
          decision_prompt: map() | nil,
          blocker_id: String.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "sympp_guidance_requests" do
    field(:work_package_id, :string)
    field(:requester_grant_id, :string)
    field(:requested_by, :string)
    field(:idempotency_key, :string)
    field(:summary, :string)
    field(:question, :string)
    field(:context, :string)
    field(:status, :string)
    field(:answer, :string)
    field(:answered_by, :string)
    field(:answered_at, :utc_datetime_usec)
    field(:human_info_reason, :string)
    field(:recommended_language, :string)
    field(:decision_prompt, :map)
    field(:blocker_id, :string)

    timestamps(type: :utc_datetime_usec)
  end

  @spec statuses() :: [String.t()]
  def statuses, do: @statuses

  @spec create_changeset(map()) :: Ecto.Changeset.t()
  def create_changeset(attrs) do
    attrs =
      attrs
      |> normalize_keys()
      |> put_new_value("id", stable_id())
      |> put_new_value("status", "open")

    %__MODULE__{}
    |> cast(attrs, [
      :id,
      :work_package_id,
      :requester_grant_id,
      :requested_by,
      :idempotency_key,
      :summary,
      :question,
      :context,
      :status,
      :answer,
      :answered_by,
      :answered_at,
      :human_info_reason,
      :recommended_language,
      :decision_prompt,
      :blocker_id
    ])
    |> validate_required(@create_required_fields)
    |> validate_nonblank(@create_required_fields)
    |> validate_inclusion(:status, @statuses)
    |> normalize_decision_prompt()
    |> validate_decision_prompt()
    |> unique_constraint(:id, name: :sympp_guidance_requests_id_unique_index)
    |> unique_constraint(:idempotency_key, name: :sympp_guidance_requests_worker_idempotency_key_unique_index)
    |> foreign_key_constraint(:work_package_id)
    |> foreign_key_constraint(:requester_grant_id)
  end

  @spec answer_changeset(t(), map()) :: Ecto.Changeset.t()
  def answer_changeset(%__MODULE__{} = guidance_request, attrs) do
    guidance_request
    |> cast(normalize_keys(attrs), [:status, :answer, :answered_by, :answered_at])
    |> validate_required([:status, :answer, :answered_by, :answered_at])
    |> validate_nonblank([:answer, :answered_by])
    |> validate_inclusion(:status, @statuses)
  end

  @spec escalate_changeset(t(), map()) :: Ecto.Changeset.t()
  def escalate_changeset(%__MODULE__{} = guidance_request, attrs) do
    guidance_request
    |> cast(normalize_keys(attrs), [:status, :human_info_reason, :recommended_language, :decision_prompt, :blocker_id])
    |> validate_required([:status, :human_info_reason, :recommended_language])
    |> validate_nonblank([:human_info_reason, :recommended_language])
    |> validate_inclusion(:status, @statuses)
    |> normalize_decision_prompt()
    |> validate_decision_prompt()
  end

  defp normalize_decision_prompt(changeset) do
    case get_change(changeset, :decision_prompt) do
      nil ->
        changeset

      prompt ->
        case HumanDecisionPrompt.normalize(prompt) do
          {:ok, normalized} -> put_change(changeset, :decision_prompt, normalized)
          {:error, _reason} -> changeset
        end
    end
  end

  defp validate_decision_prompt(changeset) do
    validate_change(changeset, :decision_prompt, fn :decision_prompt, prompt ->
      case HumanDecisionPrompt.normalize(prompt) do
        {:ok, _normalized} -> []
        {:error, reason} -> [decision_prompt: HumanDecisionPrompt.error_message(reason)]
      end
    end)
  end

  defp validate_nonblank(changeset, fields) do
    Enum.reduce(fields, changeset, &validate_nonblank_field/2)
  end

  defp validate_nonblank_field(field, changeset), do: validate_change(changeset, field, &nonblank_errors/2)

  defp nonblank_errors(field, value) when is_binary(value) do
    if String.trim(value) == "", do: [{field, "cannot be blank"}], else: []
  end

  defp nonblank_errors(_field, _value), do: []

  defp normalize_keys(attrs) when is_map(attrs) do
    Map.new(attrs, fn {key, value} -> {normalize_key(key), value} end)
  end

  defp normalize_key(key) when is_atom(key), do: Atom.to_string(key)
  defp normalize_key(key), do: to_string(key)

  defp put_new_value(attrs, key, value) do
    if Map.get(attrs, key) in [nil, ""] do
      Map.put(attrs, key, value)
    else
      attrs
    end
  end

  defp stable_id do
    Id.random("guidance")
  end
end
