import { useEffect, useState } from "react";

import { areaLabel } from "./areas";
import { span, type GoalView } from "./model";

const LOGO = "/splusplus-logo.png";
const ICON = 64;
const YOU = "#ff7a45";

// The first question, answered in one corner: am I needed? The dot sits at the edge and the tab icon repeats it.
export function Status({ views }: { views: GoalView[] }) {
  const needed = views.filter((view) => view.ask).length;
  const moving = views.reduce((sum, view) => sum + view.live.length, 0);
  const goals = views.filter((view) => view.state === "live").length;

  return (
    <span className="flex shrink-0 items-center gap-3 text-sm">
      <span className="hidden text-xs text-faint min-[1440px]:inline">
        {moving} moving across {goals} {goals === 1 ? "goal" : "goals"}
      </span>
      <span className={needed > 0 ? "font-semibold text-you" : "text-dim"}>{needed > 0 ? `You are needed in ${needed}` : "You are not needed"}</span>
      <span className={`size-2 rounded-full ${needed > 0 ? "animate-pulse bg-you" : "bg-merge"}`} />
    </span>
  );
}

// Shown only while someone is waiting on the operator: each ask takes you to its goal.
export function Asks({ at, onPick, views }: { at: number; onPick: (goalId: string) => void; views: GoalView[] }) {
  const asks = views.filter((view) => view.ask);
  if (asks.length === 0) return null;

  return (
    <div className="flex h-10 items-center gap-1 text-sm">
      {asks.map((view) => (
        <button key={view.goal.id} className="min-w-0 truncate rounded px-2 py-1 text-left text-dim hover:bg-line hover:text-ink" title="Take me to this goal" type="button" onClick={() => onPick(view.goal.id)}>
          <span className="text-you">{areaLabel(view.goal.area.slice(-1))}</span>: {view.ask!.title} <span className="text-faint">({span(at - view.ask!.from)})</span>
        </button>
      ))}
    </div>
  );
}

// Readable from a background tab: the count in the title, and a small orange dot on the icon while needed.
export function useTabSignal(needed: number) {
  const logo = useLogo();

  useEffect(() => {
    document.title = needed > 0 ? `(${needed}) Symphony++` : "Symphony++";
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon && logo) icon.href = tabIcon(logo, needed > 0);
  }, [logo, needed]);
}

function useLogo() {
  const [logo, setLogo] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    const image = new Image();
    image.onload = () => setLogo(image);
    image.src = LOGO;
  }, []);
  return logo;
}

// The logo on a rounded tile, cropped a little so the mark fills the tab icon.
function tabIcon(logo: HTMLImageElement, needed: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = ICON;
  canvas.height = ICON;
  const pen = canvas.getContext("2d");
  if (!pen) return LOGO;

  const crop = logo.naturalWidth * 0.06;
  pen.save();
  pen.beginPath();
  pen.roundRect(0, 0, ICON, ICON, ICON * 0.24);
  pen.clip();
  pen.drawImage(logo, crop, crop, logo.naturalWidth - 2 * crop, logo.naturalHeight - 2 * crop, 0, 0, ICON, ICON);
  pen.restore();
  if (needed) drawDot(pen);
  return canvas.toDataURL("image/png");
}

// A dot in the corner with a clear ring around it, so it reads on any tab colour.
function drawDot(pen: CanvasRenderingContext2D) {
  const center = ICON - 12;
  pen.globalCompositeOperation = "destination-out";
  pen.beginPath();
  pen.arc(center, center, 15, 0, Math.PI * 2);
  pen.fill();
  pen.globalCompositeOperation = "source-over";
  pen.fillStyle = YOU;
  pen.beginPath();
  pen.arc(center, center, 11, 0, Math.PI * 2);
  pen.fill();
}
