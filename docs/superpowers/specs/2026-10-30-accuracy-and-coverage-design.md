# Accuracy fixes and load coverage (unused CSS and JS)

Status: draft for approval · 2026-10-30

## Why

HARgus is moving toward comparing sites: a teacher setting Harvard against UCSD, a salesperson setting a customer
against competitors. A comparison inherits every inaccuracy of the readings it compares, so the known accuracy problems
left over from the redesign go first. The same batch adds one new measurement that compares well across sites and teaches well:
how much of the CSS and JavaScript a page ships is not used while it loads.

The two parts are independent and can be built and reviewed as separate tasks in one plan.

## Goals

- Remove the known false positive and the display flaws left from phase 5, without changing any other finding.
- Add a **coverage** measurement: per file and in total, the share of each script and stylesheet that did not run
  (JS) or match (CSS) during page load, shown in the Performance area.

## Non-goals

- Coverage after interaction (scrolling, tabbing, the views). Load only.
- Coverage for old readings. The data has to be collected live; old readings say "not measured".
- Coverage inside cross-site iframes or workers. Main frame only.
- Telling the reader which code to delete. The plugin reports bytes, not dead functions or selectors.
- The comparison features themselves (a later project).

## Anti-goals

- Calling code "unused". Code that does not run during load may still be needed later, for a menu, a form or a
  route. Every label says **not used during load**. Help explains the difference once.
- Making every reading slower or its timings worse to get this number. See *Overhead* below.

---

## Part A: accuracy fixes

Each item is small. All of them change rendering or tooling only, except A1, which deliberately changes findings.

| # | Fix | Where | Changes findings? |
|---|---|---|---|
| A1 | `<link rel="mask-icon" color="…">` is not presentational markup. The page collector stores tag.attribute pairs, so it records `link.color`. Exclude `link.color` from the `PRESENTATIONAL` check, in both the evidence list and `presentationalPlaces`. `color` on `<link>` exists only for mask-icon. The fix is in analysis, not collection, so `score-check` replays it. | `extension/plugins/html.js` | **Yes**, on purpose. The finding is `info`, so grades should not move. |
| A2 | A number must not wrap away from its unit ("43.9 / KB"). Fix this in rendering only, for example by keeping a value and its unit together in the `h` helpers that draw values, or with CSS on value cells. Do not change the shared formatters, because they also produce finding text. | `extension/ui/render.js`, `theme.css` | No |
| A3 | Capped lists say "first N of M" when they stop short. | content, network, html-validate, css-validate renders | No |
| A4 | One shared helper for folding tag lists past 8, replacing the four local copies, and styled like the table and list folds. | `extension/ui/render.js` and the 4 callers | No |
| A5 | No list folded twice inside a section that is already closed. | history, css-validate, security renders | No |
| A6 | One wording for counts on closed sections, matching the existing `h.more` usage. | renders flagged in the phase-5 final review | No |
| A7 | Renders import thresholds from the plugin's own constants instead of copying the numbers. | meta, resilience | No |
| A8 | The pagespeed headline is keyed on the Lighthouse audit id, not its English title. | `extension/plugins/pagespeed.js` | No |
| A9 | The `<head>` order glance folds past 8 like other lists. The Accessibility views "Fail" tile no longer wraps onto two lines. | head-order, a11y-views, `theme.css` | No |
| A10 | The print rule that pushes inline URLs onto their own line is fixed. | `theme.css` (print) | No |
| A11 | `scripts/screens.mjs` retries a site once when its first load times out. | `scripts/screens.mjs` | n/a (tooling) |

### Verifying Part A

- `npm test` passes, with a test for each behaviour change (A1, A2, A3, A8, A11 where practical).
- **Score check:** run `scripts/score-check.mjs` against the 21 calibration readings with `--compare`. The only
  differences allowed are A1's: the presentational-markup finding loses `mask-icon` from its evidence or count, or
  disappears where it was the only cause. Then regenerate the baseline with `--write`, in its own commit, whose message
  lists the readings whose findings changed. Before A1, the baseline holds 21 readings and 1365 findings.
- `theme.css` keeps its export rule: no `<` outside comments, and media queries use `min-width` and `max-width` only.

---

## Part B: load coverage

### What it measures

