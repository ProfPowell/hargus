import { test } from 'node:test';
import assert from 'node:assert/strict';
import { altVerdict, altVerdicts } from '../extension/core/alt-verdict.js';

const img = (over = {}) => ({ kind: 'img', alt: 'A red tent', name: 'A red tent', inLink: false, adjacentText: '', src: '/a.png', ...over });
const v = (over, repeats = 1) => altVerdict(img(over), { repeats }).verdict;

test('ok', () => {
  const r = altVerdict(img(), { repeats: 1 });
  assert.equal(r.verdict, 'ok');
  assert.equal(typeof r.note, 'string');
});

test('missing: no alt and no accessible name; a name rescues it', () => {
  assert.equal(v({ alt: null, name: '' }), 'missing');
  assert.equal(v({ alt: null, name: 'Partner' }), 'ok');
});

test('empty: decorative, or linked when in a link without other text', () => {
  assert.equal(v({ alt: '', name: '' }), 'empty-decorative');
  assert.equal(v({ alt: '', name: '', inLink: true }), 'empty-linked');
  assert.equal(v({ alt: '', name: '', inLink: true, adjacentText: 'Read more' }), 'empty-decorative', 'the link has text');
});

test('suspicious: WAVE list, prefixes, suffixes, blank', () => {
  for (const alt of ['image', 'Graphic', 'PHOTO', 'spacer', 'blank', 'logo', '*', 'image of a tent', 'graphic of a tent', 'bullet', 'Company image', 'the graphic', ' ']) {
    assert.equal(v({ alt, name: alt }), 'suspicious', JSON.stringify(alt));
  }
  assert.equal(v({ alt: 'A photographer at work', name: 'x' }), 'ok');
  assert.equal(v({ alt: 'Learn more about tents', name: 'x' }), 'ok');
});

test('redundant: equal to adjacent text, or contained within 15 characters', () => {
  assert.equal(v({ alt: 'Summer Sale', adjacentText: '  summer   sale ' }), 'redundant');
  const alt = 'Summer sale';
  assert.equal(v({ alt, adjacentText: `${alt} ${'x'.repeat(14)}` }), 'redundant', '15 extra characters');
  assert.equal(v({ alt, adjacentText: `${alt} ${'x'.repeat(15)}` }), 'ok', '16 extra characters');
  assert.equal(v({ alt, adjacentText: '' }), 'ok');
});

test('long: 100 vs 101 characters', () => {
  assert.equal(v({ alt: `${'ab '.repeat(33)}a` }), 'ok', '100 characters');
  assert.equal(v({ alt: `${'ab '.repeat(33)}ab` }), 'long', '101 characters');
});

test('filename: extension or camera stem', () => {
  for (const alt of ['photo.gif', 'hero-banner.PNG', 'IMG_1234', 'DSC0001', 'dscn_00456']) assert.equal(v({ alt }), 'filename', alt);
  for (const alt of ['PXL_20240101_123456', 'Screenshot 2025-03-04 at 10.00.00', 'Screen Shot 2020-01-01', 'Screenshot 2025-01-02 at 10.11.12', 'Screen Shot 2024-03-04 at 9.05.01 AM', 'Screenshot 2025-01-02 at 10.11.12 (2)', 'image0', 'untitled', 'photo-123', '3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3']) assert.equal(v({ alt }), 'filename', alt);
  for (const alt of ['Screenshot at the beach', 'Screenshot from the launch', 'IMG 1234 Tent', 'Page 12', 'Q4-2025', 'Euro2024', 'FY2025', 'Windows2000', 'Screenshot of the dashboard', 'Image gallery']) assert.equal(v({ alt }), 'ok', alt);
});

test('repeated: the same alt on 2+ images with different src', () => {
  assert.equal(v({}, 2), 'repeated');
  assert.equal(v({}, 1), 'ok');
});

test('precedence follows the list order', () => {
  assert.equal(v({ alt: 'image', adjacentText: 'image' }, 3), 'suspicious');
  assert.equal(v({ alt: 'Tent.png', adjacentText: 'Tent.png' }, 3), 'redundant');
  assert.equal(v({ alt: `${'x'.repeat(101)}.png` }, 3), 'long');
  assert.equal(v({ alt: 'tent.png' }, 3), 'filename');
});

test('altVerdicts: repeats counts distinct srcs, case-insensitive; same src is not a repeat', () => {
  const out = altVerdicts([
    img({ alt: 'Product', name: 'Product', src: '/1.png' }),
    img({ alt: 'product', name: 'product', src: '/2.png' }),
    img({ alt: 'Logo mark', name: 'Logo mark', src: '/3.png' }),
    img({ alt: 'Logo mark', name: 'Logo mark', src: '/3.png' }),
    img({ alt: '', name: '', src: '/4.png' }),
    img({ alt: '', name: '', src: '/5.png' }),
  ]);
  assert.deepEqual(out.map((x) => x.verdict), ['repeated', 'repeated', 'ok', 'ok', 'empty-decorative', 'empty-decorative']);
  assert.ok(out.every((x) => typeof x.note === 'string'));
  assert.equal(out[0].src, '/1.png', 'keeps the input fields');
});
