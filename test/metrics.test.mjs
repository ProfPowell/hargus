import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METRICS, metricValues, formatMetric } from '../extension/core/metrics.js';
import { AREAS, scoreReading } from '../extension/core/score.js';
import { getPlugins } from '../extension/plugins/index.js';

const entry = (bytes) => ({ request: { url: 'https://a.test/' }, response: { _transferSize: bytes, content: {} } });
const reading = (plugins = {}, extra = {}) => ({ log: { entries: [entry(100), entry(250)], _harplus: { plugins, ...extra } } });
const result = (id, data, findings = []) => ({ id, name: id, status: 'ok', data, findings, summary: [] });
const f = (severity, category) => ({ severity, category, title: `${severity} ${category}` });

test('the list follows the spec', () => {
  assert.deepEqual(METRICS.map((x) => x.id), ['lcp', 'fcp', 'ttfb', 'cls', 'blockingTime', 'load', 'bytes', 'requests',
    'a11yFindings', 'contrastFailures', 'securityFindings', 'securityHeaders', 'contentFindings', 'thirdPartyRequests',
    'jsBytes', 'cssBytes', 'infrastructureFindings', 'internationalFindings', 'carbon']);
  const areas = AREAS.map((a) => a.id);
  for (const x of METRICS) {
    assert.ok(areas.includes(x.area), x.id);
    assert.equal(x.better, x.id === 'securityHeaders' ? 'higher' : 'lower', x.id);
    assert.ok(x.best && x.worst, x.id);
  }
});

test('timings are medians when runs exist', () => {
  const vitals = result('vitals', { lcp: { time: 2000 }, fcp: 500, navigation: { ttfb: 80, load: 3000 }, cls: 0.1, blockingTime: 0 });
  const r = reading({ vitals }, { runs: { samples: [{ lcp: 1000 }, { lcp: 3000 }] } });
  const v = metricValues(r);
  assert.equal(v.lcp.value, 2000);
  assert.deepEqual(v.lcp.range, { min: 1000, max: 3000, n: 3 });
  assert.equal(v.fcp.range, null); // one finite value only
  assert.equal(v.fcp.value, 500);
  assert.equal(v.load.value, 3000);
});

test('stored medians and spreads are preferred', () => {
  const vitals = result('vitals', {
    lcp: { time: 9 }, median: { lcp: 1500 }, runs: { metrics: { lcp: { median: 1500, min: 1200, max: 1800, n: 3 } } },
  });
  const v = metricValues(reading({ vitals }));
  assert.equal(v.lcp.value, 1500);
  assert.deepEqual(v.lcp.range, { min: 1200, max: 1800, n: 3 });
});

test('findings metrics count high plus medium from scoreReading', () => {
  const fs = [f('high', 'accessibility'), f('high', 'accessibility'), f('medium', 'accessibility'), ...Array(4).fill(f('low', 'accessibility'))];
  const r = reading({ axe: result('axe', {}, fs) });
  const v = metricValues(r, scoreReading(r, getPlugins()));
  assert.equal(v.a11yFindings.value, 3);
  assert.equal(v.securityFindings.value, null); // security not measured
  assert.equal(metricValues(r).a11yFindings.value, null); // no scores given
});

test('plugin figures are read from their data', () => {
  const r = reading({
    contrast: result('contrast', { totals: { failing: 7 } }),
    security: result('security', { headers: [{ ok: true }, { ok: false }, { ok: true }] }),
    network: result('network', { totals: { thirdParty: { requests: 12 } } }),
    javascript: result('javascript', { totals: { bytes: 4000 } }),
    css: result('css', { totalBytes: 900 }),
    carbon: result('carbon', { grams: 0.42 }),
  });
  const v = metricValues(r);
  assert.deepEqual([v.contrastFailures.value, v.securityHeaders.value, v.thirdPartyRequests.value, v.jsBytes.value, v.cssBytes.value, v.carbon.value], [7, 2, 12, 4000, 900, 0.42]);
});

test('absent sources give null, never 0 or NaN', () => {
  const v = metricValues(reading());
  for (const x of METRICS) {
    if (x.id === 'bytes') assert.equal(v.bytes.value, 350);
    else if (x.id === 'requests') assert.equal(v.requests.value, 2);
    else assert.deepEqual(v[x.id], { value: null, range: null }, x.id);
  }
});

test('formatMetric uses the shared formatters', () => {
  assert.equal(formatMetric('lcp', 2500), '2.50 s');
  assert.equal(formatMetric('bytes', 2048), '2.0 KB');
  assert.equal(formatMetric('cls', 0.1234), '0.123');
  assert.equal(formatMetric('carbon', 0.4231), '0.42 g');
  assert.equal(formatMetric('requests', 12), '12');
  assert.equal(formatMetric('lcp', null), '—');
});
