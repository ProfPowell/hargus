# Report redesign, phase 3: Overview, sidebar and Help — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Overview becomes a triage page with these parts, from top to bottom:
1. a verdict header with a reading-status strip;
2. Fix first;
3. an Areas table showing each area's severity mix;
4. five headline stats;
5. Built with;
6. a plain-language Reading health section.

The sidebar lists areas by issue count. A single Help button opens a report-wide overlay.

**Architecture:**
- **Pure logic.** A new module, `extension/core/readout.js`, holds the logic that has no markup: the verdict sentence, the reading status, and the plain-language capture reasons.
- **Markup.** `extension/ui/report.js` rebuilds `overviewPane` and `sidebar` from phase 1 and 2 helpers.
- **Help.** `extension/ui/help.js` holds the static Help content, shown with the native `popover` attribute so it also works in the no-script export.

**Tech Stack:** plain ES modules, CSS `@layer` and `light-dark()`, `node --test`, and Playwright e2e (`npm run test:e2e`, run from the worktree directory).

**Spec:** `docs/superpowers/specs/2026-10-28-report-redesign-design.md`, sections A (sidebar, app bar), B (Overview) and E (Help overlay). The spec lets the builder choose whether Help lands in phase 3; this plan includes it.

**Design references:**
- `docs/design/2026-10-28-proposed.css`;
- board 2 ("Overview · 1280") and board 5 ("Overview · 390") in `docs/design/2026-10-28-report-redesign.html`.

## Global Constraints

- **Scores and findings unchanged.** This phase is rendering only.
- **No script in the export.** The standalone export (`standaloneDocument`) contains no `<script>`. Help uses `popover`/`popovertarget`; disclosure uses `<details>`.
- **Print.** Every closed `<details>` opens for print. The Help overlay and its button do not print.
- **Help is the only explanation.** It is the single explanatory surface. Nowhere else on the Overview gains explanatory paragraphs: no per-row help icons, no "what this means" text.
- **Naming.** The UI says "issue"; code and data keep `findings`.
- **Escaping.** Every interpolated value goes through `html```, and `raw()` is used only for constant markup. Link URLs go through the scheme check.
- **No colour without a word or glyph.** Use `h.sev`, `h.status`, `h.scoreBar` and `h.mix`, which all carry text.
- **Accessibility.** The UI meets WCAG 2.2 AA at 1280 px and 390 px, in light and dark.
- **CSS.** `theme.css` keeps `@layer reset, tokens, base, components, pages;` and uses the phase 1 tokens.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Rulings made while planning

1. **The verdict rule.** `verdictSentence(scores)` replaces `summarize` on the Overview. `summarize` stays exported for its tests and any other caller. The sentence is built from these parts, in order:
   - **Cap text first.** When the overall grade is capped, or a critical area is failing, today's cap text comes first, unchanged: "Capped at D: … (critical for <profile>)." or "<Area> is failing (critical for <profile>)."
   - **Strong areas.** If one or two measured areas score 90 or more, write "Strong on <a> and <b>." using the two highest scores, in lower case. Otherwise write "Best area: <a> (<score>)."
   - **The weak area.** Take the lowest-scoring measured area. If its status is `serious` or `critical`, write "<Area> is <poor|failing>" and add one of:
     - ": all N high-severity issues are there." when it holds every high issue and there are some;
     - ": N of M high-severity issues are there." when it holds some;
     - "." otherwise.
   - **Otherwise,** when there are at least two measured areas, write "No area below <lowest score>."
   - **Nothing measured.** If no area is measured, the sentence is "No areas measured yet — enable plugins and re-run analysis."
2. **Reading status.** `readingStatus(reading)` returns `{ state, views, skipped, failedChecks, warnings }`:
   - `state` is one of:
     - `'failed'` when no plugin result has status `ok`;
     - `'partial'` when there are skipped views or any plugin result has status `error`;
     - `'complete'` otherwise.
   - `views` is the number of views captured: `capture.views.length`, or 0.
   - `skipped` is a list of `{ view, label, why }`, where `label` comes from `viewLabel` in `extension/core/views.js` and `why` from `plainReason(reason)`.
   - `failedChecks` lists the plugin names whose status is `error`.
   - `warnings` holds the raw `capture.warnings`.
