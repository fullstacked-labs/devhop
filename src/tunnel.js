import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CLOUDFLARED_VERSION, downloadCloudflared } from './cloudflared.js';

export function getBinPath() {
  if (process.env.DEVHOP_CLOUDFLARED) return process.env.DEVHOP_CLOUDFLARED;
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'cloudflared.exe' : 'cloudflared';

  const cacheDir = process.env.XDG_CACHE_HOME
    ? path.join(process.env.XDG_CACHE_HOME, 'devhop', 'bin')
    : path.join(os.homedir(), '.cache', 'devhop', 'bin');

  // Versioned so bumping the pin fetches the new binary instead of reusing an old one.
  return path.join(cacheDir, CLOUDFLARED_VERSION, binName);
}

export async function ensureBinary(onProgress) {
  const binPath = getBinPath();

  if (process.env.DEVHOP_CLOUDFLARED) {
    if (!fs.existsSync(binPath)) {
      throw new Error(`DEVHOP_CLOUDFLARED points to ${binPath}, which does not exist.`);
    }
    return binPath;
  }

  // If binary exists and is valid (> 1MB), reuse it
  if (fs.existsSync(binPath)) {
    try {
      const stat = fs.statSync(binPath);
      if (stat.size > 1024 * 1024) {
        return binPath;
      }
      // If corrupted / 0-byte, remove and redownload
      fs.unlinkSync(binPath);
    } catch (_) {}
  }

  const dir = path.dirname(binPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Atomic download to .tmp file to prevent corrupt cache on interrupt
  const tempPath = `${binPath}.tmp-${Date.now()}`;
  if (onProgress) onProgress('Downloading cloudflared binary (one-time setup)...');

  try {
    await downloadCloudflared(tempPath);
    fs.renameSync(tempPath, binPath);
    try { fs.chmodSync(binPath, '755'); } catch (_) {}
    removeOldVersions(path.dirname(dir));
    return binPath;
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw new Error(`Failed to install cloudflared: ${err.message}`);
  }
}

// Older pins sit next to the current one as <version>/ directories; releases
// before 0.2 cached an unversioned binary directly in the cache root.
//
// Best-effort: a stale directory we cannot delete must not fail an install that
// already succeeded.
export function removeOldVersions(cacheRoot) {
  for (const legacy of ['cloudflared', 'cloudflared.exe']) {
    try { fs.unlinkSync(path.join(cacheRoot, legacy)); } catch (_) {}
  }
  try {
    for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d{4}\.\d+\.\d+$/.test(entry.name) && entry.name !== CLOUDFLARED_VERSION) {
        fs.rmSync(path.join(cacheRoot, entry.name), { recursive: true, force: true });
      }
    }
  } catch (_) {}
}

// Quick-tunnel creation fails intermittently; one retry fixes most first-run failures.
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2000;

export function startTunnel({ localPort, binPath, protocol, onUrl, onLocation, onError, onClose, onRetry }) {
  const tunnelArgs = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`];
  if (protocol === 'http2') {
    tunnelArgs.push('--protocol', 'http2');
  }

  let attempt = 0;
  let current = null;
  let manualClose = false;
  let lastLocation = null;

  function launch() {
    attempt += 1;
    const child = spawn(binPath, tunnelArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let urlFound = false;
    const recentOutput = [];
    const handleLine = (raw) => {
      const line = raw.trim();
      if (!line) return;
      recentOutput.push(line);
      if (recentOutput.length > 10) recentOutput.shift();
      const locMatch = line.match(/location=([A-Z0-9]+)/i);
      if (locMatch && onLocation) {
        const loc = locMatch[1].toUpperCase();
        if (loc !== lastLocation) {
          lastLocation = loc;
          onLocation(loc);
        }
      }
      const urlMatch = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !urlFound) {
        urlFound = true;
        if (onUrl) onUrl(urlMatch[0]);
      }
    };

    // A pipe read can end mid-line, so match on complete lines only.
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', handleLine);
    }

    child.on('error', (err) => {
      if (onError) onError(err, { recentOutput: recentOutput.join('\n'), urlFound });
    });

    child.on('close', (code, signal) => {
      if (manualClose) return;
      if (!urlFound && attempt < MAX_ATTEMPTS) {
        if (onRetry) onRetry(attempt);
        setTimeout(() => { if (!manualClose) launch(); }, RETRY_DELAY_MS);
        return;
      }
      if (onClose) onClose(code, { recentOutput: recentOutput.join('\n'), urlFound, signal });
    });

    current = child;
  }

  launch();

  return {
    close: () => {
      manualClose = true;
      try {
        current.kill('SIGTERM');
        // SIGKILL fallback: cloudflared must not outlive devhop if it ignores SIGTERM.
        setTimeout(() => {
          try {
            if (!current.killed) current.kill('SIGKILL');
          } catch (_) {}
        }, 500);
      } catch (_) {}
    }
  };
}
