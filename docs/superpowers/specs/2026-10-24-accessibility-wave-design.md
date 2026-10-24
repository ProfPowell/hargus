# Accessibility, WAVE-style: alt text, a real keyboard walk, page markers

**Status:** design written 2026-10-24. The owner asked to skip the brainstorm questions.

**Research:** a comparison of WAVE and HARgus, at `docs/research/wave-research.md`, with WAVE's trigger table at `docs/research/wave-items.tsv`.

## Intent

A tester compared HARgus with WebAIM's WAVE on https://www.thymecare.com/. Her feedback:
- **HARgus doesn't show alt text.** WAVE shows every image's alt in place on the page.
- **HARgus's "tabbing exploration" isn't enough.** It only infers a focus order from the DOM and reports "focus order jumps N times".

The research also found the main reason HARgus misses so much: **axe-core never runs in a normal reading.** The plugin is off by default, and the library isn't in the repo.

Goal: an Accessibility area that a WAVE user would trust and find richer. It should show:
- every image with its alt text and a verdict;
- a real keyboard walk through the page;
- WAVE-style markers on the page screenshot;
- a clear outline of the page structure;
- far more checks (axe-core plus WAVE's heuristics), each with plain fix-it text.

Success is measured on two pages:
- **The UK GDS accessibility test page** (https://alphagov.github.io/accessibility-tool-audit/test-cases.html). HARgus should detect at least as many of its planted barriers as WAVE and axe do in the GDS study (WAVE about 30–39%, axe about 30%), ideally more.
- **thymecare.com.** HARgus shows every image's alt text, and the full keyboard order, without opening another tool.

## Goals

1. **axe-core on by default.**
   - Bundle `axe.min.js`, version 4.13.0 or the latest 4.x, MPL-2.0, with its licence file kept next to it. Enable the plugin by default.
   - Collect **violations and incomplete** ("needs review") results.
   - Show needs-review items as their own list, with the element's HTML snippet and axe's failure summary.
   - Drop the "requires scripts/vendor-axe.sh" wording. Keep `scripts/vendor-axe.sh` for updating the bundled copy.
2. **An "Images & alt text" panel** in the Accessibility area. For **every** image-like element, it shows:
   - a **thumbnail cropped from the base screenshot**;
   - the alt or accessible name **in quotes**, or "no alt" or "empty (decorative)";
   - the element kind;
   - whether it is inside a link or button;
   - a **WAVE-style verdict**: missing; empty but linked; suspicious (word list); redundant with adjacent text (within 15 characters); long (over 100 characters); a filename as alt; or the same alt repeated on different images.

   Image-like elements are `img`, `input[type=image]`, `[role=img]`, `svg` with a title or role, `area` and CSS background images that carry text-like `aria-label`s.
3. **A real keyboard walk.** During capture, press Tab from the top of the page with CDP key events, up to 250 stops or until focus returns to the start or the page. For each stop, record:
   - the element (selector, role, accessible name);
   - its box on the page;
   - whether it is visible on screen;
   - whether the focus indicator changed (reusing the existing focus-style comparison).

   Then:
   - show the list in order;
   - draw **numbered markers with a connecting path** on the screenshot;
   - **report:**
     - focus traps (the walk cycles without reaching the end);
     - lost focus (`document.body` or none);
     - focus on hidden or off-screen elements;
     - stops with no accessible name;
     - stops with no visible focus change;
     - positive `tabindex`;
     - big backward jumps;
     - whether the first stop is a skip link and whether it works;
     - interactive elements that can't be reached by keyboard (clickable non-focusable elements found in the DOM).
4. **One structure outline:** headings nested inside landmarks (banner, nav, main, complementary, contentinfo, regions with names), with empty or skipped levels highlighted. It replaces the buried heading outline.
5. **WAVE-style markers on the page screenshot.** A "Page map" panel shows the base full-page screenshot with **colour-coded markers** at each flagged element, by category:

   | Category | Colour |
   |---|---|
   | Errors | red |
   | Contrast | brown |
   | Alerts | yellow |
   | Features, including **alt text shown on the image** | green |
   | Structure | blue |
   | ARIA | purple |
   | Keyboard order | numbered |

   - Each category can be switched on and off.
   - Selecting a marker shows its details: the rule, what was found, the fix and a WCAG reference.
   - **Alt text appears on the image itself**, as WAVE does.
6. **More checks: port WAVE's heuristics that axe and HARgus lack.**
   - Possible heading (short, bold or large text that isn't a heading).
   - Possible list.
   - Redundant adjacent links to the same URL.
   - Broken in-page (`#`) links.
   - `fieldset` without `legend`.
   - Empty, multiple or orphaned labels.
   - `title` attributes that duplicate the label.
   - Vague link text, extending the word list.
   - Very small text.
   - Justified text.
   - Underlined non-links.
   - Layout tables.
   - Missing captions on media.
   - Plus the WAVE alt checks in goal 2.

   **Every check, ours or axe's, has plain fix-it reference text** (what, why, how to fix, WCAG success criterion), shown in its detail.
7. **Calibration.**
   - Add the GDS test page and thymecare.com to `scripts/calibrate.mjs`'s targets.
   - Record, in `docs/research/`, a before-and-after table of GDS barriers detected (by GDS test-case id) for HARgus, compared with the GDS study's WAVE and axe results.

## Non-goals

- Interactive live annotation of the user's tab, like WAVE's injected page icons. Markers live on the screenshot in the report.
- Screen-reader simulation, or a full accessibility-tree dump.
- Manual-testing checklists or guided audits.
- Replacing axe's rule logic with our own. Where axe and a HARgus check overlap, keep one finding (see Decided).

## Anti-goals

- **A noisier report that is no more trustworthy.** Duplicate findings from axe and HARgus for the same problem, or alerts shown as errors, would be a failure even with more coverage.
- **Markers in the wrong place.** A marker that points at the wrong element is worse than none. When the layout at marker time doesn't match the screenshot, say so and don't draw that marker.
- **A keyboard walk that changes the page for later views or leaves it scrolled or focused.** The walk restores focus and scroll, as every view restores its change.
- **Sending page content anywhere.** Everything stays local; axe runs in the page.

## Decided (by the designer, owner skipped questions)

- **Markers sit on the base full-page screenshot,** in the Accessibility area's new "Page map" panel.
  - **Element boxes** are collected in document coordinates by the page-phase collectors.
  - **Alignment:** they are scaled to the screenshot using its recorded document width and height. If the document size at collection differs from the screenshot's by more than 2%, the map shows a note and draws only markers whose element is still at the same place. The builder decides how to verify that.
- **Thumbnails** are CSS crops of the base screenshot, a background image with a position. No new image data is stored.
- **Report modes:**
  - **Interactive viewer:** category toggles, and click a marker for its details.
  - **Standalone export (no scripts):** markers and a legend with CSS-only toggles (checkbox hack), and details as `title` text plus a numbered list under the map.
  - **Print:** the map with all markers, plus the numbered list.
- **The keyboard walk is a capture step,** not a page-phase plugin, because it needs real key events.
  - It runs after the base screenshot and before the other views.
  - Before it starts, the page is scrolled to the top and focus is moved to the document start.
  - It stops at 250 stops, at 60 s, when it cycles, or when focus leaves the page.
  - Afterwards, focus is blurred and the scroll position restored.
  - Results go to `capture.keyboard`.
  - A new plugin, or an extension of `a11y-structure`, turns them into findings.
- **Overlap between axe and HARgus:**
  - When axe ran, HARgus heuristics that duplicate an axe rule are suppressed, and axe's finding wins. Examples: missing alt (`image-alt`), missing labels (`label`), document language (`html-has-lang`), empty headings (`empty-heading`), link names (`link-name`).
  - The suppression list is a table in code, with tests.
  - When axe didn't run (failed or turned off), HARgus's own checks report as now.
- **Severity:**
  - axe violations map as today: critical and serious to high, moderate to medium, minor to low.
  - axe incomplete and WAVE alerts are **info** (no score), shown in "Needs review".
  - WAVE-style errors ported to HARgus use medium or low, matched to their axe equivalents where one exists.
- **The axe version** is recorded in the reading.

## Decided after the builder check (designer's calls)

1. **Which screenshot markers sit on.**
   - Markers use the base view's full-page shot. Its recorded clip box (`cssWidth`/`cssHeight` from `shoot()`) is the coordinate frame. The shot is cropped at 1.5× the viewport width and 20,000 CSS px in height.
   - Elements outside the clip box are not drawn. The map shows "N markers lie beyond the captured image".
   - The 2% mismatch rule compares the document size at collection with the document size recorded for the shot, not with the clip box.
   - With no full-page shot (full-page off, or the shot failed), the map uses the base viewport shot and draws only elements inside the first viewport, with a note.
2. **What the keyboard walk may do.** It sends **Tab only**. It never presses Enter or Space, and never activates anything.
   - **Skip links** are judged statically: the first stop is a same-page link whose target exists, is not hidden, and is focusable or is a landmark or heading.
   - **Page reactions:** if the page navigates or reloads during the walk, the walk aborts, records `aborted: 'navigated'`, and the capture continues. Menus opening on focus are accepted, because that is real keyboard behaviour.
   - **Setting:** the walk is a capture setting, `capture.keyboardWalk`, on by default, beside the focus check.
3. **Where the walk runs:** right after the focus probe and before the page-phase plugins, writing `hp.capture.keyboard`. Its 60 s cap sits inside the existing capture flow, and no new overall limit is introduced.
4. **Boxes for markers.**
   - A page-phase collector resolves every flagged element to a document-coordinate box:
     - axe targets, raised to up to 50 nodes per rule for markers, while finding evidence still shows 5;
     - HARgus heuristic samples;
     - images;
     - contrast samples;
     - keyboard stops, taken from the walk.
   - Findings stay as they are. Marker data lives in a single `data.marks` list owned by a new `a11y-map` plugin: `{ category, label, ruleId, box, alt? }`.
   - The map draws at most 400 markers, with a note "N more not drawn" and priority errors > contrast > alerts > the rest.
5. **The export follows the existing export.**
   - It reuses the screenshot that is already inlined.
   - Markers are absolutely positioned elements with percentage coordinates, and the toggles are CSS-only.
   - It has no separate size cap beyond the 400-marker cap.
6. **axe-core.**
   - `extension/plugins/vendor/axe.min.js` and `LICENSE-axe-core.txt` (the MPL-2.0 text) are committed. Remove the `vendor/*.js` gitignore line for that file.
   - **Default on for everyone who never changed the setting.** The settings layer treats a missing stored value as the new default. Users who explicitly turned axe off keep it off.
   - `resultTypes` becomes `['violations', 'incomplete']`.
   - If axe times out or fails, the reading records a warning, and HARgus's own checks report unsuppressed.
7. **Calibration source.** The GDS audit repo (https://github.com/alphagov/accessibility-tool-audit) publishes per-test-case results for WAVE and axe.
   - The plan fetches those once into `docs/research/gds-audit-results.*`.
   - HARgus's per-case detection is recorded beside them.
   - The ≥ WAVE target is **recorded, not a gate**.
8. **The overlap table** is a full table built in the plan. It covers every HARgus accessibility heuristic, each marked as suppressed-by or overlapping a named axe rule, or as unique. The plan must list it for review. Overlaps that are only partial are kept, not suppressed: for example our contrast plugin, which checks more than axe does, and heading order.

## Constraints

- No new runtime dependency other than the bundled axe-core file and its licence.
- Untrusted page strings stay escaped through `html`: alt text, accessible names and HTML snippets. HTML snippets are shown as code, never rendered.
- No `NaN`, `undefined` or `Infinity` in output.
- Bounded work:
  - collectors capped by element count and time, as other collectors are;
  - the keyboard walk capped as above;
  - axe's own timeout raised only if needed, with the plugin's `timeoutMs` 60 s today.
- Works in the standalone export and print, as well as the interactive viewer.
- Existing e2e and unit tests stay green. Update tests that pinned axe's opt-in status.

## Testing

- **Unit:**
  - the alt verdicts (each rule's boundary: 15 characters for redundant, 100 for long, the suspicious word list, the filename pattern);
  - the overlap suppression table;
  - marker placement maths, including the more-than-2% mismatch rule;
  - keyboard-walk analysis: trap, lost focus, hidden stop, no name, no visible change, skip link;
  - each new WAVE heuristic;
  - the reference text existing for every finding id.
- **E2E fixture additions:**
  - images with each alt problem;
  - a keyboard trap (a widget that catches Tab);
  - a positive `tabindex`;
  - a hidden focusable element;
  - a broken skip link;
  - a `fieldset` without `legend`;
  - a possible heading.

  Assert:
  - the Images panel lists them with the right verdicts;
  - the keyboard walk records stops and detects the trap (bounded), and the page is restored;
  - Page map markers render with toggles in the viewer and in the export;
  - axe runs by default and needs-review items appear.
- **Calibration (manual, documented):** GDS test page and thymecare.com, before and after.

## Left to the builder

- **Where the new UI panels live in the Accessibility area,** and the order of panels.
- **How to verify a marker's element** is still in place when document sizes differ.
- **How the walk detects cycles and traps.** For example: the same element stopped on twice with no new stops in between, or the walk stuck on a small set.
- **The exact word lists** for suspicious alt and vague links. Start from WAVE's, in the research TSV.
- **Whether keyboard findings live in `a11y-structure`** or in a new `keyboard` plugin.
- **How to split this into plan tasks.** Suggested order: axe on by default → Images & alt → keyboard walk → outline → Page map markers → WAVE heuristics and reference text → calibration.
