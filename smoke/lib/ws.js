import crypto from 'node:crypto';
import net from 'node:net';

// Just enough WebSocket client to open an upgrade and read server text frames.
export function wsUpgrade({ port, path, headers = {}, protocol, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const lines = [
      `GET ${path} HTTP/1.1`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
    ];
    if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);

    let head = Buffer.alloc(0);
    let onText = () => {};
    let carry = Buffer.alloc(0);
    let upgraded = false;

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`WebSocket upgrade to ${path} timed out`));
    }, timeoutMs);

    // Server frames are unmasked. Anything that doesn't parse is passed on as
    // latin1 text so a pattern match on the raw bytes still works.
    const decode = (chunk) => {
      carry = Buffer.concat([carry, chunk]);
      for (;;) {
        if (carry.length < 2) return;
        let len = carry[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (carry.length < 4) return;
          len = carry.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (carry.length < 10) return;
          len = Number(carry.readBigUInt64BE(2));
          offset = 10;
        }
        if (carry.length < offset + len) return;
        const opcode = carry[0] & 0x0f;
        const payload = carry.subarray(offset, offset + len);
        carry = carry.subarray(offset + len);
        if (opcode === 1) onText(payload.toString('utf8'));
      }
    };

    socket.on('connect', () => socket.write(lines.join('\r\n') + '\r\n\r\n'));
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('data', (chunk) => {
      if (upgraded) {
        decode(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      clearTimeout(timer);
      upgraded = true;
      const statusLine = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
      const status = Number(statusLine.split(' ')[1]);
      const rest = head.subarray(end + 4);
      resolve({
        status,
        statusLine,
        socket,
        readText(callback) {
          onText = callback;
          if (rest.length) decode(rest);
        },
      });
    });
  });
}