3. **Plain reasons.** `plainReason(raw)` maps a raw capture reason to a short plain sentence fragment. It uses the first matching rule:

   | Raw reason matches | Plain text |
   |---|---|
   | `/translator/i` and `/time(d)? ?out/i` | "the on-device translator didn't load in time" |
   | `/time(d)? ?out/i` | "it took too long" |
   | `/not supported\|unsupported/i` | "this browser can't produce it" |
   | `/detached\|closed\|navigat/i` | "the page changed while it was being captured" |
   | `/views could not be merged\|analysis failed/i` | "the views couldn't be saved with the reading" |
   | anything else | "it couldn't be captured" |

   The raw text is always kept, under "Technical detail".
4. **At a glance shows five stats, each only when its source exists:**
   - **Load (LCP):** `vitals.data.lcp.time`, rated by `vitals.data.ratings.lcp`.
   - **Layout shift (CLS):** `vitals.data.cls` to 2 decimals, rated by `ratings.cls`.
   - **Page weight:** transfer bytes. The note is "<decoded> decoded" when the decoded total (sum of `content.size`) is larger.
   - **Requests:** the count. The note is "N third-party · M hosts".
   - **CO₂ per visit:** `carbon.data.grams` to 2 decimals plus " g". The note is "rating <letter>".

   Hosts contacted, Technologies and Requests over time leave the Overview. Hosts is folded into the Requests note, Technologies into Built with, and the timeline already lives in Network.
5. **Areas table.**
   - The rows are the 8 areas, worst score first, with unmeasured areas last.
   - Columns:
     - Area: a link to `#area-<id>`;
     - Score: the number plus `h.scoreBar`;
     - Grade: the grade and the `VERDICT` word;
     - Issues by severity: `h.mix(counts)`;
     - Issues: the total.
   - Under the table, a legend of the four severities, each as `h.sev` plus its total.
   - At 390 px or narrower, each row becomes one line (area with grade, the score bar, the count) and the mix column is hidden. This is CSS on the same markup, keeping `<table>` semantics.
6. **Fix first.**
   - It shows the top 5 non-info issues as `h.issues`.
   - The footer reads "Then: N more high, M medium." — leaving out any part that is zero, and leaving out the sentence entirely when both are zero.
   - The footer links to "All N issues →" at `#issues`.
7. **Built with.**
   - It shows up to 8 chips (the `h.badges` look).
   - When there are more, a link "+N more in Build →" goes to `#area-build`.
8. **Reading health.**
   - It is `<details class="disclosure" id="reading-health">`, closed. Its summary is "Reading health", with meta "N of M views skipped", or "complete", or "K checks didn't run".
   - The body holds, in order:
     - one sentence per skipped view: "<label>: skipped — <why>.";
     - "Checks that didn't run: a, b.";
     - the facts that left the strip: tags, "started at <url>" and "imported from <source>";
     - a nested `h.more('Technical detail', <ul> of raw warnings)`.
   - In the live viewer, a hashchange to `#reading-health` opens the details.
9. **Status strip.** One line under the verdict, in this order:
   1. `h.status(complete→good, partial→fair, failed→poor, word)`, where the word is "Reading complete", "Reading partial" or "Reading failed";
   2. the date and time;
   3. "Scored as <profile>";
   4. the device, plus throttle when set;
   5. the mode;
   6. the duration;
   7. when views were skipped, "N views skipped" linking to `#reading-health`.
10. **Sidebar** (spec A).
    - Top: the overall ring (44 px), the grade, and "N issues".
    - Then Overview, Issues with its count, Network with its count, Screens and Notes.
    - Then a heading "Areas · issues" over 8 links. Each link shows the area name and its issue count (including info).
    - When an area has any high-severity issue, its link also shows `h.sev('high')`'s glyph, without the word, plus `.sr-only` "includes high severity".
    - The rings and scores leave the sidebar.
