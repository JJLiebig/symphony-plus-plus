defmodule SymphonyElixirWeb.FactoryAccessPlug do
  @moduledoc false

  alias Plug.Conn
  alias SymphonyElixir.SymphonyPlusPlus.FactoryService

  @spec init(keyword()) :: keyword()
  def init(opts), do: opts

  @spec call(Conn.t(), keyword()) :: Conn.t()
  def call(conn, _opts) do
    cond do
      not FactoryService.enabled?() or loopback?(conn.remote_ip) -> conn
      not valid_token?(conn) -> deny(conn, 401)
      forwarded?(conn) -> deny(conn, 403)
      true -> Conn.put_private(conn, :sympp_remote_authenticated, true)
    end
  end

  @spec authenticated?(Conn.t()) :: boolean()
  def authenticated?(conn), do: conn.private[:sympp_remote_authenticated] == true

  defp valid_token?(conn) do
    with ["Bearer " <> token] <- Conn.get_req_header(conn, "authorization"),
         expected when is_binary(expected) <- Application.get_env(:symphony_elixir, :sympp_remote_token_hash) do
      Plug.Crypto.secure_compare(:crypto.hash(:sha256, token), expected)
    else
      _ -> false
    end
  end

  defp forwarded?(conn) do
    Enum.any?(conn.req_headers, fn {name, _} ->
      name in ["forwarded", "x-real-ip"] or String.starts_with?(name, "x-forwarded-")
    end)
  end

  defp loopback?({127, _, _, _}), do: true
  defp loopback?({0, 0, 0, 0, 0, 0, 0, 1}), do: true
  defp loopback?({0, 0, 0, 0, 0, 65_535, first, _}) when first in 0x7F00..0x7FFF, do: true
  defp loopback?(_), do: false

  defp deny(conn, status) do
    conn
    |> Conn.put_resp_content_type("application/json")
    |> Conn.send_resp(status, ~s({"error":"unauthorized"}))
    |> Conn.halt()
  end
end
