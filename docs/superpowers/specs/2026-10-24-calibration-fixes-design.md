# Calibration fixes and loose ends — design

Date: 2026-10-24. Status: draft for approval.

## Why

This was the first run on the 10 standard sites (`node scripts/calibrate.mjs`) since these features landed:
- translated views;
- language and text checks;
- axe turned on by default;
- alt verdicts;
- page-map markers;
- the keyboard walk with banners set aside.

Real sites turned up false positives that the test fixture never showed, the same as thymecare did. The user wants the calibration bugs fixed (item 1) together with the known loose ends from earlier batches (item 2).

The user skipped the brainstorm questions for this round. Every design choice below is mine and is marked **(my call)**.

**Goal:** every finding HARgus shows on these sites is either true or is wording a tester would agree with. No problem is counted twice, and no area score bottoms out on a page that is mostly fine.

**Non-goals:**
- new analysis areas;
- changes to how translated views work;
- making headless calibration faster. In headless Chromium the translation times out, and that is expected.

**Anti-goal:** hiding real problems. Every fix narrows a check to what is actually wrong. It must not mute the check.

## A. Calibration bugs (most misleading first)

Each item gives the evidence from the triage, the cause, and the fix.

### A1. A focus ring on a wrapper is reported as no focus style

- **Evidence:** Le Monde got "46 keyboard stops show no visible focus change". The ring is on the card wrapper `.ds-card__linked__post__clickarea`. react.dev's 2 search inputs are probably the same case.
- **Cause:** `keyboard-walk.js` (around lines 138 and 203) and `core/focus.js:11` compare only the focused element's own styles.
- **Fix (my call):** when the element's own styles don't change, also compare up to 4 ancestors whose border box contains the element's box within 4px, plus the element's first element child (4 and 4px since the follow-on: on Le Monde the card heading sits 2px above its click area, and on lifestyle cards the click area is the 4th such ancestor). The element's and these relatives' ::before/::after count too, including a pseudo-element that appears only on focus (content none until then, as Le Monde's `.ds-card__clickarea:has(a:focus-visible)::after`): it counts when it draws a ring (outline, shadow or border, or a background on a box of its own), never when it is display:none. Compare outline, box-shadow, border colour or width, background colour and text-decoration. A change on any of them means the stop has a visible focus style. The stop's detail says where the style is ("focus style on its parent card").

### A2. Frame stops are judged for focus style

- **Evidence:** asahi had 16 no-focus-style stops, all ad iframes. BBC had 1, its consent iframe.
- **Cause:** `keyboard.js:233` does not skip stops where the focus is in a frame.
- **Fix:** frame stops are not judged for focus style, because their contents can't be inspected. The Keyboard order table marks them "inside a frame — not checked".

### A3. Label and alt language is judged as one joined block

- **Evidence:**
  - asahi: "18 label texts in Dutch". These are ad iframe titles, "3rd party ad content".
  - Wikipedia: "3 alts in Polish", but the alts are English.
  - Le Monde: "5 French labels", of which 3 are English.
- **Cause:** `language.js:200-210` joins all the texts, detects the language once, and then reports every item in the group under that language.
- **Fix (my call):**
  - Detect each text on its own, and only when it has at least 20 letters. Shorter texts aren't judged.
  - Group the findings by the language detected for each text. The count is the number of texts that were themselves detected in that language.
  - Leave out the titles of cross-origin iframes. The page author usually doesn't write them; ad tags inject them.

### A4. A cookie banner that isn't fixed is missed, and the skip-link check counts it

- **Evidence:** gov.uk's cookie banner is an ordinary `role=region` block at the top of the page, so it was missed. The result was a false "No skip link", because the skip link comes after the banner's buttons.
- **Cause:**
  - Banner detection (`keyboard-walk.js:79-88`) only accepts fixed or sticky boxes.
  - The skip-link check (`keyboard.js:256`) doesn't skip banner stops.
- **Fix:**
  - A block also counts as a consent banner when all of these are true (my call):
    - it is in the normal flow;
    - it holds the first Tab stops;
    - it contains consent words, using the existing list;
    - it contains at least one accept or reject button.
  - It is reported as banner kind `inline`. It is not set aside, because it doesn't block the page.
  - The skip-link check and the "first stop" logic start after any run of banner stops at the start of the walk. A skip link that is the first stop after the banner passes.

### A5. The same problem reported by both axe and our check

- **Evidence:** react, asahi and Al Jazeera.
- **Cause:** in `a11y-overlap.js`, three rows are marked `keep` even though axe now reports these problems:
  - `label-in-name`, against axe `label-content-name-mismatch`. The comment saying the axe rule never runs is wrong; it does run.
  - `headings-skipped`, against `heading-order`.
  - `targets-24`, against `target-size`.
- **Fix:** all three rows become `mode: 'suppress', when: 'reported'`. Our finding yields when axe reported the rule on this page. When axe ran and found nothing, ours still shows, so its wider coverage stays. Correct the comment.

### A6. The Accessibility score bottoms out

- **Evidence:** Wikipedia's Web accessibility article scored 0, which is below asahi's 10.
- **Cause:** `score.js:49-50`:
  - each axe rule deducts on its own;
  - axe best-practice rules (not WCAG failures) count as medium;
  - the caps add up to 105.
- **Fix (my call):**
  - Findings from axe rules tagged only `best-practice` count as **low**.
  - The `CAP` values become high 55, medium 30 and low 15, so the caps total 100. This applies to every area.
- **Acceptance:** re-run calibration. Wikipedia's accessibility score should be above asahi's, and no site should score 0 unless it has high-severity barriers. Record the before and after scores for every site in the calibration memory.

### A7. Skip-link target false positives

- **Evidence:**
  - MDN's `#content` is a `display:contents` `<main>`. It has no box, so it was called hidden.
  - Wikipedia's title said "missing or hidden" for a target that exists and is visible.
- **Cause:** `keyboard-walk.js:231`.
- **Fix:**
  - A `display:contents` target is judged by the union of its children's boxes.
  - Separate findings say "target missing" and "target hidden". Wikipedia's actual failure, whatever the walk reports, gets the precise one of these. The implementer confirms which on the live page.

### A8. Transparent inputs laid over their labels counted as hidden stops

- **Evidence:** Wikipedia's 6 menu checkboxes have opacity 0 and sit exactly over their visible label buttons.
- **Cause:** `keyboard-walk.js:153` and `:187`.
- **Fix:** an opacity-0 or clipped input is not a hidden stop when its associated `<label>`, or the element at its centre point, is visible and covers at least half of its box.

### A9. "Focus lost" when the focus actually went into an iframe

- **Evidence:** BBC got "Focus lost 1 time". Live, Tab goes straight into the consent iframe.
- **Cause:** `capture.js:1756` reads the focus before it has settled.
- **Fix:** when `activeElement` reads as body, read it again after one animation frame, up to 2 times. A frame element holding focus counts as a frame stop, not as lost focus.

### A10. Text hidden for screen readers treated as the visible label

- **Evidence:** a label-in-name false positive on gov.uk.
- **Cause:** `a11y-structure.js:105` takes the visible label from `textContent`.
- **Fix:** the visible label leaves out:
  - text inside visually-hidden elements, meaning a 1px clip or `clip-path: inset(50%)`, the sr-only pattern;
  - text inside `aria-hidden` elements, which stays out of the comparison for now.

  The check compares what a sighted user reads.

### A11. Inflated focusable totals

- **Evidence:** MDN reported 396 focusables, but about 150 are reachable. 247 of them are inside closed `<details>`.
- **Cause:** `keyboard-walk.js:55`.
- **Fix:** the total leaves out the content of closed `<details>` (each `<summary>` still counts), `inert` subtrees, `hidden` or `display:none` subtrees, and `visibility:hidden` elements. This total feeds the walk-confined check.

### A12. Smaller fixes

- **a. One note for translation failures:** a translation failure that is the same for every language becomes one note naming all the languages (`international.js:93`). This follows the "group it" decision.
- **b. Generic alt text in other languages:** the generic-alt word list gains common non-English equivalents of "image", "photo" and "picture" (my call): 画像, 写真, 이미지, 사진, 图片, صورة, Bild, Foto, image, photo, imagen, immagine, изображение, фото, תמונה. Apply them with the same whole-alt matching as the English words.
- **c. Sticky stops (deferred):** MDN's 28 sticky table-of-contents stops are not drawn on the page map. This stays a known limit, because placing sticky boxes in a full-page shot is guesswork. The map already counts them as unplaced, so the only fix is wording: "sticky — not drawn".

### A13. New check: a non-modal banner covering focused stops (WCAG 2.4.11)

- **Evidence:** BBC's consent overlay covers most of the screen while 118 stops are focused behind it. No check caught this. The user called cookie banners important ("lots of sites have those").
- **Fix (my call):**
  - In the page phase, while a detected banner stays shown (not set aside, because it wasn't a trap), check each stop's viewport rectangle against the banner's rectangle.
  - Stops entirely covered fail WCAG 2.4.11 (Focus Not Obscured, Minimum, AA). They are reported as a new finding `kb-obscured`, severity medium: "N keyboard stops are hidden behind the cookie banner". The examples and the banner are named.
  - Stops at least half covered are counted in the detail only.
  - The finding gets a row in `a11y-reference.js` and in the overlap table (`unique`).

## B. Loose ends from earlier batches

### B1. The embedded-area note names only frames and canvases

The info note "N embedded areas can't be translated" (`international.js:127`) builds its detail from `leftoverDetail`. That lists every cause and text examples, so it says things like "2 CSS-generated… For example…".

**Fix:** that note's detail lists only the frame and canvas causes for each language. The low-severity leftovers finding keeps the full breakdown.

### B2. Crowded markers

`placeMarks` stacks icons only for marks on exactly the same box. Nearby boxes, such as icon strips, logo walls and thumbnails, draw overlapping icons that can't be read or hovered.

**Fix (my call):**
- After the slots are set, run a pass that removes overlaps. Judge it at the assumed map width of 640px, in list order.
- A non-keyboard mark whose icon square (`ICON_PX`) would overlap an icon already drawn joins that icon's cluster. The first icon shows "+N" and a tooltip with the members' numbers.
- The folded marks keep their numbers and their list entries. They are not drawn separately.
- Keyboard stop numbers are never folded.
- Clusters form within one category (ruling during the build). The legend toggles hide whole categories, so a mixed cluster's "+N" would be wrong while one category is hidden. Icons of different categories can still sit next to each other.
- The pass works in the export too, since it is CSS-only.

### B3. Reference boxes spread through the page, and a check for each region

The reference boxes are the first 3 headings, and these are usually near the top. Lazy content inserted partway down moves everything below it, but the check still says "only grew", so markers below the insertion are misplaced.

**Fix:**
- `refBoxes` takes up to 8 boxes, spread evenly by document position. They are chosen from rendered headings, and if there are fewer than 8 headings, from landmarks and then images.
- In `placeMarks`:
  - When the document only grew and every reference box is still in place, keep the current behaviour (`grew`).
  - A reference box counts as in place when any box found at collect time sits within 2px of it on x, y and width. Boxes are matched by position, not by order, so lazy content added below the fold doesn't make them read as moved (ruling during the build).
  - When some reference boxes moved, keep the marks above the first moved box. Withhold the marks at or below it, count them in `withheld`, and set `out.shiftedAt`. The map says "markers below this point are withheld because the page changed after the screenshot".

### B4. E2E test for a consent banner in a cross-origin iframe

Add a new fixture page imitating Sourcepoint:
- a `div[id^="sp_message_container"]` wrapping `iframe#sp_message_iframe_1`;
- the iframe is served from `http://localhost:<port>` while the page is on 127.0.0.1;
- the frame holds three buttons;
- a fixed overlay covers the page.

The test asserts:
- the banner phase detects the CMP, with tool Sourcepoint;
- the frame is set aside and restored exactly, using the existing restore check;
- the page phase reaches the page's own focusables;
- the banner finding matches what the walk saw: a trap gives `kb-banner-trap`, otherwise `kb-banner-modal`.

Also add an end-to-end case for A4's inline banner, modelled on the gov.uk shape, to the existing consent fixture or a sibling page. It asserts that no false "No skip link" is reported.

### B5. One list of vague link words

`a11y-structure.js:240` repeats `VAGUE_LINK_WORDS` as a fallback. `collectArgs` always passes the list.

**Fix:** drop the literal list. If the args are missing, skip the vague-link check and record `vagueSkipped: true` in the plugin data.

## Acceptance

- `npm test` and `npm run test:e2e` pass.
- Each A item has a unit test built from the shape the triage found, such as a wrapper ring, a `display:contents` main, or an overlaid checkbox.
- Re-run `node scripts/calibrate.mjs` on the 10 sites and compare it with this run:
  - the A1–A11 false positives are gone;
  - no real finding has disappeared;
  - the scores before and after go into memory.
- Re-run `--a11y` on the GDS page and thymecare. The GDS detection count must not drop below 44, and the thymecare banner must still be set aside and restored.

## Left to the builder

- Exact wording of new detail lines, within the house style: plain, counts first.
- How the ancestor focus-style comparison reads computed styles, as long as the walk is not slowed by more than 10%.
- Where A4's inline-banner detection lives, either in the walk or in `isBanner`.
