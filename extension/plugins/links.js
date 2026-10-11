// Link check: requests the page's own links (HEAD, no cookies) and its Open Graph image.

const SKIP = /log-?out|sign-?out|logoff|delete|remove|unsubscribe/i;
const CONCURRENCY = 6;
const TIMEOUT_MS = 10_000;
const BUDGET_MS = 150_000; // stop starting new requests well inside the plugin's 180 s timeoutMs
const MAX_OG_BYTES = 10 * 1024 * 1024;
const THUMB_WIDTH = 600;
const MAX_SHARE_BYTES = 5_242_880; // X's limit for share images
const cancel = (res) => res?.body?.cancel?.().catch(() => {});

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
  } catch (e) {
    // a timed-out or aborted HEAD is not retried; other network errors fall back to GET
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return { url, status: 0, finalUrl: url, redirected: false, ms: Date.now() - t0, error: String(e?.message || e) };
    }
    res = null;
  }
  try {
    if (!res) {
      res = await request(ctx, url, 'GET');
      cancel(res);
    }
    return { url, status: res.status, finalUrl: res.url || url, redirected: !!res.redirected, ms: Date.now() - t0 };
  } catch (e) {
    return { url, status: 0, finalUrl: url, redirected: false, ms: Date.now() - t0, error: String(e?.message || e) };
  }
}

/** Bytes → data URL, base64-encoded in 32 KB chunks (no argument-count limits). */
export function toDataUrl(bytes, type) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

/** Reads a response body up to max bytes: a Blob, or { tooLarge: true, bytes } once it passes max. */
export async function readCapped(res, max) {
  if (!res.body?.getReader) return res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) { reader.cancel().catch(() => {}); return { tooLarge: true, bytes }; }
    chunks.push(value);
  }
  return new Blob(chunks, { type: res.headers?.get('content-type') || '' });
}

async function thumbnail(bmp) {
  const scale = Math.min(1, THUMB_WIDTH / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const hh = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new globalThis.OffscreenCanvas(w, hh);
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, hh);
  const t = await canvas.convertToBlob({ type: 'image/webp', quality: 0.7 });
  return toDataUrl(new Uint8Array(await t.arrayBuffer()), t.type || 'image/webp');
}

async function ogImage(ctx, url) {
  try {
    const res = await request(ctx, url, 'GET');
    if (!res.ok) { cancel(res); return { url, status: res.status }; }
    const out = { url, status: res.status };
    const declared = Number(res.headers?.get('content-length')) || 0;
    if (declared > MAX_OG_BYTES) { cancel(res); return { ...out, bytes: declared, tooLarge: true }; }
    const canDecode = typeof globalThis.createImageBitmap === 'function';
    if (declared && !canDecode) { cancel(res); return { ...out, bytes: declared }; }
    const body = await readCapped(res, MAX_OG_BYTES);
    if (body.tooLarge) return { ...out, bytes: Math.max(declared, body.bytes), tooLarge: true };
    out.bytes = Math.max(declared, body.size);
    if (!canDecode) return out;
    let bmp;
    try {
      bmp = await globalThis.createImageBitmap(body);
      out.width = bmp.width;
      out.height = bmp.height;
      if (typeof globalThis.OffscreenCanvas === 'function' && bmp.width > 0) {
        try { out.thumb = await thumbnail(bmp); } catch { /* encode failed: keep the size */ }
      }
    } catch { /* SVG or undecodable: no size, no thumbnail */ } finally {
      bmp?.close?.();
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
    let u;
    try { u = new URL(url); } catch { checked.push({ url, skipped: 'not a valid URL' }); continue; }
    if (!/^https?:$/i.test(u.protocol)) checked.push({ url, skipped: 'not http(s)' });
    else if (SKIP.test(u.pathname + u.search)) checked.push({ url, skipped: 'looks like a sign-out or destructive link' });
    else todo.push(url);
  }
  // budgetMs is an undocumented option used only by tests to shrink the run deadline
  const deadline = Date.now() + (Number(ctx.options.budgetMs) || BUDGET_MS);
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      if (ctx.signal?.aborted || Date.now() > deadline) break;
      const url = todo[next++];
      checked.push(await check(ctx, url));
      done++;
      if (!ctx.signal?.aborted) ctx.progress?.(`Checking links ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array(Math.min(CONCURRENCY, todo.length)).fill(0).map(worker));
  const notStarted = todo.slice(next);
  for (const url of notStarted) checked.push({ url, skipped: 'time budget' });

  const findings = [];
  const add = (severity, title, detail, category = 'content') => findings.push({ severity, category, title, ...(detail ? { detail } : {}) });
  const ran = checked.filter((x) => !x.skipped);
  const refused = ran.filter((x) => [401, 403, 429].includes(x.status));
  const broken = ran.filter((x) => x.status >= 400 && !refused.includes(x));
  const failed = ran.filter((x) => x.status === 0);
  const insecure = ran.filter((x) => x.status && x.status < 400 && x.redirected && x.url.startsWith('https:') && x.finalUrl.startsWith('http:'));
  const redirects = ran.filter((x) => x.status && x.status < 400 && x.redirected && !insecure.includes(x));
  const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
  for (const b of broken.slice(0, 10)) add('medium', `Broken link: ${b.status} ${pathOf(b.url)}`, b.url);
  if (broken.length > 10) add('medium', `…and ${broken.length - 10} more broken links`);
  for (const x of insecure) add('medium', 'Link redirects to insecure HTTP', `${x.url} → ${x.finalUrl}`);
  if (redirects.length) add('low', `${redirects.length} links redirect — update them to their final URL`, redirects.slice(0, 10).map((x) => `${x.url} → ${x.finalUrl}`).join('; '));
  if (refused.length) add('info', `${refused.length} links refused the check (401, 403 or 429)`, refused.slice(0, 10).map((x) => x.url).join(', '));
  if (notStarted.length) add('info', `${notStarted.length} links not checked (time limit)`);
  if (failed.length) add('info', `${failed.length} links timed out or failed to load`, failed.slice(0, 10).map((x) => x.url).join(', '));

  const rawOg = ctx.results?.meta?.data?.og?.['og:image'];
  let ogUrl = null;
  try { ogUrl = rawOg ? new URL(rawOg, ctx.target?.finalUrl || ctx.target?.url || undefined).href : null; } catch { ogUrl = null; } // og:image may be relative
  const httpOg = ogUrl && /^https?:$/.test(new URL(ogUrl).protocol);
  const og = !ogUrl ? null : httpOg ? await ogImage(ctx, ogUrl) : { url: ogUrl, status: 0, error: 'not http(s)' };
  if (og && httpOg && !(og.status >= 200 && og.status < 400)) add('medium', 'Open Graph image does not load', ogUrl);
  else if (og?.width && (og.width < 1200 || og.height < 630)) add('low', `Open Graph image is ${og.width}×${og.height} (1200×630 recommended)`, ogUrl);
  if (og?.bytes > MAX_SHARE_BYTES) add('low', `Share image is ${(og.bytes / 1_048_576).toFixed(1)} MB (X limits images to 5 MB)`, ogUrl, 'seo');

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
  disclosure: 'Requests each linked URL on this site (HEAD, no cookies) and the page\'s Open Graph image. External links only when enabled.',
  tags: ['content'],
  options: [
    { key: 'external', label: 'Also check external links', type: 'checkbox', default: false },
    { key: 'max', label: 'Most links to check', type: 'number', default: 150 },
  ],
  run,
  render,
};
