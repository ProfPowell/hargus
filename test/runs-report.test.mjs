import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows, extraRunSeconds, median, formatRows } from '../scripts/runs-report.mjs';

const digest = [
  { url: 'https://a.test/', durationMs: 40000, vitalsRuns: { n: 3, metrics: {
    lcp: { median: 2000, min: 1800, max: 2600, n: 3, varies: true },
    cls: { median: 0, min: 0, max: 0, n: 3, varies: false },
    ttfb: { median: 0, min: 0, max: 0, n: 3, varies: false },
  } } },
  { url: 'https://b.test/', error: 'timed out' },
  { url: 'https://c.test/', durationMs: 20000, vitalsRuns: null },
];

test('rows: one row per site and metric, range as a percent of the median', () => {
  const r = rows(digest);
  assert.deepEqual(r[0], { site: 'https://a.test/', metric: 'lcp', median: 2000, rangePct: 40, varies: true });
  assert.deepEqual(r[1], { site: 'https://a.test/', metric: 'cls', median: 0, rangePct: 0, varies: false });
  assert.equal(r.length, 3, 'errored sites and sites without runs add no rows');
});

test('rows: a zero median with a spread has no percent', () => {
  const r = rows([{ url: 'u', vitalsRuns: { metrics: { cls: { median: 0, min: 0, max: 0.2, n: 3, varies: true } } } }]);
  assert.equal(r[0].rangePct, null);
});

test('median: middle value, mean of the middle two when even, null when empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('extraRunSeconds: (median of the 3-run durations - median of the 1-run durations) / 2, to the nearest 5 s', () => {
  assert.equal(extraRunSeconds([50000, 60000, 70000], [30000, 30000, 30000]), 15);
  assert.equal(extraRunSeconds([37000], [30000]), 5);
  assert.equal(extraRunSeconds([], [30000]), null);
});

test('formatRows: a table line per row and a varies share', () => {
  const out = formatRows(rows(digest));
  assert.match(out, /a\.test.*lcp.*2000.*40%.*varies/);
  assert.match(out, /1 of 3 site-metric pairs vary \(33%\)/);
});
