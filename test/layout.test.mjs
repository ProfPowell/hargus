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

const breaking = (overflowers) => plugin.run(reading({
  breakpoints: [900],
  views: { desktop: B, 'bp900-below': { overflowX: 20, clipped: 0, overflowers }, 'bp900-at': { overflowX: 0, clipped: 0 } },
}), ctx({ vwRules: 2 }));

test('places: each element wider than the viewport, with its width; the other findings have none', () => {
  const r = breaking([{ selector: 'div.edge', width: 920.4, over: 20 }, { selector: 'img#hero', width: 1000 }]);
  const f = r.findings.find((x) => /Layout breaks/.test(x.title));
  assert.deepEqual(f.places, [{ selector: 'div.edge', note: '920 px' }, { selector: 'img#hero', note: '1000 px' }]);
  assert.equal(f.detail, 'Wider than the viewport: div.edge (920 px), img#hero (1000 px)', 'detail unchanged');
  assert.ok(r.findings.filter((x) => x !== f).every((x) => !x.places));
});

test('places odd values: blank selectors skipped, a missing width has no note, 200 at most, markup escaped when drawn', () => {
  const odd = breaking([{ selector: '', width: 950 }, { selector: '  ', width: 950 }, { width: 950 }, { selector: 'p:has(<b>"x")' }]);
  assert.deepEqual(odd.findings[0].places, [{ selector: 'p:has(<b>"x")' }]);
  const drawn = String(h.places(odd.findings[0].places));
  assert.doesNotMatch(drawn, /<b>/);
  assert.match(drawn, /<code>p:has\(&lt;b&gt;&quot;x&quot;\)<\/code>/);
  const many = breaking(Array.from({ length: 250 }, (_, i) => ({ selector: `div.n${i}`, width: 950 })));
  assert.equal(many.findings[0].places.length, 200);
});

test('headline: Breakpoints reads on its own', () => {
  const r = breaking([{ selector: 'div.edge', width: 920 }]);
  assert.deepEqual(r.summary, [{ label: 'Breakpoints', headline: true, value: '900 px' }]);
});

test('render: answer first; per view only what the glance lacks (clipped text, every culprit)', () => {
  const r = breaking([{ selector: 'div.edge', width: 920 }, { selector: 'img#hero', width: 1000 }]);
  const out = String(plugin.render({ status: 'ok', ...r }, h));
  assert.ok(out.trimStart().startsWith('<div class="stats">'), 'stats come first');
  assert.match(out, /Breakpoints<\/span><div class="stat-value">1<\/div><span class="stat-note">900 px</);
  assert.match(out, /Edge views that fit<\/span><div class="stat-value">1 of 2</);
  assert.match(out, /width: 100vw rules<\/span><div class="stat-value">2</);
  assert.match(out, /div\.edge \(920 px\), img#hero \(1000 px\)/);
  assert.doesNotMatch(out, /<th scope="col">Overflow<\/th>/, 'the glance has the overflow');
  const clipped = plugin.run(reading({
    breakpoints: [900],
    views: { desktop: B, 'bp900-below': { overflowX: 20, rootClipX: true, clipped: 0, overflowers: [{ selector: 'div.edge', width: 920 }] }, 'bp900-at': { overflowX: 0, clipped: 0 } },
  }), ctx({ vwRules: 0 }));
  const c = String(plugin.render({ status: 'ok', ...clipped }, h));
  assert.match(c, /div\.edge \(920 px\) \(hidden by html\/body\)/);
  assert.match(c, /Edge views that fit<\/span><div class="stat-value">2 of 2</);
  // A culprit with no width shows no px; a view that hides overflow with no culprits still says so.
  const odd = plugin.run(reading({
    breakpoints: [900],
    views: { desktop: B, 'bp900-below': { overflowX: 20, clipped: 0, overflowers: [{ selector: 'div.nowidth' }] }, 'bp900-at': { overflowX: 30, rootClipX: true, clipped: 0, overflowers: [] } },
  }), ctx({ vwRules: 0 }));
  const o = String(plugin.render({ status: 'ok', ...odd }, h));
  assert.match(o, /<td>div\.nowidth<\/td>/);
  assert.match(o, /<td>\(hidden by html\/body\)<\/td>/);
  assert.doesNotMatch(o, /NaN|undefined/);
});
