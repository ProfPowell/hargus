import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetKind, ASSET_KINDS, isBrokenAsset, lineOf, hrefIndex, assetSources, linkSources, groupBroken, groupFinding } from '../extension/core/broken.js';
import { isThirdParty, mainEntry, siteOf } from '../extension/core/har-util.js';
import network from '../extension/plugins/network.js';

const entry = (url, status, type, extra = {}) => ({
  startedDateTime: '2026-01-01T00:00:00Z', time: 10,
  request: { method: 'GET', url, headers: [] },
  response: { status, httpVersion: 'h2', headers: [], content: { size: 0, mimeType: '' } },
  _resourceType: type, ...extra,
});
const reading = (entries) => ({
  log: { pages: [], entries, _harplus: { target: { finalUrl: 'https://example.com/' } } },
});
const ctx = { target: { site: 'example.com' }, util: { isThirdParty }, skip: (m) => { throw new Error(m); } };

test('ASSET_KINDS lists the kinds that can be broken', () => {
  assert.deepEqual(ASSET_KINDS, ['image', 'script', 'stylesheet', 'font', 'media', 'frame']);
});

test('assetKind gives the kind of each asset entry', () => {
  const main = mainEntry(reading([entry('https://example.com/', 200, 'document')]));
  for (const k of ['image', 'script', 'stylesheet', 'font', 'media']) {
    assert.equal(assetKind(entry(`https://example.com/x.${k}`, 404, k), main), k);
  }
});

test('assetKind: sub-frame documents are frames; main document, xhr and fetch are not assets', () => {
  const main = entry('https://example.com/', 200, 'document');
  assert.equal(assetKind(entry('https://example.com/frame.html', 404, 'document'), main), 'frame');
  assert.equal(assetKind(entry('https://example.com/frame.html', 404, 'iframe'), main), 'frame');
  assert.equal(assetKind(main, main), null);
  assert.equal(assetKind(entry('https://example.com/api', 500, 'xhr'), main), null);
  assert.equal(assetKind(entry('https://example.com/api', 500, 'fetch'), main), null);
  assert.equal(assetKind(entry('https://example.com/ping', 500, 'ping'), main), null);
});

test('assetKind: a redirect hop before the main document is not a frame', () => {
  const hop = entry('http://example.com/', 301, 'document');
  const main = entry('https://example.com/', 200, 'document');
  assert.equal(assetKind(hop, main), null);
});

test('Network splits asset errors from other request errors', () => {
  const r = reading([
    entry('https://example.com/', 200, 'document'),
    entry('https://example.com/a.png', 404, 'image'),
    entry('https://example.com/api', 500, 'xhr'),
    entry('https://example.com/f.woff2', 404, 'font'),
  ]);
  const { findings } = network.run(r, ctx);
  const a = findings.find((f) => f.id === 'asset-errors');
  const o = findings.find((f) => f.id === 'request-errors');
  assert.equal(a.title, '2 asset requests returned HTTP errors');
  assert.equal(o.title, '1 other request returned HTTP errors');
  for (const f of [a, o]) { assert.equal(f.severity, 'medium'); assert.equal(f.category, 'quality'); }
  assert.equal(a.evidence, '404 https://example.com/a.png\n404 https://example.com/f.woff2');
  assert.equal(o.evidence, '500 https://example.com/api');
});

test('Network emits each error finding only when non-empty', () => {
  const ids = (e) => network.run(reading([entry('https://example.com/', 200, 'document'), e]), ctx).findings.map((f) => f.id).filter(Boolean);
  assert.deepEqual(ids(entry('https://example.com/a.png', 404, 'image')), ['asset-errors']);
  assert.deepEqual(ids(entry('https://example.com/api', 500, 'xhr')), ['request-errors']);
});

test('isBrokenAsset: an asset with status 400 or more, 401 and 403 included', () => {
  const main = entry('https://example.com/', 200, 'document');
  assert.equal(isBrokenAsset(entry('https://example.com/a.png', 401, 'image'), main), true);
  assert.equal(isBrokenAsset(entry('https://example.com/b.png', 403, 'image'), main), true);
  assert.equal(isBrokenAsset(entry('https://example.com/c.png', 200, 'image'), main), false);
  assert.equal(isBrokenAsset(entry('https://example.com/d.png', 0, 'image'), main), false);
  assert.equal(isBrokenAsset(entry('https://example.com/api', 500, 'xhr'), main), false);
});

