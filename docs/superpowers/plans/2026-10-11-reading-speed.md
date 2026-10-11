# Reading Speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut a reading's total time (typical about 25 s → 15 s or less; Al Jazeera about 120 s → about 60 s) without dropping any view, screenshot or finding.

**Architecture:**
- The core reading is saved and handed to the report tab before the views run.
- The views produce a separate **views patch** (in a new IndexedDB store), which the report tab merges before running the five plugins that need view data.
- Fixed view sleeps become an in-page render-settled check.
- The recorder stops counting long-lived requests as network activity.

**Tech Stack:** Plain ES modules (MV3 extension plus Node CLI), the `node --test` unit tests (`npm test`) and the Playwright e2e (`npm run test:e2e`).

**Spec:** `docs/superpowers/specs/2026-10-11-reading-speed-design.md`

## Global Constraints

- In-page helpers in `extension/browser/capture.js` (`settleRender`, `scrollPage`, `measureView` and others) are serialised into the page with `this.evaluate(fn, args, world)`. They must be self-contained: no imports, module constants or closures.
- Names, verbatim:
  - `capture.viewsPending`
  - `capture.viewTimings` (an array of `{ view, runMs, restoreMs, ok }`)
  - `_harplus.timing` (`{ coreMs, viewsMs, analysisMs, totalMs }`)
  - the message `{ type: 'harplus:views', readingId, tabId }`
  - the plugin field `needs: ['views']`
  - `mergeViewsPatch`, `saveViewsPatch`, `getViewsPatch`, `deleteViewsPatch`
  - `settleRender`
  - recorder `counts` / `busy` / `lastBusyActivity`
- Plugins that need views: `a11y-views`, `layout`, `international`, `resilience`, and the remote plugins built in `extension/plugins/remote.js`.
- Long-lived threshold: `longMs = 5000`. Types that never count: `WebSocket`, `EventSource`, `Media`.
- Report-tab wait: give up after 5 minutes (`5 * 60 * 1000`) with `viewsSkipped: [{ view: 'all', reason }]`.
- IndexedDB: `DB = 'harplus'`, `VERSION` 1 → 2, new store `patches` with `keyPath: 'id'` (the patch's `id` is the reading id).
- Settle caps:
  - device: `settleRender(1500)` plus the existing `settle(4000)`;
  - nocss, noimages, rtl, pseudo, display media, spacing and breakpoints: `settleRender(1000)`;
  - vision: `settleRender(500)`;
  - reflow, text200 and nojs: unchanged.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The report tab misses the `harplus:views` message** because it opened, or registered its listener, after the broadcast. The tab must still find the patch in the store and finish. Test: Task 5 (patch already in the store before `finishAnalysis` starts).
2. **The captured tab is in the background**, where `requestAnimationFrame` doesn't fire. `settleRender` must still return within its cap through the 50 ms tick fallback, not hang until the view's `runMs`. Test: Task 2 runs `settleRender` with `requestAnimationFrame` stubbed out and asserts it returns.
3. **Analysis throws before the views arrive.** The reading must still end `analysis: 'done'`, with the views merged if the patch exists, or skipped if not. It must not be left `viewsPending` forever. Test: Task 5.
4. **A plugin is `after` a held plugin.** It must be held too, not run early with missing results. Test: Task 3.
5. **The same patch is merged twice** (two tabs, or a retry). No duplicate screenshots or warnings. Test: Task 3 (`mergeViewsPatch` idempotent).

---

### Task 1: Long-lived requests don't count as network activity

**Files:**
- Modify: `extension/core/recorder.js` (constructor, `touch`, `onRequest`, `onResponse`, `Network.dataReceived`, `onDone`, plus new methods)
- Modify: `extension/browser/capture.js` (`Page.loadEventFired` handler around line 644, and `waitForIdle` around line 740)
- Test: `test/recorder-busy.test.mjs` (new)

**Interfaces:**
- Produces:
  - `HarRecorder#counts(rec, now, loadedAt, longMs = 5000): boolean`
  - `HarRecorder#busy(now, loadedAt): number`
  - `HarRecorder#lastBusyActivity: number` (ms timestamp)
  - `CaptureSession#loadedAt: number | null`

- [ ] **Step 1: Write the failing test** (`test/recorder-busy.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarRecorder } from '../extension/core/recorder.js';

const W = 1_760_000_000;
const req = (rec, id, type, ts, url = `https://x.test/${id}`) => rec.handle('Network.requestWillBeSent', {
  requestId: id, loaderId: 'L', frameId: 'F', type, timestamp: ts, wallTime: W + ts, request: { url, method: 'GET', headers: {} },
});

test('WebSocket, EventSource and Media never count', () => {
  const rec = new HarRecorder();
  req(rec, '1', 'WebSocket', 1); req(rec, '2', 'EventSource', 1); req(rec, '3', 'Media', 1); req(rec, '4', 'Script', 1);
  assert.equal(rec.busy(Date.now(), null), 1);
});

test('a request open > 5 s after load stops counting; before load it still counts', () => {
  const rec = new HarRecorder();
  const r = req(rec, '1', 'XHR', 1);
  const now = Date.now();
  r.startedAt = now - 6000;
  assert.equal(rec.counts(r, now, now - 1000), false, 'long-lived after load');
  assert.equal(rec.counts(r, now, null), true, 'no load yet');
  assert.equal(rec.counts(r, now, now + 1), true, 'load not reached at now');
  r.startedAt = now - 1000;
  assert.equal(rec.counts(r, now, now - 500), true, 'young request');
});

