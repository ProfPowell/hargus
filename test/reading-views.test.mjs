import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForViews } from '../extension/core/views-wait.js';

const bus = () => {
  const subs = new Set();
  return { subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); }, emit: (m) => subs.forEach((f) => f(m)), size: () => subs.size };
};

test('patch already stored before waiting → resolves at once (Review Focus 1)', async () => {
  const b = bus();
  const r = await waitForViews({ fromStore: async () => ({ id: 'r1', capture: {} }), subscribe: b.subscribe, timeoutMs: 1000 });
  assert.equal(r.patch.id, 'r1');
  assert.equal(b.size(), 0, 'listener removed');
});

test('views message → reads the store', async () => {
  const b = bus();
  let stored = null;
  const p = waitForViews({ fromStore: async () => stored, subscribe: b.subscribe, timeoutMs: 1000 });
  await new Promise((r) => setTimeout(r, 10));
  stored = { id: 'r1' };
  b.emit({ kind: 'views' });
  assert.equal((await p).patch.id, 'r1');
});

test('capture error → synthetic skipped patch', async () => {
  const b = bus();
  const p = waitForViews({ fromStore: async () => null, subscribe: b.subscribe, timeoutMs: 1000 });
  await new Promise((r) => setTimeout(r, 10));
  b.emit({ kind: 'error', text: 'Debugger detached' });
  const { patch } = await p;
  assert.deepEqual(patch.capture.viewsSkipped, [{ view: 'all', reason: 'views did not finish: Debugger detached' }]);
});

test('deadline → synthetic skipped patch', async () => {
  const b = bus();
  const { patch } = await waitForViews({ fromStore: async () => null, subscribe: b.subscribe, timeoutMs: 30 });
  assert.match(patch.capture.viewsSkipped[0].reason, /timed out/);
  assert.equal(b.size(), 0);
});