11. **Help.**
    - **Button.** `<button type="button" class="btn help-btn" popovertarget="help" aria-label="Help">` with a "?" glyph and the visible word "Help". It goes in the app bar of `reading.html` (before Export) and of `standaloneDocument`.
    - **Overlay.** `<div id="help" popover class="help" role="dialog" aria-labelledby="help-h">` holds:
      - an `<h2 id="help-h">Reading this report</h2>`;
      - a close `<button popovertarget="help" popovertargetaction="hide">Close</button>`;
      - the five sections from spec E, in `extension/ui/help.js` as `helpOverlay() → html`.
    - **Placement.** The overlay is rendered once, by `renderReport`, so the extension and the export share it.
    - **Text.** Keep it short: about 250–400 words in all.
    - **Area lines.** They come from `AREAS` labels with one line each, written in `help.js`.
    - **Print.** `[popover]` is already hidden in print (theme.css), and `.help-btn` must be hidden too.

## Review Focus

1. **A reading where vitals, carbon or tech didn't run.** At a glance shows the stats it has with no empty tiles, and Built with is absent. Pinned in Task 3.
2. **A reading with no screenshot.** The hero still lays out, using the existing "No screenshot" box. Pinned in Task 3.
3. **A failed reading** (no plugin ok). The strip says "Reading failed", the Areas table shows "not measured" rows, and nothing throws. Pinned in Tasks 1 and 3.
4. **Help keyboard use in the export.** The button opens the overlay, Esc closes it, and focus returns to the button. This is native popover behaviour, checked by e2e in Task 4.
5. **At 390 px.** The Areas table and the strip don't scroll sideways, and the overall ring doesn't crush the title. Pinned in Task 4.

---

### Task 1: `readout.js`: the verdict sentence, the reading status and plain reasons

**Files:**
- Create: `extension/core/readout.js`
- Test: `test/readout.test.mjs` (new)

**Interfaces:**
- Consumes: `scoreReading`, `AREAS` and `VERDICT` from `extension/core/score.js`; `viewLabel` from `extension/core/views.js`.
- Produces:
  - `verdictSentence(scores) → string` (ruling 1);
  - `readingStatus(reading) → { state, views, skipped:[{view,label,why}], failedChecks:string[], warnings:string[] }` (ruling 2);
  - `plainReason(raw) → string` (ruling 3).

- [ ] **Step 1: Write the failing tests**

  ```js
  test('verdict: strong pair, failing area holding every high issue', () => {
    // scores: infrastructure 100, performance 96, …, accessibility 37 (critical) with all 6 high issues
    assert.equal(verdictSentence(s), 'Strong on infrastructure and performance. Accessibility is failing: all 6 high-severity issues are there.');
  });
  test('verdict: no strong area, weakest poor with some highs', () => { /* "Best area: content (84). Security is poor: 2 of 3 high-severity issues are there." */ });
  test('verdict: everything fine', () => { /* "Strong on a and b. No area below 88." */ });
  test('verdict: cap text first, unchanged', () => { assert.match(verdictSentence(capped), /^Capped at D: Accessibility is failing \(critical for Public sector \/ education\)\. /); });
  test('verdict: nothing measured', () => { assert.equal(verdictSentence(empty), 'No areas measured yet — enable plugins and re-run analysis.'); });
  test('readingStatus: complete / partial (skipped view, plugin error) / failed', () => {
    assert.equal(readingStatus(ok).state, 'complete');
    const p = readingStatus(withSkip); // capture.viewsSkipped [{ view: 'translated-de', reason: 'TimeoutError: Translator create timed out after 60s' }]
    assert.equal(p.state, 'partial'); assert.deepEqual(p.skipped[0], { view: 'translated-de', label: viewLabel('translated-de'), why: "the on-device translator didn't load in time" });
    assert.equal(readingStatus(noneOk).state, 'failed');
  });
  test('plainReason: first matching rule, fallback', () => {
    assert.equal(plainReason('Navigation timeout of 15000 ms exceeded'), 'it took too long');
    assert.equal(plainReason('weird'), "it couldn't be captured");
  });
  ```

  Build the fixtures the way `test/score.test.mjs` does.

- [ ] **Step 2: Run the tests and check that they fail**

  Run `node --test test/readout.test.mjs`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement**

  Reuse `summarize`'s cap-text logic. Move it into a shared helper in `score.js` (for example `capText(scores)`) that both functions call, rather than copying it.

- [ ] **Step 4: Run the tests and check that they pass**

  Run `npm test`. Expected: all pass, and the `summarize` tests are unchanged.

