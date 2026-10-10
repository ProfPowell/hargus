# Reliable Readings and Visible Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
1. A reading can never be lost to Chrome stopping the service worker.
2. The user can always see what a reading is doing, and for how long.

**Architecture:**
- The service worker only captures. It saves the reading as soon as capture finishes, marked `analysis: 'pending'`.
- A reading tab opens in the background when the reading starts. It shows a live checklist, runs the analyze and enrich phases itself (extension pages have no 30-second limit), saves the result, and turns into the report.
- A shared pure progress model drives four surfaces: the badge (stage codes), the toolbar tooltip, the popup and the checklist.

**Tech Stack:** Vanilla ES modules, no build step, no dependencies. `node:test` for unit tests. Playwright (installed globally) for the end-to-end test.

**Spec:** `docs/superpowers/specs/2026-10-10-reliable-readings-progress-design.md`. Read it first; it includes the root-cause evidence.

## Global Constraints

- Nothing runs the analyze or enrich phases inside the service worker any more.
- Every reading is saved before its analysis, with `reading.log._harplus.analysis = 'pending'`. Finishing sets it to `'done'`.
- The progress tab is created with `active: false` and placed next to the captured tab. It is activated at the end only when `settings.ui.openWhenDone` is true.
- Stage codes for the badge:

  | Stage | Badge |
  |---|---|
  | loading | LOAD |
  | scrolling | SCRL |
  | collecting | READ |
  | screenshot | SHOT |
  | bodies | BODY |
  | sensing | PAGE |
  | views | VIEW |
  | saving | SAVE |
  | analyzing | LOOK |
  | done | ✓ |
  | error | ! |
  | recording | REC |

- Every interpolated value goes through the escaping `html` tag.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The progress tab is closed early, or never opened.**
   - Expected: the reading is still saved, and analysis still happens. The service worker reopens a background reading tab when the progress tab is gone at save time. Opening the reading later resumes the analysis.
   - Pinned in Task 3: `complete()` falls back to opening `reading.html?id=…&tab=…`. Task 5's e2e asserts that analysis finishes.
2. **Capture fails.**
   - Expected: the progress tab shows the error, the badge shows `!`, and "Try again" retries without opening a second progress tab.
   - Pinned in Task 2 (`renderProgress` error row) and Task 4 (retry passes `progressTab`).
3. **An old reading has no `analysis` field.**
   - Expected: it is treated as done. It must never start an unexpected analysis.
   - Pinned in Task 3 (`indexRecord pending false`) and Task 4 (the check is strictly `=== 'pending'`).
4. **A lookup fails during analysis in the tab.**
   - Expected: the plugin rows show the error, the reading is still saved as done, and the report renders.
   - Pinned in Task 4 (`try/catch` around `runPlugins`).
5. **Hostile step text, such as a plugin error message containing HTML.**
   - Expected: it is escaped in the checklist.
   - Pinned in Task 2 (escaping test).

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `extension/core/progress.js` | create | stages, labels, badge codes, `addStep`, `elapsed`, `formatElapsed` |
| `extension/ui/progress-view.js` | create | `renderProgress()` checklist markup |
| `extension/ui/theme.css` | modify | progress panel styles |
| `extension/background.js` | modify | step history, badge/title, progress tab, save-early, `harplus:analysis` |
| `extension/core/harplus.js` | modify | `indexRecord().pending` |
| `extension/ui/reading.js` | modify | `?capture=` follow mode, finish-pending analysis, progress panel, re-run via panel, retry |
| `extension/ui/library.js` | modify | "Finishing…" chip |
| `extension/ui/popup.js` | modify | step label · elapsed; "finishing lookups" link |
| `test/progress.test.mjs` | create | model and view tests |
| `test/core.test.mjs` | modify | `indexRecord` pending |
| `test/e2e/run.mjs` | modify | pending-then-done flow, progress tab, badge history |

---

### Task 1: Progress model

**Files:**
- Create: `extension/core/progress.js`
- Test: `test/progress.test.mjs`

**Interfaces:**
- Produces:
  - `STAGES` (object: stage → `{ label, badge }`)
  - `labelFor(stage)`
  - `badgeFor(stage)`
  - `addStep(steps, { stage, text, at }) → steps[]`. Each step is `{ stage, text, start, end? }`.
  - `elapsed(step, now) → ms`
  - `formatElapsed(ms) → '12 s' | '1 min 5 s'`

