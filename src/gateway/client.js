// Gateway client — GATEWAY_DESIGN.md §1/§4. Dial the relay at
// /_gateway/register, REGISTER, then pump streams: OPEN → net.connect to the
// local masquerade-proxy port, bytes both ways as DATA frames, half-close
// discipline on CLOSE. The WS layer is hand-rolled over http(s).request,
// mirroring relay.js's server side: client frames are MASKED (RFC 6455 §5.3),
// server frames must be unmasked. Zero deps.
//
// State machine (§4): CONNECTING → REGISTERING → ACTIVE; any socket death →
// reconnect with exponential backoff (base 500ms → cap 15s, ±50% full jitter,
// reset after >60s stable); DEAD only on 10 consecutive failed dials, a fatal
// REGISTER_ERR (bad token / version / banned), or manual close.

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { FRAME, PROTOCOL_VERSION, encodeFrame, FrameDecoder, GatewayProtocolError } from './frames.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// RFC 6455 opcodes
const WS_BINARY = 0x2;
const WS_CLOSE = 0x8;
const WS_PING = 0x9;
const WS_PONG = 0xa;

const BACKOFF_BASE = 500;
const BACKOFF_CAP = 15000;

// §4 backoff: exponential from base, capped, ±50% full jitter. Pure + exported
// so tests can assert the sequence directly.
export function backoffDelay(n, baseMs = BACKOFF_BASE, capMs = BACKOFF_CAP, rand = Math.random) {
  const exp = Math.min(capMs, baseMs * 2 ** (n - 1));
  return Math.round(exp * (0.5 + rand()));
}
const STABLE_RESET = 60_000; // >60s stable → backoff resets to base (§4)
const MAX_ATTEMPTS = 10; // consecutive failed dials → DEAD (§4)
const HIGH_WATER = 1024 * 1024; // R5 per-stream backpressure mark
const MAX_CHUNK = 256 * 1024; // §2 DATA frame cap