test('data on a non-counting request does not move lastBusyActivity; lastActivity still moves', () => {
  const rec = new HarRecorder();
  req(rec, 'ws', 'EventSource', 1);
  const before = rec.lastBusyActivity;
  const t0 = rec.lastActivity;
  const later = Date.now() + 50;
  while (Date.now() < later) { /* let the clock move */ }
  rec.handle('Network.dataReceived', { requestId: 'ws', dataLength: 10 });
  assert.equal(rec.lastBusyActivity, before);
  assert.ok(rec.lastActivity > t0);
  req(rec, 's', 'Script', 2);
  assert.ok(rec.lastBusyActivity > before, 'a counting request moves it');
});

test('busy drops when the request finishes', () => {
  const rec = new HarRecorder();
  req(rec, '1', 'Script', 1);
  assert.equal(rec.busy(Date.now(), null), 1);
  rec.handle('Network.loadingFinished', { requestId: '1', timestamp: 2 });
  assert.equal(rec.busy(Date.now(), null), 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/recorder-busy.test.mjs`
Expected: FAIL (`rec.busy is not a function`).

- [ ] **Step 3: Implement in `extension/core/recorder.js`**

In the constructor, after `this.lastActivity = Date.now();`:

```js
    this.lastBusyActivity = this.lastActivity; // activity from requests that count towards "busy"
    this.loadedAt = null;                      // set by the capture layer: lets touch() judge long-lived requests
```

Replace `touch()` with:

```js
  touch(rec) {
    const now = Date.now();
    this.lastActivity = now;
    if (!rec || this.counts(rec, now, this.loadedAt)) this.lastBusyActivity = now;
  }

  /** Does this request keep the page "busy"? Streams, sockets, media and long-polls after load do not. */
  counts(rec, now, loadedAt, longMs = 5000) {
    if (['WebSocket', 'EventSource', 'Media'].includes(rec?.type)) return false;
    if (loadedAt != null && loadedAt <= now && rec?.startedAt != null && now - rec.startedAt > longMs) return false;
    return true;
  }

  /** In-flight requests that count towards "busy". */
  busy(now, loadedAt) {
    let n = 0;
    for (const key of this.inflight) if (this.counts(this.live.get(key), now, loadedAt)) n++;
    return n;
  }
```

- In `onRequest`'s new record literal, add `startedAt: Date.now(),`, and change its `this.touch();` to `this.touch(rec);`.
- In `onResponse`, change `this.touch();` to `this.touch(rec);`.
- In the `Network.dataReceived` case, change `this.touch();` to `this.touch(rec);`.
- In `onDone`, move `this.touch(...)` after the `rec` lookup as `this.touch(rec);`, keeping `this.inflight.delete(key)` before it. A missing `rec` calls `this.touch()`, which counts as busy activity, as before.
- Other `this.touch()` calls (redirect stub, line ~207) stay argument-less.

- [ ] **Step 4: Use it in the capture layer** (`extension/browser/capture.js`)

Where the main frame's `Page.loadEventFired` sets `this.loaded = true;` (around line 644), add:

```js
      this.loadedAt = Date.now();
      this.recorder.loadedAt = this.loadedAt;
```

In `reload()` and `reloadQuiet()`, next to `this.loaded = false;`, add `this.loadedAt = null; this.recorder.loadedAt = null;`.

In `waitForIdle`, replace:

```js
      const quiet = Date.now() - this.recorder.lastActivity;
      const inflight = this.recorder.inflight.size;
```

with:

```js
      // Sockets, streams, media and requests open > 5 s after load don't keep the page "busy".
      const quiet = Date.now() - this.recorder.lastBusyActivity;
      const inflight = this.recorder.busy(Date.now(), this.loadedAt);
```

Leave the warning that lists open requests as it is: it still reports `this.recorder.inflight`.

- [ ] **Step 5: Run the tests**

Run: `node --test test/recorder-busy.test.mjs`, then `npm test`
Expected: PASS. `test/core.test.mjs` recorder tests are unchanged.

- [ ] **Step 6: Commit**

```bash
git add extension/core/recorder.js extension/browser/capture.js test/recorder-busy.test.mjs
git commit -m "Recorder: sockets, streams, media and long-polls after load don't count as network activity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Render-settled view waits and per-view timings

**Files:**
- Modify: `extension/browser/capture.js` (new `settleRender` after `settleLayout`, plus the `view()` helper and the view `run` bodies in `captureViews`)
- Test: `test/settle-render.test.mjs` (new)

**Interfaces:**
- Produces:
  - `export async function settleRender(maxMs)` (exported for tests; the extension evaluates it in the page)
  - `viewTimings: Array<{ view, runMs, restoreMs, ok }>`, a local in `captureViews`. Task 4 moves it into the patch. In this task, assign `hp.capture.viewTimings = viewTimings` next to `hp.capture.viewsMs`.

- [ ] **Step 1: Write the failing test** (`test/settle-render.test.mjs`)

`settleRender` uses only `performance`, `requestAnimationFrame`, `setTimeout`, `document.fonts` and `document.documentElement`, so Node can run it against stubs.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleRender } from '../extension/browser/capture.js';

const withPage = async (sizes, raf, fn) => {
  let i = 0;
  const de = { get scrollWidth() { return sizes[Math.min(i, sizes.length - 1)][0]; }, get scrollHeight() { return sizes[Math.min(i++, sizes.length - 1)][1]; } };
  globalThis.document = { documentElement: de, fonts: { ready: Promise.resolve() } };
  globalThis.requestAnimationFrame = raf;
  try { return await fn(); } finally { delete globalThis.document; delete globalThis.requestAnimationFrame; }
};

test('returns once size is stable for two frames', async () => {
  const t = Date.now();
  await withPage([[100, 100], [100, 200], [100, 300], [100, 300], [100, 300], [100, 300]], (cb) => setTimeout(cb, 5), () => settleRender(2000));
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
});

test('hidden tab (rAF never fires) still returns within the cap via the 50 ms tick (Review Focus 2)', async () => {
  const t = Date.now();
  await withPage([[100, 100]], () => {}, () => settleRender(400));
  assert.ok(Date.now() - t < 1200, `took ${Date.now() - t} ms`);
});

test('a page that keeps growing returns at the cap', async () => {
  let h = 0;
  const sizes = Array.from({ length: 500 }, () => [100, (h += 10)]);
  const t = Date.now();
  await withPage(sizes, (cb) => setTimeout(cb, 5), () => settleRender(300));
  const ms = Date.now() - t;
  assert.ok(ms >= 250 && ms < 1500, `took ${ms} ms`);
});
```

If importing `capture.js` in Node fails because `settleRender` isn't exported yet, that is the expected RED.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/settle-render.test.mjs`
Expected: FAIL (`settleRender` is not exported).

- [ ] **Step 3: Add `settleRender`** after `settleLayout` in `capture.js`

```js
/** Wait until the page has painted and stopped changing size. Runs in the page (main world). */
export async function settleRender(maxMs) {
  const start = performance.now();
  // rAF does not fire in hidden tabs; fall back to a 50 ms tick.
  const frame = () => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 50); });
  await frame();
  await frame();
  await Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 500))]);
  let last = '';
  let stable = 0;
  while (performance.now() - start < maxMs) {
    await frame();
    const now = `${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}`;
    stable = now === last ? stable + 1 : 0;
    last = now;
    if (stable >= 2) return;
  }
}
```

Inside `captureViews`, add the helper:

```js
    const settled = (cap) => withTimeout(this.evaluate(settleRender, cap, 'main'), cap + 2000, 'settle').catch(() => {});
```

- [ ] **Step 4: Replace the fixed sleeps in the view `run` bodies**

| View block | Replace | With |
|---|---|---|
| Device views (`for (const id of DEVICE_VIEWS)`) | `await sleep(1000);` | `await settled(1500);` (keep `await this.settle(4000);`) |
| `nocss`, `noimages` | `await sleep(300);` | `await settled(1000);` |
| `rtl`, `pseudo` | `await sleep(400);` | `await settled(1000);` |
| Vision views | `await sleep(300);` | `await settled(500);` |
| Display views | `await sleep(300);` | `await settled(1000);` |
| `spacing` | `await sleep(600);` | `await settled(1000);` |
| Breakpoint views | `await sleep(600);` | `await settled(1000);` |

Leave `reflow` and `text200` (`settleLayout`) and `nojs` as they are. Remove `sleep` from the imports only if nothing else uses it; `waitForIdle` and `finish` still do.

- [ ] **Step 5: Record per-view timings**

In `captureViews`, add `const viewTimings = [];` before `const view = …`. Inside `view()`, time the run and the restore:

```js
      const t0 = Date.now();
      let ok = false;
      const p = run();
      try {
        const got = await withTimeout(p, runMs, label);
        hp.screenshots.push(...got.shots);
        if (got.measured) views[id] = got.measured;
        ok = true;
      } catch (e) {
        /* existing catch body unchanged */
      }
      const runMs_ = Date.now() - t0;
      const r0 = Date.now();
      await withTimeout(restore(), restoreMs, `${label} restore`).catch((e) => this.warnings.push(`${label} restore failed: ${e.message}`));
      viewTimings.push({ view: id, runMs: runMs_, restoreMs: Date.now() - r0, ok });
```

The two early `return`s (disabled, or detached/aborted) push no timing. Next to `hp.capture.viewsMs = …`, add `hp.capture.viewTimings = viewTimings;`.

- [ ] **Step 6: Run the tests**

Run: `node --test test/settle-render.test.mjs`, then `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extension/browser/capture.js test/settle-render.test.mjs
git commit -m "Views: render-settled waits instead of fixed sleeps; per-view timings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Views patch merge and the plugin host's `needs` gating

**Files:**
- Modify: `extension/core/harplus.js` (new export `mergeViewsPatch`)
- Modify: `extension/core/plugin-host.js` (`runPlugins`, plus a new export `heldBack`)
- Modify: `extension/plugins/a11y-views.js`, `layout.js`, `international.js`, `resilience.js` and `remote.js` (add `needs: ['views']`)
- Test: `test/views-patch.test.mjs` (new)

**Interfaces:**
- Produces:
  - `mergeViewsPatch(reading, patch): reading`
  - `heldBack(plugins): Set<string>`
  - `runPlugins(reading, plugins, env)`, which honours `env.views` (a Promise or undefined)
- `patch` shape (spec §1.2):
  ```js
  { id?, readingId?, screenshots?: [], capture?: {…}, warnings?: [], timing?: { viewsMs }, finishedAt? }
  ```

- [ ] **Step 1: Write the failing tests** (`test/views-patch.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReading, makeTarget, mergeViewsPatch } from '../extension/core/harplus.js';
import { runPlugins, heldBack } from '../extension/core/plugin-host.js';
import { getPlugins } from '../extension/plugins/index.js';

const pendingReading = () => {
  const r = createReading({ target: makeTarget('https://x.test/'), capture: { warnings: ['core warning'] }, screenshots: [{ kind: 'viewport', view: 'desktop', data: 'a' }] });
  r.log._harplus.capture.viewsPending = true;
  return r;
};
const PATCH = {
  id: 'r1', screenshots: [{ kind: 'viewport', view: 'mobile', data: 'b' }],
  capture: { views: { desktop: { cssWidth: 1280 }, mobile: { cssWidth: 390 } }, viewsMs: 9000, viewTimings: [{ view: 'mobile', runMs: 900, restoreMs: 50, ok: true }] },
  warnings: ['core warning', 'mobile view failed: x'], timing: { viewsMs: 9000 },
};

test('mergeViewsPatch: appends shots, assigns capture keys, skips duplicate warnings, clears viewsPending', () => {
  const r = mergeViewsPatch(pendingReading(), structuredClone(PATCH));
  const hp = r.log._harplus;
  assert.deepEqual(hp.screenshots.map((s) => s.view), ['desktop', 'mobile']);
  assert.equal(hp.capture.views.mobile.cssWidth, 390);
  assert.equal(hp.capture.viewsMs, 9000);
  assert.deepEqual(hp.capture.warnings, ['core warning', 'mobile view failed: x']);
  assert.equal(hp.capture.viewsPending, undefined);
});

test('mergeViewsPatch is idempotent and ignores readings that are not pending (Review Focus 5)', () => {
  const r = mergeViewsPatch(pendingReading(), structuredClone(PATCH));
  mergeViewsPatch(r, structuredClone(PATCH));
  assert.equal(r.log._harplus.screenshots.length, 2);
  assert.equal(r.log._harplus.capture.warnings.length, 2);
  const plain = createReading({ target: makeTarget('https://x.test/') });
  mergeViewsPatch(plain, structuredClone(PATCH));
  assert.equal(plain.log._harplus.capture.views, undefined);
  assert.equal(mergeViewsPatch(pendingReading(), null).log._harplus.capture.viewsPending, true, 'null patch is a no-op');
});

test('heldBack: needs views, plus anything transitively after a held plugin (Review Focus 4)', () => {
  const ps = [
    { id: 'v', phase: 'analyze', needs: ['views'] },
    { id: 'x', phase: 'analyze', after: ['v'] },
    { id: 'y', phase: 'enrich', after: ['x'] },
    { id: 'z', phase: 'analyze' },
  ];
  assert.deepEqual([...heldBack(ps)].sort(), ['v', 'x', 'y']);
});

test('runPlugins: held plugins wait for env.views while the rest of their phase finishes', async () => {
  const reading = createReading({ target: makeTarget('https://x.test/') });
  const order = [];
  let release;
  const views = new Promise((r) => { release = r; });
  const plugins = [
    { id: 'v', name: 'V', phase: 'analyze', needs: ['views'], run: () => { order.push('v'); return {}; } },
    { id: 'a', name: 'A', phase: 'analyze', run: () => { order.push('a'); return {}; } },
    { id: 'e', name: 'E', phase: 'enrich', run: () => { order.push('e'); return {}; } },
    { id: 'w', name: 'W', phase: 'enrich', after: ['v'], run: () => { order.push('w'); return {}; } },
  ];
  const done = runPlugins(reading, plugins, { phases: ['analyze', 'enrich'], views });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, ['a', 'e'], 'non-held plugins ran, held ones wait');
  release();
  await done;
  assert.deepEqual(order, ['a', 'e', 'v', 'w']);
});

