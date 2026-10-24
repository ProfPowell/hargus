# WAVE-style Accessibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make the Accessibility area trustworthy and richer than WAVE. It should have:
- axe-core on by default, with a needs-review list;
- an Images & alt text panel;
- a real Tab keyboard walk;
- a headings-in-landmarks outline;
- WAVE-style markers on the page screenshot, including alt text drawn on images;
- WAVE heuristics with fix-it reference text;
- calibration against the GDS test page and thymecare.com.

**Architecture:**
- **Pure rules live in `extension/core/`:**
  - `a11y-overlap.js`
  - `alt-verdict.js`
  - `keyboard.js`
  - `a11y-reference.js`
  - `page-map.js`

  They are unit-tested.
- **Page data:** page-phase collectors gather it.
  - The keyboard walk is a capture step (CDP Tab key events) that writes `hp.capture.keyboard`.
  - A new `a11y-map` plugin, which runs after the other accessibility plugins, resolves flagged elements to document boxes and owns the markers.
- **Rendering:** `extension/ui/report.js` renders the panels and the Page map, with CSS-only toggles so they work in the no-script export.

**Tech Stack:** vanilla ES modules, axe-core 4.x (MPL-2.0, bundled), CDP `Input.dispatchKeyEvent`, `h.html` templates, `node --test`, Playwright e2e, and `scripts/calibrate.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-24-accessibility-wave-design.md`. It includes "Decided after the builder check" items 1–8, which are binding. The research is in `docs/research/wave-research.md` and `docs/research/wave-items.tsv`.

## Global Constraints

- **No new runtime dependency** except the bundled `axe.min.js` and its licence.
- **Escaping.** Untrusted page strings stay escaped through `html`: alt text, accessible names and HTML snippets. Snippets are shown as `<code>`, never rendered.
- **No `NaN`, `undefined` or `Infinity`** in output.
- **Bounded work:**
  - collectors are capped by element count and time;
  - the keyboard walk is capped at 250 stops or 60 s, and stops on a cycle or navigation;
  - the map draws at most 400 markers.
- **Restore.** The keyboard walk restores focus (blur) and scroll position, and never presses Enter or Space.
- **Every surface.** Everything works in the interactive viewer, the standalone export (no scripts) and print.
- **Commits** end with `Co-Authored-By: <model that wrote it> <noreply@anthropic.com>`.
- **Commands.** Run `npm test` and `npm run test:e2e` from the repo or worktree root; the baseline is 623 tests, e2e green.
- **Worktree guard.** It rejects compound shell commands with git. Do not commit `package-lock.json`.

## Review Focus

1. **A page whose layout shifts after the screenshot** (lazy images, cookie banner). Markers whose element moved are not drawn and are counted in a note, never drawn in the wrong place. Pinned in Task 5 (unit: the mismatch rule).
2. **A page with hundreds of images or focusable elements** (shop grids). The Images panel and keyboard walk stay bounded and responsive. The panel lists everything collected up to its cap and says "N more". Pinned in Task 2 (cap unit test) and Task 3 (250-stop cap).
3. **A widget that traps Tab** (custom carousel or dialog). The walk detects the cycle, stops, reports a focus trap, and the capture continues. Pinned in Task 3 (e2e fixture trap).
4. **axe fails or times out on a heavy page.** HARgus's own checks report unsuppressed, and there is a warning. Pinned in Task 1 (unit: suppression only when `axe.status === 'ok'`).
5. **Alt text containing markup or quotes** (`alt="<b>Sale</b> “50%”"`). It is shown escaped and quoted in the panel and on the map. Pinned in Task 2 (unit escaping test).

---

### Task 1: axe-core bundled and on by default; needs review; overlap suppression

**Files:**
- Add: `extension/plugins/vendor/axe.min.js` (download with `sh scripts/vendor-axe.sh`, latest 4.x) and `extension/plugins/vendor/LICENSE-axe-core.txt` (the MPL-2.0 text from the axe-core repo)
- Modify: `.gitignore` (stop ignoring `extension/plugins/vendor/axe.min.js`)
- Modify: `extension/plugins/axe.js`
- Create: `extension/core/a11y-overlap.js`
- Modify: `extension/plugins/a11y-basics.js` and `extension/plugins/a11y-structure.js` (`after: ['axe']`; suppression)
- Test: `test/a11y-overlap.test.mjs` (new), plus existing axe and a11y tests