- [ ] **Step 1: Write the failing test.** Create `test/progress.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, labelFor, badgeFor, addStep, elapsed, formatElapsed } from '../extension/core/progress.js';

test('stage table: labels and 4-character badge codes', () => {
  const codes = Object.fromEntries(Object.entries(STAGES).map(([k, v]) => [k, v.badge]));
  assert.deepEqual(codes, {
    loading: 'LOAD', scrolling: 'SCRL', collecting: 'READ', screenshot: 'SHOT', bodies: 'BODY', sensing: 'PAGE',
    views: 'VIEW', saving: 'SAVE', analyzing: 'LOOK', done: '✓', error: '!', recording: 'REC',
  });
  for (const v of Object.values(STAGES)) assert.ok(v.badge.length <= 4);
  assert.equal(labelFor('views'), 'Extra views');
  assert.equal(labelFor('mystery'), 'mystery');
  assert.equal(badgeFor('mystery'), '…');
});

test('addStep closes the previous step, ignores duplicates, plugin events only update text', () => {
  let s = addStep([], { stage: 'loading', text: 'Reloading the page', at: 1000 });
  s = addStep(s, { stage: 'loading', text: 'Reloading the page', at: 1500 });
  assert.equal(s.length, 1);
  s = addStep(s, { stage: 'views', text: 'Tablet view', at: 4000 });
  s = addStep(s, { stage: 'views', text: 'Phone view', at: 6000 });
  assert.deepEqual(s.map((x) => [x.stage, x.text, x.start, x.end]), [
    ['loading', 'Reloading the page', 1000, 4000],
    ['views', 'Tablet view', 4000, 6000],
    ['views', 'Phone view', 6000, undefined],
  ]);
  s = addStep(s, { stage: 'plugin', text: 'Web vitals — ok', at: 6500 });
  assert.equal(s.length, 3);
  assert.equal(s[2].text, 'Web vitals — ok');
  assert.deepEqual(addStep([], { stage: 'plugin', text: 'x', at: 1 }), []);
  s = addStep(s, { stage: 'done', text: '', at: 9000 });
  assert.equal(s[2].end, 9000);
  assert.equal(s[3].end, 9000, 'done is closed immediately');
});

test('elapsed and formatting', () => {
  assert.equal(elapsed({ start: 1000, end: 4000 }, 99999), 3000);
  assert.equal(elapsed({ start: 1000 }, 6500), 5500);
  assert.equal(formatElapsed(4400), '4 s');
  assert.equal(formatElapsed(65_000), '1 min 5 s');
  assert.equal(formatElapsed(0), '0 s');
});
```

- [ ] **Step 2: Run the test and check that it fails.**

Run: `node --test test/progress.test.mjs`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Create `extension/core/progress.js`.**

```js
// Progress of a reading — shared by the service worker (badge, tooltip, status), the popup and the
// reading tab's live checklist. Pure.

export const STAGES = {
  loading: { label: 'Reloading the page', badge: 'LOAD' },
  scrolling: { label: 'Scrolling for lazy content', badge: 'SCRL' },
  collecting: { label: 'Reading the page', badge: 'READ' },
  screenshot: { label: 'Screenshots', badge: 'SHOT' },
  bodies: { label: 'Response bodies', badge: 'BODY' },
  sensing: { label: 'In-page checks', badge: 'PAGE' },
  views: { label: 'Extra views', badge: 'VIEW' },
  saving: { label: 'Saving', badge: 'SAVE' },
  analyzing: { label: 'Analysis and lookups', badge: 'LOOK' },
  done: { label: 'Done', badge: '✓' },
  error: { label: 'Failed', badge: '!' },
  recording: { label: 'Recording', badge: 'REC' },
};

export const labelFor = (stage) => STAGES[stage]?.label || String(stage);
export const badgeFor = (stage) => STAGES[stage]?.badge ?? '…';

/** Append a step, closing the open one. 'plugin' events only update the current step's text. */
export function addStep(steps = [], { stage, text = '', at }) {
  const last = steps[steps.length - 1];
  if (stage === 'plugin') return last ? [...steps.slice(0, -1), { ...last, text }] : steps;
  if (last && last.stage === stage && last.text === text) return steps;
  const before = last && last.end == null ? [...steps.slice(0, -1), { ...last, end: at }] : steps;
  const step = { stage, text, start: at };
  if (stage === 'done' || stage === 'error') step.end = at;
  return [...before, step];
}

export const elapsed = (step, now) => Math.max(0, (step.end ?? now) - step.start);

export function formatElapsed(ms) {
  const s = Math.round(Math.max(0, ms) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
```

