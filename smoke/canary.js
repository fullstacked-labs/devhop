import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { findFreePort } from '../src/port.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'inherit'], ...options });
  children.push(child);
  return child;
}

function killAll() {
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  }
}

// DNS and the Cloudflare edge can lag behind the "ready" event (a fresh tunnel
// answers 530 for a few seconds), so retry network errors and 5xx for a while.
async function fetchWithRetries(url, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const result = { status: res.status, body: await res.text() };
      if (result.status < 500) return result;
      last = new Error(`HTTP ${result.status}`);
    } catch (err) {
      last = err;
    }
    await sleep(2000);
  }
  throw new Error(`could not fetch ${url}: ${last?.message}`);
}

async function main() {
  const port = await findFreePort();
  spawnChild('node', ['smoke/fixtures/stub/server.js', String(port)]);

  const devhop = spawnChild('node', ['bin/devhop.js', String(port), '--json']);
  const lines = [];
  const events = readline.createInterface({ input: devhop.stdout });
  const exited = new Promise((resolve) => devhop.once('exit', resolve));
  let onEvent;
  events.on('line', (line) => {
    lines.push(line);
    try { onEvent?.(JSON.parse(line)); } catch (_) {}
  });

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no "ready" event within 60 s')), 60000);
    onEvent = (event) => {
      if (event.event === 'ready') {
        clearTimeout(timer);
        resolve(event);
      } else if (event.event === 'error') {
        clearTimeout(timer);
        reject(new Error(`devhop reported ${event.code}: ${event.message}`));
      }
    };
  });

  const page = await fetchWithRetries(ready.url);
  if (page.status !== 200 || /not allowed/i.test(page.body)) {
    throw new Error(`GET ${ready.url} returned ${page.status}`);
  }

  const inspect = await fetchWithRetries(ready.inspectUrl);
  if (inspect.status !== 200 || !inspect.body.includes('devhop inspector')) {
    throw new Error(`GET ${ready.inspectUrl} returned ${inspect.status} without the inspector page`);
  }

  process.kill(devhop.pid, 'SIGINT');
  await Promise.race([exited, sleep(10000)]);
  const last = lines[lines.length - 1];
  if (last !== '{"event":"closed"}') throw new Error(`expected a closed event after SIGINT, last line was: ${last}`);

  return ready.url;
}

const started = Date.now();
try {
  const url = await main();
  console.log(`canary ok: ${url} (${Date.now() - started} ms)`);
  killAll();
  process.exit(0);
} catch (err) {
  console.error(`canary FAILED: ${err.message}`);
  killAll();
  process.exit(1);
}
