# Translated views (German, Arabic, Japanese)

**Status:** design agreed in conversation (2026-10-23); builder-check questions answered.

**Background:** spike findings are in `~/.claude/projects/-Users-tpowell-src-har-plus/memory/translator-api-spike.md`. They are summarised in "What the spike established" below.

## Intent

HARgus's International checks find layout problems under translation using the "Long text" view (`pseudo`). That view pads every text node with accented letters and dots. The problems it finds are real, but they don't look real: nobody believes "Ŵéļçöɱé····" is what a visitor sees, so a clipped box in that view is easy to dismiss.

**Goal:** show the page in **real** translations, so the problems are believable. Examples: a German screenshot with a cut-off button, an Arabic page that scrolls sideways, a Japanese page whose labels overflow. "Real translations make the problems believable."

## Goals

- **Three translated views:** German (`translated-de`, for text growth), Arabic (`translated-ar`, right-to-left with a real script) and Japanese (`translated-ja`, no word spaces, different line-breaking, font fallback).
- **On by default.** Extra capture time is acceptable, even minutes, including the one-time model downloads.
- **Measured like the Long text view:** extra clipped text boxes and sideways scrolling compared with the base view. Each view gets a screenshot.
- **Text that stayed in English is flagged:** visible text the translation could not reach.
- **Findings name the language.** For example: "Text gets cut off when translated (German): up to 6 more text boxes clip".
- **The Screens tab shows the translated screenshots** alongside the existing International shots.

## Non-goals

- Shipping or storing translations as data for the user. Translated text is not saved in the reading beyond what the screenshot and the leftover examples show.
- Translating cross-origin iframes, closed shadow roots or canvas content. These are reported as leftovers, not translated.
- Choosing or configuring other languages. The three are fixed in this design.
- Replacing the existing right-to-left view (`rtl`). It stays: it shows the original page mirrored, which isolates mirroring bugs from script and length effects.

## Anti-goals (a failure even if it works)

- **Sending page text off the machine.** Only Chrome's on-device Translator API is used. No cloud translation, no translate proxy, no API key. If on-device translation is unavailable, the fallback runs.
- **A reading that hangs, or fails outright, because translation is slow or blocked.** Every translated view is bounded and skippable.
- **Translated text left on the page after the view.** The page must be restored exactly, as the other views restore it.

## Fallback (decided)

- **When each translated view runs:** it runs if on-device translation works for that language on this run.
- **When the Long text view runs:** only as a fallback, and only when a translated view **failed**. Failed means one of:
  - translation was unavailable, because the browser has no translator or it is not branded Google Chrome;
  - the site blocks it with `Permissions-Policy: translator=()`;
  - the model failed to download or create in time;
  - the view ran but failed its self-check.
- **Skips that do not trigger the fallback:**
  - a view the user switched off in settings;
  - a view skipped because the page is already in that language, such as the German view on a German page.
- **The Long text toggle still applies.** If the user turned `pseudo` off, the fallback does not run either.
- **What a normal reading shows:** in up-to-date Chrome, three real languages and no padded view.
- **Ordering:** the fallback depends on the translated views' outcomes, so `pseudo` moves after them in the view sequence.
- **Recording skips:**
  - Each skipped or failed translated view is recorded in the reading as `capture.translation[id] = { status: 'ok' | 'skipped' | 'failed', reason }`. Examples of reasons: "blocked by the site's Permissions-Policy", "translation unavailable in this browser", "page is already in German", "turned off".
  - The International plugin shows failures as info notes, as it does for unverified views. It shows "already in German" as a neutral glance item.
  - The plugin knows the fallback ran because `views.pseudo` is present.

## What the spike established (constraints on the how)

- **Availability:**
  - `Translator` is exposed in the page main world, in CDP isolated worlds, in extension pages and in the service worker.
  - Only branded Google Chrome downloads models: about 80 MB per language pair, 11–15 s the first time, cached in the Chrome profile afterwards.
  - Playwright's Chromium and Chrome for Testing never download, and `create()` hangs.
