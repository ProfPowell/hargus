# Translated Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** add German, Arabic and Japanese capture views that translate the page with Chrome's on-device Translator API. Each view is measured like the Long text view and flags text that stayed in English. Long text becomes a fallback that runs only when a translated view fails.

**Architecture:**
- **`extension/core/translation.js`** holds the pure decisions:
  - the view list;
  - error classification;
  - bail-out scope;
  - whether the fallback runs.

  It is unit-tested.
- **`extension/browser/translate-view.js`** holds self-contained page functions, run through `capture.evaluate` in the main world with a user gesture:
  - translate;
  - restore;
  - keep applied;
  - find leftovers.
- **`capture.js`** runs the three views, records `capture.translation`, and moves `pseudo` after them as the fallback.
- **`international.js` and `report.js`** turn the measurements into findings, glance items and Screens chips.

**Tech Stack:** vanilla ES modules, CDP (`Runtime.evaluate` with `userGesture`), Chrome's `Translator` API, `node --test`, and Playwright e2e with a fake translator injected via `addInitScript`.

**Spec:** `docs/superpowers/specs/2026-10-23-translated-views-design.md` (it includes the spike findings and every decided behaviour).

## Global Constraints

- **On-device only.** No cloud translation, proxy or key. If the on-device translator is unavailable, the view fails and the fallback runs.
- **Never hang or fail the reading.** Every translated view is bounded by `view()`'s `runMs`/`restoreMs`, and skips with a reason.
- **Restore the page exactly.** Restore puts back text nodes and attributes. An attribute is restored only if it still holds our translation.
- **No test code in the shipped extension.** The fake translator is injected only by the Playwright harness.
- **Output:** no `NaN`, `undefined` or `Infinity`. Untrusted text, such as leftover examples, stays escaped through `html`.
- **Commits** end with `Co-Authored-By: <model that wrote it> <noreply@anthropic.com>`.
- **Commands:** run `npm test` and `npm run test:e2e` from the repo or worktree root. The baseline is 597 tests, with e2e green.
- **Worktree guard:** compound shell commands with git are rejected. Do not commit a `package-lock.json`.

## Rulings made while planning

- **View ids and labels:**

  | id | lang | Label |
  |---|---|---|
  | `translated-de` | `de` | `German` |
  | `translated-ar` | `ar` | `Arabic` |
  | `translated-ja` | `ja` | `Japanese` |

  They are added to `INTERNATIONAL_VIEWS` after `rtl`, with `pseudo` last, so `LAYOUT_VIEWS` and the Screens card pick them up.
- **Self-check:** the probe kind is `translated`. It passes when at least 90% of the saved nodes that are still connected hold their translation. This mirrors `viewProbe('pseudo')`.
- **`create()` timeout:** 60 s, enough for a first download of about 15 s with headroom. Each view's `runMs` is 180 s. The `NotSupportedError` retry happens once, inside the page function.
- **The fallback decision lives in `core/translation.js`.** `capture.js` calls `needsFallback(translation, want)` before the `pseudo` view, and skips `pseudo` with reason `'not needed'` when it returns false.

## Review Focus

1. **A page that resets its text while translated.** React re-renders, live tickers. The keeper re-translates new text. Restore puts back the page's newest original, never our translation, as `pseudoText` does. Pinned in Task 2 (e2e: the fixture's existing re-rendering element ends the view with original English text).
2. **The page is already in the target language.** `<html lang="de">` skips the German view as "page is already in German", without triggering the fallback. Pinned in Task 1 (unit).
3. **The site blocks translation.** `Permissions-Policy: translator=()` fails all three views with one reason, and the fallback runs once. Pinned in Task 1 (unit) and Task 2 (e2e fallback path).
4. **Leftover text in a cross-origin iframe or in CSS `content`.** It is counted with its cause. Brand names the translator returned unchanged are not counted. Pinned in Task 2 (e2e: the fixture gains a `::before` content string and uses its existing cross-origin iframe, if present; otherwise add one).
5. **A translated view fails its self-check** because the page restored most text. The fallback runs and an info note appears. Pinned in Task 1 (unit for `needsFallback`) and Task 3 (unit for the note).

---

### Task 1: Pure translation decisions and view registration

