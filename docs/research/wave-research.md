# WAVE vs HARgus accessibility: research and gap analysis

Date: 2026-10-24. Repo state: `main` @ 107405e. Read-only research; no project files changed.

## TL;DR

1. **The biggest gap is that the full engine isn't running.** axe-core is off by default (`defaultEnabled: false`) and isn't vendored. `extension/plugins/vendor/` holds only `.gitkeep`, and `scripts/vendor-axe.sh` has to be run by hand. So a typical reading gets only HARgus's heuristic checks, about 30 rules in all. axe-core has about 100 rules, and WAVE has 110 item types.
2. **HARgus never shows the alt text of the page's images.** `images.js` records only `alt: img.hasAttribute('alt')`, a boolean, and it lives in the Performance area. `a11y-basics` counts images with *no* alt attribute. `a11y-structure` shows the alt text only for up to 5 images it flags as "unhelpful".
3. **What HARgus has and lacks:**
   - It has a heading outline (`h.outline`, buried in the Structure plugin's detail panel) and landmark *counts*.
   - It has no landmark map, no tab or reading-order list, and no in-page or screenshot annotations.
   - Findings are text plus CSS selectors, with at most 5 samples per rule.
4. **WAVE's value is presentation as much as rules:**
   - icons placed on the page next to each element, with alt text shown inline;
   - Order, Structure and Contrast panels;
   - a Styles-off view;
   - "Features" and "Structure" items that show what is *right*, alongside alerts that need a human.
5. **Recommended order:**
   1. Ship and enable axe-core, and surface its "needs review" results.
   2. Add an "Images & alt text" panel.
   3. Annotate screenshots with WAVE-style markers.
   4. Add Structure, Order and Landmark panels.
   5. Port the cheap WAVE heuristics HARgus lacks: `alt_redundant`, `alt_duplicate`, `alt_link_missing`, `heading_possible`, `list_possible`, `link_redundant`, `link_skip_broken`, `label_*`, `fieldset`, `meta_refresh`, `title_invalid` and similar.

---

## 1. WAVE in depth

### 1.1 Sources

- **Item list.** WAVE API docs, https://wave.webaim.org/api/docs, also available as `?format=json`. Lists 110 items with id, title, type, summary and WCAG mapping.
- **Detection logic.** I took the per-item "The Algorithm... in English" text and the panel UI from the WAVE Chrome extension v3.3.1.0 (id `jbbplnpkjmmeebjpijfedlgcdilocofh`), in `sidebar.min.js` and `sidebar.html`. The same text appears in WAVE's Reference panel. Extracted table: `/private/tmp/claude-501/-Users-tpowell-src-har-plus/9de64588-9328-4473-9a40-b270ed17d3a8/scratchpad/dl/details.tsv`
- **Help.** https://wave.webaim.org/help
- **API parameters.** https://wave.webaim.org/api/details

### 1.2 Categories and counts

| Category | Colour or icon | Count | Meaning |
|---|---|---|---|
| Errors | red | 22 | Likely failures |
| Contrast Errors | red/contrast | 1 | WCAG 1.4.3 text contrast |
| Alerts | yellow | 42 | Need human review |
| Features | green | 13 | Accessibility features present (positive) |
| Structural Elements | blue | 22 | Headings, lists, landmarks, tables, iframes |
| ARIA | purple | 10 | ARIA present: "check it's right" |

The WAVE API's `reporttype` levels are:

| Level | Credits | Returns |
|---|---|---|
| 1 | 1 | Counts |
| 2 | 2 | Per-item counts |
| 3 | 3 | Contrast data and XPaths |
| 4 | 3 | Contrast data and CSS selectors |

Other parameters: `viewportwidth` (default 1200) and `evaldelay` (default 250 ms).

### 1.3 Complete item list and what triggers each one

Wording is condensed from WAVE's "Algorithm in English" text.

**Errors**

| id | Trigger |
|---|---|
| alt_missing | `<img>` has no alt attribute |
| alt_link_missing | Image with missing, empty or space-only alt (or hidden) inside a link that has no other text or alt |
| alt_spacer_missing | No alt, and the image is ≤3 px in width or height or named spacer./space./blank.* |
| alt_input_missing | `input[type=image]` with missing or empty alt |
| alt_area_missing | `<area>` with missing or empty alt |
| alt_map_missing | `img[usemap]` without alt |
| longdesc_invalid | longdesc is empty, not a URL, or points to an image |
| label_missing | input (not image, submit, reset, button or hidden), select or textarea without a proper label. Valid: `label[for]` to a unique id, a wrapping label, non-empty `title`, or non-empty `aria-labelledby` |
| label_empty | Associated label has no text and no alt |
| label_multiple | Two or more labels for one control |
| aria_reference_broken | aria-labelledby or aria-describedby points to a missing id |
| aria_menu_broken | `role=menu` with no menuitem, menuitemcheckbox or menuitemradio |
| title_invalid | Title is missing, empty or whitespace, or starts with "untitled" |
| language_missing | `<html lang>` is missing or empty, or any lang value is invalid |
| meta_refresh | `<meta http-equiv=refresh>` |
| heading_empty | Heading with no text and no alt |
| button_empty | `<button>` with no text or alt, or a submit, button or reset input with no value |
| link_empty | `a[href]` with no text and no alt |
| link_skip_broken | "skip"/"jump" in-page link that is display:none or visibility:hidden, or whose target is missing |
| th_empty | Empty `<th>` |
| blink | `<blink>` or `text-decoration: blink` |
| marquee | `<marquee>` |

**Contrast:** `contrast` fires below 4.5:1, or 3:1 for large text (≥18pt, or 14pt bold). WAVE skips text with transparency, gradients or filters.

**Alerts**

| id | Trigger |
|---|---|
| alt_suspicious | Alt starts with "graphic of", "bullet" or "image of"; ends in "image" or "graphic"; is only spaces; is a file name; or is one of: image, graphic, photo, photograph, drawing, painting, artwork, logo, bullet, button, arrow, more, spacer, blank, chart, table, diagram, graph, `*` |
| alt_redundant | Alt equals text within 15 characters of the image |
| alt_duplicate | Same non-empty alt (case-insensitive) on images with at most 2 other images between them |
| alt_long | Alt longer than 100 characters |
| longdesc | Valid longdesc is present |
| image_title | Image has a title but no alt |
| label_orphaned | Label wraps nothing and has no `for`, or its `for` is missing, unlabellable, or points to a hidden input |
| label_title | Unlabelled control that has a `title` |
| select_missing_label | `<select>` with no label or ARIA label |
| fieldset_missing | At least 2 checkboxes or radios sharing a name, not inside a fieldset |
| legend_missing | Fieldset with no legend, or an empty one |
| heading_missing | No h1–h6 |
| h1_missing | No `<h1>` |
| region_missing | No header, nav, main, footer or aside, and no landmark roles |
| heading_skipped | A level is skipped (h1 straight to h3). An h1 is not required to come first. |
| heading_possible | `<p>` under 50 characters that is ≥20 px, or ≥16 px and bold or italic |
| table_layout | `<table>` with no `<th>` |
| table_caption_possible | Data table without a caption whose first cell has colspan ≥3, or with a short bold or centred `<p>` right before it |
| list_possible | Text that starts like a list: `* `, `1. `, `a. `, `1) `, `a) `, `- ` |
| link_internal_broken | `#` link with no matching id or name |
| link_suspicious | Link text (including alt) contains "click" or "click here", or is: here, more, more..., details, more details, link, this page, continue, continue reading, read more, button |
| link_redundant | Two adjacent links to the same URL |
| link_word / link_excel / link_powerpoint / link_pdf / link_document | Links to .doc(x), .xls(x), .ppt(x)/.pps(x), .pdf, or rtf/odt/pages/key and similar |
| audio_video | Links to or embeds of media files (mp3, mp4, webm, mov and others) |
| html5_video_audio | `<video>` or `<audio>` (check captions and transcripts) |
| youtube_video | Embedded or linked YouTube video |
| flash / applet / plugin | `<object>` or `<embed>` (Flash or unknown), `<applet>` |
| noscript | `<noscript>` is present |
| event_handler | onmouseover without onfocus; onclick on a non-link, non-control, non-tabindex element; ondblclick |
| javascript_jumpmenu | `select[onchange]` |
| accesskey | Any accesskey |
| tabindex | Positive tabindex |
| text_small | Text ≤10 px |
| text_justified | p, div or td with more than 500 characters and `text-align: justify` |
| underline | `<u>`, or `text-decoration: underline` on non-links |
| title_redundant | `title` equals the element text or alt |

**Features**

| id | Trigger |
|---|---|
| alt | Non-empty alt |
| alt_null | `alt=""` |
| alt_spacer | Spacer image with `alt=""` |
| alt_link | Linked image whose alt names the link |
| alt_input | Image input with alt |
| alt_map | `img[usemap]` with alt |
| alt_area | `<area>` with alt |
| figure | `<figure>` |
| label | Correctly associated label |
| fieldset | Fieldset present |
| link_skip | Working, visible skip link |
| link_skip_target | Its target |
| lang | Valid lang on the document or an element |

**Structural Elements**

| id | Trigger |
|---|---|
| h1–h6 | Headings |
| ol, ul, dl | Lists |
| header (banner), nav, search, main, aside (complementary), footer (contentinfo) | Landmarks |
| region | `role=region` with a label |
| table_data | Table with a `<th>` |
| table_caption | `<caption>` |
| th, th_col, th_row | Header cells, by scope |
| iframe | Inline frames |

**ARIA**

| id | Trigger |
|---|---|
| aria | Any role, state or property other than landmarks or labelledby/describedby |
| aria_label | aria-label or aria-labelledby |
| aria_describedby | aria-describedby |
| aria_live_region | role=alert or alertdialog, or aria-live |
| aria_menu | role=menu or menubar |
| aria_button | Non-button element with role=button |
| aria_expanded | aria-expanded |
| aria_haspopup | aria-haspopup |
| aria_tabindex | tabindex of 0 or less |
| aria_hidden | aria-hidden="true" |

WAVE also computes an **AIM Score** out of 10, shown in the Details panel.

### 1.4 How WAVE presents results

From the extension's `sidebar.html` and the help page.

- **In-page icons.** WAVE injects a coloured icon next to every flagged element:
  - **Placement** follows a per-item `position` (first, after or last) and `icon_order`.
  - **Alt text inline:** the alt text appears beside the image. That is the "show ALT text" behaviour the owner wants.
  - **Tooltip and links:** hovering an icon gives a tooltip with a REFERENCE link. Clicking an icon in the sidebar scrolls to it and highlights it.
  - **Hidden elements:** icons for hidden elements are dimmed in the sidebar.
- **Details panel.** Grouped by category, then by item type with counts. Each item type is a toggle, so the person can show or hide those icons.
- **Reference panel.** For each item:
  - What It Means
  - Why It Matters
  - What To Do
  - The Algorithm... in English
  - WCAG guidelines
  - a link to the icon index
- **Order panel.** "Order, role, and accessible name (what is read by a screen reader) for all navigable page elements". This is a tab-order list showing "NO ACCESSIBLE NAME" where one is missing, with a "Refresh Navigation Order" button.
- **Structure panel.** A nested outline of headings, landmarks and lists in DOM order, or "This page has no heading structure!".
- **Contrast panel.**
  - Foreground/background hex inputs, colour pickers, alpha and lightness sliders.
  - Ratio, text size, sample text, and WCAG AA/AAA pass or fail.
  - A **Desaturate page** (grayscale) toggle.
  - A note that WAVE can't measure text over gradients, filters or transparency, and to use the eye-dropper for images.
- **Styles OFF/ON.** Disabling CSS "reveals hidden-element icons and the underlying reading and navigation order".
- **Code panel.** A Code tab at the bottom shows the markup for the selected icon, linked in both directions with the icons.

### 1.5 Limitations and critiques

- **WebAIM's own position:**
  - "WAVE cannot tell you if your web content is accessible. Only a human can determine true accessibility."
  - "The absence of errors DOES NOT mean your page is accessible or compliant."
  - The web-hosted version may not fully apply JavaScript, so WebAIM recommends the extensions.

  Source: https://wave.webaim.org/help
- **Contrast blind spots:** WAVE skips gradients, filters, transparency and text over images. It checks only the static state: no hover, focus or animation.
- **No real keyboard testing.** The Order panel lists the order but never tabs, so it can't detect focus traps or missing focus indicators.
- **Shallow rules:** the alt, link and heading heuristics are simple string and size rules. They are noisy by design: alerts are "check this", not failures.
- **Missing rules:** compared with axe, WAVE has no duplicate-id check, no ARIA required-attribute, allowed-role or required-children validation, and no "content outside landmarks" check. Source: Scott Logic, https://blog.scottlogic.com/2023/09/27/accessibility-tooling-wave-vs-axe.html
- **Interference with axe:** WAVE's injected icons can cause axe to report false positives if both run on the same DOM.
- **Coverage benchmark:** GDS ran its test page with 142 deliberate barriers (updated April 2018):

  | Tool | Barriers found | Including "potential" barriers |
  |---|---|---|
  | WAVE | 30% | 39% |
  | aXe | 29% | 30% |
  | Siteimprove | 29% | 36% |
  | Tenon | 34% | 34% |
  | HTML_CodeSniffer | 20% | 34% |

  WAVE's extra coverage comes from its *alerts*. Source: https://alphagov.github.io/accessibility-tool-audit/
- **Deque's counter-claim:** across about 2,000 audits and 300k issues, axe-based automated testing caught about 57% of issues *by volume*. This is a vendor study: the common issue types dominate the count. Source: https://www.deque.com/blog/automated-testing-study-identifies-57-percent-of-digital-accessibility-issues
- **Where real failures cluster:** the WebAIM Million 2026, run with WAVE on about 1M home pages, found:
  - 96% of all detected errors fall in six types: low-contrast text (83.9% of pages), missing alt (53.1%), missing labels (51%), empty links (46.3%), empty buttons (30.6%), missing lang (13.5%).
  - An average of 66.6 images per page, 16.2% of them missing alt; 45% of the images missing alt are linked images.
  - 10.8% of alt texts are questionable or repetitive.

  Source: https://webaim.org/projects/million/

### 1.6 WAVE vs axe-core in brief

| | WAVE | axe-core |
|---|---|---|
| Philosophy | Visual, human-assisted. Shows features and structure, plus many "alerts" | Zero false positives. "violations" are certain; "incomplete" means needs review |
| Strengths | Alt text inline, icons on the page, Order and Structure panels, Styles off, heuristic alerts (redundant or suspicious alt, possible heading or list, redundant links, document links, media) | ARIA validity (roles, attributes, required children and parents), duplicate ids, landmark rules (`region`, `landmark-*`), nested-interactive, scrollable-region-focusable, `target-size`, `label-title-only`, list structure, table header associations, `svg-img-alt`, `role-img-alt`, `object-alt`, `image-redundant-alt`, `identical-links-same-purpose`, CI-friendly |
| Overlap | Missing alt, empty links and buttons, labels, contrast, lang, title, headings, meta refresh, blink and marquee, tabindex, skip link | Same |
| Neither does | Keyboard operation, focus traps, screen-reader announcements, meaningful-alt judgement, captions quality, reading-order sense | Same |

Practitioner consensus is to use both: WAVE for manual visual review, axe for breadth and CI.

---

## 2. HARgus today (code inventory)

### 2.1 Plugins in the Accessibility area

All are registered in `extension/plugins/index.js`, and each one's `area` is `accessibility`.

**`/Users/tpowell/src/har-plus/extension/plugins/a11y-basics.js`**, runs in the page, isolated world. Checks:

| Check | Notes |
|---|---|
| html-lang | Presence only; the value isn't validated |
| document-title | Empty only |
| image-alt | `img:not([alt])` that is visible and not role=presentation or none |
| input-label | |
| button-name | |
| link-name | |
| frame-title | |
| meta-viewport | Zoom blocked |
| duplicate-id | |
| tabindex | Positive values |
| autoplay-audio | |
| focusable-hidden | Focusable elements inside aria-hidden |

Also collects stats (images, fields, links, buttons, landmark count, skip link present) and keeps at most 5 selector samples per rule. Its glance shows an "Issues by check" bar chart and a checklist.

**`/Users/tpowell/src/har-plus/extension/plugins/a11y-structure.js`**. Checks:

| Group | Checks |
|---|---|
| Headings | Outline (≤300 visible, plus hidden ones); skipped, empty and duplicate headings |
| Landmarks | Counts for main, nav, aside, banner, contentinfo; missing or multiple main; nav and aside labels not distinct |
| Names and references | label-in-name (2.5.3); broken label, describedby and ARIA references |
| Links | Plain HTTP links; same URL with different text; current-page link without aria-current |
| Alt and forms | `badAlt`: "image of…", a generic word, a file name, a long number, or more than 150 characters; invalid autocomplete; reset button |
| Size | Targets under 24 px (2.5.8) and 44 px (mobile); text under 12 px; form fields under 16 px (mobile) |
| Focus | Focus order jumping back up the page; focusable div or span without a role; focus-indicator probe results from capture (`core/focus.js`) |

Its render shows `h.outline(headings)` (the **heading outline**), hidden headings, and a rule table.

**`/Users/tpowell/src/har-plus/extension/plugins/contrast.js`**:
- Checks every text element against its composited background, with WCAG AA and advisory APCA results.
- Skips text over images, gradients and media, and reports those as "could not be checked".
- Renders colour-pair swatches.

**`/Users/tpowell/src/har-plus/extension/plugins/axe.js`**:
- Injects `plugins/vendor/axe.min.js` (`scripts/vendor-axe.sh`, default 4.13.0) and runs tags wcag2a, aa, 21a, 21aa, 22aa and best-practice.
- `resultTypes: ['violations']`. **incomplete ("needs review") results are reduced to a count**; their nodes are dropped.
- Keeps 5 sample targets per rule.
- **`defaultEnabled: false`, and the vendor file is absent from the repo, which gitignores `extension/plugins/vendor/*.js`.**

**`/Users/tpowell/src/har-plus/extension/plugins/a11y-views.js`**, offline. Turns the capture views into findings:

| View | What it checks |
|---|---|
| reflow | 320 px (1.4.10) |
| spacing | Text spacing (1.4.12) |
| text200 | 200% text (1.4.4) |
| dark | Dark mode |
| forced | Forced colours: opt-outs and icon-only controls |
| morecontrast | prefers-contrast styles present |
| print | Print output |

The vision views (protanopia, deuteranopia, tritanopia, achromatopsia, blurred, low contrast) are captured as screenshots but produce no measurements.

**Elsewhere:**
- `html.js`: fake buttons and click-divs, categorised as accessibility.
- `pagespeed.js`: Lighthouse's accessibility score, remote.
- `content.js`: vague link text ("click here" and similar), in the **Content** area, not Accessibility.
- `meta.js`: no-h1, in the SEO and Content area.
- `images.js`: every image's size and format; alt is a boolean only, in the **Performance** area.
- `layout.js`: breakpoint overflow only; nothing accessibility-specific.

### 2.2 UI

In `/Users/tpowell/src/har-plus/extension/ui/report.js`:

- **Accessibility area pane** (`areaPane`, about lines 233–253):
  1. score ring
  2. glances (charts and checklists)
  3. top 8 findings
  4. "Plugin detail": each plugin's `render()` table
- **Findings** are text with CSS-selector evidence and no element screenshots. axe adds a `helpUrl` link.
- **Screens tab** (`screensPane`, about line 585):
  - device lineup;
  - resilience views (no JS, No CSS, no images);
  - international views;
  - accessibility views as captioned screenshots with rating chips;
  - vision-simulation screenshots.

  None of the screenshots carry annotations or overlays.

### 2.3 Direct answers

| Question | Answer |
|---|---|
| Does HARgus show each image's alt text? | **No.** Only up to 5 "unhelpful alt" samples (selector plus alt) in the Structure table. `images.js` stores `alt` as a boolean and has no column for it. No thumbnails are tied to alt. |
| Heading outline? | **Yes**, in a11y-structure's plugin detail (`h.outline`, `ui/render.js:71`). It's flat and indented, with no flagging of skipped levels per row, and isn't linked to the page. |
| Landmark map? | **No.** Counts only in the summary ("main 1 · nav 2 · aside 0"). |
| Tab or reading order? | **No list.** Only a "focus order jumps back up N times" finding, and the focus-style probe samples. |
| In-page annotations or icons on screenshots? | **None.** The No CSS screenshot exists (Screens, Resilience) but has no markers. |

---

## 3. Gap analysis: WAVE item → HARgus coverage

Legend: ✅ covered · 🟡 partial · ❌ missing. "axe" means available from axe-core but off by default; with axe enabled many ❌ become ✅.

### Errors

| WAVE | HARgus | Where / notes | axe rule |
|---|---|---|---|
| alt_missing | ✅ | a11y-basics `image-alt` (visible only) | image-alt |
| alt_link_missing | 🟡 | Indirect: basics `link-name` catches links with no name; nothing targets image-only links | image-alt, link-name |
| alt_spacer_missing | ❌ (falls under image-alt) | | — |
| alt_input_missing | ❌ | `input[type=image]` is excluded from input-label and never alt-checked | input-image-alt |
| alt_area_missing / alt_map_missing | ❌ | | area-alt |
| longdesc_invalid | ❌ | Obsolete; low value | — |
| label_missing | ✅ | basics `input-label` | label |
| label_empty | ❌ | A label element with no text counts as "labelled" | label |
| label_multiple | ❌ | | form-field-multiple-labels |
| aria_reference_broken | ✅ | structure `labelRefs` / `ariaRefs` | aria-valid-attr-value |
| aria_menu_broken | ❌ | | aria-required-children |
| title_invalid | 🟡 | Empty title only; "untitled" not checked | document-title |
| language_missing | 🟡 | Presence only; the lang value and element langs aren't validated (the language plugin may cover part) | html-has-lang, html-lang-valid, valid-lang |
| meta_refresh | ❌ | | meta-refresh |
| heading_empty | ✅ | structure `empty` | empty-heading |
| button_empty | ✅ | basics `button-name` | button-name |
| link_empty | ✅ | basics `link-name` | link-name |
| link_skip_broken | ❌ | Basics detects only that a skip link is *present* | skip-link |
| th_empty | ❌ | | empty-table-header |
| blink / marquee | ❌ | | blink, marquee |
| contrast | ✅ | contrast.js, stronger than WAVE (composited alpha, APCA) | color-contrast |

### Alerts

| WAVE | HARgus | Notes | axe |
|---|---|---|---|
| alt_suspicious | 🟡 | structure `badAlt`: smaller word list, no "bullet", "graphic of", trailing "image", space-only or `*` | — |
| alt_redundant | ❌ | | image-redundant-alt (narrower) |
| alt_duplicate | ❌ | | — |
| alt_long | 🟡 | More than 150 characters, not 100 | — |
| image_title | ❌ | | — |
| label_orphaned / label_title / select_missing_label | ❌ / 🟡 / 🟡 | `title` silently counts as a label | label-title-only |
| fieldset_missing / legend_missing | ❌ | | — |
| heading_missing / h1_missing | 🟡 | No-h1 lives in the meta plugin under SEO and Content | page-has-heading-one |
| region_missing | 🟡 | "No `<main>`" only | region, landmark-one-main |
| heading_skipped | ✅ | Count only; doesn't say *where* | heading-order |
| heading_possible | ❌ | | — |
| table_layout / table_caption_possible | ❌ | | — |
| list_possible | ❌ | | — |
| link_internal_broken | ❌ | | — |
| link_suspicious | 🟡 | content.js `VAGUE`, in the Content area | — |
| link_redundant | ❌ | structure `multiText` is the inverse (same URL, *different* text) | — |
| link_pdf / word / excel / ppt / document | ❌ | | — |
| audio_video / html5_video_audio / youtube_video | 🟡 | autoplay-audio only; nothing on captions or `<track>` | video-caption, audio-caption (deprecated) |
| flash / applet / plugin | ❌ | | object-alt |
| noscript | ❌ | Low value; HARgus has a No-JS view instead | — |
| event_handler / javascript_jumpmenu | 🟡 | html.js counts fake buttons and click-divs | — |
| accesskey | ❌ | | accesskeys |
| tabindex | ✅ | basics `tabindex` | tabindex |
| text_small | ✅ | Under 12 px, stricter than WAVE's ≤10 px | — |
| text_justified / underline | ❌ | | — |
| title_redundant | ❌ | | — |

### Features, Structure and ARIA (the "what's present" inventory)

| WAVE | HARgus | Notes |
|---|---|---|
| alt / alt_null / alt_link / alt_input… (alt shown inline) | ❌ | **No inventory of images with their alt; decorative (`alt=""`) vs informative is never shown** |
| label / fieldset / figure | ❌ | No forms inventory |
| link_skip / link_skip_target | 🟡 | Boolean "skip link" in basics stats |
| lang (element-level) | ❌ (accessibility) | |
| h1–h6 outline | ✅ | `h.outline` in Structure detail |
| landmarks (header, nav, search, main, aside, footer, region) | 🟡 | Counts only; no map; `search` and `region` not counted |
| lists, tables, th scope, iframe inventory | ❌ | |
| ARIA inventory (live regions, expanded, haspopup, hidden, role=button) | 🟡 | Partly in `noRole` / `focusable-hidden` |

### Presentation

| WAVE feature | HARgus | Notes |
|---|---|---|
| Icons on the page next to elements | ❌ | No overlay on any screenshot |
| Alt text shown inline | ❌ | |
| Order panel (tab order, role, accessible name) | ❌ | Collected internally (`order` in a11y-structure `collect`) but thrown away after computing jumps |
| Structure panel (headings, landmarks, lists) | 🟡 | Headings only |
| Styles off | ✅ (screenshot) | No-CSS view exists in Screens → Resilience; no markers on it |
| Contrast tool (pickers, desaturate) | 🟡 | Pairs and swatches plus the achromatopsia screenshot; no interactive picker (fine for a static report) |
| Reference: what, why, how to fix, algorithm, WCAG | 🟡 | axe findings link to Deque docs; HARgus's own rules have a title and sometimes `detail`, with no WCAG mapping or "how to fix" on most |
| Per-item element list with code | 🟡 | 5 selector samples per rule; HTML snippets are collected (`samples[].html` in basics and axe) but not shown |

---

## 4. Recommendations (prioritised)

Effort: S is under a day, M is 1–3 days, L is about a week.

### High

**H1. Ship axe-core enabled by default, and surface "needs review".** Effort: S–M.
- **Licensing:** axe-core is MPL-2.0, so it can be bundled with attribution.
- **Changes:** vendor `axe.min.js` (commit it, or fetch it in the build and stop gitignoring it), and set `defaultEnabled: true`.
- **Show incomplete results:** in `axe.js` `collect`, add `'incomplete'` to `resultTypes` and keep its nodes. Show them as a "Needs review" group (info severity), the equivalent of WAVE's alerts.
- **Show code:** include `samples[].html` in the render, as WAVE's Code panel does.
- **Deduplicate:** when axe ran, suppress or merge the basics findings that duplicate it (image-alt, label, button-name, link-name, duplicate-id), so scores don't double-count. Map axe rule id to basics id.
- **What the person sees:**
  - about 100 rules instead of about 30;
  - new findings for ARIA validity, landmarks/region, `skip-link`, `meta-refresh`, `input-image-alt`, `area-alt`, `svg-img-alt`, `role-img-alt`, `label-title-only`, `form-field-multiple-labels`, list and table structure, `video-caption`, `html-lang-valid`, `nested-interactive`, `scrollable-region-focusable`;
  - a "Needs review" list.

**H2. "Images & alt text" panel**, in the Accessibility area and on the glance. Effort: M.
- **Collect** for every `img`, `input[type=image]`, `area`, `svg[role=img]`, `[role=img]` and CSS background-image hero:
  - src
  - alt (raw, distinguishing missing, empty and whitespace)
  - computed accessible name
  - whether it's linked, and the link's other text
  - the nearby text (±15 characters)
  - visibility
  - rect
- **Show** a grid or table: thumbnail (from the HAR response body, already present for images, or a crop of the full-page screenshot), alt text in quotes, role (decorative, informative, linked, button), and a WAVE-style verdict chip:

  | Verdict | WAVE equivalent |
  |---|---|
  | Missing | alt_missing |
  | Empty: decorative | alt_null |
  | Empty inside a link | alt_link_missing |
  | Suspicious | WAVE's full list, replacing `badAlt` |
  | Redundant with nearby text | alt_redundant |
  | Duplicate of nearby image | alt_duplicate |
  | Long | over 100 characters |
  | title but no alt | image_title |
  | Spacer | |
  | OK | |

- **Filters:** problems only, linked only, decorative only.
- **Why it's high:** this directly answers "show ALT text", and missing alt is the #2 failure on the web (53% of home pages).
- **Implementation notes:** share the collector with `images.js`, or add an `a11y-images` plugin in the accessibility area. The thumbnail can come from `images.js` data joined by `src`.

**H3. Annotated screenshots with WAVE-style markers.** Effort: M–L.
- **Collect:** during `collect`, record `getBoundingClientRect()` plus `scrollX`/`scrollY` for every flagged node and every image. For axe, call `axe.utils.getNodeFromTree` or use `document.querySelector(target)` to get rects.
- **Render:** in the report, draw an absolutely positioned SVG/HTML layer over the full-page screenshot. Markers are colour-coded the WAVE way (red error, yellow alert, green feature, blue structure), each numbered and linked to its finding.
- **Toggles:** errors, alerts, alt text, headings, landmarks, tab order.
- **Alt text on images:** a small alt label pinned to each image, which is WAVE's signature.
- **Where:** offer it on both the styled screenshot and the **No CSS** screenshot (WAVE's Styles off), which already exists.
- **Caveats:**
  - Lazy-loaded content and sticky headers can shift positions between collect and screenshot time. Collect rects at screenshot time, or in the same pass as the full-page capture.
  - The self-contained report has no scripts, so use CSS `:target` and checkbox hacks for toggles.

**H4. Order panel (tab order, role, accessible name).** Effort: S–M.
- **Data:** the `order` array is already built in `a11y-structure.collect`. Keep up to about 300 entries of `{index, role, name, selector, rect, tabindex}`.
- **Show:**
  - a numbered list, with "NO ACCESSIBLE NAME" highlighted in red, as WAVE does;
  - backward jumps flagged inline, instead of the bare "jumps N times" count;
  - optionally, numbered badges plus connecting lines over the screenshot as a tab-order overlay (reuse H3).
- **Accessible name:** compute it with a better algorithm. axe exposes `axe.commons.text.accessibleText(node)` when axe is loaded; otherwise use the existing `name()`.

### Medium

**M1. Structure panel: headings, landmarks and lists as one nested outline.** Effort: S–M.
- **Content:** DOM-order tree of landmarks (banner, nav with its label, search, main, complementary, contentinfo, region) with headings nested inside.
- **Inline marks:** skipped levels (h2 → h4), empty headings, and h1 count, all marked on the row itself.
- **Exposure:** add `search` and labelled `region` to the counts. Move it out of "Plugin detail" onto the area glance.

**M2. Port the cheap WAVE heuristics that neither HARgus nor axe has.** Effort: M in total; each is a few lines in `a11y-structure.collect`.

| Heuristic | Rule |
|---|---|
| `heading_possible` | `<p>` under 50 characters that is ≥20 px, or ≥16 px and bold or italic |
| `list_possible` | Text starting with list markers such as `* `, `1. `, `- ` |
| `link_redundant` | Adjacent links to the same URL (the classic image link plus text link pair) |
| `alt_duplicate`, `alt_redundant` | Via H2 |
| `link_internal_broken` | `#` links with no target, beyond skip links |
| Document links | Links to PDF and Office files: an info-level inventory |
| `table_layout` | A table with no `th` |
| `text_justified` | |
| `title_redundant` | |
| `image_title` | |
| `fieldset_missing`, `legend_missing` | |
| `label_empty`, `label_orphaned` | |
| `title_invalid` | Add "untitled" |
| `link_suspicious` | Move or duplicate content.js's `VAGUE` list into accessibility, add WAVE's words ("this page", "continue reading", "button"), and include linked image alt text |

These are "alerts" and should score as info or low, not errors.

**M3. Features and inventory ("what's right").** Effort: S.

Show positive counts as WAVE's green and blue items do:
- images with alt, decorative images
- labelled fields, fieldsets
- skip link that works
- landmarks, lists, data tables with th and caption
- ARIA live regions, aria-expanded, aria-hidden

This gives reviewers context, and lets the Accessibility area say "53 images, 41 with alt, 9 decorative, 3 missing" rather than only listing failures.

**M4. Reference text per HARgus rule.** Effort: M.

For each HARgus rule, add "What it means / Why it matters / How to fix / WCAG SC", modelled on WAVE's Reference panel. Add a `wcag` field to findings so the report can filter by success criterion. axe findings already carry their tags and helpUrl.

**M5. Show elements, not only selectors.** Effort: S.

Render the `html` snippet already collected (basics and axe samples). When H3 exists, add a "show on page" link that jumps to the marker. Raise the 5-sample cap behind a "show all" toggle.

### Low

| # | Recommendation | Effort |
|---|---|---|
| L1 | Media: list every `<video>`, `<audio>` and YouTube/Vimeo iframe, flagging missing `<track kind=captions>` (axe `video-caption` covers part) | S |
| L2 | `meta_refresh`, `blink`/`marquee`, `accesskey`. Trivial, and axe covers them once it's on | S |
| L3 | Contrast markers on the screenshot, and "desaturated" side by side with the achromatopsia view that already exists | S, after H3 |
| L4 | An "AIM-like" single number is unnecessary: HARgus already scores the area | — |
| L5 | Language validity: validate `lang` values against BCP 47 on html and elements (axe `html-lang-valid` / `valid-lang` covers it) | S |

### What axe would already give us but we don't surface

- **The whole engine.** It is disabled by default and not shipped.
- **`incomplete` results.** WAVE-alert-like "needs review" items: contrast over images or gradients (exactly where `contrast.js` gives up), `aria-hidden` focus, link-in-text-block, and others. Today they are reduced to a number.
- **`passes`.** Could feed the "features" inventory (M3).
- **Node HTML and `failureSummary`.** Collected but not rendered; `failureSummary` is dropped in `render`.
- **Accessible names.** `axe.commons` helpers (`text.accessibleText`, `aria.getRole`) could compute accurate names and roles for the Order panel (H4) and the alt panel (H2).

### Suggested build order

1. H1: enable axe, plus incomplete results and HTML snippets. This brings the biggest jump in what HARgus catches.
2. H2: alt panel.
3. H4: Order list.
4. M1: Structure outline.
5. H3: annotation layer, which then powers alt-on-image, tab-order and landmark overlays.
6. M2 heuristics and M3 inventory, then M4 and M5 polish.