test('Network: a 404 image the browser also blocked (ORB) is only an asset error, not a failed request', () => {
  const r = reading([entry('https://example.com/', 200, 'document'), entry('https://example.com/a.png', 404, 'image', { _error: 'net::ERR_BLOCKED_BY_ORB' })]);
  const { findings } = network.run(r, ctx);
  assert.deepEqual(findings.map((f) => f.id || f.title), ['asset-errors']);
});

test('assetKind: with no main entry a document is never a frame', () => {
  assert.equal(assetKind(entry('https://example.com/', 200, 'document'), undefined), null);
  assert.equal(assetKind(entry('https://example.com/f.html', 404, 'iframe'), null), null);
  assert.equal(assetKind(entry('https://example.com/a.png', 404, 'image'), null), 'image');
});

/* ------------------------------------------------------- grouping and sources */

const PAGE = 'https://example.com/';
const withBody = (e, text) => ({ ...e, response: { ...e.response, content: { size: text.length, mimeType: 'text/html', text } } });
const lines = (n, at) => Array.from({ length: n }, (_, i) => at[i + 1] || `<p>line ${i + 1}</p>`).join('\n');

test('lineOf finds the 1-based line of the first needle found, also as &amp;', () => {
  const t = 'a\n<a href="/x?a=1&amp;b=2">\nc /y';
  assert.equal(lineOf(t, ['/y']), 3);
  assert.equal(lineOf(t, ['/nope', '/x?a=1&b=2']), 2);
  assert.equal(lineOf(t, ['/nope']), null);
  assert.equal(lineOf('', ['/y']), null);
});

test('hrefIndex maps each decoded <a href> to its lines, in order', () => {
  const t = '<a href="/x">\n<p>\n<A HREF = "/x">\n<a class="c" href="/q?a&amp;b">\n<a href=/u>';
  assert.deepEqual([...hrefIndex(t)], [['/x', [1, 3]], ['/q?a&b', [4]], ['/u', [5]]]);
  assert.deepEqual([...hrefIndex('')], []);
  assert.deepEqual([...hrefIndex('<p data-href="/x"><link href="/x"><abbr href="/x">')], []);
});

test('assetSources: a parser initiator on the page gives this page and lineNumber + 1', () => {
  const img = entry('https://example.com/a.png', 404, 'image', { _initiator: { type: 'parser', url: 'https://example.com/#top', lineNumber: 87 } });
  const har = reading([entry(PAGE, 200, 'document'), img]);
  assert.deepEqual(assetSources(img, har, PAGE), [{ via: 'page', file: 'this page', line: 88 }]);
});

test('assetSources: a CSS initiator with no line is found in the stylesheet body', () => {
  const css = withBody(entry('https://example.com/css/site.css', 200, 'stylesheet'), lines(220, { 212: '.hero { background: url(../img/hero.png) }' }));
  const img = entry('https://example.com/img/hero.png', 404, 'image', { _initiator: { type: 'parser', url: 'https://example.com/css/site.css' } });
  const har = reading([entry(PAGE, 200, 'document'), css, img]);
  assert.deepEqual(assetSources(img, har, PAGE), [{ via: 'stylesheet', file: '/css/site.css', line: 212 }]);
});

test('assetSources: a script initiator reads as script; no initiator is source unknown', () => {
  const js = entry('https://example.com/js/x.js', 200, 'script');
  const img = entry('https://example.com/a.png', 404, 'image', { _initiator: { type: 'script', url: 'https://example.com/js/x.js', lineNumber: 39 } });
  const har = reading([entry(PAGE, 200, 'document'), js, img]);
  assert.deepEqual(assetSources(img, har, PAGE), [{ via: 'script', file: '/js/x.js', line: 40 }]);
  assert.deepEqual(assetSources(entry('https://example.com/b.png', 404, 'image'), har, PAGE), [{ note: 'source unknown' }]);
});

