import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repo, 'plugins/symphony-plus-plus-mcp/skills');
const bundle = resolve(repo, 'skills/symphony-plus-plus');
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
for (const [path, body] of outputs) {
  if (check) {
    const actual = await readFile(path, 'utf8').catch(() => '');
    if (actual.replace(/\r\n/g, '\n') !== body) throw new Error(`Stale portable payload: ${portablePath(relative(repo, path))}`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
}
const installedFiles = await readdir(resolve(bundle, 'references'), { recursive: true, withFileTypes: true });
for (const entry of installedFiles.filter(entry => entry.isFile())) {
  const path = resolve(entry.parentPath, entry.name);
  if (!outputs.has(path)) throw new Error(`Unexpected portable payload: ${portablePath(relative(repo, path))}`);
}
console.log(`Portable procedures ${check ? 'verified' : 'packaged'} (${outputs.size} files).`);
