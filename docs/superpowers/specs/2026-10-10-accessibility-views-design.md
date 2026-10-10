# Accessibility views: design

**Status:** approved in conversation on 2026-10-10 as the first of four batches drawn from the Polypane gap analysis. This spec is waiting for review.

## Goal

Every reading also captures how the page looks and behaves under these conditions:
- colour-vision deficiencies;
- user display preferences: dark mode, forced colours and more contrast;
- print;
- the WCAG text-spacing, reflow and resize-text conditions.

Where a condition can be measured reliably, a new analyze-phase plugin turns the measurements into findings.

## Views

The new views are all on by default and keep **a viewport screenshot only**; no full-page shot is taken.

| id | Label | Group | How it is made (no reload) | Measured |
|---|---|---|---|---|
| `protanopia` | Protanopia | vision | `Emulation.setEmulatedVisionDeficiency({ type: 'protanopia' })` | no |
| `deuteranopia` | Deuteranopia | vision | `Emulation.setEmulatedVisionDeficiency({ type: 'deuteranopia' })` | no |
| `tritanopia` | Tritanopia | vision | `Emulation.setEmulatedVisionDeficiency({ type: 'tritanopia' })` | no |
| `achromatopsia` | Achromatopsia | vision | `Emulation.setEmulatedVisionDeficiency({ type: 'achromatopsia' })` | no |
| `blurred` | Blurred vision | vision | `Emulation.setEmulatedVisionDeficiency({ type: 'blurredVision' })` | no |
| `lowcontrast` | Reduced contrast | vision | `Emulation.setEmulatedVisionDeficiency({ type: 'reducedContrast' })` | no |
| `dark` | Dark mode | display | `Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] })` | yes |
| `forced` | Forced colours | display | `Emulation.setEmulatedMedia({ features: [{ name: 'forced-colors', value: 'active' }] })` | yes |
| `morecontrast` | More contrast | display | `Emulation.setEmulatedMedia({ features: [{ name: 'prefers-contrast', value: 'more' }] })` | yes |
| `print` | Print | display | `Emulation.setEmulatedMedia({ media: 'print' })` | yes |
| `spacing` | Text spacing | wcag | inject the WCAG 1.4.12 stylesheet (below) | yes |
| `reflow` | 320 px reflow | wcag | `Emulation.setDeviceMetricsOverride` at 320 × 640, DPR 1, `mobile: false` | yes |
| `text200` | 200% text | wcag | `Page.setFontSizes({ fontSizes: { standard: 32, fixed: 26 } })` | yes |

**How each view is restored:**

| Views | Restore |
|---|---|
| vision | `setEmulatedVisionDeficiency({ type: 'none' })` |
| display | `setEmulatedMedia({ media: '', features: [] })` |
| `spacing` | remove the injected style element |
| `reflow` | `applyDevice(base)`, as the device views do |
| `text200` | `setFontSizes({ fontSizes: { standard: 16, fixed: 13 } })` |

**Text-spacing stylesheet:** inject it as `<style id="harplus-spacing">`:

```css
* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
p { margin-bottom: 2em !important; }
```

**Order and timing.**
- The views run after the existing views and before the no-JavaScript view, which reloads the page.
- Each view waits 300 ms (vision and display) or 600 ms (`spacing`, `reflow`, `text200`) before its screenshot.
- Each has `runMs` 20 000 and `restoreMs` 10 000, and fails in isolation like the existing views.

**Grouping.**
- `views.js` exports `VISION_VIEWS`, `DISPLAY_VIEWS` (dark, forced, morecontrast, print) and `WCAG_VIEWS` (spacing, reflow, text200), plus `A11Y_VIEWS` for all three groups together.
- `VIEWS` and `VIEW_LABELS` include them all.
- `shotView` already accepts any id in `VIEWS`.

**Screenshots.** `shoot(view, { thumb, fullPage = true })` gains a `fullPage` flag. The new views pass `fullPage: false`.

**Settings.**
- `DEFAULTS.capture.views` gains every new id set to `true`.
- The Options "Capture defaults" view checkboxes gain one chip per non-vision view, plus one chip "Vision simulations" bound to a new `capture.views.vision` key.
- When `views.vision` is false, all six vision views are skipped with the reason `disabled`.
- The popup's view checkboxes get the same chips.

## Measurements

The measured views run the existing `measureView()`.

`measureView()` gains these fields, which are cheap and computed on every measured view, including the base:
- `bodyFont`: the computed `font-size` of `body`, in px;
- `bg`: the luminance (0–1) of the first non-transparent `background-color` walking from `body` up to `html`. Use 1 (white) if all are transparent; that is the canvas default;
- `fixed`: visible elements with `position: fixed` or `sticky` whose box covers at least 10% of the viewport area, up to 20 elements;
- `chrome`: whether a visible `nav`, `header`, `footer` or `[role=navigation|banner|contentinfo]` exists;
- `forcedNone`: the number of elements whose computed `forced-color-adjust` is `none`, sampling the first 3000 elements;
- `iconOnly`: the number of visible `a` and `button` elements that have no text, no `aria-label` and no `img` or `svg` child, and whose computed `background-image` is not `none`.

