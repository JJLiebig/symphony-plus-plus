// Pure scope model for the redesigned Topic, Space and task views: which tasks a scope shows, how
// each is doing (its health) and how far along it is. Topic and Space are one view; a space only
// narrows the tasks to its repository. No GPUI or Herdr imports.

import { reviewBumps, shortRepo } from "./model.js";
import { NOWHERE, spaceRepo, spaceById } from "./levels.js";

// Reading order: what needs the person first, then what is in trouble, then what is fine.
export const HEALTH = ["needs", "stuck", "slowing", "moving", "resting", "landed"];
// How far a package has come, by stage. A guide for drawing position, never a percentage shown.
export const STAGE_AT = { queued: 0, build: 0.25, checks: 0.5, review: 0.7, merge: 0.9, done: 1 };
export const STEPS = ["build", "checks", "review", "merge"];

const keyOf = (value) => shortRepo(value ?? "").toLowerCase();

// A task's health: needs the person, stuck (nothing moved for a long while), slowing (road bumps),
// moving, resting (planned, shaping or parked) or landed.
export function health(job) {
  if (job.needs.length) return "needs";
  if (job.verdict === "stalled") return "stuck";
  if (job.verdict === "bump") return "slowing";
  if (job.state === "settled") return "landed";
  if (job.verdict === "on_track") return "moving";
  return "resting";
}

// A package's health on the same scale; queued packages simply wait.
export function packageHealth(pkg, now) {
  if (pkg.stage === "done") return "landed";
  if (pkg.activity.nextActor === "human") return "needs";
  if (pkg.stage === "queued") return "queued";
  if (pkg.failed || reviewBumps(pkg, now).length) return "slowing";
  return "moving";
}

// How far along: the landed share and the share in flight, of the packages still counted.
export function progress(job) {
  const counted = job.packages.filter((pkg) => pkg.outcome !== "dropped");
  if (!counted.length) return { landed: 0, flight: 0, total: 0 };
  const landed = counted.filter((pkg) => pkg.stage === "done").length / counted.length;
  const flight = counted.filter((pkg) => pkg.stage !== "done").reduce((n, pkg) => n + (STAGE_AT[pkg.stage] ?? 0), 0) / counted.length;
  return { landed, flight, total: counted.length };
}

const rank = (h) => HEALTH.indexOf(h);

// The tasks a Topic or Space shows: every task touching it, once. Landed work stays a day, then
// leaves with dormant work for the dashboard.
export function scopeTasks(path, desk, jobs, place) {
  let touching;
  if (path.space) {
    const found = spaceById(desk, path.space);
    const key = found ? spaceRepo(found.space) : null;
    touching = key ? jobs.filter((job) => job.repos.some((repo) => keyOf(repo) === key)) : [];
  } else if (path.topic === NOWHERE) {
    touching = jobs.filter((job) => place.home(job) === NOWHERE);
  } else {
    touching = jobs.filter((job) => place.touches(job, path.topic));
  }
  return touching.filter((job) => job.lane !== "settled" && job.lane !== "dormant")
    .map((job) => ({ job, health: health(job), progress: progress(job) }))
    .sort((a, b) => rank(a.health) - rank(b.health) || b.job.lastMoveAt - a.job.lastMoveAt);
}

// A task's packages in the order the eye wants them: needs, trouble, moving furthest first, queued, landed.
export function packageOrder(job, now) {
  const order = ["needs", "slowing", "moving", "queued", "landed"];
  return job.packages.filter((pkg) => pkg.outcome !== "dropped")
    .map((pkg) => ({ pkg, health: packageHealth(pkg, now) }))
    .sort((a, b) => order.indexOf(a.health) - order.indexOf(b.health) || (STAGE_AT[b.pkg.stage] ?? 0) - (STAGE_AT[a.pkg.stage] ?? 0) || a.pkg.seq - b.pkg.seq);
}

// What the person is asked. A need sympp derived from a package waiting on the person has no
// question of its own, so it names the package rather than repeat the waiting reason.
export function askText(job, need) {
  if (need.id || need.kind !== "guidance" || !need.pkgId) return need.text;
  const pkg = job.packages.find((p) => p.id === need.pkgId);
  return pkg ? `${pkg.title} is waiting on you` : need.text;
}

// The scope's name for its bar, and where Esc goes.
export function scopeTitle(path, desk) {
  if (path.space) {
    const found = spaceById(desk, path.space);
    return found ? found.space.name || shortRepo(found.space.folder) || "Space" : "Space";
  }
  return desk.find((topic) => topic.id === path.topic)?.name ?? "Topic";
}
