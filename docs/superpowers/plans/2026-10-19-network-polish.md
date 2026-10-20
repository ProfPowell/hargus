# Network Pane Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fix the loose ends in the Network pane: zoom feedback and focus, the duplicate "Other" in the donut, and the leftovers from the first waterfall batch. Each fix is pinned by a test that fails without it.

**Architecture:**
- Pure changes go in `extension/ui/charts.js` (`foldSegments`, `donut`) and `extension/ui/waterfall.js` (`cacheFact`, new `displayUrl`).
- Markup changes go in `extension/ui/report.js` and styles in `extension/ui/theme.css`.
- Interaction changes go in `extension/ui/reading.js`.
- The only test-only task is the "Show more" e2e.

**Tech Stack:** vanilla ES modules, `html` tagged templates (`extension/ui/html.js`; `raw()` bypasses escaping), CSS `@layer` with `light-dark()` tokens, `node --test`, Playwright e2e (`npm run test:e2e`).

**Spec:** `docs/superpowers/specs/2026-10-19-network-polish-design.md`

## Global Constraints

- **No new runtime dependency.** Colours only from `theme.css` tokens, working in light and dark. No `NaN`, `undefined` or `Infinity` in output. Keyboard and screen-reader access hold.
- **No stored data changes.** Export and print are unchanged, except for the `td.type` column fix.
- **Escaping.** Untrusted HAR strings (URLs, headers) stay escaped through `html`. A `data:` URL's payload is never written into the page.
- **Commits.** Each message ends with `Co-Authored-By: <the model that wrote it> <noreply@anthropic.com>`, e.g. `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **Commands.** Run `npm test` and `npm run test:e2e` from the repo or worktree root (baseline: 534 unit tests, e2e green). The worktree guard rejects compound shell commands involving git, so run git commands plain and separately. Do not commit a `package-lock.json`.

## Rulings made while planning

- **Donut fold:** the existing `other: true` slice always absorbs the remainder and does not compete for one of the `max − 1` kept places. This changes the spec's "ranked like any other". It guarantees exactly one "Other" and never wastes a slot on it.
- **Only `s-maxage`, no `max-age`:** the note is "fresh in shared caches for <S>".
- **`Expires` that doesn't parse as a date:** "expired on arrival", per RFC 9111 §5.3, which treats an invalid `Expires` as already expired.
- **`Expires` with no `Cache-Control`:** the fact reads `<source> · Expires: <raw value> (<note>)`.
- **`data:` MIME type:** the text before the first `;` or `,`, which may be empty. The size is the payload length; for base64 it is `floor(len × 3 / 4)` minus the padding.

## Review Focus

1. **A focused element that vanishes.** If the focused row is filtered or sorted away by a re-render, focus is left alone and nothing throws. Typing in the filter box keeps focus in the box, because the box is outside `#net-table`. Pinned in Task 3 (e2e: type in the filter while zoomed, and the active element is still the input).
2. **`Expires: 0` or `Expires: -1`.** Common "already expired" values; they read "expired on arrival", never a negative or huge age. Pinned in Task 2.
3. **A non-base64 `data:` URL with parameters** (`data:text/plain;charset=utf-8,hello%20world`). It shows `data:text/plain,…` and is never confused with base64. Pinned in Task 2.
4. **A donut with no `other: true` segment that still folds.** It appends one "Other" slice with a formatted display, and only one. Pinned in Task 1.
5. **Escape with no drag in progress.** It keeps its existing job of closing the open request row. Pinned in Task 3 (the existing Escape-closes-row e2e must still pass after the new drag-cancel branch).

---

### Task 1: The donut fold merges into "Other" and formats it

**Files:**
- Modify: `extension/ui/charts.js` (`foldSegments`, `donut`)
- Modify: `extension/plugins/network.js` (the Page weight donut in `glance`)
- Test: `test/charts.test.mjs`, `test/glance.test.mjs`

**Interfaces:**
- Produces:
  - `foldSegments(segments = [], max = 6, format?: (n: number) => string) → segments`
  - `donut({ segments, center, size, label, format })`
