import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { BrowserCandidate } from './browser-candidate.js';

// Qualify only the public discovery/command/parser contract, not live Review Suite.
export async function reviewRepository(candidate: BrowserCandidate) {
  const root = join(candidate.root, 'review-repository');
  const upstream = join(candidate.root, 'review-upstream.git');
  await mkdir(root);
  const receipt = join('.e2e', `${basename(candidate.root)}-review-setup.jsonl`);
  const git = async (args: string[]) => {
    try {
      const result = await promisify(execFile)('git', args, {
        cwd: root, timeout: 30_000,
        env: { PATH: process.env.PATH, HOME: candidate.factory!.home, USERPROFILE: candidate.factory!.home, GIT_CONFIG_NOSYSTEM: '1' },
      });
      await appendFile(receipt, `${JSON.stringify({ command: 'git', args, ...result, exitCode: 0 })}\n`);
    } catch (error: any) {
      await appendFile(receipt, `${JSON.stringify({ command: 'git', args, exitCode: error.code, stdout: error.stdout, stderr: error.stderr })}\n`);
      throw error;
    }
  };
  await git(['init', '--bare', upstream]);
  await git(['init', '-b', 'beta']);
  await git(['-c', 'user.name=Synthetic acceptance', '-c', 'user.email=acceptance@example.invalid', 'commit', '--allow-empty', '-m', 'Disposable review input']);
  await git(['remote', 'add', 'origin', upstream]);
  await git(['push', 'origin', 'beta']);
  return root;
}

export async function installReviewProvider(candidate: BrowserCandidate) {
  const version = 'b3-synthetic';
  const directory = join(candidate.factory!.home, '.codex/plugins/cache/review-suite/review-suite', version, 'scripts');
  await mkdir(directory, { recursive: true });
  const receipt = join(process.cwd(), '.e2e', `${basename(candidate.root)}-review-provider.jsonl`);
  const plugin = { installed: [{ pluginId: 'review-suite@review-suite', enabled: true, version }] };
  const command = join(candidate.root, 'provider-bin', 'codex');
  await writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ command: 'codex', argv }) + '\\n');
if (JSON.stringify(argv) !== JSON.stringify(['plugin', 'list', '--json'])) process.exit(1);
process.stdout.write(${JSON.stringify(JSON.stringify(plugin))});
`);
  await chmod(command, 0o755);
  const status = { review: 'rvw_b3_provider_wait', mode: 'fast', status: 'running', done: false, next_action: 'continue', progress: 'review 1/2 correctness', round: '1' };
  await writeFile(join(directory, 'review.py'), `import json, sys
with open(${JSON.stringify(receipt)}, 'a', encoding='utf-8') as output:
    output.write(json.dumps({'command': 'python', 'argv': sys.argv}) + '\\n')
if sys.argv[1:5] != ['--status', '--json', '--cd', sys.argv[4]]:
    raise SystemExit(1)
print(${JSON.stringify(JSON.stringify(status))})
`);
  return receipt;
}
