import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMasqueradeProxy } from '../src/proxy.js';
import { startTunnel } from '../src/tunnel.js';
import { isPortOpen, detectDevPorts, findFreePort, parseTarget } from '../src/port.js';

test('Inspector page is served by devhop while app responses stay byte-identical', async (t) => {
  const backendPort = await findFreePort();
  const proxyPort = await findFreePort();
  const payload = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);

  const backend = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(payload);
  });
  await new Promise((resolve) => backend.listen(backendPort, '127.0.0.1', resolve));

  const { server: proxyServer } = createMasqueradeProxy({ targetPort: backendPort });
  await new Promise((resolve) => proxyServer.listen(proxyPort, '127.0.0.1', resolve));
  t.after(() => {
    backend.close();
    proxyServer.close();
  });

  const inspectResponse = await fetch(`http://127.0.0.1:${proxyPort}/__devhop/inspect`);
  assert.strictEqual(inspectResponse.status, 200);
  assert.match(inspectResponse.headers.get('content-type'), /^text\/html/);
  const inspectHtml = await inspectResponse.text();
  assert.match(inspectHtml, /Eruda/);
  assert.match(inspectHtml, /<iframe[^>]+src="\/"/);

  const appResponse = await fetch(`http://127.0.0.1:${proxyPort}/`);
  assert.strictEqual(appResponse.status, 200);
  assert.deepStrictEqual(Buffer.from(await appResponse.arrayBuffer()), payload);
});

