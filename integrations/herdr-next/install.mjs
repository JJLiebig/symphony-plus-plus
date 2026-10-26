#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { planInstall, planRemoval } from './chrome.mjs';

const help = `Install the optional native S++ view into Herdr-app.
Usage: node integrations/herdr-next/install.mjs --endpoint <dashboard-origin> [options]
       node integrations/herdr-next/install.mjs --lab [options]
       node integrations/herdr-next/install.mjs --remove-chrome [--home <folder>] [--app <executable>]
  --lab                  Install the factory-floor lab (sample data, no S++ needed) beside the view
  --home <folder>        Herdr-app home (default: HERDR_APP_HOME or ~/.config/herdr-app)
  --open <overview|panel> Open a native tab or a pane beside the focused terminal
  --app <executable>     Herdr-app executable (default: herdr-app)
  --session <name>       Explicit local core session for agent navigation
  --mark <a|b|c|d>       S++ mark to install (default: a); use --replace to switch
  --replace              Replace a previously installed mod with this version
  --chrome               Also add an S++ panel button to your desk-tabs bar and S++ badges to your
                         desk-agents list (both backed up first)
  --remove-chrome        Restore desk-tabs and desk-agents and remove the S++ panel
  --help                 Show this help
The S++ backend and your existing layouts, topics and terminals are unchanged.`;

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

async function removeChrome(values) {
  const home = resolve(values.home || process.env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app'));
  const plan = await planRemoval(home);
  if (plan.missing) {
    emit({ error: 'The S++ chrome was not removed; no files were changed', missing: plan.missing });
    return 1;
  }
  if (plan.writes.length && !await checkedWrite(home, values, plan.writes, ['desk-tabs', 'desk-agents', 'sympp'])) return 1;
  emit({ chrome: plan.writes.length ? 'removed' : 'not installed', layout: plan.layout });
  return 0;
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      endpoint: { type: 'string' }, home: { type: 'string' },
      open: { type: 'string' }, app: { type: 'string' }, session: { type: 'string' }, mark: { type: 'string' },
      replace: { type: 'boolean' }, lab: { type: 'boolean' }, help: { type: 'boolean' },
      chrome: { type: 'boolean' }, 'remove-chrome': { type: 'boolean' },
    } }));
  } catch (error) {
    emit({ error: error.message, help });
    return 2;
  }
  if (values.help) { process.stdout.write(`${help}\n`); return 0; }
  if (values.mark !== undefined && (!['a', 'b', 'c', 'd'].includes(values.mark) || values.lab)) {
    emit({ error: values.lab ? '--mark selects the S++ view, not the lab' : '--mark must be a, b, c or d', help });
    return 2;
  }
  if (values['remove-chrome']) return removeChrome(values);
  if (values.chrome && values.lab) {
    emit({ error: '--chrome adds the S++ view, not the lab', help });
    return 2;
  }
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
  const source = join(here, 'mods', mod);
  const markSource = values.mark && values.mark !== 'a' ? join(here, 'marks', values.mark) : source;
  const names = (await readdir(source)).filter(name => name.endsWith('.js') || name === 'mod.json' || name.endsWith('.svg') || name.endsWith('.png'));
  const sources = names.map(name => ({
    from: join(!values.lab && /^(glyph|mark)[.-]/.test(name) ? markSource : source, name), to: join(target, name),
  }));
  if (!values.lab) {
    sources.push({ from: resolve(here, '../../plugins/symphony-plus-plus-mcp/scripts/sympp-herdr.js'), to: helper });
  }
  const files = await Promise.all(sources.map(async ({ from, to }) => ({
    to, body: await readFile(from), existing: await contents(to),
  })));
  const changed = files.filter(file => file.existing !== null && !file.existing.equals(file.body));
  if (changed.length && !values.replace) {
    emit({ error: `The installed ${values.lab ? 'S++ lab' : 'S++ integration'} differs; no files were changed`,
      help: 'Keep your edits, or rerun with --replace to install this version.' });
    return 1;
  }
  let props = {};
  if (!values.lab) {
    const session = values.session || process.env.HC_SESSION;
    const hosts = { local: { node: process.execPath, helper, ...(session ? { session } : {}) } };
    props = { endpoint, hosts };
  }
  const chrome = values.chrome ? await planInstall(home, { ...props, role: 'panel' }) : null;
  if (chrome?.missing) {
    emit({ error: 'The S++ chrome needs your desk layout and mods; no files were changed', missing: chrome.missing });
    return 1;
  }
  const writes = files.filter(({ body, existing }) => !existing?.equals(body));
  if (chrome) {
    if (!await checkedWrite(home, values, [...writes, ...chrome.writes], ['desk-tabs', 'desk-agents', 'sympp'])) return 1;
  } else await write(writes);
  if (!values.lab) {
    await rm(join(home, 'tools', 'sympp-http.cjs'), { force: true });
    await rm(join(home, 'data', 'sympp-requests'), { recursive: true, force: true });
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
  emit({ installed: target, ...(endpoint ? { endpoint, mark: values.mark || 'a' } : {}),
    ...(chrome ? { chrome: chrome.writes.length ? 'installed' : 'unchanged', layout: chrome.layout, backups: chrome.backups } : {}),
    ...(values.open ? { opened: values.open } : { command, args: JSON.stringify(args) }) });
  return 0;
}

try { process.exitCode = await main(); }
catch {
  emit({ error: 'Could not install the native view', help: 'Check that the package files exist and the Herdr-app home is writable.' });
  process.exitCode = 1;
}