**Interfaces:**
- **Produces:**
  - **`axe.js`:**
    - `defaultEnabled: true`.
    - The description no longer mentions `vendor-axe.sh`.
    - `collect` uses `resultTypes: ['violations', 'incomplete']`. For marker use it keeps up to 50 node targets per rule; evidence still shows 5 samples.
    - `data.incomplete` is `[{ id, impact, help, helpUrl, nodes, samples: [{ target, html, summary }] }]`.
    - `data.engine` holds the version.
  - **Needs-review findings:** one `info` finding per incomplete rule, titled `Needs review: ${help} (${nodes})`, with `detail` = the first sample's failure summary and `evidence` = the targets.
  - **`core/a11y-overlap.js`:**
    - `OVERLAP: Array<{ ours: string /* plugin:findingKey */, axe: string /* rule id */, mode: 'suppress' | 'keep' }>`
    - `suppressedBy(pluginId, findingKey, axeResult) → string | null`. It returns the axe rule id when `axeResult?.status === 'ok'`, the row's mode is `'suppress'`, and that axe rule ran: present in violations, incomplete, or passes, so record passed rule ids as `data.passedIds` in `axe.js`.
- **Overlap table.** Build it by reading every finding emitted by `a11y-basics.js` and `a11y-structure.js`, and give each one a stable `findingKey`. Add an `id`-like key if the finding has none.
  - **Suppress** when the axe rule covers the same problem. Minimum: missing alt → `image-alt`; missing form label → `label`; html lang → `html-has-lang`; empty heading → `empty-heading`; link without name → `link-name`; button without name → `button-name`; duplicate ids → `duplicate-id-aria`.
  - **Keep** partial overlaps: contrast, heading order/skips, focus order, target size.
  - List the whole table in your report for review.

- [ ] **Step 1: Write the failing tests:**
  - `suppressedBy` returns the rule id only when axe is `ok` and the rule ran;
  - `null` for axe `failed`, a missing result, or a `keep` row;
  - plugin-level: a11y-basics with a ctx whose axe result covers `image-alt` omits its missing-alt finding, and keeps it when axe failed (Review Focus 4);
  - the axe plugin's `run()` produces needs-review info findings from `incomplete`;
  - `defaultEnabled === true`.
- [ ] **Step 2: Run the tests and see them fail.** Run `node --test test/a11y-overlap.test.mjs`.
- [ ] **Step 3: Implement.**
  - Vendor axe and commit the file.
  - In `plugin-host.js`, `pluginEnabled` already treats a missing stored value as the default. Confirm that the options page does not persist `enabled` for untouched plugins. If it does, write the migration the spec requires: users who never changed axe get the new default.
  - Update existing tests that pinned axe as opt-in, and list them.
  - Render needs-review in `axe.js` `render()` as a second table, with the snippet as `<code>`.
- [ ] **Step 4: Run the tests.** Run `npm test` and `npm run test:e2e`. The e2e must now show axe running by default: assert `p.axe.status === 'ok'` and `data.engine`.
- [ ] **Step 5: Commit** with "axe-core bundled and on by default; needs review; HARgus checks yield to axe where they overlap".

---

### Task 2: Images & alt text panel

**Files:**
- Create: `extension/core/alt-verdict.js`
- Create: `extension/plugins/a11y-map.js`. It is page phase, isolated world, `area: 'accessibility'`, `after: ['axe', 'a11y-basics', 'a11y-structure', 'contrast']`. This task adds its image collection, and Task 5 adds markers.
- Modify: `extension/plugins/index.js` (register it)
- Modify: `extension/ui/report.js` (a crop-thumbnail helper)
- Test: `test/alt-verdict.test.mjs` (new), `test/a11y-map.test.mjs` (new)

