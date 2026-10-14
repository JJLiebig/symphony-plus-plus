import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFile, chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expect, test as base } from 'e2e';
import { Factory, type Client } from './factory.js';

type Reply = { stdout: string; exitCode: number };

// Own only the external gh protocol. The real factory, adapter and OS child
// invocation remain unchanged. This does not qualify gh or GitHub compatibility.
export class Provider {
  readonly replies = new Map<number, Reply>();
  readonly apiReplies = new Map<string, Reply>();
  readonly calls: { argv: string[]; reply: Reply }[] = [];
  readonly server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { argv } = JSON.parse(body);
    let reply: Reply = { stdout: 'Unexpected synthetic provider command', exitCode: 1 };
    if (JSON.stringify(argv) === JSON.stringify(['auth', 'status', '--hostname', 'github.com'])) {
      reply = { stdout: 'Synthetic protocol available', exitCode: 0 };
    } else if (argv.length === 6 && JSON.stringify(argv.slice(0, 5)) ===
      JSON.stringify(['api', '--hostname', 'github.com', '--method', 'GET'])) {
      reply = this.apiReplies.get(argv[5]) ?? { stdout: 'HTTP 404 synthetic API not found', exitCode: 1 };
    } else if (argv.length === 7 && argv[0] === 'pr' && argv[1] === 'view' &&
      /^\d+$/.test(argv[2]) && argv[3] === '--repo' && ['example/service', 'example/client'].includes(argv[4]) && argv[5] === '--json') {
      reply = this.replies.get(Number(argv[2])) ?? { stdout: 'HTTP 404 synthetic PR not found', exitCode: 1 };
    }
    this.calls.push({ argv, reply });
    await appendFile(this.receipt, `${JSON.stringify({ argv, reply })}\n`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply));
  });
  constructor(private receipt: string) {}

  set(number: number, metadata: object) {
    this.replies.set(number, { stdout: JSON.stringify(metadata), exitCode: 0 });
  }

  async start(root: string) {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address() as { port: number };
    const bin = join(root, 'provider-bin');
    await mkdir(bin);
    await copyFile(resolve('tests/support/provider-cli.mjs'), join(bin, 'gh'));
    await chmod(join(bin, 'gh'), 0o755);
    return { bin, endpoint: `http://127.0.0.1:${address.port}` };
  }

  async stop() {
    const closed = once(this.server, 'close');
    this.server.close();
    this.server.closeAllConnections();
    await closed;
  }
}

export const test = base.extend<{ delivery: { factory: Factory; provider: Provider } }>({
  delivery: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'sympp-delivery-'));
    await mkdir('.e2e', { recursive: true });
    const provider = new Provider(join('.e2e', `${basename(root)}-provider.jsonl`));
    let factory: Factory | undefined;
    try {
      factory = new Factory(root, await provider.start(root));
      await use({ factory, provider });
    } finally {
      await factory?.stop();
      await provider.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
});

export const head = (digit: string) => digit.repeat(40);
export const prUrl = (number: number) => `https://github.com/example/service/pull/${number}`;

export function pr(number: number, sha: string, patch: object = {}) {
  return {
    id: `PR_synthetic_${number}`, number, url: prUrl(number),
    headRefName: `feature/delivery-${number}`, headRefOid: sha,
    baseRefName: 'beta', baseRefOid: head('0'), changedFiles: 1,
    files: [{ path: 'src/service.ts', changeType: 'MODIFIED' }],
    statusCheckRollup: [{ name: 'required', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    reviewDecision: 'APPROVED', state: 'OPEN', isDraft: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T11:00:00Z',
    mergedAt: null, mergeCommit: null, ...patch,
  };
}

export async function board(client: Client, request: string) {
  return (await client.call('read_delivery_board', { work_request_id: request })).delivery_board;
}

export async function row(client: Client, request: string, wp: string) {
  const result = (await board(client, request)).work_packages.find((item: any) => item.id === wp);
  expect(result).toBeTruthy();
  return result;
}

export async function close(client: Client, wp: string, outcome = 'completed_no_pr', evidence: object = { no_pr_evidence: 'The architect accepted the investigation findings; no code change was needed.' }) {
  return client.call('record_work_package_delivery', {
    work_package_id: wp, outcome, idempotency_key: `close-${wp}`,
    evidence: { [outcome]: evidence },
  });
}

export async function sync(client: Client, wp: string, number: number, sha: string) {
  return client.call('sync_pr', { work_package_id: wp, url: prUrl(number), head_sha: sha });
}
