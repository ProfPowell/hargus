import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { toDataUrl, readCapped, isPrivateHost } from '../extension/plugins/links.js';
import { getPlugins } from '../extension/plugins/index.js';
import { CASES, runCase, LONG, ODD } from './fixtures/links-cases.mjs';
import BASELINE from './fixtures/links-findings-baseline.json' with { type: 'json' };

// fetch stub: routes[url] = { status, finalUrl?, headFails?, headStatus? } ; records method per call
function stub(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    const r = routes[url];
    if (!r || r.throws) throw new TypeError('network');
    if (init.method === 'HEAD' && r.headFails) throw new TypeError('network');
    const status = init.method === 'HEAD' && r.headStatus ? r.headStatus : r.status;
    const res = new Response(init.method === 'HEAD' ? null : (r.body ?? ''), { status, headers: r.headers });
    Object.defineProperty(res, 'url', { value: r.finalUrl || url });
    Object.defineProperty(res, 'redirected', { value: !!r.finalUrl && r.finalUrl !== url });
    return res;
  };
}
// sources/missing are Content's linkTargets.sources and links.missing; a11y is the a11y-basics status, when given.
const ctx = ({ routes = {}, internal = [], external = [], sources, missing, a11y, og, options = {}, calls = [], progress = [] } = {}) => ({
  results: {
    content: { status: 'ok', data: { linkTargets: { internal, external, ...(sources ? { sources } : {}) }, ...(missing ? { links: { missing } } : {}) } },
    meta: { status: 'ok', data: { og: og ? { 'og:image': og } : {} } },
    ...(a11y ? { 'a11y-basics': { status: a11y } } : {}),
  },
  target: { url: 'https://s.test/' },
  options: { external: false, max: 150, ...options },
  fetch: stub(routes, calls),
  progress: (t) => progress.push(t),
  signal: new AbortController().signal,
  skip: (m) => { const e = new Error(m); e.name = 'SkipError'; throw e; },
});
const titles = (r) => r.findings.map((f) => f.title);

test('registered in enrich after content, Content area, options and disclosure', () => {
  assert.ok(getPlugins().some((p) => p.id === 'links'));
  assert.equal(plugin.phase, 'enrich');
  assert.equal(plugin.area, 'content');
  assert.deepEqual(plugin.after, ['content']);
  assert.deepEqual(plugin.options.map((o) => [o.key, o.default]), [['external', true], ['max', 2500]]);
  assert.match(plugin.disclosure, /every link on the page, on this site and elsewhere/);
});

test('skips with a reason when content data is missing', async () => {
  const c = ctx();
  delete c.results.content;
  await assert.rejects(() => plugin.run({}, c), /needs the Content plugin/);
});

test('HEAD first, GET fallback on 405; broken, redirected, insecure, timeouts', async () => {
  const calls = [];
  const progress = [];
  const r = await plugin.run({}, ctx({
    calls, progress,
    internal: ['https://s.test/ok', 'https://s.test/gone', 'https://s.test/old', 'https://s.test/nohead', 'https://s.test/down', 'https://s.test/insecure', 'https://s.test/logout'],
    routes: {
      'https://s.test/ok': { status: 200 },
      'https://s.test/gone': { status: 404 },
      'https://s.test/old': { status: 200, finalUrl: 'https://s.test/new' },
      'https://s.test/nohead': { status: 200, headStatus: 405 },
      'https://s.test/down': { throws: true },
      'https://s.test/insecure': { status: 200, finalUrl: 'http://s.test/insecure' },
    },
  }));
  assert.ok(calls.includes('HEAD https://s.test/nohead') && calls.includes('GET https://s.test/nohead'));
  assert.ok(!calls.some((c) => c.includes('/logout')), 'logout never requested');
  const t = titles(r);
  assert.ok(t.includes('1 broken internal link or asset (1 page)'));
  assert.ok(t.includes('Link redirects to insecure HTTP'));
  assert.ok(t.includes('1 links redirect — update them to their final URL'));
  assert.ok(t.includes('1 links timed out or failed to load'));
  assert.equal(r.findings.find((f) => f.id === 'broken-internal').severity, 'medium');
  assert.equal(r.findings.find((f) => f.title.startsWith('1 links timed out')).severity, 'info');
  assert.ok(r.findings.every((f) => f.category === 'content'));
  assert.equal(r.data.checked.find((x) => x.url === 'https://s.test/logout').skipped, 'looks like a sign-out or destructive link');
  assert.equal(progress.at(-1), 'Checking links 6/6');
  assert.match(r.summary[0].value, /^6 of 7 checked · 1 broken link or asset · 2 redirects$/);
});

test('12 broken internal links → one finding titled "12 broken internal links and assets (12 pages)"', async () => {
  const internal = Array(12).fill(0).map((_, i) => `https://s.test/x${i}`);
  const routes = Object.fromEntries(internal.map((u) => [u, { status: 500 }]));
  const r = await plugin.run({}, ctx({ internal, routes }));
  const f = r.findings.filter((x) => x.id === 'broken-internal');
  assert.equal(f.length, 1);
  assert.equal(f[0].title, '12 broken internal links and assets (12 pages)');
  assert.equal(f[0].severity, 'medium');
  assert.equal(f[0].count, 12);
  assert.ok(!titles(r).some((t) => t.startsWith('Broken link:') || /more broken links/.test(t)));
  assert.equal(r.data.broken.internal.length, 12);
});

test('an external broken link goes in the external finding', async () => {
  const r = await plugin.run({}, ctx({
    options: { external: true },
    internal: ['https://s.test/a'], external: ['https://o.test/gone'],
    routes: { 'https://s.test/a': { status: 200 }, 'https://o.test/gone': { status: 404 } },
  }));
  assert.deepEqual(r.findings.filter((f) => f.id?.startsWith('broken-')).map((f) => [f.id, f.title]),
    [['broken-external', '1 broken external link or asset (1 page)']]);
  assert.deepEqual(r.data.broken.external.map((x) => [x.url, x.status, x.kind]), [['https://o.test/gone', 404, 'page']]);
});

// A recorded page with one image that came back 404, asked for by the page on line 12 (0-based 11).
const PAGE = 'https://s.test/';
const recorded = () => ({ log: { _harplus: { target: { finalUrl: PAGE } }, entries: [
  { request: { url: PAGE }, response: { status: 200, content: { mimeType: 'text/html', text: '<html></html>' } }, _resourceType: 'document' },
  { request: { url: 'https://s.test/img/hero.png' }, response: { status: 404, content: {} }, _resourceType: 'image', _initiator: { type: 'parser', url: PAGE, lineNumber: 11 } },
] } });

