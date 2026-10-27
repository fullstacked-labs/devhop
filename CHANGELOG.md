# Changelog

## Unreleased

### Fixed
- The tunnel URL and edge location are recognised when cloudflared's output is split mid-line; before, devhop could stay connected without ever showing the URL.
- When a phone disconnects mid-response (SSE, HMR, a large download), devhop now closes its request to the dev server instead of leaving the stream open.
- A refused WebSocket upgrade now forwards the dev server's response body, not just its headers.
- A wrong target scheme now gets the promised hint: `https:` pointing at a plain-HTTP server suggests `http://`, and `http:` pointing at a TLS server suggests `https://`.
- IPv6 targets such as `[::1]:3000` connect; the brackets were being kept in the host name. `::` is treated like `0.0.0.0`.
- The cloudflared download gives up after 30 seconds without data and says what to check, instead of hanging.
- `--doctor` reports a missing `DEVHOP_CLOUDFLARED` path instead of saying cloudflared "isn't downloaded yet".
- Failing to delete an old cloudflared version no longer fails an install that succeeded.
- The README demo images load on the npm page.

### Changed
- The README and `llms.txt` now say that upstream HTTPS certificates are not verified for any host, so self-signed certificates work; point devhop only at servers you trust.

### Removed
- The hidden `--gateway` transport. It was experimental, and its relay dropped
  request bodies and refused phone WebSocket upgrades (`REFACTOR.md` G1–G2).
  The code and tests are quarantined under `experimental/gateway/`; the flag now
  exits with a `GATEWAY_UNAVAILABLE` error.

## 0.2.0

### Breaking
- Requires Node.js 20 or newer.

### Added
- `--json` now emits structured events (`ready`, `reconnecting`, `error` with stable codes, `closed`) for agents and scripts. The existing `ready` fields are unchanged; it gains `inspectUrl` and `edgeReady`.
- `--doctor` prints paste-able diagnostics for bug reports (`--doctor --json` for a machine-readable version).
- Agent Skills `SKILL.md` at `skills/devhop/SKILL.md`.
- Dashboard warns that the tunnel URL is public.
- Nightly framework smoke matrix: Next.js 16, Vite, Nuxt, SvelteKit and Astro, plus a real-tunnel canary.

### Changed
- devhop waits until Cloudflare answers through the tunnel before showing the URL and QR code. A fresh quick tunnel can return HTTP 530 for several seconds, so a scan right away used to land on an error page. If Cloudflare still hasn't answered after 20 seconds, the URL is shown with a warning.
- cloudflared is pinned and its SHA-256 is checked on download, and the `cloudflared` npm dependency is gone (no install scripts). `DEVHOP_CLOUDFLARED` points at your own binary.
- Auto-detect checks port 4200 (Angular) and no longer checks 30178.

### Fixed
- The "Quick-tunnel setup failed — retrying once" message now prints instead of the generic reconnect message.

### Removed
- Keyboard shortcuts and clipboard copy.
