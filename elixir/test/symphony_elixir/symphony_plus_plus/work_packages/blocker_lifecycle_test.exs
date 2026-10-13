Code.require_file("../work_packages_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.WorkPackages.BlockerLifecycleTest do
  use SymphonyElixir.SymphonyPlusPlus.WorkPackagesCase

  test "reactivation reports a deleted package as not found", %{repo: repo} do
    assert {:ok, deleted} =
             Repository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-BLOCKER-DELETED", status: "blocked"))

    repo.delete!(deleted)
    assert {:error, :not_found} = Repository.reactivate_if_unblocked(repo, deleted.id)
  end
end
