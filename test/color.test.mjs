import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRgb, composite, toHex, relLum, wcagRatio, apcaLc } from '../extension/core/color.js';

test('parseRgb: hex, rgb(), rgba() with comma or slash syntax', () => {
  assert.deepEqual(parseRgb('#ff8000'), { r: 255, g: 128, b: 0, a: 1 });
  assert.deepEqual(parseRgb('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseRgb('rgba(1, 2, 3, 0.5)'), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.deepEqual(parseRgb('rgb(1 2 3 / 50%)'), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.equal(parseRgb('oklch(50% 0.1 20)'), null);
  assert.equal(parseRgb(''), null);
});

test('composite and hex', () => {
  assert.deepEqual(composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 }), { r: 128, g: 128, b: 128, a: 1 });
  assert.equal(toHex({ r: 153, g: 153, b: 153 }), '#999999');
  assert.equal(toHex({ r: 300, g: -4, b: 15.6 }), '#ff0010');
});

test('WCAG 2 ratios (reference values)', () => {
  const w = parseRgb('#ffffff');
  assert.equal(relLum(w).toFixed(3), '1.000');
  assert.equal(wcagRatio(parseRgb('#000000'), w).toFixed(2), '21.00');
  assert.equal(wcagRatio(parseRgb('#777777'), w).toFixed(2), '4.48');
  assert.equal(wcagRatio(parseRgb('#767676'), w).toFixed(2), '4.54');
  assert.equal(wcagRatio(w, parseRgb('#767676')).toFixed(2), '4.54', 'order-independent');
});

test('APCA-W3 Lc (reference values ±1)', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) <= 1, `${a} ≈ ${b}`);
  near(apcaLc(parseRgb('#000000'), parseRgb('#ffffff')), 106.04);
  near(apcaLc(parseRgb('#ffffff'), parseRgb('#000000')), -107.88);
  near(apcaLc(parseRgb('#888888'), parseRgb('#ffffff')), 63.06);
  assert.equal(apcaLc(parseRgb('#777777'), parseRgb('#777777')), 0);
});