**Files:**
- Create: `extension/core/translation.js`
- Modify: `extension/core/views.js` (`INTERNATIONAL_VIEWS`, `VIEW_LABELS`)
- Modify: `extension/browser/settings.js` (view toggles default `true` for the three ids)
- Test: `test/translation.test.mjs` (new)

**Interfaces (exports of `extension/core/translation.js`):**
- **`TRANSLATED_VIEWS`:** `[{ id: 'translated-de', lang: 'de', label: 'German' }, { id: 'translated-ar', lang: 'ar', label: 'Arabic' }, { id: 'translated-ja', lang: 'ja', label: 'Japanese' }]`.
- **`classifyError(message: string) → { reason: string, scope: 'all' | 'one' }`:**

  | Message contains | Reason | Scope |
  |---|---|---|
  | `Permission Policy` / `NotAllowedError` with "Permission" | `blocked by the site's Permissions-Policy` | `'all'` |
  | `Translator is not defined` / `no Translator` / `unavailable` | `translation unavailable in this browser` | `'all'` |
  | `create timed out` | `the translation model did not load in time` | `'all'` |
  | anything else | `translation failed: <first 80 chars>` | `'one'` |

- **`sameAsPage(viewLang, htmlLang) → boolean`:** compares primary subtags through `primary()` from `core/language.js`, which is already merged.
- **`needsFallback(translation: Record<id, {status, reason}>, want: Record<id, boolean>) → boolean`:**
  - It is true when any translated view has `status === 'failed'` and `want.pseudo !== false`.
  - `'skipped'` (turned off, or already in that language) never counts.
- **Views:**
  - `views.js`: `INTERNATIONAL_VIEWS = ['rtl', 'translated-de', 'translated-ar', 'translated-ja', 'pseudo']`.
  - `VIEW_LABELS` gains the three labels from the table above.
- **Settings:** `settings.js` view defaults gain the three ids as `true`.

- [ ] **Step 1: Write the failing tests** in `test/translation.test.mjs`:

```js
test('classifyError: page-wide vs per-language', () => {
  assert.deepEqual(classifyError("NotAllowedError: Access denied because the Permission Policy is not enabled."), { reason: "blocked by the site's Permissions-Policy", scope: 'all' });
  assert.equal(classifyError('ReferenceError: Translator is not defined').scope, 'all');
  assert.equal(classifyError('create timed out after 60 s').reason, 'the translation model did not load in time');
  assert.deepEqual(classifyError('NotSupportedError: Unable to create translator for the given source and target language.'), { reason: 'translation failed: NotSupportedError: Unable to create translator for the given source and target l', scope: 'one' });
});
test('sameAsPage compares primary subtags', () => {
  assert.ok(sameAsPage('de', 'de-AT'));
  assert.ok(!sameAsPage('de', 'en'));
  assert.ok(!sameAsPage('ja', ''));
});
test('needsFallback: only failures count, and pseudo can be turned off', () => {
  const ok = { status: 'ok' }; const off = { status: 'skipped', reason: 'turned off' }; const same = { status: 'skipped', reason: 'page is already in German' };
  const bad = { status: 'failed', reason: 'blocked' };
  assert.equal(needsFallback({ 'translated-de': ok, 'translated-ar': ok, 'translated-ja': ok }, {}), false);
  assert.equal(needsFallback({ 'translated-de': same, 'translated-ar': off, 'translated-ja': ok }, {}), false);
  assert.equal(needsFallback({ 'translated-de': ok, 'translated-ar': bad, 'translated-ja': ok }, {}), true);
  assert.equal(needsFallback({ 'translated-de': bad }, { pseudo: false }), false);
});
test('views: translated views registered between rtl and pseudo, labelled, on by default', async () => {
  assert.deepEqual(INTERNATIONAL_VIEWS, ['rtl', 'translated-de', 'translated-ar', 'translated-ja', 'pseudo']);
  assert.equal(VIEW_LABELS['translated-ar'], 'Arabic');
  // settings default: read the defaults object the way existing settings tests do
});
```

  Fill the settings assertion the way the existing settings tests read defaults (see `test/views-patch.test.mjs` or wherever `settings.js` defaults are tested).

- [ ] **Step 2: Run the tests and see them fail**

  Run: `node --test test/translation.test.mjs`
  Expected: the module is not found.

