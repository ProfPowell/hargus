# Calibration Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the false positives, duplicate findings and score anomalies found on the 10 calibration sites, add the obscured-by-banner check, and close five loose ends.

**Architecture:** Keyboard-walk page code (`extension/browser/keyboard-walk.js`, serialised and self-contained) records the facts. `capture.js keyboardWalk` drives Tab, and `core/keyboard.js analyzeKeyboard` (pure) turns the facts into findings. Language, overlap, scoring, international and page-map fixes stay in their own modules. Every fix narrows a check; none of them mutes one.

**Tech Stack:** Plain ES modules, a Chrome MV3 extension, `node --test` for units, and a Playwright e2e run (`test/e2e/run.mjs`, fixtures in `test/e2e/site/`).

**Spec:** `docs/superpowers/specs/2026-10-24-calibration-fixes-design.md` (sections A1–A13 and B1–B5 are referenced below).

## Global Constraints

- Page-phase functions (`kbStart`, `describeFocus`, plugin `collect`) are serialised through `fnSource`. They must be self-contained, with no imports and no closure over module scope. Shared code is injected only through `pageDeps`.
- Install with `npm install --no-package-lock`. There is no lockfile, and you must not add one.
- Finding ids stay stable. A new id needs a `REFERENCE` row in `core/a11y-reference.js` and a row in `OVERLAP` in `core/a11y-overlap.js`. A test already enforces both.
- Wording is plain and puts counts first, in the style of the existing findings (for example "N keyboard stops show…").
- The walk must not get slower by more than 10% on the e2e fixture (A1 adds style reads).
- Both `npm test` and `npm run test:e2e` must pass at every commit.
- The worktree guard rejects compound shell commands that involve git. Run `git add` and `git commit` as separate commands.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A wrapper whose style changes on hover or for another reason, not focus.** The ancestor comparison must use the snapshot taken before the walk and the style while focused. A wrapper that never changes must not count as a focus style. Pinned in Task 1.
2. **A page with both an inline banner (A4) and a real skip link inside the banner.** The banner's own "skip" link must not be taken as the page's skip link. Pinned in Task 3.
3. **Short label texts in the majority language mixed with long ones in another language.** Only texts that were themselves detected in the other language are counted. Pinned in Task 4.
4. **A cluster of marks in which a keyboard stop number sits among image icons.** The stop numbers stay drawn and the icons fold around them. Pinned in Task 7.
5. **A moved reference box whose y equals a mark's top.** That mark counts as "at or below" and is withheld. Pinned in Task 7.

---

### Task 1: Focus style on a wrapper or child (A1), frame stops not judged (A2)

**Files:**
- Modify: `extension/browser/keyboard-walk.js` (`kbStart` style snapshot around line 47; `describeFocus` output around line 203)
- Modify: `extension/core/focus.js` (add `nearFocusChange`)
- Modify: `extension/browser/capture.js:1766` (where `changed` is computed)
- Modify: `extension/core/keyboard.js` (the `blind` filter around line 233)
- Modify: `extension/plugins/a11y-structure.js` or the Keyboard order table renderer (wherever the per-stop "focus style" cell is drawn), so frame stops read "inside a frame — not checked"
- Test: `test/focus.test.mjs` (new), `test/keyboard.test.mjs`, `test/keyboard-walk.test.mjs`

**Interfaces:**
- Produces: `nearFocusChange(near: Array<{ rel: 'parent'|'grandparent'|'ancestor'|'child', before, after }>) -> { rel, changes: string[] } | null` in `core/focus.js`. It returns the first entry whose `focusChanges(before, after)` is non-empty.
- Produces: the `describeFocus` output gains `near: [{ rel, before, after }]` (stripped by capture like `before` and `after`). A stop gains `changedOn: 'parent'|…` when only a near element changed. `changed` is true in that case.
- Produces: frame stops get `changed: null` and `focusNotChecked: 'frame'`.

- [ ] **Step 1: Write the failing tests**
  - In `test/focus.test.mjs`, `nearFocusChange picks the first changed relative`: given an outline that appears on the `parent` entry only, it returns `{ rel: 'parent', changes: ['outline'] }`. Given no changes on any entry, it returns `null`.
  - In `test/keyboard.test.mjs`:
    - `a stop whose ring is on its wrapper is not reported`: a stop `{ changed: true, changedOn: 'parent' }` gives no `kb-no-focus-style`.
    - `frame stops are not judged for focus style`: a stop `{ frame: true, changed: false }` gives no `kb-no-focus-style`, and a non-frame stop with `changed: false` is still reported.
