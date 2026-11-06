import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildGoals, type PkgView } from "./model";
import { PkgLine } from "./report";

it("shows caller inspection on a reviewed descendant already awaiting merge", () => {
  const { goals, now } = buildGoals({ work_request_details: [{
    work_request: { id: "wr", title: "Ship" },
    work_packages: [{ id: "wp", title: "Change", board_state: { stage: "merge" }, review_signal: { status: "inspection_needed" } }],
  }] }, {});
  const pkg = goals[0].pkgs[0];
  const view: PkgView = { pkg, stage: "merge", since: now, untimed: true, failed: false, round: 1, actor: null };
  expect(renderToStaticMarkup(<PkgLine at={now} view={view} />)).toContain("Changes since review need inspection");
  expect(view.failed).toBe(false);
});
