defmodule SymphonyElixir.SymphonyPlusPlus.GuidanceRequests.Service do
  @moduledoc false

  import Ecto.Query, only: [from: 2]

  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.Assignment
  alias SymphonyElixir.SymphonyPlusPlus.Authorization.ActorResolver
  alias SymphonyElixir.SymphonyPlusPlus.Authorization.Decision
  alias SymphonyElixir.SymphonyPlusPlus.Authorization.Policy
  alias SymphonyElixir.SymphonyPlusPlus.GuidanceRequests.GuidanceRequest
  alias SymphonyElixir.SymphonyPlusPlus.GuidanceRequests.Repository
  alias SymphonyElixir.SymphonyPlusPlus.HumanDecisionPrompt
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Repository, as: PlanningRepository
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Service, as: PlanningService
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage

  @worker_active_statuses ["ready_for_worker", "claimed", "planning", "implementing", "reviewing", "ci_waiting", "blocked"]
  @local_operator_actor "local-operator"

  @type error ::
          Repository.error()
          | PlanningRepository.error()
          | :assignment_mismatch
          | :assignment_revoked
          | :expired
          | :forbidden
          | :idempotency_conflict
          | :invalid_answer_choice
          | :invalid_status
          | :missing_answer
          | :missing_custom_redirect_note
          | :missing_idempotency_key
          | :unauthenticated
          | :work_package_scope_mismatch
          | :work_package_not_worker_active
          | {:authorization_policy_denied, Decision.t()}
  @type local_operator_context :: :local_operator

  @spec create_for_assignment(Repository.repo(), Assignment.t(), map()) ::
          {:ok, GuidanceRequest.t()} | {:error, error()}
  def create_for_assignment(repo, %Assignment{grant_role: "worker"} = assignment, attrs)
      when is_atom(repo) and is_map(attrs) do
    create_for_worker(repo, assignment, attrs)
  end

  def create_for_assignment(repo, _assignment, attrs) when is_atom(repo) and is_map(attrs), do: {:error, :unauthenticated}

  @spec create_for_worker(Repository.repo(), Assignment.t(), map()) :: {:ok, GuidanceRequest.t()} | {:error, error()}
  def create_for_worker(repo, %Assignment{grant_role: "worker"} = assignment, attrs)
      when is_atom(repo) and is_map(attrs) do
    with :ok <-
           authorize_assignment_package_action(repo, assignment, :guidance_request_create, assignment.work_package_id),
         :ok <- PlanningService.require_valid_assignment(repo, assignment),
         attrs <- normalize_keys(attrs),
         {:ok, idempotency_key} <- required_trimmed(attrs, "idempotency_key"),
         request_attrs <- request_attrs(assignment, attrs, idempotency_key) do
      replay_or_create_for_worker(repo, assignment, request_attrs)
    end
  end

  def create_for_worker(repo, _assignment, attrs) when is_atom(repo) and is_map(attrs), do: {:error, :unauthenticated}

  @spec get_for_worker(Repository.repo(), Assignment.t(), String.t()) :: {:ok, GuidanceRequest.t()} | {:error, error()}
  def get_for_worker(repo, %Assignment{grant_role: "worker"} = assignment, id)
      when is_atom(repo) and is_binary(id) do
    with :ok <- PlanningService.require_valid_assignment(repo, assignment),
         {:ok, guidance_request} <- Repository.get(repo, id),
         :ok <- require_worker_scope(guidance_request, assignment) do
      {:ok, guidance_request}
    else
      {:error, :forbidden} -> {:error, :not_found}
      {:error, _reason} = error -> error
    end
  end

  def get_for_worker(repo, _assignment, id) when is_atom(repo) and is_binary(id), do: {:error, :unauthenticated}

  @spec get_for_assignment(Repository.repo(), Assignment.t(), String.t()) :: {:ok, GuidanceRequest.t()} | {:error, error()}
  def get_for_assignment(repo, %Assignment{grant_role: "worker"} = assignment, id)
      when is_atom(repo) and is_binary(id) do
    get_for_worker(repo, assignment, id)
  end

  def get_for_assignment(repo, %Assignment{} = assignment, id) when is_atom(repo) and is_binary(id) do
    with :ok <- PlanningService.require_valid_assignment(repo, assignment),
         {:ok, guidance_request} <- Repository.get(repo, id),
         :ok <- authorize_for_assignment(repo, assignment, :guidance_request_read, guidance_request) do
      {:ok, guidance_request}
    end
  end

  def get_for_assignment(repo, _assignment, id) when is_atom(repo) and is_binary(id), do: {:error, :unauthenticated}

  @spec authorize_for_assignment(Repository.repo(), Assignment.t(), atom(), GuidanceRequest.t()) ::
          :ok | {:error, error()}
  def authorize_for_assignment(repo, %Assignment{} = assignment, action, %GuidanceRequest{} = guidance_request)
      when is_atom(repo) and is_atom(action) do
    authorize_assignment_package_action(repo, assignment, action, guidance_request.work_package_id)
  end

  @spec list_visible_to_architect(Repository.repo(), map()) :: {:ok, [GuidanceRequest.t()]} | {:error, error()}
  def list_visible_to_architect(repo, filters), do: Repository.list_visible_to_architect(repo, filters)

  @spec get_visible_to_architect(Repository.repo(), String.t(), map()) :: {:ok, GuidanceRequest.t()} | {:error, error()}
  def get_visible_to_architect(repo, id, filters) when is_atom(repo) and is_binary(id) and is_map(filters) do
    with {:ok, guidance_request} <- Repository.get(repo, id),
         :ok <- require_architect_scope(repo, guidance_request, filters) do
      {:ok, guidance_request}
    else
      {:error, :forbidden} -> {:error, :not_found}
      {:error, _reason} = error -> error
    end
  end

  @spec answer(Repository.repo(), String.t(), map()) :: {:ok, GuidanceRequest.t()} | {:error, error()}
  def answer(repo, id, attrs), do: Repository.answer(repo, id, attrs)

  @spec answer_human_info_needed_for_local_operator(Repository.repo(), local_operator_context(), String.t(), map()) ::
          {:ok, %{guidance_request: GuidanceRequest.t()}} | {:error, error()}
  def answer_human_info_needed_for_local_operator(repo, :local_operator, id, attrs)
      when is_atom(repo) and is_binary(id) and is_map(attrs) do
    attrs = normalize_keys(attrs)

    repo
    |> run_local_operator_transaction(fn ->
      with {:ok, work_package_id} <- required_trimmed(attrs, "work_package_id", :work_package_scope_mismatch),
           {:ok, guidance_request} <- Repository.get(repo, id),
           :ok <- require_local_operator_scope(guidance_request, work_package_id),
           :ok <- require_human_info_needed(guidance_request),
           {:ok, answer} <- local_operator_answer(guidance_request, attrs),
           :ok <- lock_work_package(repo, guidance_request.work_package_id),
           {:ok, answered} <-
             Repository.answer_human_info_needed(repo, id, %{
               "answer" => answer,
               "answered_by" => @local_operator_actor,
               "answered_at" => DateTime.utc_now(:microsecond)
             }) do
        %{guidance_request: answered}
      else
        {:error, reason} -> repo.rollback(reason)
      end
    end)
    |> unwrap_local_operator_transaction()
  rescue
    error in Exqlite.Error -> normalize_exqlite_error(error)
  end

  def answer_human_info_needed_for_local_operator(repo, _context, id, attrs)
      when is_atom(repo) and is_binary(id) and is_map(attrs),
      do: {:error, :unauthenticated}

  @spec escalate_human_info_needed(Repository.repo(), String.t(), map()) :: {:ok, GuidanceRequest.t()} | {:error, error()}
  def escalate_human_info_needed(repo, id, attrs), do: Repository.escalate_human_info_needed(repo, id, attrs)

  defp run_local_operator_transaction(repo, fun), do: repo.transaction(fun)

  defp unwrap_local_operator_transaction({:ok, %{guidance_request: %GuidanceRequest{}} = result}), do: {:ok, result}
  defp unwrap_local_operator_transaction({:error, reason}), do: {:error, reason}

  defp require_human_info_needed(%GuidanceRequest{status: "human_info_needed"}), do: :ok
  defp require_human_info_needed(%GuidanceRequest{}), do: {:error, :invalid_status}

  defp require_local_operator_scope(%GuidanceRequest{work_package_id: work_package_id}, work_package_id), do: :ok
  defp require_local_operator_scope(%GuidanceRequest{}, _work_package_id), do: {:error, :work_package_scope_mismatch}

  defp replay_or_create_for_worker(repo, %Assignment{} = assignment, attrs) do
    case replay_existing(repo, attrs) do
      {:error, :not_found} ->
        create_new_for_worker(repo, assignment, attrs)

      result ->
        result
    end
  end

  defp create_new_for_worker(repo, %Assignment{} = assignment, attrs) do
    repo
    |> run_create_transaction(fn -> create_new_for_worker_transaction(repo, assignment, attrs) end)
    |> unwrap_create_transaction()
  end

  defp run_create_transaction(repo, fun), do: repo.transaction(fun)

  defp create_new_for_worker_transaction(repo, %Assignment{} = assignment, attrs) do
    with :ok <- lock_worker_active_package(repo, assignment.work_package_id),
         {:ok, guidance_request} <- create_or_replay(repo, attrs) do
      guidance_request
    else
      {:error, reason} -> repo.rollback(reason)
    end
  end

  defp unwrap_create_transaction({:ok, %GuidanceRequest{} = guidance_request}), do: {:ok, guidance_request}
  defp unwrap_create_transaction({:error, reason}), do: {:error, reason}

  defp replay_existing(repo, attrs) do
    case Repository.get_by_idempotency_key(repo, attrs["work_package_id"], attrs["requester_grant_id"], attrs["idempotency_key"]) do
      {:ok, guidance_request} -> replay_or_conflict(guidance_request, attrs)
      {:error, _reason} = error -> error
    end
  end

  defp create_or_replay(repo, attrs) do
    case Repository.get_by_idempotency_key(repo, attrs["work_package_id"], attrs["requester_grant_id"], attrs["idempotency_key"]) do
      {:ok, guidance_request} ->
        replay_or_conflict(guidance_request, attrs)

      {:error, :not_found} ->
        case Repository.create(repo, attrs) do
          {:error, :idempotency_key_conflict} -> replay_after_conflict(repo, attrs)
          result -> result
        end

      {:error, _reason} = error ->
        error
    end
  end

  defp replay_after_conflict(repo, attrs) do
    with {:ok, guidance_request} <-
           Repository.get_by_idempotency_key(repo, attrs["work_package_id"], attrs["requester_grant_id"], attrs["idempotency_key"]) do
      replay_or_conflict(guidance_request, attrs)
    end
  end

  defp replay_or_conflict(%GuidanceRequest{} = guidance_request, attrs) do
    expected =
      Map.take(attrs, [
        "work_package_id",
        "requester_grant_id",
        "idempotency_key",
        "summary",
        "question",
        "context",
        "decision_prompt"
      ])

    actual =
      %{
        "work_package_id" => guidance_request.work_package_id,
        "requester_grant_id" => guidance_request.requester_grant_id,
        "idempotency_key" => guidance_request.idempotency_key,
        "summary" => guidance_request.summary,
        "question" => guidance_request.question,
        "context" => guidance_request.context,
        "decision_prompt" => guidance_request.decision_prompt
      }
      |> Map.reject(fn {_key, value} -> is_nil(value) end)

    if expected == actual, do: {:ok, guidance_request}, else: {:error, :idempotency_conflict}
  end

  defp request_attrs(%Assignment{} = assignment, attrs, idempotency_key) do
    %{
      "work_package_id" => assignment.work_package_id,
      "requester_grant_id" => assignment.grant_id,
      "requested_by" => assignment.claimed_by,
      "idempotency_key" => idempotency_key,
      "summary" => Map.get(attrs, "summary"),
      "question" => Map.get(attrs, "question"),
      "context" => Map.get(attrs, "context"),
      "decision_prompt" => request_decision_prompt(Map.get(attrs, "decision_prompt"))
    }
    |> Map.reject(fn {_key, value} -> is_nil(value) end)
  end

  defp request_decision_prompt(nil), do: nil

  defp request_decision_prompt(prompt) do
    case HumanDecisionPrompt.normalize(prompt) do
      {:ok, normalized} -> normalized
      {:error, _reason} -> prompt
    end
  end

  defp local_operator_answer(%GuidanceRequest{} = guidance_request, attrs) do
    case HumanDecisionPrompt.answer_text_result(guidance_request.decision_prompt, attrs) do
      {:ok, answer} ->
        case String.trim(answer) do
          "" -> {:error, :missing_answer}
          answer -> {:ok, answer}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp require_worker_scope(%GuidanceRequest{} = guidance_request, %Assignment{} = assignment) do
    matching_worker? =
      guidance_request.work_package_id == assignment.work_package_id and
        guidance_request.requester_grant_id == assignment.grant_id

    if matching_worker? do
      :ok
    else
      {:error, :forbidden}
    end
  end

  defp lock_worker_active_package(repo, work_package_id) do
    query =
      from(work_package in WorkPackage,
        where: work_package.id == ^work_package_id,
        where: work_package.status in ^@worker_active_statuses
      )

    case repo.update_all(query, set: [id: work_package_id]) do
      {1, _rows} -> :ok
      {0, _rows} -> worker_active_lock_miss(repo, work_package_id)
    end
  end

  defp worker_active_lock_miss(repo, work_package_id) do
    case WorkPackageRepository.get(repo, work_package_id) do
      {:ok, %WorkPackage{}} -> {:error, :work_package_not_worker_active}
      {:error, _reason} = error -> error
    end
  end

  defp lock_work_package(repo, work_package_id) do
    query =
      from(work_package in WorkPackage,
        where: work_package.id == ^work_package_id
      )

    case repo.update_all(query, set: [id: work_package_id]) do
      {1, _rows} -> :ok
      {0, _rows} -> WorkPackageRepository.get(repo, work_package_id)
    end
    |> case do
      :ok -> :ok
      {:ok, %WorkPackage{}} -> :ok
      {:error, _reason} = error -> error
    end
  end

  defp require_architect_scope(repo, %GuidanceRequest{} = guidance_request, filters) do
    case Repository.list_visible_to_architect(repo, Map.put(filters, "work_package_id", guidance_request.work_package_id)) do
      {:ok, visible} ->
        if Enum.any?(visible, &(&1.id == guidance_request.id)), do: :ok, else: {:error, :forbidden}

      {:error, _reason} = error ->
        error
    end
  end

  defp authorize_assignment_package_action(repo, %Assignment{} = assignment, action, work_package_id) do
    case PlanningService.package_resource_target(repo, work_package_id, :guidance_request) do
      {:ok, target} ->
        actor =
          ActorResolver.from_assignment(assignment, PlanningService.package_surface_actor_opts(assignment, target))

        case Policy.decide(actor, action, target) do
          %Decision{allowed?: true} -> :ok
          %Decision{} = decision -> {:error, {:authorization_policy_denied, decision}}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp required_trimmed(attrs, key) do
    required_trimmed(attrs, key, :missing_idempotency_key)
  end

  defp required_trimmed(attrs, key, error) do
    case Map.get(attrs, key) do
      value when is_binary(value) ->
        case String.trim(value) do
          "" -> {:error, error}
          trimmed -> {:ok, trimmed}
        end

      _value ->
        {:error, error}
    end
  end

  defp normalize_keys(attrs) when is_map(attrs) do
    Map.new(attrs, fn {key, value} -> {normalize_key(key), value} end)
  end

  defp normalize_key(key) when is_atom(key), do: Atom.to_string(key)
  defp normalize_key(key), do: to_string(key)

  defp normalize_exqlite_error(error) do
    message = Exception.message(error)
    normalized_message = String.downcase(message)

    if String.contains?(normalized_message, "busy") or String.contains?(normalized_message, "locked") do
      {:error, :database_busy}
    else
      {:error, {:storage_failed, message}}
    end
  end
end