- **`availability()` can't be trusted.** It reports `"downloadable"` for every new origin (privacy masking), so it can't tell whether a model is installed.
- **`create()` needs user activation** while availability is downloadable. Through CDP that means `Runtime.evaluate({ …, userGesture: true })`. HARgus's `capture.evaluate` (`extension/browser/capture.js`, around line 1127) needs a way to pass it.
- **The first `create()` in a browser session fails with `NotSupportedError`.** Retry once.
- **Speed after creation:** about 5–8 ms per string, and about 1.5 s for 300 strings. Parallel calls give no speed-up.
- **Text growth:** en→de text is about 1.33× longer. Arabic, Japanese, French and Spanish outputs were correct.
- **Blocking:** `Permissions-Policy: translator=()` makes `create()` throw `NotAllowedError`.

## Decided behaviour

1. **Placement.** Run the three translated views next to `rtl` and `pseudo` in the capture's view sequence, using the same `view(id, { run, restore, runMs, restoreMs })` scaffolding as `pseudoText`.
   - Each run:
     1. translates;
     2. waits for settle;
     3. runs the self-check probe;
     4. grabs the measurement and screenshot.
   - `restore` puts the original text back.
2. **What is translated:**
   - visible text nodes;
   - `placeholder`, `alt`, `aria-label` and `title`;
   - the `value` of `input[type=submit|button|reset]`.
3. **What is skipped:** the same as the Long text view (`script`, `style`, `noscript`, `textarea`, `code`, `pre`, `svg`, `translate="no"`), plus hidden text.
4. **The Arabic view also sets `dir="rtl"` on `<html>`.** It reuses the `rtl` view's direction logic (`flipDir`), including re-applying it if the page resets it.
5. **Scripts adding text later.** Keep translating text the page's scripts add during the view, the way `pseudoText` keeps its rewrite applied.
6. **Source language:** the page's declared `<html lang>` primary subtag, falling back to `en`.
   - A view whose target equals the source (for example the German view on a German page) is skipped with the note "page is already in German".
7. **Bounded work:**
   - each view has a time budget (minutes acceptable overall);
   - a node cap like `pseudoText`'s 5,000;
   - a per-call timeout on `create()`, long enough for a first-time model download;
   - one retry after `NotSupportedError`.
   - Exceeding any of these skips the view with its reason and triggers the fallback.
