import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AREAS, PROFILES, grade, status, pluginArea, resultArea, normRating, scoreReading, topFindings, summarize,
  resolveProfile, profileFromSettings, carbonScore,
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
    'a11y-basics': ok('a11y-basics', [f('high', 'accessibility', '2 form fields without labels'), f('high', 'accessibility', 'x'), f('high', 'accessibility', 'y')]), // 55
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
