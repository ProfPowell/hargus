import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEWS, VIEW_LABELS, LAYOUT_VIEWS, VISION_VIEWS, DISPLAY_VIEWS, WCAG_VIEWS, A11Y_VIEWS, VISION_DEFICIENCY, MEDIA_EMULATION, SPACING_CSS,
  baseView, shotView, shotsByView, ratio, compareViews, ratingFor,
  A11Y_CLIP_EXTRA, A11Y_LIGHT_BG, A11Y_FORCED_OPT_OUTS, extraClipped, reflowScroll, darkState,
  isBreakpointView, viewLabel, pickBreakpoints, breakpointFindings, edgeOverflow, edgeClipExtra, edgePartner,
} from '../extension/core/views.js';
import { DEFAULTS, merge } from '../extension/browser/settings.js';

const reading = (capture, screenshots) => ({ log: { _harplus: { capture, screenshots } } });

test('view ids and labels', () => {
  assert.deepEqual(LAYOUT_VIEWS, ['desktop', 'tablet', 'mobile', 'nojs', 'nocss', 'noimages', 'rtl', 'pseudo']);
  assert.deepEqual(VIEWS, [...LAYOUT_VIEWS, 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred', 'lowcontrast',
    'dark', 'forced', 'morecontrast', 'print', 'spacing', 'reflow', 'text200']);
  assert.equal(VIEW_LABELS.mobile, 'Phone');
  assert.equal(VIEW_LABELS.nojs, 'No JavaScript');
  assert.equal(VIEW_LABELS.pseudo, 'Long text');
});

test('base view comes from the capture device', () => {
  assert.equal(baseView(reading({ device: 'mobile' }, [])), 'mobile');
  assert.equal(baseView(reading({ device: 'desktop' }, [])), 'desktop');
  assert.equal(baseView(reading({}, [])), 'desktop');
  assert.equal(baseView(reading({ device: 'toaster' }, [])), 'desktop');
  assert.equal(shotView({ view: 'nojs' }, 'desktop'), 'nojs');
  assert.equal(shotView({}, 'tablet'), 'tablet');
});

test('shots grouped by view with their screenshot index; first shot of each kind wins', () => {
  const shots = [
    { kind: 'viewport', view: 'desktop', cssWidth: 1280 },
    { kind: 'thumbnail' },
    { kind: 'fullpage', view: 'desktop' },
    { kind: 'viewport', view: 'mobile', cssWidth: 390 },
    { kind: 'viewport', view: 'mobile', cssWidth: 999 },
  ];
  const by = shotsByView(reading({ device: 'desktop' }, shots));
  assert.deepEqual(Object.keys(by).sort(), ['desktop', 'mobile']);
  assert.equal(by.desktop.viewport.index, 0);
  assert.equal(by.desktop.fullpage.index, 2);
  assert.equal(by.mobile.viewport.shot.cssWidth, 390);
});

test('old readings: shots without view belong to the base view', () => {
  const by = shotsByView(reading({ device: 'tablet' }, [{ kind: 'viewport' }, { kind: 'fullpage' }]));
  assert.deepEqual(Object.keys(by), ['tablet']);
  assert.deepEqual(shotsByView({ log: { _harplus: {} } }), {});
});

test('ratios and comparison (zero base → 1)', () => {
  assert.equal(ratio(50, 200), 0.25);
  assert.equal(ratio(10, 0), 1);
  assert.equal(ratio(0, 0), 1);
  const cmp = compareViews({
    desktop: { text: 1000, links: 20 },
    nojs: { text: 150, links: 4 },
    nocss: { text: 1400, links: 20 },
  }, 'desktop');
  assert.equal(cmp.base, 'desktop');
  assert.equal(cmp.views.nojs.textRatio, 0.15);
  assert.equal(cmp.views.nojs.linkRatio, 0.2);
  assert.equal(cmp.views.nocss.textRatio, 1.4);
  assert.equal(cmp.views.desktop.textRatio, 1);
  assert.equal(compareViews({ nojs: { text: 1, links: 1 } }, 'desktop'), null);
  assert.equal(compareViews(undefined, 'desktop'), null);
});

