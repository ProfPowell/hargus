import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REFERENCE, WCAG, referenceFor, referenceForMark, wcagFromTags, wcagLink, wcagLabel } from '../extension/core/a11y-reference.js';
import { OVERLAP, suppressedBy } from '../extension/core/a11y-overlap.js';
import { analyzeStructure } from '../extension/plugins/a11y-structure.js';
import basics from '../extension/plugins/a11y-basics.js';
import { markDetails, buildMarks } from '../extension/core/page-map.js';
import { KIND_LABELS } from '../extension/core/focus.js';

const src = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const idsIn = (text, re) => [...text.matchAll(re)].map((m) => m[1]);

test('every finding id the accessibility plugins can emit has a reference entry', () => {
  const ids = new Set([
    ...idsIn(src('plugins/a11y-basics.js'), /\b(?:check|flag)\('([a-z0-9-]+)'/g),
    ...idsIn(src('plugins/a11y-structure.js'), /\badd\('([a-z0-9-]+)'/g),
    ...idsIn(src('core/keyboard.js'), /\badd\('([a-z0-9-]+)'/g),
    ...idsIn(src('plugins/a11y-map.js'), /\badd\('([a-z0-9-]+)'/g),
    ...idsIn(src('plugins/a11y-views.js'), /\badd\('([a-z0-9-]+)'/g),
    ...idsIn(src('plugins/contrast.js'), /\bid: '(contrast-[a-z]+)'/g),
    ...Object.values({ a: 'no-name', b: 'linked-empty-alt', c: 'alt-decorative', d: 'suspicious-alt', e: 'redundant-alt', f: 'long-alt', g: 'filename-alt', h: 'repeated-alt', i: 'alt-ok', j: 'heading', k: 'landmark', l: 'kb-stop', m: 'contrast' }),
  ]);
  assert.ok(ids.size > 70, `found ${ids.size} ids`);
  for (const id of OVERLAP.map((o) => o.ours.split(':')[1]).filter((k) => !k.startsWith('no-name-'))) ids.add(id);
  const missing = [...ids].filter((id) => !referenceFor('a11y-structure', id));
  assert.deepEqual(missing, [], `no reference for: ${missing.join(', ')}`);
  for (const kind of Object.keys(KIND_LABELS)) assert.ok(referenceFor('a11y-structure', `focus-${kind}`), `focus-${kind}`);
});

test('the ids the tests below rely on are really emitted by the new checks', () => {
  for (const id of ['fieldset-legend', 'label-empty', 'label-orphaned', 'label-multiple', 'link-broken-anchor', 'link-redundant', 'title-redundant', 'video-captions', 'media-embed', 'layout-table']) {
    assert.match(src('plugins/a11y-basics.js'), new RegExp(`'${id}'`), id);
  }
  for (const id of ['possible-heading', 'possible-list', 'vague-link', 'tiny-text', 'justified-text', 'underline-nonlink']) {
    assert.match(src('plugins/a11y-structure.js'), new RegExp(`'${id}'`), id);
  }
});

test('reference entries are complete and their criteria are known', () => {
  for (const [id, e] of Object.entries(REFERENCE)) {
    for (const k of ['what', 'why', 'fix']) assert.ok(typeof e[k] === 'string' && e[k].length > 10, `${id}.${k}`);
    assert.ok(Array.isArray(e.wcag), `${id}.wcag`);
    for (const sc of e.wcag) assert.ok(WCAG[sc], `${id}: ${sc} is in the criteria table`);
  }
  assert.equal(REFERENCE['link-broken-anchor'].wcag.length > 0, true);
});

test('WCAG links: the Understanding page of the criterion, with its number and name', () => {
  const w = wcagLink('1.4.3');
  assert.deepEqual(w, { sc: '1.4.3', name: 'Contrast (Minimum)', url: 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html' });
  assert.equal(wcagLabel(w), '1.4.3 Contrast (Minimum)');
  for (const sc of Object.keys(WCAG)) assert.match(wcagLink(sc).url, /^https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\/[a-z-]+\.html$/, sc);
  assert.equal(wcagLink('9.9.9').url, 'https://www.w3.org/WAI/WCAG22/quickref/', 'unknown criteria link to the quick reference');
});

test('axe tags map to criteria; level and best-practice tags are ignored', () => {
  assert.deepEqual(wcagFromTags(['wcag2a', 'wcag111', 'wcag21aa', 'best-practice', 'cat.text-alternatives']), ['1.1.1']);
  assert.deepEqual(wcagFromTags(['wcag1410', 'wcag143', 'wcag2411', 'wcag258', 'wcag143']), ['1.4.10', '1.4.3', '2.4.11', '2.5.8']);
  assert.deepEqual(wcagFromTags(undefined), []);
});

test('axe findings use axe\'s help and page with the mapped criteria; needs-review says so', () => {
  const v = referenceFor('axe', 'image-alt', ['wcag2a', 'wcag111'], { help: 'Images must have alternative text', url: 'https://dequeuniversity.com/rules/axe/4.10/image-alt' });
  assert.equal(v.what, 'Images must have alternative text');
  assert.equal(v.url, 'https://dequeuniversity.com/rules/axe/4.10/image-alt');
  assert.deepEqual(v.wcag.map((w) => w.sc), ['1.1.1']);
  assert.match(v.fix, /rule page/);
  const rv = referenceFor('axe', 'review:color-contrast', ['wcag143'], { help: 'Elements must meet minimum color contrast ratio thresholds' });
  assert.match(rv.why, /person has to look/);
  assert.deepEqual(rv.wcag.map((w) => w.sc), ['1.4.3']);
});

test('referenceFor: unknown keys give null; own-property lookup only', () => {
  assert.equal(referenceFor('a11y-basics', 'nope'), null);
  assert.equal(referenceFor('a11y-basics', 'constructor'), null);
  assert.equal(referenceFor('a11y-basics', '__proto__'), null);
  const r = referenceFor('a11y-basics', 'html-lang');
  assert.match(r.fix, /lang=/);
  assert.equal(r.wcag[0].sc, '3.1.1');
});

test('referenceForMark: heuristics by id, axe by rule with tags, review marks', () => {
  assert.equal(referenceForMark({ source: 'a11y-structure', ruleId: 'tiny-text' }).wcag[0].sc, '1.4.4');
  const axe = referenceForMark({ source: 'axe', ruleId: 'image-alt', label: 'Images must have alternative text', tags: ['wcag111'], ref: 'https://x/y' });
  assert.deepEqual([axe.what, axe.url, axe.wcag[0].sc], ['Images must have alternative text', 'https://x/y', '1.1.1']);
  const rev = referenceForMark({ source: 'axe-review', ruleId: 'color-contrast', label: 'Needs review: Contrast', tags: ['wcag143'] });
  assert.equal(rev.what, 'Contrast');
  assert.match(rev.why, /person has to look/);
  assert.equal(referenceForMark({ source: 'keyboard', ruleId: 'kb-stop' }).wcag[0].sc, '2.4.3');
  assert.equal(referenceForMark({ source: 'x' }), null);
});

test('marker details carry the reference by default: what, why, fix and criteria with links', () => {
  const marks = buildMarks({
    violations: [{ id: 'image-alt', help: 'Images must have alternative text', helpUrl: 'https://x/y', tags: ['wcag2a', 'wcag111'], targets: ['img'] }],
    heuristics: [{ source: 'a11y-basics', id: 'fieldset-legend', title: 'Fieldset without a legend (1)', severity: 'medium', sels: ['fieldset'] }],
    boxes: new Map([['img', { x: 0, y: 0, w: 10, h: 10 }], ['fieldset', { x: 0, y: 20, w: 10, h: 10 }]]),
  });
  const a = markDetails(marks.find((m) => m.ruleId === 'image-alt'));
  assert.equal(a.url, 'https://x/y');
  assert.equal(a.wcag[0].sc, '1.1.1');
  assert.ok(a.fix);
  const f = markDetails(marks.find((m) => m.ruleId === 'fieldset-legend'));
  assert.match(f.what, /fieldset/i);
  assert.match(f.fix, /legend/);
  assert.equal(f.wcag.map((w) => w.sc).join(), '1.3.1,3.3.2');
  assert.equal(markDetails({ category: 'error', label: 'x', ruleId: 'zzz' }).fix, '', 'no entry: empty');
});

const bag = (n) => ({ count: n, samples: Array.from({ length: Math.min(n, 5) }, (_, i) => ({ selector: `p:nth-of-type(${i + 1})`, text: 'x' })) });
const base = { headings: [], landmarks: { hasMain: true, mains: 1, navs: [], asides: [] } };

test('structure: WAVE-style findings appear at their trigger count and not at zero', () => {
  const none = analyzeStructure({ ...base, possibleHeadings: bag(0), possibleLists: bag(0), vagueLinks: bag(0), tinyText: bag(0), justified: bag(0), underlined: bag(0) });
  assert.deepEqual(none.findings.map((f) => f.id), []);
  const c = { ...base, possibleHeadings: bag(2), possibleLists: bag(1), vagueLinks: bag(3), tinyText: bag(1), justified: bag(1), underlined: bag(4) };
  const out = analyzeStructure(c);
  const by = Object.fromEntries(out.findings.map((f) => [f.id, f]));
  assert.deepEqual(Object.keys(by).sort(), ['justified-text', 'possible-heading', 'possible-list', 'tiny-text', 'underline-nonlink', 'vague-link']);
  assert.ok(Object.values(by).every((f) => f.severity === 'low' && f.category === 'accessibility'));
  assert.match(by['possible-heading'].title, /^2 possible headings/);
  assert.match(by['possible-list'].title, /^1 possible list /);
  assert.ok(by['vague-link'].evidence.includes('p:nth-of-type(1)'));
  assert.match(by['underline-nonlink'].title, /^4 /);
});

test('structure: old readings without the new bags still analyse', () => {
  assert.deepEqual(analyzeStructure(base).findings.map((f) => f.id), []);
});

const rule = (id, impact, count = 1) => ({ id, impact, help: `help ${id}`, count, samples: [{ selector: 'x', html: '<x>' }] });
const ctxFor = (rules, axe) => ({ collected: { rules, errors: [], stats: {} }, results: { axe } });
const okAxe = (over = {}) => ({ status: 'ok', data: { violations: [], incomplete: [], passedIds: [], ...over } });

test('basics: severities of the WAVE-style rules', () => {
  const out = basics.run({}, ctxFor([rule('fieldset-legend', 'serious'), rule('label-empty', 'serious'), rule('label-orphaned', 'serious'), rule('label-multiple', 'moderate'),
    rule('link-broken-anchor', 'serious'), rule('link-redundant', 'moderate'), rule('title-redundant', 'minor'), rule('video-captions', 'serious'), rule('media-embed', 'minor'), rule('layout-table', 'moderate')]));
  const sev = Object.fromEntries(out.findings.map((f) => [f.id, f.severity]));
  assert.deepEqual(sev, { 'fieldset-legend': 'medium', 'label-empty': 'medium', 'label-orphaned': 'medium', 'label-multiple': 'low', 'link-broken-anchor': 'medium', 'link-redundant': 'low', 'title-redundant': 'info', 'video-captions': 'medium', 'media-embed': 'info', 'layout-table': 'low' });
});

test('overlap: new checks have rows; those axe covers yield, the rest are kept or unique', () => {
  const mode = (k) => OVERLAP.find((o) => o.ours === k)?.mode;
  for (const k of ['a11y-basics:video-captions', 'a11y-basics:label-empty']) assert.equal(mode(k), 'suppress', k);
  for (const k of ['fieldset-legend', 'label-orphaned', 'label-multiple', 'link-broken-anchor', 'link-redundant', 'title-redundant', 'media-embed', 'layout-table']) assert.ok(mode(`a11y-basics:${k}`), k);
  for (const k of ['possible-heading', 'possible-list', 'vague-link', 'tiny-text', 'justified-text', 'underline-nonlink']) assert.ok(mode(`a11y-structure:${k}`), k);
  const covered = basics.run({}, ctxFor([rule('video-captions', 'serious'), rule('layout-table', 'moderate')], okAxe({ passedIds: ['video-caption'] })));
  assert.deepEqual(covered.findings.map((f) => f.id), ['layout-table']);
  assert.equal(suppressedBy('a11y-basics', 'video-captions', okAxe()), null, 'axe did not run the rule');
});

test('axe findings carry their tags for the reference', async () => {
  const axe = (await import('../extension/plugins/axe.js')).default;
  const out = axe.run({}, { collected: { violations: [{ id: 'image-alt', impact: 'critical', help: 'h', helpUrl: 'u', tags: ['wcag2a', 'wcag111'], nodes: 1, samples: [{ target: 'img' }] }],
    incomplete: [{ id: 'color-contrast', help: 'c', helpUrl: 'u', tags: ['wcag143'], nodes: 1, samples: [{ target: 'p', summary: 's' }] }], passes: 1 } });
  assert.deepEqual(out.findings.map((f) => f.tags), [['wcag2a', 'wcag111'], ['wcag143']]);
});

test('the findings table shows how to fix, with WCAG links; axe findings use their tags', async () => {
  const { findingsTable, referenceHtml } = await import('../extension/ui/report.js');
  const out = String(findingsTable([
    { severity: 'medium', area: 'accessibility', plugin: 'a11y-basics', pluginName: 'Accessibility basics', id: 'fieldset-legend', title: 'Fieldsets without a legend (2)' },
    { severity: 'high', area: 'accessibility', plugin: 'axe', pluginName: 'axe', id: 'image-alt', tags: ['wcag2a', 'wcag111'], ref: 'https://dequeuniversity.com/rules/axe/4/image-alt', title: 'Images must have alternative text (3)' },
    { severity: 'low', area: 'content', plugin: 'content', pluginName: 'Content', title: 'Not an accessibility finding' },
  ]));
  assert.equal((out.match(/<summary>how to fix<\/summary>/g) || []).length, 2, 'two findings have a reference');
  assert.match(out, /Add &lt;legend&gt; as the first child/);
  assert.match(out, /href="https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\/info-and-relationships\.html"[^>]*>1\.3\.1 Info and Relationships/);
  assert.match(out, /href="https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\/non-text-content\.html"/);
  const marker = String(referenceHtml({ what: 'W', why: 'Y', fix: 'F', wcag: [wcagLink('2.4.7')], url: 'https://x.test/r' }));
  for (const t of ['What:', 'Why it matters:', 'How to fix:', 'WCAG:', '2.4.7 Focus Visible', 'Rule reference']) assert.ok(marker.includes(t), t);
  assert.equal(String(referenceHtml(null)), '');
});
