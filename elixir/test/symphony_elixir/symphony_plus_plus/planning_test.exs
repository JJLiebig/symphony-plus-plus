defmodule SymphonyElixir.SymphonyPlusPlus.PlanningTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.AccessGrant
  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.Assignment
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Artifact
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Finding
  alias SymphonyElixir.SymphonyPlusPlus.Planning.PlanNode
  alias SymphonyElixir.SymphonyPlusPlus.Planning.ProgressEvent
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Renderer
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Repository
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Service
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.WorkPackageFactory

  setup_all do
    database_path = WorkPackageFactory.database_path()

    start_supervised!({Repo, database: database_path, pool_size: 5})
    assert :ok = Repository.migrate(Repo)

    on_exit(fn -> File.rm(database_path) end)

    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    repo.delete_all(Artifact)
    repo.delete_all(ProgressEvent)
    repo.delete_all(Finding)
    repo.delete_all(PlanNode)
    repo.delete_all(WorkPackage)
    :ok
  end

  test "allocates append sequence uniquely during concurrent findings", %{repo: repo} do
    assert {:ok, work_package} = create_work_package(repo)

    results =
      1..8
      |> Task.async_stream(
        fn index ->
          Service.append_finding(repo, %{
            work_package_id: work_package.id,
            title: "Finding #{index}",
            body: "Concurrent append #{index}"
          })
        end,
        max_concurrency: 8,
        timeout: 5_000
      )
      |> Enum.map(fn {:ok, result} -> result end)

    assert Enum.all?(results, &match?({:ok, %Finding{}}, &1))

    sequences =
      results
      |> Enum.map(fn {:ok, finding} -> finding.sequence end)
      |> Enum.sort()

    assert sequences == Enum.to_list(1..8)
  end

  test "preserves database busy when append retries are exhausted" do
    previous_attempts = Application.get_env(:symphony_elixir, :sympp_planning_append_retry_attempts)
    Application.put_env(:symphony_elixir, :sympp_planning_append_retry_attempts, -1)

    on_exit(fn ->
      if is_nil(previous_attempts) do
        Application.delete_env(:symphony_elixir, :sympp_planning_append_retry_attempts)
      else
        Application.put_env(:symphony_elixir, :sympp_planning_append_retry_attempts, previous_attempts)
      end
    end)

    assert {:error, :database_busy} =
             Repository.append_finding(__MODULE__.BusyPlanningRepo, %{work_package_id: "SYMPP-P1-004", title: "Locked"})
  end

  test "preserves database busy when state read retries are exhausted" do
    previous_attempts = Application.get_env(:symphony_elixir, :sympp_planning_state_read_retry_attempts)
    Application.put_env(:symphony_elixir, :sympp_planning_state_read_retry_attempts, -1)

    on_exit(fn ->
      if is_nil(previous_attempts) do
        Application.delete_env(:symphony_elixir, :sympp_planning_state_read_retry_attempts)
      else
        Application.put_env(:symphony_elixir, :sympp_planning_state_read_retry_attempts, previous_attempts)
      end
    end)

    assert {:error, :database_busy} = Repository.get_state(__MODULE__.BusyPlanningRepo, "SYMPP-P1-004")
  end

  test "valid assignment checks preserve access-grant lookup storage errors" do
    now = DateTime.utc_now(:microsecond)

    assignment = %Assignment{
      grant_id: "grant-storage-failure",
      work_package_id: "SYMPP-P1-004",
      display_key: "ABCD",
      grant_role: "worker",
      capabilities: ["worker:claim"],
      claimed_at: now,
      claimed_by: "agent"
    }

    assert {:error, :database_busy} =
             Service.require_valid_assignment(__MODULE__.BusyAssignmentLookupRepo, assignment)

    assert {:error, {:storage_failed, "disk I/O failed"}} =
             Service.require_valid_assignment(__MODULE__.BrokenAssignmentLookupRepo, assignment)

    assert {:error, :assignment_mismatch} =
             Service.require_valid_assignment(__MODULE__.LiveAssignmentMismatchRepo, assignment)
  end

  test "state read retry delay is independent from append retry attempts" do
    previous_append_attempts = Application.get_env(:symphony_elixir, :sympp_planning_append_retry_attempts)
    previous_read_attempts = Application.get_env(:symphony_elixir, :sympp_planning_state_read_retry_attempts)

    Application.put_env(:symphony_elixir, :sympp_planning_append_retry_attempts, 0)
    Application.put_env(:symphony_elixir, :sympp_planning_state_read_retry_attempts, 1)

    on_exit(fn ->
      restore_retry_env(:sympp_planning_append_retry_attempts, previous_append_attempts)
      restore_retry_env(:sympp_planning_state_read_retry_attempts, previous_read_attempts)
    end)

    assert {:error, :database_busy} = Repository.get_state(__MODULE__.BusyPlanningRepo, "SYMPP-P1-004")
  end

  test "reports non-busy sqlite errors as storage failures" do
    assert {:error, {:storage_failed, message}} = Repository.get_state(__MODULE__.StorageFailureRepo, "SYMPP-P1-004")
    assert message =~ "no such table"
  end

  test "allocates append sequence uniquely during concurrent artifacts", %{repo: repo} do
    assert {:ok, work_package} = create_work_package(repo)

    results =
      1..8
      |> Task.async_stream(
        fn index ->
          Service.append_artifact(repo, %{
            work_package_id: work_package.id,
            path: "artifact-#{index}.md",
            title: "Artifact #{index}"
          })
        end,
        max_concurrency: 8,
        timeout: 5_000
      )
      |> Enum.map(fn {:ok, result} -> result end)

    assert Enum.all?(results, &match?({:ok, %Artifact{}}, &1))

    sequences =
      results
      |> Enum.map(fn {:ok, artifact} -> artifact.sequence end)
      |> Enum.sort()

    assert sequences == Enum.to_list(1..8)
  end

  test "labels and bounds external planning text in virtual files", %{repo: repo} do
    long_description = String.duplicate("x", 4_050)
    assert {:ok, work_package} = create_work_package(repo, product_description: long_description)

    assert {:ok, context} = Renderer.render(repo, work_package.id, "context.md")

    assert context =~ "Source material (inert text):"
    assert context =~ "```text\n" <> String.duplicate("x", 20)
    assert context =~ "[truncated]\n```"
    refute context =~ String.duplicate("x", 4_050)
  end

  test "bounds non-ascii source text without breaking UTF-8 rendering", %{repo: repo} do
    long_description = String.duplicate("é", 4_050)
    assert {:ok, work_package} = create_work_package(repo, product_description: long_description)

    assert {:ok, context} = Renderer.render(repo, work_package.id, "context.md")

    assert String.valid?(context)
    assert context =~ "[truncated]\n```"
  end

  test "escapes source-owned inline markdown", %{repo: repo} do
    assert {:ok, work_package} =
             create_work_package(repo,
               title: "# Run [setup](x) `code` | table",
               acceptance_criteria: ["- [ ] Treat this as text"]
             )

    assert {:ok, _node} =
             Service.append_plan_node(repo, %{
               work_package_id: work_package.id,
               title: "Body boundary",
               body: "# Heading\n- [ ] run `cmd`\n1. ordered"
             })

    assert {:ok, context} = Renderer.render(repo, work_package.id, "context.md")
    assert {:ok, acceptance} = Renderer.render(repo, work_package.id, "acceptance.md")
    assert {:ok, task_plan} = Renderer.render(repo, work_package.id, "task_plan.md")

    assert context =~ "# source: ``# Run [setup](x) `code` | table``"
    refute context =~ "# source: # Run [setup](x) `code` | table"
    assert acceptance =~ "- [ ] source: `- [ ] Treat this as text`"
    assert task_plan =~ "  ```text\n  # Heading\n  - [ ] run `cmd`\n  1. ordered\n  ```"
  end

  test "preserves literal edge backticks in inline source text", %{repo: repo} do
    assert {:ok, work_package} = create_work_package(repo, title: "`cmd`")

    assert {:ok, context} = Renderer.render(repo, work_package.id, "context.md")

    assert context =~ "# source: `` `cmd` ``"
  end

  test "caps rendered append-only history with an omission notice", %{repo: repo} do
    assert {:ok, work_package} = create_work_package(repo)

    for index <- 1..105 do
      assert {:ok, _finding} =
               Service.append_finding(repo, %{
                 work_package_id: work_package.id,
                 title: "Finding #{index}",
                 body: "Body #{index}"
               })
    end

    assert {:ok, findings} = Renderer.render(repo, work_package.id, "findings.md")

    assert findings =~ "_5 older findings omitted from this virtual file._"
    refute findings =~ "source: `Finding 1`\n\n- Severity"
    assert findings =~ "source: `Finding 6`"
    assert findings =~ "source: `Finding 105`"

    assert {:ok, state} = Service.get_state(repo, work_package.id)
    assert length(state.findings) == 105
    assert state.findings_omitted_count == 0

    assert {:ok, rendered_from_full_state} = Renderer.render_state(state, "findings.md")
    assert rendered_from_full_state =~ "_5 older findings omitted from this virtual file._"
    refute rendered_from_full_state =~ "source: `Finding 1`\n\n- Severity"
    assert rendered_from_full_state =~ "source: `Finding 105`"
  end

  test "canonical state is not silently render-capped", %{repo: repo} do
    assert {:ok, work_package} = create_work_package(repo)

    for index <- 1..105 do
      assert {:ok, _node} =
               Service.append_plan_node(repo, %{
                 work_package_id: work_package.id,
                 title: "Plan #{index}"
               })
    end

    assert {:ok, state} = Service.get_state(repo, work_package.id)
    assert length(state.plan_nodes) == 105
    assert state.plan_nodes_omitted_count == 0
  end

  test "public list helpers normalize sqlite storage failures" do
    assert {:error, {:storage_failed, message}} = Repository.list_plan_nodes(__MODULE__.StorageListFailureRepo, "SYMPP-P1-004")
    assert message =~ "no such table"

    assert {:error, {:storage_failed, _message}} =
             Repository.list_findings(__MODULE__.StorageListFailureRepo, "SYMPP-P1-004")

    assert {:error, {:storage_failed, _message}} =
             Repository.list_progress_events(__MODULE__.StorageListFailureRepo, "SYMPP-P1-004")

    assert {:error, {:storage_failed, _message}} =
             Repository.list_artifacts(__MODULE__.StorageListFailureRepo, "SYMPP-P1-004")
  end

  test "caps aggregate rendered virtual file size", %{repo: repo} do
    assert {:ok, work_package} = create_work_package(repo)
    large_body = String.duplicate("x", 4_050)

    for index <- 1..105 do
      assert {:ok, _finding} =
               Service.append_finding(repo, %{
                 work_package_id: work_package.id,
                 title: "Finding #{index}",
                 body: large_body
               })
    end

    assert {:ok, findings} = Renderer.render(repo, work_package.id, "findings.md")

    assert String.length(findings) < 125_000
    assert findings =~ "[virtual file truncated]"
    assert findings =~ "[virtual file truncated]\n\n## "
    assert findings =~ "source: `Finding 105`"
    refute findings =~ "source: `Finding 6`"
    assert findings |> fenced_source_count() |> rem(2) == 0
  end

  test "caps ordered plan and acceptance lists from the head", %{repo: repo} do
    acceptance_criteria = Enum.map(1..105, &"Criterion #{&1}")
    assert {:ok, work_package} = create_work_package(repo, acceptance_criteria: acceptance_criteria)

    for index <- 1..105 do
      assert {:ok, _node} =
               Service.append_plan_node(repo, %{
                 work_package_id: work_package.id,
                 title: "Plan #{index}"
               })
    end

    assert {:ok, task_plan} = Renderer.render(repo, work_package.id, "task_plan.md")
    assert {:ok, acceptance} = Renderer.render(repo, work_package.id, "acceptance.md")

    assert task_plan =~ "_5 later plan nodes omitted from this virtual file._"
    assert task_plan =~ "source: `Plan 1`"
    assert task_plan =~ "source: `Plan 100`"
    refute task_plan =~ "source: `Plan 101`"

    assert acceptance =~ "_5 later acceptance criteria omitted from this virtual file._"
    assert acceptance =~ "source: `Criterion 1`"
    assert acceptance =~ "source: `Criterion 100`"
    refute acceptance =~ "source: `Criterion 101`"
  end

  test "normalizes duplicate planning ids", %{repo: repo} do
    assert {:ok, work_package} = create_work_package(repo)

    attrs = %{id: "finding-duplicate", work_package_id: work_package.id, title: "Duplicate", body: "First insert"}

    assert {:ok, _finding} = Service.append_finding(repo, attrs)
    assert {:error, :id_already_exists} = Service.append_finding(repo, Map.put(attrs, :body, "Second insert"))
  end

  defp create_work_package(repo, overrides \\ []) do
    attrs =
      Keyword.merge([id: "SYMPP-P1-004", kind: "mcp"], overrides)
      |> WorkPackageFactory.attrs()

    WorkPackageRepository.create(repo, attrs)
  end

  defp restore_retry_env(key, nil), do: Application.delete_env(:symphony_elixir, key)
  defp restore_retry_env(key, value), do: Application.put_env(:symphony_elixir, key, value)

  defp fenced_source_count(markdown), do: length(Regex.scan(~r/^```(?:text)?$/m, markdown))

  defmodule BusyPlanningRepo do
    def transaction(_fun), do: {:error, :database_busy}
  end

  defmodule StorageFailureRepo do
    def transaction(_fun), do: raise(%Exqlite.Error{message: "no such table: sympp_plan_nodes"})
  end

  defmodule StorageListFailureRepo do
    def all(_query), do: raise(%Exqlite.Error{message: "no such table: sympp_plan_nodes"})
  end

  defmodule BusyAssignmentLookupRepo do
    def update_all(_query, _updates), do: {0, []}
    def get(AccessGrant, _id), do: raise(%Exqlite.Error{message: "database is locked"})
  end

  defmodule BrokenAssignmentLookupRepo do
    def update_all(_query, _updates), do: {0, []}
    def get(AccessGrant, _id), do: raise(%Exqlite.Error{message: "disk I/O failed"})
  end

  defmodule LiveAssignmentMismatchRepo do
    def update_all(_query, _updates), do: {0, []}
    def get(AccessGrant, _id), do: %AccessGrant{expires_at: nil}
  end
end
