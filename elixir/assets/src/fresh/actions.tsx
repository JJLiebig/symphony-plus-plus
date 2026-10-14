import { MoreHorizontal } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import { api } from "./api";
import type { Goal, GoalView } from "./model";

// Called after an action went through, so the board reads the ledger again.
export const ReloadContext = createContext<() => void>(() => undefined);

type Step = [path: string, body: Record<string, string>];
type Action = { key: string; label: string; hint: string; confirm: string; steps: Step[] };

const COMPLETE: Step = ["state", { state: "completed" }];
const ARCHIVE: Step = ["archive", {}];
const STALE_MS = 30 * 24 * 3600e3;

// The backend archives only finished goals, so archiving an unfinished one marks it done first.
function archiveSteps(goal: Goal): Step[] {
  return goal.closedAt === null ? [COMPLETE, ARCHIVE] : [ARCHIVE];
}

// None of these stops a running worker or merges a PR, so a goal with work in flight says so.
function actionsFor(goal: Goal, moving: number): Action[] {
  const finished = goal.closedAt !== null;
  const running = moving > 0 ? ` ${moving} ${moving === 1 ? "package is" : "packages are"} still moving and will keep running.` : "";
  const done: Action = { key: "done", label: "Mark as done", hint: `Close this goal as finished, whatever its packages say.${running}`, confirm: "Mark as done?", steps: [COMPLETE] };
  const archiveHint = finished ? "Take it off the board. It can be restored." : `Mark it done and take it off the board. It can be restored.${running}`;
  const archive: Action = { key: "archive", label: "Archive", hint: archiveHint, confirm: "Archive?", steps: archiveSteps(goal) };
  const remove: Action = { key: "delete", label: "Delete", hint: `Remove it for good, with its history, its packages and their worktrees.${running}`, confirm: "Delete for good?", steps: [["delete", {}]] };
  return finished ? [archive, remove] : [done, archive, remove];
}

async function run(goalId: string, [path, body]: Step) {
  const response = await fetch(api(`/work-requests/${encodeURIComponent(goalId)}/${path}`), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return;
  const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  throw new Error(payload?.error?.message || "The backend refused this.");
}

// The only things the board changes: closing, archiving or deleting a goal. Each takes a second click.
export function GoalActions({ className, goal, moving = 0 }: { className?: string; goal: Goal; moving?: number }) {
  const reload = useContext(ReloadContext);
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  // Mock goals are not in the ledger, so there is nothing to act on; the gap keeps rows aligned.
  if (goal.mock) return <span className={`inline-block size-6 shrink-0 ${className ?? ""}`} />;

  const toggle = () => {
    setOpen(!open);
    setArmed(null);
    setFailure(null);
  };
  const pick = async (action: Action) => {
    if (armed !== action.key) return setArmed(action.key);
    setBusy(true);
    try {
      for (const step of action.steps) await run(goal.id, step);
      setOpen(false);
      reload();
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "The backend refused this.");
    } finally {
      setBusy(false);
      setArmed(null);
    }
  };

  return (
    <span ref={root} className={`relative inline-block shrink-0 ${className ?? ""}`}>
      <button aria-expanded={open} aria-label={`Actions for ${goal.title}`} className={`flex size-6 items-center justify-center rounded hover:bg-line hover:text-ink ${open ? "bg-line text-ink" : "text-faint"}`} title="Mark as done, archive or delete" type="button" onClick={toggle}>
        <MoreHorizontal className="size-4" />
      </button>
      {open ? (
        <span className="absolute right-0 top-full z-30 mt-1 block w-72 rounded border border-line bg-bg p-1 text-left text-sm font-normal shadow-xl">
          {actionsFor(goal, moving).map((action) => (
            <button key={action.key} className={`block w-full rounded px-2.5 py-1.5 text-left hover:bg-line disabled:opacity-50 ${action.key === "delete" ? "text-fail" : "text-ink"}`} disabled={busy} type="button" onClick={() => void pick(action)}>
              <span className="block font-medium">{armed === action.key ? `${action.confirm} Click again` : action.label}</span>
              <span className="block text-xs text-dim">{action.hint}</span>
            </button>
          ))}
          {failure ? <span className="block px-2.5 py-1.5 text-xs text-fail">{failure}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

// Clears a shelf in one go: everything on it, or only what has sat there for a month. Each takes a second click.
export function ShelfCleanup({ at, views }: { at: number; views: GoalView[] }) {
  const reload = useContext(ReloadContext);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const real = views.filter((view) => !view.goal.mock);
  const stale = real.filter((view) => at - view.lastMoveAt > STALE_MS);
  const choices = [
    { key: "stale", label: `older than 30 days (${stale.length})`, picked: stale.length < real.length ? stale : [] },
    { key: "all", label: `all (${real.length})`, picked: real },
  ].filter((choice) => choice.picked.length > 0);
  if (choices.length === 0) return null;

  const pick = async (choice: (typeof choices)[number]) => {
    if (armed !== choice.key) return setArmed(choice.key);
    setBusy(true);
    setFailure(null);
    try {
      for (const view of choice.picked) for (const step of archiveSteps(view.goal)) await run(view.goal.id, step);
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "The backend refused this.");
    } finally {
      setBusy(false);
      setArmed(null);
      reload();
    }
  };

  return (
    <p className="flex items-center gap-1 text-xs text-faint">
      <span title="Marks them done where needed and takes them off the board. They can be restored.">Archive</span>
      {choices.map((choice) => (
        <button key={choice.key} className={`rounded px-1.5 py-0.5 hover:bg-line hover:text-ink disabled:opacity-50 ${armed === choice.key ? "bg-line text-ink" : ""}`} disabled={busy} type="button" onClick={() => void pick(choice)}>
          {armed === choice.key ? `Archive ${choice.picked.length}? Click again` : choice.label}
        </button>
      ))}
      {failure ? <span className="text-fail">{failure}</span> : null}
    </p>
  );
}
