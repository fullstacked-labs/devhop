# Refactor notes

Audit of devhop 0.2.0 on 2026-10-27. The gateway quarantine (Phase 5), the bug
fixes (B1, B3–B6, B8, B9, B11, B12, B16) and the CLI work (B2, B10, B13, plus
the `src/args.js` and `src/ui.js` split) landed the same day, for release as
0.3.0, and were removed from this file; B7 is obsolete, B14 was disproved and B15 was
dropped (see the notes at the bottom). The rest is open. This is a backlog for structural work,
not a changelog. The IDs (`B1`, `G3`, `S1`) are for commit messages and issues;
the `D`/`S`/`A` items are code quality, not behaviour.

`npm test` is 123/123 green, so every item below is outside the current suite.
"Reproduced" means a throwaway script showed the behaviour;
"inspection" means the code path is clear but no test covers it yet. Remove an
item once its fix lands, or mark it done with a link to the commit.

## Summary

### Shipping path

No open items. B1–B16 are fixed, decided or dropped; the notes at the bottom
record what was learned.

### Gateway (quarantined)

| ID | Area | Severity | State |
| --- | --- | --- | --- |
| G1 | `relay.js` loses POST/PUT bodies | critical for gateway | reproduced |
| G2 | `relay.js` refuses phone-side WebSocket upgrades | critical for gateway | reproduced |
| G3 | `relay.js` governor socket counter goes negative | high | reproduced |
| G4 | `relay.js` second REGISTER leaves a stale binding | high | reproduced |
| G5 | `relay.js` never sweeps expired grace bindings | high | inspection |
| G6 | `relay.js` detached ingress sockets can crash the process | high | inspection |
| G7 | `relay.js` idle reaper only counts phone-to-relay bytes | medium | inspection |
| G8 | `relay.js` has no backpressure toward the phone | medium | inspection |
| G9 | `relay.js` does not bounds-check the REGISTER token length | low | inspection |
| G10 | both gateway sides have WS framing gaps | low | inspection |

Quarantined on 2026-10-27: `--gateway` is rejected with `GATEWAY_UNAVAILABLE`,
and the modules and tests live under `experimental/gateway/`. The items below
stay as research debt until someone revives the transport; they are not on the
shipping path.

### Code quality

| ID | Group | Severity | State |
| --- | --- | --- | --- |
| D1–D5 | dead code and unused surface | low | inspected |
| S1–S6 | spaghetti and hidden ownership | medium | inspected |
| A1–A8 | generated-looking patterns | low–medium | inspected |

The short version: the shipping path is not buried in dead code, but it has a
clear generated-code texture. The expensive parts are `run()` and
`startGateway()` (single functions that own whole state machines), the gateway's
five hand-written WebSocket parsers, and tests that assert the implementation or
quietly tolerate the bugs above. The dead code is small but real. None of these
items change runtime behaviour by itself; they are what makes the behaviour
fixes expensive to review.

## Gateway (quarantined)

The transport is out of the CLI and lives under `experimental/gateway/`, so
these are research debt rather than shipping bugs. G1/G2 must be fixed before it
returns: they break HMR and normal form submissions. Paths below refer to the
quarantined copy (`experimental/gateway/src/`).

### G1 — POST/PUT bodies are lost

**Where:** `src/gateway/relay.js:389-423`

After Host routing, the relay detaches the socket from Node's HTTP parser and
rebuilds only the request head (`#rawHead`). Node may already have buffered
part of the body into `req`, and those bytes are never flushed into the OPEN
stream. The dev server then waits for a Content-Length that never arrives.

**Repro:** a phone `POST` with `Content-Length: 5` and `hello` in the same
write timed out; the mock dev server never saw the body.

**Fix:** flush any bytes already buffered on `req` (`req.read()`) into the raw
stream before or after OPEN, or route ingress through a path that never lets
Node parse the body. Add a body round-trip test for small and chunked bodies.

### G2 — phone-side WebSocket upgrades are refused

**Where:** `src/gateway/relay.js:175-192`

Every upgrade that is not `/_gateway/register` gets `404 Not Found`. HMR
WebSockets from Vite and Next.js cannot work through the gateway.

**Repro:** a phone upgrade to an existing binding returned
`HTTP/1.1 404 Not Found`.

**Fix:** treat an ingress upgrade as a normal stream: send OPEN with the
upgrade head and pump bytes both ways until either side closes. Keep the 404
only for an unknown path with no binding.

**Test:** an HMR-style upgrade through the relay reaches the dev server and
returns 101, then carries a message in each direction.

### G3 — the governor socket counter goes negative

