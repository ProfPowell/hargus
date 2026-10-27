// Link check: requests every link on the page, on this site and elsewhere (HEAD, then GET if HEAD fails; no cookies;
// private-network links skipped unless the page is on one), and the page's Open Graph image.

import { siteOf } from '../core/har-util.js';
import { groupBroken, groupFinding } from '../core/broken.js';

const SKIP = /log-?out|sign-?out|logoff|delete|remove|unsubscribe/i;
const CONTENT_LIMIT = 5000; // Content's per-list cap on link targets (MAX_LINK_TARGETS in content.js)
const DEFAULT_MAX = 2500; // links checked unless the user raises (or removes, with 0) the limit
const CONCURRENCY = 12;
const PER_HOST = 4;
const TIMEOUT_MS = 10_000;
const RATE_LIMITED = 'rate limited (429)';
const BUDGET_MS = 150_000; // stop starting new requests well inside the plugin's 180 s timeoutMs
const MAX_OG_BYTES = 10 * 1024 * 1024;
const THUMB_WIDTH = 600;
const MAX_SHARE_BYTES = 5_242_880; // X's limit for share images
const cancel = (res) => res?.body?.cancel?.().catch(() => {});

const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/** True for a URL hostname on the local machine or a private network: loopback, RFC 1918, link-local, .local, .internal. */
export function isPrivateHost(hostname = '') {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (h.includes(':')) return h === '::1' || /^fe[89ab][0-9a-f]:/.test(h);
  return false;
}

async function request(ctx, url, method) {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean));
  return ctx.fetch(url, { method, credentials: 'omit', redirect: 'follow', signal, headers: { Accept: ACCEPT } });
}

