import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { countWords, syllables, flesch, splitSentences, analyze } from '../extension/plugins/content.js';
import { getPlugins } from '../extension/plugins/index.js';
import * as util from '../extension/core/har-util.js';
import { h } from '../extension/ui/render.js';

const words = (n, w = 'word') => Array(n).fill(w).join(' ');
const base = (over = {}) => ({
  url: 'https://www.site.test/a/b/', lang: 'en', text: '', bodyTextBytes: 0,
  paragraphs: [], headings: [], navs: [], breadcrumb: false, links: [], ids: [], ...over,
});
const titles = (r) => r.findings.map((f) => f.title);

test('registered after meta as a Content page plugin', () => {
  const ids = getPlugins().map((p) => p.id);
  assert.equal(ids.indexOf('content'), ids.indexOf('meta') + 1);
  assert.equal(plugin.phase, 'page');
  assert.equal(plugin.area, 'content');
  assert.deepEqual(plugin.after, ['meta']);
});

test('countWords: spaces, punctuation-only tokens, CJK characters ÷ 2', () => {
  assert.equal(countWords('Hello there, world — ok'), 4);
  assert.equal(countWords(''), 0);
  assert.equal(countWords('日本語の文章です'), 4); // 8 chars → 4
  assert.equal(countWords('Tokyo 東京'), 2);       // 1 + round(2/2)
});

test('syllables heuristic', () => {
  for (const [w, n] of [['cat', 1], ['table', 2], ['reading', 2], ['simple', 2], ['made', 1], ['the', 1], ['', 0]]) assert.equal(syllables(w), n, w);
});

test('flesch arithmetic', () => {
  const r = flesch({ words: 100, sentences: 5, syllables: 150 });
  assert.equal(r.ease.toFixed(3), '59.635');
  assert.equal(r.grade.toFixed(2), '9.91');
  assert.equal(flesch({ words: 0, sentences: 0, syllables: 0 }), null);
});

test('splitSentences: latin punctuation before space/end, CJK full stops', () => {
  assert.deepEqual(splitSentences('One two. Three? Four!'), ['One two', 'Three', 'Four']);
  assert.equal(splitSentences('Version 2.5 is out. Yes.').length, 2);
  assert.equal(splitSentences('今日は。明日は。').length, 2);
});

test('reading findings: long sentences, wall of text, thin content, hard to read', () => {
  const long = `${words(30, 'extraordinarily')}.`;
  const text = `${long} ${long} ${long} Short one.`;
  const r = analyze(base({ text, paragraphs: [{ text: words(160) }, { text: 'tiny paragraph here for count' }] }), { meta: {}, url: 'https://www.site.test/a/b/' });
  const t = titles(r);
  assert.ok(t.includes('Many long sentences (75% over 25 words)'), t.join(' | '));
  assert.ok(t.includes('1 wall-of-text paragraphs'));
  assert.ok(t.some((x) => /^Thin content \(\d+ words\)$/.test(x)));
  assert.ok(t.some((x) => /^Hard to read \(Flesch -?\d+, grade \d+\)$/.test(x)));
  assert.equal(r.findings.find((f) => f.title.startsWith('Hard to read')).severity, 'medium');
  assert.ok(r.findings.every((f) => f.category === 'content'));
  assert.equal(r.data.reading.english, true);
});

test('readability skipped for non-English pages', () => {
  const r = analyze(base({ lang: 'fr', text: `${words(300, 'extraordinairement')}.` }), { meta: {}, url: 'https://www.site.test/' });
  assert.equal(r.data.reading.english, false);
  assert.equal(r.data.reading.flesch, null);
  assert.ok(!titles(r).some((x) => x.startsWith('Hard to read')));
  assert.equal(r.data.reading.readability, 'not applicable: page language is fr');
});

test('empty page: zero words, thin content, no NaN anywhere', () => {
  const r = analyze(base({ url: 'https://www.site.test/' }), { meta: {}, url: 'https://www.site.test/' });
  assert.equal(r.data.reading.words, 0);
  assert.ok(titles(r).includes('Thin content (0 words)'));
  const out = String(plugin.glance({ data: r.data }, h)) + String(plugin.render({ data: r.data }, h));
  assert.doesNotMatch(out, /NaN|undefined|Infinity/);
});

test('text vs markup', () => {
  const r = analyze(base({ bodyTextBytes: 500, text: words(300) }), { meta: {}, url: 'https://www.site.test/', docBytes: 10_000 });
  assert.ok(titles(r).includes('Mostly markup (5% text)'));
  const ok = analyze(base({ bodyTextBytes: 5000, text: words(300) }), { meta: {}, url: 'https://www.site.test/', docBytes: 10_000 });
  assert.ok(!titles(ok).some((x) => x.startsWith('Mostly markup')));
});

