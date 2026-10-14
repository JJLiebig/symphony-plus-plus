import { createContext, Fragment, useContext, useRef } from "react";

import { span, type GoalView } from "./model";
import { reportFor, wantsAttention, type Verdict } from "./report";

// What changed between the last look and now, per goal and in total. Each total knows the goals behind it.
type Total = { label: string; goalIds: string[] };
export type Changes = { notes: Map<string, string[]>; totals: Total[] };
export const SinceContext = createContext<Map<string, string[]>>(new Map());

const ARRIVED: Partial<Record<Verdict, string>> = { needs_you: "now needs you", bump: "new road bump", stalled: "stalled", settled: "finished" };
// Singular and plural wording for the totals line.
const TOTALS: Record<string, [string, string]> = {
  "now needs you": ["now needs you", "now need you"],
  "new road bump": ["new road bump", "new road bumps"],
  stalled: ["stalled", "stalled"],
  "back on track": ["back on track", "back on track"],
  finished: ["goal finished", "goals finished"],
  new: ["new goal", "new goals"],
  done: ["package done", "packages done"],
  started: ["package started", "packages started"],
};

function verdictNote(was: Verdict, is: Verdict) {
  if (was === is) return "";
  return ARRIVED[is] ?? (is === "on_track" && wantsAttention(was) ? "back on track" : "");
}

function goalChanges(then: GoalView | undefined, now: GoalView, since: number, at: number) {
  if (!then) return { notes: ["new"], done: 0, started: 0 };
  const doneThen = new Set(then.done.map((pkg) => pkg.id));
  const knownThen = new Set([...doneThen, ...then.live.map((live) => live.pkg.id)]);
  const done = now.done.filter((pkg) => !doneThen.has(pkg.id)).length;
  const started = now.live.filter((live) => !knownThen.has(live.pkg.id)).length;
  const notes = [verdictNote(reportFor(then, since).verdict, reportFor(now, at).verdict), done > 0 ? `+${done} done` : "", started > 0 ? `+${started} started` : ""];
  return { notes: notes.filter(Boolean), done, started };
}

export function changesBetween(before: GoalView[], after: GoalView[], since: number, at: number): Changes {
  const then = new Map(before.map((view) => [view.goal.id, view]));
  const notes = new Map<string, string[]>();
  const tally = new Map<string, { sum: number; goalIds: string[] }>();
  const count = (label: string, by: number, goalId: string) => {
    if (by === 0) return;
    const entry = tally.get(label) ?? { sum: 0, goalIds: [] };
    tally.set(label, { sum: entry.sum + by, goalIds: [...entry.goalIds, goalId] });
  };

  for (const view of after) {
    const entry = goalChanges(then.get(view.goal.id), view, since, at);
    if (entry.notes.length > 0) notes.set(view.goal.id, entry.notes);
    entry.notes.filter((note) => !note.startsWith("+")).forEach((note) => count(note, 1, view.goal.id));
    count("done", entry.done, view.goal.id);
    count("started", entry.started, view.goal.id);
  }
  const totals = Object.keys(TOTALS).flatMap((label) => {
    const entry = tally.get(label);
    return entry ? [{ label: `${entry.sum} ${TOTALS[label][entry.sum === 1 ? 0 : 1]}`, goalIds: entry.goalIds }] : [];
  });
  return { notes, totals };
}

// One line that saves rescanning the board: what happened while you were away.
export function SinceLine({ at, changes, onPick, onSeen, since, width }: { at: number; changes: Changes; onPick: (goalId: string) => void; onSeen: () => void; since: number; width: string }) {
  // A figure can stand for several goals: each click goes to the next one.
  const turns = useRef(new Map<string, number>());
  const next = (total: Total) => {
    const turn = turns.current.get(total.label) ?? 0;
    turns.current.set(total.label, turn + 1);
    onPick(total.goalIds[turn % total.goalIds.length]);
  };
  if (changes.totals.length === 0) return <p className={`mx-auto mb-5 text-sm text-faint ${width}`}>Nothing has changed since you last looked.</p>;

  return (
    <div className={`mx-auto mb-5 flex items-baseline gap-3 text-sm ${width}`}>
      <span className="shrink-0 text-faint">Since you last looked, {span(at - since)} ago</span>
      <span className="flex min-w-0 items-baseline overflow-hidden whitespace-nowrap text-ink">
        {changes.totals.map((total, index) => (
          <Fragment key={total.label}>
            {index > 0 ? <span className="text-faint">·</span> : null}
            <button className="rounded px-1.5 hover:bg-line" title={total.goalIds.length > 1 ? "Take me there. Click again for the next one." : "Take me there"} type="button" onClick={() => next(total)}>
              {total.label}
            </button>
          </Fragment>
        ))}
      </span>
      <button className="shrink-0 rounded px-1.5 py-0.5 text-xs text-dim hover:bg-line hover:text-ink" type="button" onClick={onSeen}>
        Mark as seen
      </button>
    </div>
  );
}

export function SinceChip({ goalId }: { goalId: string }) {
  const notes = useContext(SinceContext).get(goalId);
  if (!notes) return null;
  return (
    <span className="shrink-0 rounded bg-white/10 px-1.5 py-px font-mono text-[10px] font-normal text-ink/80" title="Changed since you last looked">
      {notes.join(" · ")}
    </span>
  );
}
