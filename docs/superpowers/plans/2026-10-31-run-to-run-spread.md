# Run-to-Run Spread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a reading with 1, 3 or 5 runs of the same page, and report the median timing with its range, a
"steady" or "varies" verdict, and a table of every run. Ratings, findings and the score all use the median.

**Architecture:**
- **Capture:** `takeReading` does N−1 timing-only reloads before the full run's reload. Each one runs the existing
  vitals collector in the page, and its traffic and console are kept out of the reading. The samples are stored in
  `log._harplus.runs`.
- **Analysis:** a pure module, `core/runs.js`, works out the median, range and verdict. The vitals plugin joins the
  stored timing samples with its own full-run data and reports on the median.
- **Unchanged without runs:** a reading with no `runs` behaves exactly as it does today.

**Tech Stack:** plain ES modules (Chrome MV3), node:test, Playwright for e2e and the live scripts.

**Spec:** `docs/superpowers/specs/2026-10-31-run-to-run-spread-design.md`

## Global Constraints

- **The default is 1 run, and it behaves exactly as today.** Any reading without `log._harplus.runs`, or with no
  timing samples, scores and renders exactly as before.
  `node scripts/score-check.mjs /Users/tpowell/src/har-plus/test/e2e/out/calibrate --compare /Users/tpowell/src/har-plus/test/e2e/out/score-baseline.json`
  must report "no differences" after every task.
- **Run counts offered:** 1, 3 and 5, in reload mode only. Snapshot and record ignore `runs`.
- **Timing runs keep no extras:** no bodies, screenshots, views, coverage or other plugins. Their network traffic and
  console never enter the reading.
- **A failed timing run never fails the reading.** It is listed in `skipped` with its reason.
- **One value per metric:** whatever the tile shows, the rating, the finding and the score use the same value.
- **"Varies" rules:**
  - a metric varies when its values fall into more than one rating band (`LIMITS` and `BLOCKING` in
    `extension/plugins/vitals.js`), or when (max − min) > 25% of the median;
  - for TTFB, load and DOMContentLoaded the 25% rule applies only when max − min ≥ 100 ms;
  - for CLS and blocking time only the band rule applies.
- **Spread needs data:** at least 2 values in all (timing samples plus the full run). With fewer, the reading behaves
  as a 1-run reading.
- **Median of an even count** is the mean of the middle two values.
- **Labels** say "median" and "runs" in words, never "p50" or "σ".
- **Project rules:**
  - `theme.css` contains no `<` outside comments, and its media queries use only min-width and max-width;
  - plugins draw only through the `h` helpers, and the export runs without script;
  - `places` keys are whitelisted (url, text, region, selector, file, note, status, line, entry), and run figures go
    in `evidence`;
  - capped lists store true counts.
- **Never run e2e, screens, calibrate or score-check at the same time** as each other.
- **In a worktree:** the HARs and the baseline live in the main checkout, so use the absolute paths
  `/Users/tpowell/src/har-plus/test/e2e/out/...`.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. **A metric missing in some runs.** For example, LCP is null in one run because the tab was hidden. The median uses
   only the runs that have the metric, and with fewer than 2 values that metric shows the full run's value and no
   range. The test is in Task 1.
2. **Every timing run fails.** The reading is a normal 1-run reading, and Reading health says "Only 1 of 3 runs
   succeeded". The tests are in Task 3 (capture) and Task 2 (render).
3. **Timing-run traffic leaking into the HAR.** A 3-run reading's entries must all belong to the full run's load. The
   test is in Task 3 (fake session), and e2e checks it in Task 5.
4. **Old readings and 1-run readings in the report.** No range note, no "Each run" section, and the Overview and tiles
   exactly as before. The test is in Task 2, and the score check runs after every task.
5. **Medians that sit on a band edge.** For example, LCP runs of 2400, 2600 and 2500 give a median of 2500, which is
   good (≤ 2500), and the metric varies because its runs span two bands. The test is in Task 1.

