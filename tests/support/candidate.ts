import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test as base } from 'e2e';

export type CandidateOptions = { database?: string; offline?: boolean; surface?: 'worker' | 'architect' };

// A real candidate process, not the installed plugin or an in-process test harness.
export class Candidate {
  readonly database: string;
  readonly home: string;
  readonly logPath: string;
  readonly process: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number | string | null, { resolve: (response: any) => void; reject: (error: Error) => void }>();
  private log;

  constructor(root: string, name: string, private transport: 'stdio' | 'http' = 'stdio', provider?: { bin: string; endpoint: string }, options: CandidateOptions = {}) {
    this.home = join(root, name);
    this.database = options.database ?? join(this.home, 'ledger.sqlite3');
    this.logPath = resolve('.e2e', `${basename(root)}-${name}-${Date.now()}.txt`);
    this.log = createWriteStream(this.logPath);
    const args = transport === 'stdio'
      ? ['sympp.mcp', '--database', this.database, '--repo-root', resolve('.')]
      : ['sympp.cockpit', '--database', this.database, '--port', '0', '--no-open-dashboard',
        '--dashboard-origin', 'http://127.0.0.1:1'];
    this.process = spawn('mix', args, {
      cwd: resolve('elixir'),
      // Deliberate allowlist: no live provider, host authentication, or plugin settings.
      env: {
        PATH: provider ? `${provider.bin}${delimiter}${process.env.PATH}` : process.env.PATH,
        ...(provider ? { ACCEPTANCE_PROVIDER: provider.endpoint } : {}),
        ...(options.offline ? { SYMPP_OFFLINE_SANDBOX: '1' } : {}),
        ...(options.surface ? { SYMPP_MCP_SURFACE_PROFILE: options.surface } : {}),
        HOME: this.home,
        USERPROFILE: this.home,
        TMPDIR: root,
        MIX_ENV: 'dev',
        MIX_HOME: process.env.MIX_HOME,
        MIX_ARCHIVES: process.env.MIX_ARCHIVES,
        LANG: 'C.UTF-8',
        ELIXIR_ERL_OPTIONS: '+S 2:2 +fnu',
      },
      stdio: 'pipe',
    });
    this.process.stderr.pipe(this.log, { end: false });
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', (line) => {
      this.log.write(`${line}\n`);
      // Mix/log output is not a protocol response. Unknown response fields are tolerated.
      if (!line.startsWith('{') && !line.startsWith('[')) return;
      let response: any;
      try { response = JSON.parse(line); } catch { return; }
      const key = Array.isArray(response) ? 'batch' : response.id;
      const request = this.pending.get(key);
      if (!request) return;
      this.pending.delete(key);
      request.resolve(response);
    });
    this.process.on('error', (error) => this.fail(error));
    this.process.on('exit', (code, signal) => this.fail(new Error(`Candidate exited: ${code ?? signal}`)));
  }

  private fail(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  async request(method: string, params: object = {}) {
    const response = await this.rawRequest(method, params);
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result;
  }

  async rawRequest(method: string, params: object = {}) {
    const id = ++this.sequence;
    return this.rawPayload({ jsonrpc: '2.0', id, method, params }, id);
  }

  // Serial protocol fixtures can submit malformed requests and whole batches.
  // Responses still come exclusively from the candidate's actual stdout.
  async rawPayload(payload: unknown, key: number | string | null = Array.isArray(payload) ? 'batch' : null) {
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error('Candidate protocol response timed out'));
      }, 30_000);
      this.pending.set(key, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.process.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async stop() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      this.log.end();
      return;
    }
    const exited = once(this.process, 'exit');
    if (this.transport === 'http') this.process.kill('SIGTERM');
    else this.process.stdin.end();
    const timer = setTimeout(() => this.process.kill('SIGKILL'), 5_000);
    try { await exited; } finally { clearTimeout(timer); this.log.end(); }
  }
}

export const test = base.extend<{ candidates: { primary: Candidate; peer: Candidate; root: string } }>({
  candidates: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'sympp-acceptance-'));
    const started: Candidate[] = [];
    try {
      await mkdir('.e2e', { recursive: true });
      // Homes deliberately do not exist. Runtime bootstrap owns their creation.
      const primary = new Candidate(root, 'primary');
      started.push(primary);
      const peer = new Candidate(root, 'peer');
      started.push(peer);
      await use({ primary, peer, root });
    } finally {
      await Promise.all(started.map((candidate) => candidate.stop()));
      await rm(root, { recursive: true, force: true });
    }
  },
});
