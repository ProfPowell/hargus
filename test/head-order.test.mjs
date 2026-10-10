import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { parseHead, analyzeHead } from '../extension/plugins/head-order.js';
import { h } from '../extension/ui/render.js';

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
