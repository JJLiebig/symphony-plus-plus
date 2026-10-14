import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { appendFileSync } from 'node:fs';

const browser = process.env.SYMPP_BROWSER_ACCEPTANCE === '1';
const recording = browser && process.env.SYMPP_BROWSER_RECORDING === '1';
if (recording && process.env.CI) throw new Error('Browser model recording is local-only');
const disabledModel = {
  specificationVersion: 'v4' as const,
  provider: 'b3-disabled',
  modelId: 'gpt-6-luna',
  supportedUrls: {},
  doGenerate: async () => {
    appendFileSync('.e2e/model-denials.jsonl', `${JSON.stringify({ method: 'doGenerate', network: false })}\n`);
    throw new Error('B3_REPLAY_MODEL_DISABLED: model generation and network transport are unavailable');
  },
  doStream: async () => {
    appendFileSync('.e2e/model-denials.jsonl', `${JSON.stringify({ method: 'doStream', network: false })}\n`);
    throw new Error('B3_REPLAY_MODEL_DISABLED: model generation and network transport are unavailable');
  },
};
// Hosted replay never imports or constructs a provider/OAuth client.
const model = recording ? (await import('e2e/oauth/chatgpt')).chatgpt('gpt-6-luna') : disabledModel;

export default {
  tests: browser
    ? ['tests/acceptance/operator-board.e2e.ts', 'tests/acceptance/herdr-inspector.e2e.ts']
    : ['tests/acceptance/**/*.e2e.ts', '!tests/acceptance/operator-board.e2e.ts', '!tests/acceptance/herdr-inspector.e2e.ts'],
  targets: browser
    ? [{ name: 'browser', engine: web({ viewport: { width: 1440, height: 1000 } }), app: { url: 'http://127.0.0.1:20373' } }]
    : [{ name: 'api', platform: 'api' }],
  workers: 1,
  retries: 0,
  cache: { mode: recording ? 'read-write' : 'read-only', strict: !recording },
  timeout: 120_000,
  cleanupTimeout: 30_000,
  trace: 'on',
  agents: { default: browser ? {
    model,
    maxSteps: 6,
    maxModelCalls: 4,
    providerOptions: { openai: { reasoningEffort: 'low' } },
  } : {} },
} satisfies E2EConfig;
