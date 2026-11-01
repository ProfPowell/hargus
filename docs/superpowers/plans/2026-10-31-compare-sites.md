# Comparing Sites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A compare page that shows which of 2–8 sites wins overall, per area and per metric. It has ties, strengths
and weaknesses, a conditions warning and before and after, built on saved sets that can be recorded from a list of
URLs.

**Architecture:**
- **Pure core modules:**
  - `core/metrics.js` holds the metric extractors;
  - `core/compare.js` holds winners, ties, strengths, conditions and before and after;
  - `core/sets.js` holds the set-record operations and URL-list parsing;
  - `core/round.js` sequences a list recording, with injected dependencies.

  All four are unit-tested.
- **Storage and pages:**
  - a `sets` store in IndexedDB;
  - a renderer `ui/compare-view.js`, which works on strings and is shared by the page and the export;
  - the page itself, `ui/compare.html` and `ui/compare.js`;
  - library changes;
  - a background round driver.

**Tech Stack:** plain ES modules for Chrome MV3, with no dependencies. Tests use `node --test`, e2e uses Playwright,
and pages are drawn with the `html` tagged template from `ui/html.js`.

**Spec:** `docs/superpowers/specs/2026-10-31-compare-sites-design.md`

## Global Constraints

- **`theme.css`:** no `<` outside comments, and media queries use only `min-width` and `max-width`.
- **Drawing:** plugins and pages draw only through the `html`/`h` helpers (`ui/render.js`, `ui/html.js`, `ui/charts.js`).
  Every value from a reading is escaped.
- **Export:** the exported compare file contains no `<script` and makes no requests. CSS and fonts are inlined, and
  thumbnails are data URLs.
- **Existing rules:** `places` keys stay whitelisted, and capped lists store true counts.
- **No change to single readings:** no change to `scoreReading`, to single reports or to index records.
  `node scripts/score-check.mjs … --compare test/e2e/out/score-baseline.json` prints "no differences".
- **No new permissions** in `manifest.json`, and no tab groups.
- **IndexedDB** goes to version 3, which only adds the `sets` store (`keyPath: 'id'`).
- **Named exports with the spec's values:**
  - `TIE_POINTS = 3`, `TIE_PCT = 0.10`;
  - floors: 100 ms for timings, 0.02 for CLS, 1 for counts, 10 kB (10 240 bytes) for sizes;
  - `MAX_SITES = 8`, `STRIP_AT = 5` (5 or more sites use the strip), `DATE_SPREAD_DAYS = 7`;
  - a round deadline of 300 s × runs per site.
- **Copy, verbatim from the spec:**
  - "Recordings of several pages can't be compared yet";
  - "Keep the recording window visible until the round ends";
  - "Some timings are single runs; record with 3 runs for firmer results.";
  - "No clear strengths in this group" and "No clear weaknesses in this group";
  - "not recorded: <reason>", "reading deleted", "new in this round", "not in this round", "no change".
- **Wording to avoid:** no head-to-head sentences, no lists of shared or unique issues, and no "p50" or "σ".
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A reading with an unmeasured area or a missing metric**, for example a snapshot reading with no vitals, or pagespeed off. That site is left out of the area or metric, never counted as 0 and never shown as NaN. (Task 2 test `unmeasured and missing values never win or lose`.)
2. **All sites tied, or only one site having a value.** The verdict says "tie", the metric row is hidden when fewer than 2 sites have a value, and nobody gets a strength from it. (Task 2 test `all tied: no winner, no strengths`.)
3. **A host or title containing markup**, for example `<img onerror>` in a page title. It is escaped in the page and in the export. (Task 5 test `site strings are escaped in page and export`.)
4. **The service worker restarting mid-round.** The stored round still reads back as incomplete, with each site's last state, and a new round can start. (Task 7 test `a stale running round reads as incomplete`.)
5. **A set whose reading was deleted, plus a site that failed.** The comparison renders, with "reading deleted" and "not recorded: <reason>" in that site's column, and the other sites are compared normally. (Task 5 test `gaps render in place`.)

---

### Task 1: Metric extractors

**Files:**
- Create: `extension/core/metrics.js`
- Test: `test/metrics.test.mjs`

