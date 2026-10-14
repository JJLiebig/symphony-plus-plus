defmodule SymphonyElixir.MixProject do
  use Mix.Project

  def project do
    [
      app: :symphony_elixir,
      version: "0.1.0",
      elixir: "~> 1.20",
      compilers: Mix.compilers(),
      start_permanent: Mix.env() == :prod,
      test_ignore_filters: [
        "test/support/canonical_work_package_fixtures.ex",
        "test/support/github_test_support.exs",
        "test/support/mcp_harness.exs",
        "test/support/symphony_plus_plus/mcp_case.exs",
        "test/support/symphony_plus_plus/mcp_common_helpers.exs",
        "test/support/symphony_plus_plus/mcp_handoff_helpers.exs",
        "test/support/symphony_plus_plus/mcp_session_helpers.exs",
        "test/support/test_support.exs",
        "test/support/work_package_factory.exs",
        "test/symphony_elixir/symphony_plus_plus/dashboard/api_case.exs",
        "test/symphony_elixir/symphony_plus_plus/work_packages_case.exs"
      ],
      dialyzer: [
        plt_core_path: "_build/dialyzer",
        plt_add_apps: [:mix]
      ],
      escript: escript(),
      releases: releases(),
      aliases: aliases(),
      deps: deps()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      mod: {SymphonyElixir.Application, []},
      extra_applications: [:logger]
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:bandit, "~> 1.12"},
      {:phoenix, "~> 1.8"},
      {:req, "~> 0.6.1"},
      {:jason, "~> 1.4"},
      {:yaml_elixir, "~> 2.12"},
      {:solid, "~> 1.3"},
      {:ecto, "~> 3.13.0"},
      {:ecto_sql, "~> 3.13.0"},
      {:ecto_sqlite3, "~> 0.23.0"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:dialyxir, "~> 1.4", only: [:dev], runtime: false}
    ]
  end

  defp aliases do
    [
      setup: ["deps.get"],
      build: ["escript.build"],
      static: ["format --check-formatted", "lint"],
      lint: ["specs.check", "credo --strict"]
    ]
  end

  defp escript do
    [
      app: nil,
      main_module: SymphonyElixir.CLI,
      name: "symphony",
      path: "bin/symphony"
    ]
  end

  defp releases do
    [
      symphony_elixir: [
        include_executables_for: [:unix, :windows],
        applications: [
          runtime_tools: :permanent
        ]
      ]
    ]
  end
end
