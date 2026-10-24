# GDS test page and thymecare.com: HARgus calibration

Run 2026-10-24, headless Chromium with the unpacked extension, reload mode, default settings (`node scripts/calibrate.mjs --a11y`).

- **After**: this branch (worktree-a11y-wave, HEAD 5d3481e).
- **Before**: a checkout of the plan's base commit 56a927f (no axe, no Images panel, no keyboard walk, no Page map), run with the same script by passing the two URLs. This is the real old commit, not an axe-disabled approximation.
- Baselines: WAVE and axe results per case from the GDS audit (gds-audit-results.md in this folder).
- Raw readings and screenshots are not committed.

## How cases were mapped

Each case's expected barrier was checked against the reading's findings and Page map markers. Markers carry page coordinates; each was assigned to the case whose heading section contains it (section positions measured on the live page at 1280 px). The before reading has no markers, so its findings were matched by rule and by the sample selectors it keeps (samples are capped at 5 per rule). Verdicts:

- detected: HARgus flags the element or the barrier itself.
- partial: only a hint (a needs-review item, a page-level finding that does not name the element, or a shared count).
- n/a: the case lives on a separate example page that was not read (10 cases).

Verdicts are my hand judgement, not an automated check.

## Totals

In-page cases: 132 of 142 (10 are on separate example pages).

| | Detected | Partial | WAVE (same cases) | axe (same cases) |
|---|---|---|---|---|
| HARgus before (56a927f) | 19 | 6 | 41 reported | 36 issues |
| HARgus after (this branch) | 44 | 6 | 41 reported | 36 issues |

WAVE "reported" counts issue, warning-only and noticed. Counting only WAVE's "issue found", WAVE is 22 on the in-page cases.

Overlap with the baselines, counting HARgus "detected" only:

| | Cases WAVE reported | Cases axe found an issue |
|---|---|---|
| Before | 16 of 41 | 17 of 36 |
| After | 30 of 41 | 28 of 36 |

Target (recorded, not a gate): HARgus at least WAVE. By raw count the target is met (44 detected, 50 with partials, against WAVE's 41), but by overlap HARgus after finds 30 of WAVE's 41 and 28 of axe's 36. HARgus finds cases neither tool reports (for example the Images panel's file-name alt, target size, fake headings and lists). The misses against WAVE are mostly its warnings about content (justified text, links to PDF, sound or multimedia files, accesskey, spacer image) and "user to check" cases. The misses against axe are mostly radio and checkbox groups without a fieldset, `href="#"`, table headers and placeholder-only labels (modern axe no longer flags that one).

Accessibility area score on the GDS page: before 10, after -5 (see product bug 2). On thymecare.com: before 92, after 86.

## Per-case table

WAVE and axe columns are from the GDS data; Before and After are HARgus.

