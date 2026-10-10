# Capture Views (Devices + Resilience) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every reading captures desktop, tablet and phone screenshots plus no-JavaScript, no-CSS and no-images views. The views are measured, findings are raised when content depends on JavaScript, and the Screens page shows a device line-up and a resilience grid.

**Architecture:**
- **Capture.** After the main capture has built the HAR and run the page plugins, `CaptureSession.captureViews()` produces the views and then restores the tab:
  - device views by resizing the viewport in place;
  - no-CSS and no-images by toggling the page in place and restoring it;
  - no-JS by one reload with scripts disabled, followed by one normal reload.
- **Shared helpers.** Pure helpers in `core/views.js` are used by the capture layer, a new offline `resilience` plugin and the report's Screens pane.

**Tech Stack:** Vanilla ES modules, no build step, no dependencies. Unit tests use `node:test`. The end-to-end test uses Playwright with Chromium (installed globally) and the unpacked extension.

**Spec:** `docs/superpowers/specs/2026-10-10-capture-views-design.md` (read it first).

## Global Constraints

- No build step and no dependencies in `extension/` or `cli/`.
- View ids are exactly `desktop`, `tablet`, `mobile`, `nojs`, `nocss` and `noimages`. UI labels: Desktop, Tablet, Phone, No JavaScript, No CSS, No images.
- Device view sizes:
  - desktop: 1280×800, DPR 1, not mobile;
  - tablet: 820×1180, DPR 2, mobile;
  - mobile: 390×844, DPR 3, mobile.

  These are the existing `DEVICES` presets plus a new desktop preset.
- Views run only after `recorder.build()`. The reading's HAR must never contain requests made by the views.
- The tab must end the capture with its original viewport, script execution enabled, and styles and images restored. No-JS is followed by a normal reload.
- A failing or timed-out view adds a capture warning plus a `capture.viewsSkipped` entry. It never fails the reading.
- No-JS runs only in `reload` mode. In other modes it is skipped with the reason `not in reload mode`.
- All six views are on by default (`settings.capture.views`).
- Resilience thresholds:
  - no-JS text ratio < 0.2 is **high**, or **medium** if `<noscript>` exists;
  - no-JS text ratio from 0.2 up to (but not including) 0.6 is **medium**;
  - no-JS link ratio < 0.5 with at least 5 base links is **medium**;
  - no-CSS text ratio > 1.3 is **info**.

  All of these findings use category `quality`. The rating is good at ≥ 0.8, needs-improvement at ≥ 0.2, and poor below.
- Every interpolated value goes through the escaping `html` tag.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Old and lite readings.** Screenshots may have no `view`, or a stored reading may hold only a thumbnail. The Screens pane must show only the base device. The hero must fall back to the thumbnail, and zoom indices must point at real screenshots. Pinned in Task 3 (`old reading without views`, `thumbnail-only reading`).
2. **Pages whose base text is zero**, such as canvas apps or image-only pages. The ratios must be 1, so no false "almost no content" finding appears. Pinned in Task 1 (`zero base`) and Task 2 (`no false alarm when base has no text`).
3. **Views the user switched off.** They must produce no shots and a `disabled` skip. The resilience plugin must report only the views that exist, and the Screens pane must show only those. Pinned in Task 2 (`partial views`) and Task 3 (`partial views`).
4. **Snapshot and record modes.** No-JS must be skipped with the reason recorded, and no `nojs` shot must appear. Pinned in Task 6 (snapshot assertion).
5. **Tab restored after capture.** Scripts must run again, the viewport must have its original width, and the HAR must have no duplicate document entries. Pinned in Task 6 (restoration assertions).

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `extension/core/views.js` | create | view ids, labels, base view, shots grouped by view, ratio comparison, rating |
| `extension/browser/settings.js` | modify | `capture.views` defaults |
| `extension/plugins/resilience.js` | create | offline findings and summary from `capture.views`; glance |
| `extension/plugins/index.js` | modify | register `resilience` after `baseline` |
| `extension/ui/report.js` | modify | Screens pane layout A; hero picks the base viewport; zoom by screenshot index |
| `extension/ui/reading.js` | modify | zoom handler uses the index |
| `extension/ui/theme.css` | modify | line-up, resilience grid, switch, chips, print |
| `extension/ui/popup.html`, `popup.js`, `options.html` | modify | Views checkboxes |
| `extension/browser/capture.js` | modify | desktop preset, `shoot(view)`, `measureView`, `stripStyles`, `stripImages`, `captureViews()` |
| `docs/FORMAT.md`, `README.md` | modify | document `view`, `capture.views`, `capture.viewsSkipped`, the settings and the Screens page |
| `test/e2e/site/main.js`, `test/e2e/run.mjs` | modify | content rendered by script; end-to-end assertions |
| `test/views.test.mjs`, `test/resilience.test.mjs` | create | unit tests |
| `test/report.test.mjs` | modify | Screens pane tests |

---

### Task 1: View helpers and settings defaults

**Files:**
- Create: `extension/core/views.js`
- Modify: `extension/browser/settings.js` (`DEFAULTS.capture`)
- Test: `test/views.test.mjs`

**Interfaces:**
- Produces, from `extension/core/views.js`:
  - `DEVICE_VIEWS = ['desktop', 'tablet', 'mobile']`
  - `RESILIENCE_VIEWS = ['nojs', 'nocss', 'noimages']`
  - `VIEWS` (all six, in that order)
  - `VIEW_LABELS` (an id → label object)
  - `baseView(reading) → 'desktop' | 'tablet' | 'mobile'`
  - `shotView(shot, base) → viewId`
  - `shotsByView(reading) → { [viewId]: { viewport?: { shot, index }, fullpage?: { shot, index } } }`
  - `ratio(n, base) → number`
  - `compareViews(views, base) → { base, views: { [id]: { ...measure, textRatio, linkRatio } } } | null`
  - `ratingFor(r) → 'good' | 'needs-improvement' | 'poor'`
- Produces `DEFAULTS.capture.views = { desktop: true, tablet: true, mobile: true, nojs: true, nocss: true, noimages: true }`.