Chrome can report which byte ranges of each script ran (V8 precise coverage) and which CSS rules matched (CSS rule-usage tracking).
HARgus already drives the tab through the Chrome debugger, so it can collect both while recording.

**Window.** Coverage (`Profiler.startPreciseCoverage`, and `CSS.startRuleUsageTracking` after `DOM.enable` and
`CSS.enable`) starts in `takeReading` just before `s.reload()`. It is taken (`Profiler.takePreciseCoverage` and
`CSS.stopRuleUsageTracking`, then coverage is stopped) immediately after that first `waitForIdle` returns. That is before the
optional scroll-through, before the focus probe, the keyboard walk, the page plugins and the views, all of which interact with the page and would run extra code.
No other `waitForIdle` call is involved. When that wait ran out before idle (`reachedIdle` false), coverage is still
taken. It is stored with `idle: false`, and the panel says "taken while the page was still loading", since more
code may have been about to run. The focus probe's later `CSS.enable` must not disturb this: tracking has already
stopped by then. The builder confirms that nothing in the early enable breaks the probe.

**Capture modes.**

| Mode | Coverage |
|---|---|
| `reload` (default) | Measured |
| `snapshot` | Not measured, with the reason "needs a reload: the page was already loaded" |
| `record` | Not measured, with the reason "a recording spans several pages" |

**Scope.** Only the main frame's own target. Scripts and stylesheets from other hosts that load into the main frame are
included and marked third-party, using the same first-party test the rest of HARgus uses. The inline cases are
included as one row per kind ("inline scripts", "inline styles"), not one row per block:
- inline scripts are scripts whose URL is the document URL;
- inline styles are `<style>` blocks and stylesheets with no source URL (constructed or adopted).

Scripts with an empty URL (`eval`, `new Function`) and extension scripts are left out. `style=` attributes aren't
stylesheets and aren't counted. `@import`ed sheets count as their own files. V8 reports character offsets;
they are treated as bytes. That is exact for ASCII-minified code and close enough otherwise.

### Data stored in the reading

The capture stores a compact summary at `log._harplus.coverage`, never raw ranges:

```js
coverage: {
  window: 'load',               // reserved for a future 'interaction' window
  idle: true,                   // false when taken before network idle
  js:  { files: [ { url, bytes, unusedBytes, thirdParty, inline? } ], totalBytes, unusedBytes, fileCount },
  css: { files: [ ... same shape ... ],                               totalBytes, unusedBytes, fileCount },
  skipped?: 'reason'            // set instead of js and css when not measured
}
```

- `bytes` and `unusedBytes` are decoded (uncompressed) source bytes, as coverage reports them.
- Each `files` list keeps the 100 largest by `unusedBytes`. The totals and `fileCount` are always true counts, as the
  phase-5 "true counts" rule requires.
- URLs are stored as the HAR stores network entry URLs, including the query string, so a file can be matched to its
  entry and two bundles with the same path stay distinct.

### The plugin

A new **analyze-phase** plugin, `coverage`, in the **Performance** area. Its `run()` reads `log._harplus.coverage`,
so it re-runs from saved data in the extension's re-analyse, in the CLI and in `score-check`. It is an
analyze plugin, which score-check already re-runs, so it is not added to `REPLAY`. It skips in three cases:
- with no coverage data: "not measured in this reading" (old readings, HARs from other tools);
- with coverage turned off in Options: "turned off in Options";
- with any other stored `skipped` reason: that reason.

**Estimated transfer waste.** For each file, unused share × the file's transfer size from the matching HAR entry
(the main-frame entry with the same URL; with several, the first that has a positive transfer size), as Lighthouse
estimates it. When no entry matches, or its transfer size is 0 or unknown (served from cache, inline), use the unused
decoded bytes. That overstates compressed files, and the panel marks such rows "size before compression".

**Findings.** At most one per kind:

| Finding | Severity |
|---|---|
| JavaScript not used during load: estimated waste ≥ 150 KB | medium |
| JavaScript not used during load: estimated waste ≥ 40 KB | low |
| CSS not used during load: estimated waste ≥ 50 KB | medium |
| CSS not used during load: estimated waste ≥ 15 KB | low |

