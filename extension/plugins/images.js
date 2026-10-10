// Images: how well each image is encoded and sized. In the page: every image's natural and shown size,
// loading hints and the LCP image. In the extension: the largest raster images are fetched (cache first)
// and re-encoded with the browser's own encoders, so the savings are measured rather than guessed.

let env = globalThis;
/** Test seam: replace createImageBitmap / OffscreenCanvas (defaults to the real ones). */
export function setImageEnv(e) { env = e || globalThis; }

const RASTER = new Set(['jpeg', 'png', 'gif', 'webp', 'bmp']);
const MAX_ENCODE = 20;
const MIN_BYTES = 10 * 1024;
const BUDGET_MS = 8000;
const KB = 1024;

export function formatOf(mime = '', url = '') {
  const m = String(mime).toLowerCase().match(/image\/(x-)?([a-z0-9+.-]+)/);
  let f = m ? m[2] : (String(url).split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (f === 'jpg' || f === 'pjpeg') f = 'jpeg';
  if (f === 'svg+xml') f = 'svg';
  return f || 'other';
}

const file = (u) => { const name = String(u).split(/[?#]/)[0].split('/').pop() || String(u); try { return decodeURIComponent(name); } catch { return name; } };
const sum = (xs, k) => xs.reduce((n, x) => n + (x[k] || 0), 0);
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function collect() {
  const lcp = await new Promise((resolve) => {
    let last = null;
    try {
      new PerformanceObserver((list) => { const xs = list.getEntries(); if (xs.length) last = xs[xs.length - 1]; })
        .observe({ type: 'largest-contentful-paint', buffered: true });
    } catch { /* not supported */ }
    setTimeout(() => resolve(last ? (last.element?.currentSrc || last.element?.src || last.url || null) : null), 60);
  });
  const images = [...document.images].slice(0, 200).map((img) => {
    const r = img.getBoundingClientRect();
    const ar = getComputedStyle(img).aspectRatio;
    return {
      src: img.currentSrc || img.src,
      naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
      displayWidth: Math.round(r.width), displayHeight: Math.round(r.height), dpr: devicePixelRatio,
      loading: img.getAttribute('loading') || '', fetchpriority: img.getAttribute('fetchpriority') || '', decoding: img.getAttribute('decoding') || '',
      sized: (img.hasAttribute('width') && img.hasAttribute('height')) || (!!ar && ar !== 'auto'),
      aboveFold: r.top < innerHeight && r.bottom > 0,
      inPicture: img.parentElement?.tagName === 'PICTURE',
      alt: img.hasAttribute('alt'),
    };
  });
  return { images, lcp };
}

async function run(reading, ctx) {
  const c = ctx.collected;
  if (!c?.images) ctx.skip('no page data');
  const { transferSize, formatBytes } = ctx.util;
  const byUrl = new Map();
  for (const e of reading.log.entries) {
    const bytes = transferSize(e);
    const prev = byUrl.get(e.request.url);
    if (!prev || bytes > prev.bytes) byUrl.set(e.request.url, { bytes, mime: e.response.content?.mimeType || '' });
  }
  const seen = new Set();
  const images = [];
  for (const i of c.images) {
    if (!i.src || i.src.startsWith('data:') || seen.has(i.src)) continue;
    seen.add(i.src);
    const net = byUrl.get(i.src) || { bytes: 0, mime: '' };
    const need = (natural, shown) => (shown > 0 ? Math.min(natural, Math.round(shown * (i.dpr || 1))) : natural);
    images.push({ ...i, bytes: net.bytes, format: formatOf(net.mime, i.src), neededWidth: need(i.naturalWidth, i.displayWidth), neededHeight: need(i.naturalHeight, i.displayHeight), saving: 0, formatSaving: 0, oversized: false });
  }

  const candidates = images.filter((i) => RASTER.has(i.format) && i.bytes > MIN_BYTES && i.naturalWidth > 0 && i.neededWidth > 0)
    .sort((a, b) => b.bytes - a.bytes).slice(0, MAX_ENCODE);
  const deadline = Date.now() + BUDGET_MS;
  let avifSupported = null;
  for (const i of candidates) {
    if (Date.now() > deadline) { i.encodeError = 'time budget exceeded'; continue; }
    try {
      const res = await ctx.fetch(i.src, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bmp = await env.createImageBitmap(await res.blob());
      const encode = (w, h, type, quality) => {
        const canvas = new env.OffscreenCanvas(w, h);
        canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
        return canvas.convertToBlob({ type, quality });
      };
      i.webpNeeded = (await encode(i.neededWidth, i.neededHeight, 'image/webp', 0.8)).size;
      i.webpNatural = i.neededWidth === i.naturalWidth && i.neededHeight === i.naturalHeight
        ? i.webpNeeded : (await encode(i.naturalWidth, i.naturalHeight, 'image/webp', 0.8)).size;
      i.avifNeeded = null;
      if (avifSupported !== false) {
        const a = await encode(i.neededWidth, i.neededHeight, 'image/avif', 0.6);
        avifSupported = a.type === 'image/avif';
        if (avifSupported) i.avifNeeded = a.size;
      }
      bmp.close?.();
      i.saving = i.bytes - Math.min(i.bytes, i.webpNeeded, i.avifNeeded ?? Infinity);
      i.formatSaving = Math.max(0, i.bytes - i.webpNatural);
      i.oversized = i.naturalWidth * i.naturalHeight > 2 * i.neededWidth * i.neededHeight && i.saving >= 50 * KB;
    } catch (e) {
      i.encodeError = String(e?.message || e);
    }
  }

  const findings = [];
  const add = (severity, title, detail) => findings.push({ severity, category: 'performance', title, detail });
  const oversized = images.filter((i) => i.oversized).sort((a, b) => b.saving - a.saving);
  if (oversized.length) {
    const total = sum(oversized, 'saving');
    add(total >= 300 * KB ? 'medium' : 'low', `${count(oversized.length, "image is larger than it's shown", "images are larger than they're shown")}`,
      `${formatBytes(total)} could be saved by serving the size each image is shown at. ${oversized.slice(0, 5).map((i) => `${file(i.src)} ${i.naturalWidth}×${i.naturalHeight} → ${i.neededWidth}×${i.neededHeight}`).join('; ')}`);
  }
  const legacy = images.filter((i) => (i.format === 'jpeg' || i.format === 'png') && i.formatSaving >= 0.25 * i.bytes && i.formatSaving >= 20 * KB);
  if (legacy.length) {
    const total = sum(legacy, 'formatSaving');
    add(total >= 500 * KB ? 'medium' : 'low', `Modern formats would save ${formatBytes(total)}`,
      `${count(legacy.length, 'JPEG/PNG image', 'JPEG/PNG images')} would be smaller as WebP${avifSupported ? ' or AVIF' : ''}.`);
  }
  const unsized = images.filter((i) => i.sized === false);
  if (unsized.length) add('low', `${count(unsized.length, 'image', 'images')} without width and height`, 'Reserve space to avoid layout shift: set width and height attributes or a CSS aspect-ratio.');
  const lcp = images.find((i) => i.src === c.lcp);
  if (lcp?.loading === 'lazy') add('medium', 'The largest image (LCP) is lazy-loaded', 'Lazy loading delays the most important image — remove loading="lazy" from it.');
  if (lcp?.aboveFold && lcp.fetchpriority !== 'high') add('info', 'The LCP image has no fetchpriority=high', 'fetchpriority="high" lets the browser fetch it before other images.');
  for (const g of images.filter((i) => i.format === 'gif' && i.bytes >= 200 * KB)) {
    add('low', `Animated GIF of ${formatBytes(g.bytes)} — use a video`, `${file(g.src)}: an MP4 or WebM is usually a fraction of the size.`);
  }

  const bytes = sum(images, 'bytes');
  const saving = sum(images, 'saving');
  const share = bytes ? saving / bytes : 0;
  const rating = share < 0.1 ? 'good' : share < 0.4 ? 'needs-improvement' : 'poor';
  const formats = {};
  for (const i of images) formats[i.format] = (formats[i.format] || 0) + 1;
  return {
    data: { images, lcp: c.lcp, avifSupported, totals: { bytes, saving, measured: candidates.length, share, rating } },
    findings,
    summary: [
      { label: 'Images', value: `${images.length} · ${formatBytes(bytes)}`, headline: true },
      { label: 'Potential savings', value: `${formatBytes(saving)} (${Math.round(share * 100)}%)`, rating },
      { label: 'Formats', value: Object.entries(formats).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') },
    ],
  };
}

const bestOf = (i) => Math.min(i.bytes, i.webpNeeded ?? Infinity, i.avifNeeded ?? Infinity);

function glance(r, h) {
  const d = r.data;
  const t = d.totals;
  const byFormat = {};
  for (const i of d.images) byFormat[i.format] = (byFormat[i.format] || 0) + i.bytes;
  const top = d.images.filter((i) => i.saving > 0).sort((a, b) => b.saving - a.saving).slice(0, 8);
  return h.html`<div class="tiles">
    ${h.stat({ label: 'Image weight', value: h.bytes(t.bytes), note: `${d.images.length} images` })}
    ${h.stat({ label: 'Potential savings', value: h.bytes(t.saving), rating: t.rating, note: `${t.measured} re-encoded` })}
    ${h.stat({ label: 'Oversized', value: d.images.filter((i) => i.oversized).length, note: 'more than 2× the pixels needed' })}
  </div>
  <div class="glance-grid">
    <section class="card"><h4>Bytes by format</h4>${h.stackBar({ segments: Object.entries(byFormat).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v, display: h.bytes(v) })) })}</section>
    ${top.length ? h.html`<section class="card"><h4>Biggest savings</h4>${h.hbars({ label: 'Savings per image', rows: top.map((i) => ({ label: file(i.src), value: i.saving, display: `${h.bytes(i.bytes)} → ${h.bytes(bestOf(i))}` })) })}</section>` : ''}
  </div>`;
}

function render(r, h) {
  return h.table(r.data.images.map((i) => ({
    file: file(i.src), format: i.format, natural: `${i.naturalWidth}×${i.naturalHeight}`, needed: `${i.neededWidth}×${i.neededHeight}`,
    bytes: h.bytes(i.bytes), webp: i.webpNeeded != null ? h.bytes(i.webpNeeded) : '—', avif: i.avifNeeded != null ? h.bytes(i.avifNeeded) : '—',
    saving: i.encodeError ? `not measured (${i.encodeError})` : h.bytes(i.saving),
  })), [
    { key: 'file', label: 'File' }, { key: 'format', label: 'Format' }, { key: 'natural', label: 'Natural' }, { key: 'needed', label: 'Needed' },
    { key: 'bytes', label: 'Bytes' }, { key: 'webp', label: 'WebP' }, { key: 'avif', label: 'AVIF' }, { key: 'saving', label: 'Saving' },
  ]);
}

export default {
  id: 'images',
  name: 'Images',
  version: '0.1.0',
  phase: 'page',
  world: 'main',
  area: 'performance',
  group: 'quality',
  description: 'Every image\'s size, format and loading hints, with savings measured by re-encoding the largest ones as WebP and AVIF.',
  tags: ['performance', 'images'],
  collect,
  run,
  render,
  glance,
};
