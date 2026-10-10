# Accessibility page checks: design

**Status:** approved in conversation on 2026-10-10 as batch 2 of the Polypane gap work. This spec is waiting for review.

## Goal

Add deeper in-page accessibility checks, written by us with no new dependencies. axe stays an optional extra.
- **Contrast** for every visible text element: WCAG 2 is scored, APCA is advisory.
- **Outline-grade structure rules:**
  - headings, including `role="heading"`;
  - landmarks;
  - label-in-name (WCAG 2.5.3);
  - links;
  - ARIA references to ids that don't exist;
  - alt-text quality;
  - `autocomplete` values.
- **Target size, small text and focus order.**
- **A focus-style check.** It samples one control of each kind and forces `:focus-visible` through CDP, so no page script runs.

This batch also removes duplicated checks. Today skipped headings, empty headings and a missing `<main>` are reported by up to three plugins, so they count more than once.

## Architecture

| Unit | Kind | Responsibility |
|---|---|---|
| `extension/plugins/contrast.js` | new page-phase plugin | `collect()` walks the visible text. Pure helpers handle the colour maths (WCAG ratio, APCA Lc). `run()` groups the results into colour pairs and findings. |
| `extension/plugins/a11y-structure.js` | new page-phase plugin | `collect()` gathers the structural facts; a pure `analyze()` turns them into findings. It also reads the capture's `focus` probe. |
| `extension/core/color.js` | new pure module | `parseRgb`, `composite`, `relLum`, `wcagRatio`, `apcaLc`, `toHex`. Shared by `contrast` and its tests. |
| `extension/browser/capture.js` | changed | Adds a focus-style probe (`focusProbe`) that runs during capture, using CDP `CSS.forcePseudoState`. |
| `a11y-basics.js`, `html.js`, `content.js` | changed | Drop the duplicated checks (see "Clean-up"). |

Both new plugins use `area: 'accessibility'` and `group: 'quality'`. All their findings use category `accessibility`.

## Contrast (`contrast` plugin)

**Collect**, in the page, self-contained. Like `measureView`, it resolves colours with a 1×1 canvas so any CSS colour syntax works.

- **Candidates.** Elements that directly contain a non-whitespace text node, in document order, up to 4000 elements or 2000 ms; `truncated` records a cut-off.
- **Skipped:**
  - elements that aren't rendered (no client rects);
  - `visibility` not `visible`;
  - inside `[aria-hidden="true"]` or `[hidden]`;
  - disabled form controls and their labels (`:disabled`, `[aria-disabled="true"]`);
  - text colour with alpha 0;
  - `script`, `style`, `noscript` and `template`.
- **Text colour.** The computed `color` resolved to RGBA. The alpha is multiplied by the product of the `opacity` of the element and its ancestors.
- **Background.** Walk from the element up to `html`, collecting every `background-color` with alpha > 0. Stop at the first fully opaque one; if none is found, use white, the canvas default. The background is that colour with the semi-transparent layers between it and the element composited on top, in order.
  - If any element on the way up, the element itself included, has a `background-image` other than `none`, the contrast is **unknown**.
  - It is also unknown if the element's box overlaps an `img`, `video`, `canvas` or `svg` sibling positioned behind it. Detect this cheaply: an ancestor up to 3 levels up contains such an element absolutely positioned and overlapping the element's rect.
- **Text colour composited** over the resolved background, using its effective alpha.
- **Size class.** `large` when the font size is ≥ 24 px, or ≥ 18.66 px with `font-weight` ≥ 700.
- **Output per element:** `{ fg: '#rrggbb', bg: '#rrggbb', large: bool, selector, unknown: bool }`. `selector` is a short CSS path, as `a11y-basics` builds it.

**Pure maths** (`extension/core/color.js`):
- `relLum` follows WCAG 2.x: the sRGB transfer threshold is 0.04045.
- `wcagRatio(a, b) = (Lmax + 0.05) / (Lmin + 0.05)`.
- `apcaLc(text, bg)` is APCA-W3 0.0.98G-4g:
  - `Y = 0.2126729·R^2.4 + 0.7151522·G^2.4 + 0.0721750·B^2.4`, with R, G and B as 0–1 sRGB values;
  - soft clamp: if `Y < 0.022`, then `Y += (0.022 − Y)^1.414`;
  - if `|Ybg − Ytxt| < 0.0005`, then Lc is 0;
  - if `Ybg > Ytxt`: `S = (Ybg^0.56 − Ytxt^0.57)·1.14`, and Lc is 0 when `S < 0.1`, otherwise `S − 0.027`;
  - otherwise: `S = (Ybg^0.65 − Ytxt^0.62)·1.14`, and Lc is 0 when `S > −0.1`, otherwise `S + 0.027`;
  - return Lc × 100. It is signed: positive means dark text on a light background.

