import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// A protocol boundary host, never evidence of a live Herdr desktop.
export class InspectorHost {
  readonly calls: { method: string; params: any }[] = [];
  readonly socketPath: string;
  readonly subscribers = new Set<Socket>();
  readonly sockets = new Set<Socket>();
  readonly server = createServer((socket) => {
    this.sockets.add(socket);
    socket.on('close', () => { this.sockets.delete(socket); this.subscribers.delete(socket); });
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        this.calls.push({ method: message.method, params: message.params });
        appendFileSync(this.receipt, `${JSON.stringify({ method: message.method, params: message.params })}\n`);
        let result: object = {};
        if (message.method === 'session.snapshot') result = this.snapshot;
        else if (message.method === 'events.subscribe') this.subscribers.add(socket);
        else if (message.method === 'pane.focus') this.snapshot.focused_pane_id = message.params.pane_id;
        socket.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
    });
  });
  process?: ChildProcessWithoutNullStreams;
  output = '';
  frames = 0;
  stderr = '';
  constructor(readonly root: string, readonly snapshot: any, readonly receipt: string) {
    this.socketPath = join(root, 'inspector.sock');
  }
  get screen() {
    return this.output.split('\u001b[H\u001b[2J').at(-1)!.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
  }
  async start(endpoint: string) {
    this.server.listen(this.socketPath);
    await once(this.server, 'listening');
    for (const pane of this.snapshot.panes) if (pane.tokens?.sympp_work_request_id) pane.tokens.sympp_endpoint = endpoint;
    this.process = spawn(process.execPath, [resolve('plugins/symphony-plus-plus-mcp/herdr/dist/sympp-herdr.mjs')], {
      env: {
        PATH: process.env.PATH, HOME: this.root, USERPROFILE: this.root, TMPDIR: this.root,
        HERDR_PLUGIN_ENTRYPOINT_ID: 'execution-inspector', HERDR_SOCKET_PATH: this.socketPath,
        HERDR_PANE_ID: 'inspector', SYMPP_TARGET_TAB_ID: 'tab-a', SYMPP_TARGET_PANE_ID: 'owner-a',
      }, stdio: 'pipe',
    });
    this.process.stdout.on('data', (chunk) => {
      this.output += chunk;
      this.frames = this.output.split('\u001b[H\u001b[2J').length - 1;
      appendFileSync(`${this.receipt}.stdout.txt`, chunk);
    });
    this.process.stderr.on('data', (chunk) => {
      this.stderr += chunk;
      appendFileSync(`${this.receipt}.stderr.txt`, chunk);
    });
  }
  event(name: string) {
    for (const socket of this.subscribers) socket.write(`${JSON.stringify({ event: name, data: {} })}\n`);
  }
  async stop() {
    if (this.process && this.process.exitCode === null && this.process.signalCode === null) {
      const exited = once(this.process, 'exit');
      this.process.kill('SIGTERM');
      const timer = setTimeout(() => this.process?.kill('SIGKILL'), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    const closed = once(this.server, 'close');
    this.server.close();
    for (const socket of this.sockets) socket.destroy();
    await closed;
  }
}
