# Images, Carbon and International Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three readings, each with findings and charts:
- **Images:** real re-encode savings in the Performance area.
- **Carbon:** SWDM v4 per-visit CO₂ plus a green-hosting check, in a new Sustainability area.
- **International:** Right-to-left and Long text capture views, plus translation and RTL checks, in a new International area.

**Architecture:**
- **Scorecard:** gains two areas with new weights.
- **Images:** a page-phase plugin. It reads every image in the page, then re-encodes the largest ones in the service worker using `OffscreenCanvas`.
- **Carbon:** an enrich-phase plugin. It sums bytes per host, checks each host with the Green Web Foundation, and applies the Sustainable Web Design Model (SWDM) v4.
- **International:** the existing in-place capture views gain `rtl` and `pseudo`, and `measureView` gains overflow, clipping and right-to-left (RTL) text metrics. An offline `international` plugin turns those metrics, the CSS plugin's property counts and the page metadata into findings.

**Tech Stack:** Vanilla ES modules, no build step, no dependencies. `node:test` for unit tests. Playwright (installed globally) for end-to-end tests.

**Spec:** `docs/superpowers/specs/2026-10-10-images-carbon-international-design.md` (read it first).

**Refinements to the spec, decided while planning:**
- `measureView` records `rtlUnmarked`. This is the share of letters that are Hebrew or Arabic but whose element's computed `direction` is not `rtl`. The "RTL text without dir" finding uses `rtlUnmarked ≥ 0.05` instead of `rtlChars` plus the page `dir`. As a result, a page that correctly marks a paragraph `dir="rtl"` is not flagged.
- The format-savings finding compares bytes with `webpNatural`, the WebP encode at natural size, so it isolates the effect of the format. The oversize and total savings use the best encode at the needed size.

## Global Constraints

- No build step and no dependencies in `extension/` or `cli/`.
- Areas, in this order, with these weights:

  | Area id | Label | Weight |
  |---|---|---|
  | `performance` | Performance | 20 |
  | `accessibility` | Accessibility | 20 |
  | `security` | Security | 20 |
  | `build` | Build & content | 15 |
  | `infrastructure` | Infrastructure | 10 |
  | `international` | International | 8 |
  | `sustainability` | Sustainability | 7 |

- Categories `international` and `sustainability` map to the areas of the same name.
- SWDM v4 energy intensity, in kWh/GB:

  | | Operational | Embodied |
  |---|---|---|
  | Data centre | 0.055 | 0.012 |
  | Network | 0.059 | 0.013 |
  | Device | 0.080 | 0.081 |

  The grid intensity is 494 g/kWh. A green host has zero data-centre operational emissions.
- Rating upper bounds, in grams per view:

  | Rating | A+ | A | B | C | D | E | F |
  |---|---|---|---|---|---|---|---|
  | Up to | 0.040 | 0.079 | 0.145 | 0.209 | 0.278 | 0.359 | above 0.359 |

  Carbon rating → score: A+ 100, A 90, B 80, C 70, D 55, E 40, F 25.
- Green check: `GET {endpoint}{host}`. The endpoint defaults to `https://api.thegreenwebfoundation.org/api/v3/greencheck/`. Check at most 25 hosts, 4 at a time. Skip IP hosts. A failed lookup gives `green: null`.
- Images:
  - re-encode at most 20 raster images over 10 KB, within an 8 s budget;
  - WebP at quality 0.8;
  - AVIF at quality 0.6, kept only when `blob.type === 'image/avif'`.
- International views:
  - `rtl` sets `dir="rtl"` on `<html>`.
  - `pseudo` maps letters to accented forms and appends `' ' + '·'.repeat(ceil(len × 0.4))` to nodes of 3 or more characters. It skips `script`, `style`, `noscript`, `textarea`, `code`, `pre`, `svg` and `[translate="no"]`.
  - Both views run in place after `noimages` and before `nojs`, and both are on by default.
- Every interpolated value goes through the escaping `html` tag.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Old readings.** Readings without the new results, views or areas must render. The two new areas show as "not measured", and no `undefined` or `NaN` appears. Pinned in Task 1 (`old reading: seven areas, new ones unmeasured`) and Task 6 (`international section absent for old readings`).
2. **Images that can't be re-encoded.** This covers cross-origin fetch failures, decode errors and blown time budgets. Each must be recorded per image and must not sink the plugin. Pinned in Task 2 (`fetch failure`, `time budget`).
3. **Unreachable or rate-limited green check API.** The estimate must still be produced, with unknown hosts. Pinned in Task 3 (`failed lookup`, `greenCheck off`).
4. **Pages with no right-to-left text, no CSS data or no hreflang.** There must be no false international findings, and a skip only when nothing is available at all. Pinned in Task 5 (`clean page`, `skip`).
5. **Tab restored after the RTL and pseudo views.** `dir` and the text must both come back. Pinned in Task 7 (e2e: `html` has no `dir` attribute afterwards, and the first `.tags li` text is back).

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `extension/core/score.js`, `core/har-util.js` | modify | 7 areas, weights, categories, sustainability metric |
| `extension/ui/charts.js` | modify | `globe`/`leaf` icons; checklist `ok: null` (unknown) |
| `extension/ui/theme.css` | modify | area-card grid for 7; international screens grid |
| `extension/plugins/images.js` | create | image inventory, re-encode, findings, glance |
| `extension/plugins/carbon.js` | create | bytes per host, green check, SWDM v4, rating, glance |
| `extension/plugins/international.js` | create | translation/RTL findings from views, CSS, meta |
| `extension/plugins/index.js` | modify | register the three plugins |
| `extension/core/views.js`, `browser/settings.js` | modify | `rtl`/`pseudo` view ids, labels, defaults |
| `extension/browser/capture.js` | modify | `measureView` metrics, `flipDir`, `pseudoText`, two new views |
| `extension/ui/report.js` | modify | International screens section and chips |
| `extension/ui/popup.html`, `options.html` | modify | two more view checkboxes |
| `scripts/make-test-image.mjs`, `test/e2e/site/*`, `test/e2e/server.mjs`, `test/e2e/run.mjs` | create/modify | test image, page fixtures, green-check mock, e2e asserts |
| `docs/PLUGINS.md`, `docs/FORMAT.md`, `README.md` | modify | areas/weights/categories, view metrics, report |
| `test/score.test.mjs`, `charts.test.mjs`, `views.test.mjs`, `report.test.mjs`, `images.test.mjs`, `carbon.test.mjs`, `international.test.mjs` | modify/create | unit tests |

---

### Task 1: Seven areas in the scorecard

**Files:**
- Modify: `extension/core/score.js` (`AREAS`, `CATEGORY_AREA`, `metricInput`)
- Modify: `extension/core/har-util.js` (`CATEGORIES`)
- Modify: `extension/ui/charts.js` (`ICONS`, `checklist`)
- Modify: `extension/ui/theme.css` (`.area-cards`)
- Modify: `docs/PLUGINS.md` (Scores section, plugin `area:` comment)
- Test: `test/score.test.mjs`, `test/charts.test.mjs`, `test/report.test.mjs`

**Interfaces:**
- Produces: `AREAS` with 7 entries. `scoreReading(...).areas` has keys `international` and `sustainability`. `metricInput('sustainability')` returns `{ label: 'Carbon rating', score }` when `results.carbon.status === 'ok'`. `CARBON_SCORE` is exported. `icon('globe')` and `icon('leaf')` exist. `checklist` items accept `ok: null`, which renders the `info` icon titled "unknown".

- [ ] **Step 1: Write the failing tests.**

In `test/score.test.mjs`:
- In the test `unmeasured areas are excluded and weights renormalise`, change the expected value to `Math.round((70 * 20 + 100 * 10) / 30)`.
- Append:

```js
test('seven areas with the new weights', () => {
  assert.deepEqual(AREAS.map((a) => `${a.id}:${a.weight}`), [
    'performance:20', 'accessibility:20', 'security:20', 'build:15', 'infrastructure:10', 'international:8', 'sustainability:7',
  ]);
  assert.equal(AREAS.reduce((n, a) => n + a.weight, 0), 100);
  assert.equal(pluginArea({ area: 'international' }), 'international');
  assert.equal(pluginArea({ area: 'sustainability' }), 'sustainability');
});

test('international and sustainability categories land in their areas; carbon rating blends', () => {
  const s = scoreReading(reading({
    international: ok('international', [f('medium', 'international')], { area: 'international' }),
    carbon: ok('carbon', [f('low', 'sustainability')], { area: 'sustainability', data: { rating: 'D' } }),
  }), getPlugins());
  assert.equal(s.areas.international.score, 94);
  assert.equal(s.areas.sustainability.score, Math.round((98 + 55) / 2));
  assert.deepEqual(s.areas.sustainability.inputs.map((i) => i.label), ['Findings', 'Carbon rating']);
});

test('old reading: seven areas, new ones unmeasured', () => {
  const s = scoreReading(reading({ security: ok('security') }), getPlugins());
  assert.equal(Object.keys(s.areas).length, 7);
  assert.equal(s.areas.international.score, null);
  assert.equal(s.areas.sustainability.status, 'none');
});
```

In `test/charts.test.mjs`:
- Add `'globe', 'leaf'` to the icon-name loop array in the test `icons: decorative by default…`.
- Append:

```js
test('checklist unknown state', () => {
  const s = String(checklist([{ label: 'cdn.test', ok: null, note: 'unknown' }]));
  assert.match(s, /aria-label="unknown"/);
  assert.match(s, /icon-info/);
});
```

In `test/report.test.mjs`, append:

```js
test('report has seven area panes and sidebar links', () => {
  const out = renderReport(load(), getPlugins());
  for (const id of ['international', 'sustainability']) {
    assert.match(out, new RegExp(`id="area-${id}"`));
    assert.match(out, new RegExp(`href="#area-${id}"`));
  }
  assert.doesNotMatch(out, /undefined|NaN/);
});
```

- [ ] **Step 2: Run the tests and check they fail.**

Run: `node --test test/score.test.mjs test/charts.test.mjs test/report.test.mjs`
Expected: FAIL. There are 5 areas, the icon `globe` is missing, and `aria-label="fail"` appears for `ok: null`.

- [ ] **Step 3: Implement.**