async function check(ctx, url) {
  const t0 = Date.now();
  let res;
  let method = 'HEAD';
  try {
    res = await request(ctx, url, 'HEAD');
    // Many servers answer HEAD differently from a browser's GET (GitHub 400, some CDNs 503): let GET decide.
    // A 429 is the host asking us to slow down: never answer it with another request.
    if (res.status >= 400 && res.status !== 429) res = null;
  } catch (e) {
    // a timed-out or aborted HEAD is not retried; other network errors fall back to GET
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return { url, status: 0, finalUrl: url, redirected: false, ms: Date.now() - t0, method, error: String(e?.message || e) };
    }
    res = null;
  }
  try {
    if (!res) {
      method = 'GET';
      res = await request(ctx, url, 'GET');
      cancel(res);
    }
    return { url, status: res.status, finalUrl: res.url || url, redirected: !!res.redirected, ms: Date.now() - t0, method };
  } catch (e) {
    return { url, status: 0, finalUrl: url, redirected: false, ms: Date.now() - t0, method, error: String(e?.message || e) };
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
  const withExternal = ctx.options.external !== false;
  const all = [...targets.internal, ...(withExternal ? targets.external : [])];
  // Content lists at most CONTENT_LIMIT targets of each kind; its totals (newer readings) count them all.
  const totals = targets.totals;
  const known = totals ? Math.max(all.length, (totals.internal || 0) + (withExternal ? totals.external || 0 : 0)) : all.length;
  // Only an exact 0 lifts the limit; unset, empty, NaN or negative values mean the default.
  const raw = ctx.options.max;
  const n = raw == null || raw === '' ? DEFAULT_MAX : Number(raw);
  const cap = n === 0 ? Infinity : n > 0 ? n : DEFAULT_MAX;
  const list = all.slice(0, cap);
  const notQueued = known - list.length;
  // max applies first; Content's own cap is the cause only when it truncated the lists (totals exceed the list length).
  const byMax = cap < all.length;
  const limit = byMax ? cap : CONTENT_LIMIT;
  const checked = [];
  const todo = [];
  // Private-network links are not contacted from a public page; a page that is itself on one gets them checked.
  let pageIsPrivate = false;
  try { pageIsPrivate = isPrivateHost(new URL(ctx.target?.finalUrl || ctx.target?.url).hostname); } catch { /* no page URL: public */ }
  for (const url of list) {
    let u;
    try { u = new URL(url); } catch { checked.push({ url, skipped: 'not a valid URL' }); continue; }
    if (!/^https?:$/i.test(u.protocol)) checked.push({ url, skipped: 'not http(s)' });
    else if (!pageIsPrivate && isPrivateHost(u.hostname)) checked.push({ url, skipped: 'private network' });
    else if (SKIP.test(u.pathname + u.search)) checked.push({ url, skipped: 'looks like a sign-out or destructive link' });
    else todo.push(url);
  }
  // budgetMs is an undocumented option used only by tests to shrink the run deadline
  const deadline = Date.now() + (Number(ctx.options.budgetMs) || BUDGET_MS);
  let done = 0;
  const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
  const busy = new Map();
  // The queue is bucketed by host (host computed once per URL). take() looks only at each host's next URL and
  // returns the earliest one, in page order, whose host is below PER_HOST — without rescanning every URL.
  const queue = new Map(); // host → [{ url, host, i }] in page order
  todo.forEach((url, i) => {
    const host = hostOf(url);
    if (!queue.has(host)) queue.set(host, []);
    queue.get(host).push({ url, host, i });
  });
  let pending = todo.length;
  const take = () => {
    let best = null;
    for (const [host, list] of queue) {
      if ((busy.get(host) || 0) < PER_HOST && (!best || list[0].i < best[0].i)) best = list;
    }
    if (!best) return null;
    const entry = best.shift();
    if (!best.length) queue.delete(entry.host);
    pending--;
    return entry;
  };
  // A host that answers 429 gets no more requests: its queued links are skipped and reported.
  const backOff = (host) => {
    for (const { url } of queue.get(host) || []) checked.push({ url, skipped: RATE_LIMITED });
    pending -= queue.get(host)?.length || 0;
    queue.delete(host);
  };
  // A worker finding only saturated hosts waits here. Every finished request (and every exiting worker)
  // releases all waiters, which then re-check the loop condition (queue, abort, deadline).
  let wake = () => {};
  const wakeAll = () => { const w = wake; wake = () => {}; w(); };
  const worker = async () => {
    try {
      while (pending) {
        if (ctx.signal?.aborted || Date.now() > deadline) break;
        const next = take();
        if (!next) { await new Promise((r) => { const prev = wake; wake = () => { prev(); r(); }; }); continue; }
        const { url, host } = next;
        busy.set(host, (busy.get(host) || 0) + 1);
        try {
          const result = await check(ctx, url);
          checked.push(result);
          if (result.status === 429) backOff(host);
        } finally { busy.set(host, busy.get(host) - 1); wakeAll(); }
        done++;
        if (!ctx.signal?.aborted) ctx.progress?.(`Checking links ${done}/${todo.length}`);
      }
    } finally { wakeAll(); }
  };
  await Promise.all(Array(Math.min(CONCURRENCY, todo.length)).fill(0).map(worker));
  for (const { url } of [...queue.values()].flat().sort((a, b) => a.i - b.i)) checked.push({ url, skipped: 'time budget' });

  const findings = [];
  const add = (severity, title, detail, category = 'content') => findings.push({ severity, category, title, ...(detail ? { detail } : {}) });
  const ran = checked.filter((x) => !x.skipped);
  const refused = ran.filter((x) => [401, 403, 429].includes(x.status));
  const failed = ran.filter((x) => x.status === 0);
  const insecure = ran.filter((x) => x.status && x.status < 400 && x.redirected && x.url.startsWith('https:') && x.finalUrl.startsWith('http:'));
  const redirects = ran.filter((x) => x.status && x.status < 400 && x.redirected && !insecure.includes(x));
  // Broken links and recorded broken assets, one finding per group. The on-page group is a11y-basics' finding too:
  // it is only raised here when that plugin didn't run ok. Content's and Network's own findings step aside.
  const content = ctx.results.content.data;
  const pageUrl = ctx.target?.finalUrl || ctx.target?.url;
  const groups = groupBroken({
    checked, sources: targets.sources || {}, missing: content.links?.missing || [], har: reading,
    pageUrl, siteOf: ctx.util?.siteOf || siteOf,
  });
  for (const g of ['page', 'internal', 'external']) {
    if (g === 'page' && ctx.results['a11y-basics']?.status === 'ok') continue;
    const f = groupFinding(g, groups[g], { pageUrl, missingCount: content.links?.missingCount });
    if (f) findings.push(f);
  }
  // A same-site downgrade is the site's own doing; one to another site (often a WAF or bot-check page) is grouped and low.
  const siteOfUrl = (u) => { try { return (ctx.util?.siteOf || siteOf)(new URL(u).hostname); } catch { return ''; } };
  const crossSite = insecure.filter((x) => siteOfUrl(x.finalUrl) !== siteOfUrl(x.url));
  const sameSite = insecure.filter((x) => !crossSite.includes(x));
  for (const x of sameSite.slice(0, 10)) add('medium', 'Link redirects to insecure HTTP', `${x.url} → ${x.finalUrl}`);
  if (sameSite.length > 10) add('medium', `…and ${sameSite.length - 10} more links redirect to insecure HTTP`);
  if (crossSite.length) add('low', `${crossSite.length} links were redirected to another site over HTTP (possibly a bot check)`, crossSite.slice(0, 10).map((x) => `${x.url} → ${x.finalUrl}`).join('; '));
  if (redirects.length) add('low', `${redirects.length} links redirect — update them to their final URL`, redirects.slice(0, 10).map((x) => `${x.url} → ${x.finalUrl}`).join('; '));
  if (refused.length) add('info', `${refused.length} links refused the check (401, 403 or 429)`, refused.slice(0, 10).map((x) => x.url).join(', '));
  const budgetSkipped = checked.filter((x) => x.skipped === 'time budget');
  if (budgetSkipped.length) add('info', `${budgetSkipped.length} links not checked (time budget)`,
    `They were not tested — check again to test them. ${budgetSkipped.slice(0, 10).map((x) => x.url).join(', ')}`);
  const rateLimited = checked.filter((x) => x.skipped === RATE_LIMITED);
  if (rateLimited.length) {
    const hosts = [...new Set(rateLimited.map((x) => hostOf(x.url)))].join(', ');
    add('info', `${rateLimited.length} links not checked (rate limited by ${hosts})`, rateLimited.slice(0, 10).map((x) => x.url).join(', '));
  }
  if (notQueued > 0) {
    const examples = all.slice(list.length, list.length + 10).join(', ');
    const detail = byMax ? `Set "Most links to check" to 0 in the Link check options to check every link.${examples ? ` ${examples}` : ''}`
      : `The page reader keeps at most ${CONTENT_LIMIT.toLocaleString('en-US')} links per list.`;
    add('info', `${notQueued} links not checked (over the ${limit.toLocaleString('en-US')} link limit)`, detail);
  }
  const anchors = targets.anchors;
  if (anchors && anchors.total > anchors.read) add('info', `${anchors.total - anchors.read} more links on the page were not read (the page reader stops at ${anchors.read.toLocaleString('en-US')})`);
  const total = checked.filter((x) => x.skipped !== 'not http(s)' && x.skipped !== 'not a valid URL').length + notQueued;
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
  const broken = groups.internal.length + groups.external.length;
  return {
    data: { checked, ogImage: og, broken: groups },
    findings,
    supersedes: ['content:missing-anchors', 'network:asset-errors'],
    summary: [{ label: 'Link check', value: `${ran.length} of ${total} checked · ${broken} broken ${broken === 1 ? 'link or asset' : 'links and assets'} · ${redirects.length + insecure.length} redirects`, headline: true }],
  };
}