**Interfaces:**
- **Produces:**
  - **`altVerdict(img: { kind, alt: string | null, name: string, inLink: boolean, adjacentText: string, src: string }, { repeats: number }) → { verdict, note }`.**
    - `verdict` is one of `'missing'`, `'empty-decorative'`, `'empty-linked'`, `'suspicious'`, `'redundant'`, `'long'`, `'filename'`, `'repeated'`, `'ok'`.
    - **Rules:**
      - missing means `alt === null` with no accessible name;
      - empty means `alt === ''` (linked if `inLink`);
      - suspicious uses WAVE's word list (from `docs/research/wave-items.tsv`: "image", "graphic", "photo", "picture", "spacer", "blank" and so on), as a whole word, or alt equal to one of them;
      - redundant means `alt` equals adjacent text after normalising whitespace and case, or differs by ≤ 15 characters when one contains the other;
      - long means more than 100 characters;
      - filename means it matches `/\.(png|jpe?g|gif|webp|svg|avif)$/i` or looks like a file stem (`IMG_1234`, `DSC0001`);
      - repeated means the same non-empty alt appears on 2 or more images with different `src`.
    - **Precedence** is the order of the list above. `note` is a short human sentence.
  - **`altVerdicts(images) → images with verdicts`.** It computes `repeats`.
  - **`a11y-map` collect** returns `images: [{ sel, kind, alt, name, inLink, adjacentText, src, box: { x, y, w, h } }]` in document coordinates (`getBoundingClientRect` plus scroll), and `doc: { w, h }`.
    - It covers `img`, `input[type=image]`, `[role=img]`, `svg` with a `<title>` or `role="img"`, `area[href]` and `object` or `embed` images.
    - Cap at 1,000, with `imagesTruncated: N`.
  - **`run()`.**
    - Its `data.images` holds the verdicts.
    - Findings:
      - `${n} images have no alt text` (medium) when there is no axe `image-alt` run, using the same suppression as Task 1;
      - `${n} linked images have empty alt` (medium);
      - `${n} images have suspicious alt text` (low);
      - `${n} images repeat nearby text in their alt` (low);
      - `${n} alt texts are longer than 100 characters` (low);
      - `${n} alt texts look like file names` (low).
  - **`render()`.** An "Images & alt text" table with these columns:
    - a thumbnail (`cropThumb(reading, box)`, a CSS crop of the base full-page shot);
    - the alt in quotes, "no alt" or "empty (decorative)";
    - the kind;
    - in a link;
    - the verdict chip.

    It also gives a verdict filter summary line ("12 ok · 3 missing · 2 suspicious…").
  - **`cropThumb(reading, box, size = 96) → html`** goes in `report.js`. It returns a `<span class="crop">` whose background is the base full-page shot's data URL. `background-position` and `background-size` are computed from the shot's `cssWidth`, `cssHeight` and `scale`. When the box falls outside the shot it returns a "not in screenshot" placeholder.
- [ ] **Step 1: Write the failing tests:**
  - each verdict at its boundary: 15 vs 16 characters for redundant, 100 vs 101 for long, suspicious words, filename patterns, repeated across different `src`, and the precedence;
  - the a11y-map `run()` findings with exact titles;
  - escaping of `<b>Sale</b> “50%”` in the rendered panel (Review Focus 5);
  - the cap note at 1,000 (Review Focus 2);
  - `cropThumb` placement maths: a box at (100, 200, 50×50) on a 1000×4000 shot with scale 0.5 gives the expected `background-position` and `background-size`; a box outside the shot gives the placeholder.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement.**
  - Add `docWidth`/`docHeight` (from `content.width`/`content.height`) to the full-page shot record in `capture.js` `shoot()`. Task 5's mismatch rule needs them.
  - Put the panel first in the Accessibility area. Look at how plugin renders appear in `areaPane`.
- [ ] **Step 4: Run the tests.** Run `npm test`, then `npm run test:e2e`.
  - Add fixture images, one per verdict, to `test/e2e/site/index.html`.
  - Assert in the e2e that the Images panel lists them with the right verdicts and that thumbnails render.
  - Look at the Accessibility area screenshot and describe it.
- [ ] **Step 5: Commit** with "Images & alt text: every image with its alt, a WAVE-style verdict and a screenshot thumbnail".