- [ ] **Step 1: Write the failing test.** Create `test/views.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEWS, VIEW_LABELS, baseView, shotView, shotsByView, ratio, compareViews, ratingFor,
} from '../extension/core/views.js';
import { DEFAULTS, merge } from '../extension/browser/settings.js';

const reading = (capture, screenshots) => ({ log: { _harplus: { capture, screenshots } } });

test('view ids and labels', () => {
  assert.deepEqual(VIEWS, ['desktop', 'tablet', 'mobile', 'nojs', 'nocss', 'noimages']);
  assert.equal(VIEW_LABELS.mobile, 'Phone');
  assert.equal(VIEW_LABELS.nojs, 'No JavaScript');
});

test('base view comes from the capture device', () => {
  assert.equal(baseView(reading({ device: 'mobile' }, [])), 'mobile');
  assert.equal(baseView(reading({ device: 'desktop' }, [])), 'desktop');
  assert.equal(baseView(reading({}, [])), 'desktop');
  assert.equal(baseView(reading({ device: 'toaster' }, [])), 'desktop');
  assert.equal(shotView({ view: 'nojs' }, 'desktop'), 'nojs');
  assert.equal(shotView({}, 'tablet'), 'tablet');
});

test('shots grouped by view with their screenshot index; first shot of each kind wins', () => {
  const shots = [
    { kind: 'viewport', view: 'desktop', cssWidth: 1280 },
    { kind: 'thumbnail' },
    { kind: 'fullpage', view: 'desktop' },
    { kind: 'viewport', view: 'mobile', cssWidth: 390 },
    { kind: 'viewport', view: 'mobile', cssWidth: 999 },
  ];
  const by = shotsByView(reading({ device: 'desktop' }, shots));
  assert.deepEqual(Object.keys(by).sort(), ['desktop', 'mobile']);
  assert.equal(by.desktop.viewport.index, 0);
  assert.equal(by.desktop.fullpage.index, 2);
  assert.equal(by.mobile.viewport.shot.cssWidth, 390);
});

test('old readings: shots without view belong to the base view', () => {
  const by = shotsByView(reading({ device: 'tablet' }, [{ kind: 'viewport' }, { kind: 'fullpage' }]));
  assert.deepEqual(Object.keys(by), ['tablet']);
  assert.deepEqual(shotsByView({ log: { _harplus: {} } }), {});
});

test('ratios and comparison (zero base → 1)', () => {
  assert.equal(ratio(50, 200), 0.25);
  assert.equal(ratio(10, 0), 1);
  assert.equal(ratio(0, 0), 1);
  const cmp = compareViews({
    desktop: { text: 1000, links: 20 },
    nojs: { text: 150, links: 4 },
    nocss: { text: 1400, links: 20 },
  }, 'desktop');
  assert.equal(cmp.base, 'desktop');
  assert.equal(cmp.views.nojs.textRatio, 0.15);
  assert.equal(cmp.views.nojs.linkRatio, 0.2);
  assert.equal(cmp.views.nocss.textRatio, 1.4);
  assert.equal(cmp.views.desktop.textRatio, 1);
  assert.equal(compareViews({ nojs: { text: 1, links: 1 } }, 'desktop'), null);
  assert.equal(compareViews(undefined, 'desktop'), null);
});

test('zero base: ratios are 1 so nothing looks lost', () => {
  const cmp = compareViews({ desktop: { text: 0, links: 0 }, nojs: { text: 0, links: 0 } }, 'desktop');
  assert.equal(cmp.views.nojs.textRatio, 1);
  assert.equal(cmp.views.nojs.linkRatio, 1);
});

test('ratingFor thresholds', () => {
  assert.equal(ratingFor(0.8), 'good');
  assert.equal(ratingFor(0.79), 'needs-improvement');
  assert.equal(ratingFor(0.2), 'needs-improvement');
  assert.equal(ratingFor(0.19), 'poor');
});

test('settings: all views on by default; user overrides survive merge', () => {
  assert.deepEqual(DEFAULTS.capture.views, { desktop: true, tablet: true, mobile: true, nojs: true, nocss: true, noimages: true });
  const s = merge(DEFAULTS, { capture: { views: { nojs: false } } });
  assert.equal(s.capture.views.nojs, false);
  assert.equal(s.capture.views.tablet, true);
});
```

- [ ] **Step 2: Run the test and check that it fails.**

Run: `node --test test/views.test.mjs`
Expected: FAIL with `Cannot find module '…/extension/core/views.js'`.

- [ ] **Step 3: Create `extension/core/views.js`.**

```js
// Capture views: the device and resilience variants of a reading's screenshots. Pure helpers shared
// by the capture layer, the resilience plugin and the report.

export const DEVICE_VIEWS = ['desktop', 'tablet', 'mobile'];
export const RESILIENCE_VIEWS = ['nojs', 'nocss', 'noimages'];
export const VIEWS = [...DEVICE_VIEWS, ...RESILIENCE_VIEWS];
export const VIEW_LABELS = {
  desktop: 'Desktop', tablet: 'Tablet', mobile: 'Phone', nojs: 'No JavaScript', nocss: 'No CSS', noimages: 'No images',
};

/** The view the main capture used: its device, or desktop. */
export function baseView(reading) {
  const d = reading.log._harplus?.capture?.device;
  return DEVICE_VIEWS.includes(d) ? d : 'desktop';
}

/** A screenshot's view; readings from before views were added have none and belong to the base view. */
export const shotView = (shot, base) => (VIEWS.includes(shot?.view) ? shot.view : base);

/** { [view]: { viewport: { shot, index }, fullpage: { shot, index } } } — index points into screenshots. */
export function shotsByView(reading) {
  const base = baseView(reading);
  const out = {};
  (reading.log._harplus?.screenshots || []).forEach((shot, index) => {
    if (shot.kind !== 'viewport' && shot.kind !== 'fullpage') return;
    const slot = (out[shotView(shot, base)] ||= {});
    if (!slot[shot.kind]) slot[shot.kind] = { shot, index };
  });
  return out;
}

/** n as a share of base; a base of 0 means there was nothing to lose, so 1. */
export const ratio = (n, base) => (base > 0 ? (n || 0) / base : 1);

/** Ratios of every measured view against the base view's measurement, or null without a base. */
export function compareViews(views, base) {
  const b = views?.[base];
  if (!b) return null;
  const out = {};
  for (const [id, m] of Object.entries(views)) {
    out[id] = { ...m, textRatio: ratio(m.text, b.text), linkRatio: ratio(m.links, b.links) };
  }
  return { base, views: out };
}

export const ratingFor = (r) => (r >= 0.8 ? 'good' : r >= 0.2 ? 'needs-improvement' : 'poor');
```

- [ ] **Step 4: Add the defaults in `extension/browser/settings.js`.** Inside `DEFAULTS.capture`, after `fullPage: true,`, add:

```js
    views: { desktop: true, tablet: true, mobile: true, nojs: true, nocss: true, noimages: true },
```

- [ ] **Step 5: Run the tests and check that they pass.**

Run: `node --test test/views.test.mjs`, then `npm test`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add extension/core/views.js extension/browser/settings.js test/views.test.mjs
git commit -m "Add capture view helpers and view settings defaults

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Resilience plugin

**Files:**
- Create: `extension/plugins/resilience.js`
- Modify: `extension/plugins/index.js` (import, plus `BUILTIN` after `baseline`)
- Test: `test/resilience.test.mjs`

**Interfaces:**
- Consumes `compareViews`, `baseView`, `ratingFor`, `VIEW_LABELS` and `VIEWS` from `core/views.js` (Task 1), and the `h` chart kit (`h.hbars`, `h.table`, `h.html`).
- Produces a plugin `{ id: 'resilience', group: 'build', phase: 'analyze', run, render, glance }`.
  - `data` is the `compareViews` output.
  - `summary` labels are `Without JavaScript` (rated, headline), `Without CSS` and `Without images`.