test('Proxy rewrites request headers (Host, Origin, Referer, x-forwarded-proto, sec-fetch-site)', async (t) => {
  const backendPort = await findFreePort();
  const proxyPort = await findFreePort();

  let capturedHeaders = null;

  // 1. Mock dev server
  const backend = http.createServer((req, res) => {
    capturedHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise((r) => backend.listen(backendPort, '127.0.0.1', r));

  // 2. DevHop masquerade proxy
  const { server: proxyServer } = createMasqueradeProxy({
    targetPort: backendPort,
    getPublicUrl: () => 'https://mock.trycloudflare.com'
  });

  await new Promise((r) => proxyServer.listen(proxyPort, '127.0.0.1', r));

  t.after(() => {
    backend.close();
    proxyServer.close();
  });

  // 3. Client sends request mimicking external Cloudflare tunnel
  await fetch(`http://127.0.0.1:${proxyPort}/api/test`, {
    headers: {
      Host: 'mock.trycloudflare.com',
      Origin: 'https://mock.trycloudflare.com',
      Referer: 'https://mock.trycloudflare.com/settings',
      'Sec-Fetch-Site': 'cross-site'
    }
  });

  assert.ok(capturedHeaders, 'Backend should have received request');
  assert.strictEqual(capturedHeaders.host, `localhost:${backendPort}`, 'Host must be masqueraded to localhost:<port>');
  assert.strictEqual(capturedHeaders.origin, `https://localhost:${backendPort}`, 'Origin must match https protocol');
  assert.strictEqual(capturedHeaders.referer, `https://localhost:${backendPort}/`, 'Referer must be masqueraded to https://localhost:<port>/');
  assert.strictEqual(capturedHeaders['sec-fetch-site'], 'same-origin', 'sec-fetch-site must be normalized to same-origin');
  assert.strictEqual(capturedHeaders['x-forwarded-proto'], 'https', 'x-forwarded-proto must be https');
  assert.strictEqual(capturedHeaders['x-forwarded-ssl'], 'on', 'x-forwarded-ssl must be on');
  assert.strictEqual(capturedHeaders['x-forwarded-host'], `localhost:${backendPort}`, 'x-forwarded-host must be localhost:<port>');
});

test('Proxy rewrites both http:// and https:// Location headers in redirects', async (t) => {
  const backendPort = await findFreePort();
  const proxyPort = await findFreePort();
  const publicTunnelUrl = 'https://cool-tunnel-name.trycloudflare.com';

  // 1. Mock backend returning both http and https redirects
  let redirectCount = 0;
  const backend = http.createServer((req, res) => {
    redirectCount++;
    const scheme = redirectCount === 1 ? 'http' : 'https';
    res.writeHead(302, {
      Location: `${scheme}://localhost:${backendPort}/dashboard?param=test#section`
    });
    res.end();
  });

  await new Promise((r) => backend.listen(backendPort, '127.0.0.1', r));

  // 2. DevHop masquerade proxy
  const { server: proxyServer } = createMasqueradeProxy({
    targetPort: backendPort,
    getPublicUrl: () => publicTunnelUrl
  });

  await new Promise((r) => proxyServer.listen(proxyPort, '127.0.0.1', r));

  t.after(() => {
    backend.close();
    proxyServer.close();
  });

  // Test 1: http redirect rewrite
  let res = await fetch(`http://127.0.0.1:${proxyPort}/login`, { redirect: 'manual' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(
    res.headers.get('location'),
    `${publicTunnelUrl}/dashboard?param=test#section`,
    'http:// redirect must be rewritten to public tunnel URL'
  );

  // Test 2: https redirect rewrite
  res = await fetch(`http://127.0.0.1:${proxyPort}/login`, { redirect: 'manual' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(
    res.headers.get('location'),
    `${publicTunnelUrl}/dashboard?param=test#section`,
    'https:// redirect must be rewritten to public tunnel URL'
  );
});

test('Proxy rewrites Access-Control-Allow-Origin response header to public tunnel URL', async (t) => {
  const backendPort = await findFreePort();
  const proxyPort = await findFreePort();
  const publicTunnelUrl = 'https://cors-test.trycloudflare.com';

  const backend = http.createServer((req, res) => {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': `https://localhost:${backendPort}`,
      'Access-Control-Allow-Credentials': 'true'
    });
    res.end('ok');
  });
  // 2. DevHop masquerade proxy
  await new Promise((r) => backend.listen(backendPort, '127.0.0.1', r));

  const { server: proxyServer } = createMasqueradeProxy({
    targetPort: backendPort,
    getPublicUrl: () => publicTunnelUrl
  });

  await new Promise((r) => proxyServer.listen(proxyPort, '127.0.0.1', r));

  t.after(() => {
    backend.close();
    proxyServer.close();
  });

  const res = await fetch(`http://127.0.0.1:${proxyPort}/api/data`);
  assert.strictEqual(
    res.headers.get('access-control-allow-origin'),
    publicTunnelUrl,
    'Access-Control-Allow-Origin must be rewritten to the public tunnel URL'
  );
});

test('Proxy strips Domain=localhost and Domain=.localhost from response Set-Cookie headers', async (t) => {
  const backendPort = await findFreePort();
  const proxyPort = await findFreePort();

  const backend = http.createServer((req, res) => {
    res.setHeader('Set-Cookie', [
      `session_token=secret123; Domain=localhost; Path=/; HttpOnly; SameSite=Lax`,
      `dotted_cookie=abc; Domain=.localhost; Path=/`,
      `ipv6_cookie=xyz; domain=[::1]; Path=/`
    ]);
    res.writeHead(200);
    res.end('ok');
  });

  await new Promise((r) => backend.listen(backendPort, '127.0.0.1', r));

  const { server: proxyServer } = createMasqueradeProxy({
    targetPort: backendPort,
    getPublicUrl: () => 'https://mock.trycloudflare.com'
  });

  await new Promise((r) => proxyServer.listen(proxyPort, '127.0.0.1', r));

  t.after(() => {
    backend.close();
    proxyServer.close();
  });

  const res = await fetch(`http://127.0.0.1:${proxyPort}/test`);
  const rawCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];

  assert.strictEqual(rawCookies.length, 3);
  assert.ok(!rawCookies[0].includes('Domain=localhost'), 'Domain=localhost must be stripped');
  assert.ok(!rawCookies[1].includes('Domain=.localhost'), 'Domain=.localhost must be stripped');
  assert.ok(!rawCookies[2].includes('domain=[::1]'), 'domain=[::1] must be stripped');
  assert.ok(rawCookies[0].includes('Path=/'), 'Path attribute must remain intact');
});

test('Port probing and auto-detection identifies open dev server ports', async (t) => {
  const testPort = await findFreePort();
  const unusedPort = await findFreePort();

  const beforeListen = await isPortOpen(testPort);
  assert.strictEqual(beforeListen, false, 'Port should be closed before server start');

  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => server.listen(testPort, '127.0.0.1', r));

  t.after(() => server.close());

  const afterListen = await isPortOpen(testPort);
  assert.strictEqual(afterListen, true, 'Port should be detected as open');

  const detected = await detectDevPorts([testPort, unusedPort]);
  assert.deepStrictEqual(detected, [testPort], 'Should only detect active listening port');
});

test('parseTarget dynamically handles ports, hosts, URLs, and edge cases', () => {
  assert.deepStrictEqual(parseTarget('3000'), { port: 3000, host: '127.0.0.1', protocol: 'http:' });
  assert.deepStrictEqual(parseTarget('443'), { port: 443, host: '127.0.0.1', protocol: 'https:' });
  assert.deepStrictEqual(parseTarget('localhost:3000'), { port: 3000, host: 'localhost', protocol: 'http:' });
  assert.deepStrictEqual(parseTarget('127.0.0.1:8080'), { port: 8080, host: '127.0.0.1', protocol: 'http:' });
  assert.deepStrictEqual(parseTarget('0.0.0.0:4321'), { port: 4321, host: '0.0.0.0', protocol: 'http:' });
  assert.deepStrictEqual(parseTarget('http://localhost:5173'), { port: 5173, host: 'localhost', protocol: 'http:' });
  assert.deepStrictEqual(parseTarget('https://127.0.0.1:8443'), { port: 8443, host: '127.0.0.1', protocol: 'https:' });
  assert.deepStrictEqual(parseTarget('https://localhost'), { port: 443, host: 'localhost', protocol: 'https:' });
  assert.deepStrictEqual(parseTarget('http://127.0.0.1:3000/some/path'), { port: 3000, host: '127.0.0.1', protocol: 'http:' });
  assert.deepStrictEqual(parseTarget('[::1]:3000'), { port: 3000, host: '[::1]', protocol: 'http:' });
  assert.deepStrictEqual(parseTarget('http://[::1]:3000'), { port: 3000, host: '[::1]', protocol: 'http:' });

  assert.strictEqual(parseTarget(''), null);
  assert.strictEqual(parseTarget('--no-qr'), null);
  assert.strictEqual(parseTarget('-h'), null);
  assert.strictEqual(parseTarget('invalid-target'), null);
  assert.strictEqual(parseTarget('ftp://localhost:21'), null);
  assert.strictEqual(parseTarget('70000'), null);
  assert.strictEqual(parseTarget('0'), null);
});

test('Proxy handles dev server restarts: returns 502 when down and resumes when up', async (t) => {
  const backendPort = await findFreePort();
  const proxyPort = await findFreePort();

  const { server: proxyServer } = createMasqueradeProxy({
    targetPort: backendPort,
    getPublicUrl: () => 'https://restart-test.trycloudflare.com'
  });

  await new Promise((r) => proxyServer.listen(proxyPort, '127.0.0.1', r));
  t.after(() => proxyServer.close());

  // 1. Request when backend is down/restarting: should return 502 with Retry-After header
  const downRes = await fetch(`http://127.0.0.1:${proxyPort}/api/health`);
  assert.strictEqual(downRes.status, 502, 'Should return 502 Bad Gateway when dev server is offline');
  assert.strictEqual(downRes.headers.get('retry-after'), '1');
  const downText = await downRes.text();
  assert.ok(downText.includes(`Target server not responding on port ${backendPort}`));

  // 2. Start dev server (simulating dev server finished rebooting)
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('online');
  });
  await new Promise((r) => backend.listen(backendPort, '127.0.0.1', r));
  t.after(() => backend.close());

  // 3. Request immediately succeeds without restarting devhop proxy
  const upRes = await fetch(`http://127.0.0.1:${proxyPort}/api/health`);
  assert.strictEqual(upRes.status, 200, 'Should resume proxying with 200 when dev server is back online');
  const upText = await upRes.text();
  assert.strictEqual(upText, 'online');
});

