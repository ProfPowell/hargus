# Reading report redesign — design

Date: 2026-10-09 · Status: approved in brainstorming, awaiting spec review

## Goal

Make the reading report look professional and read at three depths:

1. **Client / executive** — a scorecard: one overall score and grade, five area scores, the few things to fix first.
2. **Learner** — visual explanations of how the site is built (composition, stack, network mix, infrastructure path).
3. **Analyst** — every plugin's detail, all findings, the network waterfall and raw data, one click away.

Reports can be shared as a printed PDF (Chrome *Print → Save as PDF*) or as a standalone `.html` file.

## Constraints

- No build step and no runtime dependencies in the extension (current rule; see README).
- Plugin `render()` output must work in the viewer, the HTML export and the CLI, so chart helpers are
  pure string-producing functions with no DOM access.
- All interpolated plugin data stays escaped (plugin data is untrusted).
- Existing plugins, remote plugins and stored readings keep working without changes.

## Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Audience | All three, in layers: scorecard → teaching visuals → analyst detail |
| Layout | **B: dashboard with a sticky area sidebar** (mockups: `area-pane.html`, `overview-areas.html` in `.superpowers/brainstorm/`) |
| Charts | Hand-written inline SVG/HTML helpers; no chart library |
| Scoring | 0–100 score + letter grade per area, transparent deduction formula |
| Sharing | Print stylesheet **and** standalone HTML export; CLI `--report` uses the same renderer |
| Narrative sentence | Kept; template-generated from scores and worst findings (no AI) |
| Tech icons | Coloured letter badge + category label; no logo downloads |

## 1. Areas

Five areas, in this order: **Performance, Accessibility, Security, Build & content, Infrastructure.**

Findings map to areas by `category`:

| Finding category | Area |
|---|---|
| `performance` | performance |
| `accessibility` | accessibility |
| `security`, `privacy` | security |
| `quality`, `seo` | build |
| `infrastructure`, `intel` | infrastructure |
| anything else | the plugin's area |

Plugins gain an optional `area` field that decides which area page shows the plugin's panel. When it is
absent it comes from `group`: `build → build`, `security → security`, `infrastructure → infrastructure`,
`quality → performance`, `other → build`. Built-in plugins set `area` explicitly where that default is
wrong: `a11y-basics`, `axe → accessibility`; `meta`, `html-validate`, `css-validate → build`.
`group` stays for backward compatibility; `GROUP_LABELS` is replaced in the UI by `AREAS`
(id, label, weight) exported from `core/score.js`.

## 2. Scoring — `core/score.js`

Pure functions with no DOM or `chrome.*` access; used by the viewer, the export and the CLI.

- `scoreReading(reading, plugins) → { overall, areas: { [id]: AreaScore } }`
- `AreaScore = { id, label, score|null, grade|null, status, counts: {high,medium,low,info}, deductions: [{finding, points}], inputs: [{label, score}] }`

**Finding score** (per area): `100 − min(60, 15·high) − min(30, 6·medium) − min(15, 2·low)`; info costs 0.

**Metric inputs:**
- Performance: if the `pagespeed` result has a Lighthouse performance score, area score =
  `0.5 · findingScore + 0.5 · lighthouse`. Otherwise, if `vitals` ran, the metric half is the mean of
  LCP/CLS/FCP/TTFB ratings with `good = 100, needs-improvement = 60, poor = 20`.
- Accessibility: if `pagespeed` has an accessibility score, blend 50/50 the same way.

**Not measured:** an area with no plugin that ran successfully has `score: null`, a grey ring labelled
"not measured", and is left out of the overall score.

**Overall:** weighted mean over measured areas with weights Performance 25, Accessibility 25,
Security 25, Build & content 15, Infrastructure 10 (renormalised over the areas present). Rounded to an integer.

**Grade:** A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F < 60. Add `+` when the score is within the top 3 points
of its band (e.g. 87–89 → B+), `−` within the bottom 3 (80–82 → B−). The A band is 90–100, so
A− is 90–92 and A+ is 97–100. F has no `+`/`−`.

**Status** (ring colour and verdict word): ≥ 85 `good`, 70–84 `warning` ("needs work"),
50–69 `serious` ("poor"), < 50 `critical` ("failing"), `null` → `none`.

