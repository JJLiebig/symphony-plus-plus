import { expect } from 'e2e';
import { contract, test, type Client } from '../support/factory.js';

async function packageState(architect: Client, request: string, wp: string) {
  const board = await architect.call('read_delivery_board', { work_request_id: request });
  return board.delivery_board.work_packages.find((entry: any) => entry.work_package.id === wp).work_package;
}

test('human answers retain decision provenance and stale replay cannot append a second decision', async ({ factory }) => {
  const architect = await factory.client();
  const id = await architect.request('Human decision', 'human_info_needed');
  const question = (await architect.call('ask_question', {
    work_request_id: id, category: 'scope', question: 'Ship the bounded option?', why_needed: 'Human approval defines scope.',
    decision_prompt: { tl_dr: 'Choose scope', details: 'Keep this delivery bounded.',
      options: [{ id: 'bounded', label: 'Bounded option', answer: 'Ship the bounded option.' }] },
  })).clarification_question.id;
  const args = {
    work_request_id: id, question_id: question, expected_question_status: 'open',
    answer: 'Ship the bounded option.', answered_by: 'human-operator', source_type: 'human',
    decision: 'Ship the bounded option.', rationale: 'It meets the agreed need.',
    scope_impact: 'Defer adjacent behavior.', created_by: 'human-operator',
  };
  const answer = await architect.call('answer_question_and_record_decision', args);
  expect(answer.clarification_question.status).toBe('answered');
  expect(answer.work_request.status).toBe('human_info_needed');
  await architect.reject('answer_question_and_record_decision', args, 'already_answered');
  const observer = await factory.client();
  const read = await observer.call('read_work_request', { work_request_id: id });
  expect(read.decision_log_entries).toHaveLength(1);
  const decision = read.decision_log_entries[0];
  expect(decision.id).toBe(answer.decision_log_entry.id);
  expect(decision.source_type).toBe('human');
  expect(decision.source_id).toBe(question);
  expect(decision.created_by).toBe('human-operator');
  expect(decision.decision).toBe(args.decision);
  expect(decision.rationale).toBe(args.rationale);
  expect(decision.scope_impact).toBe(args.scope_impact);
  expect(read.clarification_questions[0].answer).toBe(args.answer);
  expect(read.work_request.status).toBe('human_info_needed');
  expect((await architect.call('slice_work_request', {
    work_packages: [contract('Approved outcome', { goal: `Implement decision ${decision.id}` })],
  })).status.work_request_status).toBe('sliced');
});

test('questions, human escalation and review waits preserve explicit package blockers and sibling state', async ({ factory }) => {
  const architect = await factory.client();
  const id = await architect.request('Decision versus blocker');
  const sliced = await architect.call('slice_work_request', { work_packages: [contract('Affected work'), contract('Sibling work')] });
  const [affected, sibling] = sliced.work_package_ids;
  await architect.call('dispatch_work_package', { work_package_id: affected });
  await architect.call('dispatch_work_package', { work_package_id: sibling });
  const initial = await packageState(architect, id, affected);
  const siblingBefore = await packageState(architect, id, sibling);
  expect(initial.blocker_state['active?']).toBe(false);
  const question = (await architect.call('ask_question', {
    work_request_id: id, category: 'scope', question: 'Should we change the optional detail?', why_needed: 'A product decision can be answered while independent work continues.',
  })).clarification_question.id;
  const assignment = await architect.call('get_current_assignment');
  const anchor = assignment.assignment.work_package_id;
  await architect.call('append_progress', {
    work_package_id: anchor, summary: 'A human scope choice is needed.', idempotency_key: 'escalation',
    payload: { type: 'architect_operator_report', human_escalation: { question: 'Should the optional detail ship?' } },
  });
  const escalated = await architect.call('read_work_request', { work_request_id: id });
  expect(escalated.work_request.operator_report.human_escalation.question).toBe('Should the optional detail ship?');
  await architect.call('append_progress', {
    work_package_id: affected, summary: 'Waiting for hosted review.', status: 'ci_waiting', idempotency_key: 'ordinary-wait',
  });
  expect((await packageState(architect, id, affected)).blocker_state['active?']).toBe(false);

  const declaration = {
    work_package_id: affected, summary: 'Required schema is unavailable.', status: 'blocked', idempotency_key: 'schema-blocker',
    payload: { type: 'blocker', active: true, blocker_id: 'schema' },
  };
  const first = await architect.call('append_progress', declaration);
  const replay = await architect.call('append_progress', declaration);
  expect(replay.progress_event.id).toBe(first.progress_event.id);
  await architect.call('append_progress', {
    ...declaration, summary: 'Required access is unavailable.', idempotency_key: 'access-blocker',
    payload: { type: 'blocker', active: true, blocker_id: 'access' },
  });
  expect((await packageState(architect, id, affected)).blocker_state['active?']).toBe(true);
  const human = {
    work_request_id: id, question_id: question, answer: 'Keep the optional detail deferred.',
    source_type: 'human', decision: 'Defer the optional detail.', rationale: 'The current scope is sufficient.', scope_impact: 'No package changes.',
  };
  await architect.call('answer_question_and_record_decision', human);
  await architect.call('append_progress', {
    work_package_id: anchor, summary: 'Human answered.', idempotency_key: 'escalation-resolved',
    payload: { type: 'architect_operator_report', human_escalation: null },
  });
  expect((await packageState(architect, id, affected)).blocker_state['active?']).toBe(true);

  const resolution = {
    work_package_id: affected, blocker_id: 'schema', resolution: 'Schema supplied.',
    summary: 'Schema prerequisite available.', idempotency_key: 'resolve-schema',
  };
  const resolved = await architect.call('resolve_blocker', resolution);
  expect((await architect.call('resolve_blocker', resolution)).progress_event.id).toBe(resolved.progress_event.id);
  expect((await packageState(architect, id, affected)).blocker_state['active?']).toBe(true);
  await architect.call('resolve_blocker', {
    ...resolution, blocker_id: 'access', resolution: 'Access supplied.', summary: 'Access prerequisite available.', idempotency_key: 'resolve-access',
  });
  expect((await packageState(architect, id, affected)).blocker_state['active?']).toBe(false);
  expect(await packageState(architect, id, sibling)).toEqual(siblingBefore);
  const report = (await architect.call('read_work_request', { work_request_id: id })).work_request.operator_report;
  expect(report.human_escalation.question).toBe('Should the optional detail ship?');
  expect(report.human_escalation.resolved_at).toBeTruthy();
});
