defmodule SymphonyElixir.SymphonyPlusPlus.WorkRequests.OperatorReport do
  @moduledoc false

  import Ecto.Query, only: [from: 2]

  alias SymphonyElixir.SymphonyPlusPlus.MCP.{CurrentWorkRequest, Session, WorkRequestScope}
  alias SymphonyElixir.SymphonyPlusPlus.Planning.{ProgressEvent, Redactor}
  alias SymphonyElixir.SymphonyPlusPlus.WorkRequests.{ArchitectHandoff, WorkRequest}

  @type repo :: module()
  @fields ["brief", "eta", "parking", "human_escalation"]
  @event_type "architect_operator_report"

  @spec authorized_payload(repo(), Session.t(), map()) :: {:ok, String.t(), map()} | {:error, term()} | {:tool_error, String.t()}
  def authorized_payload(repo, %Session{assignment: %{grant_role: "architect"}} = session, arguments) do
    with {:ok, work_request_id} <- CurrentWorkRequest.id_argument(%{}, session),
         {:ok, work_request, _filters, _scope} <-
           WorkRequestScope.authorized_work_request_scope(repo, session, work_request_id, :progress_append, "append_progress"),
         anchor_id = ArchitectHandoff.anchor_id_for_work_request(work_request),
         true <- Map.get(arguments, "work_package_id") == anchor_id and Session.work_package_id(session) == anchor_id,
         {:ok, patch} <- normalize_patch(Map.fetch!(arguments, "payload")) do
      {:ok, anchor_id, Map.merge(patch, %{"type" => @event_type, "source_tool" => @event_type})}
    else
      false -> {:error, :forbidden}
      error -> error
    end
  end

  def authorized_payload(_repo, %Session{}, _arguments), do: {:error, :forbidden}

  @spec load_many(repo(), [WorkRequest.t()]) :: {:ok, %{String.t() => map() | nil}} | {:error, term()}
  def load_many(_repo, []), do: {:ok, %{}}

  def load_many(repo, work_requests) do
    anchors = Map.new(work_requests, &{&1.id, ArchitectHandoff.anchor_id_for_work_request(&1)})

    events_by_anchor =
      anchors
      |> Map.values()
      |> Enum.chunk_every(500)
      |> Enum.flat_map(fn anchor_ids ->
        repo.all(
          from(event in ProgressEvent,
            where: event.work_package_id in ^anchor_ids,
            where: event.actor_type == "architect" and not is_nil(event.access_grant_id),
            order_by: [asc: event.sequence]
          )
        )
      end)
      |> Enum.group_by(& &1.work_package_id)

    {:ok, Map.new(anchors, fn {id, anchor_id} -> {id, project(Map.get(events_by_anchor, anchor_id, []))} end)}
  rescue
    error in Exqlite.Error -> {:error, {:storage_failed, Exception.message(error)}}
  end

  defp normalize_patch(payload) do
    payload
    |> Map.take(@fields)
    |> Enum.reduce_while({:ok, %{}}, fn {field, value}, {:ok, patch} ->
      case normalize_field(field, value) do
        {:ok, normalized} -> {:cont, {:ok, Map.put(patch, field, normalized)}}
        :error -> {:halt, {:tool_error, "invalid_operator_report_#{field}"}}
      end
    end)
  end

  defp normalize_field(_field, nil), do: {:ok, nil}
  defp normalize_field(field, text) when field in ["brief", "eta"], do: normalize_text(text)

  defp normalize_field("parking", %{"reason" => reason}) do
    with {:ok, reason} <- normalize_text(reason), do: {:ok, %{"reason" => reason}}
  end

  defp normalize_field("human_escalation", %{"question" => question}) do
    with {:ok, question} <- normalize_text(question), do: {:ok, %{"question" => question}}
  end

  defp normalize_field(_field, _value), do: :error

  defp normalize_text(text) when is_binary(text) do
    text = String.trim(text)

    if text != "" and String.length(text) <= ProgressEvent.payload_string_limit() do
      {:ok, text}
    else
      :error
    end
  end

  defp normalize_text(_text), do: :error

  defp project(events) do
    events
    |> Enum.filter(&report_event?/1)
    |> Enum.reduce(%{}, fn event, report ->
      written_at = DateTime.to_iso8601(event.created_at)

      event.payload
      |> Map.take(@fields)
      |> Enum.reduce(report, fn {field, value}, acc ->
        Map.put(acc, field, apply_field(field, value, Map.get(acc, field), written_at))
      end)
    end)
    |> case do
      report when map_size(report) == 0 -> nil
      report -> Redactor.redact_output(report)
    end
  end

  defp report_event?(%ProgressEvent{
         actor_type: "architect",
         access_grant_id: grant_id,
         created_at: %DateTime{},
         payload: %{"type" => @event_type, "source_tool" => @event_type} = payload
       })
       when is_binary(grant_id) and grant_id != "" do
    match?({:ok, _patch}, normalize_patch(payload))
  end

  defp report_event?(_event), do: false

  defp apply_field(field, text, _previous, written_at) when field in ["brief", "eta"] do
    %{"text" => text, "written_at" => written_at}
  end

  defp apply_field("parking", value, previous, written_at) do
    apply_interval(value, previous, written_at, "reason", "parked_at", "resumed_at")
  end

  defp apply_field("human_escalation", value, previous, written_at) do
    apply_interval(value, previous, written_at, "question", "raised_at", "resolved_at")
  end

  defp apply_interval(nil, nil, _written_at, _text_key, _opened_key, _closed_key), do: nil

  defp apply_interval(nil, previous, written_at, _text_key, _opened_key, closed_key) do
    Map.put(previous, closed_key, Map.get(previous, closed_key) || written_at)
  end

  defp apply_interval(value, previous, written_at, text_key, opened_key, closed_key) do
    opened_at = if previous && is_nil(previous[closed_key]), do: previous[opened_key], else: written_at
    %{text_key => value[text_key], opened_key => opened_at, closed_key => nil}
  end
end
