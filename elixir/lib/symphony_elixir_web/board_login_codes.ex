defmodule SymphonyElixirWeb.BoardLoginCodes do
  @moduledoc false
  use Agent

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(_opts), do: Agent.start_link(fn -> %{} end, name: __MODULE__)

  @spec issue(binary()) :: String.t()
  def issue(key) do
    code = Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)
    now = System.monotonic_time(:second)

    Agent.update(__MODULE__, fn codes ->
      codes
      |> Map.reject(fn {_code, {_key, expires}} -> expires <= now end)
      |> Map.put(code, {key, now + 60})
    end)

    code
  end

  @spec consume(String.t(), binary()) :: boolean()
  def consume(code, key) do
    Agent.get_and_update(__MODULE__, fn codes ->
      {entry, codes} = Map.pop(codes, code)
      now = System.monotonic_time(:second)
      valid = match?({^key, expires} when expires > now, entry)
      {valid, codes}
    end)
  end
end