- Behaviour, after dropping zero-value segments as today:
  - With `max` or fewer segments, they are returned unchanged.
  - Otherwise, rank the segments that are **not** `other: true` by value, and keep the top `max − 1` in input order.
  - The rest merge into the existing `other: true` segment, which stays where it was in the input. Values are summed, and `display` becomes `format(sum)` when `format` is given.
  - With no `other: true` segment, a new `{label:'Other', other:true, value, display: format?.(value)}` is appended.
  - Either way the result has exactly `max` segments, one of them "Other".
  - Without `format`, a newly appended slice has no `display`, exactly as today.

- [ ] **Step 1: Write the failing tests** (in `test/charts.test.mjs`, next to "donut folds small segments…")

```js
test('foldSegments merges the remainder into the existing other slice and formats it', () => {
  const fmt = (n) => `${n} B`;
  const segs = [...'abcdefg'].map((l, i) => ({ label: l, value: 100 - i * 10 }));
  segs.splice(2, 0, { label: 'Other', value: 85, other: true }); // a 100, b 90, Other 85, c 80, d 70, e 60, f 50, g 40
  const out = foldSegments(segs, 6, fmt);
  assert.deepEqual(out.map((s) => s.label), ['a', 'b', 'Other', 'c', 'd', 'e']);
  const other = out.find((s) => s.other);
  assert.equal(other.value, 85 + 50 + 40); // f 50, g 40 folded in
  assert.equal(other.display, '175 B');
});

test('foldSegments with no other slice appends one formatted Other', () => {
  const segs = 'abcdefgh'.split('').map((l, i) => ({ label: l, value: 10 - i }));
  const out = foldSegments(segs, 6, (n) => `${n} B`);
  assert.deepEqual(out.map((s) => s.label), ['a', 'b', 'c', 'd', 'e', 'Other']);
  assert.equal(out[5].display, '12 B');
});

test('donut passes format to the fold: the legend never shows a bare number', () => {
  const segs = 'abcdefgh'.split('').map((l, i) => ({ label: l, value: 1000 - i, display: `${1000 - i} B` }));
  const s = String(donut({ segments: segs, format: (n) => `${n} B` }));
  assert.match(s, /<span>Other<\/span><em>2982 B<\/em>/); // f 995 + g 994 + h 993
});
```

In `test/glance.test.mjs`, add:

```js
test('network glance donut: one Other slice, sized in bytes', () => {
  const types = ['document', 'script', 'stylesheet', 'image', 'font', 'xhr', 'media', 'other'];
  const s = G('network', {
    totals: { requests: 8, bytes: 80_000, decoded: 80_000, thirdParty: { requests: 0, bytes: 0 } },
    // 'other' is the third-largest type, so today it is kept *and* a second "Other" fold is appended.
    byType: types.map((type, i) => ({ type, requests: 1, bytes: type === 'other' ? 15_000 : 20_000 - i * 2000 })),
    hosts: [{ host: 'a.com', requests: 8, bytes: 80_000, thirdParty: false }],
  });
  const legend = s.slice(s.indexOf('<ul class="legend">'));
  assert.equal((legend.match(/<span>Other<\/span>/g) || []).length, 1);
  assert.doesNotMatch(legend, /<span>Other<\/span><em>[\d,]+<\/em>/);
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --test test/charts.test.mjs test/glance.test.mjs`
Expected: the three new chart tests fail (no merge, and `display` is undefined). The glance test fails because "Other" appears twice.

- [ ] **Step 3: Implement**
  - `foldSegments` and `donut` in `extension/ui/charts.js`, as in Interfaces.
  - In `extension/plugins/network.js` `glance`, give the `other` type's segment `other: true` and pass `format: h.bytes` to `h.donut`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/charts.test.mjs test/glance.test.mjs`, then `npm test`.
Expected: all pass, and the existing "donut folds small segments…" test is unchanged.

- [ ] **Step 5: Commit**

