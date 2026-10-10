import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarRecorder, computeTimings, parseSetCookies } from '../extension/core/recorder.js';
import { registrableDomain, siteOf, isPrivateIP, redirectChain, mainEntry, serverIPs } from '../extension/core/har-util.js';
import { reverseName, cymruOriginName, txtValue, expandIPv6 } from '../extension/core/doh.js';
import { createReading, ensureHarPlus, indexRecord, makeTarget, toMarkdown, stripForSharing, entriesFromResourceTiming } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';

import { readFileSync } from 'node:fs';
import { getPlugins } from '../extension/plugins/index.js';
import { scoreReading } from '../extension/core/score.js';
import { feedNavigation, W } from './helpers.mjs';

test('recorder builds HAR pages and entries with redirects, headers, cookies, TLS', () => {
  const rec = new HarRecorder();
  feedNavigation(rec);
  rec.setPageTitle('Example Domain');
  const { pages, entries, tls } = rec.build({ dropImplicit: true });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].title, 'Example Domain');
  assert.equal(Math.round(pages[0].pageTimings.onContentLoad), 800);
  assert.equal(Math.round(pages[0].pageTimings.onLoad), 1200);
  assert.equal(entries.length, 3);
  const [redirect, doc, script] = entries;
  assert.equal(redirect.response.status, 301);
  assert.equal(redirect.response.redirectURL, 'https://www.example.com/');
  assert.deepEqual(redirect.request.cookies.map((c) => c.name), ['a', 'b']);
  assert.ok(redirect.response.headersSize > 0);
  assert.equal(doc.response.status, 200);
  assert.equal(doc.serverIPAddress, '93.184.215.14');
  assert.equal(doc.response.httpVersion, 'h2');
  assert.equal(doc.response.content.size, 5000);
  assert.equal(doc.response._transferSize, 1800);
  assert.equal(doc.response.cookies.length, 2);
  assert.deepEqual(doc.response.cookies[0], { name: 'sid', value: 'abc', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
  assert.equal(doc.timings.dns, 10);
  assert.equal(doc.timings.connect, 40);
  assert.equal(doc.timings.ssl, 30);
  assert.equal(doc.timings.wait, 100);
  assert.equal(script._resourceType, 'script');
  assert.equal(script.request.queryString[0].value, 'GTM-1');
  assert.equal(tls['https://www.example.com'].protocol, 'TLS 1.3');
  assert.equal(tls['https://www.example.com'].sanCount, 2);
  for (const e of entries) {
    assert.ok(e.time >= 0);
    for (const k of ['send', 'wait', 'receive']) assert.ok(e.timings[k] >= 0, k);
  }
});

test('recorder drops pre-navigation traffic in reload mode and tracks bodies policy', () => {
  const rec = new HarRecorder({ bodies: 'document' });
  rec.handle('Network.requestWillBeSent', { requestId: 'old', loaderId: 'X', frameId: 'F', type: 'XHR', timestamp: 99, wallTime: W - 1, request: { url: 'https://www.example.com/poll', method: 'GET', headers: {} } });
  feedNavigation(rec);
  const { entries } = rec.build({ dropImplicit: true });
  assert.ok(!entries.some((e) => e.request.url.endsWith('/poll')));
  assert.equal(rec.wantsBody(rec.get('L1')), true);
  assert.equal(rec.wantsBody(rec.get('R2')), false);
});

test('timings fall back without ResourceTiming', () => {
  const t = computeTimings({ wsTs: 1, respTs: 1.25, endTs: 1.5 });
  assert.equal(t.wait, 250);
  assert.equal(t.receive, 250);
});

test('set-cookie parsing', () => {
  const [c] = parseSetCookies(['id=1; Domain=.ex.com; Expires=Wed, 21 Oct 2037 07:28:00 GMT; SameSite=None; Secure; Partitioned']);
  assert.equal(c.domain, '.ex.com');
  assert.equal(c.sameSite, 'None');
  assert.equal(c._partitioned, true);
  assert.match(c.expires, /^2037-10-21/);
});

test('registrable domains', () => {
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('shop.example.com.au'), 'example.com.au');
  assert.equal(registrableDomain('profpowell.github.io'), 'github.io');
  assert.equal(siteOf('profpowell.github.io'), 'profpowell.github.io');
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain('10.0.0.1'), '10.0.0.1');
});

