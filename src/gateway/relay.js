// Gateway relay — GATEWAY_DESIGN.md §1-§8. Loopback HTTP server that accepts
// client WSS upgrades (RFC 6455 server handshake hand-rolled, zero deps) and
// ingress HTTP connections routed by Host (R7), then pumps bytes both ways
// (L4, no parsing). Each WS binary message = exactly one codec frame
// (src/gateway/frames.js); the length prefix inside the frame lets the
// decoder reassemble across TCP chunk boundaries — see slice-1 note.
//
// Deviations kept visible (AMBIGUITY list in the slice-2 report):
// - PING/backoff/idle timers are constructor options so tests run fast.
// - R5 backpressure (per-stream pause at 1 MiB) is NOT implemented here —
//   the pump uses socket pause/resume on one aggregate highWaterMark instead;
//   per-stream accounting lands with the client slice when stream objects
//   gain their real shape.
// - Parking (§7) holds the ingress socket open during the 30 s grace window;
//   the 10 s discard applies only to conns that arrive with no binding or a
//   fully expired one.

import { createHash } from 'node:crypto';
import crypto from 'node:crypto';
import http from 'node:http';
import { FRAME, PROTOCOL_VERSION, encodeFrame, FrameDecoder, GatewayProtocolError } from './frames.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// RFC 6455 opcodes
const WS_BINARY = 0x2;
const WS_CLOSE = 0x8;
const WS_PING = 0x9;
const WS_PONG = 0xa;

const REGISTER_ERR_CODES = {
  BAD_TOKEN: 1,
  LIMIT: 3,
  BANNED: 4,
  GOVERNOR: 5,
};

// Encode a server→client WS message: no mask (server frames are unmasked),
// length per RFC 6455 §5.2.
function wsEncode(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN set: one message, no continuation
  return Buffer.concat([header, payload]);
}

// Parse one client WS message from buf at off. Client frames are masked
// (RFC 6455 §5.3). Returns {opcode, payload, next} or null if incomplete;
// throws on a masked-less client frame (protocol error).
function wsParse(buf, off) {
  if (buf.length - off < 2) return null;
  const opcode = buf[off] & 0x0f;
  const masked = (buf[off + 1] & 0x80) !== 0;
  if (!masked) throw new GatewayProtocolError('client WS frame not masked');
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
  if (buf.length - pos < 4) return null;
  const mask = buf.subarray(pos, pos + 4);
  pos += 4;
  if (buf.length - pos < len) return null;
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = buf[pos + i] ^ mask[i & 3];
  return { opcode, payload, next: pos + len };
}

function subFromToken(token, salt) {
  return createHash('sha256').update(`${token}${salt}`).digest('hex').slice(0, 6);
}

export class Relay {
  #limits;
  #timers;
  #opts;
  // sub -> { socket, dec, send(), streams: Map<id, ServerResponse>, parked: [] , graceUntil: null }
  #bindings = new Map();
  #sockets = 0; // live client WS + ingress sockets (governor counter)
  #startedAt = Date.now();
  #httpServer;
  #pingTimer;