test('zero base: ratios are 1 so nothing looks lost', () => {
  const cmp = compareViews({ desktop: { text: 0, links: 0 }, nojs: { text: 0, links: 0 } }, 'desktop');
  assert.equal(cmp.views.nojs.textRatio, 1);
  assert.equal(cmp.views.nojs.linkRatio, 1);
});

test('ratingFor thresholds', () => {
  assert.equal(ratingFor(0.8), 'good');
  assert.equal(ratingFor(0.79), 'needs-improvement');
  assert.equal(ratingFor(0.2), 'needs-improvement');
  assert.equal(ratingFor(0.19), 'poor');
});

test('settings: all views on by default; user overrides survive merge', () => {
  assert.deepEqual(DEFAULTS.capture.views, {
    desktop: true, tablet: true, mobile: true, nojs: true, nocss: true, noimages: true, rtl: true, pseudo: true,
    vision: true, protanopia: true, deuteranopia: true, tritanopia: true, achromatopsia: true, blurred: true, lowcontrast: true,
    dark: true, forced: true, morecontrast: true, print: true, spacing: true, reflow: true, text200: true, breakpoints: true,
  });
  const s = merge(DEFAULTS, { capture: { views: { nojs: false } } });
  assert.equal(s.capture.views.nojs, false);
  assert.equal(s.capture.views.tablet, true);
});

import { getIn, setIn } from '../extension/ui/paths.js';

test('dotted-path helpers for nested capture options', () => {
  const o = { views: { nojs: true } };
  assert.equal(getIn(o, 'views.nojs'), true);
  assert.equal(getIn(o, 'views.missing'), undefined);
  assert.equal(getIn(o, 'fullPage'), undefined);
  setIn(o, 'views.nojs', false);
  setIn(o, 'fullPage', true);
  setIn(o, 'a.b.c', 1);
  assert.deepEqual(o, { views: { nojs: false }, fullPage: true, a: { b: { c: 1 } } });
});