test('runPlugins without env.views runs everything (CLI, imports, old readings)', async () => {
  const reading = createReading({ target: makeTarget('https://x.test/') });
  const order = [];
  const plugins = [
    { id: 'v', name: 'V', phase: 'analyze', needs: ['views'], run: () => { order.push('v'); return {}; } },
    { id: 'a', name: 'A', phase: 'analyze', run: () => { order.push('a'); return {}; } },
  ];
  await runPlugins(reading, plugins, { phases: ['analyze'] });
  assert.deepEqual(order.sort(), ['a', 'v']);
});

test('the five view-reading plugins declare needs: views', () => {
  const ids = getPlugins().filter((p) => (p.needs || []).includes('views')).map((p) => p.id);
  for (const id of ['a11y-views', 'layout', 'international', 'resilience']) assert.ok(ids.includes(id), id);
});
```

`remote.js` builds plugins from user settings, so its `needs` is checked in Step 4 by reading the code. Default settings have no remote plugins.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/views-patch.test.mjs`
Expected: FAIL (`mergeViewsPatch` is not exported).

- [ ] **Step 3: Implement `mergeViewsPatch`** (`extension/core/harplus.js`, exported)

```js
/** Fold a views patch (screenshots + capture fields from the views run) into a reading still waiting for it. */
export function mergeViewsPatch(reading, patch) {
  const hp = reading?.log?._harplus;
  if (!hp?.capture?.viewsPending || !patch) return reading;
  hp.screenshots = [...(hp.screenshots || []), ...(patch.screenshots || [])];
  const { warnings: _w, ...capture } = patch.capture || {};
  Object.assign(hp.capture, capture);
  const seen = new Set(hp.capture.warnings || []);
  hp.capture.warnings = [...(hp.capture.warnings || []), ...(patch.warnings || []).filter((w) => !seen.has(w))];
  if (patch.timing) hp.timing = { ...(hp.timing || {}), ...patch.timing };
  delete hp.capture.viewsPending;
  return reading;
}
```

