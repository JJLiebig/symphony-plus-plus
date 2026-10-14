import { execFile } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { contract, type Client } from './factory.js';

// Only disposable hosted fixtures invoke Git. Retain failed commands as well as
// successful ones; no Git authentication or global configuration is changed.
export async function git(root: string, cwd: string, ...args: string[]) {
  let receipt: object;
  try {
    const result = await promisify(execFile)('git', args, { cwd,
      env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Acceptance', GIT_AUTHOR_EMAIL: 'acceptance@example.invalid',
        GIT_COMMITTER_NAME: 'Acceptance', GIT_COMMITTER_EMAIL: 'acceptance@example.invalid' },
    });
    receipt = { cwd, args, ...result, exitCode: 0 };
    return result.stdout.trim();
  } catch (error: any) {
    receipt = { cwd, args, stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
    throw error;
  } finally {
    await appendFile(join('.e2e', 'worktree-git.jsonl'), `${JSON.stringify(receipt!)}\n`);
  }
}

export async function repository(root: string, name: string) {
  const origin = join(root, `${name}.git`);
  const checkout = join(root, name);
  await git(root, root, 'init', '--bare', origin);
  await git(root, root, 'init', '-b', 'beta', checkout);
  await writeFile(join(checkout, 'README.md'), 'Initial fixture content\n');
  await git(root, checkout, 'add', 'README.md');
  await git(root, checkout, 'commit', '-m', 'Initial fixture');
  await git(root, checkout, 'remote', 'add', 'origin', origin);
  await git(root, checkout, 'push', '-u', 'origin', 'beta');
  return { origin, checkout };
}

export async function workPackage(client: Client, origin: string, branch: string) {
  await client.request(`Worktree ${branch}`, 'ready_for_slicing', 'beta', origin);
  const [id] = (await client.call('slice_work_request', { work_packages: [contract('Owned worktree', { branch_pattern: branch })] })).work_package_ids;
  await client.call('dispatch_work_package', { work_package_id: id });
  return id as string;
}
