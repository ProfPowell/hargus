# Writing plugins for HARgus

A plugin is a plain ES module that default-exports an object. The same module runs in the
extension (capture), the viewer (**Re-run analysis**) and the Node CLI, so a plugin must not touch
`chrome.*`, `window` or `document` except inside page-side functions (`collect`, `probe.collect`).

## The three phases

| Phase | Runs | Has | Typical use |
|---|---|---|---|
| `page` | during capture, while the page is live | `ctx.collected` — the return value of your `collect()` run in the page | DOM, globals, performance timeline |
| `analyze` | after capture, offline | the recording only | headers, cookies, URLs, timings, bodies |
| `enrich` | after `analyze` | `ctx.fetch`, `ctx.dns` | DNS, RDAP, IP data, third-party APIs, the site's own files |

Phases run in that order. Inside a phase, plugins run in parallel; use `after: ['other-id']` to wait
for another plugin in the same phase and then read its result from `ctx.results['other-id']`.
Results from earlier phases are always available in `ctx.results`.

`page` plugins cannot be re-run later (the page is gone). If an offline plugin needs a little live
data, give it a **probe** instead: `probe.collect` runs in the page during capture, its output is
stored in `_harplus.probes[id]`, and `run()` reads it as `ctx.probe` — now, on re-runs, and in the CLI.
The `tech` plugin works this way.

## Plugin object

```js
export default {
  id: 'my-plugin',                 // unique, kebab-case
  name: 'My plugin',               // shown in the UI
  version: '0.1.0',
  phase: 'analyze',                // 'page' | 'analyze' | 'enrich'
  group: 'build',                  // readout section: build | quality | security | infrastructure | other
  area: 'performance',             // optional: performance | accessibility | security | build | infrastructure | international | sustainability
                                   //   (default from group: quality → performance, other → build)
  description: 'One line for Options and the CLI.',
  disclosure: 'Sends X to Y.',     // REQUIRED if data leaves the machine; shown with ↗ in the UI
  tags: ['security'],
  defaultEnabled: true,            // false = user opts in
  after: [],                       // same-phase dependencies
  timeoutMs: 20000,                // default 20 s
  options: [                       // rendered in Options; values arrive in ctx.options
    { key: 'limit', label: 'Max items', type: 'number', default: 10 },
    // types: text | number | checkbox | select (with choices: [...])
  ],

  // page phase only
  world: 'isolated',               // 'isolated' = DOM only (default) · 'main' = page JS globals too
  collect(options) { /* runs IN the page; self-contained; return JSON */ },
  collectArgs(ctx) { return {}; }, // optional: argument for collect (defaults to ctx.options)
  inject: [],                      // optional: script URLs evaluated before collect (see axe.js)

  // any phase except page
  probe: { world: 'main', collect(args) { /* in the page */ }, args: {} },  // args may be async (ctx) => ({…})

  run(reading, ctx) {              // may be async
    return { data: {}, summary: [], findings: [] };
  },
  render(result, h) {              // optional: HTML for the viewer (see helpers below)
    return h.kv(Object.entries(result.data));
  },
  glance(result, h, { results, target }) {  // optional: charts at the top of the area page (not for remote plugins)
    return h.stat({ label: 'Thing', value: result.data.n, rating: 'good' });
  },
};
```

`collect` and `probe.collect` are serialized with `Function.prototype.toString()` and evaluated in
the page, so they **cannot use imports or outer variables**. Pass what they need through arguments.

## `ctx`