**Where:** `src/gateway/relay.js:114-117`, `src/gateway/relay.js:396-403`

The connection-level `close` listener is deliberately kept when the ingress
socket is detached, then `#serveIngress` adds a second `close` listener that
decrements `#sockets` again. Every ingress request lowers the count by two for
one connection.

**Repro:** `relay.health.sockets` was `-1` after one 503 ingress request. After
enough requests the fd ceiling check is effectively disabled.

**Fix:** remove the extra decrement in `#serveIngress`; the connection-level
listener already owns the count. Add a test that asserts the count returns to
exactly the baseline, not `<= baseline`.

### G4 — a second REGISTER leaves a stale binding

**Where:** `src/gateway/relay.js:264-385`

The binding object is keyed into `#bindings` only after the first REGISTER. A
second REGISTER with a different token adds a new key while the old key still
points at the same object, whose `.sub` has moved to the new key. Cleanup only
graces the current `binding.sub`.

**Repro:** `health.tunnels` went from 1 to 2 on a single socket after a second
REGISTER with a different token; the old map key remained after disconnect.

**Fix:** reject a second REGISTER on a registered binding, or delete the old
key before adding the new one. Test one socket cannot own two subs.

### G5 — expired grace bindings are never swept

**Where:** `src/gateway/relay.js:208-223`

A disconnect sets `graceUntil` and nothing removes the entry after the window.
`#bindings` grows for every tunnel ever started, and old subs stay reserved.

**Fix:** schedule a delete at `graceUntil`, or sweep expired entries from
`#pingClients`/health. Make the sweep safe against a reclaim racing it.

**Test:** disconnect, wait past grace, reconnect with a different token that
hashes to the same base sub; it must not get a suffix from the stale entry.

### G6 — detached ingress sockets can crash the relay

**Where:** `src/gateway/relay.js:396-420`

`#serveIngress` removes every socket listener except `close`, including
`error`. The parked and 503 paths add no error listener of their own, so a
phone RST can emit an unhandled `'error'` and take down the relay process.

**Fix:** attach one shared `error` handler whenever the socket is detached
from the HTTP parser, including parked and raw-503 paths.

**Test:** reset a parked connection and a raw-503 connection; the relay stays up.

### G7 — the idle reaper only counts phone-to-relay bytes

**Where:** `src/gateway/relay.js:464-475`

`idleTimer.refresh()` runs only in the ingress socket's `data` listener. A long
download, SSE stream, or (once G2 is fixed) a quiet WebSocket with server
traffic is destroyed after `ingressIdle` (60 s) even though the server is
sending.

**Fix:** refresh the idle deadline on both directions, or track last activity
per stream in the binding and let either side reset it.

**Test:** stream server-to-phone data for longer than the idle window with no
phone bytes; the stream must stay open.

### G8 — no backpressure toward the phone

**Where:** `src/gateway/relay.js:274-278`

`#onClientFrame` calls `sock.write(payload)` and ignores the return value. A
fast dev server and a slow phone can grow the ingress socket buffer without
bound.

**Fix:** mirror the client's aggregate high-water logic: pause the WS read side
or queue per stream when the ingress socket is over its mark, and resume on
`drain`.

**Test:** a slow phone reader plus a fast server keeps memory bounded and
eventually delivers every byte in order.

### G9 — REGISTER token length is not bounds-checked

**Where:** `src/gateway/relay.js:306-320`

A `tokenLen` larger than the remaining payload silently truncates. Malformed
input should get a protocol error, not a token derived from whatever bytes were
present.

**Fix:** require `payload.length >= 3 + tokenLen` before reading the token and
reply with a malformed-REGISTER error.

**Test:** a REGISTER whose token length exceeds the payload is rejected.

### G10 — WS framing gaps

**Where:** `src/gateway/client.js:41-85`, `src/gateway/relay.js:33-78`

Both sides hand-roll WS framing and ignore RSV, FIN/continuation, and the
advertised length cap. A hostile peer can make the other side buffer a very
large message.

**Fix:** extract one `src/gateway/ws.js` codec with explicit limits, and use it
from both sides. This also removes the duplicated encode/parse code that makes
gateway changes expensive to review.

**Test:** fragmented frames, RSV bits, oversized lengths, and a masked server
frame are all rejected.

## Code quality: dead code, spaghetti, generated-looking patterns

The items are grouped by what a contributor actually has to do: delete something
(`D`), move a boundary (`S`), or stop trusting prose and tests (`A`). None are
runtime bugs; B/G already cover those. Fix them with the file they touch rather
than as a standalone cleanup branch. Paths under `src/gateway/` and
`test/gateway/` moved to `experimental/gateway/` with the quarantine.

