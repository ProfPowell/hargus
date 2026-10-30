import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaChecks, areaSummary, resultWord, resultWordFor, SEVS } from '../extension/core/area.js';
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

test('reading: headline values joined, else first item, else dash; skipped/error shows the reason (≤120 chars, … when cut)', () => {
  const ps = [...plugins, { id: 'd', area: 'content' }, { id: 'e', area: 'content' }];
  const { reading, issues } = fx({
    a: ok('a', [], [{ label: 'X', value: '1' }, { label: 'Y', value: '2', headline: true }, { label: 'Z', value: '3', headline: true }]),
    b: ok('b', [], [{ label: 'Words', value: '900' }]),
    c: ok('c'),
    d: bad('d', 'error', 'e'.repeat(300)),
    e: bad('e', 'skipped', 'x'.repeat(120)),
  }, ps);
  const by = Object.fromEntries(areaChecks('content', reading, ps, issues).concat(areaChecks('build', reading, ps, issues)).map((r) => [r.id, r.reading]));
  assert.equal(by.a, 'Y 2 · Z 3');
  assert.equal(by.b, 'Words 900');
  assert.equal(by.c, '—');
  assert.equal(by.d.length, 120);
  assert.equal(by.d, `${'e'.repeat(119)}…`, 'cut text ends in an ellipsis');
  assert.equal(by.e, 'x'.repeat(120), 'exactly 120: kept whole, no ellipsis');
});

test('area Reading shows label value unless the value starts with the label', () => {
  const { reading, issues } = fx({
    a: ok('a', [], [{ label: 'Contrast', value: '11 of 1075 text elements fail (AA)', headline: true }, { label: 'LCP', value: 'lcp 2.1 s', headline: true }]),
    b: ok('b', [], [{ label: 'Images', value: '8 of 8 have alt text', headline: true }]),
  }, plugins);
  const by = Object.fromEntries(areaChecks('content', reading, plugins, issues).map((r) => [r.id, r.reading]));
  assert.equal(by.a, 'Contrast 11 of 1075 text elements fail (AA) · lcp 2.1 s');
  assert.equal(by.b, 'Images 8 of 8 have alt text');
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

test('summary: skipped and errored checks are named after the count', () => {
  const row = (id, status = 'ok') => ({ id, name: id, status, counts: { high: 0, medium: 0, low: 0, info: 0 } });
  const clean = { score: 100, counts: { high: 0, medium: 0, low: 0, info: 0 } };
  assert.equal(areaSummary(clean, [row('1'), row('2'), row('3'), row('4'), row('5', 'skipped')]), 'No issues from 5 checks (1 skipped).');
  assert.equal(areaSummary(clean, [row('1'), row('2', 'skipped'), row('3', 'error')]), 'No issues from 3 checks (1 skipped, 1 error).');
  assert.equal(areaSummary(clean, [row('1'), row('2', 'error'), row('3', 'error')]), 'No issues from 3 checks (2 errors).');
  assert.equal(areaSummary({ score: 90, counts: { high: 0, medium: 0, low: 1, info: 0 } }, [row('1'), row('2', 'skipped'), row('3', 'skipped')]), '1 low issue from 3 checks (2 skipped).');
});

test('resultWordFor: the word for a list of issues by severity, same rules as the row', () => {
  assert.deepEqual(SEVS, ['high', 'medium', 'low', 'info']);
  assert.deepEqual(resultWordFor('ok', [{ severity: 'low' }]), { result: 'needs work', band: 'fair' });
  assert.deepEqual(resultWordFor('ok', [{ severity: 'info' }, { severity: 'high' }]), { result: 'failing', band: 'poor' });
  assert.deepEqual(resultWordFor('ok', []), { result: 'passing', band: 'good' });
  assert.deepEqual(resultWordFor('skipped', [{ severity: 'high' }]), resultWord('skipped', {}));
});
