# 🦘 devhop

[![npm version](https://img.shields.io/npm/v/devhop.svg)](https://www.npmjs.com/package/devhop)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Built for AI Agents](https://img.shields.io/badge/AI%20Agent-Skill%20Ready-purple.svg)](./skills/devhop/SKILL.md)
![smoke](https://github.com/fullstacked-labs/devhop/actions/workflows/smoke.yml/badge.svg)

> **Your phone says "Blocked request. This host is not allowed." `npx devhop` fixes it.**

Hot reload, real HTTPS (mic, camera, passkeys) and a QR code, with no config edits or accounts.

```text
Vite:     Blocked request. This host ("smoke-check.trycloudflare.com") is not allowed.
Next.js:  Blocked cross-origin request to Next.js dev resource /_next/hmr from "smoke-check.trycloudflare.com".
Safari:   TypeError: undefined is not an object (evaluating 'navigator.mediaDevices.getUserMedia')
```

```bash
npx devhop [port]
```

![demo](docs/demo.gif)

```text
 🦘 DEVHOP 

  Target:       http://localhost:3000
  Mobile URL:   https://breeze-sunset-vintage-glade.trycloudflare.com
  ⚠ Public link — anyone with it can open your dev server. Ctrl+C when done.

  ✔ Connected to Cloudflare Edge [ARN]

  Scan with your iPhone or Android camera:
  [ QR Code ]

  Press Ctrl+C to stop the tunnel and disconnect.
```

## Your agent built it. Now see it on your phone.

Ask your coding agent "show me this on my phone". It runs `npx devhop --json`, reads the URL from the first event, and hands it back. You scan it, and the page hot-reloads while the agent keeps editing.

The skill is at [`skills/devhop/SKILL.md`](./skills/devhop/SKILL.md), and the [JSON events](#json-events-for-agents-and-scripts) are below.

## Works with

| Framework | Version tested | Page | Hot reload | Without devhop |
| :--- | :--- | :---: | :---: | :--- |
| Vite + React | Vite 8.3.5 | ✅ | ✅ | 403 `Blocked request. This host … is not allowed.` |
| Next.js | 16.4.3 | ✅ | ✅ | page loads, but the hot-reload WebSocket never connects |
| Nuxt | 4.6.2 | ✅ | ✅ | 403 `Blocked request. This host … is not allowed.` |
| SvelteKit | 3.1.0 | ✅ | ✅ | 403 `Blocked request. This host … is not allowed.` |
| Astro | 7.4.2 | ✅ | ✅ | 403 `Blocked request. This host … is not allowed.` |

Checked nightly in CI; see the [smoke workflow](./.github/workflows/smoke.yml). "Without devhop" is the same request sent straight to the dev server with the tunnel's Host header.

## Quickstart

Run directly without installing:

```bash
# Auto-detects your active dev server (Next.js, Vite, Astro, Nuxt, etc.)
npx devhop

# Or pass a port number
npx devhop 3000

# Or paste whatever your terminal printed
npx devhop http://localhost:5173
npx devhop localhost:3000
npx devhop 0.0.0.0:4321
```

For an HTTPS dev server, pass the upstream URL including its scheme:

```bash
npx devhop https://localhost:8443
```

Targets accept bare ports, `host:port`, and `http://` or `https://` URLs. A bare `443` implies HTTPS. Self-signed certificates on loopback are accepted. If the upstream scheme is wrong, devhop returns a `502` with a hint to retry using the matching URL scheme.

### Options

```text
npx devhop                   Auto-detect active dev server port
npx devhop [target]          Expose port, host:port, or URL with QR code
npx devhop [target] --no-qr  Expose target without printing QR code
npx devhop [target] --json   Output tunnel JSON (for AI agents & scripts)
npx devhop [target] --http2  Route tunnel over HTTP/2 (corporate firewall bypass)
npx devhop --help            Show help message
npx devhop --version         Show version
npx devhop --doctor          Print diagnostics for bug reports
```

### JSON events for agents and scripts

`npx devhop 3000 --json` writes one JSON object per line to stdout:

| `event` | When | Fields |
| --- | --- | --- |
| `ready` | The public URL is known | `url`, `inspectUrl`, `target`, `port`, `host`, `protocol`, `edgeReady` |
| `reconnecting` | The tunnel is retrying | `attempt` |
| `error` | Before exiting non-zero | `code`, `message` |
| `closed` | After Ctrl+C or SIGTERM | none |
| `doctor` | `npx devhop --doctor --json` | `devhop`, `node`, `platform`, `arch`, `cloudflared`, `devPorts`, `cacheDir` |

`edgeReady` is `false` when Cloudflare hadn't answered after 20 seconds. The URL is still valid; reload after a few seconds.

```json
{"event":"ready","url":"https://example.trycloudflare.com","inspectUrl":"https://example.trycloudflare.com/__devhop/inspect","target":"http://127.0.0.1:3000","port":3000,"host":"127.0.0.1","protocol":"http:","edgeReady":true}
{"event":"reconnecting","attempt":1}
{"event":"error","code":"NO_DEV_SERVER","message":"No active dev server detected on standard dev ports. Pass a port, e.g. npx devhop 3000."}
```

Error codes: `INVALID_TARGET`, `NO_DEV_SERVER`, `CLOUDFLARED_INSTALL_FAILED`, `TUNNEL_START_FAILED`, `TUNNEL_EXITED`, `UNCAUGHT`. Machine-readable summary: [`llms.txt`](./llms.txt).

### cloudflared

On first run devhop downloads a pinned cloudflared release into `~/.cache/devhop/bin/<version>/` and checks its SHA-256 before using it. To use your own binary instead, set `DEVHOP_CLOUDFLARED=/path/to/cloudflared`; devhop then downloads nothing.

### Mobile inspector

Open `https://<tunnel>/__devhop/inspect` on your phone for an app preview iframe, a one-tap Eruda bookmarklet, and bundler recipes for Vite and Next.js. The inspector leaves your app HTML untouched.

### Corporate firewall bypass

On office or cafe networks where UDP/QUIC is blocked, `cloudflared` may fail to connect. Force the tunnel over TCP port 443 instead:

```bash
npx devhop 3000 --http2
```

## What unlocks on your phone

Because the tunnel is genuine HTTPS, the Web APIs that need a secure context work on a real device:

| Feature | Using Wi-Fi IP (`http://192.168.x.x`) | Using `npx devhop` | What you can test |
| :--- | :---: | :---: | :--- |
| **Microphone (`getUserMedia`)** | ❌ Blocked | ✅ **Works** | Speech-to-Text dictation, voice notes, audio recorders |
| **Camera (`getUserMedia`)** | ❌ Blocked | ✅ **Works** | QR/barcode scanning, photo uploads, video capture |
| **FaceID / TouchID (Passkeys)** | ❌ Blocked | ✅ **Works** | Biometric login flows |
| **WebCrypto (`crypto.subtle`)** | ❌ Blocked | ✅ **Works** | Client-side encryption and JWT auth tokens |
| **1-Click Copy (`navigator.clipboard`)** | ❌ Blocked | ✅ **Works** | Copy-to-clipboard buttons |
| **"Add to Home Screen" (PWA)** | ❌ Blocked | ✅ **Works** | Testing full-screen PWA installs on iOS |

## How it works

```
┌─────────────────┐       HTTPS       ┌─────────────────────────────┐
│  iPhone Safari  │ ────────────────▶ │ *.trycloudflare.com (Edge)  │
└─────────────────┘                   └─────────────────────────────┘
                                                     │
                                                     ▼ HTTP
                                      ┌─────────────────────────────┐
                                      │      devhop Micro-Proxy     │
                                      │ (Makes it look like loopback)│
                                      └─────────────────────────────┘
                                                     │
                                                     ▼ Localhost
                                      ┌─────────────────────────────┐
                                      │ Next.js / Vite (Port 3000)  │
                                      └─────────────────────────────┘
```

1. **Instant trusted link**: Creates a temporary HTTPS link via Cloudflare's edge. Your phone sees a genuine, trusted security padlock.
2. **Framework friendly**: Relabels incoming requests so Next.js and Vite think your phone is just a regular browser tab running directly on your laptop. No red error screens, no config editing.
3. **Live updates on save**: Preserves the live WebSocket connection so your phone screen refreshes instantly when you save code.
4. **Logins & cookies stay intact**: Rewrites redirect links and strips `localhost` cookie restrictions so login flows and session cookies work naturally on your phone.
5. **Survives server restarts**: If Vite or Next.js reboots while you're working, `devhop` recovers automatically without dropping your tunnel or making you scan a new QR code.

## Compared to

| | **devhop** | **`cloudflared tunnel --url`** | **ngrok** | **unjs/untun** | **LocalCan** | **mkcert** |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Command** | `npx devhop` | `cloudflared tunnel --url …` | CLI download + login | `npx untun` | Mac app | `brew install` |
| **Account or signup** | None | None | Required | None | License key | None |
| **Real HTTPS padlock** | Yes | Yes | Yes | Yes | Yes (local only) | Manual iOS profile |
| **Hot reload in Vite, Next.js, Nuxt, SvelteKit, Astro** | Yes (nightly CI) | ⚠️ Needs `allowedHosts` / `allowedDevOrigins` edits | ⚠️ Needs `allowedHosts` / `allowedDevOrigins` edits | ⚠️ Needs `allowedHosts` / `allowedDevOrigins` edits | ⚠️ Needs `allowedHosts` / `allowedDevOrigins` edits | ⚠️ Wi-Fi IP mismatch |
| **Terminal QR code** | Yes | Link only | Link only | Link only | App UI only | None |

## FAQ

**Why not just cloudflared?** `cloudflared tunnel --url http://localhost:3000` gets you a URL. Then Vite answers 403 `Blocked request. This host … is not allowed.` and Next.js refuses the hot-reload socket, because both check the Host and Origin headers. devhop runs cloudflared for you and rewrites those headers so the dev server sees localhost. The [table above](#works-with) shows what each framework does without it.

**Is it safe?** The URL is public and anyone who has it can reach your dev server. See [Security & exposure](#security--exposure).

**`navigator.mediaDevices` is still undefined.** The page must be a secure context in a real browser tab. It is also undefined in home-screen web apps and some in-app browsers, and old code may call the deprecated `navigator.getUserMedia`. Open the tunnel URL in Safari or Chrome directly.

**Can I get a persistent URL?** Not on quick tunnels. Every run gets a new random subdomain.

## Security & exposure

Read this before running devhop:

- **Your dev server is reachable from the public internet** for as long as the tunnel runs. Anyone with the URL can hit it. Close the tunnel (Ctrl+C) when you step away.
- **Header masquerading is intentional.** devhop rewrites `Host`, `Origin`, and `Referer` so your dev server treats the phone as trusted loopback — which also means dev-mode origin and CSRF protections (Next.js `allowedDevOrigins`, Vite `allowedHosts`) are bypassed for everyone, not just your phone.
- Run only dev servers you're actively working on. Never point devhop at anything containing real credentials or user data.

## Limitations

devhop rides Cloudflare's free quick tunnels (`trycloudflare.com`), which Cloudflare explicitly labels *testing and development only*:

- **No SSE.** Quick tunnels buffer or drop Server-Sent Events, so token-streaming endpoints will misbehave. HMR (WebSockets) works fine.
- **200 concurrent in-flight requests.** Heavy HMR bursts or many simultaneous devices can hit Cloudflare's request cap and return `429`.
- **Ephemeral URLs.** Every run gets a new random subdomain; there is no custom-domain option on free quick tunnels.
- **No SLA.** Cloudflare can rate-limit or change the free quick-tunnel service at any time. If first-run setup fails intermittently, devhop retries once automatically before giving up.
- **Blocked domains.** Some corporate networks and security tools block `*.trycloudflare.com`, because free tunnel domains get abused for phishing. If the phone shows a block page, try cellular.

## License

MIT © [Noor Latif](https://github.com/noor-latif) · [Fullstacked](https://fullstacked.se)

More tools from [Fullstacked Labs](https://github.com/fullstacked-labs).
