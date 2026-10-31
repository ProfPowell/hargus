import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../extension/plugins/network.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';
import { h } from '../extension/ui/render.js';

const S = 'https://s.test/';
const LONG = `${S}assets/${'deep/'.repeat(120)}missing.png?v=${'x'.repeat(100)}`;
const ODD = `${S}api?q=<b>&r="1"`;

const entry = (url, { status = 200, type = 'other', mime = 'text/plain', bytes = 100, size = bytes, headers = [], ...extra } = {}) => ({
  startedDateTime: new Date(1000).toISOString(), time: 10, _resourceType: type,
  request: { method: 'GET', url, headers: [] },
  response: { status, httpVersion: 'h2', headers, redirectURL: '', bodySize: bytes, headersSize: 0, _transferSize: bytes, content: { mimeType: mime, size } },
  timings: {}, ...extra,
});
const cached = [{ name: 'cache-control', value: 'max-age=60' }];

function sample() {
  const entries = [
    entry('http://s.test/', { status: 301, type: 'document', mime: 'text/html', headers: [{ name: 'location', value: 'https://s.test/start' }] }),
    entry(`${S}start`, { status: 302, type: 'document', mime: 'text/html', headers: [{ name: 'location', value: S }] }),
    entry(S, { type: 'document', mime: 'text/html', headers: [{ name: 'content-encoding', value: 'br' }] }),
    entry(`${S}app.js`, { type: 'script', mime: 'application/javascript', bytes: 5000, size: 5000 }),
    entry(LONG, { status: 404, type: 'image', mime: 'text/html' }),
    entry(ODD, { status: 500, type: 'fetch', mime: 'application/json', headers: cached }),
    entry(`${S}gone.css`, { status: 0, type: 'stylesheet', mime: '', _error: 'net::ERR_FAILED', headers: cached }),
    entry('data:image/png;base64,iVBORw0KGgo=', { type: 'image', mime: 'image/png', bytes: 2 * 1024 ** 2, headers: cached }),
  ];
  for (const e of entries.slice(0, 2)) e.response.redirectURL = e.response.headers[0].value;
  return createReading({ entries, target: makeTarget('http://s.test/', 'S', S) });
}

async function runIt() {
  const reading = sample();
  await runPlugins(reading, [plugin], {});
  return reading.log._harplus.plugins.network;
}

test('places: each finding about requests names them, linked to the Network pane by entry; evidence unchanged', async () => {
  const r = await runIt();
  assert.equal(r.status, 'ok', r.error);
  const f = (re) => r.findings.find((x) => re.test(x.title));
  const unc = f(/without compression/);
  assert.equal(unc.evidence, `${S}app.js`);
  assert.deepEqual(unc.places, [{ url: `${S}app.js`, status: 200, entry: 3, note: '4.9 KB application/javascript' }]);
  assert.deepEqual(f(/without cache headers/).places, [{ url: `${S}app.js`, status: 200, entry: 3, note: 'script' }]);
  const asset = r.findings.find((x) => x.id === 'asset-errors');
  assert.equal(asset.evidence, `404 ${LONG}`);
  assert.deepEqual(asset.places, [{ url: LONG.slice(0, 500), status: 404, entry: 4 }]);
  assert.deepEqual(r.findings.find((x) => x.id === 'request-errors').places, [{ url: ODD, status: 500, entry: 5 }]);
  assert.deepEqual(f(/request failed/).places, [{ url: `${S}gone.css`, status: 'ERR', entry: 6, note: 'net::ERR_FAILED' }]);
  const chain = f(/redirect/);
  assert.equal(chain.detail, `http://s.test/ → ${S}start → ${S}`);
  assert.deepEqual(chain.places, [{ url: 'http://s.test/', status: 301, entry: 0 }, { url: `${S}start`, status: 302, entry: 1 }, { url: S, status: 200, entry: 2 }]);
  assert.deepEqual(f(/over 1 MB/).places, [{ url: 'data:image/png;base64,iVBORw0KGgo=', status: 200, entry: 7, note: '2.00 MB' }]);
  assert.equal(f(/requests$/), undefined);
});

test('odd values: a very long URL, a "<" in a URL and a data: URL are escaped when drawn, the status linked to its request', async () => {
  const r = await runIt();
  const places = r.findings.flatMap((x) => x.places || []);
  const drawn = String(h.places(places, { interactive: true }));
  assert.match(drawn, /q=&lt;b&gt;&amp;r=&quot;1&quot;/);
  assert.doesNotMatch(drawn, /q=<b>/);
  assert.match(drawn, /<a class="place-code" href="#network" data-entry="4" data-status-class="error">404/);
  assert.match(drawn, /<span class="url-path">data:image\/png;base64,iVBORw0KGgo=<\/span>/);
  assert.equal(places.find((p) => p.status === 404).url.length, 500);
});

