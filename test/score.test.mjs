import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AREAS, PROFILES, grade, status, pluginArea, resultArea, normRating, scoreReading, topFindings, summarize,
  resolveProfile, profileFromSettings, carbonScore, CAP,
  BREADTH_SHARE, EXTENT_MAX, EXTENT_FULL, EXTENT_SMOOTH, EXTENT_WEIGHT, EXTENT_AREAS, DEDUCT,
  extentOf, scoreTable, scoreRule,
} from '../extension/core/score.js';
import { getPlugins } from '../extension/plugins/index.js';
import axe from '../extension/plugins/axe.js';

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
  assert.equal(byId.meta, 'content');
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
    ...Array(5).fill(0).map((_, i) => f('high', 'security', `h${i}`)), // 75 → capped at 55
    f('medium', 'privacy'), f('low', 'security'), f('info', 'security'),
  ];
  const s = scoreReading(reading({ security: ok('security', findings) }), getPlugins());
  const a = s.areas.security;
  assert.equal(a.score, 100 - 55 - 6 - 2);
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
  assert.equal(s.areas.accessibility.score, 99); // extent area: 100 − 0.6 × 2 = 98.8
  assert.equal(s.areas.build.score, 100);
});

test('performance blends vitals ratings, lighthouse wins when present', () => {
  const vitals = ok('vitals', [], { data: { ratings: { lcp: 'needs improvement', cls: 'good', fcp: 'good', ttfb: 'poor' } } });
  const s1 = scoreReading(reading({ vitals }), getPlugins());
  // findings 100, metric (60+100+100+20)/4 = 70 → (2×70 + 100)/3 = 80
  assert.equal(s1.areas.performance.score, 80);
  assert.deepEqual(s1.areas.performance.inputs.map((i) => i.label), ['Findings', 'Web vitals ratings']);
  const pagespeed = ok('pagespeed', [], { data: { lab: { scores: { performance: 0.4, accessibility: 0.9 } } } });
  const s2 = scoreReading(reading({ vitals, pagespeed, 'a11y-basics': ok('a11y-basics') }), getPlugins());
  assert.equal(s2.areas.performance.score, 60); // (2×40 + 100) / 3
  assert.equal(s2.areas.accessibility.score, 93); // (2×90 + 100) / 3 = 93.3
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
  assert.equal(s.overall.score, Math.round((70 * 18 + 100 * 9) / 27));
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
    'a11y-basics': ok('a11y-basics', [f('high', 'accessibility', '2 form fields without labels'), f('high', 'accessibility', 'x'), f('high', 'accessibility', 'y'), f('high', 'accessibility', 'z'), f('high', 'accessibility', 'w')]), // 100 − 0.6 × 55 = 67
  }), getPlugins());
  assert.equal(summarize(s), 'Strong on security, weak on accessibility. Top issue: 2 form fields without labels.');
});

test('eight areas; General weights on AREAS', () => {
  assert.deepEqual(AREAS.map((a) => `${a.id}:${a.weight}`), [
    'performance:18', 'accessibility:18', 'security:18', 'content:12', 'build:10', 'infrastructure:9', 'international:8', 'sustainability:7',
  ]);
  assert.equal(AREAS.find((a) => a.id === 'build').label, 'Build');
  assert.equal(AREAS.find((a) => a.id === 'content').label, 'Content');
  assert.equal(pluginArea({ area: 'content' }), 'content');
});

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

