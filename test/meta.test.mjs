import { test } from 'node:test';
import assert from 'node:assert/strict';
import meta from '../extension/plugins/meta.js';
import * as hu from '../extension/core/har-util.js';
import { h } from '../extension/ui/render.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';

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

test('headline: Title, labelled so it reads on its own; absent when there is no title', () => {
  const r = run(collected());
  assert.deepEqual(r.summary.filter((s) => s.headline).map((s) => `${s.label} ${s.value}`), ['Title A good page title here']);
  assert.ok(!run(collected({ title: '' })).summary.find((s) => s.label === 'Title').value);
});

test('render: checks first with words; tag dumps closed; URLs as parts; long chip runs and outlines fold', () => {
  const r = run(collected({
    title: 'Short', description: '', canonical: null, robots: 'noindex', og: { 'og:title': 'x', 'og:image': `${S}og.png`, 'og:type': 'website' }, twitter: {},
    feeds: [{ type: 'application/rss+xml', href: `${S}feed.xml` }, { type: 'application/atom+xml', href: `${S}atom.xml` }],
    forms: [{ action: `${S}search?q=1`, method: 'get', password: false, fields: 1 }],
    hints: [{ rel: 'preconnect', href: 'https://cdn.test/' }],
    customElements: Array.from({ length: 11 }, (_, i) => `x-el${i}`),
    headings: Array.from({ length: 9 }, (_, i) => ({ level: i ? 2 : 1, text: `H${i}` })),
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
  assert.match(out, /<summary>Outline · 9 headings<\/summary><div class="disclosure-body"><ol class="outline">/, 'the outline folds whole');
  assert.doesNotMatch(out, /undefined|NaN/);
  const small = String(meta.render({ status: 'ok', ...run(collected()) }, h));
  assert.doesNotMatch(small, /Outline ·/);
  assert.match(small, /<h4>Outline<\/h4>[\s\S]*<ol class="outline">/);
});

test('glance: with an image, one check line with its size, then the seven previews closed', () => {
  const d = run(collected()).data;
  const out = String(meta.glance({ status: 'ok', data: d }, h, { target: { finalUrl: `${S}a` }, results: { links: { data: { ogImage: { width: 1200, height: 630, thumb: 'data:image/webp;base64,AAAA' } } } }, interactive: true }));
  assert.match(out, /<h4>Share previews<\/h4><ul class="checks"><li><span class="status" data-status="good"><span class="sr-only">\(pass\)<\/span>Share image<small>1200×630<\/small>/);
  assert.match(out, /<details class="disclosure"><summary>Previews<span class="disclosure-meta">7 platforms<\/span><\/summary><div class="disclosure-body"><div class="pv-grid">/);
  assert.equal((out.match(/class="pv-card /g) || []).length, 7);
  assert.ok(out.indexOf('class="checks"') < out.indexOf('pv-card'));
});

test('glance: without an image, the one line says so and the text-only previews stay closed', () => {
  const d = run(collected({ og: { 'og:title': 'x' }, twitter: {} })).data;
  const out = String(meta.glance({ status: 'ok', data: d }, h, { target: { finalUrl: `${S}a` }, results: {} }));
  assert.match(out, /data-status="poor"><span class="sr-only">\(fail\)<\/span>No share image<small>og:image is not set<\/small>/);
  assert.match(out, /<details class="disclosure"><summary>Previews/);
  assert.doesNotMatch(out, /<details class="disclosure" open/);
  assert.doesNotMatch(out, /undefined|NaN/);
});
