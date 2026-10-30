# Report redesign, phase 5: plugin panels — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every one of the 37 plugins follows the spec's panel rules (section F):
- it leads with its answer;
- long lists fold;
- URLs show as host, path and query;
- findings that are about specific URLs or elements carry `places`;
- each plugin has a clear headline for the area's Checks table.

**Architecture:**
- **Foundation (Task 1).** One task puts the cross-cutting parts where every plugin gets them for free:
  - a fold in `h.table`/`h.list`;
  - URL parts in `h.link`;
  - a labelled Reading in `area.js`;
  - Markdown hardening for places;
  - a score-check script that proves a batch changed no scores.
- **Per-area batches (Tasks 2–9).** These do the plugin-by-plugin work. Each batch is checked against a baseline taken before any change.

**Tech Stack:** plain ES modules, `node --test`, the HARgus CLI's in-process plugin runner (`extension/core/plugin-host.js` `runPlugins`, `extension/plugins/index.js` `getPlugins`), and Playwright e2e (`npm run test:e2e`, run from the worktree directory).

**Spec:** `docs/superpowers/specs/2026-10-28-report-redesign-design.md`, section F ("Rules for plugin panels"), section D ("Places") and H.5.

## Global Constraints

- **Scores unchanged.** For the same HAR, scores are identical. Findings are identical except for the added `places`, and `evidence` stays on every finding. Every batch proves this with `scripts/score-check.mjs` against the baseline taken in Task 1.
- **Panel rules (spec F), applied to each plugin's `render()` and `glance()`:**
  1. A panel opens with its answer, a stats row (`h.stats`) or checks (`h.checks`), then detail. Raw dumps go in a closed disclosure (`h.more`).
  2. Any list longer than 8 rows folds behind a disclosure showing the count. Task 1 makes this the default.
  3. URLs always go through URL parts. Evidence is never joined into one string.
  4. Findings are data, never drawn by the plugin.
  5. No colour without a word.
  6. Interactive bits use `details`, `:target`, `popover` or anchors.
- **No new explanatory paragraphs.** Help is the only explanatory surface. Tighten or cut existing prose rather than add to it.
- **The standalone export has no `<script>`.** Print opens every `<details>`.
- **Escaping.** Every interpolated value goes through `html```. `raw()` is only for constant markup. Link URLs are scheme-checked.
- **`theme.css`** contains no `<` outside comments: the export escapes it, so use `min-width`/`max-width`.
- **Anchors that tests and screens rely on keep working:**
  - `#p-<id>` and `#pd-<id>`;
  - `details.plugin`;
  - `details.broken-item` and `details.broken-others` (Link check);
  - `#p-a11y-map` and `#p-page-map`;
  - `.pm-*` (Page map).
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Per-plugin checklist (every batch task applies this to each of its plugins)

- [ ] **Answer first.** The first thing in `render()` is the answer: `h.stats` of the key numbers, or `h.checks` of pass/fail items. Detail follows. Anything that is a raw dump (JSON, full header lists, every entry) goes in a closed `h.more`.
- [ ] **No duplicate drawing.** A glance (Measurements) and a render (Plugin data) must not draw the same table or list twice. Keep the visual summary in the glance, and keep only the detail the glance doesn't show in the render. Fold the rest.
- [ ] **Folds.** Tables and lists over 8 rows fold by default (Task 1). Opt out with `{ fold: false }` only when the rows are the answer and few readers would want them hidden. Say why in a comment.
- [ ] **URLs.** Every URL shown as text goes through `h.link(url)` (Task 1 renders URL parts when no text is given), `h.url(url)` (no link), or `h.places`.
- [ ] **Words with colour.** No colour-only marks. Ratings use `h.status`, severities `h.sev`, pass/fail `h.checks`.
- [ ] **Headline.** At least one `summary` item has `headline: true`, and its `label value` reads on its own in the Checks table (Task 1 shows `label value`), for example "LCP 2.1 s" or "Images 8 of 8 have alt text".
- [ ] **Places.** A finding is "about specific URLs or elements" when its `evidence` is a list of URLs, selectors or elements, or a newline-joined list of them. Such a finding gets `places: [{ url?, selector?, text?, line?, status?, note? }]`, at most 200, with `evidence` kept. Free-text evidence stays as evidence.
- [ ] **Tests.** Update the plugin's tests (`test/<plugin>.test.mjs`, `test/glance.test.mjs`, `test/plugins.test.mjs`) to the new markup, keeping what they verify. Add a test for every finding that now carries `places`.

## Rulings made while planning