### Dead code and unused surface

#### D1 — `Relay` keeps a dead `#opts` field

**Where:** `src/gateway/relay.js:87,110`

`#opts = { maxFds }` is assigned in the constructor and never read. `maxFds` is
already consumed once to compute `governorCeiling`. Remove the field and the
assignment; keep `maxFds` in the local parameter.

**Test:** none needed; the constructor and governor tests already cover the
value.

#### D2 — `socket.binding` is never read

**Where:** `src/gateway/relay.js:206`

The comment says it is reachable from ingress teardown, but every teardown path
closes over `binding` or reads `#bindings`. The property is dead and adds a
second, mutable name for the same object. Remove it, or use it as the single
owner in `#serveIngress`; don't leave both.

**Test:** an ingress socket must not outlive its binding (assert binding and
stream cleanup after client close).

#### D3 — unused test helper and imports

**Where:** `test/gateway/relay.test.js:187-192`; `test/gateway/client.test.js:9,12`;
`test/proxy.test.js:423-427,463-467,490-494`

`registerPayload()` in relay.test.js is never called; `MockClient.register()`
rebuilds the same bytes inline at line 128. `net` and `FrameDecoder` are
imported but unused in client.test.js. proxy.test.js dynamically re-imports
`startTunnel`, `fs`, `os`, and `path` in four tests although all four are
imported at the top.

**Fix:** delete `registerPayload` or call it from `register`; delete the unused
imports; use the top-level imports.

**Test:** `node --test` is unchanged; this is a readability change.

#### D4 — exports that only exist for imaginary tests

**Where:** `src/gateway/client.js:29-34`; `src/cli.js:13`;
`src/gateway/frames.js:87-102`

`backoffDelay` is exported with a comment saying tests assert the sequence
directly, but no test imports it; the backoff test observes `onRetry` instead.
`printHelp` is exported but only called inside `cli.js`. `decodeFrames` is a
one-shot decoder used only by the frame tests; production uses `FrameDecoder`.

**Fix:** unexport `backoffDelay` and `printHelp`; either keep `decodeFrames` as
a documented codec API and test it as such, or move it to the test helper.
Comments should describe the actual contract.

**Test:** if `decodeFrames` stays public, the parser-limit tests in
frames.test.js already cover it; add an import check if the export is meant for
consumers.

#### D5 — binding shape is assembled ad hoc

**Where:** `src/gateway/relay.js:202,453-454`;
`test/gateway/client.test.js:23,76,82`

`nextStreamId` is not in the binding literal; it appears on first ingress.
`relay.httpSrv` is not a `Relay` property; the test invents it after `listen()`
because it needs the server later. Both make the object shape depend on call
order and test knowledge.

**Fix:** declare `nextStreamId: 1` in the binding literal; keep the HTTP server
in a test variable (`const httpServer = relay.listen(...)`) instead of mutating
the relay.

**Test:** existing gateway tests; no new behaviour.

### Spaghetti and hidden ownership

#### S1 — `startGateway()` is a 297-line function

**Where:** `src/gateway/client.js:87-383`

One function owns dialing, reconnection and backoff, WS handshake validation,
WS frame parsing, codec dispatch, stream creation, local socket lifecycle,
backpressure, registration payloads, and callbacks. Seven nested functions share
eight mutable locals (`socket`, `req`, `carry`, `decoder`, `closed`, `dead`,
`attempt`, `retryTimer`). There is no state object to inspect in a failure.

**Fix:** extract a `GatewayConnection` (dial/handshake/backoff), a `StreamTable`
(OPEN/DATA/CLOSE, pending bytes), and a pure `registerPayload()`. Inject the
transport and timers so the cable-pull test does not need `destroyForTest`.

**Test:** the existing integration tests keep working; add unit tests for
`StreamTable` and backoff without sockets.

#### S2 — `run()` still owns the whole lifecycle

**Where:** `src/cli.js:21-220`; `process.exit` at 18, 94, 146, 151, 163, 202, 216

Argument parsing (`src/args.js`), the help and dashboard (`src/ui.js`) and the
validation errors (`fail()`) moved out. `run()` still owns auto-detection,
binary install, proxy creation, listen, signal handlers, cleanup, and the
tunnel wiring. The remaining exits are the signal handler, the uncaught-error
handler and the tunnel callbacks; each needs cleanup to run first, so they do
not fit `fail()`.

**Fix:** extract the lifecycle (proxy, tunnel, cleanup) into its own module
only if it becomes hard to change; otherwise leave it.

#### S3 — `#handleRegister()` mixes six policies

