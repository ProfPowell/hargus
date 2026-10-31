import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { setImageEnv, formatOf } from '../extension/plugins/images.js';
import { getPlugins } from '../extension/plugins/index.js';
import * as util from '../extension/core/har-util.js';
import { h } from '../extension/ui/render.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';
import { CASES, runCase, LONG, ODD, fakeEnv } from './fixtures/images-cases.mjs';
import BASELINE from './fixtures/images-findings-baseline.json' with { type: 'json' };

const img = (src, nw, nh, dw, dh, extra = {}) => ({
  src, naturalWidth: nw, naturalHeight: nh, displayWidth: dw, displayHeight: dh, dpr: 1, loading: '', fetchpriority: '',
  decoding: '', sized: true, aboveFold: true, inPicture: false, alt: true, ...extra,
});
const entry = (url, bytes, mime) => ({
  request: { url, method: 'GET', headers: [] },
  response: { status: 200, headers: [], bodySize: bytes, headersSize: 0, _transferSize: bytes, content: { mimeType: mime, size: bytes } },
  timings: {}, time: 1, startedDateTime: new Date(0).toISOString(),
});
const S = 'https://s.test/';
const collected = {
  images: [
    img(`${S}big.jpg`, 2400, 1600, 300, 200, { loading: 'lazy', sized: false }),
    img(`${S}logo.png`, 400, 100, 400, 100),
    img(`${S}tiny.png`, 10, 10, 10, 10),
    img(`${S}anim.gif`, 300, 300, 300, 300),
    img(`${S}fail.jpg`, 800, 600, 800, 600),
    img('data:image/png;base64,xx', 1, 1, 1, 1),
  ],
  lcp: `${S}big.jpg`,
};
const reading = { log: { entries: [
  entry(`${S}big.jpg`, 1_000_000, 'image/jpeg'), entry(`${S}logo.png`, 60_000, 'image/png'), entry(`${S}tiny.png`, 2_000, 'image/png'),
  entry(`${S}anim.gif`, 400_000, 'image/gif'), entry(`${S}fail.jpg`, 200_000, 'image/jpeg'),
], _harplus: {} } };
const fetched = [];
const ctx = (over = {}) => ({
  collected, util,
  fetch: async (url) => { fetched.push(url); if (url.endsWith('fail.jpg')) throw new Error('CORS'); return { ok: true, status: 200, blob: async () => ({}) }; },
  skip: (m) => { throw new Error(m); },
  ...over,
});
const runWith = async (env, over) => { setImageEnv(env); fetched.length = 0; try { return await plugin.run(reading, ctx(over)); } finally { setImageEnv(); } };
const byFile = (out, f) => out.data.images.find((i) => i.src.endsWith(f));

test('registered as a page plugin in Performance', () => {
  assert.ok(getPlugins().some((p) => p.id === 'images'));
  assert.equal(plugin.phase, 'page');
  assert.equal(plugin.area, 'performance');
  assert.equal(formatOf('image/jpeg'), 'jpeg');
  assert.equal(formatOf('', 'https://x/a.JPG?v=1'), 'jpeg');
  assert.equal(formatOf('image/svg+xml'), 'svg');
});

test('candidates: raster over 10 KB, data: URLs skipped, fetch failure recorded', async () => {
  const out = await runWith(fakeEnv());
  assert.equal(out.data.images.length, 5, 'data: URL skipped');
  assert.ok(!fetched.some((u) => u.endsWith('tiny.png')), 'tiny not encoded');
  assert.equal(byFile(out, 'fail.jpg').encodeError, 'CORS');
  assert.equal(byFile(out, 'fail.jpg').saving, 0);
  assert.equal(out.data.totals.measured, 3, 'only successful encodes');
});

