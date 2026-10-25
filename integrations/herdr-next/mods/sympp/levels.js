// Pure Factory, Topic and Space levels: where S++ jobs sit among the person's Herdr topics and
// spaces, what needs them first, what the panel follows and which needs are new. No GPUI or Herdr
// imports, so every rule here is asserted on its own. Jobs stay canonical S++ jobs: a level only
// places, ranks and references them; it never copies the backlog.

import { shortRepo, lanesOf, bindingsFor } from "./model.js";
import * as J from "./job.js";

export const UNSORTED = "unsorted";
export const NOWHERE = "nowhere";
export const LEVELS = ["factory", "topic", "space", "job"];

const keyOf = (value) => shortRepo(value ?? "").toLowerCase();

// ---------- Topics and spaces ----------

// Herdr's own topic grouping, shared("desk.topics") = { groups: [{ id, name, spaces, folded }],
// unsorted }. Spaces no group claims are unsorted, so a new space never disappears.
export function deskOf(deskTopics, spaceList) {
  const list = Array.isArray(spaceList) ? spaceList : [];
  const byId = new Map(list.map((s) => [s.id, s]));
  const placed = new Set();
  const groups = Array.isArray(deskTopics?.groups) ? deskTopics.groups : [];
  const topics = groups.filter((g) => g && g.id && g.name).map((g) => {
    const spaces = (Array.isArray(g.spaces) ? g.spaces : []).map((id) => byId.get(id)).filter((s) => s && !placed.has(s.id));
    for (const s of spaces) placed.add(s.id);
    return { id: g.id, name: g.name, kind: "topic", spaces };
  });
  return [...topics,
    { id: UNSORTED, name: "Unsorted", kind: "unsorted", spaces: list.filter((s) => !placed.has(s.id)) },
    { id: NOWHERE, name: "Without a space", kind: "none", spaces: [] }];
}

// A space's repository is the leaf of its folder; ancestor folders never match.
export function spaceRepo(space) {
  return space?.folder ? keyOf(space.folder) || null : null;
}

export function spaceById(desk, id) {
  for (const topic of desk) {
    const space = topic.spaces.find((s) => s.id === id);
    if (space) return { space, topic };
  }
  return null;
}

// Explicit repository mappings first, then every topic with a space on that repository.
function topicsOfRepo(repo, desk, repoTopics) {
  const explicit = repoTopics && typeof repoTopics === "object" ? repoTopics[repo] ?? repoTopics[shortRepo(repo)] : undefined;
  if (typeof explicit === "string") return desk.filter((t) => t.kind === "topic" && (t.id === explicit || t.name === explicit));
  const key = keyOf(repo);
  return key ? desk.filter((t) => t.spaces.some((s) => spaceRepo(s) === key)) : [];
}

// Each job has one home topic, its own repository's first, so the factory counts it once. Every
// other topic it touches holds a reference to that one job.
export function placeJobs(jobs, desk, repoTopics) {
  const home = new Map();
  const repos = new Map();
  for (const job of jobs) {
    const within = new Map();
    for (const repo of job.repos) {
      for (const topic of topicsOfRepo(repo, desk, repoTopics)) {
        if (!within.has(topic.id)) within.set(topic.id, []);
        within.get(topic.id).push(repo);
      }
    }
    repos.set(job.id, within);
    home.set(job.id, within.keys().next().value ?? NOWHERE);
  }
  return {
    home: (job) => home.get(job.id) ?? NOWHERE,
    touches: (job, topicId) => repos.get(job.id)?.has(topicId) ?? false,
    reposIn: (job, topicId) => repos.get(job.id)?.get(topicId) ?? [],
    alsoIn: (job) => [...(repos.get(job.id)?.keys() ?? [])].filter((id) => id !== home.get(job.id)),
  };
}

// ---------- Factory ----------

