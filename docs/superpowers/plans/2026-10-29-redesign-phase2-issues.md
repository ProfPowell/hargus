# Report redesign, phase 2: the Issues pane — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Findings get one home, the Issues pane, as a list plus one open issue at `#issue-<key>`. Fix first and the area pages switch to the same issue row and link there. Link check's broken-link findings carry `places`.

**Architecture:**
- **New core module.** `extension/core/issues.js` gives every finding a stable key, lists them in report order, and turns one issue into the brief's Markdown.
- **Shell rendering.** `h.issue` and `h.places` in `extension/ui/render.js` draw the rows and the place lists. `report.js` builds the Issues pane, one detail `<article>` per issue, shown by `:target`.
- **Viewer interaction.** `reading.js` adds filters, Copy and the place-to-request jump.

**Tech Stack:** plain ES modules, CSS `@layer` and `light-dark()`, `node --test`, and Playwright e2e (`npm run test:e2e`, run from the worktree directory).

**Spec:** `docs/superpowers/specs/2026-10-28-report-redesign-design.md`, sections A (panes, naming), D (Issues pane, places) and H.2.

**Design references:**
- `docs/design/2026-10-28-proposed.css`, the sections "issue list", "places", "smart URL" and "list ↔ detail";
- board 4 ("Issues, one open") and board 6 (Issues at 390 px) in `docs/design/2026-10-28-report-redesign.html`.

## Global Constraints

- **Scores unchanged.** For the same HAR, scores are identical, and findings are identical except for the added `places`. `evidence` stays on every finding.
- **No script in the export.** The standalone export (`standaloneDocument` in `report.js`) contains no `<script>`. Navigation is `:target` and disclosure is `<details>`.
- **Print.** Every issue's detail prints, in list order. Every closed `<details>` opens for print.
- **No explanation text.** The detail has no What / Why / How section. The accessibility reference block, from `referenceHtml`, stays only inside a closed "Reference" disclosure.
- **Naming.** The UI says "issue" where it says "finding" today. Code, data fields and the saved reading keep `findings`.
- **Escaping.** Every interpolated value goes through `html```; `raw()` is only for constant markup. URLs in links go through the scheme check (`#`, `http:` and `https:` only).
- **Colour.** No colour without a word or glyph. Use `h.sev` for severity.
- **CSS.** `theme.css` keeps `@layer reset, tokens, base, components, pages;` and uses phase 1 tokens (`--surface`, `--ink-*`, `--sev-*`, `--sp-*`, `--fs-*`, `--r-*`).
- **Old links.** `#findings` must still land on the Issues pane, in the extension and in the export.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings made while planning

1. **Issue key.** The key is `slug(plugin) + '-' + slug(id ?? index)`, where `index` is the finding's position in its plugin's own `findings` array. That is the saved order, so it stays stable across re-renders.
   - `scoreReading` (in `extension/core/score.js`) adds `index` to each scored finding copy. This adds a field to an in-memory copy; saved findings don't change.
   - A collision (the same plugin emitting the same id twice) gets `-2`, `-3` and so on, in list order.
2. **Copy as Markdown and the brief share one line format.** `issueMarkdown(issue)` lives in `extension/core/harplus.js`, and `toMarkdown` uses it for every finding.
   - Places become indented sub-bullets, at most 10, then "- …and N more places".
   - The console rule stays: no detail for `console` findings.
3. **Broken-link places.** `groupFinding` adds one place per broken item, built from the item's first source:
   - `url`, `status`, `text`, `region`, `line`, `selector` and `file` come from the item and that source;
   - `note` is "and N more places" when the item has more sources;
   - `entry` is the HAR index of the recorded request with that URL, when there is one.

   Listing every source as its own place is deferred to phase 5.
4. **Detail layout.**
   - All details render as `<article class="issue-detail" id="issue-<key>">` siblings after the list.
   - CSS shows only the `:target` one.
   - With no issue targeted, the first issue's detail shows, via `:not(:has(.issue-detail:target))`.
   - At ≥ 1100 px the list and the shown detail sit side by side (`.split`); below that the detail comes after the list.
