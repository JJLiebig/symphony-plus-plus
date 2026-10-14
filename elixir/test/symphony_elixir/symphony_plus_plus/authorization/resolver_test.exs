defmodule SymphonyElixir.SymphonyPlusPlus.Authorization.ResolverTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.Assignment
  alias SymphonyElixir.SymphonyPlusPlus.Authorization.Actor
  alias SymphonyElixir.SymphonyPlusPlus.Authorization.ActorResolver
  alias SymphonyElixir.SymphonyPlusPlus.Authorization.Scope
  alias SymphonyElixir.SymphonyPlusPlus.Authorization.TargetResolver
  alias SymphonyElixir.SymphonyPlusPlus.MCP.Session

  test "resolves current worker session to one work package scope without proof material" do
    session = Session.new(assignment("worker", work_package_id: "wp-1"), proof_hash: "secret-proof-hash")

    assert {:ok, %Actor{role: :worker, scopes: [%Scope{type: :work_package, id: "wp-1"}]} = actor} =
             ActorResolver.from_session(session)

    refute inspect(actor) =~ "secret-proof-hash"
  end

  test "resolves current architect assignment as migration-safe explicit scopes" do
    actor =
      assignment("architect", work_package_id: "wp-anchor", phase_id: "phase-1")
      |> ActorResolver.from_assignment(work_request_id: "wr-1", repo: "nextide/symphony-plus-plus", base_branch: "main")

    assert actor.role == :architect
    assert Enum.any?(actor.scopes, &match?(%Scope{type: :work_request, id: "wr-1"}, &1))
    assert Enum.any?(actor.scopes, &match?(%Scope{type: :work_package, id: "wp-anchor"}, &1))
    assert Enum.any?(actor.scopes, &match?(%Scope{type: :repo, repo: "nextide/symphony-plus-plus", base_branch: "main"}, &1))

    assert Enum.any?(
             actor.scopes,
             &match?(
               %Scope{
                 type: :phase,
                 id: "phase-1",
                 repo: "nextide/symphony-plus-plus",
                 base_branch: "main",
                 metadata: %{migration_only: true}
               },
               &1
             )
           )
  end

  test "prefers persisted work request scope without caller repo or phase fallback" do
    actor =
      assignment("architect",
        work_package_id: "wp-anchor",
        phase_id: "phase-1",
        scopes: [Scope.work_request("wr-persisted")]
      )
      |> ActorResolver.from_assignment(work_request_id: "wr-fallback", repo: "nextide/other-repo", base_branch: "feature")

    assert Scope.work_request("wr-persisted") in actor.scopes
    refute Scope.work_request("wr-fallback") in actor.scopes
    assert Enum.any?(actor.scopes, &match?(%Scope{type: :work_package, id: "wp-anchor"}, &1))
    refute Scope.repo("nextide/other-repo", "feature") in actor.scopes
    refute Enum.any?(actor.scopes, &match?(%Scope{type: :phase}, &1))
  end

  test "preserves fallback work request scope when persisted legacy scopes are incomplete" do
    actor =
      assignment("architect",
        work_package_id: "wp-anchor",
        phase_id: "phase-1",
        scopes: [Scope.repo("nextide/symphony-plus-plus", "main"), Scope.work_package("wp-anchor")]
      )
      |> ActorResolver.from_assignment(work_request_id: "wr-fallback", repo: "nextide/symphony-plus-plus", base_branch: "main")

    assert Enum.any?(actor.scopes, &match?(%Scope{type: :work_request, id: "wr-fallback"}, &1))
    assert Enum.any?(actor.scopes, &match?(%Scope{type: :repo, repo: "nextide/symphony-plus-plus", base_branch: "main"}, &1))
    assert Enum.count(actor.scopes, &match?(%Scope{type: :work_package, id: "wp-anchor"}, &1)) == 1
  end

  test "worker assignments ignore persisted scopes outside their package" do
    actor =
      assignment("worker",
        work_package_id: "wp-worker",
        scopes: [
          Scope.ledger(),
          Scope.repo("service-a", "main"),
          Scope.repo("service-b", "release"),
          Scope.work_request("wr-overbroad"),
          Scope.work_package("wp-other"),
          Scope.work_package("wp-worker")
        ]
      )
      |> ActorResolver.from_assignment()

    assert actor.scopes == [Scope.work_package("wp-worker")]
  end

  test "resolves operator assignment to ledger scope" do
    assert %Actor{
             role: :operator,
             source: :mcp_assignment,
             scopes: [%Scope{type: :ledger, metadata: %{source: :mcp_assignment}}]
           } = ActorResolver.from_assignment(assignment("operator", []))
  end

  test "preserves operator ledger scope when persisted scope rows exist" do
    actor =
      ActorResolver.from_assignment(assignment("operator", scopes: [Scope.work_package("wp-legacy")]))

    assert Enum.any?(actor.scopes, &match?(%Scope{type: :ledger}, &1))
    assert Enum.any?(actor.scopes, &match?(%Scope{type: :work_package, id: "wp-legacy"}, &1))
  end

  test "architect target resolution rejects missing WorkRequest scope" do
    architect_assignment = assignment("architect", phase_id: "phase-1")
    assert {:error, :missing_work_request_scope} = TargetResolver.architect_work_request(architect_assignment, [])
  end

  defp assignment(role, opts) do
    %Assignment{
      grant_id: "ag-1",
      work_package_id: Keyword.get(opts, :work_package_id),
      phase_id: Keyword.get(opts, :phase_id),
      display_key: "D57F",
      grant_role: role,
      capabilities: Keyword.get(opts, :capabilities, []),
      claimed_at: ~U[2026-05-30 20:54:59Z],
      claimed_by: "#{role}-actor",
      scopes: Keyword.get(opts, :scopes, [])
    }
  end
end
