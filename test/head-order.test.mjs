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
    'low:A blocking script delays the CSS',
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