- [ ] **Step 1: Write the failing test.** Create `test/resilience.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../extension/plugins/resilience.js';
import { getPlugins } from '../extension/plugins/index.js';
import { h } from '../extension/ui/render.js';

const reading = (views, device = 'desktop') => ({ log: { entries: [], _harplus: { capture: { device, views } } } });
const ctx = { skip: (why) => { const e = new Error(why); e.name = 'SkipError'; throw e; } };
const run = (views, device) => plugin.run(reading(views, device), ctx);
const base = { text: 1000, links: 20, images: 10, imagesWithAlt: 8, noscript: false };
const titles = (out) => out.findings.map((f) => `${f.severity}:${f.title}`);

test('registered after baseline in the build group', () => {
  const ids = getPlugins().map((p) => p.id);
  assert.equal(ids.indexOf('resilience'), ids.indexOf('baseline') + 1);
  assert.equal(plugin.group, 'build');
  assert.equal(plugin.phase, 'analyze');
});

test('skips without measurements', () => {
  assert.throws(() => run(undefined), /no view measurements/);
  assert.throws(() => run({ desktop: base }), /no view measurements/);
});

test('no-JS thresholds: high below 0.2, medium below 0.6, none at 0.6', () => {
  assert.deepEqual(titles(run({ desktop: base, nojs: { ...base, text: 199, links: 20 } })), ['high:Page shows almost no content without JavaScript']);
  assert.deepEqual(titles(run({ desktop: base, nojs: { ...base, text: 200, links: 20 } })), ['medium:Much of the content needs JavaScript']);
  assert.deepEqual(titles(run({ desktop: base, nojs: { ...base, text: 599, links: 20 } })), ['medium:Much of the content needs JavaScript']);
  assert.deepEqual(titles(run({ desktop: base, nojs: { ...base, text: 600, links: 20 } })), []);
});

test('<noscript> fallback downgrades the high finding to medium and says so', () => {
  const out = run({ desktop: base, nojs: { ...base, text: 10, links: 20, noscript: true } });
  assert.equal(out.findings[0].severity, 'medium');
  assert.match(out.findings[0].detail, /1% of the text is visible; a <noscript> fallback exists/);
});

test('links finding needs at least 5 base links', () => {
  assert.ok(titles(run({ desktop: base, nojs: { ...base, text: 900, links: 9 } })).includes('medium:Most links need JavaScript'));
  assert.deepEqual(titles(run({ desktop: { ...base, links: 4 }, nojs: { ...base, text: 900, links: 0 } })), []);
});

test('no-CSS hidden content is info above 1.3', () => {
  assert.deepEqual(titles(run({ desktop: base, nocss: { ...base, text: 1301 } })), ['info:Hidden content appears without CSS']);
  assert.deepEqual(titles(run({ desktop: base, nocss: { ...base, text: 1300 } })), []);
});

test('no false alarm when base has no text', () => {
  const out = run({ desktop: { ...base, text: 0, links: 0 }, nojs: { ...base, text: 0, links: 0 } });
  assert.deepEqual(out.findings, []);
});

test('summary: rated headline for no-JS, rows for CSS and images; partial views', () => {
  const out = run({ mobile: base, nojs: { ...base, text: 150, links: 4 }, noimages: { ...base } }, 'mobile');
  assert.equal(out.data.base, 'mobile');
  const js = out.summary.find((s) => s.label === 'Without JavaScript');
  assert.deepEqual(js, { label: 'Without JavaScript', value: '15% of text · 20% of links', rating: 'poor', headline: true });
  assert.equal(out.summary.find((s) => s.label === 'Without images').value, '8 of 10 images have alt text');
  assert.equal(out.summary.find((s) => s.label === 'Without CSS'), undefined, 'no-CSS view absent → no row');
});

test('glance: bars of text and links per view; render: table', () => {
  const out = run({ desktop: base, tablet: { ...base, text: 950 }, nojs: { ...base, text: 150, links: 4 } });
  const g = String(plugin.glance({ status: 'ok', ...out }, h));
  assert.match(g, /Visible text vs\. Desktop/);
  assert.match(g, /No JavaScript/);
  assert.match(g, /<b>15%<\/b>/);
  assert.match(g, /<b>95%<\/b>/);
  const r = String(plugin.render({ status: 'ok', ...out }, h));
  assert.match(r, /<th scope="col">View<\/th>/);
  assert.match(r, /Tablet/);
});
```

- [ ] **Step 2: Run the test and check that it fails.**

Run: `node --test test/resilience.test.mjs`
Expected: FAIL with `Cannot find module '…/extension/plugins/resilience.js'`.

- [ ] **Step 3: Create `extension/plugins/resilience.js`.**

```js
// Resilience: how much of the page survives without JavaScript, CSS or images. Compares the
// measurements the capture took for each view (capture.views) — offline, so it re-runs and works
// in the CLI on any reading that has them.

import { compareViews, baseView, ratingFor, VIEW_LABELS, VIEWS } from '../core/views.js';

const pct = (r) => `${Math.round(r * 100)}%`;

function run(reading, ctx) {
  const cmp = compareViews(reading.log._harplus?.capture?.views, baseView(reading));
  if (!cmp || Object.keys(cmp.views).length < 2) ctx.skip('no view measurements in this reading — take a new reading with views enabled');
  const { views } = cmp;
  const base = views[cmp.base];
  const findings = [];
  const summary = [];

  const js = views.nojs;
  if (js) {
    if (js.textRatio < 0.2) {
      findings.push({
        severity: js.noscript ? 'medium' : 'high', category: 'quality',
        title: 'Page shows almost no content without JavaScript',
        detail: `${pct(js.textRatio)} of the text is visible${js.noscript ? '; a <noscript> fallback exists' : ''}.`,
      });
    } else if (js.textRatio < 0.6) {
      findings.push({ severity: 'medium', category: 'quality', title: 'Much of the content needs JavaScript', detail: `${pct(js.textRatio)} of the text is visible without JavaScript.` });
    }
    if (base.links >= 5 && js.linkRatio < 0.5) {
      findings.push({ severity: 'medium', category: 'quality', title: 'Most links need JavaScript', detail: `${js.links} of ${base.links} links are visible without JavaScript.` });
    }
    summary.push({ label: 'Without JavaScript', value: `${pct(js.textRatio)} of text · ${pct(js.linkRatio)} of links`, rating: ratingFor(js.textRatio), headline: true });
  }
  const css = views.nocss;
  if (css) {
    if (css.textRatio > 1.3) {
      findings.push({ severity: 'info', category: 'quality', title: 'Hidden content appears without CSS', detail: 'Menus, screen-reader text or duplicated content become visible — check the reading order.' });
    }
    summary.push({ label: 'Without CSS', value: `${pct(css.textRatio)} of text` });
  }
  const img = views.noimages;
  if (img) summary.push({ label: 'Without images', value: `${img.imagesWithAlt} of ${img.images} images have alt text` });
  return { data: cmp, findings, summary };
}

const present = (r) => VIEWS.filter((id) => r.data?.views?.[id]);
const RESILIENT = new Set(['nojs', 'nocss', 'noimages']);

function glance(r, h) {
  const rows = (key) => present(r).map((id) => ({
    label: VIEW_LABELS[id], value: Math.round(r.data.views[id][key] * 100), display: pct(r.data.views[id][key]),
    color: RESILIENT.has(id) ? 'var(--c2)' : 'var(--c1)',
  }));
  return h.html`<section class="card"><h4>Visible text vs. ${VIEW_LABELS[r.data.base]}</h4>${h.hbars({ rows: rows('textRatio'), label: 'Visible text per view' })}
    <h4>Visible links</h4>${h.hbars({ rows: rows('linkRatio'), label: 'Visible links per view' })}</section>`;
}

function render(r, h) {
  return h.table(present(r).map((id) => {
    const v = r.data.views[id];
    return { view: VIEW_LABELS[id], text: `${v.text} (${pct(v.textRatio)})`, links: `${v.links} (${pct(v.linkRatio)})`, images: `${v.imagesWithAlt}/${v.images} with alt`, size: `${v.cssWidth}×${v.cssHeight}` };
  }), [
    { key: 'view', label: 'View' }, { key: 'text', label: 'Visible text' }, { key: 'links', label: 'Links' },
    { key: 'images', label: 'Images' }, { key: 'size', label: 'Viewport × page height' },
  ]);
}

export default {
  id: 'resilience',
  name: 'Resilience',
  version: '0.1.0',
  phase: 'analyze',
  group: 'build',
  description: 'How much of the page survives without JavaScript, CSS or images, from the views measured during capture.',
  tags: ['quality', 'progressive-enhancement'],
  run,
  render,
  glance,
};
```

