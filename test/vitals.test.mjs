import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../extension/plugins/vitals.js';
import { h } from '../extension/ui/render.js';

const c = (over = {}) => ({
  visibility: 'visible', navigation: { ttfb: 100, domContentLoaded: 400, load: 900, serverTiming: [] }, fcp: 500,
  lcp: { time: 5000, size: 1, element: 'img.hero' }, cls: 0.3, clsSources: [], longAnimationFrames: 3, blockingTime: 400,
  resources: 1, renderBlocking: [], domElements: 10, ...over,
});
const ctx = (collected) => ({ collected, skip: (m) => { throw new Error(m); } });
const run = (col) => plugin.run({ log: { entries: [], _harplus: {} } }, ctx(col));
const NOTE = 'Measured up to 1.8 s, before HAR-PLUS scrolled the page.';

test('cutAt: LCP, CLS and blocking findings note they stop at the scroll', () => {
  const r = run(c({ cutAt: 1800 }));
  for (const re of [/^Largest contentful paint/, /^Cumulative layout shift/, /^Main thread blocked/]) {
    const f = r.findings.find((x) => re.test(x.title));
    assert.ok(f, `${re} present`);
    assert.ok(f.detail.endsWith(NOTE), f.detail);
  }
});

test('CLS detail keeps the shifted elements before the note', () => {
  const r = run(c({ cutAt: 1800, clsSources: [{ value: 0.3, sources: [{ node: 'div.ad' }] }] }));
  assert.equal(r.findings.find((x) => /^Cumulative/.test(x.title)).detail, `Shifted: div.ad ${NOTE}`);
});

test('no cutAt (older readings): no note', () => {
  const r = run(c());
  assert.ok(r.findings.every((f) => !String(f.detail || '').includes('Measured up to')));
});

test('LCP only after the scroll → lcp null: no LCP finding, summary dash, clean render', () => {
  const r = run(c({ cutAt: 1800, lcp: null }));
  assert.ok(!r.findings.some((f) => /^Largest contentful paint/.test(f.title)));
  assert.equal(r.summary.find((s) => s.label === 'LCP').value, '—');
  const out = String(plugin.render({ data: r.data }, h)) + String(plugin.glance?.({ data: r.data }, h) ?? '');
  assert.doesNotMatch(out, /NaN|undefined/);
});