test('a recorded 404 image is an internal item of kind image, even with external links off', async () => {
  const r = await plugin.run(recorded(), ctx({ options: { external: false } }));
  assert.deepEqual(r.data.broken.internal.map((x) => [x.url, x.status, x.kind]), [['https://s.test/img/hero.png', 404, 'image']]);
  assert.deepEqual(r.data.broken.internal[0].sources, [{ via: 'page', file: 'this page', line: 12 }]);
  assert.equal(r.findings.find((f) => f.id === 'broken-internal').title, '1 broken internal link or asset (1 image)');
});

test('the summary counts broken links and recorded broken assets, internal and external', async () => {
  const r = await plugin.run(recorded(), ctx({ internal: ['https://s.test/gone'], routes: { 'https://s.test/gone': { status: 404 } } }));
  assert.equal(r.summary[0].value, '1 of 1 checked · 2 broken links and assets · 0 redirects');
});

test('the on-page finding passes Content\'s missingCount and the page URL to the title and detail', async () => {
  const c = ctx({ missing: [{ href: 'https://s.test/#nope', raw: '#nope', text: 'Jump', region: 'main' }] });
  c.results.content.data.links.missingCount = 250;
  const r = await plugin.run({}, c);
  assert.equal(r.findings.find((f) => f.id === 'broken-page').title, '1 broken link on this page (first 1 checked)');
});

test('the on-page finding: present without a11y-basics, absent when it ran ok; data.broken.page listed either way', async () => {
  const missing = [{ href: 'https://s.test/#nope', raw: '#nope', text: 'Jump', region: 'main', selector: 'main > a' }];
  const without = await plugin.run({}, ctx({ missing }));
  assert.equal(without.findings.find((f) => f.id === 'broken-page')?.title, '1 broken link on this page');
  assert.equal(without.data.broken.page.length, 1);
  const failed = await plugin.run({}, ctx({ missing, a11y: 'error' }));
  assert.ok(failed.findings.some((f) => f.id === 'broken-page'));
  const ok = await plugin.run({}, ctx({ missing, a11y: 'ok' }));
  assert.ok(!ok.findings.some((f) => f.id === 'broken-page'));
  assert.deepEqual(ok.data.broken.page.map((x) => [x.url, x.status, x.kind]), [['https://s.test/#nope', 'no such id', 'anchor']]);
});

test('the result supersedes Content\'s missing anchors and Network\'s asset errors', async () => {
  const r = await plugin.run({}, ctx());
  assert.deepEqual(r.supersedes, ['content:missing-anchors', 'network:asset-errors']);
  assert.deepEqual(r.data.broken, { page: [], internal: [], external: [], others: [] });
});

test('older readings: no sources, no missing, no reading still group what Link check found', async () => {
  const r = await plugin.run(undefined, ctx({ internal: ['https://s.test/gone'], routes: { 'https://s.test/gone': { status: 410 } } }));
  assert.deepEqual(r.data.broken.internal.map((x) => [x.url, x.status, x.sources.length]), [['https://s.test/gone', 410, 0]]);
});

test('render: a broken-item details per item, with status, kind, URL, places and every source line, escaped', async () => {
  const { h } = await import('../extension/ui/render.js');
  const data = { checked: [{ url: 'https://s.test/team', status: 404, method: 'GET', ms: 5 }], ogImage: null, broken: {
    page: [{ url: 'https://s.test/#nope', status: 'no such id', kind: 'anchor', sources: [{ text: 'Jump', region: 'main', line: 9 }], moreSources: 0 }],
    internal: [
      { url: 'https://s.test/team', status: 404, kind: 'page', moreSources: 0, sources: [
        { text: 'Our team', region: 'nav', selector: 'nav > a', line: 41 },
        { text: 'Team', region: 'footer', note: 'added by a script' },
        { text: '<b>x</b>', region: 'main', note: 'source not in the recording' },
      ] },
      { url: 'https://s.test/img/a.png', status: 404, kind: 'image', moreSources: 2, sources: [
        { via: 'stylesheet', file: '/css/site.css', line: 212 },
        { via: 'page', file: 'this page', line: 88, region: 'main', selector: 'section.hero > img' },
        { via: 'script', file: '/js/x.js', line: 40 },
      ] },
    ],
    external: [],
  } };
  const out = String(plugin.render({ data }, h));
  assert.equal(out.match(/<details class="broken-item">/g).length, 3);
  for (const s of ['On this page', 'Internal', '404 · page · ', 'https://s.test/team', '3 places', '5 places', '1 place<',
    'no such id · anchor', '/css/site.css line 212', 'this page line 88 · main › section.hero &gt; img', 'loaded by /js/x.js line 40',
    '“<bdi>Our team</bdi>” · nav · line 41 · <code class="selector">nav &gt; a</code>', '“<bdi>Team</bdi>” · footer · <bdi>added by a script</bdi>', '“<bdi>&lt;b&gt;x&lt;/b&gt;</bdi>” · main · <bdi>source not in the recording</bdi>',
    'and 2 more places']) {
    assert.ok(out.includes(s), `${s} in render`);
  }
  assert.ok(!out.includes('<b>x</b>'), 'source text is escaped');
  // The groups are a level below "Broken"; the summary only toggles (no link in it), the link is in the body.
  assert.ok(out.includes('<h4>Broken</h4>') && out.includes('<h5>On this page</h5>') && out.includes('<h5>Internal</h5>'), 'group labels are h5 under the h4');
  assert.ok(!/<h4>(On this page|Internal|External)<\/h4>/.test(out), 'no group label at the Broken level');
  for (const m of out.matchAll(/<summary>([\s\S]*?)<\/summary>/g)) assert.ok(!m[1].includes('<a '), `no link in ${m[1]}`);
  assert.ok(out.includes('<p class="broken-url"><a href="https://s.test/team"'), 'the link is in the expanded body');
  assert.ok(!out.includes('External'), 'an empty group is omitted');
  assert.ok(out.indexOf('broken-item') < out.indexOf('<table'), 'broken above the table');
});

test('render: assets only other sites asked for sit in a closed Not counted section after the groups', async () => {
  const { h } = await import('../extension/ui/render.js');
  const ad = (u) => ({ url: u, status: 400, kind: 'image', moreSources: 0, sources: [{ via: 'page', file: 'sync.adnet.com/usync' }] });
  const data = { checked: [], ogImage: null, broken: {
    page: [], internal: [], external: [{ url: 'https://cdn.o.test/a.png', status: 404, kind: 'image', moreSources: 0, sources: [] }],
    others: [ad('https://px.ads.test/1'), ad('https://px.ads.test/2')],
  } };
  const out = String(plugin.render({ data }, h));
  assert.ok(out.includes('<details class="broken-others"><summary>Not counted: 2 broken requests made by other sites’ code</summary>'));
  assert.ok(out.includes('sync.adnet.com/usync'));
  assert.ok(out.indexOf('<h5>External</h5>') < out.indexOf('broken-others'), 'after the counted groups');
  const one = String(plugin.render({ data: { ...data, broken: { ...data.broken, external: [], others: [ad('https://px.ads.test/1')] } } }, h));
  assert.ok(one.includes('Not counted: 1 broken request made by other sites’ code'));
  assert.ok(one.includes('<h4>Broken</h4>'), 'Broken shows when only uncounted items exist');
  const none = String(plugin.render({ data: { ...data, broken: { ...data.broken, others: [] } } }, h));
  assert.ok(!none.includes('broken-others'));
});

