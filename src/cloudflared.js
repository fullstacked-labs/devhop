import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { spawnSync } from 'node:child_process';

// Bump with scripts/bump-cloudflared.js, which rewrites the two blocks below.
export const CLOUDFLARED_VERSION = '2026.10.4';
export const CLOUDFLARED_ASSETS = {
  'linux-x64': { file: 'cloudflared-linux-amd64', sha256: 'ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42' },
  'linux-arm64': { file: 'cloudflared-linux-arm64', sha256: '2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6' },
  'linux-arm': { file: 'cloudflared-linux-arm', sha256: 'f29b44e97ec18dd2971dfdd9bad0c6d460aaa78223b91b186219f02135c08d8c' },
  'darwin-x64': { file: 'cloudflared-darwin-amd64.tgz', sha256: 'f11fbef4207d715892331917dafd437f032cf4b7137ed64dea3008338c1c613d' },
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', sha256: '68b6bc4080ac1330234db2a9002d07f98b000537a1bd531a687b660d4160fa7f' },
  'win32-x64': { file: 'cloudflared-windows-amd64.exe', sha256: '411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8' },
};

const MAX_REDIRECTS = 5;

export function nextRedirectUrl(current, location, redirects) {
  if (redirects >= MAX_REDIRECTS) {
    throw new Error(`too many redirects fetching ${current.pathname.split('/').pop()}`);
  }
  const next = new URL(location, current);
  if (current.protocol === 'https:' && next.protocol !== 'https:') {
    throw new Error(`refusing to follow a redirect to ${next.protocol}//${next.host}`);
  }
  return next;
}

function fetchToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const get = url.protocol === 'http:' ? http.get : https.get;
    const req = get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        try {
          resolve(fetchToFile(nextRedirectUrl(url, res.headers.location, redirects), dest, redirects + 1));
        } catch (err) {
          reject(err);
        }
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed: HTTP ${res.statusCode} from ${url.host}`));
        return;
      }
      const hash = crypto.createHash('sha256');
      const tap = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      pipeline(res, tap, fs.createWriteStream(dest)).then(() => resolve(hash.digest('hex')), reject);
    });
    req.on('error', reject);
  });
}

// `baseUrl` and `assets` are overridable so tests can use a local server and their own hashes.
export async function downloadCloudflared(
  dest,
  {
    platform = process.platform,
    arch = process.arch,
    baseUrl = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`,
    assets = CLOUDFLARED_ASSETS,
  } = {}
) {
  const asset = assets[`${platform}-${arch}`];
  if (!asset) {
    throw new Error(
      `Unsupported platform ${platform}-${arch}. Install cloudflared yourself and set DEVHOP_CLOUDFLARED=/path/to/cloudflared.`
    );
  }
  const isTarball = asset.file.endsWith('.tgz');
  const target = isTarball ? `${dest}.tgz` : dest;
  const discard = () => {
    try { fs.unlinkSync(target); } catch (_) {}
  };

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let actual;
  try {
    actual = await fetchToFile(new URL(`${baseUrl}/${asset.file}`), target);
  } catch (err) {
    discard();
    throw err;
  }
  if (actual !== asset.sha256) {
    discard();
    throw new Error(`cloudflared checksum mismatch for ${asset.file} (expected ${asset.sha256}, got ${actual})`);
  }

  if (isTarball) {
    // Extract into a private directory so a concurrent run never sees a half-written binary.
    const scratch = fs.mkdtempSync(path.join(path.dirname(dest), 'extract-'));
    try {
      const result = spawnSync('tar', ['-xzf', target, '-C', scratch]);
      if (result.status !== 0) throw new Error(`could not extract ${asset.file}: ${result.stderr?.toString().trim() || 'tar failed'}`);
      fs.renameSync(path.join(scratch, 'cloudflared'), dest);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
      discard();
    }
  }
  if (platform !== 'win32') fs.chmodSync(dest, 0o755);
  return dest;
}
