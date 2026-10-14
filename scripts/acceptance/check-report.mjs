import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// e2e permits a successful exit when all selected tests skip. This required gate
// must prove every discovered case ran once and used no model transport.
const { run } = JSON.parse(await readFile('.e2e/report.json', 'utf8'));
assert.equal(run.status, 'passed');
assert.equal(run.exitCode, 0);
assert.ok(run.summary.discovered > 0, 'No acceptance cases discovered');
assert.equal(run.summary.selected, run.summary.discovered);
assert.equal(run.summary.passed, run.summary.selected);
assert.equal(run.summary.executed, run.summary.selected);
assert.equal(run.usage.maxModelCallsInStep, 0);
assert.equal(run.usage.modelTokens, 0);
for (const result of run.results) {
  assert.equal(result.attempts.length, 1, 'Acceptance retried');
}
console.log('All discovered acceptance cases passed once with zero model calls and tokens.');
