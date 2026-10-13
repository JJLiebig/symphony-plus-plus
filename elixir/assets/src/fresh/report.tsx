import { Check, Circle, Laptop, Monitor, Server, type LucideIcon } from "lucide-react";
import { createContext, useContext, useState } from "react";

import { deployAt, span, type Goal, type GoalView, type Pkg, type PkgView, type Stage } from "./model";
import { GLOW, NUDGE, smoothly, useFlash } from "./motion";
import { locate, Pip, Track } from "./parts";
import { sampleReport } from "./samples";

// What a goal says when asked "is this coming along?". The architect owns the words and the ETA;
// the ledger only supplies the verdict's facts.
export type Verdict = "needs_you" | "bump" | "stalled" | "on_track" | "idle" | "parked" | "settled";
// `briefAt` is when the architect wrote the brief; null where the wording is not the architect's.
export type Report = { verdict: Verdict; brief: string; briefAt: number | null; eta: string | null; sample: boolean; bumps: string[] };
// A phase is a top-level group. `pkgs` covers everything beneath it; `subs` are its nested groups, flattened in order.
export type Phase = { id: string; title: string; pkgs: Pkg[]; subs: Array<{ id: string; title: string; pkgs: Pkg[] }> };
export type PhaseStatus = "done" | "active" | "waiting" | "upcoming";
export type PhaseState = { phase: Phase; live: PkgView[]; queued: Pkg[]; done: Pkg[]; status: PhaseStatus };
export type Density = "closed" | "attention" | "active" | "open";
// How much of one goal is on screen: its headline, what is moving now, or done, now and up next.
export type Level = "closed" | "now" | "full";
export type PhaseControl = { all: boolean; isOpen: (state: PhaseState) => boolean; open: (state: PhaseState) => void; setAll: (all: boolean) => void; toggle: (state: PhaseState) => void };

const LONG_REVIEW = 3 * 3600e3;
const STALL_AFTER = 2 * 3600e3;
const FOLD_AFTER = 2;
const ROW = "grid grid-cols-[10px_minmax(0,1fr)_auto_auto_28px] items-center gap-3 rounded px-2 py-1 odd:bg-white/[0.035]";

export const VERDICT: Record<Verdict, { label: string; text: string; dot: string }> = {
  needs_you: { label: "Needs you", text: "text-you", dot: "bg-you" },
  bump: { label: "Road bump", text: "text-checks", dot: "bg-checks" },
  stalled: { label: "Stalled", text: "text-checks", dot: "bg-checks" },
  on_track: { label: "On track", text: "text-merge", dot: "bg-merge" },
  idle: { label: "Quiet", text: "text-faint", dot: "bg-faint" },
  parked: { label: "Parked", text: "text-faint", dot: "bg-faint" },
  settled: { label: "Done", text: "text-dim", dot: "bg-merge/40" },
};

// "active" shows what is moving in every goal; "attention" opens only the goals that deviate from plan.
export const DensityContext = createContext<Density>("active");

// The verdicts that deviate from plan and should be seen first.
export function wantsAttention(verdict: Verdict) {
  return verdict === "needs_you" || verdict === "bump" || verdict === "stalled";
}

function defaultLevel(density: Density, verdict: Verdict): Level {
  if (density === "open") return "full";
  if (density === "active") return "now";
  return density === "attention" && wantsAttention(verdict) ? "full" : "closed";
}

// A goal follows the chosen density until it is opened or closed by hand.
export function useGoalLevel(verdict: Verdict) {
  const density = useContext(DensityContext);
  const [override, setOverride] = useState<{ density: Density; level: Level } | null>(null);
  const level = override?.density === density ? override.level : defaultLevel(density, verdict);
  const reopened: Level = density === "active" ? "now" : "full";

  return {
    level,
    showAll: () => smoothly(() => setOverride({ density, level: "full" })),
    toggle: () => smoothly(() => setOverride({ density, level: level === "closed" ? reopened : "closed" })),
  };
}

// Which phases of one goal are opened. A phase with work in progress is open unless closed by hand.
export function usePhaseControl(): PhaseControl {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [all, setAllState] = useState(false);
  const isOpen = (state: PhaseState) => overrides[state.phase.id] ?? (all || state.status === "active");

  return {
    all,
    isOpen,
    open: (state) => smoothly(() => setOverrides({ ...overrides, [state.phase.id]: true })),
    setAll: (next) =>
      smoothly(() => {
        setOverrides({});
        setAllState(next);
      }),
    toggle: (state) => smoothly(() => setOverrides({ ...overrides, [state.phase.id]: !isOpen(state) })),
  };
}

