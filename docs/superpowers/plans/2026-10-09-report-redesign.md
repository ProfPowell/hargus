# Reading Report Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the reading page into a professional, scored, chart-rich dashboard (sidebar layout B) that also prints cleanly and exports as a standalone HTML report, from the extension and the CLI.

**Architecture:** A pure scoring module (`core/score.js`) maps findings and metrics to five areas. A pure chart kit (`ui/charts.js`) produces escaped inline SVG/HTML and is exposed to plugins on `h`. Plugins gain an optional `glance()` for area-page charts. One pure function, `renderReport()` in `ui/report.js`, produces the whole report; `reading.js` adds interactivity on top. The standalone export and CLI `--report` wrap the same markup with `theme.css` inlined.

**Tech Stack:** Vanilla ES modules, no build step, no dependencies. Node 20+ `node:test` for unit tests. Playwright (globally installed) for the e2e run.

**Spec:** `docs/superpowers/specs/2026-10-09-report-redesign-design.md` (read it first). Mockups: `.superpowers/brainstorm/*/content/area-pane.html` and `overview-areas.html` (gitignored, local only).

## Global Constraints

- No build step and no runtime dependencies in `extension/` or `cli/`.
- Chart helpers and `renderReport` must not touch `document`/`window`/`chrome.*` (they run in Node for the CLI).
- Every interpolated value goes through the escaping `html` tag; only our own constant SVG strings may use `raw()`.
- Existing plugins, remote plugins and stored readings must keep working unchanged.
- Areas, in order: `performance` "Performance" (weight 25), `accessibility` "Accessibility" (25), `security` "Security" (25), `build` "Build & content" (15), `infrastructure` "Infrastructure" (10).
- Deductions: high 15, medium 6, low 2, info 0; caps per severity: high 60, medium 30, low 15.
- Grades: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F < 60; `+` at band low+7 and above, `−` (U+2212) at band low+2 and below; no `+`/`−` on F.
- Status: ≥ 85 `good`, 70–84 `warning`, 50–69 `serious`, < 50 `critical`, null `none`. Verdicts: good / needs work / poor / failing / not measured.
- Ring labels: number only inside; text width ≤ 80 % of the inner diameter.
- Categorical colours: light `#2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4,#008300,#6250d6,#e34948`; dark `#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767` (validated on `#ffffff` / `#121b1f`; light slots 3–5 are under 3:1, so legends must always show values as text). Status: good `#0ca30c`, warning `#fab219`, serious `#ec835a`, critical `#d03b3b`.
- Commit after every task with a message ending in the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Readings saved before this change** (plugin results have no `area`, summaries have no `rating`): the report must still put every plugin in the right area using the plugin list, and show no `undefined`. Pinned in Task 10 (`old reading without area renders`).
2. **Plugins that errored, were skipped or returned `data: null`**: `glance` must never be called for them and the area still renders. Pinned in Task 10 (`error and skipped results do not call glance`).
3. **A plugin `glance()` that throws** (e.g. a site with unusual data): only that chart is replaced by an error note. Pinned in Task 10 (`throwing glance is contained`).
4. **Hostile page content** (title, finding titles, technology names containing `<script>` or quotes): escaped everywhere, including the standalone document `<title>`. Pinned in Task 10 (`page strings are escaped`) and Task 12.
5. **Empty reading** (0 entries, no plugin results): every ring shows "—"/not measured, no `NaN`/`Infinity`, no crash in spark/max computations. Pinned in Task 10 (`empty reading renders`).

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `extension/ui/html.js` | create | escaping `html` tag, `raw`, `esc`, `isRaw` (moved out of render.js so charts can import without a cycle) |
| `extension/core/score.js` | create | areas, plugin/finding → area mapping, scoring, grades, status, narrative, top findings |
| `extension/ui/charts.js` | create | chart kit (ring, donut, stackBar, hbars, meter, stat, spark, legend, checklist, flow, timeline, icon, badges) |
| `extension/ui/report.js` | create | `renderReport`, `findingsTable`, `networkTable`, `standaloneDocument`, `timeBuckets` |
| `extension/ui/render.js` | modify | re-export html.js, merge charts into `h`, add `renderGlance` |
| `extension/core/plugin-host.js` | modify | keep `rating`/`headline` in summaries; stamp `area` on results |
| `extension/core/harplus.js` | modify | `summaryValue`, score in `indexRecord`, markdown shows ratings |
| `extension/plugins/*.js` | modify | `area` fields, `glance()`, rated/headline summary items |
| `extension/ui/theme.css` | modify | chart tokens, chart CSS, report layout, print CSS |
| `extension/ui/reading.html`, `reading.js` | modify | sidebar layout, hydrate report, exports, print |
| `extension/ui/library.js` | modify | overall ring on cards |
| `cli/harplus.mjs` | modify | `--report <file>` on `analyze` and `summary`; ratings in readout |
| `docs/PLUGINS.md`, `README.md` | modify | document area, glance, rating, headline, chart helpers, scoring, exports |
| `test/score.test.mjs`, `test/charts.test.mjs`, `test/glance.test.mjs`, `test/report.test.mjs` | create | unit tests |
| `test/cli.test.mjs`, `test/e2e/run.mjs` | modify | CLI report test; e2e viewer checks |

Run all unit tests with `npm test` from the repo root.

---

### Task 1: Split the HTML tag into `ui/html.js` and add chart colour tokens

**Files:**
- Create: `extension/ui/html.js`
- Modify: `extension/ui/render.js:1-27`
- Modify: `extension/ui/theme.css` (`@layer tokens` block, lines 12–37)
- Test: `test/charts.test.mjs` (created here, extended in Tasks 3–5)

**Interfaces:**
- Produces: `extension/ui/html.js` exports `esc(v) → string`, `raw(s) → Raw`, `isRaw(v) → boolean`, `html(strings, ...values) → Raw`. `render.js` re-exports all four, so existing imports keep working.
- Produces CSS custom properties used by every later task: `--c1`…`--c8`, `--c-other`, `--st-good`, `--st-warning`, `--st-serious`, `--st-critical`, `--st-none`, `--ink-good`, `--ink-warning`, `--ink-serious`, `--ink-critical`, `--track`, `--band-good`, `--band-warning`, `--band-poor`.

- [ ] **Step 1: Write the failing test**

Create `test/charts.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html, raw, esc, isRaw } from '../extension/ui/html.js';
import * as render from '../extension/ui/render.js';

test('html tag escapes values and passes raw through', () => {
  const out = html`<p title="${'"x"'}">${'<b>'}${raw('<i>ok</i>')}${['a', '&']}${null}${false}${0}</p>`;
  assert.ok(isRaw(out));
  assert.equal(String(out), '<p title="&quot;x&quot;">&lt;b&gt;<i>ok</i>a&amp;0</p>');
  assert.equal(esc("'"), '&#39;');
});

test('render.js re-exports the html helpers', () => {
  assert.equal(render.html, html);
  assert.equal(render.raw, raw);
  assert.equal(render.esc, esc);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/charts.test.mjs`
Expected: FAIL — `Cannot find module '.../extension/ui/html.js'`.

- [ ] **Step 3: Create `extension/ui/html.js`**

```js
// Escaping HTML templating. Every interpolated value is escaped unless it came from html`` / raw() —
// plugin data is untrusted (it comes from web pages and remote services).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s));
export const isRaw = (v) => v instanceof Raw;

function fmt(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join('');
  if (v == null || v === false) return '';
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += fmt(v) + strings[i + 1]; });
  return new Raw(out);
}
```

- [ ] **Step 4: Replace the top of `extension/ui/render.js`**

Replace lines 1–27 (from the opening comment through the end of `export function html(...) {...}`) with:

```js
// Helper kit handed to plugin render()/glance() functions, plus small viewer utilities.
// Escaping lives in html.js; every interpolated value is escaped unless it came from html`` / raw().

import { formatBytes, formatMs } from '../core/har-util.js';
import { html, raw, esc, isRaw } from './html.js';

export { html, raw, esc, isRaw };
```

Everything below (the `empty`, `cell`, `slug`, `h`, `renderGeneric`, … definitions) stays. `cell()` uses `v instanceof Raw` — change those two occurrences to `isRaw(v)`:
- in `const empty = …`: `(v instanceof Raw && !v.s.trim())` → `(isRaw(v) && !String(v).trim())`
- in `function cell(v)`: `if (v instanceof Raw) return v;` → `if (isRaw(v)) return v;`

- [ ] **Step 5: Add colour tokens to `extension/ui/theme.css`**

Inside `@layer tokens { :root { … } }`, after the line `--ok: light-dark(#2b8a3e, #69db7c);`, add:

```css
    /* chart palette (dataviz reference instance, validated on --panel in both modes) */
    --c1: light-dark(#2a78d6, #3987e5);
    --c2: light-dark(#eb6834, #d95926);
    --c3: light-dark(#1baf7a, #199e70);
    --c4: light-dark(#eda100, #c98500);
    --c5: light-dark(#e87ba4, #d55181);
    --c6: light-dark(#008300, #008300);
    --c7: light-dark(#6250d6, #9085e9);
    --c8: light-dark(#e34948, #e66767);
    --c-other: light-dark(#9aa6ad, #6b7a83);
    /* status: fixed in both modes; always paired with an icon and a word */
    --st-good: #0ca30c;
    --st-warning: #fab219;
    --st-serious: #ec835a;
    --st-critical: #d03b3b;
    --st-none: var(--line);
    --ink-good: light-dark(#006300, #0ca30c);
    --ink-warning: light-dark(#8a5a00, #fab219);
    --ink-serious: light-dark(#a8461c, #ec835a);
    --ink-critical: light-dark(#b02a2a, #ff6b6b);
    --track: light-dark(#e7ecef, #24343b);
    --band-good: light-dark(#a7dca7, #1f4d27);
    --band-warning: light-dark(#fde2a6, #5a4612);
    --band-poor: light-dark(#f2b6b6, #5c2323);
```

- [ ] **Step 6: Re-validate the palette against our surfaces**

The dataviz skill ships `scripts/validate_palette.js` (in the skill's base directory; locate it with `find / -name validate_palette.js -path '*dataviz*' 2>/dev/null | head -1`). Run:

```bash
V=$(find / -name validate_palette.js -path '*dataviz*' 2>/dev/null | head -1)
node "$V" "#2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4,#008300,#6250d6,#e34948" --mode light --surface "#ffffff"
node "$V" "#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767" --mode dark --surface "#121b1f"
```

Expected: `ALL CHECKS PASS` in both; light mode prints a contrast WARN for `#1baf7a`, `#eda100`, `#e87ba4` (relief = every legend shows values as text, which the chart kit does). If the script cannot be found, skip this step and note it in the commit message.

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: PASS (all existing tests plus the 2 new ones).

- [ ] **Step 8: Commit**

```bash
git add extension/ui/html.js extension/ui/render.js extension/ui/theme.css test/charts.test.mjs
git commit -m "Move HTML escaping to ui/html.js and add chart colour tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Scoring module, plugin areas and rated summaries

**Files:**
- Create: `extension/core/score.js`
- Modify: `extension/core/plugin-host.js` (import; result object in `runOne`, ~line 128; `normalize`, ~line 207)
- Modify: `extension/core/harplus.js` (`indexRecord` ~line 105; `toMarkdown` summary line ~line 154)
- Modify: `cli/harplus.mjs` (`printReadout` summary line)
- Modify: `extension/plugins/a11y-basics.js`, `axe.js`, `meta.js`, `html-validate.js`, `css-validate.js` (add `area`)
- Test: `test/score.test.mjs`

**Interfaces:**
- Consumes: `SEVERITIES`, `SEVERITY_RANK` from `core/har-util.js`.
- Produces (all exported from `extension/core/score.js`):
  - `AREAS: Array<{ id, label, weight }>`
  - `CATEGORY_AREA`, `GROUP_AREA`, `DEDUCT`, `CAP`, `VERDICT` (objects)
  - `pluginArea(plugin) → areaId`
  - `resultArea(result, plugins) → areaId` (uses `result.area`, else the plugin's area, else `'build'`)
  - `normRating(r) → 'good'|'needs-improvement'|'poor'|null`
  - `grade(score|null) → string|null`, `status(score|null) → 'good'|'warning'|'serious'|'critical'|'none'`
  - `scoreReading(reading, plugins = []) → { overall: { score, grade, status, findings }, areas: { [id]: AreaScore } }` where `AreaScore = { id, label, weight, score, grade, status, measured, counts: {high,medium,low,info}, deductions: [{ finding, points }], inputs: [{ label, score }] }` and each `finding` is `{ ...finding, plugin, pluginName, area }`.
  - `topFindings(scores, n = 5, areaId = null, { includeInfo = false } = {}) → finding[]` sorted by severity, then area weight (desc).
  - `summarize(scores) → string`
- Produces in `core/harplus.js`: `summaryValue(item) → string` (value plus "(rating)" when rated); `indexRecord()` gains `score`, `grade`, `status`.
- Produces in plugin results: `area` (string) on every result written by `runOne`; summary items keep `rating` (normalised) and `headline: true`.

- [ ] **Step 1: Write the failing tests**

Create `test/score.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AREAS, grade, status, pluginArea, resultArea, normRating, scoreReading, topFindings, summarize,
} from '../extension/core/score.js';
import { getPlugins } from '../extension/plugins/index.js';

const f = (severity, category, title = `${severity} ${category}`) => ({ severity, category, title });
const reading = (plugins) => ({ log: { entries: [], _harplus: { plugins } } });
const ok = (id, findings = [], extra = {}) => ({ id, name: id, status: 'ok', findings, summary: [], data: {}, ...extra });

test('grade bands and modifiers', () => {
  const cases = [[100, 'A+'], [97, 'A+'], [96, 'A'], [93, 'A'], [92, 'A−'], [90, 'A−'], [89, 'B+'], [87, 'B+'],
    [86, 'B'], [83, 'B'], [82, 'B−'], [80, 'B−'], [79, 'C+'], [70, 'C−'], [60, 'D−'], [59, 'F'], [0, 'F']];
  for (const [s, g] of cases) assert.equal(grade(s), g, `score ${s}`);
  assert.equal(grade(null), null);
});

test('status bands', () => {
  assert.equal(status(85), 'good');
  assert.equal(status(84), 'warning');
  assert.equal(status(70), 'warning');
  assert.equal(status(69), 'serious');
  assert.equal(status(50), 'serious');
  assert.equal(status(49), 'critical');
  assert.equal(status(null), 'none');
});

test('plugin areas: explicit area, group fallback, built-in overrides', () => {
  assert.equal(pluginArea({ area: 'security', group: 'build' }), 'security');
  assert.equal(pluginArea({ group: 'quality' }), 'performance');
  assert.equal(pluginArea({ group: 'other' }), 'build');
  assert.equal(pluginArea(undefined), 'build');
  const byId = Object.fromEntries(getPlugins().map((p) => [p.id, pluginArea(p)]));
  assert.equal(byId['a11y-basics'], 'accessibility');
  assert.equal(byId.axe, 'accessibility');
  assert.equal(byId.meta, 'build');
  assert.equal(byId['html-validate'], 'build');
  assert.equal(byId['css-validate'], 'build');
  assert.equal(byId.vitals, 'performance');
  assert.equal(byId.network, 'performance');
  assert.equal(byId.security, 'security');
  assert.equal(byId.tech, 'build');
  assert.equal(byId.dns, 'infrastructure');
  assert.equal(resultArea({ id: 'x', area: 'security' }, []), 'security');
  assert.equal(resultArea({ id: 'a11y-basics' }, getPlugins()), 'accessibility');
});

test('normRating accepts spaces and case', () => {
  assert.equal(normRating('needs improvement'), 'needs-improvement');
  assert.equal(normRating('Good'), 'good');
  assert.equal(normRating('meh'), null);
  assert.equal(normRating(null), null);
});

test('finding deductions with caps; categories map to areas', () => {
  const findings = [
    ...Array(5).fill(0).map((_, i) => f('high', 'security', `h${i}`)), // 75 → capped at 60
    f('medium', 'privacy'), f('low', 'security'), f('info', 'security'),
  ];
  const s = scoreReading(reading({ security: ok('security', findings) }), getPlugins());
  const a = s.areas.security;
  assert.equal(a.score, 100 - 60 - 6 - 2);
  assert.deepEqual(a.counts, { high: 5, medium: 1, low: 1, info: 1 });
  assert.equal(a.deductions.length, 8);
  assert.equal(a.deductions[0].finding.area, 'security');
  assert.equal(a.deductions[0].finding.pluginName, 'security');
});

test('findings land in their category area even from another area plugin', () => {
  const s = scoreReading(reading({
    html: ok('html', [f('low', 'accessibility', 'No <main> element')]),
    'a11y-basics': ok('a11y-basics'),
  }), getPlugins());
  assert.equal(s.areas.accessibility.score, 98);
  assert.equal(s.areas.build.score, 100);
});

test('performance blends vitals ratings, lighthouse wins when present', () => {
  const vitals = ok('vitals', [], { data: { ratings: { lcp: 'needs improvement', cls: 'good', fcp: 'good', ttfb: 'poor' } } });
  const s1 = scoreReading(reading({ vitals }), getPlugins());
  // findings 100, metric (60+100+100+20)/4 = 70 → 85
  assert.equal(s1.areas.performance.score, 85);
  assert.deepEqual(s1.areas.performance.inputs.map((i) => i.label), ['Findings', 'Web vitals ratings']);
  const pagespeed = ok('pagespeed', [], { data: { lab: { scores: { performance: 0.4, accessibility: 0.9 } } } });
  const s2 = scoreReading(reading({ vitals, pagespeed, 'a11y-basics': ok('a11y-basics') }), getPlugins());
  assert.equal(s2.areas.performance.score, 70); // (100 + 40) / 2
  assert.equal(s2.areas.accessibility.score, 95); // (100 + 90) / 2
});

test('unmeasured areas are excluded and weights renormalise', () => {
  const s = scoreReading(reading({
    security: ok('security', [f('high', 'security'), f('high', 'security')]), // 70
    dns: ok('dns'), // infrastructure 100
    whois: { id: 'whois', name: 'whois', status: 'skipped', findings: [], summary: [] },
  }), getPlugins());
  assert.equal(s.areas.performance.score, null);
  assert.equal(s.areas.performance.status, 'none');
  assert.equal(s.areas.infrastructure.score, 100);
  assert.equal(s.overall.score, Math.round((70 * 25 + 100 * 10) / 35));
  assert.equal(s.overall.findings, 2);
});

test('empty reading: nothing measured', () => {
  const s = scoreReading(reading({}), []);
  assert.equal(s.overall.score, null);
  assert.equal(s.overall.grade, null);
  for (const a of AREAS) assert.equal(s.areas[a.id].score, null);
  assert.equal(summarize(s), 'No areas measured yet — enable plugins and re-run analysis.');
});

test('topFindings orders by severity then area weight; info excluded by default', () => {
  const s = scoreReading(reading({
    dns: ok('dns', [f('high', 'infrastructure', 'infra high')]),
    security: ok('security', [f('high', 'security', 'sec high'), f('info', 'security', 'sec info')]),
    network: ok('network', [f('medium', 'performance', 'perf medium')]),
  }), getPlugins());
  assert.deepEqual(topFindings(s, 5).map((x) => x.title), ['sec high', 'infra high', 'perf medium']);
  assert.deepEqual(topFindings(s, 5, 'security', { includeInfo: true }).map((x) => x.title), ['sec high', 'sec info']);
});

