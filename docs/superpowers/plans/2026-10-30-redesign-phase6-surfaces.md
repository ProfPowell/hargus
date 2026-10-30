# Report redesign, phase 6: other surfaces, polish and after shots — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every surface uses only the redesign's tokens and components:
- popup, progress tab, library and options;
- the Network and Screens panes;
- the export.

Phase 1 set up old token names as aliases; they are retired. The polish left over from phases 1–4 is done. The final after shots go in `screens/after/`.

**Architecture:**
- **Tokens:** rename every old token use to its new name, then delete the alias block. The existing "every var is declared" test guards the rename.
- **Surfaces:** small markup changes in `library.js`, `popup.html`, `progress-view.js` and `report.js` (Network and Screens pane heads) swap colour-only marks for `h.sev` or `h.status`, and switch the default disclosure markers to the `.disclosure` look.
- **Export:** `standaloneDocument` inlines the two Instrument Sans files as `data:` URLs, so the export renders in its real font.

**Tech Stack:** plain ES modules, CSS `@layer` and `light-dark()`, `node --test`, and Playwright e2e (`npm run test:e2e`, run from the worktree directory).

**Spec:** `docs/superpowers/specs/2026-10-28-report-redesign-design.md`, sections F ("Existing tokens that are no longer used are removed"), G and H.6.

**Design reference:** `docs/design/2026-10-28-proposed.css`

## Global Constraints

- **Rendering only.** Scores and findings don't change.
- **No layout changes to popup, progress, library, options, Network or Screens** (spec G). They only take the tokens and components.
- **The standalone export contains no `<script>`.** Print opens every `<details>`.
- **No colour without a word or glyph.**
- **WCAG 2.2 AA** at 1280 and 390 px, light and dark. The popup is 360 px wide.
- **`theme.css` layers and syntax.** It keeps `@layer reset, tokens, base, components, pages;` and contains no `<` outside comments: the export escapes it, so use `min-width`/`max-width`.
- **Interpolation.** Every interpolated value goes through `html```; `raw()` is only for constant markup.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Rulings made while planning