- [ ] **Step 2: Run `node --test test/focus.test.mjs test/keyboard.test.mjs`.** Expected: FAIL, because `nearFocusChange` is not exported and the frame stop is reported.
- [ ] **Step 3: Implement.**
  - **`kbStart`:** for each focusable element already snapshotted (the existing cap of 5000 elements), also snapshot the same `KEYS` styles for these near elements:
    - up to 3 ancestors whose border box contains the element's box (within 1px), tagged `parent`, `grandparent` and `ancestor`;
    - its first element child, tagged `child`.

    Store them in the same `styles` WeakMap. `describeFocus` reads `kb.styles` for the same near elements and emits `near` only when its own `before` and `after` show no change, which keeps the payload small.
  - **`capture.js`:** when `focusChanges` is empty, call `nearFocusChange(near)`. On a hit, set `changed = true`, `changedOn = rel` and `changes`.
  - **Frame stops:** set `changed = null` and `focusNotChecked = 'frame'`.
- [ ] **Step 4: Add `test/keyboard-walk.test.mjs` `describeFocus reports near styles for a wrapper-ring stop`.** Model it on the existing describeFocus tests in that file: a link inside a div that gains an outline under `:focus-within`, with an assertion that `near[0].rel === 'parent'`. If that file has no DOM harness for this, put the case in the e2e fixture instead (Task 8 owns the fixture; leave a note in the report).
- [ ] **Step 5: Run `npm test`.** Expected: all pass.
- [ ] **Step 6: Commit.** Use the message "Keyboard walk: a focus ring on the wrapper or child counts; frame stops aren't judged for focus style".

### Task 2: Stop facts. Display:contents skip targets (A7), overlaid inputs (A8), lost focus into an iframe (A9), inflated totals (A11)

**Files:**
- Modify: `extension/browser/keyboard-walk.js` (`describeFocus` skip target around line 231 and the visible/clipped logic around lines 153–187; `kbStart` tabbable count around line 55)
- Modify: `extension/browser/capture.js` (the phase loop around line 1753, where `objectId` is missing)
- Modify: `extension/core/keyboard.js` (the `kb-skip-target` finding)
- Modify: `extension/core/a11y-reference.js` (see below)
- Test: `test/keyboard.test.mjs`, `test/keyboard-walk.test.mjs`, `test/capture-helpers.test.mjs` if the settle loop is factored as a helper

**Interfaces:**
- Produces: `out.skip.visible` is true for a `display:contents` target when any child has a client rect.
- Produces: `kb-skip-target` titles that split into "The skip link's target is missing" (when `!exists`) and "The skip link's target is hidden" (exists but not visible). "Not focusable, a landmark or a heading" keeps its own title, "The skip link's target can't take focus". The id stays `kb-skip-target`, so update the `REFERENCE` "what" text to cover all three.
- Produces: `start.focusableCount` and `start.focusableAll` leave out descendants of a closed `<details>` other than its first `<summary>`, plus `[hidden]` subtrees, `display:none` subtrees and `visibility:hidden` elements. The existing `getClientRects` check already covers most of these; the closed-details case is the new one.

- [ ] **Step 1: Write the failing tests** in `test/keyboard.test.mjs`:
  - `skip target missing and hidden read differently`: skip `{exists:false}` → the title matches `/missing$/`; skip `{exists:true, visible:false}` → `/hidden$/`.
  - `a focus that settles on a frame is not lost`: this is covered through capture. Add the settle as a pure helper `settleActive(read: () => Promise<objectId|null>, frames = 2) -> Promise<objectId|null>` in `extension/browser/capture.js` (exported for tests) and test it with a stub that returns null and then an id. Expected: the id.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **A7:** a `display:contents` target uses the union of its children's rects for `visible`.
  - **A8:** in `describeFocus`, before declaring `visible = false` for an input with `opacity:0` or clipping, check the element at the centre of the input's rect via `elementFromPoint`. If that element, or any of `el.labels`, is visible and covers at least 50% of the input's box, then `visible = true` and `overlaid = true`.
  - **A9:** when `kbActive` returns null, call `settleActive`. It re-reads after `requestAnimationFrame`, up to 2 times, before recording `{ none: true }`. Do the wait inside the page with an awaited `Runtime.evaluate` of a promise that resolves on rAF. A frame element that holds focus is already returned by `kbActive`, because an iframe is the active element.
  - **A11:** in `kbStart`'s `tabbable` filter, add `!el.closest('details:not([open]) > :not(summary:first-of-type)')` (also check through the `up` chain for shadow DOM), plus `!el.closest('[hidden]')`.