`git add extension/ui/charts.js extension/plugins/network.js test/charts.test.mjs test/glance.test.mjs`, then `git commit -m "Donut: fold the remainder into the existing Other slice, formatted (no duplicate Other, no raw bytes)"`, with the trailer.

---

### Task 2: Cache directives, `data:` URLs, the redirect chip, the type column

**Files:**
- Modify: `extension/ui/waterfall.js` (`cacheFact`, new `displayUrl`, `requestFacts`'s URL fact, `wireText`'s start line)
- Modify: `extension/ui/report.js` (`statusClass` is unchanged; the Name cell text and `title`; the Type cell gets `class="type"`)
- Modify: `extension/ui/theme.css` (add `.st-chip.st-redir`; replace the `td:nth-child(5)` rule with `td.type`)
- Test: `test/waterfall.test.mjs`, `test/report.test.mjs`

**Interfaces:**
- Produces:
  - `displayUrl(url: string) → string`, exported from `waterfall.js`.
    - For `data:` URLs: `` `data:${mime}${base64 ? ';base64' : ''},… (${formatBytes(size)})` ``.
    - Any other URL is returned unchanged.
  - `cacheFact(e) → string`. The format is `` `${src} · ${cc}${note}` `` where `note` is `` ` (${text})` `` or `''`.
- **Note text,** where `age()` is the existing helper in `waterfall.js`:
  - `no-store` → `not stored`.
  - Else `no-cache` or `max-age=0` → `revalidated every time`.
  - Else `max-age=N` (N > 0) → `fresh for ${age(N)}`, plus these suffixes in order:
    - `, never revalidated` if `immutable`;
    - `, then served stale for ${age(M)} while revalidating` if `stale-while-revalidate=M`;
    - `; shared caches: ${age(S)}` if `s-maxage=S` and S ≠ N;
    - `; browser only` if `private`.
  - Else `s-maxage=S` alone → `fresh in shared caches for ${age(S)}`.
  - Else, if an `Expires` header is present: d = (Expires − Date) / 1000. `Date` is the `Date` response header, falling back to `startedDateTime`.
    - d > 0 → `fresh for ${age(Math.round(d))}`.
    - d ≤ 0, or `Expires` unparseable → `expired on arrival`.
    - With no `Cache-Control`, the middle part is `Expires: ${raw}`.
  - Else, no note.
  - Malformed numbers (`max-age=abc`) are ignored.

- [ ] **Step 1: Write the failing unit tests** in `test/waterfall.test.mjs`. Add `displayUrl` to the import, and use a helper `ce(headers)` that builds `{ response: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) }, startedDateTime: '2026-10-19T10:00:00Z' }`.

