# AGENTS.md — devhop

devhop is a zero-config CLI (`npx devhop`) that puts a local web dev server on
a phone: a Cloudflare quick tunnel for trusted HTTPS, plus a small Node proxy
that rewrites Host/Origin/Referer so dev servers treat the phone as localhost.

## Layout

- `bin/devhop.js`: entry point; calls `run()` in `src/cli.js`.
- `src/cli.js`: argument parsing, dashboard, lifecycle and cleanup.
- `src/proxy.js`: the masquerade proxy (stdlib `http`/`https`/`net`/`tls` only).
- `src/tunnel.js`: caches and runs `cloudflared`.
- `src/cloudflared.js`: downloads the pinned cloudflared release and checks
  its SHA-256. Bump the pin with `node scripts/bump-cloudflared.js [version]`.
- `src/doctor.js`: `--doctor` diagnostics.
- `src/port.js`: target parsing and dev-port detection.
- `experimental/gateway/`: the self-hosted relay transport, quarantined. It is
  not wired into the CLI and not published; fix [`REFACTOR.md`](./REFACTOR.md)
  G1–G2 before moving it back to `src/`. Revival steps: Phase 5.
- `test/`: `node:test` suites; `npm test` runs every `*.test.js` in the repo,
  including the quarantined gateway tests under `experimental/gateway/test/`.
- `smoke/`: framework smoke matrix (`node smoke/run.js <fixture>`) and the
  real-tunnel canary; see `smoke/README.md`. Not part of `npm test`.
- `scripts/`: release helpers (`release-notes.js`, `bump-cloudflared.js`).
- [`REFACTOR.md`](./REFACTOR.md): audited defects and the refactor plan. Read it
  before structural work; remove an item when its fix lands.
- `skills/devhop/SKILL.md`, `llms.txt`: docs for coding agents. Keep them in
  sync with the CLI. The `--json` events and error codes are public API: add
  fields, don't rename or remove them.

## Commands

```bash
npm test                          # all tests, ~12 s
node bin/devhop.js --help
node bin/devhop.js 3000 --json    # real tunnel; needs network
```

## Rules

- Node ≥ 20, ESM, `node:` imports, 2-space indent, single quotes.
- Runtime dependencies stay at two (`picocolors`, `qrcode-terminal`).
  Adding one needs a reason the stdlib can't cover, and no dependency may
  have an install script.
- Tests bind port 0 or `findFreePort()`, never a fixed port.
- Conventional Commits (`feat(cli): …`, `fix(proxy): …`), one logical change
  per commit. No AI attribution trailers.
- Releases go out only through the tag workflow. Never run `npm publish` by hand.

## Writing style (code, comments, docs, terminal output)

devhop has to read as written by someone who cares. Specifically:

- A comment explains *why*. Don't narrate what the next line does, number
  steps, or cite design docs, requirement IDs (`R12`, `§5`) or files readers
  can't open.
- No absolutes ("guarantees", "zero", "completely", "never fails") unless a
  test proves them. No statistics without a link.
- Terminal output is facts and next steps: the URL, the target, warnings, and
  errors that say what to try. No feature lists or self-praise on screen.
- Error messages name the problem and the fix, with a runnable example.
- The smallest diff that does the job. No new helpers, flags, files or
  abstractions a task didn't ask for, and no drive-by reformatting.
- README claims must be backed by a test or the smoke matrix. Competitors are
  described accurately ("needs config"), not as broken.

## Behaviour that looks simplifiable but isn't

- `src/proxy.js` WebSocket upgrades: the raw socket replay waits for the
  upstream status line before piping. A non-101 is forwarded and closed.
- `experimental/gateway/src/relay.js`: after Host routing, the ingress socket
  is detached from Node's HTTP parser, which would otherwise swallow bytes
  pipelined behind an upgrade request.
- Upgraded client sockets emit `'end'` on FIN as well as `'close'`; teardown
  listens to both or a half-closed peer leaks a binding.
- `src/tunnel.js` retries quick-tunnel creation once: first-run failures are
  common and transient.
- `smoke/run.js` fails a fixture whose direct checks both pass. That is the
  control: if the framework works without devhop, the README claim is false.
  Drop the framework from the claims instead of loosening the verdict.