**Where:** `src/gateway/relay.js:289-385`

The method checks the governor, parses the version, rejects short payloads,
invents an empty-token fallback, enforces the per-IP cap, derives and
collision-resolves the sub, reclaims old bindings, and replays parked sockets.
A 97-line method with a nested loop over `#bindings` is the reason G4/G5 were
easy to miss.

**Fix:** split `parseRegister`, `admitRegistration`, `allocateSub`, and
`replayParked`; make each take the binding and return a result. Keep the wire
replies in one place.

**Test:** table-driven register cases (bad version, short payload, token length,
IP cap, collision, reclaim).

#### S4 — `#serveIngress()` strips listeners from a live socket

**Where:** `src/gateway/relay.js:389-423`

It enumerates `socket.eventNames()`, removes every listener except `close`,
removes three `req` listeners, then adds another `close` listener that
decrements the governor counter. This is why G3 (double decrement) and G6
(unhandled error on detached paths) exist: the socket has no single owner. The
raw-503 and parked branches inherit whatever listener set the strip left.

**Fix:** take ownership before Node's parser runs, or wrap the detached socket
in one `IngressSocket` that owns the listener set and the counter exactly once.
Do not keep the old connection-level `close` listener as a special case.

**Test:** exact `relay.health.sockets` baseline after 503, parked, and normal
streams; RST each path and assert the relay stays up.

#### S5 — WebSocket framing is written five times

**Where:** `src/gateway/relay.js:33-78`; `src/gateway/client.js:41-85`;
`smoke/lib/ws.js:30-50`; `test/gateway/relay.test.js:79-120`;
`test/gateway/client.test.js:54-70`

Each copy handles a different subset of RFC 6455: server encode/client parse,
client encode/server parse, smoke decode, mock client encode and parse, fake
gateway parse and plain encode. Only the frame codec
(`src/gateway/frames.js`) is shared. This is the concrete duplication behind
G10.

**Fix:** one `src/gateway/ws.js` with `encode(opcode, payload, { mask })` and
`parse(buf, off, { expectMask })`, explicit max message size, and RSV/FIN
checks. Use it from relay, client, smoke, and both test harnesses.

**Test:** codec tests for fragmentation, RSV, masked/unmasked direction,
126/127 lengths, and oversize; gateway tests then exercise the same parser.

#### S6 — the tests mirror the implementation, not the modules

**Where:** `test/proxy.test.js` (600 lines), `test/gateway/relay.test.js` (461),
`test/gateway/client.test.js` (325), `test/gateway/cable-pull.test.js` (176)

`proxy.test.js` imports proxy, tunnel, port, and CLI, so a proxy failure and a
tunnel failure land in one file. The gateway tests each carry their own WS
client and socket helpers; two of them duplicate the masked-frame parser. Setup
boilerplate is repeated in almost every proxy test.

**Fix:** Phase 4. Split by module; share `test/helpers/{http,ws,tunnel}.js`.
Prefer `server.listen(0)` and return the assigned port over `findFreePort()`
plus a later bind.

**Test:** no change to assertions; the split is successful when each file
imports one production module and the suite is faster.

### Generated-looking patterns

These are not style preferences. They are places where the prose, the tests, or
the public surface promise more than the code does.

#### A1 — numbered step comments

**Where:** `src/proxy.js:93,100,105,110,115,128,133,138,144,152`;
`test/proxy.test.js:49,58,71,96,109,122,131,153,267,274,282`;
`test/gateway/cable-pull.test.js:114,117,121,131,136,151,166`

`// 1.`, `// 2.`, `// Test 1:`, and an out-of-order `2, 3, 4, 6, 5a, 5b, 5c`
sequence read like a generated plan left in the diff. `AGENTS.md` says a comment
explains why, and explicitly says not to number steps. They also go stale when a
step moves.

**Fix:** delete the numbers and keep only the non-obvious reason, or rename the
test so the step is the test name. Do not replace them with a longer prose
version of the same list.

**Test:** none; review the diff for comments that only restate the next line.

#### A2 — comments assert properties the code does not enforce

**Where:** `src/gateway/client.js:29-30`,
`src/gateway/relay.js:286`, `src/gateway/frames.js:11-12`,
`src/cloudflared.js:101`

- "exported so tests can assert the sequence directly" — no test imports
  `backoffDelay` (D4).
- "unknown-but-valid codec types can't occur" — `REGISTER_OK`, `REGISTER_ERR`,
  and `PONG` are valid codec types and can arrive from a client;
  `#onClientFrame` silently ignores them.
