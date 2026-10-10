import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../extension/ui/render.js';
import { getPlugins } from '../extension/plugins/index.js';

const plugin = (id) => getPlugins().find((p) => p.id === id);
const ok = (data, extra = {}) => ({ status: 'ok', data, findings: [], summary: [], ...extra });
const G = (id, data, ctx = {}) => String(plugin(id).glance(ok(data), h, ctx));

test('vitals glance: four threshold meters plus blocking time', () => {
  const s = G('vitals', {
    lcp: { time: 3100, element: 'img' }, cls: 0.04, fcp: 1200, blockingTime: 610,
    navigation: { ttfb: 420 }, ratings: { lcp: 'needs improvement', cls: 'good', fcp: 'good', ttfb: 'good' },
  });
  assert.equal((s.match(/class="chart meter"/g) || []).length, 5);
  assert.match(s, /Largest contentful paint/);
  assert.match(s, /3\.1 s/);
  assert.match(s, /rating-needs-improvement/);
  assert.match(s, /rating-poor/); // blocking 610 > 600
});

test('vitals summary carries ratings and the LCP headline', async () => {
  const v = plugin('vitals');
  const out = v.run({ log: { entries: [] } }, {
    collected: { navigation: { ttfb: 100 }, fcp: 900, lcp: { time: 3000 }, cls: 0.3, blockingTime: 0, renderBlocking: [], domElements: 10, visibility: 'visible' },
    skip: () => { throw new Error('skip'); },
  });
  const lcp = out.summary.find((s) => s.label === 'LCP');
  assert.deepEqual(lcp, { label: 'LCP', value: '3.00 s', rating: 'needs improvement', headline: true });
  assert.equal(out.summary.find((s) => s.label === 'CLS').rating, 'poor');
});

test('network glance: weight donut, party bars, top hosts', () => {
  const s = G('network', {
    totals: { requests: 10, bytes: 2_500_000, decoded: 6_000_000, thirdParty: { requests: 4, bytes: 500_000 } },
    byType: [{ type: 'image', requests: 3, bytes: 1_000_000 }, { type: 'script', requests: 4, bytes: 900_000 }, { type: 'font', requests: 2, bytes: 600_000 }],
    hosts: [{ host: 'a.com', requests: 6, bytes: 2_000_000, thirdParty: false }, { host: 'gtm.com', requests: 4, bytes: 500_000, thirdParty: true }],
  });
  assert.match(s, /class="chart donut"/);
  assert.match(s, />2\.38<\/text>/);
  assert.match(s, /class="unit"[^>]*>MB</);
  assert.match(s, /aria-label="Requests: First party 6, Third party 4"/);
  assert.match(s, /a\.com/);
  assert.match(s, /width:66\.7%;background:var\(--c2\)/);
});

test('pagespeed glance: one ring per Lighthouse category', () => {
  const s = G('pagespeed', { strategy: 'mobile', lab: { scores: { performance: 0.42, accessibility: 0.95, 'best-practices': 1, seo: null } } });
  assert.equal((s.match(/class="chart ring"/g) || []).length, 3);
  assert.match(s, /Lighthouse Performance: 42 of 100/);
  assert.equal(G('pagespeed', { lab: null }), '');
});
