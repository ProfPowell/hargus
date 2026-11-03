import { test } from 'node:test';
import assert from 'node:assert/strict';
import meta from '../extension/plugins/meta.js';
import * as hu from '../extension/core/har-util.js';
import { h } from '../extension/ui/render.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';
import { assertRuleIds } from './helpers.mjs';

const S = 'https://s.test/';
const collected = (over = {}) => ({
  url: `${S}a`, title: 'A good page title here', description: 'A long enough description of the page for search results.', canonical: `${S}a`,
  lang: 'en', dir: '', charset: 'UTF-8', robots: '', googlebot: '', viewport: 'width=device-width', themeColor: '', manifest: null, appleItunesApp: null,
  og: { 'og:title': 'x', 'og:image': `${S}i.png` }, twitter: { 'twitter:card': 'summary' }, icons: [{ rel: 'icon', href: `${S}f.ico` }],
  jsonld: [{ '@type': 'Organization', name: 'Org', url: `${S}`, logo: `${S}logo.png` }], jsonldErrors: [], compatMode: 'CSS1Compat',
  images: { noDimensions: 0, total: 0, missingAlt: 0, lazy: 0, responsive: 0 }, forms: [], headings: [{ level: 1, text: 'H' }],
  links: { internal: 1, external: 0, nofollow: 0, externalUrls: [] }, generator: [], emails: [], phones: [], words: 10, domElements: 10,
  customElements: [], counts: { title: 1, description: 1, viewport: 1 }, dupProps: [], scripts: [], inlineScripts: { count: 0, bytes: 0 },
  stylesheets: [], inlineStyles: 0, iframes: [], feeds: [], hreflang: [], hints: [], ...over,
});
const run = (c) => meta.run({}, { collected: c, util: hu, target: { site: 's.test' }, skip: (m) => { throw new Error(m); } });
const find = (r, re) => r.findings.find((f) => re.test(f.title));

test('places: forms, og:url vs canonical and relative share images name their URLs; detail unchanged', () => {
  const r = run(collected({
    og: { 'og:title': 'x', 'og:image': '/i.png', 'og:url': `${S}b` }, twitter: { 'twitter:card': 'summary', 'twitter:image': 'tw.png' },
    forms: [{ action: 'http://s.test/post', method: 'post', password: false, fields: 2 }, { action: 'https://forms.other.test/x', method: 'post', password: false, fields: 1 }],
  }));
  const http = find(r, /^Form submits over plain HTTP$/);
  assert.equal(http.detail, 'http://s.test/post');
  assert.deepEqual(http.places, [{ url: 'http://s.test/post' }]);
  assert.deepEqual(find(r, /^Form posts to a third party: forms\.other\.test$/).places, [{ url: 'https://forms.other.test/x' }]);
  const diff = find(r, /^og:url differs/);
  assert.equal(diff.detail, `${S}b vs ${S}a`);
  assert.deepEqual(diff.places, [{ url: `${S}b`, note: 'og:url' }, { url: `${S}a`, note: 'canonical' }]);
  const rel = find(r, /^Share image URL is relative/);
  assert.equal(rel.detail, '/i.png, tw.png');
  assert.deepEqual(rel.places, [{ url: '/i.png', note: 'og:image' }, { url: 'tw.png', note: 'twitter:image' }]);
  assertRuleIds(r.findings, 'meta');
  assert.equal(find(r, /^Form posts to a third party/).subject, 'https://forms.other.test/x');
  assert.equal(http.subject, 'http://s.test/post');
  for (const f of r.findings.filter((x) => !/Form|og:url|relative/.test(x.title))) assert.equal(f.places, undefined, f.title);
});

test('odd values: a very long form action is cut to 500 by normalize, and a "<" is escaped when drawn', async () => {
  const long = `http://s.test/${'deep/'.repeat(150)}post?q=<b>&r="1"`;
  const out = run(collected({ url: 'https://s.test/', forms: [{ action: long, method: 'post', password: false, fields: 1 }] }));
  const reading = createReading({ entries: [], target: makeTarget(S, 'S', S) });
  await runPlugins(reading, [{ id: 'n', name: 'N', phase: 'analyze', run: async () => out }], {});
  const f = reading.log._harplus.plugins.n.findings.find((x) => x.title === 'Form submits over plain HTTP');
  assert.equal(f.places[0].url, long.slice(0, 500));
  assert.equal(f.detail, long, 'the detail is unchanged');
  const drawn = String(h.places([{ url: 'http://s.test/p?q=<b>&r="1"' }]));
  assert.match(drawn, /q=&lt;b&gt;&amp;r=&quot;1&quot;/);
  assert.doesNotMatch(drawn, /<b>&/);
});