---

### Task 3: Real keyboard walk

**Files:**
- Create: `extension/core/keyboard.js` (pure analysis)
- Create: `extension/browser/keyboard-walk.js` (page helper functions, self-contained)
- Modify: `extension/browser/capture.js` (a `keyboardWalk(hp)` step after `focusProbe` and before the page-phase `runPlugins`; setting `capture.keyboardWalk`)
- Modify: `extension/browser/settings.js` (`keyboardWalk: true`)
- Modify: `extension/ui/options.html` (a toggle beside the focus check)
- Modify: `extension/plugins/a11y-structure.js` (findings from `hp.capture.keyboard`) and its `render()` (the "Keyboard order" table)
- Test: `test/keyboard.test.mjs` (new), plus e2e

**Interfaces:**
- **The walk step:**
  1. Scroll to the top.
  2. Focus the document start, with `document.activeElement?.blur()` and focus on `<body>`.
  3. Then, up to 250 times or 60 s:
     - `Input.dispatchKeyEvent` Tab (keyDown and keyUp);
     - read the active element with a self-contained `describeFocus()`. It returns `{ sel, role, name, tag, box (document coordinates), visible: boolean (in viewport after the browser scrolls it and not zero-size, not hidden), onScreen, tabindex, changed: boolean (any outline, box-shadow or border difference against its unfocused computed style, taken before focus) }`, or `{ none: true }` when focus is on `body` or `null`.
  4. **Stop** when:
     - a stop repeats the first stop (the end of the cycle);
     - the same small set (≤ 3 elements) repeats 3 times (a trap);
     - focus leaves the page (`none` twice);
     - or navigation happens (watch `Page.frameNavigated` and abort with `aborted: 'navigated'`).
  5. **Restore:** blur, then scroll back to the original position.
  6. **Record** `hp.capture.keyboard = { stops: [...], ended: 'cycle' | 'trap' | 'left-page' | 'cap' | 'time' | 'navigated', ms }`.

  It is skipped when `settings.capture.keyboardWalk === false`, and recorded as `{ skipped: 'turned off' }`.
- **`core/keyboard.js`:** `analyzeKeyboard(k, { focusables = [], clickables = [] }) → { findings: [...], summary }`.
  - **Findings:**
    - `Keyboard focus gets trapped` (high) when `ended === 'trap'`, with the trapped selectors;
    - `Focus is lost ${n} times while tabbing` (medium) for `none` stops in the middle;
    - `${n} keyboard stops are hidden or off-screen` (medium);
    - `${n} keyboard stops have no accessible name` (high);
    - `${n} keyboard stops show no visible focus change` (medium);
    - `${n} elements use a positive tabindex` (low);
    - `Tab order jumps back up the page ${n} times` (low): a stop more than 200 px above the previous one and overlapping it horizontally;
    - `No skip link as the first stop` (low), or `The skip link's target is missing or hidden` (medium). A skip link is a same-page `#` link whose target exists, is visible, and is focusable, a landmark or a heading. Collect the target's state inside `describeFocus` for the first stop.
    - `${n} clickable elements can't be reached by keyboard` (medium). These are elements with `onclick`, or `role` button or link, or `cursor: pointer` with a click listener (best effort), that are not focusable and not in the stops. a11y-structure's collector supplies `clickables` with their selectors.
  - These **replace** a11y-structure's current DOM-inferred `Focus order jumps back…` finding whenever a walk exists. The inferred one stays only when the walk was skipped or aborted early.
- **`render()`:** a "Keyboard order" table: #, role, name (or **"no accessible name"** in red), the selector as `<code>`, and flags (hidden, no visible focus, positive tabindex). The `ended` reason is shown above it.
- [ ] **Step 1: Write the failing tests** (`analyzeKeyboard`, unit):
  - each finding at its trigger, with exact titles;
  - a trap ends the walk with a high finding (Review Focus 3);
  - a clean walk gives no findings;
  - a skip link that is good, missing or hidden;
  - the inferred focus-jump finding is suppressed when a walk exists.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** the analysis, the capture step and the rendering.
  - **E2E fixture additions:**
    - a two-button widget whose keydown handler sends Tab back to the first button (the trap), placed near the end of the page so earlier stops are recorded;
    - an element with `tabindex="3"`;
    - a focusable element inside a `visibility:hidden` or off-screen container;
    - a first-stop skip link `href="#nowhere"` (a missing target);
    - a `div onclick` with no tabindex.
