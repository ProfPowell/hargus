import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASES, phaseSegments, niceTicks, pageMarkers, timelineModel, sortRows, midTrunc, protocolName, requestedBy, originFact, sizeFact, cacheFact, requestFacts, wireText, RB_CAP } from '../extension/ui/waterfall.js';

const T = (o) => ({ blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 0, receive: 0, ...o });
const entry = (o = {}) => ({
  startedDateTime: '2026-10-19T10:00:00.000Z', time: 100,
  request: { method: 'GET', url: 'https://a.test/x', headers: [] },
  response: { status: 200, headers: [], content: { size: 0 } },
  timings: T({ wait: 80, receive: 20 }), ...o,
});
const reading = (entries, extra = {}) => ({ log: { pages: [{ startedDateTime: '2026-10-19T10:00:00.000Z', pageTimings: { onContentLoad: 400, onLoad: 900 } }], entries, _harplus: { plugins: {} }, ...extra } });

test('phases are in HAR order with readable labels', () => {
  assert.deepEqual(PHASES.map((p) => p.key), ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive']);
  assert.equal(PHASES.find((p) => p.key === 'wait').label, 'Waiting (TTFB)');
});

test('phaseSegments drops -1 and zero phases and draws connect without TLS', () => {
  const r = phaseSegments(T({ blocked: 4, dns: 20, connect: 90, ssl: 40, send: 0.5, wait: 150, receive: 46 }), 350);
  assert.deepEqual(r.segments, [{ key: 'blocked', ms: 4 }, { key: 'dns', ms: 20 }, { key: 'connect', ms: 50 }, { key: 'ssl', ms: 40 }, { key: 'send', ms: 0.5 }, { key: 'wait', ms: 150 }, { key: 'receive', ms: 46 }]);
  assert.equal(r.known, true);
});

test('phaseSegments: no timing when time is 0, negative, missing, or no phase is known', () => {
  assert.equal(phaseSegments(T({ wait: 5 }), 0).known, false);
  assert.equal(phaseSegments(T({ wait: 5 }), -1).known, false);
  assert.equal(phaseSegments(T({ wait: 5 }), undefined).known, false);
  assert.equal(phaseSegments(T(), 50).known, false);
  assert.deepEqual(phaseSegments(undefined, 50), { segments: [], known: false });
});

test('niceTicks: 1/2/2.5/5 x 10^n steps, four or five ticks', () => {
  assert.deepEqual(niceTicks(37), [0, 10, 20, 30]);
  assert.deepEqual(niceTicks(960), [0, 200, 400, 600, 800]);
  assert.deepEqual(niceTicks(12400), [0, 2500, 5000, 7500, 10000]);
  assert.deepEqual(niceTicks(0), [0]);
  assert.deepEqual(niceTicks(NaN), [0]);
});

test('pageMarkers: DOMContentLoaded and load from page timings, FCP and LCP from vitals, sorted, absent ones dropped', () => {
  const r = reading([entry()]);
  r.log._harplus.plugins.vitals = { data: { fcp: 300, lcp: { time: 650 } } };
  assert.deepEqual(pageMarkers(r).map((m) => [m.key, m.ms]), [['fcp', 300], ['dcl', 400], ['lcp', 650], ['load', 900]]);
  r.log.pages[0].pageTimings = { onContentLoad: -1 };
  r.log._harplus.plugins.vitals = { data: { fcp: null, lcp: null } };
  assert.deepEqual(pageMarkers(r), []);
});

test('timelineModel: bars as percentages of a span that also fits the markers', () => {
  const r = reading([entry(), entry({ startedDateTime: '2026-10-19T10:00:00.200Z', time: 300 })]);
  const m = timelineModel(r);
  assert.equal(m.span, 900, 'the load marker widens the span past the last request end (500)');
  assert.deepEqual([m.bars[1].left, m.bars[1].width, m.bars[1].start], [22.22, 33.33, 200]);
  assert.equal(m.markers.find((x) => x.key === 'load').left, 100);
  assert.deepEqual(m.ticks.map((t) => t.ms), [0, 200, 400, 600, 800]);
});

test('timelineModel: a bad date sits at 0 with no timing, never NaN', () => {
  const m = timelineModel(reading([entry(), entry({ startedDateTime: 'garbage' })]));
  assert.deepEqual([m.bars[1].start, m.bars[1].left, m.bars[1].width, m.bars[1].known], [null, 0, 0, false]);
  for (const b of m.bars) assert.ok(Number.isFinite(b.left) && Number.isFinite(b.width), JSON.stringify(b));
  for (const x of [...m.ticks, ...m.markers]) assert.ok(Number.isFinite(x.left), JSON.stringify(x));
  assert.ok(Number.isFinite(m.span) && Number.isFinite(m.t0));
});

test('timelineModel without pages (Review Focus 1): t0 is the first request, no page markers', () => {
  const r = reading([entry({ startedDateTime: '2026-10-19T10:00:01.000Z' }), entry({ startedDateTime: '2026-10-19T10:00:01.500Z' })]);
  delete r.log.pages;
  const m = timelineModel(r);
  assert.equal(m.t0, Date.parse('2026-10-19T10:00:01.000Z'));
  assert.deepEqual(m.markers, []);
  assert.deepEqual([m.bars[0].left, m.bars[1].start], [0, 500]);
});

test('timelineModel: an entry earlier than the page start moves t0 back and shifts the markers with it', () => {
  const r = reading([entry({ startedDateTime: '2026-10-19T09:59:59.900Z' })]);
  const m = timelineModel(r);
  assert.equal(m.bars[0].start, 0);
  assert.equal(m.markers.find((x) => x.key === 'dcl').at, 500, 'page-relative 400 ms + 100 ms offset');
});

test('sortRows: every key, both directions, stable on ties', () => {
  const rows = [
    { i: 0, e: entry({ request: { url: 'https://a.test/b', headers: [] }, response: { status: 404, headers: [], content: {}, _transferSize: 10 }, time: 50, _resourceType: 'script' }) },
    { i: 1, e: entry({ request: { url: 'https://a.test/a', headers: [] }, response: { status: 200, headers: [], content: {}, _transferSize: 30 }, time: 10, _resourceType: 'image' }) },
    { i: 2, e: entry({ request: { url: 'https://a.test/c', headers: [] }, response: { status: 200, headers: [], content: {}, _transferSize: 30 }, time: -1, _resourceType: 'document', _error: 'net::ERR_FAILED' }) },
  ];
  const order = (k, d) => sortRows(rows, k, d).map((r) => r.i);
  assert.deepEqual(order('index', 'asc'), [0, 1, 2]);
  assert.deepEqual(order('index', 'desc'), [2, 1, 0]);
  assert.deepEqual(order('status', 'asc'), [2, 1, 0], 'an error sorts below every status');
  assert.deepEqual(order('name', 'asc'), [1, 0, 2]);
  assert.deepEqual(order('type', 'asc'), [2, 1, 0]);
  assert.deepEqual(order('size', 'asc'), [0, 1, 2], 'ties keep capture order');
  assert.deepEqual(order('size', 'desc'), [1, 2, 0], 'ties keep capture order in descending too');
  assert.deepEqual(order('time', 'asc'), [2, 1, 0]);
  assert.deepEqual(order('start', 'asc'), [0, 1, 2]);
  assert.notEqual(sortRows(rows, 'index', 'asc'), rows, 'a new array');
});

test('midTrunc keeps the start and end of long names', () => {
  assert.equal(midTrunc('short'), 'short');
  const s = midTrunc('www.googletagmanager.com/gtm.js?id=GTM-ABCDEFG&l=dataLayer&cx=c&gtm=45He', 40);
  assert.equal(s.length, 40);
  assert.match(s, /^www\.googletagmanager\.com.*…/);
  assert.match(s, /gtm=45He$/);
});

const hdr = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));

