import Config

if config_env() == :prod do
  truthy? = fn value ->
    value
    |> to_string()
    |> String.trim()
    |> String.downcase()
    |> then(&(&1 in ["1", "true", "yes", "on"]))
  end

  parse_port! = fn name ->
    value = System.get_env(name, "")

    case Integer.parse(value) do
      {port, ""} when port >= 0 and port <= 65_535 ->
        port

      _invalid ->
        raise "#{name} must be a non-negative integer from 0 to 65535"
    end
  end

  if truthy?.(System.get_env("SYMPP_RUNTIME_ARTIFACT")) do
    unless truthy?.(System.get_env("SYMPP_RUNTIME_ARTIFACT_ACKNOWLEDGED")) do
      raise "SYMPP_RUNTIME_ARTIFACT_ACKNOWLEDGED is required for packaged runtime startup"
    end

    workflow_file = System.get_env("SYMPP_WORKFLOW_FILE", "") |> String.trim()
    logs_root = System.get_env("SYMPP_LOGS_ROOT", "") |> String.trim()
    database = System.get_env("SYMPP_DATABASE", "") |> String.trim()

    if workflow_file != "" and not File.regular?(workflow_file) do
      raise "SYMPP_WORKFLOW_FILE must point to a readable WORKFLOW.md file"
    end

    if logs_root == "" do
      raise "SYMPP_LOGS_ROOT is required for packaged runtime startup"
    end

    if workflow_file != "" do
      config :symphony_elixir, :workflow_file_path, Path.expand(workflow_file)
    end

    if database != "" do
      config :symphony_elixir, :sympp_repo_database, Path.expand(database)
    end

    config :symphony_elixir, :log_file, Path.join(Path.expand(logs_root), "log/symphony.log")
    config :symphony_elixir, :server_port_override, parse_port!.("SYMPP_BACKEND_PORT")
    config :symphony_elixir, SymphonyElixirWeb.Endpoint, server: true, sympp_local_operator: true
  else
    case System.get_env("SYMPP_BACKEND_PORT") do
      nil ->
        :ok

      "" ->
        :ok

      _value ->
        config :symphony_elixir, :server_port_override, parse_port!.("SYMPP_BACKEND_PORT")
    end
  end
end
