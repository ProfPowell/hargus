import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../extension/plugins/vitals.js';
import { h } from '../extension/ui/render.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';

const c = (over = {}) => ({
  visibility: 'visible', navigation: { ttfb: 100, domContentLoaded: 400, load: 900, serverTiming: [] }, fcp: 500,
  lcp: { time: 5000, size: 1, element: 'img.hero' }, cls: 0.3, clsSources: [], longAnimationFrames: 3, blockingTime: 400,
  resources: 1, renderBlocking: [], domElements: 10, ...over,
});
const ctx = (collected) => ({ collected, skip: (m) => { throw new Error(m); } });
const run = (col) => plugin.run({ log: { entries: [], _harplus: {} } }, ctx(col));
const NOTE = 'Measured up to 1.8 s, before HARgus scrolled the page.';

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

/** A plugin's output as the saved reading keeps it (through normalize). */
const saved = async (out) => {
  const reading = createReading({ entries: [], target: makeTarget('https://s.test/', 'S', 'https://s.test/') });
  await runPlugins(reading, [{ id: 'n', name: 'N', phase: 'analyze', run: async () => out }], {});
  return reading.log._harplus.plugins.n;
};

test('places: the LCP element with its resource, each shifted element once with its shift, every render-blocking URL', () => {
  const blocking = Array.from({ length: 7 }, (_, i) => `https://s.test/b${i}.css`);
  const r = run(c({
    lcp: { time: 5000, size: 1, element: 'img.hero', url: 'https://s.test/hero.jpg' },
    clsSources: [{ value: 0.2, sources: [{ node: 'div.ad' }, { node: '(removed)' }] }, { value: 0.1, sources: [{ node: 'div.ad' }, { node: 'p#x' }] }],
    renderBlocking: blocking,
  }));
  const f = (re) => r.findings.find((x) => re.test(x.title));
  assert.deepEqual(f(/^Largest contentful paint/).places, [{ selector: 'img.hero', url: 'https://s.test/hero.jpg' }]);
  assert.deepEqual(f(/^Cumulative layout shift/).places, [{ selector: 'div.ad', note: 'shift 0.2' }, { selector: 'p#x', note: 'shift 0.1' }]);
  assert.equal(f(/^Cumulative layout shift/).detail, 'Shifted: div.ad, (removed), p#x', 'detail unchanged');
  assert.deepEqual(f(/render-blocking/).places, blocking.map((url) => ({ url })));
  assert.equal(f(/^First contentful paint|^Time to first byte/), undefined);
  assert.equal(run(c({ lcp: { time: 5000, size: 1, element: null } })).findings.find((x) => /^Largest/.test(x.title)).places, undefined, 'no element, no places');
});

test('odd values: a very long and a data: render-blocking URL, a "<" in an element, survive normalize, escaped when drawn', async () => {
  const long = `https://s.test/${'p/'.repeat(300)}a.css`;
  const out = run(c({
    lcp: { time: 5000, size: 1, element: 'div.<b>' },
    renderBlocking: [long, 'data:text/css,p{}', ...Array.from({ length: 4 }, (_, i) => `https://s.test/${i}.css`)],
  }));
  const s = await saved(out);
  const rb = s.findings.find((x) => /render-blocking/.test(x.title)).places;
  assert.equal(rb[0].url.length, 500);
  assert.equal(rb[1].url, 'data:text/css,p{}');
  const lcp = s.findings.find((x) => /^Largest/.test(x.title)).places;
  const drawn = String(h.places([...lcp, ...rb]));
  assert.match(drawn, /<code>div\.&lt;b&gt;<\/code>/);
  assert.match(drawn, /<span class="url-path">data:text\/css,p\{\}<\/span>/);
});

