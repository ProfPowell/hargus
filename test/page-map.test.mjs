import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarks, placeMarks, markSelectors, markDetails, PRIORITY, CATEGORIES, MAX_MARKS } from '../extension/core/page-map.js';
import plugin from '../extension/plugins/a11y-map.js';

const box = (x, y, w = 10, h = 10) => ({ x, y, w, h });
const mk = (category, b = box(0, 0), over = {}) => ({ category, label: category, ruleId: category, box: b, ...over });
const SHOT = { cssWidth: 1000, cssHeight: 4000, docWidth: 1000, docHeight: 4000 };
const DOC = { w: 1000, h: 4000 };

test('placeMarks: percentage maths on a 1000×4000 shot', () => {
  const r = placeMarks([mk('error', box(100, 2000, 50, 400))], SHOT, DOC);
  assert.equal(r.placed.length, 1);
  const p = r.placed[0];
  assert.equal(p.left, 10);
  assert.equal(p.top, 50);
  assert.equal(p.width, 5);
  assert.equal(p.height, 10);
  assert.equal(r.beyond, 0);
  assert.equal(r.dropped, 0);
  assert.equal(r.mismatch, false);
});

test('placeMarks: a box beyond the clip box is counted in beyond, a box straddling the edge is clamped', () => {
  const r = placeMarks([mk('error', box(10, 4100)), mk('alert', box(1200, 10)), mk('feature', box(990, 3990, 40, 40))], SHOT, DOC);
  assert.equal(r.beyond, 2);
  assert.equal(r.placed.length, 1);
  assert.equal(r.placed[0].left, 99);
  assert.equal(r.placed[0].width, 1, 'clamped to the clip box');
  assert.equal(r.placed[0].height, 0.25);
});

test('placeMarks: the 2% mismatch flag compares document sizes, not the clip box (Review Focus 1)', () => {
  const tall = { ...SHOT, cssHeight: 20000, docHeight: 30000 }; // truncated shot: clip box smaller than the document
  assert.equal(placeMarks([mk('error')], tall, { w: 1000, h: 30000 }).mismatch, false, 'same document, truncated shot');
  assert.equal(placeMarks([mk('error')], SHOT, { w: 1000, h: 4080 }).mismatch, false, 'exactly 2% is not a mismatch');
  const m = placeMarks([mk('error'), mk('keyboard', box(0, 0), { n: 1 })], SHOT, { w: 1000, h: 4100 });
  assert.equal(m.mismatch, true, '2.5% taller');
  assert.equal(m.placed.length, 2, 'under 10%: every mark kept, with a note');
  assert.equal(placeMarks([mk('error')], SHOT, { w: 1030, h: 4000 }).mismatch, true, 'width counts too');
  const big = placeMarks([mk('error'), mk('feature'), mk('keyboard', box(0, 0), { n: 1 }), mk('structure')], SHOT, { w: 1000, h: 5000 });
  assert.equal(big.mismatch, true);
  assert.deepEqual(big.placed.map((p) => p.category).sort(), ['keyboard', 'structure'], '10% or more: only keyboard and structure');
  assert.equal(big.withheld, 2);
  // A viewport shot records no document size: no mismatch check.
  assert.equal(placeMarks([mk('error')], { cssWidth: 1280, cssHeight: 800 }, { w: 1280, h: 9000 }).mismatch, false);
});

test('placeMarks: over the cap keeps by priority error > contrast > alert > aria > keyboard > feature > structure', () => {
  assert.deepEqual(PRIORITY, ['error', 'contrast', 'alert', 'aria', 'keyboard', 'feature', 'structure']);
  assert.equal(MAX_MARKS, 400);
  const marks = [];
  for (let i = 0; i < 300; i++) marks.push(mk('structure', box(i, i)));
  for (let i = 0; i < 100; i++) marks.push(mk('feature', box(i, i + 1)));
  for (let i = 0; i < 50; i++) marks.push(mk('keyboard', box(i, i + 2), { n: i + 1 }));
  for (let i = 0; i < 150; i++) marks.push(mk('alert', box(i, i + 3)));
  for (let i = 0; i < 120; i++) marks.push(mk('error', box(i, i + 4)));
  for (let i = 0; i < 20; i++) marks.push(mk('contrast', box(i, i + 5)));
  const r = placeMarks(marks, SHOT, DOC);
  assert.equal(r.placed.length, 400);
  assert.equal(r.dropped, 340);
  const by = (c) => r.placed.filter((p) => p.category === c).length;
  assert.deepEqual([by('error'), by('contrast'), by('alert'), by('keyboard'), by('feature'), by('structure')], [120, 20, 150, 50, 60, 0]);
  assert.equal(placeMarks(marks, SHOT, DOC, 10).placed.every((p) => p.category === 'error'), true);
});