- [ ] **Step 4: Run the tests.** Run `npm test`, then `npm run test:e2e` three times. Assert:
  - `hp.capture.keyboard.stops.length > 5`;
  - `ended === 'trap'`;
  - the findings above are present;
  - after capture, the page's scroll and focus are restored (`document.activeElement` is `body`, and `scrollY` is unchanged);
  - later views are still captured normally.
- [ ] **Step 5: Commit** with "Keyboard walk: real Tab presses during capture, every stop listed, traps, hidden and unnamed stops".

---

### Task 4: Headings inside landmarks outline

**Files:**
- Modify: `extension/plugins/a11y-structure.js` (`collect` records, for each heading, the landmark chain it sits in; `render` builds the tree)
- Create: `extension/core/outline.js`
- Test: `test/outline.test.mjs` (new)

**Interfaces:**
- **`buildOutline(headings: [{ level, text, sel, landmarks: [{ role, label }] }], landmarksAll: [{ role, label, sel }]) → tree`.**
  - Its nodes are `{ kind: 'landmark' | 'heading', role?, label?, level?, text?, issues: ('empty' | 'skipped')[], children }`.
  - Headings nest by level inside their innermost landmark, in document order.
  - Landmarks with no headings still appear.
- **Rendering:** a nested list replaces `h.outline(d.headings)`. Landmarks are shown as badges (banner, navigation "Main", main, complementary, contentinfo, region "Name"). Empty and skipped headings are marked in red.
- [ ] **Step 1: Write the failing tests:**
  - nesting by level within landmarks;
  - a skipped level marked;
  - an empty heading marked;
  - a landmark without headings present;
  - headings outside any landmark at the top level.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Run `npm test` and `npm run test:e2e`.
- [ ] **Step 5: Commit** with "Structure outline: headings nested in landmarks, with empty and skipped levels marked".

---

### Task 5: Page map, WAVE-style markers on the screenshot

**Files:**
- Create: `extension/core/page-map.js`
- Modify: `extension/plugins/a11y-map.js` (resolve flagged elements to boxes; `data.marks`)
- Modify: `extension/ui/report.js` (the Page map panel) and `extension/ui/theme.css`
- Modify: `extension/ui/reading.js` (interactive behaviour: select a marker to show its details; toggles stay CSS-only)
- Test: `test/page-map.test.mjs` (new), `test/report.test.mjs`

**Interfaces:**
- **`a11y-map` `collectArgs(ctx)`.** It passes the selectors to resolve:
  - axe violation and incomplete targets (up to 50 per rule), from `ctx.results.axe.data`;
  - a11y-basics and a11y-structure finding evidence selectors;
  - contrast sample selectors;
  - the keyboard stops from `hp.capture.keyboard` (its boxes are already there).

  `collect` resolves each selector with `document.querySelector`, in a try/catch, to a document box.
- **`buildMarks({ violations, incomplete, heuristics, contrast, images, keyboard }) → marks[]`.**
  - Each mark is `{ category: 'error' | 'contrast' | 'alert' | 'feature' | 'structure' | 'aria' | 'keyboard', label, ruleId, box, alt?, n? }`.
  - **Mapping:**
    - axe violations go to `error`, except contrast rules, which go to `contrast`, and `aria-*` rules, which go to `aria`;
    - axe incomplete and HARgus alerts go to `alert`;
    - images with verdict `ok` or `empty-decorative` go to `feature` with `alt`, and images with a bad verdict go to `error` or `alert` per verdict;
    - headings and landmarks go to `structure`;
    - keyboard stops go to `keyboard` with `n`.
