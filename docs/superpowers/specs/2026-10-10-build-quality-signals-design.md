# Build and quality signals: design

**Status:** approved in conversation on 2026-10-10 as batch 3 of the Polypane gap work. This spec is waiting for review.

## Goal

Surface six build-quality signals that HAR-PLUS misses today:
1. console errors, exceptions, CSP violations and browser Issues during load;
2. the elements that cause sideways overflow, and `100vw` use;
3. `<head>` element order, using the Capo.js weights;
4. layouts that break just either side of the site's busiest CSS breakpoints;
5. which elements caused the layout shift;
6. PageSpeed defaulting to the reading's own device.

## 1. Console and Issues recording

**Capture** (`extension/browser/capture.js`):
- After `Page.enable` and `Network.enable`, enable the CDP `Runtime`, `Log` and `Audits` domains on the main session, each with `.catch(() => {})`.
- Recording runs from capture start until `captureViews` begins, while `this.viewsRunning` is false. Events after that are ignored.

| Event | Recorded as |
|---|---|
| `Runtime.exceptionThrown` | `{ kind: 'exception', text, url, line }` from `exceptionDetails`. The text is `exception.description` up to its first newline, or `text`. |
| `Runtime.consoleAPICalled` with type `error` | `{ kind: 'console-error', text }` |
| `Runtime.consoleAPICalled` with type `warning` | `{ kind: 'console-warn', text }` |
| | Both take `text` from the args (each value, description or type, joined by spaces), plus `url` and `line` from the first stack frame. |
| `Log.entryAdded` with level `error` or `warning` | `{ kind: 'log', source: entry.source, level, text, url }` |
| `Audits.issueAdded` | `{ kind: 'issue', code: issue.code, text }`. `text` is a short description built from the issue's `details`, for example the CSP violated directive and blocked URL, or the mixed-content URL. |

**Storage:**
- Store the entries in `hp.capture.console = { entries: [...], dropped: n }`. Entries are deduplicated by `kind` + `text` + `url` + `line`, each with a `count`. The cap is 100 distinct entries; anything beyond that counts in `dropped`.
- Each `text` is capped at 300 characters.

**Redaction**, applied before storing, by the pure function `redact(text)` in `extension/core/console.js`:
- URLs with a query string keep the scheme, host and path, and the query becomes `?…`;
- any run of 24 or more characters from `[A-Za-z0-9_\-+/=]` becomes `…`.

**Sharing:** `stripForSharing` gains `console: 'counts'` as the default for exports.
- It replaces each entry's `text` with `''` and keeps `kind`, `code`, `source`, `url` (already without its query), `line` and `count`.
- It removes the `detail` of findings from the `console` plugin result.
- The test fixture export also strips this way.

**Plugin `console`** (new, analyze phase):
- `area: 'build'`, `group: 'build'`. It reads `hp.capture.console`.
- With no `console` data, it skips with "no console recording in this reading — take a new reading".

| Condition | Severity | Category | Title |
|---|---|---|---|
| exceptions ≥ 1 | medium | quality | `<n> uncaught JavaScript errors` (detail: top 3 texts with `url:line`) |
| console-error ≥ 1 | low | quality | `<n> console errors` |
| issues with code `ContentSecurityPolicyIssue`, or log entries with source `security` that mention "Content Security Policy" | medium | security | `<n> Content-Security-Policy violations` |
| issues with code `MixedContentIssue` | medium | security | `<n> mixed-content requests blocked or upgraded` |
| issues with code `DeprecationIssue`, or log entries with source `deprecation` | info | quality | `<n> deprecated features used` |
| issues whose code starts with `Cookie` | low | quality | `<n> cookie issues reported by the browser` |
| log entries with source `network` and level `error` | info | quality | `<n> failed requests logged by the browser` |

- **Counting:** each `<n>` sums the entries' `count`.
- **Summary:** "Console": `<exceptions> exceptions · <errors> errors · <warnings> warnings · <issues> issues`, rated good / needs-improvement / poor, at 0 / no exceptions / ≥ 1 exception.
- **Render:** a table of entries showing kind, text (or "—" if stripped), location and count.

## 2. Overflow culprits and `100vw`

**`measureView()`** gains `overflowers`: up to 5 entries of `{ selector, width, over }`.
- **Candidates:** elements whose `getBoundingClientRect().right > innerWidth + 1`, while the document's `scrollWidth > innerWidth`.
- **Innermost only:** an element is dropped if one of its descendants is also a candidate. Find this by walking the candidates and dropping any that `contains()` another.
- **Limits:** the walk stays within the existing 3000-element / 1500 ms budget.
- **Order:** by `over` (right − innerWidth), largest first.
- `selector` is a short CSS path, built as elsewhere.

