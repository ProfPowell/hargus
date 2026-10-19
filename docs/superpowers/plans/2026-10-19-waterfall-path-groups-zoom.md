# Waterfall: LCP Path, Site Groups, Zoom — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** add three things to the Network waterfall. An "LCP path" highlight: the request chain that led to LCP, with the other rows dimmed. "Group by site": third-party sites collapse into summary rows. An overview strip with a zoom brush, plus Ctrl/⌘-wheel zoom, and the header pinned while the table scrolls.

**Architecture:**
- `extension/ui/waterfall.js` gains pure functions: `lcpPath`, `pathSummary` and `groupRows` (Task 1), and a zoom window in `timelineModel` with `clampWindow`, `zoomAt` and `overviewLanes` (Task 2).
- `extension/ui/report.js` renders the toggles, the strip, group rows, path classes and clipped bars inside `networkTable` (Task 3).
- `extension/ui/reading.js` wires the pointer, wheel and keyboard interaction (Task 4).

**Tech Stack:** vanilla ES modules, the `html` tagged templates from `extension/ui/html.js`, CSS `@layer` with `light-dark()` tokens, `node --test`, and Playwright e2e (`npm run test:e2e`).

**Spec:** `docs/superpowers/specs/2026-10-19-waterfall-path-groups-zoom-design.md`. It builds on `docs/superpowers/specs/2026-10-19-network-waterfall-design.md`.

## Global Constraints

- **Inherited from the waterfall spec:**
  - no new runtime dependency;
  - pure logic in `extension/ui/waterfall.js`, with no DOM access, unit-tested with `node --test`;
  - colours only from tokens in `extension/ui/theme.css`, working in light and dark (`light-dark()`);
  - the rendered report never contains `NaN`, `undefined` or `Infinity`;
  - keyboard and screen-reader access.
- **No stored data changes.** Everything is derived at render time from the HAR and the vitals plugin's `data.lcp` and `data.renderBlocking`.
- **Export and print unchanged.** The standalone export and print show the whole load, with no toggles, groups, brush or dimming.
- **Performance:** with 5,000 entries, the path, the groups, the overview and one re-render after a zoom or toggle each stay under 50 ms in Node unit timing.
- **Commits:** every commit message ends with a `Co-Authored-By:` trailer naming the model that actually wrote the commit, e.g. `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. This was recorded as a ruling in the previous batch.
- **Test commands:** run `npm test` and `npm run test:e2e` from the repo or worktree root.
- **Worktree guard:** the worktree guard rejects compound shell commands (pipelines with git, `&&` chains with git, loops). Use plain, separate commands.

## Notes against the spec (rulings made while planning)

- **Where the toggles live.** The "◆ LCP path" and "Group by site" toggles, the overview strip and the zoom text are rendered by `networkTable` (interactive mode) at the top of `#net-table`, not in `netTools()`. This keeps them testable in Node; the spec's report test asks for exactly that.
- **Paging with groups.** A group counts as one row towards "Show more". Its members, when expanded, are rendered in addition and never count.
- **Live region.** The `aria-live` text sits in a persistent `#wf-live` element (`sr-only`) outside `#net-table`, because a live region that is re-rendered is not announced reliably. The visible "Showing X–Y of Z" text is plain.
- **Reset attribute.** The reset button uses `data-wf-reset`, because `data-zoom` is already the screenshot-zoom hook in `reading.js`.

## Review Focus

1. **The path in a collapsed group.** A path request inside a collapsed site group lights up the group row, not a hidden row. Pinned in Task 3.
2. **Zoomed and filtered at the same time.** Filtering while zoomed keeps the window, and the bars for the rows that remain are still placed in it. Pinned in Task 4 (e2e: filter, check the window text is unchanged).
3. **A window outside every bar.** A window that contains no request start renders empty tracks (bars outside it with zero width), with no `NaN` and no negative widths. Pinned in Task 2.
4. **A redirect chain to the LCP image** (http → https, or a CDN redirect). The path walks through the redirect. Pinned in Task 1.
5. **Ctrl-wheel outside the timeline.** Ctrl-wheel over the page (not the timeline) still does the browser's page zoom; only the timeline and strip capture it. Pinned in Task 4: a Ctrl-wheel over the summary line does not change the window.

---

## File structure

| File | Responsibility |
|---|---|
| `extension/ui/waterfall.js` | Add `MAX_HOPS`, `lcpPath`, `pathSummary`, `groupRows` (Task 1); `MIN_WINDOW`, `clampWindow`, `zoomAt`, `isZoomed`, `overviewLanes`, plus the windowed `timelineModel(reading, view)` with `bars[i].end`, `clipStart`, `clipEnd`, and `place()`/`window` on the model (Task 2) |
| `test/waterfall.test.mjs` | Unit tests (Tasks 1 and 2) |
| `extension/ui/report.js` | `networkTable` options `window`, `path`, `groups`, `openGroups`; the toolbar, strip, summary line, group rows, path classes and clip cues; the table scroll box (Task 3) |
| `extension/ui/theme.css` | Dim and outline, group rows, clip cues, overview strip and brush, sticky header, print reset (Task 3) |
| `test/report.test.mjs` | Report tests (Task 3) |
| `extension/ui/reading.js` | State, toggles, group expand, brush pointer and keys, ruler drag, wheel zoom, live text (Task 4) |
| `test/e2e/run.mjs` | E2E (Task 4) |

---

### Task 1: LCP path and site groups (pure)

**Files:**
- Modify: `extension/ui/waterfall.js` (the import line, plus appended code)
- Test: `test/waterfall.test.mjs` (the import line, plus appended tests)

**Interfaces:**
- **Consumes:**
  - From the existing `waterfall.js`: `timelineModel(reading)` (returns `bars[i].start`, ms or `null`, and `markers[]` with `{key, at}`), `num` (a local helper) and `resourceType`.
  - From `../core/har-util.js`: `hostOf`, `isThirdParty`, `siteOf(host)`, `transferSize` and `formatMs`.
- **Produces:**
  - `MAX_HOPS = 20`.
  - `lcpPath(reading) → null | { kind: 'resource'|'text', ms: number, label: string, hops: number[], blocking: number[], missing: boolean }`. `hops` are entry indices, document first and target last.
  - `pathSummary(reading, path, visible?: Set<number>) → string`.
  - `groupRows(rows: Array<{e, i}>, site: string, model) → Array<{e, i} | { group: string, rows: Array<{e, i}>, count, bytes, start, end }>`. `start` and `end` are in ms.

- [ ] **Step 1: Write the failing tests**

Add `lcpPath, pathSummary, groupRows, MAX_HOPS` to the import list at the top of `test/waterfall.test.mjs`. Then append:

```js
/* ---------------------------------------------------------------- LCP path */

const at = (ms) => new Date(Date.parse('2026-10-19T10:00:00.000Z') + ms).toISOString();
const req = (url, { start = 0, time = 50, type = 'script', init, status = 200, redirectURL } = {}) => ({
  startedDateTime: at(start), time, _resourceType: type, ...(init ? { _initiator: init } : {}),
  request: { method: 'GET', url, headers: [] },
  response: { status, headers: [], content: { size: 0 }, ...(redirectURL ? { redirectURL } : {}) },
  timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: time, receive: 0 },
});
const pathReading = (entries, vitals) => ({ log: {
  pages: [{ startedDateTime: at(0), pageTimings: {} }], entries,
  _harplus: { target: { url: 'https://a.test/', site: 'a.test' }, plugins: { vitals: { data: vitals } } },
} });
const chain = () => [
  req('https://a.test/', { start: 0, time: 100, type: 'document', init: { type: 'other' } }),
  req('https://a.test/main.css', { start: 120, time: 50, type: 'stylesheet', init: { type: 'parser', url: 'https://a.test/' } }),
  req('https://a.test/app.js', { start: 130, time: 80, type: 'script', init: { type: 'parser', url: 'https://a.test/' } }),
  req('https://a.test/hero.webp', { start: 300, time: 200, type: 'image', init: { type: 'script', url: 'https://a.test/app.js' } }),
  req('https://a.test/late.css', { start: 700, time: 40, type: 'stylesheet', init: { type: 'parser', url: 'https://a.test/' } }),
];

test('lcpPath: resource chain through initiators, render-blocking before LCP only', () => {
  const p = lcpPath(pathReading(chain(), { lcp: { time: 600, url: 'https://a.test/hero.webp' }, renderBlocking: ['https://a.test/main.css', 'https://a.test/late.css'] }));
  assert.deepEqual(p, { kind: 'resource', ms: 600, label: 'hero.webp', hops: [0, 2, 3], blocking: [1], missing: false });
  assert.equal(pathSummary(pathReading(chain(), { lcp: { time: 600, url: 'https://a.test/hero.webp' }, renderBlocking: ['https://a.test/main.css'] }), p),
    'LCP 600 ms — hero.webp, reached in 3 hops: document 100 ms → app.js 80 ms → hero.webp 200 ms (+1 render-blocking)');
});

test('lcpPath: walks through a redirect to the LCP image (Review Focus 4)', () => {
  const es = chain();
  es[3] = req('http://cdn.a.test/hero.webp', { start: 300, time: 20, type: 'image', status: 301, redirectURL: 'https://cdn.a.test/hero.webp', init: { type: 'script', url: 'https://a.test/app.js' } });
  es.push(req('https://cdn.a.test/hero.webp', { start: 330, time: 150, type: 'image', init: { type: 'redirect' } }));
  const p = lcpPath(pathReading(es, { lcp: { time: 600, url: 'https://cdn.a.test/hero.webp' } }));
  assert.deepEqual(p.hops, [0, 2, 3, 5]);
});

test('lcpPath: loops stop, chains cap at MAX_HOPS', () => {
  const loop = [
    req('https://a.test/x.js', { start: 0, init: { type: 'script', url: 'https://a.test/y.js' } }),
    req('https://a.test/y.js', { start: 10, init: { type: 'script', url: 'https://a.test/x.js' } }),
  ];
  assert.deepEqual(lcpPath(pathReading(loop, { lcp: { time: 100, url: 'https://a.test/y.js' } })).hops, [0, 1]);
  const long = Array.from({ length: 30 }, (_, k) => req(`https://a.test/${k}.js`, { start: k * 10, init: k ? { type: 'script', url: `https://a.test/${k - 1}.js` } : { type: 'other' } }));
  assert.equal(lcpPath(pathReading(long, { lcp: { time: 400, url: 'https://a.test/29.js' } })).hops.length, MAX_HOPS);
});