test('headline: Title, labelled so it reads on its own; "Title missing" when there is no title', () => {
  const head = (c) => run(c).summary.filter((s) => s.headline).map((s) => `${s.label} ${s.value}`);
  assert.deepEqual(head(collected()), ['Title A good page title here']);
  assert.deepEqual(head(collected({ title: '' })), ['Title missing']);
});

test('render: checks first with words; tag dumps closed; URLs as parts; long chip runs fold; only hidden headings listed', () => {
  const r = run(collected({
    title: 'Short', description: '', canonical: null, robots: 'noindex', og: { 'og:title': 'x', 'og:image': `${S}og.png`, 'og:type': 'website' }, twitter: {},
    feeds: [{ type: 'application/rss+xml', href: `${S}feed.xml` }, { type: 'application/atom+xml', href: `${S}atom.xml` }],
    forms: [{ action: `${S}search?q=1`, method: 'get', password: false, fields: 1 }],
    hints: [{ rel: 'preconnect', href: 'https://cdn.test/' }],
    customElements: Array.from({ length: 11 }, (_, i) => `x-el${i}`),
    headings: Array.from({ length: 9 }, (_, i) => ({ level: i ? 2 : 1, text: `H${i}`, ...(i % 4 === 3 ? { hidden: true } : {}) })),
  }));
  const out = String(meta.render({ status: 'ok', ...r }, h));
  assert.ok(out.indexOf('<ul class="checks">') < out.indexOf('<dl class="kv">'), 'checks before the values');
  for (const [label, state, note] of [['Title', 'poor', '5 characters'], ['Description', 'poor', 'missing'], ['Canonical', 'poor', 'missing'], ['Viewport', 'good', ''],
    ['Indexable', 'poor', 'noindex'], ['Open Graph', 'good', ''], ['Twitter card', 'poor', 'missing'], ['Structured data', 'good', ''], ['Favicon', 'good', '']]) {
    const word = state === 'good' ? 'pass' : 'fail';
    assert.ok(out.includes(`<span class="status" data-status="${state}"><span class="sr-only">(${word})</span>${label}${note ? `<small>${note}</small>` : ''}</span>`), `${label} ${word}`);
  }
  assert.match(out, /<details class="disclosure"><summary>Open Graph<span class="disclosure-meta">3 tags<\/span><\/summary>/, 'Open Graph tags closed with their count');
  assert.match(out, /<dt>og:image<\/dt><dd><a href="https:\/\/s\.test\/og\.png"[^>]*><span class="url"/, 'a URL value is linked as parts');
  assert.doesNotMatch(out, /Twitter \/ X card/, 'no empty Twitter section');
  assert.match(out, /<dt>url<\/dt><dd><a href="https:\/\/s\.test\/"/, 'organisation URLs linked');
  assert.match(out, /<dt>Feeds<\/dt><dd><ul class="plain"><li><a href="https:\/\/s\.test\/feed\.xml"[^>]*><span class="url"/, 'feeds are links, not one joined string');
  assert.match(out, /<td><span class="url" title="https:\/\/s\.test\/search\?q=1"><span class="url-host">s\.test<\/span><span class="url-path">\/search<\/span><span class="url-query">\?q=1<\/span>/, 'form action as parts');
  assert.match(out, /<span class="url-host">cdn\.test<\/span>/, 'hint href as parts');
  assert.equal((out.match(/class="tag">x-el/g) || []).length, 11);
  assert.match(out, /<summary>3 more<\/summary><div class="disclosure-body"><span class="tag">x-el8<\/span>/, 'chips fold past 8');
  // One home per fact: Content draws the outline; meta lists only the headings Content cannot show (H3 and H7).
  assert.match(out, /<details class="disclosure"><summary>Hidden headings<span class="disclosure-meta">2<\/span><\/summary><div class="disclosure-body"><ol class="outline"><li style="--level:2"><span class="lvl">h2<\/span>H3<\/li><li style="--level:2"><span class="lvl">h2<\/span>H7<\/li><\/ol>/);
  assert.doesNotMatch(out, /H0|<h4>Outline<\/h4>/, 'no full outline');
  assert.doesNotMatch(out, /undefined|NaN/);
  const none = String(meta.render({ status: 'ok', ...run(collected()) }, h));
  assert.doesNotMatch(none, /Hidden headings|class="outline"/, 'nothing hidden (or an older reading without the flag): nothing shown');
});