- "Decoder rejects a REGISTER whose version ≠ 1" — the relay deliberately builds
  `new FrameDecoder({ validateVersion: false })` at `relay.js:199` and answers
  with `REGISTER_ERR` itself.
- "a concurrent run never sees a half-written binary" — the extraction scratch
  directory is private, but two `ensureBinary` calls still race on the final
  `renameSync` and on the cache path.

**Fix:** make each comment match the enforced behaviour, or enforce it. Where a
claim is a security property, add the test before keeping the comment.

**Test:** one assertion per claim that stays; delete the rest.

#### A3 — global `uncaughtException` hides the stack

**Where:** `src/cli.js:176-181`; `bin/devhop.js:5-7`

The handler catches every uncaught error, including programmer errors and
third-party throws, logs only `err.message`, emits an `UNCAUGHT` event with only
the message, and exits. The default Node handler would print the stack.
`bin/devhop.js` has the same message-only behaviour for rejected `run()`
promises. A bug report from `--json` therefore loses the line numbers that
would identify it.

**Fix:** let Node print uncaught errors; use `uncaughtExceptionMonitor` only for
cleanup if cleanup must run. In `bin/devhop.js`, log `err.stack ?? err.message`.
If the JSON contract needs an `UNCAUGHT` event, include `stack` as an added
field.

**Test:** a child process that throws gets a stack in stderr.

#### A4 — test-only seams in the shipped API

**Where:** `src/gateway/client.js:92,371-381`;
`test/gateway/cable-pull.test.js:119`; `test/gateway/client.test.js:23`

`destroyForTest()` is a public method on the production handle, with a comment
telling callers not to use it. `backoffBaseMs` is a production option that
exists only to make tests fast. `relay.httpSrv` is an undeclared property the
test adds to the relay. These are not test hooks; they are unowned API surface.

**Fix:** inject a transport/clock (`connect`, `now`, `setTimeout`) into
`startGateway`, and inject a fake that can RST. For the relay, return the HTTP
server from `listen()` and keep it in the test. The production object then has
one shape.

**Test:** cable-pull uses the injected transport; no `destroyForTest` or
`httpSrv` remains.

#### A5 — tests that can pass while the bug is present

**Where:** `test/gateway/relay.test.js:457`; `test/proxy.test.js:448-460,574-577`;
`test/gateway/cable-pull.test.js:174`

- The idle test asserts `sockets <= baseline`; with G3 the count is
  `baseline - 1`, so the test passes while the governor is broken. Use
  `assert.equal`.
- The retry test polls with `setInterval` and no deadline; if `onClose` never
  fires, the test hangs instead of failing.
- `cable-pull.test.js` ends with `process.exit(0)` inside the test body. That
  can hide an open handle, a failed teardown, or a pending assertion, and it
  makes the file unusable in a combined runner.

**Fix:** assert exact state; drive the behaviour through the public function;
add a deadline to every poll; close servers and return from the test.

**Test:** mutate the code to reintroduce G3 and confirm the test fails.

#### A6 — wall-clock sleeps as synchronization

**Where:** `test/gateway/client.test.js:95,110,124,173,194,218,233,238,259,280,284,302,315`;
`test/gateway/relay.test.js:456`; `test/proxy.test.js:300,574`;
`test/gateway/cable-pull.test.js:109,118,137,167`; `smoke/run.js:44,104,110`

The gateway tests wait 100–1200 ms for registration, reconnect, and teardown;
the proxy retry test polls every 100 ms; the smoke harness sleeps 1.5 s before
editing. These are guesses about scheduler and CI speed. They make the suite
slow and flaky, and they hide races because a longer sleep often makes the race
disappear.

**Fix:** expose the events the tests already need (`registered`, `reclaimed`,
`closed`) or inject timers. Where a real socket is required, poll a predicate
with a deadline and a clear failure message. Keep the `t.after` cleanup.

**Test:** run the suite repeatedly (for example 20 iterations) and compare
failures; a deterministic test should not need a different sleep on a faster
machine.

#### A7 — empty catches and magic literals

**Where:** `src/cli.js:165`; `src/cloudflared.js:84`; `src/edge.js:15,50`;
`src/port.js:58`; `src/proxy.js:169`; `src/tunnel.js:39,54,58,67,154,156`;
`src/gateway/client.js:364`

Twelve `catch (_) {}` blocks swallow cleanup and parse failures. Some are
deliberate (best-effort unlink, DNS fallback), but the code does not say which;
`send502` swallows a failure to write a 502, and `server.close()` swallows a
close error. Separately, `slice(10)`, `64 * 1024`, `500`, `250`, `0.8`, and
`'755'` versus `0o755` are unnamed literals with different units.

