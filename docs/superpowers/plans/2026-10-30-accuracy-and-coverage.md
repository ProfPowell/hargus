# Accuracy fixes and load coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the accuracy and display flaws left from the redesign, and add a Performance plugin that reports the CSS and JS not used during page load.

**Architecture:** Part A changes plugin renders, `h` helpers, `theme.css` and scripts. Only A1 changes findings. Part B adds:
- a pure summariser, `extension/core/coverage.js`;
- capture wiring in `extension/browser/capture.js`, which starts CDP coverage before the reload and takes it at the first network idle, storing `log._harplus.coverage`;
- an analyze-phase plugin, `extension/plugins/coverage.js`, that reads it, so the plugin replays in the CLI and score-check.

**Tech Stack:** Plain JS (ES modules), Chrome MV3 with `chrome.debugger` (CDP 1.3), `node --test`, Playwright for e2e and calibration.

**Spec:** `docs/superpowers/specs/2026-10-30-accuracy-and-coverage-design.md`

## Global Constraints

- Every label says **not used during load**, never "unused code" or "dead code".
- No finding may change except A1's (Task 1). Every other task must show `score-check --compare` = "no differences".
- `extension/ui/theme.css` contains no `<` outside comments. Media queries use `min-width` and `max-width` only. A unit test enforces this.
- Plugins draw only through the `h` helpers. The standalone export runs without script.
- `places` keys are whitelisted: url, text, region, selector, file, note, status, line, entry. Places are locations only: byte figures go in evidence.
- Capped lists store true counts.
- Coverage thresholds (starting values): JS waste ≥ 150 KB is medium and ≥ 40 KB is low. CSS waste ≥ 50 KB is medium and ≥ 15 KB is low. A file counts towards a finding only at ≥ 10 KB (JS) or ≥ 5 KB (CSS) estimated waste. Each kind keeps its top 100 files by `unusedBytes`.
- Overhead rule: if the median change in LCP or blocking time with coverage on is above 5%, `capture.coverage` defaults to off.
- Grade rule: if any reference site's Performance grade moves by more than one grade step because of coverage findings, the thresholds are revisited before merge.
- Score check: `node scripts/score-check.mjs /Users/tpowell/src/har-plus/test/e2e/out/calibrate --compare test/e2e/out/score-baseline.json`. The HARs and the baseline live in the main checkout (`test/e2e/out/` is git-ignored); in a worktree, use the absolute paths `/Users/tpowell/src/har-plus/test/e2e/out/...`.
- Never run e2e, screens and calibration at the same time.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. **A page with no external scripts or styles:** coverage has zero totals, there's no finding, and the panel says "No scripts or stylesheets measured". Tested in Tasks 4 and 6.
2. **The same script URL loaded twice:** it shows as one row, not double counted. Its bytes are the larger copy's and its unused bytes the smaller of the two. Tested in Task 4.
3. **`data:`, `blob:`, `chrome-extension:` and empty-URL scripts:** left out. Tested in Task 4.
4. **A file served from cache, where transfer size is 0:** waste falls back to unused decoded bytes and the row is marked "size before compression". Tested in Task 6.
5. **Coverage CDP calls throwing:** the reading still completes, with `coverage.skipped = 'coverage failed: <message>'`. Tested in Task 5.

---

### Task 1: A1, mask-icon is not presentational markup

**Files:**
- Modify: `extension/plugins/html.js` (the `PRESENTATIONAL` checks at ~133, ~168–169, ~182)
- Test: `test/html.test.mjs`

- [ ] **Step 1: Write the failing test** `html: link.color (mask-icon) is not presentational`. Use collected data with `attrPairs: { 'link.color': 1, 'td.align': 2 }`, and assert:
  - the "Presentational HTML attributes" finding's evidence contains `td.align ×2` and not `link.color`;
  - its places contain no `link` selector;
  - with only `{ 'link.color': 1 }`, there is no such finding.
