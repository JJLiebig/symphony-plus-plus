defmodule SymphonyElixir.SymphonyPlusPlus.Repo do
  @moduledoc false

  use Ecto.Repo,
    otp_app: :symphony_elixir,
    adapter: Ecto.Adapters.SQLite3

  @data_dir Path.join([".agents", "splusplus"])
  @default_database_file "symphony_plus_plus.sqlite3"
  @default_database_display_path "$HOME/.agents/splusplus/symphony_plus_plus.sqlite3"
  @default_database_help_text "Default ledger: preferred #{@default_database_display_path}; falls back under temp/relative .agents/splusplus if home is unavailable. Use --database only for isolation."
  @default_pool_size 5
  @default_queue_target 1_000
  @default_queue_interval 5_000

  @impl true
  def init(:supervisor, config) do
    :ok = SymphonyElixir.SymphonyPlusPlus.OfflineSandbox.verify!(Keyword.fetch!(config, :database))
    {:ok, config}
  end

  def init(:runtime, config), do: {:ok, config}

  @spec child_options(keyword()) :: keyword()
  def child_options(opts \\ []) do
    defaults = [
      database: Keyword.get_lazy(opts, :database, &database_path/0),
      name: Keyword.get(opts, :name, __MODULE__),
      pool_size: Application.get_env(:symphony_elixir, :sympp_repo_pool_size, @default_pool_size),
      queue_target: Application.get_env(:symphony_elixir, :sympp_repo_queue_target, @default_queue_target),
      queue_interval: Application.get_env(:symphony_elixir, :sympp_repo_queue_interval, @default_queue_interval)
    ]

    Keyword.merge(defaults, opts)
  end

  @spec database_path() :: String.t()
  def database_path do
    configured_database_path()
    |> normalize_database_path()
  end

  @doc false
  @spec database_path_without_side_effects() :: String.t() | term()
  def database_path_without_side_effects do
    configured_database_path_without_side_effects()
    |> normalize_database_path_without_side_effects()
  end

  @doc false
  @spec default_database_help_text() :: String.t()
  def default_database_help_text, do: @default_database_help_text

  @doc false
  @spec database_path_if_present() :: String.t() | term() | nil
  def database_path_if_present do
    case configured_database_path_without_side_effects() do
      database_path when is_binary(database_path) ->
        existing_database_path(database_path)

      database_path ->
        database_path
    end
  end

  @doc false
  @spec operator_database_path(module()) :: String.t() | term() | nil
  def operator_database_path(repo \\ __MODULE__) do
    configured_database_path_for_handoff() || live_database_path(repo) || database_path_if_present()
  end

  @doc false
  @spec child_id(term()) :: term()
  def child_id(database_path), do: {__MODULE__, :database, database_key(database_path)}

  @doc false
  @spec process_name(term()) :: {:global, term()}
  def process_name(database_path), do: {:global, process_key(database_path)}

  @doc false
  @spec process_key(term()) :: term()
  def process_key(database_path), do: {__MODULE__, :database, database_key(database_path)}

  @doc false
  @spec database_key(term()) :: term()
  def database_key(database_path) when is_binary(database_path) do
    cond do
      filesystem_database_path?(database_path) ->
        database_path
        |> Path.expand()
        |> canonical_path_key()

      sqlite_file_uri?(database_path) ->
        sqlite_file_uri_database_key(database_path)

      true ->
        {:sqlite_database, database_path}
    end
  end

  def database_key(database_path) do
    database_path
  end

  @doc false
  @spec same_database_path?(term(), term()) :: boolean()
  def same_database_path?(left, right), do: database_key(left) == database_key(right)

  @doc false
  @spec filesystem_database_path?(term()) :: boolean()
  def filesystem_database_path?(database_path) when is_binary(database_path), do: not sqlite_special_database?(database_path)
  def filesystem_database_path?(_database_path), do: false

  @doc false
  @spec memory_database?(term()) :: boolean()
  def memory_database?(":memory:"), do: true

  def memory_database?("file:" <> _uri = database_path) do
    {uri_path, query_params} = sqlite_file_uri_parts(database_path)

    uri_path == ":memory:" or String.downcase(Map.get(query_params, "mode", "")) == "memory"
  end

  def memory_database?(_database_path), do: false

  @doc false
  @spec sqlite_file_uri_path(term()) :: String.t() | nil
  def sqlite_file_uri_path("file:" <> _uri = database_path) do
    database_path
    |> sqlite_file_uri_parts()
    |> elem(0)
  end

  def sqlite_file_uri_path(_database_path), do: nil

  @doc false
  @spec default_database_root_for_test(
          String.t() | nil,
          String.t() | nil,
          (Path.t() -> :ok | {:error, term()})
        ) :: Path.t()
  def default_database_root_for_test(user_home, temp_dir, mkdir_fun \\ fn _path -> :ok end) do
    default_database_root(user_home, temp_dir, mkdir_fun)
  end

  defp configured_database_path do
    case Application.fetch_env(:symphony_elixir, :sympp_repo_database) do
      {:ok, database_path} -> configured_database_value(database_path)
      :error -> configured_repo_database_path()
    end
  end

  defp configured_database_path_without_side_effects do
    case Application.fetch_env(:symphony_elixir, :sympp_repo_database) do
      {:ok, database_path} -> configured_database_value_without_side_effects(database_path)
      :error -> configured_repo_database_path_without_side_effects()
    end
  end

  defp configured_repo_database_path do
    :symphony_elixir
    |> Application.get_env(__MODULE__, [])
    |> repo_database_config()
    |> configured_database_value()
  end

  defp configured_repo_database_path_without_side_effects do
    :symphony_elixir
    |> Application.get_env(__MODULE__, [])
    |> repo_database_config()
    |> case do
      nil -> default_database_path_without_side_effects()
      database_path -> configured_database_value_without_side_effects(database_path)
    end
  end

  defp repo_database_config(config) when is_list(config), do: Keyword.get(config, :database)
  defp repo_database_config(_config), do: nil

  defp configured_database_value(nil), do: default_database_path()
  defp configured_database_value(database_path) when is_binary(database_path), do: configured_binary_database_path(database_path)
  defp configured_database_value(database_path), do: database_path

  defp configured_database_value_without_side_effects(nil), do: default_database_path_without_side_effects()

  defp configured_database_value_without_side_effects(database_path) when is_binary(database_path) do
    if String.trim(database_path) == "" do
      default_database_path_without_side_effects()
    else
      database_path
    end
  end

  defp configured_database_value_without_side_effects(database_path), do: database_path

  defp configured_database_path_for_handoff do
    case Application.get_env(:symphony_elixir, :sympp_repo_database) do
      database_path when is_binary(database_path) -> configured_binary_database_path_for_handoff(database_path)
      database_path -> database_path
    end
  end

  defp configured_binary_database_path_for_handoff(database_path) do
    database_path = String.trim(database_path)

    cond do
      database_path == "" -> nil
      filesystem_database_path?(database_path) -> Path.expand(database_path)
      true -> database_path
    end
  end

  defp live_database_path(repo) do
    case repo.query("PRAGMA database_list", []) do
      {:ok, %{rows: rows}} -> persistent_main_database_path(rows) || configured_database_path_for_handoff()
      {:error, _reason} -> configured_database_path_for_handoff()
      _result -> configured_database_path_for_handoff()
    end
  rescue
    _error in [Exqlite.Error, UndefinedFunctionError] -> configured_database_path_for_handoff()
  end

  defp persistent_main_database_path(rows) do
    Enum.find_value(rows, fn
      [_seq, "main", path] when is_binary(path) and path != "" -> path
      _row -> nil
    end)
  end

  defp normalize_database_path(database_path) when is_binary(database_path) do
    if filesystem_database_path?(database_path) do
      database_path = Path.expand(database_path)
      File.mkdir_p!(Path.dirname(database_path))
      database_path
    else
      database_path
    end
  end

  defp normalize_database_path(database_path), do: Path.expand(database_path)

  defp normalize_database_path_without_side_effects(database_path) when is_binary(database_path) do
    if filesystem_database_path?(database_path), do: Path.expand(database_path), else: database_path
  end

  defp normalize_database_path_without_side_effects(database_path), do: database_path

  defp configured_binary_database_path(database_path) do
    if String.trim(database_path) == "" do
      default_database_path()
    else
      database_path
    end
  end

  defp existing_database_path(database_path) do
    cond do
      memory_database?(database_path) ->
        nil

      filesystem_database_path?(database_path) ->
        database_path = Path.expand(database_path)
        if File.exists?(database_path), do: database_path, else: nil

      sqlite_file_uri?(database_path) ->
        if sqlite_file_uri_exists?(database_path), do: database_path, else: nil

      true ->
        database_path
    end
  end

  defp sqlite_file_uri_exists?(database_path) do
    case sqlite_file_uri_path(database_path) do
      path when is_binary(path) ->
        String.trim(path) != "" and path |> Path.expand() |> File.exists?()

      _path ->
        false
    end
  end

  defp sqlite_special_database?(":memory:"), do: true
  defp sqlite_special_database?("file:" <> _uri), do: true
  defp sqlite_special_database?(_database_path), do: false

  defp sqlite_file_uri?(database_path), do: String.starts_with?(database_path, "file:")

  defp sqlite_file_uri_database_key(database_path) do
    {uri_path, query_params} = sqlite_file_uri_parts(database_path)
    normalized_query_params = Enum.sort(query_params)

    if memory_database?(database_path) do
      {:sqlite_memory_uri, uri_path, normalized_query_params}
    else
      {:sqlite_file_uri, uri_path |> Path.expand() |> canonical_path_key(), normalized_query_params}
    end
  end

  defp sqlite_file_uri_parts("file:" <> uri) do
    case String.split(uri, "?", parts: 2) do
      [uri_path, query] -> {URI.decode(uri_path), URI.decode_query(query)}
      [uri_path] -> {URI.decode(uri_path), %{}}
    end
  end

  defp canonical_path_key(path) do
    case :os.type() do
      {:win32, _name} -> normalize_case_insensitive_path_key(path)
      _other -> path
    end
  end

  defp normalize_case_insensitive_path_key(path) do
    path
    |> String.replace("\\", "/")
    |> String.downcase()
  end

  defp default_database_path do
    Path.join(default_database_root(), @default_database_file)
  end

  defp default_database_path_without_side_effects do
    root =
      case configured_default_database_root() do
        root when is_binary(root) -> if File.dir?(root), do: root
        nil -> existing_default_database_root()
      end

    case root do
      nil -> nil
      root -> Path.join(root, @default_database_file)
    end
  end

  defp default_database_root do
    case configured_default_database_root() do
      root when is_binary(root) ->
        File.mkdir_p!(root)
        root

      nil ->
        default_database_root(System.user_home(), System.tmp_dir(), &File.mkdir_p/1)
    end
  end

  defp configured_default_database_root do
    case Application.get_env(:symphony_elixir, :sympp_repo_default_database_root) do
      root when is_binary(root) ->
        root = String.trim(root)
        if root == "", do: nil, else: Path.expand(root)

      _root ->
        nil
    end
  end

  defp existing_default_database_root do
    System.user_home()
    |> candidate_database_roots(System.tmp_dir())
    |> Enum.find(&File.dir?/1)
  end

  defp default_database_root(user_home, temp_dir, mkdir_fun) when is_function(mkdir_fun, 1) do
    user_home
    |> candidate_database_roots(temp_dir)
    |> Enum.find_value(@data_dir, fn root ->
      if ensure_directory(root, mkdir_fun), do: root
    end)
  end

  defp candidate_database_roots(user_home, temp_dir) do
    [database_data_root(user_home), database_data_root(temp_dir), @data_dir]
    |> Enum.reject(&is_nil/1)
  end

  defp database_data_root(path) when is_binary(path) do
    if String.trim(path) == "" do
      nil
    else
      Path.join(path, @data_dir)
    end
  end

  defp database_data_root(_path), do: nil

  defp ensure_directory(path, mkdir_fun) do
    case mkdir_fun.(path) do
      :ok -> true
      {:error, _reason} -> false
    end
  rescue
    _error -> false
  end
end