- [ ] **Step 3: Implement** as in Interfaces.
  - Existing tests that pin `INTERNATIONAL_VIEWS` or the view list may change. Update them and list each one in your report.

- [ ] **Step 4: Run the tests and see them pass**

  Run: `node --test test/translation.test.mjs`, then `npm test`.
  Expected: all pass.

- [ ] **Step 5: Commit**

  Use the message "Translated views: ids, labels, defaults, error classes and the fallback rule", with the trailer.

---

### Task 2: Page translator, capture integration, e2e with a fake translator

**Files:**
- Create: `extension/browser/translate-view.js` (page functions; each self-contained for `fnSource`)
- Modify: `extension/browser/capture.js`. The changes:
  - `evaluate(fn, args, world, { userGesture } = {})`;
  - the three views after `rtl`;
  - `capture.translation`;
  - `pseudo` gated by `needsFallback`;
  - a `viewProbe` kind `'translated'`.
- Modify: `test/e2e/run.mjs` and `test/e2e/site/index.html` (fixture: a `::before { content: "Sale today" }` element, and a cross-origin iframe if the fixture has none)
- Test: `test/e2e/run.mjs`

**Interfaces:**
- **Consumes** (Task 1): `TRANSLATED_VIEWS`, `classifyError`, `sameAsPage`, `needsFallback`.
- **Produces:**
  - **`capture.evaluate(fn, args, world = 'isolated', { userGesture = false } = {})`.** It sets `userGesture: true` on `Runtime.evaluate` when asked. Existing callers are unchanged.
  - **`translatePage({ source, target, rtl, timeoutMs }) → { translated: number, eligible: number }`** (page, main world). It:
    1. calls `Translator.create`, with one retry on `NotSupportedError` and a `timeoutMs` race;
    2. translates eligible text nodes and the attributes `placeholder`, `alt`, `aria-label`, `title`, plus `value` on `input[type=submit|button|reset]`;
    3. skips what `pseudoText` skips, plus hidden and `translate="no"`;
    4. stores originals in `window.__harplusTranslated` as `[[node, original, translated]]` for text, plus attribute records;
    5. installs a keeper (MutationObserver) that translates text added later and records originals as `pseudoText` does;
    6. when `rtl` is set, also applies `flipDir(true)`'s direction logic.

    It throws with the API's error message on failure. Deduplicate repeated strings with a `Map` cache.
  - **`restoreTranslation({ rtl }) → true`.** It:
    - disconnects the keeper;
    - restores the text nodes;
    - restores each attribute only if it still equals our translation;
    - undoes `dir` when `rtl` is set.
  - **`leftoverText() → { count, examples: string[≤5], causes: { iframe, cssContent, svg, canvas, late } }`.** It runs after translation has settled.
    - **Counted as leftovers:** visible text of 2 or more words that was never handed to the translator. Its sources are:
      - a cross-origin `iframe` (counted per iframe, with no text available, so the example is its `src` host);
      - `::before`/`::after` `content` strings of visible elements;
      - SVG `<text>` elements;
      - visible `<canvas>` elements (counted, no text);
      - text nodes present now that are neither in `__harplusTranslated` nor skipped (`late`).
    - **Not counted:** text the translator returned unchanged.
  - **`viewProbe('translated')`:**
    - It passes when at least 90% of the connected saved nodes hold their translation.
    - On pass, its detail is `"N% of text translated"`.
    - On fail, its detail is `"the page restored X% of the text"`.
  - **Recorded data:**
    - **`patch.capture.translation[id] = { status: 'ok' | 'skipped' | 'failed', reason?, leftovers? }`.** The view measurement goes in `views[id]` as usual, and a successful view also records `leftovers`.
    - **Skip reasons:**
      - `turned off` (when `want[id] === false`, still added to `viewsSkipped` by `view()`);
      - `page is already in ${label}` (from `sameAsPage`);
      - a view that ran but failed its self-check is recorded as `failed`, with the check detail as its reason.
    - **Bail-out:** after a `failed` with `classifyError(...).scope === 'all'`, the remaining translated views are recorded `failed` with the same reason and are not run.
    - **Source language:** `primary(<html lang>)`, else `en`, read once before the translated views (via a small main-world evaluate).
  - **`pseudo` view:** it runs only when `needsFallback(patch.capture.translation, want)` is true. Otherwise it is added to `viewsSkipped` with reason `not needed`.

