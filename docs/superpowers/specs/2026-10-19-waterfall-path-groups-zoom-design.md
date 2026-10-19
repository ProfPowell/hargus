# Waterfall: LCP path, site groups, zoom

**Status:** approved design (brainstorm 2026-10-19), not yet planned. This is the follow-up batch to `2026-10-19-network-waterfall-design.md`.

## Why

The new waterfall shows every request clearly, but three questions are still hard to answer:
- **What delayed LCP?** Nothing links the LCP image to the chain of requests that led to it.
- **How much is third-party?** Dozens of rows from one site bury the page's own requests.
- **What happened at the start?** One late request stretches the timeline, so the early bars become slivers. In a long list, the ruler scrolls out of view.

## Decisions (from the brainstorm)

- The critical path answers "what delayed LCP". Render-blocking-only highlighting and Lighthouse-style chains were rejected.
- Third-party requests are grouped by site (registrable domain). Grouping by company was rejected, because it needs a large vendor list.
- Zoom uses an overview strip with a brush, plus Ctrl/⌘-wheel and pinch zoom. The header is pinned. Quick range buttons were rejected.
- When the path is on, other rows are dimmed (mockup option A). Path bars get a violet outline.

## Global constraints

- **Inherited:** the global constraints of the waterfall spec apply unchanged: no dependency; pure logic in `extension/ui/waterfall.js`; colours from tokens in both modes; no `NaN`, `undefined` or `Infinity` in output; and keyboard and screen-reader access.
- **No stored data changes.** Everything is derived at render time from the HAR and the vitals plugin's `data.lcp` and `data.renderBlocking`.
- **The standalone export and print are unchanged in behaviour.** They show the whole load with no toggles, groups, brush or dimming.
- **Performance:** with 5,000 entries, computing the path, the groups and the overview, and one re-render after a zoom or toggle, each stay under 50 ms in Node unit timing.

## 1. LCP path

### Model: `lcpPath(reading) → { kind, ms, label, hops, blocking } | null`

**`kind` and the target request**
- `kind` is `'resource'` when `data.lcp.url` matches a request URL. The target is the first such request with a 2xx or 3xx status, or failing that the first match.
- Otherwise `kind` is `'text'`, and the target is the main document. That is the first `document` request whose URL equals the reading's `target.finalUrl` or `target.url`, or failing that the first `document` request.
- `lcpPath` returns `null` when `data.lcp` is missing or has no `time`.

**`hops`: entry indices from the document to the target, in order**
- Walk backwards from the target. A request's parent is the latest-starting request whose URL equals the request's `_initiator.url` and that started at or before it.
- For a redirect initiator, the parent is the request that redirected.
- Stop at a request with no parent, at a request already visited (a loop), or after 20 hops.
- For `kind: 'text'`, `hops` is just the document.

**`blocking`: indices of extra render-blocking requests**
- These are requests in `data.renderBlocking` that end at or before the LCP time and are not already in `hops`.

**`label`**
- For a resource: the target's file name, e.g. `hero-lab.webp`.
- For text: `text (h1.hero)`, from `data.lcp.element`.

### Summary line, shown when the toggle is on

- **Resource:** `LCP 690 ms — hero-lab.webp, reached in 4 hops: document 312 ms → main.css 96 ms → app.js 80 ms → hero-lab.webp 270 ms (+2 render-blocking)`. Each hop shows its file name, or "document", and its `time`. The "(+N render-blocking)" part appears only when N > 0.
- **Text:** `LCP 690 ms — text (h1.hero): document 312 ms + 2 render-blocking (main.css, app.js)`.

### UI

- **Toggle:** a toggle button "◆ LCP path" in the Network tools, using `aria-pressed`. When it is on:
  - every row not on the path gets the `off-path` class, which sets `opacity: 0.4`;
  - path rows, whether hops or blocking, get the `on-path` class, which gives the bar a 2px `--c7` (violet) outline;
  - a blocking row also shows a small "blocks render" tag next to its name;
  - the summary line appears above the table.
- **No LCP data:** the toggle is `disabled`, with `title="No LCP recorded for this reading"`.
- **Path inside a closed group:** if a path request sits inside a collapsed site group, the group row is treated as on-path and is not dimmed.

## 2. Group by site

### Model: `groupRows(rows, site) → Array<Row | Group>`

- `rows` are the already filtered and sorted `{e, i}` rows.
- Third-party rows (`isThirdParty(host, site)`) are bucketed by `siteOf(host)`. A bucket with two or more rows becomes a group: `{ group: siteKey, rows, count, bytes, start, end }`.
  - `bytes` is the sum of `transferSize`.
  - `start` is the minimum start offset in ms and `end` the maximum of start plus `time`. Both are taken from the timeline model.
- A group is placed where its first member falls in the input order. Members keep their input order.
- First-party rows and single-request sites stay as plain rows.

### UI

- **Toggle:** a toggle button "Group by site" in the tools, using `aria-pressed`.
- **Group row:**
  - a disclosure button with `aria-expanded` and `aria-label="Show N requests from site"`;
  - the request count ("7 requests"), the site name in the amber third-party colour, the total size, and the span time (`end − start`);
  - a striped amber bar from `start` to `end` with a dashed outline.
- **Expanding:** the members appear as normal rows directly below the group row, indented by 1rem in the Name cell. They expand into request detail as usual. Collapsing hides them, and closes any open request detail inside the group.
- **Show more:** a group counts as one row. Its members don't count until it is expanded.
- **State:** expanded groups are kept by site key across re-renders (sort, filter, zoom).

## 3. Zoom and scroll

