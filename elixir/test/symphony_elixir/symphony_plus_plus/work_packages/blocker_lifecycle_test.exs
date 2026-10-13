Code.require_file("../work_packages_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.WorkPackages.BlockerLifecycleTest do
  use SymphonyElixir.SymphonyPlusPlus.WorkPackagesCase

  test "never reactivates terminal, abandoned, or deleted packages", %{repo: repo} do
    for status <- ["merged", "closed", "abandoned"] do
      assert {:ok, package} =
               Repository.create(
                 repo,
                 WorkPackageFactory.attrs(id: "SYMPP-BLOCKER-#{status}", status: status)
               )

      assert {:ok, unchanged} = Repository.reactivate_if_unblocked(repo, package.id)
      assert unchanged.status == status
    end

    assert {:ok, deleted} =
             Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-BLOCKER-DELETED", status: "blocked"))

    repo.delete!(deleted)
    assert {:error, :not_found} = Repository.reactivate_if_unblocked(repo, deleted.id)
  end
end
