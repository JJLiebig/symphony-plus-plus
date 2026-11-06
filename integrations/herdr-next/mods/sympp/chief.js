// Pure Start chief logic: the chief's brief and command, the factory's machine, where the chief starts
// and its place among Herdr's topics. No GPUI or Herdr imports; chiefview.js draws the dialog and runs
// these against Herdr.

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

const trimmed = (path) => path.replace(/[\\/]+$/, "");
const leaf = (path) => trimmed(path).split(/[\\/]/).pop();
const parent = (path) => (/[\\/]/.test(trimmed(path)) ? trimmed(path).replace(/[\\/][^\\/]*$/, "") : "");
const worktree = (path) => /[\\/]\.worktrees([\\/]|$)/.test(path);

// Where the chief may start on its machine, best first: the folder of the topic's own space there;
// else the topic's repository in that machine's repos root (the folder most of its spaces' checkouts
// sit in); else that root. Worktree checkouts never count. Empty: the machine's home.
export function chiefFolders(topicSpaces, allSpaces, machine) {
  const checkout = (s) => typeof s.folder === "string" && s.folder && !worktree(s.folder);
  const here = (s) => checkout(s) && (s.machine ?? null) === machine;
  const own = topicSpaces.find(here);
  if (own) return [own.folder];
  const counts = new Map();
  for (const s of allSpaces.filter(here)) {
    const root = parent(s.folder);
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  const root = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!root) return [];
  const repo = topicSpaces.filter(checkout).map((s) => leaf(s.folder)).find(Boolean);
  const sep = root.includes("/") || !root.includes("\\") ? "/" : "\\";
  return repo ? [`${root}${sep}${repo}`, root] : [root];
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