5. **Old `#findings` links.** An empty `<span id="findings" class="pane-alias"></span>` sits inside the Issues pane, so `:has(:target)` shows the pane without script. `markActive` in `reading.js` maps the hash `findings` to the `issues` pane.
6. **Filters.**
   - In the extension, filters and Group by re-render only the list (`#issues-list`).
   - The export shows the full list grouped by severity, with no controls.
   - Low and Info groups start folded in a `details` with their count.
   - Category filtering is replaced by Source (plugin), as the spec says.
   - The text search box stays (my call).
7. **Place-to-request jump.** This is extension only.
   - A place with `entry` renders its status as `<a class="place-code" href="#network" data-entry="<i>">`. In the export it renders as a plain `<span class="place-code">`.
   - The click handler:
     1. clears the Network filters and sets the row limit to `Infinity`;
     2. sets `location.hash = 'network'`;
     3. re-renders Network;
     4. calls `expandEntry(i)`, which focuses the row.

## Review Focus

1. **Duplicate keys.** Two findings from one plugin with the same `id`, or with no id, must still get distinct, stable keys. Pinned in Task 1.
2. **Odd evidence.** A finding with no `places` and string, array or object `evidence` must render an escaped "Evidence" disclosure and never `[object Object]`. Pinned in Task 3.
3. **Bad place URLs.** A relative path, `data:`, a 2,000-character or an unparsable URL must render as plain text without throwing. Pinned in Task 2.
4. **No issues.** A reading with zero findings shows "No issues." and no empty detail. Pinned in Task 3.
5. **Dead hashes.** An old `#findings` hash, and an `#issue-…` key that no longer exists, both land on the Issues pane. Pinned in Tasks 3 and 5 (e2e).

---

### Task 1: Issue keys, the issue list, Markdown, and `places` through `normalize()`

**Files:**
- Create: `extension/core/issues.js`
- Modify: `extension/core/score.js` (finding copy at ~line 157)
- Modify: `extension/core/harplus.js` (`toMarkdown` at ~line 166; add `issueMarkdown`)
- Modify: `extension/core/plugin-host.js` (`normalize`, ~line 219)
- Test: `test/issues.test.mjs` (new), `test/core.test.mjs`, or wherever `normalize` and `toMarkdown` are tested today; add to that file.

**Interfaces:**
- Produces:
  - **`issueKey(finding: {plugin, id?, index}) → string`.** Lower-case `[a-z0-9-]`, no leading or trailing dash.
  - **`allIssues(scores) → Issue[]`.**
    - An `Issue` is the scored finding plus `key`. Every finding is included, info too.
    - Order is the same as `topFindings(scores, Infinity, null, { includeInfo: true })`.
    - Keys are made unique with `-2`, `-3`.
  - **`issueMarkdown(issue) → string`.** One bullet line, with any place sub-bullets. Exported from `harplus.js`.
  - **The `places` field.** `normalize` passes `places` through: an array of at most 200 plain objects.
    - Only these keys are kept: `url text region selector file note` as strings of up to 500 characters each, `status` as a number or a string of up to 20 characters, and `line` and `entry` as non-negative integers.
    - An item with no kept key is dropped.
    - An empty result means the field is omitted.

