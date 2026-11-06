#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = resolve(here, '../../scripts');
const helperScripts = (await contents(join(scripts, 'sympp-herdr.js'))) ? scripts : resolve(here, '../../packages/sympp/scripts');

const bundled = existsSync(resolve(here, '../../.sympp-install.json'));
const help = `Install the optional native sympp view into Herdr-app.
Usage: node integrations/herdr-next/install.mjs --endpoint <dashboard-origin> [options]
       node integrations/herdr-next/install.mjs --lab [options]
  --server <ssh host>    Connect to an existing factory (or http://127.0.0.1:19998 on the server)
  --lab                  Install the factory-floor lab (sample data, no sympp needed) beside the view
  --home <folder>        Herdr-app home (default: HERDR_APP_HOME or ~/.config/herdr-app)
  --open <overview|panel> Open a native tab or a pane beside the focused terminal
  --app <executable>     Herdr-app executable (default: herdr-app)
  --factory <runtime>    Local factory runtime record (default: SYMPP_RUNTIME_FILE or SYMPP_HOME/runtime/codex-plugin.json)
  --session <name>       Explicit local core session for agent navigation
  --replace              Replace a previously installed mod with this version
  --check                Check the sympp mod with Herdr-app and roll back on failure
  --help                 Show this help
The sympp backend and your existing layouts, topics and terminals are unchanged.`.split('\n').filter(line => !bundled || !/--lab/.test(line)).join('\n');

function emit(fields) {
  for (const [key, value] of Object.entries(fields)) {
    process.stdout.write(`${key}: ${JSON.stringify(value)}\n`);
  }
}

