import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../extension/plugins/a11y-views.js';
import { getPlugins } from '../extension/plugins/index.js';
import { h } from '../extension/ui/render.js';

const B = { text: 1000, links: 20, clipped: 2, overflowX: 0, bodyFont: 16, bg: 1, fixed: [], chrome: true, forcedNone: 0, iconOnly: 0 };
const reading = (views, prefs) => ({ log: { entries: [], _harplus: { capture: { device: 'desktop', views, prefs } } } });
const ctx = (css) => ({ results: css ? { css: { status: 'ok', data: css } } : {}, skip: (m) => { const e = new Error(m); e.name = 'SkipError'; throw e; } });
const run = (views, { prefs, css } = {}) => plugin.run(reading({ desktop: B, ...views }, prefs), ctx(css));
const t = (out) => out.findings.map((f) => `${f.severity}:${f.title}`);

test('registered right after layout; Accessibility area, analyze phase', () => {
  const ids = getPlugins().map((p) => p.id);
  assert.equal(ids.indexOf('a11y-views'), ids.indexOf('layout') + 1);
  assert.equal(plugin.area, 'accessibility');
  assert.equal(plugin.phase, 'analyze');
});

test('skips without accessibility views (old readings)', () => {
  assert.throws(() => plugin.run(reading({ desktop: B }), ctx()), /no accessibility views/);
  assert.throws(() => plugin.run(reading(undefined), ctx()), /no accessibility views/);
});

test('reflow: overflow and extra clipping are medium; base clipping is not counted', () => {
  assert.deepEqual(t(run({ reflow: { ...B, overflowX: 40 } })), ['medium:Page scrolls horizontally at 320 px (WCAG 1.4.10)']);
  assert.deepEqual(t(run({ reflow: { ...B, clipped: 5 } })), ['medium:3 more text boxes clip at 320 px (WCAG 1.4.10)']);
  assert.deepEqual(t(run({ reflow: { ...B, clipped: 4 } })), []);
});

test('spacing: clips → medium; same overflow as base → nothing', () => {
  assert.deepEqual(t(run({ spacing: { ...B, clipped: 5 } })), ['medium:Text clips with WCAG text spacing (1.4.12)']);
  assert.deepEqual(t(run({ spacing: { ...B, overflowX: 10 } })), ['low:Page scrolls sideways with WCAG text spacing']);
  const wide = { ...B, overflowX: 200 };
  assert.deepEqual(t(plugin.run(reading({ desktop: wide, spacing: { ...wide } }), ctx())), []);
});

test('200% text: ignores font size → low; grows and clips → medium; grows cleanly → nothing', () => {
  assert.deepEqual(t(run({ text200: { ...B, bodyFont: 16, clipped: 9 } })), ['low:Text ignores the browser\'s font-size setting']);
  assert.deepEqual(t(run({ text200: { ...B, bodyFont: 32, clipped: 5 } })), ['medium:Text clips at 200% size (WCAG 1.4.4)']);
  assert.deepEqual(t(run({ text200: { ...B, bodyFont: 32 } })), []);
  assert.deepEqual(t(plugin.run(reading({ desktop: { ...B, bodyFont: undefined }, text200: { ...B, bodyFont: undefined } }), ctx())), [], 'old measurement: no false finding');
});

test('dark mode: no change and no dark styles → info; declared dark but light → low; dark styles in css → no info', () => {
  assert.deepEqual(t(run({ dark: { ...B, bg: 0.98 } })), ['info:No dark mode']);
  assert.deepEqual(t(run({ dark: { ...B, bg: 0.98 } }, { prefs: { colorScheme: 'light dark', mediaFeatures: {} } })), ['info:No dark mode', 'low:Declares dark color-scheme but stays light']);
  assert.deepEqual(t(run({ dark: { ...B, bg: 0.98 } }, { css: { mediaFeatures: { 'prefers-color-scheme': 2 }, media: {} } })), []);
  assert.deepEqual(t(run({ dark: { ...B, bg: 0.05 } })), []);
});

test('forced colours: opt-outs ≥ 20 and icon-only controls → low', () => {
  assert.deepEqual(t(run({ forced: { ...B, forcedNone: 20, iconOnly: 2 } })), ['low:20 elements opt out of forced colours', 'low:2 icon-only controls may vanish in forced colours']);
  assert.deepEqual(t(run({ forced: { ...B, forcedNone: 19 } })), []);
});

test('more contrast: info without prefers-contrast styles', () => {
  assert.deepEqual(t(run({ morecontrast: { ...B } })), ['info:No high-contrast styles']);
  assert.deepEqual(t(run({ morecontrast: { ...B } }, { prefs: { mediaFeatures: { 'prefers-contrast': 1 } } })), []);
});

