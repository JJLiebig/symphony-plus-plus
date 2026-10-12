defmodule SymphonyElixir.SymphonyPlusPlus.MCP.ArchitectPRSync do
  @moduledoc false

  import Ecto.Query, only: [from: 2]
  import SymphonyElixir.SymphonyPlusPlus.MCP.ToolArguments, only: [required_argument: 2]

  alias SymphonyElixir.SymphonyPlusPlus.BaseBranch
  alias SymphonyElixir.SymphonyPlusPlus.ClaimLeases.ClaimLease
  alias SymphonyElixir.SymphonyPlusPlus.Dashboard.OperationalProjection
  alias SymphonyElixir.SymphonyPlusPlus.DashboardPubSub
  alias SymphonyElixir.SymphonyPlusPlus.GitHub.{Client, DefaultClient, MergeReconciler, PullRequest, PullRequestArtifact, PullRequestProgress}
  alias SymphonyElixir.SymphonyPlusPlus.Lifecycle.StateMachine
  alias SymphonyElixir.SymphonyPlusPlus.MCP.Session
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Repository, as: PlanningRepository
  alias SymphonyElixir.SymphonyPlusPlus.ProductTree.ExecutionGraph
  alias SymphonyElixir.SymphonyPlusPlus.RepoIdentity
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.{WorkPackage, WorkPackageActivity}

  @handoff_statuses ["ready_for_worker", "active", "reviewing", "ci_waiting", "ready_for_merge"]
  @architect_actor %{grant_role: "architect", capabilities: ["architect:lifecycle.transition"]}

  @spec sync(module(), Session.t(), WorkPackage.t(), map()) :: {:ok, map()} | {:error, term()} | {:tool_error, term()}
  def sync(repo, %Session{} = session, %WorkPackage{} = work_package, %{"url" => _url} = arguments) do
    client = Application.get_env(:symphony_elixir, :sympp_github_client, DefaultClient)

    with {:ok, expected_head} <- required_argument(arguments, "head_sha"),
         {:ok, ref} <- PullRequest.parse(arguments, work_package.repo),
         {:ok, metadata} <- Client.fetch_pull_request(client, ref, provider_snapshot: true),
         {:ok, payload} <- PullRequest.provider_snapshot(metadata, ref, expected_head),
         :ok <- require_delivery_scope(work_package, payload),
         :ok <- require_exact_head(payload, expected_head),
         {:ok, result} <- persist(repo, session, work_package, payload) do
      if result.status == "ready_for_merge" and PullRequestProgress.merged?(payload) do
        MergeReconciler.reconcile_work_package(repo, work_package.id)
      else
        {:ok, result}
      end
    end
  end

  def sync(repo, %Session{}, %WorkPackage{} = work_package, _arguments) do
    MergeReconciler.reconcile_work_package(repo, work_package.id)
  end

  defp require_delivery_scope(work_package, payload) do
    cond do
      not RepoIdentity.scope_match?(work_package.repo, payload["repository"]) -> {:error, :repository_mismatch}
      BaseBranch.canonicalize(work_package.base_branch) != BaseBranch.canonicalize(payload["base_branch"]) -> {:error, :base_branch_mismatch}
      true -> :ok
    end
  end

  defp require_exact_head(%{"head_sha" => head}, head), do: :ok
  defp require_exact_head(_payload, _head), do: {:error, :provider_head_mismatch}

  defp persist(repo, session, work_package, payload) do
    repo.transaction(fn ->
      with :ok <- lock_package(repo, work_package),
           :ok <- require_unowned(repo, work_package.id),
           {:ok, current} <- WorkPackageRepository.get(repo, work_package.id),
           :ok <- require_mutable_handoff(repo, current, payload),
           :ok <- append_snapshot(repo, session, current, payload),
           {:ok, state} <- PlanningRepository.get_state(repo, current.id),
           {:ok, graph} <- ExecutionGraph.evaluate(repo, current.work_request_id) do
        reasons = readiness_reasons(state, graph)

        case reconcile_readiness(repo, current, reasons) do
          {:ok, updated} -> %{status: updated.status, head_sha: payload["head_sha"], readiness_reasons: reasons}
          {:error, reason} -> repo.rollback(reason)
        end
      else
        {:error, reason} -> repo.rollback(reason)
      end
    end)
    |> DashboardPubSub.broadcast_changed_on_success()
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
    claimed? = repo.exists?(from(lease in ClaimLease, where: lease.work_package_id == ^work_package_id and lease.status in ["active", "paused"]))
    runtime = WorkPackageActivity.context(repo, work_package_id).runtime_state
    if claimed? or runtime.active_agent_run_ids != [] or runtime.stale_agent_run_ids != [], do: {:error, :active_runtime}, else: :ok
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
    branch = %{"type" => "branch", "source_tool" => "attach_branch", "branch" => payload["branch"], "head_sha" => payload["head_sha"]}

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
