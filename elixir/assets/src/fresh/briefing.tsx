import { ChevronRight } from "lucide-react";

import { GoalActions } from "./actions";
import { areaLabel } from "./areas";
import { AskLine, lanesOf, Rest } from "./board";
import type { GoalView } from "./model";
import { Deploy } from "./parts";
import { BriefAge, DotStrip, FindArchitect, GoalPackages, GoalTitle, reportFor, useGoalLevel, VerdictBadge } from "./report";
import { SinceChip } from "./since";

// Direction 2: every goal reports in. Words first, dots second, packages only if you ask.
export function Briefing({ at, views }: { at: number; views: GoalView[] }) {
  const lanes = lanesOf(views, at);

  return (
    <div className="mx-auto max-w-[1080px]">
      <div className="space-y-4">
        {lanes.main.map((view) => (
          <GoalReport key={view.goal.id} at={at} view={view} />
        ))}
      </div>
      <Rest at={at} lanes={lanes} />
    </div>
  );
}

function GoalReport({ at, view }: { at: number; view: GoalView }) {
  const report = reportFor(view, at);
  const { level, showAll, toggle } = useGoalLevel(report.verdict);
  const total = view.live.length + view.queued.length + view.done.length;

  return (
    <article className="rounded-lg border border-line bg-panel p-5" data-goal={view.goal.id}>
      <div className="flex items-start">
        <button className="block min-w-0 flex-1 text-left" type="button" onClick={toggle}>
          <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{areaLabel(view.goal.area)}</span>
          <span className="mt-1 flex items-baseline gap-3">
            <ChevronRight className={`size-4 shrink-0 self-center text-faint transition-transform ${level === "closed" ? "" : "rotate-90"}`} />
            <span className="min-w-0 flex-1 text-lg font-semibold leading-snug">
              <GoalTitle goal={view.goal} />
            </span>
            <SinceChip goalId={view.goal.id} />
            <VerdictBadge verdict={report.verdict} />
          </span>
        </button>
        <FindArchitect compact className="ml-2 mt-5" goal={view.goal} />
        <GoalActions className="mt-5" goal={view.goal} moving={view.live.length} />
      </div>
      <p className="mt-2 max-w-[72ch] pl-7 text-[15px] leading-relaxed text-ink/90">
        {report.brief}
        {report.eta ? <span className="text-dim"> ETA: {report.eta}.</span> : null}
        <BriefAge at={at} report={report} />
        {report.sample ? <span className="ml-2 rounded border border-line px-1 font-mono text-[10px] uppercase text-faint">sample wording</span> : null}
      </p>
      <AskLine at={at} className="ml-7 mt-3" view={view} />
      {report.bumps.length > 0 ? (
        <ul className="ml-7 mt-3 space-y-0.5 border-l-2 border-checks pl-3 text-sm text-dim">
          {report.bumps.map((bump) => (
            <li key={bump}>{bump}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex items-center gap-3 pl-7">
        <DotStrip view={view} />
        <span className="shrink-0 font-mono text-xs text-dim">
          {view.live.length} moving · {view.done.length}/{total} done
        </span>
        <Deploy at={at} goal={view.goal} />
      </div>
      {level !== "closed" ? (
        <div className="mt-4 pl-5">
          <GoalPackages at={at} level={level} view={view} onFull={showAll} />
        </div>
      ) : null}
    </article>
  );
}