- **`placeMarks(marks, shot: { cssWidth, cssHeight, docWidth, docHeight }, docAtCollect: { w, h }, max = 400) → { placed: [{ ...mark, left%, top%, w%, h% }], beyond: n, dropped: n, mismatch: boolean }`.**
  - **Clip box:** marks outside `cssWidth`/`cssHeight` are counted in `beyond`.
  - **Mismatch:** when `|docAtCollect.h − shot.docHeight| / shot.docHeight > 0.02`, or the same for width, `mismatch` is true. Marks are still drawn only when their box lies within the clip box, and the map shows a note. Per spec item 1, re-checking each element's position is left to the builder. A simple rule is fine: keep all marks and show the note when the mismatch is under 10%, and draw only `keyboard` and `structure` marks plus the note when it is 10% or more.
  - **Cap:** above `max`, it keeps by priority error > contrast > alert > aria > keyboard > feature > structure and counts the rest in `dropped`.
- **The Page map panel** (first or second in the Accessibility area, near the Images panel):
  - the base full-page shot with absolutely positioned markers at percentage coordinates;
  - WAVE-like icons as coloured circles with a glyph, and numbered circles for keyboard stops, with a thin path between consecutive stops drawn as an SVG polyline in the same percentage space;
  - feature marks over images show the alt in a small label on the image (truncated to 60 characters, escaped);
  - a legend with a checkbox per category, which toggles through a CSS sibling selector, and the counts;
  - notes for `beyond`, `dropped` and `mismatch`;
  - below the map, a numbered list of every placed marker (category, rule label, selector), used for print and the export.
  - **Interactive viewer:** selecting a marker highlights its list entry and shows the details, using the reference text from Task 6 when available.
  - **No full-page shot:** use the viewport shot and keep only marks inside the first viewport, with a note.
- [ ] **Step 1: Write the failing tests:**
  - `placeMarks`:
    - percentage maths on a 1000×4000 shot;
    - a box beyond the clip box counted in `beyond`;
    - the 2% mismatch flag (Review Focus 1);
    - priority when over 400;
  - `buildMarks` category mapping;
  - the report panel renders markers with escaped alt labels, legend checkboxes and the numbered list;
  - the standalone export contains the markers and no `<script>`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Run `npm test`, then `npm run test:e2e`.
  - Assert that the Page map renders with markers on the fixture, including at least one alt label and the keyboard path, and that toggling a category hides its markers (CSS).
  - Take a screenshot `reading-page-map.png` and describe it.
- [ ] **Step 5: Commit** with "Page map: WAVE-style markers, alt text on images and the keyboard path over the screenshot".

---

### Task 6: WAVE heuristics and fix-it reference text

**Files:**
- Create: `extension/core/a11y-reference.js`
- Modify: `extension/plugins/a11y-basics.js` and/or `extension/plugins/a11y-structure.js` (new collectors and checks)
- Modify: `extension/ui/report.js` (the finding detail shows the reference: what, why, how to fix, and the WCAG success criterion with a link)
- Test: `test/a11y-reference.test.mjs` (new), plus additions to the existing a11y tests

**Interfaces:**
- **New checks.** Each check is a finding with a stable key; use WAVE's trigger wording from `docs/research/wave-items.tsv` where it applies.
  - **Possible heading** (low): `p` or `div` with fewer than 50 characters, bold or at least 1.2× body font size, not a heading, followed by content.
  - **Possible list** (low): 3 or more sibling lines starting with the same bullet-like character or numbering, not in a list.
  - **Redundant adjacent links** (low): 2 links in a row to the same `href`.
  - **Broken same-page link** (medium): an `href="#x"` with no `id` or name `x`. Exclude `#` and `#top`.
  - **Fieldset without legend** (medium).
  - **Empty, multiple or orphaned label** (medium for empty or orphaned, low for multiple).
  - **`title` duplicating the visible label or name** (info).
  - **Vague link text** (low): extend the word list with WAVE's ("click here", "here", "more", "read more", "learn more", "link", "this").
  - **Very small text** (low): computed font size under 10 px on visible text.
  - **Justified text** (low).
  - **Underlined non-link** (low).
  - **Layout table** (low): a table with no `th` or caption, and 1 row or 1 column, or used for layout (heuristic).
  - **Media without captions** (medium): `video` with no `track[kind=captions|subtitles]`, and YouTube or Vimeo iframes as `info`.
  - Each new check suppresses against axe via Task 1's table where axe has an equivalent: add rows (for example `link-in-text-block`).
