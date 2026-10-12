import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite";

// Serves the operator API from a captured snapshot (see scripts/capture-snapshot.mjs)
// so the dashboard can be developed without a backend. Writes only change memory.

const API_BASE = "/api/v1/sympp/operator";
const SUMMARY_KEYS = ["settings", "ledger", "work_requests", "generated_at", "linked_work_package_ids"];
const DEFERRED_KEYS = ["work_packages", "active_blocking_edges", "work_request_details", "guidance_requests", "generated_at"];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Snapshot = { dir: string; manifest: Json; hydrated: Json; archived: Json; solo: Json };
type Mutation = (snapshot: Snapshot, id: string, body: Json) => Json;

export function snapshotApi(): Plugin {
  const dir = resolveSnapshotDir();
  let snapshot = loadSnapshot(dir);
  let history: Json | null = null;
  const streams = new Set<ServerResponse>();
  const notify = () => streams.forEach((stream) => stream.write("event: dashboard_changed\ndata: {}\n\n"));

  return {
    name: "sympp-snapshot-api",
    configureServer(server) {
      server.config.logger.info(`  Snapshot API: ${dir} (ledger as of ${snapshot.hydrated.generated_at})`);
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url || "/", "http://spp.localhost");
        if (url.pathname === "/__snapshot/history") return sendJson(res, 200, (history ??= packageHistory(dir)));
        if (url.pathname === "/__snapshot/local") return sendJson(res, 200, localBoardConfig());
        if (url.pathname === "/__snapshot/reset") {
          snapshot = loadSnapshot(dir);
          notify();
          return sendJson(res, 200, { ok: true });
        }
        if (!url.pathname.startsWith(API_BASE)) return next();

        const route = url.pathname.slice(API_BASE.length) || "/";
        if (req.method === "GET") return handleGet(snapshot, route, url, req, res, streams);
        if (req.method === "POST") return void handlePost(snapshot, route, req, res, notify);
        return sendJson(res, 405, { error: { code: "method_not_allowed" } });
      });
    },
  };
}

function resolveSnapshotDir() {
  const configured = process.env.SYMPP_SNAPSHOT_DIR;
  if (configured) return path.resolve(configured);

  const root = path.join(os.homedir(), ".agents", "splusplus-beta", "snapshots");
  const latest = existsSync(root) ? readdirSync(root).filter((name) => existsSync(path.join(root, name, "dashboard.hydrated.json"))).sort().pop() : undefined;
  if (!latest) throw new Error(`No snapshot found under ${root}. Run: node scripts/capture-snapshot.mjs`);
  return path.join(root, latest);
}

// Operator-owned names (areas, sample wording) stay out of the repository: an optional, git-ignored
// board.local file next to this one. Without it the board files every goal as "Unfiled".
function localBoardConfig(): Json {
  const file = path.resolve("board.local");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Json) : {};
}

// Every package's progress log from the captured /work-packages/:id responses, trimmed to what a replay needs.
function packageHistory(dir: string): Json {
  const folder = path.join(dir, "work-packages");
  return Object.fromEntries(
    readdirSync(folder).map((file) => {
      const detail = JSON.parse(readFileSync(path.join(folder, file), "utf8")) as Json;
      const events = (detail.progress ?? []).map((event: Json) => ({
        t: event.created_at,
        s: event.status,
        y: event.payload?.type,
        c: event.payload?.check_summary?.status,
        m: event.payload?.merge_state?.merged === true,
        n: event.payload?.number,
        u: event.payload?.url,
        a: event.actor?.id,
        r: event.actor?.type,
        x: typeof event.summary === "string" ? event.summary.slice(0, 120) : undefined,
      }));
      return [file.replace(/\.json$/, ""), events];
    }),
  );
}

function loadSnapshot(dir: string): Snapshot {
  const read = (file: string) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Json;
  return { dir, manifest: read("manifest.json"), hydrated: read("dashboard.hydrated.json"), archived: read("dashboard.archived.json"), solo: read("dashboard.solo.json") };
}

function handleGet(snapshot: Snapshot, route: string, url: URL, req: IncomingMessage, res: ServerResponse, streams: Set<ServerResponse>) {
  if (route === "/dashboard/events") return openEventStream(req, res, streams);

  const payload = readRoute(snapshot, route, url.searchParams.get("surface"));
  return payload ? sendJson(res, 200, payload) : sendJson(res, 404, { error: { code: "not_found", message: "Not in this snapshot" } });
}

function readRoute(snapshot: Snapshot, route: string, surface: string | null): Json | null {
  const { hydrated } = snapshot;
  switch (route) {
    case "/config":
      return { apiBase: API_BASE, basePath: "", logoUrl: "/splusplus-logo.png", snapshot: { ...snapshot.manifest, simulated_writes: true } };
    case "/dashboard":
      if (surface === "archived") return snapshot.archived;
      if (surface === "solo") return snapshot.solo;
      return { ...pick(hydrated, SUMMARY_KEYS), deferred: { dashboard_sections: true } };
    case "/dashboard/deferred":
      return { ...pick(hydrated, DEFERRED_KEYS), deferred: { dashboard_sections: false } };
    case "/dashboard/hydrated":
      return hydrated;
    default:
      return readEntity(snapshot, route);
  }
}

