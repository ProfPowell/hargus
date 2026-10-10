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
  const r = String(plugin.render({ status: 'ok', ...out }, h));
  assert.match(r, /<th scope="col">View<\/th>/);
  assert.match(r, /Tablet/);
});
