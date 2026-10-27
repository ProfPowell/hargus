# HARgus: design brief for a redesign session

This folder holds screenshots of every screen in HARgus, taken from real readings, plus this brief. The goal of the
session is a better **information architecture and layout** for the tool and its reports. The visual style can change
too, but structure comes first: what lives where, what a person sees first, and how they get from a score to the fix.

Everything here was captured on 2026-10-27 by `node scripts/screens.mjs`. Rerun it after changes to get matching
"after" shots. `manifest.json` lists every file with one line on what it shows.

## What HARgus is

HARgus is a Chrome extension (Manifest V3). It takes a **reading** of a web page:
1. It reloads the page with Chrome's debugger attached.
2. It records the full network conversation (HAR) plus screenshots and around 20 alternative views of the page (phone,
   no CSS, dark mode, 200% text, simulated colour blindness, and so on).
3. It runs 37 analysis plugins over the recording.

The result is a score for each of 8 **areas** (Performance, Accessibility, Security, Content, Build, Infrastructure,
International, Sustainability), an overall grade, and a list of **findings**:
- each finding has a severity (high, medium, low or info);
- most say what is wrong, why it matters and how to fix it;
- many point to the exact place: a line of HTML, a CSS selector, a request.

Who uses it: web developers, accessibility testers and agency leads checking a site. They use it to:
- find out what to fix first;
- hand a report to someone else, as a standalone HTML file, a PDF, or a Markdown brief for an AI agent or a ticket.

Readings are saved locally and can be reopened, re-analysed, exported and imported.

## The surfaces, in the order a person meets them

| Surface | What it does | Screens |
|---|---|---|
| **Toolbar popup** (360 px wide) | Shows the current page. Its main button is **Take reading**. **Record** captures a multi-page journey and **Snapshot** reads without reloading. It also holds the capture options (device, network, which views) and on/off switches for the plugins. | `01`–`04` |
| **Reading tab, in progress** | Opens beside the page, shows each capture step with its time, and then turns into the report. | `05`–`09` |
| **Report** (`reading.html`) | Sticky app bar (title, Re-run analysis, Export, Delete) above a sidebar and a content pane. The panes are Overview, the 8 areas, All findings, Network, Screens and Notes. | `10`–`40` |
| **Exports** | A standalone HTML report: the same report with no script, toggles done in CSS, and print styles. Also Print/PDF, a Markdown brief, and the HAR-PLUS file itself. | `30`–`32`, `export-print.pdf`, `brief.md` |
| **Readings library** | One card per saved reading, with filter, sort and import. | `43`, `44` |
| **Options** | Capture defaults and every plugin's settings and API keys. | `45`, `46` |

The report is the heart of the tool and where most of the design effort should go.

### Report panes

- **Overview** (`10`, `11`):
  - a summary card with a thumbnail, the URL, a one-line verdict, capture chips and the overall ring;
  - 8 area cards, each with a score ring, grade, two stats, its top finding and a link;
  - a row of headline stats;
  - "Fix these first", findings by area and severity, and "Built with".
- **Area panes** (`12`–`19`, opened up in `24`–`26`), all with the same structure:
  1. a score header with "How is this scored?";
  2. area-specific widgets (share previews, readability, sentence length, contrast samples, the page map and so on);
  3. the area's findings;
  4. "Plugin detail": one collapsible panel per plugin, each drawn by its plugin.
- **All findings** (`20`, `28`): a filterable table of every finding, by severity, area and category. Each row opens
  into What / Why it matters / How to fix / WCAG, plus the evidence.
- **Network** (`21`, `29`): a waterfall table of every request. A row opens in place with tabs: overview, timing,
  headers, wire.
- **Screens** (`22`): every captured view, including breakpoints, accessibility views and vision simulations.
- **Notes** (`23`): the user's own notes and tags on the reading.

There are also a second site (`41`, `42`, gov.uk, which scores well), dark theme (`33`–`36`) and phone width
(`37`–`40`).

## How the UI is built (constraints for any design)

- **Plain HTML, CSS and JavaScript.** There is no framework and no build step:
  - one stylesheet, `extension/ui/theme.css` (~740 lines), uses `@layer reset, tokens, base, components, pages`, with
    colours as `light-dark()` tokens;
  - the JavaScript is split by page: `reading.js` (report shell, sidebar, routing by `#hash`), `report.js` (Overview,
    area panes, findings), `waterfall.js`, `charts.js`, `popup.js`, `options.js` and `library.js`.
