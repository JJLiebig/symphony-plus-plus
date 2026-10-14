import { expect } from 'e2e';
import { access, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from '../support/authority.js';
import { git, repository, workPackage } from '../support/worktree-git.js';

const exists = async (path: string) => access(path).then(() => true, () => false);

test('real worktree prepare and replay preserve branch scope and clean only the recorded owned checkout', async ({ processes }) => {
  const { root } = processes;
  const repo = await repository(root, 'source');
  const foreign = await repository(root, 'foreign');
  const factory = processes.factory();
  const client = await factory.client();
  const wp = await workPackage(client, repo.origin, 'feature/owned');
  const args = { work_package_id: wp, target_repo_root: repo.checkout };
  await client.reject('prepare_work_package_worktree', { ...args, target_repo_root: foreign.checkout }, 'target_repo_root_scope_mismatch');
  await client.reject('prepare_work_package_worktree', { ...args, branch: 'feature/wrong' }, 'branch_scope_mismatch');
  const prepared = await client.call('prepare_work_package_worktree', args);
  const path = prepared.worktree.path;
  expect(prepared.worktree.status).toBe('prepared');
  expect(prepared.work_package.worktree_path).toBe(path);
  expect(await git(root, path, 'branch', '--show-current')).toBe('feature/owned');
  expect(await git(root, path, 'rev-parse', 'HEAD')).toBe(await git(root, repo.checkout, 'rev-parse', 'origin/beta'));
  expect((await client.call('prepare_work_package_worktree', args)).worktree.path).toBe(path);
  expect((await client.call('prepare_work_package_worktree', args)).worktree.status).toBe('already_prepared');
  const clone = join(root, 'same-origin');
  await git(root, root, 'clone', '--branch', 'beta', repo.origin, clone);
  await writeFile(join(path, 'untracked.txt'), 'Owned disposable work\n');
  await writeFile(join(clone, 'unrelated.txt'), 'Keep foreign clone content\n');
  await client.reject('cleanup_work_package_worktree', { ...args, target_repo_root: clone }, 'invalid_worktree_path');
  await client.reject('cleanup_work_package_worktree', { ...args, target_repo_root: foreign.checkout }, 'target_repo_root_scope_mismatch');
  expect(await readFile(join(path, 'untracked.txt'), 'utf8')).toBe('Owned disposable work\n');
  expect(await readFile(join(clone, 'unrelated.txt'), 'utf8')).toBe('Keep foreign clone content\n');
  const cleaned = await client.call('cleanup_work_package_worktree', args);
  expect(cleaned.worktree.status).toBe('cleaned');
  expect(cleaned.work_package.worktree_path).toBeNull();
  expect(await exists(path)).toBe(false);
  expect(await readFile(join(clone, 'unrelated.txt'), 'utf8')).toBe('Keep foreign clone content\n');
  expect(await readFile(join(foreign.checkout, 'README.md'), 'utf8')).toBe('Initial fixture content\n');
  expect((await client.call('cleanup_work_package_worktree', args)).worktree.status).toBe('already_clean');
  const again = await client.call('prepare_work_package_worktree', args);
  expect(again.worktree.status).toBe('prepared');
  expect((await client.call('cleanup_work_package_worktree', args)).worktree.status).toBe('cleaned');
});

test('outside-root path substitution is refused without deleting unrelated content and recovery cleans the owned path', async ({ processes }) => {
  const { root } = processes;
  const repo = await repository(root, 'source');
  const factory = processes.factory();
  const client = await factory.client();
  const wp = await workPackage(client, repo.origin, 'feature/safe-path');
  const args = { work_package_id: wp, target_repo_root: repo.checkout };
  const path = (await client.call('prepare_work_package_worktree', args)).worktree.path;
  const saved = `${path}-saved`;
  const unrelated = join(root, 'unrelated');
  await mkdir(unrelated);
  await writeFile(join(unrelated, 'keep.txt'), 'Unrelated data\n');
  await rename(path, saved);
  await symlink(unrelated, path, 'dir');
  try {
    await client.reject('cleanup_work_package_worktree', args, 'unsafe_worktree_path');
    expect(await readFile(join(unrelated, 'keep.txt'), 'utf8')).toBe('Unrelated data\n');
    expect((await client.call('read_work_package', { work_package_id: wp })).work_package.worktree_path).toBe(path);
  } finally {
    await rm(path);
    await rename(saved, path);
  }
  expect((await client.call('cleanup_work_package_worktree', args)).worktree.status).toBe('cleaned');
  expect(await exists(path)).toBe(false);
  expect(await readFile(join(unrelated, 'keep.txt'), 'utf8')).toBe('Unrelated data\n');
});

test('a real Git removal obstruction preserves the worktree and a later cleanup recovers after restart', async ({ processes }) => {
  const { root } = processes;
  const repo = await repository(root, 'source');
  let factory = processes.factory();
  let client = await factory.client();
  const wp = await workPackage(client, repo.origin, 'feature/recovery');
  const args = { work_package_id: wp, target_repo_root: repo.checkout };
  const path = (await client.call('prepare_work_package_worktree', args)).worktree.path;
  await git(root, repo.checkout, 'worktree', 'lock', path);
  const failed = await client.rpc('tools/call', { name: 'cleanup_work_package_worktree', arguments: args });
  expect(failed.error || failed.result?.structuredContent?.worktree?.status === 'cleanup_queued').toBeTruthy();
  expect(await exists(path)).toBe(true);
  expect((await client.call('read_work_package', { work_package_id: wp })).work_package.worktree_path).toBe(path);
  await factory.stop();
  await git(root, repo.checkout, 'worktree', 'unlock', path);
  factory = processes.factory();
  client = await factory.client();
  await client.call('claim_local_architect_assignment', { work_request_id: (await client.call('list_work_requests')).work_requests[0].id, claimed_by: 'acceptance-architect' });
  const recovered = await client.call('cleanup_work_package_worktree', args);
  expect(['cleaned', 'already_clean']).toContain(recovered.worktree.status);
  expect(recovered.work_package.worktree_path).toBeNull();
  expect(await exists(path)).toBe(false);
  expect(await readFile(join(repo.checkout, 'README.md'), 'utf8')).toBe('Initial fixture content\n');
});
