defmodule SymphonyElixir.SymphonyPlusPlus.PortableSkillPackageTest do
  use ExUnit.Case, async: true

  @repo_root Path.expand("../../../../", __DIR__)
  @bundle Path.join(@repo_root, "skills/symphony-plus-plus")

  test "portable payload matches canonical procedures and has self-contained links" do
    node = System.find_executable("node")
    assert node, "Node is required to validate portable skill packaging"

    {output, status} =
      System.cmd(node, [Path.join(@repo_root, "scripts/package-portable-skills.mjs"), "--check"], stderr_to_stdout: true)

    assert status == 0, output
    files = Path.wildcard(Path.join(@bundle, "**/*")) |> Enum.filter(&File.regular?/1)
    assert length(files) == 11
    assert Enum.all?(files, &(Path.extname(&1) == ".md"))
    assert Path.wildcard(Path.join(@bundle, "**/SKILL.md")) == [Path.join(@bundle, "SKILL.md")]

    for file <- files,
        [_, target] <- Regex.scan(~r/\[[^\]]*\]\(([^)]+)\)/, File.read!(file)),
        not String.starts_with?(target, ["https://", "http://", "#"]) do
      path = target |> String.split("#") |> hd()
      resolved = Path.expand(path, Path.dirname(file))
      assert String.starts_with?(resolved, @bundle <> "/"), "Escaping link: #{file} -> #{target}"
      assert File.regular?(resolved), "Broken link: #{file} -> #{target}"
    end
  end
end