- [ ] **Step 4: Add `test/keyboard-walk.test.mjs` cases** in that file's existing style, if it can run page functions against a DOM; otherwise in the e2e fixture (note it for Task 8):
  - a checkbox at `opacity:0` laid over its label → `visible: true`;
  - a `display:contents` `main#content` → `skip.visible: true`;
  - 5 links inside a closed `<details>` → not counted.
- [ ] **Step 5: Run `npm test` and `npm run test:e2e`.** Expected: all pass.
- [ ] **Step 6: Commit.** Use the message "Keyboard walk: display:contents targets, overlaid inputs, settled focus, closed details not counted".

### Task 3: Inline consent banners (A4) and the obscured-by-banner check (A13)

**Files:**
- Modify: `extension/browser/keyboard-walk.js` (`kbStart` banner search around lines 79–96; `describeFocus` for the obscured test)
- Modify: `extension/core/keyboard.js` (`skipLinkStop`, the `kb-no-skip-link` and first-stop logic around line 256, and the new `kb-obscured`)
- Modify: `extension/core/a11y-reference.js` and `extension/core/a11y-overlap.js` (a `kb-obscured` row, `mode: 'unique'`)
- Test: `test/keyboard.test.mjs`, `test/a11y-overlap.test.mjs` (existing coverage test)

**Interfaces:**
- Produces: `start.consent` may be `{ sel, kind: 'inline' }` for a flow (non-fixed) banner. An inline banner is never set aside. `isBanner` is unchanged; the inline kind is only reported.
- Produces: in a page phase, a stop gains `obscured: 'full' | 'half'` when the consent element is shown and not set aside, and its viewport rect at focus time covers the stop's viewport rect entirely (`full`) or by at least 50% of its area (`half`). Stops inside the banner are never obscured.
- Produces: `firstPageStop(stops) -> stop | undefined` in `core/keyboard.js`. It returns the first real stop after the leading run of `inConsent` stops. `skipLinkStop` and the `kb-no-skip-link` / `kb-skip-target` logic use it.
- Produces: finding `kb-obscured`, severity `medium`, title `${n} keyboard stops are hidden behind the cookie banner` (singular "stop is"), evidence = selectors, detail naming the banner selector and the `half` count ("M more are half covered"). WCAG 2.4.11.

- [ ] **Step 1: Write the failing tests** in `test/keyboard.test.mjs`:
  - `a skip link right after an inline banner counts`: stops `[{inConsent:true,…},{inConsent:true,…},{skip:{exists:true,visible:true,focusable:true}, sel:'a.skip'}]`, a complete walk → no `kb-no-skip-link`.
  - `a skip link inside the banner is not the page's skip link`: the first stop is `{inConsent:true, skip:{…}}` and the first page stop has no skip → `kb-no-skip-link` is reported (Review Focus 2).
  - `stops behind a shown banner are reported once`: 3 stops with `obscured:'full'` and 2 with `'half'` → one `kb-obscured`, title `3 keyboard stops are hidden behind the cookie banner`, detail containing `2 more are half covered`.
  - `no obscured finding when only half covered`: only `'half'` stops → no finding.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Inline detection in `kbStart`:** if there is no tool or fixed match, look for an element that meets all of these:
    - matches `[role="region"], [role="dialog"], section, div, aside, form`;
    - its text matches the existing cookie/consent regex;
    - it contains a button whose text matches `/\b(accept|reject|agree|decline|allow|deny)\b/i`;
    - it contains the first tabbable element in document order;
    - it is no more than 40% of the document height.

    Take the outermost such element below `body`.
  - **`describeFocus`:** when `kb.consentEl` is set, connected, shown and not set aside, and the stop is not inside it, compute coverage from the two `getBoundingClientRect`s.
- [ ] **Step 4: Run `npm test`.** Expected: all pass, including the overlap and reference coverage tests.
- [ ] **Step 5: Commit.** Use the message "Keyboard walk: inline cookie banners, skip link judged after the banner, stops hidden behind a banner (2.4.11)".

### Task 4: Label and alt language judged one text at a time (A3)