- [ ] **Step 1: Write the failing tests**

  ```js
  test('issueKey: plugin + id, else index; slugged', () => {
    assert.equal(issueKey({ plugin: 'links', id: 'broken-internal', index: 3 }), 'links-broken-internal');
    assert.equal(issueKey({ plugin: 'a11y-basics', index: 0 }), 'a11y-basics-0');
    assert.equal(issueKey({ plugin: 'axe', id: 'Color Contrast!', index: 1 }), 'axe-color-contrast');
  });
  test('allIssues: report order, info included, duplicate keys made unique', () => {
    // scores built with scoreReading from a reading whose plugin 'p' emits two findings with id 'dup' and one without id
    assert.deepEqual(allIssues(scores).filter((i) => i.plugin === 'p').map((i) => i.key), ['p-dup', 'p-dup-2', 'p-2']);
  });
  test('normalize keeps places, whitelists keys, caps 200, drops empties', () => {
    const out = normalize({ findings: [{ title: 't', places: [{ url: 'https://a/b', status: 404, line: 12, entry: 3, bogus: 1 }, { bogus: 2 }, ...Array(300).fill({ url: 'u' })] }] });
    const p = out.findings[0].places;
    assert.equal(p.length, 200); assert.deepEqual(p[0], { url: 'https://a/b', status: 404, line: 12, entry: 3 });
    assert.equal(normalize({ findings: [{ title: 't', places: [{ bogus: 1 }] }] }).findings[0].places, undefined);
  });
  test('issueMarkdown: same line as the brief; places as sub-bullets, capped at 10', () => {
    const md = issueMarkdown({ severity: 'medium', category: 'content', title: 'T', detail: 'D', pluginName: 'Link check', plugin: 'links',
      places: Array.from({ length: 12 }, (_, i) => ({ status: 404, url: `https://x/${i}`, text: 'a', line: i + 1 })) });
    assert.match(md, /^- \*\*MEDIUM\*\* · content · T — D _\(Link check\)_\n  - 404 https:\/\/x\/0 · “a” · line 1\n/);
    assert.match(md, /\n  - …and 2 more places$/);
    assert.ok(toMarkdown(reading).includes(issueMarkdown(firstFindingOf(reading)))); // the brief uses the same text
  });
  ```

  The place sub-bullet format joins the present parts with " · ", in this order: `status url`, `“text”`, `region`, `line N`, `selector`, `file`, `note`.

- [ ] **Step 2: Run the tests and check that they fail**

  Run `node --test test/issues.test.mjs`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement**

  - `score.js`: the finding copy becomes `{ ...f, severity: sev, plugin: r.id, pluginName: r.name, area, index: r.findings.indexOf(f) }`.
  - `issues.js` imports `topFindings` from `score.js`.
  - `toMarkdown` uses `issueMarkdown` for each finding. Its `findings(reading)` source stays the same.

- [ ] **Step 4: Run the tests and check that they pass**

  Run `npm test`. Expected: all pass, and the score tests are unchanged.

- [ ] **Step 5: Commit**

  The message is "Issue keys, allIssues, issueMarkdown shared with the brief; normalize passes places".

---

### Task 2: `h.issue` and `h.places`

**Files:**
- Modify: `extension/ui/render.js` (add `issue` and `places` to `h`)
- Modify: `extension/ui/theme.css` (`@layer components`)
- Test: `test/charts.test.mjs`

**Interfaces:**
- Consumes `h.sev` (phase 1) and the `Issue` from Task 1.
- Produces:
  - **`h.issue(issue, { showArea = true, current = false } = {}) → html`.**
    - The output is `<a class="issue" href="#issue-<key>"[ aria-current="true"]>`.
    - Inside: `h.sev(issue.severity)`, then `<span class="issue-title">`, then `<span class="issue-count">`, then `<span class="issue-meta">`.
    - `issue-count` holds `count` when it is above 1, otherwise nothing.
    - `issue-meta` holds the area label (when `showArea`) and `pluginName`, each in a `<span>`.
    - Under 520 px of container width, the severity moves to its own line (`container-type: inline-size` on `ul.issues`).
    - The title never squeezes into a narrow column: the title takes `1fr` of a two-row grid. This is the design mock's bug, not to be copied.
  - **`h.issues(list, opts) → html`.** The output is `<ul class="issues">` of `<li>${h.issue(i, opts)}</li>`, or `<p class="muted">No issues.</p>` when the list is empty.
  - **`h.places(items, { interactive = false } = {}) → html | ''`.**
    - The output is `<ul class="places">`. Each item is `<li class="place">`, holding:
      - the code: `<a class="place-code" href="#network" data-entry="i">status</a>` when `interactive` and `entry` is an integer, else `<span class="place-code">status</span>`, and omitted with no status;
      - `<span class="url" title="full">` containing `<span class="url-host">`, `<span class="url-path">` and `<span class="url-query">`. URLs that `new URL` can't parse, or that aren't `http(s)`, go whole into `.url-path`;
      - when `interactive` and `url` are set, `<button type="button" class="copy" data-copy="url" aria-label="Copy URL">`;
      - `<span class="place-where">` holding `“text”`, `region`, `line N`, `selector` (in `<code>`), `file` and `note`, each a `<span class="loc">`.
    - A 404 status gets `data-status-class="error"` for colour, and the code text itself carries the meaning.
    - Returns `''` for an empty or missing list.
  - **CSS.** Copy the sections "issue list", "places" and "smart URL" from `docs/design/2026-10-28-proposed.css`. The query shrinks first (`flex-shrink: 100`), then the path; the host never shrinks.

- [ ] **Step 1: Write the failing tests**

  ```js
  test('issue row: link to its key, sev word, count only when > 1, area optional, escaped', () => {
    const i = { key: 'links-broken-internal', severity: 'medium', title: '7 <broken>', count: 7, area: 'content', pluginName: 'Link check' };
    const s = String(h.issue(i));
    assert.match(s, /^<a class="issue" href="#issue-links-broken-internal">/); assert.match(s, /data-sev="medium"/);
    assert.ok(s.includes('7 &lt;broken&gt;') && s.includes('<span class="issue-count">7</span>') && s.includes('Content'));
    assert.ok(!String(h.issue({ ...i, count: 1 })).includes('>1<'));
    assert.ok(!String(h.issue(i, { showArea: false })).includes('Content'));
    assert.equal(String(h.issues([])), '<p class="muted">No issues.</p>');
  });
  test('places: URL split, entry link only when interactive, bad URLs whole, escaped', () => {
    const p = String(h.places([{ status: 404, url: 'https://en.wikipedia.org/wiki/X?action=edit&redlink=1', text: 'X', region: 'main', line: 1242, selector: '#a', entry: 5 }], { interactive: true }));
    assert.match(p, /<a class="place-code" href="#network" data-entry="5">404<\/a>/);
    assert.ok(p.includes('<span class="url-host">en.wikipedia.org</span>') && p.includes('<span class="url-path">/wiki/X</span>') && p.includes('<span class="url-query">?action=edit&amp;redlink=1</span>'));
    assert.ok(!String(h.places([{ status: 404, url: 'https://a/b', entry: 5 }])).includes('<a class="place-code"'));
    for (const url of ['/rel/path', 'data:text/html,<b>', 'x'.repeat(2000), 'http://[bad']) assert.doesNotThrow(() => String(h.places([{ url }])));
    assert.ok(String(h.places([{ url: 'data:text/html,<b>' }])).includes('&lt;b&gt;'));
    assert.equal(String(h.places([])), '');
  });
  ```

- [ ] **Step 2: Run the tests and check that they fail**

  Run `node --test test/charts.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement the helpers and CSS**

  The area label comes from `AREAS` in `extension/core/score.js` (or wherever `report.js` gets `AREA_LABEL`); reuse it, don't redefine it.

