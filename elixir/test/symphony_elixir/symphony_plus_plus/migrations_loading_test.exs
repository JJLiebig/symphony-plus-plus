defmodule SymphonyElixir.SymphonyPlusPlus.MigrationsLoadingTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.LocalCommand

  test "concurrent cold loaders wait for one migration compilation" do
    root = Path.join(System.tmp_dir!(), "sympp-migration-loading-#{System.os_time(:nanosecond)}")
    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf!(root) end)
    script = Path.join(root, "concurrent_load.exs")
    source = Path.expand("../../../lib/symphony_elixir/symphony_plus_plus/repo/migrations.ex", __DIR__)

    # A fresh VM isolates the loader cache, migration module and synthetic application priv path.
    File.write!(script, ~S'''
    [source, root] = System.argv()
    ebin = Path.join(root, "symphony_elixir-0.1.0/ebin")
    priv = Path.join(root, "symphony_elixir-0.1.0/priv/symphony_plus_plus/repo/migrations")
    File.mkdir_p!(ebin)
    File.mkdir_p!(priv)
    true = :code.add_patha(String.to_charlist(ebin))
    Code.compile_file(source)

    parent = self()
    token = make_ref()
    :persistent_term.put(:migration_compile_barrier, {parent, token})
    File.write!(Path.join(priv, "20261008120000_barrier.exs"), """
    defmodule MigrationCompileBarrier do
      use Ecto.Migration
      {parent, token} = :persistent_term.get(:migration_compile_barrier)
      send(parent, {:compiling, self(), token})
      receive do
        {:release, ^token} -> :ok
      after
        10_000 -> raise "compile barrier timeout"
      end
      def change, do: :ok
    end
    """)

    load = fn label ->
      spawn(fn ->
        send(parent, {:started, label})
        result = try do
          {:ok, SymphonyElixir.SymphonyPlusPlus.Repo.Migrations.all()}
        rescue
          error -> {:error, error.__struct__, Exception.message(error)}
        end
        send(parent, {:result, label, result})
      end)
    end

    load.(:first)
    compiler = receive do
      {:compiling, compiler, ^token} -> compiler
    after
      10_000 -> raise "first migration did not reach compile barrier"
    end
    load.(:second)
    receive do
      {:started, :second} -> :ok
    after
      10_000 -> raise "second loader did not start"
    end
    before_release = receive do
      {:result, :second, result} -> result
    after
      1_000 -> :blocked
    end
    send(compiler, {:release, token})

    :blocked = before_release
    expected = {:ok, [{20_261_008_120_000, MigrationCompileBarrier}]}
    for label <- [:first, :second] do
      receive do
        {:result, ^label, result} -> ^expected = result
      after
        10_000 -> raise "loader did not finish: #{label}"
      end
    end
    true = function_exported?(MigrationCompileBarrier, :__migration__, 0)
    :ok = MigrationCompileBarrier.change()
    receive do
      {:compiling, _, ^token} -> raise "migration compiled twice"
    after
      0 -> :ok
    end
    ''')

    {executable, args} =
      LocalCommand.executable_invocation(System.find_executable("elixir"), [
        "--erl",
        "+S 2:2",
        "-pa",
        Path.dirname(:code.which(Ecto.Migration)),
        script,
        source,
        root
      ])

    {output, status} = System.cmd(executable, args, stderr_to_stdout: true)
    assert status == 0, output
  end
end
