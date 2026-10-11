# HARgus: Rename, Brand, Popup, Presets and Options — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The extension becomes **HARgus** with a new mark, palette and bundled fonts. The popup becomes one action, with a reading-type switch, a preset-driven Setup line, and progress and result views. Four presets replace the popup's checkbox lists, Options is reorganised into sections, and the toolbar badge shows the last grade for the active site. The HAR-PLUS format and every stored identifier stay as they are.

**Architecture:**
- **Shared helpers.** Two new pure modules, used by the popup, Options, the service worker, the reading tab and the CLI:
  - `core/presets.js`: preset model, resolution, offline filtering, summaries, estimates;
  - `core/badge.js`: grade → badge text, colour and title.
- **Preset applied at capture time.** The service worker resolves the active preset into capture options and records `_harplus.capture.preset` on the reading.
- **Preset honoured afterwards.** Analysis, including re-runs, reads `preset.lookups` from the reading, not from settings.
- **Popup.** It keeps one HTML file with four `hidden`-toggled sections.
- **Options.** It is regrouped; the settings paths keep their existing names.

**Tech Stack:** Vanilla ES modules, no build step, no dependencies. Unit tests use `node:test`. The end-to-end test uses Playwright with Chromium and the unpacked extension.

**Spec:** `docs/superpowers/specs/2026-10-11-hargus-brand-and-popup-design.md` (read it first).

**Mockups:** `docs/superpowers/mockups/2026-10-11-hargus/*.html|png`. The inline styles there are the visual reference; implement with `theme.css` tokens and classes.

**Brand assets:** `docs/brand/` (README, tokens, SVGs, icons, fonts).

## Global Constraints

- No build step and no dependencies in `extension/` or `cli/`.
- **Do not rename:**
  - the IndexedDB name `harplus` or its stores;
  - `chrome.storage` keys;
  - `harplus:*` message types;
  - `log._harplus`;
  - `data-harplus-*` attributes;
  - the `harplus-reference-data` cache;
  - the `harplus-analysis:*` locks;
  - `cli/harplus.mjs`;
  - `.plus.har`.

  Existing readings must open, score and export unchanged.
- The product name is always written **HARgus**. The format is always written **HAR-PLUS**.
- Grade colours (`--st-*`, `--ink-*`, `--band-*`) do not change. Teal (`--accent`) is never used to mean a grade.
- No counts or times are hard-coded in the interface. Everything comes from `presetSummary`, the plugin list or `estimateMs`.
- The popup is 360 px wide and at most 600 px tall.
- **Accessibility:**
  - segmented controls are `role="group"` with a label and buttons with `aria-pressed`;
  - controls are at least 40 px tall;
  - focus shows as a visible `--accent` ring;
  - status messages go through the existing `aria-live` output;
  - icons have text alternatives or `aria-hidden`.
- Every interpolated value goes through the escaping `html` tag.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Older readings and settings:**
   - readings with no `capture.preset` analyse as today (lookups on);
   - settings with no `presets` migrate exactly once;
   - a changed `capture.views` becomes "My views".

   Pinned in Task 3 (migration tests) and Task 10 (fixture reading opens).
2. **Private means private:**
   - a reading taken with lookups off never runs a plugin with a `disclosure`, now or on "Re-run analysis", except plugins with `offlineOptions`, which run with those options;
   - `tech` gets `fingerprintDb: false`.

   Pinned in Task 4 and the e2e contacted-hosts assertion.
3. **Cancel leaves a clean tab:**
   - `harplus:cancel` detaches;
   - if views had started, the tab reloads (no-CSS and no-images change the page in place);
   - the badge and status clear.

   Pinned in Task 7.
4. **Badge correctness:**
   - the grade belongs to the tab's *host*;
   - progress codes win while busy;
   - the badge clears when the last reading of that host is deleted or the setting is off.

   Pinned in Task 6.
