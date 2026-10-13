defmodule SymphonyElixir.SymphonyPlusPlus.Planning.ProgressEvent do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  alias SymphonyElixir.SymphonyPlusPlus.Id
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Redactor

  @payload_depth_limit 8
  @payload_entry_limit 100
  @payload_string_limit 4_000
  @payload_truncated "[truncated]"

  @primary_key {:id, :string, autogenerate: false}
  @foreign_key_type :string

  @spec payload_string_limit() :: pos_integer()
  def payload_string_limit, do: @payload_string_limit

  @type t :: %__MODULE__{
          id: String.t() | nil,
          work_package_id: String.t() | nil,
          summary: String.t() | nil,
          body: String.t() | nil,
          status: String.t() | nil,
          sequence: non_neg_integer() | nil,
          idempotency_key: String.t() | nil,
          idempotency_scope: String.t() | nil,
          actor_id: String.t() | nil,
          actor_type: String.t() | nil,
          access_grant_id: String.t() | nil,
          agent_run_id: String.t() | nil,
          payload: map() | nil,
          created_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "sympp_progress_events" do
    field(:work_package_id, :string)
    field(:summary, :string)
    field(:body, :string)
    field(:status, :string)
    field(:sequence, :integer)
    field(:idempotency_key, :string)
    field(:idempotency_scope, :string, default: "direct")
    field(:actor_id, :string)
    field(:actor_type, :string)
    field(:access_grant_id, :string)
    field(:agent_run_id, :string)
    field(:payload, :map, default: %{})
    field(:created_at, :utc_datetime_usec)

    timestamps(type: :utc_datetime_usec)
  end

  @spec create_changeset(map(), keyword()) :: Ecto.Changeset.t()
  def create_changeset(attrs, opts \\ []) do
    attrs =
      attrs
      |> normalize_keys()
      |> put_new_value("id", stable_id("progress"))
      |> put_new_value("status", "recorded")
      |> put_new_value("payload", %{})
      |> redact_payload()
      |> normalize_idempotency_key()
      |> put_idempotency_scope()
      |> put_new_value("created_at", DateTime.utc_now(:microsecond))

    audit_fields = if Keyword.get(opts, :trusted_audit_metadata, false), do: audit_fields(), else: []

    %__MODULE__{}
    |> cast(attrs, base_fields() ++ audit_fields)
    |> validate_required([:id, :work_package_id, :summary, :status, :sequence, :created_at])
    |> validate_number(:sequence, greater_than_or_equal_to: 1)
    |> validate_nonblank_optional(:idempotency_key)
    |> validate_required([:idempotency_scope])
    |> validate_nonblank_optional(:actor_id)
    |> validate_nonblank_optional(:actor_type)
    |> validate_nonblank_optional(:access_grant_id)
    |> validate_nonblank_optional(:agent_run_id)
    |> unique_constraint(:id, name: :sympp_progress_events_id_unique_index)
    |> unique_constraint(:idempotency_key, name: :sympp_progress_events_scoped_idempotency_key_unique_index)
    |> foreign_key_constraint(:work_package_id)
  end

  defp base_fields do
    [
      :id,
      :work_package_id,
      :summary,
      :body,
      :status,
      :sequence,
      :idempotency_key,
      :idempotency_scope,
      :payload,
      :created_at
    ]
  end

  defp audit_fields do
    [:actor_id, :actor_type, :access_grant_id, :agent_run_id]
  end

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

  defp redact_payload(attrs) do
    Map.update(attrs, "payload", %{}, fn
      nil ->
        %{}

      payload ->
        payload
        |> bound_payload()
        |> Redactor.redact()
        |> Redactor.json_safe()
    end)
  end

  defp bound_payload(payload), do: bound_payload(payload, @payload_depth_limit)

  defp bound_payload(_payload, depth) when depth <= 0, do: @payload_truncated
  defp bound_payload(%DateTime{} = datetime, _depth), do: datetime
  defp bound_payload(%Date{} = date, _depth), do: date
  defp bound_payload(%NaiveDateTime{} = datetime, _depth), do: datetime
  defp bound_payload(%Time{} = time, _depth), do: time
  defp bound_payload(%_{} = struct, depth), do: struct |> Map.from_struct() |> bound_payload(depth)

  defp bound_payload(%{} = map, depth) do
    bounded =
      map
      |> Enum.take(@payload_entry_limit)
      |> Map.new(fn {key, value} -> {key, bound_payload(value, depth - 1)} end)

    if map_size(map) > @payload_entry_limit do
      Map.put(bounded, "__truncated__", true)
    else
      bounded
    end
  end

  defp bound_payload(values, depth) when is_list(values) do
    bounded =
      values
      |> Enum.take(@payload_entry_limit)
      |> Enum.map(&bound_payload(&1, depth - 1))

    if length(values) > @payload_entry_limit do
      bounded ++ [@payload_truncated]
    else
      bounded
    end
  end

  defp bound_payload(value, _depth) when is_binary(value) do
    if String.length(value) > @payload_string_limit do
      String.slice(value, 0, @payload_string_limit) <> @payload_truncated
    else
      value
    end
  end

  defp bound_payload(value, _depth), do: value

  defp normalize_idempotency_key(attrs) do
    Map.update(attrs, "idempotency_key", nil, fn
      value when is_binary(value) -> String.trim(value)
      value -> value
    end)
  end

  defp put_idempotency_scope(attrs) do
    scope =
      case Map.get(attrs, "access_grant_id") do
        value when is_binary(value) and value != "" -> value
        _value -> "direct"
      end

    Map.put(attrs, "idempotency_scope", scope)
  end

  defp validate_nonblank_optional(changeset, field) do
    validate_change(changeset, field, fn ^field, value ->
      if is_binary(value) and String.trim(value) == "" do
        [{field, "cannot be blank"}]
      else
        []
      end
    end)
  end

  defp stable_id(prefix) do
    Id.random(prefix)
  end
end
