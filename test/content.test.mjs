import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { countWords, syllables, flesch, splitSentences, proseSentences, analyze, scriptOf, ari, aari, hardest } from '../extension/plugins/content.js';
import { getPlugins } from '../extension/plugins/index.js';
import * as util from '../extension/core/har-util.js';
import { h } from '../extension/ui/render.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';
import { CASES as CONTENT_CASES, base as caseBase, LONG as C_LONG, ODD as C_ODD } from './fixtures/content-cases.mjs';
import CONTENT_BASELINE from './fixtures/content-findings-baseline.json' with { type: 'json' };

const words = (n, w = 'word') => Array(n).fill(w).join(' ');
const base = (over = {}) => ({
  url: 'https://www.site.test/a/b/', lang: 'en', text: '', bodyTextBytes: 0,
  paragraphs: [], headings: [], navs: [], breadcrumb: false, links: [], ids: [], ...over,
});
const titles = (r) => r.findings.map((f) => f.title);
const sentencesOf = (n, perSentence, w = 'word') => Array.from({ length: n }, () => `${words(perSentence, w)}.`).join(' ');
const FR = sentencesOf(6, 50, 'extraordinairement'); // 300 words, 6 sentences
const EN = sentencesOf(6, 50); // 300 words, 6 sentences
const AR = Array(10).fill('مرحبا بكم في متجرنا. نقدم الشحن المجاني على جميع الطلبات.').join(' '); // 100 words, 20 sentences
const JA = `${Array(10).fill('今日はとてもいい天気なので公園まで歩いて行きました').join('。')}。`; // 25 chars × 10

