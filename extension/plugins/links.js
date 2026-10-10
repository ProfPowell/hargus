// Link check: requests the page's own links (HEAD, no cookies) and its Open Graph image.

const SKIP = /log-?out|sign-?out|logoff|delete|remove|unsubscribe/i;
const CONCURRENCY = 6;
const TIMEOUT_MS = 10_000;

async function request(ctx, url, method) {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean));
  return ctx.fetch(url, { method, credentials: 'omit', redirect: 'follow', signal });
}

async function check(ctx, url) {
  const t0 = Date.now();
  let res;
  try {
    res = await request(ctx, url, 'HEAD');
    if (res.status === 405 || res.status === 501) res = null;
  } catch { res = null; }
  try {
    if (!res) {
      res = await request(ctx, url, 'GET');
      res.body?.cancel?.().catch(() => {});
    }
    return { url, status: res.status, finalUrl: res.url || url, redirected: !!res.redirected, ms: Date.now() - t0 };
  } catch (e) {
    return { url, status: 0, finalUrl: url, redirected: false, ms: Date.now() - t0, error: String(e?.message || e) };
  }
}

async function ogImage(ctx, url) {
  try {
    const res = await request(ctx, url, 'GET');
    if (!res.ok) return { url, status: res.status };
    const out = { url, status: res.status };
    if (typeof globalThis.createImageBitmap === 'function') {
      try {
        const bmp = await globalThis.createImageBitmap(await res.blob());
        out.width = bmp.width;
        out.height = bmp.height;
        bmp.close?.();
      } catch { /* SVG or undecodable: status only */ }
    }
    return out;
  } catch (e) {
    return { url, status: 0, error: String(e?.message || e) };
  }
}

async function run(reading, ctx) {
  const targets = ctx.results?.content?.data?.linkTargets;
  if (!targets) ctx.skip('needs the Content plugin’s page data — take a new reading in the extension');
  const list = [...targets.internal, ...(ctx.options.external ? targets.external : [])].slice(0, Number(ctx.options.max) || 150);
  const checked = [];
  const todo = [];
  for (const url of list) {
    if (!/^https?:/i.test(url)) checked.push({ url, skipped: 'not http(s)' });
    else if (SKIP.test(new URL(url).pathname + new URL(url).search)) checked.push({ url, skipped: 'looks like a sign-out or destructive link' });
    else todo.push(url);
  }
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const url = todo[next++];
      checked.push(await check(ctx, url));
      ctx.progress?.(`Checking links ${++done}/${todo.length}`);
    }
  };
  await Promise.all(Array(Math.min(CONCURRENCY, todo.length)).fill(0).map(worker));

  const findings = [];
  const add = (severity, title, detail) => findings.push({ severity, category: 'content', title, ...(detail ? { detail } : {}) });
  const ran = checked.filter((x) => !x.skipped);
  const broken = ran.filter((x) => x.status >= 400);
  const failed = ran.filter((x) => x.status === 0);
  const insecure = ran.filter((x) => x.status && x.status < 400 && x.redirected && x.url.startsWith('https:') && x.finalUrl.startsWith('http:'));
  const redirects = ran.filter((x) => x.status && x.status < 400 && x.redirected && !insecure.includes(x));
  const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
  for (const b of broken.slice(0, 10)) add('medium', `Broken link: ${b.status} ${pathOf(b.url)}`, b.url);
  if (broken.length > 10) add('medium', `…and ${broken.length - 10} more broken links`);
  for (const x of insecure) add('medium', 'Link redirects to insecure HTTP', `${x.url} → ${x.finalUrl}`);
  if (redirects.length) add('low', `${redirects.length} links redirect — update them to their final URL`, redirects.slice(0, 10).map((x) => `${x.url} → ${x.finalUrl}`).join('; '));
  if (failed.length) add('info', `${failed.length} links timed out or failed to load`, failed.slice(0, 10).map((x) => x.url).join(', '));

  const rawOg = ctx.results?.meta?.data?.og?.['og:image'];
  let ogUrl = null;
  try { ogUrl = rawOg ? new URL(rawOg, ctx.target?.finalUrl || ctx.target?.url || undefined).href : null; } catch { ogUrl = null; } // og:image may be relative
  const og = ogUrl ? await ogImage(ctx, ogUrl) : null;
  if (og && !(og.status >= 200 && og.status < 400)) add('medium', 'Open Graph image does not load', ogUrl);
  else if (og?.width && (og.width < 1200 || og.height < 630)) add('low', `Open Graph image is ${og.width}×${og.height} (1200×630 recommended)`, ogUrl);

  const order = (x) => (x.skipped ? 3 : x.status >= 400 || x.status === 0 ? 0 : x.redirected ? 1 : 2);
  checked.sort((a, b) => order(a) - order(b));
  return {
    data: { checked, ogImage: og },
    findings,
    summary: [{ label: 'Link check', value: `${ran.length} checked · ${broken.length} broken · ${redirects.length + insecure.length} redirects`, headline: true }],
  };
}

function render(r, h) {
  return h.html`${h.table(r.data.checked.map((x) => ({
    status: x.skipped ? `skipped: ${x.skipped}` : x.status || x.error || 'failed',
    url: h.link(x.url), final: x.redirected ? h.link(x.finalUrl) : '', ms: x.ms != null ? h.ms(x.ms) : '',
  })), [{ key: 'status', label: 'Status' }, { key: 'url', label: 'URL' }, { key: 'final', label: 'Final URL' }, { key: 'ms', label: 'Time' }])}
  ${r.data.ogImage ? h.sub('Open Graph image', h.kv([['URL', h.link(r.data.ogImage.url)], ['Status', r.data.ogImage.status || r.data.ogImage.error], ['Size', r.data.ogImage.width ? `${r.data.ogImage.width}×${r.data.ogImage.height}` : 'not measured']])) : ''}`;
}

export default {
  id: 'links',
  group: 'quality',
  area: 'content',
  name: 'Link check',
  version: '0.1.0',
  phase: 'enrich',
  after: ['content'],
  timeoutMs: 180_000,
  description: 'Checks the page’s links for broken pages and redirects, and the Open Graph image’s size.',
  disclosure: 'Requests each linked URL on this site (HEAD, no cookies). External links only when enabled.',
  tags: ['content'],
  options: [
    { key: 'external', label: 'Also check external links', type: 'checkbox', default: false },
    { key: 'max', label: 'Most links to check', type: 'number', default: 150 },
  ],
  run,
  render,
};