| # | Barrier | WAVE | axe | Before | After | HARgus finding |
|---|---|---|---|---|---|---|
| 1 | Content identified by location | Not found | Not found | - | - |  |
| 2 | Plain language is not used | Not found | Not found | - | - |  |
| 3 | Content is not in correct reading order in source code | Not found | Not found | - | - |  |
| 4 | Content is not organised into well-defined groups or chunks, using headings, lists, and other visual mechanisms | Not found | Not found | n/a | n/a | separate example page (not read) |
| 5 | First instance of abbreviation not expanded | Not found | Not found | - | - |  |
| 6 | Wide page forces users to scroll horizontally | Not found | Not found | detected | detected | layout finding names div.warning-icon (610 px); a11y-views reflow finding at 320 px |
| 7 | Colour alone is used to convey content | Not found | Not found | - | - |  |
| 8 | Small text does not have a contrast ratio of at least 4.5:1 so does not meet AA | Issue found | Issue found | detected | detected | contrast finding with element; axe color-contrast marker (after) |
| 9 | Large text does not have a contrast ratio of at least 3:1 so does not meet AA | Issue found | Issue found | detected | detected | contrast finding with element; axe color-contrast marker (after) |
| 10 | Small text does not have a contrast ratio of at least 7:1 so does not meet AAA | Issue found | Issue found | detected | detected | contrast finding with element; axe color-contrast marker (after) |
| 11 | Large text does not have a contrast ratio of at least 4.5:1 so does not meet AAA | Issue found | Issue found | detected | detected | contrast finding with element; axe color-contrast marker (after) |
| 12 | Focus not visible | Not found | Not found | - | - |  |
| 13 | Inadequate line height used | Not found | Not found | - | - |  |
| 14 | All caps text found | Not found | Not found | - | - |  |
| 15 | Blink element found | Issue found | Issue found | partial | detected | before: page-level "Obsolete HTML elements" lists <blink>; after: axe blink on the element |
| 16 | Italics used on long sections of text | Not found | Not found | - | - |  |
| 17 | Marquee element found | Issue found | Issue found | partial | detected | before: page-level "Obsolete HTML elements" lists <marquee>; after: axe marquee on the element |
| 18 | Long lines of text | Not found | Not found | - | - |  |
| 19 | Very small text found | Warning only | Not found | detected | detected | text element under 10 px (after marks it in the Page map) |
| 20 | Justified text found | Warning only | Not found | - | - |  |
| 21 | Text language changed without required change in direction | Not found | Not found | - | - |  |
| 22 | html element has an empty lang attribute | Not found | Issue found | n/a | n/a | separate example page (not read) |
| 23 | lang attribute not used to identify change of language | Not found | Not found | - | - |  |
| 24 | Text language is in the wrong direction | Not found | Not found | - | - |  |
| 25 | html element has an invalid value in the lang attribute | Not found | Issue found | n/a | n/a | separate example page (not read) |
| 26 | lang attribute used to identify change of language, but with invalid value | User to check | Issue found | - | detected | axe valid-lang |
| 27 | html element is missing a lang attribute | Issue found | Issue found | n/a | n/a | separate example page (not read) |
| 28 | html element has lang attribute set to wrong language | Not found | Not found | n/a | n/a | separate example page (not read) |
| 29 | lang attribute used to identify change of language, but with wrong language | Not found | Not found | - | - |  |
| 30 | Inappropriate page title | Not found | Not found | n/a | n/a | separate example page (not read) |
| 31 | Empty page title | Issue found | Issue found | n/a | n/a | separate example page (not read) |
| 32 | Missing page title | Issue found | Issue found | n/a | n/a | separate example page (not read) |
| 33 | Empty heading | Issue found | Issue found | detected | detected | empty headings (structure); axe empty-heading |
| 34 | Missing H1 | Warning only | Not found | n/a | n/a | separate example page (not read) |
| 35 | Text formatting used instead of an actual heading | Not found | Not found | - | detected | a11y-structure possible heading (alert) |
| 36 | Headings not structured in a hierarchical manner | Warning only | Issue found | detected | detected | skipped heading levels; axe heading-order |
| 37 | LI element with no parent | Not found | Issue found | - | detected | axe listitem |
| 38 | List not marked up as a list | Not found | Not found | - | detected | a11y-structure possible list (alert) |
| 39 | DT or DD elements that are not contained within a DL element | Not found | Issue found | - | detected | axe dlitem |
| 40 | Improperly nested lists | Not found | Issue found | - | detected | axe list |
| 41 | Table with column headers and double row headers | User to check | Not found | - | - |  |
| 42 | Table has no scope attributes | User to check | Not found | - | - |  |
| 43 | Table nested within table header | Not found | Not found | - | - |  |
| 44 | Table nested within table | Not found | Not found | - | - |  |
| 45 | Table has no table headings | User to check | Issue found | - | - |  |
| 46 | Table with inconsistent numbers of columns in rows | Not found | Not found | - | - |  |
| 47 | Table that only has TH elements in it | Not found | Issue found | - | partial | axe needs-review th-has-data-cells only |
| 48 | Table is missing a caption | User to check | Not found | - | - |  |
| 49 | Table used for layout | Noticed but not a fail | Not found | - | detected | a11y-basics layout-table (alert); before only flagged its small links |
| 50 | Table has an empty table header | Issue found | Not found | - | detected | axe empty-table-header |
| 51 | Table with some empty cells | Not found | Not found | - | - |  |
| 52 | Image has alt and title that are different | Not found | Not found | - | - |  |
| 53 | Image with presentation role has non-empty alt | Not found | Not found | - | detected | axe aria-allowed-role |
| 54 | Image with no alt attribute | Issue found | Issue found | detected | detected | Images without alt (a11y-basics, axe image-alt, Images panel verdict "missing") |
| 55 | Background image that conveys information does not have a text alternative | Not found | Not found | - | - |  |
| 56 | Image has empty alt and non-empty title | Not found | Not found | - | - |  |
| 57 | A distraction is present, an animated gif | Not found | Not found | - | - |  |
| 58 | Image that conveys information has an empty alt attribute | User to check | Not found | - | - |  |
| 59 | Image that conveys information has inappropriate alt text | User to check | Not found | - | - |  |
| 60 | Image alt attribute contains image file name | Warning only | Not found | - | detected | Images panel / Page map: alt text looks like a file name |
| 61 | Image with partial text alternative | User to check | Not found | - | - |  |
| 62 | Embedded video file is missing text alternative | User to check | User to check | - | partial | axe needs-review video-caption |
| 63 | Flashing content doesn't have warning | Not found | Not found | - | - |  |
| 64 | Embedded audio file is missing text alternative | User to check | User to check | - | - |  |
| 65 | Image link with no alternative text | Issue found | Issue found | detected | detected | link without accessible name; Images panel "empty-linked" |
| 66 | Link to javascript, invalid hypertext reference | Not found | Not found | - | - |  |
| 67 | Uninformative link text | Warning only | Not found | - | detected | vague link text (alert) |
| 68 | Link launches new window with no warning | Not found | Not found | - | - |  |
| 69 | Links not separated by printable characters | Not found | Not found | - | - |  |
| 70 | Link text with identical title | Warning only | Not found | - | detected | a11y-basics title-redundant (alert) |
| 71 | Links to a sound file, no transcript | Warning only | Not found | - | - |  |
| 72 | Identifying links by colour alone | Not found | Not found | - | - |  |
| 73 | Link to PDF does not include information on file format and file size | Warning only | Not found | - | - |  |
| 74 | Link to #, invalid hypertext reference | Not found | Issue found | - | - |  |
| 75 | Blank link text | Issue found | Issue found | partial | partial | link-name count 2 covers this case and 64; keyboard walk lists a hidden unnamed stop |
| 76 | Links with the same text go to different pages | Not found | Not found | - | - |  |
| 77 | Link text does not make sense out of context | Not found | Not found | - | - |  |
| 78 | Adjacent links going to the same destination | Warning only | Not found | - | detected | a11y-basics link-redundant (alert) |
| 79 | Link contains only a full stop | Not found | Not found | - | - |  |
| 80 | Image link alt text repeats text in the link | Warning only | Issue found | - | detected | axe image-redundant-alt; Images panel "redundant" |
| 81 | Link not clearly identifiable and distinguishable from surrounding text | Not found | Not found | - | - |  |
| 82 | Link to a multimedia file, no transcript | Warning only | Not found | - | - |  |
| 83 | Non-specific link text | Warning only | Not found | - | detected | vague link text (alert) |
| 84 | Link to an image, no text alternative | Not found | Not found | - | - |  |
| 85 | Image button has no alt attribute | Issue found | Issue found | - | detected | axe input-image-alt |
| 86 | Empty button | Issue found | Issue found | detected | detected | Buttons without accessible name; axe button-name; walk lists unnamed stop |
| 87 | Uninformative alt attribute value on image button | User to check | Not found | - | - |  |
| 88 | Empty alt attribute on image button | Issue found | Issue found | - | detected | axe input-image-alt |
| 89 | Errors identified by colour only | Not found | Not found | - | - |  |
| 90 | Labels missing when they would look clumsy for some form controls | Issue found | Issue found | detected | detected | form fields without a label (axe label; walk lists unnamed stop) |
| 91 | Error messages - no suggestion for corrections given, e.g. required format | Not found | Not found | - | - |  |
| 92 | Left aligned form labels with too much white space | Not found | Not found | - | - |  |
| 93 | Group of radio buttons not enclosed in a fieldset | Warning only | Issue found | - | - |  |
| 94 | Form element has no label | Issue found | Issue found | detected | detected | form field without a label |
| 95 | Fieldset without a legend | Warning only | Not found | - | detected | a11y-basics fieldset-legend |
| 96 | Empty legend | Not found | Not found | - | detected | a11y-basics fieldset-legend (empty legend) |
| 97 | Label element with for= attribute but not matching id= attribute of form control | Issue found | Issue found | detected | detected | label for= not matching: input-label; after also label-orphaned |
| 98 | Group of check boxes not enclosed in a fieldset | Warning only | Issue found | - | - |  |
| 99 | Empty label found | Issue found | Issue found | partial | detected | after: axe label + label-empty; before: input-label count 8 with samples capped at 5 |
| 100 | Two unique labels, but identical for= attributes | Issue found | Issue found | - | partial | axe needs-review form-field-multiple-labels |
| 101 | Errors identified with a poor colour contrast | Issue found | Issue found | detected | detected | contrast finding with element; axe color-contrast |
| 102 | Non-unique field label found | Not found | Not found | - | - |  |
| 103 | Missing labels in checkboxes | Issue found | Issue found | detected | detected | unlabelled checkboxes: input-label; after also label-orphaned |
| 104 | Field hint not associated with input | Not found | Not found | - | - |  |
| 105 | Placeholder no label | Issue found | Issue found | - | - |  |
| 106 | Errors are not identified | Not found | Not found | - | - |  |
| 107 | Form control that changes context without warning | Not found | Not found | - | - |  |
| 108 | Inadequately-sized clickable targets found | Not found | Not found | - | detected | axe target-size |
| 109 | Alert shows for a short time | Not found | Not found | - | - |  |
| 110 | Lightbox - close button doesn't receive focus | Not found | Not found | - | - |  |
| 111 | Focus order in wrong order | Not found | Not found | - | - |  |
| 112 | Tabindex greater than 0 | Warning only | Issue found | detected | detected | positive tabindex; axe tabindex; walk marks the stop |
| 113 | Keyboard focus is not indicated visually | Not found | Not found | - | detected | keyboard walk: stop shows no visible focus change |
| 114 | Keyboard focus assigned to a non focusable element using tabindex=0 | User to check | Not found | - | - |  |
| 115 | Concertina items don't get keyboard focus | Not found | Not found | - | - |  |
| 116 | Keyboard trap | Not found | Not found | n/a | n/a | separate example page (not read) |
| 117 | Dropdown navigation - only the top level items receive focus | Not found | Not found | - | - |  |
| 118 | Lightbox - ESC key doesn't close the lightbox | Not found | Not found | - | - |  |
| 119 | Link with a role=button does not work with space bar | Not found | Not found | - | - |  |
| 120 | Tooltips don't receive keyboard focus | Not found | Not found | - | - |  |
| 121 | Accesskey attribute used | Warning only | Not found | - | - |  |
| 122 | Lightbox - focus is not moved immediately to lightbox | Not found | Not found | - | - |  |
| 123 | Lightbox - focus is not retained within the lightbox | Not found | Not found | - | - |  |
| 124 | Fake button is not keyboard accessible | Not found | Not found | - | - |  |
| 125 | iframe is missing a title attribute | Not found | Issue found | detected | detected | Iframes without a title; axe frame-title |
| 126 | iframe title attribute does not describe the content or purpose of the iframe | Not found | Not found | - | - |  |
| 127 | Content is not readable and functional when text is increased | Not found | Not found | - | - |  |
| 128 | Non-decorative content inserted using CSS | Not found | Not found | - | - |  |
| 129 | visibility:hidden used to visually hide content when it should be available to screenreader | Not found | Not found | - | - |  |
| 130 | display:none used to visually hide content when it should be available to screenreader | Not found | Not found | - | - |  |
| 131 | Page zoom - boxes that don't expand with the text | Not found | Not found | - | - |  |
| 132 | Duplicate id | Not found | Issue found | detected | detected | Duplicate id values (info, page-level) |
| 133 | Article element used to mark-up an element that's not an article/blog post etc. | Not found | Not found | - | - |  |
| 134 | Empty paragraph | Not found | Not found | - | - |  |
| 135 | Deprecated center element | Not found | Not found | partial | partial | page-level "Obsolete HTML elements" lists <center> |
| 136 | Invalid ARIA role names | Not found | Issue found | - | detected | axe aria-roles |
| 137 | Object not embedded accessibly - wmode parameter not set to window | Not found | Not found | - | - |  |
| 138 | Spacer image found | Noticed but not a fail | Not found | - | - |  |
| 139 | Inline style adds colour | Not found | Not found | - | - |  |
| 140 | Start and close tags don't match | Not found | Not found | - | - |  |
| 141 | PRE element without CODE element inside it | Not found | Not found | - | - |  |
| 142 | Deprecated font element | Not found | Not found | partial | partial | page-level "Obsolete HTML elements" lists <font> |

