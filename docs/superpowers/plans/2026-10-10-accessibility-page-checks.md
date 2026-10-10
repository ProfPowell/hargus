# Accessibility page checks: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add our own, dependency-free accessibility page checks:
- contrast for all visible text, with WCAG 2 scored and APCA advisory;
- outline-grade structure rules;
- target size, small text and focus order;
- a focus-style probe that forces `:focus-visible` through CDP.

Also remove the duplicated heading and `<main>` findings.

**Architecture:**
- A new pure `extension/core/color.js` holds the colour maths.
- Two new page-phase plugins: `contrast` and `a11y-structure`. Each has a self-contained `collect()` and a pure, unit-tested analysis.
- A capture-time `focusProbe()` in `extension/browser/capture.js` writes `hp.capture.focus`, which `a11y-structure` reads. A pure helper module `extension/core/focus.js` is shared by both.
- `a11y-basics`, `html` and `content` drop the duplicated findings.

**Tech Stack:** Vanilla ES modules with no dependencies. Chrome DevTools Protocol (`DOM`, `CSS.forcePseudoState`). `node --test` for unit tests and Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-10-10-accessibility-page-checks-design.md`

## Global Constraints

- No new dependencies; axe stays optional.
- Both new plugins: `area: 'accessibility'`, `group: 'quality'`, `phase: 'page'`. Every finding uses `category: 'accessibility'`.
- **WCAG contrast:** a pair passes at ratio ≥ 4.5, or ≥ 3 for large text. Large text is font-size ≥ 24 px, or ≥ 18.66 px with weight ≥ 700.
- **APCA (advisory):** a pair passes at |Lc| ≥ 75 for normal text, or ≥ 60 for large text. APCA-W3 0.0.98G-4g constants exactly as in the spec.
- **Contrast limits:**
  - collect up to 4000 elements or 2000 ms;
  - keep 20 stored pairs;
  - medium findings for the 10 worst failing pairs, then "…and N more failing colour pairs".
- **Finding titles:** use the spec's exact titles, verbatim.
- **Focus probe:**
  - on by default (`capture.focusCheck: true`), with a 10 s timeout;
  - samples at most one element of each of 8 kinds;
  - always removes the forced states and the `data-harplus-focus` attributes.
- **Commits:** every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. If the harness's attribution line names a different model, use the harness's line; that's accepted.
- **Tests:** run `npm test` before every commit. Task 6 runs `npm run test:e2e`, never two runs at once.

**Ordering change from the spec:** the focus probe runs **before** the page-phase plugins, not after them. `a11y-structure` is itself a page-phase plugin and reads `hp.capture.focus`, so the probe must have finished first. The probe doesn't change the page, so running it first changes nothing else.

## Review Focus

1. **A page with thousands of text nodes**, such as ucsd.edu. The contrast collect must stop at its 2 s / 4000-element budget, set `truncated`, and never fail the reading. Task 2 tests the truncated flag through `run()`. The e2e covers the real budget.
2. **Text on gradients or background images, and text overlapping images.** It must be marked unknown and never reported as a failing pair. Task 2 tests this.
3. **The focus probe on a page with no focusable elements, or when the debugger detaches mid-probe.** No throw escapes, no attributes are left behind, and the reading continues. Task 4 handles it with `try`/`finally` plus the outer timeout. Task 6's e2e asserts that no attributes are left.
4. **Old readings with no `capture.focus`, and the CLI.** `a11y-structure` raises no focus findings and still produces its other findings. Task 3 tests this.
5. **Removing the duplicates must not remove the only copy.** After clean-up, skipped and empty headings and a missing `<main>` are still reported, by `a11y-structure`. Task 5 asserts both the absence and the presence.

---

### Task 1: Colour maths (`extension/core/color.js`)

**Files:**
- Create: `extension/core/color.js`
- Test: `test/color.test.mjs`

**Interfaces:**
- Produces:
  - `parseRgb(str) → { r, g, b, a } | null`. Accepts `#rrggbb`, `rgb()` and `rgba()`, with space or comma syntax and an optional `/ alpha`.
  - `composite(top, bottom) → { r, g, b, a: 1 }`.
  - `toHex({ r, g, b }) → '#rrggbb'`.
  - `relLum(rgb) → number`.
  - `wcagRatio(a, b) → number`.
  - `apcaLc(text, bg) → number`, signed, ×100.

- [ ] **Step 1: Write the failing test** in `test/color.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { parseRgb, composite, toHex, relLum, wcagRatio, apcaLc } from '../extension/core/color.js';

  test('parseRgb: hex, rgb(), rgba() with comma or slash syntax', () => {
    assert.deepEqual(parseRgb('#ff8000'), { r: 255, g: 128, b: 0, a: 1 });
    assert.deepEqual(parseRgb('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
    assert.deepEqual(parseRgb('rgba(1, 2, 3, 0.5)'), { r: 1, g: 2, b: 3, a: 0.5 });
    assert.deepEqual(parseRgb('rgb(1 2 3 / 50%)'), { r: 1, g: 2, b: 3, a: 0.5 });
    assert.equal(parseRgb('oklch(50% 0.1 20)'), null);
    assert.equal(parseRgb(''), null);
  });

  test('composite and hex', () => {
    assert.deepEqual(composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 }), { r: 128, g: 128, b: 128, a: 1 });
    assert.equal(toHex({ r: 153, g: 153, b: 153 }), '#999999');
    assert.equal(toHex({ r: 300, g: -4, b: 15.6 }), '#ff0010');
  });

  test('WCAG 2 ratios (reference values)', () => {
    const w = parseRgb('#ffffff');
    assert.equal(relLum(w).toFixed(3), '1.000');
    assert.equal(wcagRatio(parseRgb('#000000'), w).toFixed(2), '21.00');
    assert.equal(wcagRatio(parseRgb('#777777'), w).toFixed(2), '4.48');
    assert.equal(wcagRatio(parseRgb('#767676'), w).toFixed(2), '4.54');
    assert.equal(wcagRatio(w, parseRgb('#767676')).toFixed(2), '4.54', 'order-independent');
  });

  test('APCA-W3 Lc (reference values ±1)', () => {
    const near = (a, b) => assert.ok(Math.abs(a - b) <= 1, `${a} ≈ ${b}`);
    near(apcaLc(parseRgb('#000000'), parseRgb('#ffffff')), 106.04);
    near(apcaLc(parseRgb('#ffffff'), parseRgb('#000000')), -107.88);
    near(apcaLc(parseRgb('#888888'), parseRgb('#ffffff')), 63.06);
    assert.equal(apcaLc(parseRgb('#777777'), parseRgb('#777777')), 0);
  });
  ```

- [ ] **Step 2: Run it to watch it fail**

  Run: `node --test test/color.test.mjs`

  Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `extension/core/color.js`:**

  ```js
  // Colour maths for contrast checks: parsing, compositing, WCAG 2 contrast ratio and APCA-W3 Lc.
  // Pure (no DOM): shared by the contrast plugin and its tests.

  export function parseRgb(str) {
    const s = String(str || '').trim();
    const hex = s.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
    if (!m) return null;
    const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  }

  /** Source-over: top (with alpha) over an opaque bottom. */
  export function composite(top, bottom) {
    const a = top.a ?? 1;
    const mix = (t, b) => Math.round(t * a + b * (1 - a));
    return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
  }

  export const toHex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

  /** WCAG 2.x relative luminance. */
  export function relLum({ r, g, b }) {
    const f = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  export function wcagRatio(a, b) {
    const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  /** APCA-W3 0.0.98G-4g lightness contrast, signed (positive: dark text on light background), ×100. */
  export function apcaLc(text, bg) {
    const y = ({ r, g, b }) => {
      let Y = 0.2126729 * (r / 255) ** 2.4 + 0.7151522 * (g / 255) ** 2.4 + 0.0721750 * (b / 255) ** 2.4;
      if (Y < 0.022) Y += (0.022 - Y) ** 1.414;
      return Y;
    };
    const yt = y(text);
    const yb = y(bg);
    if (Math.abs(yb - yt) < 0.0005) return 0;
    let lc;
    if (yb > yt) {
      const s = (yb ** 0.56 - yt ** 0.57) * 1.14;
      lc = s < 0.1 ? 0 : s - 0.027;
    } else {
      const s = (yb ** 0.65 - yt ** 0.62) * 1.14;
      lc = s > -0.1 ? 0 : s + 0.027;
    }
    return lc * 100;
  }
  ```

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `node --test test/color.test.mjs`, then `npm test`.

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/core/color.js test/color.test.mjs
  git commit -m "Colour maths: WCAG 2 contrast ratio and APCA-W3 Lc

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 2: The `contrast` plugin

