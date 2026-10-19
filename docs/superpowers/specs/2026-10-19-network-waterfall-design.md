# Network waterfall: phases, markers, inline detail

**Status:** approved design (brainstorm 2026-10-13 to 2026-10-19), not yet planned.

## Why

HARgus's Network pane is a table with a single plain bar per request:
- It has no time phases, no axis, no legend, and no DOMContentLoaded, load, FCP or LCP lines, although we collect all of them.
- Rows can't be sorted, and the table silently stops at 800 rows.
- A request's details open in a modal, where the timings are a bare list of numbers.

ProfPowell's [http-component](https://profpowell.github.io/http-component/) shows a better way to present HTTP:
- bars split into phases, with a ruler and a legend;
- rows that expand in place into plain-English facts;
- type and status chips;
- the request and response in raw wire format.

We take those ideas into HARgus's own report, and keep what HARgus already does better: full HAR data, filters and accessibility.

## Decisions (from the brainstorm)

- **No dependency.** HARgus's own pane is rebuilt with the ideas taken over; http-component is not embedded.
- **Layout A:** sortable columns with a timeline on the right (DevTools-style), not a request lane.
- **Detail A:** clicking a row expands it in place into tabs (Overview, Timing, Headers, Wire, Body). This replaces the modal.
- **In scope:** the timeline core, inline row detail, table usability, and the wire-format view.

## Global constraints

- No new runtime dependency. The report is still built from `html` tagged-template strings (`extension/ui/report.js`). Event wiring stays in `extension/ui/reading.js`.
- **Pure logic in its own module.** Bar geometry, ruler ticks, marker placement, facts wording, wire text and sorting go in a new `extension/ui/waterfall.js`. It has no DOM access and is unit-tested with `node --test`.
- **Theme tokens only.** All colours come from tokens in `extension/ui/theme.css` and work in light and dark (`light-dark()`). Phase colours are new tokens `--ph-blocked`, `--ph-dns`, `--ph-connect`, `--ph-ssl`, `--ph-send`, `--ph-wait` and `--ph-receive`. Each has a pastel fill and a darker outline, as in the brainstorm mockup.
- **Safe output.** The rendered report must never contain `NaN`, `undefined` or `Infinity`, whatever the HAR holds (bad dates, −1 timings, missing fields).
- **Stored readings are unchanged.** HAR entries keep their shape. The only new stored data is the vitals plugin's `renderBlocking` list (below).
- **Accessibility.** Colour is never the only signal: the legend uses words, status chips show the number, and phases are listed in the tooltip and the Timing tab. Rows and tabs are keyboard-operable. Animation respects `prefers-reduced-motion`.

## 1. Timeline

### Columns

| Column | Content |
|---|---|
| # | Capture order |
| Status | A chip: green for 2xx, neutral for 3xx, amber for 4xx, red for 5xx, error or 0; "ERR" when the request errored |
| Method | Unchanged |
| Type | Unchanged |
| Name | Host plus path. Long names are shortened in the middle. Other-origin names keep the amber "third" colour. The full URL is in the title |
| Size | Unchanged |
| Time | Unchanged |
| Timeline | About 45% of the width |

### Bars

- **Phases:** each bar is split into the HAR `timings` phases, in this order: blocked, dns, connect, ssl, send, wait, receive. The legend calls them Queued, DNS, Connect, TLS, Send, Waiting (TTFB) and Download.
- **Segment widths:** each segment's width is proportional to its milliseconds. Phases that are −1 or missing are left out. In HAR, `connect` includes `ssl`, so the drawn connect segment is `connect − ssl` when both are known.
- **Bar span:** the bar starts at `startedDateTime − t0` and spans `time`. If the phase sum differs from `time`, the segments are scaled to fill the bar.
- **No timing:** if `time` is 0, missing or negative, or no phase is known, the bar is drawn with a dashed outline and labelled "no timing" in the tooltip, instead of the 2px sliver it gets today.
- **Tooltip:** shows the start ("starts at 320 ms") and each known phase in ms. It uses `title` on the bar, matching today's approach.

### Ruler and gridlines

- **Ticks:** four or five "nice" ticks (1, 2 or 5 × 10ⁿ ms) across the span, labelled with `formatMs`. Faint gridlines run down the rows.
- **Span:** the span is the larger of the latest request end and the latest marker, so the load line always fits.

### Marker lines

- **DOMContentLoaded and load** come from `log.pages[0].pageTimings` (`onContentLoad`, `onLoad`), measured from the page start.
- **FCP and LCP** come from the vitals plugin's `data.fcp` and `data.lcp.time`, measured from navigation start. They are placed on the same t0, which is the page's `startedDateTime`.
- **Drawing:** lines run full height; LCP is dashed. A marker with no value is left out.
- **Legend:** each marker is listed in the legend with its time, e.g. "DOMContentLoaded 412 ms".

### Legend

- One line above the table lists only the phases that appear in the shown rows, plus the markers present.
- A swatch always comes with its word.

## 2. Row detail (inline, tabs)

### Opening and keyboard

- **Expanding:** clicking a row, or pressing Enter or Space on it, expands it in place. The detail is a full-width row inserted after the request's row. The `<dialog>` used for network entries is removed; other uses of `openDialog`, if any, are unchanged.
- **One at a time:** one row is expanded at a time. Expanding another collapses the first. Escape collapses and returns focus to the row.
- **Row semantics:** the row's first cell holds a disclosure button (▸/▾) with `aria-expanded` and `aria-controls`. The whole row stays clickable.
- **Tabs:** `role="tablist"`, `tab` and `tabpanel`, with roving `tabindex`. Left and Right arrows, Home and End move between tabs. A tab's panel content is rendered when the tab is first opened.

