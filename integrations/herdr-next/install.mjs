#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const help = `Install the optional native S++ view into Herdr-app.
Usage: node integrations/herdr-next/install.mjs --endpoint <dashboard-origin> [options]
  --home <folder>        Herdr-app home (default: HERDR_APP_HOME or ~/.config/herdr-app)
  --open <overview|panel> Open a native tab or a pane beside the focused terminal
  --app <executable>     Herdr-app executable (default: herdr-app)
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
      open: { type: 'string' }, app: { type: 'string' },
      replace: { type: 'boolean' }, help: { type: 'boolean' },
    } }));
  } catch (error) {
    emit({ error: error.message, help });
    return 2;
  }
  if (values.help) { process.stdout.write(`${help}\n`); return 0; }
  if (!values.endpoint || (values.open && !['overview', 'panel'].includes(values.open))) {
    emit({ error: !values.endpoint ? '--endpoint is required' : '--open must be overview or panel', help });
    return 2;
  }
  let endpoint;
  try {
    const url = new URL(values.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error();
    endpoint = url.origin;
  } catch {
    emit({ error: '--endpoint must be an HTTP(S) origin without credentials, path or query', help });
    return 2;
  }
  const home = resolve(values.home || process.env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app'));
  const target = join(home, 'mods', 'sympp');
  const source = join(dirname(fileURLToPath(import.meta.url)), 'mods', 'sympp');
  const files = await Promise.all(['main.js', 'model.js', 'mod.json'].map(async name => ({
    name, body: await readFile(join(source, name), 'utf8'), existing: await contents(join(target, name)),
  })));
  const changed = files.filter(file => file.existing !== null && file.existing !== file.body);
  if (changed.length && !values.replace) {
    emit({ error: 'The installed S++ mod differs; no files were changed',
      help: 'Keep your edits, or rerun with --replace to install this version.' });
    return 1;
  }
  await mkdir(target, { recursive: true });
  for (const { name, body, existing } of files) {
    if (existing === body) continue;
    const temporary = join(target, `.${name}.${process.pid}.tmp`);
    await writeFile(temporary, body, 'utf8');
    await rename(temporary, join(target, name));
  }
  const command = values.open === 'panel' ? 'pane.split' : 'tab.new';
  const args = values.open === 'panel'
    ? { direction: 'right', mod: 'sympp', props: { endpoint, role: 'panel' } }
    : { name: 'S++', mod: 'sympp', props: { endpoint } };
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
  emit({ installed: target, endpoint, ...(values.open ? { opened: values.open } : { command, args: JSON.stringify(args) }) });
  return 0;
}

try { process.exitCode = await main(); }
catch {
  emit({ error: 'Could not install the native view', help: 'Check that the package files exist and the Herdr-app home is writable.' });
  process.exitCode = 1;
}