**Files:**
- Modify: `extension/plugins/language.js:196-213` (the L5 attribute block) and the `ATTRS` collection near line 501
- Test: `test/language.test.mjs` (or the plugin test that covers L5; find it with `grep -n "label texts" test/*.mjs`)

**Interfaces:**
- Consumes: the existing `detect(text, minChars)`, `countedCode(d)`, `differs`, `languageName`.
- Produces: `ITEM_MIN_LETTERS = 20` (the count of `\p{L}` characters) and `MAX_ITEMS = 60` per group.

- [ ] **Step 1: Write the failing tests:**
  - `labels are judged one at a time`: on a `ja` page, with a stub detector returning `en` for "3rd party ad content" (an iframe title marked cross-origin) and `ja` for others → no label finding.
  - `only items detected in the other language are counted`: 4 Polish-looking alts plus 6 English alts on an `en` page, stub per text → title `4 alt texts are in Polish on a English page`, using the existing article wording.
  - `short texts are not judged`: alts under 20 letters → no detection call. Assert on the stub's call count.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - For each group, filter to items with at least `ITEM_MIN_LETTERS` letters, take the first `MAX_ITEMS`, and detect each one with `detect(text, 0)`, or with the detector's minimum if 0 is refused.
  - Bucket the items by `countedCode`, and emit one finding per code that `differs` from the declared language, with n equal to that bucket's size. Use the same severity and wording as before.
  - In `collect`, mark `title` attributes on `iframe` elements whose `src` origin differs from the page's origin, and leave them out of the label group.
  - Keep `attrChecked` / `attrDetected` semantics: checked when any item was judged, detected when any code was counted.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit.** Use the message "Language: alt and label texts judged one at a time; cross-origin frame titles left out".

### Task 5: Overlap rows (A5), visible label text (A10), one vague-word list (B5)

**Files:**
- Modify: `extension/core/a11y-overlap.js:48,55,60`
- Modify: `extension/plugins/a11y-structure.js:103-108` (`visibleText`) and `:239-240` (`VAGUE`)
- Test: `test/a11y-overlap.test.mjs`, `test/a11y-structure.test.mjs`

**Interfaces:**
- Produces: the rows `a11y-structure:headings-skipped`, `a11y-structure:label-in-name` and `a11y-structure:targets-24` become `{ mode: 'suppress', when: 'reported' }`, with comments explaining that ours yields when axe reports the same rule on this page and stays otherwise. Delete the wrong "never runs" comment.
- Produces: `data.vagueSkipped: true` from a11y-structure when `args.vague` is missing or empty, and the vague-link check doesn't run in that case.

- [ ] **Step 1: Write the failing tests:**
  - `label-in-name yields when axe reports label-content-name-mismatch`, and `stays when axe ran it and passed`. Do the same pair for heading-order and target-size. Follow the existing `suppressedBy` tests.
  - `visible label leaves out visually-hidden text`: a button with `aria-label="Search the site"` containing `<span class="sr">GOV.UK</span>Search`, where `.sr` uses `clip-path: inset(50%)` or a 1px clip → not flagged. Use the existing a11y-structure collect test harness.
  - `no vague list, no vague check`: collect with `args = {}` → `vagueSkipped: true` and no vague links.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `visibleText` works on the live tree, not on a clone. It walks text nodes and skips any whose ancestor is `aria-hidden="true"`, or computes as visually hidden: `clip: rect(0px, 0px, 0px, 0px)`, `clip-path` starting with `inset(50%`, or width and height of 1px or less with overflow hidden.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit.** Use the message "Accessibility: our checks yield to axe's same rule when it reports; visible label excludes screen-reader-only text; one vague-word list".

### Task 6: Scores that don't bottom out (A6)

**Files:**
- Modify: `extension/plugins/axe.js:50` (the severity mapping)
- Modify: `extension/core/score.js:50` (`CAP`)
- Modify: `docs/PLUGINS.md` (the scoring formula section, with the new caps)
- Test: `test/score.test.mjs`, the axe plugin test (`grep -ln "axe" test/*.mjs`)

**Interfaces:**
- Produces: `CAP = { high: 55, medium: 30, low: 15, info: 0 }`.
- Produces: an axe violation whose tags hold no `wcag*` tag, only `best-practice`, gets severity `low` whatever its impact.

