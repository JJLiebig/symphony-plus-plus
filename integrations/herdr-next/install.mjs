#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, readdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const help = `Install the optional native S++ view into Herdr-app.
Usage: node integrations/herdr-next/install.mjs --endpoint <dashboard-origin> [options]
       node integrations/herdr-next/install.mjs --lab [options]
  --lab                  Install the factory-floor lab (sample data, no S++ needed) beside the view
  --home <folder>        Herdr-app home (default: HERDR_APP_HOME or ~/.config/herdr-app)
  --open <overview|panel> Open a native tab or a pane beside the focused terminal
  --app <executable>     Herdr-app executable (default: herdr-app)
  --session <name>       Explicit local core session for agent navigation
  --replace              Replace a previously installed mod with this version
  --help                 Show this help
The S++ backend and your existing layouts, topics and terminals are unchanged.`;

function emit(fields) {
  for (const [key, value] of Object.entries(fields)) {
    process.stdout.write(`${key}: ${JSON.stringify(value)}\n`);
  }
}

async function contents(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      endpoint: { type: 'string' }, home: { type: 'string' },
      open: { type: 'string' }, app: { type: 'string' }, session: { type: 'string' },
      replace: { type: 'boolean' }, lab: { type: 'boolean' }, help: { type: 'boolean' },
    } }));
  } catch (error) {
    emit({ error: error.message, help });
    return 2;
  }
  if (values.help) { process.stdout.write(`${help}\n`); return 0; }
  const badOpen = values.open && !['overview', 'panel'].includes(values.open);
  if (badOpen || (!values.endpoint && !values.lab)) {
    emit({ error: badOpen ? '--open must be overview or panel' : '--endpoint is required', help });
    return 2;
  }
  let endpoint;
  if (!values.lab) {
    try {
      const url = new URL(values.endpoint);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          url.pathname !== '/' || url.search || url.hash) throw new Error();
      endpoint = url.origin;
    } catch {
      emit({ error: '--endpoint must be an HTTP(S) origin without credentials, path or query', help });
      return 2;
    }
  }
  const home = resolve(values.home || process.env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app'));
  const mod = values.lab ? 'sympp-lab' : 'sympp';
  const target = join(home, 'mods', mod);
  const here = dirname(fileURLToPath(import.meta.url));
  const helper = join(home, 'tools', 'sympp-herdr.js');
  const httpHelper = join(home, 'tools', 'sympp-http.cjs');
  const source = join(here, 'mods', mod);
  const names = (await readdir(source)).filter(name => name.endsWith('.js') || name === 'mod.json' || (values.lab && name.endsWith('.svg')));
  const sources = names.map(name => ({ from: join(source, name), to: join(target, name) }));
  if (!values.lab) {
    sources.push({ from: resolve(here, '../../plugins/symphony-plus-plus-mcp/scripts/sympp-herdr.js'), to: helper });
    sources.push({ from: join(here, 'http.cjs'), to: httpHelper });
  }
  const files = await Promise.all(sources.map(async ({ from, to }) => ({
    to, body: await readFile(from, 'utf8'), existing: await contents(to),
  })));
  const changed = files.filter(file => file.existing !== null && file.existing !== file.body);
  if (changed.length && !values.replace) {
    emit({ error: `The installed ${values.lab ? 'S++ lab' : 'S++ integration'} differs; no files were changed`,
      help: 'Keep your edits, or rerun with --replace to install this version.' });
    return 1;
  }
  for (const { to, body, existing } of files) {
    if (existing === body) continue;
    await mkdir(dirname(to), { recursive: true });
    const temporary = `${to}.${process.pid}.tmp`;
    await writeFile(temporary, body, 'utf8');
    await rename(temporary, to);
  }
  let props = {};
  if (!values.lab) {
    const session = values.session || process.env.HC_SESSION;
    const requests = join(home, 'data', 'sympp-requests');
    await mkdir(requests, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(requests, 0o700);
    const hosts = { local: { node: process.execPath, helper, ...(session ? { session } : {}) } };
    props = { endpoint, hosts, bridge: { node: process.execPath, helper: httpHelper } };
  }
  const command = values.open === 'panel' ? 'pane.split' : 'tab.new';
  const args = values.open === 'panel'
    ? { direction: 'right', mod, props: values.lab ? props : { ...props, role: 'panel' } }
    : { name: values.lab ? 'S++ Lab' : 'S++', mod, props };
  if (values.open) {
    const child = spawnSync(values.app || 'herdr-app', ['do', command, JSON.stringify(args)], {
      env: { ...process.env, HERDR_APP_HOME: home }, encoding: 'utf8', windowsHide: true,
    });
    if (child.error || child.status !== 0) {
      emit({ installed: target, error: 'Installed, but Herdr-app could not open the view',
        help: 'Open Herdr-app with this home, then use the command and args below.', command, args: JSON.stringify(args) });
      return 1;
    }
  }
  emit({ installed: target, ...(endpoint ? { endpoint } : {}), ...(values.open ? { opened: values.open } : { command, args: JSON.stringify(args) }) });
  return 0;
}

try { process.exitCode = await main(); }
catch {
  emit({ error: 'Could not install the native view', help: 'Check that the package files exist and the Herdr-app home is writable.' });
  process.exitCode = 1;
}