---

### Task 1: `core/runs.js`, the spread arithmetic

**Files:**
- Create: `extension/core/runs.js`
- Test: `test/runs.test.mjs`

**Interfaces:**
- Produces:
  - `export const VARIES_PCT = 0.25`
  - `export const VARIES_FLOOR_MS = 100`
  - `export const RUN_METRICS = ['lcp', 'fcp', 'ttfb', 'cls', 'blockingTime', 'domContentLoaded', 'load']`
  - `export function median(values: number[]): number | null`. It drops nulls and non-finite values, and returns the
    mean of the middle two for an even count, or null when no values are left.
  - `export function sampleOf(collected): {lcp, fcp, ttfb, cls, blockingTime, domContentLoaded, load}`. It flattens a
    vitals `collect()` result: `lcp: c.lcp?.time ?? null`, `ttfb: c.navigation?.ttfb ?? null`, and `domContentLoaded`
    and `load` from `c.navigation`. Each missing metric becomes null.
  - `export function spread(values: (number|null)[], { bands?: [good, poor], pctRule = true, floor = 0 }): { median, min, max, n, varies, bands?: { good, 'needs improvement', poor } } | null`.
    - It returns null when fewer than 2 finite values remain.
    - `varies` is true when the values fall into more than one band (when `bands` is given), or when `pctRule` is set
      and (max − min) > VARIES_PCT × median and (max − min) ≥ floor.
    - `bands` counts the values in each band, with value ≤ good counted as good and value ≤ poor as needs
      improvement.
  - `export function spreadAll(samples: object[], limits: {lcp, fcp, ttfb, cls, blockingTime}): { [metric]: spread | null }`.
    It applies the per-metric rules from Global Constraints:
    - lcp, fcp and ttfb get bands, the pct rule, and floor 0 (ttfb floor 100);
    - cls and blockingTime get bands only, with no pct rule;
    - domContentLoaded and load get the pct rule with floor 100 and no bands.

- [ ] **Step 1: Write the failing tests** in `test/runs.test.mjs`:
  - `median([3,1,2]) === 2`, `median([1,2,3,4]) === 2.5`, `median([null, 5, NaN]) === 5`, and `median([]) === null`.
  - `sampleOf` takes a vitals-shaped object (see `c()` in `test/vitals.test.mjs`) and returns
    `{ lcp: 5000, fcp: 500, ttfb: 100, cls: 0.3, blockingTime: 400, domContentLoaded: 400, load: 900 }`.
  - `sampleOf({})` gives all seven metrics as null.
  - `spread([2400, 2600, 2500], { bands: [2500, 4000] })` gives median 2500, min 2400, max 2600, n 3 and
    varies true, because the values span good and needs improvement.
    `bands` is `{ good: 2, 'needs improvement': 1, poor: 0 }`.
  - `spread([1000, 1100, 1050], { bands: [2500, 4000] })` gives varies false.
  - `spread([1000, 1400, 1100], { bands: [2500, 4000] })` gives varies true: 400 > 0.25 × 1100.
  - The floor test: `spread([100, 160, 120], { floor: 100 })` gives varies false. The range of 60 is more than 25% of
    120 but under the floor.
  - `spread([0.01, 0.05, 0.02], { bands: [0.1, 0.25], pctRule: false })` gives varies false.
  - `spread([5, null])` gives null, and `spread([5])` gives null.
  - `spreadAll` gets two samples where lcp is null in one. `lcp` is null, and the other metrics are computed.
- [ ] **Step 2:** Run `node --test test/runs.test.mjs`. It should fail because the module is not found.
- [ ] **Step 3:** Implement `extension/core/runs.js` with the signatures above. Keep it a pure module that imports
  nothing.
- [ ] **Step 4:** Run `node --test test/runs.test.mjs`, then `npm test`. Both should pass.
- [ ] **Step 5:** Commit: "core/runs: median, range and the varies rule for repeated runs".