test('linkSources: with no body recorded every note is source not in the recording', () => {
  const out = linkSources([{ raw: '/x', text: 'X', region: 'nav', selector: 'nav > a' }, { raw: '/x', text: 'X2' }], null);
  assert.deepEqual(out, [
    { text: 'X', region: 'nav', selector: 'nav > a', note: 'source not in the recording' },
    { text: 'X2', note: 'source not in the recording' },
  ]);
});

test('linkSources: relative and &amp; hrefs are found as written', () => {
  const html = '<html>\n<a href="../x">a</a>\n<a href=\'/x\'>b</a>\n<a href="x">c</a>\n<a href="/q?a=1&amp;b=2">d</a>';
  const out = linkSources([{ raw: '../x' }, { raw: '/x' }, { raw: 'x' }, { raw: '/q?a=1&b=2' }], html);
  assert.deepEqual(out.map((s) => s.line), [2, 3, 4, 5]);
});

test('linkSources: numeric &, uppercase HREF with spaces, and quotes as entities are found', () => {
  const html = '<html>\n<a href="/?p=1&#038;q=2">wp</a>\n<a HREF = "/caps">c</a>\n<a href="/n?a=1&#x26;b=2&#38;c">n</a>\n<a href=\'/s?q=&quot;x&#39;\'>s</a>';
  const out = linkSources([{ raw: '/?p=1&q=2' }, { raw: '/caps' }, { raw: '/n?a=1&b=2&c' }, { raw: '/s?q="x\'' }], html);
  assert.deepEqual(out.map((s) => s.line), [2, 3, 4, 5]);
});

test('linkSources: a <link rel=canonical> with the same href is not counted as a place', () => {
  const html = '<head>\n<link rel="canonical" href="/team">\n</head>\n<a href="/team">Team</a>';
  const out = linkSources([{ raw: '/team', text: 'Team' }, { raw: '/team', text: 'Again' }], html);
  assert.deepEqual(out, [{ text: 'Team', line: 4 }, { text: 'Again', note: 'added by a script' }]);
});

test('linkSources: a raw href cut at 500 characters matches by prefix', () => {
  const long = `/x?${'a'.repeat(600)}`;
  const out = linkSources([{ raw: long.slice(0, 500) }], `<p>\n<a href="${long}">x</a>`);
  assert.equal(out[0].line, 2);
});

test('linkSources: 2,000 sources on a 1 MB body finish well under a second', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => `<li><a href="/p${i}">Page ${i}</a> ${'x'.repeat(480)}</li>`);
  const html = `<html>\n${rows.join('\n')}`;
  assert.ok(html.length > 1_000_000);
  const t0 = performance.now();
  const out = linkSources(rows.map((_, i) => ({ raw: `/p${i}` })), html);
  assert.ok(performance.now() - t0 < 1000, `${performance.now() - t0} ms`);
  assert.equal(out[1999].line, 2001);
});

test('linkSources: 3 anchors with 2 in the source get two lines, then added by a script', () => {
  const html = '<html>\n<a href="/team">Our team</a>\n<p>\n<a href="/team">Team</a>';
  const out = linkSources([{ raw: '/team', text: 'Our team' }, { raw: '/team', text: 'Team' }, { raw: '/team', text: 'More' }], html);
  assert.deepEqual(out, [{ text: 'Our team', line: 2 }, { text: 'Team', line: 4 }, { text: 'More', note: 'added by a script' }]);
});

const grouped = (over = {}) => groupBroken({ checked: [], sources: {}, missing: [], har: reading([withBody(entry(PAGE, 200, 'document'), '<html>')]), pageUrl: PAGE, siteOf, ...over });

test('groupBroken: one internal 404 page linked from 3 places is one item with 3 sources', () => {
  const g = grouped({
    checked: [{ url: 'https://example.com/team', status: 404 }],
    sources: { 'https://example.com/team': { list: [{ raw: '/team', text: 'A' }, { raw: '/team', text: 'B' }, { raw: '/team', text: 'C' }], more: 0 } },
  });
  assert.equal(g.internal.length, 1);
  assert.deepEqual({ ...g.internal[0], sources: g.internal[0].sources.length }, { url: 'https://example.com/team', status: 404, kind: 'page', sources: 3, moreSources: 0 });
  assert.deepEqual(g.page, []);
  assert.deepEqual(g.external, []);
});

