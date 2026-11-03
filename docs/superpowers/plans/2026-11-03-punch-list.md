# Punch List and Recheck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a QA-style Markdown punch list from any reading, with stable item IDs, and an `hargus recheck` command that records the page again headlessly and marks each item fixed / still there / verify after deploy / can't check, plus new items.

**Architecture:** Every finding-producing rule gets a stable `id` (and, where one rule fires several times per page, a stable `subject`). A pure core module turns a reading into punch items and Markdown and back, and merges an old list with a new reading. The extension adds one export; the existing `hargus` CLI gains `punchlist` and `recheck`, recording through a capture module extracted from `scripts/calibrate.mjs`.

**Tech Stack:** Plain ES modules (Chrome MV3 extension + Node ≥20), `node:test`, Playwright Chromium (already a dev dependency, loaded lazily) for recording.

**Spec:** `docs/superpowers/specs/2026-11-03-punch-list-design.md`

## Global Constraints

- Scores unchanged. `score-check` may differ from the old baseline **only** by added `id`/`subject` fields on findings; the baseline is rewritten once (Task 3) after `--ignore-ids` proves that.
- No new `manifest.json` permissions.
- Punch list Markdown contains no console message text (console findings: titles and line numbers only) and no response bodies.
- Included severities: `high`, `medium`, `low`. Info never appears. Section headings verbatim: `## High`, `## Medium`, `## When you have time`.
- Tags verbatim: `Page`, `Deploy`, `Timing`. Unsure → `Deploy`.
- Statuses verbatim in the Markdown: `fixed <YYYY-MM-DD>`, `still there`, `verify after deploy`, `can't check: <reason>`; section `## New since last check`.
- Item ID: `HG-` + 8 lowercase hex (FNV-1a 32-bit) of `plugin|rule|pathAndQuery|subject`. Never counts, timings, sizes, ratios, selectors or places.
- Local hosts: `localhost`, `127.0.0.1`, `[::1]`, names ending `.localhost` or `.test`, or `--local`.
- `hargus recheck` exit codes: 0 nothing still there and nothing new; 1 otherwise; 2 recording failed, interstitial, or missing/unreadable list block.
- Drawing in the extension only through the `html`/`h` helpers. Match surrounding code: small pure functions, one-line JSDoc above exports, no new dependencies.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. A page recorded twice unchanged yields identical IDs (runs = 1 and 3) — pinned in Task 3 (calibrate stability check) and Task 9 (e2e recheck of an unchanged page: 0 fixed, 0 new).
2. A local recheck never says "fixed" for a Deploy/Timing item or for a plugin that errored/was skipped — Task 6 tests.
3. Hand edits to the Markdown (ticked boxes, deleted items, edited prose) — Task 6 tests.
4. A recheck that lands on a login wall/bot check/failed load leaves the file untouched, exit 2 — Task 8 test.
5. Readings recorded before rule ids existed — Task 7: export disabled with "Record this page again to export a punch list".

---

### Task 1: Rule ids — audit tool and first plugin batch

**Files:**
- Modify: `scripts/score-check.mjs` (new `--ids` mode and `--ignore-ids` flag for `--compare`)
- Modify: `extension/plugins/{security,well-known,dns,whois,exposure,network,head-order,meta,tech,html,html-validate,css-validate}.js`
- Test: the plugin's existing `test/*.test.mjs` files; fixture baselines under `test/fixtures/*-findings-baseline.json` regenerate where they change

**Interfaces:**
- Produces: on every finding object, `id: string` — slug `[a-z0-9-]+`, unique per plugin, stable per rule (not per message wording); and `subject?: string` only where one rule emits several findings on one page (a host, header name, view name, file URL without query). Existing ids are kept.
- Produces: `node scripts/score-check.mjs <harDir> --ids` → prints `N findings without id` (non-info, after re-running plugins as `--compare` does) listing `plugin: title`, and `N collisions` listing plugin/id/subject groups that occur more than once in one reading; exits 1 if either is non-zero.
- Produces: `--compare <baseline> --ignore-ids` → compares with `id` and `subject` stripped from findings.