- [ ] **Step 4: Run the tests and check that they pass.**

Run: `node --test test/progress.test.mjs`, then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add extension/core/progress.js test/progress.test.mjs
git commit -m "Progress model: stages, badge codes, step history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Progress checklist view

**Files:**
- Create: `extension/ui/progress-view.js`
- Modify: `extension/ui/theme.css` (`@layer pages`, reading section)
- Test: `test/progress.test.mjs` (append)

**Interfaces:**
- Consumes `labelFor`, `elapsed` and `formatElapsed` (Task 1), `html` from `./html.js`, and `icon` from `./charts.js`.
- Produces `renderProgress({ host, steps, plugins, startedAt, now, error, retry }) → Raw`.
  - Each entry in `plugins` is `{ id, name, status: 'running'|'ok'|'skipped'|'error', start, end?, error? }`.
  - When `retry` is true and `error` is set, the output includes `<button … id="retry">Try again</button>`.

- [ ] **Step 1: Write the failing test.** Append to `test/progress.test.mjs`:

```js
import { renderProgress } from '../extension/ui/progress-view.js';

test('renderProgress: capture steps, running timer, plugin rows, escaping', () => {
  const steps = [
    { stage: 'loading', text: 'Reloading the page', start: 0, end: 15_000 },
    { stage: 'views', text: '<b>No JavaScript</b> view', start: 15_000 },
  ];
  const plugins = [
    { id: 'dns', name: 'DNS', status: 'ok', start: 20_000, end: 21_000 },
    { id: 'history', name: 'Wayback history', status: 'running', start: 20_000 },
    { id: 'css-validate', name: 'CSS validation', status: 'error', error: 'timed out <script>', start: 20_000, end: 50_000 },
  ];
  const s = String(renderProgress({ host: 'ucsd.edu', steps, plugins, startedAt: 0, now: 41_000 }));
  assert.match(s, /Reading ucsd\.edu/);
  assert.match(s, /· 41 s/);
  assert.match(s, /prog-row prog-ok[\s\S]*?Reloading the page[\s\S]*?15 s/);
  assert.match(s, /prog-row prog-running[\s\S]*?Extra views[\s\S]*?&lt;b&gt;No JavaScript&lt;\/b&gt; view[\s\S]*?26 s/);
  assert.match(s, /<h2>Analysis and lookups<\/h2>/);
  assert.match(s, /prog-row prog-running[\s\S]*?Wayback history[\s\S]*?21 s/);
  assert.match(s, /prog-row prog-error[\s\S]*?timed out &lt;script&gt;/);
  assert.doesNotMatch(s, /<script>|<b>No/);
  assert.match(s, /You can switch tabs/);
});

test('renderProgress: error with retry; empty is safe', () => {
  const s = String(renderProgress({ host: 'x.test', steps: [{ stage: 'error', text: 'Cannot inspect this tab', start: 5, end: 5 }], error: 'Cannot inspect this tab', retry: true, now: 10 }));
  assert.match(s, /class="error"/);
  assert.match(s, /id="retry"/);
  assert.match(s, /prog-row prog-error/);
  assert.doesNotMatch(String(renderProgress({ now: 0 })), /undefined|NaN/);
});
```

Arithmetic check:
- The views step runs from 15,000 to now (41,000), which is 26 s.
- `history` runs from 20,000 to 41,000, which is 21 s.
- Header elapsed: now − startedAt = 41 s.

- [ ] **Step 2: Run the test and check that it fails.**

Run: `node --test test/progress.test.mjs`
Expected: FAIL with `Cannot find module …/progress-view.js`.

- [ ] **Step 3: Create `extension/ui/progress-view.js`.**

