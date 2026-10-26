import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OVERLAP, suppressedBy } from '../extension/core/a11y-overlap.js';
import axe from '../extension/plugins/axe.js';
import mapPlugin, { analyzeMap } from '../extension/plugins/a11y-map.js';
import { readFileSync } from 'node:fs';
import basics from '../extension/plugins/a11y-basics.js';
import { analyzeStructure } from '../extension/plugins/a11y-structure.js';
import { h } from '../extension/ui/render.js';

const okAxe = (over = {}) => ({ status: 'ok', data: { violations: [], incomplete: [], passedIds: [], ...over } });

test('suppressedBy: needs axe ok, a suppress row, and the rule having run', () => {
  assert.equal(suppressedBy('a11y-basics', 'image-alt', okAxe({ violations: [{ id: 'image-alt' }] })), 'image-alt');
  assert.equal(suppressedBy('a11y-basics', 'image-alt', okAxe({ passedIds: ['image-alt'] })), 'image-alt');
  assert.equal(suppressedBy('a11y-basics', 'image-alt', okAxe({ incomplete: [{ id: 'image-alt' }] })), 'image-alt');
  assert.equal(suppressedBy('a11y-basics', 'image-alt', okAxe()), null, 'rule did not run');
  assert.equal(suppressedBy('a11y-basics', 'image-alt', { status: 'error', data: null }), null);
  assert.equal(suppressedBy('a11y-basics', 'image-alt', { status: 'skipped' }), null);
  assert.equal(suppressedBy('a11y-basics', 'image-alt', undefined), null);
  assert.equal(suppressedBy('a11y-structure', 'headings-skipped', okAxe({ passedIds: ['heading-order'] })), null, 'ran and passed: ours stays');
  assert.equal(suppressedBy('a11y-basics', 'nope', okAxe()), null);
});

test('headings-skipped, label-in-name and targets-24 yield only when axe finds the same rule violated', () => {
  for (const [key, rule] of [['headings-skipped', 'heading-order'], ['label-in-name', 'label-content-name-mismatch'], ['targets-24', 'target-size']]) {
    assert.equal(suppressedBy('a11y-structure', key, okAxe({ violations: [{ id: rule }] })), rule, `${key} yields to a violation`);
    assert.equal(suppressedBy('a11y-structure', key, okAxe({ incomplete: [{ id: rule }] })), null, `${key} stays when axe only needs review`);
    assert.equal(suppressedBy('a11y-structure', key, okAxe({ passedIds: [rule] })), null, `${key} stays when axe ran it and passed`);
    assert.equal(suppressedBy('a11y-structure', key, okAxe()), null, `${key} stays when axe did not run it`);
  }
});

test('multi-rule rows suppress only when every listed rule ran', () => {
  const all = okAxe({ passedIds: ['button-name', 'aria-command-name'], violations: [{ id: 'input-button-name' }] });
  assert.ok(suppressedBy('a11y-basics', 'button-name', all));
  assert.equal(suppressedBy('a11y-basics', 'button-name', okAxe({ passedIds: ['button-name', 'aria-command-name'] })), null);
});

test('table: required suppress rows exist; keep rows for partial overlaps', () => {
  const mode = (k) => OVERLAP.find((o) => o.ours === k)?.mode;
  for (const k of ['a11y-basics:image-alt', 'a11y-basics:input-label', 'a11y-basics:html-lang', 'a11y-structure:headings-empty',
    'a11y-basics:link-name', 'a11y-basics:button-name', 'a11y-structure:headings-skipped', 'a11y-structure:targets-24', 'a11y-structure:label-in-name']) assert.equal(mode(k), 'suppress', k);
  for (const k of ['a11y-structure:focus-jumps', 'a11y-basics:duplicate-id']) assert.equal(mode(k), 'keep', k);
  assert.equal(new Set(OVERLAP.map((o) => o.ours)).size, OVERLAP.length, 'no duplicate rows');
});

const imgRule = { id: 'image-alt', impact: 'critical', help: 'Images without an alt attribute', count: 1, samples: [{ selector: 'img', html: '<img>' }] };
const fakeCtx = (axeResult) => ({ collected: { rules: [imgRule, { ...imgRule, id: 'tabindex', help: 'Positive tabindex' }], errors: [], stats: {} }, results: { axe: axeResult } });

