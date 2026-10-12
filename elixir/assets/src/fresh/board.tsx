import { Check } from "lucide-react";

import { deployAt, span, type GoalView } from "./model";
import { Deploy, locate, Shelf } from "./parts";
import { GoalTitle, reportFor, type Verdict } from "./report";

const DAY = 24 * 3600e3;
const DORMANT_AFTER = 14 * DAY;
const RANK: Record<Verdict, number> = { needs_you: 0, bump: 1, stalled: 2, on_track: 3, idle: 4, parked: 5, settled: 6 };

// Where a goal belongs on the page. Only "main" asks for attention; the rest are kept out of the way.
export type Lanes = { main: GoalView[]; landed: GoalView[]; parked: GoalView[]; dormant: GoalView[]; backlog: GoalView[]; settled: GoalView[] };

function laneOf(view: GoalView, at: number): keyof Lanes {
  // The architect set the goal aside on purpose; it comes back when work resumes or a question is raised.
  if (view.goal.report?.parked && !view.ask && view.state !== "settled") return "parked";
  if (view.state === "live") return "main";
  if (view.state === "settled") return settledLane(view, at);
  if (view.done.length === 0) return "backlog";
  return at - view.lastMoveAt < DORMANT_AFTER ? "main" : "dormant";
}

// Finished means merged. A finished goal stays in sight for a day after its last step, and for as long
// as its repository tracks deploys and none has succeeded yet. A failed deploy puts it back in the main lane.
function settledLane(view: GoalView, at: number): keyof Lanes {
  const steps = deployAt(view.goal, at);
  if (steps.some((step) => step.state === "failed")) return "main";
  const lastStep = Math.max(view.lastMoveAt, ...steps.map((step) => step.at));
  const undeployed = view.goal.deploy !== undefined && !steps.some((step) => step.state === "ok");
  return at - lastStep < DAY || undeployed ? "landed" : "settled";
}

// The main lane is ordered by who needs attention first, not by where the work is filed.
export function lanesOf(views: GoalView[], at: number): Lanes {
  const lanes: Lanes = { main: [], landed: [], parked: [], dormant: [], backlog: [], settled: [] };
  for (const view of views) lanes[laneOf(view, at)].push(view);
  const rank = new Map(lanes.main.map((view) => [view.goal.id, RANK[reportFor(view, at).verdict]]));
  lanes.main.sort((left, right) => rank.get(left.goal.id)! - rank.get(right.goal.id)!);
  return lanes;
}

export function Rest({ at, lanes }: { at: number; lanes: Lanes }) {
  return (
    <>
      <Landed at={at} views={lanes.landed} />
      <Shelf at={at} hint="set aside by the architect" label="Parked" views={lanes.parked} />
      <Shelf at={at} hint="started, then nothing for two weeks or more" label="Dormant" views={lanes.dormant} />
      <Shelf at={at} hint="no package has been picked up" label="Not started" views={lanes.backlog} />
      <Shelf at={at} label="Settled" views={lanes.settled} />
    </>
  );
}

// Finished goals report once more, with where the result is running, then leave on their own.
function Landed({ at, views }: { at: number; views: GoalView[] }) {
  if (views.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Landed · last 24 hours</h2>
      <ul className="divide-y divide-line border-y border-line">
        {views.map((view) => (
          <li key={view.goal.id} className="flex items-center gap-3 py-2 pr-2 text-sm">
            <Check className="size-4 shrink-0 text-merge" />
            <span className="max-w-[40%] shrink-0 truncate font-medium">
              <GoalTitle goal={view.goal} />
            </span>
            <span className="min-w-0 flex-1 truncate text-dim">{reportFor(view, at).brief}</span>
            <Deploy at={at} goal={view.goal} />
            <span className="w-24 shrink-0 text-right font-mono text-xs text-faint">{span(at - view.lastMoveAt)} ago</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// What the architect needs from you, always on the goal, with the way to its session.
export function AskLine({ at, className, view }: { at: number; className?: string; view: GoalView }) {
  if (!view.ask) return null;

  return (
    <p className={`flex items-baseline gap-3 border-l-2 border-you pl-3 text-sm ${className ?? ""}`}>
      <span className="shrink-0 font-semibold text-you">Architect asks</span>
      <span className="min-w-0 flex-1 text-ink">{view.ask.title}</span>
      <span className="shrink-0 font-mono text-xs text-dim">{span(at - view.ask.from)} ago</span>
      <button className="shrink-0 rounded px-1.5 py-0.5 text-xs text-dim hover:bg-line hover:text-ink" type="button" onClick={() => locate(`${view.goal.title} · architect`)}>
        Find the architect
      </button>
    </p>
  );
}
