import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { SWDM, GRID, rate, estimate } from '../extension/plugins/carbon.js';
import { getPlugins } from '../extension/plugins/index.js';
import * as util from '../extension/core/har-util.js';
import { h } from '../extension/ui/render.js';

const entry = (url, bytes) => ({
  request: { url, method: 'GET', headers: [] },
  response: { status: 200, headers: [], bodySize: bytes, headersSize: 0, _transferSize: bytes, content: { size: bytes } },
  timings: {}, time: 1, startedDateTime: new Date(0).toISOString(),
});
const reading = (entries) => ({ log: { entries, _harplus: {} } });
const calls = [];
const ctx = (answers, options = {}) => ({
  util, target: { host: 's.test' }, options: { greenCheck: true, ...options },
  fetchJSON: async (url) => {
    calls.push(url);
    const host = decodeURIComponent(url.split('/').pop());
    if (!(host in answers)) throw new Error('HTTP 503');
    return answers[host];
  },
  skip: (m) => { throw new Error(m); },
});
const PER_GB = SWDM.dc.op + SWDM.dc.emb + SWDM.net.op + SWDM.net.emb + SWDM.dev.op + SWDM.dev.emb;

test('registered in the enrich phase, Sustainability area, disclosed', () => {
  assert.ok(getPlugins().some((p) => p.id === 'carbon'));
  assert.equal(plugin.phase, 'enrich');
  assert.equal(plugin.area, 'sustainability');
  assert.match(plugin.disclosure, /thegreenwebfoundation/);
  assert.equal(GRID, 494);
  assert.equal(Math.round(PER_GB * 1000), 300);
});

test('rating boundaries', () => {
  assert.equal(rate(0.040), 'A+');
  assert.equal(rate(0.0401), 'A');
  assert.equal(rate(0.079), 'A');
  assert.equal(rate(0.359), 'E');
  assert.equal(rate(0.360), 'F');
});

test('worked example: 1 MB green first party + 1 MB third party', async () => {
  calls.length = 0;
  const out = await plugin.run(reading([entry('https://s.test/', 1e6), entry('https://cdn.other/x.js', 1e6)]),
    ctx({ 's.test': { green: true, hosted_by: 'Green Co' }, 'cdn.other': { green: false } }));
  const green = 0.001 * (PER_GB - SWDM.dc.op) * GRID;
  const grey = 0.001 * PER_GB * GRID;
  assert.ok(Math.abs(out.data.grams - (green + grey)) < 1e-9);
  assert.equal(out.data.rating, 'D');
  assert.equal(out.data.hosts.find((x) => x.host === 's.test').hostedBy, 'Green Co');
  assert.deepEqual(out.findings.map((f) => `${f.severity}:${f.title}`), ['medium:Carbon rating D (0.27 g CO₂ per visit)']);
  assert.deepEqual(out.summary[0], { label: 'CO₂ per visit', value: '0.27 g · rating D', rating: 'needs-improvement', headline: true });
  assert.deepEqual(out.summary[1], { label: 'Green hosting', value: '1 of 2 hosts', headline: true });
  assert.equal(out.data.segments.dataCentre + out.data.segments.network + out.data.segments.device, out.data.grams);
});

test('main host not green; failed lookup is unknown; IP hosts are not looked up', async () => {
  calls.length = 0;
  const out = await plugin.run(reading([entry('https://s.test/', 50_000), entry('https://down.test/a', 1000), entry('http://10.0.0.1/b', 1000)]),
    ctx({ 's.test': { green: false } }));
  assert.ok(out.findings.some((f) => f.title === "Main site isn't on green hosting"));
  assert.equal(out.data.hosts.find((x) => x.host === 'down.test').green, null);
  assert.ok(!calls.some((u) => u.includes('10.0.0.1')));
  assert.equal(out.summary[1].value, '0 of 1 hosts');
});

test('greenCheck off: estimate without lookups; custom endpoint', async () => {
  calls.length = 0;
  const off = await plugin.run(reading([entry('https://s.test/', 1e6)]), ctx({}, { greenCheck: false }));
  assert.equal(calls.length, 0);
  assert.equal(off.data.hosts[0].green, null);
  assert.ok(off.data.grams > 0);
  await plugin.run(reading([entry('https://s.test/', 1e6)]), ctx({ 's.test': { green: true } }, { endpoint: 'http://127.0.0.1:9/__mock/greencheck/' }));
  assert.ok(calls.at(-1).startsWith('http://127.0.0.1:9/__mock/greencheck/s.test'));
});

test('estimate is pure; glance shows per-year figure and host checklist', async () => {
  const e = estimate([{ host: 'a', bytes: 1e9, green: false }]);
  assert.ok(Math.abs(e.grams - PER_GB * GRID) < 1e-9);
  const out = await plugin.run(reading([entry('https://s.test/', 1e6), entry('https://cdn.other/x.js', 1e6)]),
    ctx({ 's.test': { green: true, hosted_by: 'Green Co' } }));
  const g = String(plugin.glance({ status: 'ok', ...out }, h));
  assert.match(g, /≈ 32\.3 kg/);
  assert.match(g, /aria-label="unknown"/, 'cdn.other lookup failed → unknown');
  assert.match(g, /Green Co/);
});
