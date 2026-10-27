import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';

test('parseArgs picks the mode before looking at anything else', () => {
  const cases = [
    [['--help'], 'help'],
    [['-h'], 'help'],
    [['3000', '--version'], 'version'],
    [['-v'], 'version'],
    [['--doctor', '--json'], 'doctor'],
    [['--help', '--version'], 'help'],
  ];
  for (const [args, mode] of cases) {
    assert.equal(parseArgs(args).mode, mode, args.join(' '));
  }
});

test('parseArgs reads options and the target for a normal run', () => {
  const cases = [
    [[], { json: false, qr: true, protocol: undefined, target: null }],
    [['3000'], { json: false, qr: true, protocol: undefined, target: { port: 3000, host: '127.0.0.1', protocol: 'http:' } }],
    [['--json', '5173'], { json: true, qr: false, protocol: undefined, target: { port: 5173, host: '127.0.0.1', protocol: 'http:' } }],
    [['3000', '--no-qr'], { json: false, qr: false, protocol: undefined, target: { port: 3000, host: '127.0.0.1', protocol: 'http:' } }],
    [['3000', '--http2'], { json: false, qr: true, protocol: 'http2', target: { port: 3000, host: '127.0.0.1', protocol: 'http:' } }],
    [['https://localhost:8443'], { json: false, qr: true, protocol: undefined, target: { port: 8443, host: 'localhost', protocol: 'https:' } }],
    [['[::1]:3000'], { json: false, qr: true, protocol: undefined, target: { port: 3000, host: '::1', protocol: 'http:' } }],
  ];
  for (const [args, expected] of cases) {
    assert.deepEqual(parseArgs(args), { mode: 'run', ...expected }, args.join(' '));
  }
});

test('parseArgs reports an unparseable target as INVALID_TARGET and keeps the json flag', () => {
  for (const bad of ['99999', 'invalid-target', 'ftp://localhost:21']) {
    const result = parseArgs([bad, '--json']);
    assert.equal(result.error.code, 'INVALID_TARGET', bad);
    assert.equal(result.json, true);
    assert.ok(result.error.message.includes(`"${bad}"`));
    assert.match(result.error.hint, /npx devhop 3000/);
  }
});

test('parseArgs rejects unknown options with INVALID_ARGUMENT', () => {
  for (const args of [['3000', '--jsno'], ['--jsno', '3000'], ['3000', '-x'], ['3000', '--json=true'], ['--no-qrcode']]) {
    const result = parseArgs(args);
    assert.equal(result.error?.code, 'INVALID_ARGUMENT', args.join(' '));
    assert.match(result.error.message, /^Unknown option "-/);
    assert.match(result.error.hint, /--json, --no-qr, --http2/);
  }
});

test('parseArgs rejects more than one target with INVALID_ARGUMENT', () => {
  for (const args of [['3000', '4000'], ['3000', '--json', 'localhost:5173'], ['3000', 'garbage']]) {
    const result = parseArgs(args);
    assert.equal(result.error?.code, 'INVALID_ARGUMENT', args.join(' '));
    assert.match(result.error.message, /^Expected one target, got "/);
  }
  assert.equal(parseArgs(['3000', '4000', '--json']).json, true);
});

test('parseArgs rejects the quarantined --gateway flag in both spellings', () => {
  for (const args of [['--gateway', 'wss://relay.example.com'], ['--gateway=wss://relay.example.com', '3000']]) {
    assert.equal(parseArgs(args).error.code, 'GATEWAY_UNAVAILABLE', args.join(' '));
  }
});