5. **Exactly-one primary action.** Every popup state has one primary-styled button. Pinned by visual check in Task 10.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `extension/icons/icon-*.png` | replace | from `docs/brand/icons/` |
| `extension/ui/fonts/*` | create | woff2 and OFL files from `docs/brand/fonts/` |
| `extension/ui/theme.css` | modify | `@font-face`, token values, new tokens, `.brand`/`.wordmark`/`.mark`, segmented control, primary button, popup views, Options layout |
| `extension/manifest.json` | modify | name, short_name, description, default_title |
| `extension/ui/{popup,library,reading,options}.html` | modify | titles, brand markup |
| `extension/ui/report.js` | modify | export brand, title, generator |
| `extension/core/harplus.js` | modify | `CREATOR.name`, `indexRecord` + `preset`, `durationMs` |
| `extension/core/presets.js` | create | preset model and pure functions |
| `extension/core/badge.js` | create | `gradeBadge(record, now)` |
| `extension/browser/settings.js` | modify | `presets`, `preset`, `ui.gradeBadge`, migration |
| `extension/browser/store.js` | modify | `latestForHost`, `recentIndex`; message wording |
| `extension/background.js` | modify | `captureOptions`, record preset, `harplus:cancel`, grade badge wiring, titles, `globalThis.hargus` |
| `extension/browser/capture.js` | modify | write `capture.preset` into the reading (if not done in `background.js`) |
| `extension/core/plugin-host.js` | modify | `presetPlugins` filter and `offlineOptions` merge, honouring `reading._harplus.capture.preset` |
| `extension/plugins/tech.js` | modify | `offlineOptions: { fingerprintDb: false }` |
| `extension/plugins/vitals.js` | modify | note wording |
| `extension/ui/popup.js` | rewrite | four views, as the spec says |
| `extension/ui/options.html`, `options.js` | modify | sections, preset cards, grouped views, checks summary |
| `extension/ui/reading.js` | modify | page titles; analysis and re-run honour the recorded preset |
| `package.json`, `cli/harplus.mjs` | modify | `hargus` bin and usage text |
| `README.md`, `docs/FORMAT.md`, `docs/PLUGINS.md`, `docs/ARCHITECTURE.md` | modify | product name, `capture.preset`, `offlineOptions`, naming rule |
| `test/presets.test.mjs`, `test/badge.test.mjs` | create | unit tests |
| `test/core.test.mjs`, `test/report.test.mjs`, `test/vitals.test.mjs`, `test/e2e/run.mjs` | modify | as listed per task |

---

## Task 1: Brand assets and tokens

**Files:** `extension/icons/`, `extension/ui/fonts/`, `extension/ui/theme.css`

- [ ] Copy `docs/brand/icons/icon-{16,32,48,128,512}.png` over `extension/icons/`.
- [ ] Copy `docs/brand/fonts/*.woff2` and both `OFL-*.txt` files to `extension/ui/fonts/`.
- [ ] In `theme.css`:
  - put the `@font-face` rules from `docs/brand/tokens.css` above the `@layer` statement;
  - inside `@layer tokens`, replace the values of `--bg`, `--panel`, `--panel-2`, `--line`, `--text`, `--muted`, `--accent`, `--accent-soft`, `--accent-ink`, `--font` and `--mono`;
  - add `--accent-hover`, `--primary`, `--primary-ink`, `--segment`, `--radius-lg` and `--mark-*`;
  - leave every status and chart token alone.
- [ ] Add components in `@layer components`:
  - `.brand` (flex, gap 8px, `--text`, no underline), `.brand .mark` (24 px), `.wordmark` and `.wordmark b` (as in `docs/brand/README.md`);
  - `.btn.primary` using `--primary` / `--primary-ink`, radius `--radius-lg`;
  - `a:hover` using `--accent-hover`;
  - `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`;
  - `.segmented`: a grid of equal columns, 3 px padding, `--segment` background, `--radius-lg`. Its `button[aria-pressed="true"]` has a `--panel` background, weight 600 and a 1 px shadow.