- [ ] **Step 2:** Run `node --test test/html.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Exclude the pair `link.color` in one shared predicate, `isPresentational(tag, attr)`, used by both the evidence list and `presentationalPlaces`.
- [ ] **Step 4:** `npm test` passes.
- [ ] **Step 5:** Run the score check with `--compare`. Expected: differences only in the html plugin's presentational finding. Record the list of affected readings.
- [ ] **Step 6:** Commit the code: `html: link color (mask-icon) is not presentational`.
- [ ] **Step 7:** Regenerate the baseline with `--write` against the same HAR folder, writing `/Users/tpowell/src/har-plus/test/e2e/out/score-baseline.json`. Re-run `--compare` and expect "no differences". The baseline is git-ignored, so put the affected-readings list in the task report, not a commit.

### Task 2: Part A display fixes (A2–A10)

**Files:**
- Modify: `extension/ui/render.js`, `extension/ui/theme.css`.
- Modify these plugin renders: html, javascript, meta, css (fold copies); content, network, html-validate, css-validate (caps); history, css-validate, security (nested folds); meta, resilience (thresholds); pagespeed; head-order; a11y-views.
- Test: `test/charts.test.mjs` or `test/render.test.mjs` (whichever holds the `h` helper tests), plus the existing per-plugin test files.

**Interfaces:**
- Produces:
  - `h.tags(items, { fold = 8 } = {})`, which folds like `h.list`;
  - `h.fold(items, draw, { fold = 8 } = {})`, which exposes the existing private `folded()` for custom drawers such as css swatches;
  - `h.value(number, unit)` → `<span class="nb">number&nbsp;unit</span>`, used where renders draw a number and unit as separate words.

- [ ] **Step 1: Write the failing tests:**
  - `h.tags folds past 8`: 10 items give 8 tags plus `<details class="disclosure fold">` with "2 more".
  - `h.tags fold:false shows all`.
  - `h.fold draws with a custom drawer`.
  - `h.value keeps number and unit together`: the output contains `&nbsp;` or ` ` and class `nb`.
  - `pagespeed headline keyed on audit id`: a Lighthouse result whose LCP audit title is in German still yields the headline.
  - For each of content, network, html-validate and css-validate: when a capped list is shorter than its true count, the render contains `first N of M`.
- [ ] **Step 2:** Run `npm test`. Expected: those tests FAIL.
- [ ] **Step 3: Implement.**
  - **A4:** add the helpers above. Delete the local `chips` copies in html.js, javascript.js and meta.js, and `fold8` in css.js, using `h.tags` and `h.fold` instead.
  - **A2:** use `h.value` (or `.nb { white-space: nowrap }`) where values are drawn. Don't touch `formatBytes`, `formatMs` or other shared formatters.
  - **A3:** add the "first N of M" notes.
  - **A5:** don't fold a list that sits inside an already-closed `h.more`: pass `fold:false` in the history, css-validate and security nested lists.
  - **A6:** the closed-section count is passed as `h.more`'s third argument (`meta`), the same way everywhere.
  - **A7:** meta and resilience renders import the thresholds their `run()` uses; export them as named constants.
  - **A8:** key the pagespeed headline on audit id (`largest-contentful-paint`), not title.
  - **A9:** head-order's glance list goes through `h.list` (fold); the a11y-views "Fail" tile gets `white-space: nowrap`.
  - **A10:** in the print block, the rule at ~1033 should keep inline URLs inline, so `span.url` is not `display: block` in running text; keep the overflow fix.
- [ ] **Step 4:** `npm test` passes, including the theme.css `<` test.
- [ ] **Step 5:** The score check `--compare` reports "no differences".
- [ ] **Step 6:** Commit: `Display fixes: shared tag fold, number and unit together, capped-list counts, single folds, pagespeed by audit id`.

### Task 3: Scripts, A11 screens retry and calibration flags

**Files:**
- Modify: `scripts/screens.mjs`, `scripts/calibrate.mjs`
- Test: `test/calibrate.test.mjs` (create it if absent; export the pure argument parser)

**Interfaces:**
- Produces: `calibrate.mjs` flags `--out <dir>` (default unchanged: `test/e2e/out/calibrate`) and `--coverage on|off`, which sets `settings.capture.coverage` in the service worker before recording. Also an exported `parseArgs(argv) -> { urls, out, coverage }`.

- [ ] **Step 1: Write failing tests** for `parseArgs`:
  - `['--out', '/tmp/x', 'https://a.test']` gives `{ out: '/tmp/x', urls: ['https://a.test'] }`;
  - `['--coverage', 'off']` gives `coverage: false`;
  - no flags gives `coverage` undefined and the default `out`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Calibrate: `--out` replaces `OUT` everywhere, including the digest. `--coverage` merges into `settings.capture` with the existing storage write. URL parsing must skip flag values.
  - Screens: when a site's first `page.goto` times out, retry once before failing.
- [ ] **Step 4:** `npm test` passes.
- [ ] **Step 5:** Commit: `Scripts: screens retries a slow first load; calibrate --out and --coverage`.

### Task 4: Coverage summariser (pure)

**Files:**
- Create: `extension/core/coverage.js`
- Test: `test/coverage-core.test.mjs`

**Interfaces:**
- Consumes: `isThirdParty`, `siteOf`, `hostOf` from `extension/core/har-util.js`.
- Produces:
  - `jsFiles(profileResult, { documentUrl }) -> File[]`, where `profileResult` is the `result` array of `Profiler.takePreciseCoverage`;
  - `cssFiles(ruleUsage, headers, { documentUrl }) -> File[]`, where `headers` is a `Map` from styleSheetId to the `CSS.styleSheetAdded` header (`{ sourceURL, length, isInline, isConstructed, frameId }`);
  - `summarize(files, { site, cap = 100 }) -> { files, totalBytes, unusedBytes, fileCount }`;
  - `buildCoverage({ profile, ruleUsage, headers, documentUrl, idle }) -> coverage`, in the spec's `log._harplus.coverage` shape: `{ window: 'load', idle, js, css }`;
  - `File = { url, bytes, unusedBytes, inline? }`; `summarize` adds `thirdParty`.
  - Constants: `COVERAGE_CAP = 100`, `SKIP = { snapshot: 'needs a reload: the page was already loaded', record: 'a recording spans several pages', off: 'turned off in Options' }`.

- [ ] **Step 1: Write the failing tests:**
  - `jsFiles: nested ranges`: a script of length 1000 with function ranges `[0,1000,1]`, `[100,400,0]` and `[200,300,1]` gives `unusedBytes` 200.
  - `jsFiles: script length is the largest endOffset`.
  - `jsFiles: document-URL scripts become one inline row` (`url: '', inline: true`, summed).
  - `jsFiles: drops data:, blob:, chrome-extension: and empty URLs`.
  - `jsFiles: same URL twice is one row` (bytes = max, unusedBytes = min).
  - `cssFiles: unused = length − union of used ranges`: overlapping used ranges are not double counted, and an unused rule's range is not subtracted.
  - `cssFiles: inline and constructed sheets are one "inline styles" row`.
  - `summarize: caps to 100 by unusedBytes, totals are true counts`: 150 files give `files.length` 100 and `fileCount` 150, with totals over all 150.
  - `summarize: thirdParty from the site`.
  - `buildCoverage with nothing loaded`: totals 0, `fileCount` 0.
- [ ] **Step 2:** Run `node --test test/coverage-core.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** For JS block coverage, collect every range of every function in the script and sort by `startOffset` ascending, then `endOffset` descending (outer first). Paint them in that order onto disjoint segments, with inner ranges overriding outer ones (the approach of puppeteer's `convertToDisjointRanges`). `unusedBytes` is the summed length of segments whose final count is 0.
- [ ] **Step 4:** `node --test test/coverage-core.test.mjs` passes, and so does `npm test`.
- [ ] **Step 5:** Commit: `core/coverage: summarise V8 and CSS rule coverage for one load`.

### Task 5: Capture wiring, setting and Options toggle

**Files:**
- Modify: `extension/browser/capture.js` (`takeReading`, `CaptureSession`: the event handler for `CSS.styleSheetAdded`, and new methods `startCoverage()` and `takeCoverage(idle)`), `extension/browser/settings.js` (`capture.coverage: true`), `extension/ui/options.html` (a checkbox after Keyboard walk: `data-path="capture.coverage"`, label "Code coverage during load").
- Test: `test/coverage-capture.test.mjs`

**Interfaces:**
- Consumes: `buildCoverage` and `SKIP` from Task 4.
- Produces:
  - `log._harplus.coverage` on every reading: the data, or `{ skipped }`;
  - `log._harplus.capture.coverage = true|false` (whether it was on);
  - an exported pure `coverageSkip(opts, settings) -> string|null`, returning `SKIP.snapshot` for snapshot mode, `SKIP.record` for record mode, `SKIP.off` when `settings.capture.coverage === false`, else `null`.

- [ ] **Step 1: Write the failing tests:**
  - `coverageSkip` covers each case.
  - With a fake session whose `send` rejects for `Profiler.takePreciseCoverage`, `takeCoverage` stores `{ skipped: 'coverage failed: <message>' }` and resolves without throwing. Stub `send` the way existing capture unit tests do; if none exist, test the method on a minimal object built with `CaptureSession.prototype`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `takeReading`'s reload branch:
    - before `s.reload()`, call `await s.startCoverage()`: `Profiler.enable`, then `Profiler.startPreciseCoverage({ callCount: false, detailed: true })`, `DOM.enable`, `CSS.enable` and `CSS.startRuleUsageTracking`; collect `CSS.styleSheetAdded` headers for the main frame into a Map;
    - straight after the first `waitForIdle`, call `await s.takeCoverage(s.reachedIdle)`: `Profiler.takePreciseCoverage`, `CSS.stopRuleUsageTracking`, `Profiler.stopPreciseCoverage`, then `buildCoverage(...)`, held on the session.
  - Every CDP call is wrapped, so a failure gives `skipped`.
  - `finish()` writes it to `log._harplus.coverage`. Snapshot and record readings get `{ skipped: coverageSkip(...) }`.
  - Make sure the focus probe's later `CSS.enable` still works: CSS was enabled earlier and may be left enabled, but tracking has stopped.
- [ ] **Step 4:** `npm test` passes.
- [ ] **Step 5:** Commit: `capture: collect load coverage before the reload, take it at first idle; Options toggle`.

### Task 6: The coverage plugin, panel and Help

**Files:**
- Create: `extension/plugins/coverage.js`
- Modify: `extension/plugins/index.js` (register after `network`), `extension/ui/help.js` (one new `<section>`)
- Test: `test/coverage-plugin.test.mjs`

**Interfaces:**
- Consumes: `log._harplus.coverage` (Tasks 4–5), `transferSize` from `har-util.js`, `SkipError` from `plugin-host.js`.
- Produces: the plugin `{ id: 'coverage', name: 'Code coverage', phase: 'analyze', group: 'quality', area: 'performance', run, render }`. Its result data is `{ js, css, idle }`, where each kind has `{ totalBytes, unusedBytes, fileCount, waste, first: {bytes, unusedBytes}, third: {bytes, unusedBytes}, files: [{ url, kind, bytes, unusedBytes, pct, thirdParty, waste, decodedOnly }] }`.

- [ ] **Step 1: Write the failing tests:**
  - `skips without data`: SkipError "not measured in this reading".
  - `skips with stored reason`: `{ skipped: 'turned off in Options' }` gives that reason.
  - `waste uses transfer share`: a 100 KB decoded file, 60% unused, with a 30 KB transfer entry has waste 18 KB.
  - `waste falls back to decoded when transfer is 0`: `decodedOnly` true.
  - `JS thresholds`: total counted waste of 39 KB gives no finding; 40 KB gives low; 150 KB gives medium. Files under 10 KB waste don't count.
  - `CSS thresholds`: 15 KB gives low and 50 KB gives medium; files under 5 KB don't count.
  - `finding wording and places`: the title contains "not used during load"; places are `{ url }` only, largest waste first; the evidence has the KB figures.
  - `summary`: a headline entry labelled "JS not used" with a percent value, and "CSS not used".
  - `render`: it has stats, the first- and third-party split, a table folded past 8, and "size before compression" on decodedOnly rows. It says "No scripts or stylesheets measured" when both totals are 0, and "taken while the page was still loading" when `idle` is false.
  - `render never says "unused code"`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement** with the existing `h` helpers (`h.stats`, `h.sub`, `h.table`, `h.link`). Help section copy, verbatim:
  > **Not used during load.** Code coverage counts the JavaScript that did not run, and the CSS rules that matched nothing, while the page loaded, up to the moment the network went quiet. It is not dead code: menus, forms and later pages often use some of it. Large amounts still cost download and parse time on every visit.
- [ ] **Step 4:** `npm test` passes. The score check `--compare` reports "no differences", because the calibration HARs have no coverage data and the plugin skips.
- [ ] **Step 5:** Commit: `Plugins: code coverage, CSS and JS not used during load (Performance)`.

### Task 7: e2e, overhead and grade calibration, defaults, after shots

**Files:**
- Modify: `test/e2e/run.mjs` (coverage assertion), `extension/browser/settings.js` (final default), and `extension/ui/help.js` if the default ends up off
- Create: `scripts/coverage-overhead.mjs`
- Refresh: `screens/after/`

**Interfaces:**
- Consumes: the `calibrate.mjs` flags from Task 3, and `scoreReading` from `extension/core/score.js`.
- Produces: `node scripts/coverage-overhead.mjs <dirOn> <dirOff>`, which prints:
  - for each site, LCP and blocking time from the vitals plugin data, on and off, with their percent change;
  - the medians;
  - for each site, the Performance grade with and without the coverage result;
  - an overall verdict: `default on`, `default off`, or `revisit thresholds`.

- [ ] **Step 1:** In `test/e2e/run.mjs`, set `capture.coverage: true` explicitly for the fixture reading. Assert that `log._harplus.coverage.js.fileCount > 0` and that the Performance pane renders the coverage panel ("not used during load").
- [ ] **Step 2:** `npm run test:e2e` passes.
- [ ] **Step 3:** Write `coverage-overhead.mjs` and unit-test its pure parts: median, percent change, grade-step difference (`test/coverage-overhead.test.mjs`).
- [ ] **Step 4:** Record two back-to-back runs, neither overwriting the score-check HARs:
  - `node scripts/calibrate.mjs --coverage on --out /Users/tpowell/src/har-plus/test/e2e/out/coverage-on`
  - `node scripts/calibrate.mjs --coverage off --out /Users/tpowell/src/har-plus/test/e2e/out/coverage-off`

  Then run the overhead script on the two folders.
- [ ] **Step 5:** Apply the rules from Global Constraints.
  - If the verdict is `default off`, set `capture.coverage: false` and add one sentence to the Help section: "Off by default because measuring it slows the page slightly; turn it on in Options."
  - If the verdict is `revisit thresholds`, stop and report the per-site grades in the task report. The controller rules on new thresholds.
  - Record the numbers in the task report.
- [ ] **Step 6:** `npm test` and `npm run test:e2e` pass. Run `node scripts/screens.mjs --out test/e2e/out/screens-coverage`, then check the Performance pane at 1280, in dark mode and at 390 wide. Fix layout only.
- [ ] **Step 7:** Commit the code: `Coverage: e2e, overhead check, default`. Then run `node scripts/screens.mjs --out screens/after` and commit `screens/after` alone: `screens/after: refreshed with coverage and display fixes`.