test('data keeps its shape: no entry indexes leak into the data lists', async () => {
  const r = await runIt();
  for (const k of ['uncompressed', 'noCache', 'errors', 'failed']) assert.ok(r.data[k].every((x) => !('entry' in x)), k);
});

test('render: the answer first; no largest or slowest tables (the Network pane sorts by size and time); URLs as parts', async () => {
  const r = await runIt();
  const s = String(plugin.render(r, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<table'), 'stats before the tables');
  assert.match(s, /Requests<\/span><div class="stat-value">8/);
  assert.match(s, /Hosts<\/span><div class="stat-value">2/);
  assert.match(s, /<dt>Protocols<\/dt><dd>h2 100%<\/dd><dt>Redirects<\/dt><dd>2<\/dd>/);
  assert.doesNotMatch(s, /<h4>Largest<\/h4>|<h4>Slowest<\/h4>/);
  assert.match(s, /<h4>By type<\/h4>[^]*<th scope="col">Decoded<\/th>/);
  assert.match(s, /<h4>Redirect chain<\/h4>/);
  assert.match(s, /<h4>HTTP errors<\/h4>[^]*<span class="url" title="https:\/\/s\.test\/api\?q=&lt;b&gt;&amp;r=&quot;1&quot;"><span class="url-host">s\.test<\/span><span class="url-path">\/api<\/span><span class="url-query">\?q=%3Cb%3E/);
  assert.match(s, /<h4>Failed<\/h4>[^]*net::ERR_FAILED/);
  assert.doesNotMatch(s, /NaN|undefined/);
});

test('Hosts stat counts every host, not the 40 kept in data.hosts; older readings fall back to the list', async () => {
  const reading = sample();
  for (let i = 0; i < 45; i++) reading.log.entries.push(entry(`https://h${i}.other.test/x.js`, { type: 'script', mime: 'application/javascript', headers: cached }));
  await runPlugins(reading, [plugin], {});
  const r = reading.log._harplus.plugins.network;
  assert.equal(r.data.hosts.length, 40);
  assert.equal(r.data.totals.hosts, 47);
  assert.match(String(plugin.render(r, h)), /Hosts<\/span><div class="stat-value">47</);
  assert.match(String(plugin.render(r, h)), /<h4>Hosts<\/h4><span class="panel-sub">first 40 of 47<\/span>/, 'the capped host table says it stops short');
  assert.equal(r.summary.find((x) => x.label === 'Hosts').value, '47 (46 third-party)');
  const old = { ...r, data: { ...r.data, totals: { ...r.data.totals, hosts: undefined } } };
  assert.match(String(plugin.render(old, h)), /Hosts<\/span><div class="stat-value">40</);
});

test('glance: third-party hosts say so in words', () => {
  const s = String(plugin.glance({ status: 'ok', data: {
    totals: { requests: 10, bytes: 1000, decoded: 1000, thirdParty: { requests: 4, bytes: 500 } },
    byType: [{ type: 'script', requests: 10, bytes: 1000 }],
    hosts: [{ host: 'a.com', requests: 6, bytes: 500, thirdParty: false }, { host: 'gtm.com', requests: 4, bytes: 500, thirdParty: true }],
  } }, h));
  assert.match(s, /<b>6<\/b>/);
  assert.match(s, /<b>4 · third party<\/b>/);
});

test('headlines read on their own', async () => {
  const r = await runIt();
  const heads = r.summary.filter((x) => x.headline).map((x) => `${x.label} ${x.value}`);
  assert.equal(heads[0], 'Requests 8 (13% third-party)');
  assert.match(heads[1], /^Transferred /);
});

test('capped URL lists say "first N of M" when they stop short; full ones and older readings say nothing', async () => {
  const r = await runIt();
  assert.deepEqual(r.data.counts, { uncompressed: r.data.uncompressed.length, errors: 2, failed: 1 });
  assert.doesNotMatch(String(plugin.render(r, h)), /first \d+ of/);
  const capped = { ...r, data: { ...r.data, counts: { uncompressed: 0, errors: 120, failed: 75 } } };
  const s = String(plugin.render(capped, h));
  assert.match(s, /<h4>HTTP errors<\/h4><span class="panel-sub">first 2 of 120<\/span>/);
  assert.match(s, /<h4>Failed<\/h4><span class="panel-sub">first 1 of 75<\/span>/);
  const old = { ...r, data: { ...r.data, counts: undefined } };
  assert.doesNotMatch(String(plugin.render(old, h)), /first \d+ of/);
});