**Interfaces:**
- Consumes: `scoreReading` and `AREAS` (`core/score.js`), `spreadAll`, `sampleOf` and `RUN_METRICS` (`core/runs.js`), and `transferSize` and `isThirdParty` (`core/har-util.js`).
- Produces:
  - `METRICS: Array<{ id, area, label, unit: 'ms'|'cls'|'count'|'bytes'|'grams', better: 'lower'|'higher', best: string, worst: string, get(reading, scores) → number|null, range?(reading) → {min,max,n}|null }>`.
  - `best` and `worst` are the strength and weakness labels, for example `best: 'Fastest LCP'` and `worst: 'Slowest LCP'`.
  - `range` exists only for the run-based timings, and returns the spread's min, max and n when the reading has 2 or more runs.
  - `metricValues(reading, scores) → { [id]: { value, range } }`.
  - `formatMetric(id, value) → string`, which uses the existing `formatMs` and `formatBytes` helpers.

- [ ] **Step 1: Write the failing tests.**
  - `the list follows the spec`: the ids, in order, are `lcp, fcp, ttfb, cls, blockingTime, load, bytes, requests, a11yFindings, contrastFailures, securityFindings, securityHeaders, contentFindings, thirdPartyRequests, jsBytes, cssBytes, infrastructureFindings, internationalFindings, carbon`. Every metric's `area` is in `AREAS`, and `securityHeaders.better === 'higher'`; all the others are `'lower'`.
  - `timings are medians when runs exist`: take a fixture reading with `log._harplus.runs.samples` holding LCPs of 1000 and 3000, and a full-run LCP of 2000. Then `metricValues(r).lcp.value === 2000` and `range` is `{min:1000,max:3000,n:3}`.
  - `findings metrics count high plus medium from scoreReading`: for a reading with 2 high, 1 medium and 4 low accessibility findings, `a11yFindings === 3`.
  - `absent sources give null, never 0 or NaN`: a reading with no plugins gives `null` for every metric except `bytes` and `requests`, which come from the HAR entries.
- [ ] **Step 2:** Run `node --test test/metrics.test.mjs`. Expect FAIL, because the module is missing.
- [ ] **Step 3: Implement `extension/core/metrics.js`.**
  - Timing values come from the vitals plugin's `data.median` when present, otherwise from its data, which matches what the tiles show.
  - Contrast failures come from `contrast.data.totals.failing`.
  - Security headers present come from the count of `security.data.headers` with `ok`.
  - Third-party requests come from `network.data.totals.thirdParty.requests`.
  - JS bytes come from `javascript.data.totals.bytes`, and CSS bytes from `css.data.totalBytes`.
  - Carbon comes from `carbon.data.grams`.
  - The findings metrics use `scores.areas[id].counts.high + medium`, and are null when the area isn't `measured`.
  - Fixtures go in `test/fixtures/` as small hand-written readings, or are built inline with a helper in the test.
- [ ] **Step 4:** Run `node --test test/metrics.test.mjs`. Expect PASS.
- [ ] **Step 5:** Commit with the message `Compare: metric extractors`.

### Task 2: Winners, ties and strengths

**Files:**
- Create: `extension/core/compare.js`
- Test: `test/compare.test.mjs`

**Interfaces:**
- Consumes: `METRICS`, `metricValues` and `formatMetric` (Task 1), and `scoreReading` and `AREAS`.
- Produces:
  - **Constants:** `TIE_POINTS = 3`, `TIE_PCT = 0.10`, `FLOOR = { ms: 100, cls: 0.02, count: 1, bytes: 10240, grams: 0.02 }`, `MAX_SITES = 8`, `STRIP_AT = 5`.
  - **`rankScores(entries: Array<{key, score:number|null}>) → { winners: key[], tie: boolean, order: key[] }`.** Null scores are left out. `winners` holds every key within `TIE_POINTS` of the top, and `tie` is true when there are 2 or more winners.
  - **`rankMetric(metric, entries: Array<{key, value, range}>) → { winners, tie, best: key|null, worst: key|null, shown: boolean }`.** `shown` is false when fewer than 2 values are present.
    - The two leaders tie when both have ranges that overlap.
    - Otherwise they tie when `|a−b| ≤ max(TIE_PCT × |better|, FLOOR[unit])`, or when they are equal at display precision (`formatMetric`).
    - `best` and `worst` are null on a tie at that end.
  - **`compareReadings(sites: Array<{ key, reading }>, plugins, { profile }) → Model`.** Each site is either `{ key, reading }` or `{ key, gap: 'not recorded: <reason>' | 'reading deleted' }`. Model:
    ```
    { profile: {id,label},
      sites: [{ key, host, label, url, score, grade, status, thumb, favicon, capturedAt, gap?, strengths: [{label,value}], weaknesses: [{label,value}] }],
      overall: { winners, tie, areaWins: {key:n}, ties: n },
      areas: [{ id, label, winners, tie, scores: {key:number|null}, why: string }],
      metrics: [{ id, area, label, values: {key:{value,text}}, winners, tie, best, worst }],
      faceoff: { wins: {key:n}, ties: n, total: n },
      singleRunNote: boolean,
      layout: 'columns'|'strip' }
    ```
  - **`siteLabel(url, allUrls) → string`:** the host, or host plus path when two URLs share a host.