- [ ] **Step 1: Write the e2e first** (fixture plus assertions; see the e2e hints at the end of this task).
  1. **Fake translator.** Before the main capture's tab navigates, `page.addInitScript` defines `globalThis.Translator`:
     - `availability()` resolves `'downloadable'`;
     - `create({ targetLanguage })` resolves `{ translate: async (t) => fake(t, targetLanguage) }`;
     - `fake` makes German each word + `'ung'` (about +40% on short words), Arabic each word → `'مرحبا'`, and Japanese each word → `'テキスト'`.
  2. **Main reading assertions:**
     - `hp.capture.translation['translated-de'].status === 'ok'` (and the same for `-ar` and `-ja`);
     - `views['translated-de'].clipped` is a number;
     - screenshots exist for all three;
     - `views.pseudo` is **absent**, and `viewsSkipped` has `{ view: 'pseudo', reason: 'not needed' }`;
     - the Arabic view's measurement records `dir === 'rtl'`;
     - `translation['translated-de'].leftovers.causes.cssContent >= 1`;
     - the page's text is restored afterwards: a known fixture string is back in English, and no `ung`-suffixed words remain;
     - `views.pseudo` being absent is the fallback-not-needed proof.
  3. **Fallback path.** For one of the later captures in `run.mjs`, for example the record or snapshot reading, use a page whose init script deletes `globalThis.Translator`. Assert:
     - all three translations are `failed` with reason `translation unavailable in this browser`;
     - `views.pseudo` is present;
     - the International plugin still runs.

     If no later capture fits, add a minimal second capture of `/` for this.
  4. **The fixture's re-rendering element** (Review Focus 1) ends the view with original text. If the fixture has no element that re-renders its text, add a tiny one (`setInterval` rewriting a `<span>` every 200 ms with the same English text).

- [ ] **Step 2: Run the e2e and see it fail**

  Run: `npm run test:e2e`
  Expected: it fails at the translation status (undefined).

- [ ] **Step 3: Implement** `translate-view.js`, the `evaluate` option, the views loop in `capture.js` (placed after `rtl`; `pseudo` moved after the translated views and gated), the probe kind, and the recording.
  - Each translated view's `run(live)`:
    1. `evaluate(translatePage, {...}, 'main', { userGesture: true })`;
    2. `settled(1000)`;
    3. `checked(probe('translated'), () => grab(id))`;
    4. `leftoverText()`, attached to the result.
  - `restore` calls `restoreTranslation`.
  - `runMs` is 180,000 and `restoreMs` is 20,000.
  - Progress text comes from `this.report('views', …)`, as the scaffolding already does. If you can tell a download is happening, add a short note such as "downloading the German model". That is optional.

- [ ] **Step 4: Run the tests and see them pass**

  Run: `npm test`, then `npm run test:e2e` three times.
  Expected: green each time. Review the International screenshots (`reading-area-international.png`, and the Screens tab if a shot exists) and describe them.

- [ ] **Step 5: Commit**

  Use the message "Translated views: translate in the page via Chrome's on-device Translator, leftovers, Long text as fallback", with the trailer.

**E2E hints:**
- Aim with fresh locators; no fixed sleeps.
- Fixture additions may shift other e2e counts (text clip counts, findings). Keep their intent, adjust legitimately changed counts, and list them in the report.

---

### Task 3: Findings, glance and Screens chips

**Files:**
- Modify: `extension/plugins/international.js`
- Modify: `extension/ui/report.js` (`intlChips` and the International Screens card)
- Test: `test/international.test.mjs`, `test/report.test.mjs`

**Interfaces:**
- **Consumes:**
  - `hp.capture.views[id]` (measurements);
  - `hp.capture.translation[id]` (`{status, reason, leftovers}`);
  - `TRANSLATED_VIEWS` and `VIEW_LABELS`;
  - the existing `A11Y_MIN_OVERFLOW` and clipping thresholds.
