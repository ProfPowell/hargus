import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { analyzeContrast } from '../extension/plugins/contrast.js';
import { getPlugins } from '../extension/plugins/index.js';
import { h } from '../extension/ui/render.js';

const el = (fg, bg, large = false, selector = 'p') => ({ fg, bg, large, selector });
const titles = (r) => r.findings.map((f) => `${f.severity}:${f.title}`);

test('registered after a11y-basics as an Accessibility page plugin', () => {
  const ids = getPlugins().map((p) => p.id);
  assert.equal(ids.indexOf('contrast'), ids.indexOf('a11y-basics') + 1);
  assert.equal(plugin.phase, 'page');
  assert.equal(plugin.area, 'accessibility');
});

test('groups by pair; AA thresholds 4.5 normal, 3 large', () => {
  const r = analyzeContrast({ elements: [
    el('#777777', '#ffffff'), el('#777777', '#ffffff', false, 'p.b'), // 4.48 → fail
    el('#767676', '#ffffff'), // 4.54 → pass
    el('#949494', '#ffffff', true), // 3.03 large → pass
    el('#959595', '#ffffff', true), // 2.99 large → fail
  ] });
  assert.deepEqual(titles(r), [
    'medium:Text contrast 2.9:1 (#959595 on #ffffff) — 1 elements',
    'medium:Text contrast 4.4:1 (#777777 on #ffffff) — 2 elements',
    'info:2 colour pairs below APCA thresholds (advisory)',
  ]);
  const p = r.data.pairs.find((x) => x.fg === '#777777');
  assert.equal(p.count, 2);
  assert.deepEqual(p.samples, ['p', 'p.b']);
  assert.deepEqual(r.data.totals, { checked: 5, failing: 3, unknown: 0, truncated: false });
  assert.equal(r.summary[0].value, '3 of 5 text elements fail (AA)');
  assert.equal(r.summary[0].rating, 'poor');
});

test('ten worst pairs as findings, then "…and N more"', () => {
  const els = Array.from({ length: 13 }, (_, i) => el(`#${(0xa0 + i).toString(16).repeat(3)}`, '#ffffff'));
  const r = analyzeContrast({ elements: els });
  assert.equal(r.findings.filter((f) => f.title.startsWith('Text contrast')).length, 10);
  assert.ok(titles(r).includes('medium:…and 3 more failing colour pairs'));
  assert.match(r.findings[0].title, /#acacac/, 'worst (lowest ratio, ~2.27) first');
  assert.ok(r.data.pairs.length <= 20);
});

test('unknown (over images) is counted, never a failing pair; truncation recorded; bad hex ignored', () => {
  const r = analyzeContrast({ truncated: true, elements: [{ unknown: true, large: false, selector: 'h1' }, el('url(x)', '#fff'), el('#000000', '#ffffff')] });
  assert.deepEqual(titles(r), ['info:1 text elements over images could not be checked']);
  assert.deepEqual(r.data.totals, { checked: 1, failing: 0, unknown: 1, truncated: true });
  assert.equal(r.summary[0].rating, 'good');
});

test('run() skips without collected data; glance/render escape and only use #rrggbb', () => {
  assert.throws(() => plugin.run({}, { collected: undefined, skip: (m) => { throw new Error(m); } }), /no page data/);
  const out = plugin.run({}, { collected: { elements: [el('#777777', '#ffffff')] }, skip: () => {} });
  const html = String(plugin.glance({ status: 'ok', ...out }, h)) + String(plugin.render({ status: 'ok', ...out }, h));
  assert.match(html, /background:#ffffff/);
  assert.doesNotMatch(html, /NaN|undefined/);
});

test('glance shows the truncation note even with nothing over images', () => {
  const out = analyzeContrast({ truncated: true, elements: [el('#000000', '#ffffff')] });
  assert.match(String(plugin.glance({ status: 'ok', ...out }, h)), /partly checked/);
  const full = analyzeContrast({ elements: [el('#000000', '#ffffff')] });
  assert.doesNotMatch(String(plugin.glance({ status: 'ok', ...full }, h)), /partly checked/);
});
