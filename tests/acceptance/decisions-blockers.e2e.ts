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
  await architect.reject('append_progress', { ...declaration, summary: 'Replace the original history.' }, 'idempotency_conflict');
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
  // Reusing a resolution key cannot resolve a different blocker or replace history.
  expect((await architect.call('resolve_blocker', { ...resolution, blocker_id: 'access' })).progress_event.id).toBe(resolved.progress_event.id);
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

test('human choice submission rejects unknown or empty redirects and preserves the selected answer', async ({ factory }) => {
  const architect = await factory.client();
  const id = await architect.request('Structured human choices', 'human_info_needed');
  const prompt = {
    tl_dr: 'Choose the bounded path.', details: 'The operator decides the product outcome.',
    options: [{ id: 'continue', label: 'Continue', answer: 'Continue with the bounded path.' }],
  };
  for (const malformed of [
    { tl_dr: 'Missing options', details: 'A choice is required.' },
    { ...prompt, options: [{ id: '__custom_redirect__', label: 'Reserved id', answer: 'Invalid choice.' }] },
  ]) {
    const response = await architect.rpc('tools/call', { name: 'ask_question', arguments: {
      work_request_id: id, category: 'scope', question: 'Invalid question', why_needed: 'A complete choice is required.', decision_prompt: malformed,
    } });
    expect(response.error.code).toBe(-32602);
  }
  expect((await architect.call('read_work_request', { work_request_id: id })).clarification_questions).toEqual([]);
  const ask = async (decision_prompt?: object) => (await architect.call('ask_question', {
    work_request_id: id, category: 'scope', question: 'Which path should ship?', why_needed: 'Record the human choice.',
    ...(decision_prompt ? { decision_prompt } : {}),
  })).clarification_question.id;
  const question = await ask(prompt);
  const path = `/api/v1/sympp/operator/work-requests/${id}/questions/${question}/answer`;
  for (const invalid of [
    { answer_choice: 'unknown' }, { answer_choice: '__custom_redirect__' }, { answer: 'Stale autofilled answer.' },
  ]) {
    const rejected = await architect.operator(path, invalid);
    expect(rejected.status).toBe(422);
    expect((await architect.raw(invalid, {}, 'POST', path.replace('/operator/', '/herdr/'))).status).toBe(422);
    const current = await architect.call('read_work_request', { work_request_id: id });
    expect(current.clarification_questions[0].status).toBe('open');
    expect(current.decision_log_entries).toEqual([]);
  }
  expect((await architect.operator(path, {
    answer_choice: 'continue', answer_note: 'Keep the detail deferred.', answer: 'Stale autofilled answer.',
  })).status).toBe(200);
  const read = await architect.call('read_work_request', { work_request_id: id });
  expect(read.clarification_questions[0].answer).toBe('Continue with the bounded path. Keep the detail deferred.');
  expect(read.clarification_questions[0].answered_by).toBe('local-operator');

  const cases = [
    { prompt, input: { answer_choice: '__custom_redirect__', answer_note: 'Use a smaller path.' }, answer: 'Use a smaller path.' },
    { prompt: { ...prompt, custom_redirect_label: 'Choose a different path' }, input: { answer_choice: '__custom_redirect__', answer_note: 'Use the scoped alternative.' }, answer: 'Use the scoped alternative.' },
    { prompt: { ...prompt, options: [{ id: 'redirect', label: 'Internal redirect', answer: 'Use the structured redirect option.' }] }, input: { answer_choice: 'redirect' }, answer: 'Use the structured redirect option.' },
    { prompt: undefined, input: { answer_choice: 'narrow', answer_note: 'Keep it scoped.' }, answer: 'Narrow the scope before continuing. Keep it scoped.' },
  ];
  for (const choice of cases) {
    const q = await ask(choice.prompt);
    const endpoint = `/api/v1/sympp/herdr/work-requests/${id}/questions/${q}/answer`;
    if (!choice.prompt) expect((await architect.raw({ answer_choice: 'redirect' }, {}, 'POST', endpoint)).status).toBe(422);
    const foreign = endpoint.replace(id, 'missing-request');
    expect((await architect.raw(choice.input, {}, 'POST', foreign)).status).toBe(404);
    expect((await architect.raw(choice.input, {}, 'POST', endpoint)).status).toBe(200);
    expect((await architect.raw(choice.input, {}, 'POST', endpoint)).status).toBe(409);
    const result = await architect.call('read_work_request', { work_request_id: id });
    expect(result.clarification_questions.find((entry: any) => entry.id === q).answer).toBe(choice.answer);
    expect(result.work_request.status).toBe('human_info_needed');
  }
  const closed = await ask();
  await architect.call('close_question', { work_request_id: id, question_id: closed });
  expect((await architect.raw({ answer: 'Too late.' }, {}, 'POST', `/api/v1/sympp/herdr/work-requests/${id}/questions/${closed}/answer`)).status).toBe(409);
  await architect.reject('answer_question', { work_request_id: id, question_id: closed, answer: 'Too late.' }, 'already_closed');
  const final = await architect.call('read_work_request', { work_request_id: id });
  expect(final.clarification_questions.find((entry: any) => entry.id === closed).answer).toBe(null);
  expect(final.decision_log_entries).toEqual([]);
});
