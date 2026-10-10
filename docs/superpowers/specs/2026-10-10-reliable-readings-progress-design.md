# Reliable readings and visible progress — design

Date: 2026-10-10 · Status: approved in brainstorming (design), awaiting spec review

## Problem

**Symptom.** A "Take reading" sometimes never finishes. When a reading does succeed, it can take a long time with no visible progress after the views. The user can't tell whether anything is happening.

**Evidence.** A diagnostic run on ucsd.edu completed in about 70 s:

| Phase | Time |
|---|---|
| Reload to network idle | 15 s |
| Scroll | 6 s |
| Screenshots and page plugins | 5 s |
| Views (no-JS alone took 16 s) | 26 s |
| Analysis and lookups | 18 s |

- The slowest lookups were Wayback history at 17.5 s and CSS validation at 8 s.
- The reading was 11.6 MB. The report rendered in 0.15 s.
- The diagnostic browser kept the service worker alive, so it could not reproduce Chrome's termination rule.

**Root cause.** Chrome stops an extension service worker after 30 s without extension events or API calls. It also stops the worker when any single `fetch()` response takes more than 30 s (Chrome extension service-worker lifecycle docs).

- During capture, an attached `chrome.debugger` session keeps the worker alive (Chrome 118 and later).
- After `takeReading` detaches, `background.js complete()` runs the analyze and enrich phases in the worker, and only then saves the reading.
- Several enrich plugins allow requests longer than 30 s:

  | Plugin | Timeout |
  |---|---|
  | history | 45 s |
  | html-validate | 45 s |
  | css-validate | 90 s |
  | baseline | 60 s |
  | tech | 60 s |
  | observatory | 60 s |
  | pagespeed | 120 s |

- If one of those requests is slow, Chrome can terminate the worker mid-analysis. The unsaved reading is then lost, the badge stays at "…", and no report appears.
- If nothing is slow enough, the report simply shows up late with no feedback.

**The progress gap.** Progress is only visible in the popup, which closes as soon as the user clicks the page.

## Decisions

| Topic | Decision |
|---|---|
| Durability | Save the reading as soon as capture finishes, before any analysis. Mark it `analysis: 'pending'`. |
| Where analysis runs | In the reading page, which is a long-lived extension tab. It reuses the existing Re-run analysis path. Nothing runs analysis in the service worker any more. |
| Progress surface | A reading tab opens in the background next to the captured tab when the reading starts. It shows a live checklist, then becomes the report. If "Open reading when done" is on, it is activated at the end. |
| Badge | A short stage code on the toolbar badge, plus a tooltip (`chrome.action.setTitle`) with the current step. |
| Interrupted analysis | If the tab is closed early, the reading stays pending. The library shows "Finishing…", and opening the reading resumes the analysis. |

## 1. Progress model (`extension/core/progress.js`, new, pure)

- `STAGES`, in this order: `loading`, `scrolling`, `collecting`, `screenshot`, `bodies`, `sensing`, `views`, `saving`, `analyzing`, `done`. Each stage has a label and a 4-character badge code:

  | Stage | Label | Badge |
  |---|---|---|
  | `loading` | Reloading the page | LOAD |
  | `scrolling` | Scrolling for lazy content | SCRL |
  | `collecting` | Reading the page | READ |
  | `screenshot` | Screenshots | SHOT |
  | `bodies` | Response bodies | BODY |
  | `sensing` | In-page checks | PAGE |
  | `views` | Extra views | VIEW |
  | `saving` | Saving | SAVE |
  | `analyzing` | Analysis and lookups | LOOK |
  | `done` | Done | ✓ |

  The `error` stage has badge `!`. The `recording` stage has badge `REC`.
- `addStep(steps, { stage, text, at })` returns a new steps array.
  - It closes the previous open step by setting `end = at`, then appends `{ stage, text, start: at }`.
  - Consecutive identical stage+text pairs are ignored.
  - `plugin` events, which are page-phase plugin progress, do **not** create steps. They update the text of the current step only.
- `badgeFor(stage) → string`, `labelFor(stage) → string`.
- `elapsed(step, now) → ms`.

## 2. Service worker (`extension/background.js`)

- **Status history.** `status` per tab gains:
  - `steps`, maintained with `addStep`;
  - `startedAt`;
  - `readingId`;
  - `progressTabId`.

  `report()` updates the steps, sets the badge to `badgeFor(stage)` and the title to `HAR-PLUS — <label>: <text>`, and broadcasts `harplus:progress` as it does today, now including `steps`.
