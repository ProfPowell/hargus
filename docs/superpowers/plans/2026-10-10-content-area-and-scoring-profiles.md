# Content area and scoring profiles: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split "Build & content" into Build and Content, score readings with weight profiles that have critical areas and honest low scores, and add the `content` and `links` plugins plus four metadata checks.

**Architecture:**
- The scoring changes all live in the pure `extension/core/score.js`, including `PROFILES`, `resolveProfile`, `carbonScore`, the blend and the cap.
- The settings, the index, the report, the Options page and the CLI pass a profile into `scoreReading`.
- Two new plugins follow the existing plugin contract:
  - `content`, a page-phase plugin: `collect()` gathers raw page data and a pure `run()` analyses it;
  - `links`, an enrich-phase plugin that runs after `content`.
- The plugin host gains `ctx.progress(text)`, so long lookups can report progress to the reading tab's checklist.

**Tech Stack:**
- Vanilla ES modules with no build step and no dependencies.
- Chrome MV3 extension.
- Node 20+ CLI.
- `node --test` for unit tests and Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-10-10-content-area-and-scoring-profiles-design.md`

## Global Constraints

- No dependencies and no build step. Use plain ES modules, as in the existing code.
- Page-phase `collect()` functions are serialized into the page, so they must be self-contained: no imports and no outer variables.
- The eight areas, in order: performance, accessibility, security, content, build, infrastructure, international, sustainability. The labels are "Performance", "Accessibility", "Security", "Content", "Build", "Infrastructure", "International", "Sustainability".
- The default profile is `general`, with weights Perf 18 · A11y 18 · Security 18 · Content 12 · Build 10 · Infra 9 · Intl 8 · Sustain 7 and no critical areas.
- The critical cap applies when a measured critical area scores below 60. It caps the overall score at 69.
- Area blend when there are two inputs: `round((2 × min + max) / 3)`.
- Carbon anchors in g per visit → score: 0.040→100, 0.079→90, 0.145→80, 0.209→70, 0.278→60, 0.359→50, 1.795→0. The score is piecewise-linear in ln(grams) and clamped.
- New findings use the exact titles from the spec.
- Link checking:
  - HEAD first, then GET on 405, 501 or a network error;
  - `credentials: 'omit'`;
  - 6 requests at a time, each with a 10 s timeout;
  - skip URLs matching `/log-?out|sign-?out|logoff|delete|remove|unsubscribe/i`;
  - `max` defaults to 150.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run `npm test` (unit tests) before every commit. Run `npm run test:e2e` in Task 7.

## Review Focus

Each item has a test in the task that owns it.

1. **A reading with no carbon `grams`** (an old reading). It falls back to the rating anchor and never shows NaN. Task 1 tests this.
2. **A custom profile with all weights 0, or with missing areas.** Missing weights fall back to General. If the total weight is 0, the overall score is `null` and the grade is "not measured". It never divides by zero. Task 1 tests this.
3. **A page with no `<main>`, no paragraphs and no headings**, such as an image-only splash page. Content reports 0 words and thin content, skips readability, and has no NaN in its glance. Task 4 tests this.
4. **The links plugin when the `content` result is missing**: an imported DevTools HAR, or the CLI. It skips with a clear reason instead of erroring. Task 5 tests this.
5. **An `og:image` that is SVG, or a host without `createImageBitmap`** (the Node CLI). Only the load status is reported, with no size finding and no throw. Task 5 tests this.

---

### Task 1: Scoring core (areas, profiles, carbon curve, blend, critical cap)

**Files:**
- Modify: `extension/core/score.js`
- Modify: `extension/plugins/meta.js` (the `area` line only)
- Modify: `extension/ui/charts.js` (add a `content` icon)
- Test: `test/score.test.mjs`, `test/report.test.mjs` (the "seven areas" test name and ids)

**Interfaces:**
- Produces, consumed by Tasks 2 and 7:
  - `AREAS`: eight `{ id, label, weight }` entries; `weight` holds the General weights.
  - `PROFILES`: `{ [id]: { id, label, weights: {[area]: n}, critical: [ids] } }` for `general`, `content`, `commerce`, `webapp` and `public`.
  - `resolveProfile(p)`: takes a string id, a custom object `{ id: 'custom', weights, critical }`, or undefined, and returns `{ id, label, weights, critical }`.
  - `profileFromSettings(settings)` returns `'general'`, a preset id, or a custom object.
  - `carbonScore(grams)` returns a number from 0 to 100.
  - `scoreReading(reading, plugins, { profile } = {})` returns `{ overall: { score, grade, status, findings, profile: { id, label }, capped: null | { areas: [ids], from } }, areas, weights }`.
  - `topFindings(scores, …)` uses `scores.weights`.
  - `summarize(scores)` starts with the cap sentence when a cap applies.

- [ ] **Step 1: Update and write the failing tests** in `test/score.test.mjs`.

  Change the import to:

  ```js
  import {
    AREAS, PROFILES, grade, status, pluginArea, resultArea, normRating, scoreReading, topFindings, summarize,
    resolveProfile, profileFromSettings, carbonScore,
  } from '../extension/core/score.js';
  ```

  In the test `plugin areas: explicit area, group fallback, built-in overrides`, change `assert.equal(byId.meta, 'build');` to `assert.equal(byId.meta, 'content');`.

  In `performance blends vitals ratings, lighthouse wins when present`, apply the new blend:

  ```js
    // findings 100, metric (60+100+100+20)/4 = 70 → (2×70 + 100)/3 = 80
    assert.equal(s1.areas.performance.score, 80);
  ```

  and

  ```js
    assert.equal(s2.areas.performance.score, 60); // (2×40 + 100) / 3
    assert.equal(s2.areas.accessibility.score, 93); // (2×90 + 100) / 3 = 93.3
  ```

  In `unmeasured areas are excluded and weights renormalise`, use the General weights:

  ```js
    assert.equal(s.overall.score, Math.round((70 * 18 + 100 * 9) / 27));
  ```

  Replace the test `seven areas with the new weights` with:

  ```js
  test('eight areas; General weights on AREAS', () => {
    assert.deepEqual(AREAS.map((a) => `${a.id}:${a.weight}`), [
      'performance:18', 'accessibility:18', 'security:18', 'content:12', 'build:10', 'infrastructure:9', 'international:8', 'sustainability:7',
    ]);
    assert.equal(AREAS.find((a) => a.id === 'build').label, 'Build');
    assert.equal(AREAS.find((a) => a.id === 'content').label, 'Content');
    assert.equal(pluginArea({ area: 'content' }), 'content');
  });
  ```

  Replace the test `international and sustainability categories land in their areas; carbon rating blends` with:

  ```js
  test('international and sustainability categories land in their areas; carbon grams blend', () => {
    const s = scoreReading(reading({
      international: ok('international', [f('medium', 'international')], { area: 'international' }),
      carbon: ok('carbon', [f('low', 'sustainability')], { area: 'sustainability', data: { rating: 'D', grams: 0.278 } }),
    }), getPlugins());
    assert.equal(s.areas.international.score, 94);
    assert.equal(s.areas.sustainability.score, Math.round((2 * 60 + 98) / 3)); // 73
    assert.deepEqual(s.areas.sustainability.inputs.map((i) => i.label), ['Findings', 'Carbon per visit']);
  });

  test('carbon without grams (old reading) falls back to the rating anchor', () => {
    const s = scoreReading(reading({ carbon: ok('carbon', [], { area: 'sustainability', data: { rating: 'F' } }) }), getPlugins());
    assert.equal(s.areas.sustainability.inputs[1].score, 50);
    assert.equal(s.areas.sustainability.score, Math.round((2 * 50 + 100) / 3));
  });
  ```

  Change the test `old reading: seven areas, new ones unmeasured` to `Object.keys(s.areas).length, 8` and rename it `old reading: eight areas, new ones unmeasured`.

  Append these tests:

  ```js
  test('carbonScore: anchors, interpolation in log grams, clamps', () => {
    const cases = [[0.01, 100], [0.040, 100], [0.079, 90], [0.145, 80], [0.209, 70], [0.278, 60], [0.359, 50], [1.795, 0], [5, 0]];
    for (const [g, s] of cases) assert.equal(Math.round(carbonScore(g)), s, `${g} g`);
    const mid = carbonScore(Math.sqrt(0.359 * 1.795)); // geometric midpoint of the last segment
    assert.equal(Math.round(mid), 25);
    assert.equal(carbonScore(NaN), null);
    assert.equal(carbonScore(undefined), null);
  });

  test('profiles: five presets, custom falls back to General, settings mapping', () => {
    assert.deepEqual(Object.keys(PROFILES), ['general', 'content', 'commerce', 'webapp', 'public']);
    assert.deepEqual(PROFILES.public.weights, {
      performance: 14, accessibility: 24, security: 10, content: 14, build: 6, infrastructure: 6, international: 14, sustainability: 12,
    });
    assert.deepEqual(PROFILES.public.critical, ['accessibility', 'international']);
    assert.deepEqual(PROFILES.commerce.critical, ['performance', 'security']);
    assert.deepEqual(PROFILES.content.critical, ['content']);
    assert.deepEqual(PROFILES.webapp.critical, ['security']);
    assert.deepEqual(PROFILES.general.critical, []);
    for (const p of Object.values(PROFILES)) assert.equal(Object.values(p.weights).reduce((n, w) => n + w, 0), 100, p.id);
    const c = resolveProfile({ id: 'custom', weights: { security: 50 }, critical: ['security'] });
    assert.equal(c.label, 'Custom');
    assert.equal(c.weights.security, 50);
    assert.equal(c.weights.performance, 18);
    assert.deepEqual(resolveProfile('nope'), PROFILES.general);
    assert.deepEqual(resolveProfile(), PROFILES.general);
    assert.equal(profileFromSettings({}), 'general');
    assert.equal(profileFromSettings({ scoring: { profile: 'public' } }), 'public');
    assert.deepEqual(profileFromSettings({ scoring: { profile: 'custom', custom: { weights: { build: 1 }, critical: [] } } }),
      { id: 'custom', weights: { build: 1 }, critical: [] });
  });

  test('profile weights change the overall score', () => {
    const r = reading({
      security: ok('security', [f('high', 'security'), f('high', 'security')]), // 70
      'a11y-basics': ok('a11y-basics'), // 100
    });
    assert.equal(scoreReading(r, getPlugins()).overall.score, Math.round((70 * 18 + 100 * 18) / 36));
    const pub = scoreReading(r, getPlugins(), { profile: 'public' });
    assert.equal(pub.overall.score, Math.round((70 * 10 + 100 * 24) / 34));
    assert.deepEqual(pub.overall.profile, { id: 'public', label: 'Public sector / education' });
  });

  test('critical cap: failing critical area caps at 69; non-critical or unmeasured does not', () => {
    const highs = (n, cat) => Array(n).fill(0).map((_, i) => f('high', cat, `h${i}`));
    const r = reading({
      'a11y-basics': ok('a11y-basics', [...highs(4, 'accessibility'), f('medium', 'accessibility'), f('medium', 'accessibility'), f('medium', 'accessibility'), f('medium', 'accessibility'), f('medium', 'accessibility')]), // 100-60-30 = 10
      security: ok('security'), dns: ok('dns'), international: ok('international', [], { area: 'international' }),
      html: ok('html'), meta: ok('meta'), vitals: ok('vitals'),
    });
    // public: (10×24 + 100×(10+6+14+6+14+14)) / 88 = 6640/88 → 75, capped to 69
    const gen = scoreReading(r, getPlugins());
    assert.equal(gen.overall.capped, null);
    const pub = scoreReading(r, getPlugins(), { profile: 'public' });
    assert.ok(pub.overall.capped, 'capped');
    assert.deepEqual(pub.overall.capped.areas, ['accessibility']);
    assert.equal(pub.overall.score, 69);
    assert.equal(pub.overall.grade, 'D+'); // 69: D band 60–69, ≥ 67 gets “+”
    assert.equal(pub.overall.capped.from, 75);
    assert.match(summarize(pub), /^Capped at D: Accessibility is failing \(critical for Public sector \/ education\)\./);
    // critical but unmeasured: no cap
    const unmeasured = scoreReading(reading({ security: ok('security') }), getPlugins(), { profile: 'public' });
    assert.equal(unmeasured.overall.capped, null);
  });

  test('cap names several failing areas with "and"; a score already ≤ 69 is not marked capped', () => {
    const bad = (cat) => [...Array(4).fill(0).map((_, i) => f('high', cat, `${cat}${i}`)), ...Array(5).fill(0).map((_, i) => f('medium', cat, `${cat}m${i}`))];
    const r = reading({
      'a11y-basics': ok('a11y-basics', bad('accessibility')),
      international: ok('international', bad('international'), { area: 'international' }),
      security: ok('security'),
    });
    const s = scoreReading(r, getPlugins(), { profile: 'public' });
    assert.ok(s.overall.score <= 69);
    assert.equal(s.overall.capped, null, 'already below the cap');
    const r2 = reading({
      'a11y-basics': ok('a11y-basics', bad('accessibility')),
      international: ok('international', bad('international'), { area: 'international' }),
      security: ok('security'), dns: ok('dns'), html: ok('html'), meta: ok('meta'), vitals: ok('vitals'),
    });
    const s2 = scoreReading(r2, getPlugins(), { profile: { id: 'custom', weights: { accessibility: 1, international: 1, security: 30, infrastructure: 30, build: 30, content: 30, performance: 30 }, critical: ['accessibility', 'international'] } });
    assert.equal(s2.overall.score, 69);
    assert.match(summarize(s2), /^Capped at D: Accessibility and International are failing \(critical for Custom\)\./);
  });

  test('custom profile with zero total weight: overall not measured', () => {
    const s = scoreReading(reading({ security: ok('security') }), getPlugins(), { profile: { id: 'custom', weights: Object.fromEntries(AREAS.map((a) => [a.id, 0])), critical: [] } });
    assert.equal(s.overall.score, null);
    assert.equal(s.overall.grade, null);
    assert.equal(s.areas.security.score, 100);
  });

  test('seo findings count toward Content; quality toward Build', () => {
    const s = scoreReading(reading({ meta: ok('meta', [f('low', 'seo'), f('medium', 'quality'), f('low', 'content')]), html: ok('html') }), getPlugins());
    assert.equal(s.areas.content.score, 96);
    assert.equal(s.areas.build.score, 94);
  });
  ```

  In `test/report.test.mjs`, rename `report has seven area panes and sidebar links` to `report has eight area panes and sidebar links`, and change its id list to `['international', 'sustainability', 'content', 'build']`.

- [ ] **Step 2: Run the tests to watch them fail**

  Run: `node --test test/score.test.mjs test/report.test.mjs`

  Expected: FAIL. The new exports are not defined, and the area count and weights are wrong.

- [ ] **Step 3: Implement it in `extension/core/score.js`.**

  Replace the `AREAS` block through `CARBON_SCORE` (lines 6–28) with:

  ```js
  export const AREAS = [
    { id: 'performance', label: 'Performance', weight: 18 },
    { id: 'accessibility', label: 'Accessibility', weight: 18 },
    { id: 'security', label: 'Security', weight: 18 },
    { id: 'content', label: 'Content', weight: 12 },
    { id: 'build', label: 'Build', weight: 10 },
    { id: 'infrastructure', label: 'Infrastructure', weight: 9 },
    { id: 'international', label: 'International', weight: 8 },
    { id: 'sustainability', label: 'Sustainability', weight: 7 },
  ];
  const AREA_IDS = new Set(AREAS.map((a) => a.id));
  const LABEL = Object.fromEntries(AREAS.map((a) => [a.id, a.label]));

  const w = (performance, accessibility, security, content, build, infrastructure, international, sustainability) =>
    ({ performance, accessibility, security, content, build, infrastructure, international, sustainability });
  export const PROFILES = {
    general: { id: 'general', label: 'General', weights: w(18, 18, 18, 12, 10, 9, 8, 7), critical: [] },
    content: { id: 'content', label: 'Brochure / content site', weights: w(18, 20, 8, 22, 10, 6, 8, 8), critical: ['content'] },
    commerce: { id: 'commerce', label: 'Commerce', weights: w(22, 16, 22, 12, 8, 8, 7, 5), critical: ['performance', 'security'] },
    webapp: { id: 'webapp', label: 'Web app', weights: w(20, 18, 22, 6, 16, 8, 6, 4), critical: ['security'] },
    public: { id: 'public', label: 'Public sector / education', weights: w(14, 24, 10, 14, 6, 6, 14, 12), critical: ['accessibility', 'international'] },
  };

  /** A preset id, a custom object { weights, critical }, or nothing → { id, label, weights, critical }. */
  export function resolveProfile(p) {
    if (p && typeof p === 'object') {
      const weights = { ...PROFILES.general.weights };
      for (const [k, v] of Object.entries(p.weights || {})) if (AREA_IDS.has(k) && Number.isFinite(Number(v)) && Number(v) >= 0) weights[k] = Number(v);
      return { id: 'custom', label: 'Custom', weights, critical: (p.critical || []).filter((id) => AREA_IDS.has(id)) };
    }
    return PROFILES[p] || PROFILES.general;
  }

  export function profileFromSettings(settings) {
    const s = settings?.scoring;
    if (s?.profile === 'custom') return { id: 'custom', ...(s.custom || {}) };
    return s?.profile && PROFILES[s.profile] ? s.profile : 'general';
  }

  export const CATEGORY_AREA = {
    performance: 'performance', accessibility: 'accessibility', security: 'security', privacy: 'security',
    quality: 'build', seo: 'content', content: 'content', infrastructure: 'infrastructure', intel: 'infrastructure',
    international: 'international', sustainability: 'sustainability',
  };
  export const GROUP_AREA = { build: 'build', security: 'security', infrastructure: 'infrastructure', quality: 'performance', other: 'build' };
  export const DEDUCT = { high: 15, medium: 6, low: 2, info: 0 };
  export const CAP = { high: 60, medium: 30, low: 15, info: 0 };
  export const VERDICT = { good: 'good', warning: 'needs work', serious: 'poor', critical: 'failing', none: 'not measured' };
  const RATING_SCORE = { good: 100, 'needs-improvement': 60, poor: 20 };

  // Carbon: piecewise-linear in ln(grams) through the rating boundaries; 5× the F threshold scores 0.
  const CARBON_ANCHORS = [[0.040, 100], [0.079, 90], [0.145, 80], [0.209, 70], [0.278, 60], [0.359, 50], [1.795, 0]];
  const RATING_GRAMS = { 'A+': 0.040, A: 0.079, B: 0.145, C: 0.209, D: 0.278, E: 0.359, F: 0.359 };
  export function carbonScore(grams) {
    const g = Number(grams);
    if (grams == null || !Number.isFinite(g)) return null;
    if (g <= CARBON_ANCHORS[0][0]) return 100;
    for (let i = 1; i < CARBON_ANCHORS.length; i++) {
      const [g1, s1] = CARBON_ANCHORS[i];
      if (g <= g1) {
        const [g0, s0] = CARBON_ANCHORS[i - 1];
        return s0 + ((Math.log(g) - Math.log(g0)) / (Math.log(g1) - Math.log(g0))) * (s1 - s0);
      }
    }
    return 0;
  }
  ```

  In `metricInput`, replace the sustainability branch with:

  ```js
    if (areaId === 'sustainability' && results.carbon?.status === 'ok') {
      const d = results.carbon.data || {};
      const s = carbonScore(d.grams) ?? carbonScore(RATING_GRAMS[d.rating]);
      if (s != null) return { label: 'Carbon per visit', score: Math.round(s) };
    }
  ```

  Replace `scoreReading` with:

  ```js
  export function scoreReading(reading, plugins = [], { profile } = {}) {
    const prof = resolveProfile(profile);
    const results = reading.log._harplus?.plugins || {};
    const areas = Object.fromEntries(AREAS.map((a) => [a.id, {
      ...a, weight: prof.weights[a.id], critical: prof.critical.includes(a.id),
      score: null, grade: null, status: 'none', measured: false,
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
      a.score = metric
        ? Math.round((2 * Math.min(fromFindings, metric.score) + Math.max(fromFindings, metric.score)) / 3)
        : fromFindings;
      a.grade = grade(a.score);
      a.status = status(a.score);
    }
    const measured = AREAS.filter((a) => areas[a.id].measured);
    const weight = measured.reduce((n, a) => n + prof.weights[a.id], 0);
    let score = weight ? Math.round(measured.reduce((n, a) => n + areas[a.id].score * prof.weights[a.id], 0) / weight) : null;
    const failing = prof.critical.filter((id) => areas[id].measured && areas[id].score < 60);
    let capped = null;
    if (score != null && failing.length && score > 69) {
      capped = { areas: failing, from: score };
      score = 69;
    }
    const findings = Object.values(areas).reduce((n, a) => n + a.deductions.length, 0);
    return {
      overall: { score, grade: grade(score), status: status(score), findings, profile: { id: prof.id, label: prof.label }, capped },
      areas,
      weights: prof.weights,
    };
  }
  ```

  In `topFindings`, change the sort tie-break to use the profile weights:

  ```js
      .sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || (scores.weights?.[y.area] ?? 0) - (scores.weights?.[x.area] ?? 0))
  ```

  Delete the now-unused `const WEIGHT = …` line.

  In `summarize`, put the cap sentence first:

  ```js
  export function summarize(scores) {
    const measured = AREAS.map((a) => scores.areas[a.id]).filter((a) => a.score != null);
    if (!measured.length) return 'No areas measured yet — enable plugins and re-run analysis.';
    const cap = scores.overall.capped;
    const capText = cap
      ? `Capped at D: ${cap.areas.map((id) => LABEL[id]).join(' and ')} ${cap.areas.length > 1 ? 'are' : 'is'} failing (critical for ${scores.overall.profile.label}). `
      : '';
    const best = measured.reduce((x, y) => (y.score > x.score ? y : x));
    const worst = measured.reduce((x, y) => (y.score < x.score ? y : x));
    const name = (a) => a.label.toLowerCase();
    const parts = [best.score >= 85 ? `Strong on ${name(best)}` : `Best area: ${name(best)} (${best.score})`];
    if (worst !== best) parts.push(worst.score < 70 ? `weak on ${name(worst)}` : `no area below ${worst.score}`);
    let text = `${capText}${parts.join(', ')}.`;
    const top = topFindings(scores, 1)[0];
    if (top && (top.severity === 'high' || top.severity === 'medium')) text += ` Top issue: ${top.title.replace(/\.$/, '')}.`;
    return text;
  }
  ```

  In `extension/plugins/meta.js`, change `area: 'build',` to `area: 'content',` in the default export.

  In `extension/ui/charts.js`, add a `content` entry to the icon map after `build:`, a document with text lines:

  ```js
    content: `<path d="M4 1.5h5.5L12.5 4.5V14.5H4Z" stroke-width="1.4" ${STROKE}/><path d="M6 7.5h4.5M6 10h4.5M6 12.5h3" stroke-width="1.3" ${STROKE}/>`,
  ```

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS for all tests. If another test asserted an old blend or weight value, update it to the new formula. Keep the test's intent, and state the arithmetic in a comment.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/core/score.js extension/plugins/meta.js extension/ui/charts.js test/score.test.mjs test/report.test.mjs
  git commit -m "Scoring: Content and Build areas, weight profiles, critical cap, carbon curve, worse-input blend

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 2: Profile plumbing (settings, index, report, Options, CLI, docs)

**Files:**
- Modify: `extension/browser/settings.js`
- Modify: `extension/core/harplus.js` (`indexRecord`)
- Modify: `extension/browser/store.js` (`saveReading`, new `rescoreAll`)
- Modify: `extension/ui/report.js` (`renderReport`, `standaloneDocument`, overview facts)
- Modify: `extension/ui/reading.js` (`render()`)
- Modify: `extension/ui/options.html`, `extension/ui/options.js`
- Modify: `cli/harplus.mjs`
- Modify: `docs/PLUGINS.md` (the "Scores" section)
- Test: `test/core.test.mjs`, `test/report.test.mjs`, `test/cli.test.mjs`

**Interfaces:**
- Consumes from Task 1: `scoreReading(reading, plugins, { profile })`, `profileFromSettings(settings)`, `PROFILES`, `AREAS`, `resolveProfile`.
- Produces:
  - `DEFAULTS.scoring = { profile: 'general', custom: { weights: {…General}, critical: [] } }`;
  - `indexRecord(reading, plugins, { profile } = {})`, whose record adds `profile: '<id>'`;
  - `rescoreAll(profile, onProgress?)` in `store.js`, which resolves to the number of readings re-scored;
  - `renderReport(reading, plugins, { settings, scores, interactive })` and `standaloneDocument(reading, plugins, { css, scores, settings })`, both defaulting the scores to the settings profile;
  - CLI `--profile <id>`.

- [ ] **Step 1: Write the failing tests.**

  Append to `test/core.test.mjs`:

  ```js
  test('indexRecord scores with the given profile and records it', () => {
    const r = JSON.parse(readFileSync(new URL('./fixtures/local-site.har', import.meta.url), 'utf8'));
    const gen = indexRecord(r, getPlugins());
    assert.equal(gen.profile, 'general');
    const pub = indexRecord(r, getPlugins(), { profile: 'public' });
    assert.equal(pub.profile, 'public');
    assert.equal(pub.score, scoreReading(r, getPlugins(), { profile: 'public' }).overall.score);
    const custom = indexRecord(r, getPlugins(), { profile: { id: 'custom', weights: { build: 5 }, critical: [] } });
    assert.equal(custom.profile, 'custom');
  });
  ```

  Append to `test/report.test.mjs`:

  ```js
  test('report shows the scoring profile and uses the settings profile', () => {
    const r = load();
    const out = renderReport(r, getPlugins(), { settings: { scoring: { profile: 'public' } } });
    assert.match(out, /Scored as Public sector \/ education/);
    const doc = standaloneDocument(r, getPlugins(), { settings: { scoring: { profile: 'commerce' } } });
    assert.match(doc, /Scored as Commerce/);
    assert.match(renderReport(r, getPlugins()), /Scored as General/);
  });
  ```

  Append to `test/cli.test.mjs`:

  ```js
  test('cli --profile scores the report with that profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harplus-cli-'));
    const report = join(dir, 'r.html');
    execFileSync('node', [CLI, 'summary', FIXTURE, '--profile', 'public', '--report', report], { encoding: 'utf8' });
    assert.match(readFileSync(report, 'utf8'), /Scored as Public sector \/ education/);
    assert.throws(() => execFileSync('node', [CLI, 'summary', FIXTURE, '--profile', 'nope'], { encoding: 'utf8', stdio: 'pipe' }), /unknown profile "nope"/);
  });
  ```

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/core.test.mjs test/report.test.mjs test/cli.test.mjs`

  Expected: FAIL. `profile` is undefined, "Scored as" is missing, and the CLI rejects the unknown `--profile` option.

