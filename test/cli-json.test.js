import { test } from 'node:test';
import assert from 'node:assert/strict';

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

test('--json reports an invalid gateway URL as one error event', async () => {
  const stdout = await runStubbed(['3000', '--json', '--gateway', 'nope']);
  assert.equal(stdout.length, 1);
  assert.equal(JSON.parse(stdout[0]).code, 'INVALID_GATEWAY_URL');
});

test('without --json the invalid-target error prints no JSON on stdout', async () => {
  const stdout = await runStubbed(['99999']);
  assert.deepEqual(stdout, []);
});
