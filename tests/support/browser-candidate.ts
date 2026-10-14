import { request as httpRequest, createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { test as base } from '@e2e-dev/web';
import { Factory, type Client } from './factory.js';
import { Provider } from './delivery.js';

// This fixture runs only on the hosted runner. No transcripts or model are used.
export class BrowserCandidate {
  private server?: Server;
  client!: Client;
  readonly recording = process.env.SYMPP_BROWSER_RECORDING === '1';
  recorded?: any;
  constructor(readonly root: string, readonly factory?: Factory, readonly provider?: Provider) {}

  async start() {
    if (this.factory) this.client = await this.factory.client();
    const endpoint = this.factory ? new URL(await this.factory.endpoint) : undefined;
    const staticRoot = resolve(process.env.B3_BROWSER_STATIC_ROOT ?? 'elixir/priv/static');
    let recordedBytes: Buffer | undefined;
    if (this.recording) {
      recordedBytes = await readFile(join(process.env.B3_BROWSER_GET_CAPTURE!, 'hydrated.json'));
      this.recorded = JSON.parse(recordedBytes.toString('utf8'));
      const provenance = JSON.parse(await readFile(join(process.env.B3_BROWSER_GET_CAPTURE!, 'provenance.json'), 'utf8'));
      if (createHash('sha256').update(recordedBytes).digest('hex') !== provenance.sha256) throw new Error('Hosted GET capture digest mismatch');
    }
    this.server = createServer(async (request, response) => {
      const path = new URL(request.url!, 'http://127.0.0.1:20373').pathname;
      if (this.recording && request.method !== 'GET') {
        response.writeHead(405); response.end(); return;
      }
      if (path.startsWith('/api/')) {
        if (this.recording) {
          if (path !== '/api/v1/sympp/operator/dashboard/hydrated') { response.writeHead(404); response.end(); return; }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(recordedBytes); return;
        }
        // Same-origin product requests use the real cockpit. This mirrors the
        // development proxy's Origin rewriting; it is not origin-denial proof.
        const upstream = httpRequest(new URL(request.url!, endpoint!), {
          method: request.method,
          headers: { ...request.headers, host: endpoint!.host, origin: endpoint!.origin },
        }, (incoming) => {
          response.writeHead(incoming.statusCode!, incoming.headers);
          incoming.pipe(response);
          response.on('close', () => incoming.destroy());
        });
        upstream.on('error', () => { response.writeHead(502); response.end(); });
        request.pipe(upstream);
        return;
      }
      try {
        const file = resolve(staticRoot, path === '/' || path === '/sympp/board' ? 'index.html' : `.${decodeURIComponent(path)}`);
        if (!file.startsWith(`${staticRoot}${sep}`)) { response.writeHead(404); response.end(); return; }
        const content = await readFile(file);
        const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
        response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
        response.end(content);
      } catch { response.writeHead(404); response.end(); }
    });
    this.server.listen(20373, '127.0.0.1');
    await once(this.server, 'listening');
  }

  // Preserve actual candidate GET output for the authorized read/navigation
  // recording bootstrap. Never modify payloads or emulate operator mutations.
  async capture(scenario: string) {
    const path = '/api/v1/sympp/operator/dashboard/hydrated';
    const body = await this.client.inspect(path);
    const directory = join('.e2e/browser-get-captures', basename(this.root), scenario);
    await mkdir(directory, { recursive: true });
    const bytes = `${JSON.stringify(body)}\n`;
    await writeFile(join(directory, 'hydrated.json'), bytes);
    await writeFile(join(directory, 'provenance.json'), JSON.stringify({
      checkout: process.env.ACCEPTANCE_CHECKOUT_SHA, scenario, method: 'GET', path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      capturedAt: new Date().toISOString(), source: 'live-disposable-candidate',
    }, null, 2));
    return body;
  }

  async stop() {
    if (!this.server) return;
    const closed = once(this.server, 'close');
    this.server.close();
    this.server.closeAllConnections();
    await closed;
  }
}

export const test = base.extend<{ candidate: BrowserCandidate }>({
  candidate: async ({}, use) => {
    if (process.env.SYMPP_BROWSER_RECORDING === '1') {
      await mkdir('.e2e', { recursive: true });
      const candidate = new BrowserCandidate('.e2e');
      try { await candidate.start(); await use(candidate); } finally { await candidate.stop(); }
      return;
    }
    if (process.env.CI !== 'true') throw new Error('Live browser candidate fixtures are hosted-only');
    const root = await mkdtemp(join(tmpdir(), 'sympp-browser-'));
    await mkdir('.e2e', { recursive: true });
    const provider = new Provider(join('.e2e', `${basename(root)}-provider.jsonl`));
    let factory: Factory | undefined;
    let candidate: BrowserCandidate | undefined;
    try {
      factory = new Factory(root, await provider.start(root));
      candidate = new BrowserCandidate(root, factory, provider);
      await candidate.start();
      await use(candidate);
    } finally {
      await candidate?.stop();
      await factory?.stop();
      await provider.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
});