## thymecare.com

Reading after (this branch): overall 85, 87 s. Before (56a927f): overall 86, accessibility 92.

- Images: 35 images, every verdict "ok" (alt present; no missing, empty, redundant, file-name or long alt). 12 of the 35 have no width/height.
- Keyboard walk: 6 real stops plus a terminal `{none: true}` entry, end reason "cycle", 1.3 s. All six stops are inside the OneTrust cookie dialog (Privacy Policy, Cookie Policy, Manage Preferences, Decline All, Accept All, Close). The page has 76 focusable elements; the other 70 were never walked.
- Top findings: axe "All page content should be contained by landmarks" (12 elements, the only violation); needs-review items for aria-hidden focusables (3), permitted ARIA attributes (2), colour contrast (4) and video captions (1); structure: 3 possible headings not marked up, 4 vague links, no skip link as the first stop. The before reading had only "Focusable elements inside aria-hidden (28)" from the basics plugin; axe's needs-review item (3 elements) replaces it.
- Images panel (screenshot viewed): a table with a thumbnail on the left, the alt text in quotes, kind, in-a-link and a green "ok" pill. The first photos, the logo, the arrow icon and the two NCQA badges have real thumbnails. The partner-logo carousel rows (the same six logos repeated three times) show a grey "not in screenshot" tile, or a sliver of a neighbouring logo for a few.
- Page map (screenshot viewed): the whole page (1280 x 4891) with 60 markers: 12 errors (all the landmark rule), 16 alerts, 12 features (alt text drawn as a caption on a dashed box around each image), 14 structure (H1 to H3, MAIN, NAV), 6 keyboard. The keyboard path is a polyline over the cookie dialog only. It reports "23 markers lie beyond the captured image" (carousel items off the right edge) and "2 flagged elements could not be placed". Marker placement on the visible content looks right.