test('run: an ad network’s broken sync pixel is not counted in the findings or summary', async () => {
  const sync = { startedDateTime: '2026-01-01T00:00:00Z', time: 1, request: { method: 'GET', url: 'https://px.ads.test/sync', headers: [] },
    response: { status: 400, headers: [], content: { size: 0, mimeType: '' } }, _resourceType: 'image', _initiator: { type: 'parser', url: 'https://sync.adnet.test/u' } };
  const reading = { log: { pages: [], entries: [{ startedDateTime: '2026-01-01T00:00:00Z', time: 1, request: { method: 'GET', url: 'https://s.test/', headers: [] },
    response: { status: 200, headers: [], content: { size: 0, mimeType: 'text/html' } }, _resourceType: 'document' }, sync] } };
  const r = await plugin.run(reading, ctx({}));
  assert.deepEqual(r.data.broken.others.map((x) => x.url), ['https://px.ads.test/sync']);
  assert.deepEqual(r.data.broken.external, []);
  assert.ok(!r.findings.some((f) => f.id === 'broken-external'));
  assert.match(r.summary[0].value, / 0 broken links and assets /);
});

test('external only when enabled; max caps the list', async () => {
  const calls = [];
  await plugin.run({}, ctx({ calls, options: { external: false }, internal: ['https://s.test/a'], external: ['https://o.test/'], routes: { 'https://s.test/a': { status: 200 }, 'https://o.test/': { status: 200 } } }));
  assert.ok(!calls.some((c) => c.includes('o.test')));
  const calls2 = [];
  await plugin.run({}, ctx({ calls: calls2, options: { external: true, max: 1 }, internal: ['https://s.test/a'], external: ['https://o.test/'], routes: { 'https://s.test/a': { status: 200 }, 'https://o.test/': { status: 200 } } }));
  assert.deepEqual(calls2, ['HEAD https://s.test/a']);
});

test('og:image: load failure is medium; no createImageBitmap (Node) → status only, no size finding', async () => {
  const bad = await plugin.run({}, ctx({ og: 'https://s.test/og.png', routes: {} }));
  assert.ok(titles(bad).includes('Open Graph image does not load'));
  assert.equal(bad.findings.find((f) => f.title === 'Open Graph image does not load').severity, 'medium');
  const good = await plugin.run({}, ctx({ og: 'https://s.test/og.png', routes: { 'https://s.test/og.png': { status: 200, body: 'xx' } } }));
  assert.equal(good.data.ogImage.status, 200);
  assert.equal(good.data.ogImage.width, undefined);
  assert.ok(!titles(good).some((x) => x.startsWith('Open Graph image')));
});

test('og:image smaller than 1200×630 → low', async () => {
  const saved = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({ width: 600, height: 315, close() {} });
  try {
    const r = await plugin.run({}, ctx({ og: 'https://s.test/og.png', routes: { 'https://s.test/og.png': { status: 200, body: 'xx' } } }));
    assert.ok(titles(r).includes('Open Graph image is 600×315 (1200×630 recommended)'));
    const f = r.findings.find((x) => x.title === 'Open Graph image is 600×315 (1200×630 recommended)');
    assert.equal(f.detail, 'https://s.test/og.png', 'detail unchanged');
    assert.deepEqual(f.places, [{ url: 'https://s.test/og.png', status: 200 }], 'the image is its place');
  } finally {
    if (saved) globalThis.createImageBitmap = saved; else delete globalThis.createImageBitmap;
  }
});

const delayed = (c, ms) => { const f = c.fetch; c.fetch = async (u, i) => { await new Promise((r) => setTimeout(r, ms)); return f(u, i); }; return c; };

test('time budget: unstarted URLs are skipped and reported', async () => {
  const internal = Array(30).fill(0).map((_, i) => `https://s.test/p${i}`);
  const routes = Object.fromEntries(internal.map((u) => [u, { status: 200 }]));
  const r = await plugin.run({}, delayed(ctx({ internal, routes, options: { budgetMs: 30 } }), 20));
  const skipped = r.data.checked.filter((x) => x.skipped === 'time budget');
  assert.ok(skipped.length > 0 && skipped.length < 30);
  assert.ok(titles(r).includes(`${skipped.length} links not checked (time budget)`));
  assert.equal(r.data.checked.length, 30);
});

test('a HEAD timeout is not retried with GET', async () => {
  const calls = [];
  const c = ctx({ internal: ['https://s.test/slow'] });
  c.fetch = async (u, i) => { calls.push(`${i.method} ${u}`); throw new DOMException('timed out', 'TimeoutError'); };
  const r = await plugin.run({}, c);
  assert.deepEqual(calls, ['HEAD https://s.test/slow']);
  assert.equal(r.data.checked[0].status, 0);
  assert.ok(r.data.checked[0].error);
});

test('abort stops the loop and silences progress', async () => {
  const internal = Array(30).fill(0).map((_, i) => `https://s.test/p${i}`);
  const routes = Object.fromEntries(internal.map((u) => [u, { status: 200 }]));
  const ac = new AbortController();
  const progress = [];
  const c = delayed(ctx({ internal, routes }), 10);
  c.signal = ac.signal;
  c.progress = (t) => { assert.ok(!ac.signal.aborted, 'progress after abort'); progress.push(t); if (progress.length === 2) ac.abort(); };
  const r = await plugin.run({}, c);
  assert.ok(progress.length >= 2 && progress.length < 30);
  assert.ok(r.data.checked.filter((x) => !x.skipped).length < 30);
});

test('401/403/429 are refusals, not broken links', async () => {
  const r = await plugin.run({}, ctx({
    internal: ['https://s.test/a', 'https://s.test/b', 'https://s.test/c', 'https://s.test/d'],
    routes: { 'https://s.test/a': { status: 401 }, 'https://s.test/b': { status: 403 }, 'https://s.test/c': { status: 429 }, 'https://s.test/d': { status: 404 } },
  }));
  assert.ok(titles(r).includes('3 links refused the check (401, 403 or 429)'));
  assert.deepEqual(r.data.broken.internal.map((x) => x.url), ['https://s.test/d']);
  assert.match(r.summary[0].value, /^4 of 4 checked · 1 broken link or asset · 0 redirects$/);
  assert.equal(r.data.checked.find((x) => x.url.endsWith('/b')).status, 403);
});