- [ ] **Step 1:** Add `--ids` and `--ignore-ids` to score-check. Run `node scripts/score-check.mjs test/e2e/out/calibrate --ids` — expect a large "without id" count (≈668 non-info at last count).
- [ ] **Step 2:** For each plugin in this batch, give every finding a rule id at the place it is created (extend each plugin's local `add` helper with an id parameter rather than deriving from the title). Add `subject` only where the audit shows collisions or the code emits one finding per host/header/file.
- [ ] **Step 3:** For each touched plugin with a unit test, add an assertion that every non-info finding in its existing cases has a non-empty `id`. Regenerate any `test/fixtures/*-findings-baseline.json` that changes, confirming by diff that only `id`/`subject` were added.
- [ ] **Step 4:** `npm test` passes; `--ids` shows none of this batch's plugins.
- [ ] **Step 5:** Commit "Rule ids: audit tool, security/infrastructure/build plugins".

### Task 2: Rule ids — second batch

**Files:**
- Modify: `extension/plugins/{content,links,images,language,international,carbon,css,javascript,console,vitals,layout,resilience}.js` and any plugin not in Tasks 1/3 that `--ids` still lists
- Test: as Task 1

**Interfaces:** same contract as Task 1. For `links`, `subject` is the link target's origin+path when one rule emits per link group; for `vitals`, the metric name.

- [ ] **Step 1:** Ids (and subjects where needed) in each plugin, same method as Task 1.
- [ ] **Step 2:** Test assertions and fixture baselines as Task 1 Step 3.
- [ ] **Step 3:** `npm test` passes; `--ids` lists none of these plugins.
- [ ] **Step 4:** Commit "Rule ids: content/international/performance plugins".

### Task 3: Rule ids — accessibility batch, baseline and stability

**Files:**
- Modify: `extension/plugins/{contrast,a11y-structure,a11y-views,a11y-basics}.js` and any remaining plugin `--ids` lists
- Modify: `test/e2e/out/score-baseline.json` (rewritten once)
- Test: as Task 1

**Interfaces:** same contract. Accessibility rule ids must match the keys used in `extension/core/a11y-reference.js` wherever a reference entry exists (Task 4 joins on them).

- [ ] **Step 1:** Ids/subjects for the accessibility plugins.
- [ ] **Step 2:** `node scripts/score-check.mjs test/e2e/out/calibrate --ids` → `0 findings without id`, `0 collisions`.
- [ ] **Step 3:** `node scripts/score-check.mjs test/e2e/out/calibrate --compare test/e2e/out/score-baseline.json --ignore-ids` → "no differences". Then `--write test/e2e/out/score-baseline.json`, then plain `--compare` → "no differences".
- [ ] **Step 4: Stability.** Record two fresh readings of 3 calibrate sites (`node scripts/calibrate.mjs --out <scratch>/a <3 urls>` then `/b`, and once more with `--runs 3`), and compare their sets of `(plugin, id, subject)` per site with a short throwaway script (not committed). Report in the task report every rule whose presence differs between a and b, and judge whether the page or the id is unstable; an unstable id gets fixed (drop the volatile part of its subject).
- [ ] **Step 5:** `npm test` passes. Commit "Rule ids: accessibility plugins; score baseline gains ids" — commit body states the baseline was rewritten after `--ignore-ids` showed no other difference.

### Task 4: Rule data — Expected text and tags

**Files:**
- Create: `extension/core/rules.js`
- Test: `test/rules.test.mjs`

**Interfaces:**
- Consumes: rule ids from Tasks 1–3; `extension/core/a11y-reference.js` lookups; plugin `area`.
- Produces: `ruleInfo(pluginId: string, ruleId: string, area?: string) → { tag: 'Page'|'Deploy'|'Timing', expected?: string, ref?: { label: string, url: string } }`.
- Produces: `RULES` — the data table `{ 'plugin/rule': { tag?, expected? } }`; `missingExpected(ruleKeys: string[]) → string[]`.

- [ ] **Step 1: Tests:**
  - `ruleInfo('security','missing-hsts')` (use the real id from Task 1) → `tag: 'Deploy'` and an `expected` mentioning `max-age`.
  - an accessibility contrast rule → `tag: 'Page'`, `expected` contains `4.5:1`, `ref.url` starts with `https://www.w3.org/WAI/WCAG22/Understanding/`.
  - a vitals rule → `tag: 'Timing'`.
  - unknown rule in area `accessibility` → `Page`; unknown rule in `performance`, `build`, `sustainability` or no area → `Deploy`.
  - every `expected` is one sentence (no newline, ends with `.`) and contains no code fence.
  - a non-failing test logs `missingExpected(<every plugin/id seen in the --ids run>)` as a count.
- [ ] **Step 2:** Run, see fail.
- [ ] **Step 3:** Implement. Area defaults: accessibility, content, international → Page; security, infrastructure → Deploy; performance, build, sustainability → rule by rule, default Deploy. Timing rules: vitals, load/blocking-time, slow-request rules in network, pagespeed. Accessibility `expected`/`ref` come from `a11y-reference.js` (its `fix` text, reworded in the table only where it describes code rather than outcome). Write outcome-shaped Expected lines for every non-a11y rule that reached high/medium/low on the calibrate readings; the rest may stay missing.
- [ ] **Step 4:** Tests pass; `npm test` passes.
- [ ] **Step 5:** Commit "Punch list: rule Expected text and Page/Deploy/Timing tags".

### Task 5: Punch items, IDs and Markdown out

**Files:**
- Create: `extension/core/punchlist.js`
- Test: `test/punchlist.test.mjs`

**Interfaces:**
- Consumes: `findings(reading)` (`core/harplus.js`), `ruleInfo` (Task 4), `placeLine`-style formatting (export a shared helper from `core/harplus.js` rather than copy it).
- Produces:
  - `itemId(plugin: string, rule: string, pathAndQuery: string, subject?: string) → string` (`HG-` + 8 hex FNV-1a).
  - `pathOf(url: string) → string` (path + query, no fragment; `/` for empty path).
  - `punchItems(reading) → Item[]` where `Item = { id, plugin, rule, subject?, severity, tag, title, detail?, places: string[], placesTotal: number, expected?, ref?, view? }`, high→medium→low, report order within, info excluded, console detail dropped. Same-ID duplicates suffixed `-2`, `-3` after sorting by subject then title.
  - `hasRuleIds(reading) → boolean` (false if any non-info active finding lacks `id`).
  - `punchMarkdown(reading, items, { statuses?, added?, checkedAt? }) → string` — header (title, URL, recorded date/device/throttle/runs, counts, recheck command line), sections, item layout as in the spec, and the block `<!-- hargus-punchlist {json} -->` as the last line: `{ v: 1, url, path, capturedAt, settings: { device, throttle, bypassCache, runs, coverage, views }, items: { [id]: { status, since? } } }`.

- [ ] **Step 1: Tests** (build readings with the existing test helpers in `test/helpers.mjs`):
  - same finding on `https://a.com/p?q=1` and `http://localhost:3000/p?q=1` → same `itemId`; different path → different.
  - a finding whose detail changes "5 elements" → "3 elements" keeps its ID.
  - info finding absent; low finding under `## When you have time`; order High, Medium, When you have time.
  - item text contains `**Where:**`, `**What's wrong:**`, `**Expected:**` (when rule has one), the tag word, the ID in backticks, `- [ ]`.
  - 14 places → 10 shown and `…and 4 more places`.
  - console finding with detail "secret token abc" → Markdown does not contain `secret`.
  - last line matches `/^<!-- hargus-punchlist \{.*\} -->$/` and its JSON lists every item id with status `open`.
  - `hasRuleIds` false for a reading with an id-less medium finding.
- [ ] **Step 2:** Run, see fail. **Step 3:** Implement. **Step 4:** Pass; `npm test` passes.
- [ ] **Step 5:** Commit "Punch list: items, stable IDs and Markdown".

### Task 6: Parse and recheck merge

**Files:**
- Modify: `extension/core/punchlist.js`
- Test: `test/punchlist.test.mjs`

**Interfaces:**
- Produces:
  - `parsePunchList(md: string) → { meta, visibleIds: Set<string> } | null` — `null` when the block is missing or its JSON is invalid. `visibleIds` = IDs still present in the visible items (backticked `HG-…`).
  - `isLocalUrl(url: string, force?: boolean) → boolean`.
  - `recheckList(list, reading, { url, local, now }) → { items: Item[], statuses: {[id]: Status}, added: Item[], summary: string, exitCode: 0|1 }` where Status ∈ `open|fixed|still|deploy|cantcheck` (+ reason for cantcheck).

- [ ] **Step 1: Tests:**
  - unchanged reading → every item `still`, `added` empty, exit 1 if any item, summary `N items: 0 fixed, N still there, 0 verify after deploy; 0 new`.
  - Page item gone → `fixed`, `since` = `now` date; Markdown shows `- [x]` and `fixed 2026-11-03`.
  - Deploy item gone on local URL → `deploy`, not fixed; same on `https://example.com` → `fixed`.
  - Timing item present on local URL → `deploy` (verify after deploy); a new Timing or Deploy finding on local URL is not in `added`.
  - item whose plugin has `status: 'error'` or is skipped in the new reading → `cantcheck` with the plugin's reason; never `fixed`.
  - new Page finding → in `added`, rendered under `## New since last check`; exit 1.
  - item whose visible entry was deleted from the Markdown → absent from output and from the new block.
  - item ticked `- [x]` by hand but still found → back to `- [ ]`, `still there`.
  - block missing / corrupted → `parsePunchList` returns `null`.
  - `isLocalUrl`: `http://localhost:8080/`, `http://127.0.0.1/`, `http://[::1]/`, `http://shop.localhost/`, `http://site.test/` true; `https://staging.example.com/` false; any URL with force true.
  - recheck of a `fixed` item that reappears → `still` and listed as such (not new).
  - an item with `view: 'translated-de'` when the new reading's capture shows that view skipped → `cantcheck` with reason naming the view.
- [ ] **Step 2:** Run, see fail. **Step 3:** Implement; `punchMarkdown` renders statuses and `added`. **Step 4:** Pass; `npm test`.
- [ ] **Step 5:** Commit "Punch list: parse and recheck statuses".

### Task 7: Export from the reading page, and Help

**Files:**
- Modify: `extension/ui/reading.html` (one export button), `extension/ui/reading.js` (handler), `extension/ui/help.js`
- Test: `test/report.test.mjs` (Help cap), `test/punchlist.test.mjs` if a new pure helper is added

**Interfaces:**
- Consumes: `punchItems`, `punchMarkdown`, `hasRuleIds` (Task 5).

- [ ] **Step 1:** Add `<button type="button" data-export="punchlist">Punch list for fixing (.md)</button>` after the Markdown brief entries. Handler downloads `${stem}.punchlist.md`. For a record-mode reading, the list covers the page currently shown (filter findings/target to that page; if that cannot be done cleanly, disable the button with a title "Punch lists cover one page; open a single-page reading" and say so in the report). When `hasRuleIds(reading)` is false, the button is disabled with `title="Record this page again to export a punch list"`.
- [ ] **Step 2:** Help: a short paragraph "Punch list" (≈60 words) saying it lists what's worth fixing (not info), each item has an ID, tags Page/Deploy/Timing, and `hargus recheck` re-checks it locally before deploy. Raise the Help word cap in `test/report.test.mjs` by the measured count; assert `/hargus recheck/`.
- [ ] **Step 3:** `npm test` passes.
- [ ] **Step 4:** Commit "Punch list: export from a reading; Help".

### Task 8: Recording module and `hargus punchlist` / `hargus recheck`

**Files:**
- Create: `cli/record.mjs`
- Modify: `scripts/calibrate.mjs` (use `cli/record.mjs`), `cli/harplus.mjs` (two subcommands, usage text)
- Test: `test/cli.test.mjs`, `test/calibrate.test.mjs` (stays green)

**Interfaces:**
- Produces: `openRecorder({ settings, headless = true }) → { record(url, { timeoutSec }) → Promise<Reading>, close() }` — launches Playwright Chromium with the unpacked extension, writes `settings.capture` (device, throttle, bypassCache, runs, coverage, views) plus `ui.openWhenDone: false` and history off into `chrome.storage.local`, and records like calibrate does today. Missing Playwright → throws `Error('Recording needs Playwright: npm install')`.
- Produces CLI:
  - `hargus punchlist <reading.har> [-o out.md]` — writes the punch list for a saved reading (default `<name>.punchlist.md`).
  - `hargus recheck <list.md> [--url <url>] [--out <file>] [--local] [--reading <file.har>] [--timeout S]` — `--reading` uses a saved reading instead of recording (for tests and for people who recorded by hand). Prints the summary line; rewrites the file (or `--out`); exit codes per Global Constraints. Interstitial (`detectInterstitial`) or record failure → exit 2, file untouched. Final path differing from the rechecked path → summary gains `(redirected to <path>)`.

- [ ] **Step 1: Tests** in `test/cli.test.mjs` (use `test/fixtures/local-site.har`):
  - `hargus punchlist local-site.har -o x.md` → file ends with the block; exit 0.
  - `hargus recheck x.md --reading local-site.har` → stdout matches `/0 fixed/`, exit 1 when items exist, exit 0 for a reading with no high/medium/low findings.
  - list with block removed → exit 2, stderr mentions exporting a fresh list, file unchanged.
  - `--reading` pointing at an interstitial reading (build one with the helper the interstitial tests use) → exit 2, file unchanged.
  - `parseArgs` cases: `--url` without value errors; `--timeout 0` errors.
- [ ] **Step 2:** Run, see fail. **Step 3:** Extract `cli/record.mjs` from calibrate (calibrate keeps its digest/output logic and its behaviour); add the subcommands. **Step 4:** `npm test` passes.
- [ ] **Step 5:** Commit "hargus punchlist and recheck; shared recorder".

### Task 9: End-to-end loop, screens and final checks

**Files:**
- Modify: `test/e2e/run.mjs`, `test/e2e/server.mjs` (a page variant whose problem can be switched off), `scripts/screens.mjs` (one shot: the export menu showing the new entry)

- [ ] **Step 1: e2e.** On the local test server page that has a contrast problem and a missing alt:
  - record it, click Export → Punch list, read the downloaded file: has `## High` or `## Medium`, an `HG-` id, and the block;
  - `node cli/harplus.mjs recheck <file> --url <same local url>` (records headlessly) → exit 1, `0 fixed`, `0 new`, and IDs equal to the exported ones;
  - switch the server variant so the image has alt, recheck again → that item `fixed`, exit code reflects remaining items;
  - a Deploy item (e.g. missing CSP on the local server) reads `verify after deploy`.
- [ ] **Step 2:** Screens: regenerate only the export-menu shot (or add `61-export-punchlist.png`); look at it.
- [ ] **Step 3:** Run one at a time: `npm test` → `npm run test:e2e` ("all e2e checks passed") → `node scripts/score-check.mjs test/e2e/out/calibrate --compare test/e2e/out/score-baseline.json` ("no differences").
- [ ] **Step 4:** Commit "Punch list: e2e loop and screen".
