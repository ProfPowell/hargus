# Broken Links and Assets, Grouped — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link check reports broken links and assets in three groups: on this page, internal and external. Each group is one finding, and each broken URL lists every place that uses it, with a file and line where the recording allows.

**Architecture:**
- A new pure module, `extension/core/broken.js`, classifies recorded assets, finds source lines and builds the groups.
- A second pure module, `extension/core/supersede.js`, lets a plugin result name findings it replaces. Score, the findings list and plugin panels drop those findings only when the replacing plugin finished `ok`.
- Content collects where each link sits. Network tags its error findings. Link check assembles `data.broken`, emits the group findings and renders the nested panel.

**Tech Stack:**
- plain ES modules (Chrome MV3 extension);
- `node --test` for unit tests;
- Playwright for e2e (`npm run test:e2e`).

**Spec:** `docs/superpowers/specs/2026-10-27-broken-links-grouped-design.md`

## Global Constraints

- Groups, in order: **on this page**, **internal**, **external**. Internal vs external uses `siteOf` against the page's final URL, as for links.
- Asset kinds that can be broken: image, script, stylesheet, font, media, frame.
  - Their recorded HTTP status must be ≥ 400; 401 and 403 count.
  - XHR, fetch, beacon, ping, websocket and the main document are not assets.
  - Requests with no status stay in Network.
- Link kinds:
  - `page` for `<a href>` targets;
  - `anchor` for on-this-page items (Ruling P1 below).
- A link whose URL is a recorded asset takes the asset's kind, and the **recorded status wins**:
  - a recorded broken asset is listed even if Link check skipped that URL or saw it succeed;
  - a URL Link check saw broken but the browser loaded fine is not listed.
- 401, 403 and 429 **links** stay "refused", not broken.
- All group findings are **medium**. Titles:
  - `N broken links on this page`;
  - `N broken internal links and assets (5 pages, 2 images)`;
  - `N broken external links and assets (4 pages)`.
  
  Use the singular for 1: "1 broken link on this page", "1 broken internal link or asset (1 page)". Kinds are listed in the order page, image, script, stylesheet, font, media, frame, with each kind singular or plural to match its count.
- Detail: the first three items, each as `404 /path — image, used in /css/site.css line 212`, plus `…and in 2 more places` when there are more sources.
- Evidence: the item URLs, up to 10.
- Extent fields: `count` = number of items; `unit` = `'broken links and assets'`, or `'broken links'` for on this page.
- Items are sorted by number of places (most first), then by status, then by URL. Sources stay in the order they were found. Keep at most **20** sources per item, then `moreSources: n` ("and N more places").
- Asset sources come from `_initiator`:
  - `lineNumber` is 0-based, so show +1;
  - a script initiator reads "loaded by /js/x.js line N";
  - the chain is not walked back.
