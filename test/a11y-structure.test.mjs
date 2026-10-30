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

test('extent: bag findings carry count/of/unit; guesses get a count only; page-level rules get none', () => {
  const r = analyzeStructure(base({ vagueLinks: bag(5), possibleHeadings: bag(3), landmarks: { hasMain: false, mains: 0, navs: [], asides: [] }, headings: [{ level: 1, text: 'A' }, { level: 3, text: '' }] }), { pop: { links: 200, headings: 2 } });
  const f = (id) => r.findings.find((x) => x.id === id);
  assert.deepEqual([f('vague-link').count, f('vague-link').of, f('vague-link').unit], [5, 200, 'links']);
  assert.equal(f('possible-heading').count, 3);
  assert.equal(f('possible-heading').of, undefined);
  assert.equal(f('no-main').count, undefined);
  assert.deepEqual([f('headings-skipped').count, f('headings-skipped').of, f('headings-skipped').unit], [1, 2, 'headings']);
  assert.deepEqual([f('headings-empty').count, f('headings-empty').of], [1, 2]);
});

test('extent: run() builds the population from a11y-basics stats, the focusable count, headings and contrast', () => {
  const r = plugin.run({ log: { _harplus: {} } }, {
    collected: base({ httpLinks: bag(4), badAuto: bag(2), smallText: bag(3), focusableCount: 50 }),
    results: { 'a11y-basics': { data: { stats: { links: 80, images: 9, formFields: 6, buttons: 7 } } }, contrast: { data: { totals: { checked: 120 } } } },
  });
  const f = (id) => r.findings.find((x) => x.id === id);
  assert.deepEqual([f('http-links').count, f('http-links').of, f('http-links').unit], [4, 80, 'links']);
  assert.deepEqual([f('bad-autocomplete').count, f('bad-autocomplete').of, f('bad-autocomplete').unit], [2, 6, 'form fields']);
  assert.deepEqual([f('small-text').count, f('small-text').of, f('small-text').unit], [3, 120, 'text elements']);
});

test('extent: runs after axe, a11y-basics and contrast', () => {
  assert.deepEqual(plugin.after, ['axe', 'a11y-basics', 'contrast']);
});

test('places: element findings name their samples; the text goes where it belongs; evidence unchanged', () => {
  const s = (selector, text) => ({ selector, text });
  const r = analyzeStructure(base({
    vagueLinks: { count: 2, samples: [s('a#more', 'Read more'), s('a#here', '')] },
    labelInName: { count: 1, samples: [s('button#buy', 'Buy ≠ Purchase now')] },
    httpLinks: { count: 1, samples: [s('a#old', 'http://old.test/x')] },
    multiText: { count: 1, samples: [s('https://s.test/a', 'Home | Start')] },
    badAuto: { count: 1, samples: [s('input#e', 'emial')] },
  }));
  const f = (id) => r.findings.find((x) => x.id === id);
  assert.equal(f('vague-link').evidence, 'a#more\na#here');
  assert.deepEqual(f('vague-link').places, [{ selector: 'a#more', text: 'Read more' }, { selector: 'a#here' }]);
  assert.deepEqual(f('label-in-name').places, [{ selector: 'button#buy', note: 'Buy ≠ Purchase now' }]);
  assert.deepEqual(f('http-links').places, [{ selector: 'a#old', url: 'http://old.test/x' }]);
  assert.deepEqual(f('multi-text').places, [{ url: 'https://s.test/a', text: 'Home | Start' }]);
  assert.deepEqual(f('bad-autocomplete').places, [{ selector: 'input#e', note: 'emial' }]);
  assert.equal(f('no-current'), undefined);
  const heads = analyzeStructure(base({ headings: [{ level: 1, text: 'A' }, { level: 3, text: 'B' }] })).findings[0];
  assert.equal(heads.places, undefined, 'no places without evidence');
});

test('places: focus probe and keyboard walk findings, one per selector line, without the "… and N more" line', () => {
  const blind = analyzeStructure(base(), { focus: { samples: [{ kind: 'button', selector: 'button.go', changed: [] }, { kind: 'link', selector: 'a.x', changed: [] }] } });
  assert.deepEqual(blind.findings.find((x) => x.id === 'focus-none').places, [{ selector: 'button.go' }, { selector: 'a.x' }]);
  const stops = Array.from({ length: 12 }, (_, i) => ({ sel: `button.b${i}`, role: 'button', name: '', tag: 'button', box: { x: 0, y: i * 40, w: 50, h: 20 }, visible: true, onScreen: true, tabindex: 0, changed: true }));
  const kb = analyzeStructure(base(), { keyboard: { stops, ended: 'cycle', ms: 900 } }).findings.find((x) => x.id === 'kb-no-name');
  assert.match(kb.evidence, /\n… and 2 more$/);
  assert.equal(kb.places.length, 10);
  assert.deepEqual(kb.places[0], { selector: 'button.b0' });
  assert.ok(kb.places.every((p) => !p.selector.startsWith('…')));
});

test('odd values: a very long selector and text with "<" stay whole in places, escaped when drawn', () => {
  const long = `html > body > ${'div.wrap > '.repeat(80)}a`;
  const r = analyzeStructure(base({ vagueLinks: { count: 1, samples: [{ selector: long, text: '<img src=x onerror=alert(1)> more' }] } }));
  const [p] = r.findings.find((x) => x.id === 'vague-link').places;
  assert.equal(p.selector, long);
  assert.equal(p.text, '<img src=x onerror=alert(1)> more');
  const drawn = String(h.places([p]));
  assert.doesNotMatch(drawn, /<img/);
  assert.match(drawn, /&lt;img src=x/);
});

test('render: the answer first; headline is the focus, else the headings', () => {
  const out = analyzeStructure(base({ vagueLinks: bag(2), headings: [{ level: 1, text: 'A' }, { level: 3, text: 'B' }], landmarkList: [{ role: 'main' }] }));
  const s = String(plugin.render({ status: 'ok', ...out }, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('Structure outline'));
  assert.match(s, /Headings<\/span><div class="stat-value">2<\/div><span class="stat-note">1 skipped/);
  assert.match(s, /Landmarks<\/span><div class="stat-value">1/);
  assert.match(s, /Element checks failing<\/span><div class="stat-value">1/);
  assert.doesNotMatch(s, /Keyboard stops/, 'no walk, no stops tile');
  const urls = String(plugin.render({ status: 'ok', ...analyzeStructure(base({
    httpLinks: { count: 1, samples: [{ selector: 'a#old', text: 'http://old.test/x?y=1' }] },
    multiText: { count: 1, samples: [{ selector: 'https://s.test/a', text: 'Home | Start' }] },
  })) }, h));
  assert.match(urls, /<code>a#old<\/code> <span class="url" title="http:\/\/old\.test\/x\?y=1"><span class="url-host">old\.test<\/span><span class="url-path">\/x<\/span><span class="url-query">\?y=1/);
  assert.match(urls, /<span class="url-host">s\.test<\/span><span class="url-path">\/a<\/span><\/span> Home \| Start/);
  const head = (o) => o.summary.filter((x) => x.headline).map((x) => `${x.label} ${x.value}`);
  assert.deepEqual(head(out), ['Headings 2 · 1 skipped']);
  assert.deepEqual(head(analyzeStructure(base(), { focus: { samples: [{ kind: 'button', selector: 'b', changed: ['outline'] }] } })), ['Focus 1 of 1 kinds visible']);
});
