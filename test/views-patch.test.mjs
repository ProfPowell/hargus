import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReading, makeTarget, mergeViewsPatch } from '../extension/core/harplus.js';
import { runPlugins, heldBack } from '../extension/core/plugin-host.js';
import { getPlugins } from '../extension/plugins/index.js';

const pendingReading = () => {
  const r = createReading({ target: makeTarget('https://x.test/'), capture: { warnings: ['core warning'] }, screenshots: [{ kind: 'viewport', view: 'desktop', data: 'a' }] });
  r.log._harplus.capture.viewsPending = true;
  return r;
};
const PATCH = {
  id: 'r1', screenshots: [{ kind: 'viewport', view: 'mobile', data: 'b' }],
  capture: { views: { desktop: { cssWidth: 1280 }, mobile: { cssWidth: 390 } }, viewsMs: 9000, viewTimings: [{ view: 'mobile', runMs: 900, restoreMs: 50, ok: true }] },
  warnings: ['core warning', 'mobile view failed: x'], timing: { viewsMs: 9000 },
};

test('mergeViewsPatch: appends shots, assigns capture keys, skips duplicate warnings, clears viewsPending', () => {
  const r = mergeViewsPatch(pendingReading(), structuredClone(PATCH));
  const hp = r.log._harplus;
  assert.deepEqual(hp.screenshots.map((s) => s.view), ['desktop', 'mobile']);
  assert.equal(hp.capture.views.mobile.cssWidth, 390);
  assert.equal(hp.capture.viewsMs, 9000);
  assert.deepEqual(hp.capture.warnings, ['core warning', 'mobile view failed: x']);
  assert.equal(hp.capture.viewsPending, undefined);
});

test('mergeViewsPatch is idempotent and ignores readings that are not pending (Review Focus 5)', () => {
  const r = mergeViewsPatch(pendingReading(), structuredClone(PATCH));
  mergeViewsPatch(r, structuredClone(PATCH));
  assert.equal(r.log._harplus.screenshots.length, 2);
  assert.equal(r.log._harplus.capture.warnings.length, 2);
  const plain = createReading({ target: makeTarget('https://x.test/') });
  mergeViewsPatch(plain, structuredClone(PATCH));
  assert.equal(plain.log._harplus.capture.views, undefined);
  assert.equal(mergeViewsPatch(pendingReading(), null).log._harplus.capture.viewsPending, true, 'null patch is a no-op');
});

test('heldBack: needs views, plus anything transitively after a held plugin (Review Focus 4)', () => {
  const ps = [
    { id: 'v', phase: 'analyze', needs: ['views'] },
    { id: 'x', phase: 'analyze', after: ['v'] },
    { id: 'y', phase: 'enrich', after: ['x'] },
    { id: 'z', phase: 'analyze' },
  ];
  assert.deepEqual([...heldBack(ps)].sort(), ['v', 'x', 'y']);
});

test('runPlugins: held plugins wait for env.views while the rest of their phase finishes', async () => {
  const reading = createReading({ target: makeTarget('https://x.test/') });
  const order = [];
  let release;
  const views = new Promise((r) => { release = r; });
  const plugins = [
    { id: 'v', name: 'V', phase: 'analyze', needs: ['views'], run: () => { order.push('v'); return {}; } },
    { id: 'a', name: 'A', phase: 'analyze', run: () => { order.push('a'); return {}; } },
    { id: 'e', name: 'E', phase: 'enrich', run: () => { order.push('e'); return {}; } },
    { id: 'w', name: 'W', phase: 'enrich', after: ['v'], run: () => { order.push('w'); return {}; } },
  ];
  const done = runPlugins(reading, plugins, { phases: ['analyze', 'enrich'], views });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, ['a', 'e'], 'non-held plugins ran, held ones wait');
  release();
  await done;
  assert.deepEqual(order, ['a', 'e', 'v', 'w']);
});

test('runPlugins without env.views runs everything (CLI, imports, old readings)', async () => {
  const reading = createReading({ target: makeTarget('https://x.test/') });
  const order = [];
  const plugins = [
    { id: 'v', name: 'V', phase: 'analyze', needs: ['views'], run: () => { order.push('v'); return {}; } },
    { id: 'a', name: 'A', phase: 'analyze', run: () => { order.push('a'); return {}; } },
  ];
  await runPlugins(reading, plugins, { phases: ['analyze'] });
  assert.deepEqual(order.sort(), ['a', 'v']);
});

test('the five view-reading plugins declare needs: views', () => {
  const ids = getPlugins().filter((p) => (p.needs || []).includes('views')).map((p) => p.id);
  for (const id of ['a11y-views', 'layout', 'international', 'resilience']) assert.ok(ids.includes(id), id);
});