test('network error on HEAD falls back to GET', async () => {
  const calls = [];
  const r = await plugin.run({}, ctx({ calls, internal: ['https://s.test/h'], routes: { 'https://s.test/h': { status: 200, headFails: true } } }));
  assert.deepEqual(calls, ['HEAD https://s.test/h', 'GET https://s.test/h']);
  assert.equal(r.data.checked[0].status, 200);
});

test('relative og:image resolves against the final URL', async () => {
  const calls = [];
  const c = ctx({ calls, og: '/og.png', routes: { 'https://s.test/og.png': { status: 200, body: 'xx' } } });
  c.target = { finalUrl: 'https://s.test/page' };
  const r = await plugin.run({}, c);
  assert.deepEqual(calls, ['GET https://s.test/og.png']);
  assert.equal(r.data.ogImage.url, 'https://s.test/og.png');
});

test('og:image over 10 MB is not downloaded or measured', async () => {
  const c = ctx({ og: 'https://s.test/big.png' });
  c.fetch = async () => new Response('x', { status: 200, headers: { 'content-length': String(11 * 1024 * 1024) } });
  const r = await plugin.run({}, c);
  assert.equal(r.data.ogImage.tooLarge, true);
  assert.equal(r.data.ogImage.width, undefined);
});

test('unparseable URLs are skipped, not thrown', async () => {
  const r = await plugin.run({}, ctx({ internal: ['http://'] }));
  assert.equal(r.data.checked[0].skipped, 'not a valid URL');
});

test('og:image with a non-http(s) scheme is not fetched and raises no finding', async () => {
  for (const og of ['javascript:alert(1)', 'file:///etc/passwd']) {
    const calls = [];
    const r = await plugin.run({}, ctx({ calls, og }));
    assert.deepEqual(calls, []);
    assert.equal(r.data.ogImage.error, 'not http(s)');
    assert.equal(r.data.ogImage.status, 0);
    assert.ok(!titles(r).includes('Open Graph image does not load'));
  }
});

test('toDataUrl: chunked base64, no stack overflow on large buffers', () => {
  assert.equal(toDataUrl(new Uint8Array([104, 105]), 'image/webp'), 'data:image/webp;base64,aGk=');
  const big = new Uint8Array(300_000).fill(65);
  const out = toDataUrl(big, 'image/webp');
  assert.ok(out.startsWith('data:image/webp;base64,QUFB'));
  assert.equal(out.length, 'data:image/webp;base64,'.length + 400_000);
});

test('og:image: bytes recorded; >5 MB gives a low seo finding; thumbnail when canvas exists; none in Node', async () => {
  const url = 'https://s.test/og.png';
  const big = await plugin.run({}, ctx({ og: url, routes: { [url]: { status: 200, body: 'x'.repeat(10), headers: { 'content-length': String(6 * 1024 * 1024) } } } }));
  const f = big.findings.find((x) => x.title === 'Share image is 6.0 MB (X limits images to 5 MB)');
  assert.ok(f, titles(big).join(' | '));
  assert.equal(f.category, 'seo');
  assert.equal(f.severity, 'low');
  const plain = await plugin.run({}, ctx({ og: url, routes: { [url]: { status: 200, body: 'xx' } } }));
  assert.equal(plain.data.ogImage.thumb, undefined, 'no decoder in Node');
  const saved = { cib: globalThis.createImageBitmap, oc: globalThis.OffscreenCanvas };
  globalThis.OffscreenCanvas = class { getContext() { return { drawImage() {} }; } async convertToBlob() { return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }); } };
  try {
    globalThis.createImageBitmap = async () => ({ width: 1200, height: 630, close() {} });
    const r = await plugin.run({}, ctx({ og: url, routes: { [url]: { status: 200, body: 'xxxx' } } }));
    assert.equal(r.data.ogImage.width, 1200);
    assert.equal(r.data.ogImage.bytes, 4);
    assert.equal(r.data.ogImage.thumb, 'data:image/webp;base64,AQID');
    globalThis.createImageBitmap = async () => { throw new Error('undecodable'); };
    const bad = await plugin.run({}, ctx({ og: url, routes: { [url]: { status: 200, body: 'xxxx' } } }));
    assert.equal(bad.data.ogImage.bytes, 4);
    assert.equal(bad.data.ogImage.width, undefined);
    assert.equal(bad.data.ogImage.thumb, undefined);
  } finally {
    if (saved.cib) globalThis.createImageBitmap = saved.cib; else delete globalThis.createImageBitmap;
    if (saved.oc) globalThis.OffscreenCanvas = saved.oc; else delete globalThis.OffscreenCanvas;
  }
});

const OG = 'https://s.test/og.png';
const withCanvas = async (bmp, convert, fn) => {
  const saved = { cib: globalThis.createImageBitmap, oc: globalThis.OffscreenCanvas };
  const sizes = [];
  globalThis.createImageBitmap = async () => bmp;
  globalThis.OffscreenCanvas = class { constructor(w, h) { sizes.push([w, h]); } getContext() { return { drawImage() {} }; } convertToBlob = convert; };
  try { return await fn(sizes); } finally {
    if (saved.cib) globalThis.createImageBitmap = saved.cib; else delete globalThis.createImageBitmap;
    if (saved.oc) globalThis.OffscreenCanvas = saved.oc; else delete globalThis.OffscreenCanvas;
  }
};
const okBlob = async () => new Blob([new Uint8Array([1])], { type: 'image/webp' });

test('og:image over the cap by content-length keeps bytes and still raises the size finding', async () => {
  const r = await plugin.run({}, ctx({ og: OG, routes: { [OG]: { status: 200, body: 'x', headers: { 'content-length': String(12 * 1024 * 1024) } } } }));
  assert.equal(r.data.ogImage.tooLarge, true);
  assert.equal(r.data.ogImage.bytes, 12 * 1024 * 1024);
  assert.ok(titles(r).includes('Share image is 12.0 MB (X limits images to 5 MB)'));
});

test('readCapped: Blob under the cap, tooLarge with the count read over it', async () => {
  const small = await readCapped(new Response('abcd'), 10);
  assert.equal(small.size, 4);
  const over = await readCapped(new Response('abcdefghijkl'), 5);
  assert.equal(over.tooLarge, true);
  assert.ok(over.bytes > 5);
});

test('og:image without content-length: bytes from the body (Node and decoder paths)', async () => {
  const r = await plugin.run({}, ctx({ og: OG, routes: { [OG]: { status: 200, body: 'abcdef' } } }));
  assert.equal(r.data.ogImage.bytes, 6);
  const d = await withCanvas({ width: 10, height: 10, close() {} }, okBlob, () => plugin.run({}, ctx({ og: OG, routes: { [OG]: { status: 200, body: 'abcdef' } } })));
  assert.equal(d.data.ogImage.bytes, 6);
});