### Task 2: Vitals plugin works on the median, and the report shows the spread

**Files:**
- Modify: `extension/plugins/vitals.js`. Change `run` (≈ line 102), `render` (≈ line 150) and `glance`
  (≈ line 177), and export `LIMITS` and `BLOCKING` for `spreadAll`.
- Modify: `extension/ui/report.js`. In `atAGlance` (≈ line 130), the LCP and CLS stats use the median when it is
  present.
- Modify: `extension/ui/report.js` (or wherever Reading health lines are built; search for `viewsSkipped`). Add the
  line "Only K of N runs succeeded" when `runs.requested > 1` and the total successful runs is less than
  `requested`.
- Modify: `extension/ui/help.js`. Add a "Runs" section (see Step 3).
- Modify: `extension/ui/library-card.js` (≈ line 20). Show `· ×N` after the mode when the index record's
  `runs > 1`.
- Modify: `extension/core/harplus.js`, `indexRecord` (≈ line 117). Add
  `runs: hp.capture?.runs ?? 1`.
- Tests: `test/vitals.test.mjs`, `test/report.test.mjs` and `test/library.test.mjs`.

**Interfaces:**
- **Consumes:** Task 1's `median`, `sampleOf`, `spreadAll` and `RUN_METRICS`.
- **Consumes the stored shape** (written by Task 3):
  - `reading.log._harplus.runs = { requested, samples: [{ run, lcp, fcp, ttfb, cls, blockingTime, domContentLoaded, load }], skipped: [{ run, reason }] }`.
    It holds only the timing runs, numbered 1…requested−1. The full run is always run number `requested`, and its sample
    is `sampleOf(ctx.collected)`.
  - `reading.log._harplus.capture.runs`: the count of successful runs, counting the full run.
- **Produces:**
  - `vitals.data.runs = { n, requested, samples: [...timing samples, { run: <last>, full: true, ...sampleOf(c) }], skipped, metrics: spreadAll(...) }`.
    It is present only when there are 2 or more values in all.
  - `vitals.data.ratings` comes from the median when `data.runs` is present.
  - `vitals.data.median = { lcp, fcp, ttfb, cls, blockingTime }` when `data.runs` is present, so that the Overview
    and others read a single place.
  - Old consumers of `data.lcp.time` and `data.cls` keep the full run's values. The new code reads `data.median`
    first.

- [ ] **Step 1: Write the failing tests** in `test/vitals.test.mjs`. Use a reading with
  `_harplus.runs = { requested: 3, samples: [s(3000), s(3500)], skipped: [] }`, where `s(lcp)` builds a sample, and
  the collected full run has LCP 5000.
  - **Median rating:** the LCP median is 3500 (needs improvement), so `data.ratings.lcp === 'needs improvement'`. The
    LCP finding has severity `low` and its title contains "3.5 s", not "5.0 s".
  - **Straddling a band:** `evidence` names the straddle, "1 of 3 runs were poor". That is the count of runs whose
    band differs from the median's band, written as "K of N runs were <band>". When every run is in the median's
    band there is no such evidence.
  - **Blocking time:** the finding uses the median blocking time against the existing > 300 threshold.
  - **`data.runs`:** `n` is 3, the last sample has `full: true` and `run: 3`, and `metrics.lcp.median` is 3500.
  - **No runs at all:** a reading with no `runs` gives a result `deepEqual` to today's for the same collected data.
    Assert that `data.runs` and `data.median` are undefined.
  - **One sample:** a reading with `samples: []` and `skipped: [{run:1},{run:2}]` gives no `data.runs`, and the
    ratings come from the full run.
  - **Glance with runs:** the LCP tile shows the median value, with the note "3.0–5.0 s · 3 runs · varies" (or
    "steady"). Format the range with the same formatter as the value: `formatMs` for times, two decimals for CLS.
  - **Glance without runs:** there is no note. Today's output is unchanged; compare against a 1-run render.
  - **Render with runs:**
    - a closed `<details>` titled "Each run", holding a table with the columns Run, LCP, FCP, TTFB, CLS, Blocking and
      Load;
    - one row per sample, with the full run marked "(full reading)";
    - a final row "Median";
    - skipped runs listed below the table as "Run 2: timed out".
  - **Render without runs:** no "Each run".

  In `test/report.test.mjs`:
  - **Overview:** with runs, the LCP stat shows the median and has the note "median of 3". Without runs it is
    unchanged.
  - **Reading health:** "Only 1 of 3 runs succeeded" when `requested: 3` and `capture.runs: 1`.
  - **Help:** the text matches `/Runs/`, `/median/` and `/full reading/`, and the word count stays within the cap.

  In `test/library.test.mjs`: a card with `runs: 3` shows "×3", and `runs: 1` shows no "×".
