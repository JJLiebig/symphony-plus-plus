// Invented goals, so the sketches can be judged with grouped and nested work, road bumps, an escalation,
// a stall, a parked goal, a failed deploy and a goal that just landed.
// They are anchored to the replay's busiest moment and are not in the ledger.
import { areaFor } from "./areas";
import type { ArchitectReport, Goal, Pkg, Stage } from "./model";

const MIN = 60e3;
type Live = { stage: Stage; since: number; started: number; failed?: boolean; round?: number; mode?: string; actor: string };
type Plan = { title: string; merged?: number; live?: Live };
type GroupPlan = { title: string; plans: Plan[]; subs?: Array<{ title: string; plans: Plan[] }> };

function pkg(goal: Pick<Goal, "id" | "title" | "area">, groupId: string, seq: number, plan: Plan, at: number, now: number): Pkg {
  const base: Pkg = {
    id: `${goal.id}-${seq}`,
    title: plan.title,
    seq,
    short: false,
    reviewMode: plan.live?.mode ?? null,
    groupId,
    goalTitle: goal.title,
    area: goal.area,
    createdAt: at - 2 * 24 * 60 * MIN,
    segs: [],
    endAt: null,
    outcome: null,
    prAt: null,
    prNumber: null,
    prUrl: null,
    rounds: [],
    actors: [],
    location: null,
  };
  if (plan.merged !== undefined) {
    const endAt = at - plan.merged * MIN;
    return { ...base, segs: [{ stage: "build", from: endAt - 90 * MIN, to: endAt, failed: false }], endAt, outcome: "merged", prAt: endAt - 60 * MIN };
  }
  return plan.live ? livePkg(base, plan.live, at, now) : base;
}

function livePkg(base: Pkg, live: Live, at: number, now: number): Pkg {
  const started = at - live.started * MIN;
  const since = at - live.since * MIN;
  const building = live.stage === "build";

  return {
    ...base,
    segs: [...(building ? [] : [{ stage: "build" as Stage, from: started, to: since, failed: false }]), { stage: live.stage, from: building ? started : since, to: now, failed: live.failed ?? false }],
    prAt: building ? null : since,
    rounds: Array.from({ length: (live.round ?? 1) - 1 }, (_unused, index) => since + (index + 1) * MIN),
    actors: [{ at: at - MIN, id: live.actor }],
  };
}

// A mock goal is filed under a pretend repository, so its area comes from the same mapping as real goals.
function goal(id: string, title: string, repo: string, groups: GroupPlan[], at: number, now: number): Goal {
  const head = { id, title, area: areaFor(repo) };
  let seq = 0;
  // Groups and their subgroups as one ordered list of tree nodes.
  const nodes = groups.flatMap((group, index) => {
    const groupId = `${id}-g${index}`;
    const subs = (group.subs ?? []).map((sub, position) => ({ id: `${groupId}-s${position}`, title: sub.title, parentId: groupId as string | null, plans: sub.plans }));
    return [{ id: groupId, title: group.title, parentId: null as string | null, plans: group.plans }, ...subs];
  });

  return {
    ...head,
    repo,
    baseBranch: "main",
    defaultBranch: "main",
    mock: true,
    createdAt: at - 2 * 24 * 60 * MIN,
    closedAt: null,
    asks: [],
    groups: nodes.map((node) => ({ id: node.id, title: node.title, parentId: node.parentId })),
    pkgs: nodes.flatMap((node) => node.plans.map((plan) => pkg(head, node.id, (seq += 1), plan, at, now))),
  };
}

// What the architect wrote, and how many minutes ago.
function report(at: number, ago: number, brief: string, eta?: string, parked?: string): ArchitectReport {
  const note = (text?: string) => (text ? { text, at: at - ago * MIN } : null);
  return { brief: note(brief), eta: note(eta), parked: note(parked) };
}

const merged = (titles: string[], from: number): Plan[] => titles.map((title, index) => ({ title, merged: from + index * 35 }));
const queued = (titles: string[]): Plan[] => titles.map((title) => ({ title }));
// A goal the architect did not group.
const plain = (id: string, title: string, repo: string, plans: Plan[], at: number, now: number): Goal => ({ ...goal(id, title, repo, [{ title: "", plans }], at, now), groups: [] });

