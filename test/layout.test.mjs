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
