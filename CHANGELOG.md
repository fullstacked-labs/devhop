# Changelog

## Unreleased

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