export function reportFor(view: GoalView, at: number): Report {
  const bumps = [...goalBumps(view, at), ...view.live.flatMap((live) => bumpsFor(live, at))];
  const verdict = verdictFor(view, bumps, at);
  const written = view.goal.report;
  if (written?.brief) return { verdict, brief: written.brief.text, briefAt: written.brief.at, eta: written.eta?.text ?? null, sample: false, bumps };

  const sample = sampleReport(view.goal.title, verdict === "on_track");
  return { verdict, brief: sample?.brief ?? draftBrief(view, bumps, at), briefAt: null, eta: written?.eta?.text ?? sample?.eta ?? null, sample: Boolean(sample), bumps };
}

// How old the architect's brief is, so a stale one is not read as news.
export function BriefAge({ at, report }: { at: number; report: Report }) {
  if (report.briefAt === null) return null;
  return <span className="ml-2 whitespace-nowrap font-mono text-[11px] text-faint" title="When the architect wrote this">{span(at - report.briefAt)} ago</span>;
}

// Started, work left, and nothing has moved for a while: nobody is on it.
function isStalled(view: GoalView, at: number) {
  return view.state === "resting" && view.done.length > 0 && at - view.lastMoveAt > STALL_AFTER;
}

function verdictFor(view: GoalView, bumps: string[], at: number): Verdict {
  if (view.ask) return "needs_you";
  if (view.goal.report?.parked) return "parked";
  if (isStalled(view, at)) return "stalled";
  if (bumps.length > 0) return "bump";
  if (view.state === "settled") return "settled";
  return view.live.length === 0 ? "idle" : "on_track";
}

// Road bumps that belong to the goal as a whole rather than to one package.
function goalBumps(view: GoalView, at: number) {
  const failed = deployAt(view.goal, at).filter((step) => step.state === "failed").map((step) => (step.at === null ? `${step.env} deploy failed` : `${step.env} deploy failed ${span(at - step.at)} ago`));
  return isStalled(view, at) && !view.goal.report?.parked ? [...failed, `Nothing has moved for ${span(at - view.lastMoveAt)} with ${view.queued.length} queued`] : failed;
}

function bumpsFor(live: PkgView, at: number) {
  const checks: Array<[boolean, string]> = [
    [live.failed, live.untimed ? "Checks failing" : `Checks failing for ${span(at - live.since)}`],
    [live.stage === "review" && live.round >= 3, `Review is on round ${live.round}`],
    [live.stage === "review" && !live.untimed && at - live.since > LONG_REVIEW, `In review for ${span(at - live.since)}`],
  ];
  return checks.filter(([hit]) => hit).map(([, text]) => `${text}: ${live.pkg.title}`);
}

// Fallback wording from ledger counts, used where no architect brief exists.
function draftBrief(view: GoalView, bumps: string[], at: number) {
  if (view.ask) return `Waiting on you: ${view.ask.title}`;
  if (view.goal.report?.parked) return `Parked: ${view.goal.report.parked.text}`;
  const total = view.live.length + view.queued.length + view.done.length;
  if (view.state === "settled") return `All ${total} packages have landed.`;
  if (view.live.length === 0) return `Nothing has moved for ${span(at - view.lastMoveAt)}. ${view.done.length} of ${total} packages have landed.`;
  // A road bump is the news; the counts are on the same line already.
  if (bumps.length > 0) return bumps.length === 1 ? `${bumps[0]}.` : `${bumps[0]}, and ${bumps.length - 1} more.`;
  return `${view.live.length} of ${total} packages are moving. ${view.done.length} have landed.`;
}

