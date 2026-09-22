import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';

const INSPECT_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>devhop inspector</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #111827; color: #e5e7eb; }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body { overflow: hidden; }
    main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(17rem, 22rem); height: 100%; }
    .preview { min-width: 0; background: #fff; }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
    .panel { overflow: auto; padding: 2rem; border-left: 1px solid #374151; }
    .eyebrow { margin: 0 0 .5rem; color: #93c5fd; font-size: .75rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0 0 .75rem; font-size: 1.6rem; line-height: 1.1; }
    h2 { margin: 2rem 0 .75rem; font-size: 1rem; }
    p { color: #cbd5e1; line-height: 1.5; }
    .bookmarklet { display: block; margin: 1.25rem 0 .75rem; padding: .75rem 1rem; border-radius: .5rem; background: #60a5fa; color: #0f172a; font-weight: 700; text-align: center; text-decoration: none; }
    .bookmarklet:hover { background: #93c5fd; }
    .hint { margin: 0; font-size: .85rem; }
    ul { display: grid; gap: .7rem; margin: 0; padding: 0; list-style: none; }
    a { color: #93c5fd; }
    @media (max-width: 720px) {
      body { overflow: auto; }
      main { display: flex; flex-direction: column; height: auto; min-height: 100%; }
      .preview { height: 68vh; min-height: 22rem; }
      .panel { border-top: 1px solid #374151; border-left: 0; }
    }
  </style>
</head>
<body>
  <main>
    <section class="preview" aria-label="Application preview">
      <iframe src="/" title="Your dev server"></iframe>
    </section>
    <aside class="panel">
      <p class="eyebrow">devhop inspector</p>
      <h1>Inspect your app on-device</h1>
      <p>Use the preview to open your app, then load Eruda without changing the app HTML or proxying its response body.</p>
      <a class="bookmarklet" href="javascript:(()=>{const d=document.querySelector('iframe')?.contentDocument||document,w=d.defaultView;if(w.eruda){w.eruda.init();return}const s=d.createElement('script');s.src='https://cdn.jsdelivr.net/npm/eruda@3.4.3';s.onload=()=>w.eruda.init();d.head.appendChild(s)})()">Load Eruda on the app page</a>
      <p class="hint">Tap this link while the app is open. Save it as a bookmarklet if you want to use it after opening the app directly.</p>
      <h2>Bundler recipes</h2>
      <ul>
        <li><a href="https://www.npmjs.com/package/vite-plugin-eruda" target="_blank" rel="noreferrer">Vite: vite-plugin-eruda</a></li>
        <li><a href="https://nextjs.org/docs/app/building-your-application/rendering/client-components" target="_blank" rel="noreferrer">Next.js: dev-only client provider</a></li>
      </ul>
    </aside>
  </main>
</body>
</html>`;

const LOCAL_HOST_PATTERN = /^https?:\/\/\.?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(?=\/|$)/i;
const DOMAIN_COOKIE_PATTERN = /;\s*domain=(\.?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]))/gi;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'upgrade'
]);

/**
 * Creates a reverse proxy that masquerades Host, Origin, and Referer headers
 * so remote phones look like local loopback traffic to the dev server.
 *
 * Pure Node stdlib (http/https request for regular traffic, raw TCP/TLS socket
 * for WebSocket upgrades) — no proxy dependency. Rewrites on the way in: Host,
 * x-forwarded-*, Origin, Referer, sec-fetch-site. On the way out: Location,
 * x-action-redirect, Access-Control-Allow-Origin, Set-Cookie Domain.
 *
 * @param {Object} options
 * @param {number} options.targetPort - Local dev server port to proxy to
 * @param {string} [options.targetHost='127.0.0.1'] - Local dev server host
 * @param {string} [options.targetProtocol='http:'] - Upstream scheme ('http:' or 'https:')
 * @param {() => string | null} [options.getPublicUrl] - Function returning current public tunnel URL
 * @returns {{ server: http.Server }}
 */
export function createMasqueradeProxy({
  targetPort,
  targetHost = '127.0.0.1',
  targetProtocol = 'http:',
  getPublicUrl = () => null
}) {
  const normalizedHost = targetHost === '0.0.0.0' ? '127.0.0.1' : targetHost;
  const upstreamIsHttps = targetProtocol === 'https:';

  function masqueradeRequestHeaders(req) {
    const headers = { ...req.headers };
    // 1. Masquerade Host and x-forwarded headers so dev servers treat the
    //    connection as local loopback traffic.
    headers.host = `localhost:${targetPort}`;
    headers['x-forwarded-host'] = `localhost:${targetPort}`;
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-ssl'] = 'on';

    // 2. Align Origin with https protocol (prevents Next.js cross-origin rejections)
    if (headers.origin) {
      headers.origin = `https://localhost:${targetPort}`;
    }

    // 3. Align Referer with https protocol
    if (headers.referer) {
      headers.referer = `https://localhost:${targetPort}/`;
    }

    // 4. Normalize sec-fetch-site to same-origin
    if (headers['sec-fetch-site']) {
      headers['sec-fetch-site'] = 'same-origin';
    }

    // 5. Harden against request smuggling on chunked transfers (GHSA-ggv3-7p47-pfv8):
    //    an explicit chunked body must not also carry content-length.
    if (headers['transfer-encoding']?.includes('chunked')) {
      headers.connection = 'close';
      delete headers['content-length'];
    }
    return headers;
  }

  function rewriteResponseHeaders(upstreamHeaders) {
    const publicUrl = getPublicUrl();
    const headers = { ...upstreamHeaders };

    // 1. Rewrite Location header in redirects (OAuth, Server Actions, form posts)
    if (headers.location && publicUrl) {
      headers.location = headers.location.replace(LOCAL_HOST_PATTERN, publicUrl);
    }

    // 1b. Rewrite Next.js Server Action redirect header
    if (headers['x-action-redirect'] && publicUrl) {
      headers['x-action-redirect'] = headers['x-action-redirect'].replace(LOCAL_HOST_PATTERN, publicUrl);
    }

    // 2. Rewrite Access-Control-Allow-Origin if backend reflects localhost origin
    const acao = headers['access-control-allow-origin'];
    if (acao && publicUrl && /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(acao)) {
      headers['access-control-allow-origin'] = publicUrl;
    }

    // 3. Strip Domain=localhost from Set-Cookie so mobile browsers store cookies
    if (headers['set-cookie']) {
      const cookies = Array.isArray(headers['set-cookie'])
        ? headers['set-cookie']
        : [headers['set-cookie']];
      headers['set-cookie'] = cookies.map((cookie) => cookie.replace(DOMAIN_COOKIE_PATTERN, ''));
    }

    // 4. Strip hop-by-hop headers; Node re-derives framing from the body stream.
    for (const name of HOP_BY_HOP) delete headers[name];
    return headers;
  }

  function send502(res, err) {
    if (!res || res.headersSent || !res.writable) return;
    try {
      res.writeHead(502, {
        'Content-Type': 'text/plain',
        'Retry-After': '1'
      });
      res.end(
        err?.code === 'ECONNRESET' && upstreamIsHttps
          ? `devhop: TLS handshake failed on port ${targetPort} — is the dev server really HTTPS? Try: npx devhop http://${normalizedHost}:${targetPort}`
          : `devhop: Target server not responding on port ${targetPort}`
      );
    } catch (_) {}
  }

  function proxyWebRequest(req, res) {
    const request = upstreamIsHttps ? https.request : http.request;
    const upstreamReq = request(
      {
        host: normalizedHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: masqueradeRequestHeaders(req),
        // Self-signed local certs are fine: loopback traffic never leaves the
        // kernel, so there is no MITM exposure.
        ...(upstreamIsHttps ? { rejectUnauthorized: false } : {})
      },
      (upstreamRes) => {
        const headers = rewriteResponseHeaders(upstreamRes.headers);
        res.writeHead(upstreamRes.statusCode, headers);
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => res.destroy());
      }
    );
    upstreamReq.on('error', (err) => send502(res, err));
    req.pipe(upstreamReq);
  }

  // WebSocket upgrade: open a raw TCP/TLS socket to the dev server, replay the
  // upgrade request with masqueraded headers, then pipe both directions raw.
  // No WebSocket library needed — HTTP is transparent after the 101 handshake.
  function proxyUpgrade(req, clientSocket, head) {
    const headers = masqueradeRequestHeaders(req);
    // WebSocket handshakes are request/response, not chunked: force a definite
    // framing so the dev server parses the request as a single block.
    headers.connection = 'Upgrade';

    const handshake = `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n')}\r\n\r\n`;

    const connect = (cb) =>
      upstreamIsHttps
        ? tls.connect({ host: normalizedHost, port: targetPort, rejectUnauthorized: false, servername: normalizedHost }, cb)
        : net.connect({ host: normalizedHost, port: targetPort }, cb);

    const upstreamSocket = connect(() => {
      upstreamSocket.write(handshake);
      if (head?.length) upstreamSocket.write(head);
    });
    upstreamSocket.setNoDelay(true);
    upstreamSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstreamSocket.destroy());

    // Wait for the 101 (or any failure status) before wiring raw pipes.
    let buffered = Buffer.alloc(0);
    const onUpstreamData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffered.length > 64 * 1024) {
          upstreamSocket.destroy();
          clientSocket.destroy();
        }
        return;
      }
      upstreamSocket.removeListener('data', onUpstreamData);
      const status = Number(buffered.toString('latin1').split(' ')[1]);
      if (status !== 101) {
        clientSocket.write(buffered.subarray(0, end + 4));
        clientSocket.destroy();
        upstreamSocket.destroy();
        return;
      }
      clientSocket.write(buffered);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    };
    upstreamSocket.on('data', onUpstreamData);
  }

  const server = http.createServer((req, res) => {
    if (req.url?.split('?', 1)[0] === '/__devhop/inspect') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(INSPECT_PAGE);
      return;
    }
    proxyWebRequest(req, res);
  });

  server.on('upgrade', proxyUpgrade);

  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });

  // Ignore client socket errors on the HTTP server itself
  server.on('clientError', (err, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) {
      return;
    }
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return { server };
}
