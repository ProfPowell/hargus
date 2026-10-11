import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleRender } from '../extension/browser/capture.js';

const withPage = async (sizes, raf, fn) => {
  let i = 0;
  const de = { get scrollWidth() { return sizes[Math.min(i, sizes.length - 1)][0]; }, get scrollHeight() { return sizes[Math.min(i++, sizes.length - 1)][1]; } };
  globalThis.document = { documentElement: de, fonts: { ready: Promise.resolve() } };
  globalThis.requestAnimationFrame = raf;
  try { return await fn(); } finally { delete globalThis.document; delete globalThis.requestAnimationFrame; }
};

test('returns once size is stable for two frames', async () => {
  const t = Date.now();
  await withPage([[100, 100], [100, 200], [100, 300], [100, 300], [100, 300], [100, 300]], (cb) => setTimeout(cb, 5), () => settleRender(2000));
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
});

test('hidden tab (rAF never fires) still returns within the cap via the 50 ms tick (Review Focus 2)', async () => {
  const t = Date.now();
  await withPage([[100, 100]], () => {}, () => settleRender(400));
  assert.ok(Date.now() - t < 1200, `took ${Date.now() - t} ms`);
});

test('a page that keeps growing returns at the cap', async () => {
  let h = 0;
  const sizes = Array.from({ length: 500 }, () => [100, (h += 10)]);
  const t = Date.now();
  await withPage(sizes, (cb) => setTimeout(cb, 5), () => settleRender(300));
  const ms = Date.now() - t;
  assert.ok(ms >= 250 && ms < 1500, `took ${ms} ms`);
});