```js
// The live checklist a reading tab shows while the reading is captured and analysed. Pure markup.

import { html } from './html.js';
import { icon } from './charts.js';
import { labelFor, elapsed, formatElapsed } from '../core/progress.js';

function row(state, label, text, ms) {
  const mark = state === 'running'
    ? html`<span class="status-dot status-running" aria-hidden="true"></span>`
    : icon(state === 'error' ? 'fail' : state === 'skipped' ? 'info' : 'ok', { size: 14, title: state });
  return html`<li class="prog-row prog-${state}">${mark}<span class="prog-label">${label}</span><span class="prog-text">${text || ''}</span><span class="prog-time">${formatElapsed(ms)}</span></li>`;
}

export function renderProgress({ host = '', steps = [], plugins = [], startedAt, now = Date.now(), error = '', retry = false } = {}) {
  const t0 = startedAt ?? steps[0]?.start ?? now;
  const capture = steps.filter((s) => s.stage !== 'done');
  return html`<section class="card progress" aria-live="polite">
    <h1>Reading ${host || 'page'} <small>· ${formatElapsed(now - t0)}</small></h1>
    ${error ? html`<p class="error">${error}</p>${retry ? html`<p><button class="btn primary" type="button" id="retry">Try again</button></p>` : ''}` : ''}
    ${capture.length ? html`<h2>Capture</h2><ol class="prog-list">${capture.map((s) => row(
      s.stage === 'error' ? 'error' : s.end == null ? 'running' : 'ok', labelFor(s.stage), s.text, elapsed(s, now),
    ))}</ol>` : ''}
    ${plugins.length ? html`<h2>Analysis and lookups</h2><ol class="prog-list">${plugins.map((p) => row(
      p.status, p.name, p.status === 'error' || p.status === 'skipped' ? p.error || p.status : '', (p.end ?? now) - p.start,
    ))}</ol>` : ''}
    <p class="note">You can switch tabs — this page finishes the lookups and turns into the report.</p>
  </section>`;
}
```

- [ ] **Step 4: Add CSS.** In `extension/ui/theme.css`, inside `@layer pages`, after the report layout rules and before the `@media (max-width: 900px)` block, add:

```css
  /* ---------- reading progress checklist ---------- */
  .progress { max-width: 760px; margin: 2rem auto; display: grid; gap: 0.6rem; }
  .progress h1 small { color: var(--muted); font-weight: 400; font-size: 0.9rem; }
  .prog-list { list-style: none; padding: 0; margin: 0; }
  .prog-row { display: grid; grid-template-columns: 16px minmax(9rem, max-content) minmax(0, 1fr) auto; gap: 0.6rem; align-items: center; padding: 0.3rem 0; border-top: 1px solid var(--line); font-size: 0.88rem; }
  .prog-row:first-child { border-top: 0; }
  .prog-row .status-dot { justify-self: center; }
  .prog-running .prog-label { font-weight: 600; }
  .prog-text { color: var(--muted); overflow-wrap: anywhere; }
  .prog-time { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
```

- [ ] **Step 5: Run the tests and check that they pass.**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add extension/ui/progress-view.js extension/ui/theme.css test/progress.test.mjs
git commit -m "Progress checklist view for the reading tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Service worker saves early, opens the progress tab, and tracks steps

**Files:**
- Modify: `extension/background.js` (`report`, `complete`, `capture`, `stop`, handlers)
- Modify: `extension/core/harplus.js` (`indexRecord`)
- Test: `test/core.test.mjs` (append)

**Interfaces:**
- Consumes `addStep`, `badgeFor` and `labelFor` (Task 1).
- Produces:
  - `status.get(tabId)` returns `{ startedAt, steps, badges, progressTabId, readingId, stage, text, at, tabId }`.
  - `harplus:progress` messages carry the same fields.
  - A new message handler, `harplus:analysis`, accepts `{ tabId, stage, text, readingId }`.
  - `capture(tabId, overrides)` accepts `overrides.progressTab`, which reuses an existing progress tab.
  - `capture` and `stop` resolve with the reading id after the reading is saved as pending.
  - `indexRecord(...).pending` is a boolean.

- [ ] **Step 1: Write the failing test.** Append to `test/core.test.mjs`. The file already imports from `../extension/core/harplus.js`; add `indexRecord` to that import if it isn't there yet.

```js
test('indexRecord marks pending analysis; old readings are not pending', async () => {
  const { indexRecord } = await import('../extension/core/harplus.js');
  const r = { log: { entries: [], _harplus: { id: 'x', target: {}, capture: {}, screenshots: [], plugins: {}, analysis: 'pending' } } };
  assert.equal(indexRecord(r).pending, true);
  r.log._harplus.analysis = 'done';
  assert.equal(indexRecord(r).pending, false);
  delete r.log._harplus.analysis;
  assert.equal(indexRecord(r).pending, false);
});
```

- [ ] **Step 2: Run the test and check that it fails.**

Run: `node --test test/core.test.mjs`
Expected: FAIL, because `indexRecord(r).pending` is `undefined`.

- [ ] **Step 3: `indexRecord`.** In `extension/core/harplus.js`, add `pending: hp.analysis === 'pending',` to the object `indexRecord` returns, after `notes`.

- [ ] **Step 4: Rewrite the reporting and flow in `extension/background.js`.**

