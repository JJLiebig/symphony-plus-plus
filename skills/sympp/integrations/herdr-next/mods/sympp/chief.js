// Pure chief logic: the chief's brief and command, resuming a stopped chief, the factory's machine,
// where the chief starts and its place among Herdr's topics. No GPUI or Herdr imports; chiefview.js
// draws the dialog and runs these against Herdr.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
// Agents that take their first message another way than as the last argument, as in Change anything.
const MESSAGE = { opencode: (m) => ["--prompt", m], gemini: (m) => ["-i", m], copilot: (m) => ["-i", m] };

// What the chief is told; the person's own words follow.
export function chiefBrief(name, extra = "") {
  const brief = `You are the chief for the "${name}" topic. Use the sympp skill, and register as its chief with register_chief, using "${name}" as the domain.`;
  return extra.trim() ? `${brief}\n\n${extra.trim()}` : brief;
}

export const chiefArgv = (agent, brief) => [...agent.run, ...(MESSAGE[agent.key] ?? ((m) => [m]))(brief)];

export const chiefSpaceName = (name) => `${name} chief`;

// Agents whose saved session can be resumed, as herdr-core resumes them after a restart: the arguments
// after the agent's own command.
const RESUME = { codex: (id) => ["resume", id], claude: (id) => ["--resume", id] };

// Each topic's latest chief: { [topic id]: { terminal, agent, session, cwd, started? } }. Start chief
// records the terminal it started or resumed; while the chief runs, the sympp panel adds the session
// Herdr saved for it, kept after its program ends (Herdr then forgets it) so the topic's mark can
// resume it.
export const CHIEF_SESSIONS = "sympp.chief.sessions";
// How long a chief Start chief just started counts as running before its agent shows in its terminal.
const STARTING = 30e3;

// The factory's repos root as it reports it (its SYMPP_REPOS_ROOT), shared by the sympp panel; null
// when it has none.
export const FACTORY_ROOT = "sympp.factory.root";

// A running chief's terminal as a CHIEF_SESSIONS entry, when its agent saved a session it can resume.
export function chiefSession(term) {
  const agent = term?.program?.key, session = term?.resume_session;
  if (term?.state !== "live" || !RESUME[agent] || typeof session !== "string" || !session) return null;
  return { terminal: term.address, agent, session, cwd: term.foreground?.cwd || term.cwd || "" };
}

export const machineOf = (address) => (address.includes("/") ? address.slice(0, address.indexOf("/")) : null);

// The topic's latest chief runs in its terminal: its agent runs there, or Start chief has just started
// it. That is the topic's chief from its start, before it registers or after it lost its registration.
export const chiefRunning = (last, terminalList, now = Date.now()) => Boolean(last?.terminal) && terminalList.some((k) =>
  k.address === last.terminal && k.state === "live" && (k.program?.key === last.agent || (last.started > 0 && now - last.started < STARTING)));

export const canResume = (last) => Boolean(last && RESUME[last.agent] && typeof last.session === "string" && last.session);

// Resumes the recorded session with the agent's own command, told again to register: a resumed
// session's sympp connection is new, and only register_chief ties it to the topic.
export const resumeArgv = (agent, last, name) => [...agent.run, ...RESUME[last.agent](last.session), chiefBrief(name)];

// Where Start chief records the spaces it made: { [space id]: topic id }.
export const CHIEF_SPACES = "sympp.chief.spaces";

// A topic's chief space: one Start chief made for it, or one named as it names them (spaces made before
// it kept a record). Reached from the topic's sympp mark, never listed; the desk-topics chrome keeps
// the same rule.
export const isChiefSpace = (space, topic, made) => made?.[space.id] === topic.id || space.name === chiefSpaceName(topic.name);

export function endpointHost(endpoint) {
  const host = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(endpoint ?? "")?.[1];
  return host ? host.replace(/^\[|\]$/g, "").toLowerCase() : null;
}

// The Herdr machine the factory runs on: this computer (null) for a loopback endpoint; else the
// machine named, reached or hosted at the endpoint's host, or whose ssh destination resolves to it
// (setup takes a remote factory's address from its ssh host). Undefined when none matches.
export async function factoryMachine(endpoint, list, resolve) {
  const host = endpointHost(endpoint);
  if (!host || LOOPBACK.has(host)) return null;
  const same = (value) => typeof value === "string" && value.toLowerCase() === host;
  const named = list.find((m) => same(m.name) || same(m.target) || same(m.host));
  if (named) return named.name;
  for (const m of list.filter((m) => !m.via && m.target)) if (same(await resolve(m.target).catch(() => null))) return m.name;
  return undefined;
}

