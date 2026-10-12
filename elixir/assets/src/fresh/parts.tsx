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
            {current ? <CurrentStep at={at} view={view} /> : <span className={index < position ? "text-dim" : "text-faint"}>{step.label}</span>}
          </li>
        );
      })}
    </ol>
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
export function Shelf({ at, hint, label, views }: { at: number; hint?: string; label: string; views: GoalView[] }) {
  if (views.length === 0) return null;

  return (
    <details className="mt-8 text-sm text-dim">
      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        {label} · {views.length}
        {hint ? <span className="ml-2 font-normal normal-case tracking-normal">{hint}</span> : null}
      </summary>
      <ul className="mt-2 max-w-[900px] space-y-1">
        {views.map((view) => (
          <li key={view.goal.id} className="flex justify-between gap-4">
            <span className="shrink-0 truncate">{view.goal.title}</span>
            <span className="min-w-0 flex-1 truncate text-faint">{view.goal.report?.parked?.text}</span>
            <span className="shrink-0 font-mono text-xs text-faint">
              {view.done.length}/{view.done.length + view.queued.length + view.live.length} · {span(at - view.lastMoveAt)}
            </span>
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
};

export function deployLabel(steps: DeployStep[], env: DeployStep["env"]) {
  const step = steps.find((entry) => entry.env === env);
  return step ? { text: `${env} ${DEPLOY_MARK[step.state].mark}`, tone: DEPLOY_MARK[step.state].tone } : { text: env, tone: "" };
}

// After the last merge: where the result is running. Shown only for goals whose repository has its
// deploy workflows tagged, and faint until a deploy has reported.
export function Deploy({ at, goal }: { at: number; goal: Goal }) {
  const steps = deployAt(goal, at);
  if (!goal.deploy) return null;

  return (
    <span className="shrink-0 font-mono text-xs text-faint">
      {(["Dev", "Prod"] as const).map((env) => {
        const label = deployLabel(steps, env);
        return (
          <span key={env}>
            {" ┄ "}
            <span className={label.tone}>{label.text}</span>
          </span>
        );
      })}
    </span>
  );
}