- [ ] **Step 4: Run the tests and check that they pass**

  Run `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

  The message is "h.issue/h.issues and h.places: one issue row, URL parts".

---

### Task 3: The Issues pane, and Fix first and area pages switched to issue rows

**Files:**
- Modify: `extension/ui/report.js`:
  - `PANES` (line 27);
  - `sidebar` (48–65);
  - `findingList` (75–78), which is removed;
  - the overview's Fix first (~179);
  - `areaPane`'s Findings card (~438);
  - `findingsTable` (450–463), which is removed;
  - `findingsPane` (643–648), which is replaced.
- Modify: `extension/ui/theme.css` (issues pane layout, `.issue-detail` `:target` rules, print)
- Modify: `test/report.test.mjs`, `test/a11y-reference.test.mjs`, and any test importing `findingsTable` or `findingList`

**Interfaces:**
- Consumes: `allIssues` and `issueKey` from Task 1; `h.issue`, `h.issues` and `h.places` from Task 2; `referenceHtml` and `findingReference` (already in `report.js`).
- Produces, for Task 4:
  - **`PANES`** has `'issues'` in place of `'findings'`.
  - **Pane structure:**

    ```
    <section class="pane" id="issues">
      <header class="pane-head"><h1 id="issues-h">Issues <b>N</b></h1><div class="tools" id="issues-tools"></div></header>
      <span id="findings" class="pane-alias"></span>
      <div class="split">
        <div id="issues-list">…</div>
        <div class="issue-details">article.issue-detail × N</div>
      </div>
    </section>
    ```

  - **`issuesList(issues, { group = 'severity' }) → html`.**
    - It returns the list markup for `#issues-list`.
    - Groups are headed with `.issue-group` (`h.sev` word plus count) when grouping by severity, or by area label or plugin name otherwise.
    - The Low and Info groups are wrapped in `<details class="disclosure">` with summary "Low · 37" (closed).
  - **`issueDetail(issue, { prev, next, interactive, results }) → html`.**
    - The output is `<article class="issue-detail" id="issue-<key>" aria-labelledby="issue-<key>-h">`.
    - Its contents, in order:
      1. a chips row: `h.sev(sev, { pill: true })`, an area link (`#area-<area>`), a source link (`#p-<plugin>`), and "N places" when there are places;
      2. `<h2 id="issue-<key>-h">title</h2>`;
      3. `detail` in a `<p>`;
      4. **Where:** `h.places(places, { interactive })` when there are places; otherwise, when `evidence` is set, `h.more('Evidence', <pre>…)`. Evidence is a string as is, or `JSON.stringify(…, null, 2)` for an array or object;
      5. **Reference:** `h.more('Reference', referenceHtml(ref))` when `findingReference(issue)` is set, plus `h.link(ref, 'reference')` when `issue.ref` is set;
      6. a footer: "Found by <pluginName>", the plugin's first `headline` summary value when there is one, and the link "All <pluginName> data →" to `#p-<plugin>`;
      7. a nav row, in both modes: Previous and Next as `<a href="#issue-<key>">`;
      8. **interactive only:** `<button data-act="copy-md" data-key="…">Copy as Markdown</button>`, plus `<button data-act="copy-urls" data-key="…">Copy all URLs</button>` when any place has a `url`.
    - No What / Why / How text anywhere.