test('savings maths', async () => {
  const out = await runWith(fakeEnv());
  const big = byFile(out, 'big.jpg');
  assert.deepEqual([big.neededWidth, big.neededHeight], [300, 200]);
  assert.equal(big.webpNeeded, 6000);
  assert.equal(big.webpNatural, 384000);
  assert.equal(big.avifNeeded, 4200);
  assert.equal(big.saving, 995800);
  assert.equal(big.formatSaving, 616000);
  assert.equal(big.oversized, true);
  assert.equal(byFile(out, 'logo.png').saving, 57200);
  assert.equal(byFile(out, 'logo.png').oversized, false);
  assert.equal(out.data.totals.bytes, 1_662_000);
  assert.equal(out.data.totals.saving, 1_053_000);
});

test('findings and thresholds', async () => {
  const out = await runWith(fakeEnv());
  const t = Object.fromEntries(out.findings.map((f) => [f.title, f]));
  assert.equal(t["1 image is larger than it's shown"].severity, 'medium');
  assert.match(t["1 image is larger than it's shown"].detail, /big\.jpg 2400×1600 → 300×200/);
  assert.equal(t['Modern formats would save 656.3 KB'].severity, 'medium');
  assert.ok(!Object.keys(t).some((k) => /without width and height/.test(k)), 'unsized is reported by meta, not here');
  assert.equal(out.data.totals.unsized, 1);
  assert.equal(t['The largest image (LCP) is lazy-loaded'].severity, 'medium');
  assert.equal(t['The LCP image has no fetchpriority=high'].severity, 'info');
  assert.equal(t['Animated GIF of 390.6 KB — use a video'].severity, 'low');
});

test('summary and AVIF unsupported', async () => {
  const out = await runWith(fakeEnv());
  assert.deepEqual(out.summary[0], { label: 'Images', value: '5 · 1.59 MB', headline: true });
  assert.deepEqual(out.summary[1], { label: 'Potential savings', value: '1.00 MB (63%)', rating: 'poor' });
  const noAvif = await runWith(fakeEnv({ avif: false }));
  assert.equal(noAvif.data.avifSupported, false);
  assert.equal(byFile(noAvif, 'big.jpg').avifNeeded, null);
  assert.equal(byFile(noAvif, 'big.jpg').saving, 994000);
});

test('time budget: images past the deadline are skipped, not failed', async () => {
  const realNow = Date.now;
  let t = 0;
  Date.now = () => (t += 5000);
  try {
    const out = await runWith(fakeEnv());
    assert.ok(out.data.images.some((i) => i.encodeError === 'time budget exceeded'));
  } finally { Date.now = realNow; }
});

test('glance and render', async () => {
  const out = await runWith(fakeEnv());
  const g = String(plugin.glance({ status: 'ok', ...out }, h));
  assert.match(g, /Image weight/);
  assert.match(g, /big\.jpg/);
  assert.match(g, /976\.6\u00a0KB → 4\.1\u00a0KB/);
  const r = String(plugin.render({ status: 'ok', ...out }, h));
  assert.match(r, /<th scope="col">AVIF<\/th>/);
  assert.ok(r.indexOf('class="stats"') < r.indexOf('<table'), 'stats before the table');
  assert.match(r, /Images<\/span><div class="stat-value">5/);
  assert.match(r, /Re-encoded<\/span><div class="stat-value">3/);
  assert.match(r, /Oversized<\/span><div class="stat-value">1/);
  assert.match(r, /Without width and height<\/span><div class="stat-value">1/);
  assert.match(r, /<span class="url-host">s\.test<\/span><span class="url-path">\/big\.jpg<\/span>/, 'the image URL as parts');
  assert.ok(r.indexOf('big.jpg') < r.indexOf('logo.png'), 'biggest saving first');
});

test('findings: every field but places is unchanged from before places (score-check cannot replay images)', async () => {
  for (const [name, c] of Object.entries(CASES)) {
    const out = await runCase(plugin, setImageEnv, c);
    assert.deepEqual(out.findings.map(({ places, ...f }) => f), BASELINE[name], name);
  }
});

