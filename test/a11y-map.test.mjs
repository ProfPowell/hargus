import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../extension/plugins/a11y-map.js';
import { OVERLAP, suppressedBy } from '../extension/core/a11y-overlap.js';
import { getPlugins } from '../extension/plugins/index.js';
import { cropThumb } from '../extension/ui/report.js';
import { h } from '../extension/ui/render.js';

const im = (over = {}) => ({ sel: 'img', kind: 'img', alt: 'A red tent', name: 'A red tent', inLink: false, adjacentText: '', src: '/a.png', box: { x: 0, y: 0, w: 10, h: 10 }, ...over });
const run = (images, extra = {}, axe) => plugin.run({ log: { _harplus: {} } }, { collected: { images, doc: { w: 1000, h: 4000 }, ...extra }, results: { axe } });
const titles = (r) => r.findings.map((f) => `${f.severity}:${f.title}`);

test('registered first among the accessibility plugins; page phase, isolated, after the others', () => {
  const ids = getPlugins().map((p) => p.id);
  assert.ok(ids.includes('a11y-map'));
  assert.ok(ids.indexOf('a11y-map') < ids.indexOf('a11y-basics'));
  assert.equal(plugin.phase, 'page');
  assert.equal(plugin.area, 'accessibility');
  assert.deepEqual(plugin.after, ['axe', 'a11y-basics', 'a11y-structure', 'contrast']);
  assert.equal(plugin.world, undefined);
});

test('collect is self-contained (serialisable)', () => {
  assert.doesNotMatch(plugin.collect.toString(), /\bimport\b|altVerdict/);
});

test('findings: exact titles and severities', () => {
  const r = run([
    im({ kind: 'svg', alt: null, name: '', src: '/1' }), im({ kind: 'area', alt: null, name: '', src: '/2' }),
    im({ alt: '', name: '', inLink: true, src: '/3' }),
    im({ alt: 'image', name: 'image', src: '/4' }), im({ alt: 'graphic', name: 'graphic', src: '/5' }),
    im({ alt: 'Sale', name: 'Sale', adjacentText: 'Sale', src: '/6' }),
    im({ alt: 'x'.repeat(101), name: 'x', src: '/7' }),
    im({ alt: 'IMG_1234', name: 'x', src: '/8' }),
    im({ alt: 'Fine', name: 'Fine', src: '/9' }),
  ]);
  assert.deepEqual(titles(r), [
    'medium:2 image-like elements have no accessible name',
    'medium:1 linked image has empty alt',
    'low:2 images have suspicious alt text',
    'low:1 image repeats nearby text in its alt',
    'low:1 alt text is longer than 100 characters',
    'low:1 alt text looks like a file name',
  ]);
  assert.equal(r.data.images.length, 9);
  assert.equal(r.data.images[0].verdict, 'missing');
});

test('render: elements without an alt attribute show their name labelled, not as alt', () => {
  const out = String(plugin.render(run([im({ kind: 'svg', alt: null, name: 'Partner' })]), h, {}));
  assert.match(out, /<em>name:<\/em> “Partner”/);
});

test('clean page: no findings', () => assert.deepEqual(titles(run([im()])), []));

test('an <img> without alt is a11y-basics\' finding: with axe absent there is exactly one no-alt finding', () => {
  assert.deepEqual(titles(run([im({ alt: null, name: '' })], {}, undefined)), []);
  assert.equal(run([im({ alt: null, name: '' })]).data.images[0].verdict, 'missing', 'the panel still shows it');
});

test('image-like elements without a name yield to the axe rule for their kind', () => {
  const svg = im({ kind: 'svg', alt: null, name: '' });
  assert.equal(OVERLAP.find((o) => o.ours === 'a11y-map:no-name-svg').mode, 'suppress');
  const axe = { status: 'ok', data: { violations: [], incomplete: [], passedIds: ['svg-img-alt'] } };
  assert.deepEqual(titles(run([svg], {}, axe)), []);
  assert.ok(suppressedBy('a11y-map', 'no-name-svg', axe));
  assert.deepEqual(titles(run([svg], {}, { status: 'error' })), ['medium:1 image-like element has no accessible name']);
  assert.deepEqual(titles(run([svg, im({ kind: 'area', alt: null, name: '' })], {}, axe)), ['medium:1 image-like element has no accessible name']);
});

test('render: table with quoted alt, chips, escaping, filter summary', () => {
  const r = run([im({ alt: '<b>Sale</b> “50%”', name: 'x', src: '/s' }), im({ alt: null, name: '', src: '/m' }), im({ alt: '', name: '', src: '/e' }), im({ src: '/ok' })]);
  const out = String(plugin.render(r, h, { crop: { style: '', thumb: () => h.raw('<span class="crop"></span>') } }));
  assert.match(out, /&lt;b&gt;Sale&lt;\/b&gt; “50%”/);
  assert.doesNotMatch(out, /<b>Sale<\/b>/);
  assert.match(out, /no alt/);
  assert.match(out, /empty \(decorative\)/);
  assert.match(out, /Images &amp; alt text/);
  assert.match(out, /2 ok · 1 missing · 1 decorative/);
  assert.match(out, /<span class="crop">/);
});

test('render: cap note at 1,000, and without a screenshot there are no thumbnails', () => {
  const r = run([im()], { imagesTruncated: 37 });
  const out = String(plugin.render(r, h, {}));
  assert.doesNotMatch(out, /Thumbnail/, 'no thumbnail column without a screenshot');
  assert.match(out, /37 more images not listed/);
  assert.doesNotMatch(out, /class="crop"/);
  assert.match(out, /A red tent/);
});

const shot = (over = {}) => ({ kind: 'fullpage', mimeType: 'image/webp', data: 'QUJD', cssWidth: 1000, cssHeight: 4000, scale: 0.5, ...over });
const reading = (shots) => ({ log: { _harplus: { capture: { device: 'desktop' }, screenshots: shots } } });

test('cropThumb: placement maths on a 1000x4000 shot at scale 0.5', () => {
  const out = String(cropThumb(reading([shot()]), { x: 100, y: 200, w: 50, h: 50 }));
  const k = 96 / 50;
  assert.match(out, /^<span class="crop"/);
  assert.match(out, /background-image:url\(data:image\/webp;base64,QUJD\)/);
  assert.ok(out.includes(`background-size:${1000 * k}px ${4000 * k}px`), out);
  assert.ok(out.includes(`background-position:-${100 * k}px -${200 * k}px`), out);
  assert.match(out, /width:96px;height:96px/);
});

test('cropThumb: non-square boxes keep their aspect; outside the shot gives a placeholder', () => {
  assert.match(String(cropThumb(reading([shot()]), { x: 0, y: 0, w: 200, h: 100 })), /width:96px;height:48px/);
  const out = String(cropThumb(reading([shot({ truncated: true })]), { x: 10, y: 5000, w: 50, h: 50 }));
  assert.match(out, /not in screenshot/);
  assert.doesNotMatch(out, /background-image/);
  assert.match(String(cropThumb(reading([]), { x: 0, y: 0, w: 5, h: 5 })), /not in screenshot/);
  assert.match(String(cropThumb(reading([shot()]), { x: 0, y: 0, w: 0, h: 0 })), /not in screenshot/);
});