test('lcpPath: text LCP and an unmatched LCP URL fall back to document + render-blocking', () => {
  const text = lcpPath(pathReading(chain(), { lcp: { time: 600, element: 'h1.hero' }, renderBlocking: ['https://a.test/main.css'] }));
  assert.deepEqual(text, { kind: 'text', ms: 600, label: 'text (h1.hero)', hops: [0], blocking: [1], missing: false });
  assert.equal(pathSummary(pathReading(chain(), { lcp: { time: 600, element: 'h1.hero' } }), text), 'LCP 600 ms — text (h1.hero): document 100 ms + 1 render-blocking (main.css)');
  const gone = lcpPath(pathReading(chain(), { lcp: { time: 600, url: 'https://x.test/elsewhere.png' } }));
  assert.equal(gone.kind, 'text');
  assert.equal(gone.missing, true);
  assert.equal(gone.label, 'LCP resource not in the request list');
});

test('lcpPath: null without an LCP time; pathSummary marks hops hidden by a filter', () => {
  assert.equal(lcpPath(pathReading(chain(), {})), null);
  assert.equal(lcpPath(pathReading(chain(), { lcp: null })), null);
  const r = pathReading(chain(), { lcp: { time: 600, url: 'https://a.test/hero.webp' } });
  assert.match(pathSummary(r, lcpPath(r), new Set([0, 3])), /app\.js 80 ms \(hidden by filter\)/);
});

/* ------------------------------------------------------------- site groups */

test('groupRows: third-party sites with 2+ requests become one group at their first position', () => {
  const es = [
    req('https://a.test/', { start: 0, time: 100, type: 'document' }),
    req('https://www.gtm.test/a.js', { start: 120, time: 30 }),
    req('https://a.test/b.css', { start: 130, time: 20 }),
    req('https://cdn.gtm.test/c.js', { start: 200, time: 100 }),
    req('https://solo.test/d.js', { start: 210, time: 10 }),
  ];
  es[1].response._transferSize = 1000;
  es[3].response._transferSize = 500;
  const r = pathReading(es, {});
  const rows = es.map((e, i) => ({ e, i }));
  const out = groupRows(rows, 'a.test', timelineModel(r));
  assert.deepEqual(out.map((x) => (x.group ? `g:${x.group}` : x.i)), [0, 'g:gtm.test', 2, 4]);
  const g = out[1];
  assert.deepEqual([g.count, g.bytes, g.start, g.end], [2, 1500, 120, 300]);
  assert.deepEqual(g.rows.map((x) => x.i), [1, 3], 'members keep input order');
});