| Member | Meaning |
|---|---|
| `ctx.har` | the reading (same as `reading`) |
| `ctx.target` | `{ url, finalUrl, host, origin, domain, site, title }` |
| `ctx.options` | this plugin's options merged over defaults |
| `ctx.keys` | API keys from Options (`ipinfo`, `abuseipdb`, `virustotal`, `greynoise`) |
| `ctx.results` | results of plugins that already ran |
| `ctx.collected` | page phase: `collect()` output |
| `ctx.probe` | `probe.collect()` output, if captured |
| `ctx.fetch(url, init)` | `fetch` with the plugin's timeout signal, no cookies, and host tracking |
| `ctx.fetchJSON(url, init)` | `fetch` + status check + JSON; throws `HttpError` (with `.status`) |
| `ctx.dns(name, type)` | DNS-over-HTTPS lookup, cached across plugins for the run → `{ status, ad, answers: [{ name, type, ttl, data }] }` |
| `ctx.whois(domain)` | port-43 WHOIS (Node CLI only; undefined in the browser) → `{ text, server }` |
| `ctx.progress(text)` | shows running text on the reading tab's checklist, for example "Checking links 42/120"; a no-op in the CLI unless the CLI's `onProgress` prints it |
| `ctx.skip(reason)` | stop with status `skipped` (not an error) |
| `ctx.util` | helpers from `core/har-util.js`: `mainEntry`, `redirectChain`, `serverIPs`, `header`, `resHeader`, `registrableDomain`, `isThirdParty`, `isIP`, `isPrivateIP`, `formatBytes`… |

Throwing marks the result `error` with the message. Findings with an unknown severity become `info`.

## Summary items, ratings and headlines

`summary` items may carry `rating: 'good' | 'needs-improvement' | 'poor'` (also accepts
"needs improvement") and `headline: true`. Rated items become stat tiles on the area page when a
plugin has no `glance`; up to three `headline` items per area appear on the Overview area cards.
Text exports show a rating as "value (needs improvement)".

## Findings

