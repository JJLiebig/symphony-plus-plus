import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep A1's exact native generated-registration/process regression. Installation,
// update, relocation and removal are owned by installed-runtime.e2e.ts.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(tmpdir(), 'sympp portable runtime '));
const evidence = join(repo, '.e2e');
const npx = resolve(dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js');
const env = Object.fromEntries(['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PSModulePath', 'TEMP', 'TMP']
  .filter(name => process.env[name]).map(name => [name, process.env[name]]));
Object.assign(env, {
  HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
  APPDATA: join(root, 'home/AppData/Roaming'), LOCALAPPDATA: join(root, 'home/AppData/Local'),
  CODEX_HOME: join(root, 'home/.codex'), CLAUDE_CONFIG_DIR: join(root, 'home/.claude'),
  npm_config_cache: join(root, 'npm-cache'),
  DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
});
await mkdir(evidence, { recursive: true });
// A1 owns its isolated temp trees. Another nested TEMP layer exceeds the Windows
// native library path limit when its retained offline viewer prepares a release.
await mkdir(env.HOME, { recursive: true });

async function run(name, command, args, timeout) {
  await appendFile(join(evidence, 'native-runtime-commands.jsonl'), JSON.stringify({ name, command, args, cwd: root }) + '\n');
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout, windowsHide: true });
  await writeFile(join(evidence, `native-runtime-${name}.stdout.log`), result.stdout || '');
  await writeFile(join(evidence, `native-runtime-${name}.stderr.log`), result.stderr || String(result.error || ''));
  assert.equal(result.status, 0, `${name}: ${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  console.log(result.stdout.trim());
}

try {
  await run('install', process.execPath, [npx, '--yes', 'skills@1.7.0', 'add', repo,
    '--agent', 'claude-code', '--skill', 'symphony-plus-plus', '--yes'], 180000);
  const installed = await realpath(join(root, '.claude/skills/symphony-plus-plus'));
  await run('process', 'pwsh', ['-NoProfile', '-File',
    join(repo, 'plugins/symphony-plus-plus-mcp/tests/launcher/persistent-artifact-runtime-smoke.ps1'),
    '-SkillsInstall', installed, ...(process.env.GITHUB_ACTIONS === 'true' ? ['-HostedProcessCreation'] : [])], 900000);
} finally {
  await rm(root, { recursive: true, force: true });
}
