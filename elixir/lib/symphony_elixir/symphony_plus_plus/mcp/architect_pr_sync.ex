defmodule SymphonyElixir.SymphonyPlusPlus.MCP.ArchitectPRSync do
  @moduledoc false

  import Ecto.Query, only: [from: 2]
  import SymphonyElixir.SymphonyPlusPlus.MCP.ToolArguments, only: [optional_string_argument: 2]

  alias SymphonyElixir.SymphonyPlusPlus.BaseBranch
  alias SymphonyElixir.SymphonyPlusPlus.Dashboard.OperationalProjection
  alias SymphonyElixir.SymphonyPlusPlus.DashboardPubSub

  alias SymphonyElixir.SymphonyPlusPlus.GitHub.{
    Client,
    DefaultClient,
    MergeReconciler,
    PullRequest,
    PullRequestArtifact,
    PullRequestProgress
  }

  alias SymphonyElixir.SymphonyPlusPlus.Lifecycle.StateMachine
  alias SymphonyElixir.SymphonyPlusPlus.MCP.Session
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Repository, as: PlanningRepository
  alias SymphonyElixir.SymphonyPlusPlus.ProductTree.ExecutionGraph
  alias SymphonyElixir.SymphonyPlusPlus.RepoIdentity
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.{WorkPackage, WorkPackageActivity}
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.DeliveryReconciler

  @handoff_statuses ["ready_for_worker", "active", "reviewing", "ci_waiting", "ready_for_merge"]
  @architect_actor %{grant_role: "architect", capabilities: ["architect:lifecycle.transition"]}

  @spec sync(module(), Session.t(), WorkPackage.t(), map()) :: {:ok, map()} | {:error, term()} | {:tool_error, term()}
  def sync(repo, %Session{} = session, %WorkPackage{} = work_package, arguments)
      when is_map_key(arguments, "url") or is_map_key(arguments, "number") do
    client = Application.get_env(:symphony_elixir, :sympp_github_client, DefaultClient)

    with {:ok, expected_head} <- optional_string_argument(arguments, "head_sha"),
         {:ok, ref} <- PullRequest.parse(arguments, work_package.repo),
         {:ok, metadata} <- Client.fetch_pull_request(client, ref, provider_snapshot: true),
         {:ok, payload} <- PullRequest.provider_snapshot(metadata, ref, expected_head),
         :ok <- require_delivery_scope(work_package, payload),
         :ok <- require_exact_head(payload, expected_head),
         :ok <- require_merge_evidence(payload),
         {:ok, result} <- persist(repo, session, work_package, payload) do
      if PullRequestProgress.merged?(payload) do
        with {:ok, delivery} <- DeliveryReconciler.reconcile_work_package(repo, work_package.id),
             {:ok, updated} <- WorkPackageRepository.get(repo, work_package.id) do
          {:ok, Map.merge(result, %{status: updated.status, delivery_reconciliation: delivery})}
        end
      else
        {:ok, result}
      end
    end
  end

  def sync(repo, %Session{} = session, %WorkPackage{} = work_package, %{"head_sha" => _head} = arguments) do
    with {:ok, state} <- PlanningRepository.get_state(repo, work_package.id),
         {:ok, current} <- PullRequestProgress.current_pr_state(state.progress_events) do
      sync(repo, session, work_package, Map.put(arguments, "url", current.ref.url))
    end
  end

  def sync(repo, %Session{}, %WorkPackage{} = work_package, _arguments) do
    MergeReconciler.reconcile_work_package(repo, work_package.id)
  end

  defp require_delivery_scope(work_package, payload) do
    repo_matches? = RepoIdentity.scope_match?(work_package.repo, payload["repository"], local_path_remotes?: true)
    expected_base = BaseBranch.canonicalize(work_package.base_branch)
    actual_base = BaseBranch.canonicalize(payload["base_branch"])

    cond do
      not repo_matches? -> {:error, :repository_mismatch}
      expected_base != actual_base -> {:error, :base_branch_mismatch}
      true -> :ok
    end
  end

  defp require_exact_head(_payload, nil), do: :ok
  defp require_exact_head(%{"head_sha" => head}, head), do: :ok
  defp require_exact_head(_payload, _head), do: {:error, :provider_head_mismatch}

  defp require_merge_evidence(payload) do
    if PullRequestProgress.merged?(payload), do: PullRequest.validate_merge_evidence(payload), else: :ok
  end

  defp persist(repo, session, work_package, payload) do
    repo.transaction(fn ->
      with :ok <- lock_package(repo, work_package),
           {:ok, current} <- WorkPackageRepository.get(repo, work_package.id),
           :ok <- require_handoff(repo, current, payload),
           :ok <- append_snapshot(repo, session, current, payload),
           {:ok, state} <- PlanningRepository.get_state(repo, current.id),
           {:ok, graph} <- ExecutionGraph.evaluate(repo, current.work_request_id),
           reasons = readiness_reasons(state, graph),
           {:ok, updated} <- reconcile_readiness(repo, current, reasons, payload) do
        %{status: updated.status, head_sha: payload["head_sha"], readiness_reasons: reasons}
      else
        {:error, reason} -> repo.rollback(reason)
      end
    end)
    |> DashboardPubSub.broadcast_changed_on_success()
  end

  defp reconcile_readiness(repo, package, reasons, payload) do
    if PullRequestProgress.merged?(payload), do: {:ok, package}, else: reconcile_readiness(repo, package, reasons)
  end

  defp require_handoff(repo, package, payload) do
    if PullRequestProgress.merged?(payload) do
      with true <- package.status not in ["planned", "skipped", "closed", "abandoned"],
           {:ok, state} <- PlanningRepository.get_state(repo, package.id) do
        case PullRequestProgress.current_pr_state(state.progress_events) do
          {:ok, current} -> if PullRequestProgress.same_pr?(payload, current.ref), do: :ok, else: {:error, :pr_reference_mismatch}
          {:error, :missing_attached_pr} -> :ok
          {:error, reason} -> {:error, reason}
        end
      else
        false -> {:error, :invalid_work_package_status}
        error -> error
      end
    else
      with :ok <- require_unowned(repo, package.id), do: require_mutable_handoff(repo, package, payload)
    end
  end

  defp reconcile_readiness(_repo, %WorkPackage{status: "ready_for_merge"} = package, _reasons), do: {:ok, package}
  defp reconcile_readiness(_repo, package, [_reason | _rest]), do: {:ok, package}

  defp reconcile_readiness(repo, package, []) do
    ready_from = if package.status == "ready_for_worker", do: %{package | status: "active"}, else: package

    with :ok <- validate_activation(package),
         :ok <- StateMachine.validate_ready_transition(ready_from, "ready_for_merge", @architect_actor) do
      WorkPackageRepository.update_status(repo, package.id, package.status, "ready_for_merge")
    end
  end

  defp validate_activation(%WorkPackage{status: "ready_for_worker"} = package),
    do: StateMachine.validate_transition(package, "active", @architect_actor)

  defp validate_activation(_package), do: :ok

  defp lock_package(repo, work_package) do
    query = from(package in WorkPackage, where: package.id == ^work_package.id and package.contract_revision == ^work_package.contract_revision)

    case repo.update_all(query, set: [id: work_package.id]) do
      {1, _rows} -> :ok
      {0, _rows} -> {:error, :stale_contract_revision}
    end
  end

  defp require_unowned(repo, work_package_id) do
    # A stale/missing observation never authorizes accepting over an existing claim.
    runtime = WorkPackageActivity.context(repo, work_package_id).runtime_state
    if runtime.active? or runtime.stale?, do: {:error, :active_runtime}, else: :ok
  end

  defp require_mutable_handoff(repo, %WorkPackage{status: "ready_for_merge"} = work_package, payload) do
    with {:ok, state} <- PlanningRepository.get_state(repo, work_package.id),
         {:ok, current} <- PullRequestProgress.current_pr_state(state.progress_events) do
      if current.payload["head_sha"] == payload["head_sha"] and current.ref.url == payload["url"],
        do: :ok,
        else: {:error, :ready_evidence_immutable}
    end
  end

  defp require_mutable_handoff(_repo, %WorkPackage{status: status}, _payload) when status in @handoff_statuses, do: :ok
  defp require_mutable_handoff(_repo, %WorkPackage{}, _payload), do: {:error, :invalid_work_package_status}

  defp append_snapshot(repo, session, work_package, payload) do
    branch = %{"type" => "branch", "source_tool" => "attach_branch", "branch" => payload["branch"], "head_sha" => payload["head_sha"], "observed_at" => payload["observed_at"]}

    with {:ok, _branch} <- append_event(repo, session, work_package.id, branch, "branch_attached"),
         {:ok, _attachment} <- append_event(repo, session, work_package.id, Map.put(payload, "source_tool", "attach_pr"), "pr_attached"),
         {:ok, _snapshot} <- append_event(repo, session, work_package.id, Map.put(payload, "source_tool", "sync_pr"), "pr_synced"),
         {:ok, _changed?} <- PullRequestArtifact.upsert(repo, work_package.id, payload) do
      :ok
    end
  end

  defp append_event(repo, session, work_package_id, payload, status) do
    fingerprint = :crypto.hash(:sha256, Jason.encode!(payload)) |> Base.encode16(case: :lower)

    PlanningRepository.append_audit_progress_event_for_work_package(repo, session.assignment, work_package_id, %{
      "summary" => "Architect accepted provider PR evidence",
      "status" => status,
      "idempotency_key" => "architect_pr_sync:#{status}:#{fingerprint}",
      "payload" => payload
    })
  end

  defp readiness_reasons(state, graph) do
    existing = Enum.map(OperationalProjection.readiness_failure_reasons(state), & &1["gate"])
    incoming = Enum.filter(graph.effective_edges, &(&1.dependent_work_package_id == state.work_package.id))

    existing ++
      Enum.flat_map(
        [
          {ExecutionGraph.require_ready(graph, state.work_package.id) != :ok, "dependencies_unavailable"},
          {Enum.any?(incoming, &Enum.any?(&1.constraints, fn constraint -> not constraint.input_current end)), "dependency_inputs_stale"}
        ],
        fn {missing?, reason} -> if missing?, do: [reason], else: [] end
      )
  end
end