// Phases exist only where the architect grouped the work. Nothing is invented for ungrouped goals.
export function phasesOf(goal: Goal): Phase[] {
  if (goal.groups.length === 0) return [];
  const known = new Set(goal.groups.map((group) => group.id));
  const direct = (id: string) => goal.pkgs.filter((pkg) => pkg.groupId === id);
  // Nested groups in reading order, each named by its path below the phase.
  const below = (id: string, path: string): Phase["subs"] =>
    goal.groups.filter((group) => group.parentId === id).flatMap((child) => {
      const title = path ? `${path} › ${child.title}` : child.title;
      return [{ id: child.id, title, pkgs: direct(child.id) }, ...below(child.id, title)];
    });
  const loose = goal.pkgs.filter((pkg) => !pkg.groupId || !known.has(pkg.groupId));
  const tops = goal.groups.filter((group) => !group.parentId || !known.has(group.parentId)).map((group) => {
    const subs = below(group.id, "");
    return { id: group.id, title: group.title, subs, pkgs: [...direct(group.id), ...subs.flatMap((sub) => sub.pkgs)] };
  });
  return [...tops, ...(loose.length > 0 ? [{ id: "loose", title: "Other", subs: [], pkgs: loose }] : [])];
}

export function phaseStates(view: GoalView): PhaseState[] {
  return phasesOf(view.goal).map((phase) => phaseState(phase, view));
}

function phaseState(phase: Phase, view: GoalView): PhaseState {
  const ids = new Set(phase.pkgs.map((pkg) => pkg.id));
  const bySeq = (left: Pkg, right: Pkg) => left.seq - right.seq;
  const live = view.live.filter((entry) => ids.has(entry.pkg.id));
  const queued = view.queued.filter((pkg) => ids.has(pkg.id)).sort(bySeq);
  const done = view.done.filter((pkg) => ids.has(pkg.id)).sort(bySeq);
  const total = live.length + queued.length + done.length;
  const status = total === 0 ? "upcoming" : done.length === total ? "done" : live.length > 0 ? "active" : "waiting";
  return { phase, live, queued, done, status };
}

// A goal without groups still reads as finished work, work in progress and work to come.
function looseStates(view: GoalView): PhaseState[] {
  const part = (id: string, title: string, status: PhaseStatus, live: PkgView[], queued: Pkg[], done: Pkg[]): PhaseState => ({ phase: { id, title, pkgs: [], subs: [] }, live, queued, done, status });
  return [
    ...(view.done.length > 0 ? [part("done", "Finished packages", "done", [], [], view.done)] : []),
    ...(view.live.length > 0 ? [part("now", "", "active", view.live, [], [])] : []),
    ...(view.queued.length > 0 ? [part("next", "Queued packages", "waiting", [], view.queued, [])] : []),
  ];
}