// What answering frees: every unfinished package after this one in the execution graph. An ask
// about the whole job holds all of its unfinished packages.
export function unblocks(job, pkgId) {
  const open = new Set(job.packages.filter((pkg) => pkg.stage !== "done").map((pkg) => pkg.id));
  if (!pkgId) return open.size;
  const after = new Set();
  const queue = [pkgId];
  while (queue.length) {
    const id = queue.shift();
    for (const [pre, dep] of job.edges ?? []) {
      if (pre === id && dep !== pkgId && !after.has(dep)) { after.add(dep); queue.push(dep); }
    }
  }
  return [...after].filter((id) => open.has(id)).length;
}

// Needs-you across the factory: what unblocks the most waiting packages first, then the longest wait.
export function needsQueue(jobs) {
  const age = (need) => need.since ?? Infinity;
  return jobs.flatMap((job) => job.needs.map((need) => ({ ...need, job, unblocks: unblocks(job, need.pkgId) })))
    .sort((a, b) => b.unblocks - a.unblocks || age(a) - age(b));
}

// One row per Herdr topic, then unsorted spaces and work without a space when either has anything.
export function factoryRows(jobs, desk, place) {
  const open = jobs.filter((job) => job.state !== "settled");
  const names = new Map(desk.map((t) => [t.id, t.name]));
  return desk.map((topic) => {
    const own = open.filter((job) => place.home(job) === topic.id);
    const shared = new Map();
    for (const job of open) {
      if (place.home(job) === topic.id || !place.touches(job, topic.id)) continue;
      const from = names.get(place.home(job)) ?? names.get(NOWHERE);
      shared.set(from, (shared.get(from) ?? 0) + 1);
    }
    return {
      ...topic,
      jobs: own,
      needs: own.reduce((n, job) => n + job.needs.length, 0),
      moving: own.reduce((n, job) => n + job.counts.live, 0),
      repos: [...new Set(own.flatMap((job) => job.repos.map(shortRepo)).filter(Boolean))],
      shared: [...shared].map(([name, count]) => ({ name, count })),
    };
  }).filter((row) => row.kind === "topic" || row.jobs.length > 0 || row.shared.length > 0 || (row.kind === "unsorted" && row.spaces.length > 0));
}

// ---------- Topic and space ----------

// Work grouped by repository, in the topic's space order. A job draws in full under its first
// repository here when this is its home topic; everywhere else it is a reference to that job.
// Jobs that are only planned collapse to a count.
export function topicWork(topic, jobs, place) {
  const groups = new Map();
  const group = (key, label) => {
    if (!groups.has(key)) groups.set(key, { key, label, spaces: [], jobs: [], refs: [], planned: [], away: 0 });
    return groups.get(key);
  };
  for (const space of topic.spaces) group(spaceRepo(space) ?? "", spaceRepo(space) ? shortRepo(space.folder) : "Other spaces").spaces.push(space);
  for (const job of jobs) {
    const repos = topic.id === NOWHERE ? (place.home(job) === NOWHERE ? [job.repos[0] ?? ""] : []) : place.reposIn(job, topic.id);
    if (!repos.length) continue;
    const first = group(keyOf(repos[0]), shortRepo(repos[0]) || "No repository");
    // Settled and dormant work is counted once, at home, and referenced nowhere.
    const away = job.lane === "settled" || job.lane === "dormant";
    if (place.home(job) !== topic.id) {
      if (!away) first.refs.push({ job, at: first.key, from: place.home(job), via: null });
      continue;
    }
    if (away) {
      first.away += 1;
      continue;
    }
    if (job.lane === "backlog") first.planned.push(job);
    else first.jobs.push(job);
    for (const repo of repos.slice(1)) {
      const other = group(keyOf(repo), shortRepo(repo));
      if (other !== first && !other.refs.some((ref) => ref.job === job)) other.refs.push({ job, at: other.key, from: null, via: first.label });
    }
  }
  for (const g of groups.values()) {
    const lanes = lanesOf(g.jobs);
    g.jobs = [...lanes.moving, ...lanes.parked, ...lanes.landed];
  }
  return [...groups.values()];
}

