import { test } from 'node:test';
import assert from 'node:assert/strict';
import css from '../extension/plugins/css.js';
import * as hu from '../extension/core/har-util.js';
import { h } from '../extension/ui/render.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';

const S = 'https://s.test/';
const collected = (over = {}) => ({
  sheets: [
    { label: `${S}a.css?v=2`, kind: 'linked', href: `${S}a.css?v=2`, bytes: 2048, parsed: true, parsedFrom: 'cssom', rules: 10, declarations: 40 },
    { label: 'https://cdn.test/x.css', kind: 'linked', href: 'https://cdn.test/x.css', bytes: null, parsed: false, rules: 0, declarations: 0 },
    { label: 'inline <style>', kind: 'inline', href: null, bytes: 300, parsed: true, parsedFrom: 'cssom', rules: 2, declarations: 5 },
  ],
  shadowRoots: 0, shadowHosts: [],
  stats: {
    rules: 14, styleRules: 12, emptyRules: 0, selectors: 30, declarations: 45, important: 2, idSelectors: 1, universal: 0, nested: 0, maxNesting: 0,
    duplicateSelectors: 0, specificity: { max: [1, 2, 0], maxSelector: '#a .b.c', avg: [0.1, 1.2, 0.3] }, longestSelector: '.x .y', keyframes: 0, containerQueries: 0,
  },
  atRules: { media: 2 }, media: [['(min-width: 600px)', 2]], mediaFeatures: { 'min-width': 2 }, supports: [], layers: [], fontFaces: [],
  usage: { properties: { color: 5, display: 3 }, values: {}, functions: {}, units: { px: 4 }, pseudoClasses: {}, pseudoElements: {} },
  colors: [['#fff', 3], ['#000', 2]], colorCount: 2, fontFamilies: [['Arial', 2]], fontSizes: [['16px', 2]], fontSizeCount: 1, zIndex: [],
  custom: { defined: 0, used: 0, unused: [], undefinedUsed: [], prefixes: [] }, vendor: [], vwRules: 0, errors: [], ...over,
});
const run = (c) => css.run({}, { collected: c, util: hu, skip: (m) => { throw new Error(m); } });
const find = (r, re) => r.findings.find((f) => re.test(f.title));

/** A plugin's output as the saved reading keeps it (through normalize). */
const saved = async (out) => {
  const reading = createReading({ entries: [], target: makeTarget(S, 'S', S) });
  await runPlugins(reading, [{ id: 'n', name: 'N', phase: 'analyze', run: async () => out }], {});
  return reading.log._harplus.plugins.n;
};

test('places: unparsed stylesheets name their URLs; title, detail and evidence unchanged; no other finding gains places', () => {
  const r = run(collected({ stats: { ...collected().stats, specificity: { max: [2, 0, 0], maxSelector: '#a #b', avg: [1, 0, 0] } } }));
  const f = find(r, /could not be parsed/);
  assert.equal(f.title, '1 stylesheets could not be parsed (cross-origin, not recorded)');
  assert.equal(f.detail, 'Capture response bodies (text) to include them.');
  assert.equal(f.evidence, 'https://cdn.test/x.css');
  assert.deepEqual(f.places, [{ url: 'https://cdn.test/x.css' }]);
  assert.equal(find(r, /Highest specificity/).detail, '#a #b', 'a stylesheet selector stays evidence');
  for (const x of r.findings.filter((y) => !/could not be parsed/.test(y.title))) assert.equal(x.places, undefined, x.title);
});

test('odd values: an unparsed sheet without a URL has no place; a long URL is cut to 500 and "<" is escaped when drawn', async () => {
  const long = `https://cdn.test/${'p/'.repeat(300)}x.css?q=<b>`;
  const r = run(collected({ sheets: [
    { label: long, kind: 'linked', href: long, parsed: false, rules: 0, declarations: 0 },
    { label: 'adopted (document)', kind: 'adopted', href: null, parsed: false, rules: 0, declarations: 0 },
  ] }));
  const f = find(r, /could not be parsed/);
  assert.equal(f.title, '2 stylesheets could not be parsed (cross-origin, not recorded)');
  assert.equal(f.evidence, `${long}\nadopted (document)`);
  assert.equal(f.places.length, 1);
  const s = await saved(r);
  const p = s.findings.find((x) => /could not be parsed/.test(x.title)).places;
  assert.equal(p[0].url.length, 500);
  assert.doesNotMatch(String(h.places([{ url: 'https://cdn.test/x.css?q=<b>' }])), /<b>/);
});

test('headline: Stylesheets reads on its own', () => {
  const head = run(collected()).summary.filter((x) => x.headline);
  assert.equal(head.length, 1);
  assert.equal(`${head[0].label} ${head[0].value}`, 'Stylesheets 3 (2 linked, 1 inline) · 2.3 KB');
});

test('render: stats first; sheet URLs as parts; metrics leave out what the glance and stats show; chips and swatches fold', () => {
  const props = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p${i}`, 12 - i]));
  const colors = Array.from({ length: 10 }, (_, i) => [`#00000${i}`, 1]);
  const r = run(collected({ usage: { ...collected().usage, properties: props }, colors, colorCount: 10 }));
  const s = String(css.render({ status: 'ok', ...r }, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<table'), 'stats first');
  assert.match(s, /Stylesheets<\/span><div class="stat-value">3<\/div><span class="stat-note">2.3 KB · 1 not parsed/);
  assert.match(s, /Selectors<\/span><div class="stat-value">30/);
  assert.match(s, /Declarations<\/span><div class="stat-value">45/);
  assert.match(s, /Max specificity<\/span><div class="stat-value">1,2,0<\/div><span class="stat-note">average 0.1,1.2,0.3/);
  assert.match(s, /<a href="https:\/\/s\.test\/a\.css\?v=2"[^>]*><span class="url"[^>]*><span class="url-host">s\.test<\/span><span class="url-path">\/a\.css<\/span><span class="url-query">\?v=2/);
  assert.match(s, /<dt>Most specific selector<\/dt><dd>#a \.b\.c/);
  assert.doesNotMatch(s, /<dt>(Style rules|Selectors|Declarations|!important|Max specificity|Average specificity)<\/dt>/);
  assert.equal((s.match(/<span class="tag">p\d+ ×\d+<\/span>/g) || []).length, 12);
  assert.match(s, /<summary>4 more<\/summary>/);
  assert.equal((s.match(/class="swatch"/g) || []).length, 10);
  assert.match(s, /<summary>2 more<\/summary><div class="disclosure-body"><div class="swatches">/);
});

test('render: an unsafe colour value is drawn as text with a transparent swatch', () => {
  const r = run(collected({ colors: [['red;background:url(x)', 1]], colorCount: 1 }));
  const s = String(css.render({ status: 'ok', ...r }, h));
  assert.match(s, /<i style="background:transparent"><\/i>red;background:url\(x\)/);
});
