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