- [ ] **Step 4: Gate on `needs` in `runPlugins`** (`extension/core/plugin-host.js`)

Add and export:

```js
/** Plugins that need the views, plus every plugin transitively `after` one of them. */
export function heldBack(plugins) {
  const held = new Set(plugins.filter((p) => (p.needs || []).includes('views')).map((p) => p.id));
  for (let grew = true; grew;) {
    grew = false;
    for (const p of plugins) if (!held.has(p.id) && (p.after || []).some((d) => held.has(d))) { held.add(p.id); grew = true; }
  }
  return held;
}
```

Replace the body of `runPlugins` (keep its doc comment, and add `views: Promise resolved once the reading has its views (optional)` to it):

```js
export async function runPlugins(reading, plugins, env = {}) {
  const hp = reading.log._harplus;
  hp.plugins ||= {};
  const shared = { dnsCache: new Map() };
  const phases = env.phases || PHASES;
  const active = (phase) => plugins.filter((p) => p.phase === phase &&
    (env.only ? env.only.includes(p.id) : pluginEnabled(p, env.settings)));
  const held = heldBack(phases.flatMap(active));
  const runSet = async (list) => {
    let pending = list;
    while (pending.length) {
      const ids = new Set(pending.map((p) => p.id));
      let ready = pending.filter((p) => !(p.after || []).some((d) => ids.has(d)));
      if (!ready.length) ready = pending; // dependency cycle: run them together
      await Promise.all(ready.map((p) => runOne(p, reading, env, shared)));
      pending = pending.filter((p) => !ready.includes(p));
    }
  };
  for (const phase of phases) {
    if (phase === 'page' && env.evaluate) await runProbes(reading, plugins, env);
    await runSet(active(phase).filter((p) => !held.has(p.id)));
  }
  if (held.size) {
    if (env.views) await env.views;
    for (const phase of phases) await runSet(active(phase).filter((p) => held.has(p.id)));
  }
  return reading;
}
```

