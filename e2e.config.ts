import type { E2EConfig } from 'e2e';

export default {
  tests: 'tests/acceptance/**/*.e2e.ts',
  targets: [{ name: 'api', platform: 'api' }],
  workers: 1,
  retries: 0,
  cache: { mode: 'read-only', strict: true },
  timeout: 120_000,
  cleanupTimeout: 30_000,
  trace: 'on',
  // No model or executor: acquiring an agent fails before model transport exists.
  agents: { default: {} },
} satisfies E2EConfig;