- [ ] **Step 2:** Run `node --test test/vitals.test.mjs test/report.test.mjs test/library.test.mjs`. The new tests
  should fail.
- [ ] **Step 3: Implement the changes.** In `vitals.run`:
  1. Build `all = [...(runs?.samples ?? []), { run, full: true, ...sampleOf(c) }]`.
  2. When `all.length ≥ 2`, compute `metrics = spreadAll(all, { ...LIMITS, blockingTime: BLOCKING })`.
  3. Each metric's working value is `metrics[k]?.median ?? fullRunValue`.
  4. Feed the working values into the existing ratings, findings and summary code. Don't fork it.

  The Help section reads (about 60 words; trim elsewhere if the 450-word cap in `test/report.test.mjs` is exceeded,
  or raise the cap by exactly the words added, and say which in the report):

  > **Runs.** Timings change from one load to the next. With 3 or 5 runs, HARgus reloads the page that many times and reports the median, with the range from fastest to slowest. "Varies" means the runs disagree enough that a single reading could mislead. Only timings are repeated; the element details, checks and views come from the full reading.
- [ ] **Step 4:** Run `npm test`, then the score check. All tests should pass, and the score check should report "no
  differences".
- [ ] **Step 5:** Commit: "vitals: median, range and each run when a reading has several runs".

### Task 3: Capture the timing runs, and add the Runs setting

**Files:**
- Modify: `extension/browser/settings.js`. Add `runs: 1, // 1 | 3 | 5 timing runs of the same page (reload only); extra runs are timings only` to
  `DEFAULTS.capture`.
- Modify: `extension/browser/capture.js`. Add `CaptureSession.timingRuns(n)`, called in `takeReading` before
  `startCoverage` and `reload()`, and the record fields in `finish`.
- Modify: `extension/ui/popup.html` and `popup.js`. Add a `<label class="pair">Runs <select name="runs">` with the
  options 1, 3 and 5. The value is saved as a number. The select is disabled while recording.
- Modify: `extension/ui/options.html`. Add the same select with `data-path="capture.runs"`, following how the other
  selects there are wired.
- Modify: `extension/ui/progress.js` or `core/progress.js`, only if a new stage name needs a label. Report
  `('loading', 'Timing run K of N')`.
- Test: `test/runs-capture.test.mjs`. Use the fake-session approach of `test/coverage-capture.test.mjs`.

**Interfaces:**
- **Consumes:** Task 1's `sampleOf`, and the vitals plugin's exported `collect` (`extension/plugins/vitals.js`). It is
  the plugin's `collect` property, imported from the plugin's default export.
- **Produces** `log._harplus.runs` and `log._harplus.capture.runs`, with the shapes given in Task 2. The rules:
  - **Reload mode with `runs > 1` (n = 3 or 5):** `log._harplus.runs` is written, with `requested: n`. Timing runs are
    numbered 1…n−1, and the full run is n.
  - **When nothing is written:** with runs = 1, or in snapshot or record mode, `log._harplus.runs` is absent and
    `capture.runs` is 1.
  - **Exported helper:** `runsWanted(opts) -> number`. It returns 1 unless mode is `reload` and `opts.runs` is 3 or 5.
    Any other value gives 1.