- [ ] **Step 5: Commit**

  Use the message "readout: verdict sentence, reading status, plain capture reasons".

---

### Task 2: Sidebar and Help

**Files:**
- Modify: `extension/ui/report.js` (`sidebar`, ~49–64; `renderReport` and `standaloneDocument` app bar, ~860–900)
- Create: `extension/ui/help.js`
- Modify: `extension/ui/reading.html` (app bar), `extension/ui/theme.css`
- Test: `test/report.test.mjs`

**Interfaces:**
- Consumes: `h.sev`, `allIssues` (via `renderReport`), and `AREAS`.
- Produces: `helpOverlay() → html` and the `#help` popover, rendered once inside `renderReport` output. The sidebar markup follows ruling 10.

- [ ] **Step 1: Write the failing tests**

  ```js
  test('sidebar: areas by issue count with a high mark; no area rings or scores', () => {
    const out = renderReport(reading, plugins, { interactive: false });
    const nav = out.slice(out.indexOf('<nav class="sidebar"'), out.indexOf('</nav>'));
    assert.match(nav, /Areas · issues/);
    assert.match(nav, /href="#area-accessibility"[^]*?<b>\d+<\/b>/);
    assert.match(nav, /includes high severity/);            // the fixture has a high issue in some area
    assert.equal((nav.match(/class="chart ring"/g) || []).length, 1); // only the overall ring
  });
  test('help: one popover, labelled dialog, close button, five sections; export has the button and no script', () => {
    const out = renderReport(reading, plugins, { interactive: false });
    assert.equal((out.match(/id="help"/g) || []).length, 1);
    assert.match(out, /<div id="help" popover class="help" role="dialog" aria-labelledby="help-h">/);
    assert.match(out, /popovertargetaction="hide"/);
    for (const h2 of ['How to read this report', 'How scores work', 'Severities', 'The eight areas', 'Reading health']) assert.ok(out.includes(h2), h2);
    const doc = standaloneDocument(reading, plugins, { css: '' });
    assert.match(doc, /class="btn help-btn" popovertarget="help"/); assert.ok(!/<script/i.test(doc));
  });
  ```

- [ ] **Step 2: Run the tests and check that they fail**

  Run `node --test test/report.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

  - Build the sidebar and the Help overlay and button as rulings 10 and 11 describe.
  - **Help CSS:**
    - Base it on the design's panel styling.
    - Size it `width: min(720px, 100vw - 2rem)` and `max-height: 85dvh`, with `overflow: auto`.
    - Give `::backdrop` a dim tint.
    - Pin the close button to the top-right.
  - **Sidebar CSS:** give the "Areas · issues" heading the `h2` eyebrow style. Keep the existing `aria-current` styling.
  - In `reading.html`, add the button to the app bar before Export.

- [ ] **Step 4: Run the tests and check that they pass**

  Run `npm test`. Expected: all pass. Update the existing tests that asserted area rings and scores in the sidebar.

- [ ] **Step 5: Commit**

  Use the message "Sidebar lists areas by issue count; report-wide Help popover".

---

### Task 3: The Overview pane

**Files:**
- Modify: `extension/ui/report.js`:
  - `overviewPane` (~138–176) is rebuilt;
  - `areaCard`, `overviewStats`, `findingsByArea` and `builtWith` are removed or replaced;
  - `headlines` is kept only if something else still uses it.
- Modify: `extension/ui/reading.js` (on a hashchange to `#reading-health`, open the details)
- Modify: `extension/ui/theme.css`
- Test: `test/report.test.mjs`

**Interfaces:**
- Consumes:
  - `verdictSentence`, `readingStatus` and `plainReason` from Task 1;
  - `h.issues`, `h.scoreBar`, `h.mix`, `h.sev`, `h.status`, `h.stat`, `h.stats`, `h.more` and `h.badges`;
  - `allIssues`.
- Produces the Overview markup, in this order:
  1. `interstitialCard`, unchanged;
  2. `.card.hero`, holding:
     - the screenshot (or the "No screenshot" box);
     - `h1` title;
     - the URL;
     - `<p class="verdict">` (ruling 1);
     - `<p class="status-strip">` (ruling 9);
     - `.overall`: a 104 px ring, the grade and the verdict word;
  3. `.two`, holding:
     - `section.panel` "Fix first" (ruling 6);
     - `section.panel` "Areas" (ruling 5);
  4. `<h2>At a glance</h2>` and `h.stats` (ruling 4);
  5. Built with (ruling 7);
  6. Reading health (ruling 8).

