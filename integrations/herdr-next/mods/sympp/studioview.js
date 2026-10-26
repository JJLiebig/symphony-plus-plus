// The UI studio's own pane: which package and worker it is about, and the preview. Beside it in the
// studio tab sits the worker's terminal; a native preview is its own pane below this one, which then
// shrinks to its header.
//
// s: { pkg, worker: { state, provider }, place: placement() result or null, kind: "web" | "native" |
//   "none", url, native: { state, error, builtAt }, landed, strip }

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import * as M from "./model.js";
import { MONO, button, message } from "./ui.js";

export function studioView(v, t, s) {
  return v_flex().id("studio").size_full().min_h(0).min_w(0)
    .child(header(v, t, s))
    .when(!s.strip, (el) => el.child(body(v, t, s)));
}

function workerLine(s) {
  const who = s.worker.provider ?? "Worker";
  if (s.landed) return "Landed";
  if (s.worker.state === "live") return s.place?.step === "elsewhere" ? `${who} · in another tab` : `${who} · Live`;
  if (s.worker.state === "checking") return "Checking the worker…";
  return s.worker.state === "none" ? "No worker started for this package" : "The worker isn't running";
}

function previewLine(s, now) {
  if (s.kind !== "native") return null;
  if (s.native.state === "building" && !s.native.builtAt) return "Building the preview…";
  if (s.native.error) return `Preview build failed: ${s.native.error}`;
  return `Sample data · ${s.native.builtAt ? `updated ${M.ago(s.native.builtAt, now)}` : "updating"}`;
}

function header(v, t, s) {
  const now = Date.now();
  const preview = previewLine(s, now);
  const live = s.worker.state === "live";
  const actions = h_flex().gap(4).items_center().flex_none()
    .when(live && s.place?.step === "elsewhere", (el) => el
      .child(button(t, "studio-move", "Move here", (cx) => v.moveWorker(cx), { strong: true, glyph: "terminal", tip: "Move the worker's terminal into this studio" }))
      .child(button(t, "studio-go", "Go to it", (cx) => v.goToWorker(cx), { tip: "Show the worker where it is" })))
    .when(s.kind === "web" && s.strip, (el) => el.child(openButton(v, t, s.url)))
    .when(!live && !s.landed, (el) => el.child(button(t, "studio-retry", v.workerChecking ? "Checking…" : "Retry", (cx) => v.retry(cx), { tip: "Check the worker again (R)", disabled: v.workerChecking })));
  return h_flex().id("studio-head").flex_none().px(14).py(9).gap(10).items_center().min_w(0).border_b(1).border_color(t.border)
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(s.pkg.title))
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(div().flex_none().size(6).rounded(3).bg(live ? t.ansi2 : s.landed ? t.done : t.dim))
        .child(div().flex_none().text_size(11.5).text_color(live ? t.foreground : t.muted).child(workerLine(s)))
        .when(Boolean(preview), (el) => el.child(div().min_w(0).truncate().text_size(11.5)
          .text_color(s.native.error ? t.blocked : t.muted).child(preview)))
        .when(s.kind === "web" && s.strip, (el) => el.child(div().min_w(0).truncate().text_size(11.5).font_family(MONO).text_color(t.muted).child(s.url)))))
    .child(actions);
}

function openButton(v, t, url) {
  return button(t, "studio-open", "Open", (cx) => v.openPreview(url, cx), { strong: true, glyph: "monitor", tip: "Open the preview in your browser (O)" });
}

function body(v, t, s) {
  if (s.landed) return message(t, "Landed", null);
  if (s.worker.state !== "live") {
    return message(t, s.worker.state === "checking" ? "Checking the worker…" : "Waiting for the worker",
      s.worker.state === "checking" ? null : "The studio places the worker here once S++ confirms it is running.");
  }
  if (s.kind === "web") return webPreview(v, t, s.url);
  if (s.kind === "native") {
    if (s.native.error) return message(t, "The preview didn't build", s.native.error);
    if (!s.native.builtAt) return message(t, "Building the preview…", null);
    return message(t, "The preview is closed", null, [button(t, "studio-show", "Show preview", (cx) => v.showPreview(cx), { strong: true, glyph: "monitor" })]);
  }
  return message(t, "The agent hasn't published a preview yet", null);
}

// A web preview the worker published. A raster of the page can take this card's place later; the
// URL, the Open action and the key stay the same.
function webPreview(v, t, url) {
  return v_flex().id("studio-web").flex_1().min_h(0).items_center().justify_center().p(20)
    .child(v_flex().id("studio-card").w_full().max_w(520).gap(12).p(18).rounded(8).border(1).border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(div().size(7).flex_none().rounded(4).bg(t.ansi2))
        .child(div().text_size(12).font_medium().text_color(t.muted).child("Preview")))
      .child(div().w_full().text_size(13).font_family(MONO).text_color(t.foreground).child(url))
      .child(h_flex().child(openButton(v, t, url))));
}
