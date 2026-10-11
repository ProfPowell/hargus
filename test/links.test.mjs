import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { toDataUrl } from '../extension/plugins/links.js';
import { getPlugins } from '../extension/plugins/index.js';

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
const ctx = ({ routes = {}, internal = [], external = [], og, options = {}, calls = [], progress = [] } = {}) => ({
  results: {
    content: { status: 'ok', data: { linkTargets: { internal, external } } },
    meta: { status: 'ok', data: { og: og ? { 'og:image': og } : {} } },
  },
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
  assert.deepEqual(plugin.options.map((o) => [o.key, o.default]), [['external', false], ['max', 150]]);
  assert.match(plugin.disclosure, /HEAD, no cookies/);
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
  assert.ok(t.includes('Broken link: 404 /gone'));
  assert.ok(t.includes('Link redirects to insecure HTTP'));
  assert.ok(t.includes('1 links redirect — update them to their final URL'));
  assert.ok(t.includes('1 links timed out or failed to load'));
  assert.equal(r.findings.find((f) => f.title === 'Broken link: 404 /gone').severity, 'medium');
  assert.equal(r.findings.find((f) => f.title.startsWith('1 links timed out')).severity, 'info');
  assert.ok(r.findings.every((f) => f.category === 'content'));
  assert.equal(r.data.checked.find((x) => x.url === 'https://s.test/logout').skipped, 'looks like a sign-out or destructive link');
  assert.equal(progress.at(-1), 'Checking links 6/6');
  assert.match(r.summary[0].value, /^6 checked · 1 broken · 2 redirects$/);
});

test('more than 10 broken links: 10 findings plus one "and N more"', async () => {
  const internal = Array(13).fill(0).map((_, i) => `https://s.test/x${i}`);
  const routes = Object.fromEntries(internal.map((u) => [u, { status: 500 }]));
  const r = await plugin.run({}, ctx({ internal, routes }));
  assert.equal(r.findings.filter((f) => f.title.startsWith('Broken link:')).length, 10);
  assert.ok(titles(r).includes('…and 3 more broken links'));
});

test('external only when enabled; max caps the list', async () => {
  const calls = [];
  await plugin.run({}, ctx({ calls, internal: ['https://s.test/a'], external: ['https://o.test/'], routes: { 'https://s.test/a': { status: 200 }, 'https://o.test/': { status: 200 } } }));
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
  assert.ok(titles(r).includes(`${skipped.length} links not checked (time limit)`));
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
  assert.equal(r.findings.filter((f) => f.title.startsWith('Broken link:')).length, 1);
  assert.match(r.summary[0].value, /^4 checked · 1 broken · 0 redirects$/);
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
