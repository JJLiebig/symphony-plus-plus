// Motion has one job here: make a change noticeable. Nothing moves unless something changed.
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";

export const POP: Keyframe[] = [{ transform: "scale(2.6)", filter: "brightness(1.6)" }, { transform: "scale(1)", filter: "brightness(1)" }];
export const NUDGE: Keyframe[] = [{ transform: "scale(1.3)" }, { transform: "scale(1)" }];
export const GLOW: Keyframe[] = [{ backgroundColor: "rgb(255 255 255 / 0.16)" }, {}];
const SPOTLIGHT: Keyframe[] = [{ backgroundColor: "rgb(255 122 69 / 0.18)", boxShadow: "0 0 0 1px rgb(255 122 69 / 0.9)" }, { backgroundColor: "rgb(255 122 69 / 0.1)", boxShadow: "0 0 0 1px rgb(255 122 69 / 0.6)", offset: 0.6 }, {}];

let latest = 0;

function calm() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Goals are named only while a transition runs, so each one glides to its new place and size.
function nameGoals(on: boolean) {
  document.querySelectorAll<HTMLElement>("[data-goal]").forEach((node) => {
    node.style.viewTransitionName = on ? `goal-${(node.dataset.goal ?? "").replace(/[^a-zA-Z0-9]/g, "-")}` : "";
  });
}

// Opening, closing, reordering and switching views glide instead of jumping.
export function smoothly(update: () => void) {
  if (calm() || !("startViewTransition" in document)) return update();
  const mine = (latest += 1);
  nameGoals(true);
  const transition = document.startViewTransition(() => {
    flushSync(update);
    nameGoals(true);
  });
  const settle = () => {
    if (mine === latest) nameGoals(false);
  };
  // A skipped transition (hidden tab, or a newer one starting) still applies the update; it only loses the glide.
  void transition.ready.catch(() => undefined);
  void transition.finished.then(settle, settle);
}

// Plays once when a value changes after the first render, so the eye lands on what just moved.
export function useFlash<T extends HTMLElement>(value: string, frames: Keyframe[], duration: number) {
  const ref = useRef<T>(null);
  const seen = useRef(value);

  useEffect(() => {
    if (seen.current === value) return;
    seen.current = value;
    if (!calm()) ref.current?.animate(frames, { duration, easing: "ease-out" });
  }, [duration, frames, value]);
  return ref;
}

// Bring one goal under the header and light it up.
export function focusGoal(id: string) {
  const node = document.querySelector<HTMLElement>(`[data-goal="${CSS.escape(id)}"]`);
  if (!node) return;
  node.scrollIntoView({ behavior: calm() ? "auto" : "smooth", block: "start" });
  node.animate(SPOTLIGHT, { duration: 2600, easing: "ease-out" });
}