- [ ] **Step 3: Implement.**

  In `extension/browser/settings.js`, add this to `DEFAULTS` after `ui`:

  ```js
    scoring: {
      profile: 'general',      // general | content | commerce | webapp | public | custom
      custom: {
        weights: { performance: 18, accessibility: 18, security: 18, content: 12, build: 10, infrastructure: 9, international: 8, sustainability: 7 },
        critical: [],
      },
    },
  ```

  In `extension/core/harplus.js`, change the import to `import { scoreReading, resolveProfile } from './score.js';`, then change `indexRecord`:

  ```js
  export function indexRecord(reading, plugins = [], { profile } = {}) {
    const hp = reading.log._harplus;
    const shots = hp.screenshots || [];
    const overall = scoreReading(reading, plugins, { profile }).overall;
  ```

  Add `profile: resolveProfile(profile).id,` after `pending: hp.analysis === 'pending',` in the returned object.

  In `extension/browser/store.js`:

  ```js
  import { indexRecord } from '../core/harplus.js';
  import { profileFromSettings } from '../core/score.js';
  import { getPlugins } from '../plugins/index.js';
  import { getSettings } from './settings.js';
  ```

  Then in `saveReading`, read the profile before opening the transaction:

  ```js
  export async function saveReading(reading) {
    const profile = profileFromSettings(await getSettings().catch(() => ({})));
    const d = await db();
    const id = reading.log._harplus.id;
    const tx = d.transaction(['readings', 'index'], 'readwrite');
    tx.objectStore('readings').put({ id, har: reading });
    tx.objectStore('index').put(indexRecord(reading, getPlugins(), { profile }));
    await complete(tx);
    return id;
  }

  /** Re-score every stored reading's index record with `profile`; returns how many were updated. */
  export async function rescoreAll(profile, onProgress = () => {}) {
    const d = await db();
    const ids = (await request(d.transaction('index').objectStore('index').getAllKeys())) || [];
    let n = 0;
    for (const id of ids) {
      const har = await getReading(id);
      if (!har) continue;
      const tx = d.transaction('index', 'readwrite');
      tx.objectStore('index').put(indexRecord(har, getPlugins(), { profile }));
      await complete(tx);
      onProgress(++n, ids.length);
    }
    return n;
  }
  ```

  In `extension/ui/report.js`:
  - Add `profileFromSettings` to the import from `../core/score.js`.
  - Change the `renderReport` signature so `settings` is destructured before `scores`:

    ```js
    export function renderReport(reading, plugins, { settings = {}, scores = scoreReading(reading, plugins, { profile: profileFromSettings(settings) }), interactive = true } = {}) {
    ```

  - Change `standaloneDocument`:

    ```js
    export function standaloneDocument(reading, plugins, { css = '', scores, settings = {} } = {}) {
    ```

    and inside it, `renderReport(reading, plugins, { scores, settings, interactive: false })`.
  - In the overview `facts` array, add `` `Scored as ${o.profile?.label || 'General'}`, `` immediately after `when,`.

  In `extension/ui/reading.js` `render()`, change `scores = scoreReading(reading, plugins);` to:

  ```js
    scores = scoreReading(reading, plugins, { profile: profileFromSettings(settings) });
  ```

  and add `profileFromSettings` to its `../core/score.js` import.

  In `extension/ui/options.html`, add this before the Plugins section:

  ```html
      <section class="card">
        <h2>Scoring</h2>
        <p class="note">Weights set how much each area counts toward the overall score. If a critical area fails (F), the overall grade is capped at D.</p>
        <div id="scoring"></div>
        <p id="rescore" class="muted" aria-live="polite"></p>
      </section>
  ```

  In `extension/ui/options.js`:
  - Add these imports:

    ```js
    import { listReadings, deleteAll, rescoreAll } from '../browser/store.js';
    import { AREAS, PROFILES, profileFromSettings } from '../core/score.js';
    ```

    (These replace the existing store import.)
  - Add:

    ```js
    function renderScoring() {
      const cur = settings.scoring?.profile || 'general';
      const custom = settings.scoring?.custom || { weights: {}, critical: [] };
      const presets = Object.values(PROFILES);
      $('#scoring').innerHTML = String(html`
        <div class="table-wrap"><table class="data">
          <thead><tr><th scope="col">Profile</th>${AREAS.map((a) => html`<th scope="col">${a.label}</th>`)}</tr></thead>
          <tbody>
            ${presets.map((p) => html`<tr>
              <td><label><input type="radio" name="profile" value="${p.id}" ${cur === p.id ? 'checked' : ''}> ${p.label}</label></td>
              ${AREAS.map((a) => html`<td>${p.weights[a.id]}${p.critical.includes(a.id) ? ' ✱' : ''}</td>`)}
            </tr>`)}
            <tr>
              <td><label><input type="radio" name="profile" value="custom" ${cur === 'custom' ? 'checked' : ''}> Custom</label></td>
              ${AREAS.map((a) => html`<td><input type="number" min="0" max="100" style="width:4rem" data-weight="${a.id}" value="${custom.weights?.[a.id] ?? PROFILES.general.weights[a.id]}" aria-label="${a.label} weight">
                <label class="muted"><input type="checkbox" data-critical="${a.id}" ${custom.critical?.includes(a.id) ? 'checked' : ''}> critical</label></td>`)}
            </tr>
          </tbody>
        </table></div>
        <p class="note">✱ critical area</p>`);
    }

    async function rescore() {
      const out = $('#rescore');
      const n = await rescoreAll(profileFromSettings(settings), (i, total) => { out.textContent = `Re-scoring ${total} readings… ${i}/${total}`; });
      out.textContent = n ? `Re-scored ${n} readings.` : '';
    }

    $('#scoring').addEventListener('change', async (e) => {
      const el = e.target;
      settings = await updateSettings((s) => {
        s.scoring ||= { profile: 'general', custom: { weights: {}, critical: [] } };
        if (el.name === 'profile') s.scoring.profile = el.value;
        if (el.dataset.weight) s.scoring.custom.weights[el.dataset.weight] = Math.max(0, Number(el.value) || 0);
        if (el.dataset.critical) {
          const set = new Set(s.scoring.custom.critical || []);
          if (el.checked) set.add(el.dataset.critical); else set.delete(el.dataset.critical);
          s.scoring.custom.critical = [...set];
        }
      });
      flashSaved();
      if (el.name === 'profile' || settings.scoring.profile === 'custom') rescore();
    });
    ```

  - In `init()`, call `renderScoring();` before `renderPlugins();`.
  - The existing document-level `change` listener ignores these elements, because they have no `data-path`.

  In `cli/harplus.mjs`:
  - Change the import to `import { PROFILES } from '../extension/core/score.js';`.
  - Add `profile: { type: 'string' },` to the `parseArgs` options.
  - Add this to `USAGE` after the `--quiet` line:

    ```
          --profile <id>      scoring profile: general | content | commerce | webapp | public
    ```

  - Change `writeReport` to take the settings:

    ```js
    async function writeReport(reading, plugins, file, settings = {}) {
      await writeFile(file, standaloneDocument(reading, plugins, { css: await readFile(THEME, 'utf8'), settings }));
    ```

  - In `main()`, right after parsing, add:

    ```js
      if (values.profile && !PROFILES[values.profile]) throw new Error(`unknown profile "${values.profile}" (use ${Object.keys(PROFILES).join(', ')})`);
      const scoring = { scoring: { profile: values.profile || 'general' } };
    ```

  - Pass `scoring` as the 4th argument in both `writeReport` calls. In `analyze()`, the call becomes `writeReport(reading, plugins, opts.report, { scoring: { profile: opts.profile || 'general' } })`.

  In `docs/PLUGINS.md`, replace the body of the "## Scores" section with:

  ```markdown
  Each area starts at 100 and loses points per finding: high 15, medium 6, low 2, info 0. The loss per severity is capped at 60, 30 and 15 (info loses nothing).

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
  ```

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS for all tests.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/browser/settings.js extension/core/harplus.js extension/browser/store.js extension/ui/report.js extension/ui/reading.js extension/ui/options.html extension/ui/options.js cli/harplus.mjs docs/PLUGINS.md test/core.test.mjs test/report.test.mjs test/cli.test.mjs
  git commit -m "Scoring profiles: settings, Options picker with re-scoring, report and CLI --profile

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 3: Plugin progress text (`ctx.progress`)

