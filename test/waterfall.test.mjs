import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASES, phaseSegments, niceTicks, pageMarkers, timelineModel, sortRows, midTrunc } from '../extension/ui/waterfall.js';

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
