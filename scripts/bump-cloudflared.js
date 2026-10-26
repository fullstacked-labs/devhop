import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../src/cloudflared.js', import.meta.url);
const source = readFileSync(file, 'utf8');
const wanted = process.argv[2];
const api = `https://api.github.com/repos/cloudflare/cloudflared/releases/${wanted ? `tags/${wanted}` : 'latest'}`;

const res = await fetch(api, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'devhop-bump' } });
if (!res.ok) {
  console.error(`GitHub API returned ${res.status} for ${api}`);
  process.exit(1);
}
const release = await res.json();

const table = source.match(/export const CLOUDFLARED_ASSETS = \{([\s\S]*?)\n\};/)[1];
const lines = [];
for (const [, key, name] of table.matchAll(/'([^']+)': \{ file: '([^']+)'/g)) {
  const asset = release.assets.find((a) => a.name === name);
  const digest = asset?.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
  if (!digest) {
    console.error(`Release ${release.tag_name} has no sha256 digest for ${name}`);
    process.exit(1);
  }
  lines.push(`  '${key}': { file: '${name}', sha256: '${digest}' },`);
}

const next = source
  .replace(/export const CLOUDFLARED_VERSION = '[^']*';/, `export const CLOUDFLARED_VERSION = '${release.tag_name}';`)
  .replace(/export const CLOUDFLARED_ASSETS = \{[\s\S]*?\n\};/, `export const CLOUDFLARED_ASSETS = {\n${lines.join('\n')}\n};`);
writeFileSync(file, next);
console.log(`cloudflared pinned to ${release.tag_name}`);