- [ ] Open `ui/library.html` and `ui/reading.html` in the browser. They must render in the new fonts and colours with no layout breakage. Check light and dark mode.
- [ ] Commit: `Brand: HARgus icons, bundled fonts and tokens`.

## Task 2: Rename the product

**Files:** see spec §1 (the table is the checklist).

- [ ] **Tests first.** Update `test/report.test.mjs` (`— HARgus report`) and `test/vitals.test.mjs` (`before HARgus scrolled the page`). Add to `test/core.test.mjs`: `assert.equal(CREATOR.name, 'HARgus')`. Run them; they fail.
- [ ] **Manifest:** `name`, `short_name`, `description`, `action.default_title`.
- [ ] **Brand markup** in `popup.html`, `library.html`, `reading.html` and `options.html`:
  - replace the `<img> HAR<small>+</small>` brand with the inline mark SVG (paths from `docs/brand/hargus-mark-small.svg`, `aria-hidden="true"`) and `<span class="wordmark"><b>HAR</b>gus</span>`;
  - keep "Readings" and "Options" as a following `<span class="muted">`.
- [ ] **Titles** in those HTML files and `reading.js` (`— HARgus`).
- [ ] **`report.js` export:** the open mark (`hargus-mark-open.svg` with `currentColor`) plus the wordmark; `<title>… — HARgus report</title>`; generator `HARgus`.
- [ ] **Service worker:** in `background.js`, `setTitle` prefixes become `HARgus — `. Add `globalThis.hargus = globalThis.harplus`.
- [ ] **Wording:** `store.js` blocked message; `vitals.js` note; `CREATOR.name = 'HARgus'`.
- [ ] **`package.json`:** `"name": "hargus"`, `"bin": { "hargus": "cli/harplus.mjs", "harplus": "cli/harplus.mjs" }`, and the `hargus` script. In the CLI usage text, use `hargus …` and add one line "(`harplus` still works)".
- [ ] **Docs.** README: retitle "HARgus" and give it a first paragraph that names the HAR-PLUS format. `docs/FORMAT.md`: the creator example, plus the line "do not rely on `creator.name`". `docs/ARCHITECTURE.md` and `docs/PLUGINS.md`: product mentions. Add the "Writing the name" section to the README.
- [ ] **Leftovers:** `grep -rn "HAR-PLUS\|HAR+\|HAR<small>" extension cli README.md docs/*.md`. Every remaining hit must name the format, or be a stored identifier from the do-not-rename list.
- [ ] `npm test` passes.
- [ ] Commit: `Rename the product HARgus (format stays HAR-PLUS)`.

## Task 3: Presets model, settings and migration

**Files:** create `extension/core/presets.js`, `test/presets.test.mjs`; modify `extension/browser/settings.js`