**Report and plugins:**
- The reflow finding in `a11y-views` and the "scrolls sideways" chips name the first culprit, for example "`.promo` is 364 px wide in a 320 px view". Its detail lists all of them.
- The breakpoint findings (section 4) name their culprits too.

**`100vw`:**
- The `css` plugin's declaration walk counts `width` and `min-width` values containing `100vw` (`vwRules`).
- **Finding:** the `layout` plugin (section 4) raises it, because the `css` plugin can't see `capture.views`. When `vwRules ≥ 1` and the base view's document is taller than its viewport (`cssHeight` > the base viewport height), it raises a low, category `quality` finding: `<n> rules use width: 100vw (adds horizontal scroll when a vertical scrollbar is present)`.

## 3. `<head>` order (`head-order` plugin)

- **Plugin:** new, analyze phase, `area: 'performance'`, `group: 'build'`, `after: ['css']`.
- **Source:** the main document's recorded HTML (`mainEntry(reading).response.content.text`, base64-decoded if `encoding === 'base64'`). Without it, the plugin skips with "no document HTML in this reading".
- **Parsing** is done by the pure `parseHead(html)`: a tolerant tag scanner over the text up to `</head>`, or the first `<body`. It recognises:
  - `meta`, `title`, `base`, `link`, `script`, `style` and `noscript`;
  - the attributes `charset`, `http-equiv`, `name`, `rel`, `as`, `async`, `defer`, `type`, `src`, `href` and `media`;
  - for `style`, whether the content contains `@import`.

  Comments and `<template>` are skipped.
- **Weights** (Capo.js):

  | Weight | Elements |
  |---|---|
  | 10 | `meta[charset]`, `meta[http-equiv]` (content-security-policy, origin-trial…), `meta[name=viewport]`, `base` |
  | 9 | `title` |
  | 8 | `link[rel=preconnect]` |
  | 7 | `script[async]` (and `type=module` with `async`) |
  | 6 | `style` containing `@import` |
  | 5 | blocking `script`: src, not async/defer, not `type=module`, not JSON or ld+json |
  | 4 | blocking stylesheet: `link[rel=stylesheet]` without `media=print`, plus `style` |
  | 3 | `link[rel=preload]` and `link[rel=modulepreload]` |
  | 2 | `script[defer]`, and module scripts without `async` |
  | 1 | `link[rel=prefetch|dns-prefetch|prerender]` |
  | 0 | everything else: other meta, icons, JSON-LD, `noscript` |

**Findings:**

| Condition | Severity | Category | Title |
|---|---|---|---|
| elements whose weight is greater than an earlier element's weight (the count of such inversions, at most one per element) ≥ 1 | low | performance | `<n> <head> elements out of optimal order` (detail: the first 3, e.g. "preconnect after a blocking script") |
| `<meta charset>` begins after byte 1024 of the document, or is missing | low | performance | `<meta charset> is not in the first 1024 bytes` |
| a weight-5 script appears before any weight-4 stylesheet | low | performance | `A blocking script delays the CSS` |

- **Glance:** a vertical bar list. Each row is one head element: a short label such as `meta charset` or `link stylesheet app.css`, and a bar whose width is its weight. Rows that are out of order are marked.
- **Render:** a table showing order, element, weight and an out-of-order flag.

## 4. Breakpoint-edge views

**Picking the breakpoints:**
- After the page-phase plugins, capture reads `hp.plugins.css.data.media`, an array of `[query, count]`, if the `css` result is ok.
- It extracts every px value from `min-width`/`max-width`, or from range syntax (`width >= 768px`). An `em`/`rem` value counts as 16 px per unit.
- It totals the rule counts per value, keeps values between 320 and 1920, and takes the top 2 by count, ties going to the larger value.
- If none are found, there are no breakpoint views.

**Views:**
- For each breakpoint `b`, capture two views: `bp<b>-below` at `b − 1` px and `bp<b>-at` at `b` px. Both use `setDeviceMetricsOverride({ width, height: base height, deviceScaleFactor: 1, mobile: false })` and are restored with `applyDevice(base)`.
- Each takes a viewport shot only (`fullPage: false`) and runs `measureView()`.
- They run after the accessibility views and before `nojs`, with `runMs` 30 000 and `restoreMs` 10 000.
- **Ids:** `bp<b>-below` and `bp<b>-at`, for example `bp768-below`. They are dynamic, so `views.js` gains `BREAKPOINT_VIEW = /^bp(\d+)-(below|at)$/`, and `shotView` accepts ids matching it.
- **Labels:** `<b-1> px` / `<b> px`.

