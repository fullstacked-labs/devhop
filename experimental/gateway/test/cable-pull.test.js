// Cable-pull harness: kills the client's WSS socket mid-stream and checks the seam.
// Mid-stream: open a phone request against a slow-streaming dev server, then
// SIGKILL-style destroy the client's WSS socket. Assert: reclaim within the
// grace window + headroom, at most ONE clean error response for the killed
// request, full body intact on the next request (order preserved — exercises
// half-close discipline), parked-conn replay never hangs, no state leak on
// /health.
//
// Wall-clock is kept short with injectable timers (grace 300ms, client
// backoff 25ms base) — the criterion is the RATIO (reclaim < grace + 5s
// headroom simulated), not the absolute 35s.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { Relay } from '../src/relay.js';
import { startGateway } from '../src/client.js';

const SALT = 'cable-pull-salt';
const GRACE_MS = 300;

function subFor(token) {
  return crypto.createHash('sha256').update(`${token}${SALT}`).digest('hex').slice(0, 6);
}

// Slow-streaming dev server: 4 × 256 KiB chunks, 50ms apart, deterministic
// content so order and completeness are assertable.
const CHUNKS = 4;
const CHUNK_SIZE = 256 * 1024;
function chunkContent(i) {
  return Buffer.alloc(CHUNK_SIZE, 0x40 + i); // 'A', 'B', 'C', 'D'
}
function startSlowDev() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      let i = 0;
      const t = setInterval(() => {
        if (i < CHUNKS) {
          res.write(chunkContent(i));
          i++;
        } else {
          clearInterval(t);
          res.end();
        }
      }, 50);
      req.on('close', () => clearInterval(t));
      res.on('close', () => clearInterval(t));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Raw phone request with progress: resolves { status, body } when the socket
// closes, or on timeout; exposes bytes received so far for hang checks.
function phoneRequest(relayPort, host, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let body = Buffer.alloc(0);
    let settled = false;
    const sock = net.connect(relayPort, '127.0.0.1', () => {
      sock.write(`GET /stream HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
    });
    const done = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ status, body });
    };
    const timer = setTimeout(() => done('hang'), timeoutMs);
    sock.on('data', (d) => (body = Buffer.concat([body, d])));
    sock.on('close', () => {
      const m = body.toString('latin1', 0, 60).match(/HTTP\/1\.1 (\d+)/);
      done(m ? Number(m[1]) : 'closed');
    });
    sock.on('error', () => done('error'));
  });
}

function countChunks(body) {
  // Body includes the HTTP head; verify all 4 chunk markers appear in order.
  const buf = Buffer.from(body);
  const idx = [];
  for (let i = 0; i < CHUNKS; i++) {
    const at = buf.indexOf(chunkContent(i));
    if (at === -1) return { complete: false, ordered: false };
    idx.push(at);
  }
  return { complete: true, ordered: idx.every((v, i) => i === 0 || v > idx[i - 1]) };
}

describe('cable-pull', () => {
  it('reclaims within grace, ≤1 error response, body intact, parked conn never hangs, no state leak', { timeout: 15_000 }, async () => {
    const relay = new Relay({ port: 0, salt: SALT, timers: { grace: GRACE_MS, ingressDiscard: 400 } });
    const { server: devServer, port: devPort } = await startSlowDev();
    await new Promise((r) => relay.listen(r));

    const TOKEN = 'cable';
    const urls = [];
    let gw = startGateway({
      localPort: devPort,
      gatewayUrl: `ws://127.0.0.1:${relay.address().port}`,
      token: TOKEN,
      backoffBaseMs: 25,
      onUrl: (u) => urls.push(u),
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(urls.length, 1, 'initial onUrl');
    const subHost = `${subFor(TOKEN)}.127.0.0.1`;
    const baselineSockets = relay.health.sockets;

    // 2. Phone request lands mid-stream (dev server is streaming slowly).
    const killedReq = phoneRequest(relay.address().port, subHost);

    // 3. SIGKILL-style pull: destroy the client's WSS socket, no WS CLOSE.
    await new Promise((r) => setTimeout(r, 60)); // stream is live (chunks flow)
    gw.destroyForTest();

    // 4. Process-sim: reconnect immediately with the same token, same options.
    const tKill = Date.now();
    gw = startGateway({
      localPort: devPort,
      gatewayUrl: `ws://127.0.0.1:${relay.address().port}`,
      token: TOKEN,
      backoffBaseMs: 25,
      onUrl: (u) => urls.push(u),
    });

    // 6. Parked-conn check: second phone request DURING grace, before the
    // reconnect's REGISTER lands. It must resolve (replay or one 503), never
    // hang.
    const parkedReq = phoneRequest(relay.address().port, subHost, 3000);

    // 5a. Reclaim: same sub via onUrl, within grace + headroom.
    await new Promise((r) => setTimeout(r, GRACE_MS + 200));
    assert.ok(
      urls.length >= 2 && urls[1] === urls[0],
      `same sub reclaimed via onUrl (got ${JSON.stringify(urls)})`
    );
    assert.ok(Date.now() - tKill < GRACE_MS + 5000, 'reclaim inside grace + headroom');

    const parked = await parkedReq;
    assert.notEqual(parked.status, 'hang', 'parked conn must never hang');
    assert.ok(
      parked.status === 200 || parked.status === 503,
      `parked conn replayed or one clean 503 (got ${parked.status})`
    );

    // 5b. The killed request: at most ONE error response (503 or 502).
    const killed = await killedReq;
    const errorHits = (Buffer.from(killed.body).toString('latin1').match(/HTTP\/1\.1 (503|502)/g) || []).length;
    assert.ok(
      (killed.status === 503 || killed.status === 502 || errorHits <= 1) && errorHits <= 1,
      `at most one error response for the killed request (status ${killed.status}, hits ${errorHits})`
    );

    // Fresh phone request: full streamed body, all chunks, order preserved.
    const fresh = await phoneRequest(relay.address().port, subHost, 8000);
    assert.equal(fresh.status, 200, 'fresh request round-trips after reclaim');
    const { complete, ordered } = countChunks(fresh.body);
    assert.ok(complete, 'all 4 chunks present');
    assert.ok(ordered, 'chunks in order (half-close discipline intact)');

    // 5c. Settle, then no state leak.
    await new Promise((r) => setTimeout(r, 400));
    const h = relay.health;
    assert.equal(h.tunnels, 1, `exactly one tunnel (got ${h.tunnels})`);
    assert.equal(h.streams, 0, `no orphan streams (got ${h.streams})`);
    assert.ok(h.sockets <= baselineSockets + 1, `sockets back to baseline (got ${h.sockets}, baseline ${baselineSockets})`);

    gw.close();
    relay.close(() => devServer.close(() => process.exit(0)));
  });
});
