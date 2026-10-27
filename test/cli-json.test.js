import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

test('SIGTERM leaves no cloudflared behind, even one that ignores SIGTERM', async (t) => {
  if (process.platform === 'win32') { t.skip('Shell script stub test skipped on Windows'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhop-quit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'pid');
  const stub = path.join(dir, 'fake-cloudflared');
  fs.writeFileSync(stub, [
    '#!/usr/bin/env node',
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  fs.chmodSync(stub, '755');

  const devhop = spawn(process.execPath, [new URL('../bin/devhop.js', import.meta.url).pathname, '9', '--json'], {
    env: { ...process.env, DEVHOP_CLOUDFLARED: stub },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let stdout = '';
  devhop.stdout.on('data', (chunk) => { stdout += chunk; });
  const stubPid = await new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const pid = fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8'));
      if (pid) { clearInterval(poll); resolve(pid); }
      else if (Date.now() - started > 5000) { clearInterval(poll); reject(new Error('cloudflared stub never started')); }
    }, 20);
  });
  t.after(() => { try { process.kill(stubPid, 'SIGKILL'); } catch (_) {} });

  const exited = new Promise((resolve) => devhop.once('exit', resolve));
  devhop.kill('SIGTERM');

  assert.equal(await exited, 0);
  assert.throws(() => process.kill(stubPid, 0), { code: 'ESRCH' }, 'cloudflared must be gone when devhop exits');
  assert.equal(JSON.parse(stdout.trim()).event, 'closed');
});
