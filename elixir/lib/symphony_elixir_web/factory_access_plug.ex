defmodule SymphonyElixirWeb.FactoryAccessPlug do
  @moduledoc false

  alias Plug.Conn
  alias SymphonyElixir.SymphonyPlusPlus.FactoryService

  @cookie "sympp_board"
  @session_age 30 * 24 * 60 * 60

  @spec init(keyword()) :: keyword()
  def init(opts), do: opts

  @spec call(Conn.t(), keyword()) :: Conn.t()
  def call(conn, _opts) do
    cond do
      not FactoryService.enabled?() or loopback?(conn.remote_ip) -> conn
      tailnet_board_read?(conn) -> Conn.put_private(conn, :sympp_board_read_only, true)
      not (valid_token?(conn) or valid_board_cookie?(conn)) -> deny(conn, 401)
      forwarded?(conn) -> deny(conn, 403)
      true -> authenticate(conn)
    end
  end

  @spec authenticated?(Conn.t()) :: boolean()
  def authenticated?(conn), do: conn.private[:sympp_remote_authenticated] == true

  @spec board_read_only?(Conn.t()) :: boolean()
  def board_read_only?(conn), do: conn.private[:sympp_board_read_only] == true

  defp tailnet_board_read?(conn) do
    conn.method in ["GET", "HEAD"] and Conn.get_req_header(conn, "authorization") == [] and
      not valid_board_cookie?(conn) and
      tailnet?(conn.remote_ip) and not forwarded?(conn) and board_path?(conn.path_info)
  end

  defp board_path?([]), do: true
  defp board_path?(["sympp" | _]), do: true
  defp board_path?(["assets" | _]), do: true
  defp board_path?([file]) when file in ["favicon.ico", "splusplus-logo.png"], do: true
  defp board_path?(["api", "v1", "sympp", "operator", "dashboard", kind]) when kind in ["hydrated", "events"], do: true
  defp board_path?(_), do: false

  defp tailnet?({100, second, _, _}) when second in 64..127, do: true
  defp tailnet?({0xFD7A, 0x115C, 0xA1E0, _, _, _, _, _}), do: true
  defp tailnet?({0, 0, 0, 0, 0, 65_535, first, second}), do: tailnet?({div(first, 256), rem(first, 256), div(second, 256), rem(second, 256)})
  defp tailnet?(_), do: false

  defp authenticate(%Conn{method: "POST", path_info: ["api", "v1", "sympp", "board-session"]} = conn) do
    cookie = Phoenix.Token.sign(cookie_key(), "sympp-board", "operator")

    conn
    |> Conn.put_resp_cookie(@cookie, cookie, http_only: true, same_site: "Strict", secure: conn.scheme == :https, max_age: @session_age, path: "/")
    |> Conn.put_resp_header("cache-control", "no-store")
    |> Conn.send_resp(204, "")
    |> Conn.halt()
  end

  defp authenticate(conn), do: Conn.put_private(conn, :sympp_remote_authenticated, true)

  defp valid_board_cookie?(conn) do
    board_cookie_path?(conn.path_info) and cookie_origin?(conn) and
      is_binary(cookie_key()) and verified_cookie?(Conn.fetch_cookies(conn).cookies[@cookie])
  end

  defp board_cookie_path?(["api", "v1", "sympp", "operator" | _]), do: true
  defp board_cookie_path?(path), do: board_path?(path)

  defp cookie_origin?(%Conn{method: method}) when method in ["GET", "HEAD"], do: true

  defp cookie_origin?(conn) do
    Conn.get_req_header(conn, "origin") == [URI.to_string(%URI{scheme: Atom.to_string(conn.scheme), host: conn.host, port: conn.port})]
  end

  defp verified_cookie?(value) when is_binary(value) do
    Phoenix.Token.verify(cookie_key(), "sympp-board", value, max_age: @session_age) == {:ok, "operator"}
  end

  defp verified_cookie?(_), do: false
  defp cookie_key, do: Application.get_env(:symphony_elixir, :sympp_remote_token_hash)

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