Add this import:

```js
import { addStep, badgeFor, labelFor } from './core/progress.js';
```

Replace `report`, `badge`, `complete`, `capture`, `record`, `stop` and the `handlers` object with the following. Keep `fail`, `assertIdle`, the listeners and `globalThis.harplus` as they are, and remove the now-unused `runPlugins` import.

```js
const COLORS = { error: '#c92a2a', done: '#2b8a3e', recording: '#c92a2a' };

function badge(tabId, text, color = '#1971c2') {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

function report(tabId, stage, detail) {
  const text = typeof detail === 'string' ? detail
    : detail?.text ?? (detail?.name ? `${detail.name} — ${detail.status}${detail.error ? `: ${detail.error}` : ''}` : '');
  const prev = status.get(tabId) || {};
  const at = Date.now();
  const s = { ...prev, tabId, stage: stage === 'plugin' ? prev.stage || 'sensing' : stage, text, at, steps: addStep(prev.steps, { stage, text, at }) };
  if (detail?.readingId) s.readingId = detail.readingId;
  if (stage !== 'plugin') {
    const code = badgeFor(stage);
    const badges = prev.badges || [];
    s.badges = badges[badges.length - 1] === code ? badges : [...badges, code];
    badge(tabId, code, COLORS[stage]);
  }
  chrome.action.setTitle({ tabId, title: `HAR-PLUS — ${labelFor(s.stage)}${text ? `: ${text}` : ''}` }).catch(() => {});
  status.set(tabId, s);
  chrome.runtime.sendMessage({ type: 'harplus:progress', ...s }).catch(() => {});
}

/** A background tab next to the captured one that shows progress and becomes the report. */
async function openProgressTab(tabId, query) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const t = await chrome.tabs.create({ url: chrome.runtime.getURL(`ui/reading.html?${query}`), active: false, index: tab.index + 1, windowId: tab.windowId });
    return t.id;
  } catch {
    return null;
  }
}

/** Save the captured reading at once (analysis pending); the reading tab finishes it. */
async function complete(tabId, reading) {
  report(tabId, 'saving', 'Saving the reading');
  reading.log._harplus.analysis = 'pending';
  const id = await saveReading(reading);
  const s = status.get(tabId) || {};
  const alive = s.progressTabId != null && await chrome.tabs.get(s.progressTabId).then(() => true, () => false);
  if (!alive) status.set(tabId, { ...s, progressTabId: await openProgressTab(tabId, `id=${id}&tab=${tabId}`) });
  report(tabId, 'analyzing', { readingId: id, text: 'Finishing lookups in the reading tab' });
  return id;
}

async function begin(tabId, progressTab) {
  status.set(tabId, { startedAt: Date.now(), steps: [], badges: [] });
  const progressTabId = progressTab ?? await openProgressTab(tabId, `capture=${tabId}`);
  status.set(tabId, { ...status.get(tabId), progressTabId });
  badge(tabId, '…');
}

export async function capture(tabId, overrides = {}) {
  assertIdle(tabId);
  const settings = await getSettings();
  const { progressTab, ...rest } = overrides;
  const opts = { ...settings.capture, ...rest };
  if (opts.mode === 'record') return record(tabId, rest);
  const plugins = getPlugins(settings);
  await begin(tabId, progressTab);
  try {
    const reading = await takeReading(tabId, opts, { plugins, settings, report: (st, d) => report(tabId, st, d) });
    return await complete(tabId, reading);
  } catch (e) {
    await fail(tabId, e);
    throw e;
  }
}

export async function record(tabId, overrides = {}) {
  assertIdle(tabId);
  const settings = await getSettings();
  const opts = { ...settings.capture, ...overrides };
  status.set(tabId, { startedAt: Date.now(), steps: [], badges: [] });
  await startRecording(tabId, opts, { report: (st, d) => report(tabId, st, d) });
  report(tabId, 'recording', 'Recording — browse, then press Stop');
}

export async function stop(tabId) {
  const settings = await getSettings();
  const plugins = getPlugins(settings);
  const prev = status.get(tabId) || {};
  status.set(tabId, { ...prev, progressTabId: await openProgressTab(tabId, `capture=${tabId}`) });
  badge(tabId, '…');
  try {
    const reading = await stopRecording(tabId, { plugins, settings, report: (st, d) => report(tabId, st, d) });
    return await complete(tabId, reading);
  } catch (e) {
    await fail(tabId, e);
    throw e;
  }
}

const handlers = {
  'harplus:capture': (m) => { assertIdle(m.tabId); capture(m.tabId, m.options).catch(() => {}); return { started: true }; },
  'harplus:record-start': async (m) => { await record(m.tabId, m.options); return { recording: true }; },
  'harplus:record-stop': (m) => { stop(m.tabId).catch(() => {}); return { stopping: true }; },
  'harplus:status': (m) => ({ busy: isBusy(m.tabId), recording: isRecording(m.tabId), status: status.get(m.tabId) || null }),
  'harplus:analysis': async (m) => {
    if (m.tabId == null) return { ok: false };
    if (m.stage === 'done') {
      report(m.tabId, 'done', { readingId: m.readingId, text: 'Reading complete' });
      setTimeout(() => badge(m.tabId, ''), 5000);
      const settings = await getSettings();
      const pt = status.get(m.tabId)?.progressTabId;
      if (settings.ui.openWhenDone && pt != null) chrome.tabs.update(pt, { active: true }).catch(() => {});
    } else {
      report(m.tabId, m.stage === 'error' ? 'error' : 'plugin', m.text || '');
    }
    return { ok: true };
  },
};
```