Add `needs: ['views'],` next to `phase:` in `a11y-views.js`, `layout.js`, `international.js` and `resilience.js`, and in the plugin object built in `remote.js` (around line 18).

- [ ] **Step 5: Run the tests**

Run: `node --test test/views-patch.test.mjs`, then `npm test`
Expected: PASS. Existing plugin-host and report tests are unchanged: without `env.views` the held plugins run last in their phase order, and no current plugin is `after` them.

- [ ] **Step 6: Commit**

```bash
git add extension/core/harplus.js extension/core/plugin-host.js extension/plugins/a11y-views.js extension/plugins/layout.js extension/plugins/international.js extension/plugins/resilience.js extension/plugins/remote.js test/views-patch.test.mjs
git commit -m "Core: views patch merge; plugin host holds plugins that need views until env.views resolves

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Core hand-off: save before views, views return a patch

**Files:**
- Modify: `extension/browser/store.js` (`VERSION` 2, the `patches` store, and the patch functions)
- Modify: `extension/browser/capture.js` (`captureViews` returns a patch; `finish` calls `ctx.onCore` and `ctx.onViews`)
- Modify: `extension/background.js` (`capture`, `stop`, and `complete`; new `viewsDone`)

**Interfaces:**
- Consumes: `mergeViewsPatch` (Task 3); the `viewTimings` local (Task 2).
- Produces:
  - `saveViewsPatch(patch)`, `getViewsPatch(id)` (patch or null) and `deleteViewsPatch(id)`, all in `extension/browser/store.js`
  - `ctx.onCore(reading): Promise<string>` (returns the reading id)
  - `ctx.onViews(patch): Promise<void>`
  - the broadcast `{ type: 'harplus:views', readingId, tabId }`
  - `capture.viewsPending = true` on the saved core reading

- [ ] **Step 1: Store** (`extension/browser/store.js`)

- Set `const VERSION = 2;`.
- In `onupgradeneeded`, add `if (!d.objectStoreNames.contains('patches')) d.createObjectStore('patches', { keyPath: 'id' });`.
- Update the header comment: there are now three stores, the third being "patches: { id, … } views results waiting to be merged".

Add:

```js
/** A views patch waiting to be merged into reading `patch.id`. */
export async function saveViewsPatch(patch) {
  const d = await db();
  const tx = d.transaction('patches', 'readwrite');
  tx.objectStore('patches').put(patch);
  await complete(tx);
}

export async function getViewsPatch(id) {
  const d = await db();
  return (await request(d.transaction('patches').objectStore('patches').get(id))) ?? null;
}

export async function deleteViewsPatch(id) {
  const d = await db();
  const tx = d.transaction('patches', 'readwrite');
  tx.objectStore('patches').delete(id);
  await complete(tx);
}
```

If `deleteReading` exists in this file, also delete the reading's patch in the same transaction: add `'patches'` to its store list and `tx.objectStore('patches').delete(id)`.

- [ ] **Step 2: `captureViews` returns a patch instead of mutating the reading** (`capture.js`)

At the top of `captureViews`, add `const patch = { screenshots: [], capture: {}, warnings: [] };` and `const w0 = this.warnings.length;`. Then route every `hp.` write into the patch:
- `hp.screenshots.push(...got.shots)` → `patch.screenshots.push(...got.shots)`
- `hp.capture.prefs = …` → `patch.capture.prefs = …`
- `hp.capture.breakpoints = bps` → `patch.capture.breakpoints = bps`
- `hp.capture.restoreCheck = …` → `patch.capture.restoreCheck = …`
- `hp.capture.views = views` → `patch.capture.views = views`
- `hp.capture.viewsMs = …` → `patch.capture.viewsMs = …`
- `hp.capture.viewTimings = viewTimings` → `patch.capture.viewTimings = viewTimings`
- `if (skipped.length) hp.capture.viewsSkipped = skipped` → `patch.capture.viewsSkipped = skipped` (only if non-empty)

Then grep `captureViews` and every helper it calls (`resetA11y`, the breakpoint block, `shoot`) for any remaining `hp.` or `reading.log._harplus` write, and route those too. Any read of `hp.plugins` (the breakpoint block reads `hp.plugins?.css`) stays a read.

End with:

```js
    patch.warnings = this.warnings.slice(w0);
    patch.timing = { viewsMs: patch.capture.viewsMs };
    patch.finishedAt = new Date().toISOString();
    return patch;
