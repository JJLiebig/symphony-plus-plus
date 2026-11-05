defmodule SymphonyElixir.SymphonyPlusPlus.FactoryRepos do
  @moduledoc false

  alias SymphonyElixir.Config
  alias SymphonyElixir.PathSafety
  alias SymphonyElixir.SymphonyPlusPlus.OfflineSandbox
  alias SymphonyElixir.SymphonyPlusPlus.RepoIdentity

  @spec enabled?() :: boolean()
  def enabled?, do: is_binary(Config.factory_repos_root())

  @spec resolve(String.t()) :: {:ok, String.t()} | {:error, atom()}
  def resolve(repo) do
    with :ok <- OfflineSandbox.require_online(),
         {:ok, remote, name} <- remote(repo),
         root when is_binary(root) <- Config.factory_repos_root(),
         {:ok, root} <- PathSafety.canonicalize(root),
         {:ok, checkout} <- PathSafety.canonicalize(Path.join(root, name)),
         true <- Path.dirname(checkout) == root do
      :global.trans({{__MODULE__, checkout}, self()}, fn -> checkout(remote, checkout) end)
    else
      _ -> {:error, :invalid_target_repo_root}
    end
  end

  @spec matches?(String.t(), String.t()) :: boolean()
  def matches?(checkout, expected) do
    with origin when is_binary(origin) <- RepoIdentity.local_git_origin_remote(checkout),
         {:ok, left, _} <- remote(origin),
         {:ok, right, _} <- remote(expected) do
      identity(left) == identity(right)
    else
      _ -> false
    end
  end

  defp checkout(remote, checkout) do
    if File.exists?(checkout) do
      if matches?(checkout, remote), do: {:ok, checkout}, else: {:error, :target_repo_root_scope_mismatch}
    else
      clone(remote, checkout)
    end
  end

  defp clone(remote, checkout) do
    with git when is_binary(git) <- System.find_executable("git"),
         :ok <- File.mkdir_p(Path.dirname(checkout)),
         {_output, 0} <- System.cmd(git, ["clone", "--", remote, checkout], stderr_to_stdout: true) do
      {:ok, checkout}
    else
      _ -> {:error, :factory_clone_failed}
    end
  end

  defp remote(value) when is_binary(value) do
    value = String.trim(value)

    cond do
      Regex.match?(~r/\A[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\z/, value) ->
        remote("https://github.com/" <> String.replace_suffix(value, ".git", "") <> ".git")

      parts = Regex.run(~r/\A([^@:\/\s]+)@([^:]+):(.+)\z/, value) ->
        [_match, user, host, path] = parts
        remote("ssh://" <> user <> "@" <> host <> "/" <> path)

      true ->
        uri_remote(value)
    end
  end

  defp remote(_), do: {:error, :invalid_repo_remote}

  defp uri_remote(value) do
    uri = URI.parse(value)
    name = Path.basename(uri.path || "") |> String.replace_suffix(".git", "")

    if usable_authority?(uri) and usable_repo_path?(uri.path || "", name) do
      {:ok, value, name}
    else
      {:error, :invalid_repo_remote}
    end
  rescue
    _ in URI.Error -> {:error, :invalid_repo_remote}
  end

  defp usable_authority?(uri) do
    uri.scheme in ["https", "ssh"] and is_binary(uri.host) and uri.host != "" and
      usable_userinfo?(uri) and is_nil(uri.query) and is_nil(uri.fragment)
  end

  defp usable_userinfo?(%URI{userinfo: nil}), do: true

  defp usable_userinfo?(%URI{scheme: "ssh", userinfo: user}) do
    user != "" and not String.contains?(URI.decode(user), [":", "@", "/", "\\"])
  end

  defp usable_userinfo?(%URI{userinfo: user}), do: user == "git"

  defp usable_repo_path?(path, name) do
    name not in ["", ".", ".."] and Regex.match?(~r/\A[A-Za-z0-9_.-]+\z/, name) and
      not String.contains?(path, ["/../", "/./"])
  end

  defp identity(remote) do
    uri = URI.parse(remote)
    host = String.downcase(uri.host)
    path = uri.path |> String.trim_trailing("/") |> String.replace_suffix(".git", "")
    path = if host == "github.com", do: String.downcase(path), else: path
    user = if uri.scheme == "ssh" and uri.userinfo not in [nil, "git"], do: uri.userinfo
    {host, if(uri.port in [22, 443], do: nil, else: uri.port), user, path}
  end
end