test('accessibility view groups, labels and emulation parameters', () => {
  assert.deepEqual(VISION_VIEWS, ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred', 'lowcontrast']);
  assert.deepEqual(DISPLAY_VIEWS, ['dark', 'forced', 'morecontrast', 'print']);
  assert.deepEqual(WCAG_VIEWS, ['spacing', 'reflow', 'text200']);
  assert.deepEqual(A11Y_VIEWS, [...VISION_VIEWS, ...DISPLAY_VIEWS, ...WCAG_VIEWS]);
  assert.deepEqual(A11Y_VIEWS.map((v) => VIEW_LABELS[v]), ['Protanopia', 'Deuteranopia', 'Tritanopia', 'Achromatopsia', 'Blurred vision',
    'Reduced contrast', 'Dark mode', 'Forced colours', 'More contrast', 'Print', 'Text spacing', '320 px reflow', '200% text']);
  assert.deepEqual(VISION_DEFICIENCY, { protanopia: 'protanopia', deuteranopia: 'deuteranopia', tritanopia: 'tritanopia',
    achromatopsia: 'achromatopsia', blurred: 'blurredVision', lowcontrast: 'reducedContrast' });
  assert.deepEqual(MEDIA_EMULATION.dark, { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  assert.deepEqual(MEDIA_EMULATION.forced, { features: [{ name: 'forced-colors', value: 'active' }] });
  assert.deepEqual(MEDIA_EMULATION.morecontrast, { features: [{ name: 'prefers-contrast', value: 'more' }] });
  assert.deepEqual(MEDIA_EMULATION.print, { media: 'print' });
  assert.match(SPACING_CSS, /line-height: 1\.5 !important/);
  assert.match(SPACING_CSS, /letter-spacing: 0\.12em !important/);
  assert.match(SPACING_CSS, /word-spacing: 0\.16em !important/);
  assert.match(SPACING_CSS, /p \{ margin-bottom: 2em !important; \}/);
  assert.equal(shotView({ view: 'dark' }, 'desktop'), 'dark');
});

test('settings: every accessibility view and the vision group default on', () => {
  for (const id of [...A11Y_VIEWS, 'vision']) assert.equal(DEFAULTS.capture.views[id], true, id);
  assert.equal(merge(DEFAULTS, { capture: { views: { vision: false } } }).capture.views.dark, true);
});

test('accessibility view helpers: thresholds, extra clipping, base-relative reflow and dark state', () => {
  assert.equal(A11Y_CLIP_EXTRA, 3);
  assert.equal(A11Y_LIGHT_BG, 0.5);
  assert.equal(A11Y_FORCED_OPT_OUTS, 20);
  assert.equal(extraClipped({ clipped: 12 }, { clipped: 2 }), 10);
  assert.equal(extraClipped({ clipped: 12 }, { clipped: 2, truncated: true }), 0, 'truncated base: counts not comparable');
  assert.equal(extraClipped({ clipped: 12, truncated: true }, { clipped: 2 }), 0, 'truncated view: counts not comparable');
  assert.equal(reflowScroll({ overflowX: 200 }, { overflowX: 200 }), 0, 'the base already overflows as much');
  assert.equal(reflowScroll({ overflowX: 40 }, { overflowX: 0 }), 40);
  assert.equal(reflowScroll({ overflowX: 240 }, { overflowX: 200 }), 40, 'overflow beyond the base');
  assert.equal(reflowScroll({ overflowX: 40, rootClipX: true }, { overflowX: 0 }), 0, 'the root clips: cannot scroll sideways');
  assert.equal(darkState({ bg: 0.05 }, { bg: 0.05 }), 'already dark');
  assert.equal(darkState({ bg: 0.98 }, { bg: 0.3 }), 'already dark');
  assert.equal(darkState({ bg: 0.98 }, { bg: 1 }), 'no change');
  assert.equal(darkState({ bg: 0.04 }, { bg: 1 }), 'changes');
  assert.equal(darkState({ bg: null }, { bg: 1 }), null, 'unmeasured background');
});

test('settings: focus-style check on by default', () => {
  assert.equal(DEFAULTS.capture.focusCheck, true);
});

test('breakpoint view ids and labels', () => {
  assert.ok(isBreakpointView('bp768-below'));
  assert.ok(isBreakpointView('bp1024-at'));
  assert.ok(!isBreakpointView('bp-at'));
  assert.equal(viewLabel('bp768-below'), '767 px');
  assert.equal(viewLabel('bp768-at'), '768 px');
  assert.equal(viewLabel('dark'), 'Dark mode');
  assert.equal(viewLabel('zzz'), 'zzz');
  assert.equal(shotView({ view: 'bp900-at' }, 'desktop'), 'bp900-at');
});

test('pickBreakpoints: normalises min/max/range, em, clamps 320–1920, top 2 with larger on ties', () => {
  assert.deepEqual(pickBreakpoints([['(max-width: 899px)', 3], ['(min-width: 600px)', 2], ['(min-width: 1200px)', 2]]), [900, 1200]);
  assert.deepEqual(pickBreakpoints([['(min-width: 48em)', 1], ['screen and (max-width: 47.99em)', 1]]), [768]);
  assert.deepEqual(pickBreakpoints([['(width >= 1024px)', 1], ['(width < 640px)', 1], ['(width <= 639px)', 1]]), [640, 1024]);
  assert.deepEqual(pickBreakpoints([['(min-width: 200px)', 9], ['(min-width: 4000px)', 9], ['print', 9]]), []);
  assert.deepEqual(pickBreakpoints([]), []);
  assert.deepEqual(pickBreakpoints(undefined), []);
});

test('breakpointFindings: edge-only overflow (medium, with culprits) and clipping (low)', () => {
  const base = { overflowX: 0, clipped: 1 };
  const views = {
    'bp900-below': { overflowX: 40, clipped: 1, overflowers: [{ selector: 'div.edge', width: 920, over: 40 }] },
    'bp900-at': { overflowX: 0, clipped: 5 },
  };
  const f = breakpointFindings(views, [900], base);
  assert.deepEqual(f.map((x) => `${x.severity}:${x.title}`), [
    'medium:Layout breaks at 899 px (just below the 900 px breakpoint)',
    'low:Text clips at 900 px near the 900 px breakpoint',
  ]);
  assert.equal(f[0].detail, 'Wider than the viewport: div.edge (920 px)');
  assert.ok(f.every((x) => x.category === 'quality'));
  assert.deepEqual(breakpointFindings({ 'bp900-below': { overflowX: 40 }, 'bp900-at': { overflowX: 40 } }, [900], base), [], 'both edges overflow → not an edge break');
  assert.deepEqual(breakpointFindings({ 'bp900-below': { overflowX: 40 } }, [900], { overflowX: 10 }), [], 'base already overflows');
  assert.deepEqual(breakpointFindings({}, [], base), []);
});

test('breakpointFindings: a root that clips overflow-x cannot scroll sideways', () => {
  const at = { overflowX: 0, clipped: 0 };
  assert.deepEqual(breakpointFindings({ 'bp900-below': { overflowX: 40, rootClipX: true }, 'bp900-at': at }, [900], {}), [], 'overflowing view clips');
  // The other view and the base overflow only on paper (their roots clip), so the edge break still counts.
  assert.equal(breakpointFindings({ 'bp900-below': { overflowX: 40 }, 'bp900-at': { overflowX: 40, rootClipX: true } }, [900], { overflowX: 10, rootClipX: true }).length, 1);
});

test('breakpointFindings: truncated walks give no clip finding', () => {
  const v = (x) => ({ overflowX: 0, clipped: 1, ...x });
  assert.deepEqual(breakpointFindings({ 'bp900-below': v(), 'bp900-at': v({ clipped: 9, truncated: true }) }, [900], v()), [], 'view truncated');
  assert.deepEqual(breakpointFindings({ 'bp900-below': v(), 'bp900-at': v({ clipped: 9 }) }, [900], v({ truncated: true })), [], 'base truncated');
  assert.deepEqual(breakpointFindings({ 'bp900-below': v({ truncated: true }), 'bp900-at': v({ clipped: 9 }) }, [900], v()), [], 'other truncated');
});

test('breakpointFindings: no overflow finding when the other edge view is missing', () => {
  assert.deepEqual(breakpointFindings({ 'bp900-below': { overflowX: 40 } }, [900], { overflowX: 0 }), []);
  assert.deepEqual(breakpointFindings({ 'bp900-at': { overflowX: 40 } }, [900], { overflowX: 0 }), []);
});

test('edgeOverflow and edgeClipExtra: the effective numbers the chips and glance use', () => {
  assert.equal(edgeOverflow({ overflowX: 40 }), 40);
  assert.equal(edgeOverflow({ overflowX: 40, rootClipX: true }), 0);
  assert.equal(edgeOverflow(undefined), 0);
  assert.equal(edgeClipExtra({ clipped: 6 }, { clipped: 1 }, { clipped: 2 }), 4);
  assert.equal(edgeClipExtra({ clipped: 6, truncated: true }, { clipped: 1 }, { clipped: 2 }), 0);
  assert.equal(edgeClipExtra({ clipped: 6 }, undefined, {}), 6);
  assert.equal(edgePartner('bp900-below'), 'bp900-at');
  assert.equal(edgePartner('bp900-at'), 'bp900-below');
});

test('settings: breakpoint views on by default', () => {
  assert.equal(DEFAULTS.capture.views.breakpoints, true);
});