```

- [ ] **Step 3: `finish` hands off before the views** (`capture.js`)

Change the signature to `async finish(ctx)`, with `const { plugins, settings } = ctx;` at the top. Replace the tail, from the page-plugins `runPlugins` call through `return reading;`:

```js
      await runPlugins(reading, plugins, { /* unchanged page-phase env */ });
    }
    const willView = live && !this.detached;
    const hp = reading.log._harplus;
    if (willView) hp.capture.viewsPending = true;
    const id = ctx.onCore ? await ctx.onCore(reading) : null;
    if (willView) {
      let patch;
      try {
        patch = await this.captureViews(reading);
      } catch (e) {
        this.warnings.push(`views failed: ${e.message}`);
        await this.resetA11y().catch(() => {});
        patch = { screenshots: [], capture: { viewsSkipped: [{ view: 'all', reason: e.message }] }, warnings: [`views failed: ${e.message}`] };
      } finally {
        patch ??= { screenshots: [], capture: { viewsSkipped: [{ view: 'all', reason: 'views did not finish' }] }, warnings: [] };
        patch.id = id ?? hp.id;
        patch.readingId = patch.id;
        if (ctx.onViews) await ctx.onViews(patch).catch(() => {});
        else mergeViewsPatch(reading, patch); // callers without the hand-off get the old, merged reading
      }
    }
    return reading;
```

Import `mergeViewsPatch` from `'../core/harplus.js'`; it's already imported from there for `createReading` and `makeTarget`. `takeReading` and `stopRecording` already pass `ctx` through to `finish(ctx)`, so check they pass the whole object.

- [ ] **Step 4: Background hand-off** (`extension/background.js`)

Import `saveViewsPatch` from `'./browser/store.js'`, next to `saveReading`.

In `complete(tabId, reading)`, before `saveReading`, add:

```js
  const hp = reading.log._harplus;
  hp.timing = { ...(hp.timing || {}), coreMs: Date.now() - Date.parse(hp.capture.startedAt) };
```

Add:

```js
/** Views finished (or failed): store the patch for the reading tab and tell it. */
async function viewsDone(tabId, patch) {
  await saveViewsPatch(patch);
  chrome.runtime.sendMessage({ type: 'harplus:views', readingId: patch.id, tabId }).catch(() => {});
}
```

In `capture()`, replace the `takeReading` call and its `return await complete(...)` with:

```js
      let id;
      await takeReading(tabId, opts, {
        plugins, settings, report: (st, d) => report(tabId, st, d),
        onCore: async (r) => (id = await complete(tabId, r)),
        onViews: (patch) => viewsDone(tabId, patch),
      });
      return id;
```

Do the same in `stop()` for `stopRecording`. If `complete` was never called, because the reading failed before the core, `takeReading` threw and the existing `fail` path runs.

- [ ] **Step 5: Unit suite**

Run: `npm test`
Expected: PASS. The browser behaviour is verified by Task 6's e2e. `cli/` doesn't call `finish`; confirm with `grep -rn "finish(" cli/`.

- [ ] **Step 6: Commit**

```bash
git add extension/browser/store.js extension/browser/capture.js extension/background.js
git commit -m "Capture: save the core reading before the views; views return a patch stored for the reading tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The report tab merges the patch, shows views progress, records timing

**Files:**
- Modify: `extension/ui/reading.js` (`finishAnalysis`, `applyStatus`, and a new `viewsReady`)
- Test: `test/reading-views.test.mjs` (new), using an exported pure helper

**Interfaces:**
- Consumes: `getViewsPatch`, `deleteViewsPatch` (Task 4), `mergeViewsPatch` (Task 3), and `runPlugins` with `env.views` (Task 3).
- Produces:
  - `export function waitForViews({ hasPending, fromStore, subscribe, timeoutMs }): Promise<{ patch, reason }>`, a pure, testable helper in a new module `extension/core/views-wait.js`
  - the final `_harplus.timing` with `analysisMs` and `totalMs`