test('render: the milestones the glance lacks come first; rated metrics are not repeated; URLs as parts', () => {
  const r = run(c({ lcp: { time: 5000, size: 1, element: 'img.hero', url: 'https://s.test/hero.jpg' }, renderBlocking: ['https://s.test/a.css?v=1'], domElements: 2400 }));
  const s = String(plugin.render({ status: 'ok', ...r }, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('class="kv"'), 'stats first');
  assert.match(s, /DOMContentLoaded<\/span><div class="stat-value">400\u00a0ms/, 'number and unit keep together');
  assert.match(s, /Load<\/span><div class="stat-value">900\u00a0ms/);
  assert.match(s, /Render-blocking<\/span><div class="stat-value">1/);
  assert.match(s, /DOM elements<\/span><div class="stat-value">2,400/);
  assert.match(s, /<dt>LCP element<\/dt><dd>img\.hero/);
  assert.match(s, /<span class="url-host">s\.test<\/span><span class="url-path">\/hero\.jpg/);
  assert.match(s, /<span class="url-path">\/a\.css<\/span><span class="url-query">\?v=1<\/span>/);
  assert.doesNotMatch(s, /Cumulative layout shift|Time to first byte|class="rating/, 'the glance tiles carry the rated metrics');
});

// ---- run-to-run spread: the plugin works on the median of several runs ----
const smp = (lcp, over = {}) => ({ lcp, fcp: 500, ttfb: 100, cls: 0.01, blockingTime: 100, domContentLoaded: 400, load: 900, ...over });
const withRuns = (samples, over = {}) => ({ log: { entries: [], _harplus: { runs: { requested: samples.length + 1, samples: samples.map((s, i) => ({ run: i + 1, ...s })), skipped: [], ...over } } } });
const runR = (reading, col) => plugin.run(reading, ctx(col));
const three = () => withRuns([smp(3000), smp(3500)]);
const quiet = (over = {}) => c({ cls: 0.01, blockingTime: 100, ...over });

test('runs: ratings, finding and title come from the median, not the full run', () => {
  const r = runR(three(), quiet());
  assert.equal(r.data.ratings.lcp, 'needs improvement');
  const f = r.findings.find((x) => /^Largest contentful paint/.test(x.title));
  assert.equal(f.severity, 'low');
  assert.match(f.title, /3\.50 s/);
  assert.doesNotMatch(f.title, /5\.00 s/);
  assert.equal(r.summary.find((s) => s.label === 'LCP').value, '3.50 s');
});

test('runs: data.runs and data.median', () => {
  const r = runR(three(), quiet());
  assert.equal(r.data.runs.n, 3);
  assert.equal(r.data.runs.requested, 3);
  assert.deepEqual(r.data.runs.samples.at(-1), { run: 3, full: true, lcp: 5000, fcp: 500, ttfb: 100, cls: 0.01, blockingTime: 100, domContentLoaded: 400, load: 900 });
  assert.equal(r.data.runs.metrics.lcp.median, 3500);
  assert.equal(r.data.median.lcp, 3500);
  assert.deepEqual(Object.keys(r.data.median).sort(), ['blockingTime', 'cls', 'fcp', 'lcp', 'ttfb']);
  assert.equal(r.data.lcp.time, 5000, 'the full run stays under lcp.time');
});

test('runs: a run in another band is named in evidence (was / were)', () => {
  const f = (r) => r.findings.find((x) => /^Largest contentful paint/.test(x.title));
  assert.equal(f(runR(three(), quiet())).evidence, '1 of 3 runs was poor');
  const two = runR(withRuns([smp(3000), smp(3100), smp(5200), smp(5300)]), quiet({ lcp: { time: 3200, size: 1 } }));
  assert.equal(two.data.ratings.lcp, 'needs improvement');
  assert.equal(f(two).evidence, '2 of 5 runs were poor');
  const same = runR(withRuns([smp(3000), smp(3100)]), quiet({ lcp: { time: 3200, size: 1 } }));
  assert.equal(f(same).evidence, undefined);
});

test('runs: blocking time finding uses the median against 300 ms, and varies when runs straddle 200 ms', () => {
  const r = runR(withRuns([smp(1000, { blockingTime: 100 }), smp(1000, { blockingTime: 150 })]), quiet({ blockingTime: 900 }));
  assert.ok(!r.findings.some((x) => /^Main thread blocked/.test(x.title)), 'median 150 is under 300');
  const hi = runR(withRuns([smp(1000, { blockingTime: 400 }), smp(1000, { blockingTime: 500 })]), quiet({ blockingTime: 450 }));
  assert.match(hi.findings.find((x) => /^Main thread blocked/.test(x.title)).title, /450 ms/);
  const straddle = runR(withRuns([smp(1000, { blockingTime: 150 }), smp(1000, { blockingTime: 250 })]), quiet({ blockingTime: 180 }));
  assert.equal(straddle.data.runs.metrics.blockingTime.varies, true);
  assert.equal(straddle.data.median.blockingTime, 180);
});

test('no runs: result is exactly today\'s, with no data.runs or data.median', () => {
  const plain = run(c());
  const empty = runR({ log: { entries: [], _harplus: {} } }, c());
  assert.deepEqual(empty, plain);
  assert.ok(!('runs' in plain.data) && !('median' in plain.data));
});

test('one sample in all: no data.runs, ratings from the full run', () => {
  const r = runR(withRuns([], { requested: 3, skipped: [{ run: 1, reason: 'timed out' }, { run: 2, reason: 'timed out' }] }), c());
  assert.deepEqual(r, run(c()));
  assert.equal(r.data.ratings.lcp, 'poor');
});

test('glance: median value with range, runs and varies note', () => {
  const r = runR(three(), quiet());
  const out = String(plugin.glance({ data: r.data }, h));
  assert.match(out, /3\.5 s/);
  assert.match(out, /3\.0–5\.0 s · 3 runs · varies/);
  const steady = runR(withRuns([smp(2000), smp(2100)]), quiet({ lcp: { time: 2050, size: 1 } }));
  assert.match(String(plugin.glance({ data: steady.data }, h)), /2\.0–2\.1 s · 3 runs · steady/);
  assert.match(out, /0\.01–0\.01 · 3 runs/);
});

test('glance without runs: no note', () => {
  const out = String(plugin.glance({ data: run(c()).data }, h));
  assert.doesNotMatch(out, /runs|varies|steady|median/);
});

test('render with runs: Each run table, full run marked, Median row, skipped listed', () => {
  const rd = withRuns([smp(3000), smp(3500)], { requested: 4, skipped: [{ run: 3, reason: 'timed out' }] });
  const r = runR(rd, quiet());
  const out = String(plugin.render({ data: r.data }, h));
  assert.match(out, /<details class="disclosure"><summary>Each run/);
  assert.doesNotMatch(out, /<details[^>]*open/);
  for (const col of ['Run', 'LCP', 'FCP', 'TTFB', 'CLS', 'Blocking', 'Load']) assert.match(out, new RegExp(`<th scope="col">${col}</th>`));
  assert.equal((out.match(/\(full reading\)/g) || []).length, 1);
  assert.match(out, /<td>Median<\/td>/);
  assert.match(out, /Run 3: timed out/);
});

test('render without runs: no Each run', () => {
  assert.doesNotMatch(String(plugin.render({ data: run(c()).data }, h)), /Each run/);
});