```js
test('cacheFact explains the common Cache-Control directives', () => {
  const net = 'fetched over the network';
  assert.equal(cacheFact(ce({ 'cache-control': 'no-store' })), `${net} · no-store (not stored)`);
  assert.equal(cacheFact(ce({ 'cache-control': 'no-cache' })), `${net} · no-cache (revalidated every time)`);
  assert.equal(cacheFact(ce({ 'cache-control': 'public, max-age=31536000, immutable' })), `${net} · public, max-age=31536000, immutable (fresh for 365 days, never revalidated)`);
  assert.equal(cacheFact(ce({ 'cache-control': 'max-age=60, stale-while-revalidate=3600' })), `${net} · max-age=60, stale-while-revalidate=3600 (fresh for 1 min, then served stale for 1 h while revalidating)`);
  assert.equal(cacheFact(ce({ 'cache-control': 'max-age=60, s-maxage=600' })), `${net} · max-age=60, s-maxage=600 (fresh for 1 min; shared caches: 10 min)`);
  assert.equal(cacheFact(ce({ 'cache-control': 'private, max-age=600' })), `${net} · private, max-age=600 (fresh for 10 min; browser only)`);
  assert.equal(cacheFact(ce({ 'cache-control': 's-maxage=600' })), `${net} · s-maxage=600 (fresh in shared caches for 10 min)`);
  assert.equal(cacheFact(ce({ 'cache-control': 'max-age=abc' })), `${net} · max-age=abc`);
});

test('cacheFact falls back to Expires', () => {
  const net = 'fetched over the network';
  const date = 'Mon, 19 Oct 2026 10:00:00 GMT';
  assert.equal(cacheFact(ce({ date, expires: 'Mon, 19 Oct 2026 11:00:00 GMT' })), `${net} · Expires: Mon, 19 Oct 2026 11:00:00 GMT (fresh for 1 h)`);
  assert.equal(cacheFact(ce({ date, expires: 'Mon, 19 Oct 2026 09:00:00 GMT' })), `${net} · Expires: Mon, 19 Oct 2026 09:00:00 GMT (expired on arrival)`);
  assert.equal(cacheFact(ce({ expires: '0' })), `${net} · Expires: 0 (expired on arrival)`);
  assert.equal(cacheFact(ce({ expires: '-1' })), `${net} · Expires: -1 (expired on arrival)`);
  assert.equal(cacheFact(ce({ expires: 'Mon, 19 Oct 2026 10:30:00 GMT' })), `${net} · Expires: Mon, 19 Oct 2026 10:30:00 GMT (fresh for 30 min)`); // no Date: startedDateTime
  assert.equal(cacheFact(ce({})), net);
});

test('displayUrl shortens data: URLs and leaves others alone', () => {
  assert.equal(displayUrl('data:image/png;base64,' + 'A'.repeat(16000)), `data:image/png;base64,… (${formatBytes(12000)})`);
  assert.equal(displayUrl('data:image/png;base64,QUJD=='), `data:image/png;base64,… (${formatBytes(2)})`);
  assert.equal(displayUrl('data:text/plain;charset=utf-8,hello%20world'), `data:text/plain,… (${formatBytes(13)})`);
  assert.equal(displayUrl('data:,x'), `data:,… (${formatBytes(1)})`);
  assert.equal(displayUrl('https://a.test/x.js?q=1'), 'https://a.test/x.js?q=1');
});
```

Import `formatBytes` from `../extension/core/har-util.js` in the test if it isn't already.

- [ ] **Step 2: Write the failing report tests** in `test/report.test.mjs`.