**Run.**
- **Pairs.** Group the known elements by `fg|bg|large`. Each pair holds `{ fg, bg, large, ratio, lc, count, samples: [≤3 selectors] }`.
- **WCAG pass.** A pair passes when `ratio ≥ 4.5`, or `≥ 3` if large.
- **APCA advisory pass.** A pair passes when `|lc| ≥ 75` for normal text, or `≥ 60` for large text.
- **Data:**
  - `pairs`: the 20 worst failing WCAG pairs by ratio, then the next worst APCA-only pairs, up to 20 in total;
  - `totals`: elements checked, failing, unknown and truncated.

**Findings:**

| Condition | Severity | Title |
|---|---|---|
| each of the 10 worst failing WCAG pairs | medium | `Text contrast <ratio>:1 (<fg> on <bg>) — <n> elements`; the ratio has 1 decimal |
| more than 10 failing pairs | medium | `…and <n> more failing colour pairs` |
| unknown ≥ 1 | info | `<n> text elements over images could not be checked` |
| pairs that pass WCAG but fail APCA, ≥ 1 | info | `<n> colour pairs below APCA thresholds (advisory)` |

**Summary:** "Contrast": `<failing> of <checked> text elements fail (AA)`, rated good at 0, needs-improvement at less than 10%, and poor otherwise. This is a headline row.

**Glance:** swatch rows for up to 8 pairs. Each row shows a small "Aa" chip drawn in fg on bg (both colours are inline styles validated as `#rrggbb`), the ratio, the APCA Lc, the count and a pass/fail icon.

**Render:** a table of all stored pairs: swatch, fg, bg, ratio, Lc, size, count and samples.

## Structure (`a11y-structure` plugin)

**Collect**, in the page, self-contained. Each item has `{ selector, text }` samples, up to 5 per rule.

| Area | Collected / rule | Severity | Title |
|---|---|---|---|
| Headings | `h1–h6`, plus `[role=heading]` with `aria-level` (default 2). Hidden ones (not rendered, or inside `aria-hidden`) go to `hiddenHeadings`. | — | — |
| | a visible heading more than one level deeper than the previous visible one | low | `<n> skipped heading levels` |
| | a visible heading with an empty accessible name | medium | `<n> empty headings` |
| | the same text as another visible heading (case- and space-insensitive) | info | `<n> duplicate heading texts` |
| Landmarks | no `main` or `[role=main]` | low | `No <main> landmark` |
| | more than one visible `main` | medium | `<n> main landmarks` |
| | 2+ `nav` (or `aside`) without distinct accessible names | low | `<n> navigation landmarks without distinct labels` (the `aside` wording is `complementary`) |
| | 2+ top-level `header`/`[role=banner]`, or footer/`[role=contentinfo]` (not inside `article`, `aside`, `main`, `nav` or `section`) | low | `Multiple banner landmarks` / `Multiple contentinfo landmarks` |
| Label in name | `a`, `button`, `[role=button]` or `[role=link]` with visible text AND an `aria-label`, where the normalized aria-label doesn't contain the normalized visible text | medium | `<n> controls whose accessible name hides their visible label (WCAG 2.5.3)` |
| Links | `a[href^="http:"]` on an https page | low | `<n> links use plain HTTP` |
| | the same href (without hash) with 2+ distinct non-empty texts | info | `<n> URLs linked with different text` |
| | a link in `nav` whose href equals the page URL (without hash) and has no `aria-current` | info | `Current page link has no aria-current` |
| ARIA references | `aria-labelledby`, `aria-describedby` and `label[for]` pointing to a missing id | medium | `<n> label or description references point to missing ids` |
| | `aria-controls`, `aria-owns` and `aria-activedescendant` pointing to a missing id | low | `<n> ARIA references point to missing ids` |
| Alt text | `img[alt]` whose alt matches `^(image|photo|picture|graphic|icon) of\b`, `^(image|photo|picture|placeholder|img|graphic|logo)$`, or a file name (`\.(jpe?g|png|gif|webp|avif|svg)$`, or `^[\w-]*\d{3,}[\w-]*$`), or is longer than 150 characters | low | `<n> images with unhelpful alt text` |
| Autocomplete | `input`, `select` or `textarea` with an `autocomplete` value whose tokens aren't all in the HTML autofill token list (below) | low | `<n> invalid autocomplete values (WCAG 1.3.5)` |
| | `input[type=reset]`, `button[type=reset]` | info | `Reset button present` |
| Target size | Visible interactive targets: `a[href]`, `button`, `input:not([type=hidden])`, `select`, `textarea`, `summary`, `[role=button\|link\|checkbox\|radio\|switch\|tab\|menuitem]`, `[tabindex]:not([tabindex="-1"])`. A target is undersized when its rect is narrower or shorter than 24 px AND another target's centre is within 24 px of its centre. Exempt: `a` elements whose computed `display` is `inline` and whose parent holds other text (inline links in sentences). | medium | `<n> targets smaller than 24×24 px (WCAG 2.5.8)` |
| | on mobile base-view readings, targets under 44×44 px | info | `<n> targets under 44×44 px (advisory)` |
| Small text | visible text elements with a computed font-size under 12 px (count) | low | `<n> text elements under 12 px` |
| | on mobile base-view readings, `input`, `select` and `textarea` with font-size under 16 px | low | `<n> form fields under 16 px (iOS zooms in)` |
| Focus order | Tab sequence: elements with positive `tabindex` first (ascending), then focusable elements in DOM order, only rendered ones. Count steps where the next stop's top is more than 200 px above the previous stop's top and their horizontal ranges overlap (same column). | low | `Focus order jumps back up the page <n> times` |
| | `div` or `span` with `tabindex ≥ 0` and no `role` | low | `<n> focusable elements without a role` |

