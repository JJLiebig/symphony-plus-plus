// Sample job for the factory-floor lab. Times are minutes after the job started; each event
// changes only the packages it names. The last event is "now".

export const JOB = {
  title: "Ship the native S++ Lens",
  repo: "symphony-plus-plus",
  startClock: 9 * 60 + 10,
};

export const PACKAGES = [
  { id: "board-endpoint", title: "Board endpoint" },
  { id: "board-model", title: "Native board model" },
  { id: "install-command", title: "Install command", dependsOn: "board-model" },
  { id: "snapshot-context", title: "Snapshot context" },
  { id: "motion-spike", title: "Motion spike", noPr: true },
  { id: "human-actions", title: "Human actions" },
  { id: "remote-access", title: "Remote access policy" },
  { id: "theme-tokens", title: "Theme tokens" },
];

const agent = (provider, role, status, says) => ({ provider, role, status, says });
const codex = (status, says) => agent("Codex", "worker", status, says);
const claude = (status, says) => agent("Claude", "worker", status, says);

export const EVENTS = [
  { at: 0, text: "The architect plans 8 packages", set: Object.fromEntries(PACKAGES.map((p) => [p.id, { room: "yard" }])) },
  { at: 4, text: "Board endpoint starts building", set: { "board-endpoint": { room: "build", agent: codex("working", "Reading the board contract") } } },
  { at: 6, text: "Theme tokens starts building", set: { "theme-tokens": { room: "build", agent: claude("working", "Mapping theme tokens") } } },
  { at: 9, text: "Native board model starts building", set: { "board-model": { room: "build", agent: claude("working", "Sketching the board model") } } },
  { at: 21, text: "Board endpoint opens PR #752", set: { "board-endpoint": { room: "checks", pr: 752, agent: codex("working", "Watching CI · 2 of 5 checks") } } },
  { at: 28, text: "Theme tokens opens PR #750", set: { "theme-tokens": { room: "checks", pr: 750, agent: claude("working", "Watching CI") } } },
  { at: 33, text: "Board endpoint enters review", set: { "board-endpoint": { room: "review", round: 1, stage: "review", agent: codex("working", "Review Suite round 1") } } },
  { at: 37, text: "Snapshot context starts building", set: { "snapshot-context": { room: "build", agent: codex("working", "Wiring snapshot context") } } },
  { at: 41, text: "Motion spike starts: evidence, no PR", set: { "motion-spike": { room: "build", agent: agent("OpenCode", "investigator", "working", "Measuring transition cost") } } },
  { at: 46, text: "Theme tokens waits for a review slot", set: { "theme-tokens": { room: "review", round: 1, stage: "review", agent: claude("idle", "Waiting for review") } } },
  { at: 52, text: "Board endpoint is ready to merge", set: { "board-endpoint": { room: "merge", agent: codex("done", "Review clean") } } },
  { at: 54, text: "Theme tokens takes the review track", set: { "theme-tokens": { agent: claude("working", "Review Suite round 1") } } },
  { at: 58, text: "Native board model opens PR #755", set: { "board-model": { room: "checks", pr: 755, agent: claude("working", "Watching CI") } } },
  { at: 62, text: "Board endpoint merged", set: { "board-endpoint": { room: "shipped", agent: null } } },
  { at: 66, text: "Theme tokens is ready to merge", set: { "theme-tokens": { room: "merge", agent: claude("done", "Review clean") } } },
  { at: 69, text: "Human actions starts building", set: { "human-actions": { room: "build", agent: codex("working", "Adding native human actions") } } },
  { at: 71, text: "Native board model: review round 1", set: { "board-model": { room: "review", round: 1, stage: "review", agent: claude("working", "Review Suite round 1") } } },
  { at: 78, text: "Round 1 finds 5 issues", set: { "board-model": { stage: "fix", agent: claude("working", "Fixing 5 findings") } } },
  { at: 84, text: "Native board model circles back: round 2", set: { "board-model": { round: 2, stage: "review", agent: claude("working", "Review Suite round 2") } } },
  { at: 88, text: "Snapshot context opens PR #758", set: { "snapshot-context": { room: "checks", pr: 758, agent: codex("working", "Watching CI") } } },
  { at: 90, text: "Round 2 finds 3 issues", set: { "board-model": { stage: "fix", agent: claude("working", "Fixing 3 findings") } } },
  { at: 92, text: "Human actions opens PR #761", set: { "human-actions": { room: "checks", pr: 761, agent: codex("working", "Watching CI") } } },
  { at: 96, text: "Native board model circles back: round 3", set: { "board-model": { round: 3, stage: "review", agent: claude("working", "Review Suite round 3") } } },
  { at: 99, text: "Human actions fails checks; its agent goes idle", set: { "human-actions": { agent: codex("idle", "Checks failed") } } },
  { at: 104, text: "Round 3 finds 2 issues", set: { "board-model": { stage: "fix", agent: claude("working", "Fixing 2 findings") } } },
  { at: 110, text: "Native board model circles back: round 4", set: { "board-model": { round: 4, stage: "review", agent: claude("working", "Review Suite round 4") } } },
  { at: 112, text: "The architect needs your call", set: { "remote-access": { room: "desk", needs: "Allow a remote factory over a managed tunnel?", agent: agent("Claude", "architect", "blocked", "Waiting for your decision") } } },
  { at: 128, text: "Theme tokens rebases onto beta", set: { "theme-tokens": { agent: claude("working", "Rebasing onto beta") } } },
  { at: 134, text: "Motion spike writes its evidence", set: { "motion-spike": { agent: agent("OpenCode", "investigator", "working", "Writing the evidence handoff") } } },
  { at: 145, text: "Now", set: {} },
];