// A stall, a failed deploy and a goal that landed three hours ago.
function aftermathGoals(at: number, now: number): Goal[] {
  const restore = plain(
    "mock-restore",
    "Herdr: restore sessions after a reboot",
    "mock/terminal",
    [...merged(["Persist pane layout on exit", "Persist agent thread ids", "Restore layout on start"], 380), ...queued(["Reattach running agents", "Restore scrollback", "Crash-safe write of the session file", "Restore prompt on first start"])],
    at,
    now,
  );
  const playback = plain("mock-playback", "VOD gateway: signed playback URLs", "mock/video", merged(["Signing key rotation", "Signed URL issuer", "Edge verification", "Expiry and clock-skew rules", "Playback client update"], 70), at, now);
  const timing = plain("mock-timing", "Review Suite: per-step timing in fast mode", "mock/review", merged(["Record step start and end", "Show timings in the review summary", "Flag the slowest step", "Document the timing fields"], 180), at, now);

  const search = plain("mock-search", "Search: typo-tolerant matching", "mock/video", [...merged(["Index tokenizer", "Edit-distance scorer"], 2900), ...queued(["Ranking blend", "Query-time fallback", "Relevance test set"])], at, now);

  return [
    { ...restore, baseBranch: "release/0.9" },
    { ...playback, deploy: [{ env: "Dev", state: "failed", at: at - 55 * MIN }, { env: "Prod", state: "waiting", at: null }], report: report(at, 40, "Everything is merged, but the dev deploy failed on the migration step. I am rerunning it now.", "On dev within the hour if the rerun passes") },
    { ...timing, deploy: [{ env: "Dev", state: "ok", at: at - 165 * MIN }, { env: "Prod", state: "ok", at: at - 150 * MIN }], report: report(at, 145, "All four packages are merged and live. Step timings now show in every fast review.") },
    { ...search, report: report(at, 2800, "The tokenizer and scorer are in. The rest waits for the index migration.", undefined, "Waiting for the index migration to land next week.") },
  ];
}

export function mockGoals(at: number, now: number): Goal[] {
  const payouts = goal(
    "mock-payouts",
    "Creator payouts v2: multi-currency settlement",
    "mock/payments",
    [
      { title: "Ledger and FX backend", plans: merged(["Double-entry payout ledger", "FX quote cache", "Settlement currency per creator", "Rounding and fee rules", "Ledger reconciliation job", "Backfill existing balances"], 400) },
      {
        title: "Payout API and webhooks",
        plans: [
          ...merged(["Payout request endpoint", "Payout status endpoint", "Provider webhook receiver"], 150),
          { title: "Webhook retry and dead-letter handling", live: { stage: "review", since: 205, started: 290, round: 3, mode: "deep", actor: "payout-webhooks" } },
          { title: "Idempotency keys for payout requests", live: { stage: "checks", since: 48, started: 110, failed: true, actor: "payout-idempotency" } },
        ],
      },
      {
        title: "Staff console UI",
        plans: [],
        subs: [
          { title: "Payout queue", plans: [{ title: "Payout queue table", live: { stage: "build", since: 35, started: 35, actor: "console-queue" } }, ...queued(["Currency filter and totals", "Failed payout drill-down"])] },
          { title: "Approvals", plans: [{ title: "Manual payout approval dialog", live: { stage: "review", since: 22, started: 80, mode: "fast", actor: "console-approval" } }, ...queued(["Audit trail panel", "Export to CSV"])] },
        ],
      },
      { title: "Creator-facing payout screens", plans: queued(["Payout history list", "Currency preference setting", "Payout detail and receipt", "Pending balance explainer", "Bank account status banner", "Empty and error states", "Email notifications", "Localized amounts"]) },
      { title: "Rollout and migration", plans: [] },
      { title: "Decommission legacy payouts", plans: [] },
    ],
    at,
    now,
  );

  const quotes = goal(
    "mock-quotes",
    "Quote engine: carrier integrations",
    "mock/insurance",
    [
      {
        title: "Carrier adapters",
        plans: [
          ...merged(["Adapter contract and test harness", "Carrier A adapter", "Carrier B adapter", "Carrier C adapter"], 120),
          { title: "Carrier D adapter", live: { stage: "review", since: 64, started: 140, round: 2, mode: "normal", actor: "carrier-d" } },
          { title: "Carrier E adapter", live: { stage: "merge", since: 15, started: 170, actor: "carrier-e" } },
          { title: "Rate-limit and retry policy", live: { stage: "build", since: 25, started: 25, actor: "adapter-retry" } },
        ],
      },
      { title: "Pricing rules", plans: queued(["Rule model and versioning", "Regional surcharge rules", "Bundle discounts", "Rule simulation endpoint", "Rule change audit log"]) },
      { title: "Broker portal", plans: queued(["Quote comparison view", "Save and resume a quote", "Share quote link", "Carrier availability badges", "Broker notes", "PDF export", "Quote expiry reminders", "Role-based access", "Usage analytics"]) },
      { title: "Go-live checklist", plans: [] },
    ],
    at,
    now,
  );
  quotes.asks = [{ from: at - 50 * MIN, to: Infinity, title: "Two carriers need production credentials before their adapters can be verified." }];
  payouts.report = report(at, 25, "The backend is done and most of the API is merged. Two packages are dragging: webhook retries are on their third review round, and idempotency keys have failing checks. Console UI has started in parallel.", "API finished today if round three passes; UI later this week");
  quotes.report = report(at, 50, "Four of seven carrier adapters are in and the rest are moving. I need production credentials for two carriers before their adapters can be verified.", "Adapters done tomorrow once the credentials arrive");

  // Both repositories have their deploy workflows tagged, so the board shows where the result is running.
  const untouched: Goal["deploy"] = [{ env: "Dev", state: "waiting", at: null }, { env: "Prod", state: "waiting", at: null }];
  return [{ ...payouts, deploy: untouched }, { ...quotes, deploy: untouched }, ...aftermathGoals(at, now)];
}
