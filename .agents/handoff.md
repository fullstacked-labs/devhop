# Session Handoff — 2026-09-22

## Completed Work
- [x] Ponytail over-engineering audit of devhop (6 findings, all applied), committed at `4fc378e`
- [x] Cut library export surface, SSE header, airport map, `--protocol` flag, unused `child` field; VERSION now read from package.json
- [x] 0.1.5 published to npm
- [x] Single-keypress shortcuts implemented (raw keypress via readline emitKeypressEvents in `src/cli.js` setupShortcuts); tests rewritten in `test/clipboard.test.js`; 27/27 green — uncommitted, awaiting user verification
- [x] iPhone smoke test — done (previously gated the Show HN post)

## Current State & Verification
- **Branch / Commit:** `main` at `3d6274a`, in sync with origin/main
- **Working Tree:** dirty — uncommitted single-keypress shortcut changes (`src/cli.js`, `test/clipboard.test.js`)
- **Tests & Build:** passing — `npm test` 27/27 (no build step for this CLI)

## Immediate Next Steps (Actionable)
1. **Get user verification of the single-keypress shortcuts** — uncommitted working-tree changes implementing raw keypress handling (`src/cli.js` setupShortcuts, tests rewritten in `test/clipboard.test.js`, 27/27 green). Commit only after Noor verifies the behavior interactively.
2. Pushing to main (fullstacked-labs/devhop, Noor's own company) is approved practice — commit and push on request.

## Known Traps & Gotchas
- RELEASE POLICY: never `npm publish` without an explicit yes from Noor in the same turn; batch changes to avoid version churn.
- setupShortcuts uses stdin raw mode (user-requested no-Enter shortcuts). research/FEATURE_EVALUATION.md originally banned raw mode for 4 reasons; mitigations: non-TTY/CI/--json guards, explicit Ctrl+C handling, setRawMode(false) on close. Remaining unmitigated: backgrounded devhop (`devhop &`) with TTY stdin can hit SIGTTIN suspension.
- No SSE on Cloudflare quick tunnels (buffered/dropped); HMR WebSockets fine. 200 concurrent in-flight request cap → 429 under HMR bursts.
- Next.js Server Actions need BOTH `Location` and `x-action-redirect` rewritten (`src/proxy.js`).
- cloudflared needs `--no-autoupdate`; quick-tunnel creation fails intermittently → startTunnel retries once (MAX_ATTEMPTS=2).
- `bin/devhop.js` imports `../src/cli.js` directly — there is deliberately no library entry point anymore; tests import src modules directly.
- Ports on this machine: don't grab 6768/8081/4321/30178/8123/8124 for ad-hoc tests (used by other workspace projects).
