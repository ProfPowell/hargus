import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { parseHead, analyzeHead } from '../extension/plugins/head-order.js';
import { h } from '../extension/ui/render.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';

const doc = (head) => `<!doctype html><html><head>${head}</head><body><p>x</p></body></html>`;
const t = (r) => r.findings.map((f) => `${f.severity}:${f.title}`);

test('weights (Capo.js)', () => {
  const els = parseHead(doc(`<meta charset="utf-8"><meta name="viewport" content="w"><title>T</title>
    <link rel="preconnect" href="https://cdn.test"><script async src="a.js"></script><style>@import url(x.css);</style>
    <script src="sync.js"></script><script>var inline = 1;</script><link rel="stylesheet" href="app.css"><style>p{}</style>
    <link rel="preload" href="f.woff2" as="font"><script defer src="d.js"></script><script type="module" src="m.js"></script>
    <link rel="prefetch" href="next.html"><link rel="icon" href="i.png"><script type="application/ld+json">{}</script>
    <link rel="stylesheet" href="print.css" media="print"><!-- <script src="commented.js"></script> -->
    <template><link rel="stylesheet" href="t.css"></template>`));
  assert.deepEqual(els.map((e) => e.weight), [10, 10, 9, 8, 7, 6, 5, 5, 4, 4, 3, 2, 2, 1, 0, 0, 0]);
  assert.equal(els.find((e) => e.weight === 7).label, 'script async a.js');
});

test('in optimal order: no findings', () => {
  assert.deepEqual(t(analyzeHead(doc('<meta charset="utf-8"><title>T</title><link rel="stylesheet" href="a.css"><script defer src="d.js"></script>'))), []);
});

test('inversions, blocking script before CSS, late charset', () => {
  const r = analyzeHead(doc(`<title>T</title><script src="sync.js"></script><link rel="preconnect" href="https://cdn.test"><link rel="stylesheet" href="app.css"><meta charset="utf-8">`));
  assert.deepEqual(t(r), [
    'low:2 <head> elements out of optimal order', // preconnect after script; meta charset after everything
  ]);
  assert.match(r.findings[0].detail, /link preconnect cdn\.test after script sync\.js/);
  const late = analyzeHead(doc(`<title>${'x'.repeat(1100)}</title><meta charset="utf-8">`));
  assert.ok(t(late).includes('low:<meta charset> is not in the first 1024 bytes'));
  assert.ok(t(analyzeHead(doc('<title>T</title>'))).includes('low:<meta charset> is not in the first 1024 bytes'), 'missing charset');
  assert.ok(!t(analyzeHead(doc('<meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>T</title>'))).includes('low:<meta charset> is not in the first 1024 bytes'), 'http-equiv charset counts');
});

test('missing </head> and run(): base64 body, skip without HTML; glance has no NaN', () => {
  assert.equal(parseHead('<html><head><title>T</title><body>x').length, 1);
  const html = doc('<meta charset="utf-8"><title>T</title>');
  const entry = { request: { url: 'https://s.test/' }, response: { status: 200, content: { mimeType: 'text/html', size: html.length, text: Buffer.from(html).toString('base64'), encoding: 'base64' }, headers: [] }, _resourceType: 'document' };
  const reading = { log: { entries: [entry], _harplus: { target: { finalUrl: 'https://s.test/' } } } };
  const util = { mainEntry: (r) => r.log.entries[0] };
  const out = plugin.run(reading, { util, skip: (m) => { throw new Error(m); } });
  assert.deepEqual(out.findings, []);
  assert.doesNotMatch(String(plugin.glance({ status: 'ok', ...out }, h)), /NaN|undefined/);
  assert.throws(() => plugin.run({ log: { entries: [], _harplus: {} } }, { util: { mainEntry: () => undefined }, skip: (m) => { throw new Error(m); } }), /no document HTML/);
});

const LATE_CHARSET = 'low:<meta charset> is not in the first 1024 bytes';
const runOn = (content, headers = []) => plugin.run(
  { log: { entries: [{ request: { url: 'https://s.test/' }, response: { status: 200, content, headers }, _resourceType: 'document' }], _harplus: {} } },
  { util: { mainEntry: (r) => r.log.entries[0] }, skip: (m) => { throw new Error(m); } },
);

