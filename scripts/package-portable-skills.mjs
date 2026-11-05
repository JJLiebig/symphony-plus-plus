import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repo, 'packages/sympp/skills');
const bundle = resolve(repo, 'skills/sympp');
const check = process.argv.includes('--check');
const portablePath = path => path.split(sep).join('/');
const procedures = await readdir(source);
const outputs = new Map();

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(path);
      continue;
    }
    const destination = resolve(bundle, 'references', relative(source, path))
      .replace(/SKILL\.md$/, 'procedure.md');
    let body = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
    if (entry.name === 'SKILL.md') body = body.replace(/^---\n[\s\S]*?\n---\n\n/, '');
    body = body.replace(/SKILL\.md/g, 'procedure.md');
    body = body.replace(/`symphony-plus-plus(?:-mcp)?:([a-z-]+)`/g, (_, name) => {
      if (!procedures.includes(name)) throw new Error(`Unknown procedure: ${name}`);
      const link = portablePath(relative(dirname(destination), resolve(bundle, 'references', name, 'procedure.md')));
      return `[${name}](${link})`;
    });
    outputs.set(destination, body);
  }
}

await collect(source);
// Ship the authoritative launcher, not a separately maintained implementation.
const plugin = resolve(repo, 'packages/sympp');
const runtimeFiles = (await readdir(resolve(plugin, 'scripts')))
  .filter(name => /\.(ps1|cmd|js|sh)$/.test(name)).map(name => `scripts/${name}`);
runtimeFiles.push('assets/sympp-runtime-artifacts.json');
const payloadHash = createHash('sha256');
async function panelBody(path) {
  const body = await readFile(path);
  return path.endsWith('.png') ? body : body.toString('utf8').replace(/\r\n/g, '\n');
}
async function panelFiles(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await panelFiles(resolve(directory, entry.name), name + '/');
    else outputs.set(resolve(bundle, 'integrations/herdr-next', name), await panelBody(resolve(directory, entry.name)));
  }
}
for (const name of ['install.mjs', 'chrome.mjs']) outputs.set(resolve(bundle, 'integrations/herdr-next', name), await panelBody(resolve(repo, 'integrations/herdr-next', name)));
await panelFiles(resolve(repo, 'integrations/herdr-next/mods/sympp'), 'mods/sympp/');
for (const name of (await readdir(resolve(repo, 'integrations/herdr-next/chrome'))).filter(name => name.endsWith('.mjs'))) outputs.set(resolve(bundle, 'integrations/herdr-next/chrome', name), await panelBody(resolve(repo, 'integrations/herdr-next/chrome', name)));

for (const name of runtimeFiles.sort()) {
  const body = (await readFile(resolve(plugin, name), 'utf8')).replace(/\r\n/g, '\n');
  outputs.set(resolve(bundle, name), body);
}
outputs.set(resolve(bundle, 'scripts/sympp_offline_snapshot.py'),
  (await readFile(resolve(repo, 'scripts/sympp_offline_snapshot.py'), 'utf8')).replace(/\r\n/g, '\n'));
for (const name of [...outputs.keys()].map(path => portablePath(relative(bundle, path))).sort()) {
  payloadHash.update(`${name}\n`);
  payloadHash.update(outputs.get(resolve(bundle, name)));
  payloadHash.update('\n');
}
const manifest = JSON.parse(await readFile(resolve(plugin, 'package.json'), 'utf8'));
const contract = JSON.parse(await readFile(resolve(repo, 'elixir/priv/symphony_plus_plus/mcp_contract.json'), 'utf8'));
outputs.set(resolve(bundle, '.sympp-install.json'), JSON.stringify({
  schema_version: 1, distribution: 'skills', name: manifest.name, version: manifest.version,
  contract_fingerprint: contract.mcp_contract_fingerprint,
  payload_sha256: payloadHash.digest('hex'),
}, null, 2) + '\n');
for (const [path, body] of outputs) {
  if (check) {
    const actual = await readFile(path).catch(() => Buffer.alloc(0));
    if (Buffer.isBuffer(body) ? !actual.equals(body) : actual.toString('utf8').replace(/\r\n/g, '\n') !== body) throw new Error(`Stale portable payload: ${portablePath(relative(repo, path))}`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
}
const installedFiles = await readdir(bundle, { recursive: true, withFileTypes: true });
for (const entry of installedFiles.filter(entry => entry.isFile())) {
  const path = resolve(entry.parentPath, entry.name);
  if (!outputs.has(path) && !['SKILL.md', 'connection.md'].includes(relative(bundle, path))) throw new Error(`Unexpected portable payload: ${portablePath(relative(repo, path))}`);
}
console.log(`Portable procedures ${check ? 'verified' : 'packaged'} (${outputs.size} files).`);