- [ ] **Step 4: Register it in `extension/plugins/index.js`.**
  - Add `import resilience from './resilience.js';` after the `baseline` import.
  - In `BUILTIN`, change `tech, javascript, baseline, network, security,` to `tech, javascript, baseline, resilience, network, security,`.

- [ ] **Step 5: Run the tests and check that they pass.**

Run: `node --test test/resilience.test.mjs`, then `npm test`
Expected: PASS. The existing CLI test still passes: on the fixture, `resilience` is `skipped`, because the fixture has no `capture.views`.

- [ ] **Step 6: Commit.**

```bash
git add extension/plugins/resilience.js extension/plugins/index.js test/resilience.test.mjs
git commit -m "Add resilience plugin: findings when content needs JavaScript or hides behind CSS

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Screens pane layout A, hero, zoom by index

**Files:**
- Modify: `extension/ui/report.js`. In the imports, add `shotsByView`, `baseView`, `shotView`, `compareViews`, `ratingFor`, `VIEW_LABELS`, `DEVICE_VIEWS` and `RESILIENCE_VIEWS` from `../core/views.js`. Also change the hero in `overviewPane` and rewrite `screensPane`.
- Modify: `extension/ui/reading.js` (the zoom handler)
- Modify: `extension/ui/theme.css` (`@layer pages`: append to the report block, and extend `@media print`)
- Test: `test/report.test.mjs` (append)

**Interfaces:**
- Consumes the Task 1 helpers and `h.icon`.
- Produces `data-zoom="<screenshot index>"` on every zoomable image (hero and Screens). `reading.js` looks up `hp().screenshots[Number(index)]`.

- [ ] **Step 1: Write the failing tests.** Append to `test/report.test.mjs`:

```js
const PNG = 'iVBORw0KGgo=';
const withViews = () => {
  const r = load();
  const hp = r.log._harplus;
  hp.capture.device = 'desktop';
  const shot = (view, kind, cssWidth, cssHeight) => ({ kind, view, mimeType: 'image/png', encoding: 'base64', data: PNG, cssWidth, cssHeight, dpr: 1 });
  hp.screenshots = [
    shot('desktop', 'viewport', 1280, 800), { kind: 'thumbnail', mimeType: 'image/png', data: PNG }, shot('desktop', 'fullpage', 1280, 4000),
    shot('tablet', 'viewport', 820, 1180), shot('tablet', 'fullpage', 820, 5200),
    shot('mobile', 'viewport', 390, 844), shot('mobile', 'fullpage', 390, 9000),
    shot('nojs', 'viewport', 1280, 800), shot('nocss', 'viewport', 1280, 800), shot('noimages', 'viewport', 1280, 800),
  ];
  hp.capture.views = {
    desktop: { text: 1000, links: 20, images: 10, imagesWithAlt: 8, cssWidth: 1280, cssHeight: 4000 },
    nojs: { text: 40, links: 2, images: 10, imagesWithAlt: 8, cssWidth: 1280, cssHeight: 900 },
    nocss: { text: 1400, links: 20, images: 10, imagesWithAlt: 8, cssWidth: 1280, cssHeight: 9000 },
    noimages: { text: 1000, links: 20, images: 10, imagesWithAlt: 8, cssWidth: 1280, cssHeight: 3900 },
  };
  return r;
};
const screens = (out) => out.slice(out.indexOf('id="screens"'), out.indexOf('id="notes"'));

test('screens pane: device line-up at relative scale and resilience grid with chips', () => {
  const s = screens(renderReport(withViews(), getPlugins()));
  assert.match(s, /<h2>Devices/);
  assert.match(s, /<h2>Resilience/);
  assert.match(s, /flex:0 1 51\.61%/, 'desktop share of 1280+820+390');
  assert.match(s, /flex:0 1 15\.73%/, 'phone share');
  assert.match(s, /<b>Phone<\/b> · 390×844/);
  assert.match(s, /<b>As designed<\/b>/);
  assert.match(s, /rating-poor[^>]*>[\s\S]*?4% of text/);
  assert.match(s, /140% of text/);
  assert.match(s, /8 of 10 images have alt text/);
  assert.match(s, /type="radio" name="devices-shot" value="fold" checked/);
  assert.match(s, /type="radio" name="resilience-shot" value="full"/);
  assert.match(s, /data-zoom="6"/, 'phone full page zooms to screenshot index 6');
});

test('screens pane: partial views', () => {
  const r = withViews();
  r.log._harplus.screenshots = r.log._harplus.screenshots.filter((s) => !['tablet', 'nocss'].includes(s.view));
  const s = screens(renderReport(r, getPlugins()));
  assert.doesNotMatch(s, /<b>Tablet<\/b>/);
  assert.doesNotMatch(s, /<b>No CSS<\/b>/);
  assert.match(s, /<b>No JavaScript<\/b>/);
});

test('screens pane: old reading without views shows the base device only', () => {
  const s = screens(renderReport(load(), getPlugins()));
  assert.match(s, /<h2>Devices/);
  assert.doesNotMatch(s, /<h2>Resilience/);
  assert.doesNotMatch(s, /undefined|NaN/);
});

test('hero uses the base viewport by index; thumbnail-only reading falls back', () => {
  const r = withViews();
  r.log._harplus.screenshots.unshift({ kind: 'viewport', view: 'nojs', mimeType: 'image/png', data: PNG, cssWidth: 1280, cssHeight: 800 });
  const out = renderReport(r, getPlugins());
  const hero = out.slice(out.indexOf('class="card hero"'), out.indexOf('class="hero-text"'));
  assert.match(hero, /data-zoom="1"/, 'skips the leading nojs viewport');
  const lite = load();
  lite.log._harplus.screenshots = [{ kind: 'thumbnail', mimeType: 'image/png', data: PNG }];
  const out2 = renderReport(lite, getPlugins());
  assert.match(out2.slice(out2.indexOf('class="card hero"'), out2.indexOf('class="hero-text"')), /data-zoom="0"/);
  assert.match(screens(out2), /No screenshots in this reading/);
});
```

- [ ] **Step 2: Run the tests and check that they fail.**

Run: `node --test test/report.test.mjs`
Expected: the four new tests FAIL (no `<h2>Devices`, and `data-zoom="viewport"` instead of an index).

- [ ] **Step 3: Update the hero in `overviewPane`** (`extension/ui/report.js`). Replace

```js
  const shots = r.screenshots || [];
  const shot = shots.find((s) => s.kind === 'viewport') || shots.find((s) => s.kind === 'thumbnail');
```

with

```js
  const shots = r.screenshots || [];
  const base = baseView(reading);
  let heroIndex = shots.findIndex((s) => s.kind === 'viewport' && shotView(s, base) === base);
  if (heroIndex < 0) heroIndex = shots.findIndex((s) => s.kind === 'thumbnail');
  const shot = shots[heroIndex];
```

In the hero `<img>`, change `data-zoom="${shot.kind}"` to `data-zoom="${heroIndex}"`.

- [ ] **Step 4: Replace `screensPane` in `extension/ui/report.js`.**

```js
const pct = (r) => `${Math.round(r * 100)}%`;