`extension/core/score.js`. Replace `AREAS`:

```js
export const AREAS = [
  { id: 'performance', label: 'Performance', weight: 20 },
  { id: 'accessibility', label: 'Accessibility', weight: 20 },
  { id: 'security', label: 'Security', weight: 20 },
  { id: 'build', label: 'Build & content', weight: 15 },
  { id: 'infrastructure', label: 'Infrastructure', weight: 10 },
  { id: 'international', label: 'International', weight: 8 },
  { id: 'sustainability', label: 'Sustainability', weight: 7 },
];
```

Add `international: 'international', sustainability: 'sustainability',` to `CATEGORY_AREA`. Add after `RATING_SCORE`:

```js
export const CARBON_SCORE = { 'A+': 100, A: 90, B: 80, C: 70, D: 55, E: 40, F: 25 };
```

In `metricInput`, before the final `return null;`:

```js
  if (areaId === 'sustainability' && results.carbon?.status === 'ok' && CARBON_SCORE[results.carbon.data?.rating] != null) {
    return { label: 'Carbon rating', score: CARBON_SCORE[results.carbon.data.rating] };
  }
```

`extension/core/har-util.js`: append `'international', 'sustainability'` to `CATEGORIES`.

`extension/ui/charts.js`:
- In `ICONS`, after `infrastructure`, add:

```js
  globe: `<circle cx="8" cy="8" r="6.2" stroke-width="1.4" ${STROKE}/><path d="M1.8 8h12.4M8 1.8c1.9 1.8 2.8 3.9 2.8 6.2S9.9 12.4 8 14.2C6.1 12.4 5.2 10.3 5.2 8S6.1 3.6 8 1.8Z" stroke-width="1.2" ${STROKE}/>`,
  leaf: `<path d="M3 13c0-6 4-10 10-10 0 6-4 10-10 10Z" stroke-width="1.4" ${STROKE}/><path d="M3 13 9 7" stroke-width="1.4" ${STROKE}/>`,
```

- In `checklist`, replace the `icon(...)` call with:

```js
icon(it.ok === null ? 'info' : it.ok ? 'ok' : 'fail', { title: it.ok === null ? 'unknown' : it.ok ? 'pass' : 'fail' })
```

`extension/ui/theme.css`: change `.area-cards { … minmax(min(100%, 10rem), 1fr) … }` to `minmax(min(100%, 12.5rem), 1fr)`.

`docs/PLUGINS.md`:
- In the plugin object block, change the `area:` comment to list `performance | accessibility | security | build | infrastructure | international | sustainability`.
- In the Scores section:
  - update the weights sentence to "Performance 20, Accessibility 20, Security 20, Build & content 15, Infrastructure 10, International 8, Sustainability 7";
  - add `international` and `sustainability` to the category mapping;
  - add: "Sustainability is averaged 50/50 with the carbon rating (A+ 100 … F 25)."

- [ ] **Step 4: Run all tests and check they pass.**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add extension/core/score.js extension/core/har-util.js extension/ui/charts.js extension/ui/theme.css docs/PLUGINS.md test/score.test.mjs test/charts.test.mjs test/report.test.mjs
git commit -m "Scorecard: International and Sustainability areas with new weights

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Images plugin

**Files:**
- Create: `extension/plugins/images.js`
- Modify: `extension/plugins/index.js` (import, plus `BUILTIN` after `vitals`)
- Test: `test/images.test.mjs`

**Interfaces:**
- Consumes `ctx.collected` (from `collect()`), `ctx.fetch`, and `ctx.util.transferSize` / `formatBytes`.
- Produces a plugin with `{ id: 'images', area: 'performance', group: 'quality', phase: 'page', world: 'main', collect, run, render, glance }`, plus these exports:
  - `setImageEnv(env)`, the test seam;
  - `formatOf(mime, url)`.
- `data` is `{ images: [...], lcp, avifSupported, totals: { bytes, saving, measured, share, rating } }`. Each image has:
  - `src`, `format`, `bytes`;
  - `naturalWidth`, `naturalHeight`, `neededWidth`, `neededHeight`;
  - `webpNeeded?`, `webpNatural?`, `avifNeeded?`;
  - `saving`, `formatSaving`, `oversized`;
  - `encodeError?`.

- [ ] **Step 1: Write the failing test.** Create `test/images.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { setImageEnv, formatOf } from '../extension/plugins/images.js';
import { getPlugins } from '../extension/plugins/index.js';
import * as util from '../extension/core/har-util.js';
import { h } from '../extension/ui/render.js';

// Fake encoder: WebP 0.1 B/px, AVIF 0.07 B/px (or PNG when AVIF is "unsupported").
const fakeEnv = ({ avif = true } = {}) => ({
  createImageBitmap: async () => ({ close() {} }),
  OffscreenCanvas: class {
    constructor(w, h) { this.w = w; this.h = h; }
    getContext() { return { drawImage() {} }; }
    async convertToBlob({ type }) {
      if (type === 'image/avif') return avif ? { type, size: Math.round(this.w * this.h * 0.07) } : { type: 'image/png', size: 1 };
      return { type, size: Math.round(this.w * this.h * 0.1) };
    }
  },
});
const img = (src, nw, nh, dw, dh, extra = {}) => ({
  src, naturalWidth: nw, naturalHeight: nh, displayWidth: dw, displayHeight: dh, dpr: 1, loading: '', fetchpriority: '',
  decoding: '', sized: true, aboveFold: true, inPicture: false, alt: true, ...extra,
});
const entry = (url, bytes, mime) => ({
  request: { url, method: 'GET', headers: [] },
  response: { status: 200, headers: [], bodySize: bytes, headersSize: 0, _transferSize: bytes, content: { mimeType: mime, size: bytes } },
  timings: {}, time: 1, startedDateTime: new Date(0).toISOString(),
});
const S = 'https://s.test/';
const collected = {
  images: [
    img(`${S}big.jpg`, 2400, 1600, 300, 200, { loading: 'lazy', sized: false }),
    img(`${S}logo.png`, 400, 100, 400, 100),
    img(`${S}tiny.png`, 10, 10, 10, 10),
    img(`${S}anim.gif`, 300, 300, 300, 300),
    img(`${S}fail.jpg`, 800, 600, 800, 600),
    img('data:image/png;base64,xx', 1, 1, 1, 1),
  ],
  lcp: `${S}big.jpg`,
};
const reading = { log: { entries: [
  entry(`${S}big.jpg`, 1_000_000, 'image/jpeg'), entry(`${S}logo.png`, 60_000, 'image/png'), entry(`${S}tiny.png`, 2_000, 'image/png'),
  entry(`${S}anim.gif`, 400_000, 'image/gif'), entry(`${S}fail.jpg`, 200_000, 'image/jpeg'),
], _harplus: {} } };
const fetched = [];
const ctx = (over = {}) => ({
  collected, util,
  fetch: async (url) => { fetched.push(url); if (url.endsWith('fail.jpg')) throw new Error('CORS'); return { ok: true, status: 200, blob: async () => ({}) }; },
  skip: (m) => { throw new Error(m); },
  ...over,
});
const runWith = async (env, over) => { setImageEnv(env); fetched.length = 0; try { return await plugin.run(reading, ctx(over)); } finally { setImageEnv(); } };
const byFile = (out, f) => out.data.images.find((i) => i.src.endsWith(f));

test('registered as a page plugin in Performance', () => {
  assert.ok(getPlugins().some((p) => p.id === 'images'));
  assert.equal(plugin.phase, 'page');
  assert.equal(plugin.area, 'performance');
  assert.equal(formatOf('image/jpeg'), 'jpeg');
  assert.equal(formatOf('', 'https://x/a.JPG?v=1'), 'jpeg');
  assert.equal(formatOf('image/svg+xml'), 'svg');
});

test('candidates: raster over 10 KB, data: URLs skipped, fetch failure recorded', async () => {
  const out = await runWith(fakeEnv());
  assert.equal(out.data.images.length, 5, 'data: URL skipped');
  assert.ok(!fetched.some((u) => u.endsWith('tiny.png')), 'tiny not encoded');
  assert.equal(byFile(out, 'fail.jpg').encodeError, 'CORS');
  assert.equal(byFile(out, 'fail.jpg').saving, 0);
  assert.equal(out.data.totals.measured, 4);
});

test('savings maths', async () => {
  const out = await runWith(fakeEnv());
  const big = byFile(out, 'big.jpg');
  assert.deepEqual([big.neededWidth, big.neededHeight], [300, 200]);
  assert.equal(big.webpNeeded, 6000);
  assert.equal(big.webpNatural, 384000);
  assert.equal(big.avifNeeded, 4200);
  assert.equal(big.saving, 995800);
  assert.equal(big.formatSaving, 616000);
  assert.equal(big.oversized, true);
  assert.equal(byFile(out, 'logo.png').saving, 57200);
  assert.equal(byFile(out, 'logo.png').oversized, false);
  assert.equal(out.data.totals.bytes, 1_662_000);
  assert.equal(out.data.totals.saving, 1_446_700);
});

test('findings and thresholds', async () => {
  const out = await runWith(fakeEnv());
  const t = Object.fromEntries(out.findings.map((f) => [f.title, f]));
  assert.equal(t["1 image is larger than it's shown"].severity, 'medium');
  assert.match(t["1 image is larger than it's shown"].detail, /big\.jpg 2400×1600 → 300×200/);
  assert.equal(t['Modern formats would save 656.3 KB'].severity, 'medium');
  assert.equal(t['1 image without width and height'].severity, 'low');
  assert.equal(t['The largest image (LCP) is lazy-loaded'].severity, 'medium');
  assert.equal(t['The LCP image has no fetchpriority=high'].severity, 'info');
  assert.equal(t['Animated GIF of 390.6 KB — use a video'].severity, 'low');
});

test('summary and AVIF unsupported', async () => {
  const out = await runWith(fakeEnv());
  assert.deepEqual(out.summary[0], { label: 'Images', value: '5 · 1.59 MB', headline: true });
  assert.deepEqual(out.summary[1], { label: 'Potential savings', value: '1.38 MB (87%)', rating: 'poor' });
  const noAvif = await runWith(fakeEnv({ avif: false }));
  assert.equal(noAvif.data.avifSupported, false);
  assert.equal(byFile(noAvif, 'big.jpg').avifNeeded, null);
  assert.equal(byFile(noAvif, 'big.jpg').saving, 994000);
});

test('time budget: images past the deadline are skipped, not failed', async () => {
  const realNow = Date.now;
  let t = 0;
  Date.now = () => (t += 5000);
  try {
    const out = await runWith(fakeEnv());
    assert.ok(out.data.images.some((i) => i.encodeError === 'time budget exceeded'));
  } finally { Date.now = realNow; }
});

test('glance and render', async () => {
  const out = await runWith(fakeEnv());
  const g = String(plugin.glance({ status: 'ok', ...out }, h));
  assert.match(g, /Image weight/);
  assert.match(g, /big\.jpg/);
  assert.match(g, /976\.6 KB → 4\.1 KB/);
  const r = String(plugin.render({ status: 'ok', ...out }, h));
  assert.match(r, /<th scope="col">AVIF<\/th>/);
});
```

