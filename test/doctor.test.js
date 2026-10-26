import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { collectDiagnostics, formatDiagnostics } from '../src/doctor.js';

test('collectDiagnostics returns the documented keys', async () => {
  const d = await collectDiagnostics();
  assert.deepEqual(
    Object.keys(d).sort(),
    ['arch', 'cacheDir', 'cloudflared', 'devPorts', 'devhop', 'node', 'platform']
  );
  assert.equal(d.node, process.version);
  assert.deepEqual(Object.keys(d.cloudflared).sort(), ['cached', 'override', 'path', 'version']);
});

test('formatDiagnostics says when cloudflared is not downloaded', () => {
  const out = formatDiagnostics({
    devhop: '0.2.0',
    node: 'v22.0.0',
    platform: 'linux',
    arch: 'x64',
    cloudflared: { path: '~/.cache/devhop/bin/cloudflared', override: false, cached: false, version: null },
    devPorts: [],
    cacheDir: '~/.cache/devhop/bin',
  });
  assert.match(out, /not downloaded yet/);
  assert.match(out, /none detected/);
});

test('the formatted output never contains the home directory', async () => {
  const out = formatDiagnostics(await collectDiagnostics());
  assert.ok(!out.includes(os.homedir()));
});