- **`REFERENCE: Record<key, { what, why, fix, wcag: string[] /* e.g. '1.1.1' */ }>`** covers every HARgus accessibility finding key: existing, new, and the Task 3 and Task 2 keys. axe findings use axe's `help` and `helpUrl` together with the axe rule's WCAG tags mapped to criteria.
- **`referenceFor(pluginId, key, axeTags?) → { what, why, fix, wcag, url } | null`.**
- [ ] **Step 1: Write the failing tests:**
  - each new check at its trigger and just below it;
  - every finding key emitted by the a11y plugins in their tests has a `REFERENCE` entry (iterate the emitted keys);
  - WCAG link format.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement.** Add fixture elements for the new checks (`fieldset`, possible heading, broken `#` link, redundant links, a small-text span).
- [ ] **Step 4: Run the tests.** Run `npm test` and `npm run test:e2e`.
- [ ] **Step 5: Commit** with "WAVE heuristics ported, fix-it reference text with WCAG for every accessibility finding".

---

### Task 7: Calibration on the GDS test page and thymecare.com

**Files:**
- Modify: `scripts/calibrate.mjs` (add `SITES_A11Y = ['https://alphagov.github.io/accessibility-tool-audit/test-cases.html', 'https://www.thymecare.com/']`, selectable with an option the way `SITES_2` is)
- Create: `docs/research/gds-audit-results.md` (WAVE and axe per-case results from https://github.com/alphagov/accessibility-tool-audit, with the source and fetch date)
- Create: `docs/research/gds-harg-calibration.md`
- Test: `test/calibrate.test.mjs` (the list is exported and selectable)

**Interfaces:**
- **The calibration doc:**
  - a table with one row per GDS test case: id, barrier, WAVE result, axe result (from the GDS data), and HARgus result (detected / not, plus which finding);
  - before-and-after totals. "Before" is a reading taken at the plan's base commit with axe off. "After" is this branch.
  - The ≥ WAVE target is recorded, not a gate.
  - thymecare.com gets a short section: image count, alt verdict counts, keyboard walk stops and end reason, and the top findings.
- [ ] **Step 1: Write the failing test.** `SITES_A11Y` is exported, and the CLI option selects it.
- [ ] **Step 2: Run the test and see it fail.**
- [ ] **Step 3: Implement.**
  1. Fetch the GDS per-case results.
  2. Run `node scripts/calibrate.mjs` with the new option (real network; see `scripts/calibrate.mjs` usage).
  3. Map HARgus findings to GDS cases by hand-checking each case's expected barrier against the reading's findings and panels.
  4. Write both docs.
  5. Look at the thymecare Images panel and Page map screenshots and describe them.
- [ ] **Step 4: Run the tests.** Run `npm test`.
- [ ] **Step 5: Commit** with "Calibration: GDS accessibility test page and thymecare.com, with GDS WAVE/axe baselines".

---

## Self-review notes

- **Spec coverage:**

  | Spec item | Task |
  |---|---|
  | Goals 1 (axe) and Decided 6 (axe), Decided 8 (overlap table) | Task 1 |
  | Goal 2 (Images panel) | Task 2 |
  | Goal 3 (keyboard walk), Decided 2–3 | Task 3 |
  | Goal 4 (outline) | Task 4 |
  | Goal 5 (Page map), Decided 1, 4, 5 | Task 5 |
  | Goal 6 (heuristics, reference) | Task 6 |
  | Goal 7 (calibration), Decided 7 | Task 7 |

- **Names:** `suppressedBy`, `altVerdict`, `cropThumb`, `analyzeKeyboard`, `buildOutline`, `buildMarks`, `placeMarks`, `referenceFor`, `hp.capture.keyboard` and `data.marks` are each defined once.
- **Data added to an earlier structure:** Task 2 adds `docWidth`/`docHeight` to the full-page shot, and Task 5 consumes them.