1. **Fold** (`h.table(rows, cols, { fold = 8 } = {})`, and the same for `h.list`):
   - With more than `fold` rows, the first `fold` rows render as today.
   - The rest go in `<details class="disclosure fold"><summary>N more</summary>` holding a table with the same `<thead>`.
   - `fold: false` turns it off.
   - Print opens the details. The beforeprint handler already covers `details.disclosure`, and the export's print CSS covers all `details`.
2. **URL parts.**
   - `h.url(url)` renders the phase 2 `.url` parts (host, path, query, hash) without a link.
   - `h.link(url)` with no `text`, or with `text === url`, renders an `<a>` around `h.url(url)`.
   - The `.places .url…` CSS is generalised to `.url` wherever it sits inside a panel, keeping the `.hero .url` and `td.url` rules intact.
3. **Labelled Reading.** In `area.js`, the Reading column shows each headline item as `label value`. If the value already starts with the label (case-insensitive), it shows the value alone. Example: label "Contrast", value "11 of 1075 text elements fail (AA)" gives "Contrast 11 of 1075 text elements fail (AA)".
4. **Markdown hardening** (`harplus.js` `issueMarkdown`):
   - Collapse every whitespace run in place strings to one space.
   - For `console` findings, place lines show only `status` and `line`, never `text` or `url`, because console text can carry user data.
5. **Score check** (`scripts/score-check.mjs <harDir> [--write <file> | --compare <file>]`):
   - For each `.har` in the directory: load it, re-run the analyze phase in process with no lookups (`getPlugins()`, page-phase results taken from the saved reading, enrich skipped), score it, and record `{ scores: area scores and overall, findings: every plugin's findings without places }`.
   - `--write` saves the JSON. `--compare` prints the differences and exits 1 if there are any.
   - **Source data:** the saved calibration readings at `/Users/tpowell/src/har-plus/test/e2e/out/calibrate/*.har` (10 sites; gitignored, in the main checkout).
   - **Baseline:** Task 1 writes it to `test/e2e/out/score-baseline.json` in the worktree, before any plugin change.
6. **Build is split into two batches** because it has 10 plugins:
   - Build A: html, css, javascript, tech, baseline;
   - Build B: console, css-validate, html-validate, layout, resilience.

## Review Focus

1. **A plugin whose render reads a field another plugin's glance also reads.** After de-duplication both still render correctly, and neither throws on a missing field. Covered by each batch's plugin tests and by the score check.
2. **A fold inside a Measurements half-width cell.** The "N more" summary doesn't overflow, and the continuation table keeps its columns. Checked in the Task 10 look.
3. **Places from evidence with odd values** (relative URLs, very long selectors, data: URLs). These render through `h.places` safely, which phase 2 tests already cover. Each batch adds one odd-value test per converted finding.
4. **An older saved reading whose findings have no `places`.** The issue detail falls back to Evidence, as phase 2 built it. Nothing in this phase may assume `places` exists.
5. **Scores unchanged.** `score-check --compare` passes after every batch. Pinned in each batch's last step.

---

### Task 1: Foundation

**Files:**
- Modify: `extension/ui/render.js` (`table`, `list`, `link`; add `url`)
- Modify: `extension/core/area.js` (Reading)
- Modify: `extension/core/harplus.js` (`issueMarkdown`)
- Modify: `extension/ui/theme.css` (`.fold`, generalised `.url`)
- Create: `scripts/score-check.mjs`
- Test: `test/charts.test.mjs`, `test/area.test.mjs`, `test/issues.test.mjs`, `test/score-check.test.mjs` (new; test the pure compare function)

- [ ] **Step 1: Write the failing tests**

  ```js
  test('table folds past 8 rows: first 8 shown, the rest under "N more" with the same header; fold:false opts out', () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ a: i }));
    const s = String(h.table(rows, ['a']));
    assert.equal((s.match(/<tr><td>/g) || []).length, 11);
    assert.match(s, /<details class="disclosure fold"><summary>3 more<\/summary>[^]*<thead>/);
    assert.ok(!String(h.table(rows, ['a'], { fold: false })).includes('class="disclosure fold"'));
    assert.ok(!String(h.table(rows.slice(0, 8), ['a'])).includes('fold'));
  });
  test('list folds the same way', () => {});
  test('link with no text renders URL parts; with text, plain', () => {
    assert.match(String(h.link('https://a.test/p?q=1')), /<a [^>]*><span class="url"[^>]*><span class="url-host">a\.test<\/span>/);
    assert.ok(!String(h.link('https://a.test/', 'Home')).includes('url-host'));
  });
  test('area Reading shows label value unless the value starts with the label', () => {});
  test('issueMarkdown collapses whitespace in places; console places show status and line only', () => {});
  test('score-check compare: equal → []; a changed score or finding title → listed; places ignored', () => {});
  ```

