import net from 'node:net';

const STANDARD_DEV_PORTS = [3000, 5173, 8080, 4321, 30178];
const EXTENDED_DEV_PORTS = [3001, 3002, 5174, 5175, 8000, 8001, 8888, 5000, 4000, 1234];

export function isPortOpen(port, host = '127.0.0.1', timeout = 300) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

export async function detectDevPorts(candidates, host = '127.0.0.1') {
  const probe = async (ports) => {
    const results = await Promise.all(
      ports.map(async (port) => ({ port, open: await isPortOpen(port, host) }))
    );
    return results.filter((r) => r.open).map((r) => r.port);
  };

  const active = await probe(candidates ?? STANDARD_DEV_PORTS);
  return active.length > 0 || candidates ? active : probe(EXTENDED_DEV_PORTS);
}

export function parseTarget(input) {
  if (!input || typeof input !== 'string' || input.startsWith('-')) return null;
  const trimmed = input.trim();

  if (/^\d+$/.test(trimmed)) {
    const port = Number(trimmed);
    if (!(port > 0 && port <= 65535)) return null;
    return { port, host: '127.0.0.1', protocol: port === 443 ? 'https:' : 'http:' };
  }

  try {
    const hasProtocol = trimmed.includes('://');
    const parsed = new URL(hasProtocol ? trimmed : `http://${trimmed}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    let port = parsed.port ? Number(parsed.port) : null;
    if (!port && hasProtocol) {
      port = parsed.protocol === 'https:' ? 443 : 80;
    }
    if (!(port > 0 && port <= 65535)) return null;
    return { port, host: parsed.hostname || '127.0.0.1', protocol: hasProtocol ? parsed.protocol : (port === 443 ? 'https:' : 'http:') };
  } catch (_) {
    return null;
  }
}

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}