test('structure: skipped levels, empty and long headings, title vs h1, menu overload, breadcrumbs, URL shape', () => {
  const r = analyze(base({
    url: 'https://www.site.test/Shop/Big_Things/x/y/z/?sessionid=1',
    text: words(300),
    headings: [{ level: 1, text: 'Welcome' }, { level: 3, text: 'Deep' }, { level: 2, text: '' }, { level: 2, text: 'x'.repeat(121) }],
    navs: [{ links: 61, depth: 2, label: 'Main' }],
  }), { meta: { title: 'Welcome', og: {}, structuredTypes: [] }, url: 'https://www.site.test/Shop/Big_Things/x/y/z/?sessionid=1' });
  const t = titles(r);
  assert.ok(t.includes('1 skipped heading levels'));
  assert.ok(t.includes('1 empty headings'));
  assert.ok(t.includes('1 very long headings'));
  assert.ok(t.includes('Title repeats the h1'));
  assert.ok(t.includes('Menu overload (61 links in navigation)'));
  assert.ok(t.includes('No breadcrumbs on a page 5 levels deep'));
  assert.ok(t.some((x) => x.startsWith('URL shape:') && /depth 5/.test(x) && /uppercase/.test(x) && /underscores/.test(x) && /session id/.test(x)));
  assert.equal(r.findings.find((f) => f.title === '1 empty headings').severity, 'medium');
});

test('breadcrumbs from BreadcrumbList JSON-LD satisfy the check; site-name-only title', () => {
  const r = analyze(base({ url: 'https://www.site.test/a/b/', text: words(300) }),
    { meta: { title: 'Site Test', og: { 'og:site_name': 'Site Test' }, structuredTypes: ['BreadcrumbList'] }, url: 'https://www.site.test/a/b/' });
  assert.ok(!titles(r).some((x) => x.startsWith('No breadcrumbs')));
  assert.ok(titles(r).includes('Title is only the site name'));
});

test('links: kinds, vague text, same text different places, broken anchors, density, targets', () => {
  const u = 'https://www.site.test/page';
  const r = analyze(base({
    url: u, text: words(200),
    ids: ['real'],
    links: [
      { href: 'https://www.site.test/a', text: 'Click here' },
      { href: 'https://site.test/b#x', text: 'Pricing' },
      { href: 'https://www.site.test/c', text: 'Pricing' },
      { href: 'https://other.test/', text: 'Partner' },
      { href: 'https://other.test/', text: 'Partner' },
      { href: 'mailto:a@site.test', text: 'Email' },
      { href: 'tel:+1555', text: 'Call' },
      { href: `${u}#real`, text: 'Jump' },
      { href: `${u}#missing`, text: 'Jump 2' },
      { href: `${u}#top`, text: 'Top' },
      { href: 'javascript:void(0)', text: 'More', aria: '' },
      { href: 'https://www.site.test/logout', text: 'Log out' },
    ],
  }), { meta: {}, url: u });
  const k = r.data.links.kinds;
  assert.deepEqual(k, { internal: 4, external: 2, mailto: 1, tel: 1, fragment: 3, other: 1 });
  const t = titles(r);
  assert.ok(t.includes('2 links with vague text'));
  assert.ok(t.includes('1 link texts point to different places'));
  assert.ok(t.includes('1 links to missing in-page anchors'));
  assert.equal(r.findings.find((f) => f.title === '1 links to missing in-page anchors').severity, 'medium');
  assert.deepEqual(r.data.linkTargets.internal, ['https://www.site.test/a', 'https://site.test/b', 'https://www.site.test/c', 'https://www.site.test/logout']);
  assert.deepEqual(r.data.linkTargets.external, ['https://other.test/']);
  assert.equal(r.data.links.perThousandWords, 30); // 6 page links (4 internal + 2 external) / 200 words × 1000
});

test('link density finding only with ≥ 200 words', () => {
  const links = Array(30).fill(0).map((_, i) => ({ href: `https://www.site.test/p${i}`, text: `Page ${i}` }));
  const many = analyze(base({ text: words(200), links: [...links, ...links] }), { meta: {}, url: 'https://www.site.test/' });
  assert.ok(titles(many).some((x) => x.startsWith('Very link-dense')));
  const short = analyze(base({ text: words(100), links: [...links, ...links] }), { meta: {}, url: 'https://www.site.test/' });
  assert.ok(!titles(short).some((x) => x.startsWith('Very link-dense')));
});

