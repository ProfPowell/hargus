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

test('groups by pair; AA thresholds 4.5 normal, 3 large; one finding for all failing text', () => {
  const r = analyzeContrast({ elements: [
    el('#777777', '#ffffff'), el('#777777', '#ffffff', false, 'p.b'), // 4.48 → fail
    el('#767676', '#ffffff'), // 4.54 → pass
    el('#949494', '#ffffff', true), // 3.03 large → pass
    el('#959595', '#ffffff', true), // 2.99 large → fail
  ] });
  assert.deepEqual(titles(r), [
    'low:3 text elements fail contrast (2 colour pairs)', // 1 and 2 element pairs → low
    'info:2 colour pairs below APCA thresholds (advisory)',
  ]);
  const f = r.findings[0];
  assert.equal(f.id, 'contrast-pair');
  assert.equal(f.count, 3);
  assert.equal(f.of, 5);
  assert.equal(f.unit, 'text elements');
  assert.equal(f.detail, '#959595 on #ffffff 2.9:1 (1 element); #777777 on #ffffff 4.4:1 (2 elements)');
  assert.equal(f.evidence, 'p\np\np.b');
  const p = r.data.pairs.find((x) => x.fg === '#777777');
  assert.equal(p.count, 2);
  assert.deepEqual(p.samples, ['p', 'p.b']);
  assert.deepEqual(r.data.totals, { checked: 5, failing: 3, unknown: 0, truncated: false });
  assert.equal(r.summary[0].value, '3 of 5 text elements fail (AA)');
  assert.equal(r.summary[0].rating, 'poor');
});

test('12 failing pairs of 3 elements: one contrast-pair, count covers every failing element, evidence is the worst 10 pairs', () => {
  const els = [];
  for (let i = 0; i < 12; i++) for (let j = 0; j < 3; j++) els.push(el(`#${(0xa0 + i).toString(16).repeat(3)}`, '#ffffff', false, `p.c${i}`));
  for (let k = 0; k < 64; k++) els.push(el('#000000', '#ffffff'));
  const r = analyzeContrast({ elements: els });
  assert.equal(r.findings.filter((f) => f.id === 'contrast-pair').length, 1);
  assert.equal(r.findings.filter((f) => f.id === 'contrast-more').length, 0);
  const f = r.findings[0];
  assert.equal(f.title, '36 text elements fail contrast (12 colour pairs)');
  assert.equal(f.count, 36);
  assert.equal(f.of, 100);
  assert.equal(f.severity, 'medium', 'these pairs are 3 elements and below 4:1');
  assert.equal(f.detail.split('; ').length, 3);
  assert.equal(new Set(f.evidence.split('\n')).size, 10);
  assert.ok(f.evidence.split('\n').every((s) => /^p\.c\d+$/.test(s)));
  assert.ok(r.data.pairs.length <= 20);
});

test('1 failing element: singular title, low', () => {
  const r = analyzeContrast({ elements: [el('#777777', '#ffffff')] });
  assert.equal(r.findings[0].title, '1 text element fails contrast (1 colour pair)');
  assert.equal(r.findings[0].severity, 'low');
});

test('no failing pairs: no contrast-pair', () => {
  assert.equal(analyzeContrast({ elements: [el('#000000', '#ffffff')] }).findings.some((f) => f.id === 'contrast-pair'), false);
});

test('severity: one medium pair makes the finding medium; near misses alone stay low', () => {
  const many = (fg, k) => Array.from({ length: k }, () => el(fg, '#ffffff'));
  assert.equal(analyzeContrast({ elements: [...many('#b7b7b7', 5), ...many('#7b7b7b', 50)] }).findings[0].severity, 'medium'); // 2.01:1 and 4.23:1
  assert.equal(analyzeContrast({ elements: many('#7b7b7b', 50) }).findings[0].severity, 'low');
});