- [ ] **Step 1: Write the failing tests** in `test/runs-capture.test.mjs`:
  - **`runsWanted`:** `{mode:'reload',runs:3}` gives 3, `{mode:'snapshot',runs:3}` gives 1,
    `{mode:'reload',runs:4}` gives 1, and `{mode:'reload'}` gives 1.
  - **Three requested:** a fake session whose `reload`, `waitForIdle` and `evaluate` resolve. `evaluate` returns a
    vitals-shaped object per call, and `timingRuns(3)` makes two of them. The result is 2 samples with `run: 1` and
    `run: 2`, and `skipped: []`.
  - **A timeout:** the second run's evaluate times out or rejects. `skipped` is
    `[{ run: 2, reason: <message> }]`, with no throw.
  - **Traffic stays out:** while `timingRuns` runs, the session's network handler ignores events, the same way
    `viewsRunning` does. Network events fed to `onEvent` during a timing run leave `recorder` entries empty. Use a
    `timingRunning` flag next to `viewsRunning`, and include it in the same guards at `capture.js` ≈ 1055–1068.
  - **Coverage is never started during timing runs.** Assert that the order of calls is: the timing reloads, then
    `startCoverage`, then the full `reload`.
  - **`DEFAULTS.capture.runs === 1`.**
- [ ] **Step 2:** Run `node --test test/runs-capture.test.mjs`. The tests should fail.
- [ ] **Step 3: Implement `timingRuns(n)`.** For each k in 1…n−1, inside a try/catch per run:
  1. Call `report('loading', \`Timing run ${k} of ${n}\`)`.
  2. Call `reloadQuiet({ ignoreCache: !!this.opts.bypassCache })`.
  3. Call `waitForIdle({ idleMs: this.opts.idleMs, maxMs: this.opts.maxWaitSec * 1000, quiet: true })`.
  4. Evaluate the vitals `collect` in the main world with a 5 s timeout, and push `{ run: k, ...sampleOf(result) }`.

  Emulation and throttle are already applied by `attach()`, so they carry over. Check this; if `attach` doesn't apply
  them, apply them before the first timing run.

  `finish` writes `hp.runs` when `runsWanted > 1`, and sets `capture.runs = 1 + samples.length` (the full run counts
  as 1). Reset the console after the timing runs, as the reload handler already does in reload mode.
- [ ] **Step 4:** Run `npm test`, then the score check. All tests should pass, and the score check should report "no
  differences" (calibration readings have no runs).
- [ ] **Step 5:** Commit: "capture: timing runs before the full reading; Runs setting in the popup and Options".

### Task 4: calibrate `--runs` and a per-capture timeout

**Files:**
- Modify: `scripts/calibrate.mjs`. In `parseArgs` (≈ line 60), add `--runs N`. Change the capture loop
  (≈ lines 120–156).
- Test: `test/calibrate.test.mjs`.

**Interfaces:**
- **Produces:** `parseArgs(argv) -> { urls, out, coverage, runs, timeoutSec }`.
  - `runs` is 1, 3 or 5, and is merged into `settings.capture.runs`. Any other value exits with the error
    "--runs must be 1, 3 or 5".
  - `timeoutSec` defaults to 300, or 300 × runs when `--runs` is given. It is set with `--timeout S`.
  - Fix the deferred minor along the way: a bad `--coverage` value, or `--out` followed by a flag, now exits with an
    error instead of being ignored.
  - **Per-capture timeout:** when a site's capture (from the capture call to `analysis === 'done'`) exceeds
    `timeoutSec`, the script logs `TIMEOUT <url> after S s`, closes that page, records the site in the digest as
    `{ url, error: 'timed out' }`, and goes on to the next URL.