test('lcpPath and groupRows handle 5,000 entries quickly', () => {
  const es = Array.from({ length: 5000 }, (_, k) => req(`https://s${k % 40}.test/${k}.js`, { start: k, time: 30, init: { type: 'script', url: `https://s${k % 40}.test/${Math.max(0, k - 1)}.js` } }));
  const r = pathReading(es, { lcp: { time: 4000, url: 'https://s39.test/4999.js' }, renderBlocking: [] });
  const t0 = performance.now();
  lcpPath(r);
  groupRows(es.map((e, i) => ({ e, i })), 'a.test', timelineModel(r));
  assert.ok(performance.now() - t0 < 50 * 3, 'path + groups well within budget (3× slack for CI)');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/waterfall.test.mjs`
Expected: FAIL with `does not provide an export named 'lcpPath'`.

- [ ] **Step 3: Write the implementation**

Change the `har-util.js` import at the top of `extension/ui/waterfall.js` to:

```js
import { transferSize, resourceType, hostOf, originOf, isThirdParty, siteOf, resHeader, formatBytes, formatMs } from '../core/har-util.js';
```

Append to `extension/ui/waterfall.js`:

```js
/* ------------------------------------------------------------- LCP path */

export const MAX_HOPS = 20;

const fileName = (url) => {
  try { const u = new URL(url); return u.pathname.split('/').filter(Boolean).pop() || u.hostname; } catch { return String(url || ''); }
};
const okStatus = (e) => { const s = num(e?.response?.status); return s >= 200 && s < 400; };
const absolute = (url, base) => { try { return new URL(url, base).href; } catch { return ''; } };

/**
 * The parent of request i: the latest-starting request at or before it whose URL is its initiator's URL,
 * or else the request that redirected to it. -1 when there is none.
 */
function parentOf(entries, model, i) {
  const e = entries[i];
  const start = model.bars[i].start;
  const before = (k) => k !== i && (start == null || model.bars[k].start == null ? k < i : model.bars[k].start <= start);
  const iu = e._initiator?.url;
  let best = -1;
  if (iu) {
    entries.forEach((x, k) => {
      if (x.request?.url === iu && before(k) && (best < 0 || (model.bars[k].start ?? -1) >= (model.bars[best].start ?? -1))) best = k;
    });
    if (best >= 0) return best;
  }
  const url = e.request?.url;
  entries.forEach((x, k) => {
    const to = x.response?.redirectURL;
    if (to && absolute(to, x.request?.url) === url && before(k)) best = k;
  });
  return best;
}

/** The requests that led to LCP: the initiator chain to the LCP resource (or the document for text), plus render-blocking requests that finished first. */
export function lcpPath(reading) {
  const log = reading?.log || {};
  const entries = log.entries || [];
  const v = log._harplus?.plugins?.vitals?.data || {};
  const ms = num(v.lcp?.time);
  if (!(ms >= 0) || !entries.length) return null;
  const model = timelineModel(reading);
  const t = log._harplus?.target || {};
  const docUrl = t.finalUrl || t.url;
  let doc = entries.findIndex((e) => resourceType(e) === 'document' && e.request?.url === docUrl);
  if (doc < 0) doc = entries.findIndex((e) => resourceType(e) === 'document');
  if (doc < 0) doc = 0;
  const url = v.lcp.url;
  let target = -1;
  if (url) {
    target = entries.findIndex((e) => e.request?.url === url && okStatus(e));
    if (target < 0) target = entries.findIndex((e) => e.request?.url === url);
  }
  const kind = target >= 0 ? 'resource' : 'text';
  const missing = Boolean(url) && target < 0;
  const hops = [];
  if (kind === 'resource') {
    const seen = new Set();
    for (let cur = target; cur >= 0 && !seen.has(cur) && hops.length < MAX_HOPS; cur = parentOf(entries, model, cur)) {
      seen.add(cur);
      hops.unshift(cur);
    }
  } else hops.push(doc);
  const lcpAt = model.markers.find((m) => m.key === 'lcp')?.at ?? ms;
  const rb = Array.isArray(v.renderBlocking) ? v.renderBlocking : [];
  const blocking = [];
  const seenUrl = new Set();
  entries.forEach((e, i) => {
    const u = e.request?.url;
    if (!rb.includes(u) || seenUrl.has(u) || hops.includes(i)) return;
    seenUrl.add(u);
    const b = model.bars[i];
    if (b.start != null && b.start + Math.max(0, num(e.time) || 0) <= lcpAt) blocking.push(i);
  });
  const label = missing ? 'LCP resource not in the request list'
    : kind === 'resource' ? fileName(entries[target].request.url)
      : `text${v.lcp.element ? ` (${v.lcp.element})` : ''}`;
  return { kind, ms, label, hops, blocking, missing };
}

/** One line naming each hop and its time, for the summary above the table. */
export function pathSummary(reading, path, visible) {
  if (!path) return '';
  const entries = reading?.log?.entries || [];
  const name = (i) => (resourceType(entries[i]) === 'document' ? 'document' : fileName(entries[i].request?.url));
  const hidden = (i) => (visible && !visible.has(i) ? ' (hidden by filter)' : '');
  const hop = (i) => `${name(i)} ${formatMs(entries[i].time)}${hidden(i)}`;
  const n = path.blocking.length;
  if (path.kind === 'resource') {
    return `LCP ${formatMs(path.ms)} — ${path.label}, reached in ${path.hops.length} hop${path.hops.length === 1 ? '' : 's'}: ${path.hops.map(hop).join(' → ')}${n ? ` (+${n} render-blocking)` : ''}`;
  }
  return `LCP ${formatMs(path.ms)} — ${path.label}: ${path.hops.map(hop).join(' → ')}${n ? ` + ${n} render-blocking (${path.blocking.map(name).join(', ')})` : ''}`;
}

/* ------------------------------------------------------------ site groups */

/** Third-party sites with 2+ rows collapse into one group, placed where their first row was; everything else passes through. */
export function groupRows(rows, site, model) {
  const keyOf = (r) => { const h = hostOf(r.e.request?.url); return h && isThirdParty(h, site) ? siteOf(h) : null; };
  const buckets = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const out = [];
  const placed = new Set();
  for (const r of rows) {
    const k = keyOf(r);
    const members = k ? buckets.get(k) : null;
    if (!members || members.length < 2) { out.push(r); continue; }
    if (placed.has(k)) continue;
    placed.add(k);
    let start = Infinity, end = -Infinity;
    for (const m of members) {
      const s = model.bars[m.i]?.start;
      if (s == null) continue;
      start = Math.min(start, s);
      end = Math.max(end, s + Math.max(0, num(m.e.time) || 0));
    }
    if (!Number.isFinite(start)) { start = 0; end = 0; }
    out.push({ group: k, rows: members, count: members.length, bytes: members.reduce((t, m) => t + transferSize(m.e), 0), start, end });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/waterfall.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS with 0 failures (512 plus the new tests).

- [ ] **Step 6: Commit**

```bash
git add extension/ui/waterfall.js test/waterfall.test.mjs
git commit -m "Waterfall: LCP path through initiators and redirects, path summary, third-party site groups

Co-Authored-By: <the model that wrote it> <noreply@anthropic.com>"
```

---

### Task 2: Zoom window, clamping and overview lanes (pure)

**Files:**
- Modify: `extension/ui/waterfall.js` (`niceTicks` and `timelineModel`, plus appended functions)
- Test: `test/waterfall.test.mjs`

**Interfaces:**
- **Consumes:** the existing `timelineModel`, `niceTicks` and `phaseSegments`.
- **Produces:**
  - `timelineModel(reading, view?: {from, to})` returns `{ t0, span, window: {from, to}, ticks: [{ms, left}], markers: [{key, label, ms, at, left}], bars: [{start, end, left, width, segments, known, clipStart, clipEnd}], place(startMs, endMs) → {left, width, clipStart, clipEnd} }`.
    - `span` is always the whole load.
    - With no `view`, the window is `{from: 0, to: span}`, and every existing field keeps its current value.
  - `MIN_WINDOW = 10`.
  - `clampWindow(w, span) → {from, to}`.
  - `zoomAt(w, centerMs, factor, span) → {from, to}`.
  - `isZoomed(w, span) → boolean`.
  - `overviewLanes(model, laneCount = 12) → Array<{i, lane, left, width}>`, laid out on the whole-load span.

- [ ] **Step 1: Write the failing tests**

Add `clampWindow, zoomAt, isZoomed, overviewLanes, MIN_WINDOW` to the import list. Append:

```js
/* ------------------------------------------------------------ zoom window */

test('clampWindow: inside the span, at least MIN_WINDOW wide, NaN → whole load', () => {
  assert.deepEqual(clampWindow({ from: 100, to: 300 }, 1000), { from: 100, to: 300 });
  assert.deepEqual(clampWindow({ from: -50, to: 200 }, 1000), { from: 0, to: 250 });
  assert.deepEqual(clampWindow({ from: 900, to: 1200 }, 1000), { from: 700, to: 1000 });
  assert.deepEqual(clampWindow({ from: 500, to: 502 }, 1000), { from: 500, to: 500 + MIN_WINDOW });
  assert.deepEqual(clampWindow({ from: NaN, to: 5 }, 1000), { from: 0, to: 1000 });
  assert.deepEqual(clampWindow({ from: 300, to: 100 }, 1000), { from: 0, to: 1000 });
  assert.deepEqual(clampWindow(null, 0), { from: 0, to: 1 });
});

test('zoomAt keeps the point under the pointer fixed; isZoomed', () => {
  assert.deepEqual(zoomAt({ from: 0, to: 1000 }, 250, 0.5, 1000), { from: 125, to: 625 });
  assert.deepEqual(zoomAt({ from: 125, to: 625 }, 250, 2, 1000), { from: 0, to: 1000 });
  assert.equal(isZoomed({ from: 0, to: 1000 }, 1000), false);
  assert.equal(isZoomed({ from: 10, to: 1000 }, 1000), true);
});

test('timelineModel with a window: percentages of the window, clip flags, ticks and markers inside it', () => {
  const r = reading([entry(), entry({ startedDateTime: '2026-10-19T10:00:00.200Z', time: 300 })]);
  const m = timelineModel(r, { from: 250, to: 450 });
  assert.equal(m.span, 900, 'span is still the whole load');
  assert.deepEqual(m.window, { from: 250, to: 450 });
  const b = m.bars[1];
  assert.deepEqual([b.left, b.width, b.clipStart, b.clipEnd], [0, 100, true, true]);
  assert.deepEqual([m.bars[0].width, m.bars[0].clipEnd], [0, false], 'the first bar ends before the window');
  assert.ok(m.ticks.every((t) => t.ms >= 250 && t.ms <= 450 && t.left >= 0 && t.left <= 100));
  assert.deepEqual(m.markers.map((x) => x.key), ['dcl'], 'only DOMContentLoaded (400) is inside');
  assert.equal(m.markers[0].left, 75);
  assert.deepEqual(m.place(300, 350), { left: 25, width: 25, clipStart: false, clipEnd: false });
});

test('a window that contains no request start (Review Focus 3): zero widths, no NaN or negatives', () => {
  const r = reading([entry(), entry({ startedDateTime: '2026-10-19T10:00:00.200Z', time: 300 })]);
  const m = timelineModel(r, { from: 600, to: 700 });
  for (const b of m.bars) assert.ok(Number.isFinite(b.left) && b.width >= 0 && Number.isFinite(b.width), JSON.stringify(b));
  assert.deepEqual(m.bars.map((b) => b.width), [0, 0]);
});

test('timelineModel without a window is unchanged; bars carry their end in ms', () => {
  const r = reading([entry(), entry({ startedDateTime: '2026-10-19T10:00:00.200Z', time: 300 })]);
  const m = timelineModel(r);
  assert.deepEqual(m.window, { from: 0, to: 900 });
  assert.deepEqual([m.bars[1].left, m.bars[1].width, m.bars[1].end, m.bars[1].clipStart], [22.22, 33.33, 500, false]);
});

test('overviewLanes packs bars into the first free lane, then the one that frees soonest', () => {
  const es = [0, 10, 20, 200].map((s) => entry({ startedDateTime: new Date(Date.parse('2026-10-19T10:00:00.000Z') + s).toISOString(), time: 100 }));
  const lanes = overviewLanes(timelineModel(reading(es)), 2);
  assert.deepEqual(lanes.map((l) => [l.i, l.lane]), [[0, 0], [1, 1], [2, 0], [3, 0]]);
  assert.ok(lanes.every((l) => l.left >= 0 && l.width >= 0));
  const many = Array.from({ length: 5000 }, (_, k) => entry({ startedDateTime: new Date(Date.parse('2026-10-19T10:00:00.000Z') + k).toISOString(), time: 30 }));
  const t0 = performance.now();
  overviewLanes(timelineModel(reading(many)), 12);
  assert.ok(performance.now() - t0 < 50 * 3);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/waterfall.test.mjs`
Expected: FAIL with `does not provide an export named 'clampWindow'`.

- [ ] **Step 3: Write the implementation**

In `extension/ui/waterfall.js`, replace `niceTicks` with the version below. It keeps the same export and results, and adds a `from` offset:

```js
const niceStep = (width) => {
  const raw = width / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
};

/** Round ruler ticks: a 1, 2, 2.5 or 5 × 10^n step giving four to six ticks across [from, to]. */
export function niceTicks(to, from = 0) {
  const width = to - from;
  if (!(width > 0)) return [from > 0 ? from : 0];
  const step = niceStep(width);
  const out = [];
  for (let k = Math.ceil((from - 1e-9) / step); k * step <= to + 1e-9; k++) out.push(Math.round(k * step * 1000) / 1000);
  return out;
}
```

Replace the whole `timelineModel` function with:

```js
/**
 * Everything the waterfall draws. `span` is the whole load (the last request end or the last marker); `view`
 * ({from, to} in ms) zooms the drawing to a window of it: percentages are of the window, bars crossing an edge
 * are clipped and flagged, ticks and markers outside are dropped.
 */
export function timelineModel(reading, view) {
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
  const win = view ? clampWindow(view, span) : { from: 0, to: span };
  const width = win.to - win.from;
  const rawPct = (ms) => Math.max(0, Math.min(100, ((ms - win.from) / width) * 100));
  const pct = (ms) => round2(rawPct(ms));
  // Width from the unrounded edges, so an unclipped bar keeps exactly the width it had before windows existed (33.33, not 33.34).
  const place = (a, b) => ({
    left: pct(a), width: round2(Math.max(0, rawPct(b) - rawPct(a))),
    clipStart: a < win.from && b > win.from, clipEnd: b > win.to && a < win.to,
  });
  const bars = entries.map((e, i) => {
    const { segments, known } = phaseSegments(e.timings, e.time);
    const ok = Number.isFinite(rel[i]);
    if (!ok) return { start: null, end: null, left: 0, width: 0, segments, known: false, clipStart: false, clipEnd: false };
    const end = rel[i] + Math.max(0, num(e.time) || 0);
    const p = place(rel[i], end);
    return { start: rel[i], end, left: p.left, width: known ? p.width : 0, segments, known, clipStart: known && p.clipStart, clipEnd: known && p.clipEnd };
  });
  return {
    t0, span, window: win, place,
    ticks: niceTicks(win.to, win.from).map((ms) => ({ ms, left: pct(ms) })),
    markers: markers.filter((m) => m.at >= win.from && m.at <= win.to).map((m) => ({ ...m, left: pct(m.at) })),
    bars,
  };
}
```

Append to the end of the file:

```js
/* ------------------------------------------------------------ zoom window */

export const MIN_WINDOW = 10;

/** A window inside [0, span], at least MIN_WINDOW wide (or the whole span when it is shorter); anything invalid → the whole load. */
export function clampWindow(w, span) {
  const S = num(span) > 0 ? span : 1;
  const from = num(w?.from);
  const to = num(w?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return { from: 0, to: S };
  const width = Math.min(S, Math.max(MIN_WINDOW, to - from));
  const f = Math.max(0, Math.min(from, S - width));
  return { from: f, to: f + width };
}

/** Zoom by `factor` (< 1 zooms in) keeping `center` (ms) at the same place on screen. */
export function zoomAt(w, center, factor, span) {
  const cur = clampWindow(w, span);
  const width = (cur.to - cur.from) * factor;
  const frac = (center - cur.from) / (cur.to - cur.from);
  const from = center - frac * width;
  return clampWindow({ from, to: from + width }, span);
}

export const isZoomed = (w, span) => Boolean(w) && (w.from > 0 || w.to < span);

/** Bars for the overview strip, on the whole-load span: each in the first lane free at its start, else the lane that frees soonest. */
export function overviewLanes(model, laneCount = 12) {
  const ends = Array(laneCount).fill(-Infinity);
  const out = [];
  const order = model.bars.map((b, i) => [b, i]).filter(([b]) => b.start != null).sort((a, b) => a[0].start - b[0].start || a[1] - b[1]);
  for (const [b, i] of order) {
    let lane = ends.findIndex((x) => x <= b.start);
    if (lane < 0) lane = ends.indexOf(Math.min(...ends));
    ends[lane] = b.end;
    out.push({ i, lane, left: round2((b.start / model.span) * 100), width: round2(((b.end - b.start) / model.span) * 100) });
  }
  return out;
}
```

The `overviewLanes` test expects lanes `[[0,0],[1,1],[2,0],[3,0]]` with 2 lanes:
- bar 0 runs 0–100 and takes lane 0;
- bar 1 runs 10–110 and takes lane 1;
- bar 2 runs 20–120; both lanes are busy, so it takes the lane that frees soonest, which is lane 0 (free at 100), and lane 0 now ends at 120;
- bar 3 runs 200–300; lane 0 is free (120 ≤ 200), so it takes lane 0.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/waterfall.test.mjs`
Expected: PASS. That includes all of Task 1's tests and the earlier batch's tests: no-window results are unchanged, and `niceTicks(37)`, `niceTicks(960)` and so on still give the same arrays.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS with 0 failures. `report.js` calls `timelineModel(reading)` with no window, so it keeps working.

- [ ] **Step 6: Commit**

```bash
git add extension/ui/waterfall.js test/waterfall.test.mjs
git commit -m "Waterfall: zoom window in the timeline model, clamping, zoom around a point, overview lanes

Co-Authored-By: <the model that wrote it> <noreply@anthropic.com>"
```

---

### Task 3: Render the path, groups, overview strip and pinned header

**Files:**
- Modify: `extension/ui/report.js` (the `waterfall.js` import, `networkTable`)
- Modify: `extension/ui/theme.css` (the `.net` block, the print block)
- Test: `test/report.test.mjs`

**Interfaces:**
- **Consumes:** `lcpPath`, `pathSummary`, `groupRows`, `overviewLanes`, `isZoomed`, and `timelineModel(reading, view)` with `place()`, all from Tasks 1 and 2.
- **Produces:** `networkTable(reading, rows, { limit, sort, interactive = true, window = null, path = null, groups = false, openGroups = new Set() })`. Only when `interactive` is true, it renders these at the top:
  - a `.wf-bar` holding `<button type="button" class="tog" data-wf-path aria-pressed>◆ LCP path</button>`, which is `disabled` with `title="No LCP recorded for this reading"` when `lcpPath(reading)` is null;
  - `<button type="button" class="tog" data-wf-groups aria-pressed>Group by site</button>`;
  - `<div class="wf-overview" id="wf-overview" data-span="…">`, holding `.ov-lanes` and `.ov-brush`, which has two `span.ov-h[role="slider"][data-edge="from|to"]`;
  - `<span id="wf-zoom-text">Showing …</span>`;
  - `<button type="button" data-wf-reset>Reset zoom</button>`.

  Other markup it produces:
  - When `path` is given: `<p class="lcp-sum">…</p>`. Rows get `on-path` or `off-path`, and blocking rows get `<span class="rb-tag">blocks render</span>`.
  - When `groups` is true: group rows `<tr class="grp[ on-path|off-path]" data-group="site">` with `button.disclose.grp-disc[aria-expanded]`. Members, when the group is open, are `<tr data-entry class="grp-member …">`.
  - Clipped bars get `clip-s` and/or `clip-e`, plus `<i class="clip-cue s|e">◂|▸</i>`.
  - The table wrapper is `div.table-wrap.net.scroll` when interactive.

- [ ] **Step 1: Write the failing tests**

Add `lcpPath` to a new import line in `test/report.test.mjs`: `import { lcpPath } from '../extension/ui/waterfall.js';`. Then append:

```js
test('interactive table: path and group toggles, overview strip with slider handles, reset disabled when not zoomed', () => {
  const r = load();
  const out = String(networkTable(r, allRows(r)));
  assert.match(out, /<button type="button" class="tog" data-wf-path aria-pressed="false">◆ LCP path<\/button>/);
  assert.match(out, /data-wf-groups aria-pressed="false">Group by site</);
  assert.match(out, /id="wf-overview" data-span="\d+(\.\d+)?"/);
  assert.equal(out.match(/role="slider"/g).length, 2);
  assert.match(out, /aria-label="Zoom start" aria-valuemin="0"/);
  assert.match(out, /<button type="button" data-wf-reset disabled>Reset zoom<\/button>/);
  assert.match(out, /class="table-wrap net scroll"/);
  delete r.log._harplus.plugins.vitals.data.lcp;
  assert.match(String(networkTable(r, allRows(r))), /data-wf-path aria-pressed="false" disabled title="No LCP recorded for this reading"/);
});

test('LCP path: summary line, off-path rows dimmed, render-blocking tagged', () => {
  const r = load();
  const path = lcpPath(r);
  const out = String(networkTable(r, allRows(r), { path }));
  assert.match(out, /<p class="lcp-sum">LCP \d+ ms — text \(main\)/);
  assert.match(out, /data-wf-path aria-pressed="true"/);
  assert.ok((out.match(/class="off-path"/g) || []).length > 0, 'rows off the path are dimmed');
  assert.ok((out.match(/class="on-path"/g) || []).length >= 1 + path.blocking.length);
  if (path.blocking.length) assert.match(out, /<span class="rb-tag">blocks render<\/span>/);
});

test('groups: a third-party site collapses to one row; open shows members; a path member lights the group (Review Focus 1)', () => {
  const r = load();
  const closed = String(networkTable(r, allRows(r), { groups: true }));
  assert.match(closed, /<tr class="grp" data-group="localhost">/);
  assert.match(closed, /aria-label="Show 5 requests from localhost"/);
  assert.match(closed, /<td>5 requests<\/td>/);
  assert.doesNotMatch(closed, /grp-member/);
  const open = String(networkTable(r, allRows(r), { groups: true, openGroups: new Set(['localhost']) }));
  assert.equal((open.match(/grp-member/g) || []).length, 5);
  assert.match(open, /class="disclose grp-disc" aria-expanded="true"/);
  const path = lcpPath(r);
  const lh = r.log.entries.findIndex((e) => e.request.url.includes('localhost'));
  path.blocking.push(lh);
  assert.match(String(networkTable(r, allRows(r), { groups: true, path })), /<tr class="grp on-path" data-group="localhost">/);
});

test('zoom: bars crossing the window are clipped with cues; reset enabled; window text', () => {
  const r = load();
  const span = Number(String(networkTable(r, allRows(r))).match(/data-span="([\d.]+)"/)[1]);
  const out = String(networkTable(r, allRows(r), { window: { from: span * 0.2, to: span * 0.3 } }));
  assert.match(out, /<button type="button" data-wf-reset>Reset zoom<\/button>/);
  assert.match(out, /id="wf-zoom-text">Showing \d+ ms–\d+ ms of /);
  assert.doesNotMatch(out, /NaN|undefined|Infinity/);
  const r2 = load();
  const s2 = Number(String(networkTable(r2, allRows(r2))).match(/data-span="([\d.]+)"/)[1]);
  const first = Date.parse(r2.log.entries[0].startedDateTime) - Date.parse(r2.log.pages[0].startedDateTime);
  const clipped = String(networkTable(r2, allRows(r2), { window: { from: first + 0.1, to: s2 } }));
  assert.match(clipped, /class="bar clip-s"|class="bar none"/);
});

test('standalone export: no toolbar, strip, brush, dimming or scroll box', () => {
  const doc = standaloneDocument(load(), getPlugins(), { css: '' });
  const net = doc.slice(doc.indexOf('id="net-table"'));
  assert.doesNotMatch(net, /wf-overview|data-wf-path|data-wf-groups|role="slider"|off-path|class="table-wrap net scroll"/);
});

test('networkTable with toggles and a window renders 5,000 rows quickly', () => {
  const r = load();
  const base = r.log.entries;
  r.log.entries = Array.from({ length: 5000 }, (_, k) => structuredClone(base[k % base.length]));
  const rows = allRows(r);
  const t0 = performance.now();
  networkTable(r, rows, { groups: true, path: lcpPath(r), window: { from: 1, to: 10 } });
  assert.ok(performance.now() - t0 < 50 * 4, 'one re-render well within budget (4× slack for CI)');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/report.test.mjs`
Expected: FAIL, because `data-wf-path` is not in the output.

- [ ] **Step 3: Implement in `extension/ui/report.js`**

Change the `waterfall.js` import to:

```js
import { PHASES, phaseSegments, timelineModel, sortRows, midTrunc, requestFacts, wireText, lcpPath, pathSummary, groupRows, overviewLanes, isZoomed } from './waterfall.js';
```

Replace `networkTable` with the version below. `NET_PAGE`, `statusClass`, `NET_COLUMNS`, `fmtN`, `ariaSort`, `sortMark`, `phaseLabel` and `barTip` stay exactly as they are.

```js
const OV_LANES = 12;

function overviewStrip(reading, model, full, path) {
  const onPath = new Set(path ? [...path.hops, ...path.blocking] : []);
  const w = model.window;
  const span = full.span;
  const pctOf = (ms) => Math.round((ms / span) * 10000) / 100;
  const handle = (edge, label, value) => html`<span class="ov-h" role="slider" tabindex="0" data-edge="${edge}" aria-label="${label}" aria-valuemin="0" aria-valuemax="${Math.round(span)}" aria-valuenow="${Math.round(value)}" aria-valuetext="${formatMs(value)}"></span>`;
  return html`<div class="wf-overview" id="wf-overview" data-span="${Math.round(span * 1000) / 1000}">
      <div class="ov-lanes" aria-hidden="true">${overviewLanes(full, OV_LANES).map((l) => html`<i class="${onPath.has(l.i) ? 'p' : ''}" style="left:${l.left}%;width:${l.width}%;top:${4 + l.lane * 3.5}px"></i>`)}</div>
      <div class="ov-brush" style="left:${pctOf(w.from)}%;width:${pctOf(w.to - w.from)}%">${handle('from', 'Zoom start', w.from)}${handle('to', 'Zoom end', w.to)}</div>
    </div>
    <p class="wf-zoom"><span id="wf-zoom-text">Showing ${formatMs(w.from)}–${formatMs(w.to)} of ${formatMs(span)}</span>
      <button type="button" data-wf-reset${isZoomed(w, span) ? '' : raw(' disabled')}>Reset zoom</button></p>`;
}

export function networkTable(reading, rows, { limit = NET_PAGE, sort = { key: 'index', dir: 'asc' }, interactive = true, window = null, path = null, groups = false, openGroups = new Set() } = {}) {
  const entries = reading.log.entries;
  if (!entries.length) return html`<p class="muted">No requests recorded.</p>`;
  const site = hp(reading).target?.site;
  // The export and print have no JavaScript: always the whole load, no path, no groups.
  if (!interactive) { window = null; path = null; groups = false; }
  const full = timelineModel(reading);
  const model = window ? timelineModel(reading, window) : full;
  const sorted = sortRows(rows, sort.key, sort.dir);
  const items = (groups ? groupRows(sorted, site, full) : sorted).slice(0, limit);
  const total = groups ? groupRows(sorted, site, full).length : sorted.length;
  const onPath = path ? new Set([...path.hops, ...path.blocking]) : null;
  const blocking = new Set(path ? path.blocking : []);
  const pathClass = (on) => (onPath ? (on ? 'on-path' : 'off-path') : '');
  const shownEntries = items.flatMap((x) => (x.group ? (openGroups.has(x.group) ? x.rows : []) : [x]));
  const present = new Set(shownEntries.flatMap(({ i }) => (model.bars[i].known ? model.bars[i].segments.map((s) => s.key) : [])));
  const bytes = rows.reduce((t, { e }) => t + transferSize(e), 0);
  const third = rows.filter(({ e }) => isThirdParty(hostOf(e.request.url), site)).length;
  const lines = html`${model.ticks.slice(1).map((t) => html`<i class="gl" style="left:${t.left}%"></i>`)}${model.markers.map((m) => html`<i class="mk mk-${m.key}" style="left:${m.left}%"></i>`)}`;
  const cues = (p) => html`${p.clipStart ? html`<i class="clip-cue s" aria-hidden="true">◂</i>` : ''}${p.clipEnd ? html`<i class="clip-cue e" aria-hidden="true">▸</i>` : ''}`;
  const clipCls = (p) => `${p.clipStart ? ' clip-s' : ''}${p.clipEnd ? ' clip-e' : ''}`;
  const lcpOk = Boolean(lcpPath(reading));

  const entryRow = ({ e, i }, member) => {
    const host = hostOf(e.request.url);
    let p = e.request.url;
    try { const u = new URL(e.request.url); p = u.pathname + u.search; } catch { /* keep raw */ }
    const b = model.bars[i];
    const size = transferSize(e);
    const cls = [member ? 'grp-member' : '', pathClass(onPath?.has(i))].filter(Boolean).join(' ');
    return html`<tr data-entry="${i}"${cls ? raw(` class="${cls}"`) : ''}>
      ${interactive ? html`<td class="disc"><button type="button" class="disclose" aria-expanded="false" aria-controls="ed-${i}" aria-label="Details for request ${i + 1}">▸</button></td>` : ''}
      <td class="num">${i + 1}</td>
      <td><span class="st-chip ${statusClass(e)}">${e._error ? 'ERR' : e.response.status || '—'}</span></td>
      <td>${e.request.method}</td>
      <td>${resourceType(e)}</td>
      <td class="url${isThirdParty(host, site) ? ' third' : ''}" title="${e.request.url}">${midTrunc(host + p, 64)}${blocking.has(i) ? html` <span class="rb-tag">blocks render</span>` : ''}</td>
      <td class="num" data-bytes="${size}">${formatBytes(size)}</td>
      <td class="num">${formatMs(e.time)}</td>
      <td class="tl"><div class="wf">${lines}${cues(b)}<span class="bar${b.known ? '' : ' none'}${clipCls(b)}" style="left:${b.left}%;width:${b.width}%" title="${barTip(b)}">${b.known ? b.segments.map((s) => html`<i class="ph-${s.key}" style="flex:${s.ms}"></i>`) : ''}</span></div></td>
    </tr>`;
  };

  const groupRow = (g) => {
    const open = openGroups.has(g.group);
    const p = model.place(g.start, g.end);
    const cls = ['grp', pathClass(g.rows.some((m) => onPath?.has(m.i)))].filter(Boolean).join(' ');
    return html`<tr class="${cls}" data-group="${g.group}">
      <td class="disc"><button type="button" class="disclose grp-disc" aria-expanded="${String(open)}" aria-label="Show ${g.count} requests from ${g.group}">${open ? '▾' : '▸'}</button></td>
      <td class="num"></td><td></td><td></td>
      <td>${fmtN(g.count)} requests</td>
      <td class="url third">${g.group}</td>
      <td class="num" data-bytes="${g.bytes}">${formatBytes(g.bytes)}</td>
      <td class="num">${formatMs(g.end - g.start)}</td>
      <td class="tl"><div class="wf">${lines}${cues(p)}<span class="bar grp-bar${clipCls(p)}" style="left:${p.left}%;width:${p.width}%" title="${g.group}: ${fmtN(g.count)} requests, ${formatMs(g.start)}–${formatMs(g.end)}"></span></div></td>
    </tr>${open ? g.rows.map((m) => entryRow(m, true)) : ''}`;
  };

  const toolbar = interactive ? html`<div class="wf-bar">
      <button type="button" class="tog" data-wf-path aria-pressed="${String(Boolean(path))}"${lcpOk ? '' : raw(' disabled title="No LCP recorded for this reading"')}>◆ LCP path</button>
      <button type="button" class="tog" data-wf-groups aria-pressed="${String(groups)}">Group by site</button>
    </div>
    ${overviewStrip(reading, model, full, path)}` : '';

  return html`${toolbar}
    <p class="note">${fmtN(rows.length)} of ${fmtN(entries.length)} requests · ${formatBytes(bytes)} transferred · ${fmtN(third)} third-party · span ${formatMs(full.span)}</p>
    ${path ? html`<p class="lcp-sum">${pathSummary(reading, path, new Set(rows.map((r) => r.i)))}</p>` : ''}
    <p class="wf-legend">${PHASES.filter((ph) => present.has(ph.key)).map((ph) => html`<span><i class="sw ph-${ph.key}"></i>${ph.label}</span>`)}${model.markers.map((m) => html`<span><i class="mk-key mk-${m.key}"></i>${m.label} ${formatMs(m.ms)}</span>`)}<span class="third">amber name = third-party</span></p>
    <div class="table-wrap net${interactive ? ' scroll' : ''}"><table class="data">
      <thead><tr>${interactive ? html`<th scope="col"><span class="sr-only">Details</span></th>` : ''}${NET_COLUMNS.map(([key, label]) => (key && interactive
        ? html`<th scope="col" aria-sort="${ariaSort(sort, key)}"><button type="button" class="sort" data-sort="${key}">${label}${sortMark(sort, key)}</button></th>`
        : html`<th scope="col">${label}</th>`))}
        ${interactive
          ? html`<th scope="col" class="tl-head" aria-sort="${ariaSort(sort, 'start')}"><button type="button" class="sort" data-sort="start">Timeline${sortMark(sort, 'start')}</button>`
          : html`<th scope="col" class="tl-head"><span class="tl-label">Timeline</span>`}
          <div class="ruler" aria-hidden="true">${model.ticks.map((t) => html`<span style="left:${t.left}%">${formatMs(t.ms)}</span>`)}</div></th></tr></thead>
      <tbody>${items.map((x) => (x.group ? groupRow(x) : entryRow(x, false)))}</tbody>
    </table></div>
    ${total > items.length ? html`<p class="note net-more">Showing ${fmtN(items.length)} of ${fmtN(total)} · <button type="button" data-net-more>Show ${fmtN(Math.min(NET_PAGE, total - items.length))} more</button></p>` : ''}`;
}
```

- **Show more test:** the earlier "Show more" test expects exactly 200 `<tr data-entry=`. It still holds, because with `groups` off the items are the sorted rows.
- **Class attributes:** `class="off-path"` and `class="on-path"` come from `raw(` class="…"`)`. The test regexes look for exactly `class="off-path"` and `class="on-path"`, which is what a non-member row produces.

- [ ] **Step 4: Add the styles in `extension/ui/theme.css`**

Append inside the same layer block as the existing `.net` rules, after `.req-detail .w-h`:

```css
  .wf-bar { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.25rem 0 0.4rem; }
  .wf-bar .tog { border: 1px solid var(--line); border-radius: 999px; padding: 0.15rem 0.7rem; background: var(--panel); color: var(--muted); font-weight: 600; cursor: pointer; }
  .wf-bar .tog[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .wf-bar .tog:disabled { opacity: 0.5; cursor: not-allowed; }
  .wf-bar .tog:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .wf-overview { position: relative; height: 48px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 4px; cursor: crosshair; touch-action: none; user-select: none; }
  .wf-overview .ov-lanes i { position: absolute; height: 3px; min-width: 1px; border-radius: 1px; background: var(--ph-receive); }
  .wf-overview .ov-lanes i.p { background: var(--c7); }
  .wf-overview .ov-brush { position: absolute; top: -1px; bottom: -1px; border: 2px solid var(--accent); border-radius: 4px; background: color-mix(in srgb, var(--accent) 10%, transparent); cursor: grab; min-width: 4px; }
  .wf-overview .ov-h { position: absolute; top: 12px; width: 8px; height: 22px; border-radius: 2px; background: var(--accent); cursor: ew-resize; }
  .wf-overview .ov-h[data-edge="from"] { inset-inline-start: -5px; }
  .wf-overview .ov-h[data-edge="to"] { inset-inline-end: -5px; }
  .wf-overview .ov-h:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
  .wf-zoom { display: flex; gap: 0.6rem; align-items: center; font-size: 0.8rem; color: var(--muted); margin: 0.25rem 0; }
  .wf-zoom button { border: 1px solid var(--line); border-radius: 4px; background: var(--panel); padding: 0 0.5rem; cursor: pointer; }
  .wf-zoom button:disabled { opacity: 0.5; cursor: default; }
  .lcp-sum { padding: 0.35rem 0.6rem; font-size: 0.85rem; border-radius: 4px; background: color-mix(in srgb, var(--c7) 10%, transparent); border: 1px solid color-mix(in srgb, var(--c7) 30%, transparent); }
  .net tr.off-path { opacity: 0.4; }
  .net tr.on-path .bar { outline: 2px solid var(--c7); outline-offset: 0; }
  .net .rb-tag { font-family: var(--font); font-size: 0.7rem; font-weight: 600; padding: 0 0.3rem; border-radius: 4px; color: var(--c7); background: color-mix(in srgb, var(--c7) 12%, transparent); }
  .net tr.grp td { background: color-mix(in srgb, var(--amber) 7%, transparent); font-weight: 600; }
  .net .wf .bar.grp-bar { outline: 1px dashed var(--amber); background: repeating-linear-gradient(90deg, color-mix(in srgb, var(--amber) 35%, transparent) 0 6px, color-mix(in srgb, var(--amber) 15%, transparent) 6px 12px); }
  .net tr.grp-member td.url { padding-inline-start: 1.5rem; }
  .net .wf .bar.clip-s { border-start-start-radius: 0; border-end-start-radius: 0; }
  .net .wf .bar.clip-e { border-start-end-radius: 0; border-end-end-radius: 0; }
  .net .wf .clip-cue { position: absolute; top: 0; font-size: 0.65rem; line-height: 1.1rem; color: var(--muted); font-style: normal; }
  .net .wf .clip-cue.s { inset-inline-start: 0; } .net .wf .clip-cue.e { inset-inline-end: 0; }
  .table-wrap.net.scroll { max-height: 75vh; overflow: auto; }
  .table-wrap.net.scroll thead th { position: sticky; top: 0; z-index: 1; background: var(--panel-2); }
```

In the `@media print` block, add:

```css
    .table-wrap.net.scroll { max-height: none; overflow: visible; }
    .wf-bar, .wf-overview, .wf-zoom { display: none !important; }
```

- [ ] **Step 5: Run the report tests, then the full suite**

Run: `node --test test/report.test.mjs`
Expected: PASS. All the earlier waterfall report tests still pass.

Run: `npm test`
Expected: PASS with 0 failures.

- [ ] **Step 6: Commit**

```bash
git add extension/ui/report.js extension/ui/theme.css test/report.test.mjs
git commit -m "Network pane: LCP path dimming and summary, site group rows, overview strip with brush, clipped bars, pinned header

Co-Authored-By: <the model that wrote it> <noreply@anthropic.com>"
```

---

### Task 4: Interaction: toggles, groups, brush, ruler drag, wheel zoom

**Files:**
- Modify: `extension/ui/reading.js` (imports, `state`, `netTools`, `render`, `renderNetwork`, click, keydown and pointer handlers, plus a new wheel handler)
- Modify: `test/e2e/run.mjs` (the network section)
- Test: `test/e2e/run.mjs`

**Interfaces:**
- **Consumes:**
  - `networkTable` options and markup from Task 3: `[data-wf-path]`, `[data-wf-groups]`, `tr[data-group]`, `button.grp-disc`, `#wf-overview[data-span]`, `.ov-brush`, `.ov-h[data-edge]`, `#wf-zoom-text`, `[data-wf-reset]`, `.tl-head .ruler` and `td.tl`.
  - From `waterfall.js`: `lcpPath`, `clampWindow`, `zoomAt` and `timelineModel`.
- **Produces:** in-page behaviour.

- [ ] **Step 1: Write the failing e2e assertions**

In `test/e2e/run.mjs`, insert this block directly after the line `await page2.keyboard.press('Escape');` that ends the Review Focus 3 part of the Network section, before `// print shows every pane`:

```js
    // LCP path: dims rows off the path and names the LCP in a summary line.
    await page2.click('#net-table [data-wf-path]');
    assert.equal(await page2.locator('#net-table [data-wf-path]').getAttribute('aria-pressed'), 'true');
    assert.ok(await page2.locator('#net-table tr.off-path').count() > 0, 'off-path rows dimmed');
    assert.match(await page2.locator('#net-table .lcp-sum').innerText(), /^LCP \d+ ms — /);
    assert.equal(await page2.evaluate(() => document.activeElement?.hasAttribute('data-wf-path')), true, 'focus stays on the toggle');
    await page2.click('#net-table [data-wf-path]');
    assert.equal(await page2.locator('#net-table tr.off-path').count(), 0);
    // Group by site: localhost (third-party to 127.0.0.1) collapses; expanding shows its requests.
    await page2.click('#net-table [data-wf-groups]');
    const grp = page2.locator('#net-table tr[data-group]').first();
    assert.match(await grp.innerText(), /\d+ requests/);
    await grp.locator('button.grp-disc').click();
    assert.ok(await page2.locator('#net-table tr.grp-member').count() >= 2, 'members shown');
    assert.equal(await page2.locator('#net-table tr[data-group] button.grp-disc').first().getAttribute('aria-expanded'), 'true');
    await page2.click('#net-table [data-wf-groups]');
    // Overview brush: draw a window, the text changes and Reset is enabled; Reset returns to the whole load.
    const whole = await page2.locator('#wf-zoom-text').innerText();
    const ov = await page2.locator('#wf-overview').boundingBox();
    await page2.mouse.move(ov.x + ov.width * 0.02, ov.y + ov.height / 2);
    await page2.mouse.down();
    await page2.mouse.move(ov.x + ov.width * 0.4, ov.y + ov.height / 2, { steps: 5 });
    await page2.mouse.up();
    assert.notEqual(await page2.locator('#wf-zoom-text').innerText(), whole, 'brush zoomed the timeline');
    assert.equal(await page2.locator('[data-wf-reset]').isDisabled(), false);
    // Review Focus 2: filtering while zoomed keeps the window.
    const zoomed = await page2.locator('#wf-zoom-text').innerText();
    await page2.fill('#n-q', '127.0.0.1');
    assert.equal(await page2.locator('#wf-zoom-text').innerText(), zoomed, 'filter keeps the zoom');
    await page2.fill('#n-q', '');
    await page2.click('[data-wf-reset]');
    assert.equal(await page2.locator('#wf-zoom-text').innerText(), whole);
    // Keyboard on the end handle.
    const endH = page2.locator('#wf-overview .ov-h[data-edge="to"]');
    const before = Number(await endH.getAttribute('aria-valuenow'));
    await endH.focus();
    await page2.keyboard.press('Shift+ArrowLeft');
    const endAfter = page2.locator('#wf-overview .ov-h[data-edge="to"]');
    assert.ok(Number(await endAfter.getAttribute('aria-valuenow')) < before, 'ArrowLeft moved the end handle');
    assert.equal(await page2.evaluate(() => document.activeElement?.dataset.edge), 'to', 'focus stays on the handle');
    await page2.click('[data-wf-reset]');
    // Ctrl-wheel over the timeline zooms; over the summary line it does not (Review Focus 5).
    const tl = await page2.locator('#net-table tr[data-entry] td.tl').first().boundingBox();
    const noteBox = await page2.locator('#net-table p.note').first().boundingBox();
    await page2.mouse.move(noteBox.x + 5, noteBox.y + 5);
    await page2.keyboard.down('Control');
    await page2.mouse.wheel(0, -200);
    await page2.keyboard.up('Control');
    assert.equal(await page2.locator('#wf-zoom-text').innerText(), whole, 'Ctrl-wheel outside the timeline leaves the zoom alone');
    await page2.mouse.move(tl.x + tl.width * 0.2, tl.y + tl.height / 2);
    await page2.keyboard.down('Control');
    await page2.mouse.wheel(0, -200);
    await page2.keyboard.up('Control');
    await page2.waitForFunction((w) => document.getElementById('wf-zoom-text')?.textContent !== w, whole);
    await page2.click('[data-wf-reset]');
    // Pinned header: open a request so the box scrolls, scroll it, and the header stays at the top of the box.
    await page2.locator('#net-table tr[data-entry="0"] button.disclose').click();
    const pinned = await page2.evaluate(() => {
      const box = document.querySelector('#net-table .table-wrap.net');
      box.scrollTop = 200;
      return { scrolled: box.scrollTop, boxTop: box.getBoundingClientRect().top, headTop: box.querySelector('thead th').getBoundingClientRect().top };
    });
    assert.ok(pinned.scrolled > 0, 'the table box scrolls');
    assert.ok(Math.abs(pinned.headTop - pinned.boxTop) <= 2, `header pinned: ${JSON.stringify(pinned)}`);
    await page2.keyboard.press('Escape');
    await page2.screenshot({ path: join(OUT, 'reading-network-zoom.png') });
```

The pinned-header check needs the box to scroll. An open request detail is several hundred pixels tall, so with about 20 rows the 75vh box overflows at the 1280×800 viewport.

- [ ] **Step 2: Run e2e to verify it fails**

Run: `npm run test:e2e`
Expected: FAIL at `aria-pressed` being `'false'`, because the toggle is not wired.

- [ ] **Step 3: Implement in `extension/ui/reading.js`**

Add a `waterfall.js` import below the `report.js` import:

```js
import { lcpPath, clampWindow, zoomAt, timelineModel } from './waterfall.js';
```

Extend `state` (line 22) with:

```js
netPath: false, netGroups: false, netOpenGroups: new Set(), netWindow: null,
```

At the end of `netTools()`'s template, append a persistent live region:

```js
    <span id="wf-live" class="sr-only" aria-live="polite"></span>
```

Add these module-level helpers above `renderNetwork`:

```js
let netPathData = null; // lcpPath(reading), computed once per render()
let netSpan = 1;        // the whole-load span in ms
const announce = (text) => { const el = document.getElementById('wf-live'); if (el) el.textContent = text; };
const zoomText = () => document.getElementById('wf-zoom-text')?.textContent || '';
```

In `render()`, before `renderNetwork();`:

```js
  netPathData = lcpPath(reading);
  netSpan = timelineModel(reading).span;
  state.netWindow = null;
```

In `renderNetwork`, replace the `networkTable(...)` call with:

```js
  $('#net-table').innerHTML = String(networkTable(reading, rows, {
    limit: state.netLimit, sort: state.netSort,
    window: state.netWindow, path: state.netPath ? netPathData : null,
    groups: state.netGroups, openGroups: state.netOpenGroups,
  }));
```

Add a re-render helper that keeps focus on whatever matched a selector:

```js
function rerenderKeeping(selector) {
  renderNetwork();
  if (selector) document.querySelector(selector)?.focus();
}

function setWindow(w, { announceIt = true } = {}) {
  const next = clampWindow(w, netSpan);
  state.netWindow = next.from <= 0 && next.to >= netSpan ? null : next;
  renderNetwork();
  if (announceIt) announce(zoomText());
}
```

In the `click` handler, insert the following before the `const sortBtn = …` block:

```js
  if (t.closest('#net-table [data-wf-path]')) {
    state.netPath = !state.netPath;
    rerenderKeeping('#net-table [data-wf-path]');
    return;
  }
  if (t.closest('#net-table [data-wf-groups]')) {
    state.netGroups = !state.netGroups;
    state.netLimit = NET_PAGE;
    rerenderKeeping('#net-table [data-wf-groups]');
    return;
  }
  if (t.closest('#net-table [data-wf-reset]')) {
    setWindow(null);
    document.querySelector('#wf-overview .ov-h[data-edge="to"]')?.focus();
    return;
  }
  const grpRow = t.closest('#net-table tr[data-group]');
  if (grpRow) {
    const key = grpRow.dataset.group;
    if (state.netOpenGroups.has(key)) {
      state.netOpenGroups.delete(key);
      // Closing a group closes a request detail open inside it.
      if (state.netOpen != null && document.querySelector(`#net-table tr.grp-member[data-entry="${state.netOpen}"]`)) state.netOpen = null;
    } else state.netOpenGroups.add(key);
    rerenderKeeping(`#net-table tr[data-group="${CSS.escape(key)}"] button.grp-disc`);
    return;
  }
```

In the `keydown` handler, add this as the first branch, so the slider handles take arrows, Home and End:

```js
  if (t.matches?.('#wf-overview .ov-h') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
    const cur = state.netWindow || { from: 0, to: netSpan };
    const step = netSpan * (ev.shiftKey ? 0.1 : 0.01);
    const edge = t.dataset.edge;
    const v = ev.key === 'Home' ? 0 : ev.key === 'End' ? netSpan : cur[edge] + (ev.key === 'ArrowRight' ? step : -step);
    setWindow(edge === 'from' ? { from: Math.min(v, cur.to - 10), to: cur.to } : { from: cur.from, to: Math.max(v, cur.from + 10) });
    document.querySelector(`#wf-overview .ov-h[data-edge="${edge}"]`)?.focus();
    ev.preventDefault();
    return;
  }
```

Add the pointer handling for the strip and the ruler at module level, after the keydown listener:

```js
/* -------------------------------------------- overview brush and ruler drag */

let drag = null; // { kind: 'draw'|'pan'|'from'|'to'|'ruler', el, rect, startX, startWin }

const msAt = (rect, clientX, from, to) => from + Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * (to - from);

document.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const strip = ev.target.closest?.('#wf-overview');
  const ruler = ev.target.closest?.('#net-table .tl-head .ruler');
  if (!strip && !ruler) return;
  const el = strip || ruler;
  const rect = el.getBoundingClientRect();
  const cur = state.netWindow || { from: 0, to: netSpan };
  const handle = ev.target.closest('.ov-h');
  // Unzoomed, the brush covers the whole strip: dragging inside it must draw a new window, not pan a full-width one.
  const kind = ruler ? 'ruler' : handle ? handle.dataset.edge : state.netWindow && ev.target.closest('.ov-brush') ? 'pan' : 'draw';
  drag = { kind, el, rect, startX: ev.clientX, startWin: cur };
  el.setPointerCapture?.(ev.pointerId);
  ev.preventDefault();
});

document.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const { kind, rect, startX, startWin } = drag;
  const brush = document.querySelector('#wf-overview .ov-brush');
  let w;
  if (kind === 'ruler') return; // the ruler zooms on release
  if (kind === 'pan') {
    const dms = ((ev.clientX - startX) / rect.width) * netSpan;
    w = { from: startWin.from + dms, to: startWin.to + dms };
  } else if (kind === 'from' || kind === 'to') {
    const ms = msAt(rect, ev.clientX, 0, netSpan);
    w = kind === 'from' ? { from: Math.min(ms, startWin.to - 10), to: startWin.to } : { from: startWin.from, to: Math.max(ms, startWin.from + 10) };
  } else {
    const a = msAt(rect, startX, 0, netSpan), b = msAt(rect, ev.clientX, 0, netSpan);
    w = { from: Math.min(a, b), to: Math.max(a, b) };
  }
  drag.pending = clampWindow(w, netSpan);
  if (brush) { // move the brush without re-rendering the table on every pointer move
    brush.style.left = `${(drag.pending.from / netSpan) * 100}%`;
    brush.style.width = `${((drag.pending.to - drag.pending.from) / netSpan) * 100}%`;
  }
});

document.addEventListener('pointerup', (ev) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (Math.abs(ev.clientX - d.startX) < 4 && d.kind !== 'from' && d.kind !== 'to') return; // a click, not a drag
  if (d.kind === 'ruler') {
    const a = msAt(d.rect, d.startX, d.startWin.from, d.startWin.to), b = msAt(d.rect, ev.clientX, d.startWin.from, d.startWin.to);
    setWindow({ from: Math.min(a, b), to: Math.max(a, b) });
    return;
  }
  if (d.pending) setWindow(d.pending);
});

