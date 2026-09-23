// Integration tests for the gateway client (§9 test plan, client slice).
// Runs against the REAL relay (Relay on port 0) + a plain http mock dev
// server standing in for the masquerade proxy. Mirrors relay.test.js.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { Relay } from '../../src/gateway/relay.js';
import { startGateway } from '../../src/gateway/client.js';
import { FRAME, encodeFrame, FrameDecoder } from '../../src/gateway/frames.js';

const SALT = 'test-salt';

function subFor(token) {
  return crypto.createHash('sha256').update(`${token}${SALT}`).digest('hex').slice(0, 6);
}

function startRelay(timers = {}) {
  return new Promise((resolve) => {
    const relay = new Relay({ port: 0, salt: SALT, timers });
    relay.httpSrv = relay.listen(() => resolve({ relay, port: relay.address().port }));
  });
}

// Phone-side request through the relay's ingress (Host routing, R7).
function requestWithHost(port, host, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', path, agent: false, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function mockDevServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler ?? ((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 14 });
      res.end('hello from dev');
    }));
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

let relay, relayPort;

// Unmask-position parser for one client WS frame (RFC 6455 §5.3); the fake
// gateway only needs frame boundaries, not the payload.
function wsParseMasked(buf, off) {
  if (buf.length - off < 2) return null;
  const opcode = buf[off] & 0x0f;
  let len = buf[off + 1] & 0x7f;
  let pos = off + 2;
  if ((buf[off + 1] & 0x80) !== 0) {
    if (buf.length - pos < 4) return null;
    pos += 4;
  }
  if (buf.length - pos < len) return null;
  return { opcode, next: pos + len };
}

// Plain (server→client) WS message.
function wsPlain(opcode, payload) {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}
let clientSockets = []; // relay-side sockets of /_gateway/register upgrades

beforeEach(async () => {
  clientSockets = [];
  ({ relay, port: relayPort } = await startRelay({ grace: 300, ingressDiscard: 300 }));
  relay.httpSrv.on('upgrade', (req, socket) => {
    if (req.url.startsWith('/_gateway/register')) clientSockets.push(socket);
  });
});

afterEach(async () => {
  relay.httpSrv.removeAllListeners('upgrade');
  await new Promise((r) => relay.close(r));
});