test('a11y-basics: omits the missing-alt finding when axe covered image-alt; keeps it when axe failed', () => {
  assert.deepEqual(basics.after, ['axe']);
  const covered = basics.run({}, fakeCtx(okAxe({ violations: [{ id: 'image-alt' }] })));
  assert.deepEqual(covered.findings.map((f) => f.id), ['tabindex']);
  const failed = basics.run({}, fakeCtx({ status: 'error', data: null }));
  assert.deepEqual(failed.findings.map((f) => f.id), ['image-alt', 'tabindex']);
  const absent = basics.run({}, fakeCtx(undefined));
  assert.equal(absent.findings.length, 2);
});

test('a11y-structure: every finding has a stable id; empty headings yield to axe', () => {
  const c = {
    headings: [{ level: 1, text: 'A' }, { level: 3, text: '' }], hiddenHeadings: [],
    landmarks: { mains: 0, hasMain: false, navs: [], asides: [], banners: 0, contentinfos: 0 },
  };
  const all = analyzeStructure(c);
  assert.ok(all.findings.every((f) => f.id), 'ids');
  assert.deepEqual(all.findings.map((f) => f.id), ['headings-skipped', 'headings-empty', 'no-main']);
  const yielded = analyzeStructure(c, { axe: okAxe({ passedIds: ['empty-heading', 'landmark-one-main'] }) });
  assert.deepEqual(yielded.findings.map((f) => f.id), ['headings-skipped']);
});

test('axe plugin: on by default, needs-review findings from incomplete', () => {
  assert.equal(axe.defaultEnabled, true);
  assert.doesNotMatch(axe.description, /vendor-axe/);
  const inc = { id: 'color-contrast', impact: 'serious', help: 'Elements must meet contrast', helpUrl: 'https://x', nodes: 3,
    samples: [{ target: '.a', html: '<p class="a">', summary: 'Fix any of: could not determine' }, { target: '.b', html: '<p>', summary: '' }] };
  const r = axe.run({}, { collected: { engine: '4.14.0', passes: 5, passedIds: ['x'], incomplete: [inc], violations: [] } });
  const f = r.findings.find((x) => x.title.startsWith('Needs review'));
  assert.equal(f.title, 'Needs review: Elements must meet contrast (3)');
  assert.equal(f.severity, 'info');
  assert.equal(f.detail, 'Fix any of: could not determine');
  assert.equal(f.evidence, '.a\n.b');
  assert.match(String(axe.render({ data: { violations: [], incomplete: [inc] } }, h)), /Needs review[\s\S]*<code>\.a<\/code>/);
});

test('inapplicable axe rules count as having run: one inapplicable rule of three still suppresses the button-name finding', () => {
  const two = okAxe({ passedIds: ['button-name', 'aria-command-name'] });
  assert.equal(suppressedBy('a11y-basics', 'button-name', two), null, 'input-button-name never reported');
  const three = okAxe({ passedIds: ['button-name', 'aria-command-name'], ranIds: ['input-button-name'] });
  assert.equal(suppressedBy('a11y-basics', 'button-name', three), 'button-name, aria-command-name, input-button-name');
  const covered = basics.run({}, { collected: { rules: [{ id: 'button-name', impact: 'critical', help: 'Buttons without an accessible name', count: 1, samples: [] }], errors: [], stats: {} }, results: { axe: three } });
  assert.deepEqual(covered.findings, []);
});

test('axe collect asks for inapplicable results and records their ids as ranIds', async () => {
  let opts;
  globalThis.document = { querySelectorAll: () => [] };
  globalThis.axe = { run: async (_d, o) => { opts = o; return { testEngine: { version: '4' }, passes: [], violations: [], incomplete: [], inapplicable: [{ id: 'input-button-name' }] }; } };
  try {
    const c = await axe.collect({ tags: '' });
    assert.ok(opts.resultTypes.includes('inapplicable'));
    assert.deepEqual(c.ranIds, ['input-button-name']);
  } finally { delete globalThis.axe; delete globalThis.document; }
});