A finding is `{ severity, category, title }` plus optional fields: `severity` is `high | medium | low | info`, and `category` picks the area it counts toward (see [Scores](#scores)).

A finding that affects a number of elements may also say how many:

```js
{ severity: 'high', category: 'accessibility', title: '65 links have no name', count: 65, of: 819, unit: 'links' }
```

- `count`: how many elements, or occurrences, the finding affects. Leave it out for page-level findings.
- `of`: the population `count` is out of. Set it only when the plugin already knows that total.
- `unit`: a plural noun for the report, as in "65 of 819 links (7.9%)".

`count` and `of` must be positive integers; anything else (a string such as `'65'`, 0, a negative, NaN, a fraction) is ignored, as if the field were missing. If `of` is less than `count`, it is raised to `count`. A `count` with no valid `of` is shown but adds no extent. Never parse counts out of the title.

## Chart helpers

`glance()` and `render()` receive `h`, which includes the chart kit. All helpers return escaped markup.

| Helper | Use |
|---|---|
| `h.ring({ value, max, size, status, label })` | score ring; `status`: good, warning, serious, critical, none |
| `h.donut({ segments: [{ label, value, display }], center: { value, unit }, label })` | part of a whole (≤ 6 segments, rest folded into Other) |
| `h.stackBar({ segments, label, legend })` | one 100 % bar with a legend |
| `h.hbars({ rows: [{ label, value, display, color }], label })` | ranked bars |
| `h.meter({ value, good, poor, format, label })` | good / needs-improvement / poor bands with a marker |
| `h.stat({ label, value, rating, note, meter })` | stat tile |
| `h.checklist([{ label, ok, note }])` | ✓ / ✗ list |
| `h.flow([{ title, sub }])` | node → node diagram |
| `h.timeline({ start, end, startLabel, endLabel, label })` | span with a "today" pin |
| `h.spark(values, { label })`, `h.legend(items)`, `h.icon(name)`, `h.badges(techs)`, `h.rate(v, good, poor)` | small pieces |

Colours: pass `color: 'var(--c1)'` … `'var(--c8)'`, `'var(--c-other)'` or a `#hex` colour; anything else falls back to the neutral colour.

## Scores

Each area starts at 100 and loses points per finding: high 15, medium 6, low 2, info 0. The loss per severity is capped at 55, 30 and 15, which add up to 100 so an area reaches 0 only when all three caps are hit (info loses nothing). Axe rules tagged only `best-practice` count as low whatever their impact.

**Accessibility** (the areas in `EXTENT_AREAS`) also counts how much of the page each finding affects. Its Findings score has two parts:

- **Breadth**, 60% of the loss above (`BREADTH_SHARE = 0.6`), so at most 60 points.
- **Extent**, up to 40 points (`EXTENT_MAX`) for the share of elements affected. Each non-info finding with a valid `count` n and `of` N has `share = n / (max(N, n) + 10)` (`EXTENT_SMOOTH`, so 1 of 1 counts as 1/11, not 100%). It is weighted by severity (`EXTENT_WEIGHT`: high 1, medium 0.5, low 0.1, info 0) and summed. A weighted sum of 0.25 (`EXTENT_FULL`) or more deducts the full 40.

```
breadth        = 0.6 × Σ min(CAP[s], DEDUCT[s] × findings of severity s)
extent         = 40 × min(1, Σ EXTENT_WEIGHT[severity] × share / 0.25)
findings score = clamp(round(100 − breadth − extent), 0, 100)
```

Findings without `count` and `of` (for example in saved readings) score by breadth only. Other areas keep the plain formula; their counts are stored with the finding but don't change their score, and the scoring table doesn't show them yet.

Findings count toward the area of their `category`:

| Area | Categories |
|---|---|
| performance | performance |
| accessibility | accessibility |
| security | security, privacy |
| content | content, seo |
| build | quality |
| infrastructure | infrastructure, intel |
| international | international |
| sustainability | sustainability |

Findings with any other category count toward the area of the plugin that reported them.

The link check treats 401, 403 and 429 responses as "refused", an info finding, not as broken links.

Some areas also have a metric:
- Performance: Lighthouse performance (PageSpeed), or the Web Vitals ratings;
- Accessibility: Lighthouse accessibility;
- Sustainability: carbon per visit.

When an area has a metric, its score is `(2 × the lower + the higher) / 3`, so the worse input dominates.

Carbon is scored on a log scale of grams per visit:

| g per visit | score |
|---|---|
| 0.040 | 100 |
| 0.079 | 90 |
| 0.145 | 80 |
| 0.209 | 70 |
| 0.278 | 60 |
| 0.359 | 50 |
| 1.795 | 0 |

The overall score is the weighted mean of the measured areas, using the active **scoring profile**. Critical areas are marked ✱:

| Profile | Perf | A11y | Sec | Content | Build | Infra | Intl | Sustain |
|---|---|---|---|---|---|---|---|---|
| General | 18 | 18 | 18 | 12 | 10 | 9 | 8 | 7 |
| Brochure / content site | 18 | 20 | 8 | 22✱ | 10 | 6 | 8 | 8 |
| Commerce | 22✱ | 16 | 22✱ | 12 | 8 | 8 | 7 | 5 |
| Web app | 20 | 18 | 22✱ | 6 | 16 | 8 | 6 | 4 |
| Public sector / education | 14 | 24✱ | 10 | 14 | 6 | 6 | 14✱ | 12 |
| Custom | your numbers | | | | | | | |

If a measured critical area scores below 60, the overall score is capped at 69 (a D), and the report says why.

Grades: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, else F.

## Render helpers (`h`)

`render()` returns HTML built with `h.html` — a tagged template that **escapes every value** unless
it came from another helper. Plugin data comes from web pages and remote services; never build
HTML by string concatenation.

`h.html\`…\``, `h.kv(pairs)`, `h.table(rows, columns)`, `h.list(items)`, `h.tags(items)`,
`h.sub(title, content)`, `h.link(url, text)`, `h.json(value)`, `h.bytes(n)`, `h.ms(n)`,
`h.check(bool)`, `h.sev(severity)`, `h.rating('good' | 'needs improvement' | 'poor')`,
`h.outline(headings)`. Empty values are skipped, so you can pass optional fields freely.
Without `render()`, the viewer shows `data` with a generic renderer.

## Large reference data

Plugins that need big datasets (the fingerprint database, web-features) download them at runtime
with `cachedJSON(ctx.fetch, url)` from `plugins/kb/reference.js` — cached for a week in Cache
Storage (extension) or memory (CLI). Data is not code, so this is fine under Manifest V3, and it
keeps differently-licensed data out of the repository. `plugins/kb/fingerprints.js` is a complete
example, including deriving probe arguments from the downloaded data.

## Register it

Add the import and the object to `BUILTIN` in `extension/plugins/index.js`, then reload the
extension. It appears in the popup, Options, the CLI (`hargus plugins`) and every new reading.

## Example: an offline plugin

```js
// extension/plugins/cookie-census.js — counts third-party cookies set during the reading.
import { hostOf } from '../core/har-util.js';

export default {
  id: 'cookie-census',
  name: 'Cookie census',
  version: '0.1.0',
  phase: 'analyze',
  description: 'Counts cookies set by third-party responses.',
  run(reading, ctx) {
    const third = new Map();
    for (const e of reading.log.entries) {
      const host = hostOf(e.request.url);
      if (!ctx.util.isThirdParty(host, ctx.target.site)) continue;
      for (const c of e.response.cookies || []) third.set(`${host} ${c.name}`, { host, name: c.name });
    }
    const rows = [...third.values()];
    return {
      data: { cookies: rows },
      summary: [{ label: 'Third-party cookies', value: rows.length }],
      findings: rows.length > 20
        ? [{ severity: 'low', category: 'privacy', title: `${rows.length} third-party cookies set on first load` }]
        : [],
    };
  },
  render: (r, h) => h.table(r.data.cookies, ['host', 'name']),
};
```

## Example: a lookup

```js
// Uses ctx.dns, so it shares the DoH cache with the DNS plugin.
export default {
  id: 'mx-check',
  name: 'MX check',
  version: '0.1.0',
  phase: 'enrich',
  disclosure: 'Sends the domain to your DoH resolver.',
  async run(reading, ctx) {
    const r = await ctx.dns(ctx.target.domain, 'MX');
    if (r.status === 'ERROR') throw new Error(r.error);
    const mx = r.answers.filter((a) => a.type === 'MX').map((a) => a.data);
    return { data: { mx }, summary: [{ label: 'MX', value: mx.join(', ') || 'none' }] };
  },
};
```

## Remote plugins

When a check needs another runtime (Lighthouse, a Java validator, Python, a paid API, an internal
service), run it as an HTTP endpoint and add it under **Options → Remote plugins**. No rebuild.

Request — `POST <url>` with `content-type: application/json` (and `authorization: Bearer <token>` if set):

```jsonc
{
  "harplus": "0.1",
  "plugin": "remote:lighthouse",
  "target": { "url": "…", "finalUrl": "…", "host": "…", "domain": "…", "site": "…", "title": "…" },
  "capturedAt": "2026-10-08T16:40:00.000Z",
  "readout": [ { "id": "dns", "name": "DNS", "summary": [ { "label": "…", "value": "…" } ] } ],
  "reading": { /* only when Send = reading or reading-lite; screenshots removed */ }
}
```

Response — `200` with `{ "summary": [...], "findings": [...], "data": {...} }` (all optional).
Any non-2xx response is recorded as an error. Remote results are untrusted and rendered with the
generic, escaping renderer. See `examples/remote-lighthouse/server.mjs`.

## Testing

`test/helpers.mjs` has `mockFetch(routes)` for exercising enrich plugins without the network and
`feedNavigation(recorder)` for synthetic traffic. See `test/plugins.test.mjs`.

```js
await runPlugins(reading, [myPlugin], { phases: ['enrich'], fetch: mockFetch([[/example/, { body: {…} }]]) });
```