function readEntity(snapshot: Snapshot, route: string): Json | null {
  const match = /^\/(work-packages|work-requests|solo-sessions)\/([^/]+)$/.exec(route);
  if (!match) return null;

  const id = decodeURIComponent(match[2]);
  const file = path.join(snapshot.dir, match[1], `${id}.json`);
  if (!/^[\w.-]+$/.test(id) || !existsSync(file)) return null;

  const payload = JSON.parse(readFileSync(file, "utf8")) as Json;
  const current = match[1] === "work-requests" ? requestRecords(snapshot, id)[0] : null;
  return current ? { ...payload, work_request: { ...payload.work_request, ...current } } : payload;
}

function openEventStream(req: IncomingMessage, res: ServerResponse, streams: Set<ServerResponse>) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": snapshot\n\n");
  streams.add(res);
  req.on("close", () => streams.delete(res));
}

const MUTATIONS: Array<[RegExp, Mutation]> = [
  [/^\/work-requests\/([^/]+)\/state$/, changeRequestState],
  [/^\/work-requests\/([^/]+)\/archive$/, archiveRequest],
  [/^\/work-requests\/([^/]+)\/delete$/, deleteRequest],
  [/^\/work-requests\/([^/]+)\/restore$/, restoreRequest],
  [/^\/work-requests\/([^/]+)\/architect-handoff$/, architectHandoff],
  [/^\/work-requests\/([^/]+)\/questions\/([^/]+)\/answer$/, answerQuestion],
];

async function handlePost(snapshot: Snapshot, route: string, req: IncomingMessage, res: ServerResponse, notify: () => void) {
  const body = await readBody(req);
  const mutation = MUTATIONS.find(([pattern]) => pattern.test(route));
  if (!mutation) return sendJson(res, 200, { ok: true, simulated: true, refresh: { dashboard: false } });

  const match = mutation[0].exec(route)!;
  const payload = mutation[1](snapshot, decodeURIComponent(match[1]), { ...body, question_id: match[2] && decodeURIComponent(match[2]) });
  sendJson(res, 200, { ok: true, simulated: true, refresh: { dashboard: true }, ...payload });
  notify();
}

function changeRequestState(snapshot: Snapshot, id: string, body: Json) {
  const completed = body.state === "completed";
  const patch = completed
    ? { status: "completed", completed_at: new Date().toISOString(), completion_source: "operator", operational_state: { key: "completed", label: "Completed", tone: "success", raw_status: "completed", attention_items: [] } }
    : { status: body.state, completed_at: null, operational_state: { key: body.state, label: "Ready For Slicing", tone: "neutral", raw_status: body.state, attention_items: [] } };
  requestRecords(snapshot, id).forEach((record) => Object.assign(record, patch));
  return { work_request: { id, ...patch } };
}

function archiveRequest(snapshot: Snapshot, id: string) {
  const [card] = requestRecords(snapshot, id);
  const archived = { ...card, id, archived_at: new Date().toISOString(), archive_reason: "operator" };
  removeRequest(snapshot, id);
  const section = (snapshot.archived.archived_work_requests ??= { work_requests: [] });
  section.work_requests = [archived, ...(section.work_requests ?? [])];
  section.total_count = section.work_requests.length;
  return { work_request: archived };
}

function deleteRequest(snapshot: Snapshot, id: string) {
  removeRequest(snapshot, id);
  return { work_request: { id } };
}

function restoreRequest(snapshot: Snapshot, id: string) {
  const section = snapshot.archived.archived_work_requests ?? {};
  section.work_requests = (section.work_requests ?? []).filter((card: Json) => card.id !== id);
  section.total_count = section.work_requests.length;
  return { work_request: { id, archived_at: null } };
}

function architectHandoff(snapshot: Snapshot, id: string) {
  const [card] = requestRecords(snapshot, id);
  const prompt = `Snapshot preview. A live backend would issue an architect handoff for "${card?.title ?? id}" (${card?.repo ?? "unknown repo"}).`;
  return { refresh: { dashboard: false }, architect_handoff: { status: "simulated", prompt, work_request: { id, repo: card?.repo, base_branch: card?.base_branch, status: card?.status } } };
}

function answerQuestion(snapshot: Snapshot, id: string, body: Json) {
  const detail = (snapshot.hydrated.work_request_details ?? []).find((entry: Json) => entry.work_request?.id === id);
  const question = (detail?.clarification_questions ?? []).find((entry: Json) => entry.id === body.question_id);
  if (question) Object.assign(question, { status: "answered", answer: body.answer || body.answer_note || body.answer_choice, answered_by: "operator", answered_at: new Date().toISOString() });
  return {};
}

function requestRecords(snapshot: Snapshot, id: string): Json[] {
  const cards = snapshot.hydrated.work_requests?.work_requests ?? [];
  const details = (snapshot.hydrated.work_request_details ?? []).map((detail: Json) => detail.work_request);
  return [...cards, ...details].filter((record: Json) => record?.id === id);
}

function removeRequest(snapshot: Snapshot, id: string) {
  const { hydrated } = snapshot;
  if (hydrated.work_requests?.work_requests) {
    hydrated.work_requests.work_requests = hydrated.work_requests.work_requests.filter((card: Json) => card.id !== id);
    hydrated.work_requests.total_count = hydrated.work_requests.work_requests.length;
  }
  hydrated.work_request_details = (hydrated.work_request_details ?? []).filter((detail: Json) => detail.work_request?.id !== id);
}

function pick(source: Json, keys: string[]) {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}

async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Json;
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, status: number, payload: Json) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}
