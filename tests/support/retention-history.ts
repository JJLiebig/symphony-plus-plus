import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { expect } from 'e2e';
import { type Client, type Factory } from './factory.js';

type Age = { table: 'sympp_work_requests' | 'sympp_solo_sessions'; id: string;
  column: 'inserted_at' | 'completed_at' | 'archived_at' | 'never_started_restored_at' | 'last_activity_at'; days: number };

// Hosted-only prepared history. Stop this disposable candidate before changing
// timestamps; every lifecycle action itself still goes through its public API.
export async function ageHistory(factory: Factory, ages: Age[]) {
  await factory.stop();
  const script = `import datetime,json,sqlite3,sys
db=sqlite3.connect(sys.argv[1])
with db:
 for row in json.loads(sys.argv[2]):
  stamp=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=row['days'])).strftime('%Y-%m-%d %H:%M:%S.%f')
  cursor=db.execute('UPDATE '+row['table']+' SET '+row['column']+' = ? WHERE id = ?', (stamp,row['id']))
  assert cursor.rowcount == 1, row['id']
db.close()
`;
  let result: object;
  try {
    result = { ...await promisify(execFile)('python3', ['-c', script, factory.database, JSON.stringify(ages)]), exitCode: 0 };
  } catch (error: any) {
    result = { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
    throw error;
  } finally {
    await appendFile(join('.e2e', `${basename(factory.root)}-history.jsonl`), `${JSON.stringify({ ages, result: result! })}\n`);
  }
}

export const requestPath = (id: string) => `/api/v1/sympp/operator/work-requests/${id}`;
export const detail = async (client: Client, id: string) => (await client.inspect(requestPath(id))).work_request;
export const archives = async (client: Client) => (await client.inspect('/api/v1/sympp/operator/dashboard?surface=archived')).archived_work_requests.work_requests;

export async function retention(client: Client, days = 30) {
  const result = await client.operator('/api/v1/sympp/operator/settings', {
    work_request_archive_after_days: 3, work_request_never_started_archive_after_days: days,
    solo_session_delete_after_days: 30, open_dashboard_on_boot: false,
  });
  expect(result.status).toBe(200);
  expect(result.body.settings.work_request_never_started_archive_after_days).toBe(days);
}

export async function unstarted(client: Client, title: string) {
  return (await client.call('create_work_request', { repo: 'example/retention', base_branch: 'beta',
    title, description: 'Disposable retention acceptance history.', request_kind: 'feature', status: 'draft',
  })).work_request.id as string;
}