// One dot per package in its planned order, with a gap between the architect's groups.
export function DotStrip({ view }: { view: GoalView }) {
  const phases = phaseStates(view);
  const whole: PhaseState = { phase: { id: "all", title: "", pkgs: [], subs: [] }, live: view.live, queued: view.queued, done: view.done, status: "active" };
  const runs = (phases.length > 0 ? phases : [whole]).filter((state) => state.live.length + state.queued.length + state.done.length > 0);

  return (
    <span className="flex flex-wrap items-center gap-y-1">
      {runs.map((state, index) => (
        <span key={state.phase.id} className={`flex items-center gap-0.5 ${index > 0 ? "ml-1.5 border-l border-faint pl-1.5" : ""}`} title={state.phase.title || undefined}>
          {orderedDots(state).map((dot) => (
            <span key={dot.id} title={dot.title}>
              <Pip stage={dot.stage} failed={dot.failed} />
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

function orderedDots(state: PhaseState) {
  const dots: Array<{ id: string; title: string; seq: number; stage: Stage; failed: boolean }> = [
    ...state.done.map((pkg) => ({ id: pkg.id, title: pkg.title, seq: pkg.seq, stage: "done" as Stage, failed: false })),
    ...state.live.map((live) => ({ id: live.pkg.id, title: live.pkg.title, seq: live.pkg.seq, stage: live.stage, failed: live.failed })),
    ...state.queued.map((pkg) => ({ id: pkg.id, title: pkg.title, seq: pkg.seq, stage: "queued" as Stage, failed: false })),
  ];
  return dots.sort((left, right) => left.seq - right.seq);
}

const SECTIONS: Array<{ label: string; tone: string; keep: "first" | "last"; statuses: PhaseStatus[] }> = [
  { label: "Done", tone: "text-merge/80", keep: "last", statuses: ["done"] },
  { label: "Now", tone: "text-ink", keep: "first", statuses: ["active"] },
  { label: "Up next", tone: "text-dim", keep: "first", statuses: ["waiting", "upcoming"] },
];

// A goal's work in three parts that never mix: what is done, what is moving now, and what is up next.
// At the "now" level only the middle part shows, with the rest summed up on one line.
// Done and up-next phases are one line each until opened; long lists fold behind "more".
export function GoalPackages({ at, control, level, onFull, view }: { at: number; control?: PhaseControl; level: "now" | "full"; onFull: () => void; view: GoalView }) {
  const own = usePhaseControl();
  const phases = phaseStates(view);
  const states = phases.length > 0 ? phases : looseStates(view);
  const use = control ?? own;
  const sections = level === "full" ? SECTIONS : SECTIONS.filter((section) => section.label === "Now");
  const rest = [view.done.length > 0 ? `${view.done.length} done` : "", view.queued.length > 0 ? `${view.queued.length} up next` : ""].filter(Boolean);
  const link = "px-2 font-mono text-xs text-dim underline-offset-4 hover:text-ink hover:underline";

  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <Section key={section.label} at={at} control={use} section={section} states={states.filter((state) => section.statuses.includes(state.status))} />
      ))}
      {level === "full" ? (
        <button className={link} type="button" onClick={() => use.setAll(!use.all)}>
          {use.all ? "Show only what is moving" : `See all ${view.live.length + view.done.length + view.queued.length} packages`}
        </button>
      ) : null}
      {level === "now" && rest.length > 0 ? (
        <button className={link} type="button" onClick={onFull}>
          {rest.join(" · ")} · show
        </button>
      ) : null}
    </div>
  );
}

function Section({ at, control, section, states }: { at: number; control: PhaseControl; section: (typeof SECTIONS)[number]; states: PhaseState[] }) {
  const [unfolded, setUnfolded] = useState(false);
  if (states.length === 0) return null;

  const fold = section.label !== "Now" && !control.all && !unfolded && states.length > FOLD_AFTER;
  const kept = section.keep === "last" ? states.slice(-FOLD_AFTER) : states.slice(0, FOLD_AFTER);
  // A phase opened by hand stays visible even where the list is folded.
  const shown = fold ? states.filter((state) => kept.includes(state) || control.isOpen(state)) : states;
  const more = fold && shown.length < states.length ? (
    <button className="flex items-center gap-2 px-2 py-0.5 font-mono text-xs text-faint hover:text-ink" type="button" onClick={() => smoothly(() => setUnfolded(true))}>
      <span className="tracking-widest">···</span>
      {states.length - shown.length} more {section.keep === "last" ? "finished earlier" : "after that"}
    </button>
  ) : null;

  return (
    <div>
      <p className={`px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${section.tone}`}>{section.label}</p>
      {section.keep === "last" ? more : null}
      {shown.map((state) => (
        <div key={state.phase.id}>
          {state.phase.title ? <PhaseRow control={control} state={state} /> : null}
          {control.isOpen(state) ? <PhasePackages at={at} state={state} all={control.all || state.status !== "active"} /> : null}
        </div>
      ))}
      {section.keep === "first" ? more : null}
    </div>
  );
}

const STATUS_META: Record<PhaseStatus, { icon: LucideIcon; tone: string; title: string; count: (state: PhaseState) => string }> = {
  done: { icon: Check, tone: "text-merge", title: "text-dim", count: (state) => `${state.done.length} done` },
  active: { icon: Circle, tone: "fill-current text-build", title: "text-ink", count: (state) => `${state.done.length}/${state.live.length + state.queued.length + state.done.length}` },
  waiting: { icon: Circle, tone: "text-faint", title: "text-dim", count: (state) => `0/${state.queued.length}` },
  upcoming: { icon: Circle, tone: "text-faint", title: "text-dim", count: () => "not sliced yet" },
};

// One phase on one line: status on the left, name, and how much of it is done on the right.
export function PhaseRow({ control, state }: { control: PhaseControl; state: PhaseState }) {
  const meta = STATUS_META[state.status];
  const empty = state.status === "upcoming";

  return (
    <button className={`flex w-full items-center gap-3 rounded px-2 py-1 text-left text-sm ${empty ? "cursor-default" : "hover:bg-white/[0.05]"}`} disabled={empty} type="button" onClick={() => control.toggle(state)}>
      <meta.icon className={`size-2.5 shrink-0 ${meta.tone}`} />
      <span className={`min-w-0 flex-1 truncate font-medium ${meta.title}`}>{state.phase.title}</span>
      <span className="shrink-0 font-mono text-xs text-faint">{meta.count(state)}</span>
    </button>
  );
}

// A phase's packages. Nested groups appear as captions inside it; while only moving work is shown,
// a nested group is listed only if something in it is moving.
export function PhasePackages({ all, at, state }: { all: boolean; at: number; state: PhaseState }) {
  const subs = state.phase.subs.map((sub) => ({ ...sub, ids: new Set(sub.pkgs.map((pkg) => pkg.id)) }));
  const nested = new Set(subs.flatMap((sub) => [...sub.ids]));
  const shown = subs.filter((sub) => all || state.live.some((live) => sub.ids.has(live.pkg.id)));

  return (
    <div className="pl-5">
      <Lines all={all} at={at} keep={(id) => !nested.has(id)} state={state} />
      {shown.map((sub) => (
        <div key={sub.id}>
          <p className="flex items-baseline gap-3 px-2 pb-0.5 pt-1.5 text-xs text-dim">
            <span className="min-w-0 flex-1 truncate">{sub.title}</span>
            <span className="shrink-0 font-mono text-faint">{sub.ids.size === 0 ? "not sliced yet" : `${state.done.filter((pkg) => sub.ids.has(pkg.id)).length}/${sub.ids.size}`}</span>
          </p>
          <div className="pl-3">
            <Lines all={all} at={at} keep={(id) => sub.ids.has(id)} state={state} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Lines({ all, at, keep, state }: { all: boolean; at: number; keep: (id: string) => boolean; state: PhaseState }) {
  return (
    <>
      {state.live.filter((live) => keep(live.pkg.id)).map((live) => (
        <PkgLine key={live.pkg.id} at={at} view={live} />
      ))}
      {all ? state.queued.filter((pkg) => keep(pkg.id)).map((pkg) => <RestLine key={pkg.id} label="queued" pkg={pkg} />) : null}
      {all ? state.done.filter((pkg) => keep(pkg.id)).map((pkg) => <RestLine key={pkg.id} label={pkg.outcome ?? "done"} pkg={pkg} />) : null}
    </>
  );
}

const PRIMARY_BRANCH = /^(main|master)$/;

// Against the repository's default branch where the backend knows it, otherwise against the usual names.
function offPrimary(goal: Goal, base: string) {
  return goal.defaultBranch ? base !== goal.defaultBranch : !PRIMARY_BRANCH.test(base);
}

export function GoalTitle({ goal }: { goal: Goal }) {
  return (
    <>
      {goal.title}
      {goal.mock ? <span className="ml-2 rounded border border-line px-1 align-middle font-mono text-[10px] font-normal uppercase text-faint">mock</span> : null}
      {goal.baseBranch && offPrimary(goal, goal.baseBranch) ? <span className="ml-2 align-middle font-mono text-[11px] font-normal text-faint" title="This goal lands on a branch other than the repository's main one">→ {goal.baseBranch}</span> : null}
    </>
  );
}

// The verdict nudges when it changes, so a goal turning bumpy or needing you does not slip by.
export function VerdictBadge({ small, verdict }: { small?: boolean; verdict: Verdict }) {
  const meta = VERDICT[verdict];
  const ref = useFlash<HTMLSpanElement>(verdict, NUDGE, 600);
  return (
    <span ref={ref} className={`flex shrink-0 origin-left items-center gap-1.5 font-semibold ${small ? "text-xs" : "text-sm"} ${meta.text}`}>
      <span className={`rounded-full ${small ? "size-1.5" : "size-2"} ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

// Status on the left, the detail of where it is on the right.
export function PkgLine({ at, view }: { at: number; view: PkgView }) {
  const ref = useFlash<HTMLDivElement>(`${view.stage}:${view.round}${view.failed ? ":failed" : ""}`, GLOW, 1400);
  return (
    <div ref={ref} className={ROW}>
      <Pip stage={view.stage} failed={view.failed} />
      <span className="truncate text-sm">{view.pkg.title}</span>
      <span className="font-mono text-[11px] text-faint">{view.stage === "review" && view.pkg.reviewMode ? `${view.pkg.reviewMode} review` : ""}</span>
      <Track at={at} view={view} />
      <Session view={view} />
    </div>
  );
}

function RestLine({ label, pkg }: { label: string; pkg: Pkg }) {
  const queued = label === "queued";
  return (
    <div className={ROW}>
      <Pip stage={queued ? "queued" : "done"} />
      <span className={`truncate text-sm ${queued ? "text-dim" : "text-faint line-through decoration-faint/60"}`}>{pkg.title}</span>
      <span />
      <span className={`font-mono text-xs ${queued ? "text-faint" : "text-merge/70"}`}>{label}</span>
      <span />
    </div>
  );
}

const MACHINES: Array<{ name: string; kind: string; icon: LucideIcon }> = [
  { name: "desktop-1", kind: "Desktop", icon: Monitor },
  { name: "desktop-1", kind: "Desktop", icon: Monitor },
  { name: "desktop-1", kind: "Desktop", icon: Monitor },
  { name: "laptop-1", kind: "Laptop", icon: Laptop },
  { name: "vps-1", kind: "Server", icon: Server },
];

const KIND: Record<string, { kind: string; icon: LucideIcon }> = { desktop: { kind: "Desktop", icon: Monitor }, laptop: { kind: "Laptop", icon: Laptop }, server: { kind: "Server", icon: Server } };

// The machine is the operator's label where the backend has one. The Herdr space, tab and pane are a stand-in.
function standInPlace(id: string, area: string[], goalTitle: string) {
  const hash = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const space = (area.at(-1) ?? "work").split(/[ &]/)[0].toLowerCase();
  const tab = goalTitle.split(/\s+/).slice(0, 2).join(" ").toLowerCase();
  return { machine: MACHINES[hash % MACHINES.length], where: `${space} › ${tab} › pane ${(hash % 4) + 1}` };
}

// Where a session lives. It opens on hover and on keyboard focus of the `group` button it sits in.
function PlaceCard({ rows }: { rows: string[][] }) {
  return (
    <span className="pointer-events-none absolute right-0 top-full z-30 mt-1 hidden w-72 rounded border border-line bg-bg p-2.5 text-left text-xs font-normal shadow-xl group-hover:block group-focus-visible:block">
      {rows.map(([label, value]) => (
        <span key={label} className="flex justify-between gap-3 py-0.5">
          <span className="shrink-0 text-faint">{label}</span>
          <span className="truncate text-ink">{value}</span>
        </span>
      ))}
    </span>
  );
}

// Where the session is: only the machine icon on the line, the full address on hover.
export function Session({ view }: { view: PkgView }) {
  if (!view.actor && !view.pkg.location) return <span />;
  const standIn = standInPlace(view.pkg.id, view.pkg.area ?? [], view.pkg.goalTitle ?? "");
  const known = view.pkg.location;
  const machine = known ? { name: known.label, ...(KIND[known.kind] ?? { kind: "Machine", icon: Monitor }) } : standIn.machine;
  const address = view.actor ? standIn.where : "";
  const rows = [[machine.kind, machine.name], ...(view.actor ? [["Where", address], ["Thread", view.actor]] : [])];

  return (
    <button aria-label={`Session on ${machine.name}`} className="group relative flex size-6 items-center justify-center rounded text-dim hover:bg-line hover:text-ink" type="button" onClick={() => locate([machine.name, address].filter(Boolean).join(" › "))}>
      <machine.icon className="size-3.5" />
      <PlaceCard rows={rows} />
    </button>
  );
}

// The way to the architect's session, with the same card as a package's session.
// The address is a stand-in on sample goals: the backend does not report where an architect's session is yet.
export function FindArchitect({ goal }: { goal: Goal }) {
  const place = goal.mock ? standInPlace(goal.id, goal.area, goal.title) : null;

  return (
    <button className="group relative flex shrink-0 items-center gap-1.5 self-center rounded px-1.5 py-0.5 text-xs text-dim hover:bg-line hover:text-ink" type="button" onClick={() => locate(place ? `${place.machine.name} › ${place.where}` : `${goal.title} · architect`)}>
      {place ? <place.machine.icon className="size-3.5" /> : null}
      Find the architect
      {place ? <PlaceCard rows={[[place.machine.kind, place.machine.name], ["Where", place.where]]} /> : null}
    </button>
  );
}