### Tabs

**Overview: plain-English facts, one line each**

| Fact | Source | Example or rule |
|---|---|---|
| URL | | The full URL, in monospace |
| Requested by | `_initiator` | "a `<link rel="stylesheet">` in the page (parser), line 24", "a script: https://…/app.js:120", "redirect from …", "the browser (other)" |
| Origin | | "same origin as the page", "same site, other origin", or "third-party (host)" |
| Protocol | `httpVersion`, `_priority`, `connection` | "HTTP/2 · priority VeryHigh · reused connection". The connection is "reused" when the same `connection` id appeared on an earlier entry. Parts that are unknown are left out |
| Size | | "21.4 KB on the wire · 96.0 KB decoded (brotli, 78% smaller)". The saving shows only when encoded and decoded sizes are both known and differ |
| Cache | `_fromCache`, `cache-control` | "fetched over the network", "from disk cache" or "from memory cache", followed by the response's `cache-control`, e.g. "· max-age=3600 (fresh for 1 h)" |
| Render blocking | vitals plugin's `renderBlocking` | "yes" or "no". The line is left out when unknown |
| Timing | | "starts at 320 ms, takes 96 ms" |
| Error / status text | | Shown when present |

**Timing tab**
- One line per phase: the label, a mini bar positioned within the request, and its ms. "— reused" is shown for DNS, Connect and TLS when they are −1 and the connection was reused.

**Headers tab**
- Request headers, response headers, the query string, request cookies and response cookies, in today's tables.

**Wire tab**
- The request and response side by side, as HTTP/1.1-style text, whatever the protocol:
  - **Request:** a request line (`GET /path?q HTTP/2`), then `Name: value` header lines, a blank line, and the request body when present.
  - **Response:** a status line (`HTTP/2 200 OK`), then headers, a blank line, and the body.
- **Trimming:** each side shows up to 12 header lines and then "…N more headers", and up to 2,000 characters of body and then "…N more". Binary or base64 bodies show "[binary body, N bytes]".
- **Styling:** monospace. The method, status and header names get token colours.

**Body tab**
- Today's response body view: text cut at 100k characters, or an image. The request body is shown when present.

## 3. Table usability

- **Sorting:** column headers are buttons that sort by #, Status, Type, Name, Size or Time, with `aria-sort`. Clicking again reverses the order. The default is # (capture order, the same as start order). The Timeline header sorts by start time.
- **No silent cap:** the 800-row cap is replaced. Filters and sorting apply to every row, then the first 200 rows are rendered. A note reads "Showing 200 of 1,240 · Show 200 more". A button adds 200 rows each time.
- **Filtering keeps focus:** re-rendering the table must not move focus out of the search input. Only `#net-table` is re-rendered, never the tools.
- **Summary line:** "N of M requests · X transferred · K third-party · span T ms". This replaces "orange bars are third-party"; the amber name colour is explained in the legend line as "amber name = third-party".

## 4. Render-blocking data

- **Recording:** the vitals plugin's in-page collection adds `renderBlocking`: the URLs of `performance.getEntriesByType('resource')` entries whose `renderBlockingStatus === 'blocking'`. It is capped at 200 and stored in `data.renderBlocking`.
- **Matching:** the Overview matches entries to it by exact URL. Readings without the list, including older readings, leave the line out.

## 5. Print

- Bars, the ruler, markers and the legend print. Expanded details and the "Show more" button do not.
- The current rule that prints the first 50 rows is kept.

## Error handling

- Every fact line and phase is optional: a missing input means a missing line, never an empty label or "NaN".
- An entry with an unparseable `startedDateTime` is placed at 0 with a "no timing" bar.
- A marker earlier than t0 is clamped to 0. A marker beyond the span widens the span.

## Testing

### Unit tests (`test/waterfall.test.mjs`)

- **Phase segments:** −1 phases are left out; connect is drawn as connect − ssl; the segments are scaled when their sum ≠ `time`; there is no timing when `time ≤ 0` or no phase is known.
- **Bar geometry:** left and width as percentages, clamped to 0–100.
- **Ticks:** "nice" ticks for spans of 37 ms, 960 ms, 12.4 s and 0.
- **Markers:** placement, and a marker that widens the span.
- **Facts:** the wording for each initiator type, origin class, compression saving (and its absence), cache source, the reused connection, and the lines left out when data is missing.
- **Wire text:** the request line, status line, header trimming ("…N more headers"), body trimming, and a binary body.
- **Sorting:** each column, the reverse order, and stability.

### Report tests (`test/report.test.mjs`)

- The legend lists only the phases present.
- A HAR with −1 timings and a bad date renders with no `NaN`.
- "Show more" appears beyond 200 rows.

### E2E (`test/e2e/run.mjs`)

- In the Network pane, the first row's bar has more than one phase segment, and the DOMContentLoaded and load marker lines are present.
- Enter on a row expands the detail, and the Overview tab shows "Requested by".
- ArrowRight moves to the Timing tab, and then on to Wire, where the request line is `GET … HTTP/`.
- Escape collapses the row and leaves focus on the row.
- Sorting by Size orders the rows by descending size on the second click.
- Typing in the search box keeps focus in the input.
- A screenshot of an expanded row replaces `reading-request-dialog.png`.

## Out of scope

- Embedding http-component, http-component's List and Duration views, and its request builder.
- Grouping by domain, critical-path highlighting, and zoom or brushing on the timeline.
- Virtual scrolling. "Show more" is the scaling answer for now.
