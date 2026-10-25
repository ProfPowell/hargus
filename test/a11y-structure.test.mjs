import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { analyzeStructure } from '../extension/plugins/a11y-structure.js';
import { focusChanges, FOCUS_KINDS, KIND_LABELS } from '../extension/core/focus.js';
import { getPlugins } from '../extension/plugins/index.js';
import { h } from '../extension/ui/render.js';

const none = { count: 0, samples: [] };
const bag = (n) => ({ count: n, samples: Array.from({ length: Math.min(n, 5) }, (_, i) => ({ selector: `x${i}`, text: 't' })) });
const base = (over = {}) => ({
  headings: [{ level: 1, text: 'Home', selector: 'h1' }], hiddenHeadings: [],
  landmarks: { mains: 1, hasMain: true, navs: ['Main'], asides: [], banners: 1, contentinfos: 1 },
  labelInName: none, httpLinks: none, multiText: none, noCurrent: 0, labelRefs: none, ariaRefs: none,
  badAlt: none, badAuto: none, resetButtons: 0, targets24: none, targets44: none, smallText: { count: 0 },
  smallFields: none, focusJumps: none, noRole: none, ...over,
});
const t = (r) => r.findings.map((f) => `${f.severity}:${f.title}`);

test('registered after contrast; page phase, Accessibility', () => {
  const ids = getPlugins().map((p) => p.id);
  assert.equal(ids.indexOf('a11y-structure'), ids.indexOf('contrast') + 1);
  assert.equal(plugin.phase, 'page');
  assert.equal(plugin.area, 'accessibility');
});

test('clean page: no findings', () => {
  assert.deepEqual(t(analyzeStructure(base())), []);
});

test('headings: skipped, empty, duplicates; hidden headings ignored', () => {
  const r = analyzeStructure(base({
    headings: [{ level: 1, text: 'Home' }, { level: 3, text: 'Deep' }, { level: 2, text: '' }, { level: 2, text: 'deep ' }],
    hiddenHeadings: [{ level: 5, text: 'menu' }],
  }));
  assert.deepEqual(t(r), ['low:1 skipped heading levels', 'medium:1 empty headings', 'info:1 duplicate heading texts']);
});

test('landmarks', () => {
  assert.deepEqual(t(analyzeStructure(base({ landmarks: { mains: 0, hasMain: false, navs: [], asides: [], banners: 0, contentinfos: 0 } }))), ['low:No <main> landmark']);
  assert.deepEqual(t(analyzeStructure(base({ landmarks: { mains: 2, hasMain: true, navs: ['', ''], asides: ['a', 'a'], banners: 2, contentinfos: 2 } }))), [
    'medium:2 main landmarks', 'low:2 navigation landmarks without distinct labels', 'low:2 complementary landmarks without distinct labels',
    'low:Multiple banner landmarks', 'low:Multiple contentinfo landmarks',
  ]);
  assert.deepEqual(t(analyzeStructure(base({ landmarks: { mains: 1, hasMain: true, navs: ['Main', 'Footer'], asides: [], banners: 1, contentinfos: 1 } }))), []);
});

test('names, links, references, alt, autocomplete, reset', () => {
  const r = analyzeStructure(base({
    labelInName: bag(2), httpLinks: bag(3), multiText: bag(1), noCurrent: 1, labelRefs: bag(1), ariaRefs: bag(2),
    badAlt: bag(4), badAuto: bag(1), resetButtons: 1,
  }));
  assert.deepEqual(t(r), [
    'medium:2 controls whose accessible name hides their visible label (WCAG 2.5.3)',
    'low:3 links use plain HTTP', 'info:1 URL linked with different text', 'info:Current page link has no aria-current',
    'medium:1 label or description reference points to a missing id', 'low:2 ARIA references point to missing ids',
    'low:4 images with unhelpful alt text', 'low:1 invalid autocomplete value (WCAG 1.3.5)', 'info:Reset button present',
  ]);
  assert.equal(r.findings[0].evidence, 'x0\nx1');
});

test('targets and small text; mobile-only advisories', () => {
  const c = base({ targets24: bag(3), targets44: bag(9), smallText: { count: 12 }, smallFields: bag(2) });
  assert.deepEqual(t(analyzeStructure(c)), ['medium:3 targets smaller than 24×24 px (WCAG 2.5.8)', 'low:12 text elements from 10 to under 12 px']);
  assert.deepEqual(t(analyzeStructure(c, { mobile: true })), [
    'medium:3 targets smaller than 24×24 px (WCAG 2.5.8)', 'info:9 targets under 44×44 px (advisory)',
    'low:12 text elements from 10 to under 12 px', 'low:2 form fields under 16 px (iOS zooms in)',
  ]);
});