test('old reading: eight areas, new ones unmeasured', () => {
  const s = scoreReading(reading({ security: ok('security') }), getPlugins());
  assert.equal(Object.keys(s.areas).length, 8);
  assert.equal(s.areas.international.score, null);
  assert.equal(s.areas.sustainability.status, 'none');
});

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
    'a11y-basics': ok('a11y-basics', [...highs(4, 'accessibility'), f('medium', 'accessibility'), f('medium', 'accessibility'), f('medium', 'accessibility'), f('medium', 'accessibility'), f('medium', 'accessibility')]), // 100 − 0.6 × (55 + 30) = 49
    security: ok('security'), dns: ok('dns'), international: ok('international', [], { area: 'international' }),
    html: ok('html'), meta: ok('meta'), vitals: ok('vitals'),
  });
  // public: (49×24 + 100×(10+6+14+6+14+14)) / 88 = 7576/88 → 86, capped to 69
  const gen = scoreReading(r, getPlugins());
  assert.equal(gen.overall.capped, null);
  const pub = scoreReading(r, getPlugins(), { profile: 'public' });
  assert.ok(pub.overall.capped, 'capped');
  assert.deepEqual(pub.overall.capped.areas, ['accessibility']);
  assert.equal(pub.overall.score, 69);
  assert.equal(pub.overall.grade, 'D+'); // 69: D band 60–69, ≥ 67 gets “+”
  assert.equal(pub.overall.capped.from, 86);
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

test('old readings: stored area is ignored when a current plugin matches', () => {
  const r = reading({ meta: ok('meta', [f('medium', 'seo'), f('low', 'seo')], { area: 'build' }) });
  const s = scoreReading(r, getPlugins());
  assert.equal(s.areas.content.measured, true);
  assert.equal(s.areas.content.score, 92);
});

test('an ok result routing a finding into an area marks it measured (CLI well-known)', () => {
  const r = reading({ 'well-known': ok('well-known', [f('medium', 'seo', 'robots.txt blocks all crawlers')]) });
  const s = scoreReading(r, getPlugins());
  assert.equal(s.areas.content.measured, true);
  assert.equal(s.areas.content.score, 94);
});

test('failing critical areas are named even when the cap does not lower the score', () => {
  const bad = (cat) => [...Array(4).fill(0).map((_, i) => f('high', cat, `${cat}${i}`)), ...Array(5).fill(0).map((_, i) => f('medium', cat, `${cat}m${i}`))];
  const r = reading({
    'a11y-basics': ok('a11y-basics', bad('accessibility')),
    international: ok('international', bad('international'), { area: 'international' }),
    security: ok('security'),
  });
  const s = scoreReading(r, getPlugins(), { profile: 'public' });
  assert.equal(s.overall.capped, null);
  assert.deepEqual(s.overall.failingCritical, ['accessibility', 'international']);
  assert.match(summarize(s), /^Accessibility and International are failing \(critical for Public sector \/ education\)\. /);
  assert.deepEqual(scoreReading(r, getPlugins()).overall.failingCritical, []);
});

test('an area score never goes below 0 when the severity caps add up past 100', () => {
  const many = (n, severity) => Array.from({ length: n }, () => f(severity, 'security'));
  const r = scoreReading(reading({ a: ok('a', [...many(5, 'high'), ...many(10, 'medium'), ...many(10, 'low')]) }), getPlugins());
  assert.equal(r.areas.security.inputs[0].score, 0, 'caps 55 + 30 + 15 = 100');
  assert.equal(r.areas.security.score, 0);
  assert.equal(r.areas.security.grade, 'F');
});

test('caps total 100; an area under the high cap scores above 0, every cap hit scores 0', () => {
  assert.equal(CAP.high + CAP.medium + CAP.low, 100);
  const many = (n, severity) => Array.from({ length: n }, () => f(severity, 'security'));
  const under = scoreReading(reading({ a: ok('a', [...many(10, 'high'), ...many(2, 'medium')]) }), getPlugins());
  assert.ok(under.areas.security.score > 0, 'high at cap + a little else stays above 0');
  const all = scoreReading(reading({ a: ok('a', [...many(10, 'high'), ...many(10, 'medium'), ...many(10, 'low')]) }), getPlugins());
  assert.equal(all.areas.security.score, 0);
});

