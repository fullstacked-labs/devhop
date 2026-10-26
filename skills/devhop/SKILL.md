---
name: devhop
description: Open a local web dev server on a real phone over trusted HTTPS with working hot reload. Use when the user wants to preview or test their local site on an iPhone or Android, test microphone, camera, passkeys or WebCrypto on a phone, or hits Vite "Blocked request. This host is not allowed", Next.js "Blocked cross-origin request", or navigator.mediaDevices undefined on mobile.
license: MIT
---

# devhop

Install: copy this `skills/devhop/` folder into your agent's skills directory
(for example `~/.claude/skills/devhop/`).

devhop gives a local dev server a temporary public HTTPS URL (Cloudflare quick
tunnel) and proxies it so Next.js, Vite and similar dev servers treat the phone
as localhost. Hot reload, logins and redirects keep working, and HTTPS-only
browser APIs (microphone, camera, WebCrypto, passkeys, clipboard) are
available on the phone.

## When to use it

- The user wants to see their local app on their phone.
- The user is testing microphone, camera, passkeys, WebCrypto or PWA install on a phone.
- The user hits one of these on a phone or behind a tunnel:
  - Vite: `Blocked request. This host ("…") is not allowed.`
  - Next.js: `Blocked cross-origin request`, or hot reload silently stops
  - `navigator.mediaDevices` is undefined
- The dev server runs in Docker or WSL2 and is bound to `0.0.0.0`.

## Commands

```bash
npx devhop                          # auto-detect the dev server port
npx devhop 3000                     # explicit port
npx devhop http://localhost:5173    # or pass the URL the dev server printed
npx devhop https://localhost:8443   # HTTPS dev server (self-signed is fine)
npx devhop 3000 --json              # machine-readable output
npx devhop 3000 --no-qr             # no QR code
npx devhop 3000 --http2             # use when the tunnel fails on networks that block UDP/QUIC
```

## Instructions for agents

1. Make sure the dev server is running. If you know its port or URL, pass it
   exactly as the dev server printed it.
2. Run `npx devhop <port> --json` in the background. Stdout is one JSON object
   per line with an `event` field. Read lines until `event` is `"ready"`; it
   carries `url`, `inspectUrl`, `target`, `port`, `host` and `protocol`. Later
   lines can be `reconnecting` (the tunnel is retrying), `error` (`code` and
   `message`, followed by a non-zero exit) and `closed`.
3. Give the user the `url`. If they can see the terminal, tell them to scan
   the QR code there (run without `--json` for that). Keep it plain, for example:
   "Here's your phone preview link. It updates as I edit, and the mic and camera work."
4. On an `error` event, act on its `code`:
   - `NO_DEV_SERVER`: start the dev server, then pass its port.
   - `TUNNEL_START_FAILED` or `TUNNEL_EXITED`: retry once with `--http2`.
   - `INVALID_TARGET`: pass the URL exactly as the dev server printed it.
5. When the user is done, stop devhop with SIGINT (Ctrl+C). It shuts down
   cloudflared with it.

On-device debugging: `<url>/__devhop/inspect` shows the app in a frame with a
one-tap Eruda console.

## Safety

The URL is public while devhop runs: anyone who has it can reach the dev
server, and devhop's header rewriting bypasses the dev server's own
origin checks. Only expose dev servers, never anything with real user data,
and stop devhop when the user is finished.
