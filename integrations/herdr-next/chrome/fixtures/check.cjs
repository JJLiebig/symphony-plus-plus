// Controlled executable boundary for portable installer tests; native rendering is checked separately.
if (require('node:path').basename(process.argv[1] || '') === 'check') {
  const { spawnSync } = require('node:child_process');
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  // Node 26.3 file detection can swallow an ESM syntax error; parse the module explicitly.
  const result = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: readFileSync(join(process.argv[2], 'main.js'), 'utf8'),
    env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', windowsHide: true,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
