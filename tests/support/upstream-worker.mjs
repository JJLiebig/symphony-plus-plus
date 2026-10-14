// Controlled external app-server peer. Only hosted acceptance launches this file.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const endpoint = process.env.ACCEPTANCE_UPSTREAM;
const id = randomUUID();
const controller = new AbortController();
async function post(path, body) {
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, ...body }), signal: controller.signal,
  });
  if (!response.ok) throw new Error(`Worker peer HTTP ${response.status}`);
  return response.json();
}

await post('/worker/start', { cwd: process.cwd(), pid: process.pid });
const lines = createInterface({ input: process.stdin });
let pending = Promise.resolve();
lines.on('line', (line) => {
  pending = pending.then(async () => {
    const replies = await post('/worker/message', { message: JSON.parse(line) });
    for (const reply of replies) process.stdout.write(`${JSON.stringify(reply)}\n`);
  }).catch((error) => { console.error(error); process.exit(1); });
});
async function finish(reason, code) {
  try { await post('/worker/exit', { reason }); } finally {
    controller.abort();
    process.exit(code);
  }
}
lines.on('close', () => { void finish('stdin_closed', 0); });
process.on('SIGTERM', () => { void finish('sigterm', 0); });

try {
  while (true) {
    const commands = await post('/worker/next', {});
    for (const command of commands) {
      if ('exit' in command) await finish('controlled_exit', command.exit);
      else if ('raw' in command) process.stdout.write(command.raw);
      else process.stdout.write(`${JSON.stringify(command)}\n`);
    }
  }
} catch (error) {
  if (!controller.signal.aborted) { console.error(error); process.exit(1); }
}