A one-time probe in the base view, `prefsProbe()` (a page function run once before the new views), records `hp.capture.prefs`:
- `colorScheme`: the `content` of `<meta name="color-scheme">` combined with the computed `color-scheme` of `html`;
- `mediaPrint`: whether any `link[media*=print]`, or any accessible CSSOM `@media print` rule, exists;
- `mediaFeatures`: an object of the media features found in accessible CSSOM rules, such as `prefers-color-scheme`, `forced-colors` and `prefers-contrast`.

Cross-origin stylesheets aren't readable from the page. The plugin therefore also uses `results.css.data.mediaFeatures` and `results.css.data.media`, which the css plugin builds from the recorded stylesheets.

## Plugin `a11y-views` (new, analyze phase)

- `extension/plugins/a11y-views.js`: `area: 'accessibility'`, `group: 'quality'`, `phase: 'analyze'`, `after: ['css']`.
- It reads `hp.capture.views` (the measurements), `hp.capture.prefs`, `results.css.data`, and the base view's measurement via `baseView(reading)`.
- If none of the measured new views were captured, it skips with "no accessibility views in this reading — take a new reading".

**Findings.** The category is `accessibility` unless the table says otherwise.

| View | Condition | Severity | Title |
|---|---|---|---|
| reflow | `overflowX > 0` | medium | `Page scrolls horizontally at 320 px (WCAG 1.4.10)` |
| reflow | `clipped − base.clipped ≥ 3` | medium | `N more text boxes clip at 320 px (WCAG 1.4.10)` |
| spacing | `clipped − base.clipped ≥ 3`, or `overflowX > base.overflowX` | medium | `Text clips with WCAG text spacing (1.4.12)`; detail: N more clipped boxes, overflow px |
| text200 | `bodyFont ≤ base.bodyFont` | low | `Text ignores the browser's font-size setting` |
| text200 | grows, and `clipped − base.clipped ≥ 3` or `overflowX > base.overflowX` | medium | `Text clips at 200% size (WCAG 1.4.4)` |
| dark | `abs(bg − base.bg) < 0.1`, and no `prefers-color-scheme` in prefs or css | info | `No dark mode` |
| dark | `colorScheme` includes `dark`, and `abs(bg − base.bg) < 0.1` | low | `Declares dark color-scheme but stays light` |
| forced | `forcedNone ≥ 20` | low | `N elements opt out of forced colours` |
| forced | `iconOnly ≥ 1` | low | `N icon-only controls may vanish in forced colours`; detail: "Forced colours replace the page's colours but not image content, so a background-image icon can disappear against the system background. Use an SVG with `currentColor`, or visible text." |
| morecontrast | no `prefers-contrast` in prefs or css | info | `No high-contrast styles` |
| print | `chrome` is true | low, category `content` | `Navigation and site chrome still print` |
| print | `fixed.length ≥ 1` | low, category `content` | `N fixed or sticky overlays print over content` |
| print | no `mediaPrint` and no `print` key in `css.data.media` | info, category `content` | `No print styles` |

**Summary rows:**
- "Reflow 320 px": ok, or overflow px;
- "Text spacing": ok, or N clipped;
- "200% text": the font scale, base → zoomed px;
- "Dark mode": changes, or no change;
- "Print": clean, or the list of issues.

The base view is captured first, so `base` is always present when the plugin runs.

**Glance:** a checklist with one row per measured view, ok or issue, using `h.checklist`.

**Render:** a table with, for each measured view: overflowX, clipped, bodyFont, bg, fixed count and chrome.

## Report

The Screens pane gets an **Accessibility views** section after the international section.
- **Vision:** a 3×2 grid of the six vision shots with captions. A seventh tile shows the base viewport shot for comparison.
- **Display and WCAG:** one row per measured view, with its viewport shot and a small key–value list of the measurements that matter for it, plus its findings' titles.
- Every new shot uses the existing `data-zoom` lightbox, as the existing screens do.

Readings taken before this change have none of these views, so the section doesn't render for them.

## Testing

**Unit tests:**
- `views.js`: the new groups and labels, `shotsByView` with the new ids, and `VIEWS` containing all of them.
- `a11y-views` `run()` on synthetic `capture.views` and `prefs`:
  - each finding fires at its threshold and not below it;
  - category `content` for the print findings;
  - a skip when the views are absent;
  - no NaN when fields are missing (old readings).
- `measureView` additions: covered by the e2e.
- Report: the Accessibility views section renders for a reading that has the views, renders nothing for one without, and contains no `undefined` or `NaN`.

**E2E:**
- The test site gains:
  - a `@media print` rule that hides its header;
  - one fixed banner;
  - a wide element that overflows only at 320 px (`min-width: 400px` on a promo box).
- The e2e asserts that:
  - all 13 new views appear in `screenshots` with `kind: 'viewport'` and no `fullpage`;
  - `capture.views` has measurements for the 7 measured views;
  - the `a11y-views` plugin is ok, with the reflow finding and the fixed-overlay print finding;
  - the report's Screens pane contains the Accessibility views section.
- Timing: the views phase stays under 60 s on the test site.

## Out of scope

- Motion and reduced-motion checks.
- Reachability maps.
- Simulators beyond Chrome's six: cataracts, glaucoma and the others.
- Contrast measurement, which is batch 2.