**Files:**
- Modify: `extension/core/plugin-host.js` (`makeContext`)
- Modify: `extension/ui/reading.js` (the `onProgress` handler and `structureKey`)
- Modify: `extension/ui/progress-view.js` (plugin rows)
- Test: `test/progress.test.mjs`, `test/core.test.mjs`

**Interfaces:**
- Produces:
  - `ctx.progress(text)` for any plugin. It calls `env.onProgress({ plugin, name, status: 'running', text })`.
  - `renderProgress` plugin rows show `p.text` while `p.status === 'running'`.

- [ ] **Step 1: Write the failing tests.**

  Append to `test/core.test.mjs`:

  ```js
  test('plugin host: ctx.progress reports running text', async () => {
    const seen = [];
    const plugin = { id: 'p', name: 'P', phase: 'analyze', run: (r, ctx) => { ctx.progress('Checking links 1/2'); return { data: {} }; } };
    const reading = createReading({ target: makeTarget('https://a.test/') });
    await runPlugins(reading, [plugin], { phases: ['analyze'], onProgress: (p) => seen.push(p) });
    assert.deepEqual(seen.map((p) => [p.status, p.text]), [['running', undefined], ['running', 'Checking links 1/2'], ['ok', undefined]]);
  });
  ```

  If `createReading` or `makeTarget` take different arguments, check their signatures in `extension/core/harplus.js` and build the smallest valid reading.

  Append to `test/progress.test.mjs`. Use its existing `renderProgress` import; add one if it is missing.

  ```js
  test('running plugin row shows its progress text', () => {
    const out = String(renderProgress({ plugins: [{ id: 'links', name: 'Link check', status: 'running', start: 0, text: 'Checking links 42/120' }], now: 1000 }));
    assert.match(out, /Checking links 42\/120/);
    const done = String(renderProgress({ plugins: [{ id: 'links', name: 'Link check', status: 'ok', start: 0, end: 500, text: 'Checking links 120/120' }], now: 1000 }));
    assert.doesNotMatch(done, /Checking links/);
  });
  ```

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/core.test.mjs test/progress.test.mjs`

  Expected: FAIL, because `ctx.progress is not a function` and the progress text is not rendered.

- [ ] **Step 3: Implement.**

  In `plugin-host.js` `makeContext`, add this to the returned object after `skip(msg)…`:

  ```js
      progress(text) { env.onProgress?.({ plugin: plugin.id, name: plugin.name, status: 'running', text: String(text) }); },
  ```

  In `progress-view.js`, change the plugin-row text argument:

  ```js
      p.status, p.name, p.status === 'error' || p.status === 'skipped' ? p.error || p.status : p.status === 'running' ? p.text || '' : '', (p.end ?? now) - p.start, p.start,
  ```

  In `reading.js`:
  - In the `onProgress` handler, replace the `running` branch with:

    ```js
          if (p.status === 'running') {
            if (!row) prog.plugins.push({ id: p.plugin, name: p.name, status: 'running', start: now, text: p.text });
            else if (p.text) row.text = p.text;
          }
    ```

  - In `structureKey()`, change `prog.plugins.map((x) => [x.id, x.status])` to `prog.plugins.map((x) => [x.id, x.status, x.text || ''])`.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/core/plugin-host.js extension/ui/progress-view.js extension/ui/reading.js test/core.test.mjs test/progress.test.mjs
  git commit -m "Plugin host: ctx.progress text shown on the reading tab's checklist

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 4: The `content` plugin

**Files:**
- Create: `extension/plugins/content.js`
- Modify: `extension/plugins/index.js` (import it; add it to `BUILTIN` after `meta`)
- Test: `test/content.test.mjs` (new)

**Interfaces:**
- Consumes:
  - `ctx.results.meta.data` (from `meta`): `title`, `og`, `structuredTypes`;
  - `ctx.target.finalUrl` / `ctx.target.url`;
  - `ctx.util.siteOf` and `ctx.util.mainEntry`;
  - `ctx.collected` (from `collect`).
- Produces:
  - Named exports `countWords(text)`, `syllables(word)`, `flesch({ words, sentences, syllables })`, `splitSentences(text)`, `analyze(collected, { meta, url, docBytes })`.
  - `run` returns the plugin result.
  - `result.data.linkTargets: { internal: string[], external: string[] }` holds absolute http(s) URLs with no fragment, deduplicated, up to 500 each, in document order. Task 5 consumes it.

- [ ] **Step 1: Write the failing tests** in `test/content.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import plugin, { countWords, syllables, flesch, splitSentences, analyze } from '../extension/plugins/content.js';
  import { getPlugins } from '../extension/plugins/index.js';
  import * as util from '../extension/core/har-util.js';
  import { h } from '../extension/ui/render.js';

  const words = (n, w = 'word') => Array(n).fill(w).join(' ');
  const base = (over = {}) => ({
    url: 'https://www.site.test/a/b/', lang: 'en', text: '', bodyTextBytes: 0,
    paragraphs: [], headings: [], navs: [], breadcrumb: false, links: [], ids: [], ...over,
  });
  const titles = (r) => r.findings.map((f) => f.title);

  test('registered after meta as a Content page plugin', () => {
    const ids = getPlugins().map((p) => p.id);
    assert.equal(ids.indexOf('content'), ids.indexOf('meta') + 1);
    assert.equal(plugin.phase, 'page');
    assert.equal(plugin.area, 'content');
    assert.deepEqual(plugin.after, ['meta']);
  });

  test('countWords: spaces, punctuation-only tokens, CJK characters ÷ 2', () => {
    assert.equal(countWords('Hello there, world — ok'), 4);
    assert.equal(countWords(''), 0);
    assert.equal(countWords('日本語の文章です'), 4); // 8 chars → 4
    assert.equal(countWords('Tokyo 東京'), 2);       // 1 + round(2/2)
  });

  test('syllables heuristic', () => {
    for (const [w, n] of [['cat', 1], ['table', 2], ['reading', 2], ['simple', 2], ['made', 1], ['the', 1], ['', 0]]) assert.equal(syllables(w), n, w);
  });

  test('flesch arithmetic', () => {
    const r = flesch({ words: 100, sentences: 5, syllables: 150 });
    assert.equal(r.ease.toFixed(3), '59.635');
    assert.equal(r.grade.toFixed(2), '9.91');
    assert.equal(flesch({ words: 0, sentences: 0, syllables: 0 }), null);
  });

  test('splitSentences: latin punctuation before space/end, CJK full stops', () => {
    assert.deepEqual(splitSentences('One two. Three? Four!'), ['One two', 'Three', 'Four']);
    assert.equal(splitSentences('Version 2.5 is out. Yes.').length, 2);
    assert.equal(splitSentences('今日は。明日は。').length, 2);
  });

  test('reading findings: long sentences, wall of text, thin content, hard to read', () => {
    const long = `${words(30, 'extraordinarily')}.`;
    const text = `${long} ${long} ${long} Short one.`;
    const r = analyze(base({ text, paragraphs: [{ text: words(160) }, { text: 'tiny paragraph here for count' }] }), { meta: {}, url: 'https://www.site.test/a/b/' });
    const t = titles(r);
    assert.ok(t.includes('Many long sentences (75% over 25 words)'), t.join(' | '));
    assert.ok(t.includes('1 wall-of-text paragraphs'));
    assert.ok(t.some((x) => /^Thin content \(\d+ words\)$/.test(x)));
    assert.ok(t.some((x) => /^Hard to read \(Flesch -?\d+, grade \d+\)$/.test(x)));
    assert.equal(r.findings.find((f) => f.title.startsWith('Hard to read')).severity, 'medium');
    assert.ok(r.findings.every((f) => f.category === 'content'));
    assert.equal(r.data.reading.english, true);
  });

  test('readability skipped for non-English pages', () => {
    const r = analyze(base({ lang: 'fr', text: `${words(300, 'extraordinairement')}.` }), { meta: {}, url: 'https://www.site.test/' });
    assert.equal(r.data.reading.english, false);
    assert.equal(r.data.reading.flesch, null);
    assert.ok(!titles(r).some((x) => x.startsWith('Hard to read')));
    assert.equal(r.data.reading.readability, 'not applicable: page language is fr');
  });

  test('empty page: zero words, thin content, no NaN anywhere', () => {
    const r = analyze(base({ url: 'https://www.site.test/' }), { meta: {}, url: 'https://www.site.test/' });
    assert.equal(r.data.reading.words, 0);
    assert.ok(titles(r).includes('Thin content (0 words)'));
    const out = String(plugin.glance({ data: r.data }, h)) + String(plugin.render({ data: r.data }, h));
    assert.doesNotMatch(out, /NaN|undefined|Infinity/);
  });

  test('text vs markup', () => {
    const r = analyze(base({ bodyTextBytes: 500, text: words(300) }), { meta: {}, url: 'https://www.site.test/', docBytes: 10_000 });
    assert.ok(titles(r).includes('Mostly markup (5% text)'));
    const ok = analyze(base({ bodyTextBytes: 5000, text: words(300) }), { meta: {}, url: 'https://www.site.test/', docBytes: 10_000 });
    assert.ok(!titles(ok).some((x) => x.startsWith('Mostly markup')));
  });

  test('structure: skipped levels, empty and long headings, title vs h1, menu overload, breadcrumbs, URL shape', () => {
    const r = analyze(base({
      url: 'https://www.site.test/Shop/Big_Things/x/y/z/?sessionid=1',
      text: words(300),
      headings: [{ level: 1, text: 'Welcome' }, { level: 3, text: 'Deep' }, { level: 2, text: '' }, { level: 2, text: 'x'.repeat(121) }],
      navs: [{ links: 61, depth: 2, label: 'Main' }],
    }), { meta: { title: 'Welcome', og: {}, structuredTypes: [] }, url: 'https://www.site.test/Shop/Big_Things/x/y/z/?sessionid=1' });
    const t = titles(r);
    assert.ok(t.includes('1 skipped heading levels'));
    assert.ok(t.includes('1 empty headings'));
    assert.ok(t.includes('1 very long headings'));
    assert.ok(t.includes('Title repeats the h1'));
    assert.ok(t.includes('Menu overload (61 links in navigation)'));
    assert.ok(t.includes('No breadcrumbs on a page 5 levels deep'));
    assert.ok(t.some((x) => x.startsWith('URL shape:') && /depth 5/.test(x) && /uppercase/.test(x) && /underscores/.test(x) && /session id/.test(x)));
    assert.equal(r.findings.find((f) => f.title === '1 empty headings').severity, 'medium');
  });

  test('breadcrumbs from BreadcrumbList JSON-LD satisfy the check; site-name-only title', () => {
    const r = analyze(base({ url: 'https://www.site.test/a/b/', text: words(300) }),
      { meta: { title: 'Site Test', og: { 'og:site_name': 'Site Test' }, structuredTypes: ['BreadcrumbList'] }, url: 'https://www.site.test/a/b/' });
    assert.ok(!titles(r).some((x) => x.startsWith('No breadcrumbs')));
    assert.ok(titles(r).includes('Title is only the site name'));
  });

  test('links: kinds, vague text, same text different places, broken anchors, density, targets', () => {
    const u = 'https://www.site.test/page';
    const r = analyze(base({
      url: u, text: words(200),
      ids: ['real'],
      links: [
        { href: 'https://www.site.test/a', text: 'Click here' },
        { href: 'https://site.test/b#x', text: 'Pricing' },
        { href: 'https://www.site.test/c', text: 'Pricing' },
        { href: 'https://other.test/', text: 'Partner' },
        { href: 'https://other.test/', text: 'Partner' },
        { href: 'mailto:a@site.test', text: 'Email' },
        { href: 'tel:+1555', text: 'Call' },
        { href: `${u}#real`, text: 'Jump' },
        { href: `${u}#missing`, text: 'Jump 2' },
        { href: `${u}#top`, text: 'Top' },
        { href: 'javascript:void(0)', text: 'More', aria: '' },
        { href: 'https://www.site.test/logout', text: 'Log out' },
      ],
    }), { meta: {}, url: u });
    const k = r.data.links.kinds;
    assert.deepEqual(k, { internal: 4, external: 2, mailto: 1, tel: 1, fragment: 3, other: 1 });
    const t = titles(r);
    assert.ok(t.includes('2 links with vague text'));
    assert.ok(t.includes('1 link texts point to different places'));
    assert.ok(t.includes('1 links to missing in-page anchors'));
    assert.equal(r.findings.find((f) => f.title === '1 links to missing in-page anchors').severity, 'medium');
    assert.deepEqual(r.data.linkTargets.internal, ['https://www.site.test/a', 'https://site.test/b', 'https://www.site.test/c', 'https://www.site.test/logout']);
    assert.deepEqual(r.data.linkTargets.external, ['https://other.test/']);
    assert.equal(r.data.links.perThousandWords, 30); // 6 page links (4 internal + 2 external) / 200 words × 1000
  });

  test('link density finding only with ≥ 200 words', () => {
    const links = Array(30).fill(0).map((_, i) => ({ href: `https://www.site.test/p${i}`, text: `Page ${i}` }));
    const many = analyze(base({ text: words(200), links: [...links, ...links] }), { meta: {}, url: 'https://www.site.test/' });
    assert.ok(titles(many).some((x) => x.startsWith('Very link-dense')));
    const short = analyze(base({ text: words(100), links: [...links, ...links] }), { meta: {}, url: 'https://www.site.test/' });
    assert.ok(!titles(short).some((x) => x.startsWith('Very link-dense')));
  });

  test('run() wires ctx: skips without collected data, uses meta and document size', async () => {
    assert.throws(() => plugin.run({ log: { entries: [] } }, { collected: undefined, skip: (m) => { throw new Error(m); } }), /no page data/);
    const reading = { log: { entries: [{ request: { url: 'https://www.site.test/' }, response: { status: 200, content: { size: 1000, mimeType: 'text/html' }, headers: [] }, _resourceType: 'document' }], _harplus: { target: { finalUrl: 'https://www.site.test/' } } } };
    const out = plugin.run(reading, { collected: base({ url: 'https://www.site.test/', text: words(300), bodyTextBytes: 50 }), results: { meta: { data: { title: 'T', og: {}, structuredTypes: [] } } }, target: reading.log._harplus.target, util, skip: () => {} });
    assert.ok(out.findings.some((f) => f.title === 'Mostly markup (5% text)'));
    assert.ok(out.summary.length > 0);
  });
  ```

  The `run()` test needs `ctx.util.mainEntry(reading)` to find the document entry. If the fixture entry shape doesn't match how `mainEntry` and `resourceType` detect documents, read `har-util.js` and adjust the entry. The `_resourceType` field or the mime type is what `resourceType` checks.

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/content.test.mjs`

  Expected: FAIL, because the module `content.js` is not found.