test('collect: headings carry hidden when not rendered or inside aria-hidden', () => {
  // collect() runs in the page; a minimal DOM stand-in checks the flag.
  const el = (tag, text, { shown = true, ariaHidden = false } = {}) => ({
    tagName: tag, textContent: text, checkVisibility: () => shown, closest: (s) => (s === '[aria-hidden="true"]' && ariaHidden ? {} : null),
  });
  const heads = [el('H1', 'Shown'), el('H2', 'Gone', { shown: false }), el('H2', 'Muted', { ariaHidden: true })];
  const saved = { document: globalThis.document, location: globalThis.location };
  globalThis.location = { hostname: 's.test', href: 'https://s.test/' };
  globalThis.document = {
    querySelector: () => null, getElementsByTagName: () => [], baseURI: 'https://s.test/', title: 't', characterSet: 'UTF-8', doctype: null, compatMode: 'CSS1Compat',
    documentElement: { getAttribute: () => null }, body: { innerText: '' },
    querySelectorAll: (s) => (s === 'h1,h2,h3,h4,h5,h6' ? heads : []),
  };
  try {
    assert.deepEqual(meta.collect().headings, [{ level: 1, text: 'Shown' }, { level: 2, text: 'Gone', hidden: true }, { level: 2, text: 'Muted', hidden: true }]);
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('glance: with an image, one check line with its size, then the seven previews open', () => {
  const d = run(collected()).data;
  const out = String(meta.glance({ status: 'ok', data: d }, h, { target: { finalUrl: `${S}a` }, results: { links: { data: { ogImage: { status: 200, width: 1200, height: 630, thumb: 'data:image/webp;base64,AAAA' } } } }, interactive: true }));
  assert.match(out, /<h4>Share previews<\/h4><ul class="checks"><li><span class="status" data-status="good"><span class="sr-only">\(pass\)<\/span>Share image<small>1200×630<\/small>/);
  assert.match(out, /<\/ul><div class="pv-grid">/, 'the previews are the answer: not behind a disclosure');
  assert.doesNotMatch(out, /<details/);
  assert.equal((out.match(/class="pv-card /g) || []).length, 7);
  assert.ok(out.indexOf('class="checks"') < out.indexOf('pv-card'));
  // Without Link check's result (not run yet, or turned off) a declared absolute image still passes.
  assert.match(String(meta.glance({ status: 'ok', data: d }, h, { target: { finalUrl: `${S}a` }, results: {} })), /data-status="good"><span class="sr-only">\(pass\)<\/span>Share image<\/span>/);
});

test('glance: the share image check agrees with the findings: an image that does not load, or a relative URL, fails', () => {
  const d = run(collected()).data;
  const at = (data, ogImage) => String(meta.glance({ status: 'ok', data }, h, { target: { finalUrl: `${S}a` }, results: ogImage ? { links: { data: { ogImage } } } : {} }));
  assert.match(at(d, { url: `${S}i.png`, status: 404 }), /data-status="poor"><span class="sr-only">\(fail\)<\/span>Share image<small>does not load \(404\)<\/small>/);
  assert.match(at(d, { url: `${S}i.png`, status: 0, error: 'network' }), /\(fail\)<\/span>Share image<small>does not load \(network\)<\/small>/);
  const rel = run(collected({ og: { 'og:title': 'x', 'og:image': '/i.png' } })).data;
  assert.match(at(rel, { url: `${S}i.png`, status: 200, width: 1200, height: 630 }), /\(fail\)<\/span>Share image<small>relative URL<\/small>/);
  assert.match(at(d, { url: `${S}i.png`, status: 404 }), /<div class="pv-grid">/, 'still declared, so the previews stay open');
});

test('glance: without an image, the one line says so and the text-only previews stay closed', () => {
  const d = run(collected({ og: { 'og:title': 'x' }, twitter: {} })).data;
  const out = String(meta.glance({ status: 'ok', data: d }, h, { target: { finalUrl: `${S}a` }, results: {} }));
  assert.match(out, /data-status="poor"><span class="sr-only">\(fail\)<\/span>No share image<small>og:image is not set<\/small>/);
  assert.match(out, /<details class="disclosure"><summary>Previews/);
  assert.doesNotMatch(out, /<details class="disclosure" open/);
  assert.doesNotMatch(out, /undefined|NaN/);
});

test('form findings: subjects are the action without query and numbered for repeats', () => {
  const form = (action, password = false) => ({ action, method: 'post', password, fields: 1 });
  const r = run(collected({ forms: [form('http://s.test/post?a=1'), form('http://s.test/post#x'), form(''), form('')] }));
  const subjects = r.findings.filter((f) => f.id === 'form-plain-http').map((f) => f.subject);
  assert.deepEqual(subjects, ['http://s.test/post', 'http://s.test/post#2']);
  assertRuleIds(r.findings, 'meta');
});