// One place a broken URL is used: "/css/site.css line 212", "loaded by /js/x.js line 40",
// "this page line 88 · main › section.hero > img", "“Our team” · nav · line 41 · nav > a" (the selector muted),
// "“Team” · footer · added by a script".
function sourceLine(s, h) {
  if (s.file) {
    // Recorded assets don't carry a region or selector today; kept for when an initiator can name the element.
    const at = [s.region, s.selector].filter(Boolean).join(' › ');
    return [`${s.via === 'script' ? 'loaded by ' : ''}${s.file}${s.line ? ` line ${s.line}` : ''}`, at].filter(Boolean).join(' · ');
  }
  const text = [s.text && `“${s.text}”`, s.region, s.line ? `line ${s.line}` : s.note].filter(Boolean).join(' · ');
  if (!s.selector) return text || 'source unknown';
  return h.html`${text ? `${text} · ` : ''}<code class="selector">${s.selector}</code>`;
}

const placesText = (n) => `${n} place${n === 1 ? '' : 's'}`;

// The summary only toggles: it holds the URL as text, and the link that opens it sits in the expanded body.
function brokenItems(items, h) {
  return items.map((it) => h.html`<details class="broken-item"><summary>${it.status} · ${it.kind} · ${it.url} · ${placesText(it.sources.length + it.moreSources)}</summary>
    <p class="broken-url">${h.link(it.url)}</p>
    <ul>${it.sources.map((s) => h.html`<li>${sourceLine(s, h)}</li>`)}${it.moreSources ? h.html`<li class="more">and ${it.moreSources} more ${it.moreSources === 1 ? 'place' : 'places'}</li>` : ''}</ul></details>`);
}