- [ ] **Step 3: Implement `extension/plugins/content.js`:**

  ```js
  // Content: reading level, structure / information architecture and links on the page.
  // collect() runs in the page (self-contained); analyze() is pure and unit-tested.

  const VAGUE = new Set(['click here', 'here', 'read more', 'learn more', 'more', 'click', 'this', 'link', 'details', 'continue']);
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  const SESSION = /^(sid|sessionid|jsessionid|phpsessid)$/i;

  function collect() {
    const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
    const pick = () => {
      const main = document.querySelector('main, [role=main]');
      if (main) return main;
      const articles = document.querySelectorAll('article');
      if (articles.length === 1) return articles[0];
      const body = document.body.cloneNode(true);
      for (const el of body.querySelectorAll('nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], script, style, noscript, template')) el.remove();
      return body;
    };
    const root = pick();
    const live = root.isConnected;
    const text = (live ? root.innerText : root.textContent) || '';
    const paragraphs = [...root.querySelectorAll('p, li, dd, blockquote')]
      .map((p) => clean(live ? p.innerText : p.textContent))
      .filter((t) => t.length >= 20).slice(0, 400).map((t) => ({ text: t.slice(0, 3000) }));
    const depthOf = (el) => {
      let max = 0;
      for (const l of el.querySelectorAll('ul, ol')) {
        let d = 0;
        for (let p = l; p && p !== el; p = p.parentElement) if (p.matches('ul, ol')) d++;
        max = Math.max(max, d);
      }
      return max;
    };
    const navs = [...document.querySelectorAll('nav, [role=navigation]')].slice(0, 20).map((n) => ({
      links: n.querySelectorAll('a[href]').length, depth: depthOf(n), label: clean(n.getAttribute('aria-label') || n.className || '').slice(0, 60),
    }));
    const breadcrumb = !!document.querySelector('nav[aria-label*="breadcrumb" i], [class*="breadcrumb" i]');
    const links = [...document.querySelectorAll('a[href]')].slice(0, 3000).map((a) => ({
      href: a.href, text: clean(a.innerText || a.textContent).slice(0, 120), aria: clean(a.getAttribute('aria-label')).slice(0, 120),
    }));
    const ids = [...document.querySelectorAll('[id], a[name]')].map((el) => el.id || el.getAttribute('name')).filter(Boolean);
    return {
      url: location.href,
      lang: document.documentElement.lang || '',
      text: text.slice(0, 200_000),
      bodyTextBytes: new TextEncoder().encode(document.body?.innerText || '').length,
      paragraphs,
      headings: [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].slice(0, 300).map((x) => ({ level: Number(x.tagName[1]), text: clean(x.innerText || x.textContent).slice(0, 300) })),
      navs, breadcrumb, links, ids: [...new Set(ids)].slice(0, 5000),
    };
  }

  export function countWords(text = '') {
    const cjk = (text.match(CJK) || []).length;
    const rest = text.replace(CJK, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    return rest + Math.round(cjk / 2);
  }

  export function syllables(word = '') {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return 0;
    if (w.length <= 3) return 1;
    const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
    const groups = trimmed.match(/[aeiouy]{1,2}/g);
    return Math.max(1, groups ? groups.length : 1);
  }

  export function flesch({ words, sentences, syllables: syl }) {
    if (!words || !sentences) return null;
    const wps = words / sentences;
    const spw = syl / words;
    return { ease: 206.835 - 1.015 * wps - 84.6 * spw, grade: 0.39 * wps + 11.8 * spw - 15.59 };
  }

  export function splitSentences(text = '') {
    return text.split(/[.!?]+(?=\s|$)|[。！？]+/).map((s) => s.trim()).filter((s) => /[\p{L}\p{N}]/u.test(s));
  }

  const noHash = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return null; } };
  const siteOfHost = (host) => host.replace(/^www\./, '');

  function englishText(lang, text) {
    if (lang) return /^en\b/i.test(lang);
    const letters = text.match(/\p{L}/gu) || [];
    return letters.length > 0 && letters.filter((c) => /[a-z]/i.test(c)).length / letters.length > 0.9;
  }

  /** Pure analysis of collected page data. meta: meta plugin data; docBytes: HTML document size from the HAR. */
  export function analyze(c, { meta = {}, url = c.url, docBytes = 0 } = {}) {
    const findings = [];
    const add = (severity, title, detail) => findings.push({ severity, category: 'content', title, ...(detail ? { detail } : {}) });

    // Reading
    const words = countWords(c.text);
    const sentences = splitSentences(c.text);
    const lens = sentences.map((s) => countWords(s));
    const longShare = lens.length ? lens.filter((n) => n > 25).length / lens.length : 0;
    const paraWords = c.paragraphs.map((p) => countWords(p.text));
    const walls = c.paragraphs.filter((_, i) => paraWords[i] > 150);
    const english = englishText(c.lang, c.text);
    const syl = english ? (c.text.match(/[A-Za-z]+/g) || []).reduce((n, w) => n + syllables(w), 0) : 0;
    const f = english ? flesch({ words, sentences: sentences.length, syllables: syl }) : null;
    const reading = {
      words, minutes: Math.max(1, Math.ceil(words / 230)), sentences: sentences.length,
      avgSentence: lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0,
      longShare, paragraphs: c.paragraphs.length,
      avgParagraph: paraWords.length ? Math.round(paraWords.reduce((a, b) => a + b, 0) / paraWords.length) : 0,
      walls: walls.length, english,
      flesch: f ? Math.round(f.ease) : null, grade: f ? Math.round(f.grade) : null,
      readability: english ? (f ? 'flesch' : 'not enough text') : `not applicable: page language is ${c.lang || 'unknown'}`,
      buckets: [[1, 10], [11, 15], [16, 20], [21, 25], [26, 35], [36, Infinity]].map(([lo, hi]) => ({
        label: hi === Infinity ? `${lo}+` : `${lo}–${hi}`, value: lens.filter((n) => n >= lo && n <= hi).length,
      })),
    };
    if (lens.length && longShare > 0.3) add('low', `Many long sentences (${Math.round(longShare * 100)}% over 25 words)`);
    if (walls.length) add('low', `${walls.length} wall-of-text paragraphs`, walls.slice(0, 3).map((p) => `“${p.text.slice(0, 80)}…”`).join(' '));
    if (words < 250) add('info', `Thin content (${words} words)`);
    if (f && f.ease < 50) add(f.ease < 30 ? 'medium' : 'low', `Hard to read (Flesch ${Math.round(f.ease)}, grade ${Math.round(f.grade)})`);
    const textShare = docBytes ? c.bodyTextBytes / docBytes : null;
    if (textShare != null && textShare < 0.1) add('low', `Mostly markup (${Math.round(textShare * 100)}% text)`);

    // Structure
    const heads = c.headings;
    let skipped = 0;
    heads.forEach((x, i) => { if (i && x.level > heads[i - 1].level + 1) skipped++; });
    const empty = heads.filter((x) => !x.text).length;
    const longHeads = heads.filter((x) => x.text.length > 120).length;
    if (skipped) add('low', `${skipped} skipped heading levels`);
    if (empty) add('medium', `${empty} empty headings`);
    if (longHeads) add('info', `${longHeads} very long headings`);
    const title = (meta.title || '').trim();
    const h1 = heads.find((x) => x.level === 1)?.text || '';
    const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    let host = '';
    try { host = new URL(url).hostname; } catch { /* keep empty */ }
    const brand = siteOfHost(host).split('.')[0] || '';
    const siteName = meta.og?.['og:site_name'] || '';
    if (title && h1 && norm(title) === norm(h1)) add('info', 'Title repeats the h1');
    else if (title && ((siteName && norm(title) === norm(siteName)) || (brand && norm(title).split(' ').every((w) => w === brand)))) add('info', 'Title is only the site name');
    const navLinks = c.navs.reduce((n, x) => n + x.links, 0);
    if (navLinks > 60) add('low', `Menu overload (${navLinks} links in navigation)`);
    let path = '/';
    let params = [];
    try { const u = new URL(url); path = u.pathname; params = [...u.searchParams.keys()]; } catch { /* keep defaults */ }
    const depth = path.split('/').filter(Boolean).length;
    const breadcrumbs = c.breadcrumb || (meta.structuredTypes || []).includes('BreadcrumbList');
    if (!breadcrumbs && depth >= 2) add('info', `No breadcrumbs on a page ${depth} levels deep`);
    const shape = [
      depth > 4 && `depth ${depth}`, url.length > 100 && `${url.length} characters`,
      /[A-Z]/.test(path) && 'uppercase', path.includes('_') && 'underscores', params.some((p) => SESSION.test(p)) && 'session id',
    ].filter(Boolean);
    if (shape.length) add('info', `URL shape: ${shape.join(', ')}`);

    // Links
    const here = noHash(url);
    const site = siteOfHost(host);
    const kinds = { internal: 0, external: 0, mailto: 0, tel: 0, fragment: 0, other: 0 };
    const internal = []; const external = [];
    const byText = new Map();
    const vague = []; const missing = [];
    const idSet = new Set(c.ids);
    for (const l of c.links) {
      let u;
      try { u = new URL(l.href, url); } catch { kinds.other++; continue; }
      const label = (l.text || l.aria || '').toLowerCase().trim();
      if (VAGUE.has(label)) vague.push(l);
      if (u.protocol === 'mailto:') { kinds.mailto++; continue; }
      if (u.protocol === 'tel:') { kinds.tel++; continue; }
      if (!/^https?:$/.test(u.protocol)) { kinds.other++; continue; }
      const dest = noHash(u.href);
      if (u.hash && dest === here) {
        kinds.fragment++;
        const id = decodeURIComponent(u.hash.slice(1));
        if (id && id !== 'top' && !idSet.has(id)) missing.push(l);
        continue;
      }
      const isInternal = siteOfHost(u.hostname) === site;
      kinds[isInternal ? 'internal' : 'external']++;
      const bucket = isInternal ? internal : external;
      if (!bucket.includes(dest) && bucket.length < 500) bucket.push(dest);
      if (label) {
        if (!byText.has(label)) byText.set(label, new Set());
        byText.get(label).add(dest);
      }
    }
    const conflicting = [...byText].filter(([, d]) => d.size > 1);
    const pageLinks = kinds.internal + kinds.external;
    const perThousandWords = words ? Math.round((pageLinks / words) * 1000) : 0;
    if (vague.length) add('low', `${vague.length} links with vague text`, vague.slice(0, 10).map((l) => `“${l.text || l.aria}” → ${l.href}`).join('; '));
    if (conflicting.length) add('low', `${conflicting.length} link texts point to different places`, conflicting.slice(0, 10).map(([t, d]) => `“${t}”: ${[...d].join(', ')}`).join('; '));
    if (missing.length) add('medium', `${missing.length} links to missing in-page anchors`, missing.slice(0, 10).map((l) => l.href).join(', '));
    if (words >= 200 && perThousandWords > 100) add('low', `Very link-dense (${perThousandWords} links per 1,000 words)`);

    const summary = [
      { label: 'Reading', value: `${words.toLocaleString()} words · ${reading.minutes} min${reading.flesch != null ? ` · Flesch ${reading.flesch}` : ''}`, headline: true },
      { label: 'Links', value: `${kinds.internal} internal · ${kinds.external} external`, headline: true },
      { label: 'Headings', value: `${heads.length}${skipped ? ` · ${skipped} skipped levels` : ''}` },
      { label: 'Navigation', value: c.navs.length ? `${c.navs.length} nav · ${navLinks} links` : 'none' },
    ];
    return {
      data: {
        reading, textShare,
        structure: { headings: heads, skipped, empty, navs: c.navs, navLinks, breadcrumbs, depth, shape },
        links: { kinds, perThousandWords, vague: vague.slice(0, 20), conflicting: conflicting.slice(0, 20).map(([t, d]) => ({ text: t, destinations: [...d] })), missing: missing.slice(0, 20) },
        linkTargets: { internal, external },
      },
      findings, summary,
    };
  }

  function run(reading, ctx) {
    const c = ctx.collected;
    if (!c) ctx.skip('no page data');
    const meta = ctx.results?.meta?.data || {};
    const url = ctx.target?.finalUrl || ctx.target?.url || c.url;
    const doc = ctx.util?.mainEntry?.(reading);
    return analyze(c, { meta, url, docBytes: doc?.response?.content?.size || 0 });
  }

  const fleschStatus = (e) => (e == null ? 'none' : e >= 60 ? 'good' : e >= 50 ? 'warning' : e >= 30 ? 'serious' : 'critical');

  function glance(r, h) {
    const d = r.data;
    const rd = d.reading;
    return h.html`<div class="tiles">
      ${h.stat({ label: 'Words', value: rd.words.toLocaleString(), note: `${rd.minutes} min read` })}
      ${h.stat({ label: 'Average sentence', value: `${rd.avgSentence} words`, note: `${Math.round(rd.longShare * 100)}% over 25 words` })}
      ${h.stat({ label: 'Paragraphs', value: String(rd.paragraphs), note: rd.walls ? `${rd.walls} walls of text` : 'none over 150 words' })}
      ${h.stat({ label: 'Links', value: `${d.links.kinds.internal} · ${d.links.kinds.external}`, note: 'internal · external' })}
    </div>
    <div class="glance-grid">
      ${rd.flesch != null ? h.html`<section class="card"><h4>Readability</h4>${h.ring({ value: Math.max(0, Math.min(100, rd.flesch)), size: 72, status: fleschStatus(rd.flesch), label: 'Flesch reading ease' })}<p class="note">Flesch ${rd.flesch} · grade ${rd.grade}</p></section>` : ''}
      <section class="card"><h4>Sentence length</h4>${h.hbars({ label: 'Sentences by length in words', rows: rd.buckets.map((b) => ({ label: b.label, value: b.value, display: String(b.value) })) })}</section>
    </div>`;
  }

  function render(r, h) {
    const d = r.data;
    const s = d.structure;
    return h.html`
      ${h.sub('Reading', h.kv([
        ['Words', `${d.reading.words} · ${d.reading.minutes} min`], ['Sentences', `${d.reading.sentences} · average ${d.reading.avgSentence} words`],
        ['Paragraphs', `${d.reading.paragraphs} · average ${d.reading.avgParagraph} words`], ['Readability', d.reading.flesch != null ? `Flesch ${d.reading.flesch} · grade ${d.reading.grade}` : d.reading.readability],
        ['Text vs markup', d.textShare != null ? `${Math.round(d.textShare * 100)}% text` : ''],
      ]))}
      ${h.sub('Heading outline', h.outline(s.headings))}
      ${h.sub('Navigation', h.kv([
        ['Menus', s.navs.length ? s.navs.map((n) => `${n.label || 'nav'}: ${n.links} links, depth ${n.depth}`).join(' · ') : 'none'],
        ['Breadcrumbs', s.breadcrumbs ? 'yes' : 'no'], ['URL', s.shape.length ? s.shape.join(', ') : `depth ${s.depth}`],
      ]))}
      ${h.sub('Vague link text', h.table(d.links.vague.map((l) => ({ text: l.text || l.aria, href: h.link(l.href) })), [{ key: 'text', label: 'Text' }, { key: 'href', label: 'Link' }]))}
      ${h.sub('Same text, different places', h.table(d.links.conflicting.map((x) => ({ text: x.text, to: x.destinations.join(' · ') })), [{ key: 'text', label: 'Text' }, { key: 'to', label: 'Destinations' }]))}
      ${h.sub('Missing in-page anchors', h.list(d.links.missing.map((l) => l.href)))}
    `;
  }

  export default {
    id: 'content',
    group: 'quality',
    area: 'content',
    name: 'Content',
    version: '0.1.0',
    phase: 'page',
    after: ['meta'],
    description: 'Reading level, heading structure, navigation and links on the page.',
    tags: ['content'],
    collect,
    run,
    glance,
    render,
  };
  ```

  In `extension/plugins/index.js`, add `import content from './content.js';` and change the first `BUILTIN` row to `meta, content, html, css, vitals, images, a11yBasics, axe,`.

  Check that `h.hbars` accepts `{ rows: [{ label, value, display }] }`. If its row shape differs, read `extension/ui/charts.js` `hbars` and match it.

  Check that `util.mainEntry` exists in `ctx.util`; `makeContext` passes the whole `har-util` module.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `node --test test/content.test.mjs`, then `npm test`.

  Expected: PASS. If a hand-written number in a test disagrees with the specified code, work through the arithmetic by hand. Fix the test only if the test's arithmetic is wrong. Report NEEDS_CONTEXT if the code contradicts the spec.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/content.js extension/plugins/index.js test/content.test.mjs
  git commit -m "Content plugin: readability, structure and information architecture, links on the page

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 5: The `links` plugin (link check + Open Graph image)

