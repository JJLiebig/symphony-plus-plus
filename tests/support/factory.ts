import { createInterface } from 'node:readline';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test as base } from 'e2e';
import { Candidate } from './candidate.js';

// The public cockpit owns trusted local HTTP initialization, sessions and SQLite.
// The dashboard origin skips UI asset construction; no browser is opened or used.
export class Factory extends Candidate {
  readonly endpoint: Promise<string>;
  private receipt: string;

  constructor(root: string, provider?: { bin: string; endpoint: string }) {
    super(root, 'factory', 'http', provider);
    this.receipt = join('.e2e', `${basename(root)}-mcp.jsonl`);
    this.endpoint = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Candidate cockpit startup timed out')), 30_000);
      const lines = createInterface({ input: this.process.stdout });
      lines.on('line', (line) => {
        const match = line.match(/Symphony\+\+ API bridge: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(`${match[1]}/mcp`); lines.close(); }
      });
      this.process.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Cockpit exited: ${code}`)); });
      this.process.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
  }

  async client() {
    const client = new Client(await this.endpoint, this.receipt);
    const initialized = await client.rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'factory-acceptance', version: '1.0.0' },
    });
    expect(initialized.result.protocolVersion).toBe('2025-03-26');
    const health = await client.call('sympp.health');
    expect(health.status).toBe('ok');
    expect(health.source.revision).toBe(process.env.ACCEPTANCE_CHECKOUT_SHA);
    expect(health.ledger.identity.default_home).toBe(false);
    return client;
  }
}

export class Client {
  private sequence = 0;
  private session?: string;

  constructor(private endpoint: string, private receipt?: string) {}

  async rpc(method: string, params: object = {}) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.session ? { 'mcp-session-id': this.session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.sequence, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    expect(response.status).toBe(200);
    this.session = response.headers.get('mcp-session-id') ?? this.session;
    const result = await response.json();
    if (this.receipt) await appendFile(this.receipt, `${JSON.stringify({ method, params, response: result })}\n`);
    return result;
  }

  async call(name: string, args: object = {}) {
    const response = await this.rpc('tools/call', { name, arguments: args });
    expect(response.error, `${name}: ${JSON.stringify(response.error)}`).toBeUndefined();
    expect(response.result.isError).not.toBe(true);
    return response.result.structuredContent;
  }

  async reject(name: string, args: object, reason: string) {
    const response = await this.rpc('tools/call', { name, arguments: args });
    expect(response.error?.data?.reason).toBe(reason);
    return response.error.data;
  }

  async operator(path: string, args: object) {
    const response = await fetch(new URL(path, this.endpoint), {
      method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(this.endpoint).origin },
      body: JSON.stringify(args), signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: await response.json() };
  }

  async inspect(path: string) {
    const response = await fetch(new URL(path, this.endpoint), {
      headers: { origin: new URL(this.endpoint).origin }, signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    if (this.receipt) await appendFile(this.receipt, `${JSON.stringify({ method: 'GET', path, status: response.status, response: result })}\n`);
    expect(response.status).toBe(200);
    return result;
  }

  async request(title: string, status = 'ready_for_slicing', baseBranch = 'beta') {
    const created = await this.call('create_work_request', {
      repo: 'example/service', base_branch: baseBranch, title,
      description: 'Synthetic acceptance request; no external work is executed.',
      request_kind: 'feature', status, claimed_by: 'acceptance-architect',
      repo_scopes: [{ repo: 'example/client', base_branch: 'integration' }],
    });
    expect(created.status).toBe('created');
    expect(created.work_request.creator).toEqual({ kind: 'agent', name: 'acceptance-architect', via: 'mcp' });
    const id = created.work_request.id;
    const unclaimed = await this.call('read_work_request', { work_request_id: id });
    expect(unclaimed.work_request.status).toBe(status);
    const claimed = await this.call('claim_local_architect_assignment', {
      work_request_id: id, claimed_by: 'acceptance-architect',
    });
    expect(claimed.assignment.grant_role).toBe('architect');
    return id;
  }
}

export function contract(title: string, patch: object = {}) {
  return {
    title, goal: `Deliver ${title}`, allowed_file_globs: ['src/**'],
    forbidden_file_globs: ['secrets/**'], acceptance_criteria: ['The agreed behavior is available.'],
    validation_steps: ['Run relevant hosted checks.'], stop_conditions: ['Return material scope changes to the architect.'],
    ...patch,
  };
}

export const test = base.extend<{ factory: Factory }>({
  factory: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'sympp-factory-'));
    await mkdir('.e2e', { recursive: true });
    const factory = new Factory(root);
    try { await use(factory); } finally {
      await factory.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
});