- [ ] **Step 1: Write the failing tests:**
  - `caps total 100`: `CAP.high + CAP.medium + CAP.low === 100`.
  - `an area with every cap hit scores 0, and one under the high cap scores above 0`, using the existing score test helpers.
  - `best-practice-only axe rules count as low`: a violation with `impact:'serious'` and tags `['cat.semantics','best-practice']` → severity `low`. With tags including `wcag2a` → it keeps its impact mapping.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Update any score tests that hard-code 60 for the high cap. Each such change must be the cap change only, so say which ones in the report.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit.** Use the message "Scoring: caps total 100; axe best-practice-only rules count as low".

### Task 7: International notes (A12a, B1), generic alt words (A12b), sticky wording (A12c), crowded markers (B2), spread reference boxes (B3)

**Files:**
- Modify: `extension/plugins/international.js:93-94` (per-language failure notes) and `:124-128` (embedded note detail)
- Modify: `extension/core/alt-verdict.js:19` (`WORDS`)
- Modify: `extension/core/refboxes-src.js`
- Modify: `extension/core/page-map.js` (`placeMarks` around lines 272–325, plus a new cluster pass)
- Modify: `extension/ui/report.js` (drawing `+N` cluster badges, the `shiftedAt` note, and "sticky — not drawn" wording wherever `unplacedStops` is shown)
- Test: `test/international.test.mjs`, `test/alt-verdict.test.mjs`, `test/page-map.test.mjs`, `test/report.test.mjs`

**Interfaces:**
- Produces, translation failure notes: when every failed language has the same `reason` but not all languages failed, emit one info note `${labels} views could not run — ${reason}` instead of one per language. Unverified failures stay separate.
- Produces, embedded note: the detail comes from `embeddedDetail(l) -> string`, which lists only the `iframe` and `canvas` causes through `CAUSE_WORDS`, with no examples, per language as `${label}: …`.
- Produces, generic alt words: `WORDS` gains `画像 写真 이미지 사진 图片 صورة bild foto imagen immagine изображение фото תמונה` (lower-case where the script has case). They are matched through the same normalised whole-alt test.
- Produces, `refBoxes() -> Array<[x,y,w,h]>`: up to 8 boxes, spread evenly by document y. Take rendered `h1–h6` first, then landmarks (`main, nav, header, footer, aside, [role=main]…`), then `img`. When there are more than 8 candidates, choose indices `round(i*(n-1)/7)`.
- Produces, `placeMarks` adds `out.shiftedAt: number | undefined` (the document y of the first moved reference box). The current `grew` path runs only when every box is in place. When only the height grew, the width is within 2%, the counts are equal and some boxes moved: `diff = 0`, `grew = true`, `shiftedAt = min y of the moved refs (shot-time y)`. Marks whose shot-document top y is ≥ `shiftedAt` are withheld (counted in `withheld`); keyboard and structure marks are withheld too, because they would be misplaced.
- Produces, `clusterMarks(placed, mapWidth = 640) -> void`: run at the end of `placeMarks`, in list order. Each non-keyboard mark gets `clusterOf: number` (the index of the anchor mark) when its icon square (`ICON_PX`, using the same icon position as drawing: corner, `out`, `slot`) overlaps an already drawn anchor's square. Anchors get `clusterSize: n` (members including itself). Keyboard marks are never members and never anchors.
- Produces, report: a member is not drawn. The anchor draws its icon plus a `+${clusterSize-1}` badge, with `title` listing the member numbers. List entries are unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `international.test.mjs`:
    - `translation failures with one reason make one note`: 2 of 3 failed with reason "timed out", 1 ok → one note naming both labels.
    - `embedded note names only frames and canvases`: leftovers `{causes:{iframe:2, cssContent:2}, examples:['x']}`, no text leftovers ≥3 → the detail contains `2 in an embedded frame` and does not contain `CSS-generated` or `For example`.
  - `alt-verdict.test.mjs`: `generic words in other languages are suspicious`, for `画像` and `Bild` → `suspicious`. `Bild der Woche: Hamburg` stays not suspicious.
  - `page-map.test.mjs`:
    - `refBoxes spread`: a pure test of the picking function. Export the index picker as `spreadIndices(n, k=8)` from `refboxes-src.js` and inline it into the serialised function the same way, via `pageDeps` or a copy guarded by a drift test like `test/keypath.test.mjs`. Expected: `spreadIndices(20)` → `[0,3,5,8,11,14,16,19]` and `spreadIndices(5)` → `[0,1,2,3,4]`.
    - `marks below a moved reference are withheld`: shot refs at y 100, 900 and 1800; now 100, 900 and 2100 (moved); a taller document; marks at top y 500 and 1800 → the first is kept, the second is withheld, and `shiftedAt === 1800` (Review Focus 5: the mark at exactly 1800 is withheld).
    - `all refs still → grew, nothing withheld`: keep the existing test passing.
    - `clustered icons fold, keyboard numbers don't`: 5 image marks on adjacent 10×10 boxes plus 1 keyboard mark among them → one anchor with `clusterSize: 5`, 4 members, and the keyboard mark without `clusterOf` (Review Focus 4).
  - `report.test.mjs`: `a cluster anchor shows +N and members are not drawn`.