**Fix:** keep the deliberate best-effort catches but add a one-line reason;
narrow the rest to the expected error code. Name the header cap, the SIGKILL
grace, the client close grace, the governor headroom, and use one file-mode
form.

**Test:** no new behaviour; a review rule is enough. If a catch is narrowed, add
the failing case it now surfaces.

#### A8 — inconsistent handles and names

**Where:** `src/proxy.js:82-87,275`; `src/gateway/client.js:263,344-382`;
`src/tunnel.js:145-158`

`createMasqueradeProxy` returns `{ server }` for one value; `startTunnel`
returns `{ close }`; `startGateway` returns `{ close, destroyForTest }`; the
callback contracts differ (`onClose()` versus `onClose(code, details)`). `url2`
in `client.js:263` exists only to avoid shadowing. `relay.httpSrv` is a
test-invented name.

**Fix:** return the server directly from `createMasqueradeProxy`, or make all
three returns a small handle with a documented callback shape. Rename `url2` to
`derivedUrl`. This is cosmetic, but it is the difference between an API and a
pile of closures.

**Test:** none.

## Why contributing is harder than it needs to be

- `src/cli.js` is 220 lines with target detection, binary install, proxy
  lifecycle, tunnel callbacks, signal handling, and seven `process.exit` calls.
  Validation errors go through `fail()`, but the tunnel and uncaught-error
  paths still print their own text.
- `test/proxy.test.js` is 867 lines and imports proxy, tunnel, port, and CLI
  code. A proxy failure and a tunnel failure surface in the same file.
- `src/proxy.js` carries a 52-line HTML document inline; every proxy change
  shows up as a large diff.
- `experimental/gateway/src/relay.js` is a 489-line class with registration, WS framing,
  ingress parking, governor accounting, and idle timers. `client.js` and
  `relay.js` each carry their own WS codec.
- Tunnel tests depend on `/bin/sh`, real sleeps, and Windows skips. The suite
  spends seconds waiting for stubs, and contributors on Windows cannot run the
  tunnel cases.
- README, `llms.txt`, and `SKILL.md` repeat behaviour claims, and one of them
  was false until the B5 fix. There is no machine-checkable link between the error
  codes the code emits and the table in the README.
- There is no human-facing architecture or contribution guide. `AGENTS.md` is
  written for agents and assumes the reader already knows the module seams.

## Refactor plan

### Phase 2 — separate proxy decisions from sockets

- Add `src/headers.js` (or `src/proxy/headers.js`): pure
  `masqueradeRequestHeaders(headers, { targetPort })` and
  `rewriteResponseHeaders(headers, { publicUrl })`. Today they are closures, so
  every assertion needs a live server.
- Add `src/inspect.html` (or `src/inspect.js`): move the inline page out of the
  proxy. Read it once with `readFileSync(new URL(...))`; `files` already ships
  `src`.
- Add `test/headers.test.js` for the pure rewrites and keep the existing
  integration tests for the wire.

### Phase 3 — harden the tunnel and downloader

- `startTunnel({ spawnImpl = spawn, ... })`: tests inject a fake child instead
  of `/bin/sh` and `sleep`. This removes the Windows skips and most of the
  suite's wall-clock time.

### Phase 4 — split the tests by module

`test/proxy.test.js` currently tests four modules. Split it into
`test/proxy.test.js`, `test/headers.test.js`, `test/port.test.js`,
`test/tunnel.test.js`, and `test/cli.test.js`. Add `test/helpers/`:

- `listen(server)`: bind port 0 and return the assigned port, so tests stop
  doing `findFreePort()` and then binding later.
- `startBackend(handler)` and `withProxy(backend, options)`.
- `fakeCloudflared(script)`: a Node child, not a shell script.
- One shared `test/helpers/ws.js`; `smoke/lib/ws.js` and the gateway tests each
  have their own WS client today.

Then add one regression test per reproduced bug. Name the test after the
behaviour, not the implementation.

### Phase 5 — quarantine or finish the gateway

Decided on 2026-10-27: **quarantine**. `--gateway` now exits with
`GATEWAY_UNAVAILABLE`, the modules and tests live under `experimental/gateway/`,
and the npm package no longer contains them. They still run under `npm test`
so the quarantine does not rot.

To bring the transport back:

1. **Finish.** Extract `experimental/gateway/src/ws.js` (one codec, one limit),
   split `relay.js` into transport/registration and ingress/parking/governor,
   then fix G1–G10. Add tests for POST bodies, phone WS upgrades, exact socket
   baselines, repeated REGISTER, and stale-binding sweeps.