Arithmetic check:
- Format savings: 616,000 + 56,000 = 672,000 B, which `formatBytes` shows as "656.3 KB".
- The GIF is 400,000 B, shown as "390.6 KB". `big.jpg` goes from 1,000,000 B ("976.6 KB") to its best encode of 4,200 B ("4.1 KB").
- Totals: 1,662,000 B is "1.59 MB" and 1,446,700 B is "1.38 MB".
- `big.jpg` without AVIF: the best encode is min(1,000,000, 6,000) = 6,000, so the saving is 994,000.

- [ ] **Step 2: Run the test and check it fails.**

Run: `node --test test/images.test.mjs`
Expected: FAIL with `Cannot find module '…/extension/plugins/images.js'`.

- [ ] **Step 3: Create `extension/plugins/images.js`.**

```js
// Images: how well each image is encoded and sized. In the page: every image's natural and shown size,
// loading hints and the LCP image. In the extension: the largest raster images are fetched (cache first)
// and re-encoded with the browser's own encoders, so the savings are measured rather than guessed.

let env = globalThis;
/** Test seam: replace createImageBitmap / OffscreenCanvas (defaults to the real ones). */
export function setImageEnv(e) { env = e || globalThis; }

const RASTER = new Set(['jpeg', 'png', 'gif', 'webp', 'bmp']);
const MAX_ENCODE = 20;
const MIN_BYTES = 10 * 1024;
const BUDGET_MS = 8000;
const KB = 1024;

export function formatOf(mime = '', url = '') {
  const m = String(mime).toLowerCase().match(/image\/(x-)?([a-z0-9+.-]+)/);
  let f = m ? m[2] : (String(url).split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (f === 'jpg' || f === 'pjpeg') f = 'jpeg';
  if (f === 'svg+xml') f = 'svg';
  return f || 'other';
}

const file = (u) => { const name = String(u).split(/[?#]/)[0].split('/').pop() || String(u); try { return decodeURIComponent(name); } catch { return name; } };
const sum = (xs, k) => xs.reduce((n, x) => n + (x[k] || 0), 0);
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function collect() {
  const lcp = await new Promise((resolve) => {
    let last = null;
    try {
      new PerformanceObserver((list) => { const xs = list.getEntries(); if (xs.length) last = xs[xs.length - 1]; })
        .observe({ type: 'largest-contentful-paint', buffered: true });
    } catch { /* not supported */ }
    setTimeout(() => resolve(last ? (last.element?.currentSrc || last.element?.src || last.url || null) : null), 60);
  });
  const images = [...document.images].slice(0, 200).map((img) => {
    const r = img.getBoundingClientRect();
    const ar = getComputedStyle(img).aspectRatio;
    return {
      src: img.currentSrc || img.src,
      naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
      displayWidth: Math.round(r.width), displayHeight: Math.round(r.height), dpr: devicePixelRatio,
      loading: img.getAttribute('loading') || '', fetchpriority: img.getAttribute('fetchpriority') || '', decoding: img.getAttribute('decoding') || '',
      sized: (img.hasAttribute('width') && img.hasAttribute('height')) || (!!ar && ar !== 'auto'),
      aboveFold: r.top < innerHeight && r.bottom > 0,
      inPicture: img.parentElement?.tagName === 'PICTURE',
      alt: img.hasAttribute('alt'),
    };
  });
  return { images, lcp };
}

async function run(reading, ctx) {
  const c = ctx.collected;
  if (!c?.images) ctx.skip('no page data');
  const { transferSize, formatBytes } = ctx.util;
  const byUrl = new Map();
  for (const e of reading.log.entries) {
    const bytes = transferSize(e);
    const prev = byUrl.get(e.request.url);
    if (!prev || bytes > prev.bytes) byUrl.set(e.request.url, { bytes, mime: e.response.content?.mimeType || '' });
  }
  const seen = new Set();
  const images = [];
  for (const i of c.images) {
    if (!i.src || i.src.startsWith('data:') || seen.has(i.src)) continue;
    seen.add(i.src);
    const net = byUrl.get(i.src) || { bytes: 0, mime: '' };
    const need = (natural, shown) => (shown > 0 ? Math.min(natural, Math.round(shown * (i.dpr || 1))) : natural);
    images.push({ ...i, bytes: net.bytes, format: formatOf(net.mime, i.src), neededWidth: need(i.naturalWidth, i.displayWidth), neededHeight: need(i.naturalHeight, i.displayHeight), saving: 0, formatSaving: 0, oversized: false });
  }

  const candidates = images.filter((i) => RASTER.has(i.format) && i.bytes > MIN_BYTES && i.naturalWidth > 0 && i.neededWidth > 0)
    .sort((a, b) => b.bytes - a.bytes).slice(0, MAX_ENCODE);
  const deadline = Date.now() + BUDGET_MS;
  let avifSupported = null;
  for (const i of candidates) {
    if (Date.now() > deadline) { i.encodeError = 'time budget exceeded'; continue; }
    try {
      const res = await ctx.fetch(i.src, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bmp = await env.createImageBitmap(await res.blob());
      const encode = (w, h, type, quality) => {
        const canvas = new env.OffscreenCanvas(w, h);
        canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
        return canvas.convertToBlob({ type, quality });
      };
      i.webpNeeded = (await encode(i.neededWidth, i.neededHeight, 'image/webp', 0.8)).size;
      i.webpNatural = i.neededWidth === i.naturalWidth && i.neededHeight === i.naturalHeight
        ? i.webpNeeded : (await encode(i.naturalWidth, i.naturalHeight, 'image/webp', 0.8)).size;
      i.avifNeeded = null;
      if (avifSupported !== false) {
        const a = await encode(i.neededWidth, i.neededHeight, 'image/avif', 0.6);
        avifSupported = a.type === 'image/avif';
        if (avifSupported) i.avifNeeded = a.size;
      }
      bmp.close?.();
      i.saving = i.bytes - Math.min(i.bytes, i.webpNeeded, i.avifNeeded ?? Infinity);
      i.formatSaving = Math.max(0, i.bytes - i.webpNatural);
      i.oversized = i.naturalWidth * i.naturalHeight > 2 * i.neededWidth * i.neededHeight && i.saving >= 50 * KB;
    } catch (e) {
      i.encodeError = String(e?.message || e);
    }
  }

  const findings = [];
  const add = (severity, title, detail) => findings.push({ severity, category: 'performance', title, detail });
  const oversized = images.filter((i) => i.oversized).sort((a, b) => b.saving - a.saving);
  if (oversized.length) {
    const total = sum(oversized, 'saving');
    add(total >= 300 * KB ? 'medium' : 'low', `${count(oversized.length, "image is larger than it's shown", "images are larger than they're shown")}`,
      `${formatBytes(total)} could be saved by serving the size each image is shown at. ${oversized.slice(0, 5).map((i) => `${file(i.src)} ${i.naturalWidth}×${i.naturalHeight} → ${i.neededWidth}×${i.neededHeight}`).join('; ')}`);
  }
  const legacy = images.filter((i) => (i.format === 'jpeg' || i.format === 'png') && i.formatSaving >= 0.25 * i.bytes && i.formatSaving >= 20 * KB);
  if (legacy.length) {
    const total = sum(legacy, 'formatSaving');
    add(total >= 500 * KB ? 'medium' : 'low', `Modern formats would save ${formatBytes(total)}`,
      `${count(legacy.length, 'JPEG/PNG image', 'JPEG/PNG images')} would be smaller as WebP${avifSupported ? ' or AVIF' : ''}.`);
  }
  const unsized = images.filter((i) => i.sized === false);
  if (unsized.length) add('low', `${count(unsized.length, 'image', 'images')} without width and height`, 'Reserve space to avoid layout shift: set width and height attributes or a CSS aspect-ratio.');
  const lcp = images.find((i) => i.src === c.lcp);
  if (lcp?.loading === 'lazy') add('medium', 'The largest image (LCP) is lazy-loaded', 'Lazy loading delays the most important image — remove loading="lazy" from it.');
  if (lcp?.aboveFold && lcp.fetchpriority !== 'high') add('info', 'The LCP image has no fetchpriority=high', 'fetchpriority="high" lets the browser fetch it before other images.');
  for (const g of images.filter((i) => i.format === 'gif' && i.bytes >= 200 * KB)) {
    add('low', `Animated GIF of ${formatBytes(g.bytes)} — use a video`, `${file(g.src)}: an MP4 or WebM is usually a fraction of the size.`);
  }

  const bytes = sum(images, 'bytes');
  const saving = sum(images, 'saving');
  const share = bytes ? saving / bytes : 0;
  const rating = share < 0.1 ? 'good' : share < 0.4 ? 'needs-improvement' : 'poor';
  const formats = {};
  for (const i of images) formats[i.format] = (formats[i.format] || 0) + 1;
  return {
    data: { images, lcp: c.lcp, avifSupported, totals: { bytes, saving, measured: candidates.length, share, rating } },
    findings,
    summary: [
      { label: 'Images', value: `${images.length} · ${formatBytes(bytes)}`, headline: true },
      { label: 'Potential savings', value: `${formatBytes(saving)} (${Math.round(share * 100)}%)`, rating },
      { label: 'Formats', value: Object.entries(formats).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') },
    ],
  };
}

const bestOf = (i) => Math.min(i.bytes, i.webpNeeded ?? Infinity, i.avifNeeded ?? Infinity);

function glance(r, h) {
  const d = r.data;
  const t = d.totals;
  const byFormat = {};
  for (const i of d.images) byFormat[i.format] = (byFormat[i.format] || 0) + i.bytes;
  const top = d.images.filter((i) => i.saving > 0).sort((a, b) => b.saving - a.saving).slice(0, 8);
  return h.html`<div class="tiles">
    ${h.stat({ label: 'Image weight', value: h.bytes(t.bytes), note: `${d.images.length} images` })}
    ${h.stat({ label: 'Potential savings', value: h.bytes(t.saving), rating: t.rating, note: `${t.measured} re-encoded` })}
    ${h.stat({ label: 'Oversized', value: d.images.filter((i) => i.oversized).length, note: 'more than 2× the pixels needed' })}
  </div>
  <div class="glance-grid">
    <section class="card"><h4>Bytes by format</h4>${h.stackBar({ segments: Object.entries(byFormat).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v, display: h.bytes(v) })) })}</section>
    ${top.length ? h.html`<section class="card"><h4>Biggest savings</h4>${h.hbars({ label: 'Savings per image', rows: top.map((i) => ({ label: file(i.src), value: i.saving, display: `${h.bytes(i.bytes)} → ${h.bytes(bestOf(i))}` })) })}</section>` : ''}
  </div>`;
}

function render(r, h) {
  return h.table(r.data.images.map((i) => ({
    file: file(i.src), format: i.format, natural: `${i.naturalWidth}×${i.naturalHeight}`, needed: `${i.neededWidth}×${i.neededHeight}`,
    bytes: h.bytes(i.bytes), webp: i.webpNeeded != null ? h.bytes(i.webpNeeded) : '—', avif: i.avifNeeded != null ? h.bytes(i.avifNeeded) : '—',
    saving: i.encodeError ? `not measured (${i.encodeError})` : h.bytes(i.saving),
  })), [
    { key: 'file', label: 'File' }, { key: 'format', label: 'Format' }, { key: 'natural', label: 'Natural' }, { key: 'needed', label: 'Needed' },
    { key: 'bytes', label: 'Bytes' }, { key: 'webp', label: 'WebP' }, { key: 'avif', label: 'AVIF' }, { key: 'saving', label: 'Saving' },
  ]);
}

export default {
  id: 'images',
  name: 'Images',
  version: '0.1.0',
  phase: 'page',
  world: 'main',
  area: 'performance',
  group: 'quality',
  description: 'Every image\'s size, format and loading hints, with savings measured by re-encoding the largest ones as WebP and AVIF.',
  tags: ['performance', 'images'],
  collect,
  run,
  render,
  glance,
};
```

