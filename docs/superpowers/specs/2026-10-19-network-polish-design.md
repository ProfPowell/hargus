# Network pane polish

**Status:** approved design (2026-10-19). This is a stabilisation batch after `2026-10-19-waterfall-path-groups-zoom-design.md`. Calibration on real sites waits until it lands.

## Why

The waterfall work left a handful of loose ends:
- **Zoom:** the ruler drag gives no feedback, focus is lost on re-render, and two interactions have no e2e coverage.
- **A visible chart bug:** the "Page weight by type" legend shows "Other" twice.
- **Leftovers from the first waterfall batch.**

Nothing here is a new feature. It is done when each item is fixed and pinned by a test that fails without the fix.

## Global constraints

- **No new runtime dependency.** Colours come only from `theme.css` tokens and work in light and dark mode. Output never contains `NaN`, `undefined` or `Infinity`. Keyboard and screen-reader access hold.
- **No stored data changes.** Export and print behave as they do now, except for the column fix in §3.5.
- **Untrusted HAR strings stay escaped** through `html`.

## 1. Zoom gaps

### 1.1 Ruler drag feedback

**While dragging**
- When a drag starts on the Timeline header's `.ruler`, a `.ruler-sel` element is drawn inside the ruler, spanning the dragged range.
- It uses the brush's accent fill and border, and is `aria-hidden`.
- It updates on each pointer move, in percent of the ruler width, clamped to 0–100.

**Ending the drag**
- Releasing the pointer zooms, exactly as now.
- **Escape** during any brush, ruler or pan drag cancels it: the window is unchanged and the selection is removed. This reuses the existing abort path.
- `pointercancel` removes the selection too.

### 1.2 Focus survives re-renders

- **Change:** `rerenderKeeping()` with no argument works out a selector for `document.activeElement`, provided it sits inside `#net-table`, re-renders, then puts focus back.
- **Focus targets, in order:**
  - `button.sort[data-sort=K]`
  - a row's `button.disclose` (via `tr[data-entry=I]`)
  - a group's `button.grp-disc` (via `tr.grp[data-group=S]`)
  - a detail tab, by its `id`
  - the `.ov-h[data-edge]` handles
  - `[data-wf-path]`, `[data-wf-groups]` and `[data-wf-reset]`
- **If the element is gone** after the re-render, for example a sorted-away row or a collapsed group, focus is not moved, so it does not jump.
- **Callers:** every network re-render from an interaction uses this, including `setWindow` (brush, keys, Reset) and the wheel's `requestAnimationFrame` render. The explicit handle refocus already in place stays.

### 1.3 E2E

- **Ruler drag:** drag about 10% to 40% across the ruler. While dragging, `.ruler-sel` exists. After release, the zoom text has changed and the first ruler tick is above 0 ms. Reset.
- **Escape during a ruler drag:** the zoom text is unchanged and `.ruler-sel` is gone.
- **Brush pan:**
  1. Zoom with the keyboard handles to a window narrower than the whole load.
  2. Drag inside the brush to the right.
  3. The window width (`aria-valuenow` to minus from) is unchanged, within 1 ms, and `from` has increased.
- **Focus:** focus a sort button, Ctrl-wheel over the timeline, and `document.activeElement` is still that sort button.

## 2. "Other" twice in Page weight by type

**Cause**
- `foldSegments` keeps the five largest slices and appends a new `{label:'Other'}` with no `display`, so the legend prints raw bytes ("4,120").
- The network plugin also has its own `other` type, labelled "Other".

**Fix in `extension/ui/charts.js`**
- `foldSegments(segments, max = 6, format)`:
  - The folded remainder merges into a kept segment that has `other: true`, if there is one: its value is summed and its `display` recomputed through `format`.
  - Otherwise it appends `{label:'Other', other:true, value, display: format?.(value)}`.
  - Without `format`, the display is unchanged from today.
  - A segment marked `other: true` is never chosen for folding before larger ones; it is ranked by value like any other.
- `donut({..., format})` passes `format` to `foldSegments`.