// Client→server WS message: always masked (RFC 6455 §5.3).
function wsEncodeMasked(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

// Parse one server WS message from buf at off. Server frames are unmasked;
// a masked server frame is a protocol error (mirror of relay.js's wsParse,
// which throws on unmasked client frames). Returns {opcode, payload, next}
// or null if incomplete.
function wsParseServerFrame(buf, off) {
  if (buf.length - off < 2) return null;
  const opcode = buf[off] & 0x0f;
  if ((buf[off + 1] & 0x80) !== 0) throw new GatewayProtocolError('server WS frame is masked');
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
  if (buf.length - pos < len) return null;
  const payload = Buffer.from(buf.subarray(pos, pos + len));
  return { opcode, payload, next: pos + len };
}

export function startGateway({
  localPort,
  gatewayUrl,
  token = '',
  urlTemplate = 'https://<sub>.devhop.se',
  backoffBaseMs = BACKOFF_BASE, // test hook; prod backoff is §4-fixed
  onUrl,
  onError,
  onClose,
  onRetry,
}) {
  const url = new URL(gatewayUrl);
  const tls = url.protocol === 'wss:';
  if (!tls && url.protocol !== 'ws:') {
    throw new Error(`unsupported gateway URL "${gatewayUrl}" — expected ws:// or wss://`);
  }

  // Tokenless tier (R10/R12): a per-process nonce stands in for the token,
  // so hash(token+salt) is stable across reconnects — §7 reclaim keeps the
  // same sub and the URL survives laptop sleep/wake without any user token.
  const sessionToken = token || crypto.randomBytes(16).toString('hex');

  let socket = null;
  let req = null;
  let carry = Buffer.alloc(0);
  let decoder = new FrameDecoder();
  let closed = false; // manual close: no reconnect, no callbacks
  let dead = false;
  let tearingDown = false; // guards fail() against close+error double-fire
  let attempt = 0; // consecutive failures since the last REGISTER_OK
  let activeSince = 0;
  let lastUrl = null;
  let retryTimer = null;
  const streams = new Map(); // streamId → { socket, pending, errored, closed }

  function backoffMs(n) {
    return backoffDelay(n, backoffBaseMs);
  }

  function sendWs(opcode, payload) {
    if (!socket || socket.destroyed) return;
    socket.write(wsEncodeMasked(opcode, payload));
  }

  function sendFrameWs(type, payload, streamId = 0) {
    sendWs(WS_BINARY, encodeFrame(type, payload, streamId));
  }

  function destroySocket() {
    if (req) {
      req.destroy();
      req = null;
    }
    if (socket) {
      socket.removeAllListeners();
      // relay.close() in tests destroys the socket after teardown removed our
      // listeners; add a no-op so the late ECONNRESET can't escape.
      socket.on('error', () => {});
      socket.destroy();
      socket = null;
    }
    clearTimeout(retryTimer);
    for (const st of streams.values()) st.socket.destroy();
    streams.clear();
    activeSince = 0;
  }

  // Any socket death / failed dial / transient REGISTER_ERR → reconnect (§4)
  // unless this was the MAX_ATTEMPTS-th consecutive failure.
  function fail(err) {
    if (closed || dead || tearingDown) return;
    tearingDown = true;
    destroySocket();
    tearingDown = false;
    if (activeSince && Date.now() - activeSince > STABLE_RESET) attempt = 0;
    attempt += 1;
    if (attempt >= MAX_ATTEMPTS) {
      die(new Error(`gateway unreachable after ${MAX_ATTEMPTS} consecutive attempts: ${err.message}`));
      return;
    }
    const delay = backoffMs(attempt);
    onRetry?.(attempt, delay);
    retryTimer = setTimeout(dial, delay);
    retryTimer.unref?.();
  }

  function die(err) {
    dead = true;
    destroySocket();
    onError?.(err);
    onClose?.();
  }

  function dial() {
    if (closed || dead) return;
    carry = Buffer.alloc(0);
    decoder = new FrameDecoder();
    const key = crypto.randomBytes(16).toString('base64');
    // R11: no tls options passed — Node's default certificate verification.
    const mod = tls ? https : http;
    req = mod.request({
      host: url.hostname,
      port: Number(url.port) || (tls ? 443 : 80),
      path: url.pathname === '/' ? '/_gateway/register' : url.pathname + url.search,
      headers: {
        Host: url.host,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, sock, head) => {
      req = null;
      const expect = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expect) {
        sock.destroy();
        fail(new Error('gateway handshake failed: bad Sec-WebSocket-Accept'));
        return;
      }
      socket = sock;
      sock.on('data', onWsData);
      sock.on('close', () => fail(new Error('gateway connection closed')));
      sock.on('error', (err) => fail(err));
      sock.on('drain', () => {
        for (const st of streams.values()) st.socket.resume();
      });
      if (head.length) onWsData(head);
      // R6: REGISTER before anything else — first message on every connect.
      sendFrameWs(FRAME.REGISTER, registerPayload());
    });
    req.on('response', (res) => fail(new Error(`gateway handshake failed: HTTP ${res.statusCode}`)));
    req.on('error', (err) => fail(err));
    req.end();
  }

  // §2 REGISTER payload as THIS relay parses it: version:u8, tokenLen:u16,
  // token. ponytail: the §2 table's trailing subLen:u8 is NOT sent — the
  // relay reads token at offset 3 and would swallow the 0x00 as the first
  // token byte, corrupting every non-empty registration. Re-add subLen in
  // the same commit that teaches the relay to parse it (R8 version bump).
  // Tokenless mode: token is a per-process nonce, so hash(token+salt) is
  // stable across reconnects — §7 reclaim and R10's URL-stability promise
  // hold for the default zero-config mode.
  function registerPayload() {
    const tok = Buffer.from(sessionToken, 'utf8');
    const p = Buffer.alloc(3);
    p[0] = PROTOCOL_VERSION;
    p.writeUInt16BE(tok.length, 1);
    return Buffer.concat([p, tok]);
  }

  function onWsData(chunk) {
    carry = Buffer.concat([carry, chunk]);
    try {
      for (;;) {
        const msg = wsParseServerFrame(carry, 0);
        if (!msg) break;
        carry = Buffer.from(carry.subarray(msg.next));
        if (msg.opcode === WS_PING) {
          sendWs(WS_PONG, msg.payload); // R2: answer the relay's WS-level ping
        } else if (msg.opcode === WS_PONG) {
          // liveness only; the only heartbeat is the server's (R2)
        } else if (msg.opcode === WS_CLOSE) {
          fail(new Error('gateway closed the connection'));
        } else if (msg.opcode === WS_BINARY) {
          decoder.feed(msg.payload).forEach(onFrame);
        } else {
          throw new GatewayProtocolError(`unexpected WS opcode 0x${msg.opcode.toString(16)}`);
        }
      }
    } catch (err) {
      // Codec/WS protocol error → tear down (§2 fail-fast).
      fail(err);
    }
  }

  function onFrame(frame) {
    const { type, payload, streamId } = frame;
    if (type === FRAME.REGISTER_OK) {
      const sub = payload.subarray(1, 1 + payload[0]).toString();
      const url2 = urlTemplate.replace('<sub>', sub);
      attempt = 0;
      activeSince = Date.now();
      // §4: re-fire only when the URL changed (R10 reclaim keeps it stable).
      if (url2 !== lastUrl) {
        lastUrl = url2;
        onUrl?.(url2);
      }
    } else if (type === FRAME.REGISTER_ERR) {
      const msgLen = payload.readUInt16BE(1);
      const msg = payload.subarray(3, 3 + msgLen).toString();
      console.error(`devhop gateway: ${msg}`);
      // Transient codes (limit 3, governor 5) stay in the reconnect loop;
      // everything else (bad token 1, banned 4, unknown version) is fatal (§4).
      const err = new Error(`gateway refused registration: ${msg}`);
      if (payload[0] === 3 || payload[0] === 5) fail(err);
      else die(err);
    } else if (type === FRAME.OPEN) {
      openStream(streamId, payload);
    } else if (type === FRAME.DATA) {
      const st = streams.get(streamId);
      // Unknown streamId → ignore (R4 teardown race).
      if (st) feedUpstream(st, payload);
    } else if (type === FRAME.CLOSE) {
      const st = streams.get(streamId);
      // Relay's direction is done; ours drains naturally (half-close).
      if (st && !st.socket.destroyed) st.socket.end();
    } else if (type === FRAME.PING) {
      sendFrameWs(FRAME.PONG, payload); // §2: echo the timestamp back
    }
  }

  function openStream(streamId, head) {
    const st = { socket: null, pending: [], errored: false, closed: false };
    streams.set(streamId, st);
    const upstream = net.connect(localPort, '127.0.0.1', () => {
      // §2 option (a): the OPEN payload (request head) goes upstream verbatim.
      if (head.length) upstream.write(head);
    });
    st.socket = upstream;
    upstream.on('data', (chunk) => {
      for (let off = 0; off < chunk.length; off += MAX_CHUNK) {
        sendFrameWs(FRAME.DATA, chunk.subarray(off, off + MAX_CHUNK), streamId);
      }
      // R5 (client→relay side): the WSS send buffer is one per client (R1),
      // so when it is over the mark, pause every stream's local socket read —
      // TCP backpressure then propagates to each dev-server socket.
      if (socket && socket.writableLength > HIGH_WATER) {
        for (const s of streams.values()) s.socket.pause();
      }
    });
    upstream.on('drain', () => {
      // Flush request bytes queued while this stream was over the mark.
      while (st.pending.length && upstream.writableLength <= HIGH_WATER) {
        upstream.write(st.pending.shift());
      }
    });
    upstream.on('error', () => {
      st.errored = true;
      upstream.destroy();
    });
    upstream.on('close', () => {
      if (st.closed) return;
      st.closed = true;
      streams.delete(streamId);
      sendFrameWs(FRAME.CLOSE, Buffer.from([st.errored ? 1 : 0]), streamId);
    });
  }

  // R5 (relay→local): over the mark → queue instead of ballooning the socket
  // buffer; the 'drain' handler flushes.
  // ponytail: queue-and-drain, not a credit/ACK scheme — swap when the relay
  // grows credit-ACK flow control (§6b note).
  function feedUpstream(st, payload) {
    if (st.socket.writableLength > HIGH_WATER) {
      st.pending.push(payload);
      return;
    }
    st.socket.write(payload);
  }

  dial();

  return {
    close: () => {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      for (const st of streams.values()) st.socket.destroy();
      streams.clear();
      if (req) {
        req.destroy();
        req = null;
      }
      if (socket && !socket.destroyed) {
        const s = socket;
        // Drop reconnect callbacks but keep the socket's own error handler —
        // a late RST (e.g. relay teardown after the test ended) must never
        // surface as an uncaught exception.
        s.removeAllListeners();
        s.on('error', () => {});
        try {
          s.end(wsEncodeMasked(WS_CLOSE, Buffer.alloc(0)));
        } catch (_) {}
        setTimeout(() => {
          if (!s.destroyed) s.destroy();
        }, 250).unref?.();
      }
      socket = null;
    },
    // TEST-ONLY (§9 test 3 cable-pull): destroy the WSS socket the way a
    // SIGKILL'd process would — abrupt RST, no WS CLOSE, no graceful end.
    // Not part of the public contract; do not use outside tests.
    destroyForTest: () => {
      if (socket && !socket.destroyed) {
        const s = socket;
        s.removeAllListeners();
        s.on('error', () => {});
        s.destroy();
      }
    },
  };
}