**Files:**
- Create: `extension/plugins/links.js`
- Modify: `extension/plugins/index.js` (add `links` to the third `BUILTIN` row after `htmlValidate, cssValidate,`)
- Modify: `cli/harplus.mjs` (`--no-link-check`)
- Test: `test/links.test.mjs` (new), `test/cli.test.mjs`

**Interfaces:**
- Consumes:
  - `ctx.results.content.data.linkTargets` (Task 4);
  - `ctx.results.meta.data.og['og:image']`;
  - `ctx.fetch`, `ctx.options` (`external`, `max`), `ctx.progress` (Task 3) and `ctx.signal`.
- Produces: the result data `{ checked: [{ url, status, finalUrl, redirected, ms, error?, skipped? }], ogImage: { url, status, width?, height?, error? } | null }`.

- [ ] **Step 1: Write the failing tests** in `test/links.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import plugin from '../extension/plugins/links.js';
  import { getPlugins } from '../extension/plugins/index.js';

  // fetch stub: routes[url] = { status, finalUrl?, headFails?, headStatus? } ; records method per call
  function stub(routes, calls = []) {
    return async (url, init = {}) => {
      calls.push(`${init.method || 'GET'} ${url}`);
      const r = routes[url];
      if (!r || r.throws) throw new TypeError('network');
      if (init.method === 'HEAD' && r.headFails) throw new TypeError('network');
      const status = init.method === 'HEAD' && r.headStatus ? r.headStatus : r.status;
      const res = new Response(init.method === 'HEAD' ? null : (r.body ?? ''), { status });
      Object.defineProperty(res, 'url', { value: r.finalUrl || url });
      Object.defineProperty(res, 'redirected', { value: !!r.finalUrl && r.finalUrl !== url });
      return res;
    };
  }
  const ctx = ({ routes = {}, internal = [], external = [], og, options = {}, calls = [], progress = [] } = {}) => ({
    results: {
      content: { status: 'ok', data: { linkTargets: { internal, external } } },
      meta: { status: 'ok', data: { og: og ? { 'og:image': og } : {} } },
    },
    options: { external: false, max: 150, ...options },
    fetch: stub(routes, calls),
    progress: (t) => progress.push(t),
    signal: new AbortController().signal,
    skip: (m) => { const e = new Error(m); e.name = 'SkipError'; throw e; },
  });
  const titles = (r) => r.findings.map((f) => f.title);

  test('registered in enrich after content, Content area, options and disclosure', () => {
    assert.ok(getPlugins().some((p) => p.id === 'links'));
    assert.equal(plugin.phase, 'enrich');
    assert.equal(plugin.area, 'content');
    assert.deepEqual(plugin.after, ['content']);
    assert.deepEqual(plugin.options.map((o) => [o.key, o.default]), [['external', false], ['max', 150]]);
    assert.match(plugin.disclosure, /HEAD, no cookies/);
  });

  test('skips with a reason when content data is missing', async () => {
    const c = ctx();
    delete c.results.content;
    await assert.rejects(() => plugin.run({}, c), /needs the Content plugin/);
  });

  test('HEAD first, GET fallback on 405; broken, redirected, insecure, timeouts', async () => {
    const calls = [];
    const progress = [];
    const r = await plugin.run({}, ctx({
      calls, progress,
      internal: ['https://s.test/ok', 'https://s.test/gone', 'https://s.test/old', 'https://s.test/nohead', 'https://s.test/down', 'https://s.test/insecure', 'https://s.test/logout'],
      routes: {
        'https://s.test/ok': { status: 200 },
        'https://s.test/gone': { status: 404 },
        'https://s.test/old': { status: 200, finalUrl: 'https://s.test/new' },
        'https://s.test/nohead': { status: 200, headStatus: 405 },
        'https://s.test/down': { throws: true },
        'https://s.test/insecure': { status: 200, finalUrl: 'http://s.test/insecure' },
      },
    }));
    assert.ok(calls.includes('HEAD https://s.test/nohead') && calls.includes('GET https://s.test/nohead'));
    assert.ok(!calls.some((c) => c.includes('/logout')), 'logout never requested');
    const t = titles(r);
    assert.ok(t.includes('Broken link: 404 /gone'));
    assert.ok(t.includes('Link redirects to insecure HTTP'));
    assert.ok(t.includes('1 links redirect — update them to their final URL'));
    assert.ok(t.includes('1 links timed out or failed to load'));
    assert.equal(r.findings.find((f) => f.title === 'Broken link: 404 /gone').severity, 'medium');
    assert.equal(r.findings.find((f) => f.title.startsWith('1 links timed out')).severity, 'info');
    assert.ok(r.findings.every((f) => f.category === 'content'));
    assert.equal(r.data.checked.find((x) => x.url === 'https://s.test/logout').skipped, 'looks like a sign-out or destructive link');
    assert.equal(progress.at(-1), 'Checking links 6/6');
    assert.match(r.summary[0].value, /^6 checked · 1 broken · 2 redirects$/);
  });

  test('more than 10 broken links: 10 findings plus one "and N more"', async () => {
    const internal = Array(13).fill(0).map((_, i) => `https://s.test/x${i}`);
    const routes = Object.fromEntries(internal.map((u) => [u, { status: 500 }]));
    const r = await plugin.run({}, ctx({ internal, routes }));
    assert.equal(r.findings.filter((f) => f.title.startsWith('Broken link:')).length, 10);
    assert.ok(titles(r).includes('…and 3 more broken links'));
  });

  test('external only when enabled; max caps the list', async () => {
    const calls = [];
    await plugin.run({}, ctx({ calls, internal: ['https://s.test/a'], external: ['https://o.test/'], routes: { 'https://s.test/a': { status: 200 }, 'https://o.test/': { status: 200 } } }));
    assert.ok(!calls.some((c) => c.includes('o.test')));
    const calls2 = [];
    await plugin.run({}, ctx({ calls: calls2, options: { external: true, max: 1 }, internal: ['https://s.test/a'], external: ['https://o.test/'], routes: { 'https://s.test/a': { status: 200 }, 'https://o.test/': { status: 200 } } }));
    assert.deepEqual(calls2, ['HEAD https://s.test/a']);
  });

  test('og:image: load failure is medium; no createImageBitmap (Node) → status only, no size finding', async () => {
    const bad = await plugin.run({}, ctx({ og: 'https://s.test/og.png', routes: {} }));
    assert.ok(titles(bad).includes('Open Graph image does not load'));
    assert.equal(bad.findings.find((f) => f.title === 'Open Graph image does not load').severity, 'medium');
    const good = await plugin.run({}, ctx({ og: 'https://s.test/og.png', routes: { 'https://s.test/og.png': { status: 200, body: 'xx' } } }));
    assert.equal(good.data.ogImage.status, 200);
    assert.equal(good.data.ogImage.width, undefined);
    assert.ok(!titles(good).some((x) => x.startsWith('Open Graph image')));
  });

  test('og:image smaller than 1200×630 → low', async () => {
    const saved = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => ({ width: 600, height: 315, close() {} });
    try {
      const r = await plugin.run({}, ctx({ og: 'https://s.test/og.png', routes: { 'https://s.test/og.png': { status: 200, body: 'xx' } } }));
      assert.ok(titles(r).includes('Open Graph image is 600×315 (1200×630 recommended)'));
    } finally {
      if (saved) globalThis.createImageBitmap = saved; else delete globalThis.createImageBitmap;
    }
  });
  ```

  Append to `test/cli.test.mjs`:

  ```js
  test('cli --no-link-check disables the links plugin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harplus-cli-'));
    const out = join(dir, 'x.plus.har');
    const input = join(dir, 'in.har');
    const har = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    delete har.log._harplus.plugins.links; // the refreshed fixture (Task 7) already carries a links result
    writeFileSync(input, JSON.stringify(har));
    execFileSync('node', [CLI, 'analyze', input, '--no-link-check', '--only', 'links', '-o', out, '--quiet'], { encoding: 'utf8' });
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).log._harplus.plugins.links, undefined);
  });
  ```

  `--only` overrides the enabled flags, so the CLI must also drop `links` from `only` when `--no-link-check` is set. Step 3 implements this.

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/links.test.mjs test/cli.test.mjs`

  Expected: FAIL, because the module `links.js` is not found and `--no-link-check` is an unknown option.

