import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { ReloadContext } from "./actions";
import { api } from "./api";
import { setAreas, type AreaRule } from "./areas";
import { lanesOf } from "./board";
import { Briefing } from "./briefing";
import { mockGoals } from "./mock";
import { buildGoals, liveCountAt, viewAt, type Goal, type HistoryEvent, type Hydrated, type Settings } from "./model";
import { focusGoal, smoothly } from "./motion";
import { Outline } from "./outline";
import { Phases } from "./phases";
import { DensityContext, type Density } from "./report";
import { setSamples, type SampleRule } from "./samples";
import { BoardMenu } from "./settings";
import { changesBetween, SinceContext, SinceLine } from "./since";
import { Asks, Status, useTabSignal } from "./status";

const DIRECTIONS = [
  { key: "outline", label: "Outline", hint: "Goals that open themselves", view: Outline, width: "max-w-[1280px]" },
  { key: "briefing", label: "Briefing", hint: "Each goal reports in", view: Briefing, width: "max-w-[1080px]" },
  { key: "phases", label: "Phases", hint: "Where each goal is on its route", view: Phases, width: "max-w-[1280px]" },
] as const;
const DENSITIES: Array<{ key: Density; label: string; hint: string }> = [
  { key: "closed", label: "Collapsed", hint: "Headlines only" },
  { key: "attention", label: "Attention", hint: "Open only the goals with a road bump or a question for you" },
  { key: "active", label: "Active", hint: "Every goal shows what is moving now" },
  { key: "open", label: "Expanded", hint: "Every goal shows done, now and up next" },
];
const REPLAY_DAYS = 10;
const STEP_MS = 15 * 60 * 1000;
// A frozen snapshot never changes, so there the sketch pretends the last visit was three hours ago.
const AWAY_MS = 3 * 3600e3;
const SEEN_KEY = "sympp.board.seenAt";
const REREAD_MS = 60e3;

// `replayable` is true on a snapshot, which carries recorded history; a backend only knows the present.
type Loaded = { goals: Goal[]; now: number; busiest: number; samples: number[]; replayable: boolean; settings: Settings };

