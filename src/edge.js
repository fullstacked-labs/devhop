import dns from 'node:dns';
import https from 'node:https';

const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
const PROBE_TIMEOUT_MS = 5000;

// Some local resolvers don't see a brand-new trycloudflare name for a while, so
// ask public DNS first. Only this probe bypasses the system resolver.
async function resolveAddress(hostname) {
  try {
    const resolver = new dns.promises.Resolver();
    resolver.setServers(PUBLIC_RESOLVERS);
    const [address] = await resolver.resolve4(hostname);
    if (address) return address;
  } catch (_) {}
  return (await dns.promises.lookup(hostname)).address;
}

async function probe(url) {
  const { hostname, pathname, search } = new URL(url);
  const address = await resolveAddress(hostname);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: address,
      servername: hostname,
      headers: { Host: hostname },
      path: pathname + search,
      agent: false,
      timeout: PROBE_TIMEOUT_MS
    }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('timeout', () => req.destroy(new Error('probe timed out')));
    req.on('error', reject);
    req.end();
  });
}

// The proxy answers /__devhop/inspect itself, so a slow or stopped dev server
// doesn't affect the result. The edge answers 5xx until the tunnel is routable.
export async function waitForEdge(url, { timeoutMs = 20000, intervalMs = 1000, fetchImpl = probe } = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const target = `${url}/__devhop/inspect`;
  for (;;) {
    try {
      const { status } = await fetchImpl(target);
      if (status < 500) return { ready: true, ms: Date.now() - started };
    } catch (_) {}
    if (Date.now() + intervalMs >= deadline) return { ready: false, ms: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