2. Move the modules to `src/gateway/` and the tests to `test/gateway/`, restore
   the flag in `src/cli.js`, and delete the tombstone.

The original design notes are in `research/GATEWAY_DESIGN.md`, which is
gitignored; copy anything still relevant into `experimental/gateway/` when the
work resumes.

The fixes above are a project of their own, and every one of them is invisible
to the quick-tunnel path.

### Phase 6 — contributor docs and release hygiene

- Add `CONTRIBUTING.md`: a one-diagram architecture map, the commands for one
  test file and the smoke matrix, where to add a flag (args, help, SKILL,
  `llms.txt`, test), where to add a JSON error code (registry, README table,
  `llms.txt`), and the two-runtime-dependency rule. `AGENTS.md` stays
  agent-facing.
- Add `src/errors.js`: the single registry for JSON error codes. A test can
  then assert every emitted code appears in the README and `llms.txt`, which
  prevents the B5 kind of drift.
- Fix the README and `llms.txt` claims after the code fix, not before.
- Keep `AGENTS.md`'s "Behaviour that looks simplifiable but isn't" section in
  view while working; it documents choices the audit did not flag.

The D/S/A items are not a separate project. S2 is mostly done; S1, S3, S4, S5 and
A4 are Phase 5; S6, A5 and A6 are Phase 4. D1–D5, A1–A2 and A7–A8 are
janitorial: fix them in the PR that already touches the file, not in a
standalone cleanup branch that adds review load without reducing risk.

## Suggested PR order

1. `test: split suites and add regression helpers` (Phase 4), after the 0.3.0
   release

## Open decisions

- **Gateway:** decided — quarantined on 2026-10-27. G1–G10 are research debt,
  not roadmap, until someone chooses to finish the transport.
- **TLS policy:** decided — devhop does not verify upstream certificates for
  any host, and the comment and docs now say so. Revisit with an opt-in flag if
  someone needs verification.
- **Demo assets:** decided — absolute raw GitHub URLs. `test/readme.test.js`
  keeps relative image paths out of the README unless the package ships them.
- **Error codes:** keep the README table hand-written, or generate it from
  `src/errors.js`. A generated table is more work up front and removes a whole
  class of drift.

## Notes from the fix pass

Things found while fixing the items above. Newest last.

- The baseline change (`refactor: quarantine the gateway transport`) also
  carries the 🦘→🐇 help-banner edit, because the working copy already held it
  under a stale `feat(cli): use a rabbit…` description.
- Tunnel stubs cannot be node scripts on Windows: `spawn` cannot execute a
  `.js` file there, so the `/bin/sh` stubs and their Windows skips stay. Only
  an injected `spawnImpl` (Phase 3) removes the skips.
- The "regex only" location test was deleted with B1; the split-chunk test
  drives `startTunnel` and fails on the old code.
- B14 ("response hangs after headers") was audited as a bug and disproved: an
  upstream that dies mid-response is already handled by
  `upstreamRes.on('error', () => res.destroy())`, and the client sees an abort.
- The B3 regression test needs `closeAllConnections()` in `t.after`, or the
  streaming backend keeps the test runner alive.
- B4 was rated medium-high, but a browser does not expose the body of a failed
  WebSocket handshake, so only curl-style clients benefit. The fix is small
  enough to keep. A keep-alive upstream never closes after its 404, so the proxy
  releases the client after 5 s of upstream silence (measured: 5015 ms, body
  intact).
- The B5 hint covers plain requests only. A WebSocket upgrade to a wrong-scheme
  upstream still just drops the socket in `proxyUpgrade`, with no message.
