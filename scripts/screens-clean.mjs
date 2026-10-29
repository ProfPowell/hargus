// Clean-up for scripts/screens.mjs, kept pure so it can be tested against a temp directory.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Files the screens script generates itself (never directories, never anything else). */
export function isGenerated(name) {
  return /\.png$/i.test(name) || name === 'manifest.json' || name === 'export-print.pdf' || name === 'brief.md';
}

/**
 * Remove stale output from `dir`. Default folder (`custom` false): everything except OVERVIEW.md, as before.
 * A user-supplied --out folder: only regular files the script generates; directories and other files survive.
 */
export async function cleanOut(dir, { custom = false } = {}) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (custom) {
      if (e.isFile() && isGenerated(e.name)) await rm(join(dir, e.name), { force: true });
    } else if (e.name !== 'OVERVIEW.md') await rm(join(dir, e.name), { recursive: true, force: true });
  }
}