test('placeMarks: marks on the same box get successive slots; output has no NaN; empty input', () => {
  const r = placeMarks([mk('error', box(5, 5)), mk('alert', box(5, 5)), mk('error', box(50, 5))], SHOT, DOC);
  const slots = r.placed.filter((p) => p.box.x === 5).map((p) => p.slot).sort();
  assert.deepEqual(slots, [0, 1]);
  assert.doesNotMatch(JSON.stringify(r), /NaN|null|Infinity/);
  assert.deepEqual(placeMarks([], SHOT, DOC), { placed: [], beyond: 0, dropped: 0, withheld: 0, mismatch: false });
  assert.equal(placeMarks([mk('error', { x: NaN, y: 0, w: 1, h: 1 })], SHOT, DOC).placed.length, 0, 'an unusable box is skipped');
  assert.equal(placeMarks([mk('error')], { cssWidth: 0, cssHeight: 0 }, DOC).placed.length, 0, 'no frame, nothing placed');
});

test('buildMarks: category mapping', () => {
  const boxes = new Map([['#a', box(1, 1)], ['#b', box(2, 2)], ['#c', box(3, 3)], ['#d', box(4, 4)], ['#e', box(5, 5)], ['#f', box(6, 6)], ['h1', box(7, 7)], ['nav', box(8, 8)], ['#g', box(9, 9)]]);
  const marks = buildMarks({
    violations: [
      { id: 'image-alt', help: 'Images must have alternate text', helpUrl: 'https://x/image-alt', targets: ['#a'] },
      { id: 'color-contrast', help: 'Elements must meet contrast', targets: ['#b'] },
      { id: 'aria-valid-attr', help: 'ARIA attributes must be valid', targets: ['#c', '#missing'] },
    ],
    incomplete: [{ id: 'color-contrast', help: 'Elements must meet contrast', targets: ['#d'] }],
    heuristics: [
      { source: 'a11y-basics', id: 'input-label', title: 'Form fields without a label', severity: 'high', sels: ['#e'] },
      { source: 'a11y-structure', id: 'http-links', title: '1 link uses plain HTTP', severity: 'low', sels: ['#f'] },
      { source: 'a11y-structure', id: 'aria-refs', title: 'ARIA reference', severity: 'low', sels: ['#g'] },
    ],
    contrast: [{ fg: '#777777', bg: '#ffffff', ratio: 4.48, large: false, pass: false, samples: ['#a'] }],
    images: [
      { sel: 'img.ok', box: box(10, 10), alt: 'Trail at dawn', name: 'Trail at dawn', verdict: 'ok' },
      { sel: 'img.dec', box: box(11, 11), alt: '', name: '', verdict: 'empty-decorative' },
      { sel: 'img.miss', box: box(12, 12), alt: null, name: '', verdict: 'missing' },
      { sel: 'img.sus', box: box(13, 13), alt: 'image of a tent', name: 'image of a tent', verdict: 'suspicious' },
    ],
    headings: [{ level: 1, text: 'Gear', selector: 'h1' }],
    landmarks: [{ role: 'navigation', label: 'Main', sel: 'nav' }],
    keyboard: { stops: [{ sel: 'a.one', role: 'link', name: 'One', box: box(20, 20) }, { none: true }, { sel: 'a.two', role: 'link', name: 'Two', box: box(30, 30) }] },
    boxes,
  });
  const cat = (ruleId) => marks.filter((m) => m.ruleId === ruleId).map((m) => m.category);
  assert.deepEqual(cat('image-alt'), ['error']);
  assert.deepEqual(cat('color-contrast'), ['contrast', 'alert'], 'violation → contrast, incomplete → alert');
  assert.deepEqual(cat('aria-valid-attr'), ['aria'], 'unresolved targets are skipped');
  assert.deepEqual(cat('input-label'), ['error'], 'a high-severity HARgus heuristic is an error');
  assert.deepEqual(cat('http-links'), ['alert']);
  assert.deepEqual(cat('aria-refs'), ['aria']);
  assert.deepEqual(cat('contrast'), ['contrast']);
  const img = (sel) => marks.find((m) => m.sel === sel);
  assert.equal(img('img.ok').category, 'feature');
  assert.equal(img('img.ok').alt, 'Trail at dawn');
  assert.equal(img('img.dec').category, 'feature');
  assert.equal(img('img.dec').alt, '');
  assert.equal(img('img.miss').category, 'error');
  assert.equal(img('img.sus').category, 'alert');
  assert.equal(img('img.sus').alt, 'image of a tent');
  assert.deepEqual(cat('heading').concat(cat('landmark')), ['structure', 'structure']);
  assert.equal(marks.find((m) => m.ruleId === 'heading').glyph, 'H1');
  const kb = marks.filter((m) => m.category === 'keyboard');
  assert.deepEqual(kb.map((m) => m.n), [1, 3], 'stop numbers match the Keyboard order table');
  assert.equal(marks.find((m) => m.ruleId === 'image-alt').ref, 'https://x/image-alt');
  for (const m of marks) assert.ok(CATEGORIES.some((c) => c.id === m.category), m.category);
});