- [ ] **Step 1: Write the failing tests.**
  - `rankScores: within 3 points is a tie`: `[90, 88, 70]` gives winners `[a, b]` and a tie; `[90, 86]` gives winner `[a]` and no tie; `[null, 50]` gives winner `[b]`.
  - `rankMetric: run ranges that overlap tie`: LCP a has range 1900–2300 and b has 2100–2600, so they tie. With no ranges, 2000 against 2150 ties (within 10%) and 2000 against 2400 does not.
  - `rankMetric: floor beats pct for small values`: TTFB 50 against 120 ties because of the 100 ms floor. CLS 0.01 against 0.025 ties because of the 0.02 floor.
  - `rankMetric: higher is better for securityHeaders`: 6 against 3 makes 6 the winner.
  - `the why names the biggest relative gap between winner and last place`: for Performance, where the LCP gap is the largest, `why === 'LCP 2.0 s vs 3.4 s'`.
  - `strengths are outright wins ordered by margin, then area wins fill in`: a site that wins only LCP outright gets `[{label:'Fastest LCP', value:'2.0 s'}, {label:'Best Accessibility', value:'90'}]`.
  - `all tied: no winner, no strengths`: three identical readings give `overall.tie === true`, and every site has `strengths: []` and `weaknesses: []`.
  - `unmeasured and missing values never win or lose`: a site with Performance not measured has `scores.performance[key] === null`, is absent from `winners`, gets no "Slowest" weakness, and no output contains `NaN`.
  - `gaps take no part`: a site with `gap: 'reading deleted'` keeps its column in `sites` but is absent from every ranking.
  - `layout switches at 5 sites`: 4 sites give `'columns'` and 5 give `'strip'`.
  - `siteLabel adds the path only when hosts repeat`.
  - `singleRunNote is true when any timing comes from a 1-run reading`.
- [ ] **Step 2:** Run `node --test test/compare.test.mjs`. Expect FAIL.
- [ ] **Step 3: Implement `extension/core/compare.js`.**
  - Score every reading with `scoreReading(reading, plugins, { profile })`.
  - The "why" is the metric in that area with the largest `|winner − last| / max(|winner|, |last|)` among the shown metrics, written as `"<label> <winner text> vs <last text>"`. When the area is a tie or has no metric, it is `''`.
  - The thumbnail comes from the `thumbnail` screenshot, as in `indexRecord`.
  - The favicon is the first `meta.data.icons` href whose HAR entry has an image body, as a data URL; otherwise `null`, and the page draws the initial.
- [ ] **Step 4:** Run `node --test test/compare.test.mjs`. Expect PASS.
- [ ] **Step 5:** Commit with the message `Compare: winners, ties, strengths and weaknesses`.

### Task 3: Conditions and before and after

**Files:**
- Modify: `extension/core/compare.js`
- Test: `test/compare.test.mjs` (append)

