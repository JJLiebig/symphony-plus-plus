Code.require_file("work_packages_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.WorkPackagesTest do
  use SymphonyElixir.SymphonyPlusPlus.WorkPackagesCase

  test "rejects duplicate caller-provided ids", %{repo: repo} do
    attrs = WorkPackageFactory.attrs(id: "SYMPP-P1-001")

    assert {:ok, package} = Repository.create(repo, attrs)
    assert package.id == "SYMPP-P1-001"
    assert {:error, :id_already_exists} = Repository.create(repo, attrs)
  end

  test "stored string lists reject malformed historical encodings" do
    assert StringList.load(~s(["a","b"])) == {:ok, ["a", "b"]}
    assert StringList.load(~s(["a",1])) == :error
    assert StringList.load(~s({"not":"list"})) == :error
    assert StringList.load("not-json") == :error
    assert StringList.load(123) == :error
  end
end