### Model

- **Viewing window:** `timelineModel(reading, { from, to })` takes an optional window in ms.
  - Percentages are relative to the window: `left = (start − from) / (to − from)`.
  - Bars that cross an edge are clipped to 0–100 and flagged with `clipStart` or `clipEnd`.
  - Ticks are computed for the window, starting at the first nice multiple at or after `from`.
  - Markers outside the window are dropped.
  - With no window, the behaviour is unchanged: 0 to `span`.
- **Window rules:** `clampWindow({ from, to }, span)` keeps the window inside 0 to `span`, keeps it at least 10 ms wide, and keeps `from < to`.
- **Zooming:** `zoomAt(window, centerMs, factor, span)` zooms around a point. It is used for the wheel and for keyboard zoom.
- **Overview:** `overviewLanes(model, laneCount)` packs each bar into the first lane whose last end is at or before the bar's start. Once every lane is busy, it uses the lane that frees up soonest. It returns `{ i, lane, left, width }` for the whole load. The default is 12 lanes.

### UI

**Overview strip**
- It sits above the table and is about 48px high. It draws every request as a 3px line in its lane, using the whole-load model, never zoomed. Path requests are drawn violet when the path is on.
- The brush is a translucent accent rectangle showing the current window. It has two handles, each `role="slider"` with `aria-label="Zoom start"` or `"Zoom end"` and `aria-valuemin`, `aria-valuemax`, `aria-valuenow` and `aria-valuetext` in ms.
- **Pointer:**
  - drag on empty strip draws a new window;
  - drag inside the brush pans it;
  - drag a handle resizes it.
- **Keys on a handle:**
  - ←/→ move the handle by 1% of the span, or 10% with Shift;
  - Home/End go to the limits.
- **Reset:** a "Reset zoom" button returns to the whole load. It is disabled when the timeline is not zoomed.
- **Status text:** "Showing 0–820 ms of 2.4 s" sits next to it, in an `aria-live="polite"` region that is updated after the interaction settles.

**Ruler drag**
- Dragging across the ruler in the Timeline header selects a range and zooms to it, the same as drawing on the strip.

**Wheel and pinch**
- Over the timeline column or the strip, a wheel event with `ctrlKey` or `metaKey` zooms around the pointer. Chrome reports a trackpad pinch as a `ctrlKey` wheel.
- Each wheel step uses a factor of 1.2, and `preventDefault` is called.
- A plain wheel event scrolls normally.

**Clipping cue**
- A bar clipped at an edge gets a square end on that side, plus a small "◂" or "▸" cue inside the track.

**Pinned header**
- In the interactive report, `.table-wrap.net` becomes its own scroll box with `max-height: 75vh` and `overflow: auto`. The `thead th` cells use `position: sticky; top: 0`, with the panel background, so the column headers and the ruler stay visible.
- In print and in the standalone export, the box has no max-height.

**State**
- The zoom window is kept across sort, filter and group changes. It resets when the reading is re-rendered.

## Error handling

- **No LCP data:** the toggle is disabled.
- **LCP URL with no matching request** (from a cross-origin frame, or filtered out): the path is reported as `kind: 'text'` and labelled "LCP resource not in the request list". The path is the document plus blocking requests.
- **Filtered-out path rows:** the toggle still works, and the summary still names every hop. A filtered-out hop shows "(hidden by filter)".
- **Window:** a zero or negative span, or a NaN window, falls back to the whole load.
- **Few requests:** with fewer than two third-party requests from any site, the "Group by site" toggle is shown but has no effect, and its note reads "no site has 2+ requests".

## Testing

### Unit (`test/waterfall.test.mjs`)

- **`lcpPath`:**
  - a resource chain through parser and script initiators;
  - a redirect hop;
  - a loop;
  - more than 20 hops;
  - an LCP URL that isn't found, giving text;
  - text LCP with blocking requests;
  - a blocking request after LCP being excluded;
  - no LCP, giving null.
- **`groupRows`:**
  - a site with three requests grouped, with the right byte and span totals, placed at its first member;
  - first-party and single-request sites left ungrouped;
  - the input order preserved.
- **`timelineModel` with a window:** percentages, clip flags, ticks inside the window, and markers dropped outside it.
- **`clampWindow` and `zoomAt`:** the edges, the 10 ms minimum, and NaN.
- **`overviewLanes`:** packing order, the overflow lane, and 5,000 entries under 50 ms.

### Report (`test/report.test.mjs`)

- The Network tools render the path and group toggles. The path toggle is disabled without LCP data.
- Group rows have a disclosure and correct totals.
- `networkTable` with a window renders a clipped bar.
- The standalone export has no toggles, strip or brush.

### E2E (`test/e2e/run.mjs`)

The fixture already has a hero image and some third-party (localhost) requests. Add a second third-party request where one is missing.

- **Path:** turn the LCP path on, check that off-path rows have `off-path`, and that the summary names the LCP resource.
- **Groups:** group by site, check that the group row shows "N requests", expand it, and check its members are visible.
- **Strip:** draw a brush on the strip, check that the ruler's first tick is above 0 or the window text changed, then Reset.
- **Keyboard:** on the end handle, ArrowLeft changes `aria-valuenow`.
- **Wheel:** a Ctrl-wheel over the timeline changes the window text.
- **Pinned header:** after scrolling the table box, the header's top stays at the box top.

## Out of scope

- Grouping by company, and a vendor list.
- Quick range buttons.
- Paths to FCP or other metrics.
- Saving the zoom, path or group state with the reading.
- Showing groups or the zoom in the standalone export.
