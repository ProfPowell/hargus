# Network Waterfall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the reading report's Network pane as a real waterfall. Bars are split into phases, with a ruler, page-event markers and a legend. Columns are sortable, a "Show more" button replaces the silent cap, and rows expand in place into tabbed detail (Overview facts, Timing, Headers, Wire format, Body).

**Architecture:**
- `extension/ui/waterfall.js` holds pure data functions with no DOM: the timeline model, phase segments, ticks, markers, sorting, plain-English facts and wire text.
- `extension/ui/report.js` turns that model into `html` markup: `networkTable` and the new `requestDetail`.
- `extension/ui/reading.js` wires the interaction: sort, show more, expand and collapse, tabs and keys. It drops the modal it used for network entries.

**Tech Stack:** Vanilla ES modules (MV3 extension pages), the `html` tagged templates from `extension/ui/html.js`, CSS `@layer` with `light-dark()` tokens, `node --test`, and Playwright e2e (`npm run test:e2e`).

**Spec:** `docs/superpowers/specs/2026-10-19-network-waterfall-design.md`

**Next batch (not in this plan):** critical-path highlighting, grouping by third-party domain, and timeline zoom and scroll.

## Global Constraints

- No new runtime dependency. The report is built from `html` tagged-template strings (`extension/ui/report.js`). Event wiring stays in `extension/ui/reading.js`.
- **Pure logic:** bar geometry, ruler ticks, marker placement, facts wording, wire text and sorting go in `extension/ui/waterfall.js`. It has no DOM access and is unit-tested with `node --test`.
- **Colours:** all colours come from tokens in `extension/ui/theme.css` and work in light and dark (`light-dark()`). The phase tokens are `--ph-blocked`, `--ph-dns`, `--ph-connect`, `--ph-ssl`, `--ph-send`, `--ph-wait` and `--ph-receive`. Each has a pastel fill and a darker outline.
- **Safe output:** the rendered report never contains `NaN`, `undefined` or `Infinity`, whatever the HAR holds (bad dates, −1 timings, missing fields).
- **Stored readings are unchanged.** HAR entries keep their shape. The only change to stored data is that the vitals plugin's existing `data.renderBlocking` cap rises from 30 to 200.
- **Accessibility:**
  - Colour is never the only signal: the legend has words, status chips show the number, and the phases are in the tooltip and the Timing tab.
  - Rows (through their disclosure button) and tabs work from the keyboard.
  - Animation respects `prefers-reduced-motion`.
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Running tests:** run `npm test` and `npm run test:e2e` from the repository or worktree root. `npm --prefix` cannot find the global Playwright.

## Review Focus

1. **A HAR with no `pages` array** (imported from another tool): t0 falls back to the earliest request. The DOMContentLoaded and load markers are absent, with no error. Pinned in Task 1.
2. **A HAR with zero entries:** the pane still says "No requests recorded." and renders no legend or ruler. Pinned in Task 3.
3. **The open row is filtered out or sorted away:** re-rendering never leaves a detail row orphaned. It closes when the row disappears, and returns when the row is shown again. Pinned in Task 4.
4. **Huge or binary bodies:** the Wire tab trims a 5,000-character request body and labels a base64 response as binary, never dumping it. Pinned in Task 2.
5. **The standalone HTML export** (no JavaScript): it shows every row, with no dead "Show more" button and no expansion. Pinned in Task 3.

---

## File structure

| File | Responsibility |
|---|---|
| `extension/ui/waterfall.js` (new) | Pure model: `PHASES`, `MARKERS`, `phaseSegments`, `niceTicks`, `pageMarkers`, `timelineModel`, `sortRows`, `midTrunc` (Task 1); `protocolName`, `requestedBy`, `originFact`, `sizeFact`, `cacheFact`, `requestFacts`, `wireText`, `RB_CAP` (Task 2) |
| `test/waterfall.test.mjs` (new) | Unit tests for waterfall.js |
| `extension/plugins/vitals.js` | `renderBlocking` cap 30 → 200 (Task 2) |
| `extension/ui/report.js` | `networkTable` rewritten, `requestDetail` added, `networkPane` takes `interactive` (Task 3) |
| `extension/ui/theme.css` | Phase tokens, waterfall, legend, chip, detail, tab and wire styles, plus print and standalone rules (Task 3) |
| `test/report.test.mjs` | Report tests (Task 3) |
| `extension/ui/reading.js` | State, sort, show more, inline expand, tabs and keys; removes `entryDetail` and the network dialog (Task 4) |
| `test/e2e/run.mjs` | Network pane e2e (Task 4) |

---

### Task 1: Waterfall model (pure)

**Files:**
- Create: `extension/ui/waterfall.js`
- Test: `test/waterfall.test.mjs`

**Interfaces:**
- Consumes: from `extension/core/har-util.js`: `transferSize(entry) → number`, `resourceType(entry) → string`.
- Produces:
  - `PHASES: Array<{key: 'blocked'|'dns'|'connect'|'ssl'|'send'|'wait'|'receive', label: string}>`
  - `MARKERS: Array<{key: 'fcp'|'dcl'|'lcp'|'load', label: string}>`
  - `phaseSegments(timings, time) → { segments: Array<{key, ms}>, known: boolean }`
  - `niceTicks(span) → number[]`
  - `pageMarkers(reading) → Array<{key, label, ms}>`, sorted by `ms`
  - `timelineModel(reading) → { t0, span, ticks: Array<{ms, left}>, markers: Array<{key, label, ms, at, left}>, bars: Array<{start: number|null, left, width, segments, known}> }`. `left` and `width` are percentages from 0 to 100, rounded to 2 decimals. `bars[i]` is for `reading.log.entries[i]`.
  - `sortRows(rows: Array<{e, i}>, key: 'index'|'status'|'type'|'name'|'size'|'time'|'start', dir: 'asc'|'desc') → rows` (a new array, stable)
  - `midTrunc(s, max = 64) → string`

- [ ] **Step 1: Write the failing tests**

Create `test/waterfall.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/waterfall.test.mjs`
Expected: FAIL with `Cannot find module '…/extension/ui/waterfall.js'`.

- [ ] **Step 3: Write the implementation**

Create `extension/ui/waterfall.js`:

```js
// Network waterfall model: pure functions over a reading — the timeline (bars, phases, ticks, page markers),
// sorting and, from Task 2, the plain-English facts and wire text of one request. No DOM: report.js renders it.

import { transferSize, resourceType } from '../core/har-util.js';

export const PHASES = [
  { key: 'blocked', label: 'Queued' },
  { key: 'dns', label: 'DNS' },
  { key: 'connect', label: 'Connect' },
  { key: 'ssl', label: 'TLS' },
  { key: 'send', label: 'Send' },
  { key: 'wait', label: 'Waiting (TTFB)' },
  { key: 'receive', label: 'Download' },
];

export const MARKERS = [
  { key: 'fcp', label: 'FCP' },
  { key: 'dcl', label: 'DOMContentLoaded' },
  { key: 'lcp', label: 'LCP' },
  { key: 'load', label: 'Load' },
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const round2 = (x) => Math.round(x * 100) / 100;

/** The bar's segments in HAR order. -1/missing/zero phases are dropped; HAR's connect includes ssl, so it is drawn without it. */
export function phaseSegments(timings, time) {
  const t = timings || {};
  const ssl = num(t.ssl);
  const segments = [];
  for (const { key } of PHASES) {
    let ms = num(t[key]);
    if (key === 'connect' && ssl > 0 && ms >= ssl) ms -= ssl;
    if (ms > 0) segments.push({ key, ms: Math.round(ms * 1000) / 1000 });
  }
  return { segments, known: num(time) > 0 && segments.length > 0 };
}

/** Round ruler ticks: a 1, 2, 2.5 or 5 × 10^n step giving four or five ticks from 0 up to the span. */
export function niceTicks(span) {
  if (!(span > 0)) return [0];
  const raw = span / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const out = [];
  for (let k = 0; k * step <= span + 1e-9; k++) out.push(Math.round(k * step * 1000) / 1000);
  return out;
}

/** Page events in ms from the page start: DOMContentLoaded and load from the HAR page, FCP and LCP from the vitals plugin. */
export function pageMarkers(reading) {
  const pt = reading?.log?.pages?.[0]?.pageTimings || {};
  const v = reading?.log?._harplus?.plugins?.vitals?.data || {};
  const at = { dcl: num(pt.onContentLoad), load: num(pt.onLoad), fcp: num(v.fcp), lcp: num(v.lcp?.time) };
  return MARKERS.filter((m) => at[m.key] > 0).map((m) => ({ ...m, ms: at[m.key] })).sort((a, b) => a.ms - b.ms);
}

/** Everything the waterfall draws, as percentages of one span (the last request end or the last marker, whichever is later). */
export function timelineModel(reading) {
  const log = reading?.log || {};
  const entries = log.entries || [];
  const starts = entries.map((e) => Date.parse(e.startedDateTime));
  const pageStart = Date.parse(log.pages?.[0]?.startedDateTime);
  let t0 = Number.isFinite(pageStart) ? pageStart : Infinity;
  for (const s of starts) if (Number.isFinite(s) && s < t0) t0 = s;
  if (!Number.isFinite(t0)) t0 = 0;
  const pageOffset = Number.isFinite(pageStart) ? pageStart - t0 : 0;
  const markers = pageMarkers(reading).map((m) => ({ ...m, at: m.ms + pageOffset }));
  const rel = starts.map((s) => (Number.isFinite(s) ? Math.max(0, s - t0) : NaN));
  let span = 0;
  entries.forEach((e, i) => { if (Number.isFinite(rel[i])) span = Math.max(span, rel[i] + Math.max(0, num(e.time) || 0)); });
  for (const m of markers) span = Math.max(span, m.at);
  span = Math.max(1, span);
  const pct = (ms) => round2(Math.max(0, Math.min(100, (ms / span) * 100)));
  const bars = entries.map((e, i) => {
    const { segments, known } = phaseSegments(e.timings, e.time);
    const ok = Number.isFinite(rel[i]);
    return { start: ok ? rel[i] : null, left: ok ? pct(rel[i]) : 0, width: known && ok ? pct(e.time) : 0, segments, known: known && ok };
  });
  return {
    t0, span,
    ticks: niceTicks(span).map((ms) => ({ ms, left: pct(ms) })),
    markers: markers.map((m) => ({ ...m, left: pct(m.at) })),
    bars,
  };
}

const SORT_KEYS = {
  index: ({ i }) => i,
  status: ({ e }) => (e._error ? -1 : num(e.response?.status) || 0),
  type: ({ e }) => resourceType(e),
  name: ({ e }) => e.request?.url || '',
  size: ({ e }) => transferSize(e),
  time: ({ e }) => (num(e.time) >= 0 ? e.time : -1),
  start: ({ e }) => { const s = Date.parse(e.startedDateTime); return Number.isFinite(s) ? s : Infinity; },
};

/** Rows ({e, i}) sorted by a column; ties keep capture order in both directions. */
export function sortRows(rows, key = 'index', dir = 'asc') {
  const f = SORT_KEYS[key] || SORT_KEYS.index;
  const sign = dir === 'desc' ? -1 : 1;
  return rows.map((r) => ({ r, k: f(r) })).sort((a, b) => {
    const c = typeof a.k === 'string' ? a.k.localeCompare(b.k) : a.k - b.k;
    return c ? sign * c : a.r.i - b.r.i;
  }).map((x) => x.r);
}

/** Shorten from the middle so both the host and the end of the path stay readable. */
export function midTrunc(s, max = 64) {
  s = String(s ?? '');
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/waterfall.test.mjs`
Expected: PASS, with every test green.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS with 0 failures. The 484 tests from before plus the new ones.

- [ ] **Step 6: Commit**

```bash
git add extension/ui/waterfall.js test/waterfall.test.mjs
git commit -m "Waterfall model: phase segments, ticks, page markers, timeline geometry, sorting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Request facts and wire text (pure)

**Files:**
- Modify: `extension/ui/waterfall.js` (append)
- Modify: `extension/plugins/vitals.js:73` (`renderBlocking` cap)
- Test: `test/waterfall.test.mjs` (append)

**Interfaces:**
- Consumes: from `extension/core/har-util.js`: `transferSize`, `resourceType`, `hostOf(url) → string`, `originOf(url) → string`, `isThirdParty(host, site) → boolean`, `resHeader(entry, name) → string|undefined`, `formatBytes(n) → string`, `formatMs(ms) → string`.
- Produces:
  - `RB_CAP = 200`
  - `protocolName(v) → string`, e.g. `'h2'` → `'HTTP/2'`
  - `requestedBy(entry) → string` (`''` when unknown)
  - `originFact(url, pageUrl, site) → string`
  - `sizeFact(entry) → string`
  - `cacheFact(entry) → string`
  - `requestFacts(entry, { entries, index, pageUrl, site, renderBlocking, start }) → Array<[label, text]>`. Empty facts are dropped. Labels, in order: `URL`, `Requested by`, `Origin`, `Protocol`, `Status`, `Size`, `Cache`, `Render blocking`, `Timing`, `Error`.
  - `wireText(entry) → { request: Line[], response: Line[] }`. `Line = { kind: 'start'|'header'|'blank'|'body'|'more', text: string, name?: string }`. `name` is set on header lines.

- [ ] **Step 1: Write the failing tests**

Append to `test/waterfall.test.mjs`, and extend the import line to:
`import { PHASES, phaseSegments, niceTicks, pageMarkers, timelineModel, sortRows, midTrunc, protocolName, requestedBy, originFact, sizeFact, cacheFact, requestFacts, wireText, RB_CAP } from '../extension/ui/waterfall.js';`

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/waterfall.test.mjs`
Expected: FAIL with `does not provide an export named 'protocolName'`.

- [ ] **Step 3: Write the implementation**

Change the import at the top of `extension/ui/waterfall.js` to:

```js
import { transferSize, resourceType, hostOf, originOf, isThirdParty, resHeader, formatBytes, formatMs } from '../core/har-util.js';
```

Append to `extension/ui/waterfall.js`:

```js
/* ------------------------------------------------------------- one request */

/** The vitals plugin stores at most this many render-blocking URLs (plugins/vitals.js). */
export const RB_CAP = 200;

const PROTO = { h2: 'HTTP/2', 'http/2': 'HTTP/2', 'http/2.0': 'HTTP/2', h3: 'HTTP/3', 'http/3': 'HTTP/3', 'http/1.1': 'HTTP/1.1', 'http/1.0': 'HTTP/1.0' };
export const protocolName = (v) => (v ? PROTO[String(v).toLowerCase()] || String(v).toUpperCase() : '');

const REASON = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 410: 'Gone', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const ELEMENT = { stylesheet: 'a <link rel="stylesheet">', script: 'a <script>', image: 'an <img>', media: 'a <video> or <audio>', document: 'a frame', font: 'a font' };

/** Who asked for the request, as a sentence. CDP line numbers are 0-based. */
export function requestedBy(e) {
  const i = e?._initiator;
  if (!i?.type) return '';
  const line = Number.isFinite(i.lineNumber) ? `line ${i.lineNumber + 1}` : '';
  const where = i.url ? ` (${[i.url, line].filter(Boolean).join(', ')})` : line ? ` (${line})` : '';
  switch (i.type) {
    case 'parser': return `${ELEMENT[resourceType(e)] || 'an element'} in the page's HTML${where}`;
    case 'script': return `a script${where}`;
    case 'preload': return `a preload${where}`;
    case 'preflight': return 'a CORS preflight';
    case 'redirect': return `a redirect${i.url ? ` from ${i.url}` : ''}`;
    case 'SignedExchange': return 'a signed exchange';
    default: return 'the browser (other)';
  }
}

export function originFact(url, pageUrl, site) {
  const o = originOf(url);
  const host = hostOf(url);
  if (!o || !host) return '';
  if (pageUrl && o === originOf(pageUrl)) return 'same origin as the page';
  if (site && !isThirdParty(host, site)) return 'same site, other origin';
  return `third-party (${host})`;
}

const ENCODING = { br: 'brotli', gzip: 'gzip', zstd: 'zstd', deflate: 'deflate' };

export function sizeFact(e) {
  const wire = transferSize(e);
  const decoded = num(e?.response?.content?.size);
  const enc = String(resHeader(e, 'content-encoding') || '').toLowerCase().trim();
  let s = `${formatBytes(wire)} on the wire`;
  if (decoded > 0) s += ` · ${formatBytes(decoded)} decoded`;
  if (wire > 0 && decoded > wire) s += ` (${ENCODING[enc] ? `${ENCODING[enc]}, ` : ''}${Math.round((1 - wire / decoded) * 100)}% smaller)`;
  return s;
}

const age = (s) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`);

export function cacheFact(e) {
  const src = e?._fromCache === 'disk' ? 'from disk cache'
    : e?._fromCache === 'memory' ? 'from memory cache'
      : e?._fromServiceWorker ? 'from the service worker'
        : 'fetched over the network';
  const cc = resHeader(e, 'cache-control');
  if (!cc) return src;
  const m = /max-age=(\d+)/i.exec(cc);
  const note = !m ? '' : Number(m[1]) === 0 ? ' (revalidated every time)' : ` (fresh for ${age(Number(m[1]))})`;
  return `${src} · ${cc}${note}`;
}

/** The Overview tab: [label, sentence] pairs, in a fixed order, with empty ones dropped. */
export function requestFacts(e, { entries = [], index = -1, pageUrl, site, renderBlocking, start } = {}) {
  const url = e?.request?.url || '';
  const reused = e?.connection && entries.slice(0, Math.max(0, index)).some((x) => x.connection === e.connection);
  const protocol = [protocolName(e?.response?.httpVersion || e?.request?.httpVersion), e?._priority && `priority ${e._priority}`, reused && 'reused connection'].filter(Boolean).join(' · ');
  const st = num(e?.response?.status);
  const status = st > 0 ? `${st} ${e.response.statusText || REASON[st] || ''}`.trim() : '';
  let blocking = '';
  if (Array.isArray(renderBlocking)) blocking = renderBlocking.includes(url) ? 'yes' : renderBlocking.length >= RB_CAP ? '' : 'no';
  const timing = Number.isFinite(start) && num(e?.time) >= 0 ? `starts at ${formatMs(start)}, takes ${formatMs(e.time)}` : '';
  return [
    ['URL', url], ['Requested by', requestedBy(e)], ['Origin', originFact(url, pageUrl, site)], ['Protocol', protocol],
    ['Status', status], ['Size', sizeFact(e)], ['Cache', cacheFact(e)], ['Render blocking', blocking], ['Timing', timing],
    ['Error', e?._error || ''],
  ].filter(([, v]) => v);
}

const HEADER_LINES = 12;
const BODY_CHARS = 2000;

function headerLines(headers, extra) {
  const hs = [...extra, ...(headers || []).filter((x) => !String(x.name).startsWith(':'))];
  const lines = hs.slice(0, HEADER_LINES).map((x) => ({ kind: 'header', name: x.name, text: `${x.name}: ${x.value}` }));
  if (hs.length > HEADER_LINES) lines.push({ kind: 'more', text: `…${hs.length - HEADER_LINES} more headers` });
  return lines;
}

function bodyLines(text, encoding, size) {
  if (text == null || text === '') return size > 0 ? [{ kind: 'more', text: `[body not captured, ${formatBytes(size)}]` }] : [];
  if (encoding === 'base64') return [{ kind: 'more', text: `[binary body, ${formatBytes(size > 0 ? size : Math.floor((text.length * 3) / 4))}]` }];
  const out = [{ kind: 'body', text: text.slice(0, BODY_CHARS) }];
  if (text.length > BODY_CHARS) out.push({ kind: 'more', text: `…${text.length - BODY_CHARS} more characters` });
  return out;
}

/** The request and response as HTTP/1.1-style text (whatever the protocol), trimmed for reading. */
export function wireText(e) {
  const req = e?.request || {};
  const res = e?.response || {};
  const proto = protocolName(req.httpVersion || res.httpVersion) || 'HTTP/1.1';
  let path = req.url || '';
  try { const u = new URL(req.url); path = u.pathname + u.search; } catch { /* keep the raw URL */ }
  const host = hostOf(req.url);
  const hasHost = (req.headers || []).some((x) => /^host$/i.test(x.name));
  const request = [{ kind: 'start', text: `${req.method || 'GET'} ${path} ${proto}` }, ...headerLines(req.headers, hasHost || !host ? [] : [{ name: 'Host', value: host }])];
  if (req.postData?.text) request.push({ kind: 'blank', text: '' }, ...bodyLines(req.postData.text, req.postData.encoding, req.postData.text.length));
  const st = num(res.status);
  if (!(st > 0)) return { request, response: [{ kind: 'more', text: `(no response — ${e?._error || 'request failed'})` }] };
  const c = res.content || {};
  const response = [{ kind: 'start', text: `${protocolName(res.httpVersion) || proto} ${st} ${res.statusText || REASON[st] || ''}`.trim() }, ...headerLines(res.headers, [])];
  const body = bodyLines(c.text, c.encoding, num(c.size));
  if (body.length) response.push({ kind: 'blank', text: '' }, ...body);
  return { request, response };
}
```

In `extension/plugins/vitals.js`, change the `renderBlocking` line in `collect()`. It runs in the page, so keep the literal:

```js
    renderBlocking: resources.filter((r) => r.renderBlockingStatus === 'blocking').map((r) => r.name).slice(0, 200), // RB_CAP in ui/waterfall.js
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/waterfall.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS with 0 failures.

- [ ] **Step 6: Commit**

```bash
git add extension/ui/waterfall.js test/waterfall.test.mjs extension/plugins/vitals.js
git commit -m "Waterfall: plain-English request facts and wire-format text; render-blocking list holds 200 URLs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Render the waterfall and the request detail