- `ECONNRESET` on an `http:` target is also what a crashed dev server looks
  like, so that hint is worded as a conditional ("if the dev server uses
  HTTPS"). Node 26 reports a plain-HTTP server reached over TLS as `EPROTO`;
  older Node versions use `ERR_SSL_WRONG_VERSION_NUMBER`, which is also handled
  but untested.
- B6 needed one small helper after all: `urlHost()` in `src/port.js` re-adds
  brackets wherever a host is printed as a URL (dashboard, the `ready` event's
  `target`, and the scheme hint). The `ready` event's `host` field is now the
  bare address (`::1`); it was `[::1]` before, but that target never connected,
  so no working consumer can depend on it.
- `::` is treated like `0.0.0.0` and mapped to loopback (`::1`) in the proxy.
  `parseTarget('[::]:3000')` was not covered by the old tests either.
- B8 was closed by a decision, not a code change. Skipping verification only
  for loopback would break self-signed HTTPS in containers, VMs and LAN boxes,
  and devhop already forwards plain `http://` to any host with no protection at
  all. A spike was impossible here: this sandbox cannot connect to the machine's
  own LAN address, so the non-loopback case is covered by reading
  `proxy.js` only.
- B9 uses an idle timeout (30 s of socket silence), so a slow but moving
  download still finishes and a stall mid-body is caught too. The timeout is a
  `downloadCloudflared` option like `baseUrl` and `assets`, so the tests use
  200 ms. The download is pinned to GitHub's release host and redirects, which I
  could not exercise from this sandbox, so the 30 s default is unmeasured
  against the real CDN.
- The test server helper in `test/cloudflared.test.js` now calls
  `closeAllConnections()`, otherwise a deliberately stalled socket keeps
  `server.close()` waiting.
- `removeOldVersions` only runs after a fresh download, and `ensureBinary`
  hard-codes the GitHub URL, so no test can reach it through `ensureBinary`
  without network. B12's fix is therefore tested on `removeOldVersions`
  directly, which is now exported for that reason (the A4 smell). A
  `downloadCloudflared` seam on `ensureBinary` would remove the need.
- The B12 permission test skips as root and on Windows, so CI containers that
  run as root skip it silently.
- The README images now point at `raw.githubusercontent.com/.../main/docs/`.
  `docs/demo.avif` is only on the branch until it merges to `main`, so the
  images 404 (on npm and GitHub) until then. Branch previews on GitHub also
  show `main`'s images, not the branch's.
- `test/readme.test.js` is a new file because nothing existing owns README
  checks. It parses `src`, `srcset` and `![](…)` references only; a relative
  `<a href>` to a file outside `files` (the badge links to `./skills/…`, which
  does ship) is not checked.
- Everything ships as 0.3.0 with no 0.2.1 release: the fixes alone would have
  been a patch, but the `--gateway` removal and the stricter argument parsing
  are visible changes, and one tag keeps the release notes in one section.
  Releases go through the tag workflow only.
- B15 (`--json` events lost on `process.exit`) was dropped by decision. A pipe
  write is lost only when the pipe is already full, which took about 300 KB
  queued ahead of a stalled reader; devhop's events are a few hundred bytes.
  Revisit if an agent harness ever reports a truncated final event.
- Moving `printHelp` and the dashboard into `src/ui.js` initially dropped the
  `urlHost` import that the `ready` event in `cli.js` still uses. No test
  reaches that line without a real tunnel, so only a manual identifier check
  caught it. A fake-tunnel test for the `ready` event would close that gap.
- `fail()` prints the example hint without the cyan highlighting the old inline
  `console.error` calls had, and the human `NO_DEV_SERVER` text now shows the
  same message as the JSON event (the two used to differ).
- B7 (`--gateway <url>` parsed as a target) closed with the quarantine. If the
  transport is revived, `parseArgs` must consume the `--gateway` value and
  validate it as a URL (an `INVALID_GATEWAY_URL` code with a runnable example);
  today it rejects the flag outright with `GATEWAY_UNAVAILABLE`.
- The strict parser lists valid options in its hint, but does not suggest the
  closest one ("did you mean --json?"). That would take a small edit-distance
  helper, which nothing else needs yet.
- `GATEWAY_UNAVAILABLE` is emitted but is not in the README's list of error
  codes, because the flag was never documented.
- `startTunnel().close()` now returns a promise that resolves when cloudflared
  has exited (SIGTERM, then SIGKILL after 500 ms). `quit()` awaits it, so a
  SIGTERM to devhop takes about half a second when cloudflared ignores SIGTERM.
  The `uncaughtException` and `onError` paths still call `cleanup()` and exit
  without awaiting it, so a crash can still leave a SIGTERM-ignoring
  cloudflared behind.
- The `closed` JSON event moved after the wait, so it now means cloudflared is
  gone. The "Tunnel disconnected" line still prints when the signal arrives.
- Ctrl+C in a terminal also delivers SIGINT to cloudflared directly (same
  process group), so B2 mostly matters for SIGTERM and SIGHUP, such as a closed
  terminal or a supervisor. This is reasoning, not something I tested.
- The tunnel and CLI stubs that ignore SIGTERM are node scripts with a
  `#!/usr/bin/env node` shebang, so they need a POSIX `env`; the tests skip on
  Windows like the other stub tests.
- B10 added one error code, `PROXY_START_FAILED`, for a `listen(0)` failure. That
  path is untested: with port 0 it needs something like an exhausted file
  descriptor limit to trigger. The race itself cannot be reproduced in a test,
  so the new test only asserts that the port handed to cloudflared is open.
  `findFreePort()` is now used only by tests and the smoke fixtures.