test('buildMarks: an image already marked by axe in the same category is not marked twice; duplicates collapse', () => {
  const marks = buildMarks({
    violations: [{ id: 'image-alt', help: 'Images must have alternate text', targets: ['#a', '#a'] }],
    images: [{ sel: 'img', box: box(1, 1), alt: null, name: '', verdict: 'missing' }],
    boxes: new Map([['#a', box(1, 1)]]),
  });
  assert.equal(marks.length, 1);
  assert.equal(marks[0].ruleId, 'image-alt');
  assert.equal(marks[0].alt, null, 'the image record lends its alt state');
});

test('buildMarks: an image verdict replaces a HARgus heuristic on the same image; placed marks know how many share the box', () => {
  const marks = buildMarks({
    heuristics: [{ source: 'a11y-structure', id: 'bad-alt', title: 'unhelpful alt', severity: 'low', sels: ['img.t'] }],
    images: [{ sel: 'img.t', box: box(1, 1), alt: 'image of a tent', name: 'image of a tent', verdict: 'suspicious' }],
    violations: [{ id: 'region', help: 'Landmarks', targets: ['img.t'] }],
    boxes: new Map([['img.t', box(1, 1)]]),
  });
  assert.deepEqual(marks.map((m) => m.ruleId), ['region', 'suspicious-alt']);
  const r = placeMarks(marks, SHOT, DOC);
  assert.deepEqual(r.placed.map((p) => [p.category, p.slot, p.stack]), [['error', 0, 2], ['alert', 1, 2]]);
});

test('altLabel: alt in quotes, cut at 60; decorative; no alt; an accessible name without alt', async () => {
  const { altLabel } = await import('../extension/core/page-map.js');
  assert.equal(altLabel({ image: true, alt: 'Tent' }), '“Tent”');
  assert.equal(altLabel({ image: true, alt: 'x'.repeat(70) }).length, 62);
  assert.equal(altLabel({ image: true, alt: '' }), 'alt=""');
  assert.equal(altLabel({ image: true, alt: null }), 'no alt');
  assert.equal(altLabel({ image: true, alt: null, name: 'Home' }), 'name “Home”');
  assert.equal(altLabel({ category: 'error' }), null);
});

test('buildMarks: missing inputs give no marks and no throw', () => {
  assert.deepEqual(buildMarks({}), []);
  assert.deepEqual(buildMarks({ violations: [{ id: 'x' }], keyboard: { stops: 'nope' } }), []);
});