**Interfaces:**
- Consumes: `compareReadings` and `rankScores` (Task 2).
- Produces:
  - **`DATE_SPREAD_DAYS = 7`.**
  - **`conditions(sites) → string[]`:** one plain line per difference, in this order: device, throttle, cache, runs, coverage, mode, dates. A difference is named for the minority, for example `"ucsd.edu was recorded on mobile, the others on desktop"` and `"harvard.edu used 1 run, the others 3"`. When there is no single minority, it lists every value, for example `"Devices differ: a.com mobile, b.com desktop, c.com tablet"`. For dates: `"Recorded between 3 Oct and 30 Oct"`. A site whose runs were skipped gives `"stanford.edu: 1 of 3 runs"`.
  - **`compareRounds(before: Model, after: Model) → Delta`:**
    ```
    { sites: [{ key, grade: {before, after}, score: {before, after, change}, rank: {before, after}, status: 'both'|'new'|'gone' }],
      areas: [{ id, changes: {key: {before, after, change, same: boolean}} }],
      metrics: [{ id, changes: {key: {before, after, same}} }],
      verdict: string }
    ```
    - `same` uses `TIE_POINTS` for scores, and `rankMetric`'s tie rule (applied to the before and after values) for metrics.
    - The verdict reads `"ucsd.edu improved most (+9); stanford.edu fell (−5)"`, naming the biggest rise and the biggest fall beyond `TIE_POINTS`. With neither, it reads `"No site changed by more than 3 points"`.
    - Ranks are 1-based places by overall score.
    - A site key in only one round gets status `'new'` or `'gone'`.

- [ ] **Step 1: Write the failing tests.**
  - `conditions: a single mobile site is named`.
  - `conditions: runs, coverage and mode differences each give one line`.
  - `conditions: dates more than 7 days apart`: `"Recorded between 3 Oct and 30 Oct"`; 6 days apart gives no line.
  - `conditions: alike readings give []`.
  - `conditions: skipped runs are named`.
  - `compareRounds: change, rank and verdict`: scores before `{a:70, b:80}` and after `{a:79, b:75}` give `a` a change of +9 and a rank from 2 to 1, with `verdict === 'a improved most (+9); b fell (−5)'`.
  - `compareRounds: within 3 points is no change`: `same === true`.
  - `compareRounds: new and gone sites`.
  - `compareRounds: one site, two rounds works`.
- [ ] **Step 2:** Run `node --test test/compare.test.mjs`. Expect the new tests to FAIL.
- [ ] **Step 3: Implement `conditions` and `compareRounds`.** Capture settings come from `log._harplus.capture`: `device`, `throttle`, `bypassCache`, `runs`, `coverage` and `mode`, plus `capturedAt`. Skipped runs come from `log._harplus.runs.skipped`.
- [ ] **Step 4:** Run `node --test test/compare.test.mjs`. Expect PASS.
- [ ] **Step 5:** Commit with the message `Compare: conditions warning and before and after`.

### Task 4: Sets: record operations, URL lists and the store

**Files:**
- Create: `extension/core/sets.js`
- Modify: `extension/browser/store.js` (bump `VERSION` to 3 and add the `sets` store and API)
- Test: `test/sets.test.mjs`

**Interfaces:**
- Produces, in `core/sets.js` (pure, and returns new objects):
  - **`parseUrlList(text) → { urls: string[], bad: string[] }`:**
    - trims each line and skips blank ones;
    - adds `https://` to a bare host;
    - keeps only http(s) URLs;
    - drops duplicates after normalising (lower-case host, no trailing `/` on an empty path);
    - caps the list at `MAX_SITES`, and records the overflow in `bad` as `"<url> (more than 8)"`.
  - **`newSet({ name, urls, settings }, now = Date.now()) → Set`**, with an `id` from `crypto.randomUUID()` and `rounds: []`.
  - **`setFromReadings(name, readings) → Set`:** one round, with its `settings` from the first reading's capture.
  - **`startRound(set, now) → Set`:** appends `{ at, state: 'running', readings: urls.map(url => ({ url, id: null, error: null, state: 'waiting' })) }`.
  - **`updateSite(set, roundIndex, url, patch) → Set`.**
  - **`endRound(set, roundIndex, state: 'done'|'stopped') → Set`.**
  - **`addToSet(set, reading) → Set`:** follows the spec's **Add to set** rule, using the latest round, and appends the URL when it's new.
  - **`roundState(round, { alive: boolean }) → 'running'|'incomplete'|'done'|'stopped'`:** a round stored as `'running'` reads as `'incomplete'` when `alive` is false.
  - **`SETTINGS_KEYS = ['device','throttle','bypassCache','runs','coverage']`.**