test('print: chrome, overlays, no print styles — category content', () => {
  const out = run({ print: { ...B, chrome: true, fixed: [{ tag: 'div', w: 1280, h: 120 }] } });
  assert.deepEqual(t(out), ['low:Navigation and site chrome still print', 'low:1 fixed or sticky overlays print over content', 'info:No print styles']);
  assert.ok(out.findings.every((f) => f.category === 'content'));
  assert.deepEqual(t(run({ print: { ...B, chrome: false } }, { css: { mediaFeatures: {}, media: { print: 1 } } })), []);
  assert.deepEqual(t(run({ print: { ...B, chrome: false } }, { prefs: { mediaPrint: true } })), []);
});

test('summary rows, glance and render without NaN', () => {
  const out = run({ reflow: { ...B, overflowX: 40 }, spacing: { ...B }, text200: { ...B, bodyFont: 32 }, dark: { ...B, bg: 0.05 }, print: { ...B, chrome: false } }, { prefs: { mediaPrint: true } });
  const labels = out.summary.map((s) => s.label);
  for (const l of ['Reflow 320 px', 'Text spacing', '200% text', 'Dark mode', 'Print']) assert.ok(labels.includes(l), l);
  assert.equal(out.summary.find((s) => s.label === '200% text').value, '16 → 32 px');
  const html = String(plugin.glance({ status: 'ok', ...out }, h)) + String(plugin.render({ status: 'ok', ...out }, h));
  assert.doesNotMatch(html, /NaN|undefined/);
  assert.match(html, /320 px reflow/);
});

test('reflow: only overflow beyond the base scrolls; a clipping root cannot scroll', () => {
  const wide = { ...B, overflowX: 200 };
  assert.deepEqual(t(plugin.run(reading({ desktop: wide, reflow: { ...wide } }), ctx())), [], 'base 200, reflow 200');
  const out = run({ reflow: { ...B, overflowX: 40 } });
  assert.deepEqual(t(out), ['medium:Page scrolls horizontally at 320 px (WCAG 1.4.10)']);
  assert.match(out.findings[0].detail, /40 px/);
  const more = plugin.run(reading({ desktop: wide, reflow: { ...wide, overflowX: 260 } }), ctx());
  assert.match(more.findings[0].detail, /60 px/, 'the detail states the overflow beyond the base');
  assert.deepEqual(t(run({ reflow: { ...B, overflowX: 40, rootClipX: true } })), [], 'html/body overflow-x hidden');
  assert.equal(run({ reflow: { ...B, overflowX: 40, rootClipX: true } }).data.checks.find((c) => c.id === 'reflow').ok, true);
});

test('truncated measurements: no clipped-boxes comparison, overflow and font checks kept', () => {
  const tb = { ...B, truncated: true };
  assert.deepEqual(t(plugin.run(reading({ desktop: tb, reflow: { ...B, clipped: 12 } }), ctx())), []);
  assert.deepEqual(t(run({ spacing: { ...B, clipped: 12, truncated: true } })), []);
  assert.deepEqual(t(plugin.run(reading({ desktop: tb, reflow: { ...B, overflowX: 40, clipped: 12 } }), ctx())), ['medium:Page scrolls horizontally at 320 px (WCAG 1.4.10)']);
  assert.deepEqual(t(plugin.run(reading({ desktop: tb, text200: { ...B, bodyFont: 16 } }), ctx())), ['low:Text ignores the browser\'s font-size setting']);
});

test('dark mode: an already-dark page gets no findings; a light page that stays light keeps them', () => {
  const dark = { ...B, bg: 0.05 };
  const out = plugin.run(reading({ desktop: dark, dark: { ...dark } }, { colorScheme: 'dark', mediaFeatures: {} }), ctx());
  assert.deepEqual(t(out), []);
  assert.equal(out.summary.find((s) => s.label === 'Dark mode').value, 'already dark');
  assert.equal(out.data.checks.find((c) => c.id === 'dark').ok, true);
  const light = run({ dark: { ...B, bg: 0.98 } }, { prefs: { colorScheme: 'light dark', mediaFeatures: {} } });
  assert.deepEqual(t(light), ['info:No dark mode', 'low:Declares dark color-scheme but stays light']);
  assert.equal(light.summary.find((s) => s.label === 'Dark mode').value, 'no change');
  assert.deepEqual(t(run({ dark: { ...B, bg: 0.45 } })), [], 'looks dark in dark mode');
  assert.deepEqual(t(run({ dark: { ...B, bg: null } })), [], 'unmeasured background');
});