export function App() {
  const [data, setData] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [direction, setDirection] = useState(0);
  const [area, setArea] = useState<string | null>(null);
  const [density, setDensity] = useState<Density>("active");
  const [at, setAt] = useState(0);
  const [seenAt, setSeenAt] = useState<number | null>(rememberedVisit);
  const [replay, setReplay] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const shownNow = useRef<number | null>(null);
  // The first read opens on the busiest moment; later reads keep the board live unless it is replaying.
  // Reads can overlap (the timer, a change signal, an action), so only the latest one started is shown.
  const reads = useRef(0);
  const read = useCallback(() => {
    const turn = ++reads.current;
    void load().then((loaded) => {
      if (turn !== reads.current) return;
      const before = shownNow.current;
      shownNow.current = loaded.now;
      setFailure(null);
      setData(loaded);
      setAt((current) => (before === null ? loaded.busiest : followNow(current, before, loaded.now)));
    }, (caught: unknown) => {
      if (turn === reads.current) setFailure(caught instanceof Error ? caught.message : "Could not read the ledger");
    });
  }, []);
  useEffect(read, [read]);
  useChangeSignal(read);
  // A snapshot never changes, so it is read once. Anything else is reread, also while the first read has yet to succeed.
  useReread(data?.replayable !== true, read);
  useShortcuts(setDirection, setNote);

  const since = lastLookAt(seenAt, at, data?.replayable !== false);
  const markSeen = () => {
    rememberVisit(at);
    smoothly(() => setSeenAt(at));
  };
  // An ask can sit in an area that is filtered out, so the filter is lifted before jumping to its goal.
  const goToGoal = (goalId: string) => {
    flushSync(() => setArea(null));
    focusGoal(goalId);
  };
  const views = useMemo(() => (data ? viewAt(data.goals, at) : []), [at, data]);
  const changes = useMemo(() => changesBetween(data ? viewAt(data.goals, since) : [], views, since, at), [at, data, since, views]);
  const areas = useMemo(() => [...new Set(views.filter((view) => view.state !== "settled").map((view) => view.goal.area[0]))], [views]);
  const shown = area ? views.filter((view) => view.goal.area[0] === area) : views;
  // Phases has nothing to add until a goal on the board is grouped, so it is offered only then.
  const grouped = useMemo(() => lanesOf(views, at).main.some((view) => view.goal.groups.length > 0), [at, views]);
  const directions = DIRECTIONS.filter((entry) => entry.key !== "phases" || grouped);
  const current = directions[direction] ?? directions[0];
  const View = current.view;
  useTabSignal(views.filter((view) => view.ask).length);

  if (!data) return <Unread failure={failure} />;

  return (
    <div className={`min-h-screen ${replay ? "pb-28" : "pb-10"}`}>
      <header className="pin-top sticky top-0 z-20 border-b border-line bg-bg/95 px-8 backdrop-blur">
        <div className="flex h-12 items-center gap-6">
          <BoardMenu settings={data.settings} onSaved={read} />
          <nav className="flex shrink-0 gap-1">
            {directions.map((entry, index) => (
              <button key={entry.key} className={`rounded px-2.5 py-1 text-xs ${entry.key === current.key ? "bg-ink text-bg" : "text-dim hover:text-ink"}`} title={entry.hint} type="button" onClick={() => smoothly(() => setDirection(index))}>
                <span className="mr-1.5 font-mono opacity-60">{index + 1}</span>
                {entry.label}
              </button>
            ))}
          </nav>
          <nav className="flex min-w-0 gap-1 overflow-hidden whitespace-nowrap text-xs">
            {[null, ...areas].map((name) => (
              <button key={name ?? "all"} className={`rounded px-2 py-1 ${name === area ? "bg-line text-ink" : "text-dim hover:text-ink"}`} type="button" onClick={() => smoothly(() => setArea(name))}>
                {name ?? "Everything"}
              </button>
            ))}
          </nav>
          <nav className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-xs">
            <span className="mr-1 text-faint">Show</span>
            {DENSITIES.map((entry) => (
              <button key={entry.key} className={`rounded px-2 py-1 ${entry.key === density ? "bg-line text-ink" : "text-dim hover:text-ink"}`} title={entry.hint} type="button" onClick={() => smoothly(() => setDensity(entry.key))}>
                {entry.label}
              </button>
            ))}
          </nav>
          <span className="ml-auto flex shrink-0 items-center gap-4">
            {data.replayable ? (
              <button className={`whitespace-nowrap rounded px-2 py-1 font-mono text-[11px] hover:bg-line ${at >= data.now ? "text-faint" : "text-checks"}`} title={`Show or hide the replay bar. Showing ${stamp(at)}`} type="button" onClick={() => setReplay(!replay)}>
                Replay
              </button>
            ) : null}
            <Lost failure={failure} />
            <Status views={views} />
          </span>
        </div>
        <Asks at={at} views={views} onPick={goToGoal} />
      </header>
      <main className="px-8 py-6">
        <SinceLine at={at} changes={changes} since={since} width={current.width} onPick={goToGoal} onSeen={markSeen} />
        <ReloadContext.Provider value={read}>
          <SinceContext.Provider value={changes.notes}>
            <DensityContext.Provider value={density}>
              <View at={at} views={shown} />
            </DensityContext.Provider>
          </SinceContext.Provider>
        </ReloadContext.Provider>
      </main>
      {replay ? <Scrubber at={at} data={data} onChange={setAt} /> : null}
      {note ? <p className="fixed bottom-24 left-1/2 z-30 max-w-xl -translate-x-1/2 rounded bg-ink px-3 py-2 text-sm text-bg" role="status">{note}</p> : null}
    </div>
  );
}

// A board that has never loaded shows only that it is reading, or why it could not.
function Unread({ failure }: { failure: string | null }) {
  return <p className={`p-10 text-sm ${failure ? "text-fail" : "text-dim"}`}>{failure ?? "Reading the ledger…"}</p>;
}

// A failed read keeps what the board last showed and says so.
function Lost({ failure }: { failure: string | null }) {
  if (!failure) return null;
  return <span className="whitespace-nowrap text-xs text-fail" title={failure}>Connection lost · showing the last read</span>;
}

async function load(): Promise<Loaded> {
  const [hydrated, history, local] = await Promise.all([
    ledger(),
    sketchOnly<Record<string, HistoryEvent[]>>("/__snapshot/history"),
    sketchOnly<{ areas?: AreaRule[]; samples?: SampleRule[] }>("/__snapshot/local"),
  ]);
  setAreas(local?.areas ?? []);
  setSamples(local?.samples ?? []);
  const { goals: real, now } = buildGoals(hydrated, history ?? {});
  // Against a backend there is no history to replay and nothing is invented: the board shows the present.
  const settings = hydrated.settings ?? {};
  if (!history) return { goals: real, now, busiest: now, samples: [], replayable: false, settings };

  const start = now - REPLAY_DAYS * 24 * 3600e3;
  const sample = (goals: Goal[]) => Array.from({ length: (now - start) / STEP_MS + 1 }, (_unused, index) => liveCountAt(goals, start + index * STEP_MS));
  const realSamples = sample(real);
  const busiest = start + realSamples.indexOf(Math.max(...realSamples)) * STEP_MS;
  const goals = [...real, ...mockGoals(busiest, now)];
  return { goals, now, busiest, samples: sample(goals), replayable: true, settings };
}