**Explainability:** each area header has a "How is this scored?" `<details>` disclosure (works in the export and in print) that lists inputs
and every deduction (finding title, severity, points), plus the formula in one sentence.

**Narrative:** `summarize(scores, findings) → string`, two clauses picked from templates:
best area phrase + worst area phrase, then the highest-severity finding title, e.g.
"Strong on security, weak on accessibility. Top issue: 2 form fields without labels."
Template table lives in `score.js`; no free text generation.

## 3. Chart kit — `extension/ui/charts.js`

Pure functions returning `Raw` HTML (the existing escaping `html` tag from `render.js`), merged into
the `h` helper object so plugins call `h.ring(...)` etc.

| Helper | Purpose |
|---|---|
| `ring({ value, max=100, size, status, label })` | score/progress ring; `label` is the accessible name |
| `donut({ segments:[{label,value,display?}], center:{value,unit}, size })` | part-to-whole, ≤ 6 segments (rest folded into "Other") |
| `stackBar({ segments, total? })` | single horizontal 100 % bar with legend |
| `hbars({ rows:[{label,value,display?}], max? })` | ranked horizontal bars with value at the tip |
| `meter({ value, thresholds:[good, poor], unit, format })` | good / needs-improvement / poor bands with a marker and tick labels at the thresholds |
| `stat({ label, value, rating?, note?, meter? })` | stat tile; rating → ✓ good / ▲ needs improvement / ▼ poor |
| `checklist(items:[{label, ok, note?}])` | ✓/✗ grid |
| `flow(nodes:[{title, sub}])` | left-to-right node → arrow diagram |
| `timeline({ start, now, end, labels })` | span with pins (domain lifetime, certificate validity) |
| `icon(name)` | built-in SVG icons: `high`, `medium`, `low`, `info`, `ok`, `fail`, `up`, `down`, area icons |
| `spark(values, { label })` | small column sparkline (requests over time) |
| `legend(items)` | swatch + label + value |
| `badge(tech)` | coloured letter badge + name + category for the tech stack |

Rules:
- **Ring/donut label fit.** Only the number goes inside; units on a smaller second line; grades and
  words go outside. Font size = `min(base, 0.8 · innerDiameter / estimatedWidth)` where estimated width
  uses per-character advance factors (digits 0.56 em, `.`/`,` 0.28 em, letters 0.6 em, space 0.28 em).
  Worst cases "100" at 32 px and "1,284" in a donut must pass.
- **Marks** follow the dataviz skill's specs: bars ≤ 24 px thick, 4 px rounded data end, 2 px surface gap
  between segments, hairline recessive axes, text never in series colour.
- **Colour.** Categorical slots and status colours come from the dataviz reference palette, defined as
  CSS custom properties in `theme.css` with separately chosen dark-mode values (light-dark()).
  The palette is checked with the dataviz `validate_palette.js` for both modes before shipping.
  Status colours always come with an icon and a word, never colour alone.
- **Accessibility.** Every chart has `role="img"` and an `aria-label` that states the data; legends
  show values as text; SVG marks carry `<title>` for native hover tooltips.

## 4. Plugin contract additions (backward compatible)

- `summary[]` items may add `rating: 'good'|'needs-improvement'|'poor'` and `headline: true`.
  Rated items render as stat tiles; up to three `headline` items per area feed the one-line key numbers
  on the Overview area cards.
- New optional `glance(result, h, { results, target }) → html`: charts shown at the top of the area page, above findings.
  The third argument gives read-only access to other plugins' results (the DNS request path uses `ip-intel`).
  Plugins without `glance` contribute their rated summary items as stat tiles only.
- `render(result, h)` remains the collapsible detail panel.
- Remote plugins: `glance` is never called (untrusted); their `summary` (with rating/headline) is honoured.
- `docs/PLUGINS.md` documents `area`, `glance`, `rating`, `headline` and the chart helpers.

### Built-in plugin upgrades