- [ ] **Step 1: Write the failing test** (`test/reading-views.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForViews } from '../extension/core/views-wait.js';

const bus = () => {
  const subs = new Set();
  return { subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); }, emit: (m) => subs.forEach((f) => f(m)), size: () => subs.size };
};

test('patch already stored before waiting → resolves at once (Review Focus 1)', async () => {
  const b = bus();
  const r = await waitForViews({ fromStore: async () => ({ id: 'r1', capture: {} }), subscribe: b.subscribe, timeoutMs: 1000 });
  assert.equal(r.patch.id, 'r1');
  assert.equal(b.size(), 0, 'listener removed');
});

test('views message → reads the store', async () => {
  const b = bus();
  let stored = null;
  const p = waitForViews({ fromStore: async () => stored, subscribe: b.subscribe, timeoutMs: 1000 });
  await new Promise((r) => setTimeout(r, 10));
  stored = { id: 'r1' };
  b.emit({ kind: 'views' });
  assert.equal((await p).patch.id, 'r1');
});

test('capture error → synthetic skipped patch', async () => {
  const b = bus();
  const p = waitForViews({ fromStore: async () => null, subscribe: b.subscribe, timeoutMs: 1000 });
  await new Promise((r) => setTimeout(r, 10));
  b.emit({ kind: 'error', text: 'Debugger detached' });
  const { patch } = await p;
  assert.deepEqual(patch.capture.viewsSkipped, [{ view: 'all', reason: 'views did not finish: Debugger detached' }]);
});

test('deadline → synthetic skipped patch', async () => {
  const b = bus();
  const { patch } = await waitForViews({ fromStore: async () => null, subscribe: b.subscribe, timeoutMs: 30 });
  assert.match(patch.capture.viewsSkipped[0].reason, /timed out/);
  assert.equal(b.size(), 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/reading-views.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `extension/core/views-wait.js`**

```js
// Waiting for a reading's views patch: from the store (already there), a "views done" message, a capture
// error, or a deadline. Pure: the caller supplies the store read and the message subscription.

const skipped = (reason) => ({ screenshots: [], capture: { viewsSkipped: [{ view: 'all', reason }] }, warnings: [reason] });

/**
 * fromStore(): Promise<patch|null>
 * subscribe(fn): unsubscribe — fn receives { kind: 'views' } or { kind: 'error', text }
 */
export function waitForViews({ fromStore, subscribe, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = () => {};
    let timer;
    const finish = (patch, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve({ patch, reason });
    };
    const check = async () => { const p = await fromStore().catch(() => null); if (p) finish(p, 'stored'); };
    unsubscribe = subscribe((m) => {
      if (m?.kind === 'views') check();
      else if (m?.kind === 'error') finish(skipped(`views did not finish: ${m.text || 'capture failed'}`), 'error');
    });
    timer = setTimeout(() => finish(skipped(`views did not finish: timed out after ${Math.round(timeoutMs / 1000)} s`), 'timeout'), timeoutMs);
    check(); // after subscribing, so a broadcast cannot slip between the two
  });
}
```

- [ ] **Step 4: Wire it into `extension/ui/reading.js`**

Imports: add `getViewsPatch` and `deleteViewsPatch` to the `store.js` import, `mergeViewsPatch` to the `harplus.js` import, and `import { waitForViews } from '../core/views-wait.js';`.

Add a helper above `finishAnalysis`:

```js
/** Resolves when the reading has its views (merged into `reading`), or undefined when nothing is pending. */
function viewsReady() {
  if (!hp().capture?.viewsPending) return undefined;
  return waitForViews({
    fromStore: () => getViewsPatch(id),
    subscribe: (fn) => {
      const onMsg = (msg) => {
        if (msg?.type === 'harplus:views' && msg.readingId === id) fn({ kind: 'views' });
        else if (msg?.type === 'harplus:progress' && msg.tabId === sourceTab && msg.stage === 'error') fn({ kind: 'error', text: msg.text });
      };
      chrome.runtime.onMessage.addListener(onMsg);
      return () => chrome.runtime.onMessage.removeListener(onMsg);
    },
  }).then(({ patch }) => { mergeViewsPatch(reading, patch); });
}
```

In `finishAnalysis`, add `const analysisStart = Date.now();` at the top, pass `views: viewsReady(),` in the `runPlugins` env, and replace the success tail (`hp().analysis = 'done'; await saveReading(reading);`) with:

```js
    stampTiming(analysisStart);
    hp().analysis = 'done';
    await saveReading(reading);
    await deleteViewsPatch(id).catch(() => {});
```

In the `catch` (Review Focus 3), before `hp().analysis = 'done';`, add:

```js
    if (hp().capture?.viewsPending) {
      const p = await getViewsPatch(id).catch(() => null);
      mergeViewsPatch(reading, p || { capture: { viewsSkipped: [{ view: 'all', reason: 'analysis failed before the views arrived' }] } });
    }
    stampTiming(analysisStart);
```

and after its `saveReading`, `await deleteViewsPatch(id).catch(() => {});`.

Add:

```js
function stampTiming(analysisStart) {
  const cap = hp().capture || {};
  const t = { ...(hp().timing || {}), analysisMs: Date.now() - analysisStart };
  if (cap.viewsMs != null) t.viewsMs = cap.viewsMs;
  const start = Date.parse(cap.startedAt);
  if (Number.isFinite(start)) t.totalMs = Date.now() - start;
  hp().timing = t;
}
```

**Views progress row.** In `applyStatus(s)`, change the early return `if (!s || reading) return;` to:

```js
  if (!s) return;
  if (reading) {
    // Analysis is running while the capture still drives the views: keep its steps (incl. "views") on screen.
    if (hp().capture?.viewsPending && s.steps) { prog.steps = s.steps; paintProgress(); }
    return;
  }
```

`followCapture` only subscribes when the tab was opened with `?capture=`. In `finishAnalysis`, when `hp().capture?.viewsPending` and `sourceTab != null`, add a `chrome.runtime.onMessage` listener that calls `applyStatus(msg)` for `harplus:progress` messages with `msg.tabId === sourceTab`. Remove it once the views resolve. Unless one is already registered, initialise it from `chrome.runtime.sendMessage({ type: 'harplus:status', tabId: sourceTab })`.

- [ ] **Step 5: Run the tests**

Run: `node --test test/reading-views.test.mjs`, then `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/core/views-wait.js extension/ui/reading.js test/reading-views.test.mjs
git commit -m "Reading tab: wait for the views patch while analysing, merge it, show views progress, record timing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: E2E coverage and calibration timing

**Files:**
- Modify: `test/e2e/run.mjs` (the first reload reading, around lines 86–125, plus a new closed-tab block after the existing reading-1 assertions)
- Modify: `scripts/calibrate.mjs` (`timing` in the digest)

- [ ] **Step 1: Ordering assertion (core saved before the views finish).**

Replace the first capture:

```js
    const id1 = await sw.evaluate((t) => globalThis.harplus.capture(t, { mode: 'reload' }), tabId);
```

with a non-awaited start that watches for the core save:

```js
    await sw.evaluate((t) => { globalThis.__cap1 = globalThis.harplus.capture(t, { mode: 'reload' }); }, tabId);
    let coreSeen = null;
    for (const until = Date.now() + 90_000; Date.now() < until && !coreSeen;) {
      const rid = await sw.evaluate((t) => globalThis.harplus.status.get(t)?.readingId ?? null, tabId).catch(() => null);
      if (rid) {
        const r = await page2.evaluate(async (x) => (await import('/browser/store.js')).getReading(x), rid);
        if (r?.log._harplus.capture.viewsPending) coreSeen = { rid, hasViews: !!r.log._harplus.capture.views };
      }
      if (!coreSeen) await new Promise((res) => setTimeout(res, 200));
    }
    const id1 = await sw.evaluate(() => globalThis.__cap1);
    assert.ok(coreSeen, 'the core reading was saved with viewsPending before the views finished');
    assert.equal(coreSeen.rid, id1);
    assert.equal(coreSeen.hasViews, false, 'core reading has no views yet');
```

