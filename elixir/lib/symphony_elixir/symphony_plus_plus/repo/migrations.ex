defmodule SymphonyElixir.SymphonyPlusPlus.Repo.Migrations do
  @moduledoc false

  @loaded_key {__MODULE__, :loaded_migrations}
  @migrations_dir "priv/symphony_plus_plus/repo/migrations"

  @spec path() :: Path.t()
  def path do
    Application.app_dir(:symphony_elixir, @migrations_dir)
  end

  @spec all() :: [{non_neg_integer(), module()}]
  def all do
    current_signature = signature()

    case :persistent_term.get(@loaded_key, :unset) do
      {^current_signature, migrations} -> migrations
      cached -> load_migrations(cached)
    end
  end

  @spec version_strings() :: [String.t()]
  def version_strings do
    migration_files()
    |> Enum.map(fn {version, _file} -> Integer.to_string(version) end)
  end

  @spec signature() :: term()
  def signature do
    signature(migration_files())
  end

  defp load_migrations(cached) do
    :global.trans({__MODULE__, self()}, fn ->
      files = migration_files()
      current_signature = signature(files)

      case :persistent_term.get(@loaded_key, :unset) do
        {^current_signature, migrations} ->
          migrations

        latest_cached ->
          force_compile? = cached_migrations_loaded?(cached) or cached_migrations_loaded?(latest_cached)
          migrations = Enum.map(files, &compile_migration(&1, force_compile?))
          :persistent_term.put(@loaded_key, {current_signature, migrations})
          migrations
      end
    end)
  end

  defp cached_migrations_loaded?({_signature, migrations}) when is_list(migrations), do: true
  defp cached_migrations_loaded?(_cached), do: false

  defp compile_migration({version, file}, force_compile?) do
    module = module_from_file!(file)

    if force_compile? or not Code.ensure_loaded?(module) do
      Code.compile_file(file)
    end

    {version, module}
  end

  defp signature(files) do
    {
      path(),
      Enum.map(files, fn {version, file} -> signature_entry(version, file) end)
    }
  end

  defp signature_entry(version, file) do
    stat = File.stat!(file)
    {version, Path.basename(file), stat.size, stat.mtime}
  end

  defp module_from_file!(file) do
    [_match, module] = Regex.run(~r/^defmodule\s+([A-Za-z0-9_.]+)\s+do/m, File.read!(file))

    module
    |> String.split(".")
    |> Module.concat()
  end

  defp migration_files do
    migration_path = path()

    migration_path
    |> File.ls!()
    |> Enum.filter(&String.ends_with?(&1, ".exs"))
    |> Enum.map(fn file -> {version_from_filename!(file), Path.join(migration_path, file)} end)
    |> Enum.sort_by(fn {version, _file} -> version end)
  end

  defp version_from_filename!(<<version::binary-size(14), "_", _rest::binary>>) do
    String.to_integer(version)
  end
end
