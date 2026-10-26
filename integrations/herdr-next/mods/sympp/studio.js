// Pure UI studio logic: one UI package's tab, its worker terminal beside a preview. No GPUI or Herdr
// imports; main.js runs these against Herdr and studioview.js draws the studio's own pane.

import { bindingsFor } from "./model.js";
import { jobSpace } from "./job.js";

// Open studios by Herdr tab: { [tab id]: { job, pkg, dev } }. `dev` names the package's preview copy.
export const STUDIOS = "sympp.studios";
// The tab marks the patched desk-tabs bar shows (S++ chrome 2): [{ tab, icon, iconDark?, label }].
export const TAB_MARKS = "workspace.tab_marks";
export const MARK = { icon: "mods/sympp/glyph-ui.svg", iconDark: "mods/sympp/glyph-ui-dark.svg", label: "S++ UI studio" };
// Preview copies of a worker's in-progress view are mods named like this, never "sympp" itself.
export const DEV_PREFIX = "sympp-dev-";

// UI work: the package title names UI as a word ("UI studio tab", "Token UI"), or its worker has
// published a preview. Both are readable today without a package kind for UI.
export function isUiWork(pkg, previewUrl = null) {
  return /\bUIs?\b/.test(pkg?.title ?? "") || Boolean(previewUrl);
}

// The web preview a worker published on its own terminal (sympp.preview_url), when it is an http(s)
// address. Display-only: shown only once the worker's launch has been verified.
export function previewUrlOf(terminal) {
  const url = terminal?.labels?.["sympp.preview_url"];
  if (typeof url !== "string") return null;
  const value = url.trim();
  return value.length <= 2048 && /^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i.test(value) ? value : null;
}

// Whether a job view offers the package a studio: unfinished UI work, by its title or by a preview its
// worker published (a signal only; the studio shows the address after verifying the worker).
export function uiPackage(job, pkg, bindings, terminalList) {
  if (pkg.stage === "done") return false;
  const url = bindingsFor(bindings, job.id, pkg.id).map((b) => previewUrlOf((terminalList ?? []).find((k) => k.address === b.address))).find(Boolean);
  return isUiWork(pkg, url);
}

// A tab named after the package in the job's local space; the copy's connection props carry over.
export function studioTabArgs(given, job, pkg, spaceList) {
  const { role: _role, job: _job, studio: _studio, ...rest } = given ?? {};
  const space = jobSpace(job, spaceList);
  return { name: tabName(pkg.title), ...(space ? { space: space.id } : {}), mod: "sympp", props: { ...rest, studio: { job: job.id, pkg: pkg.id } } };
}

export function tabName(title) {
  const text = String(title ?? "UI studio");
  return text.length > 32 ? `${text.slice(0, 31)}…` : text;
}

// Registered studios whose tabs are still open.
export function openStudios(registry, openTabs) {
  const open = new Set(openTabs);
  return Object.fromEntries(Object.entries(registry && typeof registry === "object" ? registry : {})
    .filter(([tab, entry]) => open.has(tab) && entry && typeof entry.pkg === "string"));
}

// The open studio tab for a package, other than `except`.
export function studioTabFor(registry, openTabs, pkgId, except = null) {
  return Object.entries(openStudios(registry, openTabs)).find(([tab, entry]) => entry.pkg === pkgId && tab !== except)?.[0] ?? null;
}

export function devName(pkgId) {
  return DEV_PREFIX + String(pkgId).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 48);
}

// Preview copies no open studio uses: what is left after a studio tab closed.
export function strayCopies(names, registry, openTabs, paneList) {
  const used = new Set(Object.values(openStudios(registry, openTabs)).map((entry) => entry.dev).filter(Boolean));
  const shown = new Set((paneList ?? []).map((p) => p.mod).filter(Boolean));
  return (names ?? []).filter((name) => name.startsWith(DEV_PREFIX) && !used.has(name) && !shown.has(name));
}

// Where the worker's terminal is relative to the studio's own pane, and the next step that puts it
// beside the studio: "keep" gives a paneless terminal a pane here, "elsewhere" means another tab
// shows it (moving it is the person's call), "swap" puts it on the left once, null when placed.
export function placement(paneList, tab, pane, address, swapped) {
  const at = (paneList ?? []).find((p) => p.terminal === address);
  if (!at) return { step: "keep" };
  if (at.tab !== tab) return { step: "elsewhere", pane: at.pane, tab: at.tab };
  const order = paneList.filter((p) => p.tab === tab).map((p) => p.pane);
  if (!swapped && order.indexOf(at.pane) > order.indexOf(pane)) return { step: "swap", pane: at.pane };
  return { step: null, pane: at.pane };
}

// The worker's bindings for this package, launches before hand-started sessions.
export function workerBindings(bindings) {
  return [...bindings].sort((a, b) => (a.kind === "launch" ? 0 : 1) - (b.kind === "launch" ? 0 : 1));
}

// What the preview pane shows. A published web preview wins; an S++ worktree whose Herdr view the
// package changes runs that view on sample data; otherwise it waits for the agent.
export function previewKind({ url, native }) {
  if (url) return "web";
  return native === "ready" || native === "building" || native === "error" ? "native" : "none";
}

// The preview builder's verdict from its exit: built, nothing of the Herdr view changed yet, no
// builder in this worktree (not an S++ checkout), or a build error worth showing.
export function buildOutcome(result) {
  if (result?.code === 0) return { state: "ready" };
  if (result?.code === 3) return { state: "unchanged" };
  const text = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`;
  if (/Cannot find module '[^']*preview\.mjs'/.test(text)) return { state: "none" };
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return { state: "error", error: line ? line.slice(0, 200) : `The preview build exited ${result?.code ?? "unexpectedly"}.` };
}

// A saved file that changes the preview: the view's own files, its sample board or the builder.
export function previewInput(path) {
  const p = String(path).replace(/\\/g, "/");
  return /\/integrations\/herdr-next\/(mods\/sympp\/[^/]+|fixture\.mjs|preview\.mjs)$/.test(p);
}

export function builderPath(cwd) {
  return `${String(cwd).replace(/[\\/]+$/, "")}/integrations/herdr-next/preview.mjs`;
}
