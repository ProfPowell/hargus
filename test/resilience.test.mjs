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

test('no <noscript> text at a 0.05 text ratio stays high', () => {
  const out = run({ desktop: base, nojs: { ...base, text: 50, links: 20, noscript: false } });
  assert.equal(out.findings[0].severity, 'high');
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
  // No colour without a word: every bar is the same colour, the label names the view.
  assert.deepEqual([...new Set(g.match(/background:[^"]+/g))], ['background:var(--c1)']);
  const r = String(plugin.render({ status: 'ok', ...out }, h));
  assert.match(r, /<th scope="col">View<\/th>/);
  assert.match(r, /Tablet/);
});

test('no places: every finding is about the page as a whole', () => {
  const out = run({ desktop: base, nojs: { ...base, text: 10, links: 0 }, nocss: { ...base, text: 1400 } });
  assert.equal(out.findings.length, 3);
  assert.ok(out.findings.every((f) => !f.places));
});

test('headline: without a no-JS view the first row stands for the check', () => {
  const out = run({ desktop: base, nocss: { ...base, text: 920 }, noimages: { ...base } });
  assert.deepEqual(out.summary.filter((s) => s.headline).map((s) => `${s.label} ${s.value}`), ['Without CSS 92% of text']);
  const js = run({ desktop: base, nojs: { ...base, text: 900 }, nocss: { ...base } });
  assert.deepEqual(js.summary.filter((s) => s.headline).map((s) => s.label), ['Without JavaScript']);
});

test('render: pass / fail checks first at the findings\' thresholds, then counts (the glance has the percentages)', () => {
  const out = run({ desktop: base, nojs: { ...base, text: 150, links: 4 }, nocss: { ...base, text: 1400 }, noimages: { ...base } });
  const r = String(plugin.render({ status: 'ok', ...out }, h));
  assert.ok(r.startsWith('<ul class="checks">'), 'checks come first');
  assert.match(r, /\(fail\)<\/span>Content shows without JavaScript<small>15% of text<\/small>/);
  assert.match(r, /\(fail\)<\/span>Links show without JavaScript<small>4 of 20<\/small>/);
  assert.match(r, /\(fail\)<\/span>No hidden content appears without CSS<small>140% of text<\/small>/);
  assert.doesNotMatch(r, /Images have alt text/, 'alt text belongs to Accessibility');
  assert.match(r, /<td>150<\/td><td>4<\/td><td>8 of 10<\/td>/);
  assert.doesNotMatch(r, /<td>[^<]*%[^<]*<\/td>/, 'no percentages in the table');
  const good = run({ desktop: { ...base, links: 3 }, nojs: { ...base, text: 900, links: 3 } });
  const g = String(plugin.render({ status: 'ok', ...good }, h));
  assert.match(g, /\(pass\)<\/span>Content shows without JavaScript/);
  assert.match(g, /\(unknown\)<\/span>Links show without JavaScript<small>too few links to judge<\/small>/);
  assert.doesNotMatch(g, /undefined|NaN/);
});

test('accessibility views are not part of the resilience comparison', () => {
  const out = run({ desktop: base, nojs: { ...base, text: 900 }, dark: { ...base, text: 1000 }, reflow: { ...base } });
  const g = String(plugin.glance({ status: 'ok', ...out }, h));
  assert.doesNotMatch(g, /Dark mode|320 px reflow/);
  assert.doesNotMatch(String(plugin.render({ status: 'ok', ...out }, h)), /Dark mode/);
});

test('a failed noimages check: the view is skipped and noted', () => {
  const r = reading({ desktop: base, nojs: { ...base, text: 900 }, noimages: { ...base } });
  r.log._harplus.capture.viewChecks = { noimages: { ok: false, detail: 'images still loaded' } };
  const out = plugin.run(r, ctx);
  assert.deepEqual(titles(out), ['info:No images view could not be verified — images still loaded']);
  assert.ok(!out.summary.some((s) => s.label === 'Without images'));
  assert.ok(!out.data.views.noimages);
});

test('only a failed noimages check beside desktop: note-only result, glance and render do not throw', () => {
  const r = reading({ desktop: base, noimages: { ...base } });
  r.log._harplus.capture.viewChecks = { noimages: { ok: false, detail: 'images still loaded' } };
  const out = plugin.run(r, ctx);
  assert.deepEqual(titles(out), ['info:No images view could not be verified — images still loaded']);
  assert.doesNotThrow(() => String(plugin.glance({ status: 'ok', ...out }, h)));
  assert.doesNotThrow(() => String(plugin.render({ status: 'ok', ...out }, h)));
});

test('translated views are not resilience views: left out of the visible-text comparison', () => {
  const out = run({ desktop: base, nojs: { ...base }, 'translated-de': { ...base, text: 1400 }, 'translated-ja': { ...base, text: 700 }, rtl: { ...base } });
  const g = String(plugin.glance({ status: 'ok', ...out }, h));
  assert.doesNotMatch(g, /German|Japanese/);
  assert.match(g, /No JavaScript/);
  assert.doesNotMatch(String(plugin.render({ status: 'ok', ...out }, h)), /German|Japanese/);
});