/* ------------------------------------------------------------ wheel zoom */

let wheelFrame = 0;
document.addEventListener('wheel', (ev) => {
  if (!(ev.ctrlKey || ev.metaKey)) return; // a plain wheel scrolls; Ctrl-wheel elsewhere keeps the browser's page zoom
  const strip = ev.target.closest?.('#wf-overview');
  const cell = ev.target.closest?.('#net-table td.tl, #net-table .tl-head');
  if (!strip && !cell) return;
  ev.preventDefault();
  const cur = state.netWindow || { from: 0, to: netSpan };
  const box = (strip || cell.querySelector('.wf, .ruler') || cell).getBoundingClientRect();
  const center = strip ? msAt(box, ev.clientX, 0, netSpan) : msAt(box, ev.clientX, cur.from, cur.to);
  const next = zoomAt(cur, center, ev.deltaY > 0 ? 1.2 : 1 / 1.2, netSpan);
  state.netWindow = next.from <= 0 && next.to >= netSpan ? null : next;
  cancelAnimationFrame(wheelFrame);
  wheelFrame = requestAnimationFrame(() => { renderNetwork(); announce(zoomText()); });
}, { passive: false });
```

The pointerdown handler calls `ev.preventDefault()`, which would stop the sort button's click if a drag started on it. The listener only runs inside `#wf-overview` and `.ruler`, and the ruler is a sibling of the sort button, not its parent, so sorting is unaffected.