- [ ] **Step 3: Implement `extension/plugins/links.js`:**

  ```js
  // Link check: requests the page's own links (HEAD, no cookies) and its Open Graph image.

  const SKIP = /log-?out|sign-?out|logoff|delete|remove|unsubscribe/i;
  const CONCURRENCY = 6;
  const TIMEOUT_MS = 10_000;

  async function request(ctx, url, method) {
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean));
    return ctx.fetch(url, { method, credentials: 'omit', redirect: 'follow', signal });
  }

  async function check(ctx, url) {
    const t0 = Date.now();
    let res;
    try {
      res = await request(ctx, url, 'HEAD');
      if (res.status === 405 || res.status === 501) res = null;
    } catch { res = null; }
    try {
      if (!res) {
        res = await request(ctx, url, 'GET');
        res.body?.cancel?.().catch(() => {});
      }
      return { url, status: res.status, finalUrl: res.url || url, redirected: !!res.redirected, ms: Date.now() - t0 };
    } catch (e) {
      return { url, status: 0, finalUrl: url, redirected: false, ms: Date.now() - t0, error: String(e?.message || e) };
    }
  }

  async function ogImage(ctx, url) {
    try {
      const res = await request(ctx, url, 'GET');
      if (!res.ok) return { url, status: res.status };
      const out = { url, status: res.status };
      if (typeof globalThis.createImageBitmap === 'function') {
        try {
          const bmp = await globalThis.createImageBitmap(await res.blob());
          out.width = bmp.width;
          out.height = bmp.height;
          bmp.close?.();
        } catch { /* SVG or undecodable: status only */ }
      }
      return out;
    } catch (e) {
      return { url, status: 0, error: String(e?.message || e) };
    }
  }

  async function run(reading, ctx) {
    const targets = ctx.results?.content?.data?.linkTargets;
    if (!targets) ctx.skip('needs the Content plugin’s page data — take a new reading in the extension');
    const list = [...targets.internal, ...(ctx.options.external ? targets.external : [])].slice(0, Number(ctx.options.max) || 150);
    const checked = [];
    const todo = [];
    for (const url of list) {
      if (!/^https?:/i.test(url)) checked.push({ url, skipped: 'not http(s)' });
      else if (SKIP.test(new URL(url).pathname + new URL(url).search)) checked.push({ url, skipped: 'looks like a sign-out or destructive link' });
      else todo.push(url);
    }
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const url = todo[next++];
        checked.push(await check(ctx, url));
        ctx.progress?.(`Checking links ${++done}/${todo.length}`);
      }
    };
    await Promise.all(Array(Math.min(CONCURRENCY, todo.length)).fill(0).map(worker));

    const findings = [];
    const add = (severity, title, detail) => findings.push({ severity, category: 'content', title, ...(detail ? { detail } : {}) });
    const ran = checked.filter((x) => !x.skipped);
    const broken = ran.filter((x) => x.status >= 400);
    const failed = ran.filter((x) => x.status === 0);
    const insecure = ran.filter((x) => x.status && x.status < 400 && x.redirected && x.url.startsWith('https:') && x.finalUrl.startsWith('http:'));
    const redirects = ran.filter((x) => x.status && x.status < 400 && x.redirected && !insecure.includes(x));
    const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
    for (const b of broken.slice(0, 10)) add('medium', `Broken link: ${b.status} ${pathOf(b.url)}`, b.url);
    if (broken.length > 10) add('medium', `…and ${broken.length - 10} more broken links`);
    for (const x of insecure) add('medium', 'Link redirects to insecure HTTP', `${x.url} → ${x.finalUrl}`);
    if (redirects.length) add('low', `${redirects.length} links redirect — update them to their final URL`, redirects.slice(0, 10).map((x) => `${x.url} → ${x.finalUrl}`).join('; '));
    if (failed.length) add('info', `${failed.length} links timed out or failed to load`, failed.slice(0, 10).map((x) => x.url).join(', '));

    const rawOg = ctx.results?.meta?.data?.og?.['og:image'];
    let ogUrl = null;
    try { ogUrl = rawOg ? new URL(rawOg, ctx.target?.finalUrl || ctx.target?.url || undefined).href : null; } catch { ogUrl = null; } // og:image may be relative
    const og = ogUrl ? await ogImage(ctx, ogUrl) : null;
    if (og && !(og.status >= 200 && og.status < 400)) add('medium', 'Open Graph image does not load', ogUrl);
    else if (og?.width && (og.width < 1200 || og.height < 630)) add('low', `Open Graph image is ${og.width}×${og.height} (1200×630 recommended)`, ogUrl);

    const order = (x) => (x.skipped ? 3 : x.status >= 400 || x.status === 0 ? 0 : x.redirected ? 1 : 2);
    checked.sort((a, b) => order(a) - order(b));
    return {
      data: { checked, ogImage: og },
      findings,
      summary: [{ label: 'Link check', value: `${ran.length} checked · ${broken.length} broken · ${redirects.length + insecure.length} redirects`, headline: true }],
    };
  }

  function render(r, h) {
    return h.html`${h.table(r.data.checked.map((x) => ({
      status: x.skipped ? `skipped: ${x.skipped}` : x.status || x.error || 'failed',
      url: h.link(x.url), final: x.redirected ? h.link(x.finalUrl) : '', ms: x.ms != null ? h.ms(x.ms) : '',
    })), [{ key: 'status', label: 'Status' }, { key: 'url', label: 'URL' }, { key: 'final', label: 'Final URL' }, { key: 'ms', label: 'Time' }])}
    ${r.data.ogImage ? h.sub('Open Graph image', h.kv([['URL', h.link(r.data.ogImage.url)], ['Status', r.data.ogImage.status || r.data.ogImage.error], ['Size', r.data.ogImage.width ? `${r.data.ogImage.width}×${r.data.ogImage.height}` : 'not measured']])) : ''}`;
  }

  export default {
    id: 'links',
    group: 'quality',
    area: 'content',
    name: 'Link check',
    version: '0.1.0',
    phase: 'enrich',
    after: ['content'],
    timeoutMs: 180_000,
    description: 'Checks the page’s links for broken pages and redirects, and the Open Graph image’s size.',
    disclosure: 'Requests each linked URL on this site (HEAD, no cookies). External links only when enabled.',
    tags: ['content'],
    options: [
      { key: 'external', label: 'Also check external links', type: 'checkbox', default: false },
      { key: 'max', label: 'Most links to check', type: 'number', default: 150 },
    ],
    run,
    render,
  };
  ```

  The broken count and the "redirects" summary must match the test, which expects `6 checked · 1 broken · 2 redirects`.
  - The six checked links are ok, gone, old, nohead, down and insecure (logout is skipped).
  - The one broken link is `gone`.
  - The two redirects are `old` plus `insecure`.
  - The `down` link failed: it has status 0 and is counted as neither broken nor a redirect.

  `ctx.signal` might be undefined in tests, which is why the code calls `.filter(Boolean)`. `AbortSignal.any` needs Node 20.3+ or Chrome 116+, and both are already required.

  In `extension/plugins/index.js`, add `import links from './links.js';` and change the third row to `htmlValidate, cssValidate, links, pagespeed, observatory,`.

  In `cli/harplus.mjs`:
  - Add `'no-link-check': { type: 'boolean' },` to the `parseArgs` options.
  - Add `      --no-link-check     skip the link check (links plugin)` to `USAGE`.
  - In `analyze()`, add `...(opts['no-link-check'] ? { links: { enabled: false } } : {}),` inside `plugins: { … }`.
  - Change `const only = list(opts.only);` to `const only = list(opts.only).filter((id) => !(opts['no-link-check'] && id === 'links'));`.
  - If `--only` was given and is now empty, nothing should run. Write `only: list(opts.only).length ? only : undefined`, so that an emptied `only` stays `[]` and runs nothing.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `node --test test/links.test.mjs test/cli.test.mjs`, then `npm test`.

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/links.js extension/plugins/index.js cli/harplus.mjs test/links.test.mjs test/cli.test.mjs
  git commit -m "Link check plugin: HEAD-first link check with progress, Open Graph image size; CLI --no-link-check

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 6: Metadata additions (`meta` plugin)

