import { Check, ChevronRight } from "lucide-react";

import { GoalActions } from "./actions";
import { areaLabel } from "./areas";
import { AskLine, lanesOf, Rest } from "./board";
import { deployAt, type Goal, type GoalView } from "./model";
import { Deploy, deployLabel, Pip } from "./parts";
import { BriefAge, DotStrip, GoalPackages, GoalTitle, phaseStates, reportFor, useGoalLevel, usePhaseControl, VerdictBadge, type PhaseState } from "./report";
import { SinceChip } from "./since";

// Direction 3: a goal the architect grouped becomes a route of its phases. Ungrouped goals stay a plain line of dots.
export function Phases({ at, views }: { at: number; views: GoalView[] }) {
  const lanes = lanesOf(views, at);

  return (
    <div className="mx-auto max-w-[1280px]">
      <div className="divide-y divide-line border-y border-line">
        {lanes.main.map((view) => (
          <GoalRoute key={view.goal.id} at={at} view={view} />
        ))}
      </div>
      <Rest at={at} lanes={lanes} />
    </div>
  );
}

function GoalRoute({ at, view }: { at: number; view: GoalView }) {
  const report = reportFor(view, at);
  const { level, showAll, toggle } = useGoalLevel(report.verdict);
  const control = usePhaseControl();
  const phases = phaseStates(view);
  const listed = (state: PhaseState) => level === "full" || (level === "now" && state.status === "active");
  // A box always answers a click: it opens its phase, widening the goal first when the phase is not listed yet.
  const pick = (state: PhaseState) => {
    if (listed(state)) return control.toggle(state);
    showAll();
    control.open(state);
  };

  return (
    <section className="py-5" data-goal={view.goal.id}>
      <div className="flex items-center">
        <button className="flex min-w-0 flex-1 items-baseline gap-3 text-left" type="button" onClick={toggle}>
          <ChevronRight className={`size-4 shrink-0 self-center text-faint transition-transform ${level === "closed" ? "" : "rotate-90"}`} />
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{areaLabel(view.goal.area.slice(-1))}</span>
          <span className="min-w-0 flex-1 truncate font-semibold">
            <GoalTitle goal={view.goal} />
          </span>
          <SinceChip goalId={view.goal.id} />
          <VerdictBadge verdict={report.verdict} />
        </button>
        <GoalActions className="ml-2" goal={view.goal} moving={view.live.length} />
      </div>
      <p className="mt-1 pl-7 text-sm text-dim">
        {report.brief}
        {report.eta ? ` ETA: ${report.eta}.` : ""}
        <BriefAge at={at} report={report} />
      </p>
      <AskLine at={at} className="ml-7 mt-2" view={view} />
      <div className="pl-7">
        {phases.length > 0 ? (
          <Route at={at} goal={view.goal} isOpen={(state) => listed(state) && control.isOpen(state)} phases={phases} onPick={pick} />
        ) : (
          <div className="mt-3 flex items-center gap-3">
            <DotStrip view={view} />
            <Deploy at={at} goal={view.goal} />
          </div>
        )}
        {level !== "closed" ? (
          <div className="mt-3">
            <GoalPackages at={at} control={control} level={level} view={view} onFull={showAll} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

// The route is always visible. Its boxes open and close the same phases as the list underneath.
function Route({ at, goal, isOpen, onPick, phases }: { at: number; goal: Goal; isOpen: (state: PhaseState) => boolean; onPick: (state: PhaseState) => void; phases: PhaseState[] }) {
  const steps = deployAt(goal, at);

  return (
    <ol className="mt-3 flex items-stretch gap-1">
      {phases.map((state) => (
        <PhaseBox key={state.phase.id} state={state} open={isOpen(state)} onToggle={() => onPick(state)} />
      ))}
      {steps.map((step) => {
        const label = deployLabel(step);
        return (
          <li key={step.env} className={`flex w-20 shrink-0 items-center justify-center rounded border border-dashed border-line px-1 text-center font-mono text-xs ${label.tone || "text-faint"}`}>
            {label.text}
          </li>
        );
      })}
    </ol>
  );
}

const BOX: Record<PhaseState["status"], string> = {
  done: "border-merge/30 text-dim",
  active: "border-ink/60 bg-panel text-ink",
  waiting: "border-line text-dim",
  upcoming: "border-dashed border-line text-faint",
};

function PhaseBox({ onToggle, open, state }: { onToggle: () => void; open: boolean; state: PhaseState }) {
  const total = state.live.length + state.queued.length + state.done.length;
  const empty = total === 0;

  return (
    <li className="min-w-0 flex-1">
      <button className={`flex h-full w-full flex-col gap-1.5 rounded border px-3 py-2 text-left ${empty ? "cursor-default" : "hover:border-ink/60"} ${BOX[state.status]} ${open ? "ring-1 ring-ink/40" : ""}`} disabled={empty} type="button" onClick={onToggle}>
        <span className="flex items-center gap-1.5 text-xs font-medium">
          {state.status === "done" ? <Check className="size-3.5 shrink-0 text-merge" /> : <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />}
          <span className="truncate">{state.phase.title}</span>
        </span>
        <span className="flex flex-wrap gap-0.5">
          {state.done.map((pkg) => <Pip key={pkg.id} stage="done" />)}
          {state.live.map((entry) => <Pip key={entry.pkg.id} stage={entry.stage} failed={entry.failed} />)}
          {state.queued.map((pkg) => <Pip key={pkg.id} stage="queued" />)}
        </span>
        <span className="font-mono text-[11px] text-dim">{phaseCaption(state, total)}</span>
      </button>
    </li>
  );
}

function phaseCaption(state: PhaseState, total: number) {
  if (state.status === "upcoming") return "not sliced yet";
  if (state.status === "done") return `done · ${total}`;
  if (state.status === "waiting") return `up next · 0/${state.queued.length}`;
  return `${state.live.length} moving · ${state.done.length}/${total}`;
}
