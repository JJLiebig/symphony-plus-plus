// A small hydrated board for the Job level: one PR job across every stage, one job without PRs,
// and one still being shaped. Shapes follow GET /api/v1/sympp/herdr/dashboard.
export const NOW = Date.parse('2026-10-25T13:00:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60e3).toISOString();

const pkg = (id, title, sequence, board, extra = {}) => ({
  id, work_package_id: id, title, sequence, repo: 'owner/web', inserted_at: at(600), board_state: board, ...extra,
});

export function boardPayload() {
  return {
    generated_at: new Date(NOW).toISOString(),
    runtime: { offline: false },
    work_packages: [{ id: 'wp-build', active_agent_run: { attempt: 2, last_seen_at: at(3), stale: false } }],
    guidance_requests: { guidance_requests: [] },
    work_request_details: [
      {
        work_request: {
          id: 'wr-pr', title: 'Native job tab', repo: 'owner/web', status: 'sliced', base_branch: 'main',
          inserted_at: at(3000), architect_session_location: { label: 'Herdr', role: 'architect', last_seen_at: at(20) },
        },
        clarification_questions: [{ id: 'q1', question: 'Which order should the levels land in?', status: 'open' }],
        work_packages: [
          pkg('wp-queued', 'Factory level', 4, { stage: 'queued', track: 'pr' }, { dependency_signal: { unmet_work_package_ids: ['wp-build'] } }),
          pkg('wp-build', 'Stage board', 2, { stage: 'build', track: 'pr', entered_at: at(90) }, {
            dispatched_at: at(90),
            activity_signal: { current_actor: { role: 'worker', name: 'codex-board' }, observation_state: 'current', next_actor: 'worker', next_action: 'open_pr' },
          }),
          pkg('wp-review', 'Review lens', 3, { stage: 'review', track: 'pr', entered_at: at(40) }, {
            dispatched_at: at(300), pr_signal: { status: 'open', number: 812, checks: { status: 'passing' } },
            review_signal: {
              type: 'review_suite', mode: 'fast', status: 'in_progress', round: 3, started_at: at(200), round_started_at: at(40),
              round_history: [
                { number: 1, started_at: at(200), finished_at: at(150), outcome: 'findings', findings: 4 },
                { number: 2, started_at: at(120), finished_at: at(60), outcome: 'findings', findings: 2 },
                { number: 3, started_at: at(40), finished_at: null, outcome: null, findings: null },
              ],
            },
            activity_signal: { current_actor: { role: 'worker', name: 'opus-lens' }, observation_state: 'stale', waiting_reason: 'review_in_progress', next_actor: 'human', next_action: 'answer_guidance', last_update_at: at(25) },
          }),
          // Landed a day before the rest started: a long stretch nobody acted in.
          pkg('wp-done', 'Module split', 1, { stage: 'done', track: 'pr', delivered: true, entered_at: at(1800) }, {
            inserted_at: at(3000), dispatched_at: at(2900), pr_signal: { status: 'merged', number: 801 },
            review_signal: { type: 'review_suite', mode: 'fast', status: 'passed', round: '1', started_at: at(2000) },
          }),
        ],
      },
      {
        work_request: { id: 'wr-nopr', title: 'Research spike', repo: 'owner/notes', status: 'sliced', inserted_at: at(400) },
        work_packages: [
          pkg('np-1', 'Survey', 1, { stage: 'done', track: 'no_pr', delivered: true, entered_at: at(200) }, { dispatched_at: at(300) }),
          pkg('np-2', 'Write-up', 2, { stage: 'build', track: 'no_pr' }, { dispatched_at: at(100) }),
        ],
      },
      { work_request: { id: 'wr-shaping', title: 'New idea', repo: 'owner/web', status: 'clarifying', inserted_at: at(30) } },
    ],
  };
}

export function detailPayload() {
  return {
    work_request: { id: 'wr-pr' },
    decision_logs: [
      { id: 'd1', sequence: 1, decision: 'One sympp mod for every level', rationale: 'Shared look and state', created_by: 'architect', created_at: at(2000) },
      { id: 'd2', sequence: 2, decision: 'Job level first', created_by: 'architect', created_at: at(1000) },
    ],
  };
}