**Autofill token list:**
- **Field names:** `name`, `honorific-prefix`, `given-name`, `additional-name`, `family-name`, `honorific-suffix`, `nickname`, `username`, `new-password`, `current-password`, `one-time-code`, `organization-title`, `organization`, `street-address`, `address-line1`, `address-line2`, `address-line3`, `address-level4`, `address-level3`, `address-level2`, `address-level1`, `country`, `country-name`, `postal-code`, `cc-name`, `cc-given-name`, `cc-additional-name`, `cc-family-name`, `cc-number`, `cc-exp`, `cc-exp-month`, `cc-exp-year`, `cc-csc`, `cc-type`, `transaction-currency`, `transaction-amount`, `language`, `bday`, `bday-day`, `bday-month`, `bday-year`, `sex`, `url`, `photo`, `tel`, `tel-country-code`, `tel-national`, `tel-area-code`, `tel-local`, `tel-extension`, `email`, `impp`, `webauthn`.
- **Modifiers:** `on`, `off`, `shipping`, `billing`, `home`, `work`, `mobile`, `fax`, `pager`, and `section-*`.

**"Mobile base view"** means `baseView(reading) === 'mobile'`. The plugin gets the reading, so `run` decides this; `collect` reports the raw sizes.

**Focus styles.** These come from `hp.capture.focus`, produced by the capture probe (below). The plugin turns them into findings:

| Condition | Severity | Title |
|---|---|---|
| every sampled kind shows no change (with ≥ 2 kinds sampled) | medium | `No visible focus indicator on any sampled control (WCAG 2.4.7)` |
| otherwise, per sampled kind with no change | low | `<Kind label> show no visible focus indicator`, for example "Buttons show no visible focus indicator" |
| `focus.outlineNone ≥ 1`, attached as detail to the findings above | — | `Stylesheets remove the focus outline in <n> rules without a replacement.` |

**Summary rows:**
- Headings (count, skipped);
- Landmarks (list);
- Targets (undersized count);
- Focus (`<k> of <n> kinds visible`).

**Glance:**
- a checklist: no skipped headings, `main` present, labels match names, no broken references, targets OK, focus visible;
- a focus-sample table: kind, sample selector, and what changed.

**Render:** grouped tables per rule with samples, plus the heading outline including the hidden headings, which are marked.

## Focus-style probe (capture)

**When:**
- in `capture.js`, after the page-phase plugins and before `captureViews`;
- only when `settings.capture.focusCheck !== false`, which defaults to true.

It has its own 10 s timeout. A failure becomes a capture warning.

**Steps:**

1. **Mark the samples.** A self-contained page function, `focusSamples()`, picks at most one visible sample of each kind and marks it with `data-harplus-focus="<kind>"`. It returns `[{ kind, selector }]`. The kinds are:
   - `inline-link`: an `a[href]` inside a `p` or `li` with sibling text;
   - `nav-link`: an `a[href]` inside `nav`;
   - `button`: `button`, or `[role=button]`;
   - `text-input`: `input` of type `text`, `email`, `search`, `tel`, `url` or `password`, or `textarea`;
   - `select`;
   - `checkbox`: a checkbox or radio;
   - `summary`;
   - `custom`: `[tabindex="0"][role]` that isn't a native control.

   It skips elements inside `[aria-hidden=true]`, disabled elements and elements that aren't rendered.

