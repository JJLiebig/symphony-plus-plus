// Controlled executable boundary for portable installer tests; native rendering is checked separately.
if (require('node:path').basename(process.argv[1] || '') === 'check') {
  const { spawnSync } = require('node:child_process');
  const { join } = require('node:path');
  const result = spawnSync(process.execPath, ['--check', join(process.argv[2], 'main.js')], {
    env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', windowsHide: true,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