test('groupBroken: external, subdomain and refused links', () => {
  const g = grouped({ checked: [
    { url: 'https://other.org/x', status: 404 },
    { url: 'https://blog.example.com/y', status: 410 },
    { url: 'https://example.com/a', status: 401 },
    { url: 'https://example.com/b', status: 403 },
    { url: 'https://example.com/c', status: 429 },
    { url: 'https://example.com/d', status: 0, error: 'timeout' },
    { url: 'https://example.com/e', skipped: 'budget' },
  ] });
  assert.deepEqual(g.external.map((i) => i.url), ['https://other.org/x']);
  assert.deepEqual(g.internal.map((i) => i.url), ['https://blog.example.com/y']);
});

test('groupBroken: a recorded 404 image from CSS is internal, kind image', () => {
  const css = withBody(entry('https://example.com/css/site.css', 200, 'stylesheet'), 'a\nb { background: url(/img/x.png) }');
  const img = entry('https://example.com/img/x.png', 404, 'image', { _initiator: { type: 'parser', url: 'https://example.com/css/site.css' } });
  const g = grouped({ har: reading([entry(PAGE, 200, 'document'), css, img]) });
  assert.deepEqual(g.internal, [{ url: 'https://example.com/img/x.png', status: 404, kind: 'image', sources: [{ via: 'stylesheet', file: '/css/site.css', line: 2 }], moreSources: 0 }]);
});

test('groupBroken: a link to an asset that loaded fine is not listed even if Link check got 404', () => {
  const har = reading([entry(PAGE, 200, 'document'), entry('https://example.com/a.png', 200, 'image')]);
  const g = grouped({ har, checked: [{ url: 'https://example.com/a.png', status: 404 }], sources: { 'https://example.com/a.png': { list: [{ raw: '/a.png' }], more: 0 } } });
  assert.deepEqual(g.internal, []);
});

test('groupBroken: recorded 401 and 403 images count as broken', () => {
  const har = reading([entry(PAGE, 200, 'document'), entry('https://example.com/a.png', 401, 'image'), entry('https://example.com/b.png', 403, 'image')]);
  assert.deepEqual(grouped({ har }).internal.map((i) => [i.url, i.status]), [['https://example.com/a.png', 401], ['https://example.com/b.png', 403]]);
});

test('groupBroken: an asset that redirected (3xx) does not hide a link Link check found broken; a 304 is loaded', () => {
  const har = reading([entry(PAGE, 200, 'document'), entry('https://example.com/old.png', 301, 'image')]);
  const g = grouped({ har, checked: [{ url: 'https://example.com/old.png', status: 404 }] });
  assert.deepEqual(g.internal.map((i) => [i.url, i.status, i.kind]), [['https://example.com/old.png', 404, 'page']]);
  const cached = reading([entry(PAGE, 200, 'document'), entry('https://example.com/c.png', 304, 'image')]);
  assert.deepEqual(grouped({ har: cached, checked: [{ url: 'https://example.com/c.png', status: 404 }] }).internal, []);
});

test('groupBroken: a link to a recorded broken asset merges into one item of the asset kind', () => {
  const img = entry('https://example.com/a.png', 404, 'image', { _initiator: { type: 'parser', url: PAGE, lineNumber: 4 } });
  const har = reading([withBody(entry(PAGE, 200, 'document'), '<html>\n<a href="/a.png">pic</a>'), img]);
  const g = grouped({ har, checked: [{ url: 'https://example.com/a.png', skipped: 'budget' }], sources: { 'https://example.com/a.png': { list: [{ raw: '/a.png', text: 'pic' }], more: 0 } } });
  assert.equal(g.internal.length, 1);
  assert.equal(g.internal[0].kind, 'image');
  assert.equal(g.internal[0].status, 404);
  assert.deepEqual(g.internal[0].sources, [{ via: 'page', file: 'this page', line: 5 }, { text: 'pic', line: 2 }]);
});