| Plugin | `glance` / render upgrades |
|---|---|
| vitals | meters for LCP, CLS, FCP, TTFB, blocking time |
| network | weight-by-type donut; first- vs third-party stacked bars (requests, bytes); top hosts `hbars` |
| pagespeed | Lighthouse category rings |
| a11y-basics / axe | issues-by-check `hbars`; structure checklist |
| security | header checklist; TLS validity timeline; cookie-flag stacked bar |
| observatory | grade ring |
| html | semantic vs generic stacked bar; landmarks checklist |
| css | rules / `!important` / custom properties stat tiles; palette swatches |
| javascript | first- vs third-party script bytes stacked bar |
| baseline | widely / newly / limited stacked bar |
| tech | badge grid grouped by category |
| dns / ip-intel | request-path `flow` (DNS → CDN → origin, mail) |
| whois | domain lifetime timeline |
| well-known | files checklist |

Other plugins keep their current render and gain rated summary items where a rating exists.

## 5. Reading page structure — `ui/reading.html`, `ui/reading.js`

- **Sidebar** (sticky): overall ring + grade + finding count; Overview; five areas each with a mini ring
  and score; then All findings, Network, Screens, Notes. Navigation by `#overview`, `#area-performance`, …
  `#findings`, `#network`, `#screens`, `#notes`; one pane visible at a time via `:target` CSS with
  Overview as the default, so it works without JavaScript (needed for the HTML export) and survives reload.
- **Overview pane:** hero (screenshot, title, URL, narrative sentence, capture facts as pills, large overall
  ring); five area cards (ring, grade + verdict, headline numbers, worst finding, "Open →"); stat row
  (requests, page weight, LCP, hosts, technologies, requests-over-time sparkline); "Fix these first"
  (top 5 findings by severity then area weight); findings-by-area stacked bars; "Built with" badges.
- **Area pane:** header (ring, grade, verdict, narrative clause, "How is this scored?"); stat tiles;
  plugin `glance` charts; top findings for the area (with "View all"); collapsible plugin detail panels;
  "Not run" note for that area's disabled plugins.
- **All findings / Network / Screens / Notes:** current behaviour kept. Findings gains an Area filter and
  severity icons. Network gains a type donut and top-hosts bars above the existing waterfall.
- **Responsive:** below 900 px the sidebar becomes a horizontal scrolling tab strip at the top.
- **Library page:** each reading card shows a small overall ring with its score.

The report markup is produced by one pure function, `renderReport(reading, plugins, scores) → string`, in a
new `ui/report.js`. `reading.js` keeps the interactive parts (filters, dialogs, notes, re-run, export) and
hydrates on top.

## 6. Print and standalone export

- **Print stylesheet** (`@media print` in `theme.css`): hide the sidebar, app bar and buttons; show every
  pane in order (Overview, areas, Findings, Network, Screens); `break-before: page` per area; force the
  light palette; expand plugin details; network table limited to the first 50 requests with a note.
- **Export → "Standalone HTML report"**: `renderReport` output wrapped in a full document with
  `theme.css` inlined, screenshots as data URLs, no scripts, `:target` navigation. File name
  `<host>-<date>.report.html`.
- **CLI:** `harplus <in.har> --report out.html` writes the same document (after running plugins as today).
  `theme.css` is read from the extension folder.

## 7. Testing

- `test/score.test.mjs`: deductions and caps, metric blending, not-measured areas, weight
  renormalisation, grade boundaries (59/60, 79/80/82/87/89/90, 97), status bands, narrative templates.
- `test/charts.test.mjs`: ring-fit for "7", "57", "100" at 32 px, donut "1,284"; escaping of labels;
  `role`/`aria-label` present; donut folds > 6 segments into "Other"; meter tick positions.
- `test/report.test.mjs`: `renderReport` on `test/fixtures/local-site.har` (after running offline
  plugins) contains every pane id, no `undefined`/`NaN`, and every built-in plugin's `glance` and
  `render` succeed.
- CLI test: `--report` writes a file containing the overview and five area panes.
- E2E (`test/e2e/run.mjs`): open the reading page, visit every pane, assert in the browser that every
  ring/donut label's `getBBox().width` ≤ 80 % of its inner diameter, no horizontal overflow at 1280 px
  and 800 px widths, and print emulation shows all panes.

## Out of scope

- Trends across multiple readings of the same site (comparison view).
- Real technology logos.
- Configurable scoring weights in Options (weights are constants in `score.js` for now).
- Changes to the popup and Options pages beyond shared stylesheet tokens.