test('protocolName normalises HAR httpVersion values', () => {
  assert.equal(protocolName('h2'), 'HTTP/2');
  assert.equal(protocolName('http/1.1'), 'HTTP/1.1');
  assert.equal(protocolName('HTTP/2.0'), 'HTTP/2');
  assert.equal(protocolName('h3'), 'HTTP/3');
  assert.equal(protocolName(''), '');
});

test('requestedBy: one sentence per initiator type, 1-based line numbers', () => {
  const e = (initiator, _resourceType) => entry({ _initiator: initiator, _resourceType });
  assert.equal(requestedBy(e({ type: 'parser', url: 'https://a.test/', lineNumber: 23 }, 'stylesheet')), 'a <link rel="stylesheet"> in the page\'s HTML (https://a.test/, line 24)');
  assert.equal(requestedBy(e({ type: 'parser', lineNumber: 4 }, 'image')), 'an <img> in the page\'s HTML (line 5)');
  assert.equal(requestedBy(e({ type: 'parser' }, 'script')), 'a <script> in the page\'s HTML');
  assert.equal(requestedBy(e({ type: 'script', url: 'https://a.test/app.js', lineNumber: 119 }, 'fetch')), 'a script (https://a.test/app.js, line 120)');
  assert.equal(requestedBy(e({ type: 'redirect', url: 'http://a.test/' })), 'a redirect from http://a.test/');
  assert.equal(requestedBy(e({ type: 'preload' })), 'a preload');
  assert.equal(requestedBy(e({ type: 'other' })), 'the browser (other)');
  assert.equal(requestedBy(entry()), '');
});