- [ ] **Step 4: Run e2e to verify it passes**

Run: `npm run test:e2e`
Expected: `· all e2e checks passed`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS with 0 failures.

- [ ] **Step 6: Look at the result**

Open `test/e2e/out/reading-network-zoom.png` and `test/e2e/out/reading-network.png`. Check these points:
- the toggles sit above the strip;
- the strip lanes are visible;
- the brush has two handles;
- the header stays readable over the rows when they scroll under it, because its background is solid.

Fix any visual defect in `theme.css` and re-run e2e.

- [ ] **Step 7: Commit**

```bash
git add extension/ui/reading.js test/e2e/run.mjs extension/ui/theme.css
git commit -m "Network pane: LCP path and group toggles, overview brush with keyboard handles, ruler drag and Ctrl-wheel zoom

Co-Authored-By: <the model that wrote it> <noreply@anthropic.com>"
```

---

## Self-review notes

**Spec coverage**

| Spec section | Task |
|---|---|
| §1 LCP path model | Task 1 |
| §1 Summary text | Task 1 (`pathSummary`) |
| §1 UI | Tasks 3 and 4 |
| §1 Toggle disabled without LCP | Task 3 |
| §1 Path inside a collapsed group | Task 3 |
| §2 Grouping model | Task 1 |
| §2 Group UI | Task 3 |
| §2 Expand and collapse; closing a group closes the request inside it | Task 4 |
| §2 Expanded groups kept across re-renders | Task 4 (`netOpenGroups` state) |
| §3 Window model and clamp | Task 2 |
| §3 Zooming around a point | Task 2 |
| §3 Overview lanes | Task 2 |
| §3 Strip and brush | Tasks 3 and 4 |
| §3 Keyboard | Task 4 |
| §3 Reset | Tasks 3 and 4 |
| §3 Live text | Task 4 |
| §3 Ruler drag | Task 4 |
| §3 Wheel and pinch | Task 4 |
| §3 Clipping cue | Task 3 |
| §3 Pinned header | Task 3 (CSS) and Task 4 (e2e) |
| §3 Window kept across sort, filter and groups; reset on render | Task 4 |
| Error handling | Tasks 1 to 3 |
| Performance | Tasks 1 to 3 timing tests |
| Export and print | Task 3 |

**Gaps against the spec**
- §2 "Few requests" (no site has 2+ requests) has no special note. The toggle simply has no effect, which the spec accepts.
- §1 "LCP resource not in the request list" is covered (Task 1).

**Type consistency.** The same names are used across tasks:
- `lcpPath()` returns `{kind, ms, label, hops, blocking, missing}`;
- `groupRows` items are `{group, rows, count, bytes, start, end}`;
- `timelineModel(reading, view)` returns `window` and `place()`, and its bars have `end`, `clipStart` and `clipEnd`;
- the data attributes are `data-wf-path`, `data-wf-groups`, `data-wf-reset`, `data-group` and `data-edge`;
- the ids are `#wf-overview`, `#wf-zoom-text` and `#wf-live`.