test('groupBroken: missing anchors group by href into on-page items', () => {
  const l = (h, text) => ({ href: `${PAGE}#${h}`, raw: `#${h}`, text, aria: '', region: 'main', selector: 'main > a' });
  const har = reading([withBody(entry(PAGE, 200, 'document'), '<a href="#a">1</a>\n<a href="#b">2</a>\n<a href="#a">3</a>')]);
  const g = grouped({ har, missing: [l('a', 'One'), l('b', 'Two'), l('a', 'Three')] });
  assert.deepEqual(g.page.map((i) => [i.url, i.kind, i.status, i.sources.length]), [
    [`${PAGE}#a`, 'anchor', 'no such id', 2], [`${PAGE}#b`, 'anchor', 'no such id', 1],
  ]);
  assert.deepEqual(g.page[0].sources.map((s) => s.line), [1, 3]);
  assert.equal(g.page[0].sources[0].region, 'main');
});

test('groupBroken: an external asset only other sites’ code asked for is set aside, not counted', () => {
  const sync = entry('https://pixel.ads.net/sync', 400, 'image', { _initiator: { type: 'parser', url: 'https://sync.adnet.com/usync/?id=1' } });
  const g = grouped({ har: reading([entry(PAGE, 200, 'document'), sync]) });
  assert.deepEqual(g.external, []);
  assert.deepEqual(g.others, [{ url: 'https://pixel.ads.net/sync', status: 400, kind: 'image', sources: [{ via: 'page', file: 'sync.adnet.com/usync/?id=1' }], moreSources: 0 }]);
});

test('groupBroken: an external asset the site asked for counts, from the page, a subdomain script or an unknown source', () => {
  const cdn = entry('https://cdn.other.org/a.png', 404, 'image', { _initiator: { type: 'parser', url: PAGE, lineNumber: 0 } });
  const fromJs = entry('https://cdn.other.org/b.png', 404, 'image', { _initiator: { type: 'script', url: 'https://static.example.com/x.js' } });
  const unknown = entry('https://cdn.other.org/c.png', 404, 'image');
  const g = grouped({ har: reading([entry(PAGE, 200, 'document'), cdn, fromJs, unknown]) });
  assert.deepEqual(g.external.map((i) => i.url).sort(), ['https://cdn.other.org/a.png', 'https://cdn.other.org/b.png', 'https://cdn.other.org/c.png']);
  assert.deepEqual(g.others, []);
});

test('groupBroken: an external asset counts when the site asked for it once, or links to it', () => {
  const ad = { type: 'parser', url: 'https://sync.adnet.com/usync' };
  const twice = [entry('https://pixel.ads.net/a', 400, 'image', { _initiator: ad }), entry('https://pixel.ads.net/a', 400, 'image', { _initiator: { type: 'parser', url: PAGE } })];
  const linked = entry('https://pixel.ads.net/b', 404, 'image', { _initiator: ad });
  const g = grouped({
    har: reading([entry(PAGE, 200, 'document'), ...twice, linked]),
    sources: { 'https://pixel.ads.net/b': { list: [{ raw: 'https://pixel.ads.net/b', text: 'B' }], more: 0 } },
  });
  assert.deepEqual(g.external.map((i) => i.url), ['https://pixel.ads.net/a', 'https://pixel.ads.net/b']);
  assert.deepEqual(g.others, []);
});

test('groupBroken: with no page URL, or an initiator with no host, every broken asset counts', () => {
  const ad = entry('https://pixel.ads.net/a', 400, 'image', { _initiator: { type: 'parser', url: 'https://sync.adnet.com/u' } });
  const g = grouped({ har: reading([entry(PAGE, 200, 'document'), ad]), pageUrl: undefined });
  assert.deepEqual(g.others, []);
  assert.deepEqual(g.external.map((i) => i.url), ['https://pixel.ads.net/a']);
  const blob = entry('https://cdn.other.org/w.png', 404, 'image', { _initiator: { type: 'script', url: 'blob:https://example.com/1f2e' } });
  const srcdoc = entry('https://cdn.other.org/s.png', 404, 'image', { _initiator: { type: 'parser', url: 'about:srcdoc' } });
  const g2 = grouped({ har: reading([entry(PAGE, 200, 'document'), blob, srcdoc]) });
  assert.deepEqual(g2.external.map((i) => i.url).sort(), ['https://cdn.other.org/s.png', 'https://cdn.other.org/w.png']);
  assert.deepEqual(g2.others, []);
});

