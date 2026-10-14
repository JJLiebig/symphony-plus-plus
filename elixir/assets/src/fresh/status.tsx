import { useEffect } from "react";

import { asset } from "./api";
import iconNeeded from "./board-icon-needed.png";
import iconQuiet from "./board-icon.png";
import { span, type GoalView } from "./model";

// The first question, answered in one corner: am I needed? The dot sits at the edge and the tab icon repeats it.
export function Status({ views }: { views: GoalView[] }) {
  const needed = views.filter((view) => view.ask).length;
  return (
    <span className="flex shrink-0 items-center gap-3 text-sm">
      <span className="hidden text-xs text-faint min-[1440px]:inline">{overview(views)}</span>
      <span className={needed > 0 ? "font-semibold text-you" : "text-dim"}>{needed > 0 ? `You are needed in ${needed}` : "You are not needed"}</span>
      <span className={`size-2 rounded-full ${needed > 0 ? "animate-pulse bg-you" : "bg-merge"}`} />
    </span>
  );
}

// Planned goals count too, so a board with work waiting never reads as empty.
function overview(views: GoalView[]) {
  const moving = views.reduce((sum, view) => sum + view.live.length, 0);
  const goals = views.filter((view) => view.state === "live").length;
  const waiting = views.filter((view) => view.state === "resting" && view.done.length === 0).length;
  const now = moving > 0 ? `${moving} moving across ${goals} ${goals === 1 ? "goal" : "goals"}` : "Nothing moving";
  if (waiting > 0) return `${now} · ${waiting} not started`;
  return moving > 0 || views.some((view) => view.state !== "settled") ? now : "No open goals";
}

// Shown only while someone is waiting on the operator: each ask takes you to its goal.
export function Asks({ at, onPick, views }: { at: number; onPick: (goalId: string) => void; views: GoalView[] }) {
  const asks = views.filter((view) => view.ask);
  if (asks.length === 0) return null;

  return (
    <div className="flex h-10 items-center gap-1 text-sm">
      {asks.map((view) => (
        <button key={view.goal.id} className="min-w-0 truncate rounded px-2 py-1 text-left text-dim hover:bg-line hover:text-ink" title="Take me to this goal" type="button" onClick={() => onPick(view.goal.id)}>
          <span className="text-you">{view.goal.area[0]}</span>
          <span className="text-ink">/{view.goal.repo.split("/").pop()}</span>: {view.ask!.title} <span className="text-faint">({span(at - view.ask!.from)})</span>
        </button>
      ))}
    </div>
  );
}

// Readable from a background tab: the count in the title, and a small orange dot on the icon while needed.
export function useTabSignal(needed: number) {
  useEffect(() => {
    document.title = needed > 0 ? `(${needed}) Symphony++` : "Symphony++";
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) icon.href = asset(needed > 0 ? iconNeeded : iconQuiet);
  }, [needed]);
}
