import { useEffect, useMemo, useState } from "react";

import { areaLabel, setAreas, type AreaRule } from "./areas";
import { Briefing } from "./briefing";
import { mockGoals } from "./mock";
import { buildGoals, liveCountAt, span, viewAt, type Goal, type GoalView, type HistoryEvent, type Hydrated } from "./model";
import { focusGoal, smoothly } from "./motion";
import { Outline } from "./outline";
import { Phases } from "./phases";
import { DensityContext, type Density } from "./report";
import { setSamples, type SampleRule } from "./samples";
import { changesBetween, SinceContext, SinceLine } from "./since";

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
// Stand-in for the browser remembering the last visit: the sketch pretends it was three hours ago.
const AWAY_MS = 3 * 3600e3;
const NEEDED_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='12' fill='%23ff7a45'/%3E%3C/svg%3E";

type Loaded = { goals: Goal[]; now: number; busiest: number; samples: number[] };

export function App() {
  const [data, setData] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [direction, setDirection] = useState(0);
  const [area, setArea] = useState<string | null>(null);
  const [density, setDensity] = useState<Density>("active");
  const [at, setAt] = useState(0);
  const [seenAt, setSeenAt] = useState<number | null>(null);
  const [replay, setReplay] = useState(false);
  const [located, setLocated] = useState<string | null>(null);

  useEffect(() => {
    void load().then((loaded) => {
      setData(loaded);
      setAt(loaded.busiest);
    }, (caught: unknown) => setFailure(caught instanceof Error ? caught.message : "Could not read the ledger"));
  }, []);
  useShortcuts(setDirection, setLocated);

  const since = seenAt !== null && seenAt <= at ? seenAt : at - AWAY_MS;
  const views = useMemo(() => (data ? viewAt(data.goals, at) : []), [at, data]);
  const changes = useMemo(() => changesBetween(data ? viewAt(data.goals, since) : [], views, since, at), [at, data, since, views]);
  const areas = useMemo(() => [...new Set(views.filter((view) => view.state !== "settled").map((view) => view.goal.area[0]))], [views]);
  const shown = area ? views.filter((view) => view.goal.area[0] === area) : views;
  const View = DIRECTIONS[direction].view;
  useTabSignal(views.filter((view) => view.ask).length);

  if (failure) return <p className="p-10 text-sm text-fail">{failure}</p>;
  if (!data) return <p className="p-10 text-sm text-dim">Reading the ledger…</p>;

  return (
    <div className={`min-h-screen ${replay ? "pb-28" : "pb-10"}`}>
      <header className="pin-top sticky top-0 z-20 border-b border-line bg-bg/95 px-8 backdrop-blur">
        <div className="flex h-12 items-center gap-6">
          <span className="text-sm font-semibold tracking-tight">S++</span>
          <nav className="flex gap-1">
            {DIRECTIONS.map((entry, index) => (
              <button key={entry.key} className={`rounded px-2.5 py-1 text-xs ${index === direction ? "bg-ink text-bg" : "text-dim hover:text-ink"}`} title={entry.hint} type="button" onClick={() => smoothly(() => setDirection(index))}>
                <span className="mr-1.5 font-mono opacity-60">{index + 1}</span>
                {entry.label}
              </button>
            ))}
          </nav>
          <nav className="flex gap-1 text-xs">
            {[null, ...areas].map((name) => (
              <button key={name ?? "all"} className={`rounded px-2 py-1 ${name === area ? "bg-line text-ink" : "text-dim hover:text-ink"}`} type="button" onClick={() => smoothly(() => setArea(name))}>
                {name ?? "Everything"}
              </button>
            ))}
          </nav>
          <nav className="flex items-center gap-1 text-xs">
            <span className="mr-1 text-faint">Show</span>
            {DENSITIES.map((entry) => (
              <button key={entry.key} className={`rounded px-2 py-1 ${entry.key === density ? "bg-line text-ink" : "text-dim hover:text-ink"}`} title={entry.hint} type="button" onClick={() => smoothly(() => setDensity(entry.key))}>
                {entry.label}
              </button>
            ))}
          </nav>
          <button className={`ml-auto rounded px-2 py-1 font-mono text-[11px] hover:bg-line ${at >= data.now ? "text-merge" : "text-checks"}`} title="Show or hide the replay bar" type="button" onClick={() => setReplay(!replay)}>
            {at >= data.now ? "Live" : `Replay · ${stamp(at)}`}
          </button>
          <Legend />
        </div>
        <NeedsYou at={at} views={shown} />
      </header>
      <main className="px-8 py-6">
        <SinceLine at={at} changes={changes} since={since} width={DIRECTIONS[direction].width} onSeen={() => smoothly(() => setSeenAt(at))} />
        <SinceContext.Provider value={changes.notes}>
          <DensityContext.Provider value={density}>
            <View at={at} views={shown} />
          </DensityContext.Provider>
        </SinceContext.Provider>
      </main>
      {replay ? <Scrubber at={at} data={data} onChange={setAt} /> : null}
      {located ? <p className="fixed bottom-24 left-1/2 z-30 -translate-x-1/2 rounded bg-ink px-3 py-2 text-sm text-bg">Would jump to the Herdr pane running “{located}”.</p> : null}
    </div>
  );
}