test('places: oversized, modern formats, LCP and GIF findings name their images', async () => {
  const out = await runCase(plugin, setImageEnv, CASES.base);
  const t = Object.fromEntries(out.findings.map((f) => [f.title, f]));
  assert.deepEqual(t["1 image is larger than it's shown"].places, [{ url: `${S}big.jpg`, note: '2400×1600 → 300×200, saves 972.5 KB' }]);
  assert.deepEqual(t['Modern formats would save 656.3 KB'].places, [
    { url: `${S}big.jpg`, note: 'jpeg 976.6 KB, saves 601.6 KB as WebP' },
    { url: `${S}logo.png`, note: 'png 58.6 KB, saves 54.7 KB as WebP' },
  ]);
  assert.deepEqual(t['The largest image (LCP) is lazy-loaded'].places, [{ url: `${S}big.jpg` }]);
  assert.deepEqual(t['The LCP image has no fetchpriority=high'].places, [{ url: `${S}big.jpg` }]);
  assert.deepEqual(t['Animated GIF of 390.6 KB — use a video'].places, [{ url: `${S}anim.gif` }]);
});

test('odd values: all seven oversized images are places (detail names five); a very long URL and a "<" survive normalize, escaped when drawn', async () => {
  const out = await runCase(plugin, setImageEnv, CASES.crowd);
  const reading = createReading({ entries: [], target: makeTarget(S, 'S', S) });
  await runPlugins(reading, [{ id: 'n', name: 'N', phase: 'analyze', run: async () => out }], {});
  const f = reading.log._harplus.plugins.n.findings.find((x) => /larger than/.test(x.title));
  assert.equal(f.places.length, 7);
  assert.equal(f.detail.split('; ').length, 5);
  const long = f.places.find((p) => p.url.includes('deep/'));
  assert.equal(long.url, LONG.slice(0, 500));
  assert.ok(f.places.some((p) => p.url === ODD));
  const drawn = String(h.places(f.places));
  assert.match(drawn, /q=&lt;b&gt;&amp;r=&quot;1&quot;/);
  assert.doesNotMatch(drawn, /<b>&/);
  assert.equal(reading.log._harplus.plugins.n.findings.find((x) => /fetchpriority/.test(x.title)).places[0].url, LONG.slice(0, 500));
});

test('nothing measured: only the LCP and GIF findings, each with its image', async () => {
  const out = await runCase(plugin, setImageEnv, CASES['nothing measured']);
  assert.ok(out.findings.every((f) => f.places?.length === 1));
});

test('GIFs are not counted in savings (the GIF finding covers them)', async () => {
  const out = await runWith(fakeEnv());
  const gif = byFile(out, 'anim.gif');
  assert.equal(gif.saving, 0);
  assert.equal(gif.oversized, false);
});

test('a fetch that never resolves is bounded: that image errors, the rest stay intact', async () => {
  const hang = (url, init) => new Promise((_, rej) => {
    if (!url.endsWith('logo.png')) return rej(new Error('unexpected hang'));
    init.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
  });
  const base = ctx().fetch;
  const out = await runWith({ ...fakeEnv(), budgetMs: 50 }, { fetch: (u, i) => (u.endsWith('logo.png') ? hang(u, i) : base(u, i)) });
  assert.equal(out.data.images.length, 5);
  assert.ok(byFile(out, 'logo.png').encodeError);
  assert.equal(byFile(out, 'logo.png').saving, 0);
  assert.equal(byFile(out, 'logo.png').webpNeeded, undefined);
  assert.equal(byFile(out, 'big.jpg').saving, 995800);
});

test('nothing measured: savings are "not measured" with no rating', async () => {
  const out = await runWith(fakeEnv(), { fetch: async () => { throw new Error('offline'); } });
  assert.equal(out.data.totals.measured, 0);
  assert.deepEqual(out.summary[1], { label: 'Potential savings', value: 'not measured' });
});
