import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, test as base } from 'e2e';

export class Installed {
  readonly env: NodeJS.ProcessEnv;
  readonly project: string;

  constructor(readonly root: string) {
    this.project = join(root, 'project');
    this.env = Object.fromEntries(['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PSModulePath']
      .filter(name => process.env[name]).map(name => [name, process.env[name]]));
    Object.assign(this.env, {
      HOME: join(root, 'profile'), USERPROFILE: join(root, 'profile'),
      APPDATA: join(root, 'profile', 'AppData', 'Roaming'), LOCALAPPDATA: join(root, 'profile', 'AppData', 'Local'),
      CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
      TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), npm_config_cache: join(root, 'npm-cache'),
      SYMPP_HOME: join(root, 'runtime'), SYMPP_DATABASE: join(root, 'runtime', 'ledger.sqlite3'),
      SYMPP_RUNTIME_FILE: join(root, 'runtime', 'runtime.json'), SYMPP_OPEN_DASHBOARD: '0',
      DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
    });
  }

  async prepare() {
    for (const path of [this.project, this.env.HOME!, this.env.TEMP!]) await mkdir(path, { recursive: true });
  }

  async run(command: string, args: string[], cwd = this.project, env = this.env) {
    const receipt = join('.e2e', `${basename(this.root)}-commands.jsonl`);
    await appendFile(receipt, JSON.stringify({ phase: 'request', command, args, cwd }) + '\n');
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(command, args, { cwd, env, windowsHide: true, timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolveResult({ code, stdout: stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''), stderr }));
    }).catch(async error => {
      await appendFile(receipt, JSON.stringify({ phase: 'failure', error: String(error) }) + '\n');
      throw error;
    });
    await appendFile(receipt, JSON.stringify({ phase: 'response', ...result }) + '\n');
    return result;
  }

  async ok(command: string, args: string[], cwd = this.project, env = this.env) {
    const result = await this.run(command, args, cwd, env);
    expect(result.code, `${command}: ${result.stdout}\n${result.stderr}`).toBe(0);
    return result.stdout;
  }

  skills(args: string[], cwd = this.project) {
    return this.ok(process.execPath, [resolve(dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js'),
      '--yes', 'skills@1.7.0', ...args], cwd);
  }

  async install(agent: 'codex' | 'claude-code', source = resolve('.'), copy = false) {
    await this.skills(['add', source, '--agent', agent, '--skill', 'symphony-plus-plus', '--yes', ...(copy ? ['--copy'] : [])]);
    return realpath(join(this.project, agent === 'codex' ? '.agents' : '.claude', 'skills/symphony-plus-plus'));
  }

  setup(bundle: string, host = 'both') {
    return this.run(process.execPath, [join(bundle, 'scripts/setup-sympp.js'), '--host', host]);
  }
}

export const test = base.extend<{ installed: Installed }>({
  installed: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'sympp-installed-'));
    await mkdir('.e2e', { recursive: true });
    const installed = new Installed(root);
    try { await installed.prepare(); await use(installed); } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
});
