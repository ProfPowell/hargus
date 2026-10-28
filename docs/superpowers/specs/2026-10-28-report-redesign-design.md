# Report redesign: one home per fact — design

Date: 2026-10-28. Status: draft for approval.

Reference: `docs/design/2026-10-28-report-redesign.html`, the output of the design session (7 boards). It was produced from `screens/` and `screens/OVERVIEW.md`. Open it in Chrome; it needs JavaScript to unpack.

## Why

The user said the report's "architecture and layout could use some help". They ran a separate design session from the screenshots and brought back a proposal. The user has reviewed the proposal with me and accepted it, with one change: explanations move out of the issues into a single help overlay.

The problem the design names, and that the screenshots show:
- The same finding is drawn three ways: in "Fix these first", in each area pane's Findings card, and in the All findings table.
- An area's score is shown in four places.
- Plugin output is mixed into the area scroll with no bridge from "why this score" to "what to fix".
- Capture problems appear as raw error text.

**Goal:** someone opening a reading can go from score → area → issue → the exact place on the page → hand-off, and each fact has exactly one place where it is drawn in full.

**Non-goals:**
- New analysis, new plugins or scoring changes. For the same HAR, scores are identical and findings are identical except for the added `places` field. `evidence` stays on every finding, beside `places` **(my call)**.
- Per-finding "What's wrong / Why it matters / How to fix" text. The user rejected it: "I think the What/Why/How explanation text is only in some help area and should not be included."
- A Network-pane redesign. Network and Screens keep their layouts; they only take the new tokens and components (phase 6).
- Moving capture options out of the popup (the design's "pass 2").

**Anti-goals:**
- Clutter. The user: "special cases could have help information, but I don't want to clutter the report." No per-row help icons, no explanatory paragraphs on panels.
- A second full rendering of a finding anywhere outside the Issues pane.
- Anything that needs script in the standalone export, or breaks print.
- A colour that carries meaning without a word or glyph beside it.

## Constraints (all from `screens/OVERVIEW.md`, still binding)

- Plain HTML, CSS and JS; no framework, no build step, no remote code.
- Plugins draw their panels through `h` helpers in `extension/ui/render.js`. Findings are data; the shell draws them.
- The standalone export (`standaloneDocument`) has no script. Navigation is `:target`, disclosure is `<details>`, overlays are `popover`.
- It prints: every closed `<details>` in the report body opens for print (as `reading.js`'s beforeprint handler already does for some); overlays and controls do not print.
- `theme.css` keeps `@layer reset, tokens, base, components, pages` and `light-dark()` tokens.
- Bundled fonts stay: Instrument Sans and IBM Plex Mono.
- WCAG 2.2 AA for the UI itself, from 1280 px down to 390 px wide, light and dark.

## A. Information architecture

### Panes

The report stays a sidebar plus one pane per section, shown by `:target`.

| Pane | Its one job |
|---|---|
| Overview | Triage: verdict, Fix first, Areas table, five stats, Built with, Reading health |
| Area (×8) | Why this area scored what it did; same five sections for every area |
| Issues | The only home of findings: list plus one open issue |
| Network | Unchanged layout |
| Screens | Unchanged layout |
| Notes | Unchanged layout |

The pane currently called "All findings" (`#findings`) becomes **Issues** (`#issues`). An old `#findings` hash should still land on Issues **(my call)**.

**Naming (my call):** the UI says "issue" everywhere it says "finding" today, as the design does. Code, data fields and the saved reading keep `findings`.

### Sidebar

- Top: the overall score ring (small), grade word and issue count. This is the only repeat of the overall score, as context on every pane.
- Links: Overview, Issues (count), Network (count), Screens, Notes.
- "Areas · issues" list: each area's name and its issue count. If the area has any high-severity issue, it shows the high glyph with visually hidden text "includes high severity". Area scores are **not** in the sidebar any more.

### App bar

Reading title and URL on the left. On the right: Re-run analysis and Export (unchanged), and a new **Help** button (see section E). In the standalone export the bar keeps its title and gains only the Help button.

## B. Overview

From top to bottom:

1. **Verdict header.**
   - The page screenshot, as today.
   - Title and URL.
   - One verdict sentence. It names the strongest areas and the failing one, e.g. "Strong on infrastructure and performance. Accessibility is failing: all 6 high-severity issues are there."
   - Overall ring, grade and verdict word.
   - A one-line **reading status** strip: complete, partial or failed; date; device; mode; duration; and "N views skipped" linking to Reading health.
   - The existing `summarize(scores)` is replaced by the new verdict sentence. The builder writes the rule from the example; this is the design's text pattern, not new copy. When the overall grade is capped, the sentence keeps today's cap reason ("Capped at D: Accessibility is failing (critical for <profile>)") **(my call)**.
   - The status strip also shows "Scored as <profile>" **(my call)**.
2. **Fix first.** The top 5 issues by the existing `topFindings` order, drawn with `h.issue`. Each row links to its issue. A footer reads "Then: N more high, M medium." and links to "All N issues".
3. **Areas table.** Rows are sorted worst score first. Columns:
   - Area (links to the area pane);
   - Score with a meter;
   - Grade and verdict word;
   - Issues by severity (`h.mix`);
   - Issue count.

   A severity legend sits under it. This replaces the 8 area cards and the "Findings by area and severity" chart.
4. **At a glance.** Five stats: Load (LCP), Layout shift (CLS), Page weight, Requests, CO₂ per visit. Each comes with its rating word or note. Other stats from today's stats row move to their area's Measurements.
5. **Built with.** Chips, at most 8, then "+N more in Build".
6. **Reading health.** Closed by default. It says in plain language what was captured, what was skipped and why. Raw error text goes under a nested "Technical detail". This replaces "Capture notes:".

At 390 px wide, the Areas table becomes a list of rows (name and grade, score meter, count); the severity mix is dropped there **(design board 5)**.

## C. Area pane — the same five sections for all 8 areas

An in-page **jump bar** under the header has these anchors, with area-scoped ids such as `#accessibility-issues` so they don't clash with the Issues pane:
- Checks
- Issues
- Measurements
- Plugin data

They are plain anchors, so they work without script and print as nothing.

1. **Header.** Area ring, name, grade and verdict word. One sentence giving the counts by severity, the number of checks, and the biggest wins. "How is this scored?" (the existing `scoringDetails`) stays as a closed disclosure. It is one of the inline "special case" help items.
2. **Checks.** A table with one row per plugin in the area, including plugins that skipped or errored, with that status as the result.

   Findings are scored under their category's area, not their plugin's (`score.js`). The table therefore has a row for each plugin whose home area this is, and for each plugin with at least one finding scored in this area. A row counts only the findings scored in this area, so the rows add up to the area's issue count **(my call)**.
   - **Check:** plugin name.
   - **Result:** a status word with its glyph: passing, needs work, failing, skipped or error.
   - **Reading:** the plugin's headline `summary` values.
   - **Issues:** counts by severity, linking to the Issues section below.
   - **Data:** a link to that plugin's disclosure in Plugin data.

   The result word is derived from the plugin's own findings in the same way the area status is: no findings above info = passing, worst severity medium or low = needs work, any high = failing **(my call; the builder may refine, but the word must never contradict the issue counts on the same row)**. "Not run" plugins keep today's note under the table, interactive only.
3. **Issues.** The area's issues as `h.issue` rows grouped by severity. High and medium are shown; low and info are folded behind a disclosure with their count. Links to "Open in Issues" filtered to the area.
4. **Measurements.** Each plugin's `glance` output (and the rated summary tiles today's `glances()` makes), each in an `h.panel`, two columns at 1280 px and one column below 900 px **(my call on the breakpoint)**.
   The area's "Open in Issues" link sets the Area filter in the extension. In the export it links to `#issues` with no filter, and the area's own Issues section already lists them **(my call)**.
5. **Plugin data.** One closed disclosure per plugin, holding today's `render()` output and the Raw data disclosure. The summary line shows the plugin name, the issue counts and its status. Its id stays `p-<plugin id>`, so existing links keep working. The Page map panel stays inside Accessibility's Plugin data, open as today.

## D. Issues pane

### List

- **Filters:** severity (All, High, Medium, Low, Info, each with a count), Area, Source (plugin), and Group by (severity, area, source).
- **Interactive:** the filters work as today's findings tools do.
- **Standalone export:** the full list is shown, grouped by severity, with no controls.
- Each row is `h.issue`: severity, title, affected count, area and source.
- Low and Info groups start folded.

### Detail

One issue is open at a time, beside the list at ≥ 1100 px wide and below it on narrower screens **(my call on the breakpoint)**.

- **Address:** `#issue-<key>`, where `<key>` is stable for the same reading: `<plugin id>-<finding id>` when the finding has an id, else `<plugin id>-<index within that plugin's findings>`, slugged. Fix first, area Issues and any other link point here.
- **Showing the pane:** CSS shows the Issues pane when an `#issue-…` element is the target, via `.pane:has(:target)`. With no issue targeted, the detail area shows the first issue, or a short "Choose an issue" line **(builder's choice)**.
- **Content, top to bottom:**
  - chips for severity, area (linking to the area pane) and source (linking to `#p-<plugin>`), plus "N places" when there are places;
  - the title;
  - the `detail` text when present;
  - **Where**, an `h.places` list, when the finding has places;
  - otherwise the existing evidence, in a closed "Evidence" disclosure;
  - the reference link (`ref`) and, for accessibility, the existing WCAG reference block (`referenceHtml`) in a closed "Reference" disclosure. That is the other inline "special case".
  - A footer: "Found by <plugin> · <its headline reading>" and "All <plugin> data →".
- **Buttons (interactive only):**
  - Copy as Markdown: this one issue, the same text the brief uses for it.
  - Previous and Next.
  - Copy all URLs, when there are places with URLs.
- **Export and print:** the standalone export prints every issue's detail in list order **(my call; it is what "printed under each row in the export" in the design means)**. The screen view of the export still shows one detail at a time by `:target`.

There is no What / Why / How section.

### Places

A new optional finding field `places` holds a list of plain objects. Every key is optional:

| Key | Meaning |
|---|---|
| `url` | the URL involved |
| `status` | HTTP status |
| `text` | link text or label |
| `region` | landmark |
| `line` | source line |
| `selector` | CSS selector |
| `file` | the file that referenced it |
| `note` | free text, e.g. "→ /wiki/Q808932" for a redirect |
| `entry` | the HAR entry index |

`normalize()` in `plugin-host.js` must pass `places` through and cap it at 200 items, with strings truncated. That is the lesson from extent scoring: a field not whitelisted there never reaches the saved reading.

`h.places(items)` draws each place on one line:
- the status code;
- the URL split into host, path and query (`.url-host`, `.url-path`, `.url-query`). The query shrinks first, then the path; the host never truncates; the full URL goes in `title`;
- a copy button (interactive only);
- the text, region, line and selector as small labels.

When `entry` is set, or the URL matches a recorded request, the status code links to that request in Network, in the extension only. Viewer code clears the Network filters, pages to the row and opens its detail. In the export the code is plain text **(my call)**.

Out of scope **(my call)**: "which issues cite this request" in Network, and linking a place to its crop in Screens (board 1). Both can follow later.

## E. Help overlay

One Help button in the app bar opens a large overlay: a native `popover` with `popovertarget`, so it works without script. It is a labelled dialog region with a close button, and Esc closes it. It is not printed.

Contents, as short sections with headings:
1. How to read this report: score → area → issue → place.
2. How scores work: overall from areas, area from findings and inputs, grades, the four verdict words. The text is general; each area's exact table stays in its own "How is this scored?".
3. Severities: what high, medium, low and info mean.
4. The eight areas, one line each on what they cover.
5. Reading health: what a view is, why views get skipped, and what partial means.

The text is static, lives in one module **(my call: `extension/ui/help.js`)**, and is the same in the extension and the export. Apart from "How is this scored?" and the accessibility Reference disclosure, nothing else in the report carries explanatory text.

## F. Components and tokens

### Tokens

These go into `theme.css`'s tokens layer, as `light-dark()`:
- **Surfaces:** `--bg`, `--surface`, `--surface-sunk`, `--line`.
- **Ink:** `--ink`, `--ink-2`, `--ink-3`.
- **Accent:** `--accent`, `--accent-soft`.
- **Severity:** `--sev-high`, `--sev-medium`, `--sev-low`, `--sev-info`.
- **Bands:** `--band-good`, `--band-fair`, `--band-poor`.

Values come from design board 7. Every ink and severity token must pass 4.5:1 on `--surface` and `--bg` in both themes. A unit test computes this from the token values.

**Scales:**
- type sizes 11 · 12 · 13 (base) · 15 · 18 · 24 · 32 · 44 px;
- spacing 4 · 8 · 12 · 16 · 24 · 32 · 48;
- radius 6 · 10 · pill.

**The body text size moves from 12 px to 13 px.** This is the design's base size **(my call: accepted)**.

**Score bands map from our existing statuses:**

| Status | Band |
|---|---|
| good | good |
| warning | fair |
| serious, critical | poor |
| none | neutral |

The verdict words stay as `VERDICT` has them.

Existing tokens that are no longer used are removed. The chart series colours (`--c1…--c8`, `--c-other`) stay.

### Helpers on `h`

Each helper makes one class shape. Plugins pick from this list and never style themselves.

| Helper | Output |
|---|---|
| `h.sev(level)` (exists; reshaped) | `.sev[data-sev]` with glyph and word; shape + glyph + word: triangle !, circle !, circle i, square i |
| `h.ring`, `h.meter` (exist) | `.score[data-band]`, `.meter[data-band]`; a ring is always shown beside its grade word |
| `h.status(ok, text)` | `.status[data-status]` glyph and word |
| `h.checks(items)` (today `h.checklist`; keep the old name as an alias) | grid of statuses |
| `h.stat`, `h.stats` | `.stats > .stat > .stat-label + .stat-value + .stat-note` |
| `h.sub(title, content, opts)` (exists; reshaped as panel) | `section.panel > .panel-head(h3 + .panel-sub + .panel-link) + .panel-body + .panel-foot`. Today's two-argument calls keep working |
| `h.issue(finding)` (new, shell only) | `a.issue` row: sev, title, count, meta. Under 520 px of container width the severity moves to its own line |
| `h.places(items)` (new) | see D |
| `h.table` (exists) | `.table-wrap > table.table`, numbers right-aligned |
| `h.hbars`, `h.mix(counts)` (new) | bars; severity mix with flex-grow per severity and a text equivalent |
| `h.more(summary, body, meta)` (new) | `details.disclosure`, printed open |
| `h.kv`, `h.badges`, `h.notice(text)` (new) | as on board 7 |

The issue row has to be laid out so the title never squeezes into a narrow column. The design's own mock has this bug in Fix first at 1280 and 390 px; we do not copy it.

### Rules for plugin panels (from board 7, adopted)

1. A panel opens with its answer, a stats row or checks, then detail. Raw dumps go in a closed disclosure.
2. Any list longer than 8 rows folds behind a disclosure showing the count.
3. URLs always go through URL parts; evidence is never joined into one string.
4. Findings are data, never drawn by a plugin.
5. No colour without a word.
6. Interactive bits use `details`, `:target`, `popover` or anchors.

## G. Other surfaces (phase 6)

Popup, progress tab, library, options, Network and Screens take the new tokens and components without layout changes. The popup's preset picker and plugin list stay as they are.

## H. Build order

One spec, one plan and one merge per phase. Each phase leaves a working report.

1. **Foundation.** Tokens, component CSS and the helpers in F, with existing helpers kept working. The token contrast test. Everything restyles; no layout changes.
2. **Issues pane.** Issue keys, list and detail, `h.issue`, `h.places`, the `places` field through `normalize()`, Copy as Markdown, filters, and the `#findings` → `#issues` rename. Fix first and area Issues switch to `h.issue`. Link check and the grouped broken links emit `places`, as the first adopter.
3. **Overview** as in B, and the sidebar as in A.
4. **Area pane** template as in C.
5. **Plugin panels.** Apply the rules in F area by area, and convert evidence to `places` where a finding is about specific URLs or elements. One batch per area; each batch is checked against the scores-unchanged test.
6. **Other surfaces, help, export and print.** G; the Help overlay (E) could go into phase 3 instead if it is wanted sooner (**builder's call**). Then rerun `scripts/screens.mjs` for after shots, and add them to `screens/` beside the before set **(my call: as `screens/after/`)**.

## I. Testing

- **Scores and findings unchanged.** For the saved calibration HARs, the scores before and after each phase are equal, and so are the findings once `places` is left out.
- **Unit tests:**
  - issue keys are stable and unique per reading;
  - `normalize` passes and caps `places`;
  - `h.places` splits URLs and escapes;
  - `h.mix` gives a text equivalent;
  - the token contrast test;
  - the Checks result word agrees with the row's issue counts.
- **e2e:**
  - the standalone export has no `<script>`;
  - `#issue-…` shows the Issues pane with that issue;
  - the Help popover opens and closes by keyboard;
  - beforeprint opens every `details`;
  - 390 px has no horizontal scroll on Overview, an area pane or Issues.
- **Visual:** the screens script's after shots, compared by eye against the boards.

## Left to the builder

- The exact verdict-sentence rule, within the example's pattern.
- Breakpoints other than those given.
- Whether old CSS classes are removed in the phase that stops using them, or at the end.
- Help text wording, kept short.
- Which `summary` values make a Check's Reading: prefer `headline: true`.
- Copy as Markdown includes the places.
- Token values: unpack them from the design file's board 7.
