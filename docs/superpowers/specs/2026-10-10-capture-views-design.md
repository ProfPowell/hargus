# Capture views: devices and resilience — design

Date: 2026-10-10 · Status: approved in brainstorming, awaiting spec review

## Goal

Every reading shows how the page looks in three ways:

- **Devices:** on desktop, tablet and phone.
- **Resilience:** without JavaScript, without CSS and without images.

The Screens page lays these out for side-by-side comparison. The resilience views are also measured, so a page that collapses without JavaScript becomes a scored finding instead of only a picture.

## Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Fidelity | **Hybrid.** Devices, no-CSS and no-images run in place with no reload. No-JS takes one reload with scripts disabled, then one normal reload to restore the tab. |
| Defaults | All six views are on by default. Each one can be toggled in the popup and in Options. |
| Shot size | Every view gets a viewport shot and a full-page shot (when `capture.fullPage` is on), using the existing caps. |
| Layout | **A:** a devices line-up at true relative scale, plus a 2×2 resilience grid. |
| Measurement | Measure every view. A new offline plugin turns the comparison into findings. |
| Cost | About 15–25 s more per reading, with every view on. |

## Constraints

- No build step and no dependencies (unchanged).
- The reading's HAR must not contain requests caused by the views. Views run after `recorder.build()`.
- When the reading finishes, the user's tab must be as it was before:
  - viewport size;
  - script execution enabled;
  - styles and images restored;
  - the page reloaded normally after the no-JS view.
- A failing or timed-out view adds a capture warning. It never fails the reading.
- Older readings, where screenshots have no `view`, must render.

## 1. View ids

`desktop`, `tablet`, `mobile` (labelled **Phone** in the UI; the id matches the existing `capture.device` value), `nojs`, `nocss`, `noimages`.

The **base view** is the capture's own device: `capture.device`, defaulting to `desktop`. Its shots are the existing main shots, which are now tagged with `view`.

## 2. Capture (`extension/browser/capture.js`)

After `finish()` has built the HAR and run the page-phase plugins, and only while the debugger is still attached, run `captureViews()`. Each view is wrapped in its own try/catch and timeout. Views run in this order:

1. **Device views** (every enabled device except the base device):
   - Apply `Emulation.setDeviceMetricsOverride` with the preset (desktop is a new preset: 1280×800, DPR 1, `mobile: false`).
   - Set touch emulation on for tablet and phone, off for desktop.
   - Wait for layout: 1 s, then `waitForIdle({ idleMs: 500, maxMs: 4000 })`.
   - Take the screenshots and measure.
   - Restore: re-apply the base device's override, or `Emulation.clearDeviceMetricsOverride` plus touch off when the base is desktop.
   - The user agent is **not** changed (in place by design).
2. **No CSS**, evaluated in the main world:
   - Disable every `document.styleSheets` entry.
   - Clear `adoptedStyleSheets` on the document and on every open shadow root, keeping the originals.
   - Move every `style` attribute to `data-harplus-style`.
   - Take the screenshots and measure, then restore everything exactly.
3. **No images**, evaluated in the main world:
   - For every `img`, move `src`/`srcset` into data attributes and set `src` to `about:invalid#harplus`, so Chrome shows the alt text.
   - For every `picture > source`, move `srcset` the same way.
   - Hide `video` posters.
   - Inject `<style id="harplus-noimg">* { background-image: none !important; }</style>`.
   - Take the screenshots and measure, then restore.
4. **No JavaScript** (only in `reload` mode, skipped in `snapshot` and `record`):
   - Set `Emulation.setScriptExecutionDisabled({ value: true })`, then reload.
   - Wait for load: `waitForIdle({ idleMs: 800, maxMs: 15000 })`.
   - Take the screenshots and measure. The measurement function still runs, because `Runtime.evaluate` is not blocked by that setting.
   - Restore: `setScriptExecutionDisabled({ value: false })`, reload, and wait for idle with `maxMs: 15000`.

Screenshots reuse the existing `screenshots()` logic, split into `shoot(view)`. It returns the viewport and full-page shots tagged `{ view }`. The thumbnail is taken only for the base view.

Progress reports: `this.report('views', '<Label> view')` before each view.

**Measurement** (`measureView`, a self-contained function evaluated in the page) returns:

`{ cssWidth, cssHeight, text, links, images, imagesWithAlt, noscript }`

- `text`: the length of the visible text, i.e. `document.body.innerText` with whitespace collapsed.
- `links`: `a[href]` elements that have at least one client rect.
- `images`: rendered `img` elements.
- `imagesWithAlt`: those whose `alt` attribute is non-empty or `""`.
- `noscript`: true when a `<noscript>` element exists.

The base view is measured too. The results are stored in `capture.views[viewId]`.

## 3. Format (`docs/FORMAT.md`)

