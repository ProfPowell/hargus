import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../extension/plugins/pagespeed.js';
import { h } from '../extension/ui/render.js';

const lhr = {
  lighthouseVersion: '13.5.0', finalDisplayedUrl: 'https://s.test/page?a=1', fetchTime: '2026-10-30T10:00:00.000Z',
  categories: { performance: { title: 'Performance', score: 0.61, auditRefs: [] }, seo: { title: 'SEO', score: 0.9, auditRefs: [] } },
  audits: {},
};
const exp = { overall_category: 'SLOW', metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4200, category: 'SLOW' }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: 'FAST' }, INTERACTION_TO_NEXT_PAINT: { percentile: 300, category: 'AVERAGE' } } };

const run = (body) => plugin.run({ log: { entries: [], _harplus: {} } }, {
  keys: { pagespeed: 'k' }, options: { strategy: 'mobile' }, target: { finalUrl: 'https://s.test/', host: 's.test' }, util: { isIP: () => false },
  fetch: async () => new Response(JSON.stringify(body), { status: 200 }), skip: (m) => { throw new Error(m); },
});

test('render: real-user p75 first with ratings in words; the Lighthouse scores are the glance\'s', async () => {
  const out = await run({ lighthouseResult: lhr, loadingExperience: exp });
  const s = String(plugin.render({ status: 'ok', ...out }, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<h4>Lab</h4>'), 'field stats before the lab');
  assert.match(s, /LCP<\/span><div class="stat-value">4\.2 s<\/div><span class="stat-note"><span class="status" data-status="poor">Poor/);
  assert.match(s, /INP<\/span><div class="stat-value">300 ms<\/div><span class="stat-note"><span class="status" data-status="fair">Needs improvement/);
  assert.match(s, /CLS<\/span><div class="stat-value">0\.05<\/div><span class="stat-note"><span class="status" data-status="good">Good/);
  assert.match(s, /Overall <span class="status" data-status="poor">Poor/);
  assert.doesNotMatch(s, /class="rating/, 'no colour-only rating chips');
  assert.doesNotMatch(s, /<dt>performance<\/dt>|<dt>seo<\/dt>/, 'scores are not repeated');
  assert.match(s, /<dt>Lighthouse<\/dt><dd>13\.5\.0<\/dd><dt>Device<\/dt><dd>mobile<\/dd>/);
  assert.match(s, /<a href="https:\/\/s\.test\/page\?a=1"[^>]*><span class="url"[^>]*><span class="url-host">s\.test<\/span><span class="url-path">\/page<\/span><span class="url-query">\?a=1/);
});

test('render without field data or lab: one note, nothing broken', () => {
  const s = String(plugin.render({ status: 'ok', data: { strategy: 'mobile', lab: null, field: null } }, h));
  assert.match(s, /No Chrome UX Report data/);
  assert.doesNotMatch(s, /NaN|undefined|<h4>Lab/);
});

test('headline: the Lighthouse performance score, else the real-user line', async () => {
  const both = (await run({ lighthouseResult: lhr, loadingExperience: exp })).summary.filter((x) => x.headline);
  assert.deepEqual(both.map((x) => `${x.label} ${x.value}`), ['Performance 61']);
  const field = (await run({ loadingExperience: exp })).summary.filter((x) => x.headline);
  assert.deepEqual(field.map((x) => `${x.label} ${x.value}`), ['Field (page) LCP 4.2 s · INP 300 ms · CLS 0.05']);
});