- **Findings** (category `international`; exact titles):
  - **Clipping:** `Text gets cut off in ${label}: ${n} more text boxes clip their content`. Medium, when the extra clipped count is 3 or more.
    - **Reference view:** German and Japanese are compared with the base view. Arabic is compared with `rtl` when `views.rtl` exists; otherwise it uses the base view, and the detail adds ` (compared with the original layout; the right-to-left view did not run)`.
  - **Sideways scrolling:** `${label} text makes the page scroll sideways`. Medium. It uses the same rule as the Long text sideways finding (`scrollsX !== false`, reference not overflowing, an extra 8 px or more), with the same reference rule as clipping.
  - **Leftovers:** `${n} pieces of text stayed in English in the ${label} view`. Low, when `leftovers.count` is 3 or more.
    - It takes the translated view with the most leftovers.
    - The detail lists the causes with counts (`3 in an embedded frame, 2 CSS-generated, …`) and up to 3 examples.
  - **Failed views:** `${label} view could not run — ${reason}`. Info, for each `status === 'failed'`.
  - **The existing Long text findings** keep their wording. They now appear only when `views.pseudo` exists, which is already the case.
- **Glance:** the "Translation and right-to-left" checklist gains `Fits in ${label}` for each translated view that ran:
  - `ok` means no clipping or sideways finding for that language;
  - its note is the extra clipped count when it is above 0.
  - A skipped "already in" view shows `ok: null` with the note `page is already in ${label}`.
- **Screens:**
  - `intlChips(v, m, base)` handles the translated ids with the same chip vocabulary as `pseudo` (`fits`, `+N clipped`, `scrolls sideways`).
  - For `translated-ar`, it compares with `rtl` when present.
  - The card shows Long text only when `views.pseudo` exists, which already happens through `by[v]`.

- [ ] **Step 1: Write the failing tests**
  - **`test/international.test.mjs`:** findings for each language at the threshold (3 extra clipped) and quiet just below it, using fake `views` and `translation`.
  - **Arabic reference:** Arabic compared with `rtl` (an `rtl.clipped` of 5 and Arabic of 7 gives no finding; Arabic of 8 gives a finding). Without `rtl`, it uses the base view and the detail mentions it.
  - **Leftovers:** at 3, the finding names the language with the most leftovers, and its detail lists the causes.
  - **Failed views:** a failed view gives the info title with its reason.
  - **"Already in German":** gives a neutral glance item and no finding.
  - **Escaping:** leftover examples with `<script>` are escaped in the rendered glance and the finding detail.
  - **`test/report.test.mjs`:**
    - the International screens card shows the German, Arabic and Japanese figures with chips;
    - it has no Long text figure when `views.pseudo` is absent;
    - it shows Long text when `views.pseudo` is present.

- [ ] **Step 2: Run the tests and see them fail**

  Run: `node --test test/international.test.mjs test/report.test.mjs`
  Expected: the new tests fail.

- [ ] **Step 3: Implement** as in Interfaces.

- [ ] **Step 4: Run the tests and see them pass**

  Run: `npm test`, then `npm run test:e2e`.
  Expected: green. Add e2e assertions that the fixture's main reading has no "could not run" info finding, and that the fallback reading has three of them.

- [ ] **Step 5: Commit**

  Use the message "International: translated-view findings, glance items and Screens chips", with the trailer.

---

## Self-review notes

- **Spec coverage:**

  | Spec section | Task |
  |---|---|
  | Goals, views, defaults | Task 1 (registration) and Task 2 (capture) |
  | Fallback rules | Task 1 (rule) and Task 2 (gating, recording) |
  | Spike constraints (gesture, retry, timeout, Permissions-Policy, masking) | Task 2 |
  | Decided behaviour 1–9 | Task 2 |
  | Decided behaviour 10 (findings, Arabic vs `rtl`) | Task 3 |
  | Decided behaviour 11 (Screens) | Task 3 |
  | Decided behaviour 12 (settings) | Task 1 |
  | Decided behaviour 13 (testing: fake translator, fallback e2e) | Task 2 |
  | Designer's calls (bail-out, gesture per evaluate, attributes, harness-only fake) | Tasks 1 and 2 |

  - Reading size is checked in the final review, as the spec says.
- **Names:** `TRANSLATED_VIEWS`, `classifyError`, `sameAsPage`, `needsFallback`, `translatePage`, `restoreTranslation`, `leftoverText`, `capture.translation` and probe kind `translated` are defined once and used consistently.