// Every job touching the space's repository, each with the job's other repositories as references.
export function spaceWork(space, jobs) {
  const key = spaceRepo(space);
  const touching = key ? jobs.filter((job) => job.repos.some((repo) => keyOf(repo) === key)) : [];
  const lanes = lanesOf(touching);
  return {
    repo: key ? shortRepo(space.folder) : null,
    jobs: [...lanes.moving, ...lanes.parked, ...lanes.landed],
    planned: lanes.backlog,
    away: lanes.settled.length + lanes.dormant.length,
    elsewhere: (job) => [...new Set(job.repos.filter((repo) => keyOf(repo) !== key).map(shortRepo))],
  };
}

// The space a bound terminal sits in, as Herdr labels it; remote ids carry their machine.
export function terminalSpace(binding, terminalList) {
  const terminal = (terminalList ?? []).find((t) => t.address === binding.address);
  const id = terminal?.labels?.["herdr.space"];
  if (typeof id !== "string" || !id) return null;
  return binding.machine ? `${binding.machine}/${id}` : id;
}

// The S++ agents for some work: each job's architect and workers with something to say about them,
// and any bound agent whose terminal sits in these spaces. Live, last seen and unknown come from
// the Job level's own rule; a report is the agent's own OSC status. Review providers are not agents
// in a space and stay on the Job level.
export function agentRows(jobs, allJobs, bindings, terminalList, spaceIds, checks, now) {
  const here = new Set(spaceIds);
  const inHere = (list) => list.some((b) => here.has(terminalSpace(b, terminalList)));
  const rows = new Map();
  const add = (job, person) => {
    const own = bindingsFor(bindings, job.id, person.pkgId ?? null);
    if (person.state === "unknown" && !own.length) return;
    const key = `${job.id}:${person.key}`;
    if (!rows.has(key)) rows.set(key, { ...person, key, job, here: inHere(own), report: J.reportFor(own, terminalList, now) });
  };
  const people = (job) => J.participants(job, bindings, checks, now).filter((p) => p.role !== "Review");
  for (const job of jobs) for (const person of people(job)) add(job, person);
  for (const b of bindings) {
    if (!here.has(terminalSpace(b, terminalList))) continue;
    const job = allJobs.find((j) => j.id === b.jobId) ?? (b.pkgId ? allJobs.find((j) => j.packages.some((pkg) => pkg.id === b.pkgId)) : null);
    const person = job && people(job).find((p) => (p.pkgId ?? null) === b.pkgId);
    if (person) add(job, person);
  }
  const order = { live: 0, seen: 1, unknown: 2 };
  return [...rows.values()].sort((a, b) => order[a.state] - order[b.state] || (b.at ?? 0) - (a.at ?? 0));
}

// ---------- Navigation ----------

// A path names the level and what it sits under: { topic, space, job }. The deepest one set is the level.
export function levelOf(path) {
  return path?.job ? "job" : path?.space ? "space" : path?.topic ? "topic" : "factory";
}

// Esc and the breadcrumb go up one level at a time.
export function up(path) {
  if (path.job) return { topic: path.topic ?? null, space: path.space ?? null, job: null };
  if (path.space) return { topic: path.topic ?? null, space: null, job: null };
  return { topic: null, space: null, job: null };
}

// What still exists of a remembered path. A job that left the board falls back a level, unless it
// was just created and the board has not caught up.
export function resolvePath(path, desk, jobs, awaiting = null) {
  const topic = desk.find((t) => t.id === path?.topic) ?? null;
  const found = path?.space ? spaceById(desk, path.space) : null;
  const job = path?.job && (jobs.some((j) => j.id === path.job) || path.job === awaiting) ? path.job : null;
  return { topic: found?.topic.id ?? topic?.id ?? null, space: found?.space.id ?? null, job };
}