Notes:
- `fail()` still calls `report(tabId, 'error', e.message)` and `badge(tabId, '!', '#c92a2a')`. Keep it.
- The old `complete()` ran plugins and opened the reading itself. Both are gone. When the reading tab finishes, it sends `harplus:analysis`.
- In `complete()`, a `plugin` stage report goes to the steps as a text update only. The `analyzing` step carries the `readingId`, which the `?capture=` tab uses to switch to the reading.

- [ ] **Step 5: Run the tests and an import check.**

Run: `npm test`, then `node -e "import('./extension/background.js').catch(e => { if (!/chrome is not defined/.test(e.message)) throw e; console.log('import ok (chrome unavailable in node)'); })"`
Expected: PASS, and the module parses.

- [ ] **Step 6: Commit.**

```bash
git add extension/background.js extension/core/harplus.js test/core.test.mjs
git commit -m "Service worker: save readings before analysis, open a progress tab, badge stage codes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Reading tab follows the capture, finishes the analysis and shows progress; library and popup

**Files:**
- Modify: `extension/ui/reading.js` (params, init, finish analysis, progress panel, re-run, retry)
- Modify: `extension/ui/library.js` (`card`)
- Modify: `extension/ui/popup.js` (progress message handling, init status)
- Test: unit tests stay green. Runtime coverage comes from the Task 5 e2e.

**Interfaces:**
- Consumes:
  - `renderProgress` (Task 2) and `labelFor`, `formatElapsed` (Task 1);
  - the `harplus:status`, `harplus:progress` and `harplus:analysis` messages (Task 3);
  - `getReading`, `saveReading` and `runPlugins`.
- Produces:
  - Reading tab URL modes: `?capture=<tabId>`, `?id=<id>&tab=<tabId>` and `?id=<id>`.
  - Library card chip `<span class="chip pending">Finishing…</span>`.

- [ ] **Step 1: Reading page params and state** (`extension/ui/reading.js`). Replace

```js
const id = new URLSearchParams(location.search).get('id');
```

with

```js
const params = new URLSearchParams(location.search);
let id = params.get('id');
const captureTab = params.has('capture') ? Number(params.get('capture')) : null;
let sourceTab = params.has('tab') ? Number(params.get('tab')) : captureTab;
const prog = { host: '', steps: [], plugins: [], startedAt: null, error: '', active: false };
let ticker = null;
```

Add these imports:

```js
import { renderProgress } from './progress-view.js';
```

- [ ] **Step 2: Progress panel helpers.** Add them after the `hp` helper:

```js
/* ------------------------------------------------------------- progress */

function paintProgress() {
  if (!prog.active) return;
  $('#app').innerHTML = String(renderProgress({ ...prog, now: Date.now(), retry: captureTab != null }));
  document.title = `${prog.error ? 'Failed' : 'Reading'} ${prog.host || ''} — HAR-PLUS`;
}

function showProgress() {
  prog.active = true;
  paintProgress();
  ticker ??= setInterval(paintProgress, 1000);
}

function hideProgress() {
  prog.active = false;
  clearInterval(ticker);
  ticker = null;
}

function tellWorker(stage, extra = {}) {
  if (sourceTab == null) return;
  chrome.runtime.sendMessage({ type: 'harplus:analysis', tabId: sourceTab, stage, ...extra }).catch(() => {});
}

