defmodule SymphonyElixir.SymphonyPlusPlus.PlanningTest do
  use ExUnit.Case, async: false

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

  defp fenced_source_count(markdown), do: length(Regex.scan(~r/^```(?:text)?$/m, markdown))
end
