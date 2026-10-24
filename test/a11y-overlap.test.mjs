import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OVERLAP, suppressedBy } from '../extension/core/a11y-overlap.js';
import axe from '../extension/plugins/axe.js';
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
  assert.equal(suppressedBy('a11y-structure', 'headings-skipped', okAxe({ passedIds: ['heading-order'] })), null, 'keep row');
  assert.equal(suppressedBy('a11y-basics', 'nope', okAxe()), null);
});

test('table: required suppress rows exist; keep rows for partial overlaps', () => {
  const mode = (k) => OVERLAP.find((o) => o.ours === k)?.mode;
  for (const k of ['a11y-basics:image-alt', 'a11y-basics:input-label', 'a11y-basics:html-lang', 'a11y-structure:headings-empty',
    'a11y-basics:link-name', 'a11y-basics:button-name', 'a11y-basics:duplicate-id']) assert.equal(mode(k), 'suppress', k);
  for (const k of ['a11y-structure:headings-skipped', 'a11y-structure:focus-jumps', 'a11y-structure:targets-24']) assert.equal(mode(k), 'keep', k);
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