test('focus order and role-less focusables', () => {
  assert.deepEqual(t(analyzeStructure(base({ focusJumps: bag(2), noRole: bag(1) }))), ['low:Focus order jumps back up the page 2 times', 'low:1 focusable element without a role']);
});

test('focus styles: none at all → one medium; some → low per kind; outline-none detail; absent → nothing', () => {
  const s = (kind, changed) => ({ kind, selector: kind, changed });
  const all = analyzeStructure(base(), { focus: { samples: [s('button', []), s('inline-link', [])], outlineNone: 2 } });
  assert.deepEqual(t(all), ['medium:No visible focus indicator on any sampled control (WCAG 2.4.7)']);
  assert.equal(all.findings[0].detail, 'Stylesheets remove the focus outline in 2 rules without a replacement.');
  const some = analyzeStructure(base(), { focus: { samples: [s('button', ['outline']), s('inline-link', [])], outlineNone: 0 } });
  assert.deepEqual(t(some), ['low:Inline links show no visible focus indicator']);
  assert.equal(some.findings[0].detail, undefined);
  assert.deepEqual(t(analyzeStructure(base(), { focus: { samples: [s('button', [])], outlineNone: 0 } })), ['low:Buttons show no visible focus indicator'], 'one kind is not "all"');
  assert.deepEqual(t(analyzeStructure(base(), { focus: undefined })), []);
});

test('focusChanges and kind labels', () => {
  const b = { outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgb(0, 0, 0)', boxShadow: 'none', borderColor: 'rgb(0, 0, 0)', borderWidth: '0px', backgroundColor: 'rgba(0, 0, 0, 0)', textDecorationLine: 'none', color: 'rgb(0, 0, 0)' };
  assert.deepEqual(focusChanges(b, { ...b, outlineStyle: 'auto', outlineWidth: '1px' }), ['outline']);
  assert.deepEqual(focusChanges(b, { ...b, outlineColor: 'red' }), [], 'outline colour alone with style none is invisible');
  assert.deepEqual(focusChanges(b, { ...b, boxShadow: '0 0 0 2px blue', textDecorationLine: 'underline' }), ['box-shadow', 'underline']);
  assert.deepEqual(focusChanges(b, b), []);
  assert.deepEqual(focusChanges(undefined, b), []);
  assert.equal(FOCUS_KINDS.length, 8);
  assert.equal(KIND_LABELS.checkbox, 'Checkboxes and radios');
});

test('run(): mobile from the base view, focus from capture; summary and glance without NaN', () => {
  const reading = { log: { entries: [], _harplus: { capture: { device: 'mobile', focus: { samples: [{ kind: 'button', selector: 'button', changed: ['outline'] }], outlineNone: 0 } } } } };
  const out = plugin.run(reading, { collected: base({ targets44: bag(1) }), skip: () => {} });
  assert.ok(out.findings.some((f) => f.title === '1 target under 44×44 px (advisory)'));
  assert.ok(out.summary.some((s) => s.label === 'Focus' && s.value === '1 of 1 kinds visible'));
  const html = String(plugin.glance({ status: 'ok', ...out }, h)) + String(plugin.render({ status: 'ok', ...out }, h));
  assert.doesNotMatch(html, /NaN|undefined/);
  assert.throws(() => plugin.run({ log: { _harplus: {} } }, { collected: undefined, skip: (m) => { throw new Error(m); } }), /no page data/);
});

test('glance and render tolerate focus samples without a changed list', () => {
  const out = analyzeStructure(base(), { focus: { samples: [{ kind: 'button', selector: 'button' }], outlineNone: 0 } });
  const r = { status: 'ok', ...out };
  assert.doesNotMatch(String(plugin.glance(r, h)) + String(plugin.render(r, h)), /NaN|undefined/);
});

import a11yBasics from '../extension/plugins/a11y-basics.js';

test('duplicates removed from a11y-basics; a11y-structure keeps the only copy', () => {
  const src = String(a11yBasics.collect);
  assert.doesNotMatch(src, /heading-order|empty-heading|landmark-main/);
  const r = analyzeStructure({ ...base(), headings: [{ level: 1, text: 'A' }, { level: 3, text: '' }], landmarks: { mains: 0, hasMain: false, navs: [], asides: [], banners: 0, contentinfos: 0 } });
  assert.deepEqual(r.findings.map((f) => f.title), ['1 skipped heading levels', '1 empty headings', 'No <main> landmark']);
});

test('collect has no vague-word list of its own: without args.vague the check is skipped', () => {
  const src = plugin.collect.toString();
  assert.match(src, /vagueSkipped/);
  assert.doesNotMatch(src, /'click here'|'read more'/);
  assert.doesNotMatch(src, /\bimport\b/);
});