test('run() wires ctx: skips without collected data, uses meta and document size', async () => {
  assert.throws(() => plugin.run({ log: { entries: [] } }, { collected: undefined, skip: (m) => { throw new Error(m); } }), /no page data/);
  const reading = { log: { entries: [{ request: { url: 'https://www.site.test/' }, response: { status: 200, content: { size: 1000, mimeType: 'text/html' }, headers: [] }, _resourceType: 'document' }], _harplus: { target: { finalUrl: 'https://www.site.test/' } } } };
  const out = plugin.run(reading, { collected: base({ url: 'https://www.site.test/', text: words(300), bodyTextBytes: 50 }), results: { meta: { data: { title: 'T', og: {}, structuredTypes: [] } } }, target: reading.log._harplus.target, util, skip: () => {} });
  assert.ok(out.findings.some((f) => f.title === 'Mostly markup (5% text)'));
  assert.ok(out.summary.length > 0);
});

test('internal vs external uses the registrable host when siteOf is given', () => {
  const links = [{ href: 'https://blink.ucsd.edu/x', text: 'Blink' }];
  const r = analyze(base({ url: 'https://www.ucsd.edu/', text: words(50), links }), { meta: {}, url: 'https://www.ucsd.edu/', siteOf: util.siteOf });
  assert.equal(r.data.links.kinds.internal, 1);
  assert.deepEqual(r.data.linkTargets.internal, ['https://blink.ucsd.edu/x']);
});

test('fragments: malformed escapes do not throw; hash routes and bare # are not broken anchors', () => {
  const u = 'https://www.site.test/page';
  const r = analyze(base({ url: u, text: words(50), ids: [], links: [
    { href: `${u}#100%`, text: 'A' }, { href: `${u}#/about`, text: 'B' }, { href: `${u}#!x`, text: 'C' }, { href: `${u}#`, text: 'D' },
  ] }), { meta: {}, url: u });
  assert.equal(r.data.links.kinds.fragment, 4);
  assert.equal(r.data.links.kinds.internal, 0);
  assert.equal(r.data.links.missing.length, 1); // only #100%
});

test('non-string href (SVG link) counts as other and is not a target', () => {
  const r = analyze(base({ text: words(50), links: [{ href: {}, text: 'svg' }] }), { meta: {}, url: 'https://www.site.test/' });
  assert.equal(r.data.links.kinds.other, 1);
  assert.deepEqual(r.data.linkTargets, { internal: [], external: [] });
});

test('heading findings carry details', () => {
  const r = analyze(base({ text: words(300), headings: [{ level: 1, text: 'Welcome' }, { level: 3, text: 'Deep' }, { level: 2, text: '' }] }), { meta: {}, url: 'https://www.site.test/' });
  assert.equal(r.findings.find((f) => f.title === '1 skipped heading levels').detail, 'h1 "Welcome" → h3 "Deep"');
  assert.equal(r.findings.find((f) => f.title === '1 empty headings').detail, 'h2 (empty)');
});

test('run() clamps a negative HAR document size', () => {
  const reading = { log: { entries: [{ request: { url: 'https://www.site.test/' }, response: { status: 200, content: { size: -1, mimeType: 'text/html' }, headers: [] }, _resourceType: 'document' }], _harplus: { target: { finalUrl: 'https://www.site.test/' } } } };
  const out = plugin.run(reading, { collected: base({ text: words(300), bodyTextBytes: 50 }), results: {}, target: reading.log._harplus.target, util, skip: () => {} });
  assert.equal(out.data.textShare, null);
});

test('Flesch on a known passage matches the hand computation', () => {
  const text = 'The cat sat on the warm mat. It was a quiet morning in the village. Children walked to school along the river. The teacher greeted every student with a smile.';
  // 30 words, 4 sentences, 41 syllables (heuristic per word: quiet 2, morning 2, village 2, children 2, along 2,
  // river 2, teacher 2, every 3, student 2, smile 2, greeted 1, all others 1).
  // ease = 206.835 - 1.015 x (30/4) - 84.6 x (41/30) = 206.835 - 7.6125 - 115.62 = 83.6
  const r = analyze(base({ text }), { meta: {}, url: 'https://www.site.test/a/b/' }).data.reading;
  assert.equal(r.words, 30);
  assert.equal(r.sentences, 4);
  assert.ok(Math.abs(r.flesch - 83.6) <= 2, `Flesch ${r.flesch}`);
});
