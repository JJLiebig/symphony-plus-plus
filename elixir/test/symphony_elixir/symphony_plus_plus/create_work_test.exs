defmodule SymphonyElixir.SymphonyPlusPlus.CreateWorkTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.SymphonyPlusPlus.AccessGrants.AccessGrant
  alias SymphonyElixir.SymphonyPlusPlus.CreateWork
  alias SymphonyElixir.SymphonyPlusPlus.Repo
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.Repository, as: WorkPackageRepository
  alias SymphonyElixir.SymphonyPlusPlus.WorkPackages.WorkPackage
  alias SymphonyElixir.WorkPackageFactory

  setup_all do
    database_path = WorkPackageFactory.database_path()

    start_supervised!({Repo, database: database_path, pool_size: 1})
    assert :ok = WorkPackageRepository.migrate(Repo)

    on_exit(fn -> File.rm(database_path) end)

    {:ok, repo: Repo}
  end

  setup %{repo: repo} do
    repo.delete_all(AccessGrant)
    repo.delete_all(WorkPackage)
    :ok
  end

  test "create-work bootstrap response redacts prompt and grant verifier material", %{repo: repo} do
    assert {:ok, creation} =
             CreateWork.create(repo, %{
               repo: "kraken",
               base_branch: "main",
               title: "Create bootstrap response",
               acceptance_criteria: ["Return bootstrap metadata without raw worker secrets."]
             })

    bootstrap = %{
      type: "ledger_claim",
      launch_prompt: "Use raw_secret_bootstrap_response only inside the ledger.",
      claim: %{tool: "claim_local_assignment", arguments: %{}}
    }

    response_creation = %{creation | worker_grant: Map.put(creation.worker_grant, :secret_hash, "hash-should-not-leak")}
    payload = CreateWork.response_payload(response_creation, worker_bootstrap: bootstrap)
    json = Jason.encode!(payload)

    assert payload.worker_bootstrap.launch_prompt =~ "[REDACTED]"
    refute payload.worker_bootstrap.launch_prompt =~ "raw_secret_bootstrap_response"
    refute Map.has_key?(payload.worker_grant, :display_key)
    refute Map.has_key?(payload.worker_grant, :secret)
    refute Map.has_key?(payload.worker_grant, :secret_hash)
    refute json =~ "raw_secret_bootstrap_response"
    refute json =~ "hash-should-not-leak"
  end
end
