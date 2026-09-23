import { describe, expect, it, vi } from "vitest";

import { createDashboardRefreshInvalidation } from "./dashboard-refresh-invalidation";

describe("dashboard refresh invalidation", () => {
  it("notifies subscribers until they unsubscribe", () => {
    const invalidation = createDashboardRefreshInvalidation();
    const listener = vi.fn();
    const unsubscribe = invalidation.subscribe(listener);

    invalidation.publish();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    invalidation.publish();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps independent signal instances isolated", () => {
    const first = createDashboardRefreshInvalidation();
    const second = createDashboardRefreshInvalidation();
    const listener = vi.fn();

    first.subscribe(listener);
    second.publish();

    expect(listener).not.toHaveBeenCalled();
  });
});