- Produces, in `browser/store.js`: `listSets() → Set[]` (newest first), `getSet(id)`, `saveSet(set)` and `deleteSet(id)`. `deleteSet` never deletes readings.

- [ ] **Step 1: Write the failing tests.**
  - `parseUrlList: bare hosts, junk and duplicates`: `"ucsd.edu\nhttps://UCSD.edu/\nftp://x\n\nhttps://a.com/p"` gives `urls: ['https://ucsd.edu/', 'https://a.com/p']` and `bad: ['ftp://x']`.
  - `parseUrlList: 9 URLs keep 8`.
  - `startRound/updateSite/endRound`: the states move from waiting, to recording, to analysing, to done or failed.
  - `addToSet: replaces the URL's reading in the latest round`, and `addToSet: a new URL is appended to urls and the round`. Neither changes `settings`.
  - `a stale running round reads as incomplete`: `roundState({state:'running'}, {alive:false}) === 'incomplete'`.
  - `the store opens version 3 with a sets store`: assert the `VERSION === 3` export, and that `onupgradeneeded` creates `sets` when it's missing. The store is not unit-tested beyond this, and e2e covers it.
- [ ] **Step 2:** Run `node --test test/sets.test.mjs`. Expect FAIL.
- [ ] **Step 3: Implement.** Export `VERSION` from `store.js` so the test can read it, and add `sets` in `onupgradeneeded` beside the existing stores.
- [ ] **Step 4:** Run `node --test test/sets.test.mjs`, then `npm test`. Expect PASS.
- [ ] **Step 5:** Commit with the message `Compare: sets store and set operations`.

### Task 5: The compare view, the page and the export

**Files:**
- Create: `extension/ui/compare-view.js`, `extension/ui/compare.html`, `extension/ui/compare.js`
- Modify: `extension/ui/theme.css` (a `/* compare */` section), `extension/ui/report.js` (export the standalone-document wrapper's CSS and font inlining as `inlineAssets(css, fonts)` if it isn't already reusable)
- Test: `test/compare-view.test.mjs`

**Interfaces:**
- Consumes: `compareReadings`, `conditions` and `compareRounds` (Tasks 2–3), `getSet`, `getReading` and `listSets` (Task 4), `roundState`, and `scoreBar` (`ui/charts.js`).
- Produces:
  - **`renderCompare(model, { conditions: string[], delta?: Delta, rounds?: {list, before, after}, progress?: Round, interactive: boolean }) → Raw`.**
  - **`compareDocument(model, opts, { css, fonts }) → string`:** standalone HTML with no script.
  - **The page, `compare.html?ids=a,b,c`:** a plain comparison of library readings.
  - **The page, `compare.html?set=<id>[&after=<i>&before=<j>]`:** the set's page, with the round picker, before and after, and progress while running.
  - **The `harplus:set-progress` message**, which the page listens for and re-renders on, with the payload `{ setId }`.

- [ ] **Step 1: Write the failing tests** against `renderCompare` and `compareDocument`, using models built with Task 2 on fixtures.
  - `columns: favicon or initial, thumbnail, score, grade, star, two strengths and two weaknesses per column`.
  - `strip at 5 sites: chips, and strengths and weaknesses in a block after the area table`.
  - `verdict line`: `"Overall: a.com · wins 4 areas · b.com 2 · c.com 2 · 1 tie"`, and the tie form `"Overall: tie between a.com and c.com"`.
  - `area table: score bars, a star on the winner, "tie", and the why`.
  - `face-off: the summary count line, best in green and worst in red via classes, grouped by area, and the single-run note when flagged`.
  - `conditions lines render above the verdict`.
  - `before and after: "88 ▲14", "no change", "3rd → 1st", and the verdict line`.
  - `gaps render in place`: a site with `gap` shows "reading deleted" or "not recorded: timed out" in its column and nothing else.
  - `site strings are escaped in page and export`: a title or host containing `<img src=x onerror=1>` appears only escaped.
  - `export: no <script, no http(s) url( or src= requests, fonts inlined, links to reports are plain text`.
  - `the profile note: "Scored with the General profile"`.