- [ ] **Step 4: Register.** In `extension/plugins/index.js`, add `import images from './images.js';` after the vitals import. Change `meta, html, css, vitals, a11yBasics, axe,` to `meta, html, css, vitals, images, a11yBasics, axe,`.

- [ ] **Step 5: Run the tests and check they pass.**

Run: `node --test test/images.test.mjs`, then `npm test`.
Expected: PASS, after the permitted `formatBytes` literal corrections.

- [ ] **Step 6: Commit.**

```bash
git add extension/plugins/images.js extension/plugins/index.js test/images.test.mjs
git commit -m "Images plugin: sizes, formats and savings measured by re-encoding

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Carbon plugin

**Files:**
- Create: `extension/plugins/carbon.js`
- Modify: `extension/plugins/index.js` (import, plus `BUILTIN` at the end of the enrich list)
- Test: `test/carbon.test.mjs`

**Interfaces:**
- Consumes `ctx.util.hostOf`, `transferSize` and `isIP`; `ctx.fetchJSON`; `ctx.target.host`; and `ctx.options.greenCheck` / `endpoint`.
- Produces a plugin with `{ id: 'carbon', area: 'sustainability', group: 'other', phase: 'enrich' }`. It also exports:
  - `SWDM`, `GRID`, `RATINGS`, `ENDPOINT`;
  - `rate(grams)`;
  - `estimate(hosts)` → `{ grams, rating, segments: { dataCentre, network, device }, hosts }`.
- `data` is `{ model, gridIntensity, grams, rating, segments, hosts: [{ host, bytes, grams, green, hostedBy }], assumptions }`. Task 1's `metricInput` reads `data.rating`.

- [ ] **Step 1: Write the failing test.** Create `test/carbon.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { SWDM, GRID, rate, estimate } from '../extension/plugins/carbon.js';
import { getPlugins } from '../extension/plugins/index.js';
import * as util from '../extension/core/har-util.js';
import { h } from '../extension/ui/render.js';

const entry = (url, bytes) => ({
  request: { url, method: 'GET', headers: [] },
  response: { status: 200, headers: [], bodySize: bytes, headersSize: 0, _transferSize: bytes, content: { size: bytes } },
  timings: {}, time: 1, startedDateTime: new Date(0).toISOString(),
});
const reading = (entries) => ({ log: { entries, _harplus: {} } });
const calls = [];
const ctx = (answers, options = {}) => ({
  util, target: { host: 's.test' }, options: { greenCheck: true, ...options },
  fetchJSON: async (url) => {
    calls.push(url);
    const host = decodeURIComponent(url.split('/').pop());
    if (!(host in answers)) throw new Error('HTTP 503');
    return answers[host];
  },
  skip: (m) => { throw new Error(m); },
});
const PER_GB = SWDM.dc.op + SWDM.dc.emb + SWDM.net.op + SWDM.net.emb + SWDM.dev.op + SWDM.dev.emb;

test('registered in the enrich phase, Sustainability area, disclosed', () => {
  assert.ok(getPlugins().some((p) => p.id === 'carbon'));
  assert.equal(plugin.phase, 'enrich');
  assert.equal(plugin.area, 'sustainability');
  assert.match(plugin.disclosure, /thegreenwebfoundation/);
  assert.equal(GRID, 494);
  assert.equal(Math.round(PER_GB * 1000), 300);
});

test('rating boundaries', () => {
  assert.equal(rate(0.040), 'A+');
  assert.equal(rate(0.0401), 'A');
  assert.equal(rate(0.079), 'A');
  assert.equal(rate(0.359), 'E');
  assert.equal(rate(0.360), 'F');
});

test('worked example: 1 MB green first party + 1 MB third party', async () => {
  calls.length = 0;
  const out = await plugin.run(reading([entry('https://s.test/', 1e6), entry('https://cdn.other/x.js', 1e6)]),
    ctx({ 's.test': { green: true, hosted_by: 'Green Co' }, 'cdn.other': { green: false } }));
  const green = 0.001 * (PER_GB - SWDM.dc.op) * GRID;
  const grey = 0.001 * PER_GB * GRID;
  assert.ok(Math.abs(out.data.grams - (green + grey)) < 1e-9);
  assert.equal(out.data.rating, 'D');
  assert.equal(out.data.hosts.find((x) => x.host === 's.test').hostedBy, 'Green Co');
  assert.deepEqual(out.findings.map((f) => `${f.severity}:${f.title}`), ['medium:Carbon rating D (0.27 g CO₂ per visit)']);
  assert.deepEqual(out.summary[0], { label: 'CO₂ per visit', value: '0.27 g · rating D', rating: 'needs-improvement', headline: true });
  assert.deepEqual(out.summary[1], { label: 'Green hosting', value: '1 of 2 hosts', headline: true });
  assert.equal(out.data.segments.dataCentre + out.data.segments.network + out.data.segments.device, out.data.grams);
});

test('main host not green; failed lookup is unknown; IP hosts are not looked up', async () => {
  calls.length = 0;
  const out = await plugin.run(reading([entry('https://s.test/', 50_000), entry('https://down.test/a', 1000), entry('http://10.0.0.1/b', 1000)]),
    ctx({ 's.test': { green: false } }));
  assert.ok(out.findings.some((f) => f.title === "Main site isn't on green hosting"));
  assert.equal(out.data.hosts.find((x) => x.host === 'down.test').green, null);
  assert.ok(!calls.some((u) => u.includes('10.0.0.1')));
  assert.equal(out.summary[1].value, '0 of 1 hosts');
});

test('greenCheck off: estimate without lookups; custom endpoint', async () => {
  calls.length = 0;
  const off = await plugin.run(reading([entry('https://s.test/', 1e6)]), ctx({}, { greenCheck: false }));
  assert.equal(calls.length, 0);
  assert.equal(off.data.hosts[0].green, null);
  assert.ok(off.data.grams > 0);
  await plugin.run(reading([entry('https://s.test/', 1e6)]), ctx({ 's.test': { green: true } }, { endpoint: 'http://127.0.0.1:9/__mock/greencheck/' }));
  assert.ok(calls.at(-1).startsWith('http://127.0.0.1:9/__mock/greencheck/s.test'));
});

test('estimate is pure; glance shows per-year figure and host checklist', async () => {
  const e = estimate([{ host: 'a', bytes: 1e9, green: false }]);
  assert.ok(Math.abs(e.grams - PER_GB * GRID) < 1e-9);
  const out = await plugin.run(reading([entry('https://s.test/', 1e6), entry('https://cdn.other/x.js', 1e6)]),
    ctx({ 's.test': { green: true, hosted_by: 'Green Co' } }));
  const g = String(plugin.glance({ status: 'ok', ...out }, h));
  assert.match(g, /≈ 32\.3 kg/);
  assert.match(g, /aria-label="unknown"/, 'cdn.other lookup failed → unknown');
  assert.match(g, /Green Co/);
});
```

Arithmetic check:
- green = 0.001 × 0.245 × 494 = 0.12103; grey = 0.001 × 0.300 × 494 = 0.1482. The total, 0.26923, is at most 0.278, so the rating is D. To two decimals that is "0.27".
- Per year: 0.26923 × 10000 × 12 / 1000 = 32.31, which shows as "32.3".
- In the last test `cdn.other` has no answer, so its lookup throws and its status is unknown.

- [ ] **Step 2: Run the test and check it fails.**

Run: `node --test test/carbon.test.mjs`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Create `extension/plugins/carbon.js`.**

```js
// Carbon: estimated CO₂ per page view with the Sustainable Web Design Model v4, from the bytes each
// host served in this reading, with a Green Web Foundation check for green hosting. First visit with an
// empty cache (readings bypass the cache) and the global average grid — the conservative figure.