// Every accessibility finding id the plugins can emit has an OVERLAP row (axe covers it, or it is listed as keep/unique).
test('every emitted accessibility finding id has an OVERLAP row', () => {
  const src = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
  const ids = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
  const bag = (n) => ({ count: n, samples: [{ selector: 'p', text: 'x' }] });
  const everything = {
    headings: [{ level: 1, text: 'A' }, { level: 3, text: '' }, { level: 3, text: 'A' }, { level: 3, text: 'a' }],
    landmarks: { mains: 2, hasMain: true, navs: ['', ''], asides: ['', ''], banners: 2, contentinfos: 2 },
    labelInName: bag(1), httpLinks: bag(1), multiText: bag(1), noCurrent: 1, labelRefs: bag(1), ariaRefs: bag(1), badAlt: bag(1), badAuto: bag(1),
    resetButtons: 1, targets24: bag(1), targets44: bag(1), smallText: { count: 1 }, tinyText: bag(1), smallFields: bag(1), focusJumps: bag(1), noRole: bag(1),
    possibleHeadings: bag(1), possibleLists: bag(1), vagueLinks: bag(1), justified: bag(1), underlined: bag(1),
  };
  const im = (over) => ({ sel: 'x', kind: 'img', alt: 'A tent', name: 'A tent', inLink: false, adjacentText: '', src: '', box: { x: 0, y: 0, w: 1, h: 1 }, ...over });
  const images = [im({ alt: null, name: '', kind: 'svg' }), im({ alt: '', name: '', inLink: true }), im({ alt: 'image' }), im({ alt: 'Tent', adjacentText: 'Tent' }),
    im({ alt: 'x'.repeat(150) }), im({ alt: 'IMG_1234.jpg' })];
  const emitted = new Set([
    ...ids(src('plugins/a11y-basics.js'), /\b(?:check|flag)\('([a-z0-9-]+)'/g).map((i) => `a11y-basics:${i}`),
    ...analyzeStructure(everything, { mobile: true }).findings.map((f) => `a11y-structure:${f.id}`),
    ...ids(src('core/keyboard.js'), /\badd\('([a-z0-9-]+)'/g).map((i) => `a11y-structure:${i}`),
    ...analyzeMap({ images, doc: { w: 1, h: 1 } }).findings.map((f) => `a11y-map:${f.id}`),
    ...ids(src('plugins/contrast.js'), /\bid: '(contrast-[a-z]+)'/g).map((i) => `contrast:${i}`),
    ...ids(src('plugins/html.js'), /'(fake-buttons)'/g).map((i) => `html:${i}`),
  ]);
  assert.ok(emitted.size > 60, `found ${emitted.size}`);
  const rows = new Set(OVERLAP.map((o) => o.ours));
  const missing = [...emitted].filter((k) => !rows.has(k));
  assert.deepEqual(missing, [], `no OVERLAP row for: ${missing.join(', ')}`);
});

test('a11y-map drops the Structure bad-alt finding (the Images panel owns alt quality) and its alt findings yield to axe', () => {
  const st = { status: 'ok', findings: [{ id: 'bad-alt', title: 'x' }, { id: 'no-main', title: 'y' }] };
  const imgs = [{ sel: 'a > img', kind: 'img', alt: '', name: '', inLink: true, adjacentText: '', src: '', box: { x: 0, y: 0, w: 1, h: 1 } },
    { sel: 'img.r', kind: 'img', alt: 'Tent', name: 'Tent', inLink: false, adjacentText: 'Tent', src: '', box: { x: 0, y: 0, w: 1, h: 1 } }];
  const results = { 'a11y-structure': st, axe: okAxe({ ranIds: ['link-name', 'image-redundant-alt'] }) };
  const r = mapPlugin.run({ log: { _harplus: {} } }, { collected: { images: imgs, doc: { w: 1, h: 1 } }, results });
  assert.deepEqual(st.findings.map((f) => f.id), ['no-main']);
  assert.deepEqual(r.findings, [], 'linked-empty-alt and redundant-alt yield to axe');
  const alone = mapPlugin.run({ log: { _harplus: {} } }, { collected: { images: imgs, doc: { w: 1, h: 1 } }, results: { 'a11y-structure': { findings: [] } } });
  assert.deepEqual(alone.findings.map((f) => f.id).sort(), ['linked-empty-alt', 'redundant-alt']);
});

test('a11y-basics leaves out a broken skip link that is the first stop of the walk; other broken anchors stay', () => {
  const rule = { id: 'link-broken-anchor', impact: 'serious', help: 'In-page links to a missing target', count: 2, samples: [{ selector: 'a.skip' }, { selector: 'footer a' }] };
  const har = { log: { _harplus: { capture: { keyboard: { stops: [{ sel: 'a.skip', skip: { href: '#main', exists: false } }] } } } } };
  const r = basics.run({}, { har, collected: { rules: [rule], errors: [], stats: {} }, results: {} });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].evidence, 'footer a');
  const only = basics.run({}, { har, collected: { rules: [{ ...rule, count: 1, samples: [rule.samples[0]] }], errors: [], stats: {} }, results: {} });
  assert.deepEqual(only.findings, [], 'reported once, by the walk');
});