`page2` and the `getReading` helper are defined just below the current capture call. Move the `page2` setup above this block if needed; it already is (`page2` is created before the capture). Check that `status.get(tabId)` carries `readingId` after `report(tabId, 'analyzing', { readingId })`; it is how `applyStatus` learns the id. If the status shape differs, read `readingId` from where `report()` stores it.

The existing `pending1` assertion (`analysis === 'pending'`) may now race with a fast analysis. Keep it only if it still passes reliably; otherwise drop it, because the new `coreSeen` assertion supersedes it. Note what you did in the report.

- [ ] **Step 2: Final-reading assertions.** After `r1 = await waitDone(id1);`, add:

```js
    const hp1 = r1.log._harplus;
    assert.equal(hp1.capture.viewsPending, undefined, 'views merged');
    assert.ok(hp1.capture.views && Object.keys(hp1.capture.views).length > 3, 'views present');
    assert.ok(hp1.timing && hp1.timing.totalMs >= hp1.timing.coreMs && hp1.timing.analysisMs > 0, `timing: ${JSON.stringify(hp1.timing)}`);
    const timed = new Set((hp1.capture.viewTimings || []).map((v) => v.view));
    for (const v of new Set(hp1.screenshots.map((s) => s.view).filter((v) => v && v !== hp1.capture.device && v !== 'desktop'))) assert.ok(timed.has(v), `viewTimings has ${v}`);
    assert.equal(await page2.evaluate(async (x) => (await import('/browser/store.js')).getViewsPatch(x), id1), null, 'patch deleted after merge');
```

The existing `a11y-views`, `layout` and `international` assertions further down must still pass unchanged. They prove the held plugins saw the views.

- [ ] **Step 3: Closed-report-tab assertion.** After the reading-1 assertions, before the mobile reading (`id2`), add:

```js
    // Report tab closed mid-views: the patch waits in the store and is merged when the reading is reopened.
    await sw.evaluate((t) => { globalThis.__cap4 = globalThis.harplus.capture(t, { mode: 'reload' }); }, tabId);
    let rid4 = null;
    for (const until = Date.now() + 90_000; Date.now() < until && !rid4;) {
      rid4 = await sw.evaluate((t) => globalThis.harplus.status.get(t)?.readingId ?? null, tabId).catch(() => null);
      if (!rid4 || rid4 === id1) { rid4 = null; await new Promise((res) => setTimeout(res, 100)); }
    }
    assert.ok(rid4, 'core reading id for the closed-tab case');
    await sw.evaluate(async (rid) => {
      for (const t of await chrome.tabs.query({})) if (t.url?.includes('/ui/reading.html') && (t.url.includes(`id=${rid}`) || t.url.includes('capture='))) await chrome.tabs.remove(t.id);
    }, rid4);
    await sw.evaluate(() => globalThis.__cap4);
    const patch4 = await page2.evaluate(async (x) => (await import('/browser/store.js')).getViewsPatch(x), rid4);
    assert.ok(patch4?.capture?.views, 'patch stored while no reading tab was open');
    await page2.goto(extUrl(`ui/reading.html?id=${rid4}`));
    const r4 = await waitDone(rid4);
    assert.ok(r4.log._harplus.capture.views && !r4.log._harplus.capture.viewsPending, 'reopened tab merged the patch');
    assert.equal(await page2.evaluate(async (x) => (await import('/browser/store.js')).getViewsPatch(x), rid4), null);
    await page2.goto(extUrl('ui/library.html'));
```

The reading tab may pick the patch up before it is closed, if analysis finished first. In that case `patch4` is null, and the reading is already done with views. Make the assertion accept either outcome: if `patch4` is null, assert the reading is done with views. Note in the report which path ran.

- [ ] **Step 4: Calibration timing** (`scripts/calibrate.mjs`)

In the successful `digest.push({ … })`, add `timing: reading.log._harplus.timing || null,`. In the markdown builder, after the `Areas:` line, add:

```js
    d.timing ? `Timing: core ${(d.timing.coreMs / 1000).toFixed(1)} s · views ${((d.timing.viewsMs ?? 0) / 1000).toFixed(1)} s · analysis ${((d.timing.analysisMs ?? 0) / 1000).toFixed(1)} s · total ${((d.timing.totalMs ?? 0) / 1000).toFixed(1)} s` : '',
```

Run `node --check scripts/calibrate.mjs`.

- [ ] **Step 5: Run everything**

Run: `npm test`, then `npm run test:e2e` three times.
Expected: all pass, 3 of 3.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/run.mjs scripts/calibrate.mjs
git commit -m "E2E: core saved before views, patch merged, timing, closed-tab reopen; calibration digest prints timing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Calibration run (controller, not a subagent)

- [ ] Run `node scripts/calibrate.mjs` from the worktree in the background.
- [ ] Compare it with the previous digest (`test/e2e/out/calibrate/digest.json` on main, copied aside before the run):
  - finding titles per site are unchanged, apart from timing-dependent values;
  - `timing.totalMs` is 15 s or less on typical sites, and about 60 s or less on Al Jazeera.
- [ ] For any site whose findings changed, or that missed the time target, open its `.har`, read `capture.viewTimings` and `timing`, find the root cause, and fix it with a test. Record each one in the ledger.