- [ ] **Step 1: Write the failing tests in `test/report.test.mjs`**

  ```js
  test('Issues pane: one list, one detail per issue, keys as ids, #findings alias, no tables', () => {
    const out = renderReport(reading, plugins, { interactive: false });
    assert.ok(PANES.includes('issues') && !PANES.includes('findings'));
    assert.match(out, /<section class="pane" id="issues"/); assert.match(out, /<span id="findings" class="pane-alias"><\/span>/);
    const keys = allIssues(scoreReading(reading, plugins)).map((i) => i.key);
    for (const k of keys) assert.ok(out.includes(`id="issue-${k}"`), k);
    assert.ok(!out.includes('class="data findings"') && !out.includes('finding-list'));
  });
  test('Fix first and area issues use the same row and link to the detail', () => {
    const out = renderReport(reading, plugins, { interactive: false });
    const top = allIssues(scoreReading(reading, plugins))[0];
    assert.ok((out.match(new RegExp(`href="#issue-${top.key}"`, 'g')) || []).length >= 3); // Fix first, area pane, Issues list
  });
  test('detail: places when present, else escaped Evidence; Reference closed; no what/why/how', () => {
    // three hand-made issues: with places; with object evidence {a:'<x>'}; with string evidence
    // assert: places issue has <ul class="places">, no Evidence; object evidence shows '&lt;x&gt;' in <pre>, never '[object Object]'
    // assert: an accessibility finding's Reference is inside <details class="disclosure"> without [open]
    // assert: !/What’s wrong|Why it matters|How to fix/.test(detailHtml)
  });
  test('no findings: "No issues." and no issue-detail', () => {
    const out = renderReport(emptyReading, plugins, { interactive: false });
    assert.match(out, /No issues\./); assert.ok(!out.includes('class="issue-detail"'));
  });
  test('export: no <script>, every detail present, Copy buttons absent, Prev/Next anchors present', () => {
    const doc = standaloneDocument(reading, plugins, { css: '' });
    assert.ok(!/<script/i.test(doc)); assert.ok(!doc.includes('data-act="copy-md"')); assert.match(doc, /class="issue-nav"[^]*href="#issue-/);
  });
  ```

  Update the existing tests that assert `findingsTable`, "All findings", the `#findings` pane or "N findings" text to the new names and words. Move the reference-block assertions in `a11y-reference.test.mjs:174` onto `issueDetail` (exported for the test) or `renderReport`.

- [ ] **Step 2: Run the tests and check that they fail**

  Run `node --test test/report.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement the pane, the rows and the CSS**

  - **Sidebar.** "All findings" becomes "Issues" with the total, linking to `#issues` with `data-pane="issues"`. Under the overall ring, "N findings" becomes "N issues".
  - **Overview.** Fix first is `h.issues(allIssues(scores).filter(not info).slice(0, 5))`. Its link reads "All N issues →" and points to `#issues`.
  - **Area pane.** "Findings · n" becomes "Issues · n", drawn with `h.issues(areaIssues.slice(0, 8), { showArea: false })`. "All issues →" becomes `<a href="#issues" data-area="<id>">`.
  - **CSS:**
    - `.issue-details > .issue-detail { display: none }`;
    - `.issue-details > .issue-detail:target, .issue-details:not(:has(.issue-detail:target)) > .issue-detail:first-child { display: block }`;
    - the `.split` grid from proposed.css at `@media (min-width: 1100px)`, and one column below that;
    - in print, every `.issue-detail` is displayed and `.issue-nav` is hidden.
    - `.pane-alias` takes no space.

