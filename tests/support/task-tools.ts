import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { test as base } from 'e2e';

// Only candidate CLI entrypoints run here. Controlled PATH programs stand in for
// external commands, never for the task or its persistence/HTTP implementation.
class TaskProcess {
  readonly process: ChildProcessWithoutNullStreams;
  output = '';
  readonly exited: Promise<number | null>;

  constructor(args: string[], root: string, bin: string, env: Record<string, string>, receipt: string) {
    this.process = spawn('mix', args, {
      cwd: resolve('elixir'),
      env: {
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), TMPDIR: root,
        MIX_ENV: 'dev', MIX_HOME: process.env.MIX_HOME, MIX_ARCHIVES: process.env.MIX_ARCHIVES,
        LANG: 'C.UTF-8', ELIXIR_ERL_OPTIONS: '+S 2:2 +fnu', ...env,
      },
      stdio: 'pipe',
    });
    this.process.stdout.on('data', (chunk) => { this.output += chunk.toString(); });
    this.process.stderr.on('data', (chunk) => { this.output += chunk.toString(); });
    this.exited = new Promise((resolve, reject) => {
      this.process.once('error', reject);
      this.process.once('exit', async (code, signal) => {
        try {
          await appendFile(receipt, `${JSON.stringify({ args, code, signal, output: this.output })}\n`);
          resolve(code);
        } catch (error) { reject(error); }
      });
    });
  }

  async stop() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = once(this.process, 'exit');
    this.process.kill('SIGTERM');
    const timer = setTimeout(() => this.process.kill('SIGKILL'), 5_000);
    try { await exited; } finally { clearTimeout(timer); }
    await this.exited;
  }
}

export const test = base.extend<{ tasks: {
  root: string; bin: string;
  start: (args: string[], env?: Record<string, string>) => TaskProcess;
  run: (args: string[], env?: Record<string, string>) => Promise<{ code: number | null; output: string }>;
} }>({
  tasks: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'sympp-tasks-'));
    const bin = join(root, 'bin');
    const children: TaskProcess[] = [];
    await mkdir(bin);
    await mkdir('.e2e', { recursive: true });
    const start = (args: string[], env: Record<string, string> = {}) => {
      const child = new TaskProcess(args, root, bin, env, join('.e2e', `${basename(root)}-cli.jsonl`));
      children.push(child);
      return child;
    };
    try {
      await use({ root, bin, start, run: async (args, env) => {
        const child = start(args, env);
        return { code: await child.exited, output: child.output };
      } });
    } finally {
      await Promise.all(children.map((child) => child.stop()));
      await rm(root, { recursive: true, force: true });
    }
  },
});
