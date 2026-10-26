import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMasqueradeProxy } from '../src/proxy.js';
import { findFreePort } from '../src/port.js';
import { wsUpgrade } from './lib/ws.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TUNNEL = 'smoke-check.trycloudflare.com';
const BLOCKED = /is not allowed|Blocked (cross-origin )?request/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The headers cloudflared delivers to the origin.
const tunnelHeaders = {
  Host: TUNNEL,
  Origin: `https://${TUNNEL}`,
  Referer: `https://${TUNNEL}/`,
  'X-Forwarded-Proto': 'https',
  'X-Forwarded-For': '203.0.113.7',
};

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(15000, () => req.destroy(new Error(`GET ${urlPath} timed out`)));
    req.on('error', reject);
  });
}

async function waitReady(port, spec, child) {
  const deadline = Date.now() + spec.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dev server exited early (code ${child.exitCode})`);
    try {
      await get(port, spec.readyPath);
      return;
    } catch (_) {
      await sleep(500);
    }
  }
  throw new Error(`dev server not ready after ${spec.readyTimeoutMs} ms`);
}

async function checkMode(port, spec, { keepSocket }) {
  const result = { page: false, hmr: false, pageStatus: null, pageError: null, hmrStatus: null };
  let socket = null;

  try {
    const page = await get(port, spec.readyPath, tunnelHeaders);
    result.pageStatus = page.status;
    const blocked = page.body.split('\n').find((line) => BLOCKED.test(line));
    result.page = page.status === 200 && !blocked;
    result.pageError = blocked?.trim().slice(0, 300) ?? (page.status === 200 ? null : page.body.trim().split('\n')[0].slice(0, 300));
  } catch (err) {
    result.pageError = err.message;
  }

  try {
    let token = '';
    if (spec.hmr.tokenFrom) {
      const res = await get(port, spec.hmr.tokenFrom.path, tunnelHeaders);
      const match = res.status === 200 && res.body.match(new RegExp(spec.hmr.tokenFrom.regex));
      if (!match) {
        result.hmrStatus = `token fetch failed (HTTP ${res.status})`;
        return { result, socket };
      }
      token = match[1];
    }
    const upgrade = await wsUpgrade({
      port,
      path: spec.hmr.path.replace('{token}', token),
      headers: tunnelHeaders,
      protocol: spec.hmr.protocol,
    });
    result.hmrStatus = upgrade.statusLine;
    result.hmr = upgrade.status === 101;
    if (result.hmr && keepSocket) socket = upgrade;
    else upgrade.socket.destroy();
  } catch (err) {
    result.hmrStatus = err.message;
  }
  return { result, socket };
}

async function checkUpdate(spec, fixtureDir, upgrade) {
  const file = path.join(fixtureDir, spec.edit.file);
  const original = fs.readFileSync(file, 'utf8');
  if (!original.includes(spec.edit.from)) return false;
  const pattern = new RegExp(spec.hmr.updatePattern);
  let received = '';
  let collecting = false;
  upgrade.readText((text) => {
    if (collecting) received += text;
  });
  try {
    await sleep(1500);
    collecting = true;
    fs.writeFileSync(file, original.replace(spec.edit.from, spec.edit.to));
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (pattern.test(received)) return true;
      await sleep(250);
    }
    return false;
  } finally {
    fs.writeFileSync(file, original);
  }
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {}
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  }, 3000);
  await exited;
  clearTimeout(timer);
}

function versionsOf(fixtureDir, packages) {
  const versions = {};
  for (const pkg of packages) {
    try {
      versions[pkg] = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'node_modules', pkg, 'package.json'), 'utf8')).version;
    } catch (_) {
      versions[pkg] = null;
    }
  }
  return versions;
}

const [name, ...flags] = process.argv.slice(2);
if (!name) {
  console.error('Usage: node smoke/run.js <fixture> [--json]');
  process.exit(1);
}
const fixtureDir = path.join(root, 'smoke', 'fixtures', name);
const spec = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'smoke.json'), 'utf8'));

const started = Date.now();
const port = await findFreePort();
const output = [];
const child = spawn(spec.dev[0], spec.dev.slice(1).map((a) => a.replace('{port}', port)), {
  cwd: fixtureDir,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1', ASTRO_TELEMETRY_DISABLED: '1', ...spec.env },
});
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    output.push(...chunk.toString().split('\n').filter(Boolean));
    if (output.length > 50) output.splice(0, output.length - 50);
  });
}

let proxyServer;
const report = { name: spec.name, framework: spec.framework, ok: false };
try {
  await waitReady(port, spec, child);

  const direct = await checkMode(port, spec, { keepSocket: false });

  const proxyPort = await findFreePort();
  ({ server: proxyServer } = createMasqueradeProxy({ targetPort: port, getPublicUrl: () => `https://${TUNNEL}` }));
  await new Promise((resolve) => proxyServer.listen(proxyPort, '127.0.0.1', resolve));
  const proxied = await checkMode(proxyPort, spec, { keepSocket: true });

  let update = false;
  if (proxied.socket) {
    try {
      update = await checkUpdate(spec, fixtureDir, proxied.socket);
    } finally {
      proxied.socket.socket.destroy();
    }
  }

  Object.assign(report, {
    versions: versionsOf(fixtureDir, spec.packages),
    direct: direct.result,
    proxied: proxied.result,
    update,
    ok: proxied.result.page && proxied.result.hmr && update && (!direct.result.page || !direct.result.hmr),
  });
  if (direct.result.page && direct.result.hmr) {
    console.error(`${name}: both direct checks passed, so devhop is not needed for this framework and the claim would be false.`);
  }
} catch (err) {
  report.error = err.message;
} finally {
  proxyServer?.close();
  await stop(child);
}

report.durationMs = Date.now() - started;
if (!report.ok) report.devOutputTail = output.join('\n');

const mark = (pass) => (pass ? 'PASS' : 'FAIL');
if (report.direct) {
  console.error(`${name}: direct   page ${mark(report.direct.page)}  hmr ${mark(report.direct.hmr)}`);
  console.error(`${name}: proxied  page ${mark(report.proxied.page)}  hmr ${mark(report.proxied.hmr)}  update ${mark(report.update)}`);
}
if (report.error) console.error(`${name}: ${report.error}`);
console.error(`${name}: ${report.ok ? 'ok' : 'FAILED'} in ${report.durationMs} ms`);

fs.mkdirSync(path.join(root, 'smoke-results'), { recursive: true });
fs.writeFileSync(path.join(root, 'smoke-results', `${name}.json`), JSON.stringify(report, null, 2));
if (flags.includes('--json')) console.log(JSON.stringify(report));
process.exit(report.ok ? 0 : 1);