async function load(): Promise<Loaded> {
  const [hydrated, history, local] = await Promise.all([
    fetch("/api/v1/sympp/operator/dashboard/hydrated", { headers: { accept: "application/json" } }).then((response) => response.json() as Promise<Hydrated>),
    fetch("/__snapshot/history").then((response) => response.json() as Promise<Record<string, HistoryEvent[]>>),
    fetch("/__snapshot/local").then((response) => response.json() as Promise<{ areas?: AreaRule[]; samples?: SampleRule[] }>),
  ]);
  setAreas(local.areas ?? []);
  setSamples(local.samples ?? []);
  const { goals: real, now } = buildGoals(hydrated, history);
  const start = now - REPLAY_DAYS * 24 * 3600e3;
  const sample = (goals: Goal[]) => Array.from({ length: (now - start) / STEP_MS + 1 }, (_unused, index) => liveCountAt(goals, start + index * STEP_MS));
  const realSamples = sample(real);
  const busiest = start + realSamples.indexOf(Math.max(...realSamples)) * STEP_MS;
  const goals = [...real, ...mockGoals(busiest, now)];
  return { goals, now, busiest, samples: sample(goals) };
}

function stamp(at: number) {
  return new Date(at).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// The first thing on screen answers the first question: am I needed? Each ask takes you to its goal.
function NeedsYou({ at, views }: { at: number; views: GoalView[] }) {
  const asks = views.filter((view) => view.ask);
  const moving = views.reduce((sum, view) => sum + view.live.length, 0);
  const summary = `${moving} moving across ${views.filter((view) => view.state === "live").length} goals`;

  if (asks.length === 0) {
    return <p className="flex h-[52px] items-center gap-3 text-sm text-dim"><span className="size-2 rounded-full bg-merge" />You are not needed. {summary}.</p>;
  }
  return (
    <div className="flex h-[52px] items-center gap-3 text-sm">
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-you" />
      <span className="shrink-0 font-semibold text-you">You are needed in {asks.length}</span>
      <span className="flex min-w-0 gap-1">
        {asks.map((view) => (
          <button key={view.goal.id} className="min-w-0 truncate rounded px-2 py-1 text-left text-dim hover:bg-line hover:text-ink" title="Take me to this goal" type="button" onClick={() => focusGoal(view.goal.id)}>
            <span className="text-ink">{areaLabel(view.goal.area.slice(-1))}</span>: {view.ask!.title} <span className="text-faint">({span(at - view.ask!.from)})</span>
          </button>
        ))}
      </span>
      <span className="ml-auto shrink-0 text-xs text-faint">{summary}</span>
    </div>
  );
}

function Legend() {
  return (
    <span className="flex items-center gap-3 font-mono text-[11px] text-dim">
      <span className="text-build">Build</span>
      <span className="text-checks">Checks</span>
      <span className="text-review">Review</span>
      <span className="text-merge">Merge</span>
      <span className="text-you">You</span>
    </span>
  );
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

// Readable from a background tab: the count in the title and an orange dot as the icon.
function useTabSignal(needed: number) {
  useEffect(() => {
    document.title = needed > 0 ? `(${needed}) Symphony++` : "Symphony++";
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) return;
    icon.type = needed > 0 ? "image/svg+xml" : "image/png";
    icon.href = needed > 0 ? NEEDED_ICON : "/splusplus-logo.png";
  }, [needed]);
}

function useShortcuts(setDirection: (index: number) => void, setLocated: (actor: string | null) => void) {
  useEffect(() => {
    let timer = 0;
    const onKey = (event: KeyboardEvent) => {
      const index = ["1", "2", "3"].indexOf(event.key);
      if (index >= 0 && !(event.target instanceof HTMLInputElement)) smoothly(() => setDirection(index));
    };
    const onLocate = (event: Event) => {
      setLocated((event as CustomEvent<string>).detail);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setLocated(null), 2500);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("fresh:locate", onLocate);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("fresh:locate", onLocate);
    };
  }, [setDirection, setLocated]);
}