```js
test('Network table: a data: URL never reaches the page; type cell is classed in both modes', () => {
  const payload = 'Q'.repeat(4000);
  const r = /* the file's existing minimal reading builder */ withEntries([
    { request: { method: 'GET', url: `data:image/gif;base64,${payload}`, headers: [] }, response: { status: 200, headers: [] }, startedDateTime: '2026-10-19T10:00:00Z', time: 1, timings: {} },
    { request: { method: 'GET', url: 'https://a.test/', headers: [] }, response: { status: 301, headers: [], redirectURL: 'https://a.test/x' }, startedDateTime: '2026-10-19T10:00:00Z', time: 1, timings: {} },
  ]);
  for (const interactive of [true, false]) {
    const out = String(networkTable(r, allRows(r), { interactive })) + String(requestDetail(r, 0));
    assert.doesNotMatch(out, new RegExp(payload.slice(0, 64)));
    assert.match(out, /data:image\/gif;base64,…/);
    assert.equal((out.match(/<td class="type">/g) || []).length, 2);
  }
  assert.match(String(networkTable(r, allRows(r))), /class="st-chip st-redir">301</);
});

test('theme: st-redir chip contrast ≥ 4.5 in light and dark; no nth-child column rule', () => {
  const css = readFileSync(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  assert.match(css, /\.st-chip\.st-redir\s*\{[^}]*color:\s*var\(--text\)[^}]*color-mix\(in srgb, var\(--c1\) 16%, transparent\)/);
  assert.doesNotMatch(css, /td:nth-child\(5\)/);
  const pair = (name) => css.match(new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`, 'i')).slice(1, 3);
  const [text, c1, panel] = ['text', 'c1', 'panel'].map(pair);
  for (const m of [0, 1]) {
    const bg = composite({ ...parseRgb(c1[m]), a: 0.16 }, parseRgb(panel[m]));
    assert.ok(wcagRatio(parseRgb(text[m]), bg) >= 4.5, `mode ${m}`);
  }
});
```

- **Fixture builder:** if the file has no `withEntries` builder, build the reading the same way the file's other `networkTable` tests do. Don't add a second builder style.
- **Imports:** import `readFileSync` from `node:fs`, and `parseRgb`, `composite` and `wcagRatio` from `../extension/core/color.js`.

- [ ] **Step 3: Run the tests and see them fail**

Run: `node --test test/waterfall.test.mjs test/report.test.mjs`
Expected: the new tests fail. `displayUrl` is not exported, the cache notes are missing, the payload appears in the output, there are no `td.type` cells, and there is no `.st-redir` rule.

- [ ] **Step 4: Implement**
  - **`waterfall.js`:**
    - `displayUrl` and `cacheFact`, as in Interfaces.
    - `requestFacts`'s `['URL', url]` becomes `['URL', displayUrl(url)]`.
    - `wireText`: when `req.url` starts with `data:`, the start line's path is `displayUrl(req.url)`.
  - **`report.js` `entryRow`:**
    - For a `data:` URL, the Name text is `displayUrl(url)` and the `title` is `displayUrl(url)`.
    - For other URLs, keep `midTrunc(host + p, 64)` and `title=url`.
    - The Type cell is `<td class="type">`.
  - **`theme.css`:**
    - Add `.st-chip.st-redir { color: var(--text); background: color-mix(in srgb, var(--c1) 16%, transparent); }` beside the other chips.
    - Replace `.net tbody tr[data-entry] > td:nth-child(5)` with `.net tbody tr[data-entry] > td.type`.
  - **Other places:** if the detail panel renders the raw URL anywhere else, for example a Headers `:path` pseudo-header or a copy field, route it through `displayUrl` too. The report test above will show you.

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/waterfall.test.mjs test/report.test.mjs`, then `npm test`.
Expected: all pass. Update any existing `cacheFact` expectation that the new wording legitimately changes, and list each one in your report.

- [ ] **Step 6: Commit**

`git add extension/ui/waterfall.js extension/ui/report.js extension/ui/theme.css test/waterfall.test.mjs test/report.test.mjs`, then `git commit -m "Network pane: explain more cache directives and Expires, shorten data: URLs, redirect chip colour, classed type column"`, with the trailer.

---

### Task 3: Ruler feedback, Escape cancels, focus and tab survive re-renders

**Files:**
- Modify: `extension/ui/reading.js` (`state`, `selectTab`, `expandEntry`/`toggleEntry`, `rerenderKeeping`, `setWindow`, the wheel rAF render, the keydown handler, the pointer handlers, `abortDrag`)
- Modify: `extension/ui/theme.css` (`.ruler-sel`)
- Test: `test/e2e/run.mjs` (the network zoom block, after the "reset keeps the table scroll position" assertion and before the existing `Escape` keypress)

**Interfaces:**
- Consumes the existing hooks:
  - `#net-table`, `button.sort[data-sort]`, `tr[data-entry] button.disclose`, `tr.grp[data-group] button.grp-disc`;
  - detail tabs `#ed-{i}-t-{key}[data-tab]` with keys `overview`, `timing`, `headers`, `wire`, `body`;
  - `#wf-overview .ov-h[data-edge]`, `[data-wf-path]`, `[data-wf-groups]`, `[data-wf-reset]`, `.tl-head .ruler`;
  - `drag`, `abortDrag()`, `setWindow()`, `rerenderKeeping()`, `selectTab()`.
- **`focusKey(el) → string | null`** (module-local): returns a selector that finds the same control after a re-render, or `null` when `el` is outside `#net-table`. Selectors, in this order:
  - `#net-table button.sort[data-sort="K"]`
  - `#net-table tr[data-entry="I"] button.disclose`
  - `#net-table tr.grp[data-group="${CSS.escape(S)}"] button.grp-disc`
  - `#${CSS.escape(tab.id)}` for a `[role=tab]`
  - `#wf-overview .ov-h[data-edge="E"]`
  - `#net-table [data-wf-path]`, `#net-table [data-wf-groups]`, `#net-table [data-wf-reset]`