// A refused or failed read is an error, not an empty ledger.
async function ledger(): Promise<Hydrated> {
  const response = await fetch(api("/dashboard/hydrated"), { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Could not read the ledger (${response.status})`);
  return (await response.json()) as Hydrated;
}

// These routes exist on the snapshot server only, so only a development server is asked.
async function sketchOnly<T>(path: string): Promise<T | null> {
  if (!import.meta.env.DEV) return null;
  const response = await fetch(path).catch(() => null);
  if (!response?.ok || !response.headers.get("content-type")?.includes("json")) return null;
  return (await response.json()) as T;
}

// The last visit is remembered in this browser only; a private window or cleared data starts over.
function rememberedVisit(): number | null {
  try {
    return Number(window.localStorage.getItem(SEEN_KEY)) || null;
  } catch {
    return null;
  }
}

function rememberVisit(at: number) {
  try {
    window.localStorage.setItem(SEEN_KEY, String(at));
  } catch {
    // Without storage the board still works; it only forgets the visit on reload.
  }
}

function lastLookAt(seenAt: number | null, at: number, replayable: boolean) {
  if (seenAt !== null && seenAt <= at) return seenAt;
  return replayable ? at - AWAY_MS : at;
}

// Against a backend the board also rereads once a minute, so the time each package has spent keeps moving.
function useReread(active: boolean, read: () => void) {
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(read, REREAD_MS);
    return () => window.clearInterval(timer);
  }, [active, read]);
}

function followNow(current: number, before: number, now: number) {
  return current >= before ? now : current;
}

// The backend only says that something changed; the board then reads everything again.
// This stream is also how the backend knows a board is open, so that it does not open another one.
function useChangeSignal(read: () => void) {
  useEffect(() => {
    const stream = new EventSource(api("/dashboard/events"));
    let connected = false;
    // The stream also opens after a reconnect, when changes may have been missed.
    const onOpen = () => {
      if (connected) read();
      connected = true;
    };
    stream.addEventListener("open", onOpen);
    stream.addEventListener("dashboard_changed", read);
    return () => stream.close();
  }, [read]);
}

function stamp(at: number) {
  return new Date(at).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// A sketch tool, not part of the product: move through the ledger's history to watch the board change.
function Scrubber({ at, data, onChange }: { at: number; data: Loaded; onChange: (at: number) => void }) {
  const start = data.now - REPLAY_DAYS * 24 * 3600e3;
  const peak = Math.max(1, ...data.samples);
  const path = data.samples.map((value, index) => `${index === 0 ? "M" : "L"}${(index / (data.samples.length - 1)) * 100},${24 - (value / peak) * 22}`).join(" ");
  const live = at >= data.now;

  return (
    <footer className="pin-bottom fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg/95 px-8 py-3 backdrop-blur">
      <div className="flex items-center gap-4 text-xs">
        <span className={`w-64 shrink-0 font-mono ${live ? "text-merge" : "text-checks"}`}>
          {live ? "Now" : "Replaying"} · {stamp(at)}
        </span>
        <div className="relative h-8 flex-1">
          <svg className="absolute inset-0 size-full text-faint" preserveAspectRatio="none" viewBox="0 0 100 24">
            <path d={path} fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
          <input aria-label="Replay time" className="absolute inset-0 w-full cursor-pointer opacity-80" max={data.now} min={start} step={STEP_MS} type="range" value={at} onChange={(event) => onChange(Number(event.target.value))} />
        </div>
        <button className="rounded px-2 py-1 text-dim hover:bg-line hover:text-ink" type="button" onClick={() => onChange(data.busiest)}>Busiest</button>
        <button className="rounded px-2 py-1 text-dim hover:bg-line hover:text-ink" type="button" onClick={() => onChange(data.now)}>Now</button>
      </div>
    </footer>
  );
}

function useShortcuts(setDirection: (index: number) => void, setNote: (note: string | null) => void) {
  useEffect(() => {
    let timer = 0;
    const onKey = (event: KeyboardEvent) => {
      const index = ["1", "2", "3"].indexOf(event.key);
      if (index >= 0 && !(event.target instanceof HTMLInputElement)) smoothly(() => setDirection(index));
    };
    const onSay = (event: Event) => {
      setNote((event as CustomEvent<string>).detail);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setNote(null), 6000);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("fresh:say", onSay);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("fresh:say", onSay);
    };
  }, [setDirection, setNote]);
}
