defmodule SymphonyElixir.SymphonyPlusPlus.FactoryRepos do
  @moduledoc false

  alias SymphonyElixir.Config
  alias SymphonyElixir.PathSafety
  alias SymphonyElixir.SymphonyPlusPlus.OfflineSandbox
  alias SymphonyElixir.SymphonyPlusPlus.RepoIdentity

  @scp_remote ~r/\A(?:([^@:\/\s]+)@)?(\[[^\]]+\]|[^:\/\s]+):((?!\/\/).+)\z/

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
      Regex.match?(~r/\A[A-Za-z]:[\\\/]/, value) ->
        {:error, :invalid_repo_remote}

      Regex.match?(~r/\A[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\z/, value) ->
        remote("https://github.com/" <> String.replace_suffix(value, ".git", "") <> ".git")

      true ->
        {uri, path} = parsed_remote(value)
        name = Path.basename(path || "") |> String.replace_suffix(".git", "")

        if usable_authority?(uri) and name not in ["", ".", ".."] and not String.contains?(value, <<0>>) do
          {:ok, value, name}
        else
          {:error, :invalid_repo_remote}
        end
    end
  rescue
    _ in [URI.Error, ArgumentError] -> {:error, :invalid_repo_remote}
  end

  defp remote(_), do: {:error, :invalid_repo_remote}

  defp parsed_remote(value) do
    case Regex.run(@scp_remote, value) do
      [_match, user, host, path] ->
        authority = if user == "", do: host, else: user <> "@" <> host
        {URI.parse("ssh://" <> authority), path}

      nil ->
        uri = URI.parse(value)
        {uri, uri.path}
    end
  end

  defp usable_authority?(uri) do
    uri.scheme in ["http", "https", "ssh", "git"] and is_binary(uri.host) and uri.host != "" and
      usable_userinfo?(uri) and is_nil(uri.query) and is_nil(uri.fragment)
  end

  defp usable_userinfo?(%URI{userinfo: nil}), do: true
  defp usable_userinfo?(%URI{userinfo: user}), do: user != "" and not String.contains?(URI.decode(user), ":")

  defp identity(remote) do
    {uri, path} = parsed_remote(remote)

    host = String.downcase(uri.host)
    default_port = %{"ssh" => 22, "https" => 443, "http" => 80, "git" => 9418}[uri.scheme]
    port = uri.port || default_port

    user = if uri.scheme == "ssh", do: uri.userinfo

    if host == "github.com" and port == default_port and user in [nil, "git"] do
      {:github, path |> String.trim("/") |> String.downcase() |> String.replace_suffix(".git", "")}
    else
      {uri.scheme, host, port, user, path}
    end
  end
end
