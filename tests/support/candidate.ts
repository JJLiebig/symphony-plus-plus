import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test as base } from 'e2e';

type RpcResponse = { id: number; result?: any; error?: unknown };

// A real candidate process, not the installed plugin or an in-process test harness.
export class Candidate {
  readonly database: string;
  readonly home: string;
  readonly process: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve: (response: any) => void; reject: (error: Error) => void }>();
  private log;

  constructor(root: string, name: string) {
    this.home = join(root, name);
    this.database = join(this.home, 'ledger.sqlite3');
    this.log = createWriteStream(resolve('.e2e', `${name}.log`));
    this.process = spawn('mix', ['sympp.mcp', '--database', this.database, '--repo-root', resolve('.')], {
      cwd: resolve('elixir'),
      // Deliberate allowlist: no live provider, host authentication, or plugin settings.
      env: {
        PATH: process.env.PATH,
        HOME: this.home,
        USERPROFILE: this.home,
        TMPDIR: root,
        MIX_ENV: 'dev',
        MIX_HOME: process.env.MIX_HOME,
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
      if (!line.startsWith('{')) return;
      let response: RpcResponse;
      try { response = JSON.parse(line); } catch { return; }
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      if (response.error) request.reject(new Error(JSON.stringify(response.error)));
      else request.resolve(response.result);
    });
    this.process.on('error', (error) => this.fail(error));
    this.process.on('exit', (code, signal) => this.fail(new Error(`Candidate exited: ${code ?? signal}`)));
  }

  private fail(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  async request(method: string, params: object = {}) {
    const id = ++this.sequence;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Candidate ${method} response timed out`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
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
    this.process.stdin.end();
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
