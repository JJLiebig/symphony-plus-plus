// Native JSON actions share the backend's persisted operator contracts.
export function requestBody(fields) {
  const body = Object.fromEntries(["title", "repo", "base_branch", "human_description"].map((key) => [key, fields[key].trim()]));
  if (Object.values(body).some((value) => !value)) throw new Error("Fill in the title, repository, base branch and request.");
  return { ...body, work_type: "feature", desired_dispatch_shape: "architect_led_feature_branch", constraints: {}, status: "ready_for_clarification" };
}

export function answerBody(question, choice, text) {
  const note = text.trim();
  if (!question.prompt) {
    if (!note) throw new Error("Enter your answer.");
    return { answer: note };
  }
  if (choice === "__custom_redirect__") {
    if (!note) throw new Error("Describe the direction you want instead.");
  } else if (!question.prompt.options?.some((option) => option.id === choice)) {
    throw new Error("Choose an option or write another direction.");
  }
  return { answer_choice: choice, ...(note ? { answer_note: note } : {}) };
}

export function answerPath(question) {
  return question.kind === "guidance"
    ? `/api/v1/sympp/herdr/work-packages/${encodeURIComponent(question.pkgId)}/guidance/${encodeURIComponent(question.id)}/answer`
    : `/api/v1/sympp/herdr/work-requests/${encodeURIComponent(question.jobId)}/questions/${encodeURIComponent(question.id)}/answer`;
}

export async function postAction(endpoint, path, body, fetcher = fetch) {
  const response = await fetcher(`${endpoint}${path}`, {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `S++ answered ${response.status}. Try again after refreshing.`);
  if (!payload) throw new Error("S++ returned an unreadable response. Refresh before trying again.");
  return payload;
}

// The same latch protects button and keyboard activation; drafts clear only after success.
export async function submitAction(action, send, accepted) {
  if (action.pending) return;
  action.pending = true;
  action.error = null;
  try { await accepted(await send()); }
  catch (error) { action.error = error?.message || "Couldn't save. Check the connection and try again."; }
  finally { action.pending = false; }
}
