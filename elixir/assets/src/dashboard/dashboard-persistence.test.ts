import { afterEach, describe, expect, it, vi } from "vitest";

import { DASHBOARD_UI_STATE_KEY } from "./runtime";
import { readStoredWorkScope, writeDashboardUiStateValue } from "./dashboard-persistence";

describe("Work board scope persistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to every repository, ignores the retired Focus Board flag and preserves unrelated preferences", () => {
    let stored = JSON.stringify({ workspaceTab: "workstreams", useFocusBoard: false });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => key === DASHBOARD_UI_STATE_KEY ? stored : null,
        setItem: (key: string, value: string) => {
          if (key === DASHBOARD_UI_STATE_KEY) stored = value;
        },
      },
    });

    expect(readStoredWorkScope()).toBeNull();
    writeDashboardUiStateValue("workScope", "fixture/repo");

    expect(readStoredWorkScope()).toBe("fixture/repo");
    expect(JSON.parse(stored)).toMatchObject({ workspaceTab: "workstreams", workScope: "fixture/repo" });
  });
});
