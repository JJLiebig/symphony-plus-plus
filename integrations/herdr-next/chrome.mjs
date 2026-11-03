// The S++ chrome for a personal Herdr desk: patches its desk-tabs and desk-agents mods (and desk-topics
// when the desk has it) and adds the S++ panel to the active layout's panel-body stack. Planning only
// reads; install.mjs writes the plan and checks the mods it names.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import deskTabs from './chrome/desk-tabs.patch.mjs';
import deskAgents from './chrome/desk-agents.patch.mjs';
import deskTopics from './chrome/desk-topics.patch.mjs';

const PATCHES = [deskTabs, deskAgents, deskTopics];
// Every chrome version marks what it adds; each patch names its own version.
const MARK = 'S++ chrome';
const PANEL = 'sympp';
const DESK = { 'desk-tabs': 'tabs', 'desk-agents': 'agents' };

async function contents(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// The patched text, or null when an edit's anchor is missing or not unique. Keeps the file's line endings.
export function applyPatch(text, patch) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let out = text;
  for (const edit of patch.edits) {
    const find = edit.find.replaceAll('\n', eol);
    const at = out.indexOf(find);
    if (at < 0 || out.indexOf(find, at + 1) >= 0) return null;
    out = out.slice(0, at) + edit.replace.replaceAll('\n', eol) + out.slice(at + find.length);
  }
  return out;
}

// The text without the patch, keeping every other change made since it was applied, or null when
// one of its replacements is missing, repeated or no longer reverses exactly.
export function revertPatch(text, patch) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let out = text;
  for (const edit of [...patch.edits].reverse()) {
    const replace = edit.replace.replaceAll('\n', eol);
    const at = out.indexOf(replace);
    if (at < 0 || out.indexOf(replace, at + 1) >= 0) return null;
    out = out.slice(0, at) + edit.find.replaceAll('\n', eol) + out.slice(at + replace.length);
  }
  return applyPatch(out, patch) === text ? out : null;
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const child of Array.isArray(node.children) ? node.children : []) walk(child, visit);
}

// The active layout and what in it the chrome needs, with what is missing.
async function readDesk(home) {
  let shared = {};
  try { shared = JSON.parse(await contents(join(home, 'shared.json')) ?? '{}'); } catch { shared = {}; }
  const name = typeof shared?.layout === 'string' && shared.layout ? shared.layout : 'main';
  const path = join(home, 'layouts', `${name}.json`);
  const text = await contents(path);
  let layout = null;
  try { layout = text === null ? null : JSON.parse(text); } catch { layout = null; }
  if (!layout) return { name, path, missing: [`The active layout "${name}" is missing or unreadable at ${path}`] };
  const mods = new Set();
  let body = null;
  walk(layout, (node) => {
    if (typeof node.content?.mod === 'string') mods.add(node.content.mod);
    if (node.id === 'panel-body' && node.type === 'stack') body = node;
  });
  const missing = [];
  if (!body) missing.push(`The "${name}" layout has no panel-body stack`);
  for (const [desk, own] of Object.entries(DESK)) {
    if (mods.has(desk)) continue;
    missing.push(mods.has(own)
      ? `The "${name}" layout uses Herdr's own ${own} mod, not ${desk}`
      : `The "${name}" layout has no ${desk} mod`);
  }
  return { name, path, text, layout, body, missing };
}

const serialize = (layout, before) => JSON.stringify(layout, null, 2) + (before.endsWith('\n') ? '\n' : '');

// Writes that install the chrome with the S++ panel's block props, or what is missing.
export async function planInstall(home, props, selectedSession) {
  const desk = await readDesk(home);
  const backups = join(home, 'data', 'sympp-chrome');
  const missing = [...desk.missing];
  const writes = [];
  const mods = [];
  for (const patch of PATCHES) {
    const file = join(home, 'mods', patch.mod, 'main.js');
    const backup = join(backups, `${patch.mod}.main.js`);
    const current = await contents(file);
    if (current === null && patch.optional) continue;
    if (current === null) { missing.push(`mods/${patch.mod}/main.js is missing`); continue; }
    mods.push(patch.mod);
    if (current.includes(MARK)) {
      // Edits made since outside the S++ lines are kept; the backup follows them.
      const original = current.includes(patch.mark) ? revertPatch(current, patch) : null;
      if (!current.includes(patch.mark)) missing.push(`${patch.mod} has another version of the S++ chrome; remove it with the installer that added it`);
      else if (original === null) missing.push(`The S++ lines in ${patch.mod} were edited`);
      else if (original !== await contents(backup)) writes.push({ to: backup, body: original });
      continue;
    }
    const body = applyPatch(current, patch);
    if (body === null) missing.push(`${patch.mod} differs from the version this patch was written for`);
    else writes.push({ to: backup, body: current }, { to: file, body });
  }
  if (missing.length) return { missing };
  const existing = desk.body.children?.find((c) => c?.id === PANEL)?.content?.props;
  props = { ...existing, ...props, hosts: { ...existing?.hosts, ...props.hosts, local: { ...existing?.hosts?.local, ...props.hosts?.local, runtime: props.hosts?.local?.runtime } } };
  if (selectedSession === undefined && existing?.hosts?.local?.session) props.hosts.local.session = existing.hosts.local.session;
  const child = { id: PANEL, type: 'block', content: { mod: PANEL, props } };
  const children = Array.isArray(desk.body.children) ? desk.body.children : [];
  const at = children.findIndex((c) => c?.id === PANEL);
  if (at < 0) {
    writes.push({ to: join(backups, `${desk.name}.layout.json`), body: desk.text });
    desk.body.children = [...children, child];
  } else if (JSON.stringify(children[at]) !== JSON.stringify({ ...children[at], ...child })) {
    children[at] = { ...children[at], ...child };
  } else {
    return { layout: desk.name, backups, writes, mods };
  }
  writes.push({ to: desk.path, body: serialize(desk.layout, desk.text) });
  return { layout: desk.name, backups, writes, mods };
}

// Writes that remove the chrome: the S++ lines out of each desk mod and the S++ panel out of the
// layout. Both keep every other change made since; the layout's backup stays in place.
export async function planRemoval(home) {
  const desk = await readDesk(home);
  const backups = join(home, 'data', 'sympp-chrome');
  const missing = [];
  const writes = [];
  const mods = [];
  for (const patch of PATCHES) {
    const file = join(home, 'mods', patch.mod, 'main.js');
    const backup = join(backups, `${patch.mod}.main.js`);
    const current = await contents(file);
    if (current !== null) mods.push(patch.mod);
    if (!current?.includes(MARK)) continue;
    const original = current.includes(patch.mark) ? revertPatch(current, patch) : null;
    if (!current.includes(patch.mark)) missing.push(`${patch.mod} has another version of the S++ chrome; remove it with the installer that added it`);
    else if (original === null) missing.push(`The S++ lines in ${patch.mod} were edited; its original before the S++ chrome is ${backup}`);
    else writes.push({ to: file, body: original });
  }
  if (missing.length) return { missing };
  const children = Array.isArray(desk.body?.children) ? desk.body.children : [];
  if (children.some((c) => c?.id === PANEL)) {
    desk.body.children = children.filter((c) => c?.id !== PANEL);
    if (desk.body.active === PANEL) desk.body.active = desk.body.children[0]?.id;
    writes.push({ to: desk.path, body: serialize(desk.layout, desk.text) });
  }
  return { layout: desk.name, backups, writes, mods };
}