8. **The self-check passes** when at least 90% of the eligible text was translated, mirroring the `pseudo` check.
9. **Leftover English (conservative, decided).** A **leftover** is visible text, at least two words long, that the translation **never reached**.
   - **Causes, each counted separately:**
     - a cross-origin iframe;
     - CSS generated content (`::before`/`::after` with `content`);
     - SVG `<text>` or canvas text (canvas is reported as a count of visible canvases, since its text can't be read);
     - text the page's scripts added after the translation pass that the observer did not catch before the measurement.
   - **Not counted:**
     - text the translator saw and returned unchanged, such as brand and product names;
     - `translate="no"` text.
   - **Reporting:** a count, up to 5 examples, and the cause breakdown.
   - **Per language:** leftovers are counted for each translated view. One finding names every language over the threshold and uses the largest count (see 10).
10. **Findings,** in the `international` category, from the International plugin:
    - **What each view is compared with:**
      - German and Japanese: the base view.
      - **Arabic: the `rtl` view** (decided), so the Arabic finding counts only what Arabic text adds on top of mirroring. If `rtl` did not run, Arabic falls back to the base view and its finding detail says so.
    - **One finding per defect, not per language** (product decision, 2026-10-24): the same broken layout is scored once. Each language still has to pass its own threshold to be named; the detail lists each named language's numbers.
    - **Clipping:** `Text gets cut off when translated (${Languages}): up to N more text boxes clip`. Medium, with the same threshold as the Long text finding (extra clipped ≥ 3) per language.
    - **Sideways scrolling:** `Translated text makes the page scroll sideways (${Languages})`. Medium, with the same 8 px / `scrollsX` rule as Long text.
    - **Leftovers:** `Up to N pieces of text stayed in ${Source} when translated (${Languages})`. Low, from 3 text leftovers per language. Frames and canvases are counted apart, as one grouped info note when no text finding fires; the node cap is a detail line.
    - "Could not run" / "could not be verified" notes stay per language (info), except one note when all three fail for the same page-wide reason.
    - The existing Long text findings only appear when the fallback ran.
    - The glance checklist gains "Fits in German", "Fits in Arabic" and "Fits in Japanese", each shown when its view ran, and one "All text translated" item whose note lists the languages with leftovers.
11. **Screens tab:** the International card shows As designed, Right-to-left, German, Arabic and Japanese. It also shows Long text when it ran. The chips follow the existing style ("fits", "+N clipped", "scrolls sideways").
12. **Settings:**
    - `translated-de`, `translated-ar` and `translated-ja` join the per-view toggles in `extension/browser/settings.js`, default `true`.
    - `pseudo` stays a toggle; when on, it runs as the fallback.
    - Add the views to `INTERNATIONAL_VIEWS` and `VIEW_LABELS` in `extension/core/views.js`.
13. **Testing:**
    - E2E and CI run on Playwright's Chromium, which cannot translate. Tests inject a **fake translator** into the page before the views run, for example via an init script or a test-only flag. Its `create()` returns an object whose `translate(text)` returns predictable text:
      - German: words lengthened by about 40%, so clipping still shows;
      - Arabic: Arabic letters;
      - Japanese: kana.
    - The fake is test-only and must never ship active.
    - A separate e2e path removes `Translator` (or makes `create()` throw) and asserts the fallback: `pseudo` runs, and the skip reasons are recorded.
    - Unit tests cover the International plugin's new findings, the glance and the Screens chips, using fake view measurements.
    - Real-Chrome behaviour is checked by a manual or calibration run, documented in the plan.

## Calls made in writing this up (by the designer, not discussed)

- **Bailing out early:**
  - A first `create()` that times out, or reports the API unavailable, marks **all** remaining translated views as failed with the same reason, without trying each one.
  - A `NotAllowedError` from Permissions-Policy is page-wide, so it fails all three at once.
  - A per-language error, such as one model failing to download, fails only that language.
- **User gesture:** every `Runtime.evaluate` that creates a translator passes `userGesture: true`. The spike showed one gesture per evaluate call works.
- **Attributes:**
  - They are translated once, when the view starts.
  - Restore puts back the original value only if the attribute still holds our translation, so a newer value the page set is kept.
  - Text nodes keep `pseudoText`'s keep-applied behaviour.
- **The fake translator in tests:**
  - It is injected only by the Playwright harness (`context.addInitScript`) into page main worlds.
  - The extension carries no test branch and no setting for it.
  - The fallback e2e removes `Translator` the same way.
- **Readings get larger.** They gain three screenshots, about the same size as the existing view shots. No storage or export limit is known to be affected; the plan's final review checks the export size.

## Left to the builder

- **Translation strategy:**
  - how the page-side translator batches or deduplicates strings (repeated strings are common);
  - how it maps nodes to originals for restore;
  - how it detects late-added text.
- **Time budgets and the `create()` timeout,** within "minutes are acceptable overall" and "never hang the reading".
- **How the user gesture reaches `capture.evaluate`:** a new option, or a dedicated helper.
- **Where in the view order the translated views go,** as long as `rtl` and the translated views don't interfere and each restores fully.
- **Progress panel wording** while a model downloads.

## Open risks

- **Model downloads:** the first run on a machine downloads about 240 MB for the three languages. Acceptable per the conversation; the progress panel should say what's happening.
- **Service-worker `create()`:** not verified in branded Chrome. The design avoids it by translating in the page.
- **Chrome may change the API's activation or masking rules.** The fallback covers that.
