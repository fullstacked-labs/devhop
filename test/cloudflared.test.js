import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { downloadCloudflared } from '../src/cloudflared.js';

const BODY = Buffer.from('not really a cloudflared binary');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const assetsFor = (hash) => ({ 'linux-x64': { file: 'cloudflared-linux-amd64', sha256: hash } });

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function tempDest(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhop-cf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'cloudflared');
}

const opts = (baseUrl, hash) => ({ platform: 'linux', arch: 'x64', baseUrl, assets: assetsFor(hash) });

test('downloadCloudflared writes the file when the checksum matches', async (t) => {
  const baseUrl = await serve(t, (_req, res) => res.end(BODY));
  const dest = tempDest(t);
  await downloadCloudflared(dest, opts(baseUrl, sha(BODY)));
  assert.deepEqual(fs.readFileSync(dest), BODY);
});

test('downloadCloudflared leaves no file behind on a checksum mismatch', async (t) => {
  const baseUrl = await serve(t, (_req, res) => res.end(BODY));
  const dest = tempDest(t);
  await assert.rejects(downloadCloudflared(dest, opts(baseUrl, sha('other'))), /checksum mismatch for cloudflared-linux-amd64/);
  assert.equal(fs.existsSync(dest), false);
});

test('downloadCloudflared follows five redirects and rejects a sixth', async (t) => {
  // /chain/<n>/<file> redirects to /chain/<n-1>/<file> until n reaches 0.
  const baseUrl = await serve(t, (req, res) => {
    const [, , remaining, file] = req.url.split('/');
    if (Number(remaining) > 0) {
      res.writeHead(302, { location: `/chain/${Number(remaining) - 1}/${file}` });
      res.end();
    } else {
      res.end(BODY);
    }
  });
  const fiveDest = tempDest(t);
  await downloadCloudflared(fiveDest, opts(`${baseUrl}/chain/5`, sha(BODY)));
  assert.deepEqual(fs.readFileSync(fiveDest), BODY);
  await assert.rejects(downloadCloudflared(tempDest(t), opts(`${baseUrl}/chain/6`, sha(BODY))), /too many redirects/);
});

test('downloadCloudflared names DEVHOP_CLOUDFLARED on an unsupported platform', async (t) => {
  await assert.rejects(
    downloadCloudflared(tempDest(t), { platform: 'freebsd', arch: 'x64' }),
    /Unsupported platform freebsd-x64.*DEVHOP_CLOUDFLARED/
  );
});
