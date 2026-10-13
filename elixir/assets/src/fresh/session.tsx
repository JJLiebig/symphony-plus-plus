import { Laptop, Monitor, Server, SquareTerminal, type LucideIcon } from "lucide-react";

import { api } from "./api";
import { span, type Goal, type PkgView, type Place } from "./model";

const KIND: Record<string, { kind: string; icon: LucideIcon }> = { desktop: { kind: "Desktop", icon: Monitor }, laptop: { kind: "Laptop", icon: Laptop }, server: { kind: "Server", icon: Server } };
const SAMPLE_MACHINES = [["desktop-1", "desktop"], ["desktop-1", "desktop"], ["desktop-1", "desktop"], ["laptop-1", "laptop"], ["vps-1", "server"]];

// Sketch only: a session from a snapshot's recorded history, or on a sample goal, gets a made-up address.
// One in seven is outside Herdr, described in the agent's own words.
function samplePlace(at: number, id: string, area: string[], goalTitle: string, role: string): Place {
  const hash = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const [machine, kind] = SAMPLE_MACHINES[hash % SAMPLE_MACHINES.length];
  const space = (area.at(-1) ?? "work").split(/[ &]/)[0].toLowerCase();
  const tab = goalTitle.split(/\s+/).slice(0, 2).join(" ").toLowerCase();
  const where = hash % 7 === 0 ? { herdr: null, said: `Terminal window: ${tab}` } : { herdr: `${space} › ${tab}`, said: null };
  return { machine, kind, ...where, role, seenAt: at - (hash % 9) * 60000, sample: true };
}

function addressOf(place: Place) {
  return [place.machine, place.herdr ?? place.said].filter(Boolean).join(" › ");
}

// Shows a short note at the foot of the board.
function say(note: string) {
  window.dispatchEvent(new CustomEvent("fresh:say", { detail: note }));
}

// Why a session could not be brought to the front, by the backend's reason.
function whyNot(reason: string | null | undefined, place: Place | null) {
  const told: Record<string, string> = {
    session_gone: "That session has ended, or it never said where it is.",
    not_in_herdr: place?.said ? `That session does not run in Herdr. It said: “${place.said}”.` : "That session does not run in Herdr, so it cannot be opened from here.",
    other_machine: `That session is on ${place?.machine ?? "another machine"}. Open Herdr there.`,
    herdr_unreachable: "Herdr did not answer. Is it running on this machine?",
    identity_mismatch: "Could not tell which pane that session is in, so nothing was opened.",
  };
  return told[reason ?? ""] ?? "Could not open that session.";
}

type Answer = { status?: string; reason?: string | null; error?: string | { message?: string } };

function sampleNote(place: Place) {
  return `Sample address. ${place.herdr ? `On a live board this opens ${addressOf(place)} in Herdr.` : whyNot("not_in_herdr", place)}`;
}

// Brings the session's pane to the front in Herdr and says what happened. It sends the agent nothing.
async function open(path: string, place: Place | null) {
  if (place?.sample) return say(sampleNote(place));
  say("Looking for the session…");
  const response = await fetch(api(`/${path}/focus`), { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: "{}" }).catch(() => null);
  const answer = ((await response?.json().catch(() => null)) ?? {}) as Answer;
  if (!response?.ok) return say((typeof answer.error === "string" ? answer.error : answer.error?.message) || "Could not reach the backend to open that session.");
  say(answer.status === "focused" ? `Herdr is now on ${place ? addressOf(place) : "that session"}.` : whyNot(answer.reason, place));
}

// Where a session was last seen. It opens on hover and on keyboard focus of the `group` button it sits in.
function PlaceCard({ at, place, thread }: { at: number; place: Place; thread?: string | null }) {
  const rows = [
    [KIND[place.kind ?? ""]?.kind ?? "Machine", place.machine],
    ["Herdr", place.herdr],
    ["Where", place.said],
    ["Session", place.role],
    ["Thread", thread],
    ["Last seen", place.seenAt === null ? null : `${span(at - place.seenAt)} ago`],
  ].filter((row): row is string[] => Boolean(row[1]));

  return (
    <span className="pointer-events-none absolute right-0 top-full z-30 mt-1 hidden w-72 rounded border border-line bg-bg p-2.5 text-left text-xs font-normal shadow-xl group-hover:block group-focus-visible:block">
      {rows.map(([label, value]) => (
        <span key={label} className="flex justify-between gap-3 py-0.5">
          <span className="shrink-0 text-faint">{label}</span>
          <span className="truncate text-ink">{value}</span>
        </span>
      ))}
      {place.herdr ? <span className="mt-1.5 block border-t border-line pt-1.5 text-faint">Click to open it in Herdr</span> : null}
    </span>
  );
}

function PlaceIcon({ place }: { place: Place }) {
  const Icon = KIND[place.kind ?? ""]?.icon ?? SquareTerminal;
  return <Icon className="size-3.5" />;
}

// Where a package's session is: only the machine icon on the line, the full address on hover, the session itself on click.
export function Session({ at, view }: { at: number; view: PkgView }) {
  const place = view.pkg.location ?? (view.actor ? samplePlace(at, view.pkg.id, view.pkg.area, view.pkg.goalTitle, "worker") : null);
  if (!place) return <span />;

  return (
    <button aria-label={`Session for ${view.pkg.title}`} className="group relative flex size-6 items-center justify-center rounded text-dim hover:bg-line hover:text-ink" type="button" onClick={() => void open(`work-packages/${encodeURIComponent(view.pkg.id)}`, place)}>
      <PlaceIcon place={place} />
      <PlaceCard at={at} place={place} thread={view.actor} />
    </button>
  );
}

// A sample goal, and a snapshot goal with recorded sessions, get a made-up address for the architect as their packages do.
function architectPlace(at: number, goal: Goal) {
  if (goal.architect) return goal.architect;
  const sketched = goal.mock || goal.pkgs.some((pkg) => pkg.actors.length > 0);
  return sketched ? samplePlace(at, `${goal.id}:architect`, goal.area, goal.title, "architect") : null;
}

// The way to the architect's session, with the same card as a package's session. On a goal's header it is
// only the machine icon, and leaves a gap while the address is unknown; on an ask it is spelled out.
export function FindArchitect({ at, className = "", compact, goal }: { at: number; className?: string; compact?: boolean; goal: Goal }) {
  const place = architectPlace(at, goal);
  if (compact && !place) return <span className={`size-6 shrink-0 ${className}`} />;
  const shape = compact ? "size-6 justify-center" : "gap-1.5 self-center px-1.5 py-0.5";
  // The spoken name starts with the words on the button, where it has words.
  const name = compact ? `Architect's session for ${goal.title}` : `Find the architect for ${goal.title}`;

  return (
    <button aria-label={name} className={`group relative flex shrink-0 items-center rounded text-xs text-dim hover:bg-line hover:text-ink ${shape} ${className}`} type="button" onClick={() => void open(`work-requests/${encodeURIComponent(goal.id)}`, place)}>
      {place ? <PlaceIcon place={place} /> : null}
      {compact ? null : "Find the architect"}
      {place ? <PlaceCard at={at} place={place} /> : null}
    </button>
  );
}