- **`rerenderKeeping(selector = focusKey(document.activeElement))`:** compute the key *before* `renderNetwork()`. Focus is restored only if the selector matches after the re-render.
- **Callers:** `setWindow` and the wheel handler's rAF render use `rerenderKeeping()`. The explicit handle refocus that already exists stays.
- **`state.netTab: string | null`:**
  - Set to the tab's `data-tab` whenever `selectTab` runs on a `#net-table` detail tab.
  - Reset to `null` when the user opens a row different from the last one.
  - Read by `expandEntry(i, {focus:false})` on re-render, which calls `selectTab(tab, {focus:false})` when `#ed-${i}-t-${state.netTab}` exists.
- **Ruler selection:**
  - During a `ruler` drag, `pointermove` creates or updates one `<div class="ruler-sel" aria-hidden="true">` inside `drag.el`. Its `left` and `width` are percentages of the ruler width, clamped to 0–100.
  - `pointerup` removes it; a zoom re-renders anyway.
  - `abortDrag()` removes it.
- **Escape:** at the top of the keydown handler, `Escape` with `drag` non-null runs `abortDrag()` and `preventDefault()`, then returns before the open-row Escape branch.
- **CSS:** `.net .ruler .ruler-sel { position: absolute; top: 0; bottom: 0; border: 2px solid var(--accent); border-radius: 3px; background: color-mix(in srgb, var(--accent) 10%, transparent); pointer-events: none; }`

- [ ] **Step 1: Write the failing e2e block.** It uses the existing `page2`, `whole`, `twoFrames` and `tlCell`. Aim the mouse with `locator.hover`/`boundingBox` measured right before use.
  1. **Ruler drag:** with `rb = ruler.boundingBox()`, do mouse down at 10%, move to 40% in 5 steps, then:
     - `assert.equal(await page2.locator('.ruler-sel').count(), 1, 'ruler drag shows its selection')`;
     - mouse up, then `twoFrames()`;
     - `assert.notEqual(zoomText, whole, 'ruler drag zooms')`;
     - `assert.notEqual(await page2.locator('#net-table .tl-head .ruler span, #net-table .tl-head .ruler i').first().innerText(), '0 ms', 'first tick above 0')`. Use whatever element holds the tick labels in `report.js`.
     - Reset.
  2. **Escape cancels:** mouse down at 10%, move to 40%, press `Escape`, mouse up. Then:
     - `assert.equal(zoomText, whole, 'Escape cancels a ruler drag')`;
     - `assert.equal(await page2.locator('.ruler-sel').count(), 0)`.
  3. **Pan:**
     - Focus `.ov-h[data-edge="to"]` and press `Shift+ArrowLeft` five times, which leaves a window of about half the load.
     - Read `from0`/`to0` from both handles' `aria-valuenow`.
     - Drag from the brush's centre 60 px to the right.
     - Read `from1`/`to1`, then `assert.ok(Math.abs((to1 - from1) - (to0 - from0)) <= 1, 'pan keeps width')` and `assert.ok(from1 > from0, 'pan moves right')`.
     - Reset.
  4. **Focus after a wheel:**
     - Focus `#net-table button.sort[data-sort="time"]`, then `tlCell.hover(...)`, Ctrl-wheel, `twoFrames()`.
     - `assert.equal(await page2.evaluate(() => document.activeElement?.dataset.sort), 'time', 'wheel zoom keeps focus')`.
     - Reset.
  5. **Filter while zoomed keeps the input focused (Review Focus 1):**
     - Zoom (one Shift+ArrowLeft on the end handle), focus the URL filter input, type `img`.
     - `assert.equal(await page2.evaluate(() => document.activeElement?.id || document.activeElement?.tagName), <the input's id or 'INPUT'>)`.
     - Clear the filter and Reset.
  6. **Tab persists:**
     - Open row 0's disclosure, click `#ed-0-t-timing`, click `button.sort[data-sort="size"]`.
     - `assert.equal(await page2.getAttribute('#ed-0-t-timing', 'aria-selected'), 'true', 'tab survives a sort')`.
     - Close the row with its disclosure.

  Use the URL filter input's real selector from `reading.js` `netTools`.