1. **Token rename map** (phase 1's alias table, reversed):

   | Old token | New token |
   |---|---|
   | `--panel` | `--surface` |
   | `--panel-2` | `--surface-sunk` |
   | `--text`, `--primary` | `--ink` |
   | `--muted` | `--ink-2` |
   | `--high`, `--medium`, `--low`, `--info` | `--sev-…` |
   | `--ok`, `--ink-good` | `--band-good` |
   | `--ink-warning`, `--amber` | `--band-fair` |
   | `--ink-serious`, `--ink-critical` | `--band-poor` |
   | `--track` | `--line` |
   | `--font` | `--font-sans` |
   | `--mono` | `--font-mono` |
   | `--radius` | `--r-1` |
   | `--radius-lg` | `--r-2` |

   - **`--st-*` stays.** It is the ring's status-keyed indirection, used from JS as `var(--st-${status})`.
   - **These also stay:** `--primary-ink`, `--accent-hover`, `--segment`, `--gap`, `--c*`, `--ph-*`, `--pm-*` and `--mark-*`.
   - **The unlayered body rule** (`body { font-family: var(--font); … }`) becomes `var(--font-sans)`.
   - **After the rename,** delete the alias declarations whose names no longer appear anywhere.
2. **Orphan CSS to delete:**
   - `ul.chart.checklist` and its children;
   - the legacy `.sev:not([data-sev])` and `.sev-high/-medium/-low/-info` rules;
   - `.status-dot` and `status-<state>` rules once nothing emits them;
   - anything else that the grep in Task 1 Step 1 shows unused.
3. **`h.sev` level mapping.** `h.sev('critical')` maps to high and `h.sev('serious')` to medium. Any other unknown level is info, as now.
4. **Library card** (`library.js`):
   - The severity counts become `h.sev(level, { word: false, sr: '<n> <level>' })` followed by the visible count. The count is part of the same chip, so it reads "6 high" to a screen reader.
   - Below the ring sits the grade plus the verdict word, small, e.g. "C+ · needs work". This follows the rule that a ring is always shown beside its grade word.
5. **Popup** (`popup.html`): the Capture options and Plugins `<details>` take `class="disclosure"`, with a `.disclosure-body` wrapper around their contents. Their summaries keep their text and the plugin count.
6. **Progress tab** (`progress-view.js`):
   - The running dot becomes `h.status('none', '')` styled as the accent spinner dot, with `.sr-only` "running".
   - Each finished row's icon carries `.sr-only` text: "done", "failed" or "skipped".
7. **Network and Screens panes:**
   - Their `header.pane-head` takes the same `h1` and tools styling as the Issues pane.
   - The Network detail tabs, sort buttons and filters use the button and field styles from proposed.css ("buttons + fields").
   - No layout changes.
8. **App bar at ≤ 560 px** (reading and export):
   - The `.appbar-title` hides; the hero already shows the title.
   - The buttons shrink to a compact padding so Re-run, Help, Export and Delete fit on one row at 390 px.
   - If they still don't fit, "Re-run analysis" shows as "Re-run", with the full name kept in `aria-label`.
9. **Help backdrop.** It becomes `light-dark(rgb(0 0 0 / 0.45), rgb(0 0 0 / 0.7))`, plus a `--line-strong` border on `.help`, so the overlay stands out in dark mode.
10. **Export font.**
    - `standaloneDocument` rewrites each `url("fonts/instrument-sans-latin(-ext)-wght.woff2")` in the CSS to a base64 `data:font/woff2` URL. This adds about 55 KB.
    - IBM Plex Mono is not inlined; it falls back to the system monospace.
    - The fonts are read where the CSS is fetched (`reading.js` ~693), then passed to `standaloneDocument` as a map `{ 'fonts/…woff2': base64 }`. `standaloneDocument` stays a pure function.
11. **After shots.** `node scripts/screens.mjs --out screens/after` writes the final set beside the before set. It is committed. `--out` only deletes files the script generated.

## Review Focus

1. **A token used only in JS or plugin markup** (e.g. `var(--muted)` inside a plugin's `h.html`) is renamed too, so no colour goes transparent. Pinned in Task 1: the undeclared-var test, plus a new test that none of the retired names appears.
2. **Dark mode** on the popup, library and options. Contrast holds in light and dark; Task 4 extends the e2e contrast check to these pages.
3. **Popup at 360 px.** The disclosures open and close with the keyboard, and nothing overflows. Pinned in Task 4.
4. **A library with a reading that has no scores** (an import, still pending). The card shows no ring, no grade and no chips, and it doesn't throw. Pinned in Task 2.
5. **An export opened offline.** The font comes from the `data:` URL and no request leaves the file. Pinned in Task 3, by checking that no `url(` in the export CSS points anywhere but `data:`.

---

### Task 1: Retire the old token names and orphan CSS

**Files:**
- Modify: `extension/ui/theme.css`, all JS under `extension/ui/` and `extension/plugins/`, and `extension/ui/charts.js` (the `h.sev` mapping)
- Test: `test/tokens.test.mjs`, `test/charts.test.mjs`

- [ ] **Step 1: List the uses, and write the failing tests**

  Grep every retired name in ruling 1 across `extension/`. Then add these tests:

  ```js
  test('retired token names are gone everywhere', () => {
    const retired = ['panel', 'panel-2', 'text', 'primary', 'muted', 'high', 'medium', 'low', 'info', 'ok', 'ink-good', 'ink-warning', 'amber', 'ink-serious', 'ink-critical', 'track', 'font', 'mono', 'radius', 'radius-lg'];
    for (const f of uiAndPluginFiles) for (const t of retired) assert.ok(!new RegExp(`var\\(--${t}\\)|--${t}:`).test(read(f)), `${t} in ${f}`);
  });
  test('h.sev maps critical → high and serious → medium', () => {
    assert.match(String(h.sev('critical')), /data-sev="high"/); assert.match(String(h.sev('serious')), /data-sev="medium"/);
  });
  ```

  The `--primary` check must not match `--primary-ink`; the regex above only matches the exact name.

- [ ] **Step 2: Run the tests and check that they fail**

  Run `node --test test/tokens.test.mjs test/charts.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Rename, delete the aliases, delete the orphan CSS, and map the severities**

  - Rename uses per ruling 1.
  - Delete the aliases.
  - Delete the orphan CSS per ruling 2, but only rules that no markup or JS emits.
  - Add the `h.sev` mapping per ruling 3.
  - Visual output must stay identical: each alias pointed straight at its new token.

- [ ] **Step 4: Run the tests and check that they pass**

  Run `npm test`. Expected: all pass, including the undeclared-var and contrast tests.

- [ ] **Step 5: Commit**

  Message: "Retire the old token names and orphan CSS; h.sev maps critical/serious".

---

### Task 2: Library, popup, progress and options

**Files:**
- Modify: `extension/ui/library.js` (card ~21–22), `extension/ui/popup.html` (~29–74), `extension/ui/progress-view.js` (~10–15), `extension/ui/options.html` (only if it uses default `<details>` markers or colour-only marks), and `extension/ui/theme.css` (`@layer pages` popup and library sections)
- Test: `test/progress.test.mjs` (or wherever the progress view is tested), and a new `test/library.test.mjs` if the card render can be imported. If it can't, factor out `cardHtml(reading, scores)` and test that.

**Interfaces:** consumes `h.sev(level, { word: false, sr })`, `h.status` and `VERDICT`/`grade` from `score.js`.

- [ ] **Step 1: Write the failing tests**

  ```js
  test('library card: severity chips carry a glyph and an sr word; ring has its grade word; no scores → no ring/chips', () => {});
  test('progress rows: running has sr "running"; done/failed/skipped icons carry sr words', () => {});
  ```

- [ ] **Step 2: Run the tests and check that they fail**

  Run `node --test` on the new or changed test files. Expected: FAIL.

- [ ] **Step 3: Implement rulings 4–6**

  Options only takes the token rename (Task 1) and the field styles. Change its markup only where it shows a colour-only mark or a default disclosure marker.

- [ ] **Step 4: Run the tests and check that they pass**

  Run `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

  Message: "Library, popup, progress: glyph and word marks, disclosure look".

---

### Task 3: Network and Screens panes, the app bar, Help backdrop, export font

**Files:**
- Modify: `extension/ui/report.js` (`networkPane`, `screensPane`, `standaloneDocument` ~1020), `extension/ui/reading.js` (export at ~693: read the font files), `extension/ui/reading.html` (app bar button labels if ruling 8 needs them), and `extension/ui/theme.css`
- Test: `test/report.test.mjs`

**Interfaces:** `standaloneDocument(reading, plugins, { css, scores, settings, fonts })`, where `fonts` is `{ [relativeUrl]: base64 }`.

- [ ] **Step 1: Write the failing tests**

  ```js
  test('export inlines Instrument Sans as data: URLs and no url() points off-file', () => {
    const doc = standaloneDocument(reading, plugins, { css: 'x{src:url("fonts/instrument-sans-latin-wght.woff2")}', fonts: { 'fonts/instrument-sans-latin-wght.woff2': 'AAAA' } });
    assert.match(doc, /url\("?data:font\/woff2;base64,AAAA"?\)/); assert.ok(!/url\("?fonts\//.test(doc));
  });
  test('app bar: compact at narrow widths (CSS rule present, max-width query)', () => {});
  test('help backdrop is darker in dark mode', () => {});
  ```

- [ ] **Step 2: Run the tests and check that they fail**

  Run `node --test test/report.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement rulings 7–10**

  Any `fonts/` URL that has no entry in the map (IBM Plex Mono) is dropped from the export CSS. Remove its whole `@font-face` block, so the export makes no request.

- [ ] **Step 4: Run the tests and check that they pass**

  Run `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

  Message: "Network and Screens pane heads, compact app bar, darker Help backdrop, export carries its font".

---

### Task 4: e2e, the look, and the after shots

**Files:**
- Modify: `test/e2e/run.mjs`, `scripts/screens.mjs` (manifest wording), and `extension/ui/theme.css` (fixes found here)
- Create: `screens/after/` (generated)

- [ ] **Step 1: Extend the e2e tests**

  1. **Contrast.** Extend the automated contrast check to the popup, library and options pages, in light and dark.
  2. **Popup.** At 360 px, the Capture options and Plugins disclosures open with Enter/Space, and `scrollWidth <= 360`.
  3. **App bar.** At 390 px, the reading app bar is one row: its height is under 64 px, and all four buttons are visible.
  4. **Export.** The exported file's CSS has no `url(` that isn't `data:`, and the computed `font-family` of `body` resolves to Instrument Sans (`document.fonts.check('13px "Instrument Sans"')`).

- [ ] **Step 2: Run the suites, then look**

  Run these one at a time, never together:
  1. `npm test`
  2. `npm run test:e2e`, from the worktree directory
  3. `node scripts/screens.mjs --out test/e2e/out/screens-phase6`

  Look at every shot. Fix anything broken in `theme.css`. In particular, compare the popup, progress, library, options, Network and Screens against the phase 4 shots: they should be the same layout in the new look.

- [ ] **Step 3: Capture and commit the after set**

  Run `node scripts/screens.mjs --out screens/after`, after everything else passes. Check that `screens/after/manifest.json` lists every shot.

  Then:

  ```bash
  git add screens/after
  git commit -m "screens/after: the redesign's after shots"
  ```

- [ ] **Step 4: Commit any fixes**

  Message: "e2e for the remaining surfaces; visual fixes".