- Link sources give: link text or aria-label (80 characters at most), region (`header`, `nav`, `main`, `aside`, `footer`, `form` or their ARIA roles, else `body`), a short selector, and the source line.
- The three source-line outcomes stay distinct:
  - a line;
  - "added by a script" (the body was recorded, the href isn't in it);
  - "source not in the recording" (no body recorded).
  
  For an asset with no initiator: "source unknown".
- The page-phase `collect` functions are serialised into the page, so they must be self-contained: no imports, literals only.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Never run e2e and calibration at the same time.

**Plan rulings on the spec:**
- **P1:** on-this-page items get the kind `anchor` and the status text `no such id`. The spec's kind list covers only internal and external.
- **P2:** the source shape is `{ file?, line?, text?, region?, selector?, via?: 'page'|'stylesheet'|'script', note? }`, where `note` is one of `'added by a script'`, `'source not in the recording'` or `'source unknown'`. This replaces the spec's `script?`/`unknown?` flags, which were ambiguous between "added by" and "loaded by".
- **P3:** recorded broken assets are reported whatever the "Also check external links" option says. That option governs fetching links only.
- **P4:** finding ids:
  - Content's missing-anchors finding: `missing-anchors`;
  - Network's split findings: `asset-errors` and `request-errors`;
  - `supersedes` entries are `"pluginId:findingId"`.
  
  Link check always supersedes `content:missing-anchors` and `network:asset-errors`.

## Review Focus

1. **A page with no recorded bodies** (body capture off, or a body over 1 MB). Every link source says "source not in the recording", never "added by a script". Test this in Task 4.
2. **A broken asset also used as a link,** where the asset loaded fine with cookies but Link check got 404 without them. It must not be listed. Test this in Task 4.
3. **Link check skipped or errored** (no Content data, or a timeout). Network's `asset-errors` and Content's `missing-anchors` must still count in the score and appear in All findings. Test this in Task 1.
4. **An href written with `&amp;`, or relative (`../x`, `/x`, `x`), in the HTML source.** Its line must still be found. Test this in Task 4.
5. **The same href in 3 anchors, but only 2 in the HTML source** (one was added by a script). The first two get successive lines and the third gets "added by a script". Test this in Task 4.

---

### Task 1: Superseded findings

**Files:**
- Create: `extension/core/supersede.js`
- Modify:
  - `extension/core/plugin-host.js` (`normalize`: keep `supersedes`);
  - `extension/core/score.js:151` (loop over active findings);
  - `extension/core/harplus.js:87-94` (`findings()`);
  - `extension/ui/report.js:231` (the panel finding count);
  - `docs/PLUGINS.md` (`## Findings`).
- Test: `test/supersede.test.mjs` (new), `test/score.test.mjs`, `test/core.test.mjs`

**Interfaces:**
- Produces:
  - `activeFindings(result, results) → finding[]`. These are `result.findings` minus any finding whose `"${result.id}:${f.id}"` appears in the `supersedes` array of another result in `results` with `status === 'ok'`.
  - `results` is the `_harplus.plugins` object, keyed by id.
- Produces: plugin results may carry `supersedes: string[]`. `normalize` keeps up to 50 strings, each at most 120 characters.

- [ ] **Step 1: Write the failing tests** in `test/supersede.test.mjs`:
  - `activeFindings drops a superseded finding when the superseding plugin is ok`: network has findings with ids `asset-errors` and `request-errors`; links is `{ status: 'ok', supersedes: ['network:asset-errors'] }`. The result has only `request-errors`.
  - `keeps it when the superseding plugin is skipped, errored or absent`: with status `skipped` or `error`, or with no links result, both findings remain.
  - `findings without an id are never dropped.`
  
  In `test/score.test.mjs`:
  - `superseded finding does not deduct`: the network area's score with links ok equals the score with the `asset-errors` finding removed by hand.
  - `a reading without supersedes scores exactly as before`: deepEqual against the same reading's score with no links result.
  
  In `test/core.test.mjs`: `normalize keeps supersedes strings and drops others`: a plugin returning `supersedes: ['a:b', 3, 'x'.repeat(200)]` gives `['a:b']`.

- [ ] **Step 2: Run** `node --test test/supersede.test.mjs test/score.test.mjs test/core.test.mjs`. Expect a FAIL on the module import or the assertions.

- [ ] **Step 3: Implement** `activeFindings` and the `normalize` change. In `normalize`, return `supersedes` alongside data, findings and summary, then check that the host stores it on the result next to `status`. Use `activeFindings` in `scoreReading`, in `findings(reading)` and in `pluginPanel`'s count.
  
  Add to `docs/PLUGINS.md`, in `## Findings`: "A result may list `supersedes: ['plugin:findingId']`. Those findings are dropped from scores and lists only when this plugin finishes `ok`, so nothing goes unreported if it fails."

- [ ] **Step 4: Run `npm test`.** Expect everything to PASS.

- [ ] **Step 5: Commit:** "Findings can be superseded by a plugin that finished ok".

### Task 2: Asset kinds and Network's split errors

**Files:**
- Create: `extension/core/broken.js` (this task adds `ASSET_KINDS` and `assetKind` only)
- Modify: `extension/plugins/network.js:42,80`
- Test: `test/broken.test.mjs` (new), plus the existing Network tests (find them with `grep -ln "plugins/network.js" test/`)

**Interfaces:**
- Produces:
  - `ASSET_KINDS = ['image','script','stylesheet','font','media','frame']`;
  - `assetKind(entry, main) → kind | null`, where `main` is the main document entry from `har-util.mainEntry`:
    - a `document` resource that is neither `main` nor part of its redirect chain is `frame`, where `_resourceType` is `document` or `iframe`;
    - xhr, other and the main document are `null`;
    - the other kinds come from `har-util.resourceType`.
- Produces: Network findings with `id: 'asset-errors'` (`N asset requests returned HTTP errors`) and `id: 'request-errors'` (`N other requests returned HTTP errors`). Both are medium, category `quality`, with the same evidence format as today. Each is emitted only when non-empty.

- [ ] **Step 1: Write the failing tests:**
  - `assetKind`: image, script, stylesheet, font and media entries give their kind; a sub-frame document gives `frame`; the main document, xhr and fetch give `null`.
  - Network: a reading with a 404 image, a 500 xhr and a 404 font gives `asset-errors` titled "2 asset requests returned HTTP errors" and `request-errors` titled "1 other request returned HTTP errors".

- [ ] **Step 2: Run** them and expect a FAIL.

- [ ] **Step 3: Implement** the change in network.js, using `assetKind(e, main)` to split `errors`. The data and panel stay unchanged.

- [ ] **Step 4: Run `npm test`.** Expect a PASS, after updating any existing Network test that asserted the old single title.

- [ ] **Step 5: Commit:** "Network splits asset errors from other request errors".

### Task 3: Content records where each link is

**Files:**
- Modify:
  - `extension/plugins/content.js`: `collect` at lines 52-58, and `analyze` near lines 243-315 and line 286;
- Test: `test/content.test.mjs`

**Interfaces:**
- Produces: each collected link is `{ href, raw, text, aria, region, selector }`:
  - `raw` is `getAttribute('href')`, as written, sliced to 500 characters;
  - `region` is one of `header|nav|main|aside|footer|form|body`, taken from the nearest ancestor element or ARIA role (`banner`→header, `navigation`→nav, `main`, `complementary`→aside, `contentinfo`→footer, `form`/`search`→form);
  - `selector` is short, at most 4 steps, preferring an id.
- Produces: `data.linkTargets.sources`, an object keyed by target URL (the same `dest` strings as `internal`/`external`):
  - each value is `{ list: [{ raw, text, region, selector }], more: n }`, with `list` holding at most 20 entries;
  - `text` is the link text or aria-label, at most 80 characters;
  - only targets that are in the lists get an entry.
- Produces: `data.links.missing` items now carry `raw`, `region` and `selector`. `data.links.missingCount` is the full count.
- Produces: Content's missing-anchors finding gains `id: 'missing-anchors'`. Its title and its condition stay the same.

- [ ] **Step 1: Write the failing tests** with `analyze`. Feed links that carry the new fields:
  - `sources` groups three anchors with the same dest into one entry with `list.length === 3`;
  - 25 anchors to one dest give 20 entries and `more: 5`;
  - `missingCount` counts past 20;
  - the missing-anchors finding has `id: 'missing-anchors'`;
  - an old-style link without `raw` or `region` still works: its source entry omits them.

- [ ] **Step 2: Run** `node --test test/content.test.mjs` and expect a FAIL.

- [ ] **Step 3: Implement** the change. In `collect`, compute `region` and `selector` inline: it is serialised, so add no helpers outside the function body.

- [ ] **Step 4: Run `npm test`** and expect a PASS.

- [ ] **Step 5: Commit:** "Content records each link's text, region, selector and href as written".

### Task 4: Grouping and source lines

**Files:**
- Modify: `extension/core/broken.js` (add to Task 2's module)
- Test: `test/broken.test.mjs`

**Interfaces:**
- Consumes:
  - `assetKind` (Task 2);
  - the `linkTargets.sources` and `links.missing` shapes (Task 3);
  - `bodyText`, `mainEntry` and `resourceType` from `har-util`.
- Produces:
  - `lineOf(text, needles) → number | null`. This is the 1-based line of the first needle found. Also try each needle with `&` written as `&amp;`.
  - `linesOf(text, needle) → number[]`. These are all 1-based lines where the needle (or its `&amp;` form) appears, in order. They are used to give the nth anchor with the same `raw` the nth occurrence.
  - `assetSources(entry, har, pageUrl) → source[]`, per the Global Constraints:
    - `via` is `'page'` when the initiator URL (without its hash) equals the page; then `file` is `'this page'`.
    - `via` is `'stylesheet'` or `'script'` when the initiator entry's `resourceType` says so. Otherwise `via` is `'page'` and `file` is the initiator path.
    - Use `lineNumber + 1`. With no line, use `lineOf` over the initiator entry's body, trying the full URL, path+search, path and file name.
  - `linkSources(srcs, mainText) → source[]`:
    - `mainText` is the main document body text, or `null` when no body was recorded;
    - successive identical `raw` values take successive `linesOf` hits;
    - when the hits run out, the note is `added by a script`;
    - when `mainText` is null, the note is `source not in the recording`.
  - `groupBroken({ checked, sources, missing, har, pageUrl, siteOf }) → { page: item[], internal: item[], external: item[] }`:
    - `item = { url, status, kind, sources, moreSources }`;
    - `checked` is Link check's results;
    - `sources` is `linkTargets.sources`;
    - `missing` is `links.missing`.
  - `groupFinding(group, items) → finding | null`, where `group` is `'page'|'internal'|'external'`. It gives the title, detail, evidence, count and unit exactly as in the Global Constraints, at medium severity, category `content`.

- [ ] **Step 1: Write the failing tests:**
  - `lineOf`/`linesOf`: plain, `&amp;`, not found → null / [].
  - `assetSources`:
    - a parser initiator on the page at `lineNumber: 87` → `{ via: 'page', file: 'this page', line: 88 }`;
    - a CSS initiator with no line whose body has the URL on line 212 → `{ via: 'stylesheet', file: '/css/site.css', line: 212 }`;
    - a script initiator → `via: 'script'`;
    - no initiator → `{ note: 'source unknown' }`.
  - `linkSources`:
    - with `mainText` null, all notes are `source not in the recording` (Review Focus 1);
    - relative `raw` (`../x`, `/x`, `x`) is found as written (Review Focus 4);
    - 3 anchors with 2 hits in the source → lines, lines, `added by a script` (Review Focus 5).
  - `groupBroken`:
    - an internal 404 page with 3 sources → one item with 3 sources;
    - an external 404 page → external;
    - a subdomain → internal;
    - checked statuses 401, 403 and 429 are not broken;
    - a recorded 404 image initiated from CSS → internal, kind `image`;
    - a link to a recorded asset that loaded with 200 but was checked as 404 → not listed (Review Focus 2);
    - a link to a recorded broken asset → one item, kind `image`, with the link and asset sources merged;
    - missing anchors `#a` ×2 and `#b` → page group, two items, kind `anchor`, status `no such id`;
    - the sort order; the 20-source cap and `moreSources`.
  - `groupFinding`:
    - the exact titles for 1 and many;
    - `(5 pages, 2 images)`;
    - the detail formats `404 /path — image, used in /css/site.css line 212`, `— page, used in “Our team” · nav · line 41`, and `…and in 2 more places`;
    - evidence capped at 10;
    - `null` for an empty group.

- [ ] **Step 2: Run** `node --test test/broken.test.mjs` and expect a FAIL.

- [ ] **Step 3: Implement** the functions. Keep the module pure: no DOM, no `chrome.*`, no fetch.

- [ ] **Step 4: Run `npm test`** and expect a PASS.

- [ ] **Step 5: Commit:** "Broken links and assets grouped by on-page, internal and external, with sources".

### Task 5: Link check uses the groups

**Files:**
- Modify:
  - `extension/plugins/links.js`: lines 216-226 (findings), the `run` return value, and `render` at lines 273-279;
  - `extension/ui/theme.css`;
  - `extension/ui/reading.js:773` (print);
  - `docs/PLUGINS.md` (a Link check note, if plugins are listed there).
- Test: `test/links.test.mjs`

**Interfaces:**
- Consumes: `groupBroken` and `groupFinding` (Task 4); `activeFindings` semantics (Task 1).
- Produces:
  - `data.broken = { page, internal, external }`;
  - findings from `groupFinding` for internal and external, always;
  - the page group's finding only when `ctx.results['a11y-basics']?.status !== 'ok'`;
  - `supersedes: ['content:missing-anchors', 'network:asset-errors']` on the result.
  
  The `Broken link: …` and `…and N more broken links` findings are removed. All other findings and the summary line are unchanged.

- [ ] **Step 1: Write the failing tests:**
  - Replace `'more than 10 broken links: 10 findings plus one "and N more"'` with `12 broken internal links → one finding titled "12 broken internal links and assets (12 pages)"`.
  - An external broken link goes in the external finding.
  - A reading with a recorded 404 image (`reading.log.entries` with `_initiator`) gives an internal item of kind image, even with `external: false`.
  - The page-group finding is present without a11y-basics and absent when `results['a11y-basics'].status === 'ok'`, while `data.broken.page` is listed either way.
  - The result has `supersedes`.
  - Render: the output contains a `details` element per item with class `broken-item`, the item's status, kind, URL and "3 places", and each source line text.
  
  Update the `ctx()` helper to accept a `reading` and `sources`.

- [ ] **Step 2: Run** `node --test test/links.test.mjs` and expect a FAIL.

- [ ] **Step 3: Implement** the changes:
  - **Render:** a `Broken` sub-section above today's table, with `h.sub('On this page' | 'Internal' | 'External', …)`, each omitted when empty.
  - **Each item** is `<details class="broken-item"><summary>status · kind · link · N places</summary><ul>…sources…</ul></details>`.
  - **A source line** reads:
    - `/css/site.css line 212`, or `this page line 88 · main › section.hero > img`;
    - `loaded by /js/x.js line 40`;
    - `“Our team” · nav · line 41`;
    - `“Team” · footer · added by a script`.
  - **Styling:** add CSS for `.broken-item` in the report's existing style.
  - **Print:** in `reading.js`'s `beforeprint`, also open `details.broken-item:not([open])` and restore them after. If the standalone export has its own print handler, do the same there.

- [ ] **Step 4: Run `npm test`** and expect a PASS.

- [ ] **Step 5: Commit:** "Link check reports broken links and assets in three groups with where each is used".

### Task 6: End-to-end fixture

**Files:**
- Modify:
  - `test/e2e/site/index.html`;
  - `test/e2e/site/app.css`;
  - `test/e2e/server.mjs`, if a 404 route is needed;
  - `test/e2e/run.mjs:173-183`.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add to the fixture:**
  - a second `<a href="/missing-page">` in a footer or nav, so it is used twice;
  - in `app.css`, a rule with `background-image: url(/img/missing-bg.png)` on an element that is present and visible, so the browser requests it;
  - the server must 404 for that path. Check that the existing missing anchor `#nowhere` remains.

- [ ] **Step 2: Update the assertions in `run.mjs`:**
  - Replace `'Broken link: 404 /missing-page'` with:
    - `pc.links.data.broken.internal` has `/missing-page` with 2 sources, each with a `line`;
    - it has `/img/missing-bg.png` with kind `image` and a source whose `file` ends in `app.css`, with a line;
    - `pc.links.data.broken.page` has `#nowhere`.
  - `pc.links.supersedes` includes `network:asset-errors`.
  - The rendered report contains `details.broken-item`.

- [ ] **Step 3: Run `npm run test:e2e`.** Expect `all e2e checks passed`.

- [ ] **Step 4: Commit:** "e2e: broken image from CSS and a link used twice reach the grouped Link check".