- [ ] **Step 2: Run the e2e and see it fail**

Run: `npm run test:e2e`
Expected: it fails at "ruler drag shows its selection".

- [ ] **Step 3: Implement** the Interfaces items in `reading.js` and add the CSS rule to `theme.css`.

- [ ] **Step 4: Run all tests and see them pass**

Run: `npm test`, then `npm run test:e2e` three times.
Expected: green each time, including the existing Escape-closes-row check (Review Focus 5).

- [ ] **Step 5: Commit**

`git add extension/ui/reading.js extension/ui/theme.css test/e2e/run.mjs`, then `git commit -m "Network pane: ruler drag shows its range, Escape cancels drags, focus and the detail tab survive re-renders"`, with the trailer.

---

### Task 4: E2E for "Show more"

**Files:**
- Test: `test/e2e/run.mjs` (a new block right after `log('import passed')`)

**Interfaces:**
- Consumes:
  - `r1` (the main reading object, already in scope) and `saveReading`/`deleteReading` from `/browser/store.js`, called through `page2.evaluate`;
  - the reading page `ui/reading.html?id=…`;
  - `#net-table tr[data-entry]`, `[data-net-more]` and `button.disclose`;
  - `NET_PAGE = 200`.

- [ ] **Step 1: Write the block**
  1. **Build the reading.** Clone `r1` into `big` and give it a new id, using the same id field `r1`/`id1` use (read how `id1` is obtained earlier in `run.mjs`). Set `big.log.entries` to 450 entries made by cycling `r1.log.entries` with `structuredClone`, each with a unique URL (append `?n=${k}`). Save it with `saveReading`.
  2. **Open it.** Go to `ui/reading.html?id=<big id>`, set `location.hash = 'network'`, and wait for `#net-table tr[data-entry]`.
  3. **First page.** `assert.equal(rows, 200)`, and `[data-net-more]` is visible.
  4. **First click.** Click `[data-net-more]`, then `assert.equal(rows, 400)`. Assert that `document.activeElement` is the `button.disclose` of the 201st `tr[data-entry]` in document order (compare with `document.querySelectorAll('#net-table tr[data-entry]')[200]`).
  5. **Second click.** Click again, then `assert.equal(rows, 450)` and `[data-net-more]` has count 0. Focus is on the disclosure of row index 400.
  6. **Clean up.** Call `deleteReading(<big id>)` so later library counts are unaffected, then `log('show more passed')`.

- [ ] **Step 2: Run it**

Run: `npm run test:e2e`
Expected: green. This covers existing behaviour, so it should pass straight away. To prove it can fail, temporarily change `NET_PAGE` to 100 in `report.js`, see the first assertion fail, restore it, and record this in the report.

- [ ] **Step 3: Commit**

`git add test/e2e/run.mjs`, then `git commit -m "E2E: Show more pages 200 → 400 → 450 and keeps focus on the first new row"`, with the trailer.

---

## Self-review notes

- **Spec coverage:**

  | Spec section | Task |
  |---|---|
  | §1.1, §1.2, §1.3 | Task 3 |
  | §2 | Task 1 |
  | §3.1 | Task 3 |
  | §3.2–§3.5 | Task 2 |
  | §3.6 | Task 4 |

  The `niceTicks` item is dropped, as the spec says.
- **Shared files:**
  - `theme.css` is edited by Tasks 2 and 3, in different rules.
  - `test/e2e/run.mjs` is edited by Tasks 3 and 4, in different blocks.
  - `reading.js` is only edited by Task 3.
- **Names:** `displayUrl`, `focusKey`, `state.netTab`, `.ruler-sel` and `td.type` are each defined once and used consistently.