function applyStatus(s) {
  if (!s) return;
  if (s.steps) prog.steps = s.steps;
  if (s.startedAt) prog.startedAt = s.startedAt;
  if (s.stage === 'error') prog.error = s.text || 'The reading failed';
  paintProgress();
  if (s.readingId && !reading && !id) {
    id = s.readingId;
    history.replaceState(null, '', `?id=${encodeURIComponent(id)}&tab=${sourceTab}`);
    openReading();
  }
}

async function followCapture() {
  chrome.tabs.get(captureTab).then((t) => { try { prog.host = new URL(t.url).host; } catch { /* keep blank */ } paintProgress(); }, () => {});
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'harplus:progress' && msg.tabId === captureTab) applyStatus(msg);
  });
  const st = await chrome.runtime.sendMessage({ type: 'harplus:status', tabId: captureTab }).catch(() => null);
  applyStatus(st?.status);
}

/** Run the analyze + enrich phases here (extension pages have no service-worker time limit). */
async function finishAnalysis({ notify }) {
  prog.plugins = [];
  prog.host ||= hp().target?.host || '';
  showProgress();
  try {
    await runPlugins(reading, plugins, {
      phases: ['analyze', 'enrich'],
      settings,
      onProgress: (p) => {
        const now = Date.now();
        const row = prog.plugins.find((x) => x.id === p.plugin);
        if (p.status === 'running') {
          if (!row) prog.plugins.push({ id: p.plugin, name: p.name, status: 'running', start: now });
        } else if (row) {
          Object.assign(row, { status: p.status, error: p.error, end: now });
        }
        paintProgress();
        if (notify && p.status !== 'running') tellWorker('plugin', { text: `${p.name} — ${p.status}` });
      },
    });
    hp().analysis = 'done';
    await saveReading(reading);
    if (notify) tellWorker('done', { readingId: id });
  } catch (e) {
    hp().analysis = 'done';
    await saveReading(reading).catch(() => {});
    if (notify) tellWorker('error', { text: e.message });
  }
  hideProgress();
  render();
  toast('Reading complete');
}

async function openReading() {
  reading = await getReading(id);
  if (!reading) {
    hideProgress();
    $('#app').innerHTML = '<p class="empty">Reading not found. <a href="library.html">Back to readings</a></p>';
    return;
  }
  if (hp().analysis === 'pending') await finishAnalysis({ notify: true });
  else { hideProgress(); render(); }
}
```

- [ ] **Step 3: `init`, re-run and retry.**

Replace `init()` with:

```js
async function init() {
  settings = await getSettings();
  plugins = getPlugins(settings);
  if (captureTab != null && !id) {
    showProgress();
    followCapture();
    return;
  }
  if (sourceTab != null) {
    const st = await chrome.runtime.sendMessage({ type: 'harplus:status', tabId: sourceTab }).catch(() => null);
    if (st?.status?.steps) { prog.steps = st.status.steps; prog.startedAt = st.status.startedAt; }
  }
  await openReading();
}
```

Replace the `#rerun` click handler body with:

```js
$('#rerun').addEventListener('click', async () => {
  if (!reading) return;
  const btn = $('#rerun');
  btn.disabled = true;
  settings = await getSettings();
  plugins = getPlugins(settings);
  prog.steps = [];
  prog.startedAt = Date.now();
  await finishAnalysis({ notify: false });
  btn.disabled = false;
});
```

Add the retry, and guard delete. In the document `click` listener, at the top (before the `zoom` lookup), add:

```js
  if (t.closest('#retry') && captureTab != null) {
    prog.error = '';
    prog.steps = [];
    prog.startedAt = Date.now();
    paintProgress();
    const tabId = (await chrome.tabs.getCurrent())?.id;
    chrome.runtime.sendMessage({ type: 'harplus:capture', tabId: captureTab, options: { progressTab: tabId } }).catch(() => {});
    return;
  }
```

In the `#delete` handler, add `if (!id) return;` as its first line.

- [ ] **Step 4: Library chip.** In `extension/ui/library.js` `card(r)`, after the host line `<div class="host">${r.host}</div>`, add:

```js
      ${r.pending ? html`<span class="chip pending" title="Open to finish the lookups">Finishing…</span>` : ''}
```

- [ ] **Step 5: Popup.** In `extension/ui/popup.js`, add `import { labelFor, formatElapsed } from '../core/progress.js';` and a helper:

```js
function describe(s) {
  if (!s) return '';
  const secs = s.startedAt ? ` · ${formatElapsed(Date.now() - s.startedAt)}` : '';
  return `${labelFor(s.stage)}${s.text ? ` — ${s.text}` : ''}${secs}`;
}
```