**Fix in `extension/plugins/network.js`**
- The Page weight donut marks the `other` type with `other: true` and passes `format: h.bytes`.

**Tests**
- `foldSegments` with 8 segments, one of them `other: true`, returns 6 segments, exactly one labelled "Other", with the summed value and a formatted display.
- The donut legend for the network glance never contains a bare number for "Other".

## 3. Leftovers from the earlier waterfall batch

### 3.1 The detail tab survives re-renders

- `state.netTab` holds the key of the selected tab, such as `headers` or `timing`, for the open row.
- `expandEntry` restores that tab when it exists, and falls back to the first tab when it doesn't.
- Opening a different row resets the tab to the first one.

### 3.2 `cacheFact` reads more directives

The output keeps the format `<source> · <cache-control>` followed by a note. The note comes from the first rule that matches:

| Directive | Note |
|---|---|
| `no-store` | not stored |
| `no-cache`, or `max-age=0` | revalidated every time |
| `max-age=N` | fresh for N |

The fresh-for note grows in these cases:
- `immutable` adds ", never revalidated".
- `stale-while-revalidate=M` adds ", then served stale for M while revalidating".
- `s-maxage=N` differs from `max-age`: it adds "; shared caches: N".
- `private` adds "; browser only".

**Expires fallback**
- When there is no `max-age` and no `s-maxage`, and the `Expires` header and the `Date` header both parse (falling back to `startedDateTime` when `Date` does not), the note is "fresh for <Expires − Date>".
- If that is 0 or less, the note is "expired on arrival".

**Unchanged cases**
- No `Cache-Control` and no `Expires` gives the source alone, as today.
- Malformed numbers are ignored.

### 3.3 Redirect status colour

`.st-chip.st-redir` gets a blue tint: `color: var(--text)` on `color-mix(in srgb, var(--c1) 16%, transparent)`, using existing tokens. The contrast ratio is at least 4.5:1 in both modes, and a unit test checks it against the token values.

### 3.4 `data:` URLs

- **The problem:** `data:` URLs only come from imported HARs, because the recorder drops them.
- **New helper:** `waterfall.js` `displayUrl(url, max)`.
  - For a `data:` URL it returns `data:<mime>[;base64],…` followed by the payload size, for example `data:image/png;base64,… (12.3 KB)`.
  - The size is the decoded payload size estimated from the length, and is clearly approximate.
  - For other URLs it returns the URL unchanged.
- **Where it is used:**
  - the Name cell's `title`;
  - the Name text, together with `midTrunc`;
  - the detail Overview "URL" fact;
  - the wire-format request line.
- The full `data:` URL is never written into the page.

### 3.5 The column offset in the export

- **The problem:** `.net tbody tr[data-entry] > td:nth-child(5) { white-space: nowrap }` targets the Type column in the interactive table, but the Name column in the standalone export, which has no disclosure column.
- **Fix:** the Type cell gets `class="type"` and the rule targets `td.type`.
- **Test:** the export's Name cell has no `type` class, and both modes have exactly one `td.type` per row.

### 3.6 E2E for "Show more"

- **Setup:** import a synthetic HAR with 450 entries through the existing import path.
- **Checks:**
  - the Network table shows 200 rows plus a "Show more" button;
  - one click gives 400 rows, and focus is on row 201's disclosure;
  - a second click gives 450 rows, the button is gone, and focus is on row 401's disclosure.

### Dropped

- **`niceTicks` returning 6 ticks:** its documented contract is four to six ticks, so this is not a bug.

## Testing summary

- **Unit (`test/waterfall.test.mjs`):** `cacheFact` cases for each directive and the `Expires` fallback; `displayUrl`.
- **Unit (`test/charts.test.mjs`):** `foldSegments` and the donut.
- **Report (`test/report.test.mjs`):** the type class in both modes, the `st-redir` chip, the `data:` URL title and text, and the network glance legend.
- **E2E (`test/e2e/run.mjs`):** §1.3 and §3.6, plus tab persistence (open a row, choose Timing, sort, and Timing is still selected).

## Out of scope

- Calibration on real sites.
- New waterfall features.
- Changing ruler tick density.