test('originFact: same origin, same site, third party', () => {
  assert.equal(originFact('https://a.test/x', 'https://a.test/', 'a.test'), 'same origin as the page');
  assert.equal(originFact('https://cdn.a.test/x', 'https://a.test/', 'a.test'), 'same site, other origin');
  assert.equal(originFact('https://b.test/x', 'https://a.test/', 'a.test'), 'third-party (b.test)');
  assert.equal(originFact('not a url', 'https://a.test/', 'a.test'), '');
});

test('sizeFact: wire vs decoded, with the compression saving only when it applies', () => {
  const br = entry({ response: { status: 200, headers: hdr({ 'content-encoding': 'br' }), content: { size: 98304 }, _transferSize: 21914 } });
  assert.equal(sizeFact(br), '21.4 KB on the wire · 96.0 KB decoded (brotli, 78% smaller)');
  const plain = entry({ response: { status: 200, headers: [], content: { size: 500 }, _transferSize: 700 } });
  assert.equal(sizeFact(plain), '700 B on the wire · 500 B decoded');
  const none = entry({ response: { status: 200, headers: [], content: {}, _transferSize: 0 } });
  assert.equal(sizeFact(none), '0 B on the wire');
});

test('cacheFact: source then cache-control with a readable max-age', () => {
  assert.equal(cacheFact(entry()), 'fetched over the network');
  assert.equal(cacheFact(entry({ _fromCache: 'disk', response: { status: 200, headers: hdr({ 'cache-control': 'public, max-age=3600' }), content: {} } })), 'from disk cache · public, max-age=3600 (fresh for 1 h)');
  assert.equal(cacheFact(entry({ _fromCache: 'memory' })), 'from memory cache');
  assert.equal(cacheFact(entry({ response: { status: 200, headers: hdr({ 'cache-control': 'max-age=0, must-revalidate' }), content: {} } })), 'fetched over the network · max-age=0, must-revalidate (revalidated every time)');
  assert.equal(cacheFact(entry({ response: { status: 200, headers: hdr({ 'cache-control': 'max-age=604800' }), content: {} } })), 'fetched over the network · max-age=604800 (fresh for 7 days)');
});

