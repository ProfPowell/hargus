# Writing plugins

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
| `ctx.skip(reason)` | stop with status `skipped` (not an error) |
| `ctx.util` | helpers from `core/har-util.js`: `mainEntry`, `redirectChain`, `serverIPs`, `header`, `resHeader`, `registrableDomain`, `isThirdParty`, `isIP`, `isPrivateIP`, `formatBytes`… |

Throwing marks the result `error` with the message. Findings with an unknown severity become `info`.

## Summary items, ratings and headlines

`summary` items may carry `rating: 'good' | 'needs-improvement' | 'poor'` (also accepts
"needs improvement") and `headline: true`. Rated items become stat tiles on the area page when a
plugin has no `glance`; up to three `headline` items per area appear on the Overview area cards.
Text exports show a rating as "value (needs improvement)".

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

Each area starts at 100 and loses points per finding (high 15, medium 6, low 2, info 0; capped at
60 / 30 / 15 per severity). Findings count toward the area of their `category`
(performance, accessibility, security + privacy, build ← quality + seo, infrastructure ← infrastructure + intel,
international, sustainability).
Findings with any other category count toward the area of the plugin that reported them.
Findings without a category are stored as `quality` and count toward Build & content.
Performance is averaged 50/50 with Lighthouse performance (PageSpeed) or the Web Vitals ratings;
Accessibility with Lighthouse accessibility when available. The overall score weights
Performance 20, Accessibility 20, Security 20, Build & content 15, Infrastructure 10, International 8, Sustainability 7
over the areas that were measured. Sustainability is averaged 50/50 with the carbon rating (A+ 100 … F 25).
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
extension. It appears in the popup, Options, the CLI (`harplus plugins`) and every new reading.

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