function ratingChip(text, rating) {
  const name = rating === 'good' ? 'ok' : rating === 'poor' ? 'fail' : 'up';
  return html`<span class="chip-r rating-${rating}">${h.icon(name, { size: 12 })}${text}</span>`;
}

function viewChips(id, c) {
  if (!c) return '';
  if (id === 'nojs') return html`${ratingChip(`${pct(c.textRatio)} of text`, ratingFor(c.textRatio))}${ratingChip(`${pct(c.linkRatio)} of links`, ratingFor(c.linkRatio))}`;
  if (id === 'nocss') return ratingChip(`${pct(c.textRatio)} of text`, c.textRatio > 1.3 ? 'needs-improvement' : 'good');
  if (id === 'noimages') return ratingChip(`${c.imagesWithAlt} of ${c.images} images have alt text`, c.images && c.imagesWithAlt < c.images ? 'needs-improvement' : 'good');
  return '';
}

/** Above-the-fold and full-page images for one view; CSS shows one, picked by the section's switch. */
function viewImages(entry, label) {
  const img = (e, cls, what) => (e ? html`<img class="${cls}" src="${screenshotURL(e.shot)}" alt="${label} — ${what}" data-zoom="${e.index}" loading="lazy">` : '');
  return html`<div class="frame">${img(entry.viewport, 'shot-fold', 'above the fold')}${img(entry.fullpage || entry.viewport, 'shot-full', 'full page')}</div>`;
}

const shotSwitch = (name) => html`<span class="seg" role="radiogroup" aria-label="Screenshot extent">
  <label><input type="radio" name="${name}" value="fold" checked> Above the fold</label>
  <label><input type="radio" name="${name}" value="full"> Full page</label></span>`;

function screensPane(reading) {
  const by = shotsByView(reading);
  const base = baseView(reading);
  const devices = DEVICE_VIEWS.filter((v) => by[v]);
  const resilient = RESILIENCE_VIEWS.filter((v) => by[v]);
  const cmp = compareViews(hp(reading).capture?.views, base);
  const sizeOf = (v) => (by[v].viewport || by[v].fullpage).shot;
  const total = devices.reduce((n, v) => n + (Number(sizeOf(v).cssWidth) || 0), 0) || 1;
  return html`<section class="pane" id="screens" aria-labelledby="screens-h"><h1 id="screens-h">Screens</h1>
    ${devices.length ? html`<section class="card views">
      <h2>Devices ${shotSwitch('devices-shot')}</h2>
      <div class="lineup">${devices.map((v) => {
        const s = sizeOf(v);
        return html`<figure style="flex:0 1 ${(((Number(s.cssWidth) || 0) / total) * 100).toFixed(2)}%">${viewImages(by[v], VIEW_LABELS[v])}<figcaption><b>${VIEW_LABELS[v]}</b> · ${s.cssWidth}×${s.cssHeight}</figcaption></figure>`;
      })}</div>
    </section>` : html`<p class="muted">No screenshots in this reading.</p>`}
    ${resilient.length && by[base] ? html`<section class="card views">
      <h2>Resilience ${shotSwitch('resilience-shot')}</h2>
      <div class="resilience">
        <figure>${viewImages(by[base], 'As designed')}<figcaption><b>As designed</b></figcaption></figure>
        ${resilient.map((v) => html`<figure>${viewImages(by[v], VIEW_LABELS[v])}<figcaption><b>${VIEW_LABELS[v]}</b>${viewChips(v, cmp?.views[v])}</figcaption></figure>`)}
      </div>
    </section>` : ''}
  </section>`;
}
```

- [ ] **Step 5: Update the zoom handler in `extension/ui/reading.js`.**
  - Add `import { VIEW_LABELS, shotView, baseView } from '../core/views.js';`.
  - Replace the `zoom` block in the click handler:

```js
  const zoom = t.closest('[data-zoom]');
  if (zoom) {
    const shot = hp().screenshots[Number(zoom.dataset.zoom)];
    if (!shot) return;
    const what = shot.kind === 'fullpage' ? 'full page' : shot.kind === 'thumbnail' ? 'thumbnail' : 'above the fold';
    openDialog(`${VIEW_LABELS[shotView(shot, baseView(reading))]} · ${what}`,
      html`<img src="${screenshotURL(shot)}" alt="Screenshot" style="width:100%">`);
    return;
  }
```

- [ ] **Step 6: Add the CSS to `extension/ui/theme.css`.**

Append inside `@layer pages`, after the report rules and before `@media (max-width: 900px)`:

```css
  /* ---------- screens: devices line-up and resilience grid ---------- */
  .views h2 { display: flex; align-items: center; gap: 0.6rem; }
  .views .seg { margin-inline-start: auto; display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; text-transform: none; letter-spacing: 0; font-size: 0.75rem; font-weight: 400; color: var(--text); }
  .views .seg label { position: relative; padding: 0.15rem 0.6rem; cursor: pointer; }
  .views .seg input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; }
  .views .seg label:has(input:checked) { background: var(--panel-2); font-weight: 600; }
  .views .seg label:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: -2px; }
  .views .frame { max-height: 70vh; overflow: auto; border: 1px solid var(--line); border-radius: 4px; background: var(--panel-2); }
  .views img { display: block; width: 100%; cursor: zoom-in; }
  .views .shot-full { display: none; }
  .views:has(input[value="full"]:checked) .shot-fold { display: none; }
  .views:has(input[value="full"]:checked) .shot-full { display: block; }
  .lineup { display: flex; align-items: flex-end; gap: 1rem; }
  .lineup figure, .resilience figure { margin: 0; display: grid; gap: 0.35rem; min-width: 0; font-size: 0.78rem; color: var(--muted); }
  .lineup figcaption b, .resilience figcaption b { color: var(--text); font-weight: 600; }
  .resilience { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); gap: 0.9rem; align-items: start; }
  .resilience figcaption { display: flex; flex-wrap: wrap; gap: 0.3rem 0.5rem; align-items: center; }
  .resilience figcaption b { width: 100%; }
  .chip-r { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0 0.45rem; border-radius: 999px; background: var(--panel-2); font-size: 0.72rem; }
  .chip-r.rating-good { color: var(--ink-good); }
  .chip-r.rating-needs-improvement { color: var(--ink-warning); }
  .chip-r.rating-poor { color: var(--ink-critical); }
  @media (max-width: 700px) {
    .lineup { flex-wrap: wrap; }
    .lineup figure { flex-basis: 100% !important; }
  }
```

Inside the existing `@media print { … }` block (pages layer), add:

```css
    .views .seg, .views .shot-fold { display: none !important; }
    .views .shot-full { display: block !important; }
    .views .frame { max-height: none; overflow: visible; }
```

- [ ] **Step 7: Run the tests and check that they pass.**

Run: `node --test test/report.test.mjs`, then `npm test`
Expected: PASS. The earlier report tests still pass. The fixture has no `view` fields, so its shots fall into the desktop line-up.

- [ ] **Step 8: Commit.**

```bash
git add extension/ui/report.js extension/ui/reading.js extension/ui/theme.css test/report.test.mjs
git commit -m "Screens page: device line-up at relative scale and resilience grid with chips

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Views checkboxes in the popup and in Options

