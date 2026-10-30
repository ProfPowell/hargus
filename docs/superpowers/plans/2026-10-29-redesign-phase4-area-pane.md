# Report redesign, phase 4: the area pane template — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every one of the 8 area panes has the same five sections, reached by a jump bar:
1. a header with the score and a summary sentence;
2. **Checks**, one row per plugin, bridging the score to its issues;
3. **Issues**;
4. **Measurements**;
5. **Plugin data**, closed.

**Architecture:**
- A new pure module, `extension/core/area.js`, works out the Checks rows and the header sentence from the reading, the plugins and the issue list.
- `areaPane` in `extension/ui/report.js` is rebuilt from these, using phase 1–3 helpers and patterns: `section.panel`, `h.status`, `h.sev`, `issuesList`, `h.stats` and `h.more`.

**Tech Stack:** plain ES modules, CSS `@layer` and `light-dark()`, `node --test`, and Playwright e2e (`npm run test:e2e`, run from the worktree directory).

**Spec:** `docs/superpowers/specs/2026-10-28-report-redesign-design.md`, section C (area pane) and H.4.

**Design references:**
- Board 3, "Area pane: Accessibility · 1280", in `docs/design/2026-10-28-report-redesign.html`. Its extracted text is reproduced in the spec's section C.
- `docs/design/2026-10-28-proposed.css`, the "page header + in-page nav" and "panel" sections.

## Global Constraints