export function crumbs(path, desk, jobs) {
  const list = [{ level: "factory", label: "Factory", path: { topic: null, space: null, job: null } }];
  const topic = desk.find((t) => t.id === path.topic);
  if (topic) list.push({ level: "topic", label: topic.name, path: { topic: topic.id, space: null, job: null } });
  const found = path.space ? spaceById(desk, path.space) : null;
  if (found) list.push({ level: "space", label: found.space.name || shortRepo(found.space.folder) || "Space", path: { topic: path.topic, space: found.space.id, job: null } });
  if (path.job) list.push({ level: "job", label: jobs.find((j) => j.id === path.job)?.title ?? "New job", path });
  return list;
}

// ---------- Following focus ----------

// What Herdr's focus shows: an S++-labelled terminal or a job tab names its job; a mod pane (this
// panel, a viewer) keeps what is shown; anything else is its space. Labels only pick what to show;
// they never authorize an agent jump.
export function focusTarget(focus, terminalList, jobTabs, paneList) {
  if (!focus?.space) return null;
  const address = focus.shown ?? focus.terminal;
  const labels = (address ? (terminalList ?? []).find((t) => t.address === address)?.labels : null) ?? {};
  const job = labels["sympp.work_request_id"] || labels["sympp.session_work_request_id"] || null;
  const pkg = labels["sympp.work_package_id"] || labels["sympp.session_work_package_id"] || null;
  if (job || pkg) return { kind: "job", job, pkg, space: focus.space };
  const tabJob = jobTabs && typeof jobTabs === "object" ? jobTabs[focus.tab] : null;
  if (typeof tabJob === "string" && tabJob) return { kind: "job", job: tabJob, pkg: null, space: focus.space };
  const pane = (paneList ?? []).find((p) => p.pane === focus.pane);
  if (pane && !pane.terminal && !focus.shown) return null;
  return { kind: "space", space: focus.space };
}

// The path a focus target leads to: its job; else its space while S++ work touches it; else the
// space's topic; else the space, which says that ordinary Herdr work stays ordinary.
export function followPath(target, jobs, desk, place) {
  if (!target) return null;
  const found = spaceById(desk, target.space);
  if (target.kind === "job") {
    const job = jobs.find((j) => j.id === target.job) ?? (target.pkg ? jobs.find((j) => j.packages.some((pkg) => pkg.id === target.pkg)) : null);
    if (job) {
      const inSpace = Boolean(found && spaceRepo(found.space) && job.repos.some((repo) => keyOf(repo) === spaceRepo(found.space)));
      return { topic: inSpace ? found.topic.id : place.home(job), space: inSpace ? found.space.id : null, job: job.id };
    }
  }
  if (!found) return null;
  const work = spaceWork(found.space, jobs);
  if (work.jobs.length > 0 || work.planned.length > 0 || found.topic.kind !== "topic") return { topic: found.topic.id, space: found.space.id, job: null };
  return { topic: found.topic.id, space: null, job: null };
}

// ---------- Toasts ----------

// Needs that appeared between two successful reads. The first read only records what is there, and
// an offline copy never announces anything.
export function newNeeds(previous, board) {
  const needs = board.jobs.flatMap((job) => job.needs.map((need) => ({ ...need, job })));
  const seen = new Set(needs.map(occurrence));
  if (previous === null || board.offline === true) return { seen, fresh: [] };
  return { seen, fresh: needs.filter((need) => !previous.has(occurrence(need))) };
}

// An escalation raised again is a new occurrence under the same key; other needs keep their key
// while their activity times move, so those times never make them new.
function occurrence(need) {
  return need.kind === "ask" && need.raisedAt ? `${need.key}@${need.raisedAt}` : need.key;
}

// One toast per need: the same need raised again later is a new item.
export function toastId(need) {
  return `${need.key}@${need.since ?? ""}`;
}