test('thumbnail size: 1200x630 -> 600x315, 300x200 unchanged', async () => {
  const run = (bmp) => withCanvas({ ...bmp, close() {} }, okBlob, async (sizes) => {
    await plugin.run({}, ctx({ og: OG, routes: { [OG]: { status: 200, body: 'xxxx' } } }));
    return sizes[0];
  });
  assert.deepEqual(await run({ width: 1200, height: 630 }), [600, 315]);
  assert.deepEqual(await run({ width: 300, height: 200 }), [300, 200]);
});

test('bitmap is closed and the size kept when the encode throws', async () => {
  let closed = 0;
  const r = await withCanvas({ width: 800, height: 400, close() { closed++; } }, async () => { throw new Error('encode'); },
    () => plugin.run({}, ctx({ og: OG, routes: { [OG]: { status: 200, body: 'xxxx' } } })));
  assert.equal(closed, 1);
  assert.equal(r.data.ogImage.width, 800);
  assert.equal(r.data.ogImage.height, 400);
  assert.equal(r.data.ogImage.thumb, undefined);
});

function stubH(routes, seen = []) {
  return async (url, init = {}) => {
    seen.push({ method: init.method || 'GET', url, accept: new Headers(init.headers).get('accept') });
    const r = routes[url];
    if (!r) throw new TypeError('network');
    const status = init.method === 'HEAD' ? (r.headStatus ?? r.status) : r.status;
    let reads = 0;
    const body = init.method === 'HEAD' ? null : new ReadableStream({ pull(c) { reads++; c.enqueue(new Uint8Array(10)); }, cancel() { r.cancelled = true; } }, { highWaterMark: 0 }); // no eager pull: reads counts only real reads
    const res = new Response(body, { status });
    Object.defineProperty(res, 'url', { value: url });
    Object.defineProperty(res, 'redirected', { value: false });
    r.reads = () => reads;
    return res;
  };
}
const ctxH = (routes, internal, seen) => ({ ...ctx({ internal }), fetch: stubH(routes, seen) });

