import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expect, test as base } from 'e2e';
import { Candidate, type CandidateOptions } from './candidate.js';
import { Client, Factory, contract } from './factory.js';

export const initialize = {
  protocolVersion: '2025-03-26', capabilities: {},
  clientInfo: { name: 'authority-acceptance', version: '1.0.0' },
};

export const tool = (name: string, args: object = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

export async function worker(factory: Factory, id: string, owner = 'acceptance-worker') {
  const client = await factory.client();
  const claimed = await client.call('claim_local_assignment', { work_package_id: id, claimed_by: owner });
  expect(claimed.assignment.grant_role).toBe('worker');
  expect(claimed.assignment.work_package_id).toBe(id);
  return client;
}

export async function packages(architect: Client, titles: string[]) {
  const ids = (await architect.call('slice_work_request', { work_packages: titles.map((title) => contract(title, { branch_pattern: 'feature/authority' })) })).work_package_ids;
  for (const id of ids) await architect.call('dispatch_work_package', { work_package_id: id });
  return ids as string[];
}

export async function snapshot(factory: Factory) {
  const destination = join(factory.root, 'offline', 'ledger.sqlite3');
  const args = [resolve('scripts/sympp_beta_snapshot.py'), 'snapshot', factory.database, destination,
    '--sandbox-root', join(factory.root, 'offline'), '--migrate', 'mix', 'sympp.beta_migrate'];
  // Exercise the supported snapshot operation; never patch the SQLite marker or
  // historical authority rows ourselves. This function runs only in hosted CI.
  let receipt: object;
  try {
    receipt = { command: 'python3', args, ...await promisify(execFile)('python3', args, {
      cwd: resolve('elixir'), timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: factory.home, USERPROFILE: factory.home, TMPDIR: factory.root,
        MIX_ENV: 'dev', MIX_HOME: process.env.MIX_HOME, MIX_ARCHIVES: process.env.MIX_ARCHIVES, LANG: 'C.UTF-8', ELIXIR_ERL_OPTIONS: '+S 2:2 +fnu' },
    }), exitCode: 0 };
  } catch (error: any) {
    receipt = { command: 'python3', args, stdout: error.stdout, stderr: error.stderr, exitCode: error.code, error: String(error) };
    throw error;
  } finally {
    await writeFile(join('.e2e', `${basename(factory.root)}-snapshot.json`), JSON.stringify(receipt!, null, 2));
  }
  return destination;
}

export const test = base.extend<{ processes: {
  root: string;
  factory: (name?: string, options?: CandidateOptions) => Factory;
  stdio: (name: string, options?: CandidateOptions) => Candidate;
} }>({
  processes: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'sympp-authority-'));
    await mkdir('.e2e', { recursive: true });
    const started: Candidate[] = [];
    const remember = <T extends Candidate>(candidate: T): T => { started.push(candidate); return candidate; };
    try {
      await use({
        root,
        factory: (name = 'factory', options = {}) => remember(new Factory(root, undefined, { ...options, name })),
        stdio: (name, options = {}) => remember(new Candidate(root, name, 'stdio', undefined, options)),
      });
    } finally {
      await Promise.all(started.map((candidate) => candidate.stop()));
      await rm(root, { recursive: true, force: true });
    }
  },
});
