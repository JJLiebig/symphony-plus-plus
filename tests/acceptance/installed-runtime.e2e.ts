import { cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect } from 'e2e';
import { test } from '../support/installed-runtime.js';

// Required Windows gate. A1 separately proves native host consumption of setup's
// exact generated command; this journey never substitutes a direct Node launch.
if (process.env.SYMPP_INSTALLED_ACCEPTANCE === '1') {
  test('Skills installation, refresh and relocated copy preserve usable native registration and unrelated ownership', { timeout: 600_000 }, async ({ installed }) => {
    expect(process.platform).toBe('win32');
    expect(await installed.skills(['add', resolve('.'), '--list'])).toContain('sympp');
    const bundle = await installed.install('codex');
    installed.env.SYMPP_BACKEND_PORT = '21345';
    const claudeFile = join(installed.project, '.mcp.json');
    await writeFile(claudeFile, JSON.stringify({ other: true, mcpServers: { notes: { command: 'notes.exe' } } }));
    expect(existsSync(installed.env.CODEX_HOME!)).toBe(false);
    expect((await installed.setup(bundle)).code).toBe(0);
    const configFile = join(installed.env.CODEX_HOME!, 'config.toml');
    const unrelated = 'model = "example-model"\n';
    await writeFile(configFile, unrelated + await readFile(configFile, 'utf8'));
    const config = await readFile(configFile, 'utf8');
    const claude = await readFile(claudeFile, 'utf8');
    const invalid = await installed.run(process.execPath, [join(bundle, 'scripts/setup-sympp.js'), '--hos', 'codex']);
    expect(invalid.code).toBe(2);
    expect(await readFile(configFile, 'utf8')).toBe(config);
    expect(await readFile(claudeFile, 'utf8')).toBe(claude);
    expect(JSON.parse(claude).mcpServers.notes.command).toBe('notes.exe');
    expect(JSON.parse(claude).other).toBe(true);
    expect((await installed.setup(bundle)).code).toBe(0);
    expect(await readFile(configFile, 'utf8')).toBe(config);
    expect(await readFile(claudeFile, 'utf8')).toBe(claude);
    const registration = JSON.parse(await installed.ok('codex.exe', ['mcp', 'get', 'sympp', '--json']));
    expect(registration.transport.env.SYMPP_DATABASE).toBe(installed.env.SYMPP_DATABASE);
    expect(registration.transport.env.SYMPP_HOME).toBe(installed.env.SYMPP_HOME);
    expect(registration.transport.env.SYMPP_RUNTIME_FILE).toBe(installed.env.SYMPP_RUNTIME_FILE);
    expect(registration.transport.env.SYMPP_BACKEND_PORT).toBe('21345');
    expect(registration.transport.env.SYMPP_RUNTIME_CHANNEL).toBe('stable');

    // A saved install must still run setup after the original is refreshed.
    const saved = join(installed.root, 'saved skill');
    await cp(bundle, saved, { recursive: true });
    await writeFile(join(bundle, 'scripts/setup-sympp.js'), 'process.exit(91);\n');
    expect((await installed.setup(bundle)).code).toBe(91);
    await installed.install('codex');
    expect((await installed.setup(bundle)).code).toBe(0);
    const copied = await installed.install('claude-code', saved, true);
    expect((await installed.setup(copied)).code).toBe(0);
    const moved = JSON.parse(await installed.ok('codex.exe', ['mcp', 'get', 'sympp', '--json']));
    expect(moved.transport.args).toContain(join(copied, 'scripts/start-sympp-mcp-bridge.js'));
    expect((await readFile(configFile, 'utf8')).startsWith(unrelated)).toBe(true);
    expect((await installed.setup(bundle)).code).toBe(0);
    const restored = JSON.parse(await installed.ok('codex.exe', ['mcp', 'get', 'sympp', '--json']));
    expect(restored.transport.args).toContain(join(bundle, 'scripts/start-sympp-mcp-bridge.js'));

    const foreignConfig = '[mcp_servers.sympp]\ncommand = "unrelated-owner.exe"\n';
    await writeFile(configFile, foreignConfig);
    const beforeClaude = await readFile(claudeFile, 'utf8');
    const refused = await installed.setup(copied);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain('unmanaged sympp MCP registration');
    expect(await readFile(configFile, 'utf8')).toBe(foreignConfig);
    expect(await readFile(claudeFile, 'utf8')).toBe(beforeClaude);

    const inline = 'mcp_servers = { notes = { command = "notes.exe" } }\n';
    await writeFile(configFile, inline);
    const inlineRefused = await installed.setup(copied);
    expect(inlineRefused.code).toBe(1);
    expect(inlineRefused.stdout).toContain('inline MCP table');
    expect(await readFile(configFile, 'utf8')).toBe(inline);
    expect(await readFile(claudeFile, 'utf8')).toBe(beforeClaude);

    await writeFile(configFile, config);
    const foreignClaude = JSON.stringify({ mcpServers: { sympp: { command: 'unrelated-owner.exe' } } });
    await writeFile(claudeFile, foreignClaude);
    expect((await installed.setup(copied)).code).toBe(1);
    expect(await readFile(configFile, 'utf8')).toBe(config);
    expect(await readFile(claudeFile, 'utf8')).toBe(foreignClaude);
    expect(existsSync(installed.env.SYMPP_DATABASE!)).toBe(false);
    for (const agent of ['codex', 'claude-code']) {
      await installed.skills(['remove', 'sympp', '--agent', agent, '--yes']);
    }
    expect(JSON.parse(await installed.skills(['list', '--json']))).toEqual([]);
  });

  test('project and global installations preserve their own runtime channel', { timeout: 600_000 }, async ({ installed }) => {
    const bundle = await installed.install('codex');
    const projectLock = join(installed.project, 'skills-lock.json');
    const local = JSON.parse(await readFile(projectLock, 'utf8'));
    // Candidate installation is real; branch metadata selects the published channel.
    local.skills.sympp = { ...local.skills.sympp, source: 'JJLiebig/sympp', sourceType: 'github', ref: 'beta' };
    await writeFile(projectLock, JSON.stringify(local));
    expect((await installed.setup(bundle)).code).toBe(0);
    const beta = JSON.parse(await installed.ok('codex.exe', ['mcp', 'get', 'sympp', '--json']));
    expect(beta.transport.env.SYMPP_RUNTIME_CHANNEL).toBe('beta');

    await installed.skills(['add', resolve('.'), '--global', '--agent', 'codex', '--skill', 'sympp', '--yes']);
    const globalBundle = join(installed.env.HOME!, '.agents/skills/sympp');
    const globalLock = join(installed.env.HOME!, '.agents/.skill-lock.json');
    const global = JSON.parse(await readFile(globalLock, 'utf8'));
    global.skills.sympp = { ...global.skills.sympp, source: 'JJLiebig/sympp', sourceType: 'github', ref: 'beta' };
    await writeFile(globalLock, JSON.stringify(global));
    local.skills.sympp.ref = 'main';
    await writeFile(projectLock, JSON.stringify(local));
    expect((await installed.setup(globalBundle)).code).toBe(0);
    const selected = JSON.parse(await installed.ok('codex.exe', ['mcp', 'get', 'sympp', '--json']));
    expect(selected.transport.env.SYMPP_RUNTIME_CHANNEL).toBe('beta');
    expect((await installed.setup(bundle)).code).toBe(0);
    const main = JSON.parse(await installed.ok('codex.exe', ['mcp', 'get', 'sympp', '--json']));
    expect(main.transport.env.SYMPP_RUNTIME_CHANNEL).toBe('stable');
  });
}
