import { spawn } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test as base } from 'e2e';
import { Factory } from './factory.js';

export class OfflineCopy {
  readonly home: string;
  readonly database: string;
  readonly commands: string;
  readonly bin: string;
  readonly processes: Factory[] = [];

  constructor(readonly root: string) {
    this.home = join(root, 'offline-home');
    this.database = join(this.home, 'ledger.sqlite3');
    this.commands = join(root, 'external-commands.txt');
    this.bin = join(root, 'bin');
  }

  async prepare() {
    await mkdir(this.bin);
    for (const name of ['git', 'gh', 'codex', 'claude', 'herdr', 'review-suite']) {
      const file = join(this.bin, name);
      // Source identity performs this one local Git read. Keep its real answer;
      // trap every provider/agent/worktree operation instead of injecting a SHA.
      const revisionRead = name === 'git'
        ? `if [ "$#" = 5 ] && [ "$1" = '-C' ] && [ "$2" = '${resolve('.')}' ] && [ "$3" = 'rev-parse' ] && [ "$4" = '--verify' ] && [ "$5" = 'HEAD' ]; then exec /usr/bin/git "$@"; fi\n`
        : '';
      await writeFile(file, `#!/bin/sh\n${revisionRead}printf '%s\\n' '${name}' >> '${this.commands}'\nexit 93\n`);
      await chmod(file, 0o700);
    }
  }

  start(name: string, offline = false) {
    const process = new Factory(this.root, { bin: this.bin, endpoint: 'http://127.0.0.1:1' }, {
      name, ...(offline ? { database: this.database, offline: true } : {}),
    });
    this.processes.push(process);
    return process;
  }

  async command(args: string[]) {
    const receipt = join('.e2e', `${basename(this.root)}-snapshot.jsonl`);
    await appendFile(receipt, JSON.stringify({ phase: 'request', command: 'python3', args }) + '\n');
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn('python3', [resolve('scripts/sympp_beta_snapshot.py'), ...args], {
        cwd: resolve('elixir'),
        env: { PATH: process.env.PATH, HOME: this.home, USERPROFILE: this.home, TMPDIR: this.root,
          SYMPP_OFFLINE_SANDBOX: '1', MIX_ENV: 'dev', MIX_HOME: process.env.MIX_HOME,
          MIX_ARCHIVES: process.env.MIX_ARCHIVES, LANG: 'C.UTF-8', ELIXIR_ERL_OPTIONS: '+S 2:2 +fnu' },
        timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolveResult({ code, stdout, stderr }));
    }).catch(async error => {
      await appendFile(receipt, JSON.stringify({ phase: 'failure', error: String(error) }) + '\n');
      throw error;
    });
    await appendFile(receipt, JSON.stringify({ phase: 'response', ...result }) + '\n');
    return result;
  }

  snapshot(source: Factory, replace = false) {
    return this.command(['snapshot', source.database, this.database, '--sandbox-root', this.home,
      ...(replace ? ['--replace'] : []), '--migrate', 'mix', 'sympp.beta_migrate']);
  }
}

export const test = base.extend<{ copy: OfflineCopy }>({
  copy: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'sympp-offline-'));
    await mkdir('.e2e', { recursive: true });
    const copy = new OfflineCopy(root);
    try { await copy.prepare(); await use(copy); } finally {
      await Promise.all(copy.processes.map(process => process.stop()));
      await rm(root, { recursive: true, force: true });
    }
  },
});
