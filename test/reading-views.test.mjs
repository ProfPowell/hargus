import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForViews, settleViewsAfterFailure, persistAndCleanup } from '../extension/core/views-wait.js';

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

test('abort → resolves aborted without a patch, subscription removed', async () => {
  const b = bus();
  const ac = new AbortController();
  const p = waitForViews({ fromStore: async () => null, subscribe: b.subscribe, timeoutMs: 60000, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(b.size(), 1);
  ac.abort();
  const r = await p;
  assert.equal(r.reason, 'aborted');
  assert.equal(r.patch, null);
  assert.equal(b.size(), 0);
});

test('already-aborted signal → resolves aborted at once', async () => {
  const b = bus();
  const ac = new AbortController();
  ac.abort();
  const r = await waitForViews({ fromStore: async () => null, subscribe: b.subscribe, timeoutMs: 60000, signal: ac.signal });
  assert.equal(r.reason, 'aborted');
  assert.equal(b.size(), 0);
});

const pending = () => ({ log: { _harplus: { screenshots: [{ id: 'a' }], capture: { viewsPending: true } } } });

test('settleViewsAfterFailure: patch exists → merged, pending cleared', async () => {
  const r = pending();
  await settleViewsAfterFailure(r, async () => ({ screenshots: [{ id: 'b' }], capture: { viewsMs: 5 }, warnings: [] }));
  const hp = r.log._harplus;
  assert.deepEqual(hp.screenshots.map((s) => s.id), ['a', 'b']);
  assert.equal(hp.capture.viewsPending, undefined);
  assert.equal(hp.capture.viewsMs, 5);
});

test('settleViewsAfterFailure: no patch → skipped recorded, pending cleared', async () => {
  const r = pending();
  await settleViewsAfterFailure(r, async () => null);
  const c = r.log._harplus.capture;
  assert.equal(c.viewsPending, undefined);
  assert.deepEqual(c.viewsSkipped, [{ view: 'all', reason: 'analysis failed before the views arrived' }]);
});

test('settleViewsAfterFailure: getPatch throws → treated as no patch', async () => {
  const r = pending();
  await settleViewsAfterFailure(r, async () => { throw new Error('idb'); });
  const c = r.log._harplus.capture;
  assert.equal(c.viewsPending, undefined);
  assert.equal(c.viewsSkipped[0].view, 'all');
});

test('settleViewsAfterFailure: not pending → untouched, store not read', async () => {
  const r = { log: { _harplus: { screenshots: [], capture: {} } } };
  let called = false;
  await settleViewsAfterFailure(r, async () => { called = true; return null; });
  assert.equal(called, false);
  assert.deepEqual(r.log._harplus.capture, {});
});

test('persistAndCleanup: save resolves → cleanup runs, resolves true', async () => {
  const calls = [];
  const ok = await persistAndCleanup(async () => { calls.push('save'); }, async () => { calls.push('cleanup'); });
  assert.equal(ok, true);
  assert.deepEqual(calls, ['save', 'cleanup']);
});

test('persistAndCleanup: save rejects → no cleanup, resolves false', async () => {
  let cleaned = false;
  const ok = await persistAndCleanup(async () => { throw new Error('quota'); }, async () => { cleaned = true; });
  assert.equal(ok, false);
  assert.equal(cleaned, false);
});

test('persistAndCleanup: cleanup failure does not make the save count as failed', async () => {
  const ok = await persistAndCleanup(async () => {}, async () => { throw new Error('idb'); });
  assert.equal(ok, true);
});