test('unreadable stylesheets: preference findings say styles may exist in them unless the css plugin read them', () => {
  const NOTE = 'Some stylesheets could not be read; styles for this preference may exist in them.';
  const views = { dark: { ...B, bg: 0.98 }, morecontrast: { ...B }, print: { ...B, chrome: false } };
  const out = run(views, { prefs: { unreadableSheets: 2, mediaFeatures: {} } });
  for (const title of ['No dark mode', 'No print styles', 'No high-contrast styles']) {
    const f = out.findings.find((x) => x.title === title);
    assert.equal(f?.detail, NOTE, title);
    assert.equal(f.severity, 'info');
  }
  const read = run(views, { prefs: { unreadableSheets: 2, mediaFeatures: {} }, css: { mediaFeatures: {}, media: {} } });
  assert.ok(read.findings.every((f) => f.detail !== NOTE), 'css plugin ok: no note');
  assert.ok(run(views).findings.every((f) => f.detail !== NOTE), 'all sheets readable: no note');
});

test('reflow finding names the widest culprit', () => {
  const out = run({ reflow: { ...B, overflowX: 44, overflowers: [{ selector: 'p.promo', width: 364, over: 44 }] } });
  const f = out.findings.find((x) => /320 px/.test(x.title));
  assert.match(f.detail, /^p\.promo is 364 px wide in a 320 px view\./);
});

test('reflow: overflow the page cannot actually scroll is not reported; old readings still are', () => {
  assert.deepEqual(t(run({ reflow: { ...B, overflowX: 408, scrollsX: false } })), []);
  assert.deepEqual(t(run({ reflow: { ...B, overflowX: 40, scrollsX: true } })), ['medium:Page scrolls horizontally at 320 px (WCAG 1.4.10)']);
  const out = run({ reflow: { ...B, overflowX: 408, scrollsX: false } });
  assert.equal(out.data.checks.find((c) => c.id === 'reflow').ok, true);
});

test('reflow: real overflow with no culprit says so', () => {
  const f = run({ reflow: { ...B, overflowX: 40, scrollsX: true, overflowers: [], overflowTruncated: false } }).findings[0];
  assert.match(f.detail, /^No single element was found wider than the viewport; the extra width may come from margins or transforms\. /);
});

test('200% text: sideways scrolling alone is low and passes the 1.4.4 check; clipping stays medium', () => {
  const s = run({ text200: { ...B, bodyFont: 32, overflowX: 120, scrollsX: true } });
  assert.deepEqual(t(s), ['low:Page scrolls sideways at 200% text size']);
  assert.equal(s.findings[0].detail, 'Content is 120 px wider than the viewport.');
  assert.equal(s.data.checks.find((c) => c.id === 'text200').ok, true);
  assert.equal(s.summary.find((x) => x.label === '200% text').rating, 'needs-improvement');
  assert.deepEqual(t(run({ text200: { ...B, bodyFont: 32, overflowX: 120, scrollsX: false } })), []);
  const c = run({ text200: { ...B, bodyFont: 32, clipped: 5, overflowX: 120 } });
  assert.deepEqual(t(c), ['medium:Text clips at 200% size (WCAG 1.4.4)']);
  assert.equal(c.findings[0].detail, '3 more clipped text boxes.');
  assert.equal(c.data.checks.find((x) => x.id === 'text200').ok, false);
});

test('spacing: scroll-only overflow is low and passes the check; clipping stays medium; tiny overflow ignored', () => {
  const s = run({ spacing: { ...B, overflowX: 81, scrollsX: true } });
  assert.deepEqual(t(s), ['low:Page scrolls sideways with WCAG text spacing']);
  assert.equal(s.findings[0].detail, 'Content is 81 px wider than the viewport.');
  assert.equal(s.data.checks.find((c) => c.id === 'spacing').ok, true);
  assert.equal(s.summary.find((x) => x.label === 'Text spacing').rating, 'needs-improvement');
  assert.deepEqual(t(run({ spacing: { ...B, overflowX: 5, scrollsX: true } })), []);
  assert.deepEqual(t(run({ spacing: { ...B, overflowX: 81, scrollsX: false } })), []);
  const c = run({ spacing: { ...B, clipped: 5, overflowX: 81 } });
  assert.deepEqual(t(c), ['medium:Text clips with WCAG text spacing (1.4.12)']);
  assert.equal(c.findings[0].detail, '3 more clipped text boxes.');
  assert.equal(c.data.checks.find((x) => x.id === 'spacing').ok, false);
});

test('a failed view check: no finding from that view, an info note instead', () => {
  const r = reading({ desktop: B, reflow: { ...B, overflowX: 40, scrollsX: true } });
  r.log._harplus.capture.viewChecks = { reflow: { ok: false, detail: 'viewport is 1280 px, expected 320' } };
  const out = plugin.run(r, ctx());
  assert.deepEqual(t(out), ['info:320 px reflow view could not be verified — viewport is 1280 px, expected 320']);
  assert.equal(out.findings[0].category, 'accessibility');
  r.log._harplus.capture.viewChecks.reflow.ok = true;
  assert.deepEqual(t(plugin.run(r, ctx())), ['medium:Page scrolls horizontally at 320 px (WCAG 1.4.10)']);
});
