# Session Handoff — 2026-09-20

## Completed Work (this session)
- [x] Second-opinion review (independent reviewer + 2026 web research) folded into the release.
- [x] `src/tunnel.js`: automatic one-retry with 2s backoff when `cloudflared` exits before a URL is found (`MAX_ATTEMPTS = 2`, `onRetry` callback wired into CLI output). Edge-location dedup moved outside the per-attempt scope so retries don't re-emit the same location.
- [x] New regression test: "Tunnel retries once with backoff when cloudflared exits before a URL is found" (stub binary fails once, succeeds on second run).
- [x] README: added **Security & exposure** (public-internet reachability, masquerading bypasses dev-mode origin/CSRF checks) and **Limitations** (no SSE on quick tunnels, 200 concurrent in-flight request cap → 429, ephemeral URLs, no SLA, ToS = testing/dev only) sections; added "First-run reliability" row to competitor table.
- [x] `research/DEEP_RESEARCH.md`: expanded First-Comment FAQ with respectful untun answer (no header rewriting, `/tmp` eviction, auto-update crash), privacy/exposure disclosure, and Cloudflare-dependency answer (upgrade path: `--domain` named subdomains).
- [x] `.gitignore`: `.serena/` and `.agents/` ignored; untracked from working copy.
- [x] CI: `.github/workflows/test.yml` — `node --test` matrix on Node 18/20/22.
- [x] Version 0.1.3 bumped in **both** `package.json` and `src/cli.js` (`VERSION` const) — verified `./bin/devhop.js --version` → `v0.1.3`.
- [x] 26/26 tests passing.
- [x] End-to-end smoke test: real tunnel against a local HTTP server; public trycloudflare URL returned 200 with backend content; `/__devhop/inspect` served through the edge (Eruda page).
- [x] npm auth restored via `NPM_TOKEN` (stored with `secret` CLI, wired into `~/.npmrc`).
- [x] **Published `devhop@0.1.3`** and verified on the registry (`npm view devhop dist-tags.latest` → `0.1.3`; tarball downloaded, version + bin verified). Note: registry metadata can lag ~1 min after publish — verify with that in mind.
- [x] Committed as `1b2a8def` "feat: upstream HTTPS targets, interactive shortcuts, clipboard copy, and mobile inspector".

## Prior Work (sessions up to 2026-09-11, all in 0.1.2)
- Header masquerade (Host/Origin/Referer/`x-action-redirect`), `Connection: close` anti-smuggling, `--json` flag, `--http2`, ring-buffer diagnostics, edge location, `--no-autoupdate`, SSE unbuffering, dev-server-restart 502 resilience. (Earlier handoff claimed a 0.1.3 publish that never happened — only 0.1.0/0.1.2 existed. Trust the registry, not notes.)

## Current State
- Branch/commit: `main` at `1b2a8def` (local; not yet pushed to origin).
- Working tree: clean.
- Tests: 26/26 passing (`npm test`, `node --test`).
- npm: `devhop@0.1.3` live, tag `latest`, maintainer `noorlatif`.

## Immediate Next Steps
1. **Push**: `git push origin main` (user's call — not done automatically).
2. **Physical mobile device smoke test** — `npx devhop 30178` against ompweb on a real iPhone; verify speech dictation (`/api/stt`). **This gates the Show HN launch.**
3. **Show HN launch** — follow `research/DEEP_RESEARCH.md` §Vector 4: headline `Show HN: devhop – Zero-config HTTPS tunnels for mobile testing with Secure Context and zero accounts`; post a QR-scan-to-working-microphone video; author's first comment must pre-answer ngrok, mkcert, **untun**, privacy/exposure, and Cloudflare-dependency questions (all drafted in the research doc).
4. **Feature watch** — named subdomains via Cloudflare Tunnel credentials (`--domain <name>.latif.se`) is the most-requested likely feature; custom target headers second.

## Known Traps & Gotchas
- **Quick tunnels do not support SSE** (Cloudflare limitation). Don't market SSE/streaming reliability; WebSockets (HMR) work fine.
- **200 in-flight request cap** on free quick tunnels returns 429 under HMR bursts.
- **Next.js Server Actions**: rewrite both `Location` and `x-action-redirect`; Next 14–16 doesn't use standard redirects there.
- **cloudflared auto-update**: without `--no-autoupdate` the process self-terminates on launch.
- **Quick-tunnel first-run flakiness**: intermittent "failed to request quick tunnel" is normal; devhop now retries once automatically.
- **undici/native fetch** throws `UND_ERR_INVALID_ARG` on manual `transfer-encoding: chunked`; use `http.request` in tests.
- **npm auth**: token stored as `NPM_TOKEN` via the `secret` CLI; if publish 401s, check `secret check NPM_TOKEN` and `npm whoami`.
- **Version is duplicated**: `package.json` and `src/cli.js` `VERSION` const must both be bumped.