- `screenshots[].view` (new, optional): one of the view ids. When it is absent, readers treat the shot as the base view.
- `capture.views` (new, optional): `{ [viewId]: { cssWidth, cssHeight, text, links, images, imagesWithAlt, noscript } }`.
- `capture.viewsSkipped` (new, optional): `[{ view, reason }]`. Reasons are "disabled", "not in reload mode", or the error message.

## 4. Settings

- `DEFAULTS.capture.views = { desktop: true, tablet: true, mobile: true, nojs: true, nocss: true, noimages: true }`.
- Popup (capture options) and Options get a **Views** group with six checkboxes:
  - Desktop
  - Tablet
  - Phone
  - No JavaScript
  - No CSS
  - No images
- The popup's change handler must support the nested `views.*` names.

## 5. Resilience plugin (`extension/plugins/resilience.js`)

- **Type:** analyze-phase, offline. `group: 'build'`. Reads `reading.log._harplus.capture.views`, and skips when there is no base view or no other view.
- **Ratios against the base view:** `textRatio = text / base.text` and `linkRatio = links / base.links`. When the base value is 0, the ratio is 1.
- **Findings, all category `quality`:**
  - no-JS `textRatio < 0.2`, high: "Page shows almost no content without JavaScript", with detail `${pct}% of the text is visible`.
    - When `noscript` is true, the detail adds "a <noscript> fallback exists" and the severity becomes **medium**.
  - no-JS `0.2 ≤ textRatio < 0.6`, medium: "Much of the content needs JavaScript".
  - no-JS `linkRatio < 0.5`, with the base having at least 5 links, medium: "Most links need JavaScript".
  - no-CSS `textRatio > 1.3`, info: "Hidden content appears without CSS", with detail "Menus, screen-reader text or duplicated content become visible — check the reading order."
- **Summary:**
  - `{ label: 'Without JavaScript', value: '<pct>% of text · <pct>% of links', rating, headline: true }`, where `rating` is good at ≥ 0.8, needs-improvement at ≥ 0.2, and poor below.
  - One row each for no CSS and no images (images with alt / images).
- **Glance:** `h.hbars` of visible text per view as a % of base, plus a second `h.hbars` for links.
- **Data:** `{ base, views: { [id]: { ...m, textRatio, linkRatio } } }`.
- **Registration:** added to `BUILTIN` after `baseline`.

## 6. Screens pane (`extension/ui/report.js` `screensPane`)

- **Devices section:**
  - figures for the available desktop, tablet and phone shots, ordered desktop, tablet, phone;
  - each figure's `flex-basis` is `cssWidth / Σ cssWidth × 100 %` over the shown devices, so all shots share one scale;
  - laid out with CSS `flex` and `align-items: end`;
  - each caption shows the label and `cssWidth×cssHeight`.
- **Resilience section:** a 2×2 grid. The "As designed" tile is the base view. Each degraded tile has chips built from `capture.views` and the resilience plugin's data:
  - no JS: text % and links %;
  - no CSS: text %;
  - no images: "N of M images have alt text".
  - Chip colours follow the plugin's ratings.
- **Above the fold / Full page switch:** each section has two radio inputs plus CSS `:checked ~` rules that swap between the `viewport` and `fullpage` images. The default is above the fold. No JavaScript is needed.
- **Print:** shows the full-page images.
- **Zoom:** the existing `data-zoom` dialog keeps working. It must use the view as well as the kind.
- **Older readings** (no `view`): the base view only, shown in the devices section; the resilience section is omitted.

Overview hero: unchanged. It uses the base viewport shot.

## 7. Test site (`test/e2e/site`)

Add a section rendered by `main.js`: a paragraph block and three links, inserted only by script. This makes the no-JS text ratio measurably lower.

## 8. Testing

- `test/resilience.test.mjs`:
  - ratio maths;
  - each threshold, with boundary values 0.2, 0.6 and 1.3;
  - the `noscript` downgrade;
  - base links under 5 suppressing the link finding;
  - skipping when there is no data;
  - summary ratings;
  - glance markup.
- `test/report.test.mjs`:
  - the screens pane with all six views: both sections, the radio switch, and the chips;
  - an older reading with no `view`, which shows only the devices section;
  - escaping of chip values.
- **Settings:** the defaults include `views`, and merge keeps the user's overrides.
- **E2E**, after the reload reading of the test site:
  - screenshots exist for all six views;
  - the device views' viewport `cssWidth` values are 1280, 820 and 390;
  - `capture.views.nojs.text < capture.views.desktop.text`;
  - the tab ends with JavaScript enabled, which a `page.evaluate` proves;
  - the tab's `innerWidth` is back to its pre-capture value;
  - `log.entries` contains no request made after the main capture's last entry.
- **E2E, snapshot mode:** no `nojs` shot, and `viewsSkipped` contains `nojs` with the reason "not in reload mode".

## Out of scope

- Per-device user agents and reloads (we chose the in-place approach).
- Per-view HAR recordings.
- Visual diffing between views.
- Detecting image-borne text.