// The groups sit one level below the "Broken" heading (an h4), so they are h5s rather than nested h.sub sections.
function brokenGroup(label, items, h) {
  return items?.length ? h.html`<section class="broken-group"><h5>${label}</h5>${brokenItems(items, h)}</section>` : '';
}

function render(r, h) {
  const b = r.data.broken;
  const broken = b ? h.sub('Broken', h.html`${brokenGroup('On this page', b.page, h)}${brokenGroup('Internal', b.internal, h)}${brokenGroup('External', b.external, h)}`) : '';
  return h.html`${broken}${h.table(r.data.checked.map((x) => ({
    status: x.skipped ? `skipped: ${x.skipped}` : x.status || x.error || 'failed',
    method: x.method || '', url: h.link(x.url), final: x.redirected ? h.link(x.finalUrl) : '', ms: x.ms != null ? h.ms(x.ms) : '',
  })), [{ key: 'status', label: 'Status' }, { key: 'method', label: 'Method' }, { key: 'url', label: 'URL' }, { key: 'final', label: 'Final URL' }, { key: 'ms', label: 'Time' }])}
  ${r.data.ogImage ? h.sub('Open Graph image', h.kv([['URL', h.link(r.data.ogImage.url)], ['Status', r.data.ogImage.status || r.data.ogImage.error], ['Size', [r.data.ogImage.width ? `${r.data.ogImage.width}×${r.data.ogImage.height}` : 'not measured', r.data.ogImage.bytes != null ? `${(r.data.ogImage.bytes / 1048576).toFixed(2)} MB` : ''].filter(Boolean).join(' · ')]])) : ''}`;
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
  disclosure: 'Requests every link on the page, on this site and elsewhere (HEAD, then GET if HEAD fails; no cookies), and the page\'s Open Graph image.',
  tags: ['content'],
  options: [
    { key: 'external', label: 'Also check external links', type: 'checkbox', default: true },
    { key: 'max', label: 'Most links to check (0 = no limit)', type: 'number', default: DEFAULT_MAX },
  ],
  run,
  render,
};