test('every request sends a browser-like Accept header', async () => {
  const seen = [];
  await plugin.run({}, ctxH({ 'https://s.test/a': { status: 200 } }, ['https://s.test/a'], seen));
  assert.ok(seen.length && seen.every((s) => s.accept === 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'), JSON.stringify(seen));
});

test('HEAD 400 or 503 → GET decides; GET status and method recorded', async () => {
  const routes = {
    'https://s.test/gh': { headStatus: 400, status: 200 },
    'https://s.test/as': { headStatus: 503, status: 200 },
    'https://s.test/gone': { headStatus: 404, status: 404 },
  };
  const out = await plugin.run({}, ctxH(routes, Object.keys(routes), []));
  const by = Object.fromEntries(out.data.checked.map((c) => [c.url, c]));
  assert.deepEqual([by['https://s.test/gh'].status, by['https://s.test/gh'].method], [200, 'GET']);
  assert.deepEqual([by['https://s.test/as'].status, by['https://s.test/as'].method], [200, 'GET']);
  assert.deepEqual([by['https://s.test/gone'].status, by['https://s.test/gone'].method], [404, 'GET']);
  const t = titles(out);
  assert.deepEqual(out.data.broken.internal.map((x) => x.url), ['https://s.test/gone']);
  assert.ok(!t.some((x) => /\/gh|\/as/.test(x)), t.join(' | '));
});

test('a HEAD that succeeds is not retried; method HEAD', async () => {
  const seen = [];
  const out = await plugin.run({}, ctxH({ 'https://s.test/ok': { status: 200 } }, ['https://s.test/ok'], seen));
  assert.deepEqual(seen.map((s) => s.method), ['HEAD']);
  assert.equal(out.data.checked[0].method, 'HEAD');
});

test('GET retry does not download the body (Review Focus 2)', async () => {
  const routes = { 'https://s.test/big.pdf': { headStatus: 403, status: 404 } };
  await plugin.run({}, ctxH(routes, ['https://s.test/big.pdf'], []));
  assert.equal(routes['https://s.test/big.pdf'].reads(), 0, 'body never read');
  assert.ok(routes['https://s.test/big.pdf'].cancelled, 'body cancelled');
});

test('defaults: external links included, under the default limit', async () => {
  const internal = Array.from({ length: 160 }, (_, i) => `https://s.test/p${i}`);
  const external = ['https://other.test/x'];
  const routes = Object.fromEntries([...internal, ...external].map((u) => [u, { status: 200 }]));
  const c = ctx({ routes, internal, external, options: { external: undefined, max: undefined } });
  c.options = {}; // plugin defaults apply
  const out = await plugin.run({}, c);
  assert.equal(out.data.checked.filter((x) => !x.skipped).length, 161);
  assert.equal(out.summary.find((s) => s.label === 'Link check').value, '161 of 161 checked · 0 broken links and assets · 0 redirects');
});

test('per-host limit: never more than 4 in flight to one host; other hosts proceed (Review Focus 1)', async () => {
  const inflight = new Map();
  let peakA = 0;
  let otherDone = 0;
  const starts = [];
  const a = Array.from({ length: 200 }, (_, i) => `https://a.test/${i}`);
  const b = Array.from({ length: 10 }, (_, i) => `https://b.test/${i}`);
  const c = ctx({ internal: a, external: b, options: { external: true, max: 0 } });
  c.fetch = async (url, init = {}) => {
    const host = new URL(url).host;
    starts.push(host);
    inflight.set(host, (inflight.get(host) || 0) + 1);
    if (host === 'a.test') peakA = Math.max(peakA, inflight.get(host));
    await new Promise((r) => setTimeout(r, 2));
    inflight.set(host, inflight.get(host) - 1);
    if (host === 'b.test') otherDone++;
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'url', { value: url });
    Object.defineProperty(res, 'redirected', { value: false });
    return res;
  };
  const out = await plugin.run({}, c);
  assert.equal(peakA, 4, `peak for one host ${peakA}`);
  assert.equal(otherDone, 10);
  assert.ok(starts.lastIndexOf('b.test') < starts.lastIndexOf('a.test'), 'every b.test request started before the last a.test request: b was not stuck behind a');
  assert.equal(out.data.checked.filter((x) => !x.skipped).length, 210, 'all 210 finished');
});

test('links not reached in the time budget get an info finding and the summary shows N of M', async () => {
  const internal = Array.from({ length: 50 }, (_, i) => `https://s.test/p${i}`);
  const c = ctx({ internal, options: { budgetMs: 1 } });
  c.fetch = async (url) => { await new Promise((r) => setTimeout(r, 20)); const res = new Response(null, { status: 200 }); Object.defineProperty(res, 'url', { value: url }); Object.defineProperty(res, 'redirected', { value: false }); return res; };
  const out = await plugin.run({}, c);
  const f = out.findings.find((x) => /links not checked \(time budget\)$/.test(x.title));
  assert.ok(f, titles(out).join(' | '));
  assert.equal(f.severity, 'info');
  assert.match(f.detail, /^They were not tested — check again to test them\. /);
  assert.match(out.summary.find((s) => s.label === 'Link check').value, /^\d+ of 50 checked · /);
});

const okFetch = (calls = []) => async (url, init = {}) => {
  calls.push(`${init.method || 'GET'} ${url}`);
  const res = new Response(null, { status: 200 });
  Object.defineProperty(res, 'url', { value: url });
  Object.defineProperty(res, 'redirected', { value: false });
  return res;
};

test('content totals above the list length: the unqueued links are reported and counted in M', async () => {
  const internal = ['https://s.test/a', 'https://s.test/b', 'https://s.test/c'];
  const c = ctx({ internal, options: { max: 0 } });
  c.results.content.data.linkTargets.totals = { internal: 5007, external: 9 };
  c.fetch = okFetch();
  const out = await plugin.run({}, c);
  const f = out.findings.find((x) => x.title === '5004 links not checked (over the 5,000 link limit)');
  assert.ok(f, titles(out).join(' | '));
  assert.equal(f.severity, 'info');
  assert.match(f.detail, /The page reader keeps at most 5,000 links per list\./);
  assert.equal(out.summary[0].value, '3 of 5007 checked · 0 broken links and assets · 0 redirects', 'external totals ignored when external links are off');
});

test('older readings without totals: M falls back to the list lengths, no limit finding', async () => {
  const out = await plugin.run({}, { ...ctx({ internal: ['https://s.test/a'], options: { max: 0 } }), fetch: okFetch() });
  assert.equal(out.summary[0].value, '1 of 1 checked · 0 broken links and assets · 0 redirects');
  assert.ok(!titles(out).some((t) => /link limit/.test(t)));
});

test('a positive max: "2 of 5 checked" and the rest reported', async () => {
  const internal = Array.from({ length: 5 }, (_, i) => `https://s.test/m${i}`);
  const calls = [];
  const out = await plugin.run({}, { ...ctx({ internal, options: { max: 2 } }), fetch: okFetch(calls) });
  assert.equal(calls.length, 2);
  assert.equal(out.summary[0].value, '2 of 5 checked · 0 broken links and assets · 0 redirects');
  assert.ok(titles(out).includes('3 links not checked (over the 2 link limit)'), titles(out).join(' | '));
});

test('isPrivateHost: loopback, RFC 1918, link-local, .local and .internal', () => {
  const host = (u) => new URL(u).hostname;
  for (const u of ['http://localhost:8080/', 'http://127.0.0.1/', 'http://127.9.9.9/', 'http://[::1]/', 'http://10.1.2.3/', 'http://172.16.0.1/',
    'http://172.31.255.255/', 'http://192.168.1.1/', 'http://169.254.169.254/', 'http://[fe80::1]/', 'http://[febf::1]/', 'http://printer.local/', 'http://db.corp.internal/', 'http://2130706433/']) {
    assert.equal(isPrivateHost(host(u)), true, u);
  }
  for (const u of ['https://s.test/', 'http://172.15.0.1/', 'http://172.32.0.1/', 'http://192.169.0.1/', 'http://11.0.0.1/', 'http://[2001:db8::1]/', 'http://[fec0::1]/', 'https://local.example/', 'https://internal.example.com/']) {
    assert.equal(isPrivateHost(host(u)), false, u);
  }
});

test('a public page: private-network links are skipped, never fetched, and still count in M', async () => {
  const calls = [];
  const c = ctx({ calls, internal: ['https://s.test/a'], external: ['http://192.168.1.1/x', 'http://localhost:8080/'], options: { external: true, max: 0 }, routes: { 'https://s.test/a': { status: 200 } } });
  c.target = { finalUrl: 'https://s.test/' };
  const out = await plugin.run({}, c);
  assert.deepEqual(calls, ['HEAD https://s.test/a']);
  assert.equal(out.data.checked.find((x) => x.url === 'http://192.168.1.1/x').skipped, 'private network');
  assert.equal(out.data.checked.find((x) => x.url === 'http://localhost:8080/').skipped, 'private network');
  assert.equal(out.summary[0].value, '1 of 3 checked · 0 broken links and assets · 0 redirects');
});

test('429: no GET retry; the host\'s queued links are skipped as rate limited; other hosts still checked', async () => {
  const calls = [];
  const limited = Array.from({ length: 10 }, (_, i) => `https://r.test/${i}`);
  const others = ['https://s.test/a', 'https://s.test/b', 'https://s.test/c'];
  const routes = Object.fromEntries([...limited.map((u) => [u, { status: 429 }]), ...others.map((u) => [u, { status: 200 }])]);
  const out = await plugin.run({}, ctx({ calls, routes, internal: limited, external: others, options: { external: true, max: 0 } }));
  assert.ok(!calls.some((c) => c.startsWith('GET ')), calls.join(' | '));
  const reached = calls.filter((c) => c.includes('r.test'));
  assert.equal(reached.length, 4, 'only the requests already in flight (PER_HOST) reach the host');
  const skipped = out.data.checked.filter((x) => x.skipped === 'rate limited (429)');
  assert.equal(skipped.length, 6);
  assert.ok(skipped.every((x) => x.url.startsWith('https://r.test/')));
  for (const u of others) assert.ok(calls.includes(`HEAD ${u}`), u);
  const t = titles(out);
  assert.ok(t.includes('6 links not checked (rate limited by r.test)'), t.join(' | '));
  assert.ok(t.includes('4 links refused the check (401, 403 or 429)'), t.join(' | '));
  assert.equal(out.findings.find((f) => f.title.startsWith('6 links not checked')).severity, 'info');
  assert.equal(out.summary[0].value, '7 of 13 checked · 0 broken links and assets · 0 redirects');
});

test('https → http redirects: same-site stays medium and capped at 10; cross-site is one grouped low finding', async () => {
  const same = Array.from({ length: 12 }, (_, i) => `https://s.test/i${i}`);
  const cross = Array.from({ length: 12 }, (_, i) => `https://s.test/w${i}`);
  const routes = Object.fromEntries([
    ...same.map((u) => [u, { status: 200, finalUrl: u.replace('https:', 'http:') }]),
    ...cross.map((u, i) => [u, { status: 200, finalUrl: `http://waf.example/block?id=${i}` }]),
    ['https://s.test/www', { status: 200, finalUrl: 'http://www.s.test/www' }],
  ]);
  const out = await plugin.run({}, ctx({ routes, internal: [...same, ...cross, 'https://s.test/www'], options: { max: 0 } }));
  const sameF = out.findings.filter((f) => f.title === 'Link redirects to insecure HTTP');
  assert.equal(sameF.length, 10);
  assert.ok(sameF.every((f) => f.severity === 'medium'));
  const more = out.findings.find((f) => f.title === '…and 3 more links redirect to insecure HTTP');
  assert.ok(more, titles(out).join(' | '));
  assert.equal(more.severity, 'medium');
  const crossF = out.findings.filter((f) => /redirected to another site over HTTP/.test(f.title));
  assert.equal(crossF.length, 1, titles(out).join(' | '));
  assert.equal(crossF[0].title, '12 links were redirected to another site over HTTP (possibly a bot check)');
  assert.equal(crossF[0].severity, 'low');
  assert.equal(crossF[0].detail.split('; ').length, 10);
  assert.ok(crossF[0].detail.startsWith('https://s.test/w0 → http://waf.example/block?id=0'), crossF[0].detail);
  assert.ok(!titles(out).some((t) => /links redirect — update/.test(t)), 'insecure redirects are not also plain redirects');
  assert.equal(out.summary[0].value, '25 of 25 checked · 0 broken links and assets · 25 redirects');
});

test('a page on a private host: its private-network links are checked', async () => {
  const calls = [];
  const c = ctx({ calls, internal: ['http://localhost:3000/a'], external: ['http://127.0.0.1:8080/x'], options: { external: true, max: 0 },
    routes: { 'http://localhost:3000/a': { status: 200 }, 'http://127.0.0.1:8080/x': { status: 200 } } });
  c.target = { finalUrl: 'http://localhost:3000/' };
  const out = await plugin.run({}, c);
  assert.deepEqual(calls.sort(), ['HEAD http://127.0.0.1:8080/x', 'HEAD http://localhost:3000/a']);
  assert.ok(out.data.checked.every((x) => !x.skipped));
});

const bigCtx = (n, options) => {
  const internal = Array.from({ length: n }, (_, i) => `https://s.test/p${i}`);
  const c = ctx({ internal, options });
  c.fetch = okFetch();
  return c;
};

test('default limit: 2,600 targets with no options checks 2,500 and says how to go further', async () => {
  const c = bigCtx(2600, {});
  c.options = {};
  const out = await plugin.run({}, c);
  assert.equal(out.data.checked.filter((x) => !x.skipped).length, 2500);
  const f = out.findings.find((x) => x.title === '100 links not checked (over the 2,500 link limit)');
  assert.ok(f, titles(out).join(' | '));
  assert.match(f.detail, /Set "Most links to check" to 0 in the Link check options to check every link\./);
  assert.match(f.detail, /https:\/\/s\.test\/p2500/);
  assert.match(out.summary[0].value, /^2500 of 2600 checked · /);
});

test('max: 0 checks every link', async () => {
  const out = await plugin.run({}, bigCtx(2600, { max: 0 }));
  assert.equal(out.data.checked.filter((x) => !x.skipped).length, 2600);
  assert.ok(!titles(out).some((t) => /link limit/.test(t)));
});

test('max: undefined (an older saved setting) gives the 2,500 default', async () => {
  const out = await plugin.run({}, bigCtx(2600, { max: undefined }));
  assert.equal(out.data.checked.filter((x) => !x.skipped).length, 2500);
});

test('the finding names the limit that cut the list: user max first, content cap otherwise', async () => {
  const c = bigCtx(5000, { max: 100 });
  c.results.content.data.linkTargets.totals = { internal: 5007, external: 0 };
  const out = await plugin.run({}, c);
  const f = out.findings.find((x) => /link limit/.test(x.title));
  assert.equal(f.title, '4907 links not checked (over the 100 link limit)');
  assert.match(f.detail, /Most links to check/);
  assert.doesNotMatch(f.detail, /page reader/);
});

test('page reader anchors: unread anchors are reported without changing M', async () => {
  const c = bigCtx(3, { max: 0 });
  c.results.content.data.linkTargets.anchors = { total: 12000, read: 10000 };
  const out = await plugin.run({}, c);
  assert.ok(titles(out).includes('2000 more links on the page were not read (the page reader stops at 10,000)'), titles(out).join(' | '));
  assert.equal(out.summary[0].value, '3 of 3 checked · 0 broken links and assets · 0 redirects');
  const c2 = bigCtx(3, { max: 0 });
  c2.results.content.data.linkTargets.anchors = { total: 10000, read: 10000 };
  assert.ok(!titles(await plugin.run({}, c2)).some((t) => /not read/.test(t)));
});

test('only an exact 0 lifts the limit: negative, NaN and empty max fall back to 2,500', async () => {
  for (const max of [-5, NaN, '']) {
    const out = await plugin.run({}, bigCtx(2600, { max }));
    assert.equal(out.data.checked.filter((x) => !x.skipped).length, 2500, String(max));
  }
});

test('max between the list length and the true total names the content cap', async () => {
  const c = bigCtx(5000, { max: 5003 });
  c.results.content.data.linkTargets.totals = { internal: 5007, external: 0 };
  const out = await plugin.run({}, c);
  const f = out.findings.find((x) => /link limit/.test(x.title));
  assert.equal(f.title, '7 links not checked (over the 5,000 link limit)');
  assert.match(f.detail, /page reader keeps at most 5,000/);
  assert.doesNotMatch(f.detail, /set to 0/i);
});

test('run: grouped findings carry places through normalize, with the recorded entry; the panel is unchanged', async () => {
  const { runPlugins } = await import('../extension/core/plugin-host.js');
  const { h } = await import('../extension/ui/render.js');
  const reading = recorded();
  reading.log.entries.push({ request: { url: 'https://s.test/gone#top' }, response: { status: 404, content: {} }, _resourceType: 'other' });
  const c = ctx({ internal: ['https://s.test/gone', 'https://s.test/never'], routes: { 'https://s.test/gone': { status: 404 }, 'https://s.test/never': { status: 404 } } });
  // The check times each request with Date.now (the panel's Time column): hold the clock still so both runs render alike.
  const realNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  let direct;
  try {
    direct = await plugin.run(reading, c);
    await runPlugins(reading, [{ ...plugin, run: (rd) => plugin.run(rd, c) }], {});
  } finally { Date.now = realNow; }
  const result = reading.log._harplus.plugins.links;
  const f = result.findings.find((x) => x.id === 'broken-internal');
  assert.deepEqual(direct.data.broken.internal.map((x) => x.url), ['https://s.test/img/hero.png', 'https://s.test/gone', 'https://s.test/never']);
  assert.deepEqual(f.places, [
    { url: 'https://s.test/img/hero.png', status: 404, file: 'this page', line: 12, entry: 1 },
    { url: 'https://s.test/gone', status: 404, entry: 2 },
    { url: 'https://s.test/never', status: 404 },
  ]);
  const panel = String(plugin.render({ data: result.data }, h));
  assert.equal(panel, String(plugin.render({ data: direct.data }, h)));
  assert.ok(!panel.includes('place-code') && !panel.includes('class="places"'), 'the panel does not show places');
});

// ---- Plugin panels (phase 5): places on the other findings, the unchanged findings, the fold ----

test('findings: every field but places is unchanged from before places (Link check is enrich; score-check cannot replay it)', async () => {
  for (const [name, c] of Object.entries(CASES)) {
    const out = await runCase(plugin, c);
    assert.deepEqual(JSON.parse(JSON.stringify(out.findings.map(({ places, ...f }) => f))), BASELINE[name], name);
  }
});

test('places: redirects, refusals, failures and the share image name their links', async () => {
  const S = 'https://s.test/';
  const by = (r, re) => r.findings.find((f) => re.test(f.title));
  const base = await runCase(plugin, CASES.base);
  assert.deepEqual(by(base, /^Link redirects to insecure HTTP$/).places, [{ url: `${S}insecure`, note: 'redirects to http://s.test/insecure' }]);
  assert.deepEqual(by(base, /links redirect — update/).places, [{ url: `${S}old`, note: `redirects to ${S}new` }]);
  assert.deepEqual(by(base, /refused the check/).places, [{ url: `${S}private`, status: 403 }, { url: `${S}locked`, status: 401 }]);
  assert.deepEqual(by(base, /timed out or failed/).places, [{ url: `${S}down`, status: 'ERR' }]);
  assert.deepEqual(by(base, /^Open Graph image does not load$/).places, [{ url: `${S}og.png`, status: 500 }]);
  const red = await runCase(plugin, CASES.redirects);
  assert.deepEqual(by(red, /^…and 2 more links redirect/).places, [
    { url: `${S}i10`, note: 'redirects to http://s.test/i10' }, { url: `${S}i11`, note: 'redirects to http://s.test/i11' }]);
  const cross = by(red, /another site over HTTP/);
  assert.equal(cross.places.length, 12, 'every cross-site redirect, though the detail names 10');
  assert.deepEqual(cross.places[0], { url: `${S}w0`, note: 'redirects to http://waf.example/block?id=0' });
  assert.equal(by(red, /links redirect — update/).places.length, 3);
  const rate = await runCase(plugin, CASES['rate limited']);
  assert.deepEqual(by(rate, /rate limited by r\.test/).places, [4, 5, 6, 7, 8, 9].map((i) => ({ url: `https://r.test/${i}` })));
  assert.ok(by(rate, /refused the check/).places.every((p) => p.status === 429));
  const over = await runCase(plugin, CASES['over the limit']);
  assert.deepEqual(by(over, /over the 2 link limit/).places, [2, 3, 4, 5].map((i) => ({ url: `${S}m${i}` })));
  assert.deepEqual(by(over, /^Open Graph image does not load$/).places, [{ url: `${S}og-missing.png`, status: 'ERR' }]);
  const cap = await runCase(plugin, CASES['content cap']);
  assert.equal(by(cap, /over the 5,000 link limit/).places, undefined, 'past Content’s cap the links are counted, not kept');
  assert.deepEqual(by(cap, /^Share image is 6\.0 MB/).places, [{ url: `${S}og-big.png`, status: 200 }]);
});

test('odd values: 14 failures give 14 places (the detail names 10); a long URL is cut to 500; "<" is escaped when drawn', async () => {
  const { runPlugins } = await import('../extension/core/plugin-host.js');
  const { createReading, makeTarget } = await import('../extension/core/harplus.js');
  const { h } = await import('../extension/ui/render.js');
  const out = await runCase(plugin, CASES.odd);
  const reading = createReading({ entries: [], target: makeTarget('https://s.test/', 'S', 'https://s.test/') });
  await runPlugins(reading, [{ id: 'n', name: 'N', phase: 'analyze', run: async () => out }], {});
  const fs = reading.log._harplus.plugins.n.findings;
  const failed = fs.find((f) => /timed out or failed/.test(f.title));
  assert.equal(failed.places.length, 14);
  assert.equal(failed.detail.split(', ').length, 10);
  assert.equal(fs.find((f) => /links redirect — update/.test(f.title)).places[0].url, LONG.slice(0, 500));
  const refused = fs.find((f) => /refused/.test(f.title));
  assert.deepEqual(refused.places, [{ url: ODD, status: 403 }]);
  const drawn = String(h.places(refused.places));
  assert.match(drawn, /q=&lt;b&gt;&amp;r=&quot;1&quot;/);
  assert.doesNotMatch(drawn, /<b>&/);
});

test('time budget: every unchecked link is a place, matching the count in the title', async () => {
  const internal = Array(30).fill(0).map((_, i) => `https://s.test/p${i}`);
  const routes = Object.fromEntries(internal.map((u) => [u, { status: 200 }]));
  const r = await plugin.run({}, delayed(ctx({ internal, routes, options: { budgetMs: 30 } }), 20));
  const f = r.findings.find((x) => /time budget/.test(x.title));
  assert.equal(`${f.places.length} links not checked (time budget)`, f.title);
  assert.ok(f.places.every((p) => /^https:\/\/s\.test\/p\d+$/.test(p.url) && Object.keys(p).length === 1));
});

test('render: past 8 broken items the rest fold under "N more"; the summary shows the URL as parts, still without a link', async () => {
  const { h } = await import('../extension/ui/render.js');
  const item = (i) => ({ url: `https://s.test/gone/${i}?q=1`, status: 404, kind: 'page', moreSources: 0, sources: [{ text: `L${i}`, region: 'main' }] });
  const data = { checked: [], ogImage: null, broken: { page: [], internal: Array.from({ length: 12 }, (_, i) => item(i)), external: [item(99)], others: [] } };
  const out = String(plugin.render({ data }, h));
  assert.equal(out.match(/<details class="broken-item">/g).length, 13, 'every item is still a details.broken-item');
  const internal = out.slice(out.indexOf('<h5>Internal</h5>'), out.indexOf('<h5>External</h5>'));
  assert.equal((internal.split('<details class="disclosure fold">')[0].match(/<details class="broken-item">/g) || []).length, 8, 'eight open');
  assert.match(internal, /<details class="disclosure fold"><summary>4 more<\/summary><div class="disclosure-body"><details class="broken-item">/);
  const external = out.slice(out.indexOf('<h5>External</h5>'));
  assert.doesNotMatch(external, /disclosure fold/, 'one item does not fold');
  assert.match(out, /<summary>404 · page · <span class="url" title="https:\/\/s\.test\/gone\/0\?q=1"><span class="url-host">s\.test<\/span><span class="url-path">\/gone\/0<\/span><span class="url-query">\?q=1<\/span><\/span> · 1 place<\/summary>/);
  for (const m of out.matchAll(/<summary>([\s\S]*?)<\/summary>/g)) assert.ok(!m[1].includes('<a '), `no link in ${m[1]}`);
  const others = String(plugin.render({ data: { ...data, broken: { page: [], internal: [], external: [], others: Array.from({ length: 9 }, (_, i) => item(i)) } } }, h));
  assert.match(others, /<details class="broken-others"><summary>Not counted: 9 broken requests made by other sites’ code<\/summary>[\s\S]*<summary>1 more<\/summary>/);
});
