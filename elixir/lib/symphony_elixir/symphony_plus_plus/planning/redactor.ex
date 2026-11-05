defmodule SymphonyElixir.SymphonyPlusPlus.Planning.Redactor do
  @moduledoc false

  @redacted "[REDACTED]"
  @sensitive_text_pattern ~r/(bearer\s+[A-Za-z0-9._~+\/=-]{8,}|wk_[A-Za-z0-9_-]{43,}|raw[_-]?secret[_-][A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})/i
  @url_pattern ~r/https?:\/\/[^\s<>"']+/i

  @sensitive_keys MapSet.new([
                    "access_token",
                    "api_key",
                    "apikey",
                    "authorization",
                    "bearer",
                    "claim_secret",
                    "client_secret",
                    "password",
                    "private_key",
                    "private_payload",
                    "raw_secret",
                    "refresh_token",
                    "secret",
                    "secret_hash",
                    "secret_key",
                    "token",
                    "work_key",
                    "work_key_secret"
                  ])

  @sensitive_query_keys MapSet.new([
                          "access_key_id",
                          "access_token",
                          "api_key",
                          "apikey",
                          "authorization",
                          "aws_access_key_id",
                          "client_secret",
                          "credential",
                          "raw_secret",
                          "refresh_token",
                          "secret",
                          "secret_key",
                          "security_token",
                          "session_token",
                          "sig",
                          "signature",
                          "token",
                          "x_amz_credential",
                          "x_amz_security_token",
                          "x_amz_signature",
                          "x_goog_credential",
                          "x_goog_signature"
                        ])

  @spec redact(term()) :: term()
  def redact(%DateTime{} = datetime), do: datetime
  def redact(%Date{} = date), do: date
  def redact(%NaiveDateTime{} = datetime), do: datetime
  def redact(%Time{} = time), do: time
  def redact(%_{} = struct), do: struct |> Map.from_struct() |> redact()

  def redact(%{} = map) do
    collisions = key_collisions(map)

    map
    |> Enum.map(fn {key, value} ->
      string_key = normalize_key(key)
      output_key = output_key(key, string_key, collisions)
      redacted_value = if sensitive_key?(string_key), do: @redacted, else: redact(value)

      {output_key, key, redacted_value}
    end)
    |> Enum.reduce(%{}, fn {output_key, key, value}, redacted ->
      Map.put(redacted, unique_output_key(output_key, key, redacted), value)
    end)
  end

  def redact(values) when is_list(values), do: Enum.map(values, &redact/1)
  def redact({key, value}) when is_atom(key) or is_binary(key), do: {key, redact_key_value(key, value)}
  def redact(value) when is_tuple(value), do: value |> Tuple.to_list() |> redact() |> List.to_tuple()
  def redact(value) when is_binary(value) or is_number(value) or is_boolean(value) or is_nil(value), do: value
  def redact(value) when is_atom(value), do: Atom.to_string(value)
  def redact(value), do: inspect(value)

  @spec redact_output(term()) :: term()
  def redact_output(value) do
    value
    |> redact()
    |> redact_text_values()
  end

  @spec redact_text(term()) :: term()
  def redact_text(nil), do: nil

  def redact_text(value) when is_binary(value) do
    value
    |> redact_signed_url_text()
    |> redact_sensitive_text()
  end

  def redact_text(value), do: value

  @spec json_safe(term()) :: term()
  def json_safe(%DateTime{} = datetime), do: DateTime.to_iso8601(datetime)
  def json_safe(%Date{} = date), do: Date.to_iso8601(date)
  def json_safe(%NaiveDateTime{} = datetime), do: NaiveDateTime.to_iso8601(datetime)
  def json_safe(%Time{} = time), do: Time.to_iso8601(time)

  def json_safe(%{} = map) do
    Map.new(map, fn {key, value} -> {normalize_key(key), json_safe(value)} end)
  end

  def json_safe(values) when is_list(values), do: Enum.map(values, &json_safe/1)
  def json_safe(value) when is_tuple(value), do: value |> Tuple.to_list() |> json_safe()
  def json_safe(value) when is_binary(value) or is_number(value) or is_boolean(value) or is_nil(value), do: value
  def json_safe(value) when is_atom(value), do: Atom.to_string(value)
  def json_safe(value), do: inspect(value)

  defp key_collisions(map) do
    map
    |> Map.keys()
    |> Enum.map(&normalize_key/1)
    |> Enum.frequencies()
  end

  defp output_key(key, normalized_key, collisions) do
    if Map.get(collisions, normalized_key, 0) > 1 and not is_binary(key) do
      inspect(key)
    else
      normalized_key
    end
  end

  defp unique_output_key(output_key, key, redacted) do
    cond do
      not Map.has_key?(redacted, output_key) ->
        output_key

      inspect(key) != output_key and not Map.has_key?(redacted, inspect(key)) ->
        inspect(key)

      true ->
        disambiguated_output_key(output_key, redacted, 2)
    end
  end

  defp disambiguated_output_key(output_key, redacted, index) do
    candidate = "#{output_key}##{index}"

    if Map.has_key?(redacted, candidate) do
      disambiguated_output_key(output_key, redacted, index + 1)
    else
      candidate
    end
  end

  defp sensitive_key?(key) do
    normalized = normalize_sensitive_key(key)

    MapSet.member?(@sensitive_keys, normalized) or String.ends_with?(normalized, "_secret") or
      String.ends_with?(normalized, "_token") or String.ends_with?(normalized, "_password") or
      String.ends_with?(normalized, "_authorization") or String.ends_with?(normalized, "_api_key") or
      String.ends_with?(normalized, "_apikey")
  end

  defp normalize_sensitive_key(key) do
    if canonical_key?(key, false) do
      key
    else
      key
      |> camel_to_snake()
      |> String.downcase()
      |> String.replace(~r/[^a-z0-9]+/, "_")
      |> String.trim("_")
    end
  end

  defp canonical_key?(<<>>, _segment?), do: true

  defp canonical_key?(<<char, rest::binary>>, _segment?) when char in ?a..?z or char in ?0..?9,
    do: canonical_key?(rest, true)

  defp canonical_key?(<<?_, next, rest::binary>>, true) when next in ?a..?z or next in ?0..?9,
    do: canonical_key?(rest, true)

  defp canonical_key?(_key, _segment?), do: false

  defp redact_text_values(%{} = value) do
    Enum.reduce(value, %{}, fn {key, field_value}, redacted ->
      redacted_key = key |> redact_text() |> unique_redacted_text_key(redacted)
      Map.put(redacted, redacted_key, redact_text_values(field_value))
    end)
  end

  defp redact_text_values(values) when is_list(values), do: Enum.map(values, &redact_text_values/1)
  defp redact_text_values(value) when is_binary(value), do: redact_text(value)
  defp redact_text_values(value), do: value

  defp unique_redacted_text_key(key, redacted) do
    if Map.has_key?(redacted, key) do
      disambiguated_output_key(key, redacted, 2)
    else
      key
    end
  end

  defp redact_sensitive_text(value), do: Regex.replace(@sensitive_text_pattern, value, @redacted)

  defp redact_signed_url_text(value) do
    Regex.replace(@url_pattern, value, &redact_url_query/1)
  end

  defp redact_url_query(url) do
    uri = URI.parse(url)

    if is_binary(uri.query) do
      uri
      |> Map.put(:query, redact_query(uri.query))
      |> URI.to_string()
    else
      url
    end
  rescue
    _ -> url
  end

  defp redact_query(query) do
    query
    |> String.split("&", trim: false)
    |> Enum.map_join("&", &redact_query_part/1)
  end

  defp redact_query_part(part) do
    case String.split(part, "=", parts: 2) do
      [key, value] ->
        if sensitive_query_key?(key) or secret_text?(value) or secret_text?(decode_www_form(value)) do
          "#{key}=#{@redacted}"
        else
          "#{key}=#{redact_sensitive_text(value)}"
        end

      [key] ->
        if sensitive_query_key?(key), do: "#{key}=#{@redacted}", else: key
    end
  end

  defp sensitive_query_key?(key) do
    decoded_key = decode_www_form(key)

    normalized =
      decoded_key
      |> camel_to_snake()
      |> String.downcase()
      |> String.replace(~r/[^a-z0-9]+/, "_")
      |> String.trim("_")

    sensitive_key?(decoded_key) or MapSet.member?(@sensitive_query_keys, normalized) or String.ends_with?(normalized, "_token") or
      String.ends_with?(normalized, "_secret") or String.ends_with?(normalized, "_signature") or
      String.ends_with?(normalized, "_sig")
  end

  defp secret_text?(value) when is_binary(value), do: Regex.match?(@sensitive_text_pattern, value)

  defp decode_www_form(value) do
    URI.decode_www_form(value)
  rescue
    _ -> value
  end

  defp redact_key_value(key, value) do
    if key |> normalize_key() |> sensitive_key?() do
      @redacted
    else
      redact(value)
    end
  end

  defp camel_to_snake(key) do
    key
    |> String.replace(~r/([A-Z]+)([A-Z][a-z])/, "\\1_\\2")
    |> String.replace(~r/([a-z0-9])([A-Z])/, "\\1_\\2")
  end

  defp normalize_key(key) when is_atom(key), do: Atom.to_string(key)
  defp normalize_key(key) when is_binary(key), do: key
  defp normalize_key(key), do: inspect(key)
end