These thresholds are starting values. They are checked in calibration (see Verification) and adjusted there if they
misgrade the reference sites. Only files with an estimated waste of at least 10 KB (JS) or 5 KB (CSS) count towards a
finding, so many tiny files don't add up to one. Each finding's `places` lists its counted files as `{ url }`, largest
first. That follows the "places are locations only" rule; the byte figures go in the evidence. The title says
"not used during load"; the detail gives totals and the first- and third-party split.

**Panel**, drawn through the `h` helpers and following the phase-5 panel rules:

- Stats: JS not used during load (percent and KB), CSS not used during load (percent and KB), files measured.
- A small first-party versus third-party split for each kind.
- A table of the files with the most unused bytes: file (as URL parts), kind, size, unused, percent unused, party.
  It folds past 8 rows.
- The Reading column in Checks shows a labelled value, for example "JS 62% not used".

**Help.** One entry in the Help overlay explains "not used during load": what it means, why it isn't the same as
dead code, and that interaction often uses some of it. No explanatory text in the panel itself.

### Overhead

Precise coverage and rule tracking can slow the page slightly while it loads, which would change timing metrics such
as blocking time and LCP for every reading.

- Use the lightest settings: block-level coverage without call counts, and rule tracking only.
- **Verification:** record the calibration sites with coverage on and off, using the existing calibration runner.
  Compare timing metrics. If the median change in blocking time or LCP is above 5%, coverage defaults to **off**,
  with an Options toggle, and the Help text says so. Otherwise it defaults to on, with the same toggle.
- Either way, the capture records whether coverage was on, so a later comparison can tell like from like.
- Build order: the Options toggle (`capture.coverage`, default **on** during the build) and the stored skip reason come
  with the first coverage task. The calibration task sets the final default as its last step. The e2e check turns
  coverage on explicitly, so it passes whatever the default is.
- I run the calibration with `scripts/calibrate.mjs` against the reference sites, recording fresh live readings. Live
  sites change, so the on/off comparison is made between two runs taken back to back, not against the old baseline.

### Scoring

Coverage findings feed the Performance score like any other finding. Because new readings would grade differently
from old ones, the calibration step reports the Performance grade change across the reference sites. A shift of more
than one grade step on any site means the thresholds are revisited before merging.

---

## Verification (whole batch)

1. `npm test` passes, with new unit tests for:
   - the coverage summariser (ranges → bytes, top-100 cap, true totals, inline grouping, third-party flag);
   - the plugin (thresholds, severities, places, skip reasons);
   - the render;
   - Part A's behaviour changes.
2. The score check shows only A1's intended differences. The baseline is regenerated afterwards. The coverage plugin
   adds new findings only for readings that have coverage data, and the existing calibration HARs have none.
3. `npm run test:e2e` passes, with an e2e check that a reload-mode reading of a fixture page has `coverage` data and a
   Performance panel row.
4. A calibration run with coverage on and off settles the default (see *Overhead*) and the thresholds
   (see *Scoring*).
5. `scripts/screens.mjs` refreshes `screens/after`, including the Performance pane with the coverage panel.

## Left to the builder

- The CDP calls and the byte arithmetic: coverage ranges to unused bytes, and rule usage to unused bytes, using
  the stylesheet headers' lengths.
- Where the summariser lives. Suggested: a pure `extension/core/coverage.js` used by capture and unit-tested,
  following the pattern of `core/console.js`.
- The exact first-party test reused, and the exact wording of titles within the rules above.
- How A2 and A6 are implemented, within the constraint that finding text does not change.

## Calls I made (for review)

- The window is load only, ending at network idle, before scroll and interaction.
- Coverage is not measured in snapshot and record modes.
- Data is stored as a compact summary, with the top 100 files per kind.
- The plugin runs in the analyze phase, so it is replayable.
- The finding thresholds and the 5% overhead rule are starting values, settled by calibration.
- A2 is fixed in rendering, not in the formatters.
- A coverage snapshot taken before network idle is still kept, and flagged.
- Inline means a script whose URL is the document URL, or a stylesheet with no source URL. `eval` code and
  extension scripts are left out.
- When the transfer size is unknown, waste falls back to decoded bytes, and the row is marked.
- A1 excludes `link.color` as a whole, since `color` on `<link>` exists only for mask-icon.
