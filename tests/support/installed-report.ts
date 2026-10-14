import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// B1 jobs select one owned file from the shared API target. Unrelated filtered
// definitions are not skips in this gate; every definition in its file is owed.
const expected = new Map([
  ['tests/acceptance/installed-runtime.e2e.ts', 3],
  ['tests/acceptance/offline-copy.e2e.ts', 1],
]);
const file = process.argv[2];
assert.ok(expected.has(file), 'Select a B1 acceptance file');
const { run } = JSON.parse(await readFile('.e2e/report.json', 'utf8'));
assert.equal(run.status, 'passed');
assert.equal(run.exitCode, 0);
assert.equal(run.summary.selected, expected.get(file));
assert.equal(run.summary.executed, expected.get(file));
assert.equal(run.summary.passed, expected.get(file));
assert.equal(run.usage.maxModelCallsInStep, 0);
assert.equal(run.usage.modelTokens, 0);
const owned = run.results.filter((result: any) => result.file.replaceAll('\\', '/') === file);
assert.equal(owned.length, expected.get(file));
for (const result of owned) {
  assert.equal(result.selected, true);
  assert.equal(result.status, 'passed');
  assert.equal(result.attempts.length, 1, 'Acceptance retried');
}
assert.equal(run.results.filter((result: any) => result.selected).length, owned.length);
console.log(`${owned.length} required ${file} cases passed once with zero model calls and tokens.`);