test('charset given by the HTTP header: a missing meta is fine, a late one still reported', () => {
  assert.ok(!t(analyzeHead(doc('<title>T</title>'), { headerCharset: true })).includes(LATE_CHARSET), 'missing meta, header charset');
  assert.ok(t(analyzeHead(doc(`<title>${'x'.repeat(1100)}</title><meta charset="utf-8">`), { headerCharset: true })).includes(LATE_CHARSET), 'late meta still reported');
  const html = doc('<title>T</title>');
  assert.ok(!t(runOn({ mimeType: 'text/html', text: html }, [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }])).includes(LATE_CHARSET), 'run() reads the header');
  assert.ok(t(runOn({ mimeType: 'text/html', text: html }, [{ name: 'content-type', value: 'text/html' }])).includes(LATE_CHARSET), 'no charset in the header');
});

test('run(): base64 with whitespace decodes; undecodable base64 skips', () => {
  const b64 = Buffer.from(doc('<meta charset="utf-8"><title>T</title>')).toString('base64').replace(/(.{20})/g, '$1\n ');
  assert.deepEqual(runOn({ mimeType: 'text/html', text: b64, encoding: 'base64' }).findings, []);
  assert.throws(() => runOn({ mimeType: 'text/html', text: '%%%not base64%%%', encoding: 'base64' }), /document HTML could not be decoded/);
});

const realistic = (scriptAndCss) => doc(`<meta charset="utf-8"><meta name="viewport" content="w"><title>T</title>
    <meta name="description" content="d"><meta property="og:title" content="t"><meta property="og:type" content="website">
    <meta property="og:url" content="u"><meta property="og:image" content="i"><meta property="og:description" content="d">
    <meta property="og:site_name" content="s"><meta property="og:locale" content="en"><meta property="og:image:alt" content="a">
    <meta property="og:image:width" content="1"><link rel="icon" href="i.png">
    ${scriptAndCss}`);
const css3 = '<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="b.css"><link rel="stylesheet" href="c.css">';

test('realistic head: sync script before CSS (Capo order) gives no findings', () => {
  const r = analyzeHead(realistic(`<script src="app.js"></script>${css3}`));
  assert.deepEqual(t(r), []);
  assert.equal(r.summary[0].value, 'optimal');
});

test('realistic head: sync script after CSS is one out-of-order element', () => {
  assert.deepEqual(t(analyzeHead(realistic(`${css3}<script src="app.js"></script>`))), ['low:1 <head> elements out of optimal order']);
});

test('head boundary ignores </head> and <body> inside script and style text', () => {
  const els = parseHead('<head><script>var a="<body>";</script><link rel=stylesheet href=a.css></head>');
  assert.deepEqual(els.map((e) => e.tag), ['script', 'link']);
  assert.equal(els[0].content, 'var a="<body>";');
  assert.equal(parseHead('<head><style>p::after{content:"</head>"}</style><link rel=stylesheet href=a.css></head>').length, 2);
});

test('script types, print media and unclosed template', () => {
  const w = (h) => parseHead(h).map((e) => e.weight);
  assert.deepEqual(w('<script type="importmap">{}</script><script type="speculationrules">{}</script><script type="text/template">x</script><script type="text/plain">x</script>'), [0, 0, 0, 0]);
  assert.deepEqual(w('<script type="text/javascript" src="x.js"></script><script src="y.js"></script>'), [5, 5]);
  assert.deepEqual(w('<link rel="stylesheet" href="a.css" media="not print"><link rel="stylesheet" href="b.css" media=" PRINT ">'), [4, 0]);
  assert.equal(parseHead('<head><title>T</title><template><link rel="stylesheet" href="t.css"></head><body>').length, 1);
});

/** A plugin's output as the saved reading keeps it (through normalize). */
const saved = async (out) => {
  const reading = createReading({ entries: [], target: makeTarget('https://s.test/', 'S', 'https://s.test/') });
  await runPlugins(reading, [{ id: 'n', name: 'N', phase: 'analyze', run: async () => out }], {});
  return reading.log._harplus.plugins.n;
};

