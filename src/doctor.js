import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { getBinPath } from './tunnel.js';
import { detectDevPorts } from './port.js';

const { version: VERSION } = createRequire(import.meta.url)('../package.json');

// Users paste this output publicly, so keep their home directory out of it.
const tildify = (s) => s.split(os.homedir()).join('~');

function cloudflaredVersion(binPath) {
  const result = spawnSync(binPath, ['--version'], { timeout: 5000, encoding: 'utf8' });
  const first = result.stdout?.split('\n')[0]?.trim();
  return first ? tildify(first) : null;
}

export async function collectDiagnostics() {
  const binPath = getBinPath();
  const cached = fs.existsSync(binPath);
  return {
    devhop: VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cloudflared: {
      path: tildify(binPath),
      override: Boolean(process.env.DEVHOP_CLOUDFLARED),
      cached,
      version: cached ? cloudflaredVersion(binPath) : null,
    },
    devPorts: await detectDevPorts(),
    cacheDir: tildify(path.dirname(binPath)),
  };
}

export function formatDiagnostics(d) {
  let cloudflared;
  if (d.cloudflared.cached) {
    cloudflared = `${d.cloudflared.path}${d.cloudflared.override ? ' (DEVHOP_CLOUDFLARED)' : ''}${d.cloudflared.version ? ` — ${d.cloudflared.version}` : ''}`;
  } else if (d.cloudflared.override) {
    cloudflared = `${d.cloudflared.path} (DEVHOP_CLOUDFLARED) — file not found; unset it or point it at a cloudflared binary`;
  } else {
    cloudflared = 'cloudflared not downloaded yet (downloads on first run)';
  }
  return [
    '```',
    `devhop      ${d.devhop}`,
    `node        ${d.node} (${d.platform} ${d.arch})`,
    `cloudflared ${cloudflared}`,
    `dev ports   ${d.devPorts.length ? d.devPorts.join(', ') : 'none detected'}`,
    '```',
  ].join('\n');
}
