import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { BrowserCandidate } from './browser-candidate.js';
import { Client } from './factory.js';

// Qualify only the public discovery/command/parser contract, not live Review Suite.
export async function installReviewProvider(candidate: Pick<BrowserCandidate, 'root' | 'factory'>, status: object = {
  review: 'rvw_b3_provider_wait', mode: 'fast', status: 'running', done: false, next_action: 'continue', progress: 'review 1/2 correctness', round: '1',
}) {
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
  await writeFile(join(directory, 'review.py'), `import json, sys
with open(${JSON.stringify(receipt)}, 'a', encoding='utf-8') as output:
    output.write(json.dumps({'command': 'python', 'argv': sys.argv}) + '\\n')
if sys.argv[1:5] != ['--status', '--json', '--cd', sys.argv[4]]:
    raise SystemExit(1)
print(${JSON.stringify(JSON.stringify(status))})
`);
  // Hydrated projection takes its graph snapshot before refreshing review status.
  // Finish that public refresh during provider setup; first-read freshness is not
  // qualified by these journeys. No cache/ledger injection or timing sleep.
  await new Client(await candidate.factory!.endpoint).inspect('/api/v1/sympp/operator/dashboard/hydrated');
  return receipt;
}
