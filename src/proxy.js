import http from 'node:http';
import httpProxy from 'http-proxy';
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


/**
 * Creates a reverse proxy that masquerades Host, Origin, and Referer headers
 * to localhost:<targetPort> and rewrites response Location, Access-Control-Allow-Origin,
 * and Set-Cookie headers.
 *
 * @param {Object} options
 * @param {number} options.targetPort - Local dev server port to proxy to
 * @param {string} [options.targetHost='127.0.0.1'] - Local dev server host
 * @param {() => string | null} [options.getPublicUrl] - Function returning current public tunnel URL
 * @returns {{ server: http.Server, proxy: httpProxy }}
 */
export function createMasqueradeProxy({
  targetPort,
  targetHost = '127.0.0.1',
  targetProtocol = 'http:',
  getPublicUrl = () => null
}) {
  const normalizedHost = targetHost === '0.0.0.0' ? '127.0.0.1' : targetHost;
  const proxy = httpProxy.createProxyServer({
    target: `${targetProtocol === 'https:' ? 'https' : 'http'}://${normalizedHost}:${targetPort}`,
    ws: true,
    changeOrigin: true,
    // Accept self-signed local certs (vite --https, next --experimental-https);
    // loopback traffic never leaves the kernel, so no MITM exposure.
    secure: targetProtocol !== 'https:',
    xfwd: false // Managed explicitly below to avoid leaking public tunnel host
  });

  const rewriteRequestHeaders = (proxyReq, req) => {
    // 1. Masquerade Host and x-forwarded headers to localhost so dev servers treat connection as local
    proxyReq.setHeader('Host', `localhost:${targetPort}`);
    proxyReq.setHeader('x-forwarded-host', `localhost:${targetPort}`);
    proxyReq.setHeader('x-forwarded-proto', 'https');
    proxyReq.setHeader('x-forwarded-ssl', 'on');

    // 2. Align Origin with https protocol (prevents Next.js cross-origin API rejections)
    if (req.headers.origin) {
      proxyReq.setHeader('Origin', `https://localhost:${targetPort}`);
    } else {
      proxyReq.removeHeader('Origin');
    }

    // 3. Align Referer with https protocol
    if (req.headers.referer) {
      proxyReq.setHeader('Referer', `https://localhost:${targetPort}/`);
    }

    // 4. Normalize sec-fetch-site to same-origin
    if (req.headers['sec-fetch-site']) {
      proxyReq.setHeader('sec-fetch-site', 'same-origin');
    }

    // 5. Harden against request smuggling on chunked transfers (GHSA-ggv3-7p47-pfv8)
    if (req.headers['transfer-encoding']?.includes('chunked')) {
      proxyReq.setHeader('Connection', 'close');
    }
  };

  proxy.on('proxyReq', rewriteRequestHeaders);
  proxy.on('proxyReqWs', rewriteRequestHeaders);

  // Intercept response headers to rewrite Location, CORS, and Set-Cookie
  proxy.on('proxyRes', (proxyRes) => {
    const publicUrl = getPublicUrl();

    // 1. Rewrite Location header in redirects (OAuth, Server Actions, form submissions)
    // Matches both http:// and https:// across localhost, 127.0.0.1, 0.0.0.0, and [::1]
    if (proxyRes.headers.location && publicUrl) {
      proxyRes.headers.location = proxyRes.headers.location.replace(
        new RegExp(`^https?://(\\.?(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]))(:${targetPort})?(?=/|$)`, 'i'),
        publicUrl
      );
    }

    // 1b. Rewrite Next.js Server Action redirect header (x-action-redirect)
    if (proxyRes.headers['x-action-redirect'] && publicUrl) {
      proxyRes.headers['x-action-redirect'] = proxyRes.headers['x-action-redirect'].replace(
        new RegExp(`^https?://(\\.?(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]))(:${targetPort})?(?=/|$)`, 'i'),
        publicUrl
      );
    }

    // 2. Rewrite Access-Control-Allow-Origin if backend reflects localhost origin
    const acao = proxyRes.headers['access-control-allow-origin'];
    if (acao && publicUrl) {
      if (acao.includes('localhost') || acao.includes('127.0.0.1') || acao.includes('0.0.0.0') || acao.includes('[::1]')) {
        proxyRes.headers['access-control-allow-origin'] = publicUrl;
      }
    }

    // 3. Rewrite Set-Cookie to strip Domain=localhost (including leading dots) so mobile browsers store cookies
    if (proxyRes.headers['set-cookie']) {
      const cookies = Array.isArray(proxyRes.headers['set-cookie'])
        ? proxyRes.headers['set-cookie']
        : [proxyRes.headers['set-cookie']];

      proxyRes.headers['set-cookie'] = cookies.map((cookie) => {
        return cookie.replace(/;\s*domain=(\.?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]))/gi, '');
      });
    }

    // 4. Ensure streaming / SSE responses are not buffered by edge tunnels
    if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
      proxyRes.headers['x-accel-buffering'] = 'no';
    }
  });

  // Handle proxy errors: return clean 502 on dev server restarts / crashes
  proxy.on('error', (err, req, res) => {
    if (res && typeof res.writeHead === 'function') {
      if (!res.headersSent && res.writable) {
        try {
          res.writeHead(502, {
            'Content-Type': 'text/plain',
            'Retry-After': '1'
          });
          res.end(err?.code === 'ECONNRESET' && targetProtocol === 'https:' ? `devhop: TLS handshake failed on port ${targetPort} — is the dev server really HTTPS? Try: npx devhop http://${normalizedHost}:${targetPort}` : `devhop: Target server not responding on port ${targetPort}`);
        } catch (_) {}
      }
    } else if (res && typeof res.destroy === 'function' && !res.destroyed) {
      try {
        res.destroy();
      } catch (_) {}
    }
  });


  const server = http.createServer((req, res) => {
    if (req.url?.split('?', 1)[0] === '/__devhop/inspect') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(INSPECT_PAGE);
      return;
    }
    proxy.web(req, res);
  });

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

  return { server, proxy };
}