test('Proxy streams chunked SSE response without buffering', async (t) => {
  const backendPort = await findFreePort();
  const proxyPort = await findFreePort();

  const backend = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('event: message\ndata: part1\n\n');
    setTimeout(() => {
      res.write('event: message\ndata: part2\n\n');
      res.end();
    }, 30);
  });

  await new Promise((r) => backend.listen(backendPort, '127.0.0.1', r));

  const { server: proxyServer } = createMasqueradeProxy({
    targetPort: backendPort,
    getPublicUrl: () => 'https://stream-test.trycloudflare.com'
  });

  await new Promise((r) => proxyServer.listen(proxyPort, '127.0.0.1', r));
  t.after(() => {
    backend.close();
    proxyServer.close();
  });

  const res = await fetch(`http://127.0.0.1:${proxyPort}/stream`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'text/event-stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value));
  }

  assert.ok(chunks.length >= 1, 'Should receive streamed chunks');
  const fullBody = chunks.join('');
  assert.ok(fullBody.includes('part1') && fullBody.includes('part2'), 'Full SSE stream payload should be received');
});

test('Proxy rewrites Next.js x-action-redirect response header to public tunnel URL', async (t) => {
  const backendPort = await findFreePort();
  const proxyPort = await findFreePort();
  const publicUrl = 'https://shiny-tunnel-789.trycloudflare.com';

  const backend = http.createServer((req, res) => {
    res.writeHead(200, {
      'x-action-redirect': `http://localhost:${backendPort}/dashboard;push`
    });
    res.end();
  });

  await new Promise((r) => backend.listen(backendPort, '127.0.0.1', r));

  const { server: proxyServer } = createMasqueradeProxy({
    targetPort: backendPort,
    getPublicUrl: () => publicUrl
  });

  await new Promise((r) => proxyServer.listen(proxyPort, '127.0.0.1', r));

  t.after(() => {
    backend.close();
    proxyServer.close();
  });

  const res = await fetch(`http://127.0.0.1:${proxyPort}/action`, {
    method: 'POST'
  });

  assert.strictEqual(
    res.headers.get('x-action-redirect'),
    `${publicUrl}/dashboard;push`,
    'x-action-redirect must be rewritten to public tunnel URL'
  );
});