**Files:**
- Modify: `extension/ui/report.js:6-21` (imports), `:270-303` (`networkTable`), `:312-319` (`networkPane`), `:515` (the `networkPane` call)
- Modify: `extension/ui/theme.css:349-358` (the `.net` rules), `:39` (tokens), and the print block around `:505`
- Test: `test/report.test.mjs`

**Interfaces:**
- Consumes: everything Task 1 and Task 2 export from `extension/ui/waterfall.js`. `h.kv`, `h.table` and `h.sub` from `extension/ui/render.js`.
- Produces:
  - `networkTable(reading, rows: Array<{e, i}>, { limit = 200, sort = { key: 'index', dir: 'asc' } } = {}) → Raw html`. Sorts all rows, renders the first `limit`, and adds "Show N more" (`[data-net-more]`) when rows are hidden.
  - Each row: `<tr data-entry="i">`, whose first cell is `<button class="disclose" aria-expanded="false" aria-controls="ed-i">`. The size cell carries `data-bytes`.
  - Sort buttons: `<button class="sort" data-sort="index|status|type|name|size|time|start">` inside `<th aria-sort>`.
  - `requestDetail(reading, i) → Raw html`: a `.req-detail` with `role="tablist"`. Tab ids are `ed-${i}-t-${tab}` and panel ids `ed-${i}-p-${tab}`, for tabs `overview`, `timing`, `headers`, `wire` and `body`. Only the overview panel is not `hidden`.
  - `NET_PAGE = 200`.

- [ ] **Step 1: Write the failing tests**

Change the import at the top of `test/report.test.mjs` to:
`import { renderReport, timeBuckets, PANES, findingsTable, standaloneDocument, networkTable, requestDetail, NET_PAGE } from '../extension/ui/report.js';`

Append:

```js
const allRows = (r) => r.log.entries.map((e, i) => ({ e, i }));

test('waterfall: phase segments, ruler, markers and a legend of only the phases present', () => {
  const r = load();
  for (const e of r.log.entries) e.timings = { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 5, receive: 2 };
  const out = String(networkTable(r, allRows(r)));
  assert.match(out, /<i class="ph-wait" style="flex:5">/);
  assert.match(out, /class="ruler"/);
  assert.match(out, /class="mk mk-dcl"/, 'DOMContentLoaded line from pageTimings');
  const legend = out.slice(out.indexOf('class="wf-legend"'), out.indexOf('</p>', out.indexOf('class="wf-legend"')));
  assert.match(legend, /Waiting \(TTFB\)/);
  assert.match(legend, /Download/);
  assert.doesNotMatch(legend, /TLS|DNS|Queued/);
  assert.match(legend, /DOMContentLoaded \d+ ms/);
  assert.doesNotMatch(out, /NaN|undefined|Infinity/);
});

test('waterfall: -1 timings and a bad date give a dashed "no timing" bar, never NaN', () => {
  const r = load();
  r.log.entries[0].startedDateTime = 'garbage';
  r.log.entries[1].timings = { blocked: -1, dns: -1, connect: -1, ssl: -1, send: -1, wait: -1, receive: -1 };
  const out = String(networkTable(r, allRows(r)));
  assert.match(out, /class="bar none"[^>]*title="no timing/);
  assert.doesNotMatch(out, /NaN|undefined|Infinity/);
});

test('waterfall: sortable headers, sorted rows, status chips', () => {
  const r = load();
  const out = String(networkTable(r, allRows(r), { sort: { key: 'size', dir: 'desc' } }));
  assert.match(out, /<th scope="col" aria-sort="descending"><button type="button" class="sort" data-sort="size">/);
  const sizes = [...out.matchAll(/data-bytes="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
  assert.match(out, /class="st-chip st-ok">200</);
  assert.match(out, /aria-controls="ed-0"/);
});

test('waterfall: "Show more" past 200 rows; the standalone export lists every row with no button (Review Focus 5)', () => {
  const r = load();
  const base = r.log.entries;
  r.log.entries = Array.from({ length: 250 }, (_, k) => structuredClone(base[k % base.length]));
  const out = String(networkTable(r, allRows(r)));
  assert.equal(NET_PAGE, 200);
  assert.equal(out.match(/<tr data-entry=/g).length, 200);
  assert.match(out, /Showing 200 of 250 · <button type="button" data-net-more>Show 50 more<\/button>/);
  const doc = standaloneDocument(r, getPlugins(), { css: '' });
  const net = doc.slice(doc.indexOf('id="net-table"'));
  assert.equal(net.match(/<tr data-entry=/g).length, 250);
  assert.doesNotMatch(net, /data-net-more/);
});

test('waterfall with zero entries keeps the empty message and draws nothing (Review Focus 2)', () => {
  const r = load();
  r.log.entries = [];
  const out = String(networkTable(r, []));
  assert.match(out, /No requests recorded\./);
  assert.doesNotMatch(out, /wf-legend|ruler/);
});

test('requestDetail: five tabs, Overview open, facts, timing, wire format', () => {
  const r = load();
  const out = String(requestDetail(r, 0));
  for (const t of ['overview', 'timing', 'headers', 'wire', 'body']) assert.match(out, new RegExp(`id="ed-0-t-${t}"`));
  assert.match(out, /role="tab" id="ed-0-t-overview" aria-controls="ed-0-p-overview" aria-selected="true" tabindex="0"/);
  assert.match(out, /id="ed-0-p-overview" aria-labelledby="ed-0-t-overview" tabindex="0">/, 'overview is not hidden');
  assert.match(out, /id="ed-0-p-wire" aria-labelledby="ed-0-t-wire" tabindex="0" hidden>/);
  assert.match(out, /<dt>Requested by<\/dt>/);
  assert.match(out, /<span class="w-s">GET \/ HTTP\/1\.1<\/span>/);
  assert.match(out, /class="ph-row"/);
  assert.doesNotMatch(out, /NaN|undefined|Infinity/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/report.test.mjs`
Expected: FAIL with `does not provide an export named 'requestDetail'`.

- [ ] **Step 3: Rewrite `networkTable` and add `requestDetail` in `extension/ui/report.js`**

Add to the imports (after the `har-util.js` import):

```js
import { PHASES, phaseSegments, timelineModel, sortRows, midTrunc, requestFacts, wireText } from './waterfall.js';
```

Replace the whole `networkTable` function (lines 270–303) with:

```js
export const NET_PAGE = 200;

const statusClass = (e) => {
  const s = e.response?.status;
  if (e._error || !(s > 0) || s >= 500) return 'st-err';
  return s >= 400 ? 'st-warn' : s >= 300 ? 'st-redir' : 'st-ok';
};
const NET_COLUMNS = [['index', '#'], ['status', 'Status'], [null, 'Method'], ['type', 'Type'], ['name', 'Name'], ['size', 'Size'], ['time', 'Time']];
const ariaSort = (sort, key) => (sort.key === key ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none');
const sortMark = (sort, key) => (sort.key === key ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : '');
const phaseLabel = (key) => PHASES.find((p) => p.key === key)?.label || key;
const barTip = (b) => (b.known
  ? [`starts at ${formatMs(b.start)}`, ...b.segments.map((s) => `${phaseLabel(s.key)} ${formatMs(s.ms)}`)].join(' · ')
  : `no timing${b.start != null ? ` · starts at ${formatMs(b.start)}` : ''}`);

export function networkTable(reading, rows, { limit = NET_PAGE, sort = { key: 'index', dir: 'asc' } } = {}) {
  const entries = reading.log.entries;
  if (!entries.length) return html`<p class="muted">No requests recorded.</p>`;
  const site = hp(reading).target?.site;
  const model = timelineModel(reading);
  const shown = sortRows(rows, sort.key, sort.dir).slice(0, limit);
  const present = new Set(shown.flatMap(({ i }) => (model.bars[i].known ? model.bars[i].segments.map((s) => s.key) : [])));
  const bytes = rows.reduce((t, { e }) => t + transferSize(e), 0);
  const third = rows.filter(({ e }) => isThirdParty(hostOf(e.request.url), site)).length;
  // Gridlines and page-event lines, drawn in every row's track.
  const lines = html`${model.ticks.slice(1).map((t) => html`<i class="gl" style="left:${t.left}%"></i>`)}${model.markers.map((m) => html`<i class="mk mk-${m.key}" style="left:${m.left}%"></i>`)}`;
  return html`<p class="note">${rows.length} of ${entries.length} requests · ${formatBytes(bytes)} transferred · ${third} third-party · span ${formatMs(model.span)}</p>
    <p class="wf-legend">${PHASES.filter((p) => present.has(p.key)).map((p) => html`<span><i class="sw ph-${p.key}"></i>${p.label}</span>`)}${model.markers.map((m) => html`<span><i class="mk-key mk-${m.key}"></i>${m.label} ${formatMs(m.ms)}</span>`)}<span class="third">amber name = third-party</span></p>
    <div class="table-wrap net"><table class="data">
      <thead><tr><th scope="col"><span class="sr-only">Details</span></th>${NET_COLUMNS.map(([key, label]) => (key
        ? html`<th scope="col" aria-sort="${ariaSort(sort, key)}"><button type="button" class="sort" data-sort="${key}">${label}${sortMark(sort, key)}</button></th>`
        : html`<th scope="col">${label}</th>`))}
        <th scope="col" class="tl-head" aria-sort="${ariaSort(sort, 'start')}"><button type="button" class="sort" data-sort="start">Timeline${sortMark(sort, 'start')}</button>
          <div class="ruler" aria-hidden="true">${model.ticks.map((t) => html`<span style="left:${t.left}%">${formatMs(t.ms)}</span>`)}</div></th></tr></thead>
      <tbody>${shown.map(({ e, i }) => {
        const host = hostOf(e.request.url);
        let path = e.request.url;
        try { const u = new URL(e.request.url); path = u.pathname + u.search; } catch { /* keep raw */ }
        const b = model.bars[i];
        const size = transferSize(e);
        return html`<tr data-entry="${i}">
          <td class="disc"><button type="button" class="disclose" aria-expanded="false" aria-controls="ed-${i}" aria-label="Details for request ${i + 1}">▸</button></td>
          <td class="num">${i + 1}</td>
          <td><span class="st-chip ${statusClass(e)}">${e._error ? 'ERR' : e.response.status || '—'}</span></td>
          <td>${e.request.method}</td>
          <td>${resourceType(e)}</td>
          <td class="url${isThirdParty(host, site) ? ' third' : ''}" title="${e.request.url}">${midTrunc(host + path, 64)}</td>
          <td class="num" data-bytes="${size}">${formatBytes(size)}</td>
          <td class="num">${formatMs(e.time)}</td>
          <td class="tl"><div class="wf">${lines}<span class="bar${b.known ? '' : ' none'}" style="left:${b.left}%;width:${b.width}%" title="${barTip(b)}">${b.known ? b.segments.map((s) => html`<i class="ph-${s.key}" style="flex:${s.ms}"></i>`) : ''}</span></div></td>
        </tr>`;
      })}</tbody>
    </table></div>
    ${rows.length > shown.length ? html`<p class="note net-more">Showing ${shown.length} of ${rows.length} · <button type="button" data-net-more>Show ${Math.min(NET_PAGE, rows.length - shown.length)} more</button></p>` : ''}`;
}

/* ------------------------------------------------------- one request, inline */

const DETAIL_TABS = [['overview', 'Overview'], ['timing', 'Timing'], ['headers', 'Headers'], ['wire', 'Wire'], ['body', 'Body']];
const fineMs = (v) => (v < 10 ? `${v.toFixed(1)} ms` : formatMs(v));

function timingPanel(e, entries, i) {
  const t = e.timings || {};
  const { segments } = phaseSegments(t, e.time);
  const total = segments.reduce((s, x) => s + x.ms, 0) || 1;
  const reused = e.connection && entries.slice(0, i).some((x) => x.connection === e.connection);
  let at = 0;
  const pos = Object.fromEntries(segments.map((s) => { const p = { left: (at / total) * 100, width: (s.ms / total) * 100, ms: s.ms }; at += s.ms; return [s.key, p]; }));
  return html`<div class="phases">${PHASES.map(({ key, label }) => {
    const p = pos[key];
    const text = p ? fineMs(p.ms) : reused && ['dns', 'connect', 'ssl'].includes(key) ? '— reused' : '—';
    return html`<div class="ph-row"><span>${label}</span><span class="ph-track">${p ? html`<b class="ph-${key}" style="left:${p.left.toFixed(2)}%;width:${Math.max(0.5, p.width).toFixed(2)}%"></b>` : ''}</span><span class="num">${text}</span></div>`;
  })}</div>`;
}

function headersPanel(e) {
  const rows = (hs) => (hs || []).map((x) => ({ name: x.name, value: x.value }));
  return html`${h.sub('Request headers', h.table(rows(e.request.headers), ['name', 'value']))}
    ${h.sub('Response headers', h.table(rows(e.response.headers), ['name', 'value']))}
    ${h.sub('Query string', h.table(e.request.queryString || [], ['name', 'value']))}
    ${h.sub('Request cookies', h.table(e.request.cookies || [], ['name', 'value']))}
    ${h.sub('Response cookies', h.table(e.response.cookies || [], ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite']))}`;
}

const wireLine = (l) => (l.kind === 'header' ? html`<span class="w-h">${l.name}:</span>${l.text.slice(l.name.length + 1)}\n`
  : l.kind === 'start' ? html`<span class="w-s">${l.text}</span>\n`
    : l.kind === 'more' ? html`<span class="muted">${l.text}</span>\n`
      : html`${l.text}\n`);

function wirePanel(e) {
  const w = wireText(e);
  return html`<div class="wire"><pre aria-label="Request">${w.request.map(wireLine)}</pre><pre aria-label="Response">${w.response.map(wireLine)}</pre></div>`;
}

function bodyPanel(e) {
  const c = e.response.content || {};
  let body = '';
  if (c.text && c.encoding === 'base64' && /^image\//.test(c.mimeType)) body = html`<img src="data:${c.mimeType};base64,${c.text}" alt="Response image" style="max-width:100%">`;
  else if (c.text && c.encoding !== 'base64') body = html`<pre class="json">${c.text.slice(0, 100_000)}${c.text.length > 100_000 ? '\n… (truncated)' : ''}</pre>`;
  return html`${e.request.postData?.text ? h.sub('Request body', html`<pre class="json">${e.request.postData.text}</pre>`) : ''}
    ${body ? h.sub('Response body', body) : ''}`;
}

/** The expanded row: Overview (plain-English facts), Timing, Headers, Wire, Body. reading.js inserts it and switches tabs. */
export function requestDetail(reading, i) {
  const entries = reading.log.entries;
  const e = entries[i];
  const t = hp(reading).target || {};
  const b = timelineModel(reading).bars[i];
  const facts = requestFacts(e, { entries, index: i, pageUrl: t.finalUrl || t.url, site: t.site, renderBlocking: resultsOf(reading).vitals?.data?.renderBlocking, start: b.start });
  const panels = { overview: h.kv(facts), timing: timingPanel(e, entries, i), headers: headersPanel(e), wire: wirePanel(e), body: bodyPanel(e) };
  const id = `ed-${i}`;
  return html`<div class="req-detail">
    <div role="tablist" aria-label="Request ${i + 1} details">${DETAIL_TABS.map(([k, label], n) => html`<button type="button" role="tab" id="${id}-t-${k}" aria-controls="${id}-p-${k}" aria-selected="${String(n === 0)}" tabindex="${n === 0 ? 0 : -1}" data-tab="${k}">${label}</button>`)}</div>
    ${DETAIL_TABS.map(([k], n) => html`<div role="tabpanel" id="${id}-p-${k}" aria-labelledby="${id}-t-${k}" tabindex="0"${n ? raw(' hidden') : ''}>${String(panels[k]).trim() ? panels[k] : html`<p class="muted">Nothing recorded.</p>`}</div>`)}
  </div>`;
}
```

Add `raw` to the `html.js` import at the top of report.js: `import { html, esc, raw } from './html.js';`.

Replace `networkPane` (lines 312–319) and its call at line 515:

```js
function networkPane(reading, plugins, interactive) {
  const net = resultsOf(reading).network;
  const p = byId(plugins, 'network');
  return html`<section class="pane" id="network" aria-labelledby="network-h">
    <header class="pane-head"><h1 id="network-h">Network</h1><div class="tools" id="network-tools"></div></header>
    ${net?.status === 'ok' && p ? renderGlance(p, net, { results: resultsOf(reading), target: hp(reading).target || {} }) : ''}
    <div id="net-table">${networkTable(reading, reading.log.entries.map((e, i) => ({ e, i })), { limit: interactive ? NET_PAGE : Infinity })}</div>
  </section>`;
}
```

At line 515: `${networkPane(reading, plugins, interactive)}`.

- [ ] **Step 4: Add the styles in `extension/ui/theme.css`**

In `@layer tokens` `:root`, after the `--band-warning` line, add:

```css
    /* waterfall phases: pastel fill, outlined darker (the outline is shared) */
    --ph-blocked: light-dark(#d5dade, #4a5560);
    --ph-dns: light-dark(#8fd6c9, #2f7f73);
    --ph-connect: light-dark(#f6b98f, #9a5a2c);
    --ph-ssl: light-dark(#c5b9f2, #6a5aa8);
    --ph-send: light-dark(#f3d77f, #8a7428);
    --ph-wait: light-dark(#9fe0b4, #3a7f52);
    --ph-receive: light-dark(#93bdf0, #3a679e);
    --ph-outline: color-mix(in srgb, var(--text) 35%, transparent);
```

Replace the `.net` block (lines 349–358) with:

```css
  .net table.data { min-width: 960px; }
  .findings table.data { min-width: 640px; }
  .net td.num { text-align: end; font-family: var(--mono); white-space: nowrap; }
  .net td.url { font-family: var(--mono); max-width: 26rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .net td.url.third, .wf-legend .third { color: var(--amber); }
  .net tbody tr[data-entry] { cursor: pointer; }
  .net tbody tr[data-entry]:hover td { background: var(--panel-2); }
  .net tbody tr[data-entry].open td { background: var(--accent-soft); }
  .net th button.sort { all: unset; cursor: pointer; font-weight: 600; }
  .net th button.sort:focus-visible, .net button.disclose:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .net button.disclose { border: 0; background: none; padding: 0 0.25rem; cursor: pointer; color: var(--muted); }
  .net th.tl-head, .net td.tl { width: 42%; min-width: 16rem; }
  .net .ruler { position: relative; height: 1rem; margin-top: 0.2rem; font-weight: 400; font-size: 0.72rem; color: var(--muted); }
  .net .ruler span { position: absolute; top: 0; border-inline-start: 1px solid var(--line); padding-inline-start: 2px; white-space: nowrap; }
  .net .wf { position: relative; height: 1.1rem; }
  .net .wf .gl { position: absolute; top: 0; bottom: 0; border-inline-start: 1px dashed var(--line); }
  .net .wf .mk, .wf-legend .mk-key { border-inline-start: 2px solid; }
  .net .wf .mk { position: absolute; top: -0.35rem; bottom: -0.35rem; }
  .mk-dcl { border-color: var(--c1) !important; } .mk-load { border-color: var(--c8) !important; }
  .mk-fcp { border-color: var(--c3) !important; } .mk-lcp { border-color: var(--c7) !important; border-inline-start-style: dashed !important; }
  .net .wf .bar { position: absolute; top: 0.25rem; height: 0.6rem; display: flex; border-radius: 2px; overflow: hidden; outline: 1px solid var(--ph-outline); outline-offset: -1px; min-width: 2px; }
  .net .wf .bar i { display: block; height: 100%; }
  .net .wf .bar.none { min-width: 0.75rem; outline: 1px dashed var(--muted); background: transparent; }
  .ph-blocked { background: var(--ph-blocked); } .ph-dns { background: var(--ph-dns); } .ph-connect { background: var(--ph-connect); }
  .ph-ssl { background: var(--ph-ssl); } .ph-send { background: var(--ph-send); } .ph-wait { background: var(--ph-wait); } .ph-receive { background: var(--ph-receive); }
  .wf-legend { display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; font-size: 0.8rem; color: var(--muted); margin: 0.25rem 0 0.5rem; }
  .wf-legend .sw { display: inline-block; width: 0.7rem; height: 0.7rem; border-radius: 2px; outline: 1px solid var(--ph-outline); outline-offset: -1px; margin-inline-end: 0.3rem; vertical-align: -1px; }
  .wf-legend .mk-key { display: inline-block; width: 0; height: 0.8rem; margin-inline-end: 0.35rem; vertical-align: -2px; }
  .st-chip { display: inline-block; font-family: var(--mono); font-size: 0.75rem; font-weight: 600; padding: 0 0.35rem; border-radius: 4px; background: var(--panel-2); }
  .st-chip.st-ok { color: var(--ink-good); background: color-mix(in srgb, var(--st-good) 14%, transparent); }
  .st-chip.st-warn { color: var(--ink-warning); background: color-mix(in srgb, var(--st-warning) 18%, transparent); }
  .st-chip.st-err { color: var(--ink-critical); background: color-mix(in srgb, var(--st-critical) 14%, transparent); }
  .net tr.detail-row > td { background: var(--panel-2); padding: 0.75rem 1rem 1rem 2.25rem; }
  .req-detail [role="tablist"] { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 0.6rem; }
  .req-detail [role="tab"] { border: 1px solid transparent; border-bottom: 0; border-radius: 6px 6px 0 0; background: none; padding: 0.3rem 0.8rem; font-weight: 600; color: var(--muted); cursor: pointer; }
  .req-detail [role="tab"][aria-selected="true"] { background: var(--panel); color: var(--text); border-color: var(--line); margin-bottom: -1px; }
  .req-detail [role="tab"]:focus-visible, .req-detail [role="tabpanel"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .req-detail .phases { display: grid; gap: 0.2rem; max-width: 40rem; }
  .req-detail .ph-row { display: grid; grid-template-columns: 9rem 1fr 5rem; gap: 0.6rem; align-items: center; font-size: 0.85rem; }
  .req-detail .ph-track { position: relative; height: 0.6rem; background: var(--track); border-radius: 2px; }
  .req-detail .ph-track b { position: absolute; top: 0; height: 100%; border-radius: 2px; outline: 1px solid var(--ph-outline); outline-offset: -1px; }
  .req-detail .wire { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 0.6rem; }
  .req-detail .wire pre { margin: 0; padding: 0.5rem 0.7rem; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; font-family: var(--mono); font-size: 0.78rem; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
  .req-detail .w-s { color: var(--accent); font-weight: 600; }
  .req-detail .w-h { color: var(--low); }
```

In the print block (around line 505), after the `.net tbody tr:nth-child(n + 51)` rule, add:

```css
    .net tr.detail-row, .net-more, .net button.disclose { display: none !important; }
```

After `.standalone [data-copy] { display: none; }`, add:

```css
  .standalone .net button.disclose, .standalone .net button.sort { pointer-events: none; }
```

- [ ] **Step 5: Run the report tests**

Run: `node --test test/report.test.mjs`
Expected: PASS, including the existing `unparseable startedDateTime renders without NaN` test.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS with 0 failures. reading.js still imports `networkTable` and calls it with two arguments, which keeps working.

- [ ] **Step 7: Commit**

```bash
git add extension/ui/report.js extension/ui/theme.css test/report.test.mjs
git commit -m "Network pane: phase-split waterfall with ruler, page markers, legend, sortable columns, show more; inline request detail markup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Interaction: sort, show more, inline expand, tabs, keys

**Files:**
- Modify: `extension/ui/reading.js:7` (imports), `:13` (the report import), `:22` (`state`), `:299-307` (`renderNetwork`), `:333-361` (remove `entryDetail`), `:395-400` (the row click), `:425-427` (the Enter keydown), the `input` and `change` handlers
- Modify: `test/e2e/run.mjs:650-654` (the network part)
- Test: `test/e2e/run.mjs`

**Interfaces:**
- Consumes: from Task 3: `networkTable(reading, rows, { limit, sort })`, `requestDetail(reading, i)`, `NET_PAGE`; the markup contract (`tr[data-entry]`, `button.disclose[aria-controls="ed-i"]`, `button.sort[data-sort]`, `[data-net-more]`, and tab and panel ids `ed-i-t-*` and `ed-i-p-*`).
- Produces: in-page behaviour only.

- [ ] **Step 1: Write the failing e2e assertions**

In `test/e2e/run.mjs`, replace these lines:

```js
    await page2.evaluate(() => { location.hash = 'network'; });
    await page2.click('#network tbody tr');
    await page2.waitForSelector('#dlg[open]');
    await page2.screenshot({ path: join(OUT, 'reading-request-dialog.png') });
    await page2.click('#dlg-close');
```

with:

```js
    await page2.evaluate(() => { location.hash = 'network'; });
    // The waterfall: phase segments and the page-event lines.
    assert.ok(await page2.locator('#net-table tbody tr[data-entry] .bar i').count() > 1, 'bars are split into phases');
    assert.ok(await page2.locator('#net-table tr[data-entry] .mk-dcl').count() > 0, 'DOMContentLoaded line drawn');
    assert.ok(await page2.locator('#net-table tr[data-entry] .mk-load').count() > 0, 'load line drawn');
    // Enter on the disclosure expands the row in place; the Overview tab is open.
    const disc = page2.locator('#net-table tr[data-entry="0"] button.disclose');
    await disc.focus();
    await page2.keyboard.press('Enter');
    await page2.waitForSelector('#ed-0 .req-detail');
    assert.equal(await disc.getAttribute('aria-expanded'), 'true');
    assert.match(await page2.locator('#ed-0-p-overview').innerText(), /Requested by/);
    // The arrow keys move between tabs; the Wire tab shows the request line.
    await page2.locator('#ed-0-t-overview').focus();
    await page2.keyboard.press('ArrowRight');
    assert.equal(await page2.locator('#ed-0-t-timing').getAttribute('aria-selected'), 'true');
    assert.equal(await page2.locator('#ed-0-p-overview').isHidden(), true);
    await page2.keyboard.press('ArrowRight');
    await page2.keyboard.press('ArrowRight');
    assert.equal(await page2.evaluate(() => document.activeElement.id), 'ed-0-t-wire');
    assert.match(await page2.locator('#ed-0-p-wire pre').first().innerText(), /^GET \S+ HTTP\//);
    await page2.screenshot({ path: join(OUT, 'reading-request-detail.png') });
    // Escape collapses it and leaves focus on the row.
    await page2.keyboard.press('Escape');
    assert.equal(await page2.locator('#ed-0').count(), 0, 'detail row removed');
    assert.equal(await page2.evaluate(() => document.activeElement.closest('tr')?.dataset.entry), '0', 'focus back on the row');
    // Sort by size: the second click is descending.
    await page2.click('#net-table button[data-sort="size"]');
    await page2.click('#net-table button[data-sort="size"]');
    const sizes = await page2.$$eval('#net-table td[data-bytes]', (tds) => tds.map((td) => Number(td.dataset.bytes)));
    assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a), 'sorted by size, descending');
    assert.equal(await page2.locator('#net-table th[aria-sort="descending"] button[data-sort="size"]').count(), 1);
    assert.equal(await page2.evaluate(() => document.activeElement?.dataset.sort), 'size', 'focus stays on the sort button');
    // Review Focus 3: expanding a row, then filtering it out, leaves no orphaned detail; clearing the filter brings it back.
    await page2.locator('#net-table tr[data-entry="0"] button.disclose').click();
    await page2.waitForSelector('#ed-0');
    await page2.fill('#n-q', 'no-such-request-zzz');
    assert.equal(await page2.locator('#net-table .detail-row').count(), 0, 'no orphaned detail row');
    assert.equal(await page2.evaluate(() => document.activeElement.id), 'n-q', 'filtering keeps focus in the search box');
    await page2.fill('#n-q', '');
    await page2.waitForSelector('#ed-0 .req-detail');
    await page2.keyboard.press('Escape');
```

- [ ] **Step 2: Run e2e to verify it fails**

Run: `npm run test:e2e`
Expected: FAIL at `#ed-0 .req-detail` (a timeout) or `aria-expanded`. Pressing Enter still opens the old dialog.

- [ ] **Step 3: Implement the interaction in `extension/ui/reading.js`**

Change line 13 to:

```js
import { renderReport, findingsTable, networkTable, requestDetail, NET_PAGE, PANES, standaloneDocument } from './report.js';
```

Change line 22 to:

```js
const state = { sev: new Set(SEVERITIES), area: '', category: '', q: '', netQ: '', netType: '', netParty: '', netSort: { key: 'index', dir: 'asc' }, netLimit: NET_PAGE, netOpen: null };
```

Replace `renderNetwork` with:

```js
function renderNetwork() {
  const site = hp().target?.site;
  const rows = reading.log.entries.map((e, i) => ({ e, i })).filter(({ e }) => {
    const host = hostOf(e.request.url);
    return (!state.netQ || e.request.url.toLowerCase().includes(state.netQ)) &&
      (!state.netType || resourceType(e) === state.netType) &&
      (!state.netParty || (state.netParty === 'third') === isThirdParty(host, site));
  });
  $('#net-table').innerHTML = String(networkTable(reading, rows, { limit: state.netLimit, sort: state.netSort }));
  // An open row survives a re-render while it is still shown (Review Focus 3).
  if (state.netOpen != null) expandEntry(state.netOpen, { focus: false });
}

/** Insert the request's detail row after its row; one open at a time. Returns false if the row is not shown. */
function expandEntry(i, { focus = true } = {}) {
  const row = document.querySelector(`#net-table tr[data-entry="${i}"]`);
  if (!row) return false;
  const btn = row.querySelector('button.disclose');
  const detail = document.createElement('tr');
  detail.className = 'detail-row';
  detail.id = `ed-${i}`;
  detail.innerHTML = `<td colspan="${row.children.length}">${requestDetail(reading, i)}</td>`;
  row.after(detail);
  row.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
  btn.textContent = '▾';
  if (focus) btn.focus();
  return true;
}

function collapseEntry({ focus = true } = {}) {
  const i = state.netOpen;
  state.netOpen = null;
  if (i == null) return;
  document.getElementById(`ed-${i}`)?.remove();
  const row = document.querySelector(`#net-table tr[data-entry="${i}"]`);
  if (!row) return;
  row.classList.remove('open');
  const btn = row.querySelector('button.disclose');
  btn.setAttribute('aria-expanded', 'false');
  btn.textContent = '▸';
  if (focus) btn.focus();
}

function toggleEntry(i) {
  const was = state.netOpen;
  collapseEntry({ focus: false });
  if (was === i) { document.querySelector(`#net-table tr[data-entry="${i}"] button.disclose`)?.focus(); return; }
  if (expandEntry(i)) state.netOpen = i;
}

function selectTab(tab, { focus = true } = {}) {
  const list = tab.closest('[role="tablist"]');
  for (const t of list.querySelectorAll('[role="tab"]')) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
}
```

In `renderNetwork`, `expandEntry` returns false when the open row is filtered out. Keep `state.netOpen` as it is, so the detail returns when the row is shown again. Remove only any stale detail element, which the `innerHTML` replacement already does.

Delete the `entryDetail` function (lines 340–361) entirely. Keep `openDialog`, which screenshots still use.

In the `click` handler, replace the `tr[data-entry]` block:

```js
  const row = t.closest('tr[data-entry]');
  if (row) {
    const e = reading.log.entries[Number(row.dataset.entry)];
    openDialog(e.request.url, entryDetail(e));
    return;
  }
```

with:

```js
  const sortBtn = t.closest('#net-table button[data-sort]');
  if (sortBtn) {
    const key = sortBtn.dataset.sort;
    state.netSort = state.netSort.key === key ? { key, dir: state.netSort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
    renderNetwork();
    document.querySelector(`#net-table button[data-sort="${key}"]`)?.focus();
    return;
  }
  if (t.closest('#net-table [data-net-more]')) {
    state.netLimit += NET_PAGE;
    renderNetwork();
    document.querySelector('#net-table [data-net-more]')?.focus();
    return;
  }
  const tab = t.closest('.req-detail [role="tab"]');
  if (tab) { selectTab(tab); return; }
  if (t.closest('.detail-row')) return; // clicks inside the detail never toggle the row
  const row = t.closest('#net-table tr[data-entry]');
  if (row) { toggleEntry(Number(row.dataset.entry)); return; }
```

Replace the keydown handler:

```js
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.matches?.('tr[data-entry]')) ev.target.click();
});
```

with:

```js
document.addEventListener('keydown', (ev) => {
  const t = ev.target;
  if (t.matches?.('.req-detail [role="tab"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
    const tabs = [...t.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
    const k = tabs.indexOf(t);
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1 : (k + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[next]);
    ev.preventDefault();
    return;
  }
  if (ev.key === 'Escape' && state.netOpen != null && t.closest?.(`#ed-${state.netOpen}, #net-table tr[data-entry="${state.netOpen}"]`)) {
    collapseEntry();
    ev.preventDefault();
  }
});
```

The row's disclosure is a `<button>`, so Enter and Space reach the click handler natively. The `tr[data-entry]` path then toggles it.

In the `input` handler, change the `n-q` line to reset the page:

```js
  if (t.id === 'n-q') { state.netQ = t.value.trim().toLowerCase(); state.netLimit = NET_PAGE; renderNetwork(); }
```

In the `change` handler, make the same change for the `n-type` and `n-party` lines: add `state.netLimit = NET_PAGE;` before each `renderNetwork()`.

- [ ] **Step 4: Run e2e to verify it passes**

Run: `npm run test:e2e`
Expected: `· all e2e checks passed`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS with 0 failures.

- [ ] **Step 6: Look at the result**

Open `test/e2e/out/reading-request-detail.png` and `test/e2e/out/reading-network.png` (written by the pane loop). Check these points:
- the bars show coloured phase segments with outlines;
- the ruler labels line up with the gridlines;
- the DOMContentLoaded and load lines are visible;
- the legend shows words beside the swatches;
- the expanded row shows the tabs, with the Wire tab's request and response side by side.

Fix any visual defect in `theme.css` and re-run e2e.

- [ ] **Step 7: Commit**

```bash
git add extension/ui/reading.js test/e2e/run.mjs extension/ui/theme.css
git commit -m "Network pane: rows expand in place into tabbed detail; sortable columns, show more, keyboard tabs and Escape

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Columns | Task 3 |
| §1 Bars and phases | Tasks 1 and 3 |
| §1 No-timing bars | Tasks 1 and 3 |
| §1 Tooltip | Task 3 (`barTip`) |
| §1 Ruler | Tasks 1 and 3 |
| §1 Markers | Tasks 1 and 3 |
| §1 Legend | Task 3 |
| §2 Opening and keyboard | Task 4 |
| §2 Tabs | Task 3 (markup) and Task 4 (behaviour) |
| §2 Overview facts | Task 2 |
| §2 Timing, Headers and Body tabs | Task 3 |
| §2 Wire tab | Tasks 2 and 3 |
| §2 Standalone export | Task 3 |
| §3 Sorting | Tasks 1, 3 and 4 |
| §3 Show more | Tasks 3 and 4 |
| §3 Focus kept while filtering | Task 4 |
| §3 Summary line | Task 3 |
| §4 Render-blocking | Task 2 |
| §5 Print | Task 3 |
| Error handling | Tasks 1 to 3 (no-NaN tests) |
| `prefers-reduced-motion` | Nothing animates, so no rule is needed |

**Type consistency:** the names match from task to task: `timelineModel().bars[i]`, `{start, left, width, segments, known}`, `requestFacts` ctx keys, `wireText` line kinds, `NET_PAGE`, the `ed-${i}` ids, and `data-sort` keys that match the `SORT_KEYS` in Task 1.