test('unknown (over images) is counted, never a failing pair; truncation recorded; bad hex ignored', () => {
  const r = analyzeContrast({ truncated: true, elements: [{ unknown: true, large: false, selector: 'h1' }, el('url(x)', '#fff'), el('#000000', '#ffffff')] });
  assert.deepEqual(titles(r), ['info:1 text elements could not be checked (over images, gradients or layered backgrounds)']);
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

test('nothing checked: no rating; value says why', () => {
  const none = analyzeContrast({ elements: [] });
  assert.equal(none.summary[0].value, 'no text found');
  assert.equal('rating' in none.summary[0], false);
  const blind = analyzeContrast({ elements: [{ unknown: true, large: false, selector: 'h1' }] });
  assert.equal(blind.summary[0].value, 'no text could be checked');
  assert.equal('rating' in blind.summary[0], false);
  assert.match(String(plugin.glance({ status: 'ok', ...blind }, h)), /1 could not be checked/);
});

test('same-colour pairs (< 1.1:1) are unknown, not failing; 1.2:1 still fails', () => {
  const r = analyzeContrast({ elements: [el('#ffffff', '#ffffff', true, 'h2.a'), el('#fefefe', '#ffffff'), el('#dddddd', '#ffffff')] });
  const t = titles(r);
  assert.ok(!r.findings.some((f) => /#ffffff on #ffffff|#fefefe on #ffffff/.test(f.detail || '')), t.join(' | '));
  assert.ok(r.findings.some((f) => f.id === 'contrast-pair' && /#dddddd on #ffffff 1\.\d:1/.test(f.detail)), t.join(' | '));
  assert.ok(t.includes('info:2 text elements could not be checked (over images, gradients or layered backgrounds)'), t.join(' | '));
  assert.equal(r.data.totals.unknown, 2);
  assert.equal(r.data.totals.checked, 1);
});

test('contrast-pair places: each sampled element with its pair and ratio; evidence unchanged', () => {
  const r = analyzeContrast({ elements: [el('#777777', '#ffffff'), el('#777777', '#ffffff', false, 'p.b'), el('#959595', '#ffffff', true, 'h2')] });
  const f = r.findings.find((x) => x.id === 'contrast-pair');
  assert.equal(f.evidence, 'h2\np\np.b');
  assert.deepEqual(f.places, [
    { selector: 'h2', note: '#959595 on #ffffff 2.9:1 (large)' },
    { selector: 'p', note: '#777777 on #ffffff 4.4:1' },
    { selector: 'p.b', note: '#777777 on #ffffff 4.4:1' },
  ]);
});

test('odd values: a long selector with "<" is a place as is, escaped when drawn', () => {
  const long = `main > ${'div.x > '.repeat(70)}p[data-x="<b>"]`;
  const f = analyzeContrast({ elements: [el('#777777', '#ffffff', false, long)] }).findings[0];
  assert.equal(f.places[0].selector, long);
  const drawn = String(h.places(f.places));
  assert.doesNotMatch(drawn, /<b>/);
  assert.match(drawn, /&lt;b&gt;/);
});

test('render: the answer first, then hex, ratio, size and samples only; glance marks carry words', () => {
  const out = analyzeContrast({ elements: [el('#777777', '#ffffff'), el('#767676', '#ffffff'), { unknown: true, selector: 'h1' }], truncated: true });
  const s = String(plugin.render({ status: 'ok', ...out }, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<table'));
  assert.match(s, /Text checked<\/span><div class="stat-value">2/);
  assert.match(s, /Fail AA<\/span><div class="stat-value">1/);
  assert.match(s, /Not checked<\/span><div class="stat-value">1<\/div><span class="stat-note">page partly checked/);
  assert.match(s, /<td>#777777 on #ffffff<\/td><td>4\.48:1<\/td><td>normal<\/td>/);
  for (const col of ['Swatch', 'APCA Lc', 'Elements', 'Result']) assert.doesNotMatch(s, new RegExp(`<th scope="col">${col}</th>`), `${col} is the glance's`);
  assert.doesNotMatch(s, /contrast-swatch/);
  const g = String(plugin.glance({ status: 'ok', ...out }, h));
  assert.match(g, /data-status="poor">fails AA/);
  assert.doesNotMatch(g, /class="icon icon-(ok|fail)"/, 'no glyph without a word');
  assert.match(String(plugin.render({ status: 'ok', ...analyzeContrast({ elements: [el('#000000', '#ffffff')] }) }, h)), /No failing colour pairs/);
});

test('rule ids: all failing pairs are one contrast-pair finding (no subject); ids are reference keys', async () => {
  const { REFERENCE } = await import('../extension/core/a11y-reference.js');
  const { assertRuleIds } = await import('./helpers.mjs');
  const r = analyzeContrast({ elements: [
    el('#777777', '#ffffff'), el('#999999', '#ffffff'), el('#3366cc', '#ccccff'), el('#aaaaaa', '#ffffff', true), // fail
    el('#000000', '#000000'), { unknown: true, selector: 'h1' }, // unknown
    el('#767676', '#ffffff'), // passes AA, below APCA
  ] });
  assert.deepEqual(r.findings.map((f) => f.id), ['contrast-pair', 'contrast-unknown', 'contrast-apca']);
  assertRuleIds(r.findings, 'contrast');
  for (const f of r.findings) {
    assert.ok(Object.hasOwn(REFERENCE, f.id), f.id);
    assert.equal(f.subject, undefined, f.id);
  }
});
