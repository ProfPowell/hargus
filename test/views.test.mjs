import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEWS, VIEW_LABELS, baseView, shotView, shotsByView, ratio, compareViews, ratingFor,
} from '../extension/core/views.js';
import { DEFAULTS, merge } from '../extension/browser/settings.js';

const reading = (capture, screenshots) => ({ log: { _harplus: { capture, screenshots } } });

test('view ids and labels', () => {
  assert.deepEqual(VIEWS, ['desktop', 'tablet', 'mobile', 'nojs', 'nocss', 'noimages', 'rtl', 'pseudo']);
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
  assert.deepEqual(DEFAULTS.capture.views, { desktop: true, tablet: true, mobile: true, nojs: true, nocss: true, noimages: true, rtl: true, pseudo: true });
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