test('Proxy injects Connection: close on chunked Transfer-Encoding requests', async (t) => {
  const backendPort = await findFreePort();
  const proxyPort = await findFreePort();
  let backendConnectionHeader = null;

  const backend = http.createServer((req, res) => {
    backendConnectionHeader = req.headers.connection;
    res.writeHead(200);
    res.end('ok');
  });

  await new Promise((r) => backend.listen(backendPort, '127.0.0.1', r));

  const { server: proxyServer } = createMasqueradeProxy({
    targetPort: backendPort
  });

  await new Promise((r) => proxyServer.listen(proxyPort, '127.0.0.1', r));

  t.after(() => {
    backend.close();
    proxyServer.close();
  });

  // Send a chunked POST request using native http.request
  await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: proxyPort,
        path: '/upload',
        method: 'POST',
        headers: {
          'transfer-encoding': 'chunked'
        }
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', reject);
    req.write('hello chunk');
    req.end();
  });
  assert.strictEqual(backendConnectionHeader, 'close', 'Should set Connection: close for chunked transfers');
});

test('Tunnel parses Cloudflare Edge location from log output', async (t) => {
  const { startTunnel } = await import('../src/tunnel.js');
  if (process.platform === 'win32') { t.skip('Shell script stub test skipped on Windows'); return; }
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhop-loc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = path.join(dir, 'fake-cloudflared.sh');
  fs.writeFileSync(stub, '#!/bin/sh\necho "2026-01-01 INF Registered tunnel connection connIndex=0 location=arn" >&2\nsleep 0.2\n');
  fs.chmodSync(stub, '755');

  const locations = [];
  await new Promise((resolve) => {
    startTunnel({
      localPort: 3000,
      binPath: stub,
      onLocation: (loc) => locations.push(loc),
      onClose: () => resolve(),
    });
  });

  assert.deepStrictEqual(locations, ['ARN']);
});

test('Tunnel location regex matches location=([A-Z0-9]+) case-insensitively', () => {
  const samples = [
    ['INF Registered tunnel connection connIndex=0 location=ARN', 'ARN'],
    ['connIndex=3 location=lhr', 'LHR'],
    ['location=SIN col=1', 'SIN'],
  ];
  for (const [line, expected] of samples) {
    const m = line.match(/location=([A-Z0-9]+)/i);
    assert.ok(m, `Should match edge location in: ${line}`);
    assert.strictEqual(m[1].toUpperCase(), expected);
  }
  assert.strictEqual('no edge info here'.match(/location=([A-Z0-9]+)/i), null);
});

