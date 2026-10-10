import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../extension/plugins/links.js';
import { getPlugins } from '../extension/plugins/index.js';

// fetch stub: routes[url] = { status, finalUrl?, headFails?, headStatus? } ; records method per call
function stub(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    const r = routes[url];
    if (!r || r.throws) throw new TypeError('network');
    if (init.method === 'HEAD' && r.headFails) throw new TypeError('network');
    const status = init.method === 'HEAD' && r.headStatus ? r.headStatus : r.status;
    const res = new Response(init.method === 'HEAD' ? null : (r.body ?? ''), { status });
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