**Files:**
- Modify: `extension/plugins/meta.js` (`run`)
- Test: `test/plugins.test.mjs` (append)

**Interfaces:**
- Consumes: the existing `c.description`, `c.title`, `c.twitter`, `c.jsonld` and the `types` Set inside `run`.
- Produces three new findings. The structured-data types summary row (`Structured data`) and render (`Structured data types`) already exist; keep them.

- [ ] **Step 1: Write the failing test.** Append to `test/plugins.test.mjs`:

  ```js
  import meta from '../extension/plugins/meta.js';
  import * as hu from '../extension/core/har-util.js';

  test('meta: description quality, Twitter card, no structured data', () => {
    const collected = (over) => ({
      url: 'https://s.test/', title: 'A good page title here', description: 'A good page title here', canonical: 'https://s.test/',
      robots: '', googlebot: '', viewport: 'width=device-width', og: { 'og:title': 'x', 'og:image': 'y' }, twitter: {}, icons: ['/f.ico'],
      jsonld: [], jsonldErrors: [], compatMode: 'CSS1Compat', charset: 'UTF-8', images: { noDimensions: 0, total: 0 },
      forms: [], headings: [{ level: 1, text: 'H' }], links: { externalUrls: [] }, generator: [], emails: [], phones: [],
      words: 10, domElements: 10, customElements: [], ...over,
    });
    const run = (c) => meta.run({}, { collected: c, util: hu, target: { site: 's.test' }, skip: (m) => { throw new Error(m); } });
    const t = (c) => run(c).findings.map((f) => f.title);
    assert.ok(t(collected()).includes('Meta description is too short or repeats the title'));
    assert.ok(t(collected({ description: 'Short one' })).includes('Meta description is too short or repeats the title'));
    assert.ok(!t(collected({ description: 'A properly long description that says what the page offers to readers.' })).includes('Meta description is too short or repeats the title'));
    assert.ok(t(collected()).includes('No Twitter card tag'));
    assert.ok(!t(collected({ twitter: { 'twitter:card': 'summary' } })).includes('No Twitter card tag'));
    assert.ok(t(collected()).includes('No structured data (JSON-LD)'));
    assert.ok(!t(collected({ jsonld: [{ '@type': 'Organization' }] })).includes('No structured data (JSON-LD)'));
    const f = run(collected()).findings;
    assert.equal(f.find((x) => x.title === 'No Twitter card tag').category, 'seo');
    assert.equal(f.find((x) => x.title === 'No structured data (JSON-LD)').severity, 'info');
  });
  ```

  If `meta.run` reads a collected field that isn't in this stub and throws, add that field to `collected()` with an empty value. Do not change `meta.js` to suit the stub.