// A registration locates a terminal, independently of its MCP helper's process lifetime.
// Core ids disambiguate equal terminal ids; names and hostnames cover registrations without one.
export function chiefTerminal(chief, machineList, terminalList) {
  const session = chief.session;
  if (!session?.terminalId) return null;
  const same = (a, b) => typeof a === "string" && Boolean(a) && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  const machine = machineList.find((m) => session.coreId ? m.id === session.coreId
    : same(m.name, session.machineId) || same(m.host, session.machineId));
  if (!machine) return null;
  const address = machine.name ? `${machine.name}/${session.terminalId}` : session.terminalId;
  return terminalList.find((t) => t.address === address && t.state === "live")?.address ?? null;
}

const trimmed = (path) => path.replace(/[\\/]+$/, "");
const parent = (path) => (/[\\/]/.test(trimmed(path)) ? trimmed(path).replace(/[\\/][^\\/]*$/, "") : "");
const worktree = (path) => /[\\/]\.worktrees([\\/]|$)/.test(path);
const parts = (path) => trimmed(path).split(/[\\/]/);
const joined = (list, like) => list.join(like.includes("\\") && !like.includes("/") ? "\\" : "/");
const common = (lists) => {
  let n = 0;
  while (lists.every((l) => n < l.length && l[n] === lists[0][n])) n++;
  return lists[0].slice(0, n);
};
// A space showing a git checkout; worktrees don't count.
const checkout = (s) => typeof s.folder === "string" && Boolean(s.folder) && Boolean(s.branch) && !worktree(s.folder);

// A machine's repos root, from its own spaces: where the folders holding its checkouts meet. Null
// when it shows no checkout, or they only meet at the top of the file system.
export function reposRoot(spaceList, machine) {
  const holders = spaceList.filter((s) => checkout(s) && (s.machine ?? null) === machine).map((s) => parent(s.folder)).filter(Boolean);
  const root = holders.length ? common(holders.map(parts)) : [];
  return root.length > 1 ? joined(root, holders[0]) : null;
}

// Where the chief starts on its machine, best first: the folder holding the topic's checkouts (where
// those folders meet, on whichever machines they are), at the same place under the chief machine's
// repos root as under their own; else that repos root. Empty: the machine's home. A machine's repos
// roots, best first: the factory's own (factory: { machine, root }) on the factory's machine when it
// reports one, then the one its spaces show; a checkout counts under the first that holds it.
// topicSpaces leaves out the topic's chief spaces.
export function chiefFolders(topicSpaces, allSpaces, machine, factory = null) {
  const own = (m) => (factory?.root && factory.machine !== undefined && (factory.machine ?? null) === m ? [factory.root] : []);
  const roots = (m) => [...own(m), reposRoot(allSpaces, m)].filter(Boolean);
  const targets = roots(machine);
  if (!targets.length) return [];
  const places = [];
  for (const s of topicSpaces.filter(checkout)) {
    const holder = parts(parent(s.folder));
    const base = roots(s.machine ?? null).map(parts).find((b) => holder.length >= b.length && b.every((p, i) => p === holder[i]));
    if (base) places.push(holder.slice(base.length));
  }
  const place = places.length ? common(places) : [];
  const folders = targets.flatMap((root) => (place.length ? [joined([...parts(root), ...place], root), root] : [root]));
  return folders.filter((f, i) => folders.indexOf(f) === i);
}

// Herdr's topics with the space added to the end of the topic and the topic unfolded; null when the
// topic is gone.
export function intoTopic(deskTopics, topic, space) {
  const next = JSON.parse(JSON.stringify(deskTopics ?? { groups: [], unsorted: [] }));
  const group = (next.groups ?? []).find((g) => g.id === topic);
  if (!group) return null;
  next.unsorted = (next.unsorted ?? []).filter((id) => id !== space);
  for (const g of next.groups) g.spaces = (g.spaces ?? []).filter((id) => id !== space);
  group.spaces.push(space);
  group.folded = false;
  return next;
}

// The topic mark's right-click menu, only what applies: a running chief's space (when it has a pane
// there) and adding it to a composition, then starting a new chief, whose registration replaces it.
export function chiefMenu(terminal, terminalList, paneList) {
  const live = Boolean(terminal) && terminalList.some((k) => k.address === terminal && k.state === "live");
  return [
    ...(live && paneList.some((p) => p.terminal === terminal) ? [{ label: "Go to chief space", action: "space" }] : []),
    ...(live ? [{ label: "Add to composition", action: "composition" }] : []),
    { label: "Start new chief", action: "start" },
  ];
}