test('axe: best-practice-only rules count as low; a wcag tag keeps the impact mapping; needs-review stays info', () => {
  const v = (tags) => ({ id: 'r', impact: 'serious', help: 'h', helpUrl: 'u', tags, nodes: 1, samples: [{ target: '#a' }] });
  const out = axe.run({}, { collected: {
    violations: [v(['cat.semantics', 'best-practice']), v(['cat.semantics', 'wcag2a', 'best-practice']), v(['wcag2a'])],
    incomplete: [{ ...v(['best-practice']), id: 'x' }], passes: 0,
  } });
  assert.deepEqual(out.findings.map((x) => x.severity), ['low', 'high', 'high', 'info']);
});

// ── Extent scoring (Accessibility counts how much of the page a finding affects) ──

const fx = (severity, count, of, unit = 'links', title) => ({ ...f(severity, 'accessibility', title), count, of, unit });
const a11y = (findings) => scoreReading(reading({ 'a11y-basics': ok('a11y-basics', findings) }), getPlugins()).areas.accessibility;
const near = (x, y, msg) => assert.ok(Math.abs(x - y) < 1e-9, `${msg ?? ''} ${x} ≈ ${y}`);
const footerNum = (t, label) => {
  const row = t.footer.find((r) => r.label.startsWith(label));
  return row ? Number(row.value.replace('−', '')) : 0;
};

test('extent constants', () => {
  assert.equal(BREADTH_SHARE, 0.6);
  assert.equal(EXTENT_MAX, 40);
  assert.equal(EXTENT_FULL, 0.25);
  assert.equal(EXTENT_SMOOTH, 10);
  assert.deepEqual(EXTENT_WEIGHT, { high: 1, medium: 0.5, low: 0.1, info: 0 });
  assert.deepEqual(EXTENT_AREAS, ['accessibility']);
  assert.deepEqual(DEDUCT, { high: 15, medium: 6, low: 2, info: 0 });
  assert.deepEqual(CAP, { high: 55, medium: 30, low: 15, info: 0 });
});

test('extent formula: one high finding, 65 of 819 links', () => {
  const a = a11y([fx('high', 65, 819)]);
  const d = a.deductions[0];
  assert.equal(d.points, 15);
  assert.equal(d.count, 65);
  assert.equal(d.of, 819);
  assert.equal(d.unit, 'links');
  near(d.share, 65 / 829, 'share');
  near(d.breadth, 9, 'breadth');
  near(d.extent, (40 * (65 / 829)) / 0.25, 'extent');
  near(a.breadth, 9, 'area breadth');
  near(a.extent, 12.545235223160435, 'area extent');
  near(a.extentSum, 65 / 829, 'extentSum');
  assert.deepEqual(a.bySeverity.high, { findings: 1, raw: 15, capped: 15 });
  assert.equal(a.inputs[0].score, 78);
  assert.equal(a.score, 78);
});

test('smoothing: 1 of 1 counts as 1/11', () => {
  near(a11y([fx('high', 1, 1)]).deductions[0].share, 1 / 11);
});

test('extent capped at 40', () => {
  const a = a11y([fx('high', 500, 500, 'links', 'a'), fx('high', 500, 500, 'links', 'b'), fx('high', 500, 500, 'links', 'c')]);
  assert.equal(a.extent, 40);
  assert.ok(a.extentSum > EXTENT_FULL);
  assert.equal(a.inputs[0].score, Math.round(100 - 0.6 * 45 - 40));
  assert.equal(a.inputs[0].score, 33);
});

test('invalid count/of fields are ignored', () => {
  const bad = ['65', 0, -1, NaN, 1.5, null, undefined, Infinity];
  for (const v of bad) {
    assert.equal(extentOf({ count: v, of: 819 }), null, `count ${String(v)}`);
    const a = a11y([fx('high', v, 819)]);
    assert.equal(a.deductions[0].share, null);
    assert.equal(a.deductions[0].extent, 0);
    assert.equal(a.inputs[0].score, 91, 'breadth only');
  }
  for (const v of bad) {
    assert.deepEqual(extentOf({ count: 65, of: v, unit: 'links' }), { count: 65, of: null, unit: 'links' }, `of ${String(v)}`);
    const d = a11y([fx('high', 65, v)]).deductions[0];
    assert.equal(d.of, null);
    assert.equal(d.share, null);
    assert.equal(d.extent, 0);
  }
  assert.equal(extentOf({ count: 3, unit: 7 }).unit, null);
  assert.equal(extentOf({}), null);
});

