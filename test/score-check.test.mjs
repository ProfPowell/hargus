import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, compare, REPLAY, NOT_REPLAYED } from '../scripts/score-check.mjs';
import { getPlugins } from '../extension/plugins/index.js';
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

test('checkFile re-runs REPLAY page plugins from their saved data; the rest keep their saved results', async () => {
  const { checkFile, REPLAY } = await import('../scripts/score-check.mjs');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  assert.ok(REPLAY.includes('axe') && REPLAY.includes('a11y-basics') && !REPLAY.includes('contrast'));
  const r = createReading({ entries: [], target: makeTarget('https://s.test/', 'S', 'https://s.test/') });
  const stale = [{ severity: 'low', category: 'quality', title: 'stale' }];
  r.log._harplus.plugins = {
    'a11y-basics': { id: 'a11y-basics', name: 'B', phase: 'page', status: 'ok', summary: [], findings: stale,
      data: { rules: [{ id: 'frame-title', impact: 'serious', help: 'Iframes without a title', count: 1, samples: [{ selector: 'iframe', html: '' }] }], errors: [], stats: {} } },
    contrast: { id: 'contrast', name: 'C', phase: 'page', status: 'ok', summary: [], findings: stale, data: { pairs: [], totals: {} } },
  };
  const dir = await mkdtemp(join(tmpdir(), 'score-check-'));
  try {
    await writeFile(join(dir, 'x.har'), JSON.stringify(r));
    const s = await checkFile(join(dir, 'x.har'), { fetch: async () => new Response('', { status: 404 }) });
    assert.deepEqual(s.findings['a11y-basics'].map((f) => f.title), ['Iframes without a title'], 'replayed from saved data');
    assert.deepEqual(s.findings.contrast.map((f) => f.title), ['stale'], 'contrast kept as saved');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('REPLAY: every page plugin is replayed or named as not replayable, and neither list holds a stranger', () => {
  const pages = getPlugins().filter((p) => p.phase === 'page').map((p) => p.id);
  const missing = pages.filter((id) => !REPLAY.includes(id) && !(id in NOT_REPLAYED));
  assert.deepEqual(missing, [], `add to REPLAY or NOT_REPLAYED in scripts/score-check.mjs: ${missing}`);
  assert.deepEqual(REPLAY.filter((id) => id in NOT_REPLAYED), [], 'a plugin is in both lists');
  assert.deepEqual([...REPLAY, ...Object.keys(NOT_REPLAYED)].filter((id) => !pages.includes(id)), [], 'listed but not a page plugin');
});
