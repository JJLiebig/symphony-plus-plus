import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
