import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

const port = Number(process.argv[2]);
const local = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
const origins = new Set([`http://localhost:${port}`, `https://localhost:${port}`, `http://127.0.0.1:${port}`]);

const server = http.createServer((req, res) => {
  if (!local.has(req.headers.host)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end(`Blocked request. This host ("${req.headers.host}") is not allowed.`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<h1>stub</h1>');
});

server.on('upgrade', (req, socket) => {
  if (req.url !== '/hmr' || !origins.has(req.headers.origin)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const watcher = fs.watch(new URL('./watched.txt', import.meta.url), () => {
    const payload = Buffer.from('{"type":"update"}');
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
  socket.on('close', () => watcher.close());
  socket.on('error', () => watcher.close());
});

server.listen(port, '127.0.0.1');