test('groupBroken: a link Link check found broken makes an ad-asked asset count, with no link sources (older readings)', () => {
  const ad = entry('https://pixel.ads.net/a', 404, 'image', { _initiator: { type: 'parser', url: 'https://sync.adnet.com/u' } });
  const g = grouped({ har: reading([entry(PAGE, 200, 'document'), ad]), checked: [{ url: 'https://pixel.ads.net/a', status: 404 }] });
  assert.deepEqual(g.external.map((i) => [i.url, i.kind]), [['https://pixel.ads.net/a', 'image']]);
  assert.deepEqual(g.others, []);
});

test('groupBroken: a page request redirected to another host’s 404 keeps the page as its initiator and counts', () => {
  const init = { type: 'parser', url: PAGE, lineNumber: 3 };
  const hop = entry('https://example.com/go.png', 302, 'image', { _initiator: init });
  const end = entry('https://cdn.other.org/gone.png', 404, 'image', { _initiator: init });
  const g = grouped({ har: reading([entry(PAGE, 200, 'document'), hop, end]) });
  assert.deepEqual(g.external.map((i) => i.url), ['https://cdn.other.org/gone.png']);
  assert.deepEqual(g.others, []);
});

test('groupBroken: a broken asset on the site’s own host counts whoever asked for it', () => {
  const img = entry('https://example.com/p.gif', 404, 'image', { _initiator: { type: 'script', url: 'https://ads.net/tag.js' } });
  const g = grouped({ har: reading([entry(PAGE, 200, 'document'), img]) });
  assert.deepEqual(g.internal.map((i) => i.url), ['https://example.com/p.gif']);
  assert.deepEqual(g.others, []);
});

test('assetSources: an initiator on another host is named with its host', () => {
  const img = entry('https://example.com/a.png', 404, 'image', { _initiator: { type: 'script', url: 'https://cdn.other.org/js/x.js', lineNumber: 2 } });
  const har = reading([entry(PAGE, 200, 'document'), entry('https://cdn.other.org/js/x.js', 200, 'script'), img]);
  assert.deepEqual(assetSources(img, har, PAGE), [{ via: 'script', file: 'cdn.other.org/js/x.js', line: 3 }]);
});

test('groupBroken: items sort by places, then status, then URL; sources cap at 20', () => {
  const src = (n, more = 0) => ({ list: Array.from({ length: n }, (_, i) => ({ raw: `/p${i}`, text: `t${i}` })), more });
  const g = grouped({
    checked: [
      { url: 'https://example.com/z', status: 404 }, { url: 'https://example.com/y', status: 500 },
      { url: 'https://example.com/x', status: 404 }, { url: 'https://example.com/w', status: 404 },
    ],
    sources: { 'https://example.com/z': src(1), 'https://example.com/y': src(1), 'https://example.com/x': src(1), 'https://example.com/w': src(20, 5) },
  });
  assert.deepEqual(g.internal.map((i) => i.url), ['https://example.com/w', 'https://example.com/x', 'https://example.com/z', 'https://example.com/y']);
  assert.equal(g.internal[0].sources.length, 20);
  assert.equal(g.internal[0].moreSources, 5);

  const imgs = Array.from({ length: 23 }, (_, i) => entry('https://example.com/a.png', 404, 'image', { _initiator: { type: 'parser', url: PAGE, lineNumber: i } }));
  const g2 = grouped({ har: reading([entry(PAGE, 200, 'document'), ...imgs]) });
  assert.equal(g2.internal[0].sources.length, 20);
  assert.equal(g2.internal[0].sources[19].line, 20);
  assert.equal(g2.internal[0].moreSources, 3);
});

const item = (url, kind, sources = [{ note: 'source unknown' }], moreSources = 0, status = 404) => ({ url, status, kind, sources, moreSources });