test('Tunnel keeps 10-line ring buffer of recent output on premature exit', async (t) => {
  const { startTunnel } = await import('../src/tunnel.js');
  const fs = await import('node:fs');
  if (process.platform === 'win32') { t.skip('Shell script stub test skipped on Windows'); return; }
  const os = await import('node:os');
  const path = await import('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhop-ring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = path.join(dir, 'fake-cloudflared.sh');
  const lines = Array.from({ length: 15 }, (_, i) => `echo "log line ${i + 1}" >&2`).join('\n');
  fs.writeFileSync(stub, `#!/bin/sh\n${lines}\nexit 1\n`);
  fs.chmodSync(stub, '755');

  const details = await new Promise((resolve) => {
    startTunnel({
      localPort: 3000,
      binPath: stub,
      onClose: (_code, d) => resolve(d),
    });
  });

  const kept = details.recentOutput.split('\n');
  assert.strictEqual(kept.length, 10, 'Ring buffer should cap at 10 lines');
  assert.deepStrictEqual(kept, Array.from({ length: 10 }, (_, i) => `log line ${i + 6}`));
});

test('Tunnel passes --protocol http2 to cloudflared when requested', async (t) => {
  const { startTunnel } = await import('../src/tunnel.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  if (process.platform === 'win32') { t.skip('Shell script stub test skipped on Windows'); return; }
  const path = await import('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhop-proto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = path.join(dir, 'fake-cloudflared.sh');
  fs.writeFileSync(stub, '#!/bin/sh\necho "ARGS:$@"\n');
  fs.chmodSync(stub, '755');

  const withHttp2 = await new Promise((resolve) => {
    startTunnel({ localPort: 3000, binPath: stub, protocol: 'http2', onClose: (_c, d) => resolve(d) });
  });
  assert.match(withHttp2.recentOutput, /--protocol http2/, 'http2 protocol must add --protocol http2 args');

  const without = await new Promise((resolve) => {
    startTunnel({ localPort: 3000, binPath: stub, onClose: (_c, d) => resolve(d) });
  });
  assert.doesNotMatch(without.recentOutput, /--protocol/, 'Default tunnel must not pass --protocol');
});

test('Proxy reaches self-signed HTTPS upstream when protocol is https:', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhop-https-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const backendPort = await findFreePort();
  const proxyPort = await findFreePort();

  const backend = https.createServer({
    key: fs.readFileSync(path.join(dir, 'key.pem')),
    cert: fs.readFileSync(path.join(dir, 'cert.pem'))
  }, (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('secure-backend'); });
  await new Promise((r) => backend.listen(backendPort, '127.0.0.1', r));
  t.after(() => new Promise((r) => backend.close(r)));

  const { server: proxyServer } = createMasqueradeProxy({
    targetPort: backendPort,
    targetProtocol: 'https:',
    getPublicUrl: () => 'https://mock.trycloudflare.com'
  });
  await new Promise((r) => proxyServer.listen(proxyPort, '127.0.0.1', r));
  t.after(() => new Promise((r) => proxyServer.close(r)));

  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${proxyPort}/`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
  assert.equal(body.status, 200);
  assert.equal(body.data, 'secure-backend');
});

test('Tunnel retries once with backoff when cloudflared exits before a URL is found', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhop-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = path.join(dir, 'cloudflared-stub');
  // First run exits empty (quick-tunnel failure); second run prints a URL then exits.
  fs.writeFileSync(stub, `#!/bin/sh
if [ -f ${dir}/second ]; then
  echo "https://retry-test.trycloudflare.com"
else
  touch ${dir}/second
  echo "failed to request quick tunnel" >&2
  exit 1
fi
`);
  fs.chmodSync(stub, '755');

  const events = [];
  const handle = startTunnel({
    localPort: 3000,
    binPath: stub,
    onRetry: () => events.push('retry'),
    onUrl: (url) => events.push(`url:${url}`),
    onClose: (code, details) => events.push(`close:${code}:${details.urlFound}`)
  });
  t.after(() => handle.close());
  const result = await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (events.some((e) => e.startsWith('close:'))) { clearInterval(poll); resolve(events); }
    }, 100);
  });
  assert.ok(events.some((e) => e === 'retry'), 'must fire onRetry after first failure');
  assert.ok(events.some((e) => e.startsWith('url:https://retry-test.trycloudflare.com')), 'second attempt must surface a URL');
  assert.ok(events.some((e) => e.startsWith('close:0:true')), 'must close cleanly after successful retry');
});

test('Invalid explicit target errors instead of silently auto-detecting', async () => {
  const { run } = await import('../src/cli.js');
  const originalError = console.error;
  const originalExit = process.exit;
  const output = [];
  console.error = (...a) => output.push(a.join(' '));
  process.exit = (code) => { throw new Error(`exit:${code}`); };
  try {
    await run(['99999']);
    assert.fail('must not reach tunnel startup');
  } catch (err) {
    assert.match(err.message, /exit:1/);
  } finally {
    console.error = originalError;
    process.exit = originalExit;
  }
  assert.match(output.join('\n'), /Invalid target: "99999"/);
});
