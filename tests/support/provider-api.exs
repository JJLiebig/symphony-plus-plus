# Hosted process entry for public tracker APIs without a daemon HTTP write route.
# No ExUnit, test support, injected client module, repository seed or assertions.
[workflow, operation, arguments] = System.argv()
:ok = SymphonyElixir.Workflow.set_workflow_file_path(workflow)
{:ok, _apps} = Application.ensure_all_started(:req)
arguments = Jason.decode!(arguments)

result =
  case {operation, arguments} do
    {"issues", ids} -> SymphonyElixir.Tracker.fetch_issue_states_by_ids(ids)
    {"comment", [id, body]} -> SymphonyElixir.Tracker.create_comment(id, body)
    {"state", [id, state]} -> SymphonyElixir.Tracker.update_issue_state(id, state)
  end

payload =
  case result do
    :ok -> %{status: "ok"}
    {:ok, issues} -> %{status: "ok", issues: Enum.map(issues, &Map.take(&1, [:id, :state]))}
    {:error, reason} -> %{status: "error", reason: inspect(reason)}
  end

IO.puts(Jason.encode!(%{provider_result: payload}))