test('axe run: violations carry count/of/unit; page-level and review findings do not', () => {
  const v = (id, nodes) => ({ id, impact: 'serious', help: id, helpUrl: 'https://x', tags: ['wcag2a'], nodes, samples: [] });
  const r = axe.run({}, { collected: { passes: 0, passedIds: [], violations: [v('link-name', 65), v('landmark-one-main', 1), v('color-contrast', 9)],
    incomplete: [v('color-contrast', 4)], population: { links: 819, images: 3, fields: 2, buttons: 1, focusables: 900 } },
  results: { contrast: { data: { totals: { checked: 300 } } } } });
  const link = r.findings.find((f) => f.id === 'link-name');
  assert.equal(link.count, 65);
  assert.equal(link.of, 819);
  assert.equal(link.unit, 'links');
  const cc = r.findings.find((f) => f.id === 'color-contrast');
  assert.equal(cc.of, 300, 'text population from the contrast plugin');
  assert.equal(cc.unit, 'text elements');
  assert.ok(!('count' in r.findings.find((f) => f.id === 'landmark-one-main')));
  assert.ok(!('count' in r.findings.find((f) => f.id === 'review:color-contrast')));
  assert.deepEqual(axe.after, ['contrast']);
});

test('axe run: an old reading without population still gives counts', () => {
  const r = axe.run({}, { collected: { passes: 0, passedIds: [], violations: [{ id: 'image-alt', impact: 'critical', help: 'h', helpUrl: '', tags: [], nodes: 2, samples: [] }] } });
  assert.equal(r.findings[0].count, 2);
  assert.ok(!('of' in r.findings[0]));
});

test('axe collect counts the populations inside the page function', async () => {
  const sizes = { 'a[href]': 7, img: 3, 'input, select, textarea': 2, 'button, [role="button"]': 4 };
  globalThis.document = { querySelectorAll: (s) => ({ length: sizes[s] ?? 11 }) };
  globalThis.axe = { run: async () => ({ testEngine: { version: '4' }, passes: [], violations: [], incomplete: [], inapplicable: [] }) };
  try {
    const c = await axe.collect({});
    assert.deepEqual(c.population, { links: 7, images: 3, fields: 2, buttons: 4, focusables: 11 });
  } finally { delete globalThis.document; delete globalThis.axe; }
});

test('a11y-basics run: element rules carry count/of; page rules do not', () => {
  const rules = [{ id: 'image-alt', impact: 'critical', help: 'Images without alt', count: 4, samples: [] },
    { id: 'html-lang', impact: 'serious', help: 'no lang', count: 1, page: true, samples: [] },
    { id: 'link-name', impact: 'serious', help: 'links', count: 2, samples: [] }];
  const r = basics.run({}, { collected: { rules, errors: [], stats: { images: 20, links: 0, formFields: 1, buttons: 1 } }, results: {} });
  const img = r.findings.find((f) => f.id === 'image-alt');
  assert.equal(img.count, 4);
  assert.equal(img.of, 20);
  assert.equal(img.unit, 'images');
  assert.ok(!('count' in r.findings.find((f) => f.id === 'html-lang')));
  const link = r.findings.find((f) => f.id === 'link-name');
  assert.equal(link.count, 2);
  assert.ok(!('of' in link), 'no links and no focusables: count only');
  assert.equal(link.unit, 'links');
});

test('a11y-basics collect marks flag() rules as page-level', () => {
  assert.match(String(basics.collect), /rules\.push\(\{ id, impact, help, count: 1, page: true, samples \}\)/);
});
