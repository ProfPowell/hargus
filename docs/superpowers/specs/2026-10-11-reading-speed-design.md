# Reading speed — design

## Why

The calibration readings took 20–141 s each, measured from start to "analysis done". A profile of the 10 readings shows where the time goes. For a typical site (BBC):

| Stage | Typical (BBC) | Worst (Al Jazeera) | Cause |
|---|---|---|---|
| Load | 3 s | 30 s | `waitForIdle` waits for the network to be quiet. Streaming and long-polling requests keep it busy until the 30 s cap. |
| Scroll, then idle | 2 s | 14 s | The same busy network: 8 s of idle wait after the scroll. |
| Page plugins | <1 s | 5 s | — |
| Views | 16 s | 29 s | About 29 views run one after another, each with fixed 300–1000 ms sleeps. Device views add a 1 s sleep plus up to 4 s of network settling. Even example.com spends 12 s here. |
| Analyze and enrich | 3–8 s | 8 s | These run in the report tab, **after** the views, although only 5 plugins read view data. |

**Goal (the user's choice):** less total time for the same reading. Keep every view, screenshot and finding.

**Success:**
- A typical calibration site takes **15 s or less** from start to analysis done, down from about 25 s.
- Al Jazeera takes **about 60 s or less**, down from about 120 s.
- On each site, the set of finding titles is the same as before, apart from timing-dependent values (vitals numbers, page weight, request counts).

**Outcome:** the calibration run after this work gave these totals (`timing.totalMs`):

| Site | Total |
|---|---|
| gov.uk | 14.0 s |
| Patagonia | 10.9 s |
| example.com | 9.9 s |
| MDN | 18.0 s |
| react.dev | 20.4 s |
| Le Monde | 20.2 s |
| BBC | 21.1 s |
| Wikipedia | 32.4 s |
| Al Jazeera | 66.3 s |

- Wall time fell by 30–45% against the baseline.
- Typical sites still missed the 15 s target. The views are now the critical path. Most of their remaining cost is full-page screenshots and the no-JS view's reloads, and both were out of scope here. The follow-up is "cheaper screenshots".
- The load wait is now shorter. As a result, late console errors and late third-party requests are no longer observed on pages that never go idle. Al Jazeera's reading has lost its uncaught error, its deprecation warning and an ad domain's certificate expiry.

## Scope

1. Analysis overlaps the views. The core reading is saved and analysed while the service worker drives the views. The view results arrive later as a patch.
2. Shorter waits. Fixed view sleeps are replaced with a render-settled check, and long-lived requests no longer count as network activity.
3. Timings are recorded in every reading and printed by the calibration runner.

**Out of scope:**
- Cheaper screenshots (approach 3).
- Showing the report progressively.
- Quick or full reading modes.
- The no-JS view's two reloads. They stay, because they restore the user's tab.

## Design

### 1. Analysis overlaps the views

#### Today

`takeReading` runs reload, idle, scroll, `finish()` (collect, screenshots, focus probe, page plugins) and `captureViews()`, and only then returns the reading. Next, `background.js` `complete()` saves the reading with `analysis: 'pending'` and opens or notifies the report tab. Finally, `ui/reading.js` `finishAnalysis` runs `analyze` and `enrich`.

#### New flow

1. **The core hand-off.** `takeReading(tabId, opts, ctx)` gains `ctx.onCore(reading)`. It is called once the page plugins are done, before `captureViews`. `background.js` uses the existing `complete()` logic: it sets `analysis = 'pending'` and `capture.viewsPending = true`, saves the reading, and opens or notifies the report tab with the reading id. The capture then continues with the views.
2. **Views return a patch and never mutate the saved reading.** `captureViews(reading)` returns a **views patch**:

   ```js
   {
     readingId,
     screenshots: [ /* view screenshots, in capture order */ ],
     capture: { views, viewsMs, viewsSkipped, prefs, breakpoints, restoreCheck, viewTimings },
     warnings: [ /* warnings added after the core save */ ],
     timing: { viewsMs },
     finishedAt,
   }
   ```

   Only keys that the views actually produced are present. Today `captureViews` writes `hp.screenshots` and `hp.capture.{prefs, breakpoints, restoreCheck, views, viewsMs, viewsSkipped}`. All of those move into the patch. The implementation must find every `hp.` write inside `captureViews` and its helpers, and route each one into the patch.
3. **The patch is stored separately.**
   - `extension/browser/store.js` bumps the IndexedDB `VERSION` to 2 and adds a `patches` object store (`keyPath: 'id'`).
   - New functions: `saveViewsPatch(patch)`, `getViewsPatch(id)` and `deleteViewsPatch(id)`.
   - The service worker saves the patch, then broadcasts `{ type: 'harplus:views', readingId, tabId }`.
   - If `captureViews` throws, it still produces a patch, with `capture.viewsSkipped: [{ view: 'all', reason }]` and the warning. That way the report tab always gets an answer.
4. **Merging is a pure core function.** `mergeViewsPatch(reading, patch)` (new, in `extension/core/harplus.js`):
   - appends `patch.screenshots` to `_harplus.screenshots`;
   - `Object.assign`s `patch.capture` into `_harplus.capture`;
   - appends `patch.warnings` to `capture.warnings`, skipping any already present;
   - deletes `capture.viewsPending`;
   - returns the reading.

   Merging the same patch twice is a no-op. The function checks `capture.viewsPending` first.
5. **The plugin host can hold plugins back for the views.**
   - A plugin can declare `needs: ['views']`. Five plugins declare it: `a11y-views`, `layout`, `international`, `resilience` and `remote`. The last is the user-configured remote plugin, which receives screenshots.
   - `runPlugins(reading, plugins, env)` gains `env.views`: a promise that resolves when the reading has its views, or `undefined` when nothing needs waiting for.
   - Plugins that need views, and any plugin that is transitively `after` one of them, are taken out of their phase. They run in one final step, after all requested phases, once `await env.views` has resolved. Their relative phase order and `after` order are kept.
   - With no `env.views`, as in the CLI, imports, re-runs and old readings, the final step runs at once, so behaviour is unchanged apart from order.
6. **The report tab waits for the patch** (`ui/reading.js`). When `finishAnalysis` runs on a reading with `capture.viewsPending`, it builds `env.views` as a promise that resolves on the first of these:
   - **(a)** `getViewsPatch(id)` already returns a patch (checked at start, for the reopen case);
   - **(b)** a `harplus:views` message arrives for this id, after which the tab reads the patch;
   - **(c)** a `harplus:progress` message for the source tab has stage `error`. The tab then merges a synthetic patch with `viewsSkipped: [{ view: 'all', reason: 'views did not finish' }]`. The service worker saves a patch in a `finally`, even when the views throw, so (c) and (d) only cover a service worker that died;
   - **(d)** a 5-minute deadline passes, handled the same way as (c).

   On (a) or (b) the tab calls `mergeViewsPatch`, then `deleteViewsPatch(id)` after the final save succeeds. The held-back plugins then run. They use the existing behaviour when views are missing, for example `a11y-views` skips with "no accessibility views".
7. **Progress while waiting.** While `capture.viewsPending` is set, the report tab's progress panel shows a "Views" row that follows the `harplus:progress` messages for the source tab (stage `views`, label such as "Mobile view"). The row completes when the patch is merged. Today `applyStatus` ignores progress once a reading is loaded; it changes to keep the views row updated.
8. **The reading is done only once the views are merged.**
   - `analysis = 'done'` is set only after the held-back plugins have run.
   - The existing `harplus:analysis` "done" message to the service worker is still sent once, at the end.
   - The badge and "Reading complete" behaviour is unchanged.
9. **Lock and take-over.** The existing `harplus-analysis:<id>` lock and the `waitForOtherTab` take-over path stay as they are. Whichever tab finishes the analysis merges the patch. A reading whose report tab was closed during the views finishes correctly when it is reopened, through path (a).
10. **Recording mode.** `stopRecording` goes through the same `finish()` and `captureViews`, so it uses the same `onCore` hand-off.

### 2. Shorter waits

**A render-settled check.** `settleRender(maxMs)` is a new in-page helper in `capture.js`. It is self-contained, since it is serialised into the page.

```js
async function settleRender(maxMs) {
  const start = performance.now();
  // rAF does not fire in hidden tabs; fall back to a 50 ms tick.
  const frame = () => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 50); });
  await frame(); await frame();
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

Each view calls `await withTimeout(this.evaluate(settleRender, CAP, 'main'), CAP + 2000, 'settle').catch(() => {})` in place of its fixed sleep:

| View | Today | New |
|---|---|---|
| Device (mobile, tablet) | `sleep(1000)` + `settle(4000)` | `settleRender(1500)` + `settle(4000)` (the network settle is kept for responsive images) |
| nocss, noimages, rtl, pseudo | `sleep(300–400)` | `settleRender(1000)` |
| Vision (4 views) | `sleep(300)` | `settleRender(500)` |
| Display media (dark, forced, more contrast, print) | `sleep(300)` | `settleRender(1000)` |
| Spacing | `sleep(600)` | `settleRender(1000)` |
| Breakpoints | `sleep(600)` | `settleRender(1000)` |
| Reflow, text200 | `settleLayout(3000)` | unchanged |
| nojs | reload + `settle(15000)` | unchanged |

**Long-lived requests don't count as activity.**

- **Recorder.** `extension/core/recorder.js` gains `counts(rec, now, loadedAt, longMs = 5000)`, which returns false for:
  - `rec.type` of `WebSocket`, `EventSource` or `Media`;
  - any request still in flight that started more than `longMs` ago, when `loadedAt` is set and earlier than `now`.
- **Two new recorder members:**
  - `busy(now, loadedAt)`: the number of in-flight requests that count.
  - `lastBusyActivity`: updated like `lastActivity`, but only by events on requests that count at that moment.
- **Capture.** `capture.js` records `this.loadedAt = Date.now()` on the main frame's `Page.loadEventFired`, alongside `loaded = true`. `waitForIdle` uses `recorder.busy(Date.now(), this.loadedAt)` and `recorder.lastBusyActivity` in place of `inflight.size` and `lastActivity`. The rest of its logic (idle window, `maxMs`, the "≤ 2 in flight after half the time" escape, warnings) is unchanged.
- **Effect.** Load, the idle wait after the scroll, and `settle()` all benefit. The user's maximum-wait setting stays the absolute cap. Late requests are still recorded in the HAR, as today. Requests seen during the views are discarded, as today.

### 3. Timings

- **`capture.viewTimings`:** an array of `{ view, runMs, restoreMs, ok }`, one per view attempted, in order, carried in the patch.
- **`_harplus.timing`:** `{ coreMs, viewsMs, analysisMs, totalMs }`.
  - `coreMs` is set at the core save: start to `onCore`.
  - `viewsMs` comes from the patch.
  - `analysisMs` is the report tab's analysis start to done.
  - `totalMs` is `capture.startedAt` to analysis done.
  - All four are set by the report tab before the final save.
- **`scripts/calibrate.mjs`:** each digest entry gains `timing`. `digest.md` prints `core X s · views Y s · analysis Z s · total T s` under each site heading.

## Testing

**Unit tests** (`node --test`):

- `mergeViewsPatch`:
  - appends screenshots and assigns the capture keys;
  - skips duplicate warnings;
  - clears `viewsPending`;
  - is idempotent when applied twice;
  - leaves a reading without `viewsPending` untouched.
- `runPlugins` with `needs`:
  - a plugin needing views does not run until `env.views` resolves, while the other plugins of its phase complete first (use a deferred promise);
  - a plugin `after` a held plugin is held too;
  - with no `env.views`, every plugin still runs;
  - a rejected or never-resolving `env.views` is not the host's job, because the report tab always resolves it. The host only `await`s.
- Recorder `counts`, `busy` and `lastBusyActivity`:
  - WebSocket, EventSource and Media requests don't count;
  - a request open more than 5 s after load stops counting;
  - the same request before load still counts;
  - data events on a non-counting request don't move `lastBusyActivity`.
- Store: `saveViewsPatch`, `getViewsPatch` and `deleteViewsPatch` round-trip. If IndexedDB isn't testable in Node, this is covered by the e2e.

**E2E** (`test/e2e/run.mjs`):

- **Ordering:** while a reading is in progress, poll `getReading(id)` and record that at some point the saved reading had `capture.viewsPending === true` and no `capture.views`. At the end the reading has `capture.views`, no `viewsPending` and `analysis === 'done'`, and the existing `a11y-views` and `layout` assertions still pass.
- **`timing`** is present on the final reading. `timing.totalMs ≥ timing.coreMs`, and `capture.viewTimings` lists every view in the screenshot set.
- **Closed report tab:**
  1. take a reading;
  2. close the report tab as soon as the core reading is saved;
  3. wait for the `harplus:views` broadcast, or poll `getViewsPatch`;
  4. open `ui/reading.html?id=<id>`.

  The reading finishes with the views merged, and `getViewsPatch(id)` returns null afterwards.
- **No regressions:** all existing e2e assertions pass, including the lazy image, the reflow finding and the `stripStyles` check.

**Calibration:** run `node scripts/calibrate.mjs` and compare with the previous digest:
- each site's finding titles are unchanged, apart from timing-dependent values;
- typical sites have `timing.totalMs` of 15 s or less;
- Al Jazeera has `timing.totalMs` of about 60 s or less.

If a site's findings change, find the root cause before merging, because it probably means a view was captured before the page settled.