## Product bugs observed (not fixed in this task)

1. **Keyboard walk stays inside a modal.** On thymecare.com the walk ends with reason "cycle" after the six stops of the cookie dialog, and nothing says the page behind it was not walked. The Page map then shows a six-stop path as the whole keyboard order. A note such as "walk was confined to a dialog; N focusable elements not reached" is missing.
2. **Accessibility area score goes negative.** The GDS page scores accessibility -5 after (10 before). A score outside 0 to 100 suggests the scorer does not clamp, or the added axe findings overshoot the deduction curve. Evidence: "Areas: ... accessibility -5" in the after run's digest.md.
3. **The keyboard walk cap is silent.** On the GDS page the walk stops at 250 stops ("ended: cap") at page y 28807 of 35599, so the last fifth of the cases (keyboard trap, lightbox cases and so on) were never walked, and no finding in the digest mentions the cap.
4. **Page map badges sit on the first letters of headings and links.** In the full-page map the H2/H3 and error badges cover the start of the text ("ive lives under our risk-bearing" for an H3; footer links lose their first letters). Cosmetic.
5. **Images panel thumbnails for carousel images.** Off-screen carousel images get the grey "not in screenshot" tile or a sliver of a neighbouring element. Not wrong, but a short note would help.
6. **The walk's stop list ends with a `{none: true}` entry**, so a consumer counting `stops.length` reads one too many (7 vs 6 on thymecare.com).

Other things seen: css-validate got HTTP 429 from jigsaw.w3.org on both readings; whois had no RDAP service for github.io; the translated views did not run on the GDS page (the translation model did not load in time). Nothing crashed or timed out; analysis took about 90 s per site.
