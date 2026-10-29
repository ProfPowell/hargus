import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanOut } from '../scripts/screens-clean.mjs';

async function fixture() {
  const d = await mkdtemp(join(tmpdir(), 'screens-clean-'));
  for (const f of ['a.png', 'manifest.json', 'export-print.pdf', 'brief.md', 'OVERVIEW.md', 'package.json', 'notes.txt']) await writeFile(join(d, f), 'x');
  await mkdir(join(d, 'src')); await writeFile(join(d, 'src', 'keep.js'), 'x');
  await mkdir(join(d, 'old.png')); // a directory that merely looks generated
  return d;
}
test('--out clean-up removes only generated files, never directories or other files', async () => {
  const d = await fixture();
  await cleanOut(d, { custom: true });
  assert.deepEqual((await readdir(d)).sort(), ['OVERVIEW.md', 'notes.txt', 'old.png', 'package.json', 'src']);
  await rm(d, { recursive: true });
});
test('default clean-up keeps only OVERVIEW.md', async () => {
  const d = await fixture();
  await cleanOut(d);
  assert.deepEqual(await readdir(d), ['OVERVIEW.md']);
  await rm(d, { recursive: true });
});