export const SWDM = { dc: { op: 0.055, emb: 0.012 }, net: { op: 0.059, emb: 0.013 }, dev: { op: 0.080, emb: 0.081 } }; // kWh/GB
export const GRID = 494; // gCO2e/kWh, global average (Ember 2022)
export const RATINGS = [['A+', 0.040], ['A', 0.079], ['B', 0.145], ['C', 0.209], ['D', 0.278], ['E', 0.359]];
export const ENDPOINT = 'https://api.thegreenwebfoundation.org/api/v3/greencheck/';
const MAX_HOSTS = 25;
const PARALLEL = 4;

export const rate = (grams) => (RATINGS.find(([, max]) => grams <= max) || ['F'])[0];
const ratingOf = (r) => (['A+', 'A', 'B'].includes(r) ? 'good' : ['C', 'D'].includes(r) ? 'needs-improvement' : 'poor');

/** hosts: [{ host, bytes, green }] → grams per view, rating, per-segment and per-host grams. */
export function estimate(hosts) {
  const segments = { dataCentre: 0, network: 0, device: 0 };
  const out = hosts.map((x) => {
    const gb = (x.bytes || 0) / 1e9;
    const dc = gb * ((x.green === true ? 0 : SWDM.dc.op) + SWDM.dc.emb) * GRID;
    const net = gb * (SWDM.net.op + SWDM.net.emb) * GRID;
    const dev = gb * (SWDM.dev.op + SWDM.dev.emb) * GRID;
    segments.dataCentre += dc;
    segments.network += net;
    segments.device += dev;
    return { ...x, grams: dc + net + dev };
  });
  const grams = segments.dataCentre + segments.network + segments.device;
  return { grams, rating: rate(grams), segments, hosts: out };
}