- [ ] **Step 2:** Run `node --test test/compare-view.test.mjs`. Expect FAIL.
- [ ] **Step 3: Implement `compare-view.js`, then the page.**
  - **`compare.js`:**
    - loads the readings by id, or the set and its rounds;
    - resolves the profile from the settings;
    - builds the model or models, and renders;
    - wires the round-picker `<select>`s, which update the query and re-render;
    - wires Export, which uses `download()`, and Print;
    - shows the progress list with each site's state and the "Keep the recording window visible until the round ends" line while the round is `running`.
  - **Readings that are still pending analysis** show as "analysing" in place of a column. The page re-renders on `harplus:progress` with stage `done`, as `library.js` does.
  - **Links:** on screen, each host links to `reading.html?id=<id>`. In the export, hosts are plain text.
  - **Print:** a `@page { size: landscape }` rule, scoped to the compare page's print stylesheet. The face-off is
    always open, so print needs nothing more.
  - **Wide tables** sit in `.table-wrap` so they scroll inside their own box.
  - **CSS** follows the hard rules, and dark mode uses the existing tokens.
- [ ] **Step 4:** Run `node --test test/compare-view.test.mjs` and `npm test`. Expect PASS. Also run `grep -n '<' extension/ui/theme.css`, which should find no new `<` outside comments.
- [ ] **Step 5:** Commit with the message `Compare: the compare page and its export`.

### Task 6: Library: select, compare, sets

**Files:**
- Modify: `extension/ui/library.html`, `extension/ui/library.js`, `extension/ui/library-card.js`, `extension/ui/theme.css`
- Test: `test/library.test.mjs` (append)

**Interfaces:**
- Consumes: `listSets`, `saveSet` and `deleteSet` (Task 4), and `setFromReadings`, `addToSet`, `parseUrlList` and `newSet`.
- Produces:
  - **`cardHtml(record, { selectable: true, sets: Set[] })`:** the existing card plus a checkbox and a set-name chip for each set containing that reading.
    - The chip links to `compare.html?set=<id>`.
    - Readings in record mode get a disabled checkbox with the title "Recordings of several pages can't be compared yet".
  - **`setCardHtml(set) → Raw`:** the name, the favicons or initials, the round count, the date of the last round, and **Compare**, **Record again** and **Delete** (two-step, like reading delete).
  - **The `harplus:record-set` message**, with `{ setId }`. It is sent to the background (Task 7).

- [ ] **Step 1: Write the failing tests.**
  - `card: checkbox, and record-mode checkbox disabled with the copy`.
  - `card: set chips link to compare.html?set=`.
  - `setCardHtml: name, rounds, last date, buttons, escaped name`.
- [ ] **Step 2:** Run `node --test test/library.test.mjs`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - **A tab bar:** "Readings" and "Sets".
  - **The selection bar** appears when one or more readings are selected. It shows "N selected" with **Compare** (2–8 selected, opening `compare.html?ids=`), **Save as set** (which asks for a name, then calls `setFromReadings`) and **Add to set**.
  - **Add to set** is a menu on each card listing the sets; choosing one calls `addToSet`, then `saveSet`.
  - **The Sets tab** lists `setCardHtml` cards and a **New set** form with a name, a URL textarea (`parseUrlList`, showing the `bad` lines inline), and device, throttle, cache, runs and coverage defaulting to the current settings.
  - **On the New set form**, **Save** stores the set and **Save and record** stores it, then sends `harplus:record-set`.
- [ ] **Step 4:** Run `node --test test/library.test.mjs` and `npm test`. Expect PASS.
- [ ] **Step 5:** Commit with the message `Compare: library selection, sets tab, add to set`.

### Task 7: Recording a list

**Files:**
- Create: `extension/core/round.js`
- Modify: `extension/background.js`, `extension/ui/reading.js` (the `close=1` query)
- Test: `test/round.test.mjs`

