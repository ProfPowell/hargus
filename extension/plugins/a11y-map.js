// Accessibility map: every image with its alt text and a WAVE-style verdict, with a thumbnail cropped
// from the base full-page screenshot. collect() runs in the page (self-contained, no imports);
// boxes are in document coordinates (getBoundingClientRect plus scroll) so they line up with the shot.

import { altVerdicts, VERDICTS, VERDICT_LABELS } from '../core/alt-verdict.js';
import { suppressedBy } from '../core/a11y-overlap.js';
import { buildMarks, markSelectors, PRIORITY } from '../core/page-map.js';

const MAX_IMAGES = 1000;
const MAX_MARKS_STORED = 2000;

function collect(args = {}) {
  const MAX = 1000;
  const $$ = (s) => [...document.querySelectorAll(s)];
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const byIds = (ids) => String(ids || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean);
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
      let p = n.localName;
      if (n.id) { parts.unshift(`${p}#${n.id}`); break; }
      if (n.classList.length) p += `.${[...n.classList].slice(0, 2).join('.')}`;
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const nameOf = (el) => {
    const lb = byIds(el.getAttribute('aria-labelledby')).map(text).join(' ');
    if (lb) return lb;
    const al = el.getAttribute('aria-label')?.trim();
    if (al) return al;
    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    const t = el.localName === 'svg' ? text(el.querySelector(':scope > title')) : '';
    return t || el.getAttribute('title')?.trim() || '';
  };
  // Text next to the image: the link's text when it is in a link, else its siblings' text.
  const nearby = (el) => {
    const a = el.closest('a[href]');
    if (a) {
      const parts = [];
      const walk = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n && parts.join(' ').length < 400; n = walk.nextNode()) {
        if (!el.contains(n) && !n.parentElement?.closest('script, style')) parts.push(n.textContent || '');
      }
      return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    const fig = el.closest('figure')?.querySelector('figcaption');
    if (fig) return text(fig).slice(0, 200);
    const p = el.parentElement;
    if (!p) return '';
    return [...p.childNodes].filter((n) => n !== el && (n.nodeType === 3 || (n.nodeType === 1 && !/^(SCRIPT|STYLE|IMG|SVG)$/i.test(n.tagName))))
      .map((n) => n.textContent || '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  };
  const srcOf = (el) => {
    const s = el.currentSrc || el.getAttribute('src') || el.getAttribute('data') || el.getAttribute('usemap') || '';
    return String(s).slice(0, 200);
  };
  const kindOf = (el) => {
    const t = el.localName;
    if (t === 'img') return 'img';
    if (t === 'input') return 'input-image';
    if (t === 'area') return 'area';
    if (t === 'svg') return 'svg';
    if (t === 'object' || t === 'embed') return 'object';
    return 'role-img';
  };
  const seen = new Set();
  const found = [];
  const add = (el) => { if (!seen.has(el)) { seen.add(el); found.push(el); } };
  for (const el of $$('img, input[type="image" i], [role="img"], svg, area[href], object, embed')) {
    if (el.localName === 'svg' && el.getAttribute('role') !== 'img' && !el.querySelector(':scope > title') && !/^(presentation|none)$/i.test(el.getAttribute('role') || '')) continue;
    if ((el.localName === 'object' || el.localName === 'embed') && !/^image\//i.test(el.getAttribute('type') || '') && !/\.(png|jpe?g|gif|webp|svg|avif)(\?|#|$)/i.test(el.getAttribute('data') || el.getAttribute('src') || '')) continue;
    if (el.localName === 'svg' && el.parentElement?.closest('svg')) continue;
    add(el);
  }
  const boxOf = (el) => {
    let t = el;
    if (el.localName === 'area') {
      const map = el.closest('map');
      t = (map && document.querySelector(`img[usemap="#${CSS.escape(map.name || map.id || '')}"]`)) || el;
    }
    const r = t.getBoundingClientRect();
    return r.width > 0 || r.height > 0 ? { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) } : null;
  };
  const images = [];
  const deadline = Date.now() + 1500;
  let truncated = 0;
  let reason = '';
  let exact = true;
  for (let i = 0; i < found.length; i++) {
    const capped = images.length >= MAX;
    if (capped || Date.now() > deadline) {
      reason = capped ? 'cap' : 'time';
      // only elements that would have been listed count: those with a layout box (cheap check, itself time-boxed)
      const stop = Date.now() + 300;
      for (let j = i; j < found.length; j++) {
        if (Date.now() > stop) { exact = false; truncated += found.length - j; break; }
        if (found[j].getClientRects().length) truncated++;
      }
      break;
    }
    const el = found[i];
    const box = boxOf(el);
    if (!box) continue; // not rendered
    const hasAlt = el.localName === 'img' || el.localName === 'input' || el.localName === 'area' || el.hasAttribute('alt');
    images.push({
      sel: path(el), kind: kindOf(el), name: nameOf(el),
      // role=presentation/none without alt marks the image decorative
      alt: (hasAlt ? el.getAttribute('alt') : null) ?? (/^(presentation|none)$/i.test(el.getAttribute('role') || '') ? '' : null),
      inLink: !!el.closest('a[href]'), adjacentText: nearby(el), src: srcOf(el), box,
    });
  }
  const kept = images;
  // Boxes for the Page map: each flagged selector resolved to the one element it names. A selector matching
  // several elements (HARgus's short paths can) is left out: a marker on the wrong element is worse than none.
  const boxes = [];
  let ambiguous = 0;
  const stopAt = Date.now() + 1500;
  for (const sel of Array.isArray(args?.sels) ? args.sels.slice(0, 2000) : []) {
    if (Date.now() > stopAt) break;
    try {
      const all = document.querySelectorAll(sel);
      if (all.length !== 1) { if (all.length > 1) ambiguous++; continue; }
      const r = all[0].getBoundingClientRect();
      if (r.width > 0 || r.height > 0) boxes.push([sel, { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }]);
    } catch { /* not a valid selector here */ }
  }
  const de = document.documentElement;
  return {
    boxes,
    ambiguous,
    images: kept,
    imagesTruncated: truncated,
    truncatedReason: reason,
    truncatedExact: exact,
    doc: { w: Math.max(de.scrollWidth, document.body?.scrollWidth || 0), h: Math.max(de.scrollHeight, document.body?.scrollHeight || 0) },
  };
}

const plural = (n, one, many) => (n === 1 ? one : many);

const arr = (v) => (Array.isArray(v) ? v : []);
const okData = (r) => (r?.status === 'ok' ? r : null);

/** The Page map's marks from the collected boxes, the other accessibility results and the keyboard walk. */
export function marksFor(c, images, results = {}, keyboard = null) {
  const axe = okData(results.axe)?.data;
  const heuristics = ['a11y-basics', 'a11y-structure'].flatMap((id) => arr(okData(results[id])?.findings)
    .filter((f) => f.evidence).map((f) => ({ source: id, id: f.id, title: f.title, severity: f.severity, detail: f.detail, sels: String(f.evidence).split('\n').map((x) => x.trim()).filter(Boolean) })));
  const st = okData(results['a11y-structure'])?.data;
  return buildMarks({
    violations: axe?.violations, incomplete: axe?.incomplete, heuristics,
    contrast: okData(results.contrast)?.data?.pairs, images,
    headings: st?.headings, landmarks: st?.landmarkList, keyboard,
    boxes: new Map(arr(c.boxes).filter((b) => Array.isArray(b) && typeof b[0] === 'string')),
  }).map((m, i) => [m, i]).sort((a, b) => PRIORITY.indexOf(a[0].category) - PRIORITY.indexOf(b[0].category) || a[1] - b[1])
    .slice(0, MAX_MARKS_STORED).map(([m]) => m); // stored in priority order, so a huge page keeps the errors
}

export function analyzeMap(c, { axe, results, keyboard } = {}) {
  const images = altVerdicts(Array.isArray(c.images) ? c.images.slice(0, MAX_IMAGES) : []);
  const findings = [];
  const add = (id, severity, title, list) => {
    if (!list.length || suppressedBy('a11y-map', id, axe)) return;
    findings.push({ id, severity, category: 'accessibility', title, evidence: list.slice(0, 5).map((i) => i.sel).join('\n') });
  };
  const of = (...vs) => images.filter((i) => vs.includes(i.verdict));
  const n = (list) => list.length;
  // <img> without alt is a11y-basics' (and axe's) finding; here only the image-like kinds it does not cover,
  // each yielding to the axe rule for its kind when that rule ran.
  const miss = of('missing').filter((i) => i.kind !== 'img' && !suppressedBy('a11y-map', `no-name-${i.kind}`, axe));
  const linked = of('empty-linked');
  const susp = of('suspicious');
  const red = of('redundant');
  const long = of('long');
  const file = of('filename');
  add('no-name', 'medium', `${n(miss)} ${plural(n(miss), 'image-like element has', 'image-like elements have')} no accessible name`, miss);
  add('linked-empty-alt', 'medium', `${n(linked)} linked ${plural(n(linked), 'image has', 'images have')} empty alt`, linked);
  add('suspicious-alt', 'low', `${n(susp)} ${plural(n(susp), 'image has', 'images have')} suspicious alt text`, susp);
  add('redundant-alt', 'low', `${n(red)} ${plural(n(red), 'image repeats nearby text in its alt', 'images repeat nearby text in their alt')}`, red);
  add('long-alt', 'low', `${n(long)} ${plural(n(long), 'alt text is', 'alt texts are')} longer than 100 characters`, long);
  add('filename-alt', 'low', `${n(file)} ${plural(n(file), 'alt text looks like a file name', 'alt texts look like file names')}`, file);

  const counts = Object.fromEntries(VERDICTS.map((v) => [v, images.filter((i) => i.verdict === v).length]));
  const flagged = images.length - counts.ok - counts['empty-decorative'];
  return {
    data: { images, doc: c.doc || null, marks: marksFor(c, images, results || { axe }, keyboard), marksAmbiguous: Number(c.ambiguous) || 0, imagesTruncated: Number(c.imagesTruncated) || 0, truncatedReason: c.truncatedReason || 'cap', truncatedExact: c.truncatedExact !== false, counts },
    findings,
    summary: [{ label: 'Images', value: `${images.length}${flagged ? ` · ${flagged} to check` : ''}` }],
  };
}

function run(reading, ctx) {
  if (!ctx.collected) ctx.skip('no page data');
  return analyzeMap(ctx.collected, { axe: ctx.results?.axe, results: ctx.results || {}, keyboard: reading.log?._harplus?.capture?.keyboard });
}

/** The selectors collect() resolves to boxes for the Page map. */
function collectArgs(ctx) {
  return { sels: markSelectors(ctx.results || {}) };
}

const RATING = { ok: 'good', 'empty-decorative': 'good', missing: 'poor', 'empty-linked': 'poor' };
const ICON = { good: 'ok', poor: 'fail' };

function render(r, h, ctx = {}) {
  const d = r.data;
  const images = d.images || [];
  const chip = (v) => {
    const rating = RATING[v] || 'needs-improvement';
    return h.html`<span class="chip-r rating-${rating}">${h.icon(ICON[rating] || 'up', { size: 12 })}${VERDICT_LABELS[v] || v}</span>`;
  };
  const summary = ['ok', ...VERDICTS.filter((v) => v !== 'ok')].filter((v) => d.counts?.[v]).map((v) => `${d.counts[v]} ${VERDICT_LABELS[v]}`).join(' · ');
  const altCell = (i) => {
    if (i.alt === null && !i.name) return h.html`<em>no alt</em>`;
    if (i.alt === '' && !i.name) return h.html`<em>empty (decorative)</em>`;
    if (i.alt === '') return h.html`<em>alt "" · name:</em> “${i.name}”`;
    if (i.alt == null) return h.html`<em>name:</em> “${i.name}”`;
    return h.html`“${i.alt || i.name}”`;
  };
  const rows = images.map((i) => ({
    ...(ctx.crop ? { thumb: ctx.crop.thumb(i.box) } : {}),
    alt: h.html`${altCell(i)}${i.verdict !== 'ok' && i.note ? h.html`<div class="muted">${i.note}</div>` : ''}`,
    kind: i.kind,
    link: i.inLink ? 'yes' : 'no',
    verdict: chip(i.verdict),
  }));
  const cols = [...(ctx.crop ? [{ key: 'thumb', label: 'Thumbnail' }] : []), { key: 'alt', label: 'Alt text' }, { key: 'kind', label: 'Kind' }, { key: 'link', label: 'In a link' }, { key: 'verdict', label: 'Verdict' }];
  return h.html`
    ${ctx.crop?.style || ''}
    ${h.sub('Images & alt text', images.length ? h.html`<p class="muted">${summary}</p>${h.table(rows, cols)}` : h.html`<p class="muted">No images found.</p>`)}
    ${d.imagesTruncated ? h.html`<p class="note">${d.truncatedExact ? '' : 'At least '}${d.imagesTruncated} more images not listed: ${d.truncatedReason === 'time' ? 'the image scan stopped after 1.5 s.' : 'the page has more than 1,000 images and the first 1,000 are shown.'}</p>` : ''}`;
}

export default {
  id: 'a11y-map',
  name: 'Images & alt text',
  version: '0.1.0',
  phase: 'page',
  group: 'quality',
  area: 'accessibility',
  after: ['axe', 'a11y-basics', 'a11y-structure', 'contrast'],
  description: 'Every image with its alt text, a WAVE-style verdict and a thumbnail from the page screenshot.',
  tags: ['accessibility'],
  timeoutMs: 15_000,
  collect,
  collectArgs,
  run,
  render,
};