- [ ] **Step 2: Run `node --test` on those files.** Expected: FAIL.
- [ ] **Step 3: Implement.** The sticky wording: the map's unplaced-stops note says `… sticky or fixed — not drawn` wherever it currently says the stops are unplaced. Change only the text.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit.** Commit in two parts if that is clearer: first "International notes, generic alt words in other languages", then "Page map: clustered icons fold into +N; reference boxes spread down the page, marks below a moved one withheld".

### Task 8: E2E coverage. A Sourcepoint-like cross-origin banner, a gov.uk-like inline banner, the obscured check, and the walk shapes from Tasks 1–2

**Files:**
- Create: `test/e2e/site/consent-sp.html` (page) and `test/e2e/site/consent-sp-frame.html` (the frame contents)
- Create: `test/e2e/site/consent-inline.html`
- Modify: `test/e2e/run.mjs` (new cases next to the OneTrust case at about lines 893–938)
- Modify: `test/e2e/site/` fixture pages for any Task 1 or Task 2 case that could not be unit-tested (see those tasks' reports)

**Interfaces:**
- Consumes: the server substitutes `__PORT__`. The page is loaded from `http://127.0.0.1:${port}` and the frame `src` is `http://localhost:__PORT__/consent-sp-frame.html`, which is cross-origin.
- Consumes: everything Tasks 1–3 produce (`changedOn`, `focusNotChecked`, `overlaid`, `start.consent.kind === 'inline'`, `obscured`, `kb-obscured`).

- [ ] **Step 1: Write the fixtures.**
  - **`consent-sp.html`:**
    - `<div id="sp_message_container_123" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5)">` wrapping `<iframe id="sp_message_iframe_123" src="http://localhost:__PORT__/consent-sp-frame.html">`;
    - the frame holds 3 buttons (Accept, Reject, Settings) and focuses Accept on load;
    - behind it, a page with a skip link, 10 links and a `main`.
  - **`consent-inline.html`:** modelled on gov.uk. A `<div role="region" aria-label="Cookies on this site">` at the top in normal flow, with "Accept additional cookies" and "Reject additional cookies" buttons. Then a skip link to `#main`, a header with 5 links, and `<main id="main">`.
- [ ] **Step 2: Write the e2e cases.**
  - **Sourcepoint:**
    - `banner.tool === 'Sourcepoint'`;
    - the banner was set aside and the existing restore check passes;
    - the page phase reached the skip link and the 10 links;
    - the banner finding is `kb-banner-trap` or `kb-banner-modal`, matching `banner.modal`;
    - no `kb-focus-lost`.
  - **Inline:**
    - `consent.kind === 'inline'`;
    - not set aside;
    - no `kb-no-skip-link`;
    - no `kb-banner-unreachable`.
  - **Obscured:** extend `consent-inline.html`, or add a third small page, with a fixed bottom banner covering a fixed band where 3 links sit, and that does not trap. Expect `kb-obscured` with count 3.
- [ ] **Step 3: Run `npm run test:e2e`.** Expected: "all e2e checks passed".
- [ ] **Step 4: Commit.** Use the message "E2E: cross-origin Sourcepoint banner, inline cookie banner, stops hidden behind a banner".

### After the tasks (controller, not a subagent task)

- Re-run `node scripts/calibrate.mjs` and `node scripts/calibrate.mjs --a11y` from the worktree. Compare against the previous digest, which is copied to the scratchpad before the run.
- Expected outcomes:
  - the false positives in A1–A11 are gone;
  - Wikipedia's Accessibility score is above asahi's;
  - GDS detection is at least 44;
  - thymecare's banner is still set aside and restored.
- Record the before and after scores in memory, in `har-plus-calibration.md`.
