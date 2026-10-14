import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expect, test as base } from 'e2e';
import { UpstreamProvider } from './upstream-provider.js';

const acknowledgement = '--i-understand-that-this-will-be-running-without-the-usual-guardrails';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class UpstreamRuntime {
  readonly workflow: string;
  readonly workspaces: string;
  readonly provider: UpstreamProvider;
  readonly logPath: string;
  process?: ChildProcessWithoutNullStreams;
  endpoint = '';
  private generation = 0;
  private logsRoot = '';

  constructor(readonly root: string) {
    this.workflow = join(root, 'WORKFLOW.md');
    this.workspaces = join(root, 'workspaces');
    this.logPath = resolve('.e2e', `${basename(root)}-candidate.txt`);
    this.provider = new UpstreamProvider(resolve('.e2e', `${basename(root)}-provider.jsonl`));
  }
  async configure(patch: any = {}, prompt = 'Work {{ issue.identifier }} / {{ issue.title }} / {{ issue.labels | join: "," }} / attempt={{ attempt }} / created={{ issue.created_at }}') {
    const config = {
      tracker: { kind: 'linear', endpoint: `${this.provider.endpoint}/graphql`, api_key: '$ACCEPTANCE_LINEAR_KEY',
        project_slug: 'upstream-project', assignee: 'worker', active_states: ['Todo', 'In Progress'], terminal_states: ['Done'] },
      polling: { interval_ms: 150 }, workspace: { root: '$ACCEPTANCE_WORKSPACES' },
      agent: { max_concurrent_agents: 1, max_turns: 2, max_retry_backoff_ms: 1500 },
      codex: { command: `${quote(process.execPath)} ${quote(resolve('tests/support/upstream-worker.mjs'))}`,
        approval_policy: 'never', thread_sandbox: 'workspace-write', read_timeout_ms: 5000,
        turn_timeout_ms: 30000, stall_timeout_ms: 0 },
      hooks: {
        after_create: 'printf "created\\n" >> lifecycle.txt',
        before_run: 'printf "before\\n" >> lifecycle.txt',
        after_run: 'printf "after\\n" >> lifecycle.txt',
        before_remove: `printf '%s\\n' "$PWD" >> ${quote(join(this.root, 'removed.txt'))}`,
      },
      server: { host: '127.0.0.1', port: 0 }, observability: { dashboard_enabled: false },
    };
    for (const [section, values] of Object.entries(patch)) Object.assign(config[section], values);
    // JSON is a YAML subset. This avoids a new fixture dependency.
    await writeFile(this.workflow, `---\n${JSON.stringify(config)}\n---\n${prompt}\n`);
  }
  async start(args?: string[], ready = args === undefined) {
    this.generation++;
    const logOption = args?.lastIndexOf('--logs-root') ?? -1;
    this.logsRoot = logOption >= 0 ? args![logOption + 1] : join(this.root, `run-${this.generation}`);
    const log = createWriteStream(this.logPath, { flags: 'a' });
    // Public CLI entrypoint; no TestSupport, ExUnit, application overrides or state injection.
    const child = spawn('mix', ['run', '--no-start', '--no-compile', '-e',
      'File.cd!(System.fetch_env!("ACCEPTANCE_CWD")); SymphonyElixir.CLI.main(System.argv())', '--',
      ...(args ? [...args, ...(logOption < 0 ? ['--logs-root', this.logsRoot] : [])]
        : [acknowledgement, '--port', '0', '--logs-root', this.logsRoot, this.workflow])], {
      cwd: resolve('elixir'), detached: true, stdio: 'pipe',
      env: { PATH: process.env.PATH, HOME: join(this.root, 'home'), USERPROFILE: join(this.root, 'home'),
        MIX_ENV: 'dev', MIX_HOME: process.env.MIX_HOME, MIX_ARCHIVES: process.env.MIX_ARCHIVES,
        LANG: 'C.UTF-8', ELIXIR_ERL_OPTIONS: '+S 2:2 +fnu', SYMPP_OPEN_DASHBOARD: 'false',
        ACCEPTANCE_UPSTREAM: this.provider.endpoint, ACCEPTANCE_WORKSPACES: this.workspaces, ACCEPTANCE_CWD: this.root,
        ACCEPTANCE_LINEAR_KEY: 'controlled-endpoint-only', TMPDIR: this.root },
    });
    this.process = child;
    this.provider.record({ kind: 'candidate_start', generation: this.generation,
      checkout: process.env.ACCEPTANCE_CHECKOUT_SHA, workflow: this.workflow });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once('close', () => log.end());
    if (!ready) return;
    // The public CLI redirects Logger to disk, including Phoenix's ephemeral port.
    await expect.poll(async () => {
      const match = (await this.runtimeLog()).match(/Running SymphonyElixirWeb.Endpoint.*127\.0\.0\.1:(\d+)/);
      if (match) this.endpoint = `http://127.0.0.1:${match[1]}`;
      return !!match;
    }, { timeout: 30000 }).toBe(true);
    await expect.poll(async () => (await this.state()).counts, { timeout: 10000 }).toBeDefined();
  }
  async request(path: string, method = 'GET') {
    const response = await fetch(`${this.endpoint}${path}`, { method, signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    this.provider.record({ kind: 'status', path, method, status: response.status, body });
    return { status: response.status, body };
  }
  async state() { return (await this.request('/api/v1/state')).body; }
  async refresh() { expect((await this.request('/api/v1/refresh', 'POST')).status).toBe(202); }
  async worker(identifier: string, turn = 1) {
    await expect.poll(() => this.provider.worker(identifier)?.turns.length ?? 0, { timeout: 20000 }).toBeGreaterThanOrEqual(turn);
    return this.provider.worker(identifier)!;
  }
  async lifecycle(identifier: string) { return readFile(join(this.workspaces, identifier, 'lifecycle.txt'), 'utf8'); }
  async runtimeLog() {
    const directory = join(this.logsRoot, 'log');
    const files = await readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    return (await Promise.all(files.filter((name) => /^symphony\.log\.\d+$/.test(name))
      .map((name) => readFile(join(directory, name), 'utf8')))).join('\n');
  }
  async api(operation: string, args: any) {
    const child = spawn('mix', ['run', '--no-start', '--no-compile', resolve('tests/support/provider-api.exs'),
      this.workflow, operation, JSON.stringify(args)], {
      cwd: resolve('elixir'), stdio: 'pipe',
      env: { PATH: process.env.PATH, HOME: join(this.root, 'home'), USERPROFILE: join(this.root, 'home'),
        MIX_ENV: 'dev', MIX_HOME: process.env.MIX_HOME, MIX_ARCHIVES: process.env.MIX_ARCHIVES,
        LANG: 'C.UTF-8', ELIXIR_ERL_OPTIONS: '+S 2:2 +fnu', ACCEPTANCE_WORKSPACES: this.workspaces,
        ACCEPTANCE_LINEAR_KEY: 'controlled-endpoint-only', TMPDIR: this.root },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    try {
      const [code] = await once(child, 'close');
      this.provider.record({ kind: 'public_tracker_api', operation, args, code, output });
      expect(code, output).toBe(0);
      const line = output.split('\n').find((line) => line.startsWith('{"provider_result":'));
      if (!line) throw new Error(`Missing tracker API result: ${output}`);
      return JSON.parse(line).provider_result;
    } finally { clearTimeout(timer); }
  }
  async stop() {
    const child = this.process;
    if (!child) return;
    const close = child.exitCode === null && child.signalCode === null ? once(child, 'close') : Promise.resolve();
    // Dedicated hosted process group: always release descendants before removing its temporary root.
    const killGroup = (signal: NodeJS.Signals) => {
      try { process.kill(-child.pid!, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    killGroup('SIGTERM');
    const timer = setTimeout(() => killGroup('SIGKILL'), 5000);
    try { await close; } finally {
      clearTimeout(timer); killGroup('SIGKILL'); this.process = undefined;
      await cp(join(this.logsRoot, 'log'), resolve('.e2e', `${basename(this.root)}-logs-${this.generation}`), { recursive: true })
        .catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

export const test = base.extend<{ upstream: UpstreamRuntime }>({
  upstream: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'sympp-upstream-'));
    await mkdir('.e2e', { recursive: true });
    await mkdir(join(root, 'home'));
    const upstream = new UpstreamRuntime(root);
    try {
      await upstream.provider.start();
      await upstream.configure();
      await use(upstream);
    } finally {
      await upstream.stop();
      await upstream.provider.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
});
