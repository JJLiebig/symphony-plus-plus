defmodule SymphonyElixir.SymphonyPlusPlus.FactoryRepos do
  @moduledoc false

  alias SymphonyElixir.Config
  alias SymphonyElixir.PathSafety
  alias SymphonyElixir.SymphonyPlusPlus.GitCheckout
  alias SymphonyElixir.SymphonyPlusPlus.OfflineSandbox
  alias SymphonyElixir.SymphonyPlusPlus.RepoIdentity

  @scp_remote ~r/\A(?:([^@:\/\s]+)@)?(\[[^\]]+\]|[^:\/\s]+):((?!\/\/).+)\z/

  @spec enabled?() :: boolean()
  def enabled?, do: is_binary(Config.factory_repos_root())

  @spec resolve(String.t()) :: {:ok, String.t()} | {:error, atom() | {:target_repo_root_scope_mismatch, String.t()}}
  def resolve(repo) do
    with :ok <- OfflineSandbox.require_online(),
         {:ok, remote, name} <- remote(repo),
         root when is_binary(root) <- Config.factory_repos_root(),
         {:ok, root} <- PathSafety.canonicalize(root) do
      :global.trans({{__MODULE__, root, identity(remote)}, self()}, fn ->
        resolve_checkout(root, remote, name)
      end)
    else
      _ -> {:error, :invalid_target_repo_root}
    end
  end

  # A board read must never clone a missing repository.
  @spec repo_signal(String.t(), keyword()) :: map()
  def repo_signal(repo, opts \\ []) do
    with {:ok, remote, _name} <- remote(repo),
         root when is_binary(root) <- Config.factory_repos_root() do
      table = signal_cache()
      key = root
      now = Keyword.get(opts, :now_ms, System.monotonic_time(:millisecond))

      case :ets.lookup(table, key) do
        [{^key, recorded_at, signals}] when now - recorded_at < 30_000 ->
          Map.get(signals, identity(remote), %{})

        _ ->
          signals = local_repo_signals(root)
          :ets.insert(table, {key, now, signals})
          Map.get(signals, identity(remote), %{})
      end
    else
      _ -> %{}
    end
  end

  defp local_repo_signals(root) do
    case PathSafety.canonicalize(root) do
      {:ok, root} ->
        root
        |> discover(root, 3)
        |> Enum.group_by(fn {_path, repo_identity} -> repo_identity end)
        |> Map.new(fn {repo_identity, checkouts} ->
          {repo_identity, checkout_signal(checkouts, repo_identity, root)}
        end)

      _ ->
        %{}
    end
  end

  defp checkout_signal(checkouts, repo_identity, root) do
    case checkout_matches(checkouts, repo_identity, root) do
      {_depth, [{checkout, _identity}]} -> %{has_ci: has_workflows?(checkout)}
      _ -> %{}
    end
  end

  defp has_workflows?(checkout) do
    directory = Path.join(checkout, ".github/workflows")

    case File.ls(directory) do
      {:ok, names} ->
        Enum.any?(names, fn name ->
          Path.extname(name) in [".yml", ".yaml"] and File.regular?(Path.join(directory, name))
        end)

      _ ->
        false
    end
  end

  defp signal_cache do
    table = :sympp_repo_signal_cache

    case :ets.whereis(table) do
      :undefined ->
        try do
          options = [:named_table, :public, read_concurrency: true]

          options =
            case Process.whereis(SymphonyElixir.Supervisor) do
              pid when is_pid(pid) -> [{:heir, pid, :repo_signal} | options]
              _ -> options
            end

          :ets.new(table, options)
        rescue
          _race in ArgumentError -> table
        end

      _ ->
        table
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

  # Search three levels below the root, stopping at checkouts.
  defp resolve_checkout(root, remote, name) do
    checkouts = discover(root, root, 3)
    expected = identity(remote)

    matches = checkout_matches(checkouts, expected, root)

    case matches do
      nil ->
        parent = clone_parent(checkouts, expected, root)

        with {:ok, checkout} <- PathSafety.canonicalize(Path.join(parent, name)),
             true <- inside_root?(checkout, root) do
          checkout(remote, checkout)
        else
          _ -> {:error, :invalid_target_repo_root}
        end

      {_depth, [{path, _identity}]} ->
        {:ok, path}

      _ ->
        {:error, :ambiguous_factory_repo_checkout}
    end
  end

  defp checkout_matches(checkouts, expected, root) do
    checkouts
    |> Enum.filter(fn {_path, repo_identity} -> repo_identity == expected end)
    |> Enum.group_by(fn {path, _identity} -> length(Path.split(Path.relative_to(path, root))) end)
    |> Enum.min_by(fn {depth, _paths} -> depth end, fn -> nil end)
  end

  defp discover(_directory, _root, 0), do: []

  defp discover(directory, root, depth) do
    case File.ls(directory) do
      {:ok, names} ->
        names
        |> Enum.reject(&(&1 in [".git", ".worktrees"]))
        |> Enum.flat_map(fn name -> discover_child(Path.join(directory, name), root, depth) end)

      _ ->
        []
    end
  end

  defp discover_child(path, root, depth) do
    # Skip symlinks to avoid escapes and cycles.
    with {:ok, %File.Stat{type: :directory}} <- File.lstat(path),
         {:ok, path} <- PathSafety.canonicalize(path),
         true <- inside_root?(path, root) do
      if File.exists?(Path.join(path, ".git")) do
        discovered_checkout(path)
      else
        discover(path, root, depth - 1)
      end
    else
      _ -> []
    end
  end

  defp discovered_checkout(path) do
    case remote(RepoIdentity.local_git_origin_remote(path)) do
      {:ok, origin, _name} -> [{path, identity(origin)}]
      _ -> []
    end
  end

  defp clone_parent(checkouts, expected, root) do
    case github_owner(expected) do
      nil ->
        root

      owner ->
        checkouts
        |> Enum.filter(fn {_path, repo_identity} -> github_owner(repo_identity) == owner end)
        |> Enum.map(fn {path, _identity} -> Path.dirname(path) end)
        |> Enum.uniq()
        |> case do
          [parent] -> parent
          _ -> root
        end
    end
  end

  defp github_owner({:github, path}) do
    case String.split(path, "/") do
      [owner, _name] -> owner
      _ -> nil
    end
  end

  defp github_owner(_identity), do: nil

  defp inside_root?(path, root), do: String.starts_with?(path, String.trim_trailing(root, "/") <> "/")

  defp checkout(remote, checkout) do
    if File.exists?(checkout) do
      if matches?(checkout, remote), do: {:ok, checkout}, else: {:error, {:target_repo_root_scope_mismatch, checkout}}
    else
      clone(remote, checkout)
    end
  end

  defp clone(remote, checkout) do
    with git when is_binary(git) <- System.find_executable("git"),
         :ok <- File.mkdir_p(Path.dirname(checkout)),
         {_output, 0} <- GitCheckout.run(git, ["clone", "--", remote, checkout]) do
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
          {:ok, clone_remote(value, uri), name}
        else
          {:error, :invalid_repo_remote}
        end
    end
  rescue
    _ in [URI.Error, ArgumentError] -> {:error, :invalid_repo_remote}
  end

  defp remote(_), do: {:error, :invalid_repo_remote}

  defp clone_remote(value, %URI{scheme: scheme}) when scheme in ["http", "https"] do
    String.replace(value, ~r{\A(https?://)[^/?#]*@}i, "\\1", global: false)
  end

  defp clone_remote(value, _uri), do: value

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
