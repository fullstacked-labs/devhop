// Gateway frame codec. Pure module: no I/O, no deps.
//
// Wire layout per frame (9-byte header + payload):
//   [type: u8][len: u32 BE][streamId: u32 BE][payload: len bytes]
// Each WS message carries one frame, but a decoder must also reassemble frames
// split across byte-stream chunks, which needs an explicit length.
//
// Max payload is 256 KiB, enforced on every frame type so a hostile peer can't
// hand us an unbounded PING either.
//
// The protocol version byte is the first byte of the REGISTER payload, not a
// per-frame field. Decoder rejects a REGISTER whose version ≠ 1.

export const PROTOCOL_VERSION = 1;

export const FRAME = {
  REGISTER: 0x01,
  REGISTER_OK: 0x02,
  REGISTER_ERR: 0x03,
  OPEN: 0x10,
  DATA: 0x11,
  CLOSE: 0x12,
  PING: 0x20,
  PONG: 0x21,
};

const TYPE_NAMES = Object.fromEntries(Object.entries(FRAME).map(([name, value]) => [value, name]));

export const MAX_PAYLOAD = 256 * 1024;

const HEADER = 9; // type (1) + len (4) + streamId (4)

export class GatewayProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayProtocolError';
  }
}

export function encodeFrame(type, payload = Buffer.alloc(0), streamId = 0) {
  if (!TYPE_NAMES[type]) {
    throw new GatewayProtocolError(`cannot encode unknown frame type 0x${(type ?? 0).toString(16)}`);
  }
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new GatewayProtocolError(`streamId out of u32 range: ${streamId}`);
  }
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? []);
  if (body.length > MAX_PAYLOAD) {
    throw new GatewayProtocolError(`payload ${body.length} bytes exceeds ${MAX_PAYLOAD}-byte limit`);
  }
  const frame = Buffer.alloc(HEADER + body.length);
  frame[0] = type;
  frame.writeUInt32BE(body.length, 1);
  frame.writeUInt32BE(streamId, 5);
  body.copy(frame, HEADER);
  return frame;
}

// Parse one header+payload out of `buf` at `off`. Returns the frame and the
// next offset, or null if the buffer doesn't hold the whole frame yet.
// Throws (fail fast: an unknown type means the peer is desynced) on unknown
// types and oversized lengths even before the full payload has arrived.
function parseFrame(buf, off, validateVersion = true) {
  // Validate incrementally: type as soon as byte 0 is here, length as soon as
  // byte 5 are — fail fast on garbage even when the frame itself is incomplete.
  if (buf.length - off < 1) return null;
  const type = buf[off];
  if (!TYPE_NAMES[type]) {
    throw new GatewayProtocolError(`unknown frame type 0x${type.toString(16)}`);
  }
  if (buf.length - off < 5) return null;
  const len = buf.readUInt32BE(off + 1);
  if (len > MAX_PAYLOAD) {
    throw new GatewayProtocolError(`frame payload ${len} bytes exceeds ${MAX_PAYLOAD}-byte limit`);
  }
  if (buf.length - off < HEADER + len) return null;
  const streamId = buf.readUInt32BE(off + 5);
  const payload = Buffer.from(buf.subarray(off + HEADER, off + HEADER + len));
  if (validateVersion && type === FRAME.REGISTER && len > 0 && payload[0] !== PROTOCOL_VERSION) {
    throw new GatewayProtocolError(
      `gateway protocol version ${payload[0]} not supported (supports ${PROTOCOL_VERSION})`
    );
  }
  return { frame: { type, streamId, payload }, next: off + HEADER + len };
}

export function decodeFrames(buffer) {
  const frames = [];
  let off = 0;
  for (;;) {
    const parsed = parseFrame(buffer, off);
    if (!parsed) {
      if (off < buffer.length) {
        const kind = buffer.length - off < HEADER ? 'header' : 'payload';
        throw new GatewayProtocolError(`truncated frame ${kind}: ${buffer.length - off} trailing byte(s)`);
      }
      return frames;
    }
    frames.push(parsed.frame);
    off = parsed.next;
  }
}

// Incremental decoder: feed() takes arbitrary chunk boundaries and returns
// every frame that has become complete. end() rejects a stream that stops
// mid-frame. After any throw the decoder is unusable — the peer is desynced
// and the connection must be torn down, never resynchronized.
export class FrameDecoder {
  #carry = Buffer.alloc(0);
  #dead = false;
  #validateVersion = true;

  // validateVersion: false lets the relay own the REGISTER_ERR reply for bad
  // versions with a message that says how to upgrade; the default keeps the codec strict
  // for any consumer that just wants fail-fast parsing.
  constructor({ validateVersion = true } = {}) {
    this.#validateVersion = validateVersion;
  }

  feed(chunk) {
    if (this.#dead) {
      throw new GatewayProtocolError('decoder unusable after protocol error; tear down the connection');
    }
    this.#carry = Buffer.concat([this.#carry, chunk]);
    const frames = [];
    let off = 0;
    try {
      for (;;) {
        const parsed = parseFrame(this.#carry, off, this.#validateVersion);
        if (!parsed) break;
        frames.push(parsed.frame);
        off = parsed.next;
      }
    } catch (err) {
      this.#dead = true;
      throw err;
    }
    this.#carry = Buffer.from(this.#carry.subarray(off));
    return frames;
  }

  end() {
    if (this.#dead) {
      throw new GatewayProtocolError('decoder unusable after protocol error; tear down the connection');
    }
    if (this.#carry.length > 0) {
      const kind = this.#carry.length < HEADER ? 'header' : 'payload';
      throw new GatewayProtocolError(`truncated frame ${kind}: ${this.#carry.length} trailing byte(s)`);
    }
  }
}
