import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaChecks, areaSummary } from '../extension/core/area.js';
import { scoreReading } from '../extension/core/score.js';
import { allIssues } from '../extension/core/issues.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';

const fx = (results, plugins) => {
  const reading = createReading({ entries: [], target: makeTarget('https://s.test/', 'S', 'https://s.test/') });
  reading.log._harplus.plugins = results;
  const scores = scoreReading(reading, plugins);
  return { reading, scores, issues: allIssues(scores) };
};
const f = (severity, category = 'content') => ({ severity, category, title: 't' });
const ok = (id, findings = [], summary = []) => ({ id, name: id.toUpperCase(), status: 'ok', summary, findings });
const bad = (id, status, error) => ({ id, name: id.toUpperCase(), status, error, summary: [], findings: [] });
const plugins = [{ id: 'c', area: 'build' }, { id: 'a', area: 'content' }, { id: 'b', area: 'content' }];

test('rows: home plugins (ok/skipped/error) plus visitors with issues here; counts sum to the area total', () => {
  const { reading, issues } = fx({
    a: ok('a', [f('high'), f('low'), f('info', 'quality')]),
    b: bad('b', 'skipped', 'no page data'),
    c: ok('c', [f('medium')]),
  }, plugins);
  const rows = areaChecks('content', reading, plugins, issues);
  assert.deepEqual(rows.map((r) => [r.id, r.home, r.total]), [['a', true, 2], ['b', true, 0], ['c', false, 1]]);
  assert.equal(rows.reduce((n, r) => n + r.total, 0), issues.filter((i) => i.area === 'content').length);
  assert.deepEqual(rows[0].counts, { high: 1, medium: 0, low: 1, info: 0 });
  assert.equal(areaChecks('build', reading, plugins, issues).map((r) => r.id).join(), 'c,a');
});

test('rows: home plugins in rank order, visitors by name', () => {
  const { reading, issues } = fx({ b: ok('b'), a: ok('a'), z: ok('z', [f('low')]), y: ok('y', [f('low')]) }, plugins);
  assert.deepEqual(areaChecks('content', reading, plugins, issues).map((r) => r.id), ['a', 'b', 'y', 'z']);
});

test('result word agrees with the row', () => {
  const ps = ['a', 'b', 'c', 'd', 'e', 'g'].map((id) => ({ id, area: 'content' }));
  const { reading, issues } = fx({
    a: ok('a', [f('high'), f('low')]), b: ok('b', [f('medium')]), c: ok('c', [f('info')]),
    d: ok('d', [f('low')]), e: bad('e', 'skipped', 'x'), g: bad('g', 'error', 'boom'),
  }, ps);
  const by = Object.fromEntries(areaChecks('content', reading, ps, issues).map((r) => [r.id, [r.status, r.result, r.band]]));
  assert.deepEqual(by.a, ['ok', 'failing', 'poor']);
  assert.deepEqual(by.b, ['ok', 'needs work', 'fair']);
  assert.deepEqual(by.d, ['ok', 'needs work', 'fair']);
  assert.deepEqual(by.e, ['skipped', 'skipped', 'none']);
  assert.deepEqual(by.g, ['error', 'error', 'poor']);
  assert.deepEqual(by.c, ['ok', 'passing', 'good']);
});

test('reading: headline values joined, else first item, else dash; skipped/error shows the reason (≤120 chars)', () => {
  const ps = [...plugins, { id: 'd', area: 'content' }];
  const { reading, issues } = fx({
    a: ok('a', [], [{ label: 'X', value: '1' }, { label: 'Y', value: '2', headline: true }, { label: 'Z', value: '3', headline: true }]),
    b: ok('b', [], [{ label: 'Words', value: '900' }]),
    c: ok('c'),
    d: bad('d', 'error', 'e'.repeat(300)),
  }, ps);
  const by = Object.fromEntries(areaChecks('content', reading, ps, issues).concat(areaChecks('build', reading, ps, issues)).map((r) => [r.id, r.reading]));
  assert.equal(by.a, '2 · 3');
  assert.equal(by.b, 'Words 900');
  assert.equal(by.c, '—');
  assert.equal(by.d.length, 120);
});

test('summary: counts, checks, biggest wins; singulars; nothing above zero; not measured', () => {
  const row = (id, name, high, medium) => ({ id, name, counts: { high, medium, low: 0, info: 0 } });
  const a = { score: 50, counts: { high: 6, medium: 4, low: 10, info: 14 } };
  const rows = [row('1', 'Contrast', 2, 0), row('2', 'axe-core audit', 4, 1), ...[3, 4, 5, 6, 7].map((n) => row(String(n), 'n' + n, 0, 0))];
  assert.equal(areaSummary(a, rows), '6 high, 4 medium, 10 low and 14 info issues from 7 checks. The biggest wins are in axe-core audit and Contrast.');
  assert.equal(areaSummary({ score: 100, counts: { high: 0, medium: 0, low: 0, info: 0 } }, rows.slice(2, 5)), 'No issues from 3 checks.');
  assert.equal(areaSummary({ score: 90, counts: { high: 0, medium: 0, low: 1, info: 0 } }, [row('1', 'X', 0, 0)]), '1 low issue from 1 check.');
  assert.equal(areaSummary({ score: 80, counts: { high: 1, medium: 0, low: 0, info: 0 } }, [row('1', 'X', 1, 0)]), '1 high issue from 1 check. The biggest win is in X.');
  assert.equal(areaSummary({ score: null, counts: { high: 0, medium: 0, low: 0, info: 0 } }, []), 'Not measured — no plugin in this area ran successfully.');
});