test('out-of-order finding: one place per late element, its position and what it should come before; detail unchanged', () => {
  const r = analyzeHead(doc(`<meta charset="utf-8"><title>T</title><script src="sync.js"></script><link rel="preconnect" href="https://cdn.test"><link rel="stylesheet" href="app.css">`));
  const [f] = r.findings;
  assert.equal(f.detail, 'link preconnect cdn.test after script sync.js');
  assert.deepEqual(f.places, [{ text: 'link preconnect cdn.test', note: '#4, should come before script sync.js' }]);
  assert.equal(analyzeHead(doc(`<title>${'x'.repeat(1100)}</title><meta charset="utf-8">`)).findings.find((x) => /charset/.test(x.title)).places, undefined, 'the charset finding has none');
});

test('odd values: a very long script URL and a "<" in an href survive normalize, escaped when drawn', async () => {
  const long = `https://x.test/${'a'.repeat(600)}.js`;
  const out = analyzeHead(doc(`<meta charset="utf-8"><link rel="stylesheet" href="a.css"><script async src="${long}"></script><link rel="prefetch" href="p.js"><link rel="preload" href="a<b.css">`));
  const f = (await saved(out)).findings[0];
  assert.equal(f.places.length, 2);
  assert.equal(f.places[0].text.length, 500, 'capped');
  assert.equal(f.places[1].text, 'link preload a<b.css');
  const drawn = String(h.places(f.places));
  assert.match(drawn, /a&lt;b\.css/);
  assert.doesNotMatch(drawn, /a<b\.css/);
});

test('render: the answer first, then only the late elements; the full order is the glance\'s', () => {
  const out = analyzeHead(doc(`<meta charset="utf-8"><title>T</title><script src="sync.js"></script><link rel="preconnect" href="https://cdn.test"><link rel="stylesheet" href="app.css">`));
  const s = String(plugin.render({ status: 'ok', ...out }, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<table'), 'stats before the table');
  assert.match(s, /Elements<\/span><div class="stat-value">5/);
  assert.match(s, /Out of order<\/span><div class="stat-value">1<\/div><span class="stat-note"><span class="status" data-status="fair">Needs improvement/);
  assert.match(s, /<th scope="col">Should come before<\/th>/);
  assert.match(s, /<td>link preconnect cdn\.test<\/td><td>8<\/td><td>script sync\.js<\/td>/);
  assert.doesNotMatch(s, /app\.css/, 'in-order elements are not redrawn');
  const clean = String(plugin.render({ status: 'ok', ...analyzeHead(doc('<meta charset="utf-8"><title>T</title>')) }, h));
  assert.doesNotMatch(clean, /<table/);
  assert.match(clean, /data-status="good">Good/);
});

test('glance: late elements say so in words; past 8 elements the rest fold', () => {
  const out = analyzeHead(doc(`<link rel="stylesheet" href="a.css"><script async src="late.js"></script>${'<meta name="x" content="y">'.repeat(35)}`));
  const s = String(plugin.glance({ status: 'ok', ...out }, h));
  assert.match(s, /<b>7 · out of order<\/b>/);
  assert.doesNotMatch(s, /⚠/);
  assert.match(s, /<details class="disclosure fold"><summary>29 more<\/summary>/, '37 elements: 8 shown, 29 folded');
  assert.match(s, /aria-label="Head elements by weight \(continued\)"/, 'the folded chart has its own label');
  assert.equal(s.split('aria-label="Head elements by weight"').length, 2, 'the first label appears once');
  assert.equal((s.match(/class="row"/g) || []).length, 37, 'every element is drawn, none dropped');
  assert.doesNotMatch(String(plugin.glance({ status: 'ok', ...analyzeHead(doc('<title>T</title>')) }, h)), /fold/);
});

test('headline reads on its own', () => {
  const s = (html) => analyzeHead(doc(html)).summary.find((x) => x.headline);
  const late = s('<link rel="stylesheet" href="a.css"><script async src="x.js"></script>');
  assert.equal(`${late.label} ${late.value}`, '<head> order 1 out of order');
  const ok = s('<title>T</title>');
  assert.equal(`${ok.label} ${ok.value}`, '<head> order optimal');
});