async function run(reading, ctx) {
  const { hostOf, transferSize, isIP } = ctx.util;
  const bytes = new Map();
  for (const e of reading.log.entries) {
    const host = hostOf(e.request.url);
    if (host) bytes.set(host, (bytes.get(host) || 0) + transferSize(e));
  }
  if (!bytes.size) ctx.skip('no requests in this reading');
  const hosts = [...bytes].map(([host, b]) => ({ host, bytes: b, green: null, hostedBy: null })).sort((a, b) => b.bytes - a.bytes);
  if (ctx.options.greenCheck !== false) {
    const base = ctx.options.endpoint || ENDPOINT;
    const queue = hosts.slice(0, MAX_HOSTS).filter((x) => !isIP(x.host));
    const worker = async () => {
      for (let x = queue.shift(); x; x = queue.shift()) {
        try {
          const j = await ctx.fetchJSON(base + encodeURIComponent(x.host));
          x.green = j?.green === true;
          x.hostedBy = j?.hosted_by || null;
        } catch {
          x.green = null;
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  }
  const est = estimate(hosts);
  const g = est.grams;
  const findings = [];
  const severity = { C: 'low', D: 'medium', E: 'medium', F: 'high' }[est.rating];
  if (severity) {
    findings.push({ severity, category: 'sustainability', title: `Carbon rating ${est.rating} (${g.toFixed(2)} g CO₂ per visit)`, detail: 'Sustainable Web Design Model v4 — first visit with an empty cache, global average grid.' });
  }
  const main = est.hosts.find((x) => x.host === ctx.target.host);
  if (main?.green === false) {
    findings.push({ severity: 'low', category: 'sustainability', title: "Main site isn't on green hosting", detail: `${main.host} is not listed by the Green Web Foundation.` });
  }
  const checked = est.hosts.filter((x) => x.green !== null);
  return {
    data: { model: 'SWDM v4', gridIntensity: GRID, grams: g, rating: est.rating, segments: est.segments, hosts: est.hosts, assumptions: 'first visit, no cache, global grid average' },
    findings,
    summary: [
      { label: 'CO₂ per visit', value: `${g.toFixed(2)} g · rating ${est.rating}`, rating: ratingOf(est.rating), headline: true },
      { label: 'Green hosting', value: `${checked.filter((x) => x.green).length} of ${checked.length} hosts`, headline: true },
    ],
  };
}

function glance(r, h) {
  const d = r.data;
  const s = d.segments;
  const year = (d.grams * 10000 * 12) / 1000;
  return h.html`<div class="tiles">
    ${h.stat({ label: 'CO₂ per visit', value: `${d.grams.toFixed(2)} g`, rating: ratingOf(d.rating), note: `rating ${d.rating} · first visit · global grid average` })}
    ${h.stat({ label: '10,000 visits a month', value: `≈ ${year.toFixed(1)} kg`, note: 'CO₂ per year' })}
  </div>
  <div class="glance-grid">
    <section class="card"><h4>Where the emissions come from</h4>${h.donut({ label: 'Emissions by segment', center: { value: d.grams.toFixed(2), unit: 'g' }, segments: [
      { label: 'Data centres', value: s.dataCentre, display: `${s.dataCentre.toFixed(3)} g` },
      { label: 'Networks', value: s.network, display: `${s.network.toFixed(3)} g` },
      { label: 'Devices', value: s.device, display: `${s.device.toFixed(3)} g` },
    ] })}</section>
    <section class="card"><h4>Green hosting</h4>${h.checklist(d.hosts.slice(0, 8).map((x) => ({
      label: `${x.host} · ${h.bytes(x.bytes)}`, ok: x.green, note: x.green === null ? 'unknown' : x.hostedBy || '',
    })))}</section>
  </div>`;
}

function render(r, h) {
  return h.html`<p class="note">${r.data.model} · ${r.data.gridIntensity} g/kWh · ${r.data.assumptions}</p>${h.table(r.data.hosts.map((x) => ({
    host: x.host, bytes: h.bytes(x.bytes), grams: x.grams.toFixed(4), green: x.green === null ? 'unknown' : x.green ? 'yes' : 'no', hostedBy: x.hostedBy || '',
  })), [{ key: 'host', label: 'Host' }, { key: 'bytes', label: 'Bytes' }, { key: 'grams', label: 'g CO₂' }, { key: 'green', label: 'Green' }, { key: 'hostedBy', label: 'Hosted by' }])}`;
}

export default {
  id: 'carbon',
  name: 'Carbon',
  version: '0.1.0',
  phase: 'enrich',
  area: 'sustainability',
  group: 'other',
  description: 'Estimated CO₂ per page view (Sustainable Web Design Model v4) with a green-hosting check per host.',
  disclosure: 'Sends each hostname to api.thegreenwebfoundation.org to check for green hosting.',
  tags: ['sustainability'],
  options: [
    { key: 'greenCheck', label: 'Check green hosting', type: 'checkbox', default: true },
    { key: 'endpoint', label: 'Green check endpoint', type: 'text', default: ENDPOINT },
  ],
  run,
  render,
  glance,
};
```

- [ ] **Step 4: Register.** In `extension/plugins/index.js`:
  - add `import carbon from './carbon.js';`;
  - append `carbon` to the end of the `BUILTIN` enrich line, after `reputation`.

- [ ] **Step 5: Run the tests and check they pass.**

Run: `node --test test/carbon.test.mjs`, then `npm test`
Expected: PASS. In the CLI test, `analyze --no-lookups` skips enrich, so carbon is absent.

- [ ] **Step 6: Commit.**

```bash
git add extension/plugins/carbon.js extension/plugins/index.js test/carbon.test.mjs
git commit -m "Carbon plugin: SWDM v4 per-visit estimate with green-hosting check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Right-to-left and Long text capture views

**Files:**
- Modify: `extension/core/views.js` (lists, labels)
- Modify: `extension/browser/settings.js` (`views` defaults)
- Modify: `extension/ui/popup.html`, `extension/ui/options.html` (two checkboxes each)
- Modify: `extension/browser/capture.js`:
  - `measureView` additions;
  - new `flipDir` and `pseudoText`;
  - two new views in `captureViews`.
- Modify: `docs/FORMAT.md` (`screenshots.view` ids, `capture.views` fields)
- Test: `test/views.test.mjs`

**Interfaces:**
- Produces:
  - `INTERNATIONAL_VIEWS = ['rtl', 'pseudo']`, with labels `Right-to-left` and `Long text`;
  - `VIEWS` lists the device views, then the resilience views, then the international views;
  - `capture.views[id]` gains `overflowX`, `clipped`, `rtlChars`, `rtlUnmarked` and `dir`;
  - screenshots with `view: 'rtl' | 'pseudo'`.

- [ ] **Step 1: Write the failing test.** In `test/views.test.mjs`:
  - Change the first test's expectation to `['desktop', 'tablet', 'mobile', 'nojs', 'nocss', 'noimages', 'rtl', 'pseudo']`.
  - Add `assert.equal(VIEW_LABELS.pseudo, 'Long text');`.
  - Change the settings test's expected defaults to include `rtl: true, pseudo: true`.

- [ ] **Step 2: Run the test and check it fails.**

Run: `node --test test/views.test.mjs`
Expected: FAIL. `VIEWS` has six entries.

- [ ] **Step 3: Update `extension/core/views.js`.** After `RESILIENCE_VIEWS`, add:

```js
export const INTERNATIONAL_VIEWS = ['rtl', 'pseudo'];
```

Change `VIEWS` to `[...DEVICE_VIEWS, ...RESILIENCE_VIEWS, ...INTERNATIONAL_VIEWS]`. Add `rtl: 'Right-to-left', pseudo: 'Long text',` to `VIEW_LABELS`.

- [ ] **Step 4: Update settings and the UI.**
  - **`settings.js`:** add `rtl: true, pseudo: true` to `views`.
  - **Popup and Options:**
    - `popup.html`: add `<label><input type="checkbox" name="views.rtl"> Right-to-left</label>` and `<label><input type="checkbox" name="views.pseudo"> Long text</label>` to the Views fieldset.
    - `options.html`: add the same two as chips with `data-path="capture.views.rtl"` and `data-path="capture.views.pseudo"`.

- [ ] **Step 5: Extend `measureView` in `extension/browser/capture.js`.** Replace the function with:

```js
/** What a reader can see in this view. Runs in the page (main world). */
function measureView() {
  const shown = (el) => el.getClientRects().length > 0;
  const imgs = [...document.querySelectorAll('img')].filter(shown);
  const root = document.body || document.documentElement;
  let clipped = 0;
  let walked = 0;
  for (const el of root.querySelectorAll('*')) {
    if (++walked > 3000) break;
    if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    const x = el.scrollWidth > el.clientWidth + 1 && (/hidden|clip/.test(cs.overflowX) || cs.textOverflow === 'ellipsis');
    const y = el.scrollHeight > el.clientHeight + 1 && /hidden|clip/.test(cs.overflowY);
    if (x || y) clipped++;
  }
  const RTL = /[֐-׿؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;
  let letters = 0;
  let rtl = 0;
  let unmarked = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (p && /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) continue;
    const l = (n.textContent.match(/\p{L}/gu) || []).length;
    if (!l) continue;
    letters += l;
    const r = (n.textContent.match(RTL) || []).length;
    if (!r) continue;
    rtl += r;
    if (p && getComputedStyle(p).direction !== 'rtl') unmarked += r;
  }
  const share = (x) => (letters ? Math.round((x / letters) * 1000) / 1000 : 0);
  return {
    cssWidth: innerWidth,
    cssHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().length,
    links: [...document.querySelectorAll('a[href]')].filter(shown).length,
    images: imgs.length,
    imagesWithAlt: imgs.filter((i) => i.hasAttribute('alt')).length,
    noscript: [...document.querySelectorAll('noscript')].reduce((n, e) => n + (e.innerText || '').replace(/\s+/g, ' ').trim().length, 0) >= 200,
    overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    clipped,
    rtlChars: share(rtl),
    rtlUnmarked: share(unmarked),
    dir: document.documentElement.getAttribute('dir') || getComputedStyle(document.documentElement).direction,
  };
}
```

- [ ] **Step 6: Add the page functions after `stripImages`.**

```js
/** Set dir="rtl" on <html> (on) or put the original dir back (off). */
function flipDir(on) {
  const root = document.documentElement;
  if (on) {
    window.__harplusDir = root.getAttribute('dir');
    root.setAttribute('dir', 'rtl');
  } else {
    const d = window.__harplusDir;
    if (d == null) root.removeAttribute('dir'); else root.setAttribute('dir', d);
    delete window.__harplusDir;
  }
  return true;
}

/** Pseudo-localize visible text — accented and ~40% longer (on) — or restore every original (off). */
function pseudoText(on) {
  if (!on) {
    for (const [node, text] of window.__harplusPseudo || []) node.textContent = text;
    delete window.__harplusPseudo;
    return true;
  }
  const MAP = {
    a: 'á', b: 'ƀ', c: 'ć', d: 'đ', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ĺ', m: 'ḿ', n: 'ń', o: 'ó', p: 'ṕ',
    r: 'ŕ', s: 'ś', t: 'ţ', u: 'ú', w: 'ẃ', y: 'ý', z: 'ź', A: 'Á', C: 'Ć', E: 'É', I: 'Í', N: 'Ń', O: 'Ó', S: 'Ś', U: 'Ú', Y: 'Ý', Z: 'Ź',
  };
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|SVG)$/i;
  const keep = (n) => {
    if (!n.textContent.trim()) return false;
    for (let el = n.parentElement; el; el = el.parentElement) {
      if (SKIP.test(el.tagName) || el.getAttribute('translate') === 'no') return false;
    }
    return true;
  };
  const nodes = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && nodes.length < 5000; n = walker.nextNode()) if (keep(n)) nodes.push(n);
  const saved = (window.__harplusPseudo = []);
  for (const n of nodes) {
    const text = n.textContent;
    saved.push([n, text]);
    const core = text.trim();
    const pad = core.length >= 3 ? ` ${'·'.repeat(Math.ceil(core.length * 0.4))}` : '';
    n.textContent = text.replace(/[A-Za-z]/g, (ch) => MAP[ch] || ch).replace(/\s*$/, (ws) => pad + ws);
  }
  return true;
}
```

- [ ] **Step 7: Add the two views to `captureViews`.** Insert them after the `noimages` view block and before the `nojs` block:

```js
    await view('rtl', {
      runMs: 30_000,
      restoreMs: 20_000,
      run: async () => {
        await this.evaluate(flipDir, true, 'main');
        await sleep(400);
        return grab('rtl');
      },
      restore: () => this.evaluate(flipDir, false, 'main'),
    });
    await view('pseudo', {
      runMs: 30_000,
      restoreMs: 20_000,
      run: async () => {
        await this.evaluate(pseudoText, true, 'main');
        await sleep(400);
        return grab('pseudo');
      },
      restore: () => this.evaluate(pseudoText, false, 'main'),
    });
```

- [ ] **Step 8: Update `docs/FORMAT.md`.** Make three edits:
  1. In the `screenshots` paragraph, change the view list to add `rtl` (`dir="rtl"` on `<html>`) and `pseudo` (text pseudo-localized: accented and about 40 % longer).
  2. In `capture.views`, add the new fields to the example and the field list:
     - `overflowX`: px wider than the window;
     - `clipped`: text elements whose content is cut off by `overflow: hidden/clip`;
     - `rtlChars`: share of letters that are Hebrew or Arabic;
     - `rtlUnmarked`: share of letters that are Hebrew or Arabic and shown left-to-right;
     - `dir`.
  3. Add one sentence: "The **International** plugin compares the `rtl` and `pseudo` views with the capture device's view."

- [ ] **Step 9: Run tests and an import check.**

Run: `npm test`, then `node -e "import('./extension/browser/capture.js').then(() => console.log('import ok'))"`
Expected: PASS and `import ok`. The runtime behaviour is covered end to end in Task 7.

- [ ] **Step 10: Commit.**

```bash
git add extension/core/views.js extension/browser/settings.js extension/ui/popup.html extension/ui/options.html extension/browser/capture.js docs/FORMAT.md test/views.test.mjs
git commit -m "Right-to-left and Long text capture views; overflow, clipping and RTL text metrics

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: International plugin

**Files:**
- Create: `extension/plugins/international.js`
- Modify: `extension/plugins/index.js` (register after `resilience`)
- Test: `test/international.test.mjs`

**Interfaces:**
- Consumes:
  - `capture.views` (base, `rtl`, `pseudo`) from Task 4;
  - `ctx.results.css.data.usage.properties`;
  - `ctx.results.meta.data` (`lang`, `dir`, `hreflang`, `canonical`);
  - `ctx.target.finalUrl`;
  - `baseView` from `core/views.js`.
- Produces a plugin with `{ id: 'international', area: 'international', group: 'other', phase: 'analyze' }`. Exports:
  - `LANG_TAG` (RegExp);
  - `cssDirection(props) → { physical, logical }`.
- `data` contains:
  - `extraClipped`, `longSideways`, `rtlMeasured`, `rtlSideways`, `rtlUnmarked`;
  - `css`;
  - `lang`, `langOk`, `dir`;
  - `hreflang`, `hreflangIssues`.

- [ ] **Step 1: Write the failing test.** Create `test/international.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { LANG_TAG, cssDirection } from '../extension/plugins/international.js';
import { getPlugins } from '../extension/plugins/index.js';
import { h } from '../extension/ui/render.js';

const reading = (views) => ({ log: { entries: [], _harplus: { capture: { device: 'desktop', views } } } });
const ctx = ({ props, meta } = {}) => ({
  results: {
    ...(props ? { css: { status: 'ok', data: { usage: { properties: props } } } } : {}),
    ...(meta ? { meta: { status: 'ok', data: meta } } : {}),
  },
  target: { finalUrl: 'https://s.test/' },
  skip: (m) => { throw new Error(m); },
});
const base = { overflowX: 0, clipped: 1, rtlUnmarked: 0, dir: 'ltr' };
const titles = (out) => out.findings.map((f) => `${f.severity}:${f.title}`);

test('registered in the analyze phase, International area', () => {
  const ids = getPlugins().map((p) => p.id);
  assert.equal(ids.indexOf('international'), ids.indexOf('resilience') + 1);
  assert.equal(plugin.area, 'international');
});

test('language tags', () => {
  for (const ok of ['en', 'en-US', 'zh-Hant', 'zh-Hant-TW', 'es-419', 'de-CH-1996']) assert.ok(LANG_TAG.test(ok), ok);
  for (const bad of ['english', 'en_US', 'e', 'de-XX-bad!', '']) assert.ok(!LANG_TAG.test(bad), bad);
});

test('css direction counts', () => {
  assert.deepEqual(cssDirection({ 'margin-left': 15, 'padding-right': 10, left: 2, 'border-top-left-radius': 1, 'margin-inline-start': 2, 'inset-inline-end': 1, 'border-start-end-radius': 1, color: 9 }), { physical: 28, logical: 4 });
});

test('long text: clipping boundary and sideways scroll; RTL sideways', () => {
  assert.deepEqual(titles(plugin.run(reading({ desktop: base, pseudo: { ...base, clipped: 3 } }), ctx())), []);
  const out = plugin.run(reading({ desktop: base, pseudo: { ...base, clipped: 4, overflowX: 40 }, rtl: { ...base, overflowX: 12 } }), ctx());
  assert.deepEqual(titles(out), [
    'medium:Text gets cut off when translated',
    'medium:Longer text makes the page scroll sideways',
    'medium:Right-to-left layout scrolls sideways',
  ]);
  assert.deepEqual(out.summary[0], { label: 'Long text', value: '3 clipped · scrolls sideways', rating: 'poor', headline: true });
  assert.deepEqual(out.summary[1], { label: 'Right-to-left', value: 'scrolls sideways' });
});

test('RTL text without dir: boundary 0.05', () => {
  assert.deepEqual(titles(plugin.run(reading({ desktop: { ...base, rtlUnmarked: 0.049 } }), ctx())), []);
  assert.deepEqual(titles(plugin.run(reading({ desktop: { ...base, rtlUnmarked: 0.05 } }), ctx())), ['medium:Right-to-left text without dir="rtl"']);
});

test('physical CSS boundary, invalid lang, hreflang issues', () => {
  assert.deepEqual(titles(plugin.run(reading({}), ctx({ props: { 'margin-left': 19 } }))), []);
  const out = plugin.run(reading({}), ctx({
    props: { 'margin-left': 15, 'padding-right': 10, 'margin-inline-start': 2 },
    meta: {
      lang: 'english', dir: null, canonical: 'https://s.test/',
      hreflang: [{ hreflang: 'en', href: 'https://s.test/' }, { hreflang: 'fr', href: 'https://s.test/fr/' }, { hreflang: 'de-XX-bad!', href: 'https://s.test/de/' }],
    },
  }));
  assert.deepEqual(titles(out), [
    'low:Layout CSS uses left/right instead of logical properties',
    'low:lang "english" is not a valid language tag',
    'low:hreflang problems',
  ]);
  assert.equal(out.findings[2].detail, 'invalid codes: de-XX-bad!; no x-default');
});

test('clean page: no findings; skip only without any input', () => {
  const clean = plugin.run(reading({ desktop: base, pseudo: { ...base }, rtl: { ...base } }), ctx({
    props: { 'margin-inline-start': 4 },
    meta: { lang: 'en', canonical: 'https://s.test/', hreflang: [{ hreflang: 'en', href: 'https://s.test' }] },
  }));
  assert.deepEqual(clean.findings, []);
  assert.equal(clean.summary[0].value, 'fits');
  assert.throws(() => plugin.run(reading(undefined), ctx()), /no view measurements, CSS or page metadata/);
});

test('glance checklist', () => {
  const out = plugin.run(reading({ desktop: base, pseudo: { ...base, clipped: 5 }, rtl: { ...base } }), ctx({ props: { 'margin-left': 30 }, meta: { lang: 'en', hreflang: [] } }));
  const g = String(plugin.glance({ status: 'ok', ...out }, h));
  assert.match(g, /Long text fits/);
  assert.match(g, /Right-to-left fits/);
  assert.match(g, /Physical \(left\/right\)/);
});
```

Arithmetic check:
- `cssDirection` physical is 15 + 10 + 2 + 1 = 28 and logical is 2 + 1 + 1 = 4.
- Physical 25 against logical 2: 25 ≥ 20 and 25 > 6, so it is flagged.
- hreflang: there are 3 alternates, there is a self entry (`en`), and there is no x-default.

- [ ] **Step 2: Run the test and check it fails.**

Run: `node --test test/international.test.mjs`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Create `extension/plugins/international.js`.**

```js
// International: how the page holds up in translation and right-to-left — from the Long text and
// Right-to-left views measured during capture, the CSS plugin's property counts and the page's
// lang / dir / hreflang. Offline, so it re-runs and works in the CLI on any reading that has the data.

import { baseView } from '../core/views.js';

export const LANG_TAG = /^[a-zA-Z]{2,3}(-[a-zA-Z]{4})?(-([a-zA-Z]{2}|\d{3}))?(-([a-zA-Z0-9]{5,8}|\d[a-zA-Z0-9]{3}))*$/;
const PHYSICAL = /^(margin|padding)-(left|right)$|^(left|right)$|^border-(left|right)(-(width|color|style))?$|^border-(top|bottom)-(left|right)-radius$/;
const LOGICAL = /^(margin|padding|inset|border)-inline|^border-(start|end)-(start|end)-radius$/;
const RTL_SHARE = 0.05;

export function cssDirection(props = {}) {
  let physical = 0;
  let logical = 0;
  for (const [k, n] of Object.entries(props)) {
    if (PHYSICAL.test(k)) physical += n;
    else if (LOGICAL.test(k)) logical += n;
  }
  return { physical, logical };
}

const mostlyPhysical = (css) => css.physical >= 20 && css.physical > 3 * css.logical;
const norm = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/$/, '') + x.search; } catch { return String(u || ''); } };

