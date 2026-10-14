import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'e2e';
import { test } from '../support/candidate.js';

test('fresh candidate bootstrap reports healthy isolated ledgers through its real API', async ({ candidates }) => {
  const contract = JSON.parse(await readFile('elixir/priv/symphony_plus_plus/mcp_contract.json', 'utf8'));
  const identities: string[] = [];
  for (const candidate of [candidates.primary, candidates.peer]) {
    const initialized = await candidate.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'acceptance-client', version: '1.0.0' },
    });
    expect(initialized.protocolVersion).toBe('2025-03-26');
    expect(initialized.capabilities.tools).toBeDefined();

    const catalog = await candidate.request('tools/list');
    expect(catalog.tools.map((tool: { name: string }) => tool.name)).toContain('sympp.health');
    const result = await candidate.request('tools/call', { name: 'sympp.health', arguments: {} });
    expect(result.isError).not.toBe(true);
    const health = result.structuredContent;
    expect(health.status).toBe('ok');
    expect(health.mode).toBe('stdio');
    expect(health.ledger.reachable).toBe(true);
    expect(health.ledger.identity.kind).toBe('sqlite');
    expect(health.ledger.identity.source).toBe('explicit');
    expect(health.ledger.identity.default_home).toBe(false);
    // The path is our independent input, not a value imported from production code.
    expect(health.ledger.identity.display_path).toBe('$HOME/ledger.sqlite3');
    expect(await realpath(candidate.database)).toBe(candidate.database);
    identities.push(await realpath(candidate.database));

    // Revision comes from the candidate checkout, not an injected runtime label.
    expect(health.source.revision).toBe(process.env.ACCEPTANCE_CHECKOUT_SHA);
    expect(health.source.mcp_contract.fingerprint).toBe(contract.mcp_contract_fingerprint);
    const version = await candidate.request('resources/read', { uri: 'sympp://health/version' });
    expect(JSON.parse(version.contents[0].text).source.revision).toBe(process.env.ACCEPTANCE_CHECKOUT_SHA);
    expect(existsSync(join(candidate.home, '.agents', 'splusplus', 'symphony_plus_plus.sqlite3'))).toBe(false);
  }
  expect(identities[0]).not.toBe(identities[1]);
  expect(candidates.primary.process.pid).not.toBe(candidates.peer.process.pid);
  // Both stay healthy after the other has booted; neither startup replaced its peer.
  for (const candidate of [candidates.primary, candidates.peer]) {
    const response = await candidate.request('tools/call', { name: 'sympp.health', arguments: {} });
    expect(response.structuredContent.status).toBe('ok');
    expect(response.structuredContent.ledger.reachable).toBe(true);
  }
});
