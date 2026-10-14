import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const mode = process.argv[2];
const { run } = JSON.parse(await readFile(`.e2e/browser-${mode}/report.json`, 'utf8'));
assert.equal(run.usage.maxModelCallsInStep, 0);
assert.equal(run.usage.modelTokens, 0);
for (const result of run.results) assert.ok(result.attempts.length <= 1, 'Browser acceptance retried');
if (mode === 'negative') {
  assert.notEqual(run.exitCode, 0, 'Unrecorded agent action passed');
  assert.match(JSON.stringify(run), /B3_REPLAY_MODEL_DISABLED/);
  const denials = (await readFile('.e2e/model-denials.jsonl', 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(denials.length > 0, 'The fail-closed descriptor was not reached');
  for (const denial of denials) assert.equal(denial.network, false);
} else {
  assert.equal(run.status, 'passed');
  assert.equal(run.exitCode, 0);
  assert.equal(run.summary.discovered, 3);
  assert.equal(run.summary.selected, 3);
  assert.equal(run.summary.executed, 3);
  assert.equal(run.summary.passed, 3);
  assert.equal(run.summary.skipped, 0);
  const acts = run.results.flatMap((result: any) => result.attempts.flatMap((attempt: any) => attempt.steps)).filter((step: any) => step.name === 'agent.act' || step.api === 'agent.act');
  if (mode === 'replay') {
    assert.equal(acts.length, 2, 'Required recorded navigation goals were absent');
    for (const act of acts) assert.equal(act.cache?.mode, 'self-finalized', 'Agent action did not finish by native replay');
    assert.ok((await readdir('.e2e/cache')).length > 0, 'No generated native recording');
  }
}
console.log(`Browser ${mode} evidence verified: zero calls/tokens and no retries.`);
