import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageStats, visionCheck } from '../extension/core/view-checks.js';

const W = 128, H = 80;
const img = (fn) => { const a = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b] = fn(x, y); const i = (y * W + x) * 4; a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = 255; } return a; };
const halves = img((x) => (x < W / 2 ? [230, 20, 20] : [20, 170, 20]));            // red | green
const grey = img((x) => { const v = x < W / 2 ? 90 : 160; return [v, v, v]; });
const stripes = img((x) => ((x >> 2) % 2 ? [255, 255, 255] : [0, 0, 0]));          // sharp edges
const smooth = img((x) => { const v = Math.round(127 + 60 * Math.sin(x / 9)); return [v, v, v]; });
const narrow = img((x) => { const v = 120 + (x % 20); return [v, v, v]; });
const st = (a) => imageStats(a, W, H);

test('saturation: colour high, grey zero', () => {
  assert.ok(st(halves).sat > 0.5);
  assert.equal(st(grey).sat, 0);
});

test('edge energy: stripes sharp, smooth low', () => {
  assert.ok(st(stripes).edge > 3 * st(smooth).edge);
});

test('luminance spread: p95 - p5', () => {
  assert.ok(st(stripes).spread > 200);
  assert.ok(st(narrow).spread < 25);
});

test('achromatopsia: ≤ 0.03 passes, colour fails', () => {
  assert.equal(visionCheck('achromatopsia', st(grey), st(halves)).ok, true);
  const f = visionCheck('achromatopsia', st(halves), st(halves));
  assert.equal(f.ok, false);
  assert.match(f.detail, /saturation/);
});

test('protanopia: a colour shift passes; an identical image fails (Review Focus 3)', () => {
  const shifted = img((x) => (x < W / 2 ? [150, 140, 30] : [150, 140, 30]));
  assert.equal(visionCheck('protanopia', st(shifted), st(halves)).ok, true);
  assert.equal(visionCheck('protanopia', st(halves), st(halves)).ok, false);
});

test('blurred: edge ≤ 0.6 × reference; lowcontrast: spread ≤ 0.8 × reference', () => {
  assert.equal(visionCheck('blurred', st(smooth), st(stripes)).ok, true);
  assert.equal(visionCheck('blurred', st(stripes), st(stripes)).ok, false);
  assert.equal(visionCheck('lowcontrast', st(narrow), st(stripes)).ok, true);
  assert.equal(visionCheck('lowcontrast', st(stripes), st(stripes)).ok, false);
});

test('an already-grey page: colour checks pass with the explanation (Review Focus 4)', () => {
  for (const v of ['achromatopsia', 'protanopia', 'deuteranopia', 'tritanopia']) {
    const r = visionCheck(v, st(grey), st(grey));
    assert.deepEqual(r, { ok: true, detail: 'page has no colour to change' });
  }
});

test('missing stats → ok with an "unmeasured" detail, never a throw', () => {
  assert.deepEqual(visionCheck('blurred', null, st(stripes)), { ok: true, detail: 'not measured' });
});