2. **Read the styles before.** A page function `focusStyles()` returns, per marked element, its computed `outline-style`, `outline-width`, `outline-color`, `box-shadow`, `border-color`, `border-width`, `background-color`, `text-decoration-line` and `color`.

3. **Force focus.** Run `DOM.enable` and `CSS.enable`, then `DOM.getDocument({ depth: 0 })` and `DOM.querySelectorAll({ nodeId: root, selector: '[data-harplus-focus]' })`. For each node, call `CSS.forcePseudoState({ nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] })`.

4. **Read the styles after** with `focusStyles()` again.

5. **Clean up, always**, in a `finally`: `CSS.forcePseudoState({ nodeId, forcedPseudoClasses: [] })` for every node, a page function that removes every `data-harplus-focus` attribute, then `CSS.disable`.

6. **Count outline removals.** `outlineNone` is the number of readable CSS rules whose selector contains `:focus` and whose style sets `outline: none`, or `outline` / `outline-style` to `0` or `none`, without also setting `box-shadow`, `border`, `background` or `text-decoration` in the same rule.

7. **Store the result:** `hp.capture.focus = { samples: [{ kind, selector, changed: ['outline', 'box-shadow', …] }], outlineNone }`. `changed` lists the properties whose computed value differs after forcing. "outline" counts only when the width is greater than 0 and the style isn't `none`.

**Kind labels** for findings: Inline links, Navigation links, Buttons, Text fields, Select menus, Checkboxes and radios, Disclosure summaries, Custom controls.

**Settings:** `DEFAULTS.capture.focusCheck: true`. Options gets the chip "Focus-style check". The popup gets the same.

No focus or blur events fire, so page scripts don't run, menus don't open and nothing scrolls.

## Clean-up of the duplicates

| Plugin | Change |
|---|---|
| `a11y-basics` | remove the rules `heading-order`, `empty-heading` and `landmark-main`; update its glance checklist and note text |
| `html` | remove the finding `No <main> element` |
| `content` | remove the findings `<n> skipped heading levels` and `<n> empty headings`. Keep the outline display and the long-headings info. Its `collect()` keeps only rendered headings that aren't `aria-hidden` |

Existing tests that assert the removed findings are updated to assert their absence.

## Testing

**Unit tests (`node --test`):**
- `color.js`:
  - parsing;
  - compositing over white;
  - WCAG ratios: #000 on #fff is 21, #777 on #fff is 4.48, #767676 on #fff is 4.54;
  - APCA: #000 on #fff ≈ 106, #fff on #000 ≈ −108, #888 on #fff ≈ 63, all within ±1.
- `contrast` `run()` on synthetic collected data:
  - grouping;
  - AA pass and fail at 4.5 and 3 for large text;
  - the cap of 10 findings and the "…and N more" finding;
  - unknown elements;
  - APCA-only pairs;
  - the glance and render show no NaN, and only `#rrggbb` reaches inline styles.
- `a11y-structure` `analyze()` on synthetic collected data: every rule at and below its threshold, mobile-only rules, and the focus findings (all none, some none, outline-none detail).
- The clean-up: `a11y-basics`, `html` and `content` no longer emit the removed findings.

**E2E.** The test site gains:
- a grey-on-white paragraph (`#999` on `#fff`);
- a 16×16 icon button next to another button;
- a `role="heading"` element;
- `aria-labelledby` pointing to a missing id;
- an `img` with `alt="image of a tent"`;
- `autocomplete="emial"`;
- a global `a:focus { outline: none }` rule, with buttons keeping their default focus ring.

The e2e asserts:
- the contrast pair finding for `#999999` on `#ffffff`;
- the 2.5.8 target finding;
- the broken-reference finding;
- the alt-text finding;
- the autocomplete finding;
- "Inline links show no visible focus indicator", with "Buttons" absent;
- `hp.capture.focus.samples` contains `button` with a non-empty `changed`;
- no `data-harplus-focus` attributes remain in the page.

## Out of scope

- Contrast of non-text UI components (WCAG 1.4.11).
- Text-shadow and stroke compensation.
- Contrast inside shadow DOM and iframes.
- Live focus traversal (tabbing) and focus traps.
- Polypane's accessibility-tree name and role checks beyond the rules above.