- [ ] **Step 4: Run the tests and check that they pass**

  Run `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

  The message is "Issues pane: list + detail by :target; Fix first and area pages use the issue row; #findings alias".

---

### Task 4: Viewer: filters, Copy, Area link, place-to-request jump

**Files:**
- Modify: `extension/ui/reading.js`:
  - `state` (line 24);
  - `findingTools` and `renderFindings` (276–300), which are replaced;
  - `markActive` (419–425);
  - the click and input handlers (~700–770).
- Test: `test/e2e/run.mjs`, as listed in Task 5. This task's logic is browser-side, so its tests live in e2e. Any pure helper you factor out (e.g. `filterIssues(list, filters)`) gets a unit test in `test/report.test.mjs`.

**Interfaces:**
- Consumes: `issuesList`, `PANES` and the pane structure from Task 3; `allIssues` and `issueMarkdown` from Task 1; `expandEntry` and `renderNetwork` (existing, in `reading.js`).
- Produces:
  - **`state.issues = { sev: Set, area: '', source: '', group: 'severity', q: '' }`.** It replaces `state.sev`, `state.area`, `state.category` and `state.q`.
  - **`filterIssues(list, f) → Issue[]`.** A pure function, exported from `report.js` so it can be unit-tested. It keeps an issue when all of these hold:
    - its severity is in `f.sev`;
    - its area is `f.area`, or `f.area` is empty;
    - its plugin is `f.source`, or `f.source` is empty;
    - its title, detail and plugin name, lower-cased, contain `f.q`.

- [ ] **Step 1: Write the failing unit test for `filterIssues`**

  ```js
  test('filterIssues: severity set, area, source, text', () => {
    const list = [{ severity: 'high', area: 'accessibility', plugin: 'axe', title: 'Contrast', pluginName: 'axe-core' }, { severity: 'low', area: 'content', plugin: 'links', title: 'Redirects', pluginName: 'Link check' }];
    assert.deepEqual(filterIssues(list, { sev: new Set(['high']), area: '', source: '', q: '' }).map((i) => i.plugin), ['axe']);
    assert.deepEqual(filterIssues(list, { sev: new Set(['high', 'low']), area: 'content', source: '', q: '' }).map((i) => i.plugin), ['links']);
    assert.deepEqual(filterIssues(list, { sev: new Set(['high', 'low']), area: '', source: 'links', q: 'redir' }).map((i) => i.plugin), ['links']);
  });
  ```

- [ ] **Step 2: Implement the tools**

  The tools go into `#issues-tools`. The interactive list shows the filtered list, re-rendered into `#issues-list` with the chosen grouping. The details are untouched.
  - Severity toggle chips: `aria-pressed`, a count on each, `h.sev` inside.
  - An Area `<select>`.
  - A Source `<select>`: plugins that have issues, by name.
  - A Group by `<select>`: severity, area or source.
  - A search box, labelled "Filter issues".

- [ ] **Step 3: Implement the actions**

  - **`data-act="copy-md"`.** Copies `issueMarkdown(issue)` for that key, then calls `toast('Issue copied')`.
  - **`data-act="copy-urls"`.** Copies the places' URLs, one per line.
  - **`data-copy="url"` on a place.** Copies that URL.
  - **`a[data-area]` with `href="#issues"`.** Sets `state.issues.area`, re-renders the tools and the list, and lets the hash change go ahead.
  - **`a.place-code[data-entry]`.** Follows ruling 7. Prevent the default, then:
    1. reset `state.netQ`, `state.netType` and `state.netParty` to `''`, and `state.netLimit` to `Infinity`;
    2. set `location.hash = 'network'`;
    3. call `renderNetwork()`;
    4. call `expandEntry(i)`, and set `state.netOpen = i`.
  - **`markActive`.** The hash `findings` maps to the pane `issues`. A hash starting with `issue-` maps to `issues` even when no element has that id (a dead key).