test('requestFacts: ordered lines, reused connection, render blocking, missing data drops the line', () => {
  const first = entry({ connection: '7' });
  const e = entry({ connection: '7', _priority: 'VeryHigh', _initiator: { type: 'other' }, response: { status: 200, statusText: '', httpVersion: 'h2', headers: [], content: {}, _transferSize: 100 } });
  const facts = requestFacts(e, { entries: [first, e], index: 1, pageUrl: 'https://a.test/', site: 'a.test', renderBlocking: ['https://a.test/x'], start: 320 });
  assert.deepEqual(facts.map(([k]) => k), ['URL', 'Requested by', 'Origin', 'Protocol', 'Status', 'Size', 'Cache', 'Render blocking', 'Timing']);
  const f = Object.fromEntries(facts);
  assert.equal(f.Protocol, 'HTTP/2 · priority VeryHigh · reused connection');
  assert.equal(f.Status, '200 OK');
  assert.equal(f['Render blocking'], 'yes');
  assert.equal(f.Timing, 'starts at 320 ms, takes 100 ms');
  const bare = Object.fromEntries(requestFacts(entry({ time: -1, response: { status: 0, headers: [], content: {} }, _error: 'net::ERR_BLOCKED_BY_CLIENT' }), {}));
  assert.equal(bare['Render blocking'], undefined, 'no list → unknown → no line');
  assert.equal(bare.Timing, undefined);
  assert.equal(bare.Status, undefined);
  assert.equal(bare.Error, 'net::ERR_BLOCKED_BY_CLIENT');
  const full = Array.from({ length: RB_CAP }, (_, k) => `https://a.test/${k}.css`);
  assert.equal(Object.fromEntries(requestFacts(entry(), { renderBlocking: full }))['Render blocking'], undefined, 'a full list that lacks the URL is unknown, not "no"');
  assert.equal(Object.fromEntries(requestFacts(entry(), { renderBlocking: [] }))['Render blocking'], 'no');
  assert.doesNotMatch(JSON.stringify(requestFacts(entry({ startedDateTime: 'x', timings: undefined }), {})), /NaN|undefined/);
});

const text = (lines) => lines.map((l) => l.text).join('\n');

test('wireText: request and status lines, Host added, HTTP/2 pseudo-headers dropped', () => {
  const e = entry({
    request: { method: 'GET', url: 'https://a.test/css/main.css?v=2', httpVersion: 'h2', headers: hdr({ ':authority': 'a.test', accept: 'text/css' }) },
    response: { status: 200, statusText: '', httpVersion: 'h2', headers: hdr({ 'content-type': 'text/css' }), content: { size: 12, text: 'body{margin:0}' } },
  });
  const w = wireText(e);
  assert.equal(text(w.request), 'GET /css/main.css?v=2 HTTP/2\nHost: a.test\naccept: text/css');
  assert.equal(text(w.response), 'HTTP/2 200 OK\ncontent-type: text/css\n\nbody{margin:0}');
  assert.equal(w.request[2].kind, 'header');
  assert.equal(w.request[2].name, 'accept');
});

test('wireText trims headers and bodies, labels binary, handles failures (Review Focus 4)', () => {
  const many = Object.fromEntries(Array.from({ length: 15 }, (_, k) => [`x-h${k}`, String(k)]));
  const e = entry({
    request: { method: 'POST', url: 'https://a.test/api', httpVersion: 'http/1.1', headers: hdr({ host: 'a.test', ...many }), postData: { mimeType: 'text/plain', text: 'a'.repeat(5000) } },
    response: { status: 200, statusText: 'OK', httpVersion: 'http/1.1', headers: [], content: { size: 2048, encoding: 'base64', text: 'iVBORw0KGgo=' } },
  });
  const w = wireText(e);
  const req = text(w.request);
  assert.match(req, /^POST \/api HTTP\/1\.1\nhost: a\.test/);
  assert.match(req, /…4 more headers/, '16 headers → 12 shown');
  assert.match(req, /\n\na{2000}\n…3000 more characters$/);
  assert.equal(text(w.response), 'HTTP/1.1 200 OK\n\n[binary body, 2.0 KB]');
  const failed = wireText(entry({ response: { status: 0, headers: [], content: {} }, _error: 'net::ERR_NAME_NOT_RESOLVED' }));
  assert.equal(text(failed.response), '(no response — net::ERR_NAME_NOT_RESOLVED)');
  const uncaptured = wireText(entry({ response: { status: 204, headers: [], content: { size: 300 } } }));
  assert.equal(text(uncaptured.response), 'HTTP/1.1 204 No Content\n\n[body not captured, 300 B]');
});