In `init()`, change `setStatus(st.status?.text || (recording ? 'Recording…' : 'Working…'))` to `setStatus(describe(st.status) || (recording ? 'Recording…' : 'Working…'))`.

Replace the final `else if (msg.stage !== 'recording') { setStatus(msg.text); }` branch with:

```js
  } else if (msg.stage === 'analyzing' && msg.readingId) {
    setStatus('Saved — finishing lookups in the reading tab', { link: `reading.html?id=${msg.readingId}&tab=${msg.tabId}` });
    setBusy(false);
  } else if (msg.stage !== 'recording') {
    setStatus(describe(msg));
  }
```

The existing `done` branch stays, with its link updated to `reading.html?id=${msg.readingId}`.

- [ ] **Step 6: Run the tests and import checks.**

Run: `npm test`
Expected: PASS. The runtime behaviour is exercised by Task 5.

- [ ] **Step 7: Commit.**

```bash
git add extension/ui/reading.js extension/ui/library.js extension/ui/popup.js
git commit -m "Reading tab follows the capture, finishes lookups with a live checklist; library and popup show progress

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end — pending, then done, plus the progress tab and badge history

**Files:**
- Modify: `test/e2e/run.mjs`

**Interfaces:**
- Consumes everything above. `globalThis.harplus.status` is the status `Map` exposed by `background.js`.

- [ ] **Step 1: Add a wait helper.** Directly after the line `const getReading = (id) => page2.evaluate(...)`, add:

```js
    const waitDone = async (rid, ms = 120_000) => {
      const t = Date.now();
      for (;;) {
        const r = await getReading(rid);
        if (r && r.log._harplus.analysis !== 'pending') return r;
        if (Date.now() - t > ms) throw new Error(`analysis still pending after ${ms / 1000}s`);
        await new Promise((res) => setTimeout(res, 500));
      }
    };
```

- [ ] **Step 2: Reading 1 is saved pending, finishes in the progress tab, and the badge sequence is right.** Replace `const r1 = await getReading(id1);` with:

```js
    const pending1 = await getReading(id1);
    assert.equal(pending1.log._harplus.analysis, 'pending', 'saved before analysis');
    const tabUrls = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url));
    assert.ok(tabUrls.some((u) => /\/ui\/reading\.html\?/.test(u) && (u.includes(`capture=${tabId}`) || u.includes(`id=${id1}`))), `progress tab open: ${tabUrls.join(', ')}`);
    const r1 = await waitDone(id1);
    for (let i = 0; i < 20; i++) {
      const b = await sw.evaluate((t) => globalThis.harplus.status.get(t)?.badges || [], tabId);
      if (b.at(-1) === '✓') break;
      await new Promise((res) => setTimeout(res, 250));
    }
    const badges = await sw.evaluate((t) => globalThis.harplus.status.get(t)?.badges || [], tabId);
    assert.ok(badges.includes('VIEW') && badges.includes('LOOK') && badges.at(-1) === '✓', `badge sequence: ${badges.join(' ')}`);
```

The `page2` creation and `goto` currently come after `id1`. Move the two lines

```js
    const page2 = await context.newPage();
    …page2.on(...) lines…
    await page2.goto(extUrl('ui/library.html'));
```

above `const id1 = …`, so that `getReading` and `waitDone` are usable straight after capture. Keep the `getReading` definition after `page2` exists.

- [ ] **Step 3: The other readings.** Make three replacements:
  - `const r2 = await getReading(id2);` → `const r2 = await waitDone(id2);`
  - `const r3 = await getReading(id3);` → `const r3 = await waitDone(id3);`
  - `const r4 = await getReading(id4);` → `const r4 = await waitDone(id4);`

- [ ] **Step 4: Run.**

Run: `npm run test:e2e`, then `npm test`
Expected: "all e2e checks passed".
- If a pre-existing assertion about plugin results fails, the analysis didn't finish. Investigate the reading tab: add `context.on('page', p => p.on('console', m => console.log('[tab]', m.text())))` temporarily. Fix the cause in Tasks 3–4 code, and report it.
- Existing assertions about the library card count (4) still hold. Progress tabs are not reading cards.
- Look at `test/e2e/out/popup.png` and report what it shows.

- [ ] **Step 5: Commit.**

```bash
git add test/e2e/run.mjs
git commit -m "E2E: readings saved pending, finished in the progress tab, badge stage history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