**Interfaces:**
- Consumes: `startRound`, `updateSite`, `endRound` and `roundState` (Task 4), `getSet` and `saveSet`, and `capture(tabId, overrides)` (`background.js`).
- Produces:
  - **`runRound(set, deps) → Promise<Set>`** in `core/round.js`. The `deps` are:
    ```
    { save(set), openTab(url) → tabId, navigate(tabId, url), capture(tabId, settings) → readingId,
      analysisDone(readingId, ms) → Promise<'done'|'error'>, deadlineMs(settings) → number,
      stopped() → boolean, now() }
    ```
    - It saves after every state change.
    - Sites run in order. Each one is set to recording, then analysing, then done, or to failed with `error` holding the reason. A capture that throws, or a deadline that passes (`300_000 × runs`), marks that site failed and moves on.
    - When `stopped()` is true it ends with `'stopped'`, and otherwise with `'done'`.
  - **In `background.js`:**
    - **The `harplus:record-set` handler** refuses when a round is already running (`"A set is already recording"`).
    - It opens a new normal window with one tab via `chrome.windows.create({ url: 'about:blank', focused: true })`.
    - It wires `deps`. `capture` calls the existing `capture(tabId, { ...set.settings, mode: 'reload', progressTab: <created with &close=1> })`.
    - `analysisDone` resolves on the `harplus:analysis` message with stage `done` for that reading.
    - `ui.openWhenDone` is skipped while a round runs.
    - It broadcasts `harplus:set-progress` after each save, and opens `compare.html?set=<id>` when the round ends.
  - **The `harplus:stop-set` message** sets the stop flag.
  - **`harplus:set-status`** returns `{ running: setId|null }`, so the page can pass `alive` to `roundState`.
  - **In `reading.js`:** with `close=1`, the tab calls `window.close()` after it sends stage `done`, which closes the reading tab.

- [ ] **Step 1: Write the failing tests** for `runRound` with fake `deps`.
  - `sites run in order, one at a time`: the second `capture` call starts only after the first `analysisDone` resolves.
  - `a failed capture is recorded and the round moves on`: `error === 'boom'`, and the next site is done.
  - `a deadline marks the site failed with "timed out"`.
  - `stop ends the round as stopped and keeps finished sites`.
  - `every state change is saved`: the `save` call count is at least 3 × sites + 2.
  - `a stale running round reads as incomplete` (with Task 4's `roundState`, run end to end on a set saved mid-round).
- [ ] **Step 2:** Run `node --test test/round.test.mjs`. Expect FAIL.
- [ ] **Step 3: Implement `round.js`, then the background wiring and `close=1`.**
- [ ] **Step 4:** Run `node --test test/round.test.mjs` and `npm test`. Expect PASS.
- [ ] **Step 5:** Commit with the message `Compare: record a set from a list of URLs`.

### Task 8: Help, e2e and screens

**Files:**
- Modify: `extension/ui/help.js`, `test/report.test.mjs` (the Help cap), `test/e2e/run.mjs`, `test/e2e/server.mjs` (a second test page if needed), `scripts/screens.mjs`
- Regenerate: `screens/after/` (the compare shots and the brief)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add the Help section.** Add a "Comparing sites" section of about 70 words covering the four points in the spec. Raise the word cap in `test/report.test.mjs` by the measured count, and add a comment naming the section. Assert `/within 3 points/` and `/same scoring profile/`.
- [ ] **Step 2: Extend e2e** with a compare block.
  - Create a set of 2 local test pages from the library's New set form, and **Save and record** it.
  - Wait for the round to end. Assert that 2 readings are in the round, that `chrome.tabs.query` finds no `reading.html` tabs left from the round, and that the compare page shows the verdict, `.area-table` and the face-off.
  - Take a mobile reading of one page and use **Add to set**, then assert the conditions line mentions mobile.
  - Choose **Record again**, then assert the round picker exists and that `▲` or "no change" renders.
  - Export the comparison and assert there is no `<script`.
- [ ] **Step 3: Extend `scripts/screens.mjs`** with these shots:
  - `54-compare-3-sites`
  - `55-compare-6-sites-strip`
  - `56-compare-dark`
  - `57-compare-narrow`
  - `58-compare-before-after`
  - `59-compare-export`
  - `60-library-sets`

  Each gets a brief line. Then regenerate.
- [ ] **Step 4: Verify.** Run these one at a time, never in parallel:
  - `npm test`, which should pass;
  - `npm run test:e2e`, which should print "all e2e checks passed";
  - a fresh calibrate run, then `node scripts/score-check.mjs test/e2e/out/calibrate --compare test/e2e/out/score-baseline.json`, which should print "no differences".
- [ ] **Step 5:** Commit with the message `Compare: Help, e2e and screens`.