test('groupFinding: titles for one and many', () => {
  assert.equal(groupFinding('page', [item(`${PAGE}#a`, 'anchor', undefined, 0, 'no such id')]).title, '1 broken link on this page');
  assert.equal(groupFinding('page', [item(`${PAGE}#a`, 'anchor'), item(`${PAGE}#b`, 'anchor')]).title, '2 broken links on this page');
  assert.equal(groupFinding('internal', [item('https://example.com/a', 'page')]).title, '1 broken internal link or asset (1 page)');
  const many = [...Array.from({ length: 5 }, (_, i) => item(`https://example.com/p${i}`, 'page')), item('https://example.com/a.png', 'image'), item('https://example.com/b.png', 'image')];
  assert.equal(groupFinding('internal', many).title, '7 broken internal links and assets (5 pages, 2 images)');
  assert.equal(groupFinding('external', [item('https://cdn.org/f.woff2', 'font'), item('https://other.org/x', 'page')]).title, '2 broken external links and assets (1 page, 1 font)');
});

test('groupFinding: severity, category, extent and evidence capped at 10', () => {
  const items = Array.from({ length: 12 }, (_, i) => item(`https://example.com/p${i}`, 'page'));
  const f = groupFinding('internal', items);
  assert.equal(f.severity, 'medium');
  assert.equal(f.category, 'content');
  assert.equal(f.count, 12);
  assert.equal(f.unit, 'broken links and assets');
  assert.equal(f.evidence, items.slice(0, 10).map((i) => i.url).join('\n'));
  assert.equal(groupFinding('page', [item(`${PAGE}#a`, 'anchor')]).unit, 'broken links');
  assert.equal(groupFinding('internal', []), null);
});

test('groupFinding: detail lists the first three items with their first source', () => {
  const f = groupFinding('internal', [
    item('https://example.com/img/x.png', 'image', [{ via: 'stylesheet', file: '/css/site.css', line: 212 }]),
    item('https://example.com/team', 'page', [{ text: 'Our team', region: 'nav', selector: 'nav a', line: 41 }, { text: 'Team', line: 50 }], 1),
    item('https://example.com/a.png', 'image', [{ via: 'script', file: '/js/x.js', line: 40 }]),
    item('https://example.com/four', 'page'),
  ]);
  assert.equal(f.detail, [
    '404 /img/x.png — image, used in /css/site.css line 212',
    '404 /team — page, used in “Our team” · nav · line 41 …and in 2 more places',
    '404 /a.png — image, loaded by /js/x.js line 40',
  ].join('; '));
  const a = groupFinding('page', [item(`${PAGE}#gone`, 'anchor', [{ text: 'Jump', region: 'main', note: 'added by a script' }], 0, 'no such id')]);
  assert.equal(a.detail, 'no such id #gone — anchor, used in “Jump” · main · added by a script');
});

test('groupFinding: the detail shows the host whenever it is not the page host, a subdomain too', () => {
  const items = [item('https://blog.example.com/y', 'page'), item('https://example.com/x', 'page')];
  assert.equal(groupFinding('internal', items, { pageUrl: PAGE }).detail, '404 blog.example.com/y — page, source unknown; 404 /x — page, source unknown');
  assert.equal(groupFinding('external', [item('https://other.org/z', 'page')], { pageUrl: PAGE }).detail, '404 other.org/z — page, source unknown');
});

test('groupFinding: on this page says how many were checked when Content counted more missing links than it kept', () => {
  const its = [item(`${PAGE}#a`, 'anchor', [{ text: 'A' }], 150, 'no such id'), item(`${PAGE}#b`, 'anchor', [{ text: 'B' }], 48, 'no such id')];
  assert.equal(groupFinding('page', its, { missingCount: 230 }).title, '2 broken links on this page (first 200 checked)');
  assert.equal(groupFinding('page', its, { missingCount: 200 }).title, '2 broken links on this page');
  assert.equal(groupFinding('page', its).title, '2 broken links on this page');
  assert.equal(groupFinding('page', its, { missingCount: 230 }).count, 2);
});
