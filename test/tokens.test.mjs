import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const css = readFileSync(join(root, 'extension/ui/theme.css'), 'utf8');

// The :root block inside `@layer tokens`.
const rootStart = css.indexOf(':root {', css.indexOf('@layer tokens'));
const rootBlock = css.slice(rootStart, css.indexOf('}', rootStart));

// --name: light-dark(#xxxxxx, #yyyyyy) -> { name: [light, dark] }
const tok = {};
for (const m of rootBlock.matchAll(/--([a-z0-9-]+):\s*light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)/gi)) tok[m[1]] = [m[2], m[3]];

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test('ink, accent, severity and band tokens pass 4.5:1 on bg, surface and surface-sunk in both modes', () => {
  for (const fg of ['ink', 'ink-2', 'ink-3', 'accent', 'sev-high', 'sev-medium', 'sev-low', 'sev-info', 'band-good', 'band-fair', 'band-poor'])
    for (const bg of ['bg', 'surface', 'surface-sunk']) for (const mode of [0, 1]) {
      assert.ok(tok[fg] && tok[bg], `${fg} / ${bg} declared`);
      assert.ok(ratio(tok[fg][mode], tok[bg][mode]) >= 4.5, `${fg} on ${bg} (${mode ? 'dark' : 'light'})`);
    }
});

test('severity ink passes 4.5:1 on its own soft fill in both modes', () => {
  for (const s of ['sev-high', 'sev-medium', 'sev-low', 'sev-info', 'accent'])
    for (const mode of [0, 1]) {
      const soft = s === 'accent' ? 'accent-soft' : `${s}-soft`;
      assert.ok(tok[s] && tok[soft], `${s} and ${soft} declared`);
      assert.ok(ratio(tok[s][mode], tok[soft][mode]) >= 4.5, `${s} on ${soft} (${mode ? 'dark' : 'light'})`);
    }
});

test('every var(--x) used is declared', () => {
  const files = [];
  for (const dir of ['extension/ui', 'extension/plugins'])
    for (const f of readdirSync(join(root, dir))) if (/\.(css|js)$/.test(f)) files.push(join(root, dir, f));
  // Declared: every `--name:` in theme.css, plus custom properties set inline from JS (style="--v:…").
  const declared = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  const used = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/--([a-z0-9-]+)\s*:/gi)) declared.add(m[1]);
    // template forms like var(--c${i}) are dynamic: skipped
    for (const m of src.matchAll(/var\(\s*--([a-z0-9${}-]+)/gi)) if (!m[1].includes('${')) used.add(m[1]);
  }
  const undeclared = [...used].filter((n) => !declared.has(n)).sort();
  assert.deepEqual(undeclared, []);
});

test('scale tokens exist', () => {
  const want = {
    'fs-2xs': '11px', 'fs-xs': '12px', 'fs-sm': '13px', 'fs-md': '15px', 'fs-lg': '18px', 'fs-xl': '24px', 'fs-2xl': '32px', 'fs-3xl': '44px',
    'sp-1': '4px', 'sp-2': '8px', 'sp-3': '12px', 'sp-4': '16px', 'sp-5': '24px', 'sp-6': '32px', 'sp-7': '48px',
    'r-1': '6px', 'r-2': '10px', 'r-pill': '999px',
  };
  for (const [k, v] of Object.entries(want)) {
    const m = rootBlock.match(new RegExp(`--${k}:\\s*([^;]+);`));
    assert.equal(m && m[1].trim(), v, `--${k}`);
  }
});
