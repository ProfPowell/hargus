// <head> order: Capo.js weights over the document HTML as the server sent it. Offline (works in the CLI).

const blank = (m) => ' '.repeat(m.length);
// 64 KB of decoded bytes; a multiple of 4 so the base64 prefix decodes cleanly.
const HEAD_B64_CHARS = 87384;

function weightOf({ tag, attrs, content }) {
  const rel = String(attrs.rel || '').toLowerCase().split(/\s+/);
  const type = String(attrs.type || '').toLowerCase();
  if (tag === 'meta' && ('charset' in attrs || 'http-equiv' in attrs || String(attrs.name || '').toLowerCase() === 'viewport')) return 10;
  if (tag === 'base') return 10;
  if (tag === 'title') return 9;
  if (tag === 'link' && rel.includes('preconnect')) return 8;
  if (tag === 'script') {
    if (/json|importmap|speculationrules|template/.test(type) || (/^text\//.test(type) && type !== 'text/javascript')) return 0;
    if ('async' in attrs && 'src' in attrs) return 7;
    if (type === 'module' || ('defer' in attrs && 'src' in attrs)) return 2;
    return 5; // synchronous: blocks parsing (inline or src), per Capo.js
  }
  if (tag === 'style') return /@import/i.test(content) ? 6 : 4;
  if (tag === 'link' && rel.includes('stylesheet')) return String(attrs.media || '').trim().toLowerCase() === 'print' ? 0 : 4;
  if (tag === 'link' && (rel.includes('preload') || rel.includes('modulepreload'))) return 3;
  if (tag === 'link' && rel.some((r) => ['prefetch', 'dns-prefetch', 'prerender'].includes(r))) return 1;
  return 0;
}

const base = (u) => String(u || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
const host = (u) => { try { return new URL(u).host; } catch { return base(u); } };

function labelOf({ tag, attrs }) {
  if (tag === 'meta') return attrs.charset != null ? 'meta charset' : attrs['http-equiv'] ? `meta http-equiv ${attrs['http-equiv']}` : `meta ${attrs.name || attrs.property || ''}`.trim();
  if (tag === 'link') {
    const rel = String(attrs.rel || '').toLowerCase();
    return `link ${rel} ${rel.includes('preconnect') || rel.includes('dns-prefetch') ? host(attrs.href) : base(attrs.href)}`.trim();
  }
  if (tag === 'script') {
    const kind = 'async' in attrs ? 'script async' : 'defer' in attrs ? 'script defer' : String(attrs.type || '') === 'module' ? 'script module' : 'script';
    return attrs.src ? `${kind} ${base(attrs.src)}` : `inline ${kind}`;
  }
  return tag;
}

// Same-length copy with comment bodies, script/style/template contents and an unclosed template's tail blanked.
// Tags are kept, so offsets into the original text still line up.
function scanCopy(s) {
  return s.replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>|<template\b[^>]*>[\s\S]*$/gi, (m, name) => {
    if (m.startsWith('<!--')) return blank(m);
    const open = /^<[^>]*>/.exec(m)[0];
    if (!name) return open + blank(m.slice(open.length));
    const close = /<\/[^>]*>$/.exec(m)[0];
    return open + blank(m.slice(open.length, m.length - close.length)) + close;
  });
}

export function parseHead(html = '') {
  const s = String(html);
  const scan = scanCopy(s);
  const stops = [scan.search(/<\/head\s*>/i), scan.search(/<body[\s>]/i)].filter((x) => x >= 0);
  const end = stops.length ? Math.min(...stops) : s.length;
  const src = scan.slice(0, end);
  const lowerSrc = src.toLowerCase();
  const out = [];
  const re = /<(meta|title|base|link|script|style|noscript)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(src))) {
    const tag = m[1].toLowerCase();
    const attrs = {};
    for (const a of m[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    let content = '';
    if (['script', 'style', 'title', 'noscript'].includes(tag)) {
      const close = lowerSrc.indexOf(`</${tag}`, re.lastIndex);
      if (close >= 0) { content = s.slice(re.lastIndex, close); re.lastIndex = close; }
    }
    const el = { tag, attrs, content, offset: m.index };
    out.push({ ...el, weight: weightOf(el), label: labelOf(el) });
  }
  return out;
}

/** headerCharset: the response's Content-Type header names a charset, so a missing <meta charset> is fine (a late one is not). */
export function analyzeHead(html, { headerCharset = false } = {}) {
  const els = parseHead(html);
  const findings = [];
  const add = (title, detail) => findings.push({ severity: 'low', category: 'performance', title, ...(detail ? { detail } : {}) });
  // Weight-0 elements take no part in ordering: only weighted elements can be late or make another one late.
  const culprits = els.map((e, i) => (e.weight >= 1 ? els.slice(0, i).find((p) => p.weight >= 1 && p.weight < e.weight) : undefined));
  const inversions = [];
  els.forEach((e, i) => { if (culprits[i]) inversions.push(`${e.label} after ${culprits[i].label}`); });
  if (inversions.length) add(`${inversions.length} <head> elements out of optimal order`, inversions.slice(0, 3).join('; '));
  const charset = els.find((e) => e.tag === 'meta' && (e.attrs.charset != null || /charset=/i.test(e.attrs.content || '')));
  const bytesBefore = charset ? new TextEncoder().encode(String(html).slice(0, charset.offset)).length : Infinity;
  if (bytesBefore > 1024 && (charset || !headerCharset)) add('<meta charset> is not in the first 1024 bytes');
  return {
    data: { elements: els.map(({ tag, label, weight }, i) => ({ tag, label, weight, late: !!culprits[i] })) },
    findings,
    summary: [{ label: '<head> order', value: inversions.length ? `${inversions.length} out of order` : 'optimal', rating: inversions.length ? 'needs-improvement' : 'good' }],
  };
}

function run(reading, ctx) {
  const e = ctx.util?.mainEntry?.(reading);
  const c = e?.response?.content;
  if (!c?.text) ctx.skip('no document HTML in this reading — capture with response bodies');
  let html = c.text;
  if (c.encoding === 'base64') {
    try {
      const b64 = c.text.replace(/\s+/g, '').slice(0, HEAD_B64_CHARS);
      html = new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
    } catch {
      ctx.skip('document HTML could not be decoded');
    }
  }
  const contentType = (e.response.headers || []).find((x) => String(x.name).toLowerCase() === 'content-type')?.value;
  return analyzeHead(html, { headerCharset: /charset=/i.test(contentType || '') });
}

function glance(r, h) {
  const rows = r.data.elements.slice(0, 30);
  return h.html`<section class="card"><h4>&lt;head&gt; order (Capo weights)</h4>${h.hbars({
    label: 'Head elements by weight', max: 10,
    rows: rows.map((e) => ({ label: `${e.late ? '⚠ ' : ''}${e.label}`, value: e.weight, display: String(e.weight), color: e.late ? 'var(--st-serious)' : 'var(--c1)' })),
  })}</section>`;
}

function render(r, h) {
  return h.table(r.data.elements.map((e, i) => ({ n: String(i + 1), el: e.label, weight: String(e.weight), late: e.late ? 'out of order' : '' })),
    [{ key: 'n', label: '#' }, { key: 'el', label: 'Element' }, { key: 'weight', label: 'Weight' }, { key: 'late', label: '' }]);
}

export default {
  id: 'head-order',
  name: '<head> order',
  version: '0.1.0',
  phase: 'analyze',
  group: 'build',
  area: 'performance',
  description: 'Orders the <head> by Capo.js weights from the HTML as served and flags elements that delay rendering.',
  tags: ['performance'],
  run,
  glance,
  render,
};
