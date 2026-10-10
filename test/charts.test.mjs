import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html, raw, esc, isRaw } from '../extension/ui/html.js';
import * as render from '../extension/ui/render.js';

test('html tag escapes values and passes raw through', () => {
  const out = html`<p title="${'"x"'}">${'<b>'}${raw('<i>ok</i>')}${['a', '&']}${null}${false}${0}</p>`;
  assert.ok(isRaw(out));
  assert.equal(String(out), '<p title="&quot;x&quot;">&lt;b&gt;<i>ok</i>a&amp;0</p>');
  assert.equal(esc("'"), '&#39;');
});

test('render.js re-exports the html helpers', () => {
  assert.equal(render.html, html);
  assert.equal(render.raw, raw);
  assert.equal(render.esc, esc);
});

import { textWidth, fitFont, RING, DONUT, innerDiameter, ring, donut, legend, foldSegments, safeColor } from '../extension/ui/charts.js';

test('ring labels fit inside 80% of the inner diameter', () => {
  for (const text of ['7', '57', '100']) {
    const fs = fitFont(text, innerDiameter(RING), 13);
    assert.ok(textWidth(text, fs) <= 0.8 * innerDiameter(RING) + 1e-9, `${text} at ${fs}`);
  }
  const fs = fitFont('1,284', innerDiameter(DONUT), 9);
  assert.ok(textWidth('1,284', fs) <= 0.8 * innerDiameter(DONUT) + 1e-9);
  assert.ok(fitFont('7', innerDiameter(RING), 13) === 13, 'short labels keep the base size');
});

test('ring markup: progress, label, status, not measured', () => {
  const s = String(ring({ value: 57, status: 'serious', label: 'Accessibility' }));
  assert.match(s, /role="img"/);
  assert.match(s, /aria-label="Accessibility: 57 of 100"/);
  assert.match(s, /stroke="var\(--st-serious\)"/);
  assert.match(s, /stroke-dasharray="57 100"/);
  assert.match(s, />57<\/text>/);
  const none = String(ring({ value: null, label: 'Security' }));
  assert.match(none, /aria-label="Security: not measured"/);
  assert.match(none, />—<\/text>/);
  assert.doesNotMatch(none, /stroke-dasharray/);
  assert.doesNotMatch(String(ring({ value: 80, showValue: false })), /<text/);
  assert.match(String(ring({ value: 50, status: 'bogus"><script>' })), /var\(--st-none\)/);
  assert.match(String(ring({ value: 1, label: '<b>' })), /&lt;b&gt;/);
});

test('donut folds small segments, labels centre, empty is blank', () => {
  const segs = 'abcdefgh'.split('').map((l, i) => ({ label: l, value: 10 - i }));
  const folded = foldSegments(segs);
  assert.equal(folded.length, 6);
  assert.deepEqual(folded.map((s) => s.label), ['a', 'b', 'c', 'd', 'e', 'Other']);
  assert.equal(folded[5].value, 5 + 4 + 3);
  const s = String(donut({ segments: segs, center: { value: '2.4', unit: 'MB' }, label: 'Page weight' }));
  assert.match(s, /aria-label="Page weight: a 10, b 9/);
  assert.match(s, />2\.4<\/text>/);
  assert.match(s, /class="unit"[^>]*>MB<\/text>/);
  assert.match(s, /<ul class="legend">/);
  assert.equal(donut({ segments: [{ label: 'x', value: 0 }] }), '');
});

test('legend escapes labels and rejects unsafe colours', () => {
  const s = String(legend([{ label: '<x>', value: 3, color: 'red;background:url(x)' }, { label: 'ok', color: 'var(--c2)' }]));
  assert.match(s, /&lt;x&gt;/);
  assert.match(s, /background:var\(--c-other\)/);
  assert.match(s, /background:var\(--c2\)/);
  assert.equal(safeColor('#abc'), '#abc');
  assert.equal(legend([]), '');
});