test('summarize: best, worst and top issue', () => {
  const s = scoreReading(reading({
    security: ok('security', [f('low', 'security')]), // 98
    'a11y-basics': ok('a11y-basics', [f('high', 'accessibility', '2 form fields without labels'), f('high', 'accessibility', 'x'), f('high', 'accessibility', 'y')]), // 55
  }), getPlugins());
  assert.equal(summarize(s), 'Strong on security, weak on accessibility. Top issue: 2 form fields without labels.');
});
```

Also add to the end of `test/core.test.mjs` (it already imports from `../extension/core/harplus.js`; add `summaryValue` and `indexRecord` to that import if not present):

```js
test('summaryValue shows ratings; plugin host keeps rating/headline and stamps area', async () => {
  const { summaryValue } = await import('../extension/core/harplus.js');
  assert.equal(summaryValue({ label: 'LCP', value: '3.1 s', rating: 'needs-improvement' }), '3.1 s (needs improvement)');
  assert.equal(summaryValue({ label: 'x', value: 'y' }), 'y');
  const { runPlugins } = await import('../extension/core/plugin-host.js');
  const r = { log: { entries: [], pages: [], _harplus: { plugins: {}, target: {}, capture: {} } } };
  const p = { id: 'p1', name: 'P1', phase: 'analyze', group: 'security', run: () => ({ summary: [
    { label: 'A', value: '1', rating: 'Needs Improvement', headline: true }, { label: 'B', value: '2', rating: 'bogus' },
  ] }) };
  await runPlugins(r, [p], { phases: ['analyze'] });
  const res = r.log._harplus.plugins.p1;
  assert.equal(res.area, 'security');
  assert.deepEqual(res.summary, [{ label: 'A', value: '1', rating: 'needs-improvement', headline: true }, { label: 'B', value: '2' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/score.test.mjs test/core.test.mjs`
Expected: FAIL — `Cannot find module '.../extension/core/score.js'` and `summaryValue is not a function`.

- [ ] **Step 3: Create `extension/core/score.js`**

```js
// Area scores, grades and the one-line narrative for a reading. Pure (no DOM, no chrome.*):
// shared by the viewer, the standalone export and the CLI. Formula documented in docs/PLUGINS.md.

import { SEVERITIES, SEVERITY_RANK } from './har-util.js';

export const AREAS = [
  { id: 'performance', label: 'Performance', weight: 25 },
  { id: 'accessibility', label: 'Accessibility', weight: 25 },
  { id: 'security', label: 'Security', weight: 25 },
  { id: 'build', label: 'Build & content', weight: 15 },
  { id: 'infrastructure', label: 'Infrastructure', weight: 10 },
];
const AREA_IDS = new Set(AREAS.map((a) => a.id));
const WEIGHT = Object.fromEntries(AREAS.map((a) => [a.id, a.weight]));

export const CATEGORY_AREA = {
  performance: 'performance', accessibility: 'accessibility', security: 'security', privacy: 'security',
  quality: 'build', seo: 'build', infrastructure: 'infrastructure', intel: 'infrastructure',
};
export const GROUP_AREA = { build: 'build', security: 'security', infrastructure: 'infrastructure', quality: 'performance', other: 'build' };
export const DEDUCT = { high: 15, medium: 6, low: 2, info: 0 };
export const CAP = { high: 60, medium: 30, low: 15, info: 0 };
export const VERDICT = { good: 'good', warning: 'needs work', serious: 'poor', critical: 'failing', none: 'not measured' };
const RATING_SCORE = { good: 100, 'needs-improvement': 60, poor: 20 };

export const pluginArea = (plugin) => (AREA_IDS.has(plugin?.area) ? plugin.area : GROUP_AREA[plugin?.group] || 'build');
export const resultArea = (result, plugins = []) =>
  (AREA_IDS.has(result?.area) ? result.area : pluginArea(plugins.find((p) => p.id === result?.id)));

export function normRating(r) {
  const k = r ? String(r).trim().toLowerCase().replace(/\s+/g, '-') : '';
  return k in RATING_SCORE ? k : null;
}

export function grade(score) {
  if (score == null) return null;
  const s = Math.round(score);
  if (s < 60) return 'F';
  const low = s >= 90 ? 90 : s >= 80 ? 80 : s >= 70 ? 70 : 60;
  const letter = { 90: 'A', 80: 'B', 70: 'C', 60: 'D' }[low];
  return letter + (s >= low + 7 ? '+' : s <= low + 2 ? '−' : '');
}

export function status(score) {
  if (score == null) return 'none';
  return score >= 85 ? 'good' : score >= 70 ? 'warning' : score >= 50 ? 'serious' : 'critical';
}

function metricInput(areaId, results) {
  const lab = results.pagespeed?.status === 'ok' ? results.pagespeed.data?.lab?.scores : null;
  if (areaId === 'performance') {
    if (lab?.performance != null) return { label: 'Lighthouse performance', score: Math.round(lab.performance * 100) };
    const ratings = results.vitals?.status === 'ok'
      ? Object.values(results.vitals.data?.ratings || {}).map(normRating).filter(Boolean) : [];
    if (ratings.length) {
      return { label: 'Web vitals ratings', score: Math.round(ratings.reduce((n, r) => n + RATING_SCORE[r], 0) / ratings.length) };
    }
  }
  if (areaId === 'accessibility' && lab?.accessibility != null) {
    return { label: 'Lighthouse accessibility', score: Math.round(lab.accessibility * 100) };
  }
  return null;
}

export function scoreReading(reading, plugins = []) {
  const results = reading.log._harplus?.plugins || {};
  const areas = Object.fromEntries(AREAS.map((a) => [a.id, {
    ...a, score: null, grade: null, status: 'none', measured: false,
    counts: { high: 0, medium: 0, low: 0, info: 0 }, deductions: [], inputs: [],
  }]));
  for (const r of Object.values(results)) {
    const home = resultArea(r, plugins);
    if (r.status === 'ok') areas[home].measured = true;
    for (const f of r.findings || []) {
      const area = CATEGORY_AREA[f.category] || home;
      const sev = SEVERITY_RANK[f.severity] != null ? f.severity : 'info';
      areas[area].counts[sev]++;
      areas[area].deductions.push({ finding: { ...f, severity: sev, plugin: r.id, pluginName: r.name, area }, points: DEDUCT[sev] });
    }
  }
  for (const a of Object.values(areas)) {
    if (!a.measured) continue;
    const fromFindings = 100 - SEVERITIES.reduce((n, s) => n + Math.min(CAP[s], DEDUCT[s] * a.counts[s]), 0);
    a.inputs.push({ label: 'Findings', score: fromFindings });
    const metric = metricInput(a.id, results);
    if (metric) a.inputs.push(metric);
    a.score = Math.round(metric ? (fromFindings + metric.score) / 2 : fromFindings);
    a.grade = grade(a.score);
    a.status = status(a.score);
  }
  const measured = AREAS.filter((a) => areas[a.id].measured);
  const weight = measured.reduce((n, a) => n + a.weight, 0);
  const score = weight ? Math.round(measured.reduce((n, a) => n + areas[a.id].score * a.weight, 0) / weight) : null;
  const findings = Object.values(areas).reduce((n, a) => n + a.deductions.length, 0);
  return { overall: { score, grade: grade(score), status: status(score), findings }, areas };
}

export function topFindings(scores, n = 5, areaId = null, { includeInfo = false } = {}) {
  return Object.values(scores.areas)
    .filter((a) => !areaId || a.id === areaId)
    .flatMap((a) => a.deductions.map((d) => d.finding))
    .filter((f) => includeInfo || f.severity !== 'info')
    .sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || WEIGHT[y.area] - WEIGHT[x.area])
    .slice(0, n);
}

export function summarize(scores) {
  const measured = AREAS.map((a) => scores.areas[a.id]).filter((a) => a.score != null);
  if (!measured.length) return 'No areas measured yet — enable plugins and re-run analysis.';
  const best = measured.reduce((x, y) => (y.score > x.score ? y : x));
  const worst = measured.reduce((x, y) => (y.score < x.score ? y : x));
  const name = (a) => a.label.toLowerCase();
  const parts = [best.score >= 85 ? `Strong on ${name(best)}` : `Best area: ${name(best)} (${best.score})`];
  if (worst !== best) parts.push(worst.score < 70 ? `weak on ${name(worst)}` : `no area below ${worst.score}`);
  let text = `${parts.join(', ')}.`;
  const top = topFindings(scores, 1)[0];
  if (top && (top.severity === 'high' || top.severity === 'medium')) text += ` Top issue: ${top.title.replace(/\.$/, '')}.`;
  return text;
}
```

- [ ] **Step 4: Update `extension/core/plugin-host.js`**

Add to the imports at the top: `import { pluginArea, normRating } from './score.js';`

In `runOne`, in the object assigned to `reading.log._harplus.plugins[plugin.id]`, add `area: pluginArea(plugin),` directly after `phase: plugin.phase,`.

In `normalize`, replace the `summary` mapping:

```js
  const summary = (out.summary || [])
    .filter((s) => s && s.label && s.value != null && s.value !== '')
    .map((s) => {
      const n = { label: String(s.label), value: String(s.value) };
      const rating = normRating(s.rating);
      if (rating) n.rating = rating;
      if (s.headline) n.headline = true;
      return n;
    });
```

- [ ] **Step 5: Update `extension/core/harplus.js`**

Add the import `import { scoreReading } from './score.js';` and this export near `findings()`:

```js
/** A summary item's display value, with its rating when the plugin rated it. */
export const summaryValue = (s) => (s.rating ? `${s.value} (${s.rating.replace(/-/g, ' ')})` : s.value);
```

In `toMarkdown`, change `` `- **${s.label}:** ${s.value}` `` to `` `- **${s.label}:** ${summaryValue(s)}` ``.

In `indexRecord`, compute `const overall = scoreReading(reading).overall;` before `return` and add these properties after `counts: severityCounts(reading),`:

```js
    score: overall.score,
    grade: overall.grade,
    status: overall.status,
```

(`indexRecord` has no plugin list; results stamped with `area` by Step 4 carry it, and older readings fall back to group mapping through `resultArea`. Their score updates on the next re-run.)

- [ ] **Step 6: Update `cli/harplus.mjs`**

Add `summaryValue` to the import from `../extension/core/harplus.js`, and in `printReadout` change `` `  ${C.dim(s.label.padEnd(24))} ${s.value}` `` to `` `  ${C.dim(s.label.padEnd(24))} ${summaryValue(s)}` ``.

- [ ] **Step 7: Add `area` to five built-in plugins**

In each default-export object, add the line directly after the existing `group:` line:
- `extension/plugins/a11y-basics.js`: `area: 'accessibility',`
- `extension/plugins/axe.js`: `area: 'accessibility',`
- `extension/plugins/meta.js`: `area: 'build',`
- `extension/plugins/html-validate.js`: `area: 'build',`
- `extension/plugins/css-validate.js`: `area: 'build',`

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all tests, including `test/score.test.mjs`).

- [ ] **Step 9: Commit**

```bash
git add extension/core/score.js extension/core/plugin-host.js extension/core/harplus.js cli/harplus.mjs extension/plugins/a11y-basics.js extension/plugins/axe.js extension/plugins/meta.js extension/plugins/html-validate.js extension/plugins/css-validate.js test/score.test.mjs test/core.test.mjs
git commit -m "Add area scoring, plugin areas and rated summary items

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Chart kit part 1 — label fitting, ring, donut, legend

**Files:**
- Create: `extension/ui/charts.js`
- Test: `test/charts.test.mjs` (append)

**Interfaces:**
- Consumes: `html`, `raw` from `extension/ui/html.js`.
- Produces (exported from `extension/ui/charts.js`):
  - `textWidth(text, fontSize) → number` (estimated, SVG user units)
  - `fitFont(text, innerDiameter, base) → number`
  - `RING = { r: 17, stroke: 4 }`, `DONUT = { r: 16, stroke: 6 }`, `innerDiameter({ r, stroke }) → number`
  - `ring({ value, max = 100, size = 44, status = 'none', label = '', showValue = true }) → Raw`
  - `foldSegments(segments, max = 6) → segments` (keeps the 5 largest in input order, adds `{ label: 'Other', value, other: true }`)
  - `donut({ segments: [{ label, value, display? }], center: { value, unit? }, size = 112, label = '' }) → Raw | ''`
  - `legend(items: [{ label, value?, color }]) → Raw | ''`
  - `safeColor(c) → string` (only `var(--name)` or `#hex`, else `var(--c-other)`)
  - `seriesColor(segment, index) → string`

- [ ] **Step 1: Write the failing tests** — append to `test/charts.test.mjs`:

```js
import { textWidth, fitFont, RING, DONUT, innerDiameter, ring, donut, legend, foldSegments, safeColor } from '../extension/ui/charts.js';

test('ring labels fit inside 80% of the inner diameter', () => {
  for (const text of ['7', '57', '100']) {
    const fs = fitFont(text, innerDiameter(RING), 13);
    assert.ok(textWidth(text, fs) <= 0.8 * innerDiameter(RING) + 1e-9, `${text} at ${fs}`);
  }
  const fs = fitFont('1,284', innerDiameter(DONUT), 9);
  assert.ok(textWidth('1,284', fs) <= 0.8 * innerDiameter(DONUT) + 1e-9);
  assert.ok(fitFont('7', innerDiameter(RING), 13) === 13, 'short labels keep the base size');
});

test('ring markup: progress, label, status, not measured', () => {
  const s = String(ring({ value: 57, status: 'serious', label: 'Accessibility' }));
  assert.match(s, /role="img"/);
  assert.match(s, /aria-label="Accessibility: 57 of 100"/);
  assert.match(s, /stroke="var\(--st-serious\)"/);
  assert.match(s, /stroke-dasharray="57 100"/);
  assert.match(s, />57<\/text>/);
  const none = String(ring({ value: null, label: 'Security' }));
  assert.match(none, /aria-label="Security: not measured"/);
  assert.match(none, />—<\/text>/);
  assert.doesNotMatch(none, /stroke-dasharray/);
  assert.doesNotMatch(String(ring({ value: 80, showValue: false })), /<text/);
  assert.match(String(ring({ value: 50, status: 'bogus"><script>' })), /var\(--st-none\)/);
  assert.match(String(ring({ value: 1, label: '<b>' })), /&lt;b&gt;/);
});

test('donut folds small segments, labels centre, empty is blank', () => {
  const segs = 'abcdefgh'.split('').map((l, i) => ({ label: l, value: 10 - i }));
  const folded = foldSegments(segs);
  assert.equal(folded.length, 6);
  assert.deepEqual(folded.map((s) => s.label), ['a', 'b', 'c', 'd', 'e', 'Other']);
  assert.equal(folded[5].value, 5 + 4 + 3);
  const s = String(donut({ segments: segs, center: { value: '2.4', unit: 'MB' }, label: 'Page weight' }));
  assert.match(s, /aria-label="Page weight: a 10, b 9/);
  assert.match(s, />2\.4<\/text>/);
  assert.match(s, /class="unit"[^>]*>MB<\/text>/);
  assert.match(s, /<ul class="legend">/);
  assert.equal(donut({ segments: [{ label: 'x', value: 0 }] }), '');
});

test('legend escapes labels and rejects unsafe colours', () => {
  const s = String(legend([{ label: '<x>', value: 3, color: 'red;background:url(x)' }, { label: 'ok', color: 'var(--c2)' }]));
  assert.match(s, /&lt;x&gt;/);
  assert.match(s, /background:var\(--c-other\)/);
  assert.match(s, /background:var\(--c2\)/);
  assert.equal(safeColor('#abc'), '#abc');
  assert.equal(legend([]), '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/charts.test.mjs`
Expected: FAIL — `Cannot find module '.../extension/ui/charts.js'`.

- [ ] **Step 3: Create `extension/ui/charts.js`**

```js
// Chart kit: pure functions returning escaped HTML/SVG (no DOM) — shared by the viewer, the
// standalone HTML export and the CLI, and handed to plugins on `h`. Colours come from theme.css
// custom properties (--c1…--c8 categorical, --st-* status). Every chart carries a text alternative.

import { html, raw } from './html.js';

/* ---------------------------------------------------------- label fitting */

// Advance widths in em for system-ui semibold, deliberately generous (measured: digits ≈ 0.65 em).
const advance = (ch) => (/[0-9]/.test(ch) ? 0.68 : /[.,:]/.test(ch) ? 0.4 : ch === ' ' ? 0.3 : /[A-Z%]/.test(ch) ? 0.75 : 0.62);
export const textWidth = (text, fontSize) => [...String(text)].reduce((n, ch) => n + advance(ch), 0) * fontSize;
const n1 = (x) => Math.round(x * 10) / 10;

/** Largest font size ≤ base whose estimated width stays within 80% of the inner diameter. */
export function fitFont(text, inner, base) {
  const w = textWidth(text, 1);
  return w ? Math.min(base, Math.floor(((0.8 * inner) / w) * 10) / 10) : base;
}

export const RING = { r: 17, stroke: 4 };
export const DONUT = { r: 16, stroke: 6 };
export const innerDiameter = ({ r, stroke }) => 2 * (r - stroke / 2);

const STATUSES = new Set(['good', 'warning', 'serious', 'critical', 'none']);
const COLOR_RE = /^(var\(--[a-z0-9-]+\)|#[0-9a-f]{3,8})$/i;
export const safeColor = (c) => (COLOR_RE.test(String(c ?? '')) ? String(c) : 'var(--c-other)');
export const seriesColor = (s, i) => safeColor(s.color || (s.other ? 'var(--c-other)' : `var(--c${(i % 8) + 1})`));
const num = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? ''));

/* ------------------------------------------------------------------ ring */

export function ring({ value, max = 100, size = 44, status = 'none', label = '', showValue = true } = {}) {
  const has = value != null && Number.isFinite(Number(value));
  const pct = has ? Math.max(0, Math.min(100, (Number(value) / max) * 100)) : 0;
  const text = has ? String(Math.round(Number(value))) : '—';
  const st = STATUSES.has(status) ? status : 'none';
  const name = `${label ? `${label}: ` : ''}${has ? `${text} of ${max}` : 'not measured'}`;
  const px = Number(size) || 44;
  return html`<svg class="chart ring" width="${px}" height="${px}" viewBox="0 0 42 42" role="img" aria-label="${name}"><title>${name}</title>
    <circle cx="21" cy="21" r="${RING.r}" fill="none" stroke="var(--track)" stroke-width="${RING.stroke}"/>
    ${pct > 0 ? html`<circle cx="21" cy="21" r="${RING.r}" fill="none" stroke="var(--st-${st})" stroke-width="${RING.stroke}" stroke-linecap="${pct >= 100 ? 'butt' : 'round'}" pathLength="100" stroke-dasharray="${n1(pct)} 100" transform="rotate(-90 21 21)"/>` : ''}
    ${showValue ? html`<text x="21" y="21" dy="0.35em" text-anchor="middle" font-size="${fitFont(text, innerDiameter(RING), 13)}">${text}</text>` : ''}
  </svg>`;
}

/* ----------------------------------------------------------------- donut */

export function foldSegments(segments = [], max = 6) {
  const xs = segments.filter((s) => Number(s.value) > 0);
  if (xs.length <= max) return xs;
  const keep = new Set([...xs].sort((a, b) => b.value - a.value).slice(0, max - 1));
  const rest = xs.filter((s) => !keep.has(s));
  return [...xs.filter((s) => keep.has(s)), { label: 'Other', value: rest.reduce((n, s) => n + Number(s.value), 0), other: true }];
}

export function legend(items = []) {
  if (!items.length) return '';
  return html`<ul class="legend">${items.map((it) => html`<li><i class="sw" style="background:${safeColor(it.color)}"></i><span>${it.label}</span>${it.value != null && it.value !== '' ? html`<em>${num(it.value)}</em>` : ''}</li>`)}</ul>`;
}

export function donut({ segments = [], center, size = 112, label = '' } = {}) {
  const segs = foldSegments(segments);
  const total = segs.reduce((n, s) => n + Number(s.value), 0);
  if (!total) return '';
  const gap = segs.length > 1 ? 0.8 : 0; // surface gap between arcs, in pathLength units
  let offset = 0;
  const arcs = segs.map((s, i) => {
    const len = (Number(s.value) / total) * 100;
    const dash = Math.max(0, len - gap);
    const arc = html`<circle cx="21" cy="21" r="${DONUT.r}" fill="none" stroke="${seriesColor(s, i)}" stroke-width="${DONUT.stroke}" pathLength="100" stroke-dasharray="${n1(dash)} ${n1(100 - dash)}" stroke-dashoffset="${n1(-offset)}"><title>${s.label}: ${s.display ?? num(s.value)}</title></circle>`;
    offset += len;
    return arc;
  });
  const value = center?.value != null ? String(center.value) : '';
  const unit = center?.unit ? String(center.unit) : '';
  const inner = innerDiameter(DONUT);
  const name = `${label ? `${label}: ` : ''}${segs.map((s) => `${s.label} ${s.display ?? num(s.value)}`).join(', ')}`;
  const px = Number(size) || 112;
  return html`<figure class="chart-fig donut-chart"><svg class="chart donut" width="${px}" height="${px}" viewBox="0 0 42 42" role="img" aria-label="${name}">
    <g transform="rotate(-90 21 21)">${arcs}</g>
    ${value ? html`<text x="21" y="${unit ? 19.5 : 21}" dy="0.35em" text-anchor="middle" font-size="${fitFont(value, inner, 9)}">${value}</text>` : ''}
    ${unit ? html`<text class="unit" x="21" y="27.5" dy="0.35em" text-anchor="middle" font-size="${fitFont(unit, inner, 4.5)}">${unit}</text>` : ''}
  </svg>${legend(segs.map((s, i) => ({ label: s.label, value: s.display ?? s.value, color: seriesColor(s, i) })))}</figure>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/charts.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/ui/charts.js test/charts.test.mjs
git commit -m "Add chart kit: ring and donut with label fitting, legend

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Chart kit part 2 — stacked bar, horizontal bars, meter, stat tile, sparkline

**Files:**
- Modify: `extension/ui/charts.js` (append)
- Test: `test/charts.test.mjs` (append)

**Interfaces:**
- Consumes: `normRating` from `extension/core/score.js`; `legend`, `seriesColor`, `safeColor` from Task 3.
- Produces:
  - `stackBar({ segments: [{ label, value, display?, color? }], label = '', legend = true }) → Raw | ''`
  - `hbars({ rows: [{ label, value, display?, color? }], max?, label = '' }) → Raw | ''`
  - `rate(value, good, poor) → 'good'|'needs-improvement'|'poor'`
  - `meter({ value, good, poor, max?, format = String, label = '' }) → Raw | ''`
  - `stat({ label, value, rating?, note?, meter? }) → Raw` (`value` may be a `Raw`, e.g. a sparkline)
  - `spark(values: number[], { label = '' }) → Raw | ''`
  - `stat` calls `icon()`, which Task 5 implements; this task adds a one-line `icon` stub returning `''` that Task 5 replaces.

- [ ] **Step 1: Write the failing tests** — append to `test/charts.test.mjs`:

```js
import { stackBar, hbars, meter, stat, spark, rate } from '../extension/ui/charts.js';

test('stackBar sizes segments by share and keeps a legend with values', () => {
  const s = String(stackBar({ label: 'Requests', segments: [{ label: 'First party', value: 86 }, { label: 'Third party', value: 62, display: '62 req' }] }));
  assert.match(s, /aria-label="Requests: First party 86, Third party 62 req"/);
  assert.match(s, /flex:58\.1;background:var\(--c1\)/);
  assert.match(s, /flex:41\.9;background:var\(--c2\)/);
  assert.match(s, /<em>62 req<\/em>/);
  assert.doesNotMatch(String(stackBar({ segments: [{ label: 'a', value: 1 }], legend: false })), /class="legend"/);
  assert.equal(stackBar({ segments: [] }), '');
});

test('hbars scale to the max and show values', () => {
  const s = String(hbars({ label: 'Hosts', rows: [{ label: 'a.com', value: 86 }, { label: 'b.com', value: 21, color: 'var(--c2)' }] }));
  assert.match(s, /width:100%;background:var\(--c1\)/);
  assert.match(s, /width:24\.4%;background:var\(--c2\)/);
  assert.match(s, /<b>86<\/b>/);
  assert.equal(hbars({ rows: [] }), '');
});

test('meter places bands, ticks and marker', () => {
  assert.equal(rate(3100, 2500, 4000), 'needs-improvement');
  assert.equal(rate(2500, 2500, 4000), 'good');
  assert.equal(rate(4001, 2500, 4000), 'poor');
  const s = String(meter({ value: 3100, good: 2500, poor: 4000, format: (v) => `${v / 1000} s`, label: 'LCP' }));
  assert.match(s, /aria-label="LCP: 3\.1 s, needs improvement \(good ≤ 2\.5 s, poor &gt; 4 s\)"/);
  assert.match(s, /class="marker" style="left:51\.7%"/);
  assert.match(s, /<span style="left:41\.7%">2\.5 s<\/span>/);
  assert.match(s, /<span style="left:66\.7%">4 s<\/span>/);
  assert.match(String(meter({ value: 99999, good: 1, poor: 2 })), /left:100%/);
  assert.equal(meter({ value: null, good: 1, poor: 2 }), '');
});

test('stat tile shows rating icon and word', () => {
  const s = String(stat({ label: 'LCP', value: '3.1 s', rating: 'needs improvement', note: 'p75' }));
  assert.match(s, /class="stat card"/);
  assert.match(s, /class="delta rating-needs-improvement"/);
  assert.match(s, /Needs improvement/);
  assert.match(s, /p75/);
  assert.doesNotMatch(String(stat({ label: 'x', value: 1 })), /rating-/);
});

test('spark bars scale to the tallest', () => {
  const s = String(spark([0, 5, 10], { label: 'Requests over time' }));
  assert.equal((s.match(/<i /g) || []).length, 3);
  assert.match(s, /height:100%/);
  assert.match(s, /height:4%/);
  assert.equal(spark([]), '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/charts.test.mjs`
Expected: FAIL — `stackBar` (and the others) are not exported.

- [ ] **Step 3: Append to `extension/ui/charts.js`**

Add `import { normRating } from '../core/score.js';` to the imports at the top, then append:

```js
/* ------------------------------------------------------------- bars */

export function stackBar({ segments = [], label = '', legend: showLegend = true } = {}) {
  const segs = segments.filter((s) => Number(s.value) > 0);
  const total = segs.reduce((n, s) => n + Number(s.value), 0);
  if (!total) return '';
  const name = `${label ? `${label}: ` : ''}${segs.map((s) => `${s.label} ${s.display ?? num(s.value)}`).join(', ')}`;
  return html`<div class="chart stackbar">${label ? html`<div class="k">${label}</div>` : ''}<div class="bar" role="img" aria-label="${name}">${segs.map((s, i) => html`<span style="flex:${n1((Number(s.value) / total) * 100)};background:${seriesColor(s, i)}" title="${s.label}: ${s.display ?? num(s.value)}"></span>`)}</div></div>${showLegend ? legend(segs.map((s, i) => ({ label: s.label, value: s.display ?? s.value, color: seriesColor(s, i) }))) : ''}`;
}

export function hbars({ rows = [], max, label = '' } = {}) {
  const xs = rows.filter((r) => Number.isFinite(Number(r.value)) && Number(r.value) >= 0);
  if (!xs.length) return '';
  const top = Number(max) || Math.max(1, ...xs.map((r) => Number(r.value)));
  return html`<div class="chart hbars" role="list" aria-label="${label}">${xs.map((r) => html`<div class="row" role="listitem"><span class="lbl" title="${r.label}">${r.label}</span><span class="track"><span style="width:${n1(Math.min(100, (Number(r.value) / top) * 100))}%;background:${safeColor(r.color || 'var(--c1)')}"></span></span><b>${r.display ?? num(r.value)}</b></div>`)}</div>`;
}

/* ------------------------------------------------------- meter & stat */

export const rate = (value, good, poor) => (value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor');

export function meter({ value, good, poor, max, format = (v) => String(v), label = '' } = {}) {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const top = Number(max) || poor * 1.5;
  const pos = (v) => n1(Math.max(0, Math.min(100, (v / top) * 100)));
  const r = rate(Number(value), good, poor);
  const name = `${label ? `${label}: ` : ''}${format(value)}, ${r.replace('-', ' ')} (good ≤ ${format(good)}, poor > ${format(poor)})`;
  return html`<div class="chart meter" role="img" aria-label="${name}">
    <div class="bands"><span class="band-good" style="flex:${pos(good)}"></span><span class="band-warning" style="flex:${n1(pos(poor) - pos(good))}"></span><span class="band-poor" style="flex:${n1(100 - pos(poor))}"></span><i class="marker" style="left:${pos(value)}%"></i></div>
    <div class="ticks" aria-hidden="true"><span style="left:0%">0</span><span style="left:${pos(good)}%">${format(good)}</span><span style="left:${pos(poor)}%">${format(poor)}</span></div>
  </div>`;
}

const RATING_UI = { good: ['ok', 'Good'], 'needs-improvement': ['up', 'Needs improvement'], poor: ['down', 'Poor'] };

export function stat({ label, value, rating, note, meter: m } = {}) {
  const r = normRating(rating);
  return html`<div class="stat card"><div class="k">${label}</div><div class="v">${value}</div>${m || ''}${r ? html`<div class="delta rating-${r}">${icon(RATING_UI[r][0], { size: 12 })}${RATING_UI[r][1]}</div>` : ''}${note ? html`<div class="delta">${note}</div>` : ''}</div>`;
}

export function spark(values = [], { label = '' } = {}) {
  const xs = values.map(Number).filter(Number.isFinite);
  if (!xs.length) return '';
  const top = Math.max(1, ...xs);
  return html`<div class="chart spark" role="img" aria-label="${label}">${xs.map((v) => html`<i style="height:${n1(Math.max(4, (v / top) * 100))}%"></i>`)}</div>`;
}

// Replaced by the full icon set in Task 5.
export function icon() { return ''; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/charts.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/ui/charts.js test/charts.test.mjs
git commit -m "Add stacked bar, bar list, threshold meter, stat tile and sparkline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Chart kit part 3 — icons, checklist, flow, timeline, badges; expose on `h`; chart CSS

**Files:**
- Modify: `extension/ui/charts.js` (replace the `icon` stub; append helpers)
- Modify: `extension/ui/render.js` (`h` object; add `renderGlance`)
- Modify: `extension/ui/theme.css` (`@layer components`, before the closing `}` of that layer — after the `.toast` rule)
- Test: `test/charts.test.mjs` (append)

**Interfaces:**
- Produces in `charts.js`:
  - `icon(name, { size = 16, title = '' }) → Raw | ''` — names: `high medium low info ok fail up down arrow overview performance accessibility security build infrastructure findings network screens notes`
  - `checklist(items: [{ label, ok, note? }]) → Raw | ''`
  - `flow(nodes: [{ title, sub? }]) → Raw | ''`
  - `timeline({ start, end, now = Date.now(), startLabel, endLabel, nowLabel = 'Today', label = '' }) → Raw | ''` (dates: ms number or ISO string)
  - `badges(techs: [{ name, category?, version? }], { limit = Infinity }) → Raw | ''`
- Produces in `render.js`: `h.ring, h.donut, h.stackBar, h.hbars, h.meter, h.stat, h.spark, h.legend, h.checklist, h.flow, h.timeline, h.icon, h.badges, h.rate`; and `renderGlance(plugin, result, ctx = {}) → Raw` (calls `plugin.glance(result, h, ctx)`, returns `''` for missing glance/remote plugins, and an error paragraph when it throws).

- [ ] **Step 1: Write the failing tests** — append to `test/charts.test.mjs`:

```js
import { icon, checklist, flow, timeline, badges } from '../extension/ui/charts.js';
import { h, renderGlance } from '../extension/ui/render.js';

test('icons: decorative by default, labelled with a title, unknown is blank', () => {
  assert.match(String(icon('high')), /aria-hidden="true"/);
  assert.match(String(icon('ok', { title: 'pass' })), /role="img" aria-label="pass"/);
  assert.equal(icon('nope'), '');
  for (const n of ['medium', 'low', 'info', 'fail', 'up', 'down', 'arrow', 'overview', 'performance', 'accessibility', 'security', 'build', 'infrastructure', 'findings', 'network', 'screens', 'notes']) {
    assert.match(String(icon(n)), /<svg/, n);
  }
});

test('checklist, flow, timeline, badges', () => {
  const c = String(checklist([{ label: 'HSTS', ok: true }, { label: '<CSP>', ok: false, note: 'missing' }]));
  assert.equal((c.match(/aria-label="pass"/g) || []).length, 1);
  assert.equal((c.match(/aria-label="fail"/g) || []).length, 1);
  assert.match(c, /&lt;CSP&gt;/);
  const f = String(flow([{ title: 'a.com', sub: 'DNS' }, { title: 'CDN' }, null, { title: 'Origin' }]));
  assert.equal((f.match(/class="arrow"/g) || []).length, 2);
  const t = String(timeline({ start: '2020-01-01', end: '2030-01-01', now: Date.parse('2025-01-01'), startLabel: 'Registered 2020', endLabel: 'Expires 2030', label: 'Domain' }));
  assert.match(t, /width:50%/);
  assert.match(t, /aria-label="Domain: Registered 2020 to Expires 2030, 50% elapsed"/);
  assert.equal(timeline({ start: 'x', end: 'y' }), '');
  const b = String(badges([{ name: 'Google Tag Manager', category: 'Tags' }, { name: 'Shopify', version: '2' }, { name: 'X' }], { limit: 2 }));
  assert.match(b, />GT<\/i>Google Tag Manager<em>Tags<\/em>/);
  assert.match(b, />S<\/i>Shopify 2/);
  assert.match(b, /\+1<\/i>more/);
});

test('h exposes the chart kit; renderGlance contains failures', () => {
  for (const k of ['ring', 'donut', 'stackBar', 'hbars', 'meter', 'stat', 'spark', 'legend', 'checklist', 'flow', 'timeline', 'icon', 'badges', 'rate']) {
    assert.equal(typeof h[k], 'function', k);
  }
  const ok = renderGlance({ name: 'P', glance: (r, hh, ctx) => hh.html`<b>${r.data.x}${ctx.target.host}</b>` }, { data: { x: 1 } }, { target: { host: 'h' } });
  assert.equal(String(ok), '<b>1h</b>');
  assert.match(String(renderGlance({ name: 'P', glance: () => { throw new Error('boom'); } }, {})), /P: chart failed — boom/);
  assert.equal(String(renderGlance({ name: 'R', remote: true, glance: () => 'x' }, {})), '');
  assert.equal(String(renderGlance({ name: 'N' }, {})), '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/charts.test.mjs`
Expected: FAIL — `checklist` is not exported / `renderGlance` is not a function.

- [ ] **Step 3: Replace the `icon` stub in `extension/ui/charts.js`**

Delete the two lines `// Replaced by the full icon set in Task 5.` and `export function icon() { return ''; }`, and append:

```js
/* ------------------------------------------------------------------ icons */

const STROKE = 'stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  high: '<path d="M8 1.5 15 14H1Z" fill="var(--st-critical)"/><path d="M8 6v3.6M8 11.6v.3" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
  medium: '<circle cx="8" cy="8" r="7" fill="var(--st-serious)"/><path d="M8 4.5v4.3M8 11v.3" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
  low: '<circle cx="8" cy="8" r="7" fill="var(--c1)"/><path d="M8 7.2v4.3M8 4.6v.3" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
  info: '<circle cx="8" cy="8" r="7" fill="var(--c-other)"/><path d="M8 7.2v4.3M8 4.6v.3" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
  ok: '<circle cx="8" cy="8" r="7" fill="var(--st-good)"/><path d="m4.8 8.2 2.2 2.2 4.2-4.6" stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  fail: '<circle cx="8" cy="8" r="7" fill="var(--st-critical)"/><path d="m5.5 5.5 5 5m0-5-5 5" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>',
  up: '<path d="M8 2 14.5 13.5h-13Z" fill="var(--st-warning)"/>',
  down: '<path d="M8 14 1.5 2.5h13Z" fill="var(--st-critical)"/>',
  arrow: `<path d="M2 8h10M9 4.5 12.5 8 9 11.5" stroke-width="1.6" ${STROKE}/>`,
  overview: '<rect x="2" y="2" width="5" height="5" rx="1" fill="currentColor"/><rect x="9" y="2" width="5" height="5" rx="1" fill="currentColor" opacity=".5"/><rect x="2" y="9" width="5" height="5" rx="1" fill="currentColor" opacity=".5"/><rect x="9" y="9" width="5" height="5" rx="1" fill="currentColor"/>',
  performance: `<path d="M2.5 12a5.5 5.5 0 1 1 11 0" stroke-width="1.6" ${STROKE}/><path d="m8 12 3-4" stroke-width="1.6" ${STROKE}/>`,
  accessibility: `<circle cx="8" cy="3" r="1.6" fill="currentColor"/><path d="M3 6h10M8 6v4m0 0-2.5 4.5M8 10l2.5 4.5" stroke-width="1.6" ${STROKE}/>`,
  security: `<path d="M8 1.5 13.5 3.5v4c0 3.3-2.3 5.9-5.5 7-3.2-1.1-5.5-3.7-5.5-7v-4Z" stroke-width="1.5" ${STROKE}/>`,
  build: `<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" stroke-width="1.6" ${STROKE}/>`,
  infrastructure: `<rect x="2" y="2.5" width="12" height="4.5" rx="1" stroke-width="1.4" ${STROKE}/><rect x="2" y="9" width="12" height="4.5" rx="1" stroke-width="1.4" ${STROKE}/><path d="M4.5 4.75h.01M4.5 11.25h.01" stroke-width="2" ${STROKE}/>`,
  findings: `<path d="M5.5 4h8M5.5 8h8M5.5 12h8" stroke-width="1.6" ${STROKE}/><path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" stroke-width="2.2" ${STROKE}/>`,
  network: `<path d="M2 4h6M5 8h7M8 12h6" stroke-width="2" ${STROKE}/>`,
  screens: `<rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke-width="1.4" ${STROKE}/><path d="m3.5 11 3-3.5 2.5 2.5 1.5-1.5 2 2.5" stroke-width="1.3" ${STROKE}/>`,
  notes: `<path d="M3 13l.6-2.8L10.8 3a1.4 1.4 0 0 1 2 2l-7.2 7.2Z" stroke-width="1.4" ${STROKE}/>`,
};

export function icon(name, { size = 16, title = '' } = {}) {
  const body = ICONS[name];
  if (!body) return '';
  const px = Number(size) || 16;
  return html`<svg class="icon icon-${name}" width="${px}" height="${px}" viewBox="0 0 16 16" ${title ? html`role="img" aria-label="${title}"` : raw('aria-hidden="true"')}>${raw(body)}</svg>`;
}

/* ------------------------------------------------- lists and diagrams */

export function checklist(items = []) {
  const xs = items.filter((it) => it && it.label);
  if (!xs.length) return '';
  return html`<ul class="chart checklist">${xs.map((it) => html`<li>${icon(it.ok ? 'ok' : 'fail', { title: it.ok ? 'pass' : 'fail' })}<span>${it.label}${it.note ? html`<small>${it.note}</small>` : ''}</span></li>`)}</ul>`;
}

export function flow(nodes = []) {
  const xs = nodes.filter((n) => n && n.title);
  if (!xs.length) return '';
  return html`<ol class="chart flow">${xs.map((n, i) => html`${i ? html`<li class="arrow" aria-hidden="true">${icon('arrow')}</li>` : ''}<li class="node"><b>${n.title}</b>${n.sub ? html`<span>${n.sub}</span>` : ''}</li>`)}</ol>`;
}

export function timeline({ start, end, now = Date.now(), startLabel = '', endLabel = '', nowLabel = 'Today', label = '' } = {}) {
  const t = (x) => (x == null || x === '' ? NaN : typeof x === 'number' ? x : Date.parse(x));
  const a = t(start);
  const b = t(end);
  const c = t(now);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return '';
  const p = n1(Math.max(0, Math.min(100, ((c - a) / (b - a)) * 100)));
  return html`<div class="chart timeline" role="img" aria-label="${label ? `${label}: ` : ''}${startLabel} to ${endLabel}, ${p}% elapsed">
    <div class="line"><span style="width:${p}%"></span></div>
    <i class="pin start"></i><i class="pin now" style="left:${p}%"></i><i class="pin end"></i>
    <div class="labels" aria-hidden="true"><span>${startLabel}</span><span class="now" style="left:${Math.min(85, Math.max(15, p))}%">${nowLabel}</span><span>${endLabel}</span></div>
  </div>`;
}

const hash = (s) => [...String(s)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
const initials = (name) => {
  const w = String(name).replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?')[0]).toUpperCase();
};
const LIGHT_SLOTS = new Set([3, 4, 5]); // aqua, yellow, magenta need dark ink on the fill

export function badges(techs = [], { limit = Infinity } = {}) {
  if (!techs.length) return '';
  const xs = techs.slice(0, limit);
  const more = techs.length - xs.length;
  return html`<ul class="chart badges">${xs.map((t) => {
    const slot = (hash(t.name) % 8) + 1;
    return html`<li class="badge"><i class="${LIGHT_SLOTS.has(slot) ? 'ink' : ''}" style="background:var(--c${slot})" aria-hidden="true">${initials(t.name)}</i>${t.name}${t.version ? ` ${t.version}` : ''}${t.category ? html`<em>${t.category}</em>` : ''}</li>`;
  })}${more > 0 ? html`<li class="badge more"><i aria-hidden="true">+${more}</i>more</li>` : ''}</ul>`;
}
```

- [ ] **Step 4: Expose the kit in `extension/ui/render.js`**

Add the import after the html.js import:

```js
import {
  ring, donut, stackBar, hbars, meter, stat, spark, legend, checklist, flow, timeline, icon, badges, rate,
} from './charts.js';
```

Inside the `export const h = { … }` object, directly after `html, raw, esc,`, add:

```js
  ring, donut, stackBar, hbars, meter, stat, spark, legend, checklist, flow, timeline, icon, badges, rate,
```

After `renderResult`, add:

```js
/** A plugin's area-page charts. Never called for remote plugins (untrusted); failures stay contained. */
export function renderGlance(plugin, result, ctx = {}) {
  if (!plugin?.glance || plugin.remote) return html``;
  try {
    return html`${plugin.glance(result, h, ctx) || ''}`;
  } catch (e) {
    return html`<p class="error">${plugin.name}: chart failed — ${e.message}</p>`;
  }
}
```

- [ ] **Step 5: Add chart CSS to `extension/ui/theme.css`**

Inside `@layer components { … }`, after the `.toast { … }` rule, add:

```css
  /* ---------- chart kit ---------- */
  svg.chart text { font-family: var(--font); font-weight: 600; fill: var(--text); font-variant-numeric: tabular-nums; }
  svg.chart text.unit { font-weight: 500; fill: var(--muted); }
  .icon { flex: none; vertical-align: -0.2em; }
  figure.chart-fig { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1rem; align-items: center; }
  ul.legend { list-style: none; padding: 0; margin: 0.4rem 0 0; display: grid; gap: 0.2rem; font-size: 0.8rem; }
  ul.legend li { display: flex; align-items: center; gap: 0.4rem; min-width: 0; }
  ul.legend em { margin-inline-start: auto; padding-inline-start: 0.75rem; font-style: normal; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  ul.legend .sw { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .stackbar .k { font-size: 0.75rem; color: var(--muted); margin: 0.5rem 0 0.2rem; }
  .stackbar .bar { display: flex; gap: 2px; height: 12px; }
  .stackbar .bar span { min-width: 2px; }
  .stackbar .bar span:first-child { border-start-start-radius: 3px; border-end-start-radius: 3px; }
  .stackbar .bar span:last-child { border-start-end-radius: 3px; border-end-end-radius: 3px; }
  .stackbar + ul.legend { display: flex; flex-wrap: wrap; gap: 0.2rem 1rem; }
  .stackbar + ul.legend em { margin-inline-start: 0.3rem; padding: 0; }
  .hbars { display: grid; grid-template-columns: minmax(6rem, 38%) minmax(0, 1fr) auto; gap: 0.3rem 0.6rem; align-items: center; font-size: 0.8rem; }
  .hbars .row { display: contents; }
  .hbars .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hbars .track { height: 10px; }
  .hbars .track span { display: block; height: 100%; min-width: 2px; border-radius: 0 3px 3px 0; }
  .hbars b { font-weight: 600; text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .meter { margin-top: 0.45rem; }
  .meter .bands { position: relative; display: flex; gap: 2px; height: 8px; }
  .meter .bands span:first-child { border-radius: 3px 0 0 3px; }
  .meter .bands span:nth-child(3) { border-radius: 0 3px 3px 0; }
  .band-good { background: var(--band-good); }
  .band-warning { background: var(--band-warning); }
  .band-poor { background: var(--band-poor); }
  .meter .marker { position: absolute; top: -4px; width: 3px; height: 16px; margin-inline-start: -1.5px; border-radius: 2px; background: var(--text); box-shadow: 0 0 0 2px var(--panel); }
  .meter .ticks { position: relative; height: 1.1rem; font-size: 0.68rem; color: var(--muted); }
  .meter .ticks span { position: absolute; top: 0.15rem; transform: translateX(-50%); white-space: nowrap; }
  .meter .ticks span:first-child { transform: none; }
  .stat { display: grid; gap: 0.15rem; align-content: start; }
  .stat .k { color: var(--muted); font-size: 0.78rem; }
  .stat .v { font-size: 1.45rem; font-weight: 600; line-height: 1.2; overflow-wrap: anywhere; }
  .stat .delta { display: flex; align-items: center; gap: 0.3rem; font-size: 0.78rem; color: var(--muted); }
  .stat .rating-good { color: var(--ink-good); }
  .stat .rating-needs-improvement { color: var(--ink-warning); }
  .stat .rating-poor { color: var(--ink-critical); }
  .spark { display: flex; gap: 2px; align-items: end; height: 1.6rem; margin-top: 0.3rem; }
  .spark i { flex: 1; min-height: 2px; border-radius: 1px 1px 0 0; background: var(--c1); }
  ul.checklist { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr)); gap: 0.35rem 1rem; font-size: 0.82rem; }
  ul.checklist li { display: flex; gap: 0.45rem; align-items: flex-start; }
  ul.checklist small { display: block; color: var(--muted); }
  ol.flow { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; align-items: stretch; gap: 0.3rem; font-size: 0.8rem; }
  ol.flow .node { flex: 1 1 8rem; min-width: 0; border: 1px solid var(--line); border-radius: 6px; padding: 0.4rem 0.55rem; background: var(--panel); }
  ol.flow .node b { display: block; overflow-wrap: anywhere; }
  ol.flow .node span { color: var(--muted); font-size: 0.75rem; }
  ol.flow .arrow { display: grid; place-items: center; color: var(--muted); }
  .timeline { position: relative; padding-top: 0.4rem; }
  .timeline .line { height: 4px; border-radius: 2px; background: var(--track); }
  .timeline .line span { display: block; height: 100%; border-radius: 2px; background: var(--c1); }
  .timeline .pin { position: absolute; top: calc(0.4rem - 6px); width: 16px; height: 16px; border-radius: 50%; background: var(--panel); border: 3px solid var(--c1); }
  .timeline .pin.start { left: 0; }
  .timeline .pin.now { margin-inline-start: -8px; border-color: var(--text); }
  .timeline .pin.end { right: 0; border-color: var(--c-other); }
  .timeline .labels { position: relative; display: flex; justify-content: space-between; margin-top: 0.7rem; min-height: 1rem; font-size: 0.72rem; color: var(--muted); }
  .timeline .labels .now { position: absolute; transform: translateX(-50%); color: var(--text); }
  ul.badges { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .badge { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.12rem 0.5rem 0.12rem 0.2rem; font-size: 0.78rem; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); }
  .badge i { display: grid; place-items: center; min-width: 1.15rem; height: 1.15rem; padding-inline: 0.15rem; border-radius: 4px; font: 700 0.6rem/1 var(--font); font-style: normal; color: #fff; }
  .badge i.ink { color: #0b0b0b; }
  .badge.more i { background: var(--c-other); }
  .badge em { font-style: normal; color: var(--muted); font-size: 0.7rem; }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extension/ui/charts.js extension/ui/render.js extension/ui/theme.css test/charts.test.mjs
git commit -m "Add icons, checklist, flow, timeline and tech badges; expose chart kit on h

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Performance glances — vitals, network, pagespeed

**Files:**
- Modify: `extension/plugins/vitals.js` (summary in `run`; add `glance`; export it in the default object)
- Modify: `extension/plugins/network.js` (summary `headline`; add `glance`)
- Modify: `extension/plugins/pagespeed.js` (add `glance`)
- Test: `test/glance.test.mjs` (create)

**Interfaces:**
- Consumes: `h` from `extension/ui/render.js` (Task 5) — `h.stat`, `h.meter`, `h.donut`, `h.stackBar`, `h.hbars`, `h.ring`, `h.bytes`, `h.html`.
- Produces: `glance(result, h, ctx)` on the default export of `vitals`, `network`, `pagespeed`. Each returns `Raw` HTML wrapped in `.tiles` or `.glance-grid` containers (CSS added in Task 11).
- Summary changes: vitals LCP/CLS/FCP/TTFB items become `{ label, value, rating }` with plain values; LCP has `headline: true`. Network `Requests` and `Transferred` get `headline: true`.

- [ ] **Step 1: Write the failing tests** — create `test/glance.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../extension/ui/render.js';
import { getPlugins } from '../extension/plugins/index.js';

const plugin = (id) => getPlugins().find((p) => p.id === id);
const ok = (data, extra = {}) => ({ status: 'ok', data, findings: [], summary: [], ...extra });
const G = (id, data, ctx = {}) => String(plugin(id).glance(ok(data), h, ctx));

test('vitals glance: four threshold meters plus blocking time', () => {
  const s = G('vitals', {
    lcp: { time: 3100, element: 'img' }, cls: 0.04, fcp: 1200, blockingTime: 610,
    navigation: { ttfb: 420 }, ratings: { lcp: 'needs improvement', cls: 'good', fcp: 'good', ttfb: 'good' },
  });
  assert.equal((s.match(/class="chart meter"/g) || []).length, 5);
  assert.match(s, /Largest contentful paint/);
  assert.match(s, /3\.1 s/);
  assert.match(s, /rating-needs-improvement/);
  assert.match(s, /rating-poor/); // blocking 610 > 600
});

test('vitals summary carries ratings and the LCP headline', async () => {
  const v = plugin('vitals');
  const out = v.run({ log: { entries: [] } }, {
    collected: { navigation: { ttfb: 100 }, fcp: 900, lcp: { time: 3000 }, cls: 0.3, blockingTime: 0, renderBlocking: [], domElements: 10, visibility: 'visible' },
    skip: () => { throw new Error('skip'); },
  });
  const lcp = out.summary.find((s) => s.label === 'LCP');
  assert.deepEqual(lcp, { label: 'LCP', value: '3.00 s', rating: 'needs improvement', headline: true });
  assert.equal(out.summary.find((s) => s.label === 'CLS').rating, 'poor');
});

test('network glance: weight donut, party bars, top hosts', () => {
  const s = G('network', {
    totals: { requests: 10, bytes: 2_500_000, decoded: 6_000_000, thirdParty: { requests: 4, bytes: 500_000 } },
    byType: [{ type: 'image', requests: 3, bytes: 1_000_000 }, { type: 'script', requests: 4, bytes: 900_000 }, { type: 'font', requests: 2, bytes: 600_000 }],
    hosts: [{ host: 'a.com', requests: 6, bytes: 2_000_000, thirdParty: false }, { host: 'gtm.com', requests: 4, bytes: 500_000, thirdParty: true }],
  });
  assert.match(s, /class="chart donut"/);
  assert.match(s, />2\.38<\/text>/);
  assert.match(s, /class="unit"[^>]*>MB</);
  assert.match(s, /aria-label="Requests: First party 6, Third party 4"/);
  assert.match(s, /a\.com/);
  assert.match(s, /width:66\.7%;background:var\(--c2\)/);
});

test('pagespeed glance: one ring per Lighthouse category', () => {
  const s = G('pagespeed', { strategy: 'mobile', lab: { scores: { performance: 0.42, accessibility: 0.95, 'best-practices': 1, seo: null } } });
  assert.equal((s.match(/class="chart ring"/g) || []).length, 3);
  assert.match(s, /Lighthouse Performance: 42 of 100/);
  assert.equal(G('pagespeed', { lab: null }), '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/glance.test.mjs`
Expected: FAIL — `plugin(...).glance is not a function`.

- [ ] **Step 3: Update `extension/plugins/vitals.js`**

Add next to `LIMITS`:

```js
const BLOCKING = [200, 600]; // Lighthouse total-blocking-time thresholds (ms)
const sec = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
```

In `run`, replace the first four `summary` entries (`LCP`, `CLS`, `FCP`, `TTFB`) with:

```js
      { label: 'LCP', value: metrics.lcp == null ? '—' : formatMs(metrics.lcp), rating: ratings.lcp, headline: true },
      { label: 'CLS', value: metrics.cls == null ? '—' : String(metrics.cls), rating: ratings.cls },
      { label: 'FCP', value: metrics.fcp == null ? '—' : formatMs(metrics.fcp), rating: ratings.fcp },
      { label: 'TTFB', value: metrics.ttfb == null ? '—' : formatMs(metrics.ttfb), rating: ratings.ttfb },
```

(The `fmt` helper above them becomes unused — delete it.)

Add before `export default`:

```js
function glance(r, h) {
  const d = r.data;
  const tile = (label, value, rating, fmt, [good, poor]) => (value == null ? '' : h.stat({
    label, value: fmt(value), rating: rating || h.rate(value, good, poor),
    meter: h.meter({ value, good, poor, format: fmt, label }),
  }));
  return h.html`<div class="tiles">
    ${tile('Largest contentful paint', d.lcp?.time, d.ratings?.lcp, sec, LIMITS.lcp)}
    ${tile('Cumulative layout shift', d.cls, d.ratings?.cls, (v) => Number(v).toFixed(2), LIMITS.cls)}
    ${tile('First contentful paint', d.fcp, d.ratings?.fcp, sec, LIMITS.fcp)}
    ${tile('Time to first byte', d.navigation?.ttfb, d.ratings?.ttfb, sec, LIMITS.ttfb)}
    ${tile('Blocking time', d.blockingTime, null, sec, BLOCKING)}
  </div>`;
}
```

Add `glance,` to the default export object after `render,`.

- [ ] **Step 4: Update `extension/plugins/network.js`**

In `run`'s `summary`, add `headline: true` to the `Requests` and `Transferred` items (e.g. `{ label: 'Requests', value: …, headline: true }`).

Add before `export default`:

```js
const TYPE_LABEL = { document: 'HTML', script: 'JavaScript', stylesheet: 'CSS', image: 'Images', font: 'Fonts', xhr: 'Fetch / XHR', media: 'Media', other: 'Other' };

function glance(r, h) {
  const d = r.data;
  const t = d.totals;
  const [num, unit] = h.bytes(t.bytes).split(' ');
  const first = { requests: t.requests - t.thirdParty.requests, bytes: t.bytes - t.thirdParty.bytes };
  const party = (label, a, b, fmt) => h.stackBar({ label, legend: label === 'Requests', segments: [
    { label: 'First party', value: a, display: fmt(a), color: 'var(--c1)' },
    { label: 'Third party', value: b, display: fmt(b), color: 'var(--c2)' },
  ] });
  return h.html`<div class="glance-grid">
    <section class="card"><h4>Page weight by type</h4>${h.donut({
      label: 'Page weight by type', center: { value: num, unit },
      segments: d.byType.map((x) => ({ label: TYPE_LABEL[x.type] || x.type, value: x.bytes, display: h.bytes(x.bytes) })),
    })}</section>
    <section class="card"><h4>First vs third party</h4>
      ${party('Requests', first.requests, t.thirdParty.requests, String)}
      ${party('Transferred', first.bytes, t.thirdParty.bytes, h.bytes)}
      <h4>Top hosts by requests</h4>${h.hbars({ label: 'Requests by host', rows: d.hosts.slice(0, 6).map((x) => ({
        label: x.host, value: x.requests, color: x.thirdParty ? 'var(--c2)' : 'var(--c1)',
      })) })}
    </section>
  </div>`;
}
```

Add `glance,` to the default export object after `render,`.

Note: `h.bytes(2_500_000)` returns `"2.38 MB"` (two decimals ≥ 1 MB per `formatBytes`), which the test expects.

- [ ] **Step 5: Update `extension/plugins/pagespeed.js`**

Add before `export default`:

```js
const LH_NAMES = { performance: 'Performance', accessibility: 'Accessibility', 'best-practices': 'Best practices', seo: 'SEO' };

function glance(r, h) {
  const s = r.data?.lab?.scores || {};
  const rings = Object.entries(LH_NAMES).filter(([k]) => s[k] != null).map(([k, label]) => {
    const v = Math.round(s[k] * 100);
    const status = v >= 90 ? 'good' : v >= 50 ? 'warning' : 'critical'; // Lighthouse's own bands
    return h.html`<figure class="ring-fig">${h.ring({ value: v, size: 64, status, label: `Lighthouse ${label}` })}<figcaption>${label}</figcaption></figure>`;
  });
  return rings.length ? h.html`<section class="card"><h4>Lighthouse · ${r.data.strategy || 'mobile'}</h4><div class="ring-row">${rings}</div></section>` : '';
}
```

Add `glance,` to the default export object (after `run,` or `render,`, whichever is last).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (existing plugin tests still pass with the new vitals summary values).

- [ ] **Step 7: Commit**

```bash
git add extension/plugins/vitals.js extension/plugins/network.js extension/plugins/pagespeed.js test/glance.test.mjs
git commit -m "Add performance glances: vitals meters, network donut and party bars, Lighthouse rings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Accessibility and security glances — a11y-basics, axe, security, observatory

**Files:**
- Modify: `extension/plugins/a11y-basics.js`, `axe.js`, `security.js`, `observatory.js`
- Test: `test/glance.test.mjs` (append)

**Interfaces:**
- Consumes: `h.hbars`, `h.checklist`, `h.timeline`, `h.stackBar`, `h.ring`, `h.html`.
- Produces: `glance` on those four plugins. Summary headlines: a11y-basics `Issues`; axe `Violations`; security `Transport` and `Security headers`.

- [ ] **Step 1: Write the failing tests** — append to `test/glance.test.mjs`:

```js
test('a11y-basics glance: issues by check and structure checklist', () => {
  const s = G('a11y-basics', {
    rules: [{ id: 'image-alt', help: 'Images without alt', count: 4 }, { id: 'input-label', help: 'Unlabelled inputs', count: 2 }],
    stats: { landmarks: 3, skipLink: false },
  });
  assert.match(s, /Images without alt/);
  assert.match(s, /<b>4<\/b>/);
  assert.match(s, /Skip link/);
  assert.equal((s.match(/aria-label="fail"/g) || []).length, 3); // skip link, image alt, labels
  assert.match(G('a11y-basics', { rules: [], stats: { landmarks: 0, skipLink: true } }), /No issues found by the basic checks/);
});

test('axe glance: top violations by elements', () => {
  const s = G('axe', { violations: [{ id: 'x', help: 'Contrast', impact: 'serious', nodes: 9 }], passes: 40, incomplete: 2 });
  assert.match(s, /Contrast/);
  assert.match(s, /<b>9<\/b>/);
});

test('security glance: header checklist, certificate timeline, cookie flags', () => {
  const now = Date.now() / 1000;
  const s = G('security', {
    https: true,
    headers: [{ label: 'Strict-Transport-Security', ok: true }, { label: 'Content-Security-Policy', ok: false }],
    tls: { protocol: 'TLS 1.3', issuer: 'R11', validFrom: now - 30 * 86400, validTo: now + 60 * 86400 },
    cookies: [{ name: 'a', secure: true, httpOnly: true }, { name: 'b', secure: false, httpOnly: false }],
  });
  assert.equal((s.match(/aria-label="pass"/g) || []).length, 2); // HTTPS + HSTS
  assert.match(s, /TLS certificate · 60 days left/);
  assert.match(s, /class="chart timeline"/);
  assert.match(s, /Weak flags/);
});

test('observatory glance: grade ring', () => {
  const s = G('observatory', { grade: 'B', score: 75, tests_passed: 8, tests_failed: 2 });
  assert.match(s, /Mozilla Observatory: 75 of 100/);
  assert.match(s, /Grade B/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/glance.test.mjs`
Expected: FAIL — `glance is not a function` for `a11y-basics`.

- [ ] **Step 3: `extension/plugins/a11y-basics.js`**

In `run`'s summary, add `headline: true` to the `Issues` item. Add before `export default`:

```js
function glance(r, h) {
  const d = r.data;
  const has = (id) => d.rules.some((x) => x.id === id);
  const rows = [...d.rules].sort((a, b) => b.count - a.count).slice(0, 8).map((x) => ({ label: x.help, value: x.count }));
  return h.html`<div class="glance-grid">
    <section class="card"><h4>Issues by check</h4>${rows.length ? h.hbars({ rows, label: 'Accessibility issues by check' }) : h.html`<p class="muted">No issues found by the basic checks.</p>`}</section>
    <section class="card"><h4>Structure</h4>${h.checklist([
      { label: 'Skip link', ok: !!d.stats.skipLink },
      { label: `Landmarks (${d.stats.landmarks})`, ok: d.stats.landmarks > 0 },
      { label: 'Images have alt text', ok: !has('image-alt') },
      { label: 'Form fields are labelled', ok: !has('input-label') },
      { label: 'Page language set', ok: !has('html-lang') },
      { label: 'Zoom allowed', ok: !has('meta-viewport') },
    ])}</section>
  </div>`;
}
```

Add `glance,` to the default export.

- [ ] **Step 4: `extension/plugins/axe.js`**

In `run`'s summary, add `headline: true` to `Violations`. Add before `export default`:

```js
function glance(r, h) {
  const v = r.data?.violations || [];
  const rows = [...v].sort((a, b) => b.nodes - a.nodes).slice(0, 8).map((x) => ({ label: x.help, value: x.nodes }));
  return h.html`<section class="card"><h4>axe-core · elements per violated rule</h4>${rows.length ? h.hbars({ rows, label: 'axe-core violations' }) : h.html`<p class="muted">No violations.</p>`}
    <p class="note">${r.data?.passes ?? 0} rules passed · ${r.data?.incomplete ?? 0} need review</p></section>`;
}
```

Add `glance,` to the default export.

- [ ] **Step 5: `extension/plugins/security.js`**

In `run`'s summary, add `headline: true` to `Transport` and `Security headers`. Add before `export default`:

```js
const toMs = (t) => (typeof t === 'number' && t < 1e12 ? t * 1000 : t); // CDP certificate times are in seconds

function glance(r, h) {
  const d = r.data;
  const tls = d.tls;
  const days = tls ? Math.round((toMs(tls.validTo) - Date.now()) / 86_400_000) : null;
  const year = (t) => new Date(toMs(t)).toISOString().slice(0, 10);
  const good = d.cookies.filter((c) => c.secure && c.httpOnly).length;
  return h.html`<div class="glance-grid">
    <section class="card"><h4>Transport &amp; headers</h4>${h.checklist([
      { label: d.https ? 'HTTPS' : 'HTTPS (page is plain HTTP)', ok: !!d.https },
      ...d.headers.map((x) => ({ label: x.label, ok: !!x.ok })),
    ])}</section>
    <section class="card">
      ${tls ? h.html`<h4>TLS certificate · ${days} days left</h4>${h.timeline({
        start: toMs(tls.validFrom), end: toMs(tls.validTo), startLabel: `Issued ${year(tls.validFrom)}`,
        endLabel: `Expires ${year(tls.validTo)}`, label: 'TLS certificate validity',
      })}<p class="note">${[tls.issuer, tls.protocol].filter(Boolean).join(' · ')}</p>` : h.html`<h4>TLS certificate</h4><p class="muted">No certificate recorded.</p>`}
      ${d.cookies.length ? h.html`<h4>First-party cookies · ${d.cookies.length}</h4>${h.stackBar({ segments: [
        { label: 'Secure + HttpOnly', value: good, color: 'var(--c1)' },
        { label: 'Weak flags', value: d.cookies.length - good, color: 'var(--c2)' },
      ] })}` : ''}
    </section>
  </div>`;
}
```

Add `glance,` to the default export.

- [ ] **Step 6: `extension/plugins/observatory.js`**

Add before `export default`:

```js
function glance(r, h) {
  const d = r.data || {};
  if (d.score == null) return '';
  const status = d.score >= 85 ? 'good' : d.score >= 70 ? 'warning' : d.score >= 50 ? 'serious' : 'critical';
  return h.html`<section class="card"><h4>Mozilla Observatory</h4><div class="ring-row"><figure class="ring-fig">${h.ring({ value: d.score, size: 64, status, label: 'Mozilla Observatory' })}<figcaption>Grade ${d.grade}</figcaption></figure>
    <p class="note">${d.tests_passed} tests passed · ${d.tests_failed} failed</p></div></section>`;
}
```

Add `glance,` to the default export.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add extension/plugins/a11y-basics.js extension/plugins/axe.js extension/plugins/security.js extension/plugins/observatory.js test/glance.test.mjs
git commit -m "Add accessibility and security glances

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Build glances — html, css, javascript, baseline, tech

**Files:**
- Modify: `extension/plugins/html.js`, `css.js`, `javascript.js`, `baseline.js`, `tech.js`
- Test: `test/glance.test.mjs` (append)

**Interfaces:**
- Consumes: `h.stackBar`, `h.checklist`, `h.stat`, `h.badges`, `h.html`.
- Produces: `glance` on those five plugins. Summary headlines: tech `Detected`; html `Elements`; baseline `Features detected`.

- [ ] **Step 1: Write the failing tests** — append to `test/glance.test.mjs`:

```js
test('html glance: semantic share and landmarks', () => {
  const s = G('html', { total: 1000, semantic: 620, generic: 310, landmarks: { header: 1, main: 1, footer: 1 } });
  assert.match(s, /HTML elements · 1,000/);
  assert.match(s, /Semantic/);
  assert.match(s, /<em>62%<\/em>/);
  assert.equal((s.match(/aria-label="fail"/g) || []).length, 1); // no <nav>
});

test('css glance: rule, !important, custom property and palette tiles', () => {
  const s = G('css', { stats: { styleRules: 4210, declarations: 2000, important: 120 }, custom: { defined: 212, used: 180 }, colorCount: 34, fontFamilies: ['a', 'b'] });
  assert.match(s, /4,210/);
  assert.match(s, /6%/);
  assert.match(s, /rating-needs-improvement/);
  assert.match(s, /212/);
});

test('javascript glance: first vs third-party bytes', () => {
  const s = G('javascript', { totals: { count: 12, bytes: 1_000_000, thirdPartyBytes: 580_000 } });
  assert.match(s, /Script bytes/);
  assert.match(s, /Third party/);
});

test('baseline glance: widely / newly / limited', () => {
  const s = G('baseline', { features: [{ baseline: 'widely' }, { baseline: 'widely' }, { baseline: 'newly' }, { baseline: 'limited' }] });
  assert.match(s, /Platform features · 4/);
  assert.match(s, /aria-label="Baseline: Widely available 2, Newly available 1, Limited 1"/);
});

test('tech glance: badges grouped by category', () => {
  const s = G('tech', { technologies: [{ name: 'Shopify', category: 'CMS' }, { name: 'React', category: 'UI', version: '18' }, { name: 'Vue', category: 'UI' }] });
  assert.match(s, /<h4>CMS<\/h4>/);
  assert.match(s, /<h4>UI<\/h4>/);
  assert.match(s, /React 18/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/glance.test.mjs`
Expected: FAIL — `glance is not a function` for `html`.

- [ ] **Step 3: `extension/plugins/html.js`**

In `run`'s summary, add `headline: true` to `Elements`. Add before `export default`:

```js
function glance(r, h) {
  const d = r.data;
  const pct = (n) => `${d.total ? Math.round((n / d.total) * 100) : 0}%`;
  const other = Math.max(0, d.total - d.semantic - d.generic);
  return h.html`<section class="card"><h4>HTML elements · ${d.total.toLocaleString('en-US')}</h4>
    ${h.stackBar({ label: '', segments: [
      { label: 'Semantic', value: d.semantic, display: pct(d.semantic), color: 'var(--c1)' },
      { label: 'div / span', value: d.generic, display: pct(d.generic), color: 'var(--c2)' },
      { label: 'Other', value: other, display: pct(other), color: 'var(--c-other)' },
    ] })}
    <h4>Landmarks</h4>${h.checklist(['header', 'nav', 'main', 'footer'].map((t) => ({ label: `<${t}>`, ok: !!d.landmarks?.[t] })))}
  </section>`;
}
```

Add `glance,` to the default export.

- [ ] **Step 4: `extension/plugins/css.js`**

Add before `export default`:

```js
function glance(r, h) {
  const d = r.data;
  const s = d.stats;
  const pct = s.declarations ? Math.round((s.important / s.declarations) * 1000) / 10 : 0;
  return h.html`<div class="tiles">
    ${h.stat({ label: 'CSS rules', value: s.styleRules.toLocaleString('en-US') })}
    ${h.stat({ label: '!important', value: `${pct}%`, rating: pct <= 2 ? 'good' : pct <= 10 ? 'needs-improvement' : 'poor', note: `${s.important} declarations` })}
    ${h.stat({ label: 'Custom properties', value: d.custom.defined.toLocaleString('en-US'), note: `${d.custom.used} used` })}
    ${h.stat({ label: 'Colours', value: d.colorCount, note: `${d.fontFamilies.length} font families` })}
  </div>`;
}
```

Add `glance,` to the default export.

- [ ] **Step 5: `extension/plugins/javascript.js`**

Add before `export default`:

```js
function glance(r, h) {
  const t = r.data.totals;
  return h.html`<section class="card"><h4>Script bytes · ${t.count} files · ${h.bytes(t.bytes)}</h4>${h.stackBar({ label: '', segments: [
    { label: 'First party', value: t.bytes - t.thirdPartyBytes, display: h.bytes(t.bytes - t.thirdPartyBytes), color: 'var(--c1)' },
    { label: 'Third party', value: t.thirdPartyBytes, display: h.bytes(t.thirdPartyBytes), color: 'var(--c2)' },
  ] })}</section>`;
}
```

Add `glance,` to the default export.

- [ ] **Step 6: `extension/plugins/baseline.js`**

In `run`'s summary, add `headline: true` to `Features detected`. Add before `export default`:

```js
function glance(r, h) {
  const fs = r.data?.features || [];
  const n = (b) => fs.filter((f) => f.baseline === b).length;
  return h.html`<section class="card"><h4>Platform features · ${fs.length}</h4>${h.stackBar({ label: 'Baseline', segments: [
    { label: 'Widely available', value: n('widely'), color: 'var(--c3)' },
    { label: 'Newly available', value: n('newly'), color: 'var(--c4)' },
    { label: 'Limited', value: n('limited'), color: 'var(--c2)' },
  ] })}</section>`;
}
```

Add `glance,` to the default export.

- [ ] **Step 7: `extension/plugins/tech.js`**

In `run`, the `summary` array's first item (`Detected`) gets `headline: true`. Add before `export default`:

```js
function glance(r, h) {
  const groups = new Map();
  for (const t of r.data?.technologies || []) {
    const k = t.category || 'Other';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ name: t.name, version: t.version });
  }
  if (!groups.size) return '';
  return h.html`<section class="card"><h4>Technology stack</h4><div class="tech-groups">${[...groups].map(([cat, list]) => h.html`<div><h4>${cat}</h4>${h.badges(list)}</div>`)}</div></section>`;
}
```

Add `glance,` to the default export.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add extension/plugins/html.js extension/plugins/css.js extension/plugins/javascript.js extension/plugins/baseline.js extension/plugins/tech.js test/glance.test.mjs
git commit -m "Add build glances: markup share, CSS tiles, script bytes, Baseline, stack badges

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Infrastructure glances — dns (request path), whois, well-known

**Files:**
- Modify: `extension/plugins/dns.js`, `whois.js`, `well-known.js`, `ip-intel.js` (headline only)
- Test: `test/glance.test.mjs` (append)

**Interfaces:**
- Consumes: `h.flow`, `h.checklist`, `h.timeline`, `h.html`; the third `glance` argument `ctx = { results, target }` (provided by `renderReport` in Task 10).
- Produces: `glance` on dns, whois, well-known. Summary headlines: dns `Web host (CNAME)`; whois `Registered`; ip-intel `Hosting`.

- [ ] **Step 1: Write the failing tests** — append to `test/glance.test.mjs`:

```js
test('dns glance: request path uses ip-intel when present; DNS posture checklist', () => {
  const data = {
    host: 'www.acme.com', ns: ['ada.ns.cloudflare.com'], ipv4: ['1.1.1.1'], ipv6: [], cnames: [], caa: [], dnssec: false,
    dmarc: { p: 'reject' }, spf: 'v=spf1 -all', providers: { dns: ['Cloudflare'], web: ['Shopify'], mail: ['Google Workspace'], senders: [] },
  };
  const ctx = { results: { 'ip-intel': { status: 'ok', data: { servers: [{ ip: '1.1.1.1', main: true, provider: 'Cloudflare', asn: 13335, geo: { country: 'US' } }] } } }, target: { host: 'www.acme.com' } };
  const s = G('dns', data, ctx);
  assert.equal((s.match(/class="node"/g) || []).length, 4); // domain, web host, server, mail
  assert.match(s, /AS13335/);
  assert.match(s, /Google Workspace/);
  assert.match(s, /DMARC enforced/);
  assert.equal((s.match(/aria-label="fail"/g) || []).length, 3); // IPv6, DNSSEC, CAA
  assert.equal((G('dns', data).match(/class="node"/g) || []).length, 3, 'no ip-intel → no server node');
});

test('whois glance: registration lifetime', () => {
  const s = G('whois', { created: '2012-03-01T00:00:00Z', expires: '2028-03-01T00:00:00Z', ageDays: 5000, daysLeft: 500 });
  assert.match(s, /Registered 2012/);
  assert.match(s, /Expires 2028/);
  assert.equal(G('whois', { created: null, expires: null }), '');
});

test('well-known glance: files checklist', () => {
  const s = G('well-known', { robots: { rules: 2 }, sitemap: { urls: 2 }, security: null, llms: null, manifest: null });
  assert.equal((s.match(/aria-label="pass"/g) || []).length, 2);
  assert.match(s, /security\.txt/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/glance.test.mjs`
Expected: FAIL — `glance is not a function` for `dns`.

- [ ] **Step 3: `extension/plugins/dns.js`**

In `run`'s summary, add `headline: true` to `Web host (CNAME)`. Add before `export default`:

```js
function glance(r, h, { results = {}, target = {} } = {}) {
  const d = r.data;
  const ip = results['ip-intel']?.status === 'ok' ? results['ip-intel'].data : null;
  const server = ip?.servers?.find((s) => s.main);
  const p = d.providers || {};
  const nodes = [
    { title: d.host || target.host, sub: `DNS: ${p.dns?.join(', ') || d.ns?.[0] || 'unknown'}` },
    p.web?.length ? { title: p.web.join(', '), sub: 'web host / CDN' } : null,
    server ? { title: server.provider || server.asName || server.ip, sub: [server.asn && `AS${server.asn}`, server.geo?.country || server.country].filter(Boolean).join(' · ') } : null,
    p.mail?.length ? { title: p.mail.join(', '), sub: 'mail' } : null,
  ];
  const enforced = ['reject', 'quarantine'].includes(d.dmarc?.p);
  return h.html`<div class="glance-grid">
    <section class="card"><h4>Request path</h4>${h.flow(nodes)}</section>
    <section class="card"><h4>DNS posture</h4>${h.checklist([
      { label: `IPv6 (${d.ipv6?.length || 0} addresses)`, ok: !!d.ipv6?.length },
      { label: enforced ? `DMARC enforced (p=${d.dmarc.p})` : 'DMARC enforced', ok: enforced },
      { label: 'SPF record', ok: !!d.spf },
      { label: 'DNSSEC signed', ok: !!d.dnssec },
      { label: 'CAA restricts issuers', ok: !!d.caa?.length },
    ])}</section>
  </div>`;
}
```

Add `glance,` to the default export.

- [ ] **Step 4: `extension/plugins/whois.js`**

In `run`'s summary, add `headline: true` to `Registered`. Add before `export default`:

```js
function glance(r, h) {
  const d = r.data || {};
  if (!d.created || !d.expires) return '';
  const year = (x) => String(x).slice(0, 4);
  return h.html`<section class="card"><h4>Domain lifetime</h4>${h.timeline({
    start: d.created, end: d.expires, startLabel: `Registered ${year(d.created)}`, endLabel: `Expires ${year(d.expires)}`, label: 'Domain registration',
  })}</section>`;
}
```

Add `glance,` to the default export.

- [ ] **Step 5: `extension/plugins/well-known.js`**

Add before `export default`:

```js
function glance(r, h) {
  const d = r.data || {};
  return h.html`<section class="card"><h4>Well-known files</h4>${h.checklist([
    { label: 'robots.txt', ok: !!d.robots },
    { label: 'Sitemap', ok: !!d.sitemap },
    { label: 'security.txt', ok: !!d.security },
  ])}</section>`;
}
```

Add `glance,` to the default export.

- [ ] **Step 6: `extension/plugins/ip-intel.js`**

In `run`'s summary, add `headline: true` to the `Hosting` item.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add extension/plugins/dns.js extension/plugins/whois.js extension/plugins/well-known.js extension/plugins/ip-intel.js test/glance.test.mjs
git commit -m "Add infrastructure glances: request path, DNS posture, domain lifetime, well-known files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `renderReport` — the whole report as one pure function

**Files:**
- Create: `extension/ui/report.js`
- Test: `test/report.test.mjs`

**Interfaces:**
- Consumes: `AREAS, scoreReading, summarize, topFindings, resultArea, pluginArea, VERDICT` (Task 2); `h, renderResult, renderGlance` (Task 5); `html` (Task 1); `screenshotURL` from `core/harplus.js`; `pluginEnabled` from `core/plugin-host.js`; `transferSize, hostOf, resourceType, formatBytes, formatMs, isThirdParty` from `core/har-util.js`.
- Produces (exported from `extension/ui/report.js`):
  - `renderReport(reading, plugins, { scores?, settings = {}, interactive = true }) → string` — markup `<div class="report"><nav class="sidebar">…</nav><div class="panes">…</div></div>` with panes `#overview`, `#area-performance`, `#area-accessibility`, `#area-security`, `#area-build`, `#area-infrastructure`, `#findings`, `#network`, `#screens`, `#notes`. Empty containers for viewer tools: `#findings-tools`, `#network-tools`. Tables in `#findings-table`, `#net-table`.
  - `findingsTable(list) → Raw`
  - `networkTable(reading, rows: [{ e, i }], { limit = 800 }) → Raw`
  - `timeBuckets(entries, n = 12) → number[]`
  - `PANES: string[]` (pane ids in order)

- [ ] **Step 1: Write the failing tests** — create `test/report.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderReport, timeBuckets, PANES, findingsTable } from '../extension/ui/report.js';
import { getPlugins } from '../extension/plugins/index.js';

const FIXTURE = new URL('./fixtures/local-site.har', import.meta.url);
const load = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));

test('fixture reading renders every pane with no undefined/NaN', () => {
  const out = renderReport(load(), getPlugins());
  for (const id of PANES) assert.match(out, new RegExp(`<section class="pane" id="${id}"`), id);
  assert.doesNotMatch(out, /undefined|NaN|Infinity|\[object Object\]/);
  assert.match(out, /class="sidebar"/);
  assert.match(out, /Overall/);
  assert.match(out, /Fix these first/);
  assert.match(out, /id="findings-table"/);
  assert.match(out, /id="net-table"/);
});

test('old reading without area renders (Review Focus 1)', () => {
  const r = load();
  for (const p of Object.values(r.log._harplus.plugins)) delete p.area;
  const out = renderReport(r, getPlugins());
  const a11y = out.slice(out.indexOf('id="area-accessibility"'), out.indexOf('id="area-security"'));
  assert.match(a11y, /id="p-a11y-basics"/, 'a11y-basics panel lives on the Accessibility page');
  assert.doesNotMatch(out, /undefined/);
});

test('error and skipped results do not call glance (Review Focus 2)', () => {
  const r = load();
  r.log._harplus.plugins.network = { id: 'network', name: 'Network', status: 'error', error: 'boom', data: null, findings: [], summary: [] };
  r.log._harplus.plugins.vitals = { id: 'vitals', name: 'Web vitals', status: 'skipped', error: 'no page', data: null, findings: [], summary: [] };
  const out = renderReport(r, getPlugins());
  assert.match(out, /Error — boom/);
  assert.doesNotMatch(out, /chart failed/);
});

test('throwing glance is contained (Review Focus 3)', () => {
  const plugins = getPlugins().map((p) => (p.id === 'security' ? { ...p, glance: () => { throw new Error('bad data'); } } : p));
  const out = renderReport(load(), plugins);
  assert.match(out, /Security: chart failed — bad data/);
  assert.match(out, /id="area-infrastructure"/);
});

test('page strings are escaped (Review Focus 4)', () => {
  const r = load();
  r.log._harplus.target.title = '<script>alert(1)</script>';
  r.log._harplus.plugins.tech.data.technologies.push({ name: '"><img src=x onerror=alert(1)>', category: 'Evil' });
  r.log._harplus.plugins.security.findings.push({ severity: 'high', category: 'security', title: '<b>x</b>' });
  const out = renderReport(r, getPlugins());
  assert.doesNotMatch(out, /<script>alert|<img src=x|<b>x<\/b>/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('empty reading renders (Review Focus 5)', () => {
  const r = { log: { entries: [], pages: [], _harplus: { plugins: {}, target: {}, capture: {}, screenshots: [], capturedAt: '2026-10-09T00:00:00Z' } } };
  const out = renderReport(r, getPlugins());
  assert.doesNotMatch(out, /undefined|NaN|Infinity/);
  assert.match(out, /No areas measured yet/);
  assert.match(out, /No requests recorded/);
  assert.deepEqual(timeBuckets([]), []);
});

test('timeBuckets spreads request starts', () => {
  const e = (ms) => ({ startedDateTime: new Date(1_000_000 + ms).toISOString() });
  assert.deepEqual(timeBuckets([e(0), e(0), e(500), e(1000)], 4), [2, 0, 1, 1]);
});

test('non-interactive report has no notes form', () => {
  const out = renderReport(load(), getPlugins(), { interactive: false });
  assert.doesNotMatch(out, /<form id="notes-form"/);
  assert.match(findingsTable([]).toString(), /No findings match/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/report.test.mjs`
Expected: FAIL — `Cannot find module '.../extension/ui/report.js'`.

- [ ] **Step 3: Create `extension/ui/report.js`**

```js
// The reading report as markup: one pure function shared by the viewer, the standalone HTML export
// and the CLI. No DOM access — reading.js adds filters, dialogs, notes and exports on top.
// Layout: a sidebar plus one pane per section; CSS :target shows the current pane, so the
// exported file navigates without JavaScript.

import {
  AREAS, scoreReading, summarize, topFindings, resultArea, pluginArea, VERDICT,
} from '../core/score.js';
import { screenshotURL } from '../core/harplus.js';
import { pluginEnabled } from '../core/plugin-host.js';
import {
  transferSize, hostOf, resourceType, formatBytes, formatMs, isThirdParty,
} from '../core/har-util.js';
import { html } from './html.js';
import { h, renderResult, renderGlance } from './render.js';

export const PANES = ['overview', ...AREAS.map((a) => `area-${a.id}`), 'findings', 'network', 'screens', 'notes'];
const AREA_LABEL = Object.fromEntries(AREAS.map((a) => [a.id, a.label]));
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hp = (reading) => reading.log._harplus;
const resultsOf = (reading) => hp(reading).plugins || {};
const byId = (plugins, id) => plugins.find((p) => p.id === id);
const rank = (plugins, id) => { const i = plugins.findIndex((p) => p.id === id); return i < 0 ? 999 : i; };

export function timeBuckets(entries, n = 12) {
  const starts = entries.map((e) => Date.parse(e.startedDateTime)).filter(Number.isFinite);
  if (!starts.length) return [];
  const t0 = Math.min(...starts);
  const span = Math.max(1, Math.max(...starts) - t0);
  const out = Array(n).fill(0);
  for (const s of starts) out[Math.min(n - 1, Math.floor(((s - t0) / span) * n))]++;
  return out;
}

/* ---------------------------------------------------------------- sidebar */

function sidebar(reading, scores) {
  const o = scores.overall;
  return html`<nav class="sidebar" aria-label="Report sections">
    <div class="overall-mini">${h.ring({ value: o.score, size: 44, status: o.status, label: 'Overall score' })}<div><b>Overall${o.grade ? ` · ${o.grade}` : ''}</b><small>${count(o.findings, 'finding')}</small></div></div>
    <a href="#overview" data-pane="overview">${h.icon('overview')}Overview</a>
    ${AREAS.map((a) => {
      const s = scores.areas[a.id];
      return html`<a href="#area-${a.id}" data-pane="area-${a.id}">${h.ring({ value: s.score, size: 18, status: s.status, label: a.label, showValue: false })}${a.label}<b>${s.score ?? '—'}</b></a>`;
    })}
    <hr>
    <a href="#findings" data-pane="findings">${h.icon('findings')}All findings<b>${o.findings}</b></a>
    <a href="#network" data-pane="network">${h.icon('network')}Network<b>${reading.log.entries.length}</b></a>
    <a href="#screens" data-pane="screens">${h.icon('screens')}Screens</a>
    <a href="#notes" data-pane="notes">${h.icon('notes')}Notes</a>
  </nav>`;
}

/* --------------------------------------------------------------- overview */

function headlines(reading, plugins, areaId) {
  return Object.values(resultsOf(reading))
    .filter((r) => r.status === 'ok' && resultArea(r, plugins) === areaId)
    .sort((a, b) => rank(plugins, a.id) - rank(plugins, b.id))
    .flatMap((r) => (r.summary || []).filter((s) => s.headline))
    .slice(0, 3);
}

export function findingList(list, { showArea = true } = {}) {
  if (!list.length) return html`<p class="muted">No findings.</p>`;
  return html`<ul class="finding-list">${list.map((f) => html`<li>${h.icon(f.severity, { title: `${f.severity} severity` })}<div><span>${f.title}</span>${f.detail ? html`<small>${f.detail}</small>` : ''}</div><span class="src">${showArea ? AREA_LABEL[f.area] : f.pluginName}</span></li>`)}</ul>`;
}

function areaCard(a, reading, plugins, scores) {
  const worst = topFindings(scores, 1, a.id)[0];
  const keys = headlines(reading, plugins, a.id);
  return html`<article class="card area-card status-${a.status}">
    <div class="top">${h.ring({ value: a.score, size: 44, status: a.status, label: a.label })}<div><h3><a href="#area-${a.id}">${a.label}</a></h3><span class="verdict">${a.grade ? `${a.grade} · ` : ''}${VERDICT[a.status]}</span></div></div>
    ${keys.length ? html`<p class="keys">${keys.map((k) => `${k.label} ${k.value}`).join(' · ')}</p>` : ''}
    ${worst ? html`<p class="worst">${h.icon(worst.severity, { title: `${worst.severity} severity` })}<span>${worst.title}</span></p>` : ''}
    <a class="more" href="#area-${a.id}">Open ${a.label} →</a>
  </article>`;
}

function overviewStats(reading) {
  const entries = reading.log.entries;
  const site = hp(reading).target?.site;
  const bytes = entries.reduce((n, e) => n + transferSize(e), 0);
  const hosts = [...new Set(entries.map((e) => hostOf(e.request.url)))];
  const third = entries.filter((e) => isThirdParty(hostOf(e.request.url), site)).length;
  const r = resultsOf(reading);
  const techs = r.tech?.status === 'ok' ? r.tech.data?.technologies || [] : [];
  const lcp = r.vitals?.status === 'ok' ? r.vitals.data?.lcp?.time : null;
  return html`<div class="tiles stats">
    ${h.stat({ label: 'Requests', value: entries.length.toLocaleString('en-US'), note: `${third} third-party` })}
    ${h.stat({ label: 'Page weight', value: formatBytes(bytes) })}
    ${lcp != null ? h.stat({ label: 'Load (LCP)', value: formatMs(lcp), rating: r.vitals.data.ratings?.lcp }) : ''}
    ${h.stat({ label: 'Hosts contacted', value: hosts.length, note: `${hosts.filter((x) => isThirdParty(x, site)).length} third-party` })}
    ${techs.length ? h.stat({ label: 'Technologies', value: techs.length, note: count(new Set(techs.map((x) => x.category)).size, 'category', 'categories') }) : ''}
    ${entries.length ? h.stat({ label: 'Requests over time', value: h.spark(timeBuckets(entries), { label: 'Requests started over the capture' }) }) : ''}
  </div>`;
}

function findingsByArea(scores) {
  const rows = AREAS.map((a) => {
    const c = scores.areas[a.id].counts;
    return { a, c, total: c.high + c.medium + c.low + c.info };
  });
  const max = Math.max(1, ...rows.map((r) => r.total));
  const sum = (k) => rows.reduce((n, r) => n + r.c[k], 0);
  return html`<div class="area-bars">${rows.map(({ a, c, total }) => html`<div class="row"><span>${a.label}</span><div style="width:${Math.round((total / max) * 100)}%">${total ? h.stackBar({ legend: false, segments: [
    { label: 'High', value: c.high, color: 'var(--st-critical)' },
    { label: 'Medium', value: c.medium, color: 'var(--st-serious)' },
    { label: 'Low / info', value: c.low + c.info, color: 'var(--c1)' },
  ] }) : ''}</div><b>${total}</b></div>`)}</div>
  ${h.legend([
    { label: 'High', value: sum('high'), color: 'var(--st-critical)' },
    { label: 'Medium', value: sum('medium'), color: 'var(--st-serious)' },
    { label: 'Low / info', value: sum('low') + sum('info'), color: 'var(--c1)' },
  ])}`;
}

function builtWith(reading) {
  const tech = resultsOf(reading).tech;
  const techs = tech?.status === 'ok' ? tech.data?.technologies || [] : [];
  return techs.length ? html`<h2>Built with</h2>${h.badges(techs, { limit: 6 })}` : '';
}

function overviewPane(reading, plugins, scores) {
  const r = hp(reading);
  const t = r.target || {};
  const cap = r.capture || {};
  const shots = r.screenshots || [];
  const shot = shots.find((s) => s.kind === 'viewport') || shots.find((s) => s.kind === 'thumbnail');
  const o = scores.overall;
  const when = r.capturedAt ? new Date(r.capturedAt).toLocaleString() : '';
  const facts = [
    when,
    [cap.device || 'desktop', cap.throttle && cap.throttle !== 'none' ? cap.throttle : ''].filter(Boolean).join(' · '),
    `${cap.mode || 'reading'} mode`,
    cap.durationMs ? `${formatMs(cap.durationMs)} capture` : '',
    cap.source ? `imported from ${cap.source}` : '',
    t.url && t.finalUrl && t.url !== t.finalUrl ? `started at ${t.url}` : '',
    ...(r.tags || []).map((x) => `tag: ${x}`),
  ].filter(Boolean);
  return html`<section class="pane" id="overview" aria-labelledby="overview-h">
    <div class="card hero">
      ${shot ? html`<img class="shot" src="${screenshotURL(shot)}" alt="Screenshot of the page" data-zoom="${shot.kind}">` : html`<div class="shot empty-shot">No screenshot</div>`}
      <div class="hero-text">
        <h1 id="overview-h">${t.title || t.host || 'Untitled reading'}</h1>
        <div class="url">${h.link(t.finalUrl || t.url)}</div>
        <p class="narrative">${summarize(scores)}</p>
        <ul class="facts">${facts.map((f) => html`<li>${f}</li>`)}</ul>
        ${cap.warnings?.length ? html`<p class="note">Capture notes: ${cap.warnings.join('; ')}</p>` : ''}
      </div>
      <div class="overall">${h.ring({ value: o.score, size: 104, status: o.status, label: 'Overall score' })}<b>Overall${o.grade ? ` · ${o.grade}` : ''}</b><small>${count(o.findings, 'finding')}</small></div>
    </div>
    <div class="area-cards">${AREAS.map((a) => areaCard(scores.areas[a.id], reading, plugins, scores))}</div>
    ${overviewStats(reading)}
    <div class="two">
      <section class="card"><h2>Fix these first</h2>${findingList(topFindings(scores, 5))}<a class="more" href="#findings">All ${count(o.findings, 'finding')} →</a></section>
      <section class="card"><h2>Findings by area and severity</h2>${findingsByArea(scores)}${builtWith(reading)}</section>
    </div>
  </section>`;
}

/* ------------------------------------------------------------- area panes */

function areaSentence(a, ran) {
  if (a.score == null) return 'Not measured — no plugin in this area ran successfully.';
  const c = a.counts;
  const parts = [c.high && `${c.high} high`, c.medium && `${c.medium} medium`, c.low && `${c.low} low`].filter(Boolean);
  const names = ran.filter((r) => r.status === 'ok').map((r) => r.name).join(', ');
  const verdict = VERDICT[a.status];
  return `${verdict[0].toUpperCase()}${verdict.slice(1)}. ${parts.length ? `${parts.join(', ')} severity findings` : 'No findings above info'}${names ? ` from ${names}` : ''}.`;
}

function scoringDetails(a) {
  if (a.score == null) return '';
  const deducted = a.deductions.filter((d) => d.points);
  return html`<details class="scoring"><summary>How is this scored?</summary>
    <p>The findings score starts at 100 and each finding deducts points — high 15, medium 6, low 2, info 0 — capped at 60, 30 and 15 per severity.${a.inputs.length > 1 ? ' It is averaged 50/50 with the measured metric below.' : ''}</p>
    ${h.table(a.inputs.map((i) => ({ input: i.label, score: i.score })), [{ key: 'input', label: 'Input' }, { key: 'score', label: 'Score' }])}
    ${deducted.length ? h.table(deducted.map((d) => ({ finding: d.finding.title, severity: d.finding.severity, points: `−${d.points}` })), [
      { key: 'finding', label: 'Finding' }, { key: 'severity', label: 'Severity' }, { key: 'points', label: 'Points' },
    ]) : ''}
  </details>`;
}

function glances(ran, plugins, reading) {
  const ctx = { results: resultsOf(reading), target: hp(reading).target || {} };
  const tiles = [];
  const charts = [];
  for (const r of ran) {
    if (r.status !== 'ok') continue;
    const p = byId(plugins, r.id);
    if (p?.glance && !p.remote) charts.push(renderGlance(p, r, ctx));
    else tiles.push(...(r.summary || []).filter((s) => s.rating).map((s) => h.stat({ label: s.label, value: s.value, rating: s.rating })));
  }
  return html`${tiles.length ? html`<div class="tiles">${tiles}</div>` : ''}${charts.map((c) => html`<div class="glance">${c}</div>`)}`;
}

function pluginPanel(r, plugins) {
  return html`<details class="plugin" id="p-${r.id}">
    <summary>
      <span class="status-dot status-${r.status}" title="${r.status}"></span>
      <span class="name">${r.name}</span>
      ${r.findings?.length ? html`<span class="muted">${count(r.findings.length, 'finding')}</span>` : ''}
      <span class="meta">${r.status} · ${formatMs(r.durationMs)}${r.contacted?.length ? ` · contacted ${r.contacted.map((c) => `${c.host} ×${c.count}`).join(', ')}` : ''}</span>
    </summary>
    <div class="content">
      ${renderResult(byId(plugins, r.id), r)}
      ${r.data != null ? html`<details class="raw" data-raw="${r.id}"><summary>Raw data</summary></details>` : ''}
    </div>
  </details>`;
}

function areaPane(area, reading, plugins, scores, settings) {
  const a = scores.areas[area.id];
  const ran = Object.values(resultsOf(reading))
    .filter((r) => resultArea(r, plugins) === area.id)
    .sort((x, y) => rank(plugins, x.id) - rank(plugins, y.id));
  const notRun = plugins.filter((p) => pluginArea(p) === area.id && !resultsOf(reading)[p.id]);
  const list = topFindings(scores, Infinity, area.id, { includeInfo: true });
  return html`<section class="pane" id="area-${area.id}" aria-labelledby="area-${area.id}-h">
    <div class="card area-head">
      ${h.ring({ value: a.score, size: 72, status: a.status, label: area.label })}
      <div><h1 id="area-${area.id}-h">${area.label} ${a.grade ? html`<span class="grade status-${a.status}">${a.grade}</span>` : ''}</h1>
        <p>${areaSentence(a, ran)}</p>${scoringDetails(a)}</div>
    </div>
    ${glances(ran, plugins, reading)}
    <section class="card"><h2>Findings · ${list.length}</h2>${findingList(list.slice(0, 8), { showArea: false })}${list.length > 8 ? html`<a class="more" href="#findings">All findings →</a>` : ''}</section>
    <section class="plugin-detail"><h2>Plugin detail</h2>
      ${ran.length ? ran.map((r) => pluginPanel(r, plugins)) : html`<p class="muted">No plugins in this area ran.</p>`}
      ${notRun.length ? html`<p class="note">Not run: ${notRun.map((p) => `${p.name}${pluginEnabled(p, settings) ? '' : ' (disabled)'}`).join(', ')}. Enable plugins in the popup or Options, then re-run.</p>` : ''}
    </section>
  </section>`;
}

/* ------------------------------------------------- findings, network, … */

export function findingsTable(list) {
  if (!list.length) return html`<p class="muted">No findings match.</p>`;
  return html`<div class="table-wrap findings"><table class="data">
    <thead><tr><th scope="col">Severity</th><th scope="col">Area</th><th scope="col">Finding</th><th scope="col">Source</th></tr></thead>
    <tbody>${list.map((f) => html`<tr>
      <td><span class="sev sev-${f.severity}">${h.icon(f.severity)}${f.severity}</span></td>
      <td>${AREA_LABEL[f.area] || ''}</td>
      <td>${f.title}${f.detail ? html`<div class="detail">${f.detail}</div>` : ''}
        ${f.evidence ? html`<details><summary>evidence</summary><pre>${typeof f.evidence === 'string' ? f.evidence : JSON.stringify(f.evidence, null, 2)}</pre></details>` : ''}
        ${f.ref ? html`<div class="detail">${h.link(f.ref, 'reference')}</div>` : ''}</td>
      <td><a href="#p-${f.plugin}">${f.pluginName}</a></td>
    </tr>`)}</tbody></table></div>`;
}

export function networkTable(reading, rows, { limit = 800 } = {}) {
  const entries = reading.log.entries;
  if (!entries.length) return html`<p class="muted">No requests recorded.</p>`;
  const site = hp(reading).target?.site;
  const starts = entries.map((e) => Date.parse(e.startedDateTime));
  const t0 = Math.min(...starts);
  const end = Math.max(1, ...entries.map((e, i) => starts[i] - t0 + Math.max(0, e.time || 0)));
  const pct = (n) => Math.max(0, Math.min(100, (n / end) * 100)).toFixed(2);
  const shown = rows.slice(0, limit);
  return html`<p class="note">${rows.length} of ${entries.length} requests · span ${formatMs(end)}${rows.length > shown.length ? ` · showing first ${shown.length}` : ''} · orange bars are third-party</p>
    <div class="table-wrap net"><table class="data">
      <thead><tr><th scope="col">#</th><th scope="col">Status</th><th scope="col">Method</th><th scope="col">Type</th><th scope="col">URL</th><th scope="col">Size</th><th scope="col">Time</th><th scope="col">Waterfall</th></tr></thead>
      <tbody>${shown.map(({ e, i }) => {
        const host = hostOf(e.request.url);
        let path = e.request.url;
        try { const u = new URL(e.request.url); path = u.pathname + u.search; } catch { /* keep raw */ }
        const bad = e._error || e.response.status >= 400 || e.response.status === 0;
        return html`<tr data-entry="${i}" tabindex="0">
          <td class="num">${i + 1}</td>
          <td class="num ${bad ? 'status-err' : ''}">${e._error ? 'ERR' : e.response.status || '—'}</td>
          <td>${e.request.method}</td>
          <td>${resourceType(e)}</td>
          <td class="url" title="${e.request.url}">${host}<span class="muted">${path.slice(0, 90)}</span></td>
          <td class="num">${formatBytes(transferSize(e))}</td>
          <td class="num">${formatMs(e.time)}</td>
          <td><div class="wf"><span class="${isThirdParty(host, site) ? 'third' : ''}" style="left:${pct(starts[i] - t0)}%;width:${pct(Math.max(0, e.time || 0))}%"></span></div></td>
        </tr>`;
      })}</tbody>
    </table></div>`;
}

function findingsPane(scores) {
  return html`<section class="pane" id="findings" aria-labelledby="findings-h">
    <header class="pane-head"><h1 id="findings-h">All findings</h1><div class="tools" id="findings-tools"></div></header>
    <div id="findings-table">${findingsTable(topFindings(scores, Infinity, null, { includeInfo: true }))}</div>
  </section>`;
}

function networkPane(reading, plugins) {
  const net = resultsOf(reading).network;
  const p = byId(plugins, 'network');
  return html`<section class="pane" id="network" aria-labelledby="network-h">
    <header class="pane-head"><h1 id="network-h">Network</h1><div class="tools" id="network-tools"></div></header>
    ${net?.status === 'ok' && p ? renderGlance(p, net, { results: resultsOf(reading), target: hp(reading).target || {} }) : ''}
    <div id="net-table">${networkTable(reading, reading.log.entries.map((e, i) => ({ e, i })))}</div>
  </section>`;
}

function screensPane(reading) {
  const shots = (hp(reading).screenshots || []).filter((s) => s.kind !== 'thumbnail');
  return html`<section class="pane" id="screens" aria-labelledby="screens-h"><h1 id="screens-h">Screens</h1>
    ${shots.length ? html`<div class="shots">${shots.map((s) => html`<figure>
      <div class="frame"><img src="${screenshotURL(s)}" alt="${s.kind === 'fullpage' ? 'Full-page' : 'Viewport'} screenshot" data-zoom="${s.kind}" loading="lazy"></div>
      <figcaption>${s.kind === 'fullpage' ? 'Full page' : 'Viewport'} · ${s.cssWidth}×${s.cssHeight} CSS px · ${s.dpr}× DPR${s.truncated ? ' · truncated' : ''}</figcaption>
    </figure>`)}</div>` : html`<p class="muted">No screenshots in this reading.</p>`}
  </section>`;
}

function notesPane(reading, interactive) {
  const r = hp(reading);
  const body = interactive
    ? html`<form id="notes-form" class="notes card">
        <label>Tags <input type="text" name="tags" value="${(r.tags || []).join(', ')}" placeholder="prospect, competitor, audit-q4" style="width:100%"></label>
        <label>Notes <textarea name="notes" placeholder="What did you learn from this reading?">${r.notes || ''}</textarea></label>
        <div><button class="btn primary" type="submit">Save notes</button></div>
      </form>`
    : html`<div class="card notes">${r.tags?.length ? html`<div>${h.tags(r.tags)}</div>` : ''}${r.notes ? html`<p style="white-space:pre-wrap">${r.notes}</p>` : html`<p class="muted">No notes.</p>`}</div>`;
  return html`<section class="pane" id="notes" aria-labelledby="notes-h"><h1 id="notes-h">Notes &amp; tags</h1>${body}</section>`;
}

/* ------------------------------------------------------------------ main */

export function renderReport(reading, plugins, { scores = scoreReading(reading, plugins), settings = {}, interactive = true } = {}) {
  return String(html`<div class="report">
    ${sidebar(reading, scores)}
    <div class="panes">
      ${overviewPane(reading, plugins, scores)}
      ${AREAS.map((a) => areaPane(a, reading, plugins, scores, settings))}
      ${findingsPane(scores)}
      ${networkPane(reading, plugins)}
      ${screensPane(reading)}
      ${notesPane(reading, interactive)}
    </div>
  </div>`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/report.test.mjs`
Expected: PASS. If `fixture reading renders … no undefined` fails, print the surrounding text (`out.slice(out.indexOf('undefined') - 200, out.indexOf('undefined') + 50)`) and fix the producing helper — do not loosen the assertion.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/ui/report.js test/report.test.mjs
git commit -m "Add renderReport: sidebar, overview, area panes, findings, network, screens, notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Wire the viewer — reading page, layout CSS, print, library ring

**Files:**
- Modify: `extension/ui/reading.html` (replace the `<header class="appbar">…</header>` block)
- Rewrite: `extension/ui/reading.js`
- Modify: `extension/ui/theme.css` (`@layer pages`: replace the reading-page rules; add report layout and print rules)
- Modify: `extension/ui/library.js` (`card()`)
- Test: manual check in Step 6 plus e2e in Task 13

**Interfaces:**
- Consumes: `renderReport, findingsTable, networkTable, PANES` (Task 10); `scoreReading, AREAS, topFindings` (Task 2). The standalone-report menu item and its export branch are added in Task 12.
- Produces: the interactive reading page.

- [ ] **Step 1: Replace the app bar in `extension/ui/reading.html`**

Replace the whole `<header class="appbar">…</header>` element with:

```html
  <header class="appbar">
    <a class="brand" href="library.html"><img src="../icons/icon-32.png" alt=""> HAR<small>+</small></a>
    <span class="appbar-title" id="appbar-title"></span>
    <div class="actions">
      <button class="btn" id="rerun" type="button" title="Re-run offline analysis and lookups with current plugins and settings">Re-run analysis</button>
      <button class="btn" type="button" popovertarget="export-menu">Export ▾</button>
      <div id="export-menu" popover class="menu">
        <button type="button" data-export="print">Print or save as PDF</button>
        <button type="button" data-export="full">HAR-PLUS file (everything)</button>
        <button type="button" data-export="lite">HAR-PLUS file (no bodies, thumbnail only)</button>
        <button type="button" data-export="markdown">Markdown brief (.md)</button>
        <button type="button" data-export="copy">Copy brief to clipboard</button>
      </div>
      <button class="btn danger" id="delete" type="button">Delete</button>
    </div>
  </header>
```

- [ ] **Step 2: Rewrite `extension/ui/reading.js`**

```js
import { getReading, saveReading, deleteReading } from '../browser/store.js';
import { getSettings } from '../browser/settings.js';
import { getPlugins } from '../plugins/index.js';
import { runPlugins } from '../core/plugin-host.js';
import { toMarkdown, stripForSharing, screenshotURL } from '../core/harplus.js';
import { hostOf, resourceType, formatBytes, formatMs, transferSize, isThirdParty, SEVERITIES } from '../core/har-util.js';
import { AREAS, scoreReading, topFindings } from '../core/score.js';
import { html, h, toast, download, fileStem } from './render.js';
import { renderReport, findingsTable, networkTable, PANES } from './report.js';

const $ = (s) => document.querySelector(s);
const id = new URLSearchParams(location.search).get('id');
const state = { sev: new Set(SEVERITIES), area: '', category: '', q: '', netQ: '', netType: '', netParty: '' };
let reading;
let plugins;
let settings;
let scores;

const hp = () => reading.log._harplus;

/* --------------------------------------------------------------- render */

function findingTools() {
  const cats = [...new Set(topFindings(scores, Infinity, null, { includeInfo: true }).map((f) => f.category))].sort();
  return html`
    <div class="chips" role="group" aria-label="Severity">${SEVERITIES.map((s) => html`<button type="button" class="chip" data-sev="${s}" aria-pressed="${String(state.sev.has(s))}"><span class="sev sev-${s}">${h.icon(s)}${s}</span></button>`)}</div>
    <select id="f-area" aria-label="Area"><option value="">All areas</option>${AREAS.map((a) => html`<option value="${a.id}" ${a.id === state.area ? 'selected' : ''}>${a.label}</option>`)}</select>
    <select id="f-cat" aria-label="Category"><option value="">All categories</option>${cats.map((c) => html`<option ${c === state.category ? 'selected' : ''}>${c}</option>`)}</select>
    <input type="search" id="f-q" placeholder="Filter findings" aria-label="Filter findings" value="${state.q}">`;
}

function netTools() {
  const types = ['document', 'script', 'stylesheet', 'image', 'font', 'xhr', 'media', 'other'];
  return html`
    <input type="search" id="n-q" placeholder="Filter URLs" aria-label="Filter requests" value="${state.netQ}">
    <select id="n-type" aria-label="Type"><option value="">All types</option>${types.map((t) => html`<option ${t === state.netType ? 'selected' : ''}>${t}</option>`)}</select>
    <select id="n-party" aria-label="Party">${[['', 'First & third party'], ['first', 'First party'], ['third', 'Third party']].map(([v, l]) => html`<option value="${v}" ${v === state.netParty ? 'selected' : ''}>${l}</option>`)}</select>`;
}

function renderFindings() {
  const list = topFindings(scores, Infinity, null, { includeInfo: true }).filter((f) => state.sev.has(f.severity) &&
    (!state.area || f.area === state.area) &&
    (!state.category || f.category === state.category) &&
    (!state.q || `${f.title} ${f.detail || ''} ${f.pluginName}`.toLowerCase().includes(state.q)));
  $('#findings-table').innerHTML = String(findingsTable(list));
}

function renderNetwork() {
  const site = hp().target?.site;
  const rows = reading.log.entries.map((e, i) => ({ e, i })).filter(({ e }) => {
    const host = hostOf(e.request.url);
    return (!state.netQ || e.request.url.toLowerCase().includes(state.netQ)) &&
      (!state.netType || resourceType(e) === state.netType) &&
      (!state.netParty || (state.netParty === 'third') === isThirdParty(host, site));
  });
  $('#net-table').innerHTML = String(networkTable(reading, rows));
}

function markActive() {
  const target = location.hash.slice(1);
  const pane = PANES.includes(target) ? target : document.getElementById(target)?.closest('.pane')?.id || 'overview';
  for (const a of document.querySelectorAll('.sidebar a[data-pane]')) {
    if (a.dataset.pane === pane) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function render() {
  const t = hp().target || {};
  document.title = `${t.title || t.host || 'Reading'} — HAR-PLUS`;
  $('#appbar-title').textContent = [t.title || t.host, t.host, hp().capturedAt && new Date(hp().capturedAt).toLocaleDateString()].filter(Boolean).join(' · ');
  scores = scoreReading(reading, plugins);
  $('#app').innerHTML = renderReport(reading, plugins, { scores, settings, interactive: true });
  $('#findings-tools').innerHTML = String(findingTools());
  $('#network-tools').innerHTML = String(netTools());
  renderFindings();
  renderNetwork();
  markActive();
}

/* -------------------------------------------------------------- dialogs */

function openDialog(title, body) {
  $('#dlg-title').textContent = title;
  $('#dlg-body').innerHTML = String(body);
  $('#dlg').showModal();
}

function entryDetail(e) {
  const headerRows = (hs) => (hs || []).map((x) => ({ name: x.name, value: x.value }));
  const c = e.response.content || {};
  let body = '';
  if (c.text && c.encoding === 'base64' && /^image\//.test(c.mimeType)) body = html`<img src="data:${c.mimeType};base64,${c.text}" alt="Response image" style="max-width:100%">`;
  else if (c.text && c.encoding !== 'base64') body = html`<pre class="json">${c.text.slice(0, 100_000)}${c.text.length > 100_000 ? '\n… (truncated)' : ''}</pre>`;
  return html`
    ${h.kv([
      ['URL', e.request.url], ['Method', e.request.method],
      ['Status', `${e.response.status} ${e.response.statusText || ''}`.trim()], ['Error', e._error],
      ['Protocol', e.response.httpVersion], ['Server', [e.serverIPAddress, e._remotePort].filter(Boolean).join(':')],
      ['Type', e._resourceType], ['MIME', c.mimeType], ['Priority', e._priority],
      ['Initiator', e._initiator ? [e._initiator.type, e._initiator.url].filter(Boolean).join(' ') : ''],
      ['Cache', e._fromCache], ['Service worker', e._fromServiceWorker], ['Target', e._target],
      ['Transferred', formatBytes(transferSize(e))], ['Decoded', formatBytes(c.size)],
      ['Started', e.startedDateTime], ['Time', formatMs(e.time)], ['Synthetic', e._synthetic],
    ])}
    ${h.sub('Timings (ms)', h.kv(Object.entries(e.timings || {}).map(([k, v]) => [k, v < 0 ? '—' : v])))}
    ${h.sub('Request headers', h.table(headerRows(e.request.headers), ['name', 'value']))}
    ${h.sub('Response headers', h.table(headerRows(e.response.headers), ['name', 'value']))}
    ${h.sub('Query string', h.table(e.request.queryString || [], ['name', 'value']))}
    ${h.sub('Request cookies', h.table(e.request.cookies || [], ['name', 'value']))}
    ${h.sub('Response cookies', h.table(e.response.cookies || [], ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite']))}
    ${e.request.postData ? h.sub('Request body', html`<pre class="json">${e.request.postData.text}</pre>`) : ''}
    ${body ? h.sub('Response body', body) : ''}`;
}

/* --------------------------------------------------------------- events */

document.addEventListener('click', async (ev) => {
  const t = ev.target;
  const zoom = t.closest('[data-zoom]');
  if (zoom) {
    const shot = hp().screenshots.find((s) => s.kind === zoom.dataset.zoom);
    openDialog(zoom.dataset.zoom === 'fullpage' ? 'Full-page screenshot' : 'Viewport screenshot',
      html`<img src="${screenshotURL(shot)}" alt="Screenshot" style="width:100%">`);
    return;
  }
  const row = t.closest('tr[data-entry]');
  if (row) {
    const e = reading.log.entries[Number(row.dataset.entry)];
    openDialog(e.request.url, entryDetail(e));
    return;
  }
  const sevToggle = t.closest('[data-sev]');
  if (sevToggle) {
    const s = sevToggle.dataset.sev;
    if (state.sev.has(s)) state.sev.delete(s); else state.sev.add(s);
    sevToggle.setAttribute('aria-pressed', String(state.sev.has(s)));
    renderFindings();
    return;
  }
  const exp = t.closest('[data-export]');
  if (exp) {
    $('#export-menu').hidePopover();
    const stem = fileStem(reading);
    const kind = exp.dataset.export;
    if (kind === 'print') window.print();
    if (kind === 'full') download(`${stem}.har`, JSON.stringify(reading));
    if (kind === 'lite') download(`${stem}.lite.har`, JSON.stringify(stripForSharing(reading)));
    if (kind === 'markdown') download(`${stem}.md`, toMarkdown(reading), 'text/markdown');
    if (kind === 'copy') { await navigator.clipboard.writeText(toMarkdown(reading)); toast('Brief copied'); }
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.matches?.('tr[data-entry]')) ev.target.click();
});

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'f-q') { state.q = t.value.trim().toLowerCase(); renderFindings(); }
  if (t.id === 'n-q') { state.netQ = t.value.trim().toLowerCase(); renderNetwork(); }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.id === 'f-area') { state.area = t.value; renderFindings(); }
  if (t.id === 'f-cat') { state.category = t.value; renderFindings(); }
  if (t.id === 'n-type') { state.netType = t.value; renderNetwork(); }
  if (t.id === 'n-party') { state.netParty = t.value; renderNetwork(); }
});

// Fill raw JSON lazily — some plugin data is large.
document.addEventListener('toggle', (ev) => {
  const d = ev.target;
  if (d.matches?.('details[data-raw]') && d.open && !d.dataset.filled) {
    d.insertAdjacentHTML('beforeend', String(h.json(hp().plugins[d.dataset.raw]?.data)));
    d.dataset.filled = '1';
  }
}, true);

document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'notes-form') return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  hp().tags = String(f.get('tags') || '').split(',').map((s) => s.trim()).filter(Boolean);
  hp().notes = String(f.get('notes') || '');
  await saveReading(reading);
  toast('Notes saved');
});

window.addEventListener('hashchange', markActive);

// Print every pane with plugin detail expanded; restore afterwards.
let opened = [];
window.addEventListener('beforeprint', () => {
  opened = [...document.querySelectorAll('details.plugin:not([open])')];
  for (const d of opened) d.open = true;
});
window.addEventListener('afterprint', () => { for (const d of opened) d.open = false; opened = []; });

$('#dlg-close').addEventListener('click', () => $('#dlg').close());

$('#rerun').addEventListener('click', async () => {
  const btn = $('#rerun');
  btn.disabled = true;
  settings = await getSettings();
  plugins = getPlugins(settings);
  await runPlugins(reading, plugins, {
    phases: ['analyze', 'enrich'],
    settings,
    onProgress: (p) => { btn.textContent = `${p.name}…`; },
  });
  await saveReading(reading);
  btn.textContent = 'Re-run analysis';
  btn.disabled = false;
  render();
  toast('Analysis updated');
});

$('#delete').addEventListener('click', async () => {
  const btn = $('#delete');
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Confirm delete';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete'; }, 4000);
    return;
  }
  await deleteReading(id);
  location.href = 'library.html';
});

async function init() {
  settings = await getSettings();
  plugins = getPlugins(settings);
  reading = id ? await getReading(id) : null;
  if (!reading) {
    $('#app').innerHTML = '<p class="empty">Reading not found. <a href="library.html">Back to readings</a></p>';
    return;
  }
  render();
}

init();
```

- [ ] **Step 3: Update `extension/ui/theme.css` (`@layer pages`)**

1. In the `/* ---------- reading ---------- */` section, **delete** these rules: `.reading main { … }`; replace `.reading main > *, section.block > *, .hero > *, details.plugin > .content > * { min-width: 0; }` with `details.plugin > .content > * { min-width: 0; }`; delete the `@media (max-width: 600px)` block's `.reading main` selector (keep `.library main` and `.appbar` in it), every `.hero …` rule, the `@media (max-width: 700px) { .hero … }` block, `section.block …` rules, every `.readout …` rule and the `h3.readout-group` rules.
2. In `@layer components`, change `.sev::before { … }` to only apply when there is no icon: `.sev:not(:has(.icon))::before { … }` (same declarations).
3. Append inside `@layer pages`, after the remaining reading rules:

```css
  /* ---------- reading report (sidebar layout) ---------- */
  .reading main { padding: 0; }
  .appbar-title { color: var(--muted); font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 10rem; }
  .report { display: grid; grid-template-columns: 15rem minmax(0, 1fr); min-height: calc(100vh - 3rem); }
  .sidebar { position: sticky; top: 3rem; align-self: start; height: calc(100vh - 3rem); overflow-y: auto; display: grid; align-content: start; gap: 0.1rem; padding: 0.9rem 0.6rem; background: var(--panel); border-inline-end: 1px solid var(--line); }
  .sidebar .overall-mini { display: flex; align-items: center; gap: 0.6rem; padding: 0.2rem 0.5rem 0.8rem; }
  .sidebar .overall-mini b { display: block; font-size: 0.85rem; }
  .sidebar .overall-mini small { color: var(--muted); font-size: 0.75rem; }
  .sidebar a { display: flex; align-items: center; gap: 0.55rem; padding: 0.4rem 0.55rem; border-radius: 6px; color: var(--text); text-decoration: none; font-size: 0.85rem; }
  .sidebar a:hover { background: var(--panel-2); }
  .sidebar a[aria-current="page"] { background: var(--panel-2); box-shadow: inset 3px 0 0 var(--accent); font-weight: 600; }
  .sidebar a b { margin-inline-start: auto; color: var(--muted); font-size: 0.78rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .sidebar hr { border: 0; border-top: 1px solid var(--line); margin: 0.5rem 0; width: 100%; }
  .panes { padding: 1.25rem; max-width: 1200px; width: 100%; margin-inline: auto; min-width: 0; }
  .pane { display: none; gap: 1rem; scroll-margin-top: 4rem; }
  .pane:target, .pane:has(:target), .panes:not(:has(:target)) > #overview { display: grid; }
  .pane > * { min-width: 0; }
  .pane h1 { font-size: 1.3rem; line-height: 1.25; text-wrap: balance; }
  .pane h2 { margin-bottom: 0.6rem; }
  .pane-head { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .pane-head .tools { margin-inline-start: auto; display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  .hero { display: grid; grid-template-columns: minmax(0, 240px) minmax(0, 1fr) auto; gap: 1.25rem; align-items: center; }
  .hero .shot { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; object-position: top; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2); cursor: zoom-in; }
  .hero .empty-shot { display: grid; place-items: center; color: var(--muted); cursor: default; }
  .hero .url { font: 0.85rem var(--mono); overflow-wrap: anywhere; }
  .hero .narrative { margin-top: 0.5rem; color: var(--muted); max-width: 60ch; }
  .hero ul.facts { list-style: none; padding: 0; margin: 0.6rem 0 0; display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .hero ul.facts li { font-size: 0.75rem; padding: 0.1rem 0.55rem; border-radius: 999px; background: var(--panel-2); color: var(--muted); }
  .hero .overall { display: grid; justify-items: center; gap: 0.2rem; padding-inline: 0.5rem; }
  .hero .overall small, .area-card .verdict { color: var(--muted); font-size: 0.78rem; }
  .area-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: 0.75rem; }
  .area-card { display: grid; gap: 0.5rem; align-content: start; border-top: 3px solid var(--st-none); }
  .area-card.status-good { border-top-color: var(--st-good); }
  .area-card.status-warning { border-top-color: var(--st-warning); }
  .area-card.status-serious { border-top-color: var(--st-serious); }
  .area-card.status-critical { border-top-color: var(--st-critical); }
  .area-card .top { display: flex; align-items: center; gap: 0.6rem; }
  .area-card h3 a { color: inherit; text-decoration: none; }
  .area-card .keys { font-size: 0.8rem; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .area-card .worst { display: flex; gap: 0.4rem; align-items: flex-start; font-size: 0.8rem; border-top: 1px solid var(--line); padding-top: 0.45rem; }
  a.more { display: inline-block; justify-self: start; margin-top: 0.4rem; font-size: 0.8rem; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr)); gap: 0.75rem; }
  .two, .glance-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); gap: 0.75rem; align-items: start; }
  .glance { display: grid; gap: 0.75rem; }
  .glance .card > h4:first-child { margin-top: 0; }
  .tech-groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr)); gap: 0 1rem; }
  ul.finding-list { list-style: none; padding: 0; margin: 0; }
  ul.finding-list li { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 0.55rem; align-items: start; padding: 0.5rem 0; border-top: 1px solid var(--line); font-size: 0.85rem; }
  ul.finding-list li:first-child { border-top: 0; }
  ul.finding-list small { display: block; color: var(--muted); font-size: 0.78rem; }
  ul.finding-list .src { font-size: 0.72rem; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 0.5rem; white-space: nowrap; }
  .area-bars { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr) auto; gap: 0.4rem 0.6rem; align-items: center; font-size: 0.8rem; }
  .area-bars .row { display: contents; }
  .area-bars .stackbar .bar { height: 10px; }
  .area-bars b { font-variant-numeric: tabular-nums; }
  .area-head { display: flex; align-items: center; gap: 1rem; }
  .area-head p { color: var(--muted); margin-top: 0.2rem; }
  .grade { font-size: 0.8rem; font-weight: 600; padding: 0.1rem 0.45rem; border-radius: 4px; vertical-align: 0.15em; background: var(--panel-2); }
  .grade.status-good { color: var(--ink-good); }
  .grade.status-warning { color: var(--ink-warning); }
  .grade.status-serious { color: var(--ink-serious); }
  .grade.status-critical { color: var(--ink-critical); }
  details.scoring { margin-top: 0.4rem; font-size: 0.82rem; }
  details.scoring summary { cursor: pointer; color: var(--accent); }
  details.scoring > * + * { margin-top: 0.5rem; }
  .ring-row { display: flex; flex-wrap: wrap; align-items: center; gap: 1.25rem; }
  figure.ring-fig { margin: 0; display: grid; justify-items: center; gap: 0.25rem; font-size: 0.78rem; color: var(--muted); }
  .plugin-detail { display: grid; gap: 0.5rem; }
  .card-score { position: absolute; top: 0.5rem; right: 0.5rem; background: var(--panel); border-radius: 50%; padding: 2px; box-shadow: 0 1px 4px rgb(0 0 0 / 0.2); }
  @media (max-width: 900px) {
    .report { grid-template-columns: 1fr; }
    .sidebar { position: static; height: auto; display: flex; overflow-x: auto; gap: 0.25rem; padding: 0.5rem; border-inline-end: 0; border-bottom: 1px solid var(--line); }
    .sidebar .overall-mini, .sidebar hr { display: none; }
    .sidebar a { flex: none; white-space: nowrap; }
    .hero { grid-template-columns: 1fr; }
    .panes { padding: 1rem; }
  }
  @media print {
    :root { color-scheme: light; }
    body { background: #fff; }
    .appbar, .sidebar, .pane-head .tools, details.raw, details.scoring, dialog, [popover] { display: none !important; }
    .report { display: block; }
    .panes { padding: 0; max-width: none; }
    .pane, .panes:not(:has(:target)) > #overview { display: grid !important; }
    .pane + .pane { break-before: page; }
    .card, figure, .area-card, ul.finding-list li, table.data tr { break-inside: avoid; }
    .table-wrap { overflow: visible; }
    .net tbody tr:nth-child(n + 51) { display: none; }
    .net::after { content: "Printed copy shows the first 50 requests."; display: block; padding: 0.5rem; font-size: 0.8rem; color: #555; }
    .hero .shot { cursor: default; }
  }
```

- [ ] **Step 4: Library card ring — `extension/ui/library.js`**

Change the import from `./render.js` to `import { html, h, toast } from './render.js';` and, in `card(r)`, insert this line directly after the `${r.thumb ? … }` screenshot line:

```js
    ${r.score != null ? html`<div class="card-score">${h.ring({ value: r.score, size: 40, status: r.status, label: 'Overall score' })}</div>` : ''}
```

- [ ] **Step 5: Run unit tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Manual check in Chrome**

Load `extension/` unpacked (chrome://extensions → Reload), take a reading of any public site, open it. Check: the sidebar switches panes and highlights the current one; the overview shows the hero, five area cards, stat tiles, "Fix these first", the area bars and "Built with"; every area pane shows header, glances, findings, plugin detail; the Findings filters (severity, area, category, text) and the Network filters work; clicking a network row opens the dialog; Print preview (Export → Print or save as PDF) shows all panes with page breaks and no sidebar; dark mode (DevTools → Rendering → prefers-color-scheme: dark) is legible; narrow the window below 900 px and the sidebar becomes a scrolling strip. Fix anything that looks wrong before committing.

- [ ] **Step 7: Commit**

```bash
git add extension/ui/reading.html extension/ui/reading.js extension/ui/theme.css extension/ui/library.js
git commit -m "Wire the sidebar report into the reading page; print stylesheet; library score ring

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Standalone HTML report — viewer export and CLI `--report`

**Files:**
- Modify: `extension/ui/report.js` (append `standaloneDocument`)
- Modify: `extension/ui/reading.html` (menu item), `extension/ui/reading.js` (export branch)
- Modify: `cli/harplus.mjs` (`--report` option on `analyze` and `summary`; usage text)
- Test: `test/report.test.mjs` (append), `test/cli.test.mjs` (append)

**Interfaces:**
- Consumes: `renderReport` (Task 10); `esc` from `ui/html.js`; `scoreReading` (Task 2).
- Produces: `standaloneDocument(reading, plugins, { css = '', scores? }) → string` — a complete HTML document, `<body class="reading standalone">`, `theme.css` inlined, no `<script>`. Files named `<stem>.report.html`.

- [ ] **Step 1: Write the failing tests**

Append to `test/report.test.mjs`:

```js
import { standaloneDocument } from '../extension/ui/report.js';

test('standalone document: inlined css, no scripts, escaped title', () => {
  const r = load();
  r.log._harplus.target.title = '</title><script>x</script>';
  const doc = standaloneDocument(r, getPlugins(), { css: '.x{color:red}' });
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /<style>\.x\{color:red\}<\/style>/);
  assert.doesNotMatch(doc, /<script/i);
  assert.match(doc, /<title>&lt;\/title&gt;&lt;script&gt;x&lt;\/script&gt; — HAR-PLUS report<\/title>/);
  assert.match(doc, /class="reading standalone"/);
  assert.match(doc, /id="area-performance"/);
  assert.doesNotMatch(doc, /<form id="notes-form"/);
});

test('standalone document refuses a css payload that closes the style element', () => {
  const doc = standaloneDocument(load(), getPlugins(), { css: 'a{}</style><script>x</script>' });
  assert.doesNotMatch(doc, /<script>x/);
});
```

Append to `test/cli.test.mjs`:

```js
test('cli writes a standalone HTML report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harplus-report-'));
  const out = join(dir, 'r.html');
  execFileSync('node', [CLI, 'summary', FIXTURE, '--report', out], { encoding: 'utf8' });
  const doc = readFileSync(out, 'utf8');
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /id="overview"/);
  for (const a of ['performance', 'accessibility', 'security', 'build', 'infrastructure']) assert.match(doc, new RegExp(`id="area-${a}"`));
  assert.match(doc, /@layer reset, tokens/); // theme.css inlined
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/report.test.mjs test/cli.test.mjs`
Expected: FAIL — `standaloneDocument` is not exported; the CLI rejects `--report` (`Unknown option '--report'`).

- [ ] **Step 3: Append `standaloneDocument` to `extension/ui/report.js`**

Add `esc` to the html.js import (`import { html, esc } from './html.js';`) and append:

```js
/** A self-contained report file: inlined CSS, embedded screenshots, :target navigation, no scripts. */
export function standaloneDocument(reading, plugins, { css = '', scores } = {}) {
  const t = hp(reading).target || {};
  const title = `${t.title || t.host || 'Reading'} — HAR-PLUS report`;
  const safeCss = String(css).replace(/</g, '\\3C '); // CSS escape: nothing in the stylesheet can close <style>
  const when = hp(reading).capturedAt ? new Date(hp(reading).capturedAt).toLocaleString() : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="HAR-PLUS">
<title>${esc(title)}</title>
<style>${safeCss}</style>
</head>
<body class="reading standalone">
<header class="appbar"><span class="brand">HAR<small>+</small></span><span class="appbar-title">${esc([t.title || t.host, t.finalUrl || t.url, when].filter(Boolean).join(' · '))}</span></header>
<main id="app">${renderReport(reading, plugins, { scores, interactive: false })}</main>
</body>
</html>
`;
}
```

- [ ] **Step 4: Viewer export**

In `extension/ui/reading.html`, add as the second item of `#export-menu` (after the Print item):

```html
        <button type="button" data-export="report">Standalone HTML report (.html)</button>
```

In `extension/ui/reading.js`, change the report.js import to also import `standaloneDocument`, and add inside the `if (exp) { … }` block after the `print` line:

```js
    if (kind === 'report') {
      const css = await (await fetch('theme.css')).text();
      download(`${stem}.report.html`, standaloneDocument(reading, plugins, { css, scores }), 'text/html');
    }
```

- [ ] **Step 5: CLI `--report`**

In `cli/harplus.mjs`:

1. Add imports:

```js
import { fileURLToPath } from 'node:url';
import { standaloneDocument } from '../extension/ui/report.js';
```

2. Add a helper after `load()`:

```js
const THEME = fileURLToPath(new URL('../extension/ui/theme.css', import.meta.url));

async function writeReport(reading, plugins, file) {
  await writeFile(file, standaloneDocument(reading, plugins, { css: await readFile(THEME, 'utf8') }));
  process.stderr.write(`${C.dim('wrote')} ${file}\n`);
}
```

3. In `analyze`, after the `.plus.har` file is written (after the `process.stderr.write(... wrote ${out})` line), add: `if (opts.report) await writeReport(reading, plugins, opts.report);`
4. In `main`'s `parseArgs` options, add `report: { type: 'string' },`.
5. In the `summary` branch, after printing, add: `if (values.report) await writeReport(reading, getPlugins(), values.report);`
6. In `USAGE`, change the summary line to `  harplus summary <file.har> [--md] [--report <out.html>]   print the readout and findings` and add under "Options for analyze": `      --report <file>     also write a standalone HTML report`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Manual check**

Run `node cli/harplus.mjs summary test/fixtures/local-site.har --report /tmp/harplus-report.html` and open the file in Chrome: sidebar links switch panes with no JavaScript; Print preview shows all panes. In the extension, Export → Standalone HTML report downloads a file that looks the same.

- [ ] **Step 8: Commit**

```bash
git add extension/ui/report.js extension/ui/reading.html extension/ui/reading.js cli/harplus.mjs test/report.test.mjs test/cli.test.mjs
git commit -m "Add standalone HTML report export in the viewer and CLI --report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: End-to-end checks and documentation

**Files:**
- Modify: `test/e2e/run.mjs` (section "4. viewer pages render", ~lines 178–200)
- Modify: `docs/PLUGINS.md`, `README.md`

**Interfaces:**
- Consumes: the finished viewer (Tasks 10–12).

- [ ] **Step 1: Update the viewer section of `test/e2e/run.mjs`**

Replace from `await page2.goto(extUrl(\`ui/reading.html?id=${id1}\`));` through the line `await page2.screenshot({ path: join(OUT, 'reading-plugins-dark.png'), fullPage: true });` with:

```js
    await page2.goto(extUrl(`ui/reading.html?id=${id1}`));
    await page2.waitForSelector('#overview .area-card');
    // every pane renders and every ring/donut label fits inside its hole
    const panes = ['overview', 'area-performance', 'area-accessibility', 'area-security', 'area-build', 'area-infrastructure', 'findings', 'network', 'screens', 'notes'];
    for (const pane of panes) {
      await page2.evaluate((p) => { location.hash = p; }, pane);
      await page2.waitForFunction((p) => getComputedStyle(document.getElementById(p)).display !== 'none', pane);
      const bad = await page2.evaluate(() => [...document.querySelectorAll('svg.ring, svg.donut')]
        .filter((svg) => svg.getBoundingClientRect().width > 0)
        .flatMap((svg) => {
          const c = svg.querySelector('circle');
          const inner = 2 * (Number(c.getAttribute('r')) - Number(c.getAttribute('stroke-width')) / 2);
          return [...svg.querySelectorAll('text')].map((t) => ({ text: t.textContent, w: t.getBBox().width, limit: inner * 0.8 }));
        })
        .filter((x) => x.w > x.limit));
      assert.deepEqual(bad, [], `ring labels overflow on ${pane}`);
      for (const width of [1280, 800]) {
        await page2.setViewportSize({ width, height: 800 });
        const overflow = await page2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `${pane} overflows horizontally by ${overflow}px at ${width}px`);
      }
      await page2.setViewportSize({ width: 1280, height: 800 });
      await page2.screenshot({ path: join(OUT, `reading-${pane}.png`), fullPage: true });
    }
    await page2.evaluate(() => { location.hash = 'network'; });
    await page2.click('#network tbody tr');
    await page2.waitForSelector('#dlg[open]');
    await page2.screenshot({ path: join(OUT, 'reading-request-dialog.png') });
    await page2.click('#dlg-close');
    // print shows every pane
    await page2.emulateMedia({ media: 'print' });
    const hidden = await page2.evaluate((ids) => ids.filter((p) => getComputedStyle(document.getElementById(p)).display === 'none'), panes);
    assert.deepEqual(hidden, [], 'print hides panes');
    await page2.pdf({ path: join(OUT, 'reading.pdf') }).catch(() => {}); // pdf() needs headless Chromium
    await page2.emulateMedia({ media: 'screen' });
    // standalone export downloads a report
    await page2.evaluate(() => { location.hash = 'overview'; });
    await page2.click('button[popovertarget="export-menu"]');
    const [dl] = await Promise.all([page2.waitForEvent('download'), page2.click('[data-export="report"]')]);
    assert.match(dl.suggestedFilename(), /\.report\.html$/);
    await dl.saveAs(join(OUT, dl.suggestedFilename()));
    await page2.setViewportSize({ width: 390, height: 844 });
    await page2.screenshot({ path: join(OUT, 'reading-narrow.png') });
    await page2.setViewportSize({ width: 1280, height: 800 });
    await page2.emulateMedia({ colorScheme: 'dark' });
    await page2.screenshot({ path: join(OUT, 'reading-dark.png'), fullPage: true });
    await page2.evaluate(() => { location.hash = 'area-performance'; for (const d of document.querySelectorAll('details.plugin')) d.open = true; });
    await page2.screenshot({ path: join(OUT, 'reading-plugins-dark.png'), fullPage: true });
    await page2.emulateMedia({ colorScheme: 'light' });
```

Also change the later library assertion to check the score ring:

```js
    await page2.waitForSelector('.reading-card');
    assert.equal(await page2.locator('.reading-card').count(), 4);
    assert.ok(await page2.locator('.reading-card .card-score svg.ring').count() >= 1, 'library cards show a score ring');
```

- [ ] **Step 2: Run the e2e test**

Run: `npm run test:e2e`
Expected: completes with no assertion errors; `test/e2e/out/` contains `reading-overview.png` … `reading-notes.png`, `reading-request-dialog.png`, a `*.report.html` file and (headless) `reading.pdf`. Open the screenshots and look for label collisions, clipped text or overflow; fix in CSS and re-run until clean. If Playwright is not installed, follow the header comment in `test/e2e/run.mjs` (`npm i -g playwright && npx playwright install chromium`).

- [ ] **Step 3: Document the plugin additions in `docs/PLUGINS.md`**

In the plugin-object code block, add after the `group:` line:

```js
  area: 'performance',             // optional: performance | accessibility | security | build | infrastructure
                                   //   (default from group: quality → performance, other → build)
```

and after the `render(result, h) {…},` entry:

```js
  glance(result, h, { results, target }) {  // optional: charts at the top of the area page (not for remote plugins)
    return h.stat({ label: 'Thing', value: result.data.n, rating: 'good' });
  },
```

Then add a new section after the `ctx` section:

````markdown
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

Colours: pass `color: 'var(--c1)'` … `'var(--c8)'` or `'var(--c-other)'`; anything else is ignored.

## Scores

Each area starts at 100 and loses points per finding (high 15, medium 6, low 2, info 0; capped at
60 / 30 / 15 per severity). Findings count toward the area of their `category`
(performance, accessibility, security + privacy, build ← quality + seo, infrastructure ← infrastructure + intel).
Performance is averaged 50/50 with Lighthouse performance (PageSpeed) or the Web Vitals ratings;
Accessibility with Lighthouse accessibility when available. The overall score weights
Performance 25, Accessibility 25, Security 25, Build & content 15, Infrastructure 10 over the
areas that were measured. Grades: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, else F.
````

- [ ] **Step 4: Update `README.md`**

After the "## What's in a reading" table sections (before the next `##` heading), add:

```markdown
### The report

The reading page opens on an **Overview**: a screenshot, a one-line summary, an overall score and a
card per area — Performance, Accessibility, Security, Build & content, Infrastructure — each with a
0–100 score, a grade, key numbers and its worst finding. Each area has its own page with charts
(Web Vitals meters, page-weight donut, header checklists, request path, domain lifetime…),
its findings and every plugin's detail. "How is this scored?" on each area page shows the arithmetic.

**Export → Print or save as PDF** prints every page in order. **Export → Standalone HTML report**
saves a single `.html` file that opens anywhere without the extension. From the CLI:
`harplus summary reading.har --report report.html`.
```

In the "## Install" or CLI usage section that lists commands, add the `--report` option if the CLI usage is reproduced there.

- [ ] **Step 5: Run all unit tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/run.mjs docs/PLUGINS.md README.md
git commit -m "Check every report pane end to end; document areas, glances, ratings, scores and exports

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
