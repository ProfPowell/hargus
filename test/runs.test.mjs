import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, sampleOf, spread, spreadAll, RUN_METRICS } from '../extension/core/runs.js';

const c = (over = {}) => ({
  visibility: 'visible', navigation: { ttfb: 100, domContentLoaded: 400, load: 900, serverTiming: [] }, fcp: 500,
  lcp: { time: 5000, size: 1, element: 'img.hero' }, cls: 0.3, clsSources: [], longAnimationFrames: 3, blockingTime: 400,
  resources: 1, renderBlocking: [], domElements: 10, ...over,
});
const LIMITS = { lcp: [2500, 4000], fcp: [1800, 3000], ttfb: [800, 1800], cls: [0.1, 0.25], blockingTime: [200, 600] };

test('median: odd, even, junk and empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([null, 5, NaN]), 5);
  assert.equal(median([]), null);
});

test('sampleOf flattens a vitals collect() result', () => {
  assert.deepEqual(sampleOf(c()), { lcp: 5000, fcp: 500, ttfb: 100, cls: 0.3, blockingTime: 400, domContentLoaded: 400, load: 900 });
  assert.deepEqual(Object.keys(sampleOf(c())).sort(), [...RUN_METRICS].sort());
});

test('sampleOf({}) gives every metric as null', () => {
  const s = sampleOf({});
  assert.deepEqual(Object.keys(s).sort(), [...RUN_METRICS].sort());
  assert.ok(Object.values(s).every((v) => v === null));
});

test('spread: values across two bands vary', () => {
  assert.deepEqual(spread([2400, 2600, 2500], { bands: [2500, 4000] }),
    { median: 2500, min: 2400, max: 2600, n: 3, varies: true, bands: { good: 2, 'needs improvement': 1, poor: 0 } });
});

test('spread: tight values in one band do not vary', () => {
  assert.equal(spread([1000, 1100, 1050], { bands: [2500, 4000] }).varies, false);
});

test('spread: one band but a wide range varies', () => {
  assert.equal(spread([1000, 1400, 1100], { bands: [2500, 4000] }).varies, true);
});

test('spread: the floor keeps small absolute ranges quiet', () => {
  assert.equal(spread([100, 160, 120], { floor: 100 }).varies, false);
  assert.equal(spread([100, 160, 120], {}).varies, true);
});

test('spread: pctRule off leaves only the bands', () => {
  assert.equal(spread([0.01, 0.05, 0.02], { bands: [0.1, 0.25], pctRule: false }).varies, false);
});

test('spread: fewer than two finite values is null', () => {
  assert.equal(spread([5, null]), null);
  assert.equal(spread([5]), null);
});

test('spreadAll: a null metric in one run is computed from the rest', () => {
  const a = sampleOf(c({ lcp: null }));
  const b = sampleOf(c({ lcp: { time: 3000 } }));
  const r = spreadAll([a, b], LIMITS);
  assert.equal(r.lcp, null);
  assert.equal(r.fcp.n, 2);
  assert.ok(r.fcp.bands);
  assert.equal(r.cls.varies, false);
  assert.equal(r.load.bands, undefined);
  assert.deepEqual(Object.keys(r).sort(), [...RUN_METRICS].sort());
});

test('spreadAll: cls has no pct rule, ttfb has a 100 ms floor', () => {
  const s = (cls, ttfb) => sampleOf(c({ cls, navigation: { ttfb, domContentLoaded: 400, load: 900 } }));
  const r = spreadAll([s(0.01, 100), s(0.05, 150)], LIMITS);
  assert.equal(r.cls.varies, false);
  assert.equal(r.ttfb.varies, false);
});

test('sampleOf: a 0 load or DOMContentLoaded means not reached, so null', () => {
  const s = sampleOf(c({ navigation: { ttfb: 100, domContentLoaded: 0, load: 0 } }));
  assert.equal(s.load, null);
  assert.equal(s.domContentLoaded, null);
  assert.equal(s.ttfb, 100);
});

test('spreadAll: lcp and fcp have a 100 ms floor, the band rule still applies', () => {
  const s = (lcp, fcp) => sampleOf(c({ lcp: { time: lcp }, fcp, navigation: { ttfb: 50, domContentLoaded: 400, load: 900 } }));
  const quiet = spreadAll([s(200, 150), s(280, 230)], LIMITS);
  assert.equal(quiet.lcp.varies, false, '80 ms is 33% of the median but under the floor');
  assert.equal(quiet.fcp.varies, false);
  const banded = spreadAll([s(2450, 300), s(2540, 320)], LIMITS);
  assert.equal(banded.lcp.varies, true, 'runs either side of 2.5 s still vary');
});