test('of below count is raised to count', () => {
  assert.deepEqual(extentOf({ count: 10, of: 4, unit: 'images' }), { count: 10, of: 10, unit: 'images' });
  const d = a11y([fx('high', 10, 4)]).deductions[0];
  assert.equal(d.of, 10);
  near(d.share, 10 / 20);
  assert.ok(d.share <= 1);
});

test('info findings contribute nothing', () => {
  const a = a11y([fx('info', 100, 100)]);
  assert.equal(a.extent, 0);
  assert.equal(a.deductions[0].extent, 0);
  assert.equal(a.inputs[0].score, 100);
  const t = scoreTable(a);
  assert.deepEqual(t.rows, []);
  assert.deepEqual(t.footer, [{ label: 'Findings score', value: '100' }]);
  assert.equal(t.score, 100);
});

test('no findings: Accessibility scores 100 with an empty table', () => {
  const a = a11y([]);
  assert.equal(a.inputs[0].score, 100);
  assert.equal(a.extent, 0);
  assert.equal(a.breadth, 0);
  const t = scoreTable(a);
  assert.equal(t.extent, true);
  assert.deepEqual(t.rows, []);
  assert.deepEqual(t.footer, [{ label: 'Findings score', value: '100' }]);
});

test('findings without counts (saved readings) score by breadth only', () => {
  const a = a11y([f('high', 'accessibility', 'a'), f('high', 'accessibility', 'b')]);
  assert.equal(a.inputs[0].score, Math.round(100 - 0.6 * 30));
  assert.equal(a.inputs[0].score, 82);
  assert.equal(a.extent, 0);
  const t = scoreTable(a);
  for (const r of t.rows) {
    assert.equal(r.affected, '');
    assert.ok(Number.isFinite(r.breadth) && Number.isFinite(r.extent) && Number.isFinite(r.points));
  }
  for (const r of t.footer) assert.doesNotMatch(r.value, /NaN|undefined|Infinity/);
});

test('non-extent area scores exactly as today', () => {
  const vitals = ok('vitals', [], { data: { ratings: { lcp: 'needs improvement', cls: 'good', fcp: 'good', ttfb: 'poor' } } });
  const network = ok('network', [
    { ...f('high', 'performance', 'a'), count: 65, of: 819, unit: 'requests' }, f('high', 'performance', 'b'),
    f('medium', 'performance'), f('low', 'performance'), f('low', 'performance'), f('info', 'performance'),
  ]);
  const a = scoreReading(reading({ vitals, network }), getPlugins()).areas.performance;
  assert.equal(a.inputs[0].score, 60);
  assert.equal(a.score, 63);
  for (const d of a.deductions) {
    assert.deepEqual(Object.keys(d).sort(), ['finding', 'points']);
    assert.equal('share' in d, false);
  }
  assert.equal('extent' in a, false);
  assert.equal('breadth' in a, false);
  assert.deepEqual(a.bySeverity.high, { findings: 2, raw: 30, capped: 30 });
  assert.deepEqual(a.bySeverity.low, { findings: 2, raw: 4, capped: 4 });
});