- **`capture()` / `stop()` start a progress tab.** At the start:
  1. Call `chrome.tabs.create({ url: reading.html?capture=<tabId>, active: false, index: tab.index + 1 })`.
  2. Remember its id in `status.progressTabId`.
  3. If creating the tab fails, continue without it. The badge and tooltip still work.
- **`complete()` saves early.** It no longer runs any plugins.
  1. Report `saving`.
  2. Set `reading.log._harplus.analysis = 'pending'`.
  3. Run `saveReading`.
  4. Report `analyzing` with `readingId`.

  `complete()` returns the id. The analysis itself happens in the reading tab (§3).
- **`harplus:analysis` message from the reading tab.** Shape: `{ tabId, stage: 'plugin'|'done'|'error', text, readingId }`. It calls `report(tabId, …)`, so the badge, title and popup stay in sync. On `done`:
  - show the badge `✓` for 5 s;
  - if `settings.ui.openWhenDone` and the progress tab exists, focus it with `chrome.tabs.update(progressTabId, { active: true })`.
- **Leftover progress tab.** If capture fails, the progress tab stays open and shows the error, with a "Try again" button.

## 3. Reading page (`extension/ui/reading.html`, `reading.js`)

- **Two entry modes.**
  - **`?capture=<tabId>`.** No reading exists yet. The page:
    - shows the **progress panel**;
    - requests `harplus:status` for that tab and renders `steps`;
    - listens for `harplus:progress` messages for that tab.

    When a progress message arrives with `readingId` (the `analyzing` stage), it calls `history.replaceState` to change the URL to `?id=<readingId>&tab=<tabId>` and continues as below.
  - **`?id=<readingId>`.** The page loads the reading.
    - If `hp.analysis === 'pending'`, it shows the progress panel (the capture steps, when known) and runs **finish analysis**: `runPlugins(reading, plugins, { phases: ['analyze', 'enrich'], settings, onProgress })`. Then it sets `hp.analysis = 'done'`, calls `saveReading`, renders the report and toasts "Reading complete".
    - Each plugin progress event updates the panel and, when `tab` is known, sends `harplus:analysis { tabId, stage: 'plugin', text }` to the service worker.
    - At the end it sends `harplus:analysis { tabId, stage: 'done', readingId }`. On failure it sends `stage: 'error'`, saves whatever finished and renders the report anyway.
- **Progress panel markup** (`renderProgress(steps, plugins, now)`, pure, in a new `extension/ui/progress-view.js`):
  - A header: "Reading <host> · <elapsed>".
  - A **Capture** list: one row per step, with an icon (`ok` when done, a spinning or pulsing dot when running), the label, the text and the elapsed time.
  - An **Analysis** list: one row per plugin, labelled running, ok, skipped or error, with the duration.
  - A note at the bottom: "You can switch tabs — this page finishes the lookups and turns into the report."
  - A 1 s interval re-renders the running timers.
- **Existing Re-run analysis.** It uses the same finish-analysis function and panel, but without the capture list.
- **Escaping.** Every value goes through `html`.

## 4. Library and index (`extension/core/harplus.js`, `extension/ui/library.js`)

- `indexRecord` gains `pending: hp.analysis === 'pending'`.
- Pending library cards show a "Finishing…" chip. The card link opens the reading, which resumes the analysis.

## 5. Popup (`extension/ui/popup.js`)

- `harplus:progress` messages and `harplus:status` now include `steps`. The popup shows the current step's label, its text and the elapsed time, e.g. "Extra views — No JavaScript view · 41 s".
- After `analyzing`, the popup shows "Saved — finishing lookups in the reading tab", with a link.

## 6. Tests

- **`test/progress.test.mjs`:**
  - `addStep` closes the previous step and ignores duplicates;
  - plugin events only update the text;
  - badge and label tables;
  - `renderProgress` markup: the running and done rows, elapsed formatting, escaping of the step text, and the plugin rows.
- **`test/core.test.mjs`:** `indexRecord().pending`.
- **E2E:**
  - `harplus.capture` resolves with the id after capture. The reading is saved with `analysis: 'pending'`.
  - A progress tab exists with URL `reading.html?…capture=`.
  - The e2e waits until the stored reading has `analysis === 'done'` (poll at most 120 s). It then asserts the analyze and enrich results as today.
  - It asserts the badge text sequence includes `VIEW` and ends with `✓`. To support this, the service worker records badge history in `status.badges`, for tests only.

## Out of scope

- An offscreen document or alarms-based resumption inside the service worker.
- Notifications.
- Changing plugin timeouts.
- The CLI, which is unaffected.