**Files:**
- Create: `extension/plugins/contrast.js`
- Modify: `extension/plugins/index.js` (import it; add it after `a11yBasics` in the first `BUILTIN` row)
- Test: `test/contrast.test.mjs`

**Interfaces:**
- Consumes from Task 1: `parseRgb`, `wcagRatio` and `apcaLc` from `../core/color.js`.
- Produces:
  - the plugin result `data = { pairs: [{ fg, bg, large, ratio, lc, count, samples, pass, apcaPass }], totals: { checked, failing, unknown, truncated } }`;
  - the named export `analyzeContrast(collected)`, which returns `{ data, findings, summary }`.

- [ ] **Step 1: Write the failing tests** in `test/contrast.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import plugin, { analyzeContrast } from '../extension/plugins/contrast.js';
  import { getPlugins } from '../extension/plugins/index.js';
  import { h } from '../extension/ui/render.js';

  const el = (fg, bg, large = false, selector = 'p') => ({ fg, bg, large, selector });
  const titles = (r) => r.findings.map((f) => `${f.severity}:${f.title}`);

  test('registered after a11y-basics as an Accessibility page plugin', () => {
    const ids = getPlugins().map((p) => p.id);
    assert.equal(ids.indexOf('contrast'), ids.indexOf('a11y-basics') + 1);
    assert.equal(plugin.phase, 'page');
    assert.equal(plugin.area, 'accessibility');
  });

  test('groups by pair; AA thresholds 4.5 normal, 3 large', () => {
    const r = analyzeContrast({ elements: [
      el('#777777', '#ffffff'), el('#777777', '#ffffff', false, 'p.b'), // 4.48 → fail
      el('#767676', '#ffffff'), // 4.54 → pass
      el('#949494', '#ffffff', true), // 3.03 large → pass
      el('#959595', '#ffffff', true), // 2.99 large → fail
    ] });
    assert.deepEqual(titles(r), [
      'medium:Text contrast 2.9:1 (#959595 on #ffffff) — 1 elements',
      'medium:Text contrast 4.4:1 (#777777 on #ffffff) — 2 elements',
      'info:2 colour pairs below APCA thresholds (advisory)',
    ]);
    const p = r.data.pairs.find((x) => x.fg === '#777777');
    assert.equal(p.count, 2);
    assert.deepEqual(p.samples, ['p', 'p.b']);
    assert.deepEqual(r.data.totals, { checked: 5, failing: 3, unknown: 0, truncated: false });
    assert.equal(r.summary[0].value, '3 of 5 text elements fail (AA)');
    assert.equal(r.summary[0].rating, 'poor');
  });

  test('ten worst pairs as findings, then "…and N more"', () => {
    const els = Array.from({ length: 13 }, (_, i) => el(`#${(0xa0 + i).toString(16).repeat(3)}`, '#ffffff'));
    const r = analyzeContrast({ elements: els });
    assert.equal(r.findings.filter((f) => f.title.startsWith('Text contrast')).length, 10);
    assert.ok(titles(r).includes('medium:…and 3 more failing colour pairs'));
    assert.match(r.findings[0].title, /#acacac/, 'worst (lowest ratio, ~2.27) first');
    assert.ok(r.data.pairs.length <= 20);
  });

  test('unknown (over images) is counted, never a failing pair; truncation recorded; bad hex ignored', () => {
    const r = analyzeContrast({ truncated: true, elements: [{ unknown: true, large: false, selector: 'h1' }, el('url(x)', '#fff'), el('#000000', '#ffffff')] });
    assert.deepEqual(titles(r), ['info:1 text elements over images could not be checked']);
    assert.deepEqual(r.data.totals, { checked: 1, failing: 0, unknown: 1, truncated: true });
    assert.equal(r.summary[0].rating, 'good');
  });

  test('run() skips without collected data; glance/render escape and only use #rrggbb', () => {
    assert.throws(() => plugin.run({}, { collected: undefined, skip: (m) => { throw new Error(m); } }), /no page data/);
    const out = plugin.run({}, { collected: { elements: [el('#777777', '#ffffff')] }, skip: () => {} });
    const html = String(plugin.glance({ status: 'ok', ...out }, h)) + String(plugin.render({ status: 'ok', ...out }, h));
    assert.match(html, /background:#ffffff/);
    assert.doesNotMatch(html, /NaN|undefined/);
  });
  ```

  These values were hand-checked:
  - WCAG ratios: #959595 ≈ 2.996, #949494 ≈ 3.034, #777777 ≈ 4.478.
  - Titles show the ratio rounded **down** to 1 decimal (2.9, 4.4), so a failing pair never displays a passing-looking 4.5.
  - The APCA-only pairs are #767676 (Lc ≈ 71.6, below 75) and #949494 (large, Lc ≈ 57.1, below 60), which makes 2. Failing WCAG pairs are never counted as APCA-only.

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/contrast.test.mjs`

  Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `extension/plugins/contrast.js`:**

  ```js
  // Contrast: every visible text element's colour against its real (composited) background.
  // WCAG 2 AA is scored; APCA-W3 Lc is advisory. collect() runs in the page (self-contained).

  import { parseRgb, wcagRatio, apcaLc } from '../core/color.js';

  const HEX = /^#[0-9a-f]{6}$/i;

  function collect() {
    const t0 = performance.now();
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = (c) => {
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = 'rgba(0, 0, 0, 0)';
      g.fillStyle = c;
      g.fillRect(0, 0, 1, 1);
      const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
      return { r, g: gg, b, a: a / 255 };
    };
    const over = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
    const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
    const path = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
        let p = n.localName;
        if (n.id) { parts.unshift(`${p}#${n.id}`); break; }
        if (n.classList.length) p += `.${[...n.classList].slice(0, 2).join('.')}`;
        parts.unshift(p);
      }
      return parts.join(' > ');
    };
    const background = (el) => {
      const layers = [];
      for (let n = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
        const c = rgba(cs.backgroundColor);
        if (c.a > 0) { layers.push(c); if (c.a >= 1) break; }
      }
      let base = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
      return base;
    };
    const overMedia = (el) => {
      const r = el.getBoundingClientRect();
      const positioned = (x) => /absolute|fixed/.test(getComputedStyle(x).position);
      for (let p = el.parentElement, d = 0; p && d < 3; p = p.parentElement, d++) {
        for (const m of p.querySelectorAll(':scope > img, :scope > video, :scope > canvas, :scope > svg, :scope > picture')) {
          if (m === el || el.contains(m) || m.contains(el)) continue;
          if (!positioned(m) && !positioned(el)) continue;
          const q = m.getBoundingClientRect();
          if (q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top) return true;
        }
      }
      return false;
    };
    const elements = [];
    let truncated = false;
    const root = document.body || document.documentElement;
    for (const el of root.querySelectorAll('*')) {
      if (elements.length >= 4000 || performance.now() - t0 > 2000) { truncated = true; break; }
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
      if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
      if (!el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible') continue;
      if (el.closest('[aria-hidden="true"], [hidden]')) continue;
      if (el.matches(':disabled, [aria-disabled="true"]') || el.closest('label')?.control?.disabled) continue;
      const fg = rgba(cs.color);
      let op = 1;
      for (let n = el; n; n = n.parentElement) {
        const o = parseFloat(getComputedStyle(n).opacity);
        op *= Number.isFinite(o) ? o : 1;
      }
      const alpha = fg.a * op;
      if (alpha <= 0) continue;
      const size = parseFloat(cs.fontSize) || 16;
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const bg = background(el);
      if (!bg || overMedia(el)) { elements.push({ unknown: true, large, selector: path(el) }); continue; }
      elements.push({ fg: hex(over({ ...fg, a: alpha }, bg)), bg: hex(bg), large, selector: path(el) });
    }
    return { elements, truncated };
  }

  export function analyzeContrast(c) {
    const els = c?.elements || [];
    const unknown = els.filter((e) => e.unknown).length;
    const map = new Map();
    for (const e of els) {
      if (e.unknown || !HEX.test(e.fg) || !HEX.test(e.bg)) continue;
      const fg = e.fg.toLowerCase();
      const bg = e.bg.toLowerCase();
      const k = `${fg}|${bg}|${e.large ? 1 : 0}`;
      let p = map.get(k);
      if (!p) {
        const f = parseRgb(fg);
        const b = parseRgb(bg);
        p = { fg, bg, large: !!e.large, ratio: wcagRatio(f, b), lc: apcaLc(f, b), count: 0, samples: [] };
        map.set(k, p);
      }
      p.count++;
      if (p.samples.length < 3) p.samples.push(e.selector);
    }
    const pairs = [...map.values()].map((p) => ({ ...p, pass: p.ratio >= (p.large ? 3 : 4.5), apcaPass: Math.abs(p.lc) >= (p.large ? 60 : 75) }));
    const failing = pairs.filter((p) => !p.pass).sort((a, b) => a.ratio - b.ratio);
    const apcaOnly = pairs.filter((p) => p.pass && !p.apcaPass).sort((a, b) => Math.abs(a.lc) - Math.abs(b.lc));
    const checked = pairs.reduce((n, p) => n + p.count, 0);
    const failingEls = failing.reduce((n, p) => n + p.count, 0);
    const findings = failing.slice(0, 10).map((p) => ({
      severity: 'medium', category: 'accessibility',
      title: `Text contrast ${(Math.floor(p.ratio * 10) / 10).toFixed(1)}:1 (${p.fg} on ${p.bg}) — ${p.count} elements`, // floor: a fail never reads 4.5
      detail: `Needs ${p.large ? '3' : '4.5'}:1${p.large ? ' (large text)' : ''}. APCA Lc ${Math.round(p.lc)}.`,
      evidence: p.samples.join('\n'),
    }));
    if (failing.length > 10) findings.push({ severity: 'medium', category: 'accessibility', title: `…and ${failing.length - 10} more failing colour pairs` });
    if (unknown) findings.push({ severity: 'info', category: 'accessibility', title: `${unknown} text elements over images could not be checked` });
    if (apcaOnly.length) findings.push({ severity: 'info', category: 'accessibility', title: `${apcaOnly.length} colour pairs below APCA thresholds (advisory)` });
    const share = checked ? failingEls / checked : 0;
    return {
      data: { pairs: [...failing, ...apcaOnly].slice(0, 20), totals: { checked, failing: failingEls, unknown, truncated: !!c?.truncated } },
      findings,
      summary: [{ label: 'Contrast', value: `${failingEls} of ${checked} text elements fail (AA)`, rating: failingEls === 0 ? 'good' : share < 0.1 ? 'needs-improvement' : 'poor', headline: true }],
    };
  }

  function run(reading, ctx) {
    if (!ctx.collected) ctx.skip('no page data');
    return analyzeContrast(ctx.collected);
  }

  const swatch = (h, p) => (HEX.test(p.fg) && HEX.test(p.bg)
    ? h.html`<span class="swatch" style="color:${p.fg};background:${p.bg}">Aa</span>` : '');

  function glance(r, h) {
    const t = r.data.totals;
    const rows = r.data.pairs.slice(0, 8);
    return h.html`<section class="card"><h4>Text contrast · ${t.failing} of ${t.checked} fail</h4>
      ${rows.length ? h.html`<ul class="contrast-pairs">${rows.map((p) => h.html`<li>${swatch(h, p)}<span>${p.ratio.toFixed(2)}:1 · Lc ${Math.round(p.lc)}</span><span class="muted">${p.count} ×</span>${h.icon(p.pass ? 'ok' : 'fail', { size: 14, title: p.pass ? 'passes AA' : 'fails AA' })}</li>`)}</ul>`
        : h.html`<p class="muted">Every checked text element passes AA.</p>`}
      ${t.unknown ? h.html`<p class="note">${t.unknown} over images not checked${t.truncated ? ' · page partly checked (time limit)' : ''}</p>` : ''}</section>`;
  }

  function render(r, h) {
    return h.table(r.data.pairs.map((p) => ({
      swatch: swatch(h, p), fg: p.fg, bg: p.bg, ratio: `${p.ratio.toFixed(2)}:1`, lc: String(Math.round(p.lc)),
      size: p.large ? 'large' : 'normal', count: String(p.count), samples: h.list(p.samples.map((s) => h.html`<code>${s}</code>`)),
    })), [{ key: 'swatch', label: '' }, { key: 'fg', label: 'Text' }, { key: 'bg', label: 'Background' }, { key: 'ratio', label: 'WCAG' },
      { key: 'lc', label: 'APCA Lc' }, { key: 'size', label: 'Size' }, { key: 'count', label: 'Elements' }, { key: 'samples', label: 'Samples' }]);
  }

  export default {
    id: 'contrast',
    name: 'Contrast',
    version: '0.1.0',
    phase: 'page',
    group: 'quality',
    area: 'accessibility',
    description: 'WCAG 2 contrast for every visible text element against its real background, with APCA as advice.',
    tags: ['accessibility'],
    timeoutMs: 15_000,
    collect,
    run,
    glance,
    render,
  };
  ```

  - In `extension/plugins/index.js`, add `import contrast from './contrast.js';` and change the first row to `meta, content, html, css, vitals, images, a11yBasics, contrast, axe,`.
  - In `extension/ui/theme.css`, add:

    ```css
      .swatch { display: inline-grid; place-items: center; width: 2.2rem; height: 1.6rem; border-radius: 4px; border: 1px solid var(--line); font-weight: 600; }
      .contrast-pairs { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.35rem; }
      .contrast-pairs li { display: flex; gap: 0.6rem; align-items: center; }
    ```

  - If `h.table` doesn't render a raw `html` cell value in a column whose label is `''`, keep the label `'Swatch'` instead.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `node --test test/contrast.test.mjs`, then `npm test`.

  Expected: PASS, after the documented APCA count check from Step 1. If an existing test asserts `BUILTIN` order or count, update it, and say why.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/core/color.js extension/plugins/contrast.js extension/plugins/index.js extension/ui/theme.css test/contrast.test.mjs
  git commit -m "Contrast plugin: WCAG 2 AA on every visible text element, APCA advisory, grouped colour pairs

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 3: The `a11y-structure` plugin (and `extension/core/focus.js`)

**Files:**
- Create: `extension/core/focus.js`
- Create: `extension/plugins/a11y-structure.js`
- Modify: `extension/plugins/index.js` (add `a11yStructure` right after `contrast`)
- Test: `test/a11y-structure.test.mjs`

**Interfaces:**
- Produces:
  - **`extension/core/focus.js`**, consumed by Task 4:
    - `FOCUS_KINDS = ['inline-link','nav-link','button','text-input','select','checkbox','summary','custom']`;
    - `KIND_LABELS`, mapping each kind to its plural label;
    - `focusChanges(before, after) → string[]`, the changed property names out of `outline`, `box-shadow`, `border`, `background`, `underline`, `color`.
  - **The plugin's `analyzeStructure(collected, { mobile, focus })`**, which returns `{ data, findings, summary }`.
  - **The shape `focus` takes** (`hp.capture.focus`, written by Task 4): `{ samples: [{ kind, selector, changed: string[] }], outlineNone: number }`.

- [ ] **Step 1: Write the failing tests** in `test/a11y-structure.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import plugin, { analyzeStructure } from '../extension/plugins/a11y-structure.js';
  import { focusChanges, FOCUS_KINDS, KIND_LABELS } from '../extension/core/focus.js';
  import { getPlugins } from '../extension/plugins/index.js';
  import { h } from '../extension/ui/render.js';

  const none = { count: 0, samples: [] };
  const bag = (n) => ({ count: n, samples: Array.from({ length: Math.min(n, 5) }, (_, i) => ({ selector: `x${i}`, text: 't' })) });
  const base = (over = {}) => ({
    headings: [{ level: 1, text: 'Home', selector: 'h1' }], hiddenHeadings: [],
    landmarks: { mains: 1, hasMain: true, navs: ['Main'], asides: [], banners: 1, contentinfos: 1 },
    labelInName: none, httpLinks: none, multiText: none, noCurrent: 0, labelRefs: none, ariaRefs: none,
    badAlt: none, badAuto: none, resetButtons: 0, targets24: none, targets44: none, smallText: { count: 0 },
    smallFields: none, focusJumps: none, noRole: none, ...over,
  });
  const t = (r) => r.findings.map((f) => `${f.severity}:${f.title}`);

  test('registered after contrast; page phase, Accessibility', () => {
    const ids = getPlugins().map((p) => p.id);
    assert.equal(ids.indexOf('a11y-structure'), ids.indexOf('contrast') + 1);
    assert.equal(plugin.phase, 'page');
    assert.equal(plugin.area, 'accessibility');
  });

  test('clean page: no findings', () => {
    assert.deepEqual(t(analyzeStructure(base())), []);
  });

  test('headings: skipped, empty, duplicates; hidden headings ignored', () => {
    const r = analyzeStructure(base({
      headings: [{ level: 1, text: 'Home' }, { level: 3, text: 'Deep' }, { level: 2, text: '' }, { level: 2, text: 'deep ' }],
      hiddenHeadings: [{ level: 5, text: 'menu' }],
    }));
    assert.deepEqual(t(r), ['low:1 skipped heading levels', 'medium:1 empty headings', 'info:1 duplicate heading texts']);
  });

  test('landmarks', () => {
    assert.deepEqual(t(analyzeStructure(base({ landmarks: { mains: 0, hasMain: false, navs: [], asides: [], banners: 0, contentinfos: 0 } }))), ['low:No <main> landmark']);
    assert.deepEqual(t(analyzeStructure(base({ landmarks: { mains: 2, hasMain: true, navs: ['', ''], asides: ['a', 'a'], banners: 2, contentinfos: 2 } }))), [
      'medium:2 main landmarks', 'low:2 navigation landmarks without distinct labels', 'low:2 complementary landmarks without distinct labels',
      'low:Multiple banner landmarks', 'low:Multiple contentinfo landmarks',
    ]);
    assert.deepEqual(t(analyzeStructure(base({ landmarks: { mains: 1, hasMain: true, navs: ['Main', 'Footer'], asides: [], banners: 1, contentinfos: 1 } }))), []);
  });

  test('names, links, references, alt, autocomplete, reset', () => {
    const r = analyzeStructure(base({
      labelInName: bag(2), httpLinks: bag(3), multiText: bag(1), noCurrent: 1, labelRefs: bag(1), ariaRefs: bag(2),
      badAlt: bag(4), badAuto: bag(1), resetButtons: 1,
    }));
    assert.deepEqual(t(r), [
      'medium:2 controls whose accessible name hides their visible label (WCAG 2.5.3)',
      'low:3 links use plain HTTP', 'info:1 URLs linked with different text', 'info:Current page link has no aria-current',
      'medium:1 label or description references point to missing ids', 'low:2 ARIA references point to missing ids',
      'low:4 images with unhelpful alt text', 'low:1 invalid autocomplete values (WCAG 1.3.5)', 'info:Reset button present',
    ]);
    assert.equal(r.findings[0].evidence, 'x0\nx1');
  });

  test('targets and small text; mobile-only advisories', () => {
    const c = base({ targets24: bag(3), targets44: bag(9), smallText: { count: 12 }, smallFields: bag(2) });
    assert.deepEqual(t(analyzeStructure(c)), ['medium:3 targets smaller than 24×24 px (WCAG 2.5.8)', 'low:12 text elements under 12 px']);
    assert.deepEqual(t(analyzeStructure(c, { mobile: true })), [
      'medium:3 targets smaller than 24×24 px (WCAG 2.5.8)', 'info:9 targets under 44×44 px (advisory)',
      'low:12 text elements under 12 px', 'low:2 form fields under 16 px (iOS zooms in)',
    ]);
  });

  test('focus order and role-less focusables', () => {
    assert.deepEqual(t(analyzeStructure(base({ focusJumps: bag(2), noRole: bag(1) }))), ['low:Focus order jumps back up the page 2 times', 'low:1 focusable elements without a role']);
  });

  test('focus styles: none at all → one medium; some → low per kind; outline-none detail; absent → nothing', () => {
    const s = (kind, changed) => ({ kind, selector: kind, changed });
    const all = analyzeStructure(base(), { focus: { samples: [s('button', []), s('inline-link', [])], outlineNone: 2 } });
    assert.deepEqual(t(all), ['medium:No visible focus indicator on any sampled control (WCAG 2.4.7)']);
    assert.equal(all.findings[0].detail, 'Stylesheets remove the focus outline in 2 rules without a replacement.');
    const some = analyzeStructure(base(), { focus: { samples: [s('button', ['outline']), s('inline-link', [])], outlineNone: 0 } });
    assert.deepEqual(t(some), ['low:Inline links show no visible focus indicator']);
    assert.equal(some.findings[0].detail, undefined);
    assert.deepEqual(t(analyzeStructure(base(), { focus: { samples: [s('button', [])], outlineNone: 0 } })), ['low:Buttons show no visible focus indicator'], 'one kind is not "all"');
    assert.deepEqual(t(analyzeStructure(base(), { focus: undefined })), []);
  });

  test('focusChanges and kind labels', () => {
    const b = { outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgb(0, 0, 0)', boxShadow: 'none', borderColor: 'rgb(0, 0, 0)', borderWidth: '0px', backgroundColor: 'rgba(0, 0, 0, 0)', textDecorationLine: 'none', color: 'rgb(0, 0, 0)' };
    assert.deepEqual(focusChanges(b, { ...b, outlineStyle: 'auto', outlineWidth: '1px' }), ['outline']);
    assert.deepEqual(focusChanges(b, { ...b, outlineColor: 'red' }), [], 'outline colour alone with style none is invisible');
    assert.deepEqual(focusChanges(b, { ...b, boxShadow: '0 0 0 2px blue', textDecorationLine: 'underline' }), ['box-shadow', 'underline']);
    assert.deepEqual(focusChanges(b, b), []);
    assert.deepEqual(focusChanges(undefined, b), []);
    assert.equal(FOCUS_KINDS.length, 8);
    assert.equal(KIND_LABELS.checkbox, 'Checkboxes and radios');
  });

  test('run(): mobile from the base view, focus from capture; summary and glance without NaN', () => {
    const reading = { log: { entries: [], _harplus: { capture: { device: 'mobile', focus: { samples: [{ kind: 'button', selector: 'button', changed: ['outline'] }], outlineNone: 0 } } } } };
    const out = plugin.run(reading, { collected: base({ targets44: bag(1) }), skip: () => {} });
    assert.ok(out.findings.some((f) => f.title === '1 targets under 44×44 px (advisory)'));
    assert.ok(out.summary.some((s) => s.label === 'Focus' && s.value === '1 of 1 kinds visible'));
    const html = String(plugin.glance({ status: 'ok', ...out }, h)) + String(plugin.render({ status: 'ok', ...out }, h));
    assert.doesNotMatch(html, /NaN|undefined/);
    assert.throws(() => plugin.run({ log: { _harplus: {} } }, { collected: undefined, skip: (m) => { throw new Error(m); } }), /no page data/);
  });
  ```

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/a11y-structure.test.mjs`

  Expected: FAIL, because the modules aren't found.

- [ ] **Step 3a: Implement `extension/core/focus.js`:**

  ```js
  // Focus-style probe helpers shared by capture (which forces :focus-visible via CDP) and the
  // a11y-structure plugin (which turns the result into findings). Pure.

  export const FOCUS_KINDS = ['inline-link', 'nav-link', 'button', 'text-input', 'select', 'checkbox', 'summary', 'custom'];
  export const KIND_LABELS = {
    'inline-link': 'Inline links', 'nav-link': 'Navigation links', button: 'Buttons', 'text-input': 'Text fields',
    select: 'Select menus', checkbox: 'Checkboxes and radios', summary: 'Disclosure summaries', custom: 'Custom controls',
  };

  /** Which visible style properties changed between the unfocused and forced-focus computed styles. */
  export function focusChanges(before, after) {
    if (!before || !after) return [];
    const out = [];
    const outlineOn = after.outlineStyle !== 'none' && parseFloat(after.outlineWidth) > 0;
    if (outlineOn && (before.outlineStyle !== after.outlineStyle || before.outlineWidth !== after.outlineWidth || before.outlineColor !== after.outlineColor)) out.push('outline');
    if (before.boxShadow !== after.boxShadow) out.push('box-shadow');
    if (before.borderColor !== after.borderColor || before.borderWidth !== after.borderWidth) out.push('border');
    if (before.backgroundColor !== after.backgroundColor) out.push('background');
    if (before.textDecorationLine !== after.textDecorationLine) out.push('underline');
    if (before.color !== after.color) out.push('color');
    return out;
  }
  ```

- [ ] **Step 3b: Implement `extension/plugins/a11y-structure.js`:**

  ```js
  // Structure: outline-grade accessibility rules (headings, landmarks, names, links, references, alt,
  // autocomplete, target size, small text, focus order) plus focus-style findings from the capture's
  // focus probe. collect() runs in the page (self-contained); analyzeStructure() is pure.

  import { baseView } from '../core/views.js';
  import { KIND_LABELS } from '../core/focus.js';

  function collect() {
    const $$ = (s) => [...document.querySelectorAll(s)];
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible' && !el.closest('[aria-hidden="true"], [hidden]');
    const path = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
        let p = n.localName;
        if (n.id) { parts.unshift(`${p}#${n.id}`); break; }
        if (n.classList.length) p += `.${[...n.classList].slice(0, 2).join('.')}`;
        parts.unshift(p);
      }
      return parts.join(' > ');
    };
    const text = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const byIds = (ids) => String(ids || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean);
    const name = (el) => el.getAttribute('aria-label')?.trim() || byIds(el.getAttribute('aria-labelledby')).map(text).join(' ')
      || text(el) || el.getAttribute('title')?.trim() || [...el.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ').trim();
    const sample = (el, label) => ({ selector: path(el), text: String(label ?? text(el)).slice(0, 80) });
    const bag = (els, f = (e) => sample(e)) => ({ count: els.length, samples: els.slice(0, 5).map(f) });

    const headings = [];
    const hiddenHeadings = [];
    for (const el of $$('h1, h2, h3, h4, h5, h6, [role="heading"]')) {
      const level = Number(el.getAttribute('aria-level')) || (/^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : 2);
      (shown(el) ? headings : hiddenHeadings).push({ level, text: name(el).slice(0, 200), selector: path(el) });
    }

    const labelOf = (el) => el.getAttribute('aria-label')?.trim() || byIds(el.getAttribute('aria-labelledby')).map(text).join(' ') || '';
    const topLevel = (el) => !el.parentElement?.closest('article, aside, main, nav, section');
    const landmarks = {
      mains: $$('main, [role="main"]').filter(shown).length,
      hasMain: !!document.querySelector('main, [role="main"]'),
      navs: $$('nav, [role="navigation"]').filter(shown).map(labelOf),
      asides: $$('aside, [role="complementary"]').filter(shown).map(labelOf),
      banners: $$('header, [role="banner"]').filter((el) => shown(el) && (el.getAttribute('role') === 'banner' || topLevel(el))).length,
      contentinfos: $$('footer, [role="contentinfo"]').filter((el) => shown(el) && (el.getAttribute('role') === 'contentinfo' || topLevel(el))).length,
    };

    const labelInName = $$('a, button, [role="button"], [role="link"]').filter((el) => {
      if (!shown(el)) return false;
      const vis = norm(text(el));
      const al = norm(el.getAttribute('aria-label'));
      return vis && al && !al.includes(vis);
    });

    const https = location.protocol === 'https:';
    const links = $$('a[href]').filter(shown);
    const httpLinks = https ? links.filter((a) => /^http:/i.test(a.getAttribute('href') || '') || a.href.startsWith('http:')) : [];
    const byHref = new Map();
    for (const a of links) {
      const u = a.href.split('#')[0];
      const tx = norm(text(a) || a.getAttribute('aria-label'));
      if (!tx) continue;
      if (!byHref.has(u)) byHref.set(u, new Set());
      byHref.get(u).add(tx);
    }
    const multi = [...byHref].filter(([, s]) => s.size > 1);
    const here = location.href.split('#')[0];
    const noCurrent = $$('nav a[href]').filter((a) => shown(a) && a.href.split('#')[0] === here && !a.hasAttribute('aria-current')).length;

    const missing = (attr) => $$(`[${attr}]`).filter((el) => String(el.getAttribute(attr) || '').split(/\s+/).filter(Boolean).some((id) => !document.getElementById(id)));
    const labelRefs = [...missing('aria-labelledby'), ...missing('aria-describedby'), ...$$('label[for]').filter((l) => l.htmlFor && !document.getElementById(l.htmlFor))];
    const ariaRefs = [...missing('aria-controls'), ...missing('aria-owns'), ...missing('aria-activedescendant')];

    const BAD_ALT = [/^(image|photo|picture|graphic|icon) of\b/i, /^(image|photo|picture|placeholder|img|graphic|logo)$/i, /\.(jpe?g|png|gif|webp|avif|svg)$/i, /^[\w-]*\d{3,}[\w-]*$/];
    const badAlt = $$('img[alt]').filter((i) => { const a = i.getAttribute('alt').trim(); return a && (a.length > 150 || BAD_ALT.some((r) => r.test(a))); });

    const AUTOFILL = new Set(['name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name', 'honorific-suffix', 'nickname', 'username', 'new-password', 'current-password', 'one-time-code', 'organization-title', 'organization', 'street-address', 'address-line1', 'address-line2', 'address-line3', 'address-level4', 'address-level3', 'address-level2', 'address-level1', 'country', 'country-name', 'postal-code', 'cc-name', 'cc-given-name', 'cc-additional-name', 'cc-family-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-type', 'transaction-currency', 'transaction-amount', 'language', 'bday', 'bday-day', 'bday-month', 'bday-year', 'sex', 'url', 'photo', 'tel', 'tel-country-code', 'tel-national', 'tel-area-code', 'tel-local', 'tel-extension', 'email', 'impp', 'webauthn',
      'on', 'off', 'shipping', 'billing', 'home', 'work', 'mobile', 'fax', 'pager']);
    const badAuto = $$('input[autocomplete], select[autocomplete], textarea[autocomplete]').filter((el) => {
      const toks = String(el.getAttribute('autocomplete')).trim().toLowerCase().split(/\s+/).filter(Boolean);
      return toks.length && !toks.every((tk) => AUTOFILL.has(tk) || tk.startsWith('section-'));
    });
    const resetButtons = $$('input[type="reset" i], button[type="reset" i]').length;

    const TARGET = 'a[href], button, input:not([type="hidden" i]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
    const targets = $$(TARGET).filter(shown).slice(0, 1500).map((el) => {
      const r = el.getBoundingClientRect();
      const inline = el.tagName === 'A' && getComputedStyle(el).display === 'inline'
        && (el.parentElement?.textContent || '').trim().length > (el.textContent || '').trim().length;
      return { el, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, inline };
    });
    const small24 = targets.filter((tg) => !tg.inline && (tg.w < 24 || tg.h < 24)
      && targets.some((o) => o !== tg && Math.hypot(o.cx - tg.cx, o.cy - tg.cy) < 24)).map((tg) => tg.el);
    const small44 = targets.filter((tg) => !tg.inline && (tg.w < 44 || tg.h < 44)).map((tg) => tg.el);

    let smallText = 0;
    let walked = 0;
    for (const el of (document.body || document.documentElement).querySelectorAll('*')) {
      if (++walked > 4000) break;
      if (!/\S/.test([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''))) continue;
      if (!shown(el)) continue;
      if (parseFloat(getComputedStyle(el).fontSize) < 12) smallText++;
    }
    const smallFields = $$('input:not([type="hidden" i]):not([type="checkbox" i]):not([type="radio" i]):not([type="submit" i]):not([type="button" i]), select, textarea')
      .filter((el) => shown(el) && parseFloat(getComputedStyle(el).fontSize) < 16);

    const focusables = $$('a[href], button, input:not([type="hidden" i]), select, textarea, summary, [tabindex], [contenteditable="true"], iframe')
      .filter((el) => shown(el) && !el.matches(':disabled') && el.tabIndex >= 0);
    const order = [...focusables.filter((el) => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex), ...focusables.filter((el) => el.tabIndex === 0)];
    const jumps = [];
    for (let i = 1; i < order.length; i++) {
      const a = order[i - 1].getBoundingClientRect();
      const b = order[i].getBoundingClientRect();
      if (b.top < a.top - 200 && b.left < a.right && b.right > a.left) jumps.push(order[i]);
    }
    const noRole = $$('div[tabindex], span[tabindex]').filter((el) => el.tabIndex >= 0 && !el.getAttribute('role') && shown(el));

    return {
      headings, hiddenHeadings, landmarks,
      labelInName: bag(labelInName, (el) => sample(el, `${text(el)} ≠ ${el.getAttribute('aria-label')}`)),
      httpLinks: bag(httpLinks, (a) => sample(a, a.href)),
      multiText: { count: multi.length, samples: multi.slice(0, 5).map(([u, s]) => ({ selector: u, text: [...s].slice(0, 3).join(' | ') })) },
      noCurrent,
      labelRefs: bag(labelRefs), ariaRefs: bag(ariaRefs),
      badAlt: bag(badAlt, (i) => sample(i, i.getAttribute('alt'))),
      badAuto: bag(badAuto, (el) => sample(el, el.getAttribute('autocomplete'))),
      resetButtons,
      targets24: bag(small24), targets44: bag(small44),
      smallText: { count: smallText },
      smallFields: bag(smallFields),
      focusJumps: bag(jumps), noRole: bag(noRole),
    };
  }

  const n = (b) => Number(b?.count) || 0;
  const ev = (b) => (b?.samples?.length ? b.samples.map((s) => s.selector).join('\n') : undefined);

  export function analyzeStructure(c, { mobile = false, focus } = {}) {
    const findings = [];
    const add = (severity, title, evidence, detail) => findings.push({ severity, category: 'accessibility', title, ...(evidence ? { evidence } : {}), ...(detail ? { detail } : {}) });
    const heads = c.headings || [];
    let skipped = 0;
    heads.forEach((x, i) => { if (i && x.level > heads[i - 1].level + 1) skipped++; });
    const empty = heads.filter((x) => !String(x.text || '').trim()).length;
    const seen = new Map();
    for (const x of heads) { const k = String(x.text || '').toLowerCase().replace(/\s+/g, ' ').trim(); if (k) seen.set(k, (seen.get(k) || 0) + 1); }
    const dupes = [...seen.values()].filter((v) => v > 1).length;
    if (skipped) add('low', `${skipped} skipped heading levels`);
    if (empty) add('medium', `${empty} empty headings`);
    if (dupes) add('info', `${dupes} duplicate heading texts`);

    const L = c.landmarks || {};
    if (!L.hasMain) add('low', 'No <main> landmark');
    if ((L.mains || 0) > 1) add('medium', `${L.mains} main landmarks`);
    const indistinct = (labels = []) => labels.length >= 2 && new Set(labels.filter(Boolean)).size < labels.length;
    if (indistinct(L.navs)) add('low', `${L.navs.length} navigation landmarks without distinct labels`);
    if (indistinct(L.asides)) add('low', `${L.asides.length} complementary landmarks without distinct labels`);
    if ((L.banners || 0) > 1) add('low', 'Multiple banner landmarks');
    if ((L.contentinfos || 0) > 1) add('low', 'Multiple contentinfo landmarks');

    if (n(c.labelInName)) add('medium', `${n(c.labelInName)} controls whose accessible name hides their visible label (WCAG 2.5.3)`, ev(c.labelInName));
    if (n(c.httpLinks)) add('low', `${n(c.httpLinks)} links use plain HTTP`, ev(c.httpLinks));
    if (n(c.multiText)) add('info', `${n(c.multiText)} URLs linked with different text`, ev(c.multiText));
    if (c.noCurrent) add('info', 'Current page link has no aria-current');
    if (n(c.labelRefs)) add('medium', `${n(c.labelRefs)} label or description references point to missing ids`, ev(c.labelRefs));
    if (n(c.ariaRefs)) add('low', `${n(c.ariaRefs)} ARIA references point to missing ids`, ev(c.ariaRefs));
    if (n(c.badAlt)) add('low', `${n(c.badAlt)} images with unhelpful alt text`, ev(c.badAlt));
    if (n(c.badAuto)) add('low', `${n(c.badAuto)} invalid autocomplete values (WCAG 1.3.5)`, ev(c.badAuto));
    if (c.resetButtons) add('info', 'Reset button present');

    if (n(c.targets24)) add('medium', `${n(c.targets24)} targets smaller than 24×24 px (WCAG 2.5.8)`, ev(c.targets24));
    if (mobile && n(c.targets44)) add('info', `${n(c.targets44)} targets under 44×44 px (advisory)`, ev(c.targets44));
    if (n(c.smallText)) add('low', `${n(c.smallText)} text elements under 12 px`);
    if (mobile && n(c.smallFields)) add('low', `${n(c.smallFields)} form fields under 16 px (iOS zooms in)`, ev(c.smallFields));
    if (n(c.focusJumps)) add('low', `Focus order jumps back up the page ${n(c.focusJumps)} times`, ev(c.focusJumps));
    if (n(c.noRole)) add('low', `${n(c.noRole)} focusable elements without a role`, ev(c.noRole));

    const samples = Array.isArray(focus?.samples) ? focus.samples : [];
    const blind = samples.filter((s) => !(s.changed || []).length);
    const outlineDetail = Number(focus?.outlineNone) > 0 ? `Stylesheets remove the focus outline in ${focus.outlineNone} rules without a replacement.` : undefined;
    if (samples.length >= 2 && blind.length === samples.length) {
      add('medium', 'No visible focus indicator on any sampled control (WCAG 2.4.7)', blind.map((s) => s.selector).join('\n'), outlineDetail);
    } else {
      for (const s of blind) add('low', `${KIND_LABELS[s.kind] || s.kind} show no visible focus indicator`, s.selector, outlineDetail);
    }

    const summary = [
      { label: 'Headings', value: `${heads.length}${skipped ? ` · ${skipped} skipped` : ''}` },
      { label: 'Landmarks', value: `main ${L.mains || 0} · nav ${(L.navs || []).length} · aside ${(L.asides || []).length}` },
      { label: 'Targets', value: `${n(c.targets24)} under 24 px` },
    ];
    if (samples.length) summary.push({ label: 'Focus', value: `${samples.length - blind.length} of ${samples.length} kinds visible`, headline: true, rating: blind.length === 0 ? 'good' : blind.length === samples.length ? 'poor' : 'needs-improvement' });
    return { data: { ...c, mobile, focus: samples.length ? { samples, outlineNone: Number(focus?.outlineNone) || 0 } : null, skipped, empty }, findings, summary };
  }

  function run(reading, ctx) {
    if (!ctx.collected) ctx.skip('no page data');
    const hp = reading.log?._harplus || {};
    return analyzeStructure(ctx.collected, { mobile: baseView(reading) === 'mobile', focus: hp.capture?.focus });
  }

  function glance(r, h) {
    const d = r.data;
    const z = (b) => !(Number(b?.count) > 0);
    return h.html`<div class="glance-grid">
      <section class="card"><h4>Structure</h4>${h.checklist([
        { label: 'Heading levels in order', ok: !d.skipped },
        { label: '<main> landmark', ok: !!d.landmarks?.hasMain },
        { label: 'Labels match accessible names', ok: z(d.labelInName) },
        { label: 'References resolve', ok: z(d.labelRefs) && z(d.ariaRefs) },
        { label: 'Targets at least 24 px', ok: z(d.targets24) },
        { label: 'Focus visible', ok: !d.focus || d.focus.samples.every((s) => s.changed.length) },
      ])}</section>
      ${d.focus ? h.html`<section class="card"><h4>Focus styles (forced :focus-visible)</h4>${h.table(d.focus.samples.map((s) => ({
        kind: s.kind, sample: h.html`<code>${s.selector}</code>`, changed: s.changed.length ? s.changed.join(', ') : 'nothing',
      })), [{ key: 'kind', label: 'Kind' }, { key: 'sample', label: 'Sample' }, { key: 'changed', label: 'Changes on focus' }])}</section>` : ''}
    </div>`;
  }

  function render(r, h) {
    const d = r.data;
    const rows = [
      ['Label not in name', d.labelInName], ['Plain HTTP links', d.httpLinks], ['URLs with different text', d.multiText],
      ['Broken label/description refs', d.labelRefs], ['Broken ARIA refs', d.ariaRefs], ['Unhelpful alt text', d.badAlt],
      ['Invalid autocomplete', d.badAuto], ['Targets under 24 px', d.targets24], ['Small form fields', d.smallFields],
      ['Focus jumps', d.focusJumps], ['Focusable without role', d.noRole],
    ].filter(([, b]) => Number(b?.count) > 0);
    return h.html`
      ${h.sub('Heading outline', h.outline(d.headings || []))}
      ${(d.hiddenHeadings || []).length ? h.sub('Hidden headings (not counted)', h.list(d.hiddenHeadings.map((x) => `h${x.level} ${x.text || '(empty)'}`))) : ''}
      ${rows.length ? h.table(rows.map(([rule, b]) => ({ rule, count: String(b.count), samples: h.list(b.samples.map((s) => h.html`<code>${s.selector}</code> ${s.text}`)) })),
        [{ key: 'rule', label: 'Rule' }, { key: 'count', label: 'Count' }, { key: 'samples', label: 'Samples' }]) : h.html`<p class="muted">No structure issues.</p>`}`;
  }

  export default {
    id: 'a11y-structure',
    name: 'Structure',
    version: '0.1.0',
    phase: 'page',
    group: 'quality',
    area: 'accessibility',
    description: 'Headings, landmarks, label-in-name, links, ARIA references, alt text, autocomplete, target size, focus order and focus styles.',
    tags: ['accessibility'],
    timeoutMs: 15_000,
    collect,
    run,
    glance,
    render,
  };
  ```

  - In `extension/plugins/index.js`, add `import a11yStructure from './a11y-structure.js';` and change the first row to `meta, content, html, css, vitals, images, a11yBasics, contrast, a11yStructure, axe,`.
  - Check that `h.outline` accepts `{ level, text }` items; it's in `extension/ui/render.js`.
  - Check that `h.checklist` takes `{ label, ok }`.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `node --test test/a11y-structure.test.mjs`, then `npm test`.

  Expected: PASS. If a test's hand-written expectation disagrees with the specified code, show the arithmetic and report NEEDS_CONTEXT.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/core/focus.js extension/plugins/a11y-structure.js extension/plugins/index.js test/a11y-structure.test.mjs
  git commit -m "Structure plugin: headings, landmarks, label-in-name, links, references, alt, autocomplete, targets, focus order and focus styles

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 4: The focus-style probe in capture, with its setting

**Files:**
- Modify: `extension/browser/capture.js`: add page functions `focusSamples`, `focusStyles` and `focusUnmark`, a method `focusProbe(hp)`, and the call in `finish()`.
- Modify: `extension/browser/settings.js`: `DEFAULTS.capture.focusCheck: true`.
- Modify: `extension/ui/options.html` and `extension/ui/popup.html`: the toggle.
- Test: `test/views.test.mjs` (settings default). The probe itself is covered by Task 6's e2e.

**Interfaces:**
- Consumes from Task 3: `focusChanges` from `../core/focus.js`.
- Produces: `hp.capture.focus = { samples: [{ kind, selector, changed }], outlineNone }`, written **before** the page-phase plugins run.

- [ ] **Step 1: Write the failing test.** Append to `test/views.test.mjs`:

  ```js
  test('settings: focus-style check on by default', () => {
    assert.equal(DEFAULTS.capture.focusCheck, true);
  });
  ```

- [ ] **Step 2: Run it to watch it fail**

  Run: `node --test test/views.test.mjs`

  Expected: FAIL, because `focusCheck` is undefined.

- [ ] **Step 3: Implement.**

  In `settings.js` `DEFAULTS.capture`, add `focusCheck: true,` after `scroll: true,`.

  In `options.html`, next to the existing capture checkboxes (near the `capture.scroll` control), add:

  ```html
          <label class="chip"><input type="checkbox" data-path="capture.focusCheck"> Focus-style check</label>
  ```

  If `capture.scroll` isn't a chip in options.html, put the new chip in the views fieldset's row.

  In `popup.html`, after the `scroll` label, add:

  ```html
          <label><input type="checkbox" name="focusCheck"> Focus-style check</label>
  ```

  In `capture.js`, import `focusChanges` from `'../core/focus.js'`. Add these page functions next to `prefsProbe`; they must be self-contained:

  ```js
  /** Mark one visible sample per focusable kind with data-harplus-focus; count :focus rules that kill the outline. */
  function focusSamples() {
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible'
      && !el.closest('[aria-hidden="true"], [hidden]') && !el.matches(':disabled');
    const path = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
        let p = n.localName;
        if (n.id) { parts.unshift(`${p}#${n.id}`); break; }
        if (n.classList.length) p += `.${[...n.classList].slice(0, 2).join('.')}`;
        parts.unshift(p);
      }
      return parts.join(' > ');
    };
    const first = (sel, extra = () => true) => [...document.querySelectorAll(sel)].find((el) => shown(el) && extra(el));
    const kinds = [
      ['inline-link', () => first('p a[href], li a[href]', (a) => !a.closest('nav')
        && (a.parentElement.textContent || '').trim().length > (a.textContent || '').trim().length)],
      ['nav-link', () => first('nav a[href]')],
      ['button', () => first('button, [role="button"]')],
      ['text-input', () => first('input[type="text" i], input[type="email" i], input[type="search" i], input[type="tel" i], input[type="url" i], input[type="password" i], input:not([type]), textarea')],
      ['select', () => first('select')],
      ['checkbox', () => first('input[type="checkbox" i], input[type="radio" i]')],
      ['summary', () => first('summary')],
      ['custom', () => first('[tabindex="0"][role]', (el) => !el.matches('a, button, input, select, textarea, summary'))],
    ];
    const samples = [];
    for (const [kind, pick] of kinds) {
      const el = pick();
      if (!el || el.hasAttribute('data-harplus-focus')) continue;
      el.setAttribute('data-harplus-focus', kind);
      samples.push({ kind, selector: path(el) });
    }
    let outlineNone = 0;
    const walk = (rules, depth) => {
      for (const r of rules || []) {
        if (r.selectorText && /:focus/.test(r.selectorText)) {
          const s = r.style;
          const killed = /^(none|0(px)?)$/.test((s.outlineStyle || '').trim()) || s.outlineWidth === '0px' || /^(none|0)\b/.test((s.outline || '').trim());
          const replaced = s.boxShadow || s.border || s.borderColor || s.borderWidth || s.background || s.backgroundColor || s.textDecoration || s.textDecorationLine;
          if (killed && !replaced) outlineNone++;
        }
        if (r.cssRules && depth < 4) walk(r.cssRules, depth + 1);
      }
    };
    for (const sh of document.styleSheets) { try { walk(sh.cssRules, 0); } catch { /* cross-origin sheet */ } }
    return { samples, outlineNone };
  }

  /** Computed focus-relevant styles of each marked sample, keyed by kind. */
  function focusStyles() {
    const out = {};
    for (const el of document.querySelectorAll('[data-harplus-focus]')) {
      const cs = getComputedStyle(el);
      out[el.getAttribute('data-harplus-focus')] = {
        outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow,
        borderColor: cs.borderColor, borderWidth: cs.borderWidth, backgroundColor: cs.backgroundColor,
        textDecorationLine: cs.textDecorationLine, color: cs.color,
      };
    }
    return out;
  }

  function focusUnmark() {
    for (const el of document.querySelectorAll('[data-harplus-focus]')) el.removeAttribute('data-harplus-focus');
  }
  ```

  Add this method to the capture class, next to `resetA11y`:

  ```js
    /** Force :focus/:focus-visible on one sample per kind via CDP (no focus events, no page scripts) and diff styles. */
    async focusProbe(hp) {
      const marked = await this.evaluate(focusSamples, null, 'main');
      const nodes = [];
      try {
        if (!marked?.samples?.length) { hp.capture.focus = { samples: [], outlineNone: marked?.outlineNone || 0 }; return; }
        const before = await this.evaluate(focusStyles, null, 'main');
        await this.send('DOM.enable');
        await this.send('CSS.enable');
        const { root } = await this.send('DOM.getDocument', { depth: 0 });
        const { nodeIds } = await this.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-harplus-focus]' });
        for (const nodeId of nodeIds) {
          nodes.push(nodeId);
          await this.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
        }
        const after = await this.evaluate(focusStyles, null, 'main');
        hp.capture.focus = {
          samples: marked.samples.map((s) => ({ ...s, changed: focusChanges(before?.[s.kind], after?.[s.kind]) })),
          outlineNone: marked.outlineNone || 0,
        };
      } finally {
        for (const nodeId of nodes) await this.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {});
        await this.evaluate(focusUnmark, null, 'main').catch(() => {});
        await this.send('CSS.disable').catch(() => {});
        await this.send('DOM.disable').catch(() => {});
      }
    }
  ```

  In `finish()`, inside `if (live) {` and BEFORE `this.report('sensing', …)` / `runPlugins`, add:

  ```js
        if (settings?.capture?.focusCheck !== false && !this.detached) {
          await withTimeout(this.focusProbe(reading.log._harplus), 10_000, 'focus probe')
            .catch((e) => this.warnings.push(`focus probe failed: ${e.message}`));
        }
  ```

  - **Check that `DOM.disable` is safe.** If other code in capture.js relies on the DOM domain staying enabled (search for `'DOM.`), remove the `DOM.disable` line and say so in the report.
  - `this.warnings` is the same array the reading's `capture.warnings` refers to; check this, so the late warnings appear in the reading.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS. The probe's behaviour is verified by Task 6's e2e.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/browser/capture.js extension/browser/settings.js extension/ui/options.html extension/ui/popup.html test/views.test.mjs
  git commit -m "Capture: focus-style probe forcing :focus-visible via CDP, on by default

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 5: Remove the duplicated checks

**Files:**
- Modify: `extension/plugins/a11y-basics.js` (remove the `heading-order`, `empty-heading` and `landmark-main` rules; update the render note)
- Modify: `extension/plugins/html.js` (remove the `No <main> element` finding)
- Modify: `extension/plugins/content.js` (remove the skipped and empty heading findings; collect only rendered, non-`aria-hidden` headings)
- Test: `test/content.test.mjs` (update), `test/a11y-structure.test.mjs` (presence guard)

**Interfaces:**
- Consumes from Task 3: `analyzeStructure`, which already emits `<n> skipped heading levels`, `<n> empty headings` and `No <main> landmark`.

- [ ] **Step 1: Update and write the tests first.**

  In `test/content.test.mjs`:
  - In the structure test, replace the asserts at lines ~92–93 with:

    ```js
      assert.ok(!t.some((x) => /skipped heading levels|empty headings/.test(x)), 'heading rules live in a11y-structure now');
    ```

  - Delete the assertion `r.findings.find((f) => f.title === '1 empty headings').severity`.
  - In the later test that checks the `skipped`/`empty` finding details (~lines 182–183), replace those two asserts with:

    ```js
      assert.equal(r.findings.find((f) => /skipped heading levels|empty headings/.test(f.title)), undefined);
    ```

  - Keep the long-headings info assertion.

  Append to `test/a11y-structure.test.mjs`:

  ```js
  import a11yBasics from '../extension/plugins/a11y-basics.js';

  test('duplicates removed from a11y-basics; a11y-structure keeps the only copy', () => {
    const src = String(a11yBasics.collect);
    assert.doesNotMatch(src, /heading-order|empty-heading|landmark-main/);
    const r = analyzeStructure({ ...base(), headings: [{ level: 1, text: 'A' }, { level: 3, text: '' }], landmarks: { mains: 0, hasMain: false, navs: [], asides: [], banners: 0, contentinfos: 0 } });
    assert.deepEqual(r.findings.map((f) => f.title), ['1 skipped heading levels', '1 empty headings', 'No <main> landmark']);
  });
  ```

  In `test/plugins.test.mjs` (or wherever `html` plugin findings are tested), add:

  ```js
  test('html plugin no longer reports a missing <main>', async () => {
    const { default: html } = await import('../extension/plugins/html.js');
    assert.doesNotMatch(String(html.run), /No <main> element/);
  });
  ```

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/content.test.mjs test/a11y-structure.test.mjs test/plugins.test.mjs`

  Expected: FAIL, because the duplicates still exist.

- [ ] **Step 3: Implement.**

  **`a11y-basics.js`:**
  - Delete the `heading-order`, `empty-heading` and `landmark-main` `check`/`flag` lines. Keep the `headings` variable only if something else uses it; otherwise remove it too.
  - Change the render note to: `Basic heuristics only. Contrast, headings, landmarks and focus styles are checked by the Contrast and Structure plugins; enable axe for a full WCAG audit.`

  **`html.js`:** delete the line `if (!c.elements.main) add('low', 'accessibility', 'No <main> element');`.

  **`content.js`:**
  - Delete the two `add(...)` lines for skipped and empty headings, and the now-unused `skippedList` and `emptyList`. Keep `skipped` and `empty` if `data.structure` still reports them.
  - In `collect()`, change the `headings:` line so it keeps only rendered headings that aren't `aria-hidden`, using the existing `shown` helper:

    ```js
        headings: [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((x) => shown(x) && !x.closest('[aria-hidden="true"]')).slice(0, 300).map((x) => ({ level: Number(x.tagName[1]), text: clean(x.innerText || x.textContent).slice(0, 300) })),
    ```

    `shown` must already be defined in `collect` (it is, at line ~19). If it's defined after the headings line, move it up.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS. If the glance test for `a11y-basics` (`test/glance.test.mjs`) asserted a removed rule, update it, and say why.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/a11y-basics.js extension/plugins/html.js extension/plugins/content.js test/content.test.mjs test/a11y-structure.test.mjs test/plugins.test.mjs
  git commit -m "Remove duplicated heading and <main> findings; Structure owns them, Content ignores hidden headings

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 6: End-to-end checks and the fixture refresh

**Files:**
- Modify: `test/e2e/site/index.html`
- Modify: `test/e2e/run.mjs`
- Modify: `test/fixtures/local-site.har` (regenerated)

**Interfaces:**
- Consumes the exact titles from Tasks 2, 3 and 5, and `hp.capture.focus` from Task 4.

- [ ] **Step 1: Extend the test site.**

  In `test/e2e/site/index.html`, add `a:focus { outline: none; }` inside the existing `<style>` block in `<head>`. Then inside `<main>`, after the existing link paragraph, add:

  ```html
      <p class="faint" style="color:#999;background:#fff">Returns are accepted within thirty days of purchase.</p>
      <div role="heading" aria-level="2">Field notes</div>
      <button type="button" aria-label="Close" style="width:16px;height:16px;padding:0;border:1px solid #333"></button><button type="button" aria-label="Menu" style="width:16px;height:16px;padding:0;border:1px solid #333"></button>
      <input type="text" aria-labelledby="missing-label-id" autocomplete="emial">
      <img src="/img/hero.svg" alt="image of a tent" width="40" height="20">
  ```

- [ ] **Step 2: Add the assertions.**

  In `test/e2e/run.mjs`, next to the existing `r1` plugin checks (near the `a11y-views` block), add:

  ```js
      const pcx = r1.log._harplus.plugins.contrast;
      assert.equal(pcx?.status, 'ok', `contrast: ${pcx?.error}`);
      assert.ok(pcx.findings.some((f) => /^Text contrast 2\.\d:1 \(#999999 on #ffffff\)/.test(f.title)), pcx.findings.map((f) => f.title).join(' | '));
      const pst = r1.log._harplus.plugins['a11y-structure'];
      assert.equal(pst?.status, 'ok', `a11y-structure: ${pst?.error}`);
      const st = pst.findings.map((f) => f.title);
      for (const re of [/targets smaller than 24×24 px \(WCAG 2\.5\.8\)$/, /label or description references point to missing ids$/,
        /images with unhelpful alt text$/, /invalid autocomplete values \(WCAG 1\.3\.5\)$/]) assert.ok(st.some((x) => re.test(x)), `${re} in ${st.join(' | ')}`);
      assert.ok(st.includes('Inline links show no visible focus indicator'), st.join(' | '));
      assert.ok(!st.includes('Buttons show no visible focus indicator'), 'buttons keep the default focus ring');
      assert.ok(pst.data.headings.some((x) => x.text === 'Field notes' && x.level === 2), 'role=heading counted');
      const fs = r1.log._harplus.capture.focus;
      assert.ok(fs?.samples?.find((s) => s.kind === 'button')?.changed.length > 0, `button focus changes: ${JSON.stringify(fs)}`);
      assert.ok(fs.outlineNone >= 1, 'a:focus outline:none rule counted');
      assert.equal(await page.evaluate(() => document.querySelectorAll('[data-harplus-focus]').length), 0, 'no probe attributes left');
      for (const id of ['a11y-basics', 'html', 'content']) {
        const titles = (r1.log._harplus.plugins[id]?.findings || []).map((f) => f.title);
        assert.ok(!titles.some((x) => /skipped heading levels|Heading levels skip|No <main>|empty headings|Empty headings/.test(x)), `${id} has no duplicated heading/main findings`);
      }
      log('contrast + structure passed');
  ```

  - **About the `page` variable:** it is the test-site tab the reading was taken from. If it isn't in scope at that point, use whatever handle the run uses for the captured tab.
  - **If the button sample is the form's empty `<button></button>`** and it shows no change, the test site's CSS may be suppressing button focus. Report the actual `changed` value, and pick a different button for the assertion rather than weakening it. One way: give the "Close" button `id="close"` and assert by selector.

- [ ] **Step 3: Run the e2e**

  Run: `npm run test:e2e`

  Expected: `all e2e checks passed`. If the new assertions pass on the first run, prove they can fail: temporarily expect `#999999 on #fafaf7`, run once, see the failure, and revert.

- [ ] **Step 4: Refresh the fixture**

  Run `cp test/e2e/out/local-site.har test/fixtures/local-site.har`, then `npm test`.

  Expected: PASS. Update only the expectations the new data legitimately changes, and list each one.

- [ ] **Step 5: Commit**

  ```bash
  git add test/e2e/site/index.html test/e2e/run.mjs test/fixtures/local-site.har
  git commit -m "E2E: contrast pair, structure rules, focus-style probe, no duplicate findings; refreshed fixture

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```
