defmodule SymphonyElixir.SymphonyPlusPlus.MCP.Session do
  @moduledoc false

  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.AccessGrant
  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.Assignment
  alias SymphonyElixir.SymphonyPlusPlus.ClaimLeases.ClaimLease
  alias SymphonyElixir.SymphonyPlusPlus.MCP.CurrentWorkRequest

  @enforce_keys [:assignment]
  defstruct [:assignment, :proof_hash, :claim_lease_id, :claim_actor_kind, :claim_actor_id, :claim_actor_display_name]

  @doc false
  def architect_claim_arguments(%__MODULE__{assignment: %{grant_role: "architect"}} = session) do
    case CurrentWorkRequest.id_argument(%{}, session) do
      {:ok, id} -> %{"work_request_id" => id, "claimed_by" => session.assignment.claimed_by}
      _missing_scope -> nil
    end
  end

  def architect_claim_arguments(_session), do: nil

  @public_assignment_fields [
    "grant_id",
    "work_package_id",
    "phase_id",
    "display_key",
    "grant_role",
    "capabilities",
    "claimed_at",
    "claimed_by"
  ]

  @type t :: %__MODULE__{
          assignment: Assignment.t(),
          proof_hash: String.t() | nil,
          claim_lease_id: String.t() | nil,
          claim_actor_kind: String.t() | nil,
          claim_actor_id: String.t() | nil,
          claim_actor_display_name: String.t() | nil
        }

  @spec new(Assignment.t(), keyword()) :: t()
  def new(%Assignment{} = assignment, opts \\ []) do
    %__MODULE__{
      assignment: assignment,
      proof_hash: Keyword.get(opts, :proof_hash),
      claim_lease_id: Keyword.get(opts, :claim_lease_id),
      claim_actor_kind: Keyword.get(opts, :claim_actor_kind),
      claim_actor_id: Keyword.get(opts, :claim_actor_id),
      claim_actor_display_name: Keyword.get(opts, :claim_actor_display_name)
    }
  end

  @spec from_grant(AccessGrant.t(), DateTime.t(), keyword()) :: {:ok, t()} | {:error, term()}
  def from_grant(%AccessGrant{} = grant, %DateTime{} = now, opts \\ []) do
    with :ok <- active_grant?(grant, now),
         :ok <- claimed_grant?(grant),
         {:ok, scopes} <- required_scopes(opts) do
      {:ok,
       new(
         %Assignment{
           grant_id: grant.id,
           work_package_id: grant.work_package_id,
           phase_id: grant.phase_id,
           display_key: grant.display_key,
           grant_role: grant.grant_role,
           capabilities: grant.capabilities,
           claimed_at: grant.claimed_at,
           claimed_by: grant.claimed_by,
           scopes: scopes
         },
         proof_hash: Keyword.get(opts, :proof_hash)
       )}
    end
  end

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(attrs) when is_map(attrs) do
    with {:ok, grant_id} <- required_string(attrs, "grant_id"),
         {:ok, work_package_id} <- nullable_string(attrs, "work_package_id"),
         {:ok, phase_id} <- optional_string(attrs, "phase_id"),
         {:ok, display_key} <- required_string(attrs, "display_key"),
         {:ok, grant_role} <- required_string(attrs, "grant_role"),
         {:ok, capabilities} <- nullable_string_list(attrs, "capabilities"),
         {:ok, claimed_by} <- required_string(attrs, "claimed_by"),
         {:ok, claim_lease_id} <- optional_string(attrs, "claim_lease_id"),
         {:ok, claim_actor_kind} <- optional_string(attrs, "claim_actor_kind"),
         {:ok, claim_actor_id} <- optional_string(attrs, "claim_actor_id"),
         {:ok, claim_actor_display_name} <- optional_string(attrs, "claim_actor_display_name"),
         {:ok, claimed_at} <- optional_datetime(attrs, "claimed_at") do
      {:ok,
       new(
         %Assignment{
           grant_id: grant_id,
           work_package_id: work_package_id,
           phase_id: phase_id,
           display_key: display_key,
           grant_role: grant_role,
           capabilities: capabilities,
           claimed_at: claimed_at,
           claimed_by: claimed_by
         },
         proof_hash: Map.get(attrs, "proof_hash") || Map.get(attrs, :proof_hash),
         claim_lease_id: claim_lease_id,
         claim_actor_kind: claim_actor_kind,
         claim_actor_id: claim_actor_id,
         claim_actor_display_name: claim_actor_display_name
       )}
    end
  end

  @spec with_claim_lease(t(), ClaimLease.t()) :: t()
  def with_claim_lease(%__MODULE__{} = session, %ClaimLease{} = lease) do
    %{
      session
      | claim_lease_id: lease.id,
        claim_actor_kind: lease.actor_kind,
        claim_actor_id: lease.actor_id,
        claim_actor_display_name: lease.actor_display_name
    }
  end

  @spec public_assignment_fields() :: [String.t()]
  def public_assignment_fields, do: @public_assignment_fields

  @spec public_assignment(t()) :: map()
  def public_assignment(%__MODULE__{assignment: %Assignment{} = assignment}) do
    %{
      "grant_id" => assignment.grant_id,
      "work_package_id" => assignment.work_package_id,
      "phase_id" => assignment.phase_id,
      "display_key" => assignment.display_key,
      "grant_role" => assignment.grant_role,
      "capabilities" => assignment.capabilities,
      "claimed_at" => format_datetime(assignment.claimed_at),
      "claimed_by" => assignment.claimed_by
    }
  end

  @spec work_package_id(t()) :: String.t() | nil
  def work_package_id(%__MODULE__{assignment: %Assignment{work_package_id: work_package_id}}), do: work_package_id

  @spec phase_id(t()) :: String.t() | nil
  def phase_id(%__MODULE__{assignment: %Assignment{phase_id: phase_id}}), do: phase_id

  defp format_datetime(%DateTime{} = datetime), do: DateTime.to_iso8601(datetime)
  defp format_datetime(nil), do: nil

  defp active_grant?(%AccessGrant{revoked_at: %DateTime{}}, _now), do: {:error, :revoked}
  defp active_grant?(%AccessGrant{expires_at: nil}, _now), do: :ok

  defp active_grant?(%AccessGrant{expires_at: %DateTime{} = expires_at}, now) do
    if DateTime.compare(expires_at, now) == :gt do
      :ok
    else
      {:error, :expired}
    end
  end

  defp active_grant?(_grant, _now), do: {:error, :expired}

  defp claimed_grant?(%AccessGrant{claimed_at: %DateTime{}, claimed_by: claimed_by}) when is_binary(claimed_by) do
    if String.trim(claimed_by) == "" do
      {:error, :missing_claim_identity}
    else
      :ok
    end
  end

  defp claimed_grant?(_grant), do: {:error, :unclaimed}

  defp required_scopes(opts) do
    case Keyword.fetch(opts, :scopes) do
      {:ok, scopes} when is_list(scopes) -> {:ok, scopes}
      {:ok, _scopes} -> {:error, :invalid_grant_scopes}
      :error -> {:error, :missing_grant_scopes}
    end
  end

  defp required_string(attrs, key) do
    case Map.get(attrs, key) || Map.get(attrs, String.to_atom(key)) do
      value when is_binary(value) ->
        if String.trim(value) == "" do
          {:error, {:blank, key}}
        else
          {:ok, value}
        end

      _value ->
        {:error, {:missing, key}}
    end
  end

  defp nullable_string(attrs, key) do
    case fetch_attr(attrs, key) do
      {:ok, nil} ->
        {:ok, nil}

      {:ok, value} when is_binary(value) ->
        if String.trim(value) == "" do
          {:error, {:blank, key}}
        else
          {:ok, value}
        end

      {:ok, _value} ->
        {:error, {:invalid, key}}

      :error ->
        {:error, {:missing, key}}
    end
  end

  defp optional_string(attrs, key) do
    case Map.get(attrs, key) || Map.get(attrs, String.to_atom(key)) do
      nil ->
        {:ok, nil}

      value when is_binary(value) ->
        if String.trim(value) == "" do
          {:error, {:blank, key}}
        else
          {:ok, value}
        end

      _value ->
        {:error, {:invalid, key}}
    end
  end

  defp nullable_string_list(attrs, key) do
    case fetch_attr(attrs, key) do
      {:ok, nil} ->
        {:ok, nil}

      {:ok, values} when is_list(values) ->
        if Enum.all?(values, &is_binary/1) do
          {:ok, values}
        else
          {:error, {:invalid, key}}
        end

      _value ->
        {:error, {:missing, key}}
    end
  end

  defp optional_datetime(attrs, key) do
    case Map.get(attrs, key) || Map.get(attrs, String.to_atom(key)) do
      nil -> {:ok, nil}
      value when is_binary(value) -> DateTime.from_iso8601(value) |> normalize_datetime_result(key)
      _value -> {:error, {:invalid, key}}
    end
  end

  defp normalize_datetime_result({:ok, datetime, _offset}, _key), do: {:ok, datetime}
  defp normalize_datetime_result({:error, reason}, key), do: {:error, {:invalid, key, reason}}

  defp fetch_attr(attrs, key) do
    atom_key = String.to_atom(key)

    cond do
      Map.has_key?(attrs, key) -> {:ok, Map.get(attrs, key)}
      Map.has_key?(attrs, atom_key) -> {:ok, Map.get(attrs, atom_key)}
      true -> :error
    end
  end
end
