import { createServer, type ServerResponse } from 'node:http';
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

export function issue(identifier: string, patch: any = {}) {
  return {
    id: identifier, identifier, title: `Deliver ${identifier}`, description: 'Independent upstream acceptance',
    priority: 2, state: { name: 'Todo' }, assignee: { id: 'worker' },
    branchName: `work/${identifier}`, url: `https://example.invalid/${identifier}`,
    labels: { nodes: [{ name: 'UPSTREAM' }] }, inverseRelations: { nodes: [] },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...patch,
  };
}

type Worker = { id: string; cwd: string; pid: number; messages: any[]; turns: any[]; exited?: string; queue: any[]; waiting?: ServerResponse };
type Fault = { status: number; body: any };

// This is the external provider, not a replacement tracker or orchestrator.
export class UpstreamProvider {
  issues: any[] = [];
  workers: Worker[] = [];
  requests: any[] = [];
  pollFault?: Fault;
  refreshFault?: Fault;
  toolReply: Fault = { status: 200, body: { data: { viewer: { id: 'external-viewer' } } } };
  mutationSuccess = true;
  stateAvailable = true;
  pageSize = 2;
  initializePadding = '';
  endpoint = '';
  private server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const reply = (payload: any, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (request.url === '/graphql') {
        // Preserve wire input and result, never authorization values.
        const receipt = { ...body, authenticated: Boolean(request.headers.authorization) };
        this.requests.push(receipt);
        let result: Fault;
        const variables = body.variables ?? {};
        if (body.query.includes('SymphonyLinearIssuesById')) {
          result = this.refreshFault ?? { status: 200, body: { data: { issues: {
            nodes: this.issues.filter((row) => variables.ids.includes(row.id)),
          } } } };
        } else if (body.query.includes('SymphonyLinearPoll')) {
          const candidates = this.issues.filter((row) => variables.stateNames.includes(row.state.name));
          const offset = variables.after ? Number(variables.after) : 0;
          const nodes = candidates.slice(offset, offset + this.pageSize);
          result = this.pollFault ?? { status: 200, body: { data: { issues: { nodes,
            pageInfo: { hasNextPage: offset + nodes.length < candidates.length, endCursor: String(offset + nodes.length) },
          } } } };
        } else if (body.query.includes('SymphonyLinearViewer')) {
          result = { status: 200, body: { data: { viewer: { id: 'worker' } } } };
        } else if (body.query.includes('SymphonyCreateComment')) {
          result = { status: 200, body: { data: { commentCreate: { success: this.mutationSuccess } } } };
        } else if (body.query.includes('SymphonyResolveStateId')) {
          result = { status: 200, body: { data: { issue: { team: { states: { nodes: this.stateAvailable ? [{ id: 'resolved-state' }] : [] } } } } } };
        } else if (body.query.includes('SymphonyUpdateIssueState')) {
          result = { status: 200, body: { data: { issueUpdate: { success: this.mutationSuccess } } } };
        } else result = this.toolReply;
        this.record({ kind: 'graphql', request: receipt, response: result });
        reply(result.body, result.status);
      } else if (request.url === '/worker/start') {
        this.workers.push({ ...body, messages: [], turns: [], queue: [] });
        this.record({ kind: 'worker_start', ...body });
        reply({});
      } else {
        const worker = this.workers.find((row) => row.id === body.id);
        if (!worker) { reply({ error: 'Unknown controlled worker' }, 404); return; }
        if (request.url === '/worker/next') {
          if (worker.queue.length) reply(worker.queue.splice(0));
          else {
            worker.waiting = response;
            response.on('close', () => { if (worker.waiting === response) worker.waiting = undefined; });
          }
        } else if (request.url === '/worker/exit') {
          worker.exited = body.reason;
          this.record({ kind: 'worker_exit', ...body });
          reply({});
        } else if (request.url === '/worker/message') {
          const message = body.message;
          worker.messages.push(message);
          this.record({ kind: 'worker_message', id: body.id, message });
          if (message.method === 'initialize') reply([{ id: message.id, result: { userAgent: 'controlled-peer' }, padding: this.initializePadding }]);
          else if (message.method === 'thread/start') reply([{ id: message.id, result: { thread: { id: worker.id } } }]);
          else if (message.method === 'turn/start') {
            worker.turns.push(message);
            reply([{ id: message.id, result: { turn: { id: `turn-${worker.turns.length}` } } }]);
          } else reply([]);
        } else reply({ error: 'Unknown fixture route' }, 404);
      }
    })().catch((error) => {
      this.record({ kind: 'provider_error', error: String(error) });
      response.writeHead(500).end();
    });
  });

  constructor(private receipt: string) {}
  record(entry: object) { appendFileSync(this.receipt, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); }
  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing provider address');
    this.endpoint = `http://127.0.0.1:${address.port}`;
  }
  worker(identifier: string) { return this.workers.filter((row) => basename(row.cwd) === identifier).at(-1); }
  send(worker: Worker, ...messages: any[]) {
    this.record({ kind: 'worker_send', id: worker.id, messages });
    worker.queue.push(...messages);
    if (worker.waiting) {
      worker.waiting.writeHead(200, { 'content-type': 'application/json' });
      worker.waiting.end(JSON.stringify(worker.queue.splice(0)));
      worker.waiting = undefined;
    }
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}