- **Plugins draw their own panels.** Each of the 37 plugins has a `render(result, h)` function. It builds its panel
  from shared helpers in `extension/ui/render.js`: `h.sub` (titled section), `h.table`, `h.ring`, `h.donut`, `h.hbars`,
  `h.stat`, `h.meter`, `h.spark`, `h.badges` and others. Many also have a `glance` function that feeds the Overview.
  - A redesign should therefore come as a **component vocabulary**: classes and helper shapes that 37 panels can use
    consistently, not 37 bespoke layouts.
- **The standalone export has no JavaScript.** Anything interactive in the report needs a CSS-only fallback (`details`,
  `:target`, checkbox toggles) or must degrade gracefully, and it must print well.
- **Extension pages allow no remote code or fonts.**
  - The fonts are bundled: Instrument Sans for text, IBM Plex Mono for code and URLs.
  - The body text is 12 px. That density is deliberate for data-heavy panes, but open to question.
- **It has to be exemplary at accessibility.**
  - It audits accessibility, so it must meet WCAG 2.2 AA itself: keyboard paths, visible focus, contrast in both
    themes, reduced motion, and status never shown by colour alone.
  - Severity always pairs an icon with a word.
  - The chart colours were validated for colour-blind readers.
- **Must work at:**
  - 1280 px (the main target) down to 390 px;
  - light and dark themes;
  - print.

## Where it hurts today

These are the developer's observations from reviewing the screenshots, not the user's list. The user's own words are
"the architecture and layout could use some help".

1. **Information architecture.**
   - The same facts appear in many places. Each area's score is in the sidebar, the area card, the area pane header,
     and again in its findings.
   - Findings live in three places: Overview "Fix these first", each area's findings list, and All findings.
   - There is no clear path from "what's my score" to "what do I fix" to "where exactly is it".
2. **Hierarchy and density.**
   - Area panes are long scrolls of equally weighted cards (`24`–`26` run past 12,000 px).
   - "Plugin detail" panels mix useful tables with raw dumps. In Link check (`15`, bottom), a wall of
     "host ×count" text sits above the broken-link groups.
3. **Long URLs and evidence.**
   - Findings and lists show full URLs and joined evidence strings inline, which makes ragged, hard-to-scan blocks
     (`15` findings, `27`).
4. **Phone width.**
   - The sidebar becomes a horizontally scrolling strip, and the app bar's buttons wrap.
   - The findings table squeezes the Area column into "Acc / essi / bility" (`39`).
5. **Share previews** (`15`, top) take a full screen even when there is no share image.
6. **Raw messages reach the user.** For example, "Capture notes: German view failed: TimeoutError: Translator create
   timed out after 60s" (`10`).
7. **Progress page** (`05`–`09`): a small card on an empty page while the reading runs for 10 to 60 seconds. It could
   use the space better.
8. **Popup** (`02`, `03`): capture options and 37 plugin checkboxes in a 360 px popup. Most people never change them,
   and the options page already has them.
9. **Library** (`43`): cards only. There is no way to compare readings over time or across sites, which agency users
   do.

## What would help most from the design session

1. **A proposed information architecture** for the report: the panes, what each one is for, and where findings, scores
   and plugin detail live. Include the path from score to fix to exact location.
2. **Layouts** for each surface, at 1280 px and 390 px:
   - Overview, one area pane (Accessibility or Content is the hardest), All findings, Network;
   - the progress state, the popup and the library.
   - Static HTML/CSS mockups are ideal, because they can be lifted into `theme.css` directly.
3. **A component vocabulary** for plugin panels: section, stat row, table, list of items with places, chart and
   collapsible evidence. Give the CSS class shapes, so all 37 plugins can adopt it.
4. **Token changes**, if any: colour, type scale, spacing. Give them as `light-dark()` custom properties that fit the
   existing `@layer tokens`.
5. **What to cut or merge.** Fewer places for the same fact is a goal in itself.

Please keep these:
- every capability visible today;
- the severity icon-plus-word pairing;
- the no-script export;
- print;
- both themes.

## Files in this folder

- `NN-*.png`: screenshots, numbered in capture order. Most report panes are full length (taken at 1280 px with the
  viewport grown to the page's height, capped at 12,000 px). Each file's width and theme are in `manifest.json`.
- `manifest.json`: every file and what it shows.
- `export-print.pdf`: the first 8 pages of the standalone report as printed (A4).
- `brief.md`: the Markdown brief export for the same reading.
- `OVERVIEW.md`: this file.

The source sites are `en.wikipedia.org/wiki/Web_accessibility` (full set) and `www.gov.uk` (overview only). Both were
read live, so numbers will differ slightly between runs.