function run(reading, ctx) {
  const views = reading.log._harplus?.capture?.views || {};
  const base = views[baseView(reading)];
  const props = ctx.results.css?.status === 'ok' ? ctx.results.css.data?.usage?.properties : null;
  const meta = ctx.results.meta?.status === 'ok' ? ctx.results.meta.data : null;
  if (!base && !props && !meta) ctx.skip('no view measurements, CSS or page metadata in this reading');
  const findings = [];
  const add = (severity, title, detail) => findings.push({ severity, category: 'international', title, detail });

  let extraClipped = null;
  let longSideways = false;
  if (base && views.pseudo) {
    extraClipped = Math.max(0, (views.pseudo.clipped || 0) - (base.clipped || 0));
    longSideways = views.pseudo.overflowX > 0 && !(base.overflowX > 0);
    if (extraClipped >= 3) add('medium', 'Text gets cut off when translated', `${extraClipped} more text boxes clip their content when the text is about 40% longer.`);
    if (longSideways) add('medium', 'Longer text makes the page scroll sideways', `The page becomes ${views.pseudo.overflowX}px wider than the window.`);
  }
  const rtlMeasured = !!(base && views.rtl);
  const rtlSideways = rtlMeasured && views.rtl.overflowX > 0 && !(base.overflowX > 0);
  if (rtlSideways) add('medium', 'Right-to-left layout scrolls sideways', `With dir="rtl" the page becomes ${views.rtl.overflowX}px wider than the window.`);
  const rtlUnmarked = base?.rtlUnmarked ?? 0;
  if (rtlUnmarked >= RTL_SHARE) add('medium', 'Right-to-left text without dir="rtl"', `${Math.round(rtlUnmarked * 100)}% of the text is Arabic or Hebrew shown left-to-right — mark it with dir="rtl" (or dir="auto").`);

  const css = props ? cssDirection(props) : null;
  if (css && mostlyPhysical(css)) add('low', 'Layout CSS uses left/right instead of logical properties', `${css.physical} physical vs ${css.logical} logical declarations — margin-inline-start, inset-inline-end and friends mirror automatically in right-to-left.`);
  const lang = meta?.lang ?? null;
  const langOk = lang == null || LANG_TAG.test(lang);
  if (lang != null && !langOk) add('low', `lang "${lang}" is not a valid language tag`, 'Use a BCP 47 tag such as en, en-US or zh-Hant.');
  const alts = meta?.hreflang || [];
  const hreflangIssues = [];
  if (alts.length) {
    const bad = alts.filter((a) => a.hreflang !== 'x-default' && !LANG_TAG.test(a.hreflang)).map((a) => a.hreflang);
    if (bad.length) hreflangIssues.push(`invalid codes: ${bad.join(', ')}`);
    const self = norm(meta.canonical || ctx.target.finalUrl);
    if (!alts.some((a) => norm(a.href) === self)) hreflangIssues.push('no hreflang entry points at this page');
    if (alts.length >= 3 && !alts.some((a) => a.hreflang === 'x-default')) hreflangIssues.push('no x-default');
    if (hreflangIssues.length) add('low', 'hreflang problems', hreflangIssues.join('; '));
  }

  const summary = [];
  if (extraClipped != null) {
    const fits = extraClipped === 0 && !longSideways;
    summary.push({
      label: 'Long text', value: fits ? 'fits' : `${extraClipped} clipped${longSideways ? ' · scrolls sideways' : ''}`,
      rating: fits ? 'good' : extraClipped < 3 && !longSideways ? 'needs-improvement' : 'poor', headline: true,
    });
  }
  if (rtlMeasured) summary.push({ label: 'Right-to-left', value: rtlSideways ? 'scrolls sideways' : 'fits' });
  if (css) summary.push({ label: 'Logical CSS', value: `${css.logical} logical · ${css.physical} physical` });
  if (meta) summary.push({ label: 'Language', value: [lang || 'no lang', meta.dir || 'ltr', `${alts.length} hreflang`].join(' · ') });
  return {
    data: { extraClipped, longSideways, rtlMeasured, rtlSideways, rtlUnmarked, css, lang, langOk, dir: meta?.dir ?? null, hreflang: alts, hreflangIssues },
    findings,
    summary,
  };
}

function glance(r, h) {
  const d = r.data;
  const items = [
    d.lang != null && { label: `lang="${d.lang}" is a valid tag`, ok: d.langOk },
    { label: 'Text direction matches the script', ok: d.rtlUnmarked < RTL_SHARE },
    d.hreflang.length > 0 && { label: `hreflang (${d.hreflang.length})`, ok: !d.hreflangIssues.length, note: d.hreflangIssues.join('; ') },
    d.css && { label: 'Logical CSS', ok: !mostlyPhysical(d.css) },
    d.extraClipped != null && { label: 'Long text fits', ok: d.extraClipped < 3 && !d.longSideways },
    d.rtlMeasured && { label: 'Right-to-left fits', ok: !d.rtlSideways },
  ].filter(Boolean);
  return h.html`<div class="glance-grid">
    <section class="card"><h4>Translation and right-to-left</h4>${h.checklist(items)}</section>
    ${d.css ? h.html`<section class="card"><h4>CSS direction</h4>${h.stackBar({ label: 'Declarations', segments: [
      { label: 'Logical', value: d.css.logical, color: 'var(--c1)' },
      { label: 'Physical (left/right)', value: d.css.physical, color: 'var(--c2)' },
    ] })}</section>` : ''}
  </div>`;
}

