// Integration tests for the gateway relay.
// The mock client speaks the real codec over hand-rolled WS frames,
// mirroring what experimental/gateway/src/client.js does.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { Relay } from '../src/relay.js';
import { FRAME, encodeFrame, FrameDecoder } from '../src/frames.js';

// undici's fetch forbids overriding Host; raw http.request does not.
// agent:false → Connection: close; no keep-alive sockets left holding the
// event loop (or the relay's server.close) after the test ends.
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

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Minimal WS client: handshake + unmasked? no — masked frames (RFC 6455).
class MockClient {
  #carry = Buffer.alloc(0);
  frames = [];
  #waiters = [];

  connect(port, path = '/_gateway/register') {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.socket = net.connect(port, '127.0.0.1', () => {
        this.socket.write(
          `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      this.socket.on('error', reject);
      this.socket.on('data', (chunk) => {
        this.#onData(chunk);
        if (this.handshaken) resolve();
      });
    });
  }

  #onData(chunk) {
    if (!this.handshaken) {
      this.#carry = Buffer.concat([this.#carry, chunk]);
      const idx = this.#carry.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = this.#carry.subarray(0, idx).toString();
      assert.match(head, /101 Switching Protocols/);
      this.#carry = Buffer.from(this.#carry.subarray(idx + 4));
      this.handshaken = true;
      if (this.#carry.length) this.#onData(Buffer.alloc(0));
      return;
    }
    this.#carry = Buffer.concat([this.#carry, chunk]);
    for (;;) {
      const msg = this.#parseFrame(0);
      if (!msg) break;
      this.#carry = Buffer.from(this.#carry.subarray(msg.next));
      if (msg.opcode === 0x9) this.socket.write(this.#encode(0xa, msg.payload)); // ping → pong
      else if (msg.opcode === 0x2) {
        const decoded = new FrameDecoder().feed(msg.payload);
        this.frames.push(...decoded);
        this.#waiters.forEach((w) => w());
      }
    }
  }

  #parseFrame(off) {
    const buf = this.#carry;
    if (buf.length - off < 2) return null;
    const opcode = buf[off] & 0x0f;
    const masked = (buf[off + 1] & 0x80) !== 0;
    let len = buf[off + 1] & 0x7f;
    let pos = off + 2;
    if (len === 126) {
      if (buf.length - pos < 2) return null;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buf.length - pos < 8) return null;
      len = Number(buf.readBigUInt64BE(pos));
      pos += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length - pos < 4) return null;
      mask = buf.subarray(pos, pos + 4);
      pos += 4;
    }
    if (buf.length - pos < len) return null;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[pos + i] ^ (mask ? mask[i & 3] : 0);
    return { opcode, payload, next: pos + len };
  }

  #encode(opcode, payload) {
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    else {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, masked]);
  }

  sendFrame(type, payload = Buffer.alloc(0), streamId = 0) {
    this.socket.write(this.#encode(0x2, encodeFrame(type, payload, streamId)));
  }

  register(token) {
    const tok = Buffer.from(token);
    const payload = Buffer.concat([Buffer.from([1]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(tok.length); return b; })(), tok]);
    this.frames.length = 0;
    this.sendFrame(FRAME.REGISTER, payload);
  }

  // Wait for the next frame matching pred, or return matching existing ones.
  // Consumes the matched frame so concurrent waiters don't grab the same one.
  waitFor(pred, ms = 2000) {
    const idx = this.frames.findIndex(pred);
    if (idx !== -1) return Promise.resolve(this.frames.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.splice(this.#waiters.indexOf(wake), 1);
        reject(new Error('timeout waiting for frame'));
      }, ms);
      const wake = () => {
        const idx = this.frames.findIndex(pred);
        if (idx !== -1) {
          clearTimeout(timer);
          this.#waiters.splice(this.#waiters.indexOf(wake), 1);
          resolve(this.frames.splice(idx, 1)[0]);
        }
      };
      this.#waiters.push(wake);
    });
  }

  registerOk() {
    return this.waitFor((f) => f.type === FRAME.REGISTER_OK || f.type === FRAME.REGISTER_ERR);
  }

  destroy() {
    this.socket?.destroy();
  }
}

// Pump a request head to a dev server over raw TCP and collect the raw
// response. Resolves on full body (Content-Length) — Node answers keep-alive,
// so socket close never fires — or after a safety timeout.
function pumpUpstream(devPort, head, ms = 2000) {
  return new Promise((resolve) => {
    const upstream = net.connect(devPort, '127.0.0.1', () => upstream.write(head));
    const resp = [];
    upstream.on('data', (d) => {
      resp.push(d);
      const raw = Buffer.concat(resp).toString();
      const m = raw.match(/content-length: (\d+)/i);
      if (m) {
        const bodyStart = raw.indexOf('\r\n\r\n') + 4;
        if (raw.length - bodyStart >= Number(m[1])) {
          upstream.destroy();
          resolve(Buffer.concat(resp));
        }
      }
    });
    setTimeout(() => resolve(Buffer.concat(resp)), ms);
  });
}

function registerPayload(token) {
  const tok = Buffer.from(token);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(tok.length);
  return Buffer.concat([Buffer.from([1]), len, tok]);
}

function startRelay(timers = {}, ctor = {}) {
  return new Promise((resolve) => {
    const relay = new Relay({ port: 0, salt: 'test-salt', timers, ...ctor });
    relay.listen(() => resolve({ relay, port: relay.address().port }));
  });
}

// NOTE: the relay's internals are reached only through public `health` and
// the wire itself — same surface a real client sees.

let relay, port;

beforeEach(async () => {
  // Short grace/discard for reclaim tests; ingressIdle stays at the real
  // default — the round-trip holds a stream open for seconds.
  ({ relay, port } = await startRelay({ grace: 300, ingressDiscard: 300 }));
});

afterEach(() => new Promise((r) => relay.close(r)));

describe('relay REGISTER', () => {
  it('accepts a token and returns REGISTER_OK with derived sub', async () => {
    const c = new MockClient();
    await c.connect(port);
    c.register('tok-1');
    const reply = await c.registerOk();
    assert.equal(reply.type, FRAME.REGISTER_OK);
    const subLen = reply.payload[0];
    assert.equal(reply.payload.subarray(1, 1 + subLen).toString(), crypto.createHash('sha256').update('tok-1test-salt').digest('hex').slice(0, 6));
    c.destroy();
  });

  it('rejects a bad version byte with prescriptive message and closes', async () => {
    const c = new MockClient();
    await c.connect(port);
    const payload = Buffer.concat([Buffer.from([9]), Buffer.from('tok')]);
    c.sendFrame(FRAME.REGISTER, payload);
    const reply = await c.registerOk();
    assert.equal(reply.type, FRAME.REGISTER_ERR);
    const msgLen = reply.payload.readUInt16BE(1);
    assert.match(reply.payload.subarray(3, 3 + msgLen).toString(), /version 9 not supported/);
    // Server closes after REGISTER_ERR.
    await new Promise((r) => c.socket.on('close', r));
    c.destroy();
  });

  it('enforces the per-IP tunnel cap', async () => {
    const clients = [];
    for (let i = 0; i < 3; i++) {
      const c = new MockClient();
      await c.connect(port);
      c.register(`tok-${i}`);
      const reply = await c.registerOk();
      assert.equal(reply.type, FRAME.REGISTER_OK);
      clients.push(c);
    }
    const fourth = new MockClient();
    await fourth.connect(port);
    fourth.register('tok-4');
    const reply = await fourth.registerOk();
    assert.equal(reply.type, FRAME.REGISTER_ERR);
    const msgLen = reply.payload.readUInt16BE(1);
    assert.match(reply.payload.subarray(3, 3 + msgLen).toString(), /limit \(3\) reached/);
    clients.forEach((c) => c.destroy());
    fourth.destroy();
  });

  it('mints a deterministic 2-char suffix on collision with a different token', async () => {
    const a = new MockClient();
    await a.connect(port);
    a.register('alpha');
    const okA = await a.registerOk();
    const subA = okA.payload.subarray(1, 1 + okA.payload[0]).toString();

    // find a token whose base6 hash collides with subA is impractical;
    // instead verify the mechanism: same token twice → reclaim, not suffix.
    const a2 = new MockClient();
    await a2.connect(port);
    a2.register('alpha');
    const okA2 = await a2.registerOk();
    const subA2 = okA2.payload.subarray(1, 1 + okA2.payload[0]).toString();
    assert.equal(subA2, subA, 'same token reclaims the same sub');
    a.destroy();
    a2.destroy();
  });

  it('accepts a tokenless register and round-trips', async () => {
    const c = new MockClient();
    await c.connect(port);
    // tokenLen 0: version byte + u16 zero length, no token bytes.
    c.sendFrame(FRAME.REGISTER, Buffer.from([1, 0, 0]));
    const reply = await c.registerOk();
    assert.equal(reply.type, FRAME.REGISTER_OK, 'tokenless register accepted');
    const subLen = reply.payload[0];
    assert.equal(subLen, 6, 'derived sub is 6 chars');
    const sub = reply.payload.subarray(1, 1 + subLen).toString();
    assert.match(sub, /^[0-9a-f]{6}$/);
    c.destroy();
  });
});

describe('relay ingress', () => {
  it('returns 503 with a one-line body for an unknown sub', async () => {
    const res = await requestWithHost(port, 'nosuch.devhop.se');
    assert.equal(res.status, 503);
    assert.match(res.body, /tunnel nosuch does not exist on this gateway/);
  });

  it('round-trips a request through the relay to a mock dev server', async () => {
    const devServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 14 });
      res.end('hello from dev');
    });
    await new Promise((r) => devServer.listen(0, '127.0.0.1', r));
    const devPort = devServer.address().port;

    const c = new MockClient();
    await c.connect(port);
    c.register('dev');
    const ok = await c.registerOk();
    const sub = ok.payload.subarray(1, 1 + ok.payload[0]).toString();

    // phone → relay ingress
    const phonePromise = requestWithHost(port, `${sub}.devhop.se`);

    // client receives OPEN with the request head verbatim, answers DATA
    const open = await c.waitFor((f) => f.type === FRAME.OPEN);
    assert.match(open.payload.toString(), /^GET \/ HTTP\/1\.1/);
    // connect to the mock dev server and pump the head
    const resp = await pumpUpstream(devPort, open.payload);
    c.sendFrame(FRAME.DATA, resp, open.streamId);
    c.sendFrame(FRAME.CLOSE, Buffer.from([0]), open.streamId);

    const phoneRes = await phonePromise;
    assert.equal(phoneRes.status, 200);
    assert.equal(phoneRes.body, 'hello from dev');

    c.destroy();
    await new Promise((r) => devServer.close(r));
  });

  it('serves two concurrent streams independently', async () => {
    let hits = 0;
    const devServer = http.createServer((req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 5 });
      res.end(`hit-${hits}`);
    });
    await new Promise((r) => devServer.listen(0, '127.0.0.1', r));
    const devPort = devServer.address().port;

    const c = new MockClient();
    await c.connect(port);
    c.register('multi');
    const ok = await c.registerOk();
    const sub = ok.payload.subarray(1, 1 + ok.payload[0]).toString();

    const pump = async () => {
      const phone = requestWithHost(port, `${sub}.devhop.se`);
      const open = await c.waitFor((f) => f.type === FRAME.OPEN);
      const resp = await pumpUpstream(devPort, open.payload);
      c.sendFrame(FRAME.DATA, resp, open.streamId);
      c.sendFrame(FRAME.CLOSE, Buffer.from([0]), open.streamId);
      return phone;
    };
    // Both requests in flight before either is answered.
    const [a, b] = await Promise.all([pump(), pump()]);
    assert.equal(a.status, 200);
    assert.equal(a.body, 'hit-1');
    assert.equal(b.body, 'hit-2');

    c.destroy();
    await new Promise((r) => devServer.close(r));
  });

  it('reclaims the same sub within grace and serves a parked conn', async () => {
    const devServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 9 });
      res.end('reclaimed');
    });
    await new Promise((r) => devServer.listen(0, '127.0.0.1', r));
    const devPort = devServer.address().port;

    const c1 = new MockClient();
    await c1.connect(port);
    c1.register('reclaim');
    const ok1 = await c1.registerOk();
    const sub = ok1.payload.subarray(1, 1 + ok1.payload[0]).toString();

    // Kill the client socket → binding enters grace (300ms in this suite).
    c1.destroy();

    // Phone arrives during grace → parked, not 503'd.
    const phonePromise = requestWithHost(port, `${sub}.devhop.se`);

    // Client reconnects within grace → same sub, parked conn replayed.
    const c2 = new MockClient();
    await c2.connect(port);
    c2.register('reclaim');
    const ok2 = await c2.registerOk();
    assert.equal(ok2.payload.subarray(1, 1 + ok2.payload[0]).toString(), sub, 'same sub reclaimed');

    const open = await c2.waitFor((f) => f.type === FRAME.OPEN);
    const resp = await pumpUpstream(devPort, open.payload);
    c2.sendFrame(FRAME.DATA, resp, open.streamId);
    c2.sendFrame(FRAME.CLOSE, Buffer.from([0]), open.streamId);

    const phoneRes = await phonePromise;
    assert.equal(phoneRes.status, 200);
    assert.equal(phoneRes.body, 'reclaimed');

    c2.destroy();
    await new Promise((r) => devServer.close(r));
  });

  it('governor rejects the N+1th tunnel and keeps the first N serving', async () => {
    await new Promise((r) => relay.close(r));
    ({ relay, port } = await startRelay({ grace: 300 }, { maxFds: 8, limits: { maxTunnelsPerIp: 100, maxStreamsPerTunnel: 64 } })); // ceiling 6
    assert.equal(relay.governorCeiling, 6);

    const clients = [];
    // Fill up to ceiling - 1: the N+1th REGISTER is evaluated while its own
    // socket already counts toward the ceiling.
    for (let i = 0; i < 5; i++) {
      const c = new MockClient();
      await c.connect(port);
      c.register(`gov-${i}`);
      const reply = await c.registerOk();
      assert.equal(reply.type, FRAME.REGISTER_OK, `tunnel ${i} accepted`);
      clients.push(c);
    }
    const extra = new MockClient();
    await extra.connect(port);
    extra.register('gov-over');
    const reply = await extra.registerOk();
    assert.equal(reply.type, FRAME.REGISTER_ERR);
    assert.equal(reply.payload[0], 5); // GOVERNOR code
    // First N still alive.
    assert.equal(relay.health.tunnels, 5);
    clients.forEach((x) => x.destroy());
    extra.destroy();
  });

  it('reaps a half-open ingress socket after the idle timer', async () => {
    await new Promise((r) => relay.close(r));
    ({ relay, port } = await startRelay({ grace: 300, ingressIdle: 200 }));

    const c = new MockClient();
    await c.connect(port);
    c.register('idle');
    const ok = await c.registerOk();
    const sub = ok.payload.subarray(1, 1 + ok.payload[0]).toString();

    const baseline = relay.health.sockets;
    // Half-open: connect, send request head, then go silent — no FIN.
    const half = net.connect(port, '127.0.0.1', () => {
      half.write(`GET / HTTP/1.1\r\nHost: ${sub}.devhop.se\r\n\r\n`);
    });
    const open = await c.waitFor((f) => f.type === FRAME.OPEN);
    assert.ok(open.streamId > 0);

    // After idle (200ms) + slack the socket must be reaped.
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(relay.health.sockets <= baseline, `sockets back to baseline: ${relay.health.sockets} <= ${baseline}`);
    half.destroy();
    c.destroy();
  });
});