- [ ] **Write `test/presets.test.mjs` first:**
  - `DEFAULT_PRESETS` has the four ids in `PRESET_ORDER`, with the labels from the spec;
  - `expandViews(['vision'])` returns `vision` plus the six simulation keys;
  - `captureOptions(settings)` returns a full `views` map (every key from `DEFAULTS.capture.views`, `true` only for the preset's views) and `preset: { id, label, lookups }`;
  - an unknown `settings.preset` falls back to `checkup`;
  - `migrateSettings(stored)`: no `presets` and all-on `capture.views` gives the defaults with `preset: 'checkup'`. No `presets` and changed views gives a `custom-1` "My views" preset containing exactly the toggles that were on, and it is active. Already migrated settings are unchanged.
- [ ] **Implement `core/presets.js`:**

```js
// Presets: which views a reading takes and whether lookups run. Pure; shared by every surface.
import { VISION_VIEWS } from './views.js';

export const VIEW_TOGGLES = ['desktop', 'tablet', 'mobile', 'breakpoints', 'nojs', 'nocss', 'noimages',
  'vision', 'forced', 'morecontrast', 'dark', 'spacing', 'reflow', 'text200', 'rtl', 'pseudo', 'print'];
export const VIEW_GROUPS = [
  { id: 'devices', label: 'Devices', views: ['desktop', 'tablet', 'mobile', 'breakpoints'] },
  { id: 'resilience', label: 'Resilience', views: ['nojs', 'nocss', 'noimages'] },
  { id: 'accessibility', label: 'Accessibility', views: ['vision', 'forced', 'morecontrast', 'dark', 'spacing', 'reflow', 'text200'] },
  { id: 'international', label: 'International', views: ['rtl', 'pseudo'] },
  { id: 'output', label: 'Output', views: ['print'] },
];
export const PRESET_ORDER = ['quick', 'checkup', 'deep', 'private'];
const CHECKUP_VIEWS = ['desktop', 'mobile', 'nojs', 'nocss'];
export const DEFAULT_PRESETS = {
  quick: { label: 'Quick check', views: [], lookups: false },
  checkup: { label: 'Check-up', views: CHECKUP_VIEWS, lookups: true },
  deep: { label: 'Deep dive', views: VIEW_TOGGLES, lookups: true },
  private: { label: 'Private', views: CHECKUP_VIEWS, lookups: false },
};

export const expandViews = (toggles) => [...new Set(toggles.flatMap((v) => (v === 'vision' ? ['vision', ...VISION_VIEWS] : [v])))];

export function activePreset(settings) {
  const all = { ...DEFAULT_PRESETS, ...(settings.presets || {}) };
  const id = all[settings.preset] ? settings.preset : 'checkup';
  return { id, ...all[id] };
}

export function captureOptions(settings) {
  const p = activePreset(settings);
  const on = new Set(expandViews(p.views));
  const keys = Object.keys(settings.capture?.views || {});
  const views = Object.fromEntries(keys.map((k) => [k, on.has(k)]));
  return { ...settings.capture, views, preset: { id: p.id, label: p.label, lookups: p.lookups !== false } };
}
```

  - Add `pluginRunsOffline`, `presetPlugins`, `presetSummary` and `estimateMs` with the semantics in spec §3:
    - `presetSummary` counts `views` as the preset's toggles (not expanded);
    - `checks` counts enabled plugins that run under the preset;
    - `lookups` counts those with a `disclosure` and no `offlineOptions`.
  - The `breakpoints` key exists in `DEFAULTS.capture.views` but not in `VIEWS`. Keep the map keyed by the settings keys, as in the snippet above.
- [ ] **In `settings.js`:**
  - add `presets: structuredClone(DEFAULT_PRESETS)`, `preset: 'checkup'` and `ui.gradeBadge: true` to `DEFAULTS`;
  - add an exported `migrateSettings(stored)`;
  - call it inside `getSettings()` before `merge`, and persist the result once when it changed.
- [ ] `npm test` passes.
- [ ] Commit: `Presets: model, resolution and settings migration`.

## Task 4: Apply presets to capture and analysis (privacy)

**Files:** `background.js`, `core/plugin-host.js`, `plugins/tech.js`, `reading.js`, `cli/harplus.mjs`, `docs/FORMAT.md`, `docs/PLUGINS.md`, tests

- [ ] **Tests first** (`test/core.test.mjs`). Build a reading with `_harplus.capture.preset = { id: 'private', lookups: false }`. Run `runPlugins` over `getPlugins()` with a `fetch` that throws.
  - No result may have `status: 'error'` from a network attempt.
  - Plugins with a `disclosure` and no `offlineOptions` are absent or `skipped`, with the reason "lookups off (preset)".
  - `tech` ran, and its result data shows `fingerprints == null`.
  - The same reading with no `preset` behaves as today.
- [ ] **`tech.js`:** add `offlineOptions: { fingerprintDb: false }`.
- [ ] **`plugin-host.js`:**
  - when `reading.log._harplus.capture?.preset?.lookups === false`, skip plugins for which `pluginRunsOffline` is false, recording them as `skipped` with that reason;
  - merge `offlineOptions` over `pluginOptions(...)` for the rest;
  - this one code path covers the capture, the reading tab, "Re-run analysis" and the CLI.
- [ ] **`background.js` `capture()`:**
  - `const opts = { ...captureOptions(settings), ...rest }`;
  - make sure `opts.preset` reaches `_harplus.capture.preset`: pass it through `takeReading`, or set it in `complete()` before `saveReading`.
  - Recording (`startRecord`) records the preset too.
- [ ] **CLI:** `--no-lookups` keeps working. When the input file has `capture.preset.lookups === false`, the CLI honours it unless `--lookups` is passed.
- [ ] **Docs:** `docs/FORMAT.md` documents `capture.preset`. `docs/PLUGINS.md` documents `offlineOptions`.
- [ ] `npm test` passes.
- [ ] Commit: `Presets drive capture views; readings with lookups off stay offline`.

## Task 5: Index additions, estimates, latest reading for a host

**Files:** `core/harplus.js`, `browser/store.js`, `core/presets.js`, tests

- [ ] **Tests first:**
  - `indexRecord` includes `preset` (id or `null`) and `durationMs`;
  - `estimateMs(records, 'checkup')` is the median of the newest five with that preset, rounded to 5 s, and `null` when there are none;
  - `latestForHost` is tested through a small in-memory stub (pure helper `pickLatest(records, host)` exported from `store.js` or `core/harplus.js`).
- [ ] **Implement:**
  - `indexRecord` adds `preset: hp.capture?.preset?.id ?? null` and `durationMs: hp.capture?.durationMs ?? null`;
  - `store.js` adds `latestForHost(host)` and `recentIndex(limit)`, both reading the `index` store sorted by `capturedAt` descending;
  - `rescoreAll` already rewrites index records, so the new fields appear on rescore.
- [ ] `npm test` passes.
- [ ] Commit: `Index: preset and duration; latest reading per host; estimates`.

## Task 6: Toolbar grade badge

**Files:** create `core/badge.js`, `test/badge.test.mjs`; modify `background.js`, `options.html`/`options.js` (toggle in Task 9)

- [ ] **Tests first:**
  - `gradeBadge({ grade: 'C', status: 'warning', score: 76, capturedAt })` gives `text: 'C'`, `color: '#fab219'`, `textColor: '#101826'`, and a title that contains "C (76)";
  - critical gives `textColor: '#ffffff'`;
  - status `none` or a `null` record gives `null`;
  - "D−" (U+2212) passes through unchanged.
- [ ] **Implement `core/badge.js`:**

```js
const COLOR = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };
export function gradeBadge(record, now = Date.now()) {
  if (!record || !COLOR[record.status] || !record.grade) return null;
  return {
    text: record.grade.slice(0, 2),
    color: COLOR[record.status],
    textColor: record.status === 'critical' ? '#ffffff' : '#101826',
    title: `HARgus — last reading ${record.grade} (${Math.round(record.score)}) · ${relativeDay(record.capturedAt, now)}`,
  };
}
```

  - `relativeDay` returns "today", "yesterday", "N days ago" or a short date. Put it in `core/progress.js` or `badge.js`, unit-tested.
- [ ] **In `background.js`:**
  - add `async function showGrade(tabId)`. It returns when busy or recording, or when `settings.ui.gradeBadge === false` (clearing the text). Otherwise it gets the tab's URL host, then `latestForHost(host)`, then `gradeBadge(...)`, and sets the text, background colour, `setBadgeTextColor` and title, or clears them.
  - call it from `chrome.tabs.onActivated`, from `chrome.tabs.onUpdated` (when `changeInfo.status === 'complete' || changeInfo.url`), and from the `harplus:analysis` done path. That path replaces today's `setTimeout(() => badge(m.tabId, ''), 5000)` with `setTimeout(() => showGrade(m.tabId), 5000)`.
  - add a `harplus:readings-changed` message, sent by library and Options after deletes, that calls `showGrade` for the active tab of each window.
- [ ] Commit: `Toolbar badge shows the last grade for the tab's site`.

## Task 7: Popup — ready and setup views, cancel

**Files:** `ui/popup.html`, `ui/popup.js`, `ui/theme.css`, `background.js`

Mockups: `popup-ready.png`, `popup-setup.png` (markup in the matching `.html`).

- [ ] **Markup in `popup.html`:** sections `#ready`, `#setup`, `#working` and `#done` (all but `#ready` start `hidden`), plus one `<output id="status" aria-live="polite">`.
  - The ready header has the brand, a "Readings" button and an icon-only Options button with `aria-label="Options"`.
  - Delete the old capture-options and plugins `<details>` and the separate Record and Snapshot buttons.
- [ ] **Ready view:**
  - site block: favicon or monogram fallback, title, host;
  - last-reading card from `latestForHost(host)`, or the muted "No readings of this site yet.";
  - the reading-type `.segmented` group, bound to `settings.capture.mode`. Button labels: Reload / As it is / Journey. The primary label and help line follow the table in spec §4;
  - the primary button calls the existing `start('reload' | 'snapshot')`, or the record-start path for Journey. The estimate (`estimateMs`) is appended only when it is not `null`;
  - the Setup line, built from `activePreset` and `presetSummary(getPlugins(settings), settings, preset)`;
  - the footer shortcut from `chrome.commands.getAll()`.
- [ ] **Setup view:**
  - the preset radio list from `PRESET_ORDER` plus custom presets; selecting one writes `settings.preset`;
  - the Read-as segmented control writes `capture.device`; the Network select writes `capture.throttle`; the Score-as select writes `scoring.profile`;
  - the Options link points at `options.html#presets`;
  - Back re-renders ready.
- [ ] **Blocked pages:** keep the `BLOCKED` regex behaviour. Replace the action area with the error message; Setup stays reachable.
- [ ] **Cancel** (in `background.js`): add `'harplus:cancel'`. It calls `discard(tabId)` and clears `status` and the badge (then `showGrade`). If `status.get(tabId)?.steps` contains a `views` step, it calls `chrome.tabs.reload(tabId)`. It returns `{ cancelled: true }`.
  - **Test** (`test/recorder-busy.test.mjs` style, or a new small test with a stubbed `chrome`): cancel during views reloads; cancel before views does not.
- [ ] Load the unpacked extension and compare against the mockups at 1× and 2×, light and dark.
- [ ] Commit: `Popup: one action, reading types and the Setup panel`.

## Task 8: Popup — working and done views

**Files:** `ui/popup.js`, `ui/theme.css`

Mockups: `popup-working.png`, `popup-done.png`.

- [ ] **Working view:**
  - render from `status` (the `harplus:status` reply on open, then `harplus:progress` messages);
  - "Taking a reading" with elapsed time, updated each second while the view is visible;
  - a `role="progressbar"` showing steps done ÷ expected steps (spec §4);
  - an `<ol>` of steps with check, current and waiting icons, each with a text alternative;
  - the views count, and "Lookups ↗ · N services" or "Lookups skipped";
  - the note, Stop (`harplus:record-stop` when recording, otherwise `harplus:cancel`), and "Watch in a tab", which reuses the progress-tab focus logic.
- [ ] **Done view:**
  - on `done` for this tab (or on open within 2 minutes of the tab's latest reading, if not yet dismissed in `chrome.storage.session`), load the reading (`getReading`) and score it (`scoreReading` with the current profile);
  - render the grade tile, status word (`VERDICT`), "{n} findings · {duration} · scored as {profile}", eight area bars in two columns, and `topFindings(scores, 3)`;
  - Again (back to ready, and mark dismissed) and "Open the report" (primary).
- [ ] The existing "Saved — finishing lookups" states map onto the working view: the `saving` step is done and `analyzing` is current.
- [ ] Commit: `Popup: progress and result views`.

## Task 9: Options — sections, presets, grouped views, checks

**Files:** `ui/options.html`, `ui/options.js`, `ui/theme.css`

Mockup: `options.png` (markup in `options.html` under mockups).

- [ ] **Layout:** a `flex-wrap` row with a `<nav aria-label="Options sections">` (links to `#presets`, `#views`, `#checks`, `#scoring`, `#capture`, `#services`, `#remote`, `#data`) and `<main>`. Each section has the matching `id`.
- [ ] **Presets:**
  - cards for `PRESET_ORDER` plus custom presets. Each shows its label, a "Default" tag when it is `settings.preset`, the estimate, and device, views, checks and lookups from `presetSummary`;
  - clicking a card selects it for editing (local UI state), and a "Make default" button sets `settings.preset`;
  - "New preset" clones the selected one as `custom-N` and lets you rename it inline;
  - built-ins have "Reset to default"; custom presets have "Delete".
- [ ] **Views:**
  - "Views in {selected preset}";
  - five `fieldset`s from `VIEW_GROUPS`, with checkboxes, labels and the one-line descriptions copied from the mockup;
  - each change writes `settings.presets[id].views`;
  - a "Lookups" switch per preset sits at the top of this section ("Send data to outside services (14 checks)"). The count comes from `presetSummary`.
- [ ] **Checks:**
  - three count tiles (on this machine, lookups ↗, off with names);
  - the existing per-plugin list, moved into a `<details>` opened by "Choose checks";
  - the existing `data-plugin` and `data-phase` handlers are unchanged.
- [ ] **Scoring:** unchanged; move it into its section.
- [ ] **Capture:** the remaining capture fields and the DoH resolver. Remove the Mode and Device selects from Options; they live in the popup.
- [ ] **Services and keys:** the API keys section, moved.
- [ ] **Remote checks:** the remote plugins section, moved, with the heading renamed.
- [ ] **Your data:** usage, "Open reading when done" (moved from the chips), "Show the last grade on the toolbar icon" (`ui.gradeBadge`), and "Delete all readings". Deleting sends `harplus:readings-changed`.
- [ ] `options.js` keeps the `data-path` binding for the moved fields, so most handlers move without change.
- [ ] Commit: `Options: sections, preset cards, grouped views, checks summary`.

## Task 10: End-to-end, older readings, visual pass

**Files:** `test/e2e/run.mjs`, `test/fixtures/`, docs

- [ ] **Fixture:** add `test/fixtures/reading-pre-hargus.plus.har`, a small reading saved by the current code (no `capture.preset`). A unit test checks that it opens, scores and runs analysis with lookups on.
- [ ] **E2E additions:**
  - **Popup:** the wordmark text is "HARgus"; clicking "As it is" makes the primary button read "Read as it is"; the Setup line opens `#setup` with four preset radios.
  - **Quick check reading** of the test site: no `view` screenshots other than the base, and every plugin result's `contacted` lists only the test server's host.
  - **Badge:** after the Check-up reading, `chrome.action.getBadgeText({ tabId })` equals the reading's grade.
  - **Options:** eight nav links, five view `fieldset`s, four preset cards.
- [ ] **Visual pass:** screenshot the popup states and Options at 1× and 2×, light and dark, and put them next to the mockup PNGs. Fix spacing and contrast issues.
- [ ] **README:** add new screenshots and the "Writing the name" section (if not done in Task 2).
- [ ] `npm test` and `npm run test:e2e` pass.
- [ ] Commit: `E2E and docs for HARgus popup, presets and badge`.
