import { GoalActions, ShelfCleanup } from "./actions";
import { areaLabel } from "./areas";
import { deployAt, span, type DeployStep, type Goal, type GoalView, type PkgView, type Stage } from "./model";
import { POP, useFlash } from "./motion";

export const STAGE: Record<Stage, { label: string; text: string; bg: string; border: string }> = {
  queued: { label: "Queued", text: "text-faint", bg: "bg-faint", border: "border-faint" },
  build: { label: "Build", text: "text-build", bg: "bg-build", border: "border-build" },
  checks: { label: "Checks", text: "text-checks", bg: "bg-checks", border: "border-checks" },
  review: { label: "Review", text: "text-review", bg: "bg-review", border: "border-review" },
  merge: { label: "Merge", text: "text-merge", bg: "bg-merge", border: "border-merge" },
  done: { label: "Done", text: "text-dim", bg: "bg-merge/40", border: "border-line" },
};

const FULL_TRACK: Array<{ label: string; stage: Stage | "pr" }> = [
  { label: "Build", stage: "build" },
  { label: "PR", stage: "pr" },
  { label: "Checks", stage: "checks" },
  { label: "Review", stage: "review" },
  { label: "Merge", stage: "merge" },
];
const SHORT_TRACK: Array<{ label: string; stage: Stage | "pr" }> = [
  { label: "Work", stage: "build" },
  { label: "Done", stage: "done" },
];
const ORDER: Record<Stage, number> = { queued: -1, build: 0, checks: 2, review: 3, merge: 4, done: 5 };

// Build ─ PR ─ Checks ─ Review ─ Merge, with the current step carrying how long it has been there.
export function Track({ at, view }: { at: number; view: PkgView }) {
  const steps = view.pkg.short ? SHORT_TRACK : FULL_TRACK;
  const live = view.stage !== "done" && view.stage !== "queued";
  const position = view.pkg.short && live ? 0 : ORDER[view.stage];

  return (
    <ol className="flex items-center gap-1.5 whitespace-nowrap font-mono text-xs">
      {steps.map((step, index) => {
        const current = live && (view.pkg.short ? index === 0 : step.stage === view.stage);
        return (
          <li key={step.label} className="flex items-center gap-1.5">
            {index > 0 ? <span className={index <= position ? "text-dim" : "text-faint"}>─</span> : null}
            {current ? <CurrentStep at={at} view={view} /> : <StepLabel reached={index < position} step={step} view={view} />}
          </li>
        );
      })}
    </ol>
  );
}

// A step the package is not on. The PR step opens the PR once there is one.
function StepLabel({ reached, step, view }: { reached: boolean; step: { label: string; stage: Stage | "pr" }; view: PkgView }) {
  const tone = reached ? "text-dim" : "text-faint";
  if (step.stage !== "pr" || !view.pkg.prUrl) return <span className={tone}>{step.label}</span>;
  return (
    <a className={`underline decoration-dotted underline-offset-2 hover:text-ink ${tone}`} href={view.pkg.prUrl} rel="noreferrer" target="_blank" title={view.pkg.prNumber ? `Open PR #${view.pkg.prNumber}` : "Open the PR"}>
      {step.label}
    </a>
  );
}

function CurrentStep({ at, view }: { at: number; view: PkgView }) {
  const tone = view.failed ? "text-fail" : STAGE[view.stage].text;
  const label = view.pkg.short ? "Work" : STAGE[view.stage].label;
  const round = view.stage === "review" && view.round > 1 ? ` · round ${view.round}` : "";

  return (
    <span className={`font-semibold ${tone}`}>
      {label}
      {view.failed ? " failing" : ""}
      {round}
      {view.untimed ? "" : ` · ${span(at - view.since)}`}
    </span>
  );
}

export function locate(actor: string) {
  window.dispatchEvent(new CustomEvent("fresh:locate", { detail: actor }));
}

// Goals that ask for nothing stay out of the way: one line, opened on demand.
function shelfCount(view: GoalView) {
  const total = view.done.length + view.queued.length + view.live.length;
  return total === 0 ? "not sliced" : `${view.done.length}/${total} done`;
}

// `age` says what the time on each row means, for example "idle" or "done".
export function Shelf({ age, at, cleanup, hint, label, views }: { age: string; at: number; cleanup?: boolean; hint?: string; label: string; views: GoalView[] }) {
  if (views.length === 0) return null;

  return (
    <details className="mt-8 text-sm text-dim">
      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        {label} · {views.length}
        {hint ? <span className="ml-2 font-normal normal-case tracking-normal">{hint}</span> : null}
      </summary>
      {cleanup ? (
        <div className="mt-2 flex max-w-[900px] justify-end">
          <ShelfCleanup at={at} views={views} />
        </div>
      ) : null}
      <ul className="mt-2 max-w-[900px] space-y-1">
        {views.map((view) => (
          <li key={view.goal.id} className="flex items-center justify-between gap-4" data-goal={view.goal.id}>
            <span className="min-w-0 truncate">{view.goal.title}</span>
            <span className="shrink-0 text-[11px] uppercase tracking-[0.12em] text-faint" title={view.goal.repo}>{areaLabel(view.goal.area)}</span>
            <span className="min-w-0 flex-1 truncate text-faint">{view.goal.report?.parked?.text}</span>
            <span className="shrink-0 font-mono text-xs text-faint">
              {shelfCount(view)} · {age} {span(at - (view.goal.report?.parked?.at ?? view.lastMoveAt))}
            </span>
            <GoalActions goal={view.goal} moving={view.live.length} />
          </li>
        ))}
      </ul>
    </details>
  );
}

// A package's dot pops when its stage changes, so a glance catches what just moved.
export function Pip({ stage, failed }: { stage: Stage; failed?: boolean }) {
  const ref = useFlash<HTMLSpanElement>(`${stage}${failed ? ":failed" : ""}`, POP, 700);
  const tone = failed ? "bg-fail" : stage === "queued" ? "border border-faint" : STAGE[stage].bg;
  return <span ref={ref} className={`inline-block size-2 rounded-[2px] ${tone}`} title={STAGE[stage].label} />;
}

const DEPLOY_MARK: Record<DeployStep["state"], { mark: string; tone: string }> = {
  ok: { mark: "✓", tone: "text-merge" },
  failed: { mark: "✗ failed", tone: "text-fail" },
  pending: { mark: "…", tone: "text-checks" },
  waiting: { mark: "", tone: "" },
};

export function deployLabel(step: DeployStep) {
  return { text: `${step.env} ${DEPLOY_MARK[step.state].mark}`.trim(), tone: DEPLOY_MARK[step.state].tone };
}

// After the last merge: where the result is running. Shown only for goals whose repository has its
// deploy workflows tagged, and faint until a deploy has reported.
export function Deploy({ at, goal }: { at: number; goal: Goal }) {
  const steps = deployAt(goal, at);
  if (steps.length === 0) return null;

  return (
    <span className="shrink-0 font-mono text-xs text-faint">
      {steps.map((step) => {
        const label = deployLabel(step);
        return (
          <span key={step.env}>
            {" ┄ "}
            <span className={label.tone}>{label.text}</span>
          </span>
        );
      })}
    </span>
  );
}