test('registered after meta as a Content page plugin', () => {
  const ids = getPlugins().map((p) => p.id);
  assert.equal(ids.indexOf('content'), ids.indexOf('meta') + 1);
  assert.equal(plugin.phase, 'page');
  assert.equal(plugin.area, 'content');
  assert.deepEqual(plugin.after, ['meta', 'a11y-structure', 'a11y-basics']);
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

test('splitSentences: latin punctuation before space/end, CJK full stops, line breaks', () => {
  assert.deepEqual(splitSentences('One two. Three? Four!'), ['One two', 'Three', 'Four']);
  assert.equal(splitSentences('Version 2.5 is out. Yes.').length, 2);
  assert.equal(splitSentences('今日は。明日は。').length, 2);
  assert.deepEqual(splitSentences('Headline one\nHeadline two\n\nA third line'), ['Headline one', 'Headline two', 'A third line']);
});

test('proseSentences: ≥ 4 words, or ≥ 10 non-space characters for CJK', () => {
  assert.deepEqual(proseSentences(['Home', 'World news', 'This one has four', 'and this has five words'], 'latin'), ['This one has four', 'and this has five words']);
  assert.deepEqual(proseSentences(['今日は', '今日はとてもいい天気です'], 'cjk'), ['今日はとてもいい天気です']);
});

test('headline list: not enough prose — no score, no hard-to-read or long-sentence finding', () => {
  const list = Array.from({ length: 240 }, (_, i) => `Minister announces extraordinarily comprehensive infrastructure investment programme ${i}`).join('\n');
  const r = analyze(base({ text: `${list}\nHome\nNews` }), { meta: {}, url: 'https://www.gov.test/' });
  // Line breaks split the headlines; the 1-word nav labels are fragments but not prose.
  assert.equal(r.data.reading.sentences, 242);
  assert.equal(r.data.reading.proseSentences, 240);
  const short = analyze(base({ text: 'Home\nNews\nSport\nWeather\nA short line of four\nContact us' }), { meta: {}, url: 'https://www.gov.test/' });
  assert.equal(short.data.reading.readability, 'not enough prose');
  for (const k of ['flesch', 'grade', 'ari', 'aari', 'cjkCharsPerSentence']) assert.equal(short.data.reading[k], null, k);
  assert.ok(!titles(short).some((t) => /^Hard to read|^Many long sentences/.test(t)));
  assert.match(String(plugin.glance(short, h)), /Not enough prose to score/);
  assert.match(String(plugin.render(short, h)), /Sentences<\/dt>\s*<dd>6 lines · 1 prose · average \d+ words/);
  const old = structuredClone(short);
  delete old.data.reading.proseSentences;
  assert.match(String(plugin.render(old, h)), /Sentences<\/dt>\s*<dd>6 · average \d+ words/, 'older readings keep the plain text');
  assert.ok(titles(short).some((t) => t.startsWith('Thin content')), 'thin content still uses all words');
});

test('enough sentences but under 100 prose words → not enough prose', () => {
  const r = analyze(base({ text: sentencesOf(8, 10) }), { meta: {}, url: 'https://www.site.test/' }); // 80 words
  assert.equal(r.data.reading.readability, 'not enough prose');
});

test('long headline list without sentence punctuation no longer reads as one giant sentence', () => {
  const list = Array.from({ length: 40 }, () => 'Council approves the new library budget for next year').join('\n');
  const r = analyze(base({ text: list }), { meta: {}, url: 'https://www.gov.test/' });
  assert.equal(r.data.reading.proseSentences, 40);
  assert.ok(r.data.reading.flesch > 30, `Flesch ${r.data.reading.flesch}`);
  assert.ok(!titles(r).some((t) => t.startsWith('Hard to read')));
});

test('reading findings: long sentences, wall of text, thin content, hard to read', () => {
  const long = `${words(30, 'extraordinarily')}.`;
  const text = `${long} ${long} ${long} ${long} ${long} ${long} Short one is here. Another short one here.`;
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

test('French page: ARI instead of Flesch, with grade findings', () => {
  const r = analyze(base({ lang: 'fr', text: FR }), { meta: {}, url: 'https://www.site.test/' });
  assert.equal(r.data.reading.english, false);
  assert.equal(r.data.reading.flesch, null);
  assert.equal(r.data.reading.readability, 'ari');
  assert.ok(r.data.reading.ari > 16);
  assert.ok(titles(r).includes(`Hard to read (ARI grade ${Math.round(r.data.reading.ari)})`));
  assert.equal(r.findings.find((f) => f.title.startsWith('Hard to read (ARI')).severity, 'medium');
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
  assert.ok(!t.some((x) => /skipped heading levels|empty headings/.test(x)), 'heading rules live in a11y-structure now');
  assert.ok(t.includes('1 very long headings'));
  assert.ok(t.includes('Title repeats the h1'));
  assert.ok(t.includes('Menu overload (61 links in navigation)'));
  assert.ok(t.includes('No breadcrumbs on a page 5 levels deep'));
  assert.ok(t.some((x) => x.startsWith('URL shape:') && /depth 5/.test(x) && /uppercase/.test(x) && /underscores/.test(x) && /session id/.test(x)));
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

test('links: sources group every anchor per target with raw, text, region and selector', () => {
  const u = 'https://www.site.test/page';
  const lk = (i, over = {}) => ({ href: 'https://www.site.test/x', raw: '/x', text: `T${i}`, aria: '', region: 'nav', selector: `nav > a:nth-of-type(${i})`, ...over });
  const r = analyze(base({ url: u, links: [lk(1), lk(2, { region: 'footer' }), lk(3), { href: 'https://other.test/', raw: 'https://other.test/', text: 'O', region: 'main', selector: '#o' }] }), { meta: {}, url: u });
  const s = r.data.linkTargets.sources;
  assert.equal(s['https://www.site.test/x'].list.length, 3);
  assert.equal(s['https://www.site.test/x'].more, 0);
  assert.deepEqual(s['https://www.site.test/x'].list[1], { raw: '/x', text: 'T2', region: 'footer', selector: 'nav > a:nth-of-type(2)' });
  assert.deepEqual(Object.keys(s).sort(), ['https://other.test/', 'https://www.site.test/x']);
});

test('links: sources cap at 20 per target with a count of the rest; text is cut to 80', () => {
  const u = 'https://www.site.test/page';
  const links = Array.from({ length: 25 }, (_, i) => ({ href: 'https://www.site.test/x', raw: '/x', text: i === 0 ? 'a'.repeat(200) : `T${i}`, region: 'main', selector: 'a' }));
  const r = analyze(base({ url: u, links }), { meta: {}, url: u });
  const e = r.data.linkTargets.sources['https://www.site.test/x'];
  assert.equal(e.list.length, 20);
  assert.equal(e.more, 5);
  assert.equal(e.list[0].text.length, 80);
});

test('links: an old-style link without raw or region gives a source entry without them; aria-label stands in for text', () => {
  const u = 'https://www.site.test/page';
  const r = analyze(base({ url: u, links: [{ href: 'https://www.site.test/x', text: 'Hi' }, { href: 'https://www.site.test/x', text: '', aria: 'Label' }] }), { meta: {}, url: u });
  assert.deepEqual(r.data.linkTargets.sources['https://www.site.test/x'].list, [{ text: 'Hi' }, { text: 'Label' }]);
});

test('links: missing anchors carry raw, region and selector; 200 are kept and missingCount counts past them; finding has an id', () => {
  const u = 'https://www.site.test/page';
  const links = Array.from({ length: 210 }, (_, i) => ({ href: `${u}#m${i}`, raw: `#m${i}`, text: `J${i}`, region: 'header', selector: '#h > a' }));
  const r = analyze(base({ url: u, links }), { meta: {}, url: u });
  assert.equal(r.data.links.missing.length, 200);
  assert.equal(r.data.links.missingCount, 210);
  assert.equal(r.data.links.missing[0].raw, '#m0');
  assert.equal(r.data.links.missing[0].region, 'header');
  assert.equal(r.data.links.missing[0].selector, '#h > a');
  const f = r.findings.find((x) => x.title === '210 links to missing in-page anchors');
  assert.equal(f.id, 'missing-anchors');
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
  assert.deepEqual(r.data.linkTargets, { internal: [], external: [], sources: {}, totals: { internal: 0, external: 0 } });
});

test('link targets: lists capped at 5000 each; totals count every unique http(s) target', () => {
  const internalLinks = Array.from({ length: 5003 }, (_, i) => ({ href: `https://www.site.test/p${i}`, text: `P${i}` }));
  const links = [...internalLinks, internalLinks[0], { href: 'https://other.test/a', text: 'A' }, { href: 'https://other.test/b', text: 'B' }, { href: 'mailto:x@site.test', text: 'Mail' }];
  const r = analyze(base({ text: words(50), links }), { meta: {}, url: 'https://www.site.test/' });
  assert.equal(r.data.linkTargets.internal.length, 5000);
  assert.equal(r.data.linkTargets.external.length, 2);
  assert.deepEqual(r.data.linkTargets.totals, { internal: 5003, external: 2 });
});

test('analyze passes the anchor counts through as linkTargets.anchors', () => {
  const r = analyze(base({ text: words(50), links: [], anchorsTotal: 12000, anchorsRead: 10000 }), { meta: {}, url: 'https://www.site.test/' });
  assert.deepEqual(r.data.linkTargets.anchors, { total: 12000, read: 10000 });
});

test('heading findings carry details', () => {
  const r = analyze(base({ text: words(300), headings: [{ level: 1, text: 'Welcome' }, { level: 3, text: 'Deep' }, { level: 2, text: '' }] }), { meta: {}, url: 'https://www.site.test/' });
  assert.equal(r.findings.find((f) => /skipped heading levels|empty headings/.test(f.title)), undefined);
});

test('run() clamps a negative HAR document size', () => {
  const reading = { log: { entries: [{ request: { url: 'https://www.site.test/' }, response: { status: 200, content: { size: -1, mimeType: 'text/html' }, headers: [] }, _resourceType: 'document' }], _harplus: { target: { finalUrl: 'https://www.site.test/' } } } };
  const out = plugin.run(reading, { collected: base({ text: words(300), bodyTextBytes: 50 }), results: {}, target: reading.log._harplus.target, util, skip: () => {} });
  assert.equal(out.data.textShare, null);
});

test('Flesch on a known passage matches the hand computation', () => {
  const text = Array(5).fill('The cat sat on the warm mat. It was a quiet morning in the village. Children walked to school along the river. The teacher greeted every student with a smile.').join(' ');
  // 30 words, 4 sentences, 41 syllables (heuristic per word: quiet 2, morning 2, village 2, children 2, along 2,
  // river 2, teacher 2, every 3, student 2, smile 2, greeted 1, all others 1).
  // ease = 206.835 - 1.015 x (30/4) - 84.6 x (41/30) = 206.835 - 7.6125 - 115.62 = 83.6
  const r = analyze(base({ text }), { meta: {}, url: 'https://www.site.test/a/b/' }).data.reading;
  assert.equal(r.words, 150);
  assert.equal(r.sentences, 20);
  assert.equal(r.proseSentences, 20);
  assert.ok(Math.abs(r.flesch - 83.6) <= 2, `Flesch ${r.flesch}`);
});

test('scriptOf: dominant script', () => {
  assert.equal(scriptOf('Hello world'), 'latin');
  assert.equal(scriptOf('Привет мир'), 'cyrillic');
  assert.equal(scriptOf('Γειά σου'), 'greek');
  assert.equal(scriptOf('مرحبا بكم في متجرنا'), 'arabic');
  assert.equal(scriptOf('日本語の文章です'), 'cjk');
  assert.equal(scriptOf('שלום עולם'), 'hebrew');
  assert.equal(scriptOf('Hello world. مرحبا'), 'latin', 'dominant wins');
  assert.equal(scriptOf(''), 'other');
});

test('ARI and AARI arithmetic', () => {
  assert.equal(ari({ letters: 31, words: 10, sentences: 2 }).toFixed(2), '-4.33');
  assert.equal(ari({ letters: 0, words: 0, sentences: 0 }), null);
  assert.equal(aari({ letters: 40, words: 10, sentences: 2 }).toFixed(2), '77.52');
});

test('ARI thresholds: >12 low, >16 medium, <=12 none (German page)', () => {
  const mk = (wordLen, perSentence, n = 20) => Array.from({ length: n }, () => `${words(perSentence, 'a'.repeat(wordLen))}.`).join(' ');
  const g = (t) => analyze(base({ lang: 'de', text: t }), { meta: {}, url: 'https://www.site.test/' });
  assert.equal(g(mk(5, 10)).findings.filter((f) => f.title.startsWith('Hard to read')).length, 0);
  assert.equal(g(mk(6, 15)).findings.find((f) => f.title.startsWith('Hard to read')).severity, 'low');
  assert.equal(g(mk(7, 15)).findings.find((f) => f.title.startsWith('Hard to read')).severity, 'medium');
});

test('Arabic: AARI shown, not scored; CJK chars per sentence; hardest sentences in any language', () => {
  const ar = analyze(base({ lang: 'ar', text: AR }), { meta: {}, url: 'https://www.site.test/' });
  assert.equal(ar.data.reading.readability, 'aari');
  assert.ok(ar.data.reading.aari > 0);
  assert.ok(!titles(ar).some((t) => t.startsWith('Hard to read')));
  const ja = analyze(base({ lang: 'ja', text: JA }), { meta: {}, url: 'https://www.site.test/' });
  assert.equal(ja.data.reading.readability, 'cjk');
  assert.equal(ja.data.reading.cjkCharsPerSentence, 25);
  const hs = hardest(['short one', 'a much longer sentence with many more words in it', 'mid length sentence here'], 'latin');
  assert.equal(hs[0].words, 10);
  assert.equal(hs.length, 3);
});

test('mixed script and old readings: English keeps Flesch; glance/render survive missing new fields', () => {
  const en = analyze(base({ lang: 'en', text: `${EN} مرحبا.` }), { meta: {}, url: 'https://www.site.test/' });
  assert.equal(en.data.reading.readability, 'flesch');
  assert.equal(en.data.reading.ari, null);
  const old = { data: { ...en.data, reading: { ...en.data.reading } } };
  for (const k of ['script', 'ari', 'aari', 'cjkCharsPerSentence', 'hardest']) delete old.data.reading[k];
  for (const fn of [plugin.glance, plugin.render]) {
    const out = String(fn(old, h));
    assert.ok(!/NaN|undefined/.test(out), out.slice(0, 200));
  }
  const fr = analyze(base({ lang: 'fr', text: FR }), { meta: {}, url: 'https://www.site.test/' });
  const o = String(plugin.glance(fr, h)) + String(plugin.render(fr, h));
  assert.ok(o.includes('ARI grade') && o.includes('Hardest sentences'));
  assert.ok(!/NaN|undefined/.test(o));
});

test('line length: median (lower), ideal share, thresholds, missing data', () => {
  const at = (ll) => analyze(base({ text: words(300), lineLengths: ll }), { meta: {}, url: 'https://www.site.test/' });
  const long = at([90, 100, 40, 95, 85]);
  assert.deepEqual(long.data.lineLength, { median: 90, ideal: 0, count: 5 });
  assert.ok(titles(long).includes('Lines are long (median 90 characters)'));
  assert.equal(long.findings.find((f) => f.title.startsWith('Lines are long')).severity, 'low');
  const ok = at([50, 60, 70]);
  assert.deepEqual(ok.data.lineLength, { median: 60, ideal: 100, count: 3 });
  assert.ok(!titles(ok).some((t) => t.startsWith('Lines are')));
  assert.ok(titles(at([20, 30, 25, 22, 28])).includes('Lines are short (median 25 characters)'));
  const none = at(undefined);
  assert.deepEqual(none.data.lineLength, { median: 0, ideal: 0, count: 0 });
  assert.ok(!titles(none).some((t) => t.startsWith('Lines are')));
});

test('line length: fewer than 5 measured paragraphs → no finding, row still shown', () => {
  const r = analyze(base({ text: words(300), lineLengths: [20, 22, 25, 30] }), { meta: {}, url: 'https://www.site.test/' });
  assert.ok(!titles(r).some((t) => t.startsWith('Lines are')));
  assert.equal(r.summary.find((x) => x.label === 'Line length').value, 'median 22 chars · 0% in 45–75');
});

test('summary: Reading carries ARI/AARI/CJK when Flesch is null; Line length row only with data', () => {
  const run = (over) => analyze(base(over), { meta: {}, url: 'https://www.site.test/' }).summary;
  const val = (s, l) => s.find((x) => x.label === l)?.value;
  assert.match(val(run({ lang: 'fr', text: FR }), 'Reading'), /· ARI \d+$/);
  assert.match(val(run({ lang: 'ar', text: AR }), 'Reading'), /· AARI \d+$/);
  assert.match(val(run({ lang: 'ja', text: JA }), 'Reading'), /· 25 chars\/sentence$/);
  assert.match(val(run({ lang: 'en', text: EN }), 'Reading'), /Flesch/);
  assert.equal(val(run({ text: words(300) }), 'Line length'), undefined);
  const s = run({ text: words(300), lineLengths: [50, 60, 90, 70] });
  assert.equal(val(s, 'Line length'), 'median 60 chars · 75% in 45–75');
  assert.ok(!s.find((x) => x.label === 'Line length').headline);
});

test('CJK hardest sentences are labelled in characters', () => {
  const ja = analyze(base({ lang: 'ja', text: JA }), { meta: {}, url: 'https://www.site.test/' });
  const out = String(plugin.render(ja, h));
  assert.ok(out.includes('characters)') && !/\(\d+ words\)/.test(out));
});

test('vague links yield to a11y-structure only when its run checked them (not vagueSkipped)', () => {
  const c = base({ text: words(200), links: [{ href: 'https://www.site.test/a', text: 'Click here' }, { href: 'https://www.site.test/b', text: 'Read more' }] });
  const run = (structure) => titles(plugin.run({ log: { entries: [] } }, { collected: c, results: { 'a11y-structure': structure }, target: { url: c.url }, util: {} }));
  assert.ok(!run({ status: 'ok', data: { vagueSkipped: false } }).includes('2 links with vague text'));
  assert.ok(run({ status: 'ok', data: { vagueSkipped: true } }).includes('2 links with vague text'));
  assert.ok(run({ status: 'error' }).includes('2 links with vague text'));
});

// ---- Plugin panels (phase 5): places, the unchanged findings, the render ----

test('findings: every field but places is unchanged from before places (score-check cannot replay Content)', () => {
  for (const [name, { c, opts }] of Object.entries(CONTENT_CASES)) {
    const out = analyze(c, opts);
    assert.deepEqual(JSON.parse(JSON.stringify(out.findings.map(({ places, ...f }) => f))), CONTENT_BASELINE[name], name);
  }
});

test('places: vague links, conflicting texts and missing anchors name their links; other findings have none', () => {
  const { c, opts } = CONTENT_CASES.links;
  const r = analyze(c, opts);
  const W = 'https://www.site.test/';
  const by = (re) => r.findings.find((f) => re.test(f.title));
  assert.deepEqual(by(/links with vague text$/).places, [
    { url: `${W}a`, text: 'Click here', region: 'main', selector: 'main > p > a' },
    { url: `${W}b`, text: 'Read more', region: 'footer', selector: 'footer > a' },
    { url: `${W}a/b/#here`, text: 'Here', region: 'main', selector: 'main > a' },
  ]);
  assert.deepEqual(by(/link texts point to different places$/).places, [
    { url: `${W}c`, text: 'Pricing', region: 'main', selector: 'main > a' },
    { url: `${W}d`, text: 'Pricing', region: 'nav', selector: 'nav > a' },
  ], 'the text as written, with where each link sits');
  assert.match(by(/link texts point to different places$/).detail, /^“pricing”: https/, 'the detail keeps its lower-cased key');
  assert.deepEqual(by(/missing in-page anchors$/).places, [{ url: `${W}a/b/#gone`, text: 'Jump', region: 'main', selector: '#toc > a' }]);
  for (const f of r.findings.filter((x) => !/vague|different places|anchors/.test(x.title))) assert.equal(f.places, undefined, f.title);
  // An older reading's links have no region or selector: the place keeps what there is.
  const old = analyze(caseBase({ text: 'x', links: [{ href: `${W}z`, text: 'Click here' }] }), { meta: {}, url: `${W}a/b/` });
  assert.deepEqual(old.findings.find((f) => /vague/.test(f.title)).places, [{ url: `${W}z`, text: 'Click here' }]);
  const covered = analyze(CONTENT_CASES.covered.c, CONTENT_CASES.covered.opts);
  assert.ok(covered.findings.every((f) => !f.places), 'covered: no link findings, so no places');
});

test('odd values: 251 missing anchors give 200 places (the detail names 10); a long URL is cut to 500; "<" is escaped when drawn', async () => {
  const { c, opts } = CONTENT_CASES.crowded;
  const out = analyze(c, opts);
  const reading = createReading({ entries: [], target: makeTarget('https://www.site.test/', 'S', 'https://www.site.test/') });
  await runPlugins(reading, [{ id: 'n', name: 'N', phase: 'analyze', run: async () => out }], {});
  const fs = reading.log._harplus.plugins.n.findings;
  const miss = fs.find((f) => f.id === 'missing-anchors');
  assert.equal(miss.title, '251 links to missing in-page anchors');
  assert.equal(miss.places.length, 200);
  assert.equal(miss.detail.split(', ').length, 10);
  const vague = fs.find((f) => /vague/.test(f.title));
  assert.equal(vague.places.length, 16, 'every vague link, though the detail names 10');
  assert.ok(vague.places.some((p) => p.url === C_LONG.slice(0, 500)), 'the long URL is cut by normalize');
  assert.equal(fs.find((f) => /different places/.test(f.title)).places.length, 27, 'every destination of every conflicting text');
  const odd = analyze(CONTENT_CASES.odd.c, CONTENT_CASES.odd.opts).findings;
  const oddVague = odd.find((f) => /vague/.test(f.title));
  assert.ok(oddVague.places.some((p) => p.url === C_ODD));
  const drawn = String(h.places(oddVague.places));
  assert.match(drawn, /q=&lt;b&gt;&amp;r=&quot;1&quot;/);
  assert.doesNotMatch(drawn, /<b>&/);
  assert.match(String(h.places(odd.find((f) => f.id === 'missing-anchors').places)), /#&lt;x&gt;/);
});

test('render: stats first, counting past the capped lists; only the reading rows the glance lacks; URLs as parts; the outline folds whole', () => {
  const { c, opts } = CONTENT_CASES.crowded;
  const r = analyze({ ...c, headings: Array.from({ length: 9 }, (_, i) => ({ level: i ? 2 : 1, text: `H${i}` })) }, opts);
  assert.equal(r.data.links.vague.length, 16);
  assert.equal(r.data.links.missing.length, 200);
  assert.equal(r.data.links.missingCount, 251);
  const out = String(plugin.render({ status: 'ok', ...r }, h));
  assert.ok(out.indexOf('class="stats"') < out.indexOf('<h4>Reading</h4>'), 'stats come first');
  assert.match(out, /Headings<\/span><div class="stat-value">9<\/div><span class="stat-note">no skipped levels/);
  assert.match(out, /Vague link text<\/span><div class="stat-value">16<\/div><span class="stat-note"><span class="status" data-status="fair">Needs improvement/);
  assert.match(out, /Missing in-page anchors<\/span><div class="stat-value">251</, 'the true count, not the 200 kept');
  assert.match(out, /Same text, different places<\/span><div class="stat-value">2</);
  assert.doesNotMatch(out, /<dt>Words<\/dt>/, 'words are the glance’s');
  assert.doesNotMatch(out, /<dt>Readability<\/dt>/, 'the glance shows the readability card');
  assert.match(out, /<dt>Average paragraph<\/dt>/);
  assert.doesNotMatch(out, /<dt>Menus<\/dt>/, 'menus are the stat, not repeated in Navigation');
  assert.match(out, /<dt>Breadcrumbs<\/dt>/);
  assert.match(out, /<summary>Heading outline · 9 headings<\/summary><div class="disclosure-body"><ol class="outline">/);
  assert.match(out, /<td><ul class="plain"><li><a href="https:\/\/www\.site\.test\/v0"[^>]*><span class="url"/, 'destinations are links as parts, not one joined string');
  assert.doesNotMatch(out, / · https:\/\//, 'no joined URLs');
  assert.match(out, /<h4>Missing in-page anchors<\/h4>[\s\S]*?<li><span class="url" title="https:\/\/www\.site\.test\/a\/b\/#missing-0"><span class="url-host">www\.site\.test<\/span><span class="url-path">\/a\/b\/<\/span><span class="url-hash">#missing-0/);
  assert.match(out, /<details class="disclosure fold"><summary>192 more<\/summary>/, 'the missing list folds past 8');
  // An older reading: no true counts, so the stats fall back to the list lengths.
  const old = { status: 'ok', data: { ...r.data, links: { ...r.data.links } } };
  delete old.data.links.vagueCount;
  delete old.data.links.conflictingCount;
  delete old.data.links.missingCount;
  assert.match(String(plugin.render(old, h)), /Missing in-page anchors<\/span><div class="stat-value">200</);
  // A script with no readability measure keeps the row, since the glance has no card for it.
  const he = analyze(base({ lang: 'he', text: Array(40).fill('שלום עולם זה משפט ארוך יותר.').join(' ') }), { meta: {}, url: 'https://www.site.test/' });
  assert.match(String(plugin.render({ status: 'ok', ...he }, h)), /<dt>Readability<\/dt>\s*<dd>not applicable: hebrew<\/dd>/);
});

test('glance: the readability ring has a word beside it', () => {
  const en = analyze(base({ lang: 'en', text: EN }), { meta: {}, url: 'https://www.site.test/' });
  assert.match(String(plugin.glance(en, h)), /<p class="note"><span class="status" data-status="(good|fair|poor)">(plain|fairly hard|hard|very hard)<\/span> Flesch/);
  const fr = analyze(base({ lang: 'fr', text: FR }), { meta: {}, url: 'https://www.site.test/' });
  assert.match(String(plugin.glance(fr, h)), /data-status="poor">very hard<\/span> ARI grade/);
});
