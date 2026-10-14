import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect } from 'e2e';
import { test } from '../support/installed-runtime.js';

// Required Windows gate. A1 separately proves native host consumption of setup's
// exact generated command; this journey never substitutes a direct Node launch.
if (process.env.SYMPP_INSTALLED_ACCEPTANCE === '1') {
  test('Skills installation, refresh and relocated copy preserve usable native registration and unrelated ownership', { timeout: 600_000 }, async ({ installed }) => {
    expect(process.platform).toBe('win32');
    expect(await installed.skills(['add', resolve('.'), '--list'])).toContain('symphony-plus-plus');
    const bundle = await installed.install('codex');
    expect(existsSync(installed.env.CODEX_HOME!)).toBe(false);
    expect((await installed.setup(bundle)).code).toBe(0);
    const configFile = join(installed.env.CODEX_HOME!, 'config.toml');
    const claudeFile = join(installed.project, '.mcp.json');
    const unrelated = 'model = "example-model"\n';
    await writeFile(configFile, unrelated + await readFile(configFile, 'utf8'));
    const config = await readFile(configFile, 'utf8');
    const claude = await readFile(claudeFile, 'utf8');
    expect((await installed.setup(bundle)).code).toBe(0);
    expect(await readFile(configFile, 'utf8')).toBe(config);
    expect(await readFile(claudeFile, 'utf8')).toBe(claude);
    const registration = JSON.parse(await installed.ok('codex.exe', ['mcp', 'get', 'symphony_plus_plus', '--json']));
    expect(registration.transport.env.SYMPP_DATABASE).toBe(installed.env.SYMPP_DATABASE);
    expect(registration.transport.env.SYMPP_HOME).toBe(installed.env.SYMPP_HOME);

    // A saved install must still run setup after the original is refreshed.
    const saved = join(installed.root, 'saved skill');
    await cp(bundle, saved, { recursive: true });
    await writeFile(join(bundle, 'scripts/setup-sympp.js'), 'process.exit(91);\n');
    expect((await installed.setup(bundle)).code).toBe(91);
    await installed.install('codex');
    expect((await installed.setup(bundle)).code).toBe(0);
    const copied = await installed.install('claude-code', saved, true);
    expect((await installed.setup(copied)).code).toBe(0);
    const moved = JSON.parse(await installed.ok('codex.exe', ['mcp', 'get', 'symphony_plus_plus', '--json']));
    expect(moved.transport.args).toContain(join(copied, 'scripts/start-sympp-mcp-bridge.js'));
    expect((await readFile(configFile, 'utf8')).startsWith(unrelated)).toBe(true);

    const foreignConfig = '[mcp_servers.symphony_plus_plus]\ncommand = "unrelated-owner.exe"\n';
    await writeFile(configFile, foreignConfig);
    const beforeClaude = await readFile(claudeFile, 'utf8');
    const refused = await installed.setup(copied);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain('unmanaged MCP registration');
    expect(await readFile(configFile, 'utf8')).toBe(foreignConfig);
    expect(await readFile(claudeFile, 'utf8')).toBe(beforeClaude);

    await writeFile(configFile, config);
    const foreignClaude = JSON.stringify({ mcpServers: { symphony_plus_plus: { command: 'unrelated-owner.exe' } } });
    await writeFile(claudeFile, foreignClaude);
    expect((await installed.setup(copied)).code).toBe(1);
    expect(await readFile(configFile, 'utf8')).toBe(config);
    expect(await readFile(claudeFile, 'utf8')).toBe(foreignClaude);
    expect(existsSync(installed.env.SYMPP_DATABASE!)).toBe(false);
  });

  test('Skills remote update keeps beta tracking for both native hosts', { timeout: 600_000 }, async ({ installed }) => {
    for (const agent of ['codex', 'claude-code'] as const) {
      await installed.install(agent, 'https://github.com/JJLiebig/symphony-plus-plus/tree/beta');
      const lock = () => readFile(join(installed.project, 'skills-lock.json'), 'utf8').then(JSON.parse);
      expect((await lock()).skills['symphony-plus-plus'].ref).toBe('beta');
      const update = await installed.skills(['update', 'symphony-plus-plus', '--project', '--yes']);
      expect(/No installed skills found|Failed to|Cannot update|cannot be updated/i.test(update)).toBe(false);
      expect((await lock()).skills['symphony-plus-plus'].ref).toBe('beta');
      const installedList = JSON.parse(await installed.skills(['list', '--agent', agent, '--json']));
      expect(JSON.stringify(installedList)).toContain('symphony-plus-plus');
    }
  });

  test('native marketplace install and upgrade preserve the alternative route and refuse mixed Skills ownership', { timeout: 600_000 }, async ({ installed }) => {
    await mkdir(installed.env.CODEX_HOME!, { recursive: true });
    await installed.ok('codex.exe', ['plugin', 'marketplace', 'add', 'https://github.com/JJLiebig/symphony-plus-plus', '--ref', process.env.ACCEPTANCE_HEAD_SHA!]);
    await installed.ok('codex.exe', ['plugin', 'marketplace', 'upgrade', 'symphony-plus-plus']);
    await installed.ok('codex.exe', ['plugin', 'add', 'symphony-plus-plus@symphony-plus-plus']);
    await installed.ok('codex.exe', ['plugin', 'add', 'symphony-plus-plus-mcp@symphony-plus-plus']);
    const listed = JSON.parse(await installed.ok('codex.exe', ['plugin', 'list', '--marketplace', 'symphony-plus-plus', '--json']));
    expect(listed.installed.some((plugin: any) => plugin.name === 'symphony-plus-plus-mcp' && plugin.enabled)).toBe(true);
    const bundle = await installed.install('codex');
    const configFile = join(installed.env.CODEX_HOME!, 'config.toml');
    const before = await readFile(configFile, 'utf8');
    const refused = await installed.setup(bundle, 'codex');
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain('marketplace plugin');
    expect(await readFile(configFile, 'utf8')).toBe(before);
    expect(existsSync(installed.env.SYMPP_DATABASE!)).toBe(false);
  });
}
