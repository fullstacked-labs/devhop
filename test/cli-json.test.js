import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPortOpen } from '../src/port.js';

async function runStubbed(args) {
  const { run } = await import('../src/cli.js');
  const original = { log: console.log, error: console.error, exit: process.exit };
  const stdout = [];
  console.log = (...a) => stdout.push(a.join(' '));
  console.error = () => {};
  process.exit = (code) => { throw new Error(`exit:${code}`); };
  try {
    await run(args);
    assert.fail('must exit before tunnel startup');
  } catch (err) {
    assert.match(err.message, /exit:1/);
  } finally {
    Object.assign(console, { log: original.log, error: original.error });
    process.exit = original.exit;
  }
  return stdout;
}

test('--json reports an invalid target as one error event', async () => {
  const stdout = await runStubbed(['99999', '--json']);
  assert.equal(stdout.length, 1);
  const event = JSON.parse(stdout[0]);
  assert.equal(event.event, 'error');
  assert.equal(event.code, 'INVALID_TARGET');
  assert.ok(event.message.length > 0);
});

test('--json reports an unknown option as one error event', async () => {
  const stdout = await runStubbed(['3000', '--jsno', '--json']);
  assert.equal(stdout.length, 1);
  const event = JSON.parse(stdout[0]);
  assert.equal(event.code, 'INVALID_ARGUMENT');
  assert.match(event.message, /--jsno/);
});

test('--json reports two targets as one error event', async () => {
  const stdout = await runStubbed(['3000', '4000', '--json']);
  assert.equal(stdout.length, 1);
  assert.equal(JSON.parse(stdout[0]).code, 'INVALID_ARGUMENT');
});

test('--json reports the quarantined gateway flag as one error event', async () => {
  const stdout = await runStubbed(['3000', '--json', '--gateway', 'wss://relay.example.com']);
  assert.equal(stdout.length, 1);
  assert.equal(JSON.parse(stdout[0]).code, 'GATEWAY_UNAVAILABLE');
});

test('without --json the invalid-target error prints no JSON on stdout', async () => {
  const stdout = await runStubbed(['99999']);
  assert.deepEqual(stdout, []);
});

// Runs `devhop 9 --json` against a cloudflared stub that records its argv and
// ignores SIGTERM, and waits until the stub is up.
async function startDevhopWithStub(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhop-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  const stub = path.join(dir, 'fake-cloudflared');
  fs.writeFileSync(stub, [
    '#!/usr/bin/env node',
    `require('fs').writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }));`,
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  fs.chmodSync(stub, '755');

  const devhop = spawn(process.execPath, [new URL('../bin/devhop.js', import.meta.url).pathname, '9', '--json'], {
    env: { ...process.env, DEVHOP_CLOUDFLARED: stub },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => devhop.kill('SIGKILL'));
  let stdout = '';
  devhop.stdout.on('data', (chunk) => { stdout += chunk; });
  const state = await new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const raw = fs.existsSync(stateFile) && fs.readFileSync(stateFile, 'utf8');
      if (raw) { clearInterval(poll); resolve(JSON.parse(raw)); }
      else if (Date.now() - started > 5000) { clearInterval(poll); reject(new Error('cloudflared stub never started')); }
    }, 20);
  });
  t.after(() => { try { process.kill(state.pid, 'SIGKILL'); } catch (_) {} });
  return { devhop, state, output: () => stdout };
}

test('devhop hands cloudflared the port its proxy is listening on', async (t) => {
  if (process.platform === 'win32') { t.skip('Shell script stub test skipped on Windows'); return; }
  const { state } = await startDevhopWithStub(t);

  const url = new URL(state.argv[state.argv.indexOf('--url') + 1]);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(await isPortOpen(Number(url.port)), true);
});

test('SIGTERM leaves no cloudflared behind, even one that ignores SIGTERM', async (t) => {
  if (process.platform === 'win32') { t.skip('Shell script stub test skipped on Windows'); return; }
  const { devhop, state, output } = await startDevhopWithStub(t);

  const exited = new Promise((resolve) => devhop.once('close', resolve));
  devhop.kill('SIGTERM');

  assert.equal(await exited, 0);
  assert.throws(() => process.kill(state.pid, 0), { code: 'ESRCH' }, 'cloudflared must be gone when devhop exits');
  assert.equal(JSON.parse(output().trim()).event, 'closed');
});