test('ip helpers', () => {
  assert.ok(isPrivateIP('192.168.1.10'));
  assert.ok(isPrivateIP('::1'));
  assert.ok(!isPrivateIP('1.1.1.1'));
  assert.equal(reverseName('1.2.3.4'), '4.3.2.1.in-addr.arpa');
  assert.equal(cymruOriginName('8.8.8.8'), '8.8.8.8.origin.asn.cymru.com');
  assert.equal(expandIPv6('2606:4700::1111'), '2606:4700:0000:0000:0000:0000:0000:1111');
  assert.ok(reverseName('2606:4700::1111').endsWith('.0.0.7.4.6.0.6.2.ip6.arpa'));
  assert.equal(txtValue('"v=spf1 include:_spf.google.com" " ~all"'), 'v=spf1 include:_spf.google.com ~all');
});

test('reading helpers: main entry, redirect chain, markdown, strip', () => {
  const rec = new HarRecorder();
  feedNavigation(rec);
  const built = rec.build({ dropImplicit: true });
  const reading = createReading({ ...built, target: makeTarget('http://www.example.com/', 'Example', 'https://www.example.com/'), screenshots: [{ kind: 'thumbnail', mimeType: 'image/webp', data: 'AA' }, { kind: 'viewport', mimeType: 'image/webp', data: 'BB' }] });
  assert.equal(mainEntry(reading).response.status, 200);
  assert.equal(redirectChain(reading).length, 2);
  assert.equal(serverIPs(reading)[0].main, true);
  assert.equal(reading.log._harplus.target.domain, 'example.com');
  const lite = stripForSharing(reading);
  assert.equal(lite.log._harplus.screenshots.length, 1);
  assert.match(toMarkdown(reading), /^# Example/);
  reading.log._harplus.analysis = 'pending';
  assert.equal(stripForSharing(reading).log._harplus.analysis, 'done');
  assert.equal(reading.log._harplus.analysis, 'pending');
});

test('ensureHarPlus upgrades a plain HAR', () => {
  const rec = new HarRecorder();
  feedNavigation(rec);
  const plain = { log: { version: '1.2', creator: { name: 'WebInspector', version: '537.36' }, ...rec.build({ dropImplicit: true }) } };
  delete plain.log.tls;
  const r = ensureHarPlus(plain, { fileName: 'x.har' });
  assert.equal(r.log._harplus.target.finalUrl, 'https://www.example.com/');
  assert.equal(r.log._harplus.capture.source, 'WebInspector 537.36');
  assert.throws(() => ensureHarPlus({ nope: 1 }));
});

test('resource timing → synthetic entries', () => {
  const entries = entriesFromResourceTiming([
    { name: 'https://a.com/', initiatorType: 'navigation', startTime: 0, duration: 300, transferSize: 5000, encodedBodySize: 4700, decodedBodySize: 12000, nextHopProtocol: 'h2', responseStatus: 200, fetchStart: 1, domainLookupStart: 2, domainLookupEnd: 10, connectStart: 10, connectEnd: 40, secureConnectionStart: 20, requestStart: 41, responseStart: 140, responseEnd: 300 },
    { name: 'https://a.com/app.css', initiatorType: 'link', startTime: 150, duration: 50, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 },
  ], { timeOrigin: Date.UTC(2026, 0, 1) });
  assert.equal(entries[0]._resourceType, 'document');
  assert.equal(entries[1]._resourceType, 'stylesheet');
  assert.equal(entries[0].timings.wait, 99);
});

test('plugin host: phases, dependencies, skip, error, timeout, probes', async () => {
  const reading = createReading({ target: makeTarget('https://x.com/') });
  const order = [];
  const plugins = [
    { id: 'b', name: 'B', phase: 'analyze', after: ['a'], run: (r, ctx) => { order.push('b'); return { summary: [{ label: 'saw a', value: ctx.results.a.data.v }] }; } },
    { id: 'a', name: 'A', phase: 'analyze', run: () => { order.push('a'); return { data: { v: 42 }, findings: [{ severity: 'bogus', title: 'x' }] }; } },
    { id: 's', name: 'S', phase: 'analyze', run: (r, ctx) => ctx.skip('nope') },
    { id: 'e', name: 'E', phase: 'analyze', run: () => { throw new Error('boom'); } },
    { id: 't', name: 'T', phase: 'enrich', timeoutMs: 50, run: () => new Promise(() => {}) },
    { id: 'off', name: 'Off', phase: 'analyze', defaultEnabled: false, run: () => ({}) },
    { id: 'p', name: 'P', phase: 'page', run: () => ({}) },
    { id: 'pr', name: 'Probe', phase: 'analyze', probe: { collect: () => 1 }, run: (r, ctx) => ({ data: { probe: ctx.probe ?? null } }) },
  ];
  await runPlugins(reading, plugins, { phases: ['analyze', 'enrich'] });
  const res = reading.log._harplus.plugins;
  assert.deepEqual(order.slice(0, 2), ['a', 'b']);
  assert.equal(res.b.summary[0].value, '42');
  assert.equal(res.a.findings[0].severity, 'info');
  assert.equal(res.s.status, 'skipped');
  assert.equal(res.e.status, 'error');
  assert.match(res.t.error, /timed out/);
  assert.equal(res.off, undefined);
  assert.equal(res.p, undefined);
  assert.equal(res.pr.data.probe, null);

  const live = createReading({ target: makeTarget('https://x.com/') });
  await runPlugins(live, plugins, { phases: ['page', 'analyze'], evaluate: async (fn) => fn() });
  assert.equal(live.log._harplus.probes.pr, 1);
  assert.equal(live.log._harplus.plugins.pr.data.probe, 1);
  assert.equal(live.log._harplus.plugins.p.status, 'ok');
});

test('cross-site iframe document finishing in the child session closes the parent record', () => {
  const rec = new HarRecorder();
  feedNavigation(rec);
  rec.handle('Network.requestWillBeSent', { requestId: 'FR', loaderId: 'FR', frameId: 'CHILD', type: 'Document', timestamp: 101, wallTime: W + 1, request: { url: 'https://other.test/frame.html', method: 'GET', headers: {} } });
  rec.handle('Network.responseReceived', { requestId: 'FR', type: 'Document', timestamp: 101.1, response: { url: 'https://other.test/frame.html', status: 200, headers: {}, mimeType: 'text/html' } });
  rec.handle('Network.dataReceived', { requestId: 'FR', dataLength: 300, encodedDataLength: 300 }, 'S1');
  rec.handle('Network.loadingFinished', { requestId: 'FR', timestamp: 101.2, encodedDataLength: 420 }, 'S1');
  assert.equal(rec.inflight.size, 0);
  const frame = rec.build().entries.find((e) => e.request.url.endsWith('frame.html'));
  assert.equal(frame._incomplete, undefined);
  assert.equal(frame.response.content.size, 300);
});

test('ExtraInfo skips cached and internal redirect hops', () => {
  const rec = new HarRecorder();
  rec.mainFrameId = 'F';
  const ev = (m, p) => rec.handle(m, p);
  ev('Network.requestWillBeSent', { requestId: 'N', loaderId: 'N', frameId: 'F', type: 'Document', timestamp: 1, wallTime: W, request: { url: 'http://a.test/', method: 'GET', headers: {} } });
  // HSTS internal redirect (no ExtraInfo), then a disk-cached 301 (no ExtraInfo), then the network 200
  ev('Network.requestWillBeSent', { requestId: 'N', loaderId: 'N', frameId: 'F', type: 'Document', timestamp: 1.01, wallTime: W, request: { url: 'https://a.test/', method: 'GET', headers: {} },
    redirectResponse: { url: 'http://a.test/', status: 307, statusText: 'Internal Redirect', headers: { Location: 'https://a.test/', 'Non-Authoritative-Reason': 'HSTS' }, mimeType: '' } });
  ev('Network.requestWillBeSent', { requestId: 'N', loaderId: 'N', frameId: 'F', type: 'Document', timestamp: 1.02, wallTime: W, request: { url: 'https://www.a.test/', method: 'GET', headers: {} },
    redirectResponse: { url: 'https://a.test/', status: 301, headers: { location: 'https://www.a.test/' }, mimeType: '', fromDiskCache: true } });
  ev('Network.requestWillBeSentExtraInfo', { requestId: 'N', headers: { cookie: 'x=1' } });
  ev('Network.responseReceivedExtraInfo', { requestId: 'N', statusCode: 200, headers: { 'set-cookie': 'fin=1; Secure' } });
  ev('Network.responseReceived', { requestId: 'N', type: 'Document', timestamp: 1.1, response: { url: 'https://www.a.test/', status: 200, headers: {}, mimeType: 'text/html' } });
  ev('Network.loadingFinished', { requestId: 'N', timestamp: 1.2, encodedDataLength: 10 });
  const [hsts, cached, final] = rec.build().entries;
  assert.equal(hsts.response.status, 307);
  assert.equal(cached.response.redirectURL, 'https://www.a.test/');
  assert.equal(cached.response.cookies.length, 0);
  assert.equal(final.response.cookies[0].name, 'fin');
  assert.equal(final.request.cookies[0].name, 'x');
});

test('dropping a child session clears its in-flight requests', () => {
  const rec = new HarRecorder();
  feedNavigation(rec);
  rec.handle('Network.requestWillBeSent', { requestId: 'W1', frameId: 'X', type: 'Fetch', timestamp: 102, wallTime: W + 2, request: { url: 'https://w.test/poll', method: 'GET', headers: {} } }, 'S9');
  assert.equal(rec.inflight.size, 1);
  rec.dropSession('S9');
  assert.equal(rec.inflight.size, 0);
});

test('a redirect to an extension stub keeps the redirect hop and ignores the stub', () => {
  const rec = new HarRecorder();
  feedNavigation(rec);
  const ev = (m, p) => rec.handle(m, p);
  const gtm = 'https://stub-me.test/tag.js';
  ev('Network.requestWillBeSent', { requestId: 'B', frameId: 'F', type: 'Script', timestamp: 103, wallTime: W + 3, request: { url: gtm, method: 'GET', headers: {} } });
  ev('Network.requestWillBeSent', { requestId: 'B', frameId: 'F', type: 'Script', timestamp: 103.01, wallTime: W + 3, request: { url: 'chrome-extension://abc/web_accessible_resources/googletagmanager_gtm.js', method: 'GET', headers: {} },
    redirectResponse: { url: gtm, status: 307, statusText: 'Internal Redirect', headers: { Location: 'chrome-extension://abc/x.js' }, mimeType: '' } });
  ev('Network.responseReceived', { requestId: 'B', type: 'Script', timestamp: 103.02, response: { url: 'chrome-extension://abc/x.js', status: 200, headers: {}, mimeType: 'text/javascript' } });
  const done = ev('Network.loadingFinished', { requestId: 'B', timestamp: 103.03, encodedDataLength: 0 });
  assert.equal(done, undefined, 'no body fetch for the stub');
  const entries = rec.build().entries.filter((e) => e.request.url.includes('stub-me') || e.request.url.startsWith('chrome-extension'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].response.status, 307);
  assert.ok(![...rec.inflight].some((k) => k.endsWith('|B')));
});

test('summaryValue shows ratings; plugin host keeps rating/headline and stamps area', async () => {
  const { summaryValue } = await import('../extension/core/harplus.js');
  assert.equal(summaryValue({ label: 'LCP', value: '3.1 s', rating: 'needs-improvement' }), '3.1 s (needs improvement)');
  assert.equal(summaryValue({ label: 'x', value: 'y' }), 'y');
  const { runPlugins } = await import('../extension/core/plugin-host.js');
  const r = { log: { entries: [], pages: [], _harplus: { plugins: {}, target: {}, capture: {} } } };
  const p = { id: 'p1', name: 'P1', phase: 'analyze', group: 'security', run: () => ({ summary: [
    { label: 'A', value: '1', rating: 'Needs Improvement', headline: true }, { label: 'B', value: '2', rating: 'bogus' },
  ] }) };
  await runPlugins(r, [p], { phases: ['analyze'] });
  const res = r.log._harplus.plugins.p1;
  assert.equal(res.area, 'security');
  assert.deepEqual(res.summary, [{ label: 'A', value: '1', rating: 'needs-improvement', headline: true }, { label: 'B', value: '2' }]);
});

test('indexRecord score matches the report score when given plugins', () => {
  const r = JSON.parse(readFileSync(new URL('./fixtures/local-site.har', import.meta.url), 'utf8'));
  assert.equal(indexRecord(r, getPlugins()).score, scoreReading(r, getPlugins()).overall.score);
});

test('indexRecord marks pending analysis; old readings are not pending', async () => {
  const { indexRecord } = await import('../extension/core/harplus.js');
  const r = { log: { entries: [], _harplus: { id: 'x', target: {}, capture: {}, screenshots: [], plugins: {}, analysis: 'pending' } } };
  assert.equal(indexRecord(r).pending, true);
  r.log._harplus.analysis = 'done';
  assert.equal(indexRecord(r).pending, false);
  delete r.log._harplus.analysis;
  assert.equal(indexRecord(r).pending, false);
});
