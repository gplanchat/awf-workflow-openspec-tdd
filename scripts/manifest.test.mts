// manifest.yaml: the fields `awf workflow install` reads, and one workflow name per file of workflows/.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = readFileSync(join(ROOT, 'manifest.yaml'), 'utf8');
const field = (name: string): string | undefined => new RegExp(`^${name}: *"?([^"\\n]*)"?$`, 'm').exec(MANIFEST)?.[1];

test('the manifest declares name, a SemVer version, author, license and an awf_version constraint', () => {
  assert.equal(field('name'), 'openspec-tdd');
  assert.match(field('version') ?? '', /^\d+\.\d+\.\d+$/);
  assert.ok((field('author') ?? '') !== '', 'author');
  assert.ok((field('license') ?? '') !== '', 'license');
  assert.match(field('awf_version') ?? '', /^>=\d+\.\d+\.\d+$/, 'awf workflow install fails on an empty awf_version constraint');
  assert.doesNotMatch(MANIFEST, /^min_cli_version:/m, 'awf reads awf_version, not min_cli_version');
});

test('the manifest lists every workflow of workflows/, and only those', () => {
  const listed = [...(MANIFEST.split(/^workflows:\s*$/m)[1] ?? '').matchAll(/^ {2}- ([\w-]+)\s*$/gm)].map((m) => m[1]).sort();
  const files = readdirSync(join(ROOT, 'workflows')).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).sort();

  assert.deepEqual(listed, files);
});