- [ ] **Step 4: Run the tests**

  Run `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

  The message is "Issues tools: severity/area/source/group/search; Copy as Markdown and URLs; place opens its request".

---

### Task 5: Link check emits places; e2e, screens script, and the look

**Files:**
- Modify: `extension/core/broken.js` (`groupFinding`, ~231)
- Modify: `extension/plugins/links.js` (pass what `groupFinding` needs to resolve `entry`)
- Modify: `scripts/screens.mjs`:
  - the pane list at line 28, `'findings'` → `'issues'`;
  - the finding-fix shot (~198–203), which becomes `report-issue-detail`: the Issues pane with the `links-broken-internal` issue (or the first issue with places) targeted;
  - the panes at ~244 and ~250.
- Modify: `test/e2e/run.mjs` (the findings block at ~1334–1343)
- Test: `test/broken.test.mjs`, `test/links.test.mjs`

**Interfaces:**
- Consumes everything above.
- Produces: `groupFinding(group, items, { pageUrl, missingCount, entryOf })`, where `entryOf(url) → number | undefined` and `places` follows ruling 3.

- [ ] **Step 1: Write the failing unit tests for places**

  ```js
  test('groupFinding: one place per item from its first source, entry when recorded, note for more sources', () => {
    const items = [{ url: 'https://s/a', status: 404, kind: 'page', sources: [{ text: 'A', region: 'main', line: 12, selector: '#a' }, { text: 'A2' }], moreSources: 1 },
                   { url: 'https://s/img.png', status: 404, kind: 'image', sources: [{ via: 'stylesheet', file: '/css/site.css', line: 3 }], moreSources: 0 }];
    const f = groupFinding('internal', items, { pageUrl: 'https://s/', entryOf: (u) => (u.endsWith('.png') ? 7 : undefined) });
    assert.deepEqual(f.places[0], { url: 'https://s/a', status: 404, text: 'A', region: 'main', line: 12, selector: '#a', note: 'and 2 more places' });
    assert.deepEqual(f.places[1], { url: 'https://s/img.png', status: 404, file: '/css/site.css', line: 3, entry: 7 });
    assert.ok(f.evidence); // evidence kept
  });
  ```

  In `links.test.mjs`, a run-level test checks that the grouped findings carry `places` through `normalize`, and that the Link check panel's output is unchanged.

- [ ] **Step 2: Implement**

  - Set `places` in `groupFinding`.
  - `links.js` builds `entryOf` from the HAR entries: first match on the URL without its hash.

- [ ] **Step 3: Update the e2e test**

  The old findings block becomes these checks:
  1. `location.hash = 'issues'`: the pane is visible, and `#issues-list .issue` has as many rows as `allIssues` has issues.
  2. Click the "Fieldsets without a legend" row: the hash becomes `#issue-…`, and only that `article.issue-detail` is visible.
  3. Its "Reference" disclosure opens to the WCAG `1.3.1 Info and Relationships` link, as the old test checked.
  4. Clicking the High severity chip leaves only High rows.
  5. `location.hash = 'findings'` shows the Issues pane.
  6. `location.hash = 'issue-nope'` shows the Issues pane.
  7. In the exported file opened with `#issues`, the pane shows with no script and Copy buttons are absent.
  8. If the test page produces a grouped broken-link issue with a place that has an `entry`: clicking its status code opens the Network pane with `#ed-<entry>` present.

  Keep the screenshot as `reading-issue-detail.png`.

- [ ] **Step 4: Run the full suites, then look**

  Run `npm test`, then `npm run test:e2e` from the worktree directory, then `node scripts/screens.mjs --out test/e2e/out/screens-phase2`. Run them one after another, never at the same time.

  Read these shots: the Issues pane at 1280 and narrow, the issue detail, the overview (Fix first rows), an area pane, the dark Issues pane, and the export.

  Fix in `theme.css` anything that breaks the layout rules in the spec. In particular:
  - an issue title squeezed into a narrow column;
  - horizontal scroll at 390 px;
  - a detail that doesn't show;
  - a severity colour that disagrees with its word.

- [ ] **Step 5: Commit**

  The message is "Link check places; e2e and screens for the Issues pane; visual fixes".
