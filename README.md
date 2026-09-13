# 🦘 devhop

[![npm version](https://img.shields.io/npm/v/devhop.svg)](https://www.npmjs.com/package/devhop)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Built for AI Agents](https://img.shields.io/badge/AI%20Agent-Skill%20Ready-purple.svg)](./skill.md)

> **Hop your local web dev server onto your phone in seconds. Live updates as you edit code, real HTTPS for camera and microphone access, and zero configuration.**

```bash
npx devhop [port]
```

```text
 🦘 DEVHOP 

  Target:       http://localhost:3000
  Mobile URL:   https://breeze-sunset-vintage-glade.trycloudflare.com

  ✔ Live updates on save active (phone refreshes automatically as you edit)
  ✔ Real HTTPS padlock active (microphone, camera & voice dictation work)
  ✔ Next.js & Vite safe (no "host not allowed" or blocked request errors)
  ✔ Zero setup (no accounts, no tokens, no certificates to install)

  Scan with your iPhone or Android camera:
  [ QR Code ]

  Press Ctrl+C to stop the tunnel and disconnect.
```

---

## Why testing on your phone is so frustrating

If you have ever tried opening your local Next.js, Vite, Remix, or Astro site on a real iPhone or Android phone, you have probably run into one of these headaches:

### 1. Your phone doesn't update when you save code (or gets blocked completely)
Normally, when you edit code on your laptop, your browser updates automatically without losing your place (often called Fast Refresh or Hot Reload).

But if you try opening your dev server on your phone through normal tunnels or your local Wi-Fi IP, Next.js and Vite block the connection for security. You end up with a red error screen:
```text
Blocked cross-origin request to Next.js dev resource...
To allow this host in development, add it to "allowedDevOrigins" in next.config.js
```
Or Vite shows:
```text
Blocked request. This host is not allowed.
```
Or Next.js Server Actions crash when submitting a form:
```text
Error: Invalid Server Actions request.
```
Editing config files or whitelisting temporary URLs breaks git branches, messes up your teammates, and stops working the moment you switch Wi-Fi networks.

### 2. Your phone's camera, microphone, and voice dictation refuse to work
Mobile Safari (iPhone) and Chrome (Android) have a strict security rule: **they refuse to turn on your microphone or camera unless the website has a real, trusted HTTPS padlock.**

If you load your site using your Wi-Fi address (like `http://192.168.1.50:3000`), the phone treats it as an untrusted site:
* `navigator.mediaDevices.getUserMedia` is `undefined`.
* Speech-to-Text, voice dictation, and camera features crash instantly.
* WebCrypto (token signing) and FaceID/TouchID (Passkeys) are disabled.

Setting up self-signed certificates (`mkcert`) on an iPhone requires emailing certificate files to yourself, installing an iOS Configuration Profile, and digging through *Settings > General > About > Certificate Trust Settings*. Over 90% of developers give up.

### 3. Cafe and office Wi-Fi blocks your phone from seeing your laptop
In coffee shops, airports, and offices, routers turn on "Client Isolation" for guest security. That means your phone and your laptop are forbidden from talking to each other directly, even on the same Wi-Fi.

---

## How devhop makes it work

`devhop` connects your phone to your laptop through an instant, outgoing tunnel and quietly adjusts the request labels along the way:

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

---

## Comparison: Why devhop feels different

| Feature | **devhop** | **ngrok** | **unjs/untun** | **LocalCan** | **mkcert** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Command** | `npx devhop` | Download CLI + login | `npx untun` | $57 Mac App | Brew install |
| **Account or Signup?** | **None** | Required | None | License key | None |
| **Real HTTPS Padlock?** | **Yes** | Yes | Yes | Yes (local only) | Manual iOS Profile |
| **Live Updates on Save (Next/Vite)**| **Yes** | ❌ Blocks connection | ❌ Blocks connection | ❌ Blocks connection | ⚠️ Wi-Fi IP mismatch |
| **Next.js Server Actions Safe?** | **Yes** | ❌ 500 CSRF abort | ❌ 500 CSRF abort | ❌ 500 CSRF abort | ⚠️ Protocol mismatch |
| **Vite 6 `allowedHosts` Safe?** | **Yes** | ❌ 403 Forbidden | ❌ 403 Forbidden | ❌ 403 Forbidden | ⚠️ Host mismatch |
| **Terminal QR Code** | **Yes** (Compact) | ❌ Link only | ❌ Link only | ❌ App UI only | ❌ None |
| **First-run reliability** | **Yes** (cached binary, auto-retry, `--no-autoupdate`) | — | ⚠️ Auto-update crash & `/tmp` eviction reported | — | — |
| **Price** | **100% Free (MIT)** | $8+/mo after 1GB | Free | $57 one-time | Free |

---

## What features unlock on your phone?

Because `devhop` provides a genuine HTTPS connection, modern mobile Web APIs work on your real device on the first try:

| Feature | Using Wi-Fi IP (`http://192.168.x.x`) | Using `npx devhop` | What you can test |
| :--- | :---: | :---: | :--- |
| **Microphone (`getUserMedia`)** | ❌ Blocked | ✅ **Works** | Speech-to-Text dictation, voice notes, audio recorders |
| **Camera (`getUserMedia`)** | ❌ Blocked | ✅ **Works** | QR/barcode scanning, photo uploads, video capture |
| **FaceID / TouchID (Passkeys)** | ❌ Blocked | ✅ **Works** | Biometric login flows |
| **WebCrypto (`crypto.subtle`)** | ❌ Blocked | ✅ **Works** | Client-side encryption and JWT auth tokens |
| **1-Click Copy (`navigator.clipboard`)** | ❌ Blocked | ✅ **Works** | Copy-to-clipboard buttons |
| **"Add to Home Screen" (PWA)** | ❌ Blocked | ✅ **Works** | Testing full-screen PWA installs on iOS |

---

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
npx devhop [target] --copy   Copy the tunnel URL to the clipboard when the tunnel is ready
npx devhop [target] --http2  Route tunnel over HTTP/2 (corporate firewall bypass)
npx devhop --help            Show help message
npx devhop --version         Show version
```

### Keyboard shortcuts and clipboard

In an interactive terminal, type a shortcut followed by **Enter**:

| Shortcut | Action |
| --- | --- |
| `c` + Enter | Copy the tunnel URL to your clipboard |
| `o` + Enter | Open the tunnel URL in your desktop browser |
| `q` + Enter | Quit and disconnect the tunnel (same cleanup as Ctrl+C) |
| `h` + Enter | Show shortcut help |

Your clipboard is untouched on startup unless you opt in with `npx devhop 3000 --copy`.
Copying tries terminal clipboard support (OSC 52, including tmux/SSH), then an available native clipboard tool.
Shortcuts and clipboard copying are disabled with piped stdin, in CI, and with `--json`.

### Mobile inspector

Open `https://<tunnel>/__devhop/inspect` on your phone for an app preview iframe, a one-tap Eruda bookmarklet, and bundler recipes for Vite and Next.js. The inspector leaves your app HTML untouched.

### Corporate firewall bypass

On office or cafe networks where UDP/QUIC is blocked, `cloudflared` may fail to connect. Force the tunnel over TCP port 443 instead:

```bash
npx devhop 3000 --http2
```

### Security & exposure

Read this before running devhop:

- **Your dev server is reachable from the public internet** for as long as the tunnel runs. Anyone with the URL can hit it. Close the tunnel (Ctrl+C / `q`) when you step away.
- **Header masquerading is intentional.** devhop rewrites `Host`, `Origin`, and `Referer` so your dev server treats the phone as trusted loopback — which also means dev-mode origin and CSRF protections (Next.js `allowedDevOrigins`, Vite `allowedHosts`) are bypassed for everyone, not just your phone.
- Run only dev servers you're actively working on. Never point devhop at anything containing real credentials or user data.

### Limitations

devhop rides Cloudflare's free quick tunnels (`trycloudflare.com`), which Cloudflare explicitly labels *testing and development only*:

- **No SSE.** Quick tunnels buffer or drop Server-Sent Events, so token-streaming endpoints will misbehave. HMR (WebSockets) works fine.
- **200 concurrent in-flight requests.** Heavy HMR bursts or many simultaneous devices can hit Cloudflare's request cap and return `429`.
- **Ephemeral URLs.** Every run gets a new random subdomain; there is no custom-domain option on free quick tunnels.
- **No SLA.** Cloudflare can rate-limit or change the free quick-tunnel service at any time. If first-run setup fails intermittently, devhop retries once automatically before giving up.

---

## AI Agent Integration

`devhop` is designed so AI coding assistants (Claude Code, Cursor, Windsurf, OMP) can launch and manage mobile previews for you:
* **`skill.md`**: Follows the Agent Skills standard so coding agents know when and how to test your app on mobile.
* **`llms.txt`**: Machine-readable reference for LLM tools.
* **`--json` Flag**: Run `npx devhop 3000 --json` for structured, non-interactive output:
  ```json
  {"url":"https://example.trycloudflare.com","target":"http://127.0.0.1:3000","port":3000,"host":"127.0.0.1","protocol":"http:"}
  ```

---

## License

MIT © [Noor Latif](https://github.com/noor-latif) · [Fullstacked](https://fullstacked.se)
