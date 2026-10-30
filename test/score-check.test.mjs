import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, compare } from '../scripts/score-check.mjs';
import { createReading, makeTarget } from '../extension/core/harplus.js';

const plugins = [{ id: 'a', area: 'content' }, { id: 'b', area: 'build' }];
const reading = (findings) => {
  const r = createReading({ entries: [], target: makeTarget('https://s.test/', 'S', 'https://s.test/') });
  r.log._harplus.plugins = {
    b: { id: 'b', name: 'B', status: 'ok', summary: [], findings: [{ severity: 'low', category: 'quality', title: 'B1' }] },
    a: { id: 'a', name: 'A', status: 'ok', summary: [], findings },
  };
  return r;
};
const f1 = { severity: 'medium', category: 'content', title: 'One', evidence: ['https://x/1'] };
const f2 = { severity: 'low', category: 'content', title: 'Two' };

test('snapshot: area scores and overall, findings per plugin without places, sorted', () => {
  const s = snapshot(reading([f2, { ...f1, places: [{ url: 'https://x/1' }] }]), plugins);
  assert.equal(typeof s.scores.overall, 'number');
  assert.equal(typeof s.scores.content, 'number');
  assert.ok('accessibility' in s.scores);
  assert.deepEqual(Object.keys(s.findings), ['a', 'b'], 'plugins sorted');
  assert.deepEqual(s.findings.a.map((f) => f.title).sort(), ['One', 'Two']);
  assert.deepEqual(s.findings.a.find((f) => f.title === 'One').evidence, ['https://x/1'], 'evidence kept');
  assert.ok(!JSON.stringify(s).includes('places'));
  assert.deepEqual(snapshot(reading([f2, f1]), plugins), snapshot(reading([f1, f2]), plugins), 'finding order never matters');
});

test('score-check compare: equal → []; a changed score or finding title → listed; places ignored', () => {
  const base = { site: snapshot(reading([f1, f2]), plugins) };
  assert.deepEqual(compare(base, structuredClone(base)), []);
  assert.deepEqual(compare(base, { site: snapshot(reading([f2, { ...f1, places: [{ url: 'https://x/9' }] }]), plugins) }), []);
  const retitled = compare(base, { site: snapshot(reading([{ ...f1, title: 'One!' }, f2]), plugins) });
  assert.ok(retitled.some((d) => d.startsWith('site.findings.a: -') && d.includes('"One"')), retitled.join('\n'));
  assert.ok(retitled.some((d) => d.startsWith('site.findings.a: +') && d.includes('"One!"')), retitled.join('\n'));
  const harsher = compare(base, { site: snapshot(reading([{ ...f1, severity: 'high' }, f2]), plugins) });
  assert.ok(harsher.some((d) => /^site\.scores\.content: \d+ → \d+$/.test(d)), harsher.join('\n'));
  assert.ok(compare(base, {}).some((d) => d.startsWith('site')), 'a missing site is a difference');
});