- [ ] **Step 2: Run it to watch it fail**

  Run: `node --test test/plugins.test.mjs`

  Expected: FAIL, because the new titles are missing.

- [ ] **Step 3: Implement.** In `meta.js` `run`, change the description lines to:

  ```js
    if (!c.description) add('low', 'seo', 'Missing meta description');
    else if (c.description.length > 170) add('info', 'seo', `Meta description is long (${c.description.length} characters)`);
    const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (c.description && (c.description.length < 50 || squash(c.description) === squash(c.title))) {
      add('low', 'seo', 'Meta description is too short or repeats the title');
    }
  ```

  Then, after the Open Graph line, add:

  ```js
    if (!c.twitter?.['twitter:card']) add('low', 'seo', 'No Twitter card tag');
    if (!c.jsonld.length) add('info', 'seo', 'No structured data (JSON-LD)');
  ```

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS. If an existing test counted meta findings exactly, update the count, and comment that the new checks explain the difference.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/meta.js test/plugins.test.mjs
  git commit -m "Metadata: description quality, Twitter card and no-structured-data checks

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 7: End-to-end coverage and fixture refresh

**Files:**
- Modify: `test/e2e/site/index.html`
- Modify: `test/e2e/server.mjs`
- Modify: `test/e2e/run.mjs`
- Modify: `test/fixtures/local-site.har`. Regenerate it from the e2e output `test/e2e/out/local-site.har`, the way earlier cycles did.

**Interfaces:**
- Consumes: everything above. Content pane id `area-content`, plugin ids `content` and `links`, `rescoreAll`, and the Options `#scoring` radio buttons.

- [ ] **Step 1: Extend the test site.**

  In `test/e2e/site/index.html`, add `<meta property="og:image" content="/img/big.jpg">` after the `og:title` meta. `big.jpg` is 1600×1000, so it loads and is large enough, which means no Open Graph finding. The small-image case is covered by the unit test in Task 5.

  Inside `<main>`, after `<h3>Skipped a level</h3>`, add:

  ```html
      <p>Read our <a href="/missing-page">click here</a> guide, the <a href="/old">old catalogue</a>, or jump to <a href="#nowhere">the specs</a>.</p>
  ```

  `/missing-page` returns 404 through the server's fallback. `/old` already redirects with a 301 to `/`. The `#nowhere` anchor has no matching id.

  In `test/e2e/server.mjs`, delay `/missing-page` by 400 ms, so the "Checking links" progress text can be seen. Add this before the static-file lookup:

  ```js
      if (path === '/missing-page') {
        await new Promise((r) => setTimeout(r, 400));
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<!doctype html><title>Not found</title><h1>404</h1>');
      }
  ```

- [ ] **Step 2: Add the e2e assertions** in `test/e2e/run.mjs`.
  - In the pane list (around line 251), insert `'area-content'` after `'area-security'`.
  - After the first reading `r1` is loaded (find where the run reads `r1`'s plugins and asserts them), add:

    ```js
        const pc = r1.log._harplus.plugins;
        assert.equal(pc.content?.status, 'ok', `content: ${pc.content?.error}`);
        assert.ok(pc.content.findings.some((f) => f.title === '1 links with vague text'), 'vague link found');
        assert.ok(pc.content.findings.some((f) => f.title === '1 links to missing in-page anchors'), 'missing anchor found');
        assert.equal(pc.links?.status, 'ok', `links: ${pc.links?.error}`);
        assert.ok(pc.links.findings.some((f) => f.title === 'Broken link: 404 /missing-page'), 'broken link found');
        assert.ok(pc.links.findings.some((f) => /links redirect/.test(f.title)), 'redirect found');
        assert.equal(pc.links.data.ogImage?.width, 1600);
        log('content + link check passed');
    ```

  - Where the progress tab is watched during the first reading, record each plugin row's text. Then assert that some captured text matched `/Checking links \d+\/\d+/`. Here is one way:
    1. Before starting the capture, register `context.on('page', …)` for the progress tab (reuse the existing handle if `run.mjs` already keeps one).
    2. Poll the progress tab every 100 ms with `progressPage.evaluate(() => [...document.querySelectorAll('.prog-text')].map((x) => x.textContent).join('|'))` until `waitDone` resolves.
    3. Collect the strings into an array, then:

    ```js
        assert.ok(progressTexts.some((t) => /Checking links \d+\/\d+/.test(t)), 'link check progress shown');
    ```

  - In the Options section (around line 306), after `waitForSelector('#plugins input')`, add:

    ```js
        const before = await page2.evaluate(async () => (await (await import('/browser/store.js')).listReadings()).map((r) => [r.id, r.score, r.profile]));
        await page2.check('#scoring input[name="profile"][value="public"]');
        await page2.waitForFunction(() => /Re-scored \d+ readings/.test(document.querySelector('#rescore')?.textContent || ''), null, { timeout: 30000 });
        const after = await page2.evaluate(async () => (await (await import('/browser/store.js')).listReadings()).map((r) => [r.id, r.score, r.profile]));
        assert.ok(after.every(([, , p]) => p === 'public'), 'index re-scored with Public sector');
        assert.ok(after.some(([id, s]) => s !== before.find((b) => b[0] === id)?.[1]), 'at least one overall score changed');
        await page2.check('#scoring input[name="profile"][value="general"]');
        await page2.waitForFunction(() => /Re-scored/.test(document.querySelector('#rescore')?.textContent || ''));
    ```

    If no stored reading's score changes under Public sector, compare `pub` against `general` on `r1` directly with `scoreReading`. That is acceptable: the rule being tested is that re-scoring writes the profile id and new scores.

- [ ] **Step 3: Run the e2e test**

  Run: `npm run test:e2e`

  Expected: `all e2e checks passed`.

- [ ] **Step 4: Refresh the fixture**

  Run `cp test/e2e/out/local-site.har test/fixtures/local-site.har`, then `npm test`.

  Expected: PASS. The fixture now contains `content` and `links` results, so the report tests render the Content pane with real data.

- [ ] **Step 5: Commit**

  ```bash
  git add test/e2e/site/index.html test/e2e/server.mjs test/e2e/run.mjs test/fixtures/local-site.har
  git commit -m "E2E: Content pane, link check with progress, profile re-scoring; refreshed fixture

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```