- Scores and findings are unchanged. This phase is rendering only.
- The standalone export has no `<script>`. The jump bar is plain anchors; disclosure is `<details>`.
- Print opens every `<details>`. The jump bar does not print.
- No new explanatory text. "How is this scored?" stays as it is today, a closed disclosure.
- The UI says "issue". Code and data keep `findings`.
- Every interpolated value goes through `html```; `raw()` only for constant markup.
- No colour without a word or glyph.
- WCAG 2.2 AA at 1280 and 390, in light and dark.
- `theme.css` keeps its `@layer` order and phase 1 tokens, and never contains `<` outside comments: the export escapes it, so use `min-width`/`max-width`.
- Existing anchors keep working:
  - `#area-<id>` (the pane);
  - `#p-<plugin id>` (a plugin's data);
  - `details.plugin` (tests and `scripts/screens.mjs` use it);
  - `a.more[data-area][href="#issues"]` (the viewer's filter link).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Rulings made while planning

1. **Which plugins get a row in Checks** (spec C).
   - A plugin gets a row when either:
     - its home area (`resultArea`) is this area; or
     - at least one of its issues is scored in this area (`issue.area === id`).
   - A row's issue counts cover only the issues scored in this area, so the rows add up to the area's issue count.
   - Home plugins that skipped or errored get a row.
   - Plugins that did not run stay in today's interactive-only "Not run" note under the table.
   - Row order: home plugins in plugin rank order, then visiting plugins by name.
2. **The Result word.**

   | Plugin status | Word | Band |
   |---|---|---|
   | error | "error" | poor |
   | skipped | "skipped" | none |
   | ok, with any high issue in this area | "failing" | poor |
   | ok, worst issue medium or low | "needs work" | fair |
   | ok, otherwise | "passing" | good |

   The word is drawn with `h.status(band, word)`. The band always agrees with the counts on the same row.
3. **The Reading column.**
   - For an `ok` plugin: the values of its `summary` items with `headline: true`, joined with " · ". If none has `headline`, use the first summary item's `label value`. If there is no summary, "—".
   - For a skipped or errored plugin: its `error` text, cut to 120 characters.
4. **The Issues column.** The non-zero counts as "6 high · 4 low · 7 info", linking to `#<area>-issues`, or "none" with no link.
5. **The Data column.** A link reading "Data", with `.sr-only` " for <plugin name>", to `#p-<plugin id>`. For a visiting plugin this goes to its own home area's pane, which is fine.
6. **The header sentence**, from `areaSummary(area, rows)`:
   - The counts: "6 high, 4 medium, 10 low and 14 info issues from 7 checks." Zero counts are dropped. "1 check" is singular. If there are no issues: "No issues from 7 checks."
   - Then, when some rows have a high or medium issue, "The biggest wins are in <A> and <B>." The rows are ranked by high count, then medium count. With only one such row: "The biggest win is in <A>."
   - An unmeasured area keeps today's sentence: "Not measured — no plugin in this area ran successfully."
7. **The header.** It holds:
   - the area ring (72 px);
   - `h1`: the area name, the grade, and the `VERDICT` word in the grade's band colour, with the word always shown;
   - the sentence;
   - `scoringDetails(a)`, unchanged.
8. **The jump bar.** `<nav class="jump" aria-label="<Area> sections">` with links to:
   - `#<id>-checks` "Checks N";
   - `#<id>-issues` "Issues N";
   - `#<id>-measurements` "Measurements";
   - `#<id>-data` "Plugin data N".

   The four sections carry these ids. They always render; an empty section shows one muted line. The existing `.pane:has(:target)` rule keeps the pane visible.
9. **Sections and headings.** Each section is `section.panel` with an `h2`. Issue group headings are `h3` (`issuesList(list, { showArea: false, level: 3 })`). Measurement panels and Plugin data summaries sit under the `h2`.
10. **The Issues section.**
    - It holds `issuesList(areaIssues, { showArea: false, level: 3 })`, with High and Medium open and Low and Info folded, as `issuesList` already does.
    - The footer link is `<a class="more" href="#issues" data-area="<id>">Open in Issues →</a>`. It always shows when there are issues; today it only shows over 8.
11. **The Measurements section.**
    - Each `ok` plugin with a `glance` gets its own `section.panel.measure` with an `h3` naming the plugin and the glance output as the body.
    - The rated `summary` tiles of plugins without a glance are gathered into one panel, "Key readings", as `h.stats`.
    - At ≥ 900 px there are two columns (`grid-template-columns: repeat(auto-fit, minmax(min(100%, 26rem), 1fr))`); below that, one column.
12. **The Plugin data section.** It holds one `details.plugin.disclosure` per home plugin that has a result (ok, skipped or error), in row order. A visiting plugin's panel stays in its home pane, and its row's Data link points there.
    - `id="p-<id>"` stays.
    - The summary holds the plugin name, its issue counts across all areas (as in today's `pluginPanel`), and the `h.status` result word for its home area.
    - The duration and contacted hosts move into the panel body's first line, `p.meta`.
    - The body is today's `renderResult` and Raw data.
    - It is closed by default, except `a11y-map`, which stays open with the Page map panel right after it, as today.

## Review Focus

1. **A plugin whose findings land in two areas** (Content's SEO findings scored in Content while it lives in Content, or `quality` findings in Build). Its row appears in both areas, with that area's counts, and the rows add up to each area's total. Pinned in Task 1.
2. **An area where every plugin skipped** (for example International on a page with no text). The header says "Not measured…", Checks lists the skipped rows with their reasons, and the other sections show their empty lines. Pinned in Tasks 1 and 2.
3. **Jump links to a section.** `#accessibility-measurements` shows the Accessibility pane scrolled to that section, with no script (export). Pinned in Task 3 (e2e).
4. **The table at 390 px.** The Checks table doesn't scroll sideways: it reflows like the Overview's Areas table, with explicit roles. Pinned in Task 3.
5. **The Page map still works.** It stays open and right after the Images panel, its markers still link, and the crops still render. The existing e2e checks pass. Pinned in Task 3.

---

### Task 1: `area.js`: the Checks rows and the header sentence

**Files:**
- Create: `extension/core/area.js`
- Test: `test/area.test.mjs` (new)

**Interfaces:**
- Consumes:
  - `resultArea` and `pluginArea` from `extension/core/score.js`;
  - `activeFindings` from `extension/core/supersede.js`;
  - the `Issue[]` from `allIssues(scores)`, where each issue has `area`, `plugin` and `severity`.
- Produces:
  - `areaChecks(areaId, reading, plugins, issues)`, which returns `Row[]`. A `Row` is `{ id, name, status, home: boolean, result, band, reading, counts: {high, medium, low, info}, total }`.
  - `areaSummary(area, rows)`, which returns a string. `area` is `scores.areas[id]`.

- [ ] **Step 1: Write the failing tests**

  ```js
  test('rows: home plugins (ok/skipped/error) plus visitors with issues here; counts sum to the area total', () => {
    // fixture: plugins a (home content, 2 content issues + 1 build issue), b (home content, skipped, error 'no page data'),
    // c (home build, 1 content issue)
    const rows = areaChecks('content', reading, plugins, issues);
    assert.deepEqual(rows.map((r) => [r.id, r.home, r.total]), [['a', true, 2], ['b', true, 0], ['c', false, 1]]);
    assert.equal(rows.reduce((n, r) => n + r.total, 0), issues.filter((i) => i.area === 'content').length);
  });
  test('result word agrees with the row', () => {
    // high → failing/poor; medium only → needs work/fair; info only → passing/good; skipped → skipped/none; error → error/poor
  });
  test('reading: headline values joined, else first item, else dash; skipped/error shows the reason (≤120 chars)', () => {});
  test('summary: counts, checks, biggest wins; singulars; nothing above zero; not measured', () => {
    assert.equal(areaSummary(a, rows), '6 high, 4 medium, 10 low and 14 info issues from 7 checks. The biggest wins are in axe-core audit and Contrast.');
    // "No issues from 3 checks." ; "… from 1 check." ; "The biggest win is in X." ; not measured → today's sentence
  });
  ```

- [ ] **Step 2: Run the tests and check that they fail**

  Run `node --test test/area.test.mjs`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement rulings 1–3 and 6**

- [ ] **Step 4: Run the tests and check that they pass**

  Run `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

  Message: "area: Checks rows and the area header sentence".

---

### Task 2: The area pane

**Files:**
- Modify: `extension/ui/report.js`:
  - `areaPane` (~462–484), rebuilt;
  - `areaSentence`, removed;
  - `glances`, replaced by `measurements`;
  - `pluginPanel`, updated to ruling 12.
- Modify: `extension/ui/theme.css`. Add the jump bar, the Checks table, the Measurements grid and `.plugin` panel restyle. Remove the `.area-head`, `.plugin-detail` and `.glance` rules that nothing uses any more.
- Test: `test/report.test.mjs`

**Interfaces:**
- Consumes:
  - `areaChecks` and `areaSummary` from Task 1;
  - `issuesList(list, { showArea, level })`;
  - `h.status`, `h.sev`, `h.stats`, `h.stat` and `h.ring`;
  - `scoringDetails`, `cropKit` and `pageMapPanel`, all existing.
- Produces this markup, in order:
  - the header;
  - `nav.jump`;
  - `section.panel#<id>-checks`, holding `h2` "Checks" and `table.checks` with columns Check, Result, Reading, Issues and Data, plus explicit table roles, as the Overview's Areas table has. The "Not run" note sits under it, interactive only;
  - `section.panel#<id>-issues`;
  - `section.panel#<id>-measurements`;
  - `section.panel#<id>-data`.

- [ ] **Step 1: Write the failing tests**

  ```js
  test('area pane: five parts in order, jump bar links resolve to section ids', () => {
    const pane = areaHtml('accessibility');
    const order = ['class="area-head', 'class="jump"', 'id="accessibility-checks"', 'id="accessibility-issues"', 'id="accessibility-measurements"', 'id="accessibility-data"'];
    assert.deepEqual(order.map((s) => pane.indexOf(s)).every((i, n, a) => i > -1 && (n === 0 || i > a[n - 1])), true);
    for (const s of ['checks', 'issues', 'measurements', 'data']) assert.match(pane, new RegExp(`href="#accessibility-${s}"`));
  });
  test('checks table: one row per Checks row, result word, counts link, data link, roles', () => {});
  test('issues: grouped with h3 headings, Open in Issues link always present when there are issues', () => {});
  test('measurements: one panel per glance, Key readings for rated summaries, empty line when none', () => {});
  test('plugin data: closed details.plugin with p-<id> for home plugins; a11y-map open with the page map after it', () => {});
  test('every area pane has the same five sections, even when nothing ran', () => {});
  test('export: no <script>; jump links are plain anchors', () => {});
  ```

- [ ] **Step 2: Run the tests and check that they fail**

  Run `node --test test/report.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement the pane and its CSS, following rulings 4, 5 and 7–12**

  - Hide the jump bar in print.
  - At ≤ ~560 px the Checks table reflows to one block per row: name and result on the first line, then the reading, then the issues and data links. Keep the table semantics with explicit roles. Write the media query with `max-width`.
  - The `h1` keeps the class `grade` for the grade.

- [ ] **Step 4: Run the tests and check that they pass**

  Run `npm test`. Expected: all pass. Update existing tests that asserted "Plugin detail", `area-head` or the old Issues card.

- [ ] **Step 5: Commit**

  Message: "Area pane: header, jump bar, Checks, Issues, Measurements, Plugin data".

---

### Task 3: e2e, screens and the look

**Files:**
- Modify: `test/e2e/run.mjs`
- Modify: `scripts/screens.mjs`. Update selectors and manifest wording for the area shots. Keep the "expanded" shots; they open `details.plugin`.
- Modify: `extension/ui/theme.css`, for any fixes found here.

- [ ] **Step 1: Update and extend the e2e tests**

  - Existing assertions that used the old area markup move to the new markup.
  - The Page map checks still pass, unchanged in substance.
  - Add a check: on `#area-accessibility`, the Checks rows' issue totals add up to the sidebar's Accessibility count.
  - Add a check: `#accessibility-measurements` shows the pane, and the section's top is within 100 px of the viewport top.
  - Add a check: the "Open in Issues" link sets the Area filter.
  - Add a check: at 390 px wide, `scrollWidth <= 390` on `#area-accessibility` and `#area-content`.
  - Add a check: in the exported file, `#content-data` shows the Content pane with no script.
  - Extend the phase 3 contrast check to the Checks table cells and the area header sentence, in light and dark.

- [ ] **Step 2: Run the suites, then capture and look**

  Run each of these on its own, never two at once:
  1. `npm test`
  2. `npm run test:e2e`, from the worktree directory
  3. `node scripts/screens.mjs --out test/e2e/out/screens-phase4`

  Read these shots:
  - all 8 area panes at 1280;
  - accessibility and content, expanded;
  - the narrow accessibility pane;
  - a dark area pane;
  - the export area pane.

  Fix anything that breaks spec C's layout. Watch especially for:
  - a cramped Checks table;
  - glance panels overflowing their grid cell;
  - the Page map losing its width;
  - a status word without its glyph.

- [ ] **Step 3: Commit**

  Message: "e2e and screens for the area pane; visual fixes".
