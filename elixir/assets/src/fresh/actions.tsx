import { MoreHorizontal } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import type { Goal } from "./model";

// Called after an action went through, so the board reads the ledger again.
export const ReloadContext = createContext<() => void>(() => undefined);

type Step = [path: string, body: Record<string, string>];
type Action = { key: string; label: string; hint: string; confirm: string; steps: Step[] };

const COMPLETE: Step = ["state", { state: "completed" }];
const ARCHIVE: Step = ["archive", {}];

// The backend archives only finished goals, so archiving an unfinished one marks it done first.
function actionsFor(goal: Goal): Action[] {
  const finished = goal.closedAt !== null;
  const done: Action = { key: "done", label: "Mark as done", hint: "Close this goal as finished, whatever its packages say.", confirm: "Mark as done?", steps: [COMPLETE] };
  const archive: Action = finished
    ? { key: "archive", label: "Archive", hint: "Take it off the board. It can be restored.", confirm: "Archive?", steps: [ARCHIVE] }
    : { key: "archive", label: "Archive", hint: "Mark it done and take it off the board. It can be restored.", confirm: "Archive?", steps: [COMPLETE, ARCHIVE] };
  const remove: Action = { key: "delete", label: "Delete", hint: "Remove it for good, with its packages and their worktrees.", confirm: "Delete for good?", steps: [["delete", {}]] };
  return finished ? [archive, remove] : [done, archive, remove];
}

async function run(goalId: string, [path, body]: Step) {
  const response = await fetch(`/api/v1/sympp/operator/work-requests/${encodeURIComponent(goalId)}/${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return;
  const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  throw new Error(payload?.error?.message || "The backend refused this.");
}

// The only things the board changes: closing, archiving or deleting a goal. Each takes a second click.
export function GoalActions({ className, goal }: { className?: string; goal: Goal }) {
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
          {actionsFor(goal).map((action) => (
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
