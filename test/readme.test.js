import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const { files } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('README images are absolute URLs or ship in the npm package', () => {
  const refs = [...readme.matchAll(/\b(?:src|srcset)="([^"]+)"|!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1] ?? m[2]);
  assert.ok(refs.length > 0, 'expected the README to reference images');
  for (const ref of refs) {
    if (/^https?:\/\//.test(ref)) continue;
    const local = path.normalize(ref);
    assert.ok(fs.statSync(path.join(root, local), { throwIfNoEntry: false })?.isFile(), `${ref} does not exist`);
    assert.ok(
      files.some((entry) => local === entry || local.startsWith(`${entry}${path.sep}`)),
      `${ref} is relative but not covered by package.json "files", so it is broken on the npm page`
    );
  }
});