- [ ] **Step 1: Write the failing tests**

  ```js
  test('overview: verdict sentence, status strip, no area cards or findings chart', () => {
    const out = overviewHtml(reading);                       // slice of renderReport between id="overview" and the next pane
    assert.match(out, /<p class="verdict">/); assert.match(out, /Reading (complete|partial|failed)/);
    assert.ok(!out.includes('area-card') && !out.includes('area-bars'));
  });
  test('overview: areas table worst first with mix and count; legend', () => {
    // rows in ascending score; each has href="#area-…", class="score-bar", class="mix" (when issues), the VERDICT word
  });
  test('overview: fix first footer counts the rest', () => { /* "Then: 1 more high, 9 medium." for a fixture with 6 high + 9 medium */ });
  test('overview: at a glance shows only stats with a source; no empty tiles', () => {
    // fixture without carbon and tech: 4 stats, no "CO₂", no Built with
  });
  test('overview: reading health closed, plain reasons, raw text under Technical detail', () => {
    // fixture with a translator timeout: summary meta "1 of N views skipped", body has "didn't load in time", raw text inside a nested details
  });
  test('overview: no screenshot and failed reading still render', () => { /* no throw; "No screenshot"; "Reading failed"; "not measured" rows */ });
  ```

- [ ] **Step 2: Run the tests and check that they fail**

  Run `node --test test/report.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement the markup and CSS**

  - **Hero.** It keeps today's grid: shot, text, ring.
  - **The `.two` grid.** Two columns at 1100 px and wider, one column below that.
  - **Areas table at 390 px or narrower.** Use CSS only (ruling 5): the rows become grids, the mix column is `display:none`, and the table semantics stay.
  - **Remove** the CSS for `.area-cards`, `.area-card` and `.area-bars` that nothing uses any more.
  - **`reading.js`.** On a hashchange to `reading-health`, set `open` on `#reading-health`.

- [ ] **Step 4: Run the tests and check that they pass**

  Run `npm test`. Expected: all pass. Update the existing tests that asserted area cards, "Fix these first" or the old stats.

- [ ] **Step 5: Commit**

  Use the message "Overview: verdict and status strip, Fix first, Areas table, five stats, Built with, Reading health".

---

### Task 4: e2e, screens and the look

**Files:**
- Modify: `test/e2e/run.mjs` (overview assertions; add Help and Reading health checks)
- Modify: `scripts/screens.mjs` (any selectors that relied on area cards or "Fix these first", and manifest wording)
- Modify: `extension/ui/theme.css`, for fixes found here

- [ ] **Step 1: Update the e2e test**

  Change existing assertions that relied on area cards, the findings chart or sidebar rings to the new markup. Add these checks:
  1. **Help in the extension.** Clicking Help shows `#help` (`:popover-open`). Pressing Esc hides it, and focus returns to the Help button.
  2. **Help in the export.** Open the exported file and do the same with no script.
  3. **Reading health.** Following "N views skipped" (when the test page produces a skipped view; otherwise go to `#reading-health` directly) opens the details.
  4. **Areas table.** It has 8 rows, and the first row's score is the lowest.
  5. **Narrow screen.** At a 390-wide viewport, `document.documentElement.scrollWidth <= 390` on the Overview.

- [ ] **Step 2: Run the suites, then capture and look**

  Run these one at a time, never together:
  1. `npm test`
  2. `npm run test:e2e`, from the worktree directory
  3. `node scripts/screens.mjs --out test/e2e/out/screens-phase3`

  Read these shots:
  - the overview, at the fold, full height, dark, narrow and narrow-full;
  - the gov.uk overview, in both widths;
  - one area pane, for the sidebar;
  - the export overview.

  Fix anything that breaks the spec's layout rules, especially:
  - the verdict or title crushed by the ring at 390 px;
  - the strip overflowing;
  - the Areas table scrolling sideways;
  - a colour without its word.

- [ ] **Step 3: Commit**

  Use the message "e2e and screens for the new Overview, sidebar and Help; visual fixes".
