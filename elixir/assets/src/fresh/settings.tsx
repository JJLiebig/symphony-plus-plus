import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api } from "./api";
import type { Settings } from "./model";

type Key = keyof Settings;
type Draft = Partial<Record<Key, number | boolean>>;

const DAYS: Array<[Key, string]> = [
  ["work_request_archive_after_days", "Finished goals are archived after"],
  ["work_request_never_started_archive_after_days", "Goals that never started, after"],
  ["solo_session_delete_after_days", "Archived goals are deleted for good after"],
];
const SWITCHES: Array<[Key, string]> = [
  ["open_dashboard_on_boot", "Open the board when the backend starts"],
  ["capture_failed_mcp_calls", "Keep failed agent calls for diagnosis"],
];

function isValid(value: number | boolean) {
  return typeof value === "boolean" || (Number.isInteger(value) && value >= 1);
}

// The mark in the corner is the board's menu: the few settings there are live behind it, off the bar.
export function BoardMenu({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <span ref={root} className="relative">
      <button aria-expanded={open} aria-label="S++ settings" className={`group -ml-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-sm font-semibold tracking-tight hover:bg-line ${open ? "bg-line" : ""}`} title="Settings" type="button" onClick={() => setOpen(!open)}>
        S++
        <ChevronDown className={`size-3 transition-colors group-hover:text-ink ${open ? "text-ink" : "text-faint"}`} />
      </button>
      {open ? <Panel settings={settings} onSaved={onSaved} /> : null}
    </span>
  );
}

function Panel({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // After a save the draft stays until the board has read the new settings, so the fields never jump back.
  const [saved, setSaved] = useState(false);
  const changed = Object.entries(draft).filter(([key, value]) => value !== settings[key as Key]);
  const set = (key: Key, value: number | boolean) => {
    setSaved(false);
    setDraft({ ...draft, [key]: value });
  };

  const save = async () => {
    setBusy(true);
    setFailure(null);
    const response = await fetch(api("/settings"), { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(changed)) }).catch(() => null);
    setBusy(false);
    if (response?.ok) {
      setSaved(true);
      return onSaved();
    }
    const payload = (await response?.json().catch(() => null)) as { error?: { message?: string } } | null;
    setFailure(payload?.error?.message || "Could not save the settings.");
  };

  return (
    <div className="absolute left-0 top-full z-30 mt-2 w-[26rem] rounded border border-line bg-bg p-4 text-sm font-normal shadow-xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Leaving the board</p>
      {DAYS.filter(([key]) => typeof settings[key] === "number").map(([key, label]) => (
        <label key={key} className="mt-2 flex items-center justify-between gap-3">
          <span className="text-ink">{label}</span>
          <span className="flex shrink-0 items-center gap-1.5 text-dim">
            <DaysInput value={(draft[key] ?? settings[key]) as number} onChange={(value) => set(key, value)} />
            days
          </span>
        </label>
      ))}
      <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">This machine</p>
      {SWITCHES.filter(([key]) => typeof settings[key] === "boolean").map(([key, label]) => (
        <label key={key} className="mt-2 flex items-center gap-2.5 text-ink">
          <input checked={(draft[key] ?? settings[key]) as boolean} className="size-3.5 accent-current" type="checkbox" onChange={(event) => set(key, event.target.checked)} />
          {label}
        </label>
      ))}
      {changed.length > 0 && saved ? <p className="mt-4 border-t border-line pt-3 text-xs text-merge">Saved.</p> : null}
      {changed.length > 0 && !saved ? (
        <div className="mt-4 flex items-center gap-3 border-t border-line pt-3">
          <p className="min-w-0 flex-1 text-xs text-dim">{failure ? <span className="text-fail">{failure}</span> : "Applies when saved: anything already past a new limit goes right away."}</p>
          <button className="rounded px-2 py-1 text-xs text-dim hover:bg-line hover:text-ink" type="button" onClick={() => setDraft({})}>Reset</button>
          <button className="rounded bg-ink px-2.5 py-1 text-xs font-medium text-bg disabled:opacity-40" disabled={busy || !changed.every(([, value]) => isValid(value))} type="button" onClick={() => void save()}>Save</button>
        </div>
      ) : null}
    </div>
  );
}

// An emptied field is not a number yet: it shows empty and cannot be saved.
function DaysInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <input className="w-14 rounded border border-line bg-transparent px-1.5 py-0.5 text-right font-mono text-ink" inputMode="numeric" min={1} type="number" value={Number.isNaN(value) ? "" : value} onChange={(event) => onChange(event.target.value === "" ? NaN : Number(event.target.value))} />;
}