async function contents(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function write(files) {
  for (const { to, body } of files) {
    await mkdir(dirname(to), { recursive: true });
    const temporary = `${to}.${process.pid}.tmp`;
    await writeFile(temporary, body);
    await rename(temporary, to);
  }
}

async function checkedWrite(home, values, files, mods) {
  const app = values.app || 'herdr-app';
  const options = { env: { ...process.env, HERDR_APP_HOME: home }, encoding: 'utf8', windowsHide: true };
  const probe = spawnSync(app, ['--version'], options);
  if (probe.error || probe.status !== 0) {
    emit({ error: 'Herdr-app is required to check the mods; no files were changed',
      help: 'Put herdr-app on PATH or pass --app <executable>.',
      reason: probe.error?.message || probe.stderr || probe.stdout });
    return false;
  }
  const before = await Promise.all(files.map(async ({ to }) => ({ to, body: await contents(to) })));
  try {
    await write(files);
    for (const mod of mods) {
      const child = spawnSync(app, ['check', join(home, 'mods', mod)], options);
      if (child.error || child.status !== 0) {
        throw new Error(`${mod}: ${child.error?.message || child.stderr?.trim() || child.stdout?.trim() || `check exited ${child.status}`}`);
      }
    }
    return true;
  } catch (error) {
    for (const file of before) {
      if (file.body === null) await rm(file.to, { force: true });
      else await write([file]);
    }
    emit({ error: 'The mod update failed; all changed files were restored', reason: error.message });
    return false;
  }
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      server: { type: 'string' }, endpoint: { type: 'string' }, factory: { type: 'string' }, home: { type: 'string' },
      open: { type: 'string' }, app: { type: 'string' }, session: { type: 'string' },
      replace: { type: 'boolean' }, lab: { type: 'boolean' }, help: { type: 'boolean' },
      check: { type: 'boolean' }, 'token-file': { type: 'string' },
    } }));
  } catch (error) {
    emit({ error: error.message, help });
    return 2;
  }
  if (values.help) { process.stdout.write(`${help}\n`); return 0; }
  if (bundled && values.lab) {
    emit({ error: 'This skill carries the default sympp panel. Use the repository installer for the lab.' });
    return 2;
  }
  if (values.server && (values.endpoint || values.factory || values.lab)) {
    emit({ error: '--server cannot be combined with --endpoint, --factory or --lab' });
    return 2;
  }
  const remoteSetup = values.server ? (await import(pathToFileURL(join(helperScripts, 'sympp-remote.js')).href)).default : null;
  const remote = values.server ? remoteSetup.serverConnection(values.server) : null;
  if (remote) values.endpoint = remote.endpoint;
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
  const helper = join(home, 'tools', 'sympp-herdr.js');
  const source = join(here, 'mods', mod);
  const names = (await readdir(source)).filter(name => name.endsWith('.js') || name === 'mod.json' || name.endsWith('.svg') || name.endsWith('.png'));
  const sources = names.map(name => ({
    from: join(source, name), to: join(target, name),
  }));
  if (!values.lab) {
    sources.push({ from: join(helperScripts, 'sympp-herdr.js'), to: helper });
  }
  const files = await Promise.all(sources.map(async ({ from, to }) => ({
    to, body: await readFile(from), existing: await contents(to),
  })));
  const changed = files.filter(file => file.existing !== null && !file.existing.equals(file.body));
  if (changed.length && !values.replace) {
    emit({ error: `The installed ${values.lab ? 'sympp lab' : 'sympp integration'} differs; no files were changed`,
      help: 'Keep your edits, or rerun with --replace to install this version.' });
    return 1;
  }
  let props = {};
  if (!values.lab) {
    const session = values.session || process.env.HC_SESSION;
    const factory = values.factory || process.env.SYMPP_RUNTIME_FILE || (process.env.SYMPP_HOME && join(process.env.SYMPP_HOME, 'runtime', 'codex-plugin.json'));
    const hosts = { local: { ...(factory ? { runtime: resolve(factory) } : {}), node: process.execPath, helper, ...(session ? { session } : {}) } };
    props = { endpoint, hosts, remote: Boolean(remote || values['token-file']) };
    if (remote || values['token-file']) delete hosts.local.runtime;
  }
  const connectionWrites = [];
  if (!values.lab && values.check) {
    const file = join(home, 'shared.json');
    const shared = JSON.parse((await contents(file))?.toString() || '{}');
    if (JSON.stringify(shared['sympp.connection']) !== JSON.stringify(props)) {
      shared['sympp.connection'] = props;
      connectionWrites.push({ to: file, body: JSON.stringify(shared, null, 2) + '\n' });
    }
  }
  const backupId = new Date().toISOString().replaceAll(':', '-') + '-' + process.pid;
  const panelBackups = values.replace ? changed.map(file => ({ to: join(home, 'data', 'sympp-panel-backups', backupId, file.to === helper ? 'sympp-herdr.js' : file.to.slice(target.length + 1)), body: file.existing })) : [];
  const writes = files.filter(({ body, existing }) => !existing?.equals(body));
  if (values.check) {
    if (!await checkedWrite(home, values, [...panelBackups, ...writes, ...connectionWrites], [mod])) return 1;
  } else await write([...panelBackups, ...writes]);
  if (!values.lab) {
    await rm(join(home, 'tools', 'sympp-http.cjs'), { force: true });
    await rm(join(home, 'data', 'sympp-requests'), { recursive: true, force: true });
  }
  if (values['token-file']) {
    const remoteSetup = (await import(pathToFileURL(join(helperScripts, 'sympp-remote.js')).href)).default;
    remoteSetup.privateWrite(join(home, 'sympp-remote.json'), JSON.stringify({ endpoint, token: (await readFile(values['token-file'], 'utf8')).trim() }));
  }
  if (remote) remoteSetup.privateWrite(join(home, 'sympp-remote.json'), JSON.stringify(remote));
  const command = values.open === 'panel' ? 'pane.split' : 'tab.new';
  const args = values.open === 'panel'
    ? { direction: 'right', mod, props: values.lab ? props : { ...props, role: 'panel' } }
    : { name: values.lab ? 'sympp Lab' : 'sympp', mod, props };
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
  emit({ installed: target, ...(endpoint ? { endpoint } : {}),
    ...(values.open ? { opened: values.open } : { command, args: JSON.stringify(args) }) });
  return 0;
}

try { process.exitCode = await main(); }
catch {
  emit({ error: 'Could not install the native view', help: 'Check that the package files exist and the Herdr-app home is writable.' });
  process.exitCode = 1;
}