- [ ] **Step 2: Run the tests and check that they fail**

  Run `node --test test/charts.test.mjs test/area.test.mjs test/issues.test.mjs test/score-check.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement rulings 1–5**

  Export the score check's pure parts (`snapshot(reading, plugins)` and `compare(a, b)`) so they can be tested. The CLI wrapper does the file input and output.

- [ ] **Step 4: Run the tests and check that they pass**

  Run `npm test`. Expected: all pass. Some plugin render tests will change because of the fold and `h.link`. Update their assertions, keeping what they verify.

- [ ] **Step 5: Write the baseline**

  The baseline must come from the code before any plugin change in this phase. Write it from the base commit's plugins, using the new script, as follows:
  1. Put the script in place but stash none of the foundation changes. The foundation changes no findings, and Step 6 verifies that.
  2. Run `node scripts/score-check.mjs /Users/tpowell/src/har-plus/test/e2e/out/calibrate --write test/e2e/out/score-baseline.json`.

  Expected: it reads 10 HARs and writes the baseline.

- [ ] **Step 6: Prove the foundation changed no score**

  Run `node scripts/score-check.mjs /Users/tpowell/src/har-plus/test/e2e/out/calibrate --compare test/e2e/out/score-baseline.json`. Expected: no differences, exit 0.

- [ ] **Step 7: Commit**

  Message: "Plugin panel foundation: table/list fold, URL parts in h.link, labelled Reading, Markdown places hardening, score-check".

---

### Tasks 2–9: one batch per area

Each task applies the **per-plugin checklist** to its plugins, then:

- [ ] Run `npm test`. Expected: all pass.
- [ ] Run `node scripts/score-check.mjs /Users/tpowell/src/har-plus/test/e2e/out/calibrate --compare test/e2e/out/score-baseline.json`. Expected: no differences.
- [ ] Commit with the message "Plugin panels: <area> (<ids>)".

| Task | Area | Plugins | Known specifics |
|---|---|---|---|
| 2 | Accessibility | a11y-basics, a11y-map, a11y-structure, a11y-views, axe, contrast | Keep the Page map (`a11y-map` + `pageMapPanel`) behaviour and its e2e anchors. The axe rule list and the a11y-basics issues-by-check are both drawn in glance and render, so de-duplicate them. axe and a11y-basics evidence (selectors) → places. |
| 3 | Performance | head-order, images, network, pagespeed, vitals | `head-order` draws its rows twice (glance + render); fold or cut one. The network render's waterfall overlaps the Network pane; keep only what the pane doesn't show. |
| 4 | Security | exposure, observatory, reputation, security | exposure evidence (exposed paths/URLs) → places. Headers as `h.checks`. |
| 5 | Content | content, links, meta | Link check's grouped broken-link panel and places already follow the rules (phase 2). Leave its structure and anchors; apply only the fold and URL parts. meta's share previews: one line when there's no image, previews behind a disclosure (spec's "Share previews" row). |
| 6 | Build A | html, css, javascript, tech, baseline | `tech` badges: chips, folded past 8 with "+N more". baseline evidence (feature lists) stays evidence unless it is per-element. |
| 7 | Build B | console, css-validate, html-validate, layout, resilience | Validator message lists (html-validate, css-validate): line numbers → places with `line`. console: places only with `line`/`status` (ruling 4), never message text. |
| 8 | Infrastructure | ct-logs, dns, history, ip-intel, well-known, whois | ct-logs certificate list and well-known file list fold. ct-logs evidence → places. |
| 9 | International + Sustainability | international, language, carbon | language evidence (passages/elements) → places with `selector`/`text`. carbon host table folds. |

**Files, each task:** `extension/plugins/<id>.js` for its plugins, their tests, and `theme.css` only if a plugin-specific rule is needed.

---

### Task 10: e2e, the look, and refreshed after shots

- [ ] **Step 1:** Run `npm test`, then `npm run test:e2e` from the worktree directory. Fix e2e assertions that pinned the old plugin markup, keeping what they verify.
- [ ] **Step 2:** Run `node scripts/screens.mjs --out test/e2e/out/screens-phase5`, then read every area pane shot, including the expanded ones, the dark ones and the narrow ones. Fix anything that breaks the rules or the layout: folds overflowing half-width cells, URL parts truncating badly, duplicated drawings left behind.
- [ ] **Step 3:** Run the score check one last time. Expected: no differences.
- [ ] **Step 4:** Refresh the after set with `node scripts/screens.mjs --out screens/after`, then commit `screens/after` alone with the message "screens/after: refreshed after the plugin panels".
- [ ] **Step 5:** Commit any fixes with the message "e2e and screens for the plugin panels; visual fixes".