- [ ] **Step 1: Write the failing tests:**
  - `parseArgs(['--runs','3'])` gives `runs: 3` and `timeoutSec: 900`.
  - `parseArgs([])` gives `runs: 1` and `timeoutSec: 300`.
  - `--runs 4`, `--coverage maybe`, and `--out --runs` (a flag used as the directory) each throw or exit with the
    errors above. Test through an exported `parseArgs` that throws, with `main` turning the throw into an exit.
  - The timeout itself: export `withDeadline(promise, ms, label)` from the script and test that it rejects with
    `timed out` after a short ms. Do not test it with a live browser.
- [ ] **Step 2:** Run `node --test test/calibrate.test.mjs`. The tests should fail.
- [ ] **Step 3:** Implement the changes. Do not run calibrate in this task.
- [ ] **Step 4:** Run `npm test`. All tests should pass.
- [ ] **Step 5:** Commit: "calibrate: --runs, per-capture timeout, strict flags".

### Task 5: e2e, live check and after screenshots

**Files:**
- Modify: `test/e2e/run.mjs`. Add a 3-run reading of the local test page.
- Modify: `extension/ui/help.js`. Add the measured cost per extra run to the Runs section.
- Create: `scripts/runs-report.mjs`. It takes the calibrate output directory and prints one row per site and metric:
  median, range %, varies, and the seconds per extra run.
- Test: `test/runs-report.test.mjs`, covering the pure row builder.

- [ ] **Step 1: e2e.** Set `capture.runs = 3` for one reading of the local page, and assert the following:
  - **Samples:** `runs.samples.length + 1 + runs.skipped.length === 3`, and `capture.runs ≥ 2` (or a recorded skip).
  - **No leaked traffic:** every HAR entry's `startedDateTime` is at or after the full run's start. Record the full
    reload's time in `capture.fullRunAt` (an ISO string, set in `takeReading` just before `reload()`), and add it to
    Task 3's fields if it isn't there.
  - **Report:** the Performance pane renders the "Each run" section, and the LCP tile has a "· 3 runs" note.
- [ ] **Step 2: Unit-test `runs-report.mjs`.** Write a test for its row builder (`rows(digest) -> [{ site, metric, median, rangePct, varies }]`)
  using a hand-made digest. To feed it, the calibrate digest must include each reading's
  `plugins.vitals.data.runs.metrics` and `capture.durationMs`. Add both to the digest entry if they are absent.
- [ ] **Step 3: Live check.** Run nothing else at the same time. Run:
  `node scripts/calibrate.mjs --runs 3 --out /Users/tpowell/src/har-plus/test/e2e/out/runs-3 <6 sites from SITES>`.
  Then run `node scripts/runs-report.mjs /Users/tpowell/src/har-plus/test/e2e/out/runs-3`.
  - Write the table into the report.
  - Seconds per extra run = (median duration of the 3-run captures − median duration of the 1-run captures in
    `/Users/tpowell/src/har-plus/test/e2e/out/calibrate`) / 2, rounded to the nearest 5 s.
  - If more than 80% or fewer than 10% of the site-metric pairs vary, say so in the report and leave `VARIES_PCT`
    alone. Retuning is a separate decision for the controller.
- [ ] **Step 4: Help.** Append "Each extra run adds about N seconds." to the Runs section. Keep the word cap, as in
  Task 2.
- [ ] **Step 5: Verify.** Run `npm test`, then `npm run test:e2e`, then the score check, one at a time.
  The score check should report "no differences".
  Then commit: "Runs: e2e, live spread check, cost in Help".
- [ ] **Step 6: Screens.** Run `node scripts/screens.mjs --out screens/after`, then look at the Performance pane
  screenshot and the Overview. Commit `screens/after` on its own: "screens/after: refreshed with run-to-run spread".
  If `screens.mjs` has no way to take a 3-run reading, add a `--runs` pass-through to it, the same way it turns
  coverage on, so the Performance shot shows the spread.
