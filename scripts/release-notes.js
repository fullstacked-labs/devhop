import { readFileSync } from 'node:fs';

const [version, file = new URL('../CHANGELOG.md', import.meta.url)] = process.argv.slice(2);
if (!version) {
  console.error('Usage: node scripts/release-notes.js <version> [changelogPath]');
  process.exit(1);
}

const lines = readFileSync(file, 'utf8').split('\n');
const start = lines.findIndex((l) => l.trim() === `## ${version.replace(/^v/, '')}`);
if (start === -1) {
  console.error(`No "## ${version.replace(/^v/, '')}" section in ${file}`);
  process.exit(1);
}
const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
console.log(lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim());
