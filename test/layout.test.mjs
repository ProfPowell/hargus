import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../extension/plugins/layout.js';
import { getPlugins } from '../extension/plugins/index.js';
import { h } from '../extension/ui/render.js';

const reading = (capture) => ({ log: { entries: [], _harplus: { capture: { device: 'desktop', ...capture } } } });
const ctx = (css) => ({ results: css ? { css: { status: 'ok', data: css } } : {}, skip: (m) => { const e = new Error(m); e.name = 'SkipError'; throw e; } });
const t = (r) => r.findings.map((f) => `${f.severity}:${f.title}`);
const B = { overflowX: 0, clipped: 0, cssHeight: 3000 };

test('registered as a Build analyze plugin', () => {
  assert.ok(getPlugins().some((p) => p.id === 'layout'));
  assert.equal(plugin.area, 'build');
  assert.equal(plugin.phase, 'analyze');
});

test('skips with neither breakpoint views nor a css result', () => {
  assert.throws(() => plugin.run(reading({ views: { desktop: B } }), ctx()), /no breakpoint views or CSS data/);
});

test('breakpoint findings and 100vw', () => {
  const r = plugin.run(reading({
    breakpoints: [900],
    views: { desktop: B, 'bp900-below': { overflowX: 20, clipped: 0, overflowers: [{ selector: 'div.edge', width: 920, over: 20 }] }, 'bp900-at': { overflowX: 0, clipped: 0 } },
  }), ctx({ vwRules: 2 }));
  assert.deepEqual(t(r), [
    'medium:Layout breaks at 899 px (just below the 900 px breakpoint)',
    'low:2 rules use width: 100vw (adds horizontal scroll when a vertical scrollbar is present)',
  ]);
});

test('100vw only when the page scrolls vertically; render without NaN', () => {
  const short = plugin.run(reading({ views: { desktop: { ...B, cssHeight: 500 } } }), ctx({ vwRules: 2 }));
  assert.deepEqual(t(short), []);
  assert.doesNotMatch(String(plugin.glance({ status: 'ok', ...short }, h)) + String(plugin.render({ status: 'ok', ...short }, h)), /NaN|undefined/);
});

test('100vw: not when the base root clips overflow-x (nothing scrolls sideways)', () => {
  const r = plugin.run(reading({ views: { desktop: { ...B, rootClipX: true } } }), ctx({ vwRules: 2 }));
  assert.deepEqual(t(r), []);
});

test('Breakpoints summary: not captured, none detected, or the skip reason', () => {
  const value = (capture) => plugin.run(reading({ views: { desktop: B }, ...capture }), ctx({ vwRules: 0 })).summary[0].value;
  assert.equal(value({}), 'not captured');
  assert.equal(value({ breakpoints: [] }), 'none detected');
  assert.equal(value({ viewsSkipped: [{ view: 'breakpoints', reason: 'no px breakpoints' }] }), 'no px breakpoints');
  assert.equal(value({ breakpoints: [600, 900] }), '600 px, 900 px');
});

test('glance: a root that clips overflow-x fits', () => {
  const r = plugin.run(reading({
    breakpoints: [900],
    views: { desktop: B, 'bp900-below': { overflowX: 20, rootClipX: true, clipped: 0, overflowers: [{ selector: 'div.edge', width: 920 }] }, 'bp900-at': { overflowX: 0, clipped: 0 } },
  }), ctx({ vwRules: 0 }));
  assert.deepEqual(t(r), []);
  const g = String(plugin.glance({ status: 'ok', ...r }, h));
  assert.doesNotMatch(g, /div\.edge/);
  assert.match(g, /899 px[\s\S]*?fits/);
});
