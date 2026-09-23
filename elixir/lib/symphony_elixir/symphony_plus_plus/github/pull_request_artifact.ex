defmodule SymphonyElixir.SymphonyPlusPlus.GitHub.PullRequestArtifact do
  @moduledoc false

  alias SymphonyElixir.SymphonyPlusPlus.Planning.Artifact
  alias SymphonyElixir.SymphonyPlusPlus.Planning.Repository, as: PlanningRepository

  @path "github-pr.json"
  @kind "github_pr"

  @type repo :: module()

  @spec upsert(repo(), String.t(), map(), keyword()) :: {:ok, boolean()} | {:error, term()}
  def upsert(repo, work_package_id, payload, opts \\ [])
      when is_atom(repo) and is_binary(work_package_id) and is_map(payload) and is_list(opts) do
    attrs =
      work_package_id
      |> artifact_attrs(payload)
      |> maybe_put_metadata(Keyword.get(opts, :metadata, %{}))

    case PlanningRepository.get_artifact(repo, attrs.id) do
      {:ok, nil} -> append_artifact(repo, attrs)
      {:ok, %Artifact{} = artifact} -> update_artifact(repo, artifact, attrs)
      {:error, reason} -> {:error, reason}
    end
  end

  defp artifact_attrs(work_package_id, payload) do
    %{
      id: artifact_id(work_package_id),
      work_package_id: work_package_id,
      path: @path,
      title: title(payload),
      kind: @kind,
      uri: Map.get(payload, "url")
    }
  end

  defp maybe_put_metadata(attrs, metadata) when is_map(metadata) and map_size(metadata) > 0 do
    Map.put(attrs, :metadata, metadata)
  end

  defp maybe_put_metadata(attrs, _metadata), do: attrs

  defp append_artifact(repo, attrs) do
    case PlanningRepository.append_artifact(repo, attrs) do
      {:ok, _artifact} -> {:ok, true}
      {:error, :id_already_exists} -> {:ok, false}
      {:error, reason} -> {:error, reason}
    end
  end

  defp update_artifact(repo, %Artifact{} = artifact, attrs) do
    attrs = Map.take(attrs, [:title, :kind, :uri, :metadata])

    if Enum.all?(attrs, fn {key, value} -> Map.get(artifact, key) == value end) do
      {:ok, false}
    else
      case PlanningRepository.update_artifact(repo, artifact, attrs) do
        {:ok, _artifact} -> {:ok, true}
        {:error, reason} -> {:error, reason}
      end
    end
  end

  defp title(%{"repository" => repository, "number" => number}) when is_binary(repository) and is_integer(number) do
    "GitHub PR #{repository}##{number}"
  end

  defp title(_payload), do: "GitHub PR metadata"

  defp artifact_id(work_package_id) do
    material = [work_package_id, @path] |> Enum.join(":")
    "artifact_" <> Base.url_encode64(:crypto.hash(:sha256, material), padding: false)
  end
end
