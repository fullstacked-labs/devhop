# Framework smoke tests

Each fixture is a minimal app. `run.js` starts its dev server and checks it twice with
the headers cloudflared delivers (`Host`, `Origin`, `Referer` on a `*.trycloudflare.com`
name): straight to the dev server, then through devhop's proxy.

```bash
cd smoke/fixtures/vite-react && npm install   # one-time; the stub fixture needs no install
node smoke/run.js vite-react                  # from the repo root
```

Results land in `smoke-results/<fixture>.json`. Exit code 0 means every proxied check passed
and at least one direct check failed.

| Check | Passes when |
| --- | --- |
| `page` | `GET /` returns 200 and no "not allowed" / "Blocked request" text |
| `hmr` | the HMR WebSocket upgrade returns `101` |
| `update` | (proxied only) editing the source file sends a message matching `updatePattern` within 30 s |

`smoke.json` may list `warm` paths: requested once before the edit, so Vite has served the module that changes.

The control: if both direct checks pass, the framework does not need devhop and the claim
would be false, so the run fails. `"updatePatternVerified": false` in a `smoke.json` means
the pattern has not been confirmed against a real run yet.

## Canary

`node smoke/canary.js` runs the real thing end to end: it starts the stub server, runs
`bin/devhop.js <port> --json`, waits for the `ready` event, fetches the public URL and the
inspector page through a live trycloudflare tunnel, then sends SIGINT and expects `closed`.
It needs network access.

trycloudflare has no SLA, so one red night is noise and two in a row are a signal. Don't make the
canary a required check.