**Settings:**
- `DEFAULTS.capture.views.breakpoints: true`, with an Options and popup chip "Breakpoint edges".
- `hp.capture.breakpoints = [b1, b2]` records which were used.

**Plugin `layout`** (new, analyze phase, `area: 'build'`, `group: 'build'`, `after: ['css']`):
- It computes the breakpoint findings with a pure helper, `breakpointFindings(views, breakpoints, base)`, in `extension/core/views.js`.
- It also raises the `100vw` finding (section 2).
- It skips when there are neither breakpoint views nor a `css` result.

| Condition, per edge view `v` | Severity | Category | Title |
|---|---|---|---|
| `v.overflowX > 0` and both the other edge view of the same breakpoint and the base view have `overflowX === 0` | medium | quality | `Layout breaks at <w> px (just <below\|at> the <b> px breakpoint)` (detail: culprits) |
| `v.clipped − max(other.clipped, base.clipped) ≥ 3` | low | quality | `Text clips at <w> px near the <b> px breakpoint` |

- **Glance:** a checklist per breakpoint (`767 / 768 px: fits`).
- **Screens pane:** a "Breakpoints" section with the edge shots in pairs, using the existing `foldImage` and chips that show overflow and culprits.

## 5. Layout-shift culprits

- **Collect:** the `vitals` plugin's `collect()` records, for the shifts in the largest session window, the sources of the 3 shifts with the highest value: `{ value, sources: [{ node, previous: {x,y,w,h}, current: {x,y,w,h} }] }` (up to 3 sources each). `node` is described the way `describe()` describes the LCP element.
- **Data:** stored as `cls.sources` beside the existing `cls` number. The result's `cls` stays a number for compatibility, and the sources go in `data.clsSources`.
- **Finding:** the CLS finding (existing) gains the detail `Shifted: <node1>, <node2>, <node3>`.
- **Render:** a "Layout shifts" table with value, element and before → after rect.

## 6. PageSpeed strategy

- The `pagespeed` option `strategy` gains `auto`, which becomes the default.
- With `auto`, the plugin requests `mobile` when `baseView(reading) === 'mobile'` and `desktop` otherwise.
- `data.strategy` records the strategy actually used, and the choices are `auto`, `mobile` and `desktop`.
- Existing settings that set `mobile` or `desktop` explicitly keep working.

## Testing

**Unit tests:**
- `redact()`: query strings, long tokens and short text untouched.
- `console` `run()`: every finding at its threshold; counts sum `count`; skip without data; stripped entries render "—".
- `stripForSharing` with `console: 'counts'`.
- `parseHead()` on fixture HTML:
  - weights;
  - inversions;
  - charset beyond 1024 bytes;
  - a blocking script before the CSS;
  - comments and templates ignored;
  - JSON-LD weighted 0.
- `head-order` `run()` findings, plus the skip without HTML.
- Breakpoint extraction from `css` media `[query, count]` lists: px, em, range syntax, the top-2 tie-break and the 320–1920 clamp. This is a pure helper `pickBreakpoints(media)` in `views.js`.
- `breakpointFindings()` thresholds; `shotView` with `bp768-below`.
- `layout` plugin: the `100vw` finding.
- `vitals` `run()` CLS detail with sources.
- `pagespeed` strategy `auto` for mobile and desktop readings.

**E2E.** The test site gains:
- a `console.error('e2e error')` and a thrown error in a `setTimeout` from `main.js` or an inline script;
- a `<meta http-equiv="Content-Security-Policy" content="img-src 'self'">`, plus an image from another origin that it blocks;
- the rule `@media (max-width: 899px) { .edge { min-width: 920px } }`, plus a `<div class="edge">` in `<main>`. The 899 px view overflows and the 900 px view doesn't. Two more `@media (max-width: 899px)` rules make 900 the busiest breakpoint;
- a `preconnect` placed after a blocking script in `<head>`.

The e2e asserts:
- the `console` findings for exceptions, console errors and CSP;
- the `head-order` out-of-order finding;
- `hp.capture.breakpoints` includes 900;
- a "Layout breaks at 899 px" finding naming `.edge`;
- the Screens "Breakpoints" section;
- the `pagespeed` strategy `auto` resolves to desktop. Network lookups to Google can't run in the e2e, so assert this through a unit test only; the e2e keeps pagespeed off.

## Out of scope

- INP attribution, which needs interaction.
- `console.log` and info messages.
- Every-breakpoint sweeps.
- Source-map resolution of error locations.
