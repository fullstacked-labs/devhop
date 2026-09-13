import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import readline from 'node:readline';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { copyToClipboard } from '../src/clipboard.js';
import { setupShortcuts } from '../src/cli.js';

function setProperty(t, object, key, value) {
  const original = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { configurable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(object, key, original);
    else delete object[key];
  });
}

function setEnvironment(t, values) {
  const original = { ...process.env };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const key of Object.keys(values)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
}

for (const { name, tty, ci, args } of [
  { name: 'piped stdin', tty: undefined, ci: undefined, args: [] },
  { name: 'CI', tty: true, ci: '1', args: [] },
  { name: 'JSON mode', tty: true, ci: undefined, args: ['--json', '--copy'] }
]) {
  test(`Shortcuts never read stdin in ${name}`, (t) => {
    setProperty(t, process.stdin, 'isTTY', tty);
    setEnvironment(t, { CI: ci });
    const create = t.mock.method(readline, 'createInterface', () => { throw new Error('stdin must not be read'); });
    assert.equal(setupShortcuts(args, { getUrl: () => 'https://example.com', quit: () => {} }), null);
    assert.equal(create.mock.callCount(), 0);
  });
}

test('Shortcuts wait for enter, show help on demand, and quit without raw mode', (t) => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => { throw new Error('raw mode is forbidden'); };
  setProperty(t, process, 'stdin', input);
  setEnvironment(t, { CI: undefined });
  const messages = [];
  t.mock.method(console, 'log', (message) => messages.push(message));
  let quits = 0;
  const shortcuts = setupShortcuts([], { getUrl: () => null, quit: () => { quits++; } });
  t.after(() => { shortcuts.close(); input.destroy(); });
  assert.deepEqual(messages, []);
  input.write('h');
  assert.deepEqual(messages, []);
  input.write('\n');
  assert.match(messages[0], /c \+ enter.*copy tunnel URL/);
  input.write('q');
  assert.equal(quits, 0);
  input.write('\n');
  assert.equal(quits, 1);
});

for (const tmux of [undefined, '/tmp/tmux-1000/default,1234,0']) {
  test(`Clipboard emits OSC 52${tmux ? ' with tmux passthrough' : ''}`, (t) => {
    setProperty(t, process.stdout, 'isTTY', true);
    setEnvironment(t, { TMUX: tmux, DISPLAY: undefined, WAYLAND_DISPLAY: undefined });
    setProperty(t, process, 'platform', 'linux');
    const writes = [];
    t.mock.method(fs, 'writeSync', (fd, text) => { writes.push(text); return text.length; });
    copyToClipboard('https://example.com/π');
    const payload = Buffer.from('https://example.com/π').toString('base64');
    assert.deepEqual(writes, [tmux ? `\x1bPtmux;\x1b\x1b]52;c;${payload}\x07\x1b\\` : `\x1b]52;c;${payload}\x07`]);
  });
}

test('Clipboard never throws or emits output with no terminal or display', (t) => {
  setProperty(t, process.stdout, 'isTTY', false);
  setProperty(t, process, 'platform', 'linux');
  setEnvironment(t, { DISPLAY: undefined, WAYLAND_DISPLAY: undefined });
  const write = t.mock.method(fs, 'writeSync', () => { throw new Error('unexpected terminal output'); });
  assert.doesNotThrow(() => copyToClipboard('https://example.com'));
  assert.equal(write.mock.callCount(), 0);
});

test('Clipboard ignores terminal failures and asynchronous native command errors', (t) => {
  setProperty(t, process.stdout, 'isTTY', true);
  setProperty(t, process, 'platform', 'linux');
  setEnvironment(t, { WAYLAND_DISPLAY: 'wayland-0' });
  t.mock.method(fs, 'writeSync', () => { throw new Error('terminal closed'); });
  const child = new EventEmitter();
  child.unref = () => {};
  const spawn = t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.doesNotThrow(() => copyToClipboard('https://example.com'));
  assert.equal(spawn.mock.callCount(), 1);
  assert.doesNotThrow(() => child.emit('error', new Error('command unavailable')));
});

test('Clipboard stays untouched until c plus enter', (t) => {
  const input = new PassThrough();
  input.isTTY = true;
  setProperty(t, process, 'stdin', input);
  setProperty(t, process.stdout, 'isTTY', true);
  setProperty(t, process, 'platform', 'linux');
  setEnvironment(t, { CI: undefined, DISPLAY: undefined, WAYLAND_DISPLAY: undefined, TMUX: undefined });
  const writes = [];
  t.mock.method(fs, 'writeSync', (fd, text) => { writes.push(text); return text.length; });
  const url = 'https://example.com';
  const shortcuts = setupShortcuts([], { getUrl: () => url, quit: () => {} });
  t.after(() => { shortcuts.close(); input.destroy(); });
  assert.deepEqual(writes, []);
  input.write('c');
  assert.deepEqual(writes, []);
  input.write('\n');
  assert.deepEqual(writes, [`\x1b]52;c;${Buffer.from(url).toString('base64')}\x07`]);
});