  constructor({ port, salt, limits = {}, timers = {}, maxFds = 1024 } = {}) {
    this.port = port;
    this.salt = salt ?? 'devhop-gateway-salt';
    this.#limits = { maxTunnelsPerIp: 3, maxStreamsPerTunnel: 64, ...limits };
    // All durations in ms, overridable so tests don't wait real seconds.
    this.#timers = {
      pingInterval: 20_000,
      pingTimeout: 40_000, // 2 missed pings → teardown (R2)
      grace: 30_000,
      ingressDiscard: 10_000,
      ingressIdle: 60_000,
      ...timers,
    };
    // Governor ceiling = 80% of the fd budget (§6b).
    this.governorCeiling = Math.floor(maxFds * 0.8);
    this.#opts = { maxFds };
    this.#httpServer = http.createServer((req, res) => this.#handleHttp(req, res));
    // Governor counter (§6b): every live TCP conn counts — client WS upgrades
    // and ingress HTTP alike — so the ceiling is a real fd/socket budget.
    this.#httpServer.on('connection', (sock) => {
      this.#sockets++;
      sock.on('close', () => this.#sockets--);
    });
    this.#httpServer.on('upgrade', (req, socket, head) => this.#handleUpgrade(req, socket, head));
  }

  listen(cb) {
    this.#httpServer.listen(this.port, '127.0.0.1', cb);
    this.#pingTimer = setInterval(() => this.#pingClients(), this.#timers.pingInterval);
    this.#pingTimer.unref?.();
    return this.#httpServer;
  }

  // Bound address once listen() has fired its callback.
  address() {
    return this.#httpServer.address();
  }

  close(cb) {
    clearInterval(this.#pingTimer);
    // Ingress/keep-alive sockets would hold server.close()'s callback open
    // forever; teardown means teardown.
    this.#httpServer.closeAllConnections();
    for (const b of this.#bindings.values()) b.socket?.destroy();
    this.#bindings.clear();
    this.#httpServer.close(cb);
  }

  get health() {
    let streams = 0;
    for (const b of this.#bindings.values()) streams += b.streams.size;
    return {
      ok: true,
      uptime_s: Math.floor((Date.now() - this.#startedAt) / 1000),
      tunnels: [...this.#bindings.values()].filter((b) => b.graceUntil === null).length,
      streams,
      sockets: this.#sockets,
    };
  }

  // Plain-HTTP side: /health (R9). Ingress is ALSO served here but as a raw
  // byte pipe: once Host routing picks a binding (R7, one header read), the
  // socket is detached from Node's HTTP parser and pumped verbatim — L4, no
  // request/response semantics anywhere (§2 option (a)).
  #handleHttp(req, res) {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.health));
      return;
    }
    const host = (req.headers.host ?? '').split(':')[0];
    const sub = host.split('.')[0];
    if (sub) {
      this.#serveIngress(req, res, sub);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  #handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (req.url.startsWith('/_gateway/register') && key) {
      // RFC 6455 §4.2.2 accept: SHA-1(key + GUID), base64.
      const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      this.#serveClient(socket, req.socket.remoteAddress, head);
      return;
    }
    // Plain HTTP handles ingress; anything else upgrading is refused.
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.end();
  }

  // --- client (tunnel) side ---

  #serveClient(socket, remoteIp, head = Buffer.alloc(0)) {
    // Version enforcement is the relay's job (prescriptive REGISTER_ERR per
    // R8), so the decoder's own check is off here.
    const dec = new FrameDecoder({ validateVersion: false });
    let lastPong = Date.now();

    const binding = { socket, streams: new Map(), parked: [], graceUntil: null, registered: false, send: null };
    binding.send = (frame) => {
      if (!socket.destroyed) socket.write(wsEncode(WS_BINARY, frame));
    };
    socket.binding = binding; // reachable from ingress teardown paths

    const cleanup = () => {
      if (binding.cleaned) return;
      binding.cleaned = true;
      // R3: binding enters grace; parked/discarded per §7. Streams die now.
      if (binding.registered && binding.sub) {
        binding.graceUntil = Date.now() + this.#timers.grace;
        for (const sock of binding.streams.values()) {
          const msg = 'devhop gateway: tunnel owner disconnected mid-request';
          if (!sock.destroyed) {
            sock.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
            sock.end();
          }
        }
        binding.streams.clear();
      }
    };
    // Client teardown surfaces as 'close' (destroy/RST) or 'end' (FIN) on an
    // upgraded socket — both mean the same thing for the binding (R3).
    socket.on('close', cleanup);
    socket.on('end', cleanup);
    socket.on('error', cleanup);

    // Watchdog: 2 consecutive missed PINGs → hard teardown (R2).
    const watchdog = setInterval(() => {
      if (Date.now() - lastPong > this.#timers.pingTimeout) socket.destroy();
    }, this.#timers.pingTimeout);
    watchdog.unref?.();
    socket.on('close', () => clearInterval(watchdog));

    // Bytes that arrived with the upgrade request itself (a client may send
    // its first WS frame before the 101 is even out) must not be dropped.
    let carry = head;
    socket.on('data', (chunk) => {
      carry = Buffer.concat([carry, chunk]);
      try {
        for (;;) {
          const msg = wsParse(carry, 0);
          if (!msg) break;
          carry = Buffer.from(carry.subarray(msg.next));
          if (msg.opcode === WS_PING) {
            socket.write(wsEncode(WS_PONG, msg.payload)); // RFC: answer pings
          } else if (msg.opcode === WS_PONG) {
            lastPong = Date.now();
          } else if (msg.opcode === WS_CLOSE) {
            socket.end();
          } else if (msg.opcode === WS_BINARY) {
            dec.feed(msg.payload).forEach((frame) => this.#onClientFrame(binding, frame, remoteIp));
          }
        }
      } catch (err) {
        // Codec/WS protocol error → tear down (§2 fail-fast).
        socket.destroy();
      }
    });
  }

  #onClientFrame(binding, frame, remoteIp) {
    const { type, payload, streamId } = frame;
    if (type === FRAME.REGISTER) {
      this.#handleRegister(binding, payload, remoteIp);
      return;
    }
    if (!binding.registered) {
      binding.socket.destroy(); // no REGISTER → no session (R6)
      return;
    }
    if (type === FRAME.DATA) {
      const sock = binding.streams.get(streamId);
      if (sock && !sock.destroyed) {
        sock.write(payload); // L4: verbatim bytes back to the phone
      }
    } else if (type === FRAME.CLOSE) {
      const sock = binding.streams.get(streamId);
      if (sock) {
        binding.streams.delete(streamId);
        sock.end();
      }
    }
    // PONG handled at WS layer; unknown-but-valid codec types can't occur.
  }

  #handleRegister(binding, payload, remoteIp) {
    const respondErr = (code, msg) => {
      const body = Buffer.alloc(3 + Buffer.byteLength(msg));
      body[0] = code;
      body.writeUInt16BE(Buffer.byteLength(msg), 1);
      body.write(msg, 3);
      binding.send(encodeFrame(FRAME.REGISTER_ERR, body));
      binding.socket.end(); // server closes after REGISTER_ERR (§6)
    };

    // Governor (§6b): ceiling is a socket budget — reject NEW tunnels while
    // live sockets are at/over the ceiling, never kill existing.
    if (this.#sockets >= this.governorCeiling && !binding.graceUntil) {
      respondErr(REGISTER_ERR_CODES.GOVERNOR, 'gateway at connection limit; try again shortly');
      return;
    }

    // payload: version:u8, tokenLen:u16, token, subLen:u8, sub* (§2)
    if (payload.length < 1 || payload[0] !== PROTOCOL_VERSION) {
      const v = payload[0] ?? '?';
      respondErr(
        REGISTER_ERR_CODES.BAD_TOKEN,
        `gateway protocol version ${v} not supported by server (supports ${PROTOCOL_VERSION}); upgrade devhop: npm i -g devhop@latest`
      );
      return;
    }
    if (payload.length < 3) {
      respondErr(REGISTER_ERR_CODES.BAD_TOKEN, 'malformed REGISTER');
      return;
    }
    const tokenLen = payload.readUInt16BE(1);
    let token = payload.subarray(3, 3 + tokenLen).toString('utf8');
    // R6/R12 tokenless tier: the client mints a per-process nonce
    // (client.js), so hash(token+salt) is stable across reconnects — §7
    // reclaim and R10 hold for the default zero-config mode. This fallback
    // branch only catches bare/old clients sending a genuinely empty token;
    // each such connect mints a fresh sub.
    if (!token) token = crypto.randomBytes(16).toString('hex');
    // R4: a new REGISTER from the same token force-closes the old socket.
    // §7: parked ingress conns must survive the reclaim — hand them over.
    let parkedConns = [];
    for (const [sub, other] of this.#bindings) {
      if (other.token === token && other !== binding) {
        other.socket.destroy();
        parkedConns = other.parked;
        this.#bindings.delete(sub);
      }
    }

    // Per-IP tunnel cap (§6): count live (non-grace) bindings for this IP.
    const ipCount = [...this.#bindings.values()].filter((b) => b.ip === remoteIp && b.graceUntil === null).length;
    if (ipCount >= this.#limits.maxTunnelsPerIp && !binding.graceUntil) {
      respondErr(
        REGISTER_ERR_CODES.LIMIT,
        `connection limit (${this.#limits.maxTunnelsPerIp}) reached for your IP; close another devhop session or use a token`
      );
      return;
    }

    // Subdomain derivation (R10): hash → 6 hex chars; collision with a
    // DIFFERENT token → deterministic 2-char suffix from R7's [a-z0-9]
    // charset (base-36 over the attempt number).
    let sub = subFromToken(token, this.salt);
    if (this.#bindings.has(sub) && this.#bindings.get(sub).token !== token) {
      let suffix = 0;
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      while (this.#bindings.has(sub)) {
        sub =
          subFromToken(token, this.salt) +
          chars[suffix % 36] +
          chars[Math.floor(suffix / 36) % 36];
        suffix++;
        if (suffix > 36 * 36) {
          respondErr(REGISTER_ERR_CODES.LIMIT, 'subdomain space exhausted; try again later');
          return;
        }
      }
    }

    // Reclaim within grace (§7): any prior binding under this sub was either
    // force-closed in the R4 loop above (parked conns handed over) or never
    // existed — the table now only holds bindings for other tokens.
    const okBody = Buffer.alloc(1 + sub.length);
    okBody[0] = sub.length;
    okBody.write(sub, 1);
    binding.registered = true;
    binding.sub = sub;
    binding.token = token;
    binding.ip = remoteIp;
    binding.graceUntil = null;
    this.#bindings.set(sub, binding);
    binding.send(encodeFrame(FRAME.REGISTER_OK, okBody));

    // Replay parked ingress conns (each still inside its 10 s discard).
    for (const parked of parkedConns.splice(0)) {
      if (parked.discarded) continue;
      this.#admitIngress(binding, parked.socket, parked.head, binding.sub);
    }
  }

  // --- ingress (phone) side ---

  #serveIngress(req, res, sub) {
    const binding = this.#bindings.get(sub);
    // Detach the socket from Node's HTTP machinery: everything from here on
    // is raw bytes (L4). The head is rebuilt verbatim for OPEN.
    const socket = res.socket;
    // Strip Node's HTTP listeners but keep the governor's connection-level
    // 'close' hook (installed on 'connection') so the count still drops.
    const listeners = socket.eventNames()
      .filter((n) => n !== 'close')
      .flatMap((n) => socket.listeners(n).map((fn) => [n, fn]));
    for (const [n, fn] of listeners) socket.removeListener(n, fn);
    req.removeAllListeners('data');
    req.removeAllListeners('end');
    req.removeAllListeners('error');
    socket.on('close', () => this.#sockets--);
    const head = this.#rawHead(req);

    if (!binding || binding.graceUntil !== null) {
      // §5: relay answers, never Caddy. Park if within grace, else 503 now.
      if (binding && Date.now() < binding.graceUntil) {
        const parked = { socket, head, discarded: false };
        binding.parked.push(parked);
        const t = setTimeout(() => {
          parked.discarded = true;
          this.#raw503(socket, sub, 'offline');
        }, this.#timers.ingressDiscard);
        t.unref?.();
        socket.on('close', () => clearTimeout(t));
        return;
      }
      this.#raw503(socket, sub, binding ? 'offline' : 'missing');
      return;
    }
    this.#admitIngress(binding, socket, head, sub);
  }

  #raw503(socket, sub, kind) {
    const msg = kind === 'offline'
      ? `devhop gateway: tunnel ${sub} is offline (owner disconnected)`
      : `devhop gateway: tunnel ${sub} does not exist on this gateway`;
    if (!socket.destroyed) {
      socket.write(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(msg)}\r\nConnection: close\r\n\r\n${msg}`);
      socket.end();
    }
  }

  // Reconstruct the request head verbatim (§2 option (a): OPEN carries the
  // head; no parsing beyond what Node already did for routing).
  #rawHead(req) {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    return Buffer.from(lines.join('\r\n') + '\r\n\r\n');
  }

  #admitIngress(binding, socket, head, sub) {
    // Stream cap (§6): refused streams get a clean 503.
    if (binding.streams.size >= this.#limits.maxStreamsPerTunnel) {
      const msg = `devhop gateway: tunnel ${sub} has too many concurrent streams`;
      socket.write(`HTTP/1.1 503 Service Unavailable\r\nContent-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
      socket.end();
      return;
    }
    const streamId = binding.nextStreamId ?? 1;
    binding.nextStreamId = streamId + 1;
    binding.streams.set(streamId, socket);

    const finish = () => {
      clearTimeout(idleTimer);
      if (binding.streams.get(streamId) === socket) binding.streams.delete(streamId);
    };

    // §6b ingress read-idle timer: silence for ingressIdle ms → reap. The
    // phone sees a normal close; no FD leak. destroy() fires the connection
    // 'close' hook, dropping the governor count.
    const idleTimer = setTimeout(() => {
      socket.destroy();
      finish();
    }, this.#timers.ingressIdle);
    idleTimer.unref?.();

    // Pure L4: every byte from the phone becomes a DATA frame, verbatim; the
    // head already rode inside OPEN. No request/response parsing anywhere.
    socket.on('data', (chunk) => {
      idleTimer.refresh();
      binding.send(encodeFrame(FRAME.DATA, chunk, streamId));
    });
    socket.on('error', finish);
    socket.on('close', finish);

    // OPEN carries the request head verbatim (§2, decision 1).
    binding.send(encodeFrame(FRAME.OPEN, head, streamId));
  }

  #pingClients() {
    for (const b of this.#bindings.values()) {
      if (b.graceUntil === null && b.socket && !b.socket.destroyed) {
        b.send(wsEncode(WS_PING, Buffer.alloc(8)));
      }
    }
  }
}