export default {
  id: 'international',
  name: 'International',
  version: '0.1.0',
  phase: 'analyze',
  area: 'international',
  group: 'other',
  description: 'Translation and right-to-left readiness: longer text, mirrored layout, text direction, logical CSS, lang and hreflang.',
  tags: ['i18n'],
  run,
  glance,
};
```

- [ ] **Step 4: Register.** In `extension/plugins/index.js`:
  - add `import international from './international.js';`;
  - change `baseline, resilience,` to `baseline, resilience, international,`.

- [ ] **Step 5: Run the tests and check they pass.**

Run: `node --test test/international.test.mjs`, then `npm test`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add extension/plugins/international.js extension/plugins/index.js test/international.test.mjs
git commit -m "International plugin: long text, right-to-left, logical CSS, lang and hreflang

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: International section on the Screens page

**Files:**
- Modify: `extension/ui/report.js` (import `INTERNATIONAL_VIEWS`; add `intlChips`; add the section in `screensPane`)
- Test: `test/report.test.mjs`

**Interfaces:**
- Consumes `INTERNATIONAL_VIEWS` (Task 4), `ratingChip`, `viewImages`, `shotSwitch` and `VIEW_LABELS`.
- Produces a Screens section with heading `<h2>International</h2>`, the switch name `international-shot`, and tiles As designed, Right-to-left and Long text.

- [ ] **Step 1: Write the failing tests.** Append to `test/report.test.mjs`:

```js
test('screens: international section with chips', () => {
  const r = withViews();
  const hp = r.log._harplus;
  hp.screenshots.push(
    { kind: 'viewport', view: 'rtl', mimeType: 'image/png', data: PNG, cssWidth: 1280, cssHeight: 800 },
    { kind: 'viewport', view: 'pseudo', mimeType: 'image/png', data: PNG, cssWidth: 1280, cssHeight: 800 },
  );
  hp.capture.views.desktop = { ...hp.capture.views.desktop, overflowX: 0, clipped: 1 };
  hp.capture.views.rtl = { ...hp.capture.views.desktop, overflowX: 30 };
  hp.capture.views.pseudo = { ...hp.capture.views.desktop, clipped: 5, overflowX: 0 };
  const s = screens(renderReport(r, getPlugins()));
  assert.match(s, /<h2>International<\/h2>/);
  assert.match(s, /name="international-shot"/);
  assert.match(s, /<b>Right-to-left<\/b>/);
  assert.match(s, /rating-poor[^>]*>[\s\S]*?scrolls sideways/);
  assert.match(s, /rating-poor[^>]*>[\s\S]*?\+4 clipped/);
});

test('screens: international section absent for old readings', () => {
  assert.doesNotMatch(screens(renderReport(withViews(), getPlugins())), /<h2>International<\/h2>/);
});
```

- [ ] **Step 2: Run the tests and check they fail.**

Run: `node --test test/report.test.mjs`
Expected: the first new test FAILs, because there is no International section.

- [ ] **Step 3: Implement in `extension/ui/report.js`.**
  1. Add `INTERNATIONAL_VIEWS` to the import from `../core/views.js`.
  2. Add the following after `viewChips`:

```js
function intlChips(id, m, baseM) {
  if (!m) return '';
  const sideways = m.overflowX > 0 && !(baseM?.overflowX > 0);
  if (id === 'rtl') return sideways ? ratingChip('scrolls sideways', 'poor') : ratingChip('fits', 'good');
  const extra = Math.max(0, (m.clipped || 0) - (baseM?.clipped || 0));
  return html`${ratingChip(`+${extra} clipped`, extra === 0 ? 'good' : extra < 3 ? 'needs-improvement' : 'poor')}${sideways ? ratingChip('scrolls sideways', 'poor') : ''}`;
}
```

  3. In `screensPane`, add `const intl = INTERNATIONAL_VIEWS.filter((v) => by[v]);` next to `resilient`.
  4. After the Resilience section's closing `` ` : ''} ``, add:

```js
    ${intl.length && by[base] ? html`<section class="card views">
      <header class="views-head"><h2>International</h2>${shotSwitch('international-shot')}</header>
      <div class="resilience">
        <figure>${viewImages(by[base], 'As designed')}<figcaption><b>As designed</b></figcaption></figure>
        ${intl.map((v) => html`<figure>${viewImages(by[v], VIEW_LABELS[v])}<figcaption><b>${VIEW_LABELS[v]}</b>${intlChips(v, hp(reading).capture?.views?.[v], hp(reading).capture?.views?.[base])}</figcaption></figure>`)}
      </div>
    </section>` : ''}
```

- [ ] **Step 4: Run the tests and check they pass.**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add extension/ui/report.js test/report.test.mjs
git commit -m "Screens page: International section with right-to-left and long-text chips

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Test site, test image, green-check mock, e2e and docs

**Files:**
- Create: `scripts/make-test-image.mjs`, `test/e2e/site/img/big.jpg` (generated)
- Modify: `test/e2e/site/index.html`, `test/e2e/site/app.css`, `test/e2e/server.mjs`, `test/e2e/run.mjs`, `README.md`

**Interfaces:**
- Consumes everything above.

- [ ] **Step 1: Write the image generator and run it.** Create `scripts/make-test-image.mjs`:

```js
// Generates test/e2e/site/img/big.jpg — a 1600×1000 noisy JPEG for the images e2e check.
// Run once with Playwright's Chromium: node scripts/make-test-image.mjs
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* fall back to a global install */ }
  const root = execSync('npm root -g').toString().trim();
  return import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();
const dataUrl = await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 1600;
  c.height = 1000;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 1600, 1000);
  grad.addColorStop(0, '#2a78d6');
  grad.addColorStop(1, '#1baf7a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1600, 1000);
  const img = g.getImageData(0, 0, 1600, 1000);
  let s = 7;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 16807) % 2147483647;
    const n = (s % 64) - 32;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.9);
});
writeFileSync(fileURLToPath(new URL('../test/e2e/site/img/big.jpg', import.meta.url)), Buffer.from(dataUrl.split(',')[1], 'base64'));
await browser.close();
console.log('wrote test/e2e/site/img/big.jpg');
```

Run: `node scripts/make-test-image.mjs && ls -la test/e2e/site/img/big.jpg`
Expected: the file exists and is somewhere between 200 KB and 2 MB.

- [ ] **Step 2: Add the test-site fixtures.**

In `test/e2e/site/index.html`, inside `<main>`, directly before `<div style="height:2400px"></div>`, add:

```html
    <img src="/img/big.jpg" alt="Trail at dawn" style="width:300px">
    <p class="promo">Spring sale</p>
    <ul class="tags"><li>Free shipping</li><li>New arrivals</li><li>Members save</li></ul>
    <p lang="ar">مرحبا بكم في متجرنا. نقدم الشحن المجاني على جميع الطلبات داخل المدينة. اكتشف معدات التخييم والمشي لمسافات طويلة لدينا. عروض خاصة لأعضاء النادي كل أسبوع.</p>
```

Append to `test/e2e/site/app.css`:

```css
.promo { margin-left: 2rem; }
.tags li { display: inline-block; width: 16ch; overflow: hidden; white-space: nowrap; font-family: monospace; }
```

Expected effects:
- Each tag label is 12 or 13 characters, so it fits in 16ch. Pseudo-localized, it becomes 18 to 20 characters and clips. That makes 3 new clipped elements.
- The Arabic paragraph has `lang="ar"` but no `dir`, so it is shown left-to-right and counts toward `rtlUnmarked`.

- [ ] **Step 3: Add the green-check mock and the JPEG type.** In `test/e2e/server.mjs`:
  - Next to the existing `/__mock/` routes, add a route that answers `GET /__mock/greencheck/<host>` with JSON `{ "url": "<host>", "green": true, "hosted_by": "Test Host" }`. Follow the existing route style.
  - If the server's content-type map doesn't cover `.jpg`, add `jpg: 'image/jpeg'`.

- [ ] **Step 4: Update the e2e run (`test/e2e/run.mjs`).**
  - In the settings block, add to `plugins`: `` carbon: { options: { endpoint: `${base}/__mock/greencheck/` } }, ``.
  - Change the `shotViews(r1)` expectation to `['desktop', 'mobile', 'noimages', 'nocss', 'nojs', 'pseudo', 'rtl', 'tablet']`.
  - After the resilience assertions, add:

```js
    assert.equal(p.images?.status, 'ok', `images: ${p.images?.error}`);
    assert.ok(p.images.findings.some((f) => /larger than (it's|they're) shown/.test(f.title) && /big\.jpg/.test(f.detail || '')), 'oversized big.jpg');
    const bigImg = p.images.data.images.find((i) => i.src.endsWith('/img/big.jpg'));
    assert.ok(bigImg.webpNeeded > 0 && bigImg.webpNeeded < bigImg.bytes, `big.jpg re-encoded smaller: ${JSON.stringify(bigImg)}`);
    assert.equal(p.carbon?.status, 'ok', `carbon: ${p.carbon?.error}`);
    assert.ok(p.carbon.data.grams > 0 && /^(A\+|[A-F])$/.test(p.carbon.data.rating));
    assert.equal(p.carbon.data.hosts.find((x) => x.host === 'localhost')?.green, true, 'green check answered by the mock');
    assert.equal(p.international?.status, 'ok', `international: ${p.international?.error}`);
    const intl = p.international.findings.map((f) => f.title);
    const iv = hp.capture.views;
    assert.ok(intl.includes('Text gets cut off when translated'), JSON.stringify({ intl, base: iv.desktop, pseudo: iv.pseudo }));
    assert.ok(intl.includes('Right-to-left text without dir="rtl"'), JSON.stringify({ intl, base: iv.desktop }));
    // The tab is restored after the international views.
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('dir')), null, 'dir restored');
    assert.equal(await page.evaluate(() => document.querySelector('.tags li').textContent), 'Free shipping', 'text restored');
```

- [ ] **Step 5: Update `README.md`.**
  - In "What's in a reading", add a row for each new plugin to the matching table:
    - **Images** (Performance). It reads sizes, formats, loading hints and savings measured by re-encoding. Leaves your machine: re-fetches images from the browser cache.
    - **Carbon** (a new "Sustainability" table). It reads CO₂ per visit using the Sustainable Web Design Model v4. Leaves your machine: hostnames go to api.thegreenwebfoundation.org.
    - **International** (a new "International" table). It reads long text, right-to-left, logical CSS, lang and hreflang. Leaves your machine: no.
  - In "### The report", mention the seven areas and the Screens page's International section.

- [ ] **Step 6: Run everything.**

Run: `npm test`, then `npm run test:e2e`
Expected: PASS and "all e2e checks passed".
- If an existing e2e assertion changes only because of the new fixtures (image counts, alt counts, html-validate counts, a11y rules), update it minimally and report it.
- If a new assertion fails, investigate the plugin or capture code. Do not weaken the assertion. Report the evidence the assertion messages print.
- Then use the Read tool on `test/e2e/out/reading-screens.png` and `reading-area-sustainability.png` and report what they show.

- [ ] **Step 7: Commit.**

```bash
git add scripts/make-test-image.mjs test/e2e/site/img/big.jpg test/e2e/site/index.html test/e2e/site/app.css test/e2e/server.mjs test/e2e/run.mjs README.md
git commit -m "E2E: images, carbon (mocked green check) and international views; docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