**Files:**
- Modify: `extension/ui/popup.html` (`#capture-opts .opts`)
- Modify: `extension/ui/popup.js` (`renderCaptureOptions` and the `#capture-opts` change handler)
- Modify: `extension/ui/options.html` (the capture section's `.chips`)
- Test: `test/views.test.mjs` (append; it covers the dotted-path helpers)

**Interfaces:**
- Consumes `DEFAULTS.capture.views` (Task 1).
- Produces, from `extension/ui/popup.js`: `getIn(obj, path)` and `setIn(obj, path, value)`. These are dotted-path helpers, also exported for tests. `popup.js` runs `init()` at import and touches `document`, so the helpers live in a new tiny module, `extension/ui/paths.js`, which `popup.js` imports.

- [ ] **Step 1: Write the failing test.** Append to `test/views.test.mjs`:

```js
import { getIn, setIn } from '../extension/ui/paths.js';

test('dotted-path helpers for nested capture options', () => {
  const o = { views: { nojs: true } };
  assert.equal(getIn(o, 'views.nojs'), true);
  assert.equal(getIn(o, 'views.missing'), undefined);
  assert.equal(getIn(o, 'fullPage'), undefined);
  setIn(o, 'views.nojs', false);
  setIn(o, 'fullPage', true);
  setIn(o, 'a.b.c', 1);
  assert.deepEqual(o, { views: { nojs: false }, fullPage: true, a: { b: { c: 1 } } });
});
```

- [ ] **Step 2: Run the test and check that it fails.**

Run: `node --test test/views.test.mjs`
Expected: FAIL with `Cannot find module '…/extension/ui/paths.js'`.

- [ ] **Step 3: Create `extension/ui/paths.js`.**

```js
// Dotted-path get/set for nested settings (e.g. "views.nojs").
export const getIn = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function setIn(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}
```

- [ ] **Step 4: Popup HTML.** In `extension/ui/popup.html`, inside `#capture-opts .opts`, after the `bypassCache` label, add:

```html
        <fieldset class="views-opts">
          <legend>Views</legend>
          <label><input type="checkbox" name="views.desktop"> Desktop</label>
          <label><input type="checkbox" name="views.tablet"> Tablet</label>
          <label><input type="checkbox" name="views.mobile"> Phone</label>
          <label><input type="checkbox" name="views.nojs"> No JavaScript</label>
          <label><input type="checkbox" name="views.nocss"> No CSS</label>
          <label><input type="checkbox" name="views.noimages"> No images</label>
        </fieldset>
```

- [ ] **Step 5: Popup JS.** In `extension/ui/popup.js`:
  - Add `import { getIn, setIn } from './paths.js';`.
  - In `renderCaptureOptions`, change `const v = settings.capture[el.name];` to `const v = getIn(settings.capture, el.name);`.
  - In the `#capture-opts` change handler, change `s.capture[el.name] = el.type === 'checkbox' ? el.checked : el.value;` to `setIn(s.capture, el.name, el.type === 'checkbox' ? el.checked : el.value);`.

- [ ] **Step 6: Popup CSS.** In `extension/ui/theme.css` (`@layer pages`, popup section), add:

```css
  .popup .views-opts { grid-template-columns: 1fr 1fr; }
```

- [ ] **Step 7: Options HTML.** In `extension/ui/options.html`, after the capture section's `<div class="chips">…</div>` (the one containing `capture.fullPage`), add:

```html
      <h3>Views <small class="muted">extra screenshots taken after each reading (about 15–25 s with all on)</small></h3>
      <div class="chips">
        <label class="chip"><input type="checkbox" data-path="capture.views.desktop"> Desktop</label>
        <label class="chip"><input type="checkbox" data-path="capture.views.tablet"> Tablet</label>
        <label class="chip"><input type="checkbox" data-path="capture.views.mobile"> Phone</label>
        <label class="chip"><input type="checkbox" data-path="capture.views.nojs"> No JavaScript</label>
        <label class="chip"><input type="checkbox" data-path="capture.views.nocss"> No CSS</label>
        <label class="chip"><input type="checkbox" data-path="capture.views.noimages"> No images</label>
      </div>
```

`options.js` already handles any `data-path` through its own get and set path helpers, so it needs no change. Check by reading `options.js` lines 10–17 and 51–70.

- [ ] **Step 8: Run the tests and check that they pass.**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add extension/ui/paths.js extension/ui/popup.html extension/ui/popup.js extension/ui/options.html extension/ui/theme.css test/views.test.mjs
git commit -m "Views checkboxes in the popup and Options

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Capture the views

**Files:**
- Modify: `extension/browser/capture.js`. The changes are:
  - the imports;
  - a new `VIEW_DEVICES` constant;
  - new page functions;
  - `screenshots()` becomes `shoot(view, { thumb })`;
  - new methods `applyDevice`, `settle`, `reloadQuiet` and `captureViews`;
  - a `baseView` getter;
  - `finish()` calls `captureViews`.
- Modify: `docs/FORMAT.md` (the `capture` and `screenshots` sections) and `README.md` (the capture options paragraph and "The report").
- Test: none at unit level. `chrome.debugger` is needed, so this is covered end-to-end in Task 6. Run `npm test` to check nothing else broke.

**Interfaces:**
- Consumes `DEVICE_VIEWS` and `VIEW_LABELS` from `core/views.js`, and `opts.views` from Task 1's settings.
- Produces:
  - `screenshots[]` entries carry a `view`;
  - `reading.log._harplus.capture.views[viewId]` holds `{ cssWidth, cssHeight, text, links, images, imagesWithAlt, noscript }`;
  - `capture.viewsSkipped` holds `[{ view, reason }]` (only present when something was skipped);
  - a `report('views', '<Label> view')` progress stage.

- [ ] **Step 1: Imports and constants.** In `extension/browser/capture.js`, add after the existing imports:

```js
import { DEVICE_VIEWS, VIEW_LABELS } from '../core/views.js';
```

After the `DEVICES` constant, add:

```js
// Screenshot views use the device presets plus desktop. In place — no user-agent change.
const VIEW_DEVICES = { desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, ...DEVICES };
```

- [ ] **Step 2: Page functions.** Add after `scrollPage`. All three are self-contained, because they are serialized into the page.

```js
/** What a reader can see in this view. Runs in the page (main world). */
function measureView() {
  const shown = (el) => el.getClientRects().length > 0;
  const imgs = [...document.querySelectorAll('img')].filter(shown);
  return {
    cssWidth: innerWidth,
    cssHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().length,
    links: [...document.querySelectorAll('a[href]')].filter(shown).length,
    images: imgs.length,
    imagesWithAlt: imgs.filter((i) => i.hasAttribute('alt')).length,
    noscript: !!document.querySelector('noscript'),
  };
}

/** Turn every stylesheet, adopted sheet and style attribute off (on=true) or back on (on=false). */
function stripStyles(on) {
  const roots = [document];
  const walk = (root) => { for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); } };
  walk(document);
  const store = (window.__harplusStyles ||= { sheets: [], adopted: [] });
  if (on) {
    for (const root of roots) {
      for (const sheet of root.styleSheets) if (!sheet.disabled) { sheet.disabled = true; store.sheets.push(sheet); }
      if (root.adoptedStyleSheets?.length) { store.adopted.push([root, root.adoptedStyleSheets]); root.adoptedStyleSheets = []; }
      for (const el of root.querySelectorAll('[style]')) { el.setAttribute('data-harplus-style', el.getAttribute('style')); el.removeAttribute('style'); }
    }
  } else {
    for (const sheet of store.sheets) sheet.disabled = false;
    for (const [root, sheets] of store.adopted) root.adoptedStyleSheets = sheets;
    for (const root of roots) {
      for (const el of root.querySelectorAll('[data-harplus-style]')) { el.setAttribute('style', el.getAttribute('data-harplus-style')); el.removeAttribute('data-harplus-style'); }
    }
    delete window.__harplusStyles;
  }
  return true;
}

/** Break every image so the browser shows alt text, and drop background images (on) — or restore. */
function stripImages(on) {
  const SRC = 'data-harplus-src';
  const SET = 'data-harplus-srcset';
  const POSTER = 'data-harplus-poster';
  const move = (el, from, to) => { if (el.hasAttribute(from)) { el.setAttribute(to, el.getAttribute(from)); el.removeAttribute(from); } };
  if (on) {
    for (const img of document.querySelectorAll('img')) {
      img.setAttribute(SRC, img.getAttribute('src') ?? '');
      move(img, 'srcset', SET);
      img.setAttribute('src', 'about:invalid#harplus');
    }
    for (const source of document.querySelectorAll('picture > source')) move(source, 'srcset', SET);
    for (const video of document.querySelectorAll('video[poster]')) move(video, 'poster', POSTER);
    const style = document.createElement('style');
    style.id = 'harplus-noimg';
    style.textContent = '*, *::before, *::after { background-image: none !important; }';
    document.head.append(style);
  } else {
    for (const img of document.querySelectorAll(`img[${SRC}]`)) {
      const src = img.getAttribute(SRC);
      if (src) img.setAttribute('src', src); else img.removeAttribute('src');
      img.removeAttribute(SRC);
      move(img, SET, 'srcset');
    }
    for (const source of document.querySelectorAll(`source[${SET}]`)) move(source, SET, 'srcset');
    for (const video of document.querySelectorAll(`video[${POSTER}]`)) move(video, POSTER, 'poster');
    document.getElementById('harplus-noimg')?.remove();
  }
  return true;
}
```

- [ ] **Step 3: Split `screenshots()` into `shoot(view, { thumb })`.** Replace the method signature and body start:

```js
  async screenshots() {
    const shots = [];
```

with

```js
  /** The base view as captured: viewport + thumbnail (+ full page). */
  screenshots() {
    return this.shoot(this.baseView, { thumb: true });
  }

  async shoot(view, { thumb = false } = {}) {
    const shots = [];
```

Inside `shoot`, make three changes:
1. Add `view,` to the viewport shot object (after `kind: 'viewport',`).
2. Wrap the thumbnail `try { … } catch …` in `if (thumb) { … }`.
3. Add `view,` to the full-page shot object (after `kind: 'fullpage',`).

Change the progress report line `this.report('screenshot', 'Capturing screenshots');` to `if (thumb) this.report('screenshot', 'Capturing screenshots');`.

- [ ] **Step 4: Add helpers and `captureViews` to the class** (after `scrollThrough`):

```js
  get baseView() {
    return DEVICES[this.opts.device] ? this.opts.device : 'desktop';
  }

  /** Emulate a device view in place; the desktop base view simply clears the override. */
  async applyDevice(id) {
    if (id === 'desktop' && !DEVICES[this.opts.device]) {
      await this.send('Emulation.clearDeviceMetricsOverride');
      await this.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      return;
    }
    const d = VIEW_DEVICES[id];
    await this.send('Emulation.setDeviceMetricsOverride', { width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.mobile });
    await this.send('Emulation.setTouchEmulationEnabled', d.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  }

  /** Wait for a short network lull without adding "did not settle" warnings to the reading. */
  async settle(maxMs) {
    const n = this.warnings.length;
    await this.waitForIdle({ idleMs: 500, maxMs }).catch(() => false);
    this.warnings.length = n;
  }

  async reloadQuiet() {
    this.loaded = false;
    this.isolated = null;
    await this.send('Page.reload', { ignoreCache: false });
  }

  /**
   * Extra screenshots after the reading is built: other devices (in place), no CSS and no images
   * (toggled in place), no JavaScript (one reload, then a normal reload to restore the tab).
   * Each view is isolated: a failure becomes a warning and a viewsSkipped entry.
   */
  async captureViews(reading) {
    const hp = reading.log._harplus;
    const want = this.opts.views || {};
    const base = this.baseView;
    const views = {};
    const skipped = [];
    const measure = async (id) => { views[id] = await withTimeout(this.evaluate(measureView, null, 'main'), 5000, 'measure'); };
    const shoot = async (id) => { hp.screenshots.push(...await this.shoot(id)); await measure(id); };
    const view = async (id, ms, fn) => {
      if (want[id] === false) { skipped.push({ view: id, reason: 'disabled' }); return; }
      if (this.detached) { skipped.push({ view: id, reason: `debugger detached (${this.detached})` }); return; }
      this.report('views', `${VIEW_LABELS[id]} view`);
      try {
        await withTimeout(fn(), ms, `${VIEW_LABELS[id]} view`);
      } catch (e) {
        skipped.push({ view: id, reason: e.message });
        this.warnings.push(`${VIEW_LABELS[id]} view failed: ${e.message}`);
      }
    };

    await measure(base).catch((e) => this.warnings.push(`measuring the page failed: ${e.message}`));
    for (const id of DEVICE_VIEWS) {
      if (id === base) continue;
      await view(id, 30_000, async () => {
        try {
          await this.applyDevice(id);
          await sleep(1000);
          await this.settle(4000);
          await shoot(id);
        } finally {
          await this.applyDevice(base).catch(() => {});
        }
      });
    }
    await view('nocss', 30_000, async () => {
      try {
        await this.evaluate(stripStyles, true, 'main');
        await sleep(300);
        await shoot('nocss');
      } finally {
        await this.evaluate(stripStyles, false, 'main').catch(() => {});
      }
    });
    await view('noimages', 30_000, async () => {
      try {
        await this.evaluate(stripImages, true, 'main');
        await sleep(300);
        await shoot('noimages');
      } finally {
        await this.evaluate(stripImages, false, 'main').catch(() => {});
      }
    });
    if (want.nojs !== false && this.opts.mode !== 'reload') {
      skipped.push({ view: 'nojs', reason: 'not in reload mode' });
    } else {
      await view('nojs', 60_000, async () => {
        try {
          await this.send('Emulation.setScriptExecutionDisabled', { value: true });
          await this.reloadQuiet();
          await this.settle(15_000);
          await shoot('nojs');
        } finally {
          await this.send('Emulation.setScriptExecutionDisabled', { value: false }).catch(() => {});
          await this.reloadQuiet().catch(() => {});
          await this.settle(15_000);
        }
      });
    }
    hp.capture.views = views;
    if (skipped.length) hp.capture.viewsSkipped = skipped;
  }
```

- [ ] **Step 5: Call it from `finish()`.** In `finish()`, directly after the `await runPlugins(reading, plugins, { phases: ['page'], … });` call and still inside `if (live) { … }`, add:

```js
      if (!this.detached) await this.captureViews(reading);
```

- [ ] **Step 6: Update `docs/FORMAT.md`.**

In the `### capture` paragraph, after `` `warnings` (string[]), `` add:

```
`views` (per-view measurements, see below), `viewsSkipped` (`[{ view, reason }]`),
```

Replace the `### screenshots` section with:

````markdown
### `screenshots`

```jsonc
{ "kind": "viewport" | "fullpage" | "thumbnail", "view": "desktop", "mimeType": "image/webp", "encoding": "base64",
  "data": "…", "cssWidth": 1280, "cssHeight": 800, "dpr": 2, "scale": 1, "truncated": false }
```

Full-page shots are capped at 20,000 CSS px tall and scaled to stay under WebP's 16,383 px limit.

`view` is one of `desktop`, `tablet`, `mobile` (devices, captured in place by resizing the viewport) or
`nojs`, `nocss`, `noimages` (the page without scripts, styles or images). Shots without `view`
(older readings) belong to the capture device's view. The thumbnail is of the capture device only.

### `capture.views`

What a reader can see in each view, measured in the page:

```jsonc
"views": {
  "desktop": { "cssWidth": 1280, "cssHeight": 6420, "text": 18234, "links": 142, "images": 38, "imagesWithAlt": 31, "noscript": false },
  "nojs":    { "cssWidth": 1280, "cssHeight": 900,  "text": 412,   "links": 3,   "images": 0,  "imagesWithAlt": 0,  "noscript": true }
}
```

`text` is the length of the visible text (whitespace collapsed), `links` and `images` count rendered
elements, `imagesWithAlt` counts images with an `alt` attribute (including `alt=""`). The
**Resilience** plugin compares each view with the capture device's view.
````

- [ ] **Step 7: Update `README.md`.**
  - In the "Capture options" sentence (around line 40), add ", extra views (desktop / tablet / phone, no JavaScript / no CSS / no images)" after "full-page screenshot".
  - In "### The report", after the sentence about each area's page, add:

```markdown
The **Screens** page lines the desktop, tablet and phone shots up at true relative size and puts the
page without JavaScript, without CSS and without images next to the original, with how much text and
how many links survive. The **Resilience** plugin turns that into findings — a page that shows almost
nothing without JavaScript is flagged.
```

- [ ] **Step 8: Run the tests and lint by loading.**

Run: `npm test`, then `node -e "import('./extension/browser/capture.js').catch(e => { if (!/chrome is not defined/.test(e.message)) throw e; })"`
Expected: unit tests PASS. The import check either succeeds or fails only on `chrome` (no syntax errors).

- [ ] **Step 9: Commit.**

```bash
git add extension/browser/capture.js docs/FORMAT.md README.md
git commit -m "Capture device and resilience views after each reading; restore the tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Test site content rendered by script, and end-to-end assertions

**Files:**
- Modify: `test/e2e/site/main.js`
- Modify: `test/e2e/run.mjs`. That means the reload-reading assertions after `const p = hp.plugins;`, the screenshots assertion, the snapshot block and the record block.

**Interfaces:**
- Consumes everything above.

- [ ] **Step 1: Content rendered by script.** In `test/e2e/site/main.js`, insert before the `//# sourceMappingURL` line:

```js
// Content that only exists when JavaScript runs — gives the no-JS view something to miss.
const section = document.createElement('section');
section.id = 'js-content';
section.innerHTML = `<h2>Rendered by JavaScript</h2>${'<p>This paragraph is added by a script, so it appears only when JavaScript runs. Readers without JavaScript never see it, which is exactly what the resilience view measures.</p>'.repeat(6)}
  <p><a href="/page2.html">Trail guides</a> · <a href="/page2.html#gear">Gear lists</a> · <a href="/page2.html#maps">Maps</a></p>`;
document.querySelector('main')?.append(section);
```

- [ ] **Step 2: Record the tab width before the first reading.** In `test/e2e/run.mjs`, directly before `// 1. reload reading (desktop)`, add:

```js
    const widthBefore = await page.evaluate(() => innerWidth);
```

- [ ] **Step 3: Replace the screenshots assertion.** Replace

```js
    assert.deepEqual(hp.screenshots.map((s) => s.kind).sort(), ['fullpage', 'thumbnail', 'viewport']);
```

with

```js
    const shotViews = (r) => [...new Set(r.log._harplus.screenshots.filter((s) => s.kind === 'viewport').map((s) => s.view))].sort();
    const shotWidth = (r, v) => r.log._harplus.screenshots.find((s) => s.view === v && s.kind === 'viewport')?.cssWidth;
    assert.deepEqual(shotViews(r1), ['desktop', 'mobile', 'noimages', 'nocss', 'nojs', 'tablet']);
    assert.deepEqual(hp.screenshots.filter((s) => s.view === 'desktop').map((s) => s.kind).sort(), ['fullpage', 'viewport']);
    assert.equal(hp.screenshots.filter((s) => s.kind === 'thumbnail').length, 1);
    assert.equal(shotWidth(r1, 'desktop'), 1280);
    assert.equal(shotWidth(r1, 'tablet'), 820);
    assert.equal(shotWidth(r1, 'mobile'), 390);
    assert.ok(hp.screenshots.some((s) => s.view === 'nojs' && s.kind === 'fullpage'), 'no-JS full page');
    const mv = hp.capture.views;
    assert.ok(mv.desktop.text > 0 && mv.nojs.text < mv.desktop.text, `no-JS text ${mv.nojs.text} < ${mv.desktop.text}`);
    assert.ok(mv.nojs.links < mv.desktop.links, 'script-rendered links missing without JS');
    assert.ok(mv.noimages.images >= 1, 'broken images still rendered with alt text');
    assert.equal(hp.capture.viewsSkipped, undefined, `nothing skipped: ${JSON.stringify(hp.capture.viewsSkipped)}`);
    // The tab is left as it was: scripts run (the script-rendered section is back), original width,
    // and the views' reloads did not leak into the HAR.
    await page.waitForSelector('#js-content');
    assert.equal(await page.evaluate(() => innerWidth), widthBefore);
    assert.equal(r1.log.entries.filter((e) => e.request.url === `${base}/`).length, 1, 'one document entry');
    assert.equal(r1.log.entries.filter((e) => e.request.url.endsWith('/main.js')).length, 1, 'main.js recorded once');
```

- [ ] **Step 4: Assert the resilience plugin.** After the line `for (const id of ['html', 'css', 'javascript', 'baseline', 'html-validate', 'css-validate']) …`, add:

```js
    assert.equal(p.resilience?.status, 'ok', `resilience: ${p.resilience?.error}`);
    assert.ok(p.resilience.summary.some((s) => s.label === 'Without JavaScript'));
```

- [ ] **Step 5: Snapshot and mobile assertions.**
  - After `const r2 = await getReading(id2);`, add:

```js
    assert.equal(shotWidth(r2, 'mobile'), 390, 'mobile base view');
    assert.equal(shotWidth(r2, 'desktop'), 1280, 'desktop view from a mobile reading');
```

  - After `assert.ok(r3.log.entries.length >= 3 && r3.log.entries.every((e) => e._synthetic));`, add:

```js
    assert.ok(!r3.log._harplus.screenshots.some((s) => s.view === 'nojs'), 'snapshot: no no-JS shot');
    assert.ok(r3.log._harplus.capture.viewsSkipped?.some((s) => s.view === 'nojs' && s.reason === 'not in reload mode'));
```

- [ ] **Step 6: Run the end-to-end test.**

Run: `npm run test:e2e`
Expected: "all e2e checks passed".
- Look at `test/e2e/out/reading-screens.png`. The device row should show three shots at relative scale, and the resilience grid four tiles with chips.
- If an existing assertion elsewhere breaks only because the new script-rendered section changed the page (for example, heading or link counts), update that assertion minimally and say so in the report.
- If a new assertion fails, investigate the capture code. Do not weaken the assertion.

- [ ] **Step 7: Run the unit tests.**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add test/e2e/site/main.js test/e2e/run.mjs
git commit -m "E2E: all six views captured, no-JS measured, tab restored, HAR untouched

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