test('markSelectors: axe targets, heuristic evidence, contrast samples, headings and landmarks; unique, capped', () => {
  const results = {
    axe: { status: 'ok', data: { violations: [{ id: 'image-alt', targets: ['#a', '#b'] }], incomplete: [{ id: 'x', targets: ['#b', 'iframe >>> #c'] }] } },
    'a11y-basics': { status: 'ok', findings: [{ id: 'link-name', evidence: 'a.x\na.y' }] },
    'a11y-structure': { status: 'ok', findings: [{ id: 'http-links', evidence: 'a.z' }, { id: 'no-main' }], data: { headings: [{ selector: 'h1' }], landmarkList: [{ sel: 'nav' }] } },
    contrast: { status: 'ok', data: { pairs: [{ pass: false, samples: ['p.dim'] }, { pass: true, samples: ['p.apca'] }] } },
  };
  const sels = markSelectors(results);
  assert.deepEqual(sels.sort(), ['#a', '#b', 'a.x', 'a.y', 'a.z', 'h1', 'nav', 'p.dim'].sort());
  assert.deepEqual(markSelectors({}), []);
  assert.deepEqual(markSelectors({ axe: { status: 'error' } }), []);
});

test('markDetails: rule, what was found and the reference seam', () => {
  const m = { category: 'error', label: 'Images must have alternate text', ruleId: 'image-alt', sel: '#a', ref: 'https://x', detail: 'Fix any of: alt' };
  const d = markDetails(m);
  assert.equal(d.category, 'Error');
  assert.equal(d.rule, 'Images must have alternate text');
  assert.equal(d.ruleId, 'image-alt');
  assert.equal(d.found, 'Fix any of: alt');
  assert.equal(d.fix, '');
  const withRef = markDetails(m, { referenceFor: (x) => (x.ruleId === 'image-alt' ? { fix: 'Add alt.', wcag: '1.1.1' } : null) });
  assert.equal(withRef.fix, 'Add alt.');
  assert.equal(withRef.wcag, '1.1.1');
});

test('a11y-map: collect is still self-contained and collectArgs passes the selectors', () => {
  assert.doesNotMatch(plugin.collect.toString(), /\bimport\b|altVerdict|markSelectors/);
  const args = plugin.collectArgs({ results: { axe: { status: 'ok', data: { violations: [{ id: 'r', targets: ['#a'] }] } } } });
  assert.deepEqual(args.sels, ['#a']);
});

test('a11y-map run: data.marks from resolved boxes, findings unchanged', () => {
  const results = {
    axe: { status: 'ok', data: { violations: [{ id: 'image-alt', help: 'Images must have alternate text', targets: ['#a'] }], incomplete: [] } },
  };
  const reading = { log: { _harplus: { capture: { keyboard: { stops: [{ sel: 'a', role: 'link', name: 'A', box: box(5, 5) }] } } } } };
  const collected = { images: [{ sel: 'img', kind: 'img', alt: 'Fine', name: 'Fine', inLink: false, adjacentText: '', src: '/f', box: box(1, 2) }], doc: DOC, boxes: [['#a', box(3, 3)]], ambiguous: 2 };
  const r = plugin.run(reading, { collected, results });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.data.marks.map((m) => m.category).sort(), ['error', 'feature', 'keyboard']);
  assert.equal(r.data.marksAmbiguous, 2);
});

test('keyboardPath: steps between consecutive stops, jumps dashed, a stop not drawn breaks the path', async () => {
  const { keyboardPath } = await import('../extension/core/page-map.js');
  const k = (n, x, y) => ({ category: 'keyboard', n, left: x, top: y, width: 0, height: 0 });
  // frame 4000 px tall, viewport 800: 1% = 40 px
  const p = keyboardPath([k(1, 10, 1), k(2, 20, 1), k(3, 20, 30), k(4, 30, 24), k(6, 40, 25), k(7, 50, 24.9)], { frameH: 4000, viewportH: 800 });
  assert.deepEqual(p.steps, [[[10, 1], [20, 1]], [[40, 25], [50, 24.9]]], 'a small step up is not a jump');
  assert.deepEqual(p.jumps, [[[20, 1], [20, 30]], [[20, 30], [30, 24]]], '1160 px down, then 240 px back up');
  assert.deepEqual(keyboardPath([k(1, 0, 0), k(2, 0, 90)]).jumps, [], 'without a viewport height nothing is a jump');
});

