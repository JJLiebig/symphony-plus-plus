defmodule SymphonyElixir.SymphonyPlusPlus.WorkRequestClarificationsTest do
  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.ClarificationQuestion
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.DecisionLogEntry
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.WorkRequest

  defmodule RetryRepo do
    alias Ecto.Changeset

    def transaction(fun) do
      Process.put(:transaction_attempts, Process.get(:transaction_attempts, 0) + 1)

      if Process.get(:transient_error) == :database_busy and transient_failure?() do
        {:error, :database_busy}
      else
        {:ok, fun.()}
      end
    catch
      {:rollback, reason} -> {:error, reason}
    end

    def one(_query), do: 0
    def update_all(_query, _updates), do: {0, []}

    def insert(%Changeset{} = changeset) do
      Process.put(:insert_attempts, Process.get(:insert_attempts, 0) + 1)

      if Process.get(:transient_error) == :sequence_conflict and transient_failure?() do
        raise %Ecto.ConstraintError{
          type: :unique,
          constraint: Process.get(:sequence_conflict_name),
          message: "sequence conflict"
        }
      else
        {:ok, Changeset.apply_changes(changeset)}
      end
    end

    def rollback(reason), do: throw({:rollback, reason})

    defp transient_failure? do
      failures_left = Process.get(:transient_failures_left, 0)

      if failures_left > 0 do
        Process.put(:transient_failures_left, failures_left - 1)
        true
      else
        false
      end
    end
  end

  setup_all do
    database_path = database_path()

    start_supervised!({Repo, database: database_path, pool_size: 1})
    assert :ok = Repository.migrate(Repo)

    on_exit(fn -> File.rm(database_path) end)

    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    repo.delete_all(DecisionLogEntry)
    repo.delete_all(ClarificationQuestion)
    repo.delete_all(WorkRequest)
    :ok
  end

  test "rejects duplicate ids invalid values and missing WorkRequest foreign keys", %{repo: repo} do
    work_request = create_work_request!(repo)

    assert {:ok, question} = Repository.ask_question(repo, work_request.id, question_attrs(id: "WRQ-DUPLICATE"))
    assert question.id == "WRQ-DUPLICATE"
    assert {:error, :id_already_exists} = Repository.ask_question(repo, work_request.id, question_attrs(id: "WRQ-DUPLICATE"))

    assert {:error, {:constraint_failed, "foreign_key"}} =
             Repository.ask_question(repo, "WR-MISSING", question_attrs(id: "WRQ-MISSING-PARENT"))

    assert {:ok, decision} = Repository.record_decision(repo, work_request.id, decision_attrs(id: "WRD-DUPLICATE"))
    assert decision.id == "WRD-DUPLICATE"
    assert {:error, :id_already_exists} = Repository.record_decision(repo, work_request.id, decision_attrs(id: "WRD-DUPLICATE"))

    assert {:error, %Ecto.Changeset{} = source_type_changeset} =
             Repository.record_decision(repo, work_request.id, decision_attrs(source_type: "bot"))

    assert "is invalid" in errors_on(source_type_changeset).source_type

    assert {:error, {:constraint_failed, "foreign_key"}} =
             Repository.record_decision(repo, "WR-MISSING", decision_attrs(id: "WRD-MISSING-PARENT"))
  end

  test "retries repeated sequence conflicts and database busy responses" do
    with_sequence_retry_attempts(5, fn ->
      assert {{:ok, %ClarificationQuestion{} = question}, transaction_attempts, insert_attempts} =
               with_transient_failures(
                 :sequence_conflict,
                 3,
                 [constraint: "sympp_work_request_questions_work_request_sequence_unique_index"],
                 fn ->
                   Repository.ask_question(RetryRepo, "WR-RETRY", question_attrs(id: "WRQ-RETRY"))
                 end
               )

      assert question.id == "WRQ-RETRY"
      assert question.sequence == 1
      assert transaction_attempts == 4
      assert insert_attempts == 4

      assert {{:ok, %DecisionLogEntry{} = decision}, transaction_attempts, insert_attempts} =
               with_transient_failures(:database_busy, 2, [], fn ->
                 Repository.record_decision(RetryRepo, "WR-RETRY", decision_attrs(id: "WRD-RETRY"))
               end)

      assert decision.id == "WRD-RETRY"
      assert decision.sequence == 1
      assert transaction_attempts == 3
      assert insert_attempts == 1
    end)
  end

  test "returns explicit terminal errors after exhausting sequence retries" do
    with_sequence_retry_attempts(2, fn ->
      assert {{:error, :sequence_conflict}, transaction_attempts, insert_attempts} =
               with_transient_failures(
                 :sequence_conflict,
                 3,
                 [constraint: "sympp_work_request_questions_work_request_sequence_unique_index"],
                 fn ->
                   Repository.ask_question(RetryRepo, "WR-EXHAUSTED", question_attrs(id: "WRQ-EXHAUSTED"))
                 end
               )

      assert transaction_attempts == 3
      assert insert_attempts == 3

      assert {{:error, :database_busy}, transaction_attempts, insert_attempts} =
               with_transient_failures(:database_busy, 3, [], fn ->
                 Repository.record_decision(RetryRepo, "WR-EXHAUSTED", decision_attrs(id: "WRD-EXHAUSTED"))
               end)

      assert transaction_attempts == 3
      assert insert_attempts == 0
    end)
  end

  test "deleting a WorkRequest deletes its clarification and decision records", %{repo: repo} do
    work_request = create_work_request!(repo)
    assert {:ok, _question} = Repository.ask_question(repo, work_request.id, question_attrs())
    assert {:ok, _decision} = Repository.record_decision(repo, work_request.id, decision_attrs())

    repo.delete!(work_request)

    assert {:ok, []} = Repository.list_questions(repo, work_request.id)
    assert {:ok, []} = Repository.list_decisions(repo, work_request.id)
  end

  test "migration is idempotent and creates primary keys plus WorkRequest sequence indexes", %{repo: repo} do
    assert :ok = Repository.migrate(repo)

    assert_primary_key(repo, "sympp_work_request_clarification_questions")
    assert_primary_key(repo, "sympp_work_request_decision_logs")

    question_indexes = index_names(repo, "sympp_work_request_clarification_questions")
    decision_indexes = index_names(repo, "sympp_work_request_decision_logs")

    assert "sympp_work_request_questions_id_unique_index" in question_indexes
    assert "sympp_work_request_questions_work_request_sequence_unique_index" in question_indexes
    assert "sympp_work_request_questions_work_request_status_index" in question_indexes
    assert "sympp_work_request_decision_logs_id_unique_index" in decision_indexes
    assert "sympp_work_request_decision_logs_work_request_sequence_unique_index" in decision_indexes
    assert "sympp_work_request_decision_logs_work_request_source_index" in decision_indexes
  end

  defp create_work_request!(repo, overrides \\ []) do
    assert {:ok, work_request} = Repository.create(repo, work_request_attrs(overrides))
    work_request
  end

  defp work_request_attrs(overrides) do
    defaults = %{
      id: "WR-#{System.unique_integer([:positive])}",
      title: "Improve intake flow",
      repo: "nextide/example",
      base_branch: "main",
      work_type: "feature",
      human_description: "Record the human's desired outcome before slicing.",
      constraints: %{"allowed_paths" => ["elixir/lib"], "forbidden_paths" => [], "requires_secret" => false},
      desired_dispatch_shape: "single_package"
    }

    Enum.into(overrides, defaults)
  end

  defp question_attrs(overrides \\ []) do
    defaults = %{
      category: "scope",
      question: "Which branch should this target?",
      why_needed: "The architect needs the target before slicing."
    }

    Enum.into(overrides, defaults)
  end

  defp decision_attrs(overrides \\ []) do
    defaults = %{
      source_type: "architect",
      decision: "Keep this WorkRequest narrow.",
      rationale: "The next slice owns broader orchestration.",
      scope_impact: "No new runtime tools.",
      created_by: "architect-1"
    }

    Enum.into(overrides, defaults)
  end

  defp with_sequence_retry_attempts(attempts, fun) do
    key = :sympp_work_request_sequence_retry_attempts
    previous = Application.get_env(:symphony_elixir, key)
    Application.put_env(:symphony_elixir, key, attempts)

    try do
      fun.()
    after
      if is_nil(previous) do
        Application.delete_env(:symphony_elixir, key)
      else
        Application.put_env(:symphony_elixir, key, previous)
      end
    end
  end

  defp with_transient_failures(kind, count, opts, fun) do
    Process.put(:transient_error, kind)
    Process.put(:transient_failures_left, count)
    Process.put(:sequence_conflict_name, Keyword.get(opts, :constraint))
    Process.put(:transaction_attempts, 0)
    Process.put(:insert_attempts, 0)

    try do
      {fun.(), Process.get(:transaction_attempts), Process.get(:insert_attempts)}
    after
      Process.delete(:transient_error)
      Process.delete(:transient_failures_left)
      Process.delete(:sequence_conflict_name)
      Process.delete(:transaction_attempts)
      Process.delete(:insert_attempts)
    end
  end

  defp assert_primary_key(repo, table) do
    %{rows: table_rows} = SQL.query!(repo, "PRAGMA table_info(#{table})")
    assert [_cid, "id", _type, _not_null, _default, 1] = Enum.find(table_rows, &(Enum.at(&1, 1) == "id"))
  end

  defp index_names(repo, table) do
    %{rows: index_rows} = SQL.query!(repo, "PRAGMA index_list(#{table})")
    Enum.map(index_rows, &Enum.at(&1, 1))
  end

  defp database_path do
    Path.join(
      System.tmp_dir!(),
      "sympp-work-request-clarifications-#{System.os_time(:nanosecond)}-#{System.unique_integer([:positive])}.sqlite3"
    )
  end

  defp errors_on(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {message, options} ->
      Enum.reduce(options, message, fn {key, value}, acc ->
        String.replace(acc, "%{#{key}}", inspect(value))
      end)
    end)
  end
end
