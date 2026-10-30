import { test } from 'node:test';
import assert from 'node:assert/strict';
import axe from '../extension/plugins/axe.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';
import { h } from '../extension/ui/render.js';

const blank = () => createReading({ entries: [], target: makeTarget('https://s.test/', 'S', 'https://s.test/') });
/** A plugin's output as the saved reading keeps it (through normalize). */
const normalize = async (out) => {
  const reading = blank();
  await runPlugins(reading, [{ id: 'n', name: 'N', phase: 'analyze', run: async () => out }], {});
  return reading.log._harplus.plugins.n;
};

const rule = (over = {}) => ({
  id: 'image-alt', impact: 'critical', help: 'Images must have alternative text', helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt',
  tags: ['wcag2a', 'wcag111'], nodes: 3,
  samples: [{ target: 'img.a', html: '<img class="a" src="a.png">', summary: 'Fix any of the following' }],
  targets: ['img.a', 'img.b', 'img.c'], ...over,
});
const run = (c) => axe.run({}, { collected: { engine: '4.10.0', passes: 7, passedIds: [], incomplete: [], violations: [], population: {}, ...c } });

test('violations: places name every target, the sampled ones with their markup; evidence stays the samples', () => {
  const f = run({ violations: [rule()] }).findings[0];
  assert.equal(f.evidence, 'img.a');
  assert.deepEqual(f.places, [{ selector: 'img.a', note: '<img class="a" src="a.png">' }, { selector: 'img.b' }, { selector: 'img.c' }]);
});

test('needs review: places too; a reading without targets falls back to the samples', () => {
  const inc = rule({ id: 'color-contrast', targets: undefined, samples: [{ target: '.x', html: '<p>', summary: '' }, { target: '.y', html: '', summary: '' }] });
  const f = run({ incomplete: [inc] }).findings[0];
  assert.equal(f.id, 'review:color-contrast');
  assert.equal(f.evidence, '.x\n.y');
  assert.deepEqual(f.places, [{ selector: '.x', note: '<p>' }, { selector: '.y' }]);
});

test('odd values: a very long selector and markup survive normalize capped at 500 characters, escaped when drawn', async () => {
  const long = `div > ${'span.deep > '.repeat(80)}a`;
  const out = run({ violations: [rule({ targets: [long], samples: [{ target: long, html: '<a onclick="x()">&lt;b&gt;</a>', summary: '' }] })] });
  const saved = await normalize(out);
  const [p] = saved.findings[0].places;
  assert.equal(p.selector.length, 500);
  assert.equal(p.note, '<a onclick="x()">&lt;b&gt;</a>');
  assert.equal(saved.findings[0].evidence, long, 'evidence kept whole');
  const drawn = String(h.places(saved.findings[0].places));
  assert.doesNotMatch(drawn, /<a onclick/);
  assert.match(drawn, /&lt;a onclick=&quot;x\(\)&quot;&gt;/);
});

test('render: the answer first, severity with its word, rule pages linked, no counts repeated from the glance', () => {
  const out = run({ violations: [rule(), rule({ id: 'region', impact: 'moderate', help: 'Content in landmarks', tags: ['best-practice'], nodes: 12 })], incomplete: [rule({ id: 'color-contrast' })] });
  const s = String(axe.render(out, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<table'), 'stats before the tables');
  assert.match(s, /Violated rules<\/span><div class="stat-value">2/);
  assert.match(s, /Elements<\/span><div class="stat-value">15/);
  assert.match(s, /Passed rules<\/span><div class="stat-value">7/);
  assert.match(s, /<span class="sev" data-sev="high"><span class="sev-ico" aria-hidden="true"><\/span>High<\/span>/);
  assert.match(s, /<span class="sev" data-sev="low"><span class="sev-ico" aria-hidden="true"><\/span>Low<\/span>/, 'best-practice only is low, as its finding');
  assert.match(s, /href="https:\/\/dequeuniversity\.com\/rules\/axe\/4\.10\/image-alt"[^>]*>Images must have alternative text<\/a> <code>image-alt<\/code>/);
  assert.doesNotMatch(s.slice(0, s.indexOf('Needs review')), /<th scope="col">Elements<\/th>/, 'the violations table has no elements column');
  assert.match(s.slice(s.indexOf('Needs review')), /<th scope="col">Elements<\/th>/, 'needs review keeps its counts (the glance has none)');
  assert.match(s, /Needs review[\s\S]*<code>img\.a<\/code> <code>&lt;img/);
  assert.match(String(axe.render({ data: { violations: [], incomplete: [] } }, h)), /No violations\./);
});

test('glance: says when it shows only the top 8 rules', () => {
  const many = Array.from({ length: 10 }, (_, i) => rule({ id: `r${i}`, help: `Rule ${i}`, nodes: i + 1 }));
  assert.match(String(axe.glance({ data: { violations: many, passes: 3, incomplete: [] } }, h)), /top 8 of 10 rules · 3 rules passed · 0 need review/);
  assert.doesNotMatch(String(axe.glance({ data: { violations: many.slice(0, 2), passes: 3, incomplete: [] } }, h)), /top 8/);
});

test('headline reads on its own', () => {
  const s = run({ violations: [rule()] }).summary.find((x) => x.headline);
  assert.equal(`${s.label} ${s.value}`, 'Violations 1 rules · 3 elements');
});
