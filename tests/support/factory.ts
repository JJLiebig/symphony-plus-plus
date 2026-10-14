import { createInterface } from 'node:readline';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test as base } from 'e2e';
import { Candidate, type CandidateOptions } from './candidate.js';

// The public cockpit owns trusted local HTTP initialization, sessions and SQLite.
// The dashboard origin skips UI asset construction; no browser is opened or used.
export class Factory extends Candidate {
  readonly endpoint: Promise<string>;
  readonly receipt: string;

  constructor(readonly root: string, provider?: { bin: string; endpoint: string }, options: CandidateOptions & { name?: string } = {}) {
    super(root, options.name ?? 'factory', 'http', provider, options);
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

  reconnect(endpoint: string) {
    const client = new Client(endpoint, this.receipt);
    client.session = this.session;
    return client;
  }

  private async record(entry: object) {
    // Assertions inspect the actual response. Evidence never persists proof or
    // synthetic secret values deliberately submitted by the redaction journeys.
    if (this.receipt) await appendFile(this.receipt, `${JSON.stringify(entry, (key, value) => {
      if (/^(secret|secret_hash|proof_hash|token|authorization|work_key)$/i.test(key)) return '[REDACTED]';
      return typeof value === 'string' ? value.replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]').replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED]') : value;
    })}\n`);
  }

  private async exchange(url: string | URL, init: RequestInit, receipt: object) {
    await this.record({ ...receipt, phase: 'request' });
    let status: number | undefined;
    let rawBody: string | undefined;
    try {
      const response = await fetch(url, init);
      status = response.status;
      rawBody = await response.text();
      const body = rawBody === '' ? null : JSON.parse(rawBody);
      await this.record({ ...receipt, phase: 'response', status, response: body });
      return { response, body };
    } catch (error) {
      try {
        await this.record({ ...receipt, phase: 'failure', status, rawBody, error: String(error) });
      } finally {
        throw error;
      }
    }
  }

  async rpc(method: string, params: object = {}) {
    const { status, body } = await this.raw({ jsonrpc: '2.0', id: ++this.sequence, method, params });
    expect(status).toBe(200);
    return body;
  }

  async raw(payload: unknown, headers: Record<string, string> = {}, method = 'POST') {
    const { response, body } = await this.exchange(this.endpoint, {
      method,
      headers: { 'content-type': 'application/json', ...(this.session ? { 'mcp-session-id': this.session } : {}), ...headers },
      ...(method === 'POST' ? { body: typeof payload === 'string' ? payload : JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(30_000),
    }, { method, payload, headerNames: Object.keys(headers) });
    this.session = response.headers.get('mcp-session-id') ?? this.session;
    return { status: response.status, body };
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
    const { response, body } = await this.exchange(new URL(path, this.endpoint), {
      method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(this.endpoint).origin },
      body: JSON.stringify(args), signal: AbortSignal.timeout(30_000),
    }, { method: 'POST', path, args });
    return { status: response.status, body };
  }

  async inspect(path: string) {
    const { response, body } = await this.exchange(new URL(path, this.endpoint), {
      headers: { origin: new URL(this.endpoint).origin }, signal: AbortSignal.timeout(30_000),
    }, { method: 'GET', path });
    expect(response.status).toBe(200);
    return body;
  }

  async request(title: string, status = 'ready_for_slicing', baseBranch = 'beta', repo = 'example/service') {
    const created = await this.call('create_work_request', {
      repo, base_branch: baseBranch, title,
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
