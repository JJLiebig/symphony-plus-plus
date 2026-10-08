import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import type { WorkRequestDetail } from "@/types/dashboard";

const actualF03Delivery = JSON.parse(readFileSync(new URL("./__fixtures__/actual-f03-delivered-row.json", import.meta.url), "utf8")) as {
  generated_at: string;
  work_request_details: WorkRequestDetail[];
};

let browser: Browser;
let server: ViteDevServer;
let url: string;

beforeAll(async () => {
  server = await createServer({
    configFile: path.resolve("vite.config.ts"),
    server: { port: 0, strictPort: false },
  });
  await server.listen();
  url = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ executablePath: browserExecutablePath() });
}, 45_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
}, 20_000);

describe("focus board interactions", () => {
  it("previews the actual merged F03 result before replaced work and retains its delivery history", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.setDefaultTimeout(5_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const detail = actualF03Delivery.work_request_details[0]!;
    const dashboard = {
      ...actualF03Delivery,
      work_requests: { work_requests: [detail.work_request], total_count: 1 },
    };
    await page.route("**/api/v1/sympp/operator/config*", (route) => route.fulfill({ json: { apiBase: "/api/v1/sympp/operator", dashboard } }));
    await page.route("**/api/v1/sympp/operator/dashboard/events", (route) => route.abort());
    await page.route("**/api/v1/sympp/operator/dashboard*", (route) => route.fulfill({ json: dashboard }));
    await page.route(`**/api/v1/sympp/operator/work-requests/${detail.work_request.id}*`, (route) => route.fulfill({ json: detail }));

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.getByRole("button", { name: /^Recently delivered/ }).click();
    const card = page.locator(`.focus-board__recent [data-request-id="${detail.work_request.id}"]`);
    const rows = card.locator(".v3-request-frontier-package");
    expect(await rows.count()).toBe(2);
    expect(await rows.first().getByRole("button", { name: "Open WorkPackage details for F03 — Show the complete package title beside actual PR metadata", exact: true }).isVisible()).toBe(true);
    expect(await rows.first().getByText("Merged", { exact: true }).isVisible()).toBe(true);
    expect(await rows.first().getByRole("link", { name: "PR #708", exact: true }).getAttribute("href")).toBe("https://github.com/JJLiebig/symphony-plus-plus/pull/708");

    await card.getByRole("button", { name: "Show all work (3)", exact: true }).press("Enter");
    expect(await rows.count()).toBe(3);
    expect(await card.getByText("Superseded", { exact: true }).count()).toBe(2);
    for (const slice of detail.work_packages!) expect(await card.getByRole("button", { name: `Open WorkPackage details for ${slice.title}`, exact: true }).isVisible()).toBe(true);
    await card.getByRole("button", { name: "Show less", exact: true }).click();
    expect(await rows.count()).toBe(2);

    await card.locator(".v3-request-main").click();
    const tree = page.locator(".focus-board__workbench .v3-product-plan");
    await tree.waitFor();
    for (const slice of detail.work_packages!) expect(await tree.locator(`[data-work-package-id="${slice.id}"]`).isVisible()).toBe(true);
    await page.close();
  }, 20_000);

  it("paints the application shell and consumes the config bootstrap without a priority waterfall", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    let releaseConfig!: () => void;
    const configReady = new Promise<void>((resolve) => { releaseConfig = resolve; });
    let priorityRequests = 0;

    await page.route("**/api/v1/sympp/operator/config*", async (route) => {
      await configReady;
      await route.fulfill({ json: { apiBase: "/api/v1/sympp/operator", dashboard: priorityDashboard } });
    });
    await page.route("**/api/v1/sympp/operator/dashboard", (route) => {
      priorityRequests += 1;
      return route.fulfill({ json: priorityDashboard });
    });
    await page.route("**/api/v1/sympp/operator/dashboard/deferred", (route) => route.fulfill({ json: deferredDashboard }));
    await page.route("**/api/v1/sympp/operator/work-requests/wr-interaction*", (route) => route.fulfill({ json: deferredDashboard.work_request_details[0] }));
    await page.route("**/api/v1/sympp/operator/dashboard/events", (route) => route.abort());

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.getByRole("heading", { name: "Symphony++" }).waitFor();
    expect(await page.getByLabel("Loading workstreams").isVisible()).toBe(true);
    expect(await page.getByText("Loading Symphony++").count()).toBe(0);

    releaseConfig();
    await page.getByText("Interaction request", { exact: true }).waitFor();
    expect(priorityRequests).toBe(0);
    await page.keyboard.press("Escape");
    await page.locator('[data-request-id="wr-interaction"]').first().getByRole("button", { name: "Open request details" }).click();
    const detail = page.locator(".dashboard-dialog-content");
    await detail.getByText("Mark Delivered", { exact: true }).waitFor();
    expect(await detail.getByText("Add Comment", { exact: true }).count()).toBe(1);
    expect(await detail.getByText("Delete Request", { exact: true }).count()).toBe(1);
    await page.close();
  }, 20_000);

  it("toggles the docked workbench and keeps it stable while selection swaps", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.setDefaultTimeout(3_000);
    let releaseDeferred!: () => void;
    const deferredReady = new Promise<void>((resolve) => {
      releaseDeferred = resolve;
    });
    let markDeferredRequested!: () => void;
    const deferredRequested = new Promise<void>((resolve) => {
      markDeferredRequested = resolve;
    });
    const requests: string[] = [];

    await page.route("**/api/v1/sympp/operator/config*", (route) =>
      route.fulfill({ json: { apiBase: "/api/v1/sympp/operator", basePath: "/sympp/board" } }),
    );
    await page.route("**/api/v1/sympp/operator/dashboard/events", (route) => route.abort());
    await page.route("**/api/v1/sympp/operator/dashboard", async (route) => {
      requests.push("priority");
      await route.fulfill({ json: priorityDashboard });
    });
    await page.route("**/api/v1/sympp/operator/dashboard/deferred", async (route) => {
      requests.push("deferred");
      markDeferredRequested();
      await deferredReady;
      await route.fulfill({ json: deferredDashboard });
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const board = page.locator(".focus-board");
    await board.waitFor({ state: "attached" });
    await deferredRequested;
    expect(requests).toEqual(["priority", "deferred"]);
    expect(await board.getAttribute("aria-busy")).toBe("true");
    expect(await board.getByText("Loading latest activity…", { exact: true }).isVisible()).toBe(true);
    expect(await board.getByText(/open across repositories/).count()).toBe(0);
    expect(await page.locator(".workstream-repo-card").count()).toBe(0);

    releaseDeferred();
    await board.locator('[data-request-id="wr-interaction"]').waitFor({ state: "attached" });
    await board.getByText("3 open across repositories", { exact: true }).waitFor();
    expect(await board.getByText("Loading latest activity…", { exact: true }).count()).toBe(0);
    for (const id of ["wr-interaction", "wr-earlier-lane", "wr-following-group"]) expect(await board.locator(`.focus-board__groups [data-request-id="${id}"]`).count()).toBe(1);
    expect(await page.getByText(/Experimental|Use Focus Board/).count()).toBe(0);
    const workbench = board.locator(".focus-board__workbench");
    const selected = board.locator('[data-request-id="wr-following-group"]');
    const next = board.locator('[data-request-id="wr-interaction"]');
    await workbench.getByText("Following group request", { exact: true }).waitFor();
    expect(await selected.locator(".v3-request-main").getAttribute("aria-pressed")).toBe("true");
    expect(await workbench.getAttribute("data-mode")).toBe("tree");
    expect(await board.locator(".focus-board__groups").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await board.locator(".focus-board__workbench-reveal").evaluate((element) => getComputedStyle(element).viewTransitionName)).toBe("focus-workbench");

    const fullMap = workbench.getByRole("button", { name: "Full map" });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".focus-board__mode-switch button:last-child")?.disabled);
    await fullMap.click();
    expect(await workbench.getAttribute("data-mode")).toBe("full");
    const graphViewport = workbench.locator(".execution-graph__viewport");
    await graphViewport.waitFor();
    expect(await graphViewport.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe("none");
    const before = await workbench.evaluate((element) => ({ height: element.getBoundingClientRect().height, top: element.getBoundingClientRect().top, scrollY }));
    await next.locator(".v3-request-main").click();

    expect(await board.getAttribute("data-focus-request-id")).toBe("wr-interaction");
    expect(await next.locator(".v3-request-main").getAttribute("aria-pressed")).toBe("true");
    expect(await workbench.getByText("Interaction request", { exact: true }).isVisible()).toBe(true);
    expect(await workbench.getAttribute("data-mode")).toBe("full");
    const after = await workbench.evaluate((element) => ({ height: element.getBoundingClientRect().height, top: element.getBoundingClientRect().top, scrollY }));
    expect(after.top).toBe(before.top);
    expect(after.scrollY).toBe(before.scrollY);
    expect(after.height).toBeGreaterThan(0);

    await next.locator(".v3-request-main").click();
    expect(await board.getAttribute("data-focus-request-id")).toBeNull();
    expect(await next.locator(".v3-request-main").getAttribute("aria-pressed")).toBe("false");
    await page.waitForFunction(() => document.querySelector(".focus-board__workbench-reveal")?.getAttribute("data-open") === "false");

    await next.locator(".v3-request-main").click();
    expect(await board.getAttribute("data-focus-request-id")).toBe("wr-interaction");
    await page.waitForFunction(() => document.querySelector(".focus-board__workbench-reveal")?.getAttribute("data-open") === "true");
    await workbench.getByRole("button", { name: "Close Interaction request" }).click();
    await page.waitForFunction(() => document.querySelector(".focus-board__workbench-reveal")?.getAttribute("data-open") === "false");
    expect(await page.evaluate(() => document.activeElement?.closest("[data-request-id]")?.getAttribute("data-request-id"))).toBe("wr-interaction");
    expect(await page.evaluate(() => document.activeElement?.classList.contains("v3-request-main"))).toBe(true);

    await page.setViewportSize({ width: 390, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await board.locator(".focus-board__groups .v3-request-row").evaluateAll((cards) => cards.every((card) => card.getBoundingClientRect().right <= window.innerWidth && card.scrollWidth <= card.clientWidth))).toBe(true);

    await page.close();
  }, 20_000);

  it("closes the blocker overview and modal when jumping to its WorkPackage", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.setDefaultTimeout(5_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/v1/sympp/operator/config*", (route) =>
      route.fulfill({ json: { apiBase: "/api/v1/sympp/operator", basePath: "/sympp/board" } }),
    );
    await page.route("**/api/v1/sympp/operator/dashboard/events", (route) => route.abort());
    await page.route("**/api/v1/sympp/operator/dashboard", (route) => route.fulfill({ json: attentionDashboard }));
    await page.route("**/api/v1/sympp/operator/work-packages/wp-jump", (route) => route.fulfill({
      json: { work_package: attentionPackage, blockers: [attentionBlocker] },
    }));
    await page.route("**/api/v1/sympp/operator/work-requests/wr-jump*", (route) => route.fulfill({
      json: attentionDashboard.work_request_details[0],
    }));

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(500);
    const attentionLabels = await page.locator(".dashboard-attention-button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
    expect({ attentionLabels, text: await page.locator("body").innerText() }).toMatchObject({
      attentionLabels: expect.arrayContaining(["Active Blockers: 1"]),
    });
    await page.keyboard.press("Escape");
    await page.locator(".dialog-overlay").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Active Blockers: 1" }).click();
    const panel = page.locator(".top-panel-inline");
    await panel.locator(".attention-location__repo:visible").waitFor();
    await page.waitForFunction(() => document.querySelector(".top-panel-viewport")?.getAttribute("data-phase") === "idle");
    expect(await panel.locator(".top-panel-static").count()).toBe(1);
    expect(await panel.locator(".top-panel-track").count()).toBe(0);
    const panelText = await panel.textContent();
    expect(panelText).toContain("Jump request");
    expect(panelText).toContain("Jump group – Jump package");
    expect(panelText).toContain("Blocked for 3h");
    expect(panelText).not.toContain("since");
    expect(panelText).not.toContain("Open blocker");
    expect(await panel.getByRole("button", { name: "Jump to Jump request" }).innerText()).toBe("WR");

    await panel.getByRole("button", { name: /Open Blocked/ }).click();
    const modal = page.locator(".attention-dialog");
    await modal.getByTitle("Jump to Jump package").waitFor();
    expect(await modal.textContent()).toContain("Jump group – Jump package");
    await modal.getByTitle("Jump to Jump package").click();

    await modal.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector(".top-panel-inline")?.getAttribute("data-open-panel") === "none");
    await page.waitForFunction(() => document.querySelector(".focus-board__workbench")?.getAttribute("data-mode") === "full");
    expect(await page.locator(".focus-board").getAttribute("data-focus-request-id")).toBe("wr-jump");
    const target = page.locator('.execution-graph__viewport--desktop [data-work-package-id="slice-jump"]');
    await target.waitFor();
    expect(await target.getAttribute("data-attention-jump")).toBe("true");
    expect(await page.locator('.execution-graph__viewport--desktop [data-group-id="group-jump"]').getAttribute("data-expanded")).toBe("true");

    await page.close();
  }, 20_000);

  it("resolves an attention jump in the Work tree when the request has no usable graph", async () => {
    const page = await browser.newPage({ viewport: { width: 700, height: 800 } });
    page.setDefaultTimeout(5_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const treeOnly = { ...attentionDashboard, work_request_details: [{ ...attentionDashboard.work_request_details[0], product_tree: { ...attentionDashboard.work_request_details[0].product_tree, execution_graph: { available: false } } }] };
    await page.route("**/api/v1/sympp/operator/config*", (route) =>
      route.fulfill({ json: { apiBase: "/api/v1/sympp/operator", basePath: "/sympp/board" } }),
    );
    await page.route("**/api/v1/sympp/operator/dashboard/events", (route) => route.abort());
    await page.route("**/api/v1/sympp/operator/dashboard", (route) => route.fulfill({ json: treeOnly }));
    await page.route("**/api/v1/sympp/operator/work-packages/wp-jump", (route) => route.fulfill({
      json: { work_package: attentionPackage, blockers: [attentionBlocker] },
    }));
    await page.route("**/api/v1/sympp/operator/work-requests/wr-jump*", (route) => route.fulfill({ json: treeOnly.work_request_details[0] }));

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.getByRole("button", { name: "Active Blockers: 1" }).click();
    await page.locator(".top-panel-inline").getByRole("button", { name: /Open Blocked/ }).click();
    await page.locator(".attention-dialog").getByTitle("Jump to Jump package").click();

    await page.waitForFunction(() => document.querySelector('.focus-board__workbench [data-work-package-id="slice-jump"]')?.getAttribute("data-attention-jump") === "true");
    expect(await page.locator(".focus-board").getAttribute("data-focus-request-id")).toBe("wr-jump");
    expect(await page.locator(".focus-board__workbench").getAttribute("data-mode")).toBe("tree");
    const group = page.locator('.focus-board__workbench [data-group-id="group-jump"]');
    expect(await group.locator(":scope > .v3-product-node-header .v3-product-node-chevron-button").getAttribute("aria-expanded")).toBe("true");
    const target = page.locator('.focus-board__workbench [data-work-package-id="slice-jump"]');
    expect(await target.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(2);

    await page.close();
  }, 20_000);
});

function browserExecutablePath() {
  const bundled = chromium.executablePath();
  if (existsSync(bundled)) return bundled;
  return browserCandidates().find(existsSync);
}

function browserCandidates() {
  if (os.platform() === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
  }
  if (os.platform() === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

const request = {
  id: "wr-interaction",
  title: "Interaction request",
  repo: "fixture/repo",
  repo_key: "fixture/repo",
  base_branch: "main",
  status: "sliced",
  work_package_count: 1,
};

const earlierLaneRequest = {
  id: "wr-earlier-lane",
  title: "Earlier lane request",
  repo: "fixture/secondary",
  repo_key: "fixture/secondary",
  base_branch: "main",
  status: "clarifying",
  open_question_count: 1,
  work_package_count: 0,
};

const followingGroupRequest = {
  id: "wr-following-group",
  title: "Following group request",
  repo: "fixture/secondary",
  repo_key: "fixture/secondary",
  base_branch: "main",
  status: "sliced",
  work_package_count: 1,
};

const priorityDashboard = {
  generated_at: "2026-07-23T12:00:00Z",
  work_requests: { work_requests: [request, earlierLaneRequest, followingGroupRequest], total_count: 3 },
  deferred: { dashboard_sections: true },
};

const deferredDashboard = {
  generated_at: "2026-07-23T12:00:00Z",
  work_packages: [{ id: "wp-interaction", status: "active" }, { id: "wp-following-group", status: "active" }],
  work_request_details: [{
    work_request: request,
    work_packages: [{
      id: "slice-interaction",
      work_request_id: request.id,
      work_package_id: "wp-interaction",
      title: "Interaction slice",
      status: "implementing",
      worker_signal: { status: "active" },
      pr_signal: { number: 42, url: "https://example.test/pull/42" },
    }],
    product_tree: {
      nodes: [{ id: "delivery", position: 0, title: "Delivery", work_package_ids: ["slice-interaction"] }],
      execution_graph: { available: true, work_package_ids: ["slice-interaction"], effective_edges: [], topological_order: ["slice-interaction"] },
    },
  }, {
    work_request: earlierLaneRequest,
    work_packages: [],
    clarification_questions: [{ id: "question-earlier-lane", status: "open" }],
    product_tree: { nodes: [] },
  }, {
    work_request: followingGroupRequest,
    work_packages: [{
      id: "slice-following-group",
      work_request_id: followingGroupRequest.id,
      work_package_id: "wp-following-group",
      title: "Following group slice",
      status: "implementing",
      worker_signal: { status: "active" },
    }],
    product_tree: {
      nodes: [{ id: "following", position: 0, title: "Following", work_package_ids: ["slice-following-group"] }],
      execution_graph: { available: true, work_package_ids: ["slice-following-group"], effective_edges: [], topological_order: ["slice-following-group"] },
    },
  }],
  active_blocking_edges: [],
  guidance_requests: { guidance_requests: [], total_count: 0 },
  solo_sessions: { solo_sessions: [], total_count: 0 },
  deferred: { dashboard_sections: false },
};

const attentionBlocker = {
  id: "blocker-jump",
  active: true,
  summary: "Needs approval before release",
  updated_at: "2026-07-30T09:15:00Z",
};

const attentionPackage = {
  id: "wp-jump",
  title: "Jump package",
  repo: "fixture/repo",
  status: "blocked",
  active_blocker_count: 1,
  active_blockers: [attentionBlocker],
};

const attentionRequest = {
  id: "wr-jump",
  title: "Jump request",
  repo: "fixture/repo",
  repo_key: "fixture/repo",
  base_branch: "main",
  status: "sliced",
  work_package_count: 1,
};

const attentionSlice = {
  id: "slice-jump",
  work_request_id: attentionRequest.id,
  work_package_id: attentionPackage.id,
  product_tree_node_id: "group-jump",
  title: "Jump package",
  status: "blocked",
  operational_state: { key: "blocked", label: "Blocked", tone: "danger" },
};

const attentionEdge = {
  id: "edge-jump",
  blocker_id: attentionBlocker.id,
  work_request_id: attentionRequest.id,
  work_package_id: attentionPackage.id,
  from: { kind: "work_package", id: "wp-source" },
  to: { kind: "work_package", id: attentionPackage.id },
  summary: attentionBlocker.summary,
  updated_at: attentionBlocker.updated_at,
};

const attentionDashboard = {
  generated_at: "2026-07-30T12:15:00Z",
  work_requests: { work_requests: [attentionRequest], total_count: 1 },
  work_packages: [attentionPackage],
  work_request_details: [{
    work_request: attentionRequest,
    work_packages: [attentionSlice],
    product_tree: {
      available: true,
      nodes: [{ id: "group-jump", position: 0, title: "Jump group", work_package_ids: [attentionSlice.id] }],
      execution_graph: { available: true, work_package_ids: [attentionSlice.id], effective_edges: [], topological_order: [attentionSlice.id] },
    },
  }],
  active_blocking_edges: [attentionEdge],
  guidance_requests: { guidance_requests: [], total_count: 0 },
  solo_sessions: { solo_sessions: [], total_count: 0 },
  deferred: { dashboard_sections: false },
};
