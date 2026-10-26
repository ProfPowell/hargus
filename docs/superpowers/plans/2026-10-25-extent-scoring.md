# Extent scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make the Accessibility score count how much of the page each finding affects, as well as how many kinds of problem there are, and make the report's scoring table add up to the score.

**Architecture:**
- **Findings** gain optional `{ count, of, unit }` fields.
- **`core/score.js`** (pure) combines them:
  - for areas in `EXTENT_AREAS` (Accessibility only), the score is 100 minus a breadth part (today's deductions, scaled to 60%) minus an extent part (up to 40 points, from severity-weighted shares);
  - a new pure `scoreTable(area)` builds the rows and footer the report renders.
- **The plugins** set the fields from data they already collect. One shared pure helper, `core/extent.js`, maps a rule id to its population.
- **Contrast** folds its per-pair findings into one.

**Tech Stack:** plain ES modules, `node --test`, Playwright e2e (`npm run test:e2e`), Chrome MV3 extension.

**Spec:** `docs/superpowers/specs/2026-10-25-extent-scoring-design.md`

## Global Constraints

- **Constants**, in `extension/core/score.js`:
  - `BREADTH_SHARE = 0.6`
  - `EXTENT_MAX = 40`
  - `EXTENT_FULL = 0.25`
  - `EXTENT_SMOOTH = 10`
  - `EXTENT_WEIGHT = { high: 1, medium: 0.5, low: 0.1, info: 0 }`
  - `EXTENT_AREAS = ['accessibility']`
  - `DEDUCT` and `CAP` are unchanged: `{high 15, medium 6, low 2, info 0}` and `{high 55, medium 30, low 15}`.
- **Validating the fields:**
  - `count` and `of` count only when `Number.isInteger(x) && x > 0`; anything else is ignored. A string `'65'` is ignored.
  - If `of < count`, `of` is raised to `count`.
  - A count with no valid `of` counts toward breadth only.
- **Areas outside `EXTENT_AREAS` score exactly as today.** The overall score, the Lighthouse ⅔/⅓ blend, the critical cap at 69 and the profile weights are unchanged.
- **`core/score.js` stays pure:** no DOM and no `chrome.*`.
- **Page functions** serialised via `fnSource` (plugin `collect`) must stay self-contained. They take shared code only through `pageDeps`.
- **Finding ids stay stable.** The new contrast finding keeps the id `contrast-pair`.
- **Wording** is plain, with counts first, for example "65 of 819 links (7.9%)".
- **Git:**
  - run `git add` and `git commit` as separate plain commands, with no `cd … &&` (a guard rejects compound git commands);
  - end each commit message with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Dependencies:** run `npm install --no-package-lock` if `node_modules` is missing.
- **Never run e2e and calibration at the same time.**

## Review Focus

1. **Saved readings re-analysed.** Their findings have no `count` or `of`, so Accessibility scores by breadth only and every number in the table is finite. Pinned in Task 1: "findings without counts".
2. **Bad field values from JSON**, such as a string, 0, a negative, NaN, a fraction, or `of` below `count`, never produce NaN or a share above 1. Pinned in Task 1: "invalid fields ignored", "of raised to count".
3. **The table must add up.** `100 − Σ footer deductions`, rounded, equals the area's Findings input score on every fixture, including the extent cap (Σe > 0.25) and the per-severity caps. Pinned in Task 1: "scoreTable adds up".
4. **An area with only info findings, or no findings at all,** scores 100 with an empty table and no NaN. Pinned in Task 1.
5. **A page with no failing contrast** emits no `contrast-pair`. A page with more than 10 failing pairs emits one finding whose count covers every failing element, not just the listed 10. Pinned in Task 3.

---

### Task 1: The formula and the table, in `core/score.js`

**Files:**
- Modify: `extension/core/score.js`
- Modify: `docs/PLUGINS.md`:
  - in the finding-shape section, document `count`, `of` and `unit`;
  - in `## Scores`, describe the formula, with the constants above and the 60% / 40-point split.
- Test: `test/score.test.mjs`

**Interfaces:**
- Produces, all exported from `extension/core/score.js`:
  - the constants listed in Global Constraints.
  - `extentOf(finding) -> { count, of, unit } | null`:
    - returns null when `count` is invalid;
    - `of` is null when invalid, otherwise `max(of, count)`;
    - `unit` is a string or null.
  - Each deduction in an extent area becomes `{ finding, points, count, of, unit, share, breadth, extent }`:
    - `points` = `DEDUCT[sev]`, unchanged, because existing callers filter on it;
    - `share` = `n / (max(N,n) + EXTENT_SMOOTH)`, or null;
    - `breadth` = `BREADTH_SHARE × DEDUCT[sev]`;
    - `extent` = `EXTENT_MAX × EXTENT_WEIGHT[sev] × share / EXTENT_FULL`, before the cap, or 0.
  - Each extent area gains:
    - `breadth`: points after the caps and the 0.6 scaling;
    - `extent`: points, `EXTENT_MAX × min(1, Σe / EXTENT_FULL)`;
    - `extentSum`: Σe;
    - `bySeverity: { high: { findings, raw, capped }, medium…, low… }`.

    Areas outside the list gain only `bySeverity`. Their deductions keep today's shape.
  - `scoreTable(area) -> { extent: boolean, rows, footer, score }`:
    - `rows`: `[{ title, severity, affected, breadth, extent, points }]`. `affected` is a string like `'65 of 819 links (7.9%)'`, `'12 images'` (count only), or `''`. `breadth` and `extent` are numbers rounded to one decimal. For non-extent areas only `points` is set.
    - `footer`: `[{ label, value }]` in this order:
      1. one row per severity that has findings, for example `{ label: 'Low · 17 findings', value: '−34, capped −15' }`, with ", capped …" only when the cap bites;
      2. for extent areas, `{ label: 'Breadth (scaled to 60%)', value: '−X' }`;
      3. for extent areas, `{ label: 'Extent 0.19 of 0.25', value: '−Y' }`;
      4. `{ label: 'Findings score', value: String(score) }`.
    - `score` is the area's Findings input score.
  - `scoreRule() -> string`: the explanatory sentence, built from `DEDUCT`, `CAP`, `BREADTH_SHARE` and `EXTENT_MAX`.
    - With the extent part: `"Breadth: each finding deducts high 15, medium 6, low 2 (capped at 55, 30 and 15 per severity), scaled to 60%. Extent: up to 40 more for the share of elements affected."`
    - `scoreRule({ extent: false })` returns `"Each finding deducts high 15, medium 6, low 2, info 0 — capped at 55, 30 and 15 per severity."`

- [ ] **Step 1: Write the failing tests** in `test/score.test.mjs`, using the existing `f`, `reading` and `ok` helpers. Give a finding its fields with `{ ...f('high','accessibility'), count, of, unit }`.

  | Test | Input | Assertions |
  |---|---|---|
  | `extent formula` | one high finding, count 65, of 819 | `share` = 65/829. `breadth` = 9. `extent` ≈ 40×(65/829)/0.25 = 12.545. Area Findings score = `round(100 − 9 − 12.545)` = 78. |
  | `smoothing: 1 of 1` | — | `share` = 1/11 |
  | `extent capped at 40` | 3 high findings, each 500 of 500 | `area.extent === 40`; score = `round(100 − 0.6×45 − 40)` = 33 |
  | `invalid fields ignored` | `count` = `'65'`, 0, −1, NaN, 1.5 | `extentOf` returns null. With a valid count, the same invalid `of` values give `of: null` and `share: null`. |
  | `of raised to count` | count 10, of 4 | `of` = 10, `share` = 10/20 |
  | `info contributes nothing` | info finding, 100 of 100 | `extent` 0, score 100 |
  | `findings without counts` | 2 high findings with no fields | score = `round(100 − 0.6×30)` = 82; `area.extent === 0` |
  | `non-extent area unchanged` | copy an existing multi-severity performance fixture from this file | score equals today's value (assert the literal); deductions have no `share` key |
  | `scoreTable adds up` | (a) the extent-capped case; (b) a case with low findings over the cap (17 low with counts); (c) a performance area | footer's last value equals `String(area.inputs[0].score)`. For (a) and (b): `Math.abs(100 − breadth − extent − score) <= 1`, parsed from the footer. (b) shows `'−34, capped −15'`. |
  | `scoreRule text` | — | equals both literal strings above. The text contains `55` and not `60`. |

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `node --test test/score.test.mjs`. Expected: the new tests fail (the exports are missing). The existing tests pass.

- [ ] **Step 3: Implement it in `extension/core/score.js`.**
  - Compute the per-severity cap totals once, into `bySeverity`.
  - For an extent area: `fromFindings = clamp(round(100 − BREADTH_SHARE × Σcapped − extent), 0, 100)`.
  - For other areas, keep today's expression exactly.
  - Format the `affected` percentage as one decimal under 10% and whole numbers at 10% and above, for example `7.9%` and `15%`. Use `toLocaleString('en-US')` for counts.

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `node --test test/score.test.mjs`, then `npm test`. Expected: all pass. Report any changed snapshot in another file. Only Accessibility numbers may move.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/core/score.js test/score.test.mjs docs/PLUGINS.md
  git commit -m "Scoring: Accessibility counts how much of the page a finding affects (breadth 60% + extent up to 40)"
  ```

### Task 2: The report's scoring details

**Files:**
- Modify: `extension/ui/report.js`, in `scoringDetails(a)` (around line 195).
- Test: `test/report.test.mjs`

**Interfaces:**
- Consumes `scoreTable(area)` and `scoreRule({ extent })` from Task 1.

- [ ] **Step 1: Write the failing tests** in `test/report.test.mjs`.
  - Render a reading whose axe result has one high finding with count 65, of 819, unit `'links'`.
  - The Accessibility `details.scoring` contains:
    - `Affected`, `Breadth` and `Extent` column headers;
    - `65 of 819 links (7.9%)`;
    - `−9`;
    - `Findings score`;
    - `capped at 55, 30 and 15`.
  - It does not contain `capped at 60`.
  - A performance area's details contain a `Points` column and the per-severity footer row, but no `Extent` column.
  - `standaloneDocument` of the same reading contains `65 of 819 links (7.9%)`.

- [ ] **Step 2: Run** `node --test test/report.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** In `scoringDetails`:
  - the paragraph becomes `scoreRule({ extent: t.extent })`, followed by the existing blend sentence;
  - the rows render `rows` with these columns:
    - Finding · Severity · Affected · Breadth · Extent when `t.extent`, with numbers shown as `−9` and `−12.5`, and `''` when the extent is 0;
    - otherwise Finding · Severity · Points;
  - the footer renders as a second `h.table` of Label · Value under the rows.

  Keep the existing filter so zero-point rows stay hidden.

- [ ] **Step 4: Run** `node --test test/report.test.mjs`, then `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/ui/report.js test/report.test.mjs
  git commit -m "Report: the scoring table adds up to the score (Affected, Breadth, Extent columns, cap footer); cap text from CAP"
  ```

### Task 3: One contrast finding

**Files:**
- Modify: `extension/plugins/contrast.js` (lines 122–132)
- Modify: `extension/core/a11y-overlap.js`: remove the `contrast:contrast-more` row (line 102) and keep the `contrast:contrast-pair` row.
- Modify: `extension/core/a11y-reference.js`:
  - remove the `contrast-more` entry;
  - reword the `contrast-pair` entry for many pairs if its text says "pair" in the singular.
- Test: `test/contrast.test.mjs`. Also update `test/a11y-overlap.test.mjs` and `test/a11y-reference.test.mjs` if they list every id.

**Interfaces:**
- Produces one finding:
  - `{ id: 'contrast-pair', severity, category: 'accessibility', title, detail, evidence, count, of, unit: 'text elements' }`;
  - `count` = `totals.failing`, the failing elements across **all** failing pairs;
  - `of` = `totals.checked`;
  - `severity` = `'medium'` if any failing pair grades medium under the existing `severity(p)` rule, else `'low'`.
- `title`: `` `${num(failing)} text ${failing === 1 ? 'element fails' : 'elements fail'} contrast (${pairs} colour ${pairs === 1 ? 'pair' : 'pairs'})` ``
- `detail`: the worst 3 pairs, as `#777777 on #ffffff 3.2:1 (12 elements)`, joined by `; `.
- `evidence`: the sample selectors of the worst 10 pairs, one per line. The a11y map places marks from these selectors, so they must stay selectors.
- `contrast-more` is no longer emitted.

- [ ] **Step 1: Write the failing tests** in `test/contrast.test.mjs`, using the existing `analyzeContrast` fixture style.

  | Case | Expected |
  |---|---|
  | 12 failing pairs, 3 elements each, 100 checked | exactly one `contrast-pair` (none with id `contrast-more`); title `36 text elements fail contrast (12 colour pairs)`; `count` 36, `of` 100; one medium pair makes the severity medium |
  | 1 failing pair on 1 element | title `1 text element fails contrast (1 colour pair)`; severity low |
  | no failing pairs | no `contrast-pair` |

  Update existing tests that expected one finding per pair.

- [ ] **Step 2: Run** `node --test test/contrast.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** in `analyzeContrast`, then update the overlap and reference rows.

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/contrast.js extension/core/a11y-overlap.js extension/core/a11y-reference.js test/
  git commit -m "Contrast: one finding for all failing text (count of checked), not one per colour pair"
  ```

### Task 4: Populations, and the fields on axe and a11y-basics findings

**Files:**
- Create: `extension/core/extent.js` (pure)
- Modify: `extension/plugins/axe.js`:
  - `collect` adds `population`;
  - `run` sets the fields;
  - the default export adds `after: ['contrast']`.
- Modify: `extension/plugins/a11y-basics.js`:
  - `flag()` rules get `page: true` in `collect`;
  - `run` sets the fields.
- Test: create `test/extent.test.mjs`; modify `test/plugins.test.mjs`, or the axe and a11y-basics tests wherever they live (grep for `axe.run(` and `a11y-basics`).

**Interfaces:**
- Produces, in `extension/core/extent.js`:
  - `PAGE_LEVEL: Set<string>`. Seed it with the research list:
    - `kb-no-skip-link`, `kb-skip-target`, `kb-trap`, `kb-banner-trap`, `kb-banner-modal`, `kb-banner-unreachable`, `kb-confined`, `kb-stopped`;
    - `no-main`, `multiple-main`, `banner-multiple`, `contentinfo-multiple`, `nav-indistinct`, `aside-indistinct`, `no-current`, `reset-button`, `focus-none`;
    - `reflow-scroll`, `spacing-scroll`, `text200-ignored`, `text200-scroll`, `morecontrast-none`, `dark-none`, `views-unverified`;
    - `landmark-one-main`, `page-has-heading-one`, `landmark-no-duplicate-banner`, `landmark-no-duplicate-contentinfo`, `landmark-no-duplicate-main`, `landmark-unique`, `bypass`, `document-title`, `html-has-lang`, `html-lang-valid`, `meta-viewport`, `meta-viewport-large`, `meta-refresh`, `skip-link`, `region`.
  - `populationFor(id, pop) -> { of, unit } | null`, where `pop = { links, images, fields, buttons, focusables, text, headings }` (numbers or undefined).
    - Returns null for `PAGE_LEVEL` ids and for `possible-heading`, `possible-list`, `layout-table` and `forced-icons`.
    - Otherwise it applies the first rule that matches:

      | id matches | population | unit |
      |---|---|---|
      | `/(^|-)link(s|-|$)\|multi-text\|broken-anchor/` | `links` | `'links'` |
      | `/alt\|image\|img\|svg\|object-alt\|no-name/`, not starting `kb-` | `images` | `'images'` |
      | `/contrast\|small-text\|tiny-text\|justified\|underline/` | `text` | `'text elements'` |
      | `/heading/` | `headings` | `'headings'` |
      | `/label\|autocomplete\|select-name\|form/`, but not `label-in-name` or `label-content` | `fields` | `'form fields'` |
      | `/button/` | `buttons` | `'buttons'` |
      | anything else | `focusables` | `'focusable elements'` |

    - When the chosen population is not a positive integer, it falls back to `focusables`, with `unit: 'focusable elements'`. If that is missing too, it returns `{ of: null, unit }` with the first unit.
  - `withExtent(finding, count, popResult) -> finding`:
    - adds `count`;
    - adds `of` and `unit` when given;
    - leaves the finding unchanged when `count` is not a positive integer.
- In `axe.js`:
  - `collect` returns `population: { links, images, fields, buttons, focusables }`;
  - the selectors are those of a11y-basics' stats: `a[href]`, `img`, `input, select, textarea`, `button, [role="button"]`;
  - focusables uses `a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex="-1"])`;
  - `run` passes `{ ...c.population, text: ctx.results?.contrast?.data?.totals?.checked }`;
  - violations get `count = v.nodes` unless the id is in `PAGE_LEVEL`;
  - incomplete (`review:`) findings get no fields.
- In `a11y-basics`:
  - findings get `count = r.count` unless `r.page` or the id is in `PAGE_LEVEL`;
  - `pop` comes from `c.stats` (`links`, `images`, `formFields` → `fields`, `buttons`) plus `focusables: ctx.results?.['a11y-structure']?.data?.focusableCount`, when present.

- [ ] **Step 1: Write the failing tests.**
  - `test/extent.test.mjs`:
    - `populationFor('link-name', { links: 819 })` → `{ of: 819, unit: 'links' }`;
    - `'image-alt'` → images;
    - `'label'` → form fields;
    - `'label-in-name'` → focusables;
    - `'color-contrast'` with `{ text: 300 }` → text elements;
    - `'landmark-one-main'` → null;
    - `'possible-heading'` → null;
    - `'link-name'` with `{ focusables: 50 }` and no links → `{ of: 50, unit: 'focusable elements' }`;
    - `withExtent(f, '3', …)` returns `f` unchanged.
  - axe `run`:
    - a violation `link-name` with 65 nodes and `population.links` 819 → `count` 65, `of` 819, `unit` 'links';
    - a `landmark-one-main` violation has no `count` key;
    - a `review:` finding has no `count`.
  - a11y-basics `run`:
    - a `check` rule with count 4 and `stats.images` 20 → `count` 4, `of` 20;
    - a `page: true` rule → no `count`.

- [ ] **Step 2: Run** `node --test test/extent.test.mjs`, plus the plugin test files. Expected: FAIL.

- [ ] **Step 3: Implement** as specified. In `axe.js`, keep the population counting inside `collect`: it is a page function and must be self-contained.

- [ ] **Step 4: Run** `npm test`. Expected: PASS. Check that no `after` cycle exists: `contrast` has no `after`.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/core/extent.js extension/plugins/axe.js extension/plugins/a11y-basics.js test/
  git commit -m "axe and basic checks: each finding says how many elements it affects, out of which population"
  ```

### Task 5: The fields on a11y-structure, keyboard and a11y-map findings

**Files:**
- Modify: `extension/plugins/a11y-structure.js`:
  - `analyzeStructure` takes `pop`;
  - `add()` takes an optional count;
  - the default export's `after` becomes `['axe', 'a11y-basics', 'contrast']`.
- Modify: `extension/core/keyboard.js`, in `analyzeKeyboard`.
- Modify: `extension/plugins/a11y-map.js`, in `analyzeMap`'s `add()`.
- Test: `test/a11y-structure.test.mjs`, `test/keyboard.test.mjs`, `test/a11y-map.test.mjs`

**Interfaces:**
- Consumes `populationFor`, `withExtent` and `PAGE_LEVEL` from Task 4.
- **a11y-structure:**
  - `analyzeStructure(c, { …, pop })`;
  - `run` builds `pop`:
    - `links`, `images`, `fields` and `buttons` from `ctx.results['a11y-basics']?.data?.stats`;
    - `focusables: c.focusableCount`;
    - `headings: (c.headings || []).length`;
    - `text: ctx.results.contrast?.data?.totals?.checked`;
  - each bag finding gets `count = n(bag)`, as do `headings-skipped` (`skipped`) and `headings-empty` (`empty`);
  - `possible-heading` and `possible-list` get a count but no `of`, because `populationFor` returns null and `withExtent` then adds the count only;
  - `PAGE_LEVEL` ids get nothing.
- **keyboard (`analyzeKeyboard`):**
  - `of = uniq.length + bannerStops.length`;
  - `unit: 'keyboard stops'`;
  - these findings set `count` to the length of their own list:

    | Finding | Count |
    |---|---|
    | `kb-hidden` | hidden stops |
    | `kb-no-name` | stops with no name |
    | `kb-no-focus-style` | stops with no visible focus |
    | `kb-positive-tabindex` | `positive.size` |
    | `kb-jumps` | jumps |
    | `kb-obscured` | obscured stops |
    | `kb-obscured-unsure` | unsure stops |
    | `kb-focus-lost` | `lost` |

  - `kb-clickable` gets `count` but no `of`; its `unit` is `'clickable elements'`;
  - the page-level kb findings get nothing.
- **a11y-map:**
  - `add(id, severity, title, list)` sets `count = list.length`;
  - `of` = `images.length` with `unit: 'images'`, when the list holds images;
  - for a non-image list, use `populationFor(id, pop)`.

- [ ] **Step 1: Write the failing tests.**
  - structure: `analyzeStructure` with `vagueLinks` count 5 and `pop.links` 200 → the `vague-link` finding has `count` 5, `of` 200, `unit` 'links'. `possible-heading` has a `count` but no `of`. `no-main` has no `count`.
  - keyboard: a walk with 10 unique stops, 2 banner stops and 3 stops with no focus style → `kb-no-focus-style` has `count` 3, `of` 12, `unit` 'keyboard stops'. `kb-no-skip-link` has no `count`.
  - map: 4 images with unhelpful alt verdicts out of 30 images → that finding has `count` 4, `of` 30, `unit` 'images'.

- [ ] **Step 2: Run** the three test files. Expected: FAIL.

- [ ] **Step 3: Implement** as specified.

- [ ] **Step 4: Run** `npm test`, then `npm run test:e2e`, with no other Chromium job running. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/a11y-structure.js extension/core/keyboard.js extension/plugins/a11y-map.js test/
  git commit -m "Structure, keyboard walk and page map findings say how many elements they affect"
  ```

### Controller step after the final review: real-site calibration (not a subagent task)

1. Run `node scripts/calibrate.mjs`, then `node scripts/calibrate.mjs --a11y`.
2. Compare each Accessibility score with the spec's expected table (±5).
3. Hard checks:
   - GDS is the lowest;
   - Wikipedia is above asahi;
   - gov.uk is in the top two;
   - no other area's score moves, except through C3.
4. Record the before and after scores in the `har-plus-calibration` memory.
5. Add a follow-up note: grouping the links plugin's broken-link findings, which is out of scope.