test('scoreTable adds up', () => {
  const capped = a11y([fx('high', 500, 500, 'links', 'a'), fx('high', 500, 500, 'links', 'b'), fx('high', 500, 500, 'links', 'c')]);
  const lows = a11y(Array.from({ length: 17 }, (_, i) => fx('low', 5, 100, 'images', `low ${i}`)));
  for (const a of [capped, lows]) {
    const t = scoreTable(a);
    assert.equal(t.extent, true);
    assert.equal(t.score, a.inputs[0].score);
    assert.equal(t.footer.at(-1).label, 'Findings score');
    assert.equal(t.footer.at(-1).value, String(a.inputs[0].score));
    const breadth = footerNum(t, 'Breadth');
    const extent = footerNum(t, 'Extent');
    assert.ok(Math.abs(100 - breadth - extent - t.score) <= 1, `${breadth} ${extent} ${t.score}`);
    assert.deepEqual(t.footer.map((r) => r.label.split(' ')[0]).slice(-3), ['Breadth', 'Extent', 'Findings']);
  }
  const tc = scoreTable(capped);
  assert.deepEqual(tc.footer, [
    { label: 'High · 3 findings', value: '−45' },
    { label: 'Breadth (scaled to 60%)', value: '−27' },
    { label: 'Extent 2.94 of 0.25', value: '−40' },
    { label: 'Findings score', value: '33' },
  ]);
  assert.deepEqual(tc.rows[0], { title: 'a', severity: 'high', affected: '500 of 500 links (100%)', breadth: 9, extent: 156.9, points: 15 });
  const tl = scoreTable(lows);
  assert.deepEqual(tl.footer[0], { label: 'Low · 17 findings', value: '−34, capped −15' });
  assert.equal(tl.footer[1].value, '−9');
  assert.equal(tl.rows.length, 17);
  assert.equal(tl.rows[0].affected, '5 of 100 images (5.0%)');
  // a performance area: points only, same cap rows
  const perf = scoreReading(reading({ network: ok('network', [
    { ...f('high', 'performance', 'big'), count: 12, unit: 'images' }, ...Array.from({ length: 10 }, (_, i) => f('low', 'performance', `l${i}`)),
  ]) }), getPlugins()).areas.performance;
  const tp = scoreTable(perf);
  assert.equal(tp.extent, false);
  assert.deepEqual(tp.footer, [
    { label: 'High · 1 finding', value: '−15' },
    { label: 'Low · 10 findings', value: '−20, capped −15' },
    { label: 'Findings score', value: String(perf.inputs[0].score) },
  ]);
  assert.equal(perf.inputs[0].score, 70);
  assert.deepEqual(tp.rows[0], { title: 'big', severity: 'high', affected: '12 images', points: 15 });
});

test('scoreTable affected text: percentages and thousands', () => {
  const a = a11y([fx('high', 65, 819, 'links', 'a'), fx('medium', 77, 501, 'keyboard stops', 'b'), fx('low', 1200, 15000, 'text elements', 'c'), fx('low', 3, undefined, 'images', 'd')]);
  assert.deepEqual(scoreTable(a).rows.map((r) => r.affected), [
    '65 of 819 links (7.9%)', '77 of 501 keyboard stops (15%)', '1,200 of 15,000 text elements (8.0%)', '3 images',
  ]);
  const r = scoreTable(a).rows;
  assert.equal(r[0].breadth, 9);
  assert.equal(r[0].extent, 12.5);
  assert.equal(r[1].breadth, 3.6);
  assert.equal(r[1].extent, 12.1); // 40 × 0.5 × 77/511 / 0.25
});

test('scoreRule text is built from the constants', () => {
  assert.equal(scoreRule(), 'Breadth: each finding deducts high 15, medium 6, low 2 (capped at 55, 30 and 15 per severity), scaled to 60%. Extent: up to 40 more for the share of elements affected.');
  assert.equal(scoreRule({ extent: false }), 'Each finding deducts high 15, medium 6, low 2, info 0 — capped at 55, 30 and 15 per severity.');
  assert.match(scoreRule(), /55/);
  assert.doesNotMatch(scoreRule(), /60,/);
  assert.doesNotMatch(scoreRule({ extent: false }), /60/);
});
