defmodule SymphonyElixir.SymphonyPlusPlus.Title do
  @moduledoc false

  import Ecto.Changeset

  @spec validate(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  def validate(changeset) do
    changeset
    |> update_change(:title, fn title -> if is_binary(title), do: String.trim(title), else: title end)
    |> validate_change(:title, fn :title, title ->
      length = String.length(title)

      if length > 40 do
        [title: "Title is #{length} characters; keep it to 2–5 words (max 40) and put detail in the description."]
      else
        []
      end
    end)
  end
end