test('groupMarks: one group per category and rule, in list order, with marker indexes', async () => {
  const { groupMarks } = await import('../extension/core/page-map.js');
  const r = placeMarks([mk('alert', box(0, 100), { ruleId: 'a', rule: 'Rule A' }), mk('alert', box(0, 10), { ruleId: 'b', rule: 'Rule B' }), mk('alert', box(0, 300), { ruleId: 'a', rule: 'Rule A' }), mk('error', box(0, 900))], SHOT, DOC);
  const g = groupMarks(r.placed);
  assert.deepEqual(g.map((x) => [x.category, x.ruleId, x.items.map((i) => i.index)]), [['error', 'error', [0]], ['alert', 'b', [1]], ['alert', 'a', [2, 3]]], 'a group\'s markers are numbered together');
  assert.equal(g[2].rule, 'Rule A');
});

test('per-element labels: heuristic titles lose their page-wide counts', async () => {
  const { withoutCount, ELEMENT_LABELS } = await import('../extension/core/page-map.js');
  assert.equal(withoutCount('Images without an alt attribute (3)'), 'Images without an alt attribute');
  assert.equal(withoutCount('24 keyboard stops show no visible focus change'), 'Keyboard stops show no visible focus change');
  const marks = buildMarks({
    heuristics: [{ id: 'kb-no-focus-style', title: '24 keyboard stops show no visible focus change', severity: 'medium', sels: ['#k'] }, { id: 'focus-links', title: 'Links show no visible focus indicator', severity: 'low', sels: ['#l'] }],
    boxes: new Map([['#k', box(1, 1)], ['#l', box(2, 2)]]),
  });
  assert.deepEqual(marks.map((m) => m.label), [ELEMENT_LABELS['kb-no-focus-style'], 'Links show no visible focus indicator']);
  assert.doesNotMatch(marks.map((m) => m.label).join(), /\d/);
});

test('axe collect: a target in an iframe or a shadow root reads as an outer >>> inner path', async () => {
  const { default: axePlugin } = await import('../extension/plugins/axe.js');
  const node = (target) => ({ target, html: '<x>', failureSummary: '' });
  globalThis.axe = { run: async () => ({ testEngine: { version: 't' }, passes: [], incomplete: [], violations: [{ id: 'r', impact: 'minor', help: 'h', helpUrl: '', tags: [], nodes: [node(['#a']), node(['iframe', '#b']), node([['#host', 'span']])] }] }) };
  globalThis.document = {};
  try {
    const c = await axePlugin.collect({});
    assert.deepEqual(c.violations[0].targets, ['#a', 'iframe >>> #b', '#host >>> span']);
  } finally { delete globalThis.axe; delete globalThis.document; }
});

test('structure marks resolve by the unique key when there is one; frame and shadow axe targets are counted, not resolved', async () => {
  const { nestedTargets } = await import('../extension/core/page-map.js');
  const results = {
    'a11y-structure': { status: 'ok', findings: [], data: { headings: [{ level: 2, text: 'A', selector: 'main > h2', key: 'main > h2:nth-of-type(2)' }], landmarkList: [{ role: 'navigation', sel: 'nav', key: 'header > nav' }] } },
    axe: { status: 'ok', data: { violations: [{ id: 'r', targets: ['iframe >>> #x', '#y'] }] } },
  };
  assert.deepEqual(markSelectors(results).sort(), ['#y', 'header > nav', 'main > h2:nth-of-type(2)']);
  assert.equal(nestedTargets(results), 1);
  const marks = buildMarks({ headings: results['a11y-structure'].data.headings, landmarks: results['a11y-structure'].data.landmarkList, boxes: new Map([['main > h2:nth-of-type(2)', box(1, 1)], ['header > nav', box(1, 1)]]) });
  assert.deepEqual(marks.map((m) => m.sel), ['main > h2:nth-of-type(2)', 'header > nav']);
});