describe('gateway client REGISTER', () => {
  it('fires onUrl with the sha256(token+salt)-derived sub', async () => {
    const urls = [];
    const gw = startGateway({
      localPort: 1, // never dialed in this test
      gatewayUrl: `ws://127.0.0.1:${relayPort}`,
      token: 'tok-1',
      onUrl: (u) => urls.push(u),
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(urls.length, 1);
    assert.equal(urls[0], `https://${subFor('tok-1')}.devhop.se`);
    gw.close();
  });

  it('honors urlTemplate for the derived URL', async () => {
    const urls = [];
    const gw = startGateway({
      localPort: 1,
      gatewayUrl: `ws://127.0.0.1:${relayPort}`,
      token: 'tpl',
      urlTemplate: 'http://<sub>.test:8099',
      onUrl: (u) => urls.push(u),
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(urls[0], `http://${subFor('tpl')}.test:8099`);
    gw.close();
  });

  it('goes DEAD on a fatal REGISTER_ERR: onError + onClose, no reconnect', async () => {
    // Stand up a minimal gateway that answers every REGISTER with a fatal
    // (code 1) REGISTER_ERR and records how many connections it saw.
    let connections = 0;
    const fake = http.createServer();
    fake.on('upgrade', (req, socket) => {
      connections++;
      const accept = crypto
        .createHash('sha1')
        .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      let carry = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        carry = Buffer.concat([carry, chunk]);
        for (;;) {
          const msg = wsParseMasked(carry, 0);
          if (!msg) break;
          carry = Buffer.from(carry.subarray(msg.next));
          const msgText = 'fatal: rejected';
          const body = Buffer.alloc(3 + msgText.length);
          body[0] = 1; // BAD_TOKEN — fatal
          body.writeUInt16BE(msgText.length, 1);
          body.write(msgText, 3);
          socket.write(wsPlain(0x2, encodeFrame(FRAME.REGISTER_ERR, body)));
          socket.end(); // server closes after REGISTER_ERR (§6)
        }
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));

    const events = { errors: [], closes: 0, retries: 0, urls: 0 };
    const gw = startGateway({
      localPort: 1,
      gatewayUrl: `ws://127.0.0.1:${fake.address().port}`,
      token: 'fatal',
      onUrl: () => events.urls++,
      onRetry: () => events.retries++,
      onError: (e) => events.errors.push(e),
      onClose: () => events.closes++,
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(events.errors.length, 1, 'onError fired once');
    assert.match(events.errors[0].message, /refused registration/);
    assert.equal(events.closes, 1, 'onClose fired');
    assert.equal(events.retries, 0, 'no reconnect after fatal REGISTER_ERR');
    assert.equal(events.urls, 0);
    assert.equal(connections, 1, 'dialed exactly once — no reconnect after DEAD');
    gw.close();
    await new Promise((r) => fake.close(r));
  });
});

describe('gateway client end-to-end', () => {
  it('round-trips a phone request: relay → OPEN → client → dev server → 200', async () => {
    const { server: devServer, port: devPort } = await mockDevServer();
    const gw = startGateway({
      localPort: devPort,
      gatewayUrl: `ws://127.0.0.1:${relayPort}`,
      token: 'e2e',
      onUrl: () => {},
    });
    await new Promise((r) => setTimeout(r, 100));

    const phoneRes = await requestWithHost(relayPort, `${subFor('e2e')}.devhop.se`);
    assert.equal(phoneRes.status, 200);
    assert.equal(phoneRes.body, 'hello from dev');

    gw.close();
    await new Promise((r) => devServer.close(r));
  });

  it('reconnects mid-active: same sub, onUrl not re-fired, 503 in the gap then success', async () => {
    const urls = [];
    const retries = [];
    const { server: devServer, port: devPort } = await mockDevServer();
    // backoffBaseMs > grace: the reconnect cannot beat the 300ms grace, so
    // the phone deterministically hits the relay's 503 (§5) in the gap.
    const gw = startGateway({
      localPort: devPort,
      gatewayUrl: `ws://127.0.0.1:${relayPort}`,
      token: 'recon',
      backoffBaseMs: 600,
      onUrl: (u) => urls.push(u),
      onRetry: (a) => retries.push(a),
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(urls.length, 1);
    assert.equal((await requestWithHost(relayPort, `${subFor('recon')}.devhop.se`)).body, 'hello from dev');

    // Kill the relay-side client socket mid-active (captured at upgrade).
    clientSockets.splice(0).forEach((s) => s.destroy());

    // Client notices, backs off (base 500ms > the 300ms grace), then reclaims.
    // In the gap the binding expires → the phone gets the relay's 503 (§5).
    // Poll: the exact moment the relay authoring the 503 (vs the reclaim
    // racing ahead) is timing-dependent — catch it at least once.
    let saw503 = false;
    for (let i = 0; i < 30 && !saw503; i++) {
      const r = await requestWithHost(relayPort, `${subFor('recon')}.devhop.se`).catch(() => null);
      if (r && r.status === 503) saw503 = true;
      else await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(saw503, 'phone saw the relay 503 while the tunnel was down');

    // After reclaim: success, same URL, onUrl NOT re-fired (§4/R10).
    await new Promise((r) => setTimeout(r, 1200));
    const res2 = await requestWithHost(relayPort, `${subFor('recon')}.devhop.se`);
    assert.equal(res2.status, 200);
    assert.equal(res2.body, 'hello from dev');
    assert.equal(urls.length, 1, 'onUrl not re-fired when URL unchanged');
    assert.equal(retries.length, 1, 'one onRetry for the reconnect');

    gw.close();
    await new Promise((r) => devServer.close(r));
  });

  it('retries with increasing backoff delays and fires onRetry per attempt', async () => {
    // Dead port: connection refused every dial → RECONNECTING loop.
    const retries = [];
    const gw = startGateway({
      localPort: 1,
      gatewayUrl: 'ws://127.0.0.1:1', // nothing listens on port 1
      backoffBaseMs: 50,
      onRetry: (attempt, delay) => retries.push({ attempt, delay }),
      onUrl: () => {},
    });
    await new Promise((r) => setTimeout(r, 450));
    assert.ok(retries.length >= 2, `expected ≥2 retries, got ${retries.length}`);
    assert.deepEqual(retries.map((r) => r.attempt), Array.from({ length: retries.length }, (_, i) => i + 1));
    // ±50% jitter around exp growth: delay 1 ∈ [25,75], delay 2 ∈ [50,150].
    assert.ok(retries[0].delay >= 20 && retries[0].delay <= 90, `delay 1 in jitter range: ${retries[0].delay}`);
    assert.ok(retries[1].delay >= 40 && retries[1].delay <= 180, `delay 2 in jitter range: ${retries[1].delay}`);
    gw.close();
  });

  it('close() ends the session with no reconnect', async () => {
    const urls = [];
    const retries = [];
    const closes = [];
    const gw = startGateway({
      localPort: 1,
      gatewayUrl: `ws://127.0.0.1:${relayPort}`,
      token: 'bye',
      onUrl: (u) => urls.push(u),
      onRetry: (a) => retries.push(a),
      onClose: () => closes.push(1),
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(urls.length, 1);
    const socketsBefore = relay.health.sockets;
    gw.close();
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(relay.health.sockets < socketsBefore, 'relay saw the socket close');
    assert.equal(retries.length, 0, 'no reconnect after manual close');
    assert.equal(closes.length, 0, 'no onClose for a manual close');
    assert.equal(relay.health.tunnels, 0, 'binding gone (tunnel not live)');
  });

  it('tokenless mode: reconnect keeps the same sub (§7/R10 via client session nonce)', async () => {
    const urls = [];
    const { server: devServer, port: devPort } = await mockDevServer();
    // Fast backoff: the client reclaims well inside the 300ms grace.
    const gw = startGateway({
      localPort: devPort,
      gatewayUrl: `ws://127.0.0.1:${relayPort}`,
      token: '',
      backoffBaseMs: 25,
      onUrl: (u) => urls.push(u),
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(urls.length, 1, 'initial onUrl fired');
    const url = urls[0];
    assert.equal(
      (await requestWithHost(relayPort, new URL(url).host)).body,
      'hello from dev',
      'tokenless tunnel serves the dev server'
    );

    // Kill the relay-side socket mid-active; client must reclaim the SAME
    // sub — its session nonce (minted once per startGateway call) is the
    // token the relay hashes, so R10 URL stability holds without a token.
    clientSockets.splice(0).forEach((s) => s.destroy());
    await new Promise((r) => setTimeout(r, 600));

    assert.equal(urls.length, 1, 'onUrl not re-fired — same sub reclaimed');
    assert.equal(new URL(urls[0]).host, new URL(url).host, 'URL unchanged across reconnect');
    const res = await requestWithHost(relayPort, new URL(url).host);
    assert.equal(res.status, 200, 'reclaimed tunnel still serves');

    gw.close();
    await new Promise((r) => devServer.close(r));
  });
});
