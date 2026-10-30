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
  assert.match(s, /DOMContentLoaded<\/span><div class="stat-value">400 ms/);
  assert.match(s, /Load<\/span><div class="stat-value">900 ms/);
  assert.match(s, /Render-blocking<\/span><div class="stat-value">1/);
  assert.match(s, /DOM elements<\/span><div class="stat-value">2,400/);
  assert.match(s, /<dt>LCP element<\/dt><dd>img\.hero/);
  assert.match(s, /<span class="url-host">s\.test<\/span><span class="url-path">\/hero\.jpg/);
  assert.match(s, /<span class="url-path">\/a\.css<\/span><span class="url-query">\?v=1<\/span>/);
  assert.doesNotMatch(s, /Cumulative layout shift|Time to first byte|class="rating/, 'the glance tiles carry the rated metrics');
});
