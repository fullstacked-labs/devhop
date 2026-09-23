import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME,
  PROTOCOL_VERSION,
  MAX_PAYLOAD,
  GatewayProtocolError,
  encodeFrame,
  decodeFrames,
  FrameDecoder,
} from '../../src/gateway/frames.js';

const ALL_TYPES = Object.values(FRAME);

describe('gateway frame codec', () => {
  describe('round-trip every type', () => {
    const sizes = [
      ['empty payload', () => Buffer.alloc(0)],
      ['small payload', () => Buffer.from('hello world')],
      ['exactly 256 KiB', () => Buffer.alloc(MAX_PAYLOAD, 0xab)],
    ];

    for (const type of ALL_TYPES) {
      for (const [label, make] of sizes) {
        it(`${label} of 0x${type.toString(16)}`, () => {
          let payload = make();
          // REGISTER's payload always starts with the version byte (R8).
          if (type === FRAME.REGISTER) {
            payload = Buffer.concat([Buffer.from([PROTOCOL_VERSION]), payload.subarray(0, MAX_PAYLOAD - 1)]);
          }
          // PING/PONG/REGISTER-family use streamId 0 (§2); others carry an id.
          const streamId = type === FRAME.OPEN || type === FRAME.DATA || type === FRAME.CLOSE ? 7 : 0;
          const frames = decodeFrames(encodeFrame(type, payload, streamId));
          assert.equal(frames.length, 1);
          assert.equal(frames[0].type, type);
          assert.equal(frames[0].streamId, streamId);
          assert.ok(frames[0].payload.equals(payload));
        });
      }
    }
  });

  it('PING and PONG carry streamId 0 by default', () => {
    for (const type of [FRAME.PING, FRAME.PONG]) {
      const [frame] = decodeFrames(encodeFrame(type, Buffer.alloc(8)));
      assert.equal(frame.streamId, 0);
    }
  });

  it('REGISTER round-trips its version byte', () => {
    const payload = Buffer.concat([Buffer.from([PROTOCOL_VERSION]), Buffer.from('tok'), Buffer.from([3]), Buffer.from('sub')]);
    const [frame] = decodeFrames(encodeFrame(FRAME.REGISTER, payload));
    assert.equal(frame.payload[0], PROTOCOL_VERSION);
  });

  it('streamId survives u32 extremes', () => {
    for (const streamId of [1, 0xffffffff]) {
      const [frame] = decodeFrames(encodeFrame(FRAME.DATA, Buffer.from('x'), streamId));
      assert.equal(frame.streamId, streamId);
    }
  });

  it('three frames in one chunk decode in order', () => {
    const buf = Buffer.concat([
      encodeFrame(FRAME.OPEN, Buffer.alloc(0), 1),
      encodeFrame(FRAME.DATA, Buffer.from('abc'), 1),
      encodeFrame(FRAME.CLOSE, Buffer.from([0]), 1),
    ]);
    const frames = decodeFrames(buf);
    assert.deepEqual(frames.map((f) => f.type), [FRAME.OPEN, FRAME.DATA, FRAME.CLOSE]);
    assert.ok(frames[1].payload.equals(Buffer.from('abc')));
  });

  it('frame split across two feeds', () => {
    const buf = encodeFrame(FRAME.DATA, Buffer.from('0123456789'), 42);
    const dec = new FrameDecoder();
    assert.deepEqual(dec.feed(buf.subarray(0, 4)), []);
    const frames = dec.feed(buf.subarray(4));
    dec.end();
    assert.equal(frames.length, 1);
    assert.equal(frames[0].streamId, 42);
    assert.ok(frames[0].payload.equals(Buffer.from('0123456789')));
  });

  it('interleaved partial + full frames across feeds', () => {
    const a = encodeFrame(FRAME.DATA, Buffer.from('AAAA'), 1);
    const b = encodeFrame(FRAME.PING, Buffer.alloc(8));
    const c = encodeFrame(FRAME.OPEN, Buffer.alloc(0), 2);
    const dec = new FrameDecoder();
    // a arrives split; b and c ride along complete on later chunks
    assert.deepEqual(dec.feed(a.subarray(0, 5)), []);
    assert.deepEqual(dec.feed(a.subarray(5)).map((f) => f.type), [FRAME.DATA]);
    assert.deepEqual(dec.feed(Buffer.concat([b, c.subarray(0, 3)])).map((f) => f.type), [FRAME.PING]);
    const rest = dec.feed(c.subarray(3));
    dec.end();
    assert.deepEqual(rest.map((f) => f.type), [FRAME.OPEN]);
    assert.equal(rest[0].streamId, 2);
    assert.ok(dec.feed(Buffer.alloc(0)).length === 0);
  });

  it('one byte at a time still decodes', () => {
    const buf = encodeFrame(FRAME.REGISTER_OK, Buffer.from([3, ...Buffer.from('abc123')]));
    const dec = new FrameDecoder();
    let frames = [];
    for (const byte of buf) frames.push(...dec.feed(Buffer.from([byte])));
    dec.end();
    assert.equal(frames.length, 1);
    assert.ok(frames[0].payload.equals(Buffer.from([3, ...Buffer.from('abc123')])));
  });

  it('end() rejects a stream that stops mid-frame', () => {
    const dec = new FrameDecoder();
    dec.feed(encodeFrame(FRAME.DATA, Buffer.from('xyz'), 1).subarray(0, 6));
    assert.throws(() => dec.end(), GatewayProtocolError);
  });

  it('rejects unknown type byte', () => {
    const buf = encodeFrame(FRAME.PING, Buffer.alloc(8));
    buf[0] = 0x7f;
    assert.throws(() => decodeFrames(buf), GatewayProtocolError);
    const dec = new FrameDecoder();
    assert.throws(() => dec.feed(Buffer.from([0x7f])), GatewayProtocolError);
  });

  it('rejects oversized payload length prefix', () => {
    const buf = encodeFrame(FRAME.DATA, Buffer.alloc(10), 1);
    buf.writeUInt32BE(MAX_PAYLOAD + 1, 1);
    assert.throws(() => decodeFrames(buf), GatewayProtocolError);
    const dec = new FrameDecoder();
    assert.throws(() => dec.feed(buf.subarray(0, 5)), GatewayProtocolError);
  });

  it('rejects truncated header (one-shot)', () => {
    assert.throws(() => decodeFrames(Buffer.from([FRAME.PING, 0, 0])), GatewayProtocolError);
  });

  it('rejects truncated payload (one-shot)', () => {
    const buf = encodeFrame(FRAME.DATA, Buffer.from('abcdef'), 1);
    assert.throws(() => decodeFrames(buf.subarray(0, buf.length - 2)), GatewayProtocolError);
  });

  it('rejects REGISTER with bad version byte', () => {
    const payload = Buffer.concat([Buffer.from([99]), Buffer.from('tok')]);
    assert.throws(() => decodeFrames(encodeFrame(FRAME.REGISTER, payload)), /version 99/);
    const dec = new FrameDecoder();
    assert.throws(() => dec.feed(encodeFrame(FRAME.REGISTER, payload)), /version 99/);
  });

  it('rejects encode of unknown type', () => {
    assert.throws(() => encodeFrame(0x99, Buffer.alloc(0)), GatewayProtocolError);
  });

  it('rejects encode of oversized payload', () => {
    assert.throws(() => encodeFrame(FRAME.DATA, Buffer.alloc(MAX_PAYLOAD + 1), 1), GatewayProtocolError);
  });

  it('decoder is unusable after a throw', () => {
    const dec = new FrameDecoder();
    assert.throws(() => dec.feed(Buffer.from([0xee])), GatewayProtocolError);
    assert.throws(() => dec.feed(Buffer.alloc(0)), GatewayProtocolError);
  });
});
