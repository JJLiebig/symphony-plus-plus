defmodule SymphonyElixir.SymphonyPlusPlus.AuditEventTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.AccessGrant
  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.Assignment
  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.Service, as: AccessGrantService
  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.WorkKey
  alias SymphonyElixir.SymphonyPlusPlus.Planning.ProgressEvent
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Renderer
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Repository, as: PlanningRepository
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Service, as: PlanningService
  alias SymphonyElixir.SymphonyPlusPlus.Planning.State
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.WorkPackageFactory

  defmodule SecretPayload do
    defstruct [:access_token, :large_blob, :safe]
  end

  setup_all do
    database_path = WorkPackageFactory.database_path()

    start_supervised!({Repo, database: database_path, pool_size: 5})
    assert :ok = PlanningRepository.migrate(Repo)

    on_exit(fn -> File.rm(database_path) end)

    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    repo.delete_all(ProgressEvent)
    repo.delete_all(AccessGrant)
    repo.delete_all(WorkPackage)
    :ok
  end

  test "actor grant and trusted agent run are recorded and exposed in the timeline", %{repo: repo} do
    assert {:ok, assignment} = claimed_assignment(repo, claimed_by: "agent-worker-1")

    assert {:ok, event} =
             PlanningService.append_authenticated_progress_event(
               repo,
               assignment,
               %{
                 idempotency_key: "progress:actor",
                 summary: "Actor update",
                 agent_run_id: "forged-run-123",
                 payload: %{phase: "implementation"}
               },
               agent_run_id: "trusted-run-123"
             )

    assert event.actor_id == "agent-worker-1"
    assert event.actor_type == "worker"
    assert event.access_grant_id == assignment.grant_id
    assert event.agent_run_id == "trusted-run-123"

    assert {:ok, [timeline_item]} = PlanningService.fetch_timeline(repo, assignment)
    assert timeline_item.actor == %{id: "agent-worker-1", type: "worker", access_grant_id: assignment.grant_id}
    assert timeline_item.agent_run_id == "trusted-run-123"
    assert timeline_item.payload == %{"phase" => "implementation"}
  end

  test "timeline fetch requires a valid assignment", %{repo: repo} do
    assert {:ok, assignment} = claimed_assignment(repo)

    assert {:error, :unauthenticated} = PlanningService.fetch_timeline(repo, assignment.work_package_id)

    assert {:error, :assignment_mismatch} =
             PlanningService.fetch_timeline(repo, %{assignment | display_key: "forged-display-key"})

    assert {:ok, _revoked} = AccessGrantService.revoke(repo, assignment.grant_id)
    assert {:error, :assignment_revoked} = PlanningService.fetch_timeline(repo, assignment)
  end

  test "claim grant append with idempotency renders one redacted progress event", %{repo: repo} do
    assert {:ok, work_package} = create_work_package(repo)
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, work_package.id)
    assert {:ok, %Assignment{} = assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")

    attrs = %{
      idempotency_key: "progress:claim-grant",
      summary: "Claimed worker wrote progress",
      body: "Append completed.",
      payload: %{
        safe: "visible",
        claim_secret: minted.work_key.secret,
        nested: %{authorization: "Bearer raw"}
      }
    }

    assert {:ok, first} = PlanningService.append_authenticated_progress_event(repo, assignment, attrs)
    assert {:ok, second} = PlanningService.append_authenticated_progress_event(repo, assignment, attrs)
    assert first.id == second.id
    assert repo.aggregate(ProgressEvent, :count) == 1

    assert first.payload == %{
             "safe" => "visible",
             "claim_secret" => "[REDACTED]",
             "nested" => %{"authorization" => "[REDACTED]"}
           }

    assert {:ok, progress_markdown} = Renderer.render(repo, work_package.id, "progress.md")
    assert progress_markdown =~ "Claimed worker wrote progress"
    assert progress_markdown =~ "worker-1"
    refute progress_markdown =~ "[REDACTED]"
    refute progress_markdown =~ minted.work_key.secret
    refute inspect(first.payload) =~ minted.work_key.secret
  end

  test "progress rendering redacts secret-shaped source text", %{repo: repo} do
    assert {:ok, work_package} = create_work_package(repo)
    secret = WorkKey.generate().secret
    fine_grained_pat = "github_pat_" <> Base.encode16(:crypto.strong_rand_bytes(18), case: :lower)
    query_password = "pw-" <> Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)

    assert {:ok, _event} =
             PlanningService.append_progress_event(repo, %{
               work_package_id: work_package.id,
               idempotency_key: "progress:secret-shaped-source",
               summary: "Worker pasted #{secret} and #{fine_grained_pat} then kept going",
               body: "See https://example.test/download?sig=#{secret}&page=1 then https://example.test/issues/1?w=1 and https://example.test/login?password=#{query_password}&page=1",
               status: "working"
             })

    assert {:ok, progress_markdown} = Renderer.render(repo, work_package.id, "progress.md")

    assert progress_markdown =~ "[REDACTED]"
    assert progress_markdown =~ "Worker pasted [REDACTED] and [REDACTED] then kept going"

    assert progress_markdown =~
             "See https://example.test/download?sig=[REDACTED]&page=1 then https://example.test/issues/1?w=1 and https://example.test/login?password=[REDACTED]&page=1"

    refute progress_markdown =~ secret
    refute progress_markdown =~ fine_grained_pat
    refute progress_markdown =~ query_password
  end

  test "direct progress append also bounds stored payloads", %{repo: repo} do
    assert {:ok, work_package} = create_work_package(repo)

    assert {:ok, event} =
             PlanningService.append_progress_event(repo, %{
               work_package_id: work_package.id,
               idempotency_key: "progress:direct-bounded-payload",
               summary: "Direct bounded payload",
               payload: %{
                 long_text: String.duplicate("b", 5_000),
                 long_list: Enum.to_list(1..120),
                 struct_payload: %SecretPayload{large_blob: String.duplicate("c", 5_000), safe: "visible"}
               }
             })

    assert String.length(event.payload["long_text"]) < 4_100
    assert event.payload["long_text"] =~ "[truncated]"
    assert length(event.payload["long_list"]) == 101
    assert List.last(event.payload["long_list"]) == "[truncated]"
    assert event.payload["struct_payload"]["large_blob"] =~ "[truncated]"
    assert event.payload["struct_payload"]["safe"] == "visible"
  end

  test "progress payload storage and rendering are JSON-safe without dropping colliding keys", %{repo: repo} do
    assert {:ok, work_package} = create_work_package(repo)

    assert {:ok, event} =
             PlanningService.append_progress_event(repo, %{
               work_package_id: work_package.id,
               idempotency_key: "progress:json-safe",
               summary: "JSON-safe payload",
               payload: %{
                 :secret => "raw-atom-secret",
                 "secret" => "raw-string-secret",
                 :Secret => "raw-capital-atom-secret",
                 "Secret" => "raw-capital-string-secret",
                 "x-api-key" => "raw-hyphen-api-key",
                 "x_api_key" => "raw-underscore-api-key",
                 {:tuple, :key} => "tuple-value",
                 "{:tuple, :key}" => "string-tuple-value",
                 1 => "integer-value",
                 "1" => "string-integer-value",
                 :created_at => ~U[2026-05-01 10:00:00Z],
                 :date => ~D[2026-05-01],
                 :naive_datetime => ~N[2026-05-01 10:01:02],
                 :time => ~T[10:01:02],
                 :headers => [{"authorization", "raw-header-token"}]
               }
             })

    assert event.payload ==
             %{
               ":secret" => "[REDACTED]",
               "secret" => "[REDACTED]",
               ":Secret" => "[REDACTED]",
               "Secret" => "[REDACTED]",
               "x-api-key" => "[REDACTED]",
               "x_api_key" => "[REDACTED]",
               "created_at" => "2026-05-01T10:00:00Z",
               "date" => "2026-05-01",
               "naive_datetime" => "2026-05-01T10:01:02",
               "time" => "10:01:02",
               "headers" => [["authorization", "[REDACTED]"]]
             }
             |> Map.merge(Map.take(event.payload, ["{:tuple, :key}", "\"{:tuple, :key}\"", "{:tuple, :key}#2", "1", "\"1\"", "1#2"]))

    assert map_size(event.payload) == 15
    assert Enum.count(Map.values(event.payload), &(&1 == "tuple-value")) == 1
    assert Enum.count(Map.values(event.payload), &(&1 == "string-tuple-value")) == 1
    assert Enum.count(Map.values(event.payload), &(&1 == "integer-value")) == 1
    assert Enum.count(Map.values(event.payload), &(&1 == "string-integer-value")) == 1

    assert {:ok, progress_markdown} = Renderer.render(repo, work_package.id, "progress.md")

    refute progress_markdown =~ "\"created_at\": \"2026-05-01T10:00:00Z\""
    refute progress_markdown =~ "\":secret\": \"[REDACTED]\""
    refute progress_markdown =~ "raw-atom-secret"
    refute progress_markdown =~ "raw-string-secret"
    refute progress_markdown =~ "raw-capital-atom-secret"
    refute progress_markdown =~ "raw-capital-string-secret"
    refute progress_markdown =~ "raw-hyphen-api-key"
    refute progress_markdown =~ "raw-underscore-api-key"
    refute progress_markdown =~ "raw-header-token"
  end

  test "progress rendering escapes audit metadata" do
    state = %State{
      progress_events: [
        %ProgressEvent{
          id: "progress-render",
          work_package_id: "SYMPP-P1-005",
          summary: "Raw append",
          status: "recorded",
          sequence: 1,
          actor_id: "worker-render",
          actor_type: "`worker`\n# actor",
          access_grant_id: "`grant`\n# grant",
          agent_run_id: "`run`\n# injected",
          payload: %{},
          created_at: ~U[2026-05-01 10:00:00Z]
        }
      ],
      progress_events_omitted_count: 0
    }

    assert {:ok, progress_markdown} = Renderer.render_state(state, "progress.md")

    assert progress_markdown =~ "Actor: source:"
    assert progress_markdown =~ "`` `worker` # actor ``"
    refute progress_markdown =~ "Agent run:"
    refute progress_markdown =~ "Grant:"
    refute progress_markdown =~ "`` `grant` # grant ``"
    refute progress_markdown =~ "`` `run` # injected ``"
    refute progress_markdown =~ "\n# injected"
    refute progress_markdown =~ "\n# actor"
    refute progress_markdown =~ "\n# grant"
  end

  test "authenticated append validates assignment against stored grant state", %{repo: repo} do
    assert {:ok, %Assignment{} = assignment} = claimed_assignment(repo)

    forged = %Assignment{
      assignment
      | grant_id: "ag_forged",
        work_package_id: assignment.work_package_id,
        claimed_by: "worker-forged"
    }

    assert {:error, :assignment_mismatch} =
             PlanningService.append_authenticated_progress_event(repo, forged, %{
               idempotency_key: "progress:forged-assignment",
               summary: "Forged"
             })

    mismatched = %{assignment | claimed_by: "worker-forged"}

    assert {:error, :assignment_mismatch} =
             PlanningService.append_authenticated_progress_event(repo, mismatched, %{
               idempotency_key: "progress:mismatched-assignment",
               summary: "Mismatched"
             })

    unclaimed = %{assignment | claimed_at: nil, claimed_by: nil}

    assert {:error, :assignment_mismatch} =
             PlanningService.append_authenticated_progress_event(repo, unclaimed, %{
               idempotency_key: "progress:unclaimed-assignment",
               summary: "Unclaimed"
             })

    assert {:ok, _revoked} = AccessGrantService.revoke(repo, assignment.grant_id)

    assert {:error, :assignment_revoked} =
             PlanningService.append_authenticated_progress_event(repo, assignment, %{
               idempotency_key: "progress:revoked-assignment",
               summary: "Revoked"
             })
  end

  test "mixed atom and string package targets cannot bypass authenticated scope", %{repo: repo} do
    assert {:ok, assignment} = claimed_assignment(repo, claimed_by: "worker-source")

    assert {:error, :work_package_scope_mismatch} =
             PlanningService.append_authenticated_progress_event(repo, assignment, %{
               :work_package_id => assignment.work_package_id,
               "work_package_id" => "forged-package",
               :idempotency_key => "progress:scope-forgery",
               :summary => "Blocked"
             })

    assert repo.aggregate(ProgressEvent, :count) == 0
  end

  test "authenticated append owns id created_at and canonical idempotency", %{repo: repo} do
    assert {:ok, assignment} = claimed_assignment(repo, claimed_by: "worker-source")

    assert {:error, :idempotency_key_conflict} =
             PlanningService.append_authenticated_progress_event(repo, assignment, %{
               :idempotency_key => "progress:owned-fields",
               "idempotency_key" => "progress:other-key",
               :summary => "Conflicting keys"
             })

    assert {:ok, event} =
             PlanningService.append_authenticated_progress_event(repo, assignment, %{
               id: "caller-id",
               idempotency_key: " progress:owned-fields ",
               summary: "Owned fields",
               created_at: ~U[2000-01-01 00:00:00Z]
             })

    assert event.id != "caller-id"
    assert event.idempotency_key == "progress:owned-fields"
    assert DateTime.compare(event.created_at, ~U[2026-01-01 00:00:00Z]) == :gt
  end

  test "authenticated idempotency keys are scoped to each claimed grant", %{repo: repo} do
    assert {:ok, work_package} = create_work_package(repo)
    assert {:ok, first_minted} = AccessGrantService.mint_worker_grant(repo, work_package.id)
    assert {:ok, second_minted} = AccessGrantService.mint_worker_grant(repo, work_package.id)
    assert {:ok, first_assignment} = AccessGrantService.claim(repo, first_minted.work_key.secret, claimed_by: "worker-1")
    assert {:ok, second_assignment} = AccessGrantService.claim(repo, second_minted.work_key.secret, claimed_by: "worker-2")

    assert {:ok, first_event} =
             PlanningService.append_authenticated_progress_event(repo, first_assignment, %{
               idempotency_key: "progress:grant-scoped",
               summary: "Grant scoped",
               payload: %{worker: "one"}
             })

    assert {:ok, second_event} =
             PlanningService.append_authenticated_progress_event(repo, second_assignment, %{
               idempotency_key: "progress:grant-scoped",
               summary: "Other grant",
               status: "blocked",
               payload: %{worker: "two"}
             })

    assert repo.aggregate(ProgressEvent, :count) == 2
    assert first_event.access_grant_id == first_assignment.grant_id
    assert second_event.access_grant_id == second_assignment.grant_id

    assert {:ok, first_timeline} = PlanningService.fetch_timeline(repo, first_assignment)
    assert Enum.map(first_timeline, & &1.id) == [first_event.id, second_event.id]
    assert Enum.find(first_timeline, &(&1.id == first_event.id)).payload == %{"worker" => "one"}
    foreign_first_view = Enum.find(first_timeline, &(&1.id == second_event.id))
    assert foreign_first_view.payload == %{}
    assert foreign_first_view.idempotency_key == nil
    assert foreign_first_view.actor == %{id: nil, type: nil, access_grant_id: nil}
    assert foreign_first_view.status == "[redacted]"
    assert foreign_first_view.summary == "[redacted]"
    assert foreign_first_view.body == nil

    assert {:ok, second_timeline} = PlanningService.fetch_timeline(repo, second_assignment)
    assert Enum.map(second_timeline, & &1.id) == [first_event.id, second_event.id]
    foreign_second_view = Enum.find(second_timeline, &(&1.id == first_event.id))
    assert foreign_second_view.payload == %{}
    assert foreign_second_view.idempotency_key == nil
    assert foreign_second_view.actor == %{id: nil, type: nil, access_grant_id: nil}
    assert foreign_second_view.status == "[redacted]"
    assert foreign_second_view.summary == "[redacted]"
    assert foreign_second_view.body == nil
    assert Enum.find(second_timeline, &(&1.id == second_event.id)).payload == %{"worker" => "two"}
  end

  test "direct and authenticated idempotency keys have separate scopes", %{repo: repo} do
    assert {:ok, assignment} = claimed_assignment(repo)

    assert {:ok, audit_event} =
             PlanningService.append_authenticated_progress_event(repo, assignment, %{
               idempotency_key: "progress:shared-key",
               summary: "Authenticated"
             })

    assert {:ok, direct_event} =
             PlanningService.append_progress_event(repo, %{
               work_package_id: assignment.work_package_id,
               idempotency_key: "progress:shared-key",
               summary: "Direct",
               payload: %{system: "visible"}
             })

    assert audit_event.id != direct_event.id
    assert audit_event.access_grant_id == assignment.grant_id
    assert direct_event.access_grant_id == nil

    assert {:ok, replayed_audit_event} =
             PlanningService.append_authenticated_progress_event(repo, assignment, %{
               idempotency_key: "progress:shared-key",
               summary: "Authenticated replay"
             })

    assert replayed_audit_event.id == audit_event.id
    assert repo.aggregate(ProgressEvent, :count) == 2

    assert {:ok, timeline} = PlanningService.fetch_timeline(repo, assignment)
    assert Enum.find(timeline, &(&1.id == direct_event.id)).payload == %{"system" => "visible"}
  end

  test "authenticated idempotency replay validates stored grant state", %{repo: repo} do
    assert {:ok, assignment} = claimed_assignment(repo)

    assert {:ok, _first_event} =
             PlanningService.append_authenticated_progress_event(repo, assignment, %{
               idempotency_key: "progress:revoked-replay",
               summary: "Before revoke"
             })

    forged_assignment = %{assignment | display_key: "forged-display-key"}

    assert {:error, :assignment_mismatch} =
             PlanningService.append_authenticated_progress_event(repo, forged_assignment, %{
               idempotency_key: "progress:revoked-replay",
               summary: "Forged replay"
             })

    assert {:ok, _revoked} = AccessGrantService.revoke(repo, assignment.grant_id)

    assert {:error, :assignment_revoked} =
             PlanningService.append_authenticated_progress_event(repo, assignment, %{
               idempotency_key: "progress:revoked-replay",
               summary: "After revoke"
             })

    assert repo.aggregate(ProgressEvent, :count) == 1
  end

  test "direct progress append does not persist caller supplied provenance", %{repo: repo} do
    assert {:ok, work_package} = create_work_package(repo)

    assert {:ok, event} =
             PlanningService.append_progress_event(repo, %{
               work_package_id: work_package.id,
               idempotency_key: "progress:direct-provenance",
               summary: "Direct provenance",
               actor_id: "forged-worker",
               actor_type: "architect",
               access_grant_id: "forged-grant",
               agent_run_id: "forged-run"
             })

    assert event.actor_id == nil
    assert event.actor_type == nil
    assert event.access_grant_id == nil
    assert event.agent_run_id == nil

    assert {:ok, replayed_event} =
             PlanningService.append_progress_event(repo, %{
               work_package_id: work_package.id,
               idempotency_key: "progress:direct-provenance",
               summary: "Direct provenance replay",
               access_grant_id: "forged-grant"
             })

    assert replayed_event.id == event.id
    assert repo.aggregate(ProgressEvent, :count) == 1
  end

  defp claimed_assignment(repo, opts \\ []) do
    claimed_by = Keyword.get(opts, :claimed_by, "worker-1")

    with {:ok, work_package} <- create_work_package(repo, id: Keyword.get(opts, :work_package_id, "SYMPP-P1-005")),
         {:ok, minted} <- AccessGrantService.mint_worker_grant(repo, work_package.id) do
      AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: claimed_by)
    end
  end

  defp create_work_package(repo, overrides \\ []) do
    attrs =
      Keyword.merge([id: "SYMPP-P1-005", kind: "mcp"], overrides)
      |> WorkPackageFactory.attrs()

    WorkPackageRepository.create(repo, attrs)
  end
end
