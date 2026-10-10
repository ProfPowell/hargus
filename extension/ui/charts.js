// Chart kit: pure functions returning escaped HTML/SVG (no DOM) — shared by the viewer, the
// standalone HTML export and the CLI, and handed to plugins on `h`. Colours come from theme.css
// custom properties (--c1…--c8 categorical, --st-* status). Every chart carries a text alternative.

import { html, raw } from './html.js';
import { normRating } from '../core/score.js';

/* ---------------------------------------------------------- label fitting */

// Advance widths in em for system-ui semibold, deliberately generous (measured: digits ≈ 0.65 em).
const advance = (ch) => (/[0-9]/.test(ch) ? 0.68 : /[.,:]/.test(ch) ? 0.4 : ch === ' ' ? 0.3 : /[A-Z%]/.test(ch) ? 0.75 : 0.62);
export const textWidth = (text, fontSize) => [...String(text)].reduce((n, ch) => n + advance(ch), 0) * fontSize;
const n1 = (x) => Math.round(x * 10) / 10;

/** Largest font size ≤ base whose estimated width stays within 80% of the inner diameter. */
export function fitFont(text, inner, base) {
  const w = textWidth(text, 1);
  return w ? Math.min(base, Math.floor(((0.8 * inner) / w) * 10) / 10) : base;
}

export const RING = { r: 17, stroke: 4 };
export const DONUT = { r: 16, stroke: 6 };
export const innerDiameter = ({ r, stroke }) => 2 * (r - stroke / 2);

const STATUSES = new Set(['good', 'warning', 'serious', 'critical', 'none']);
const COLOR_RE = /^(var\(--[a-z0-9-]+\)|#[0-9a-f]{3,8})$/i;
export const safeColor = (c) => (COLOR_RE.test(String(c ?? '')) ? String(c) : 'var(--c-other)');
export const seriesColor = (s, i) => safeColor(s.color || (s.other ? 'var(--c-other)' : `var(--c${(i % 8) + 1})`));
const num = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? ''));

/* ------------------------------------------------------------------ ring */

export function ring({ value, max = 100, size = 44, status = 'none', label = '', showValue = true } = {}) {
  const has = value != null && Number.isFinite(Number(value));
  const pct = has ? Math.max(0, Math.min(100, (Number(value) / max) * 100)) : 0;
  const text = has ? String(Math.round(Number(value))) : '—';
  const st = STATUSES.has(status) ? status : 'none';
  const name = `${label ? `${label}: ` : ''}${has ? `${text} of ${max}` : 'not measured'}`;
  const px = Number(size) || 44;
  return html`<svg class="chart ring" width="${px}" height="${px}" viewBox="0 0 42 42" role="img" aria-label="${name}"><title>${name}</title>
    <circle cx="21" cy="21" r="${RING.r}" fill="none" stroke="var(--track)" stroke-width="${RING.stroke}"/>
    ${pct > 0 ? html`<circle cx="21" cy="21" r="${RING.r}" fill="none" stroke="var(--st-${st})" stroke-width="${RING.stroke}" stroke-linecap="${pct >= 100 ? 'butt' : 'round'}" pathLength="100" stroke-dasharray="${n1(pct)} 100" transform="rotate(-90 21 21)"/>` : ''}
    ${showValue ? html`<text x="21" y="21" dy="0.35em" text-anchor="middle" font-size="${fitFont(text, innerDiameter(RING), 13)}">${text}</text>` : ''}
  </svg>`;
}

/* ----------------------------------------------------------------- donut */

export function foldSegments(segments = [], max = 6) {
  const xs = segments.filter((s) => Number(s.value) > 0);
  if (xs.length <= max) return xs;
  const keep = new Set([...xs].sort((a, b) => b.value - a.value).slice(0, max - 1));
  const rest = xs.filter((s) => !keep.has(s));
  return [...xs.filter((s) => keep.has(s)), { label: 'Other', value: rest.reduce((n, s) => n + Number(s.value), 0), other: true }];
}

export function legend(items = []) {
  if (!items.length) return '';
  return html`<ul class="legend">${items.map((it) => html`<li><i class="sw" style="background:${safeColor(it.color)}"></i><span>${it.label}</span>${it.value != null && it.value !== '' ? html`<em>${num(it.value)}</em>` : ''}</li>`)}</ul>`;
}

export function donut({ segments = [], center, size = 112, label = '' } = {}) {
  const segs = foldSegments(segments);
  const total = segs.reduce((n, s) => n + Number(s.value), 0);
  if (!total) return '';
  const gap = segs.length > 1 ? 0.8 : 0; // surface gap between arcs, in pathLength units
  let offset = 0;
  const arcs = segs.map((s, i) => {
    const len = (Number(s.value) / total) * 100;
    const dash = Math.max(0, len - gap);
    const arc = html`<circle cx="21" cy="21" r="${DONUT.r}" fill="none" stroke="${seriesColor(s, i)}" stroke-width="${DONUT.stroke}" pathLength="100" stroke-dasharray="${n1(dash)} ${n1(100 - dash)}" stroke-dashoffset="${n1(-offset)}"><title>${s.label}: ${s.display ?? num(s.value)}</title></circle>`;
    offset += len;
    return arc;
  });
  const value = center?.value != null ? String(center.value) : '';
  const unit = center?.unit ? String(center.unit) : '';
  const inner = innerDiameter(DONUT);
  const name = `${label ? `${label}: ` : ''}${segs.map((s) => `${s.label} ${s.display ?? num(s.value)}`).join(', ')}`;
  const px = Number(size) || 112;
  return html`<figure class="chart-fig donut-chart"><svg class="chart donut" width="${px}" height="${px}" viewBox="0 0 42 42" role="img" aria-label="${name}">
    <g transform="rotate(-90 21 21)">${arcs}</g>
    ${value ? html`<text x="21" y="${unit ? 19.5 : 21}" dy="0.35em" text-anchor="middle" font-size="${fitFont(value, inner, 9)}">${value}</text>` : ''}
    ${unit ? html`<text class="unit" x="21" y="27.5" dy="0.35em" text-anchor="middle" font-size="${fitFont(unit, inner, 4.5)}">${unit}</text>` : ''}
  </svg>${legend(segs.map((s, i) => ({ label: s.label, value: s.display ?? s.value, color: seriesColor(s, i) })))}</figure>`;
}

/* ------------------------------------------------------------- bars */

export function stackBar({ segments = [], label = '', legend: showLegend = true } = {}) {
  const segs = segments.filter((s) => Number(s.value) > 0);
  const total = segs.reduce((n, s) => n + Number(s.value), 0);
  if (!total) return '';
  const name = `${label ? `${label}: ` : ''}${segs.map((s) => `${s.label} ${s.display ?? num(s.value)}`).join(', ')}`;
  return html`<div class="chart stackbar">${label ? html`<div class="k">${label}</div>` : ''}<div class="bar" role="img" aria-label="${name}">${segs.map((s, i) => html`<span style="flex:${n1((Number(s.value) / total) * 100)};background:${seriesColor(s, i)}" title="${s.label}: ${s.display ?? num(s.value)}"></span>`)}</div></div>${showLegend ? legend(segs.map((s, i) => ({ label: s.label, value: s.display ?? s.value, color: seriesColor(s, i) }))) : ''}`;
}

export function hbars({ rows = [], max, label = '' } = {}) {
  const xs = rows.filter((r) => Number.isFinite(Number(r.value)) && Number(r.value) >= 0);
  if (!xs.length) return '';
  const top = Number(max) || Math.max(1, ...xs.map((r) => Number(r.value)));
  return html`<div class="chart hbars" role="list" aria-label="${label}">${xs.map((r) => html`<div class="row" role="listitem"><span class="lbl" title="${r.label}">${r.label}</span><span class="track"><span style="width:${n1(Math.min(100, (Number(r.value) / top) * 100))}%;background:${safeColor(r.color || 'var(--c1)')}"></span></span><b>${r.display ?? num(r.value)}</b></div>`)}</div>`;
}

/* ------------------------------------------------------- meter & stat */

export const rate = (value, good, poor) => (value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor');

export function meter({ value, good, poor, max, format = (v) => String(v), label = '' } = {}) {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const top = Number(max) || poor * 1.5;
  const pos = (v) => n1(Math.max(0, Math.min(100, (v / top) * 100)));
  const r = rate(Number(value), good, poor);
  const name = `${label ? `${label}: ` : ''}${format(value)}, ${r.replace('-', ' ')} (good ≤ ${format(good)}, poor > ${format(poor)})`;
  return html`<div class="chart meter" role="img" aria-label="${name}">
    <div class="bands"><span class="band-good" style="flex:${pos(good)}"></span><span class="band-warning" style="flex:${n1(pos(poor) - pos(good))}"></span><span class="band-poor" style="flex:${n1(100 - pos(poor))}"></span><i class="marker" style="left:${pos(value)}%"></i></div>
    <div class="ticks" aria-hidden="true"><span style="left:0%">0</span><span style="left:${pos(good)}%">${format(good)}</span><span style="left:${pos(poor)}%">${format(poor)}</span></div>
  </div>`;
}

const RATING_UI = { good: ['ok', 'Good'], 'needs-improvement': ['up', 'Needs improvement'], poor: ['down', 'Poor'] };

export function stat({ label, value, rating, note, meter: m } = {}) {
  const r = normRating(rating);
  return html`<div class="stat card"><div class="k">${label}</div><div class="v">${value}</div>${m || ''}${r ? html`<div class="delta rating-${r}">${icon(RATING_UI[r][0], { size: 12 })}${RATING_UI[r][1]}</div>` : ''}${note ? html`<div class="delta">${note}</div>` : ''}</div>`;
}

export function spark(values = [], { label = '' } = {}) {
  const xs = values.map(Number).filter(Number.isFinite);
  if (!xs.length) return '';
  const top = Math.max(1, ...xs);
  return html`<div class="chart spark" role="img" aria-label="${label}">${xs.map((v) => html`<i style="height:${n1(Math.max(4, (v / top) * 100))}%"></i>`)}</div>`;
}

/* ------------------------------------------------------------------ icons */

const STROKE = 'stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  high: '<path d="M8 1.5 15 14H1Z" fill="var(--st-critical)"/><path d="M8 6v3.6M8 11.6v.3" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
  medium: '<circle cx="8" cy="8" r="7" fill="var(--st-serious)"/><path d="M8 4.5v4.3M8 11v.3" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
  low: '<circle cx="8" cy="8" r="7" fill="var(--c1)"/><path d="M8 7.2v4.3M8 4.6v.3" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
  info: '<circle cx="8" cy="8" r="7" fill="var(--c-other)"/><path d="M8 7.2v4.3M8 4.6v.3" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
  ok: '<circle cx="8" cy="8" r="7" fill="var(--st-good)"/><path d="m4.8 8.2 2.2 2.2 4.2-4.6" stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  fail: '<circle cx="8" cy="8" r="7" fill="var(--st-critical)"/><path d="m5.5 5.5 5 5m0-5-5 5" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>',
  up: '<path d="M8 2 14.5 13.5h-13Z" fill="var(--st-warning)"/>',
  down: '<path d="M8 14 1.5 2.5h13Z" fill="var(--st-critical)"/>',
  arrow: `<path d="M2 8h10M9 4.5 12.5 8 9 11.5" stroke-width="1.6" ${STROKE}/>`,
  overview: '<rect x="2" y="2" width="5" height="5" rx="1" fill="currentColor"/><rect x="9" y="2" width="5" height="5" rx="1" fill="currentColor" opacity=".5"/><rect x="2" y="9" width="5" height="5" rx="1" fill="currentColor" opacity=".5"/><rect x="9" y="9" width="5" height="5" rx="1" fill="currentColor"/>',
  performance: `<path d="M2.5 12a5.5 5.5 0 1 1 11 0" stroke-width="1.6" ${STROKE}/><path d="m8 12 3-4" stroke-width="1.6" ${STROKE}/>`,
  accessibility: `<circle cx="8" cy="3" r="1.6" fill="currentColor"/><path d="M3 6h10M8 6v4m0 0-2.5 4.5M8 10l2.5 4.5" stroke-width="1.6" ${STROKE}/>`,
  security: `<path d="M8 1.5 13.5 3.5v4c0 3.3-2.3 5.9-5.5 7-3.2-1.1-5.5-3.7-5.5-7v-4Z" stroke-width="1.5" ${STROKE}/>`,
  build: `<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" stroke-width="1.6" ${STROKE}/>`,
  infrastructure: `<rect x="2" y="2.5" width="12" height="4.5" rx="1" stroke-width="1.4" ${STROKE}/><rect x="2" y="9" width="12" height="4.5" rx="1" stroke-width="1.4" ${STROKE}/><path d="M4.5 4.75h.01M4.5 11.25h.01" stroke-width="2" ${STROKE}/>`,
  findings: `<path d="M5.5 4h8M5.5 8h8M5.5 12h8" stroke-width="1.6" ${STROKE}/><path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" stroke-width="2.2" ${STROKE}/>`,
  network: `<path d="M2 4h6M5 8h7M8 12h6" stroke-width="2" ${STROKE}/>`,
  screens: `<rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke-width="1.4" ${STROKE}/><path d="m3.5 11 3-3.5 2.5 2.5 1.5-1.5 2 2.5" stroke-width="1.3" ${STROKE}/>`,
  notes: `<path d="M3 13l.6-2.8L10.8 3a1.4 1.4 0 0 1 2 2l-7.2 7.2Z" stroke-width="1.4" ${STROKE}/>`,
};

export function icon(name, { size = 16, title = '' } = {}) {
  const body = ICONS[name];
  if (!body) return '';
  const px = Number(size) || 16;
  return html`<svg class="icon icon-${name}" width="${px}" height="${px}" viewBox="0 0 16 16" ${title ? html`role="img" aria-label="${title}"` : raw('aria-hidden="true"')}>${raw(body)}</svg>`;
}

/* ------------------------------------------------- lists and diagrams */

export function checklist(items = []) {
  const xs = items.filter((it) => it && it.label);
  if (!xs.length) return '';
  return html`<ul class="chart checklist">${xs.map((it) => html`<li>${icon(it.ok ? 'ok' : 'fail', { title: it.ok ? 'pass' : 'fail' })}<span>${it.label}${it.note ? html`<small>${it.note}</small>` : ''}</span></li>`)}</ul>`;
}

export function flow(nodes = []) {
  const xs = nodes.filter((n) => n && n.title);
  if (!xs.length) return '';
  return html`<ol class="chart flow">${xs.map((n, i) => html`${i ? html`<li class="arrow" aria-hidden="true">${icon('arrow')}</li>` : ''}<li class="node"><b>${n.title}</b>${n.sub ? html`<span>${n.sub}</span>` : ''}</li>`)}</ol>`;
}

export function timeline({ start, end, now = Date.now(), startLabel = '', endLabel = '', nowLabel = 'Today', label = '' } = {}) {
  const t = (x) => (x == null || x === '' ? NaN : typeof x === 'number' ? x : Date.parse(x));
  const a = t(start);
  const b = t(end);
  const c = t(now);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return '';
  const p = n1(Math.max(0, Math.min(100, ((c - a) / (b - a)) * 100)));
  return html`<div class="chart timeline" role="img" aria-label="${label ? `${label}: ` : ''}${startLabel} to ${endLabel}, ${p}% elapsed">
    <div class="line"><span style="width:${p}%"></span></div>
    <i class="pin start"></i><i class="pin now" style="left:${p}%"></i><i class="pin end"></i>
    <div class="labels" aria-hidden="true"><span>${startLabel}</span><span class="now" style="left:${Math.min(85, Math.max(15, p))}%">${nowLabel}</span><span>${endLabel}</span></div>
  </div>`;
}

const hash = (s) => [...String(s)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
const initials = (name) => {
  const w = String(name).replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?')[0]).toUpperCase();
};
const LIGHT_SLOTS = new Set([3, 4, 5]); // aqua, yellow, magenta need dark ink on the fill

export function badges(techs = [], { limit = Infinity } = {}) {
  if (!techs.length) return '';
  const xs = techs.slice(0, limit);
  const more = techs.length - xs.length;
  return html`<ul class="chart badges">${xs.map((t) => {
    const slot = (hash(t.name) % 8) + 1;
    return html`<li class="badge"><i class="${LIGHT_SLOTS.has(slot) ? 'ink' : ''}" style="background:var(--c${slot})" aria-hidden="true">${initials(t.name)}</i>${t.name}${t.version ? ` ${t.version}` : ''}${t.category ? html`<em>${t.category}</em>` : ''}</li>`;
  })}${more > 0 ? html`<li class="badge more"><i aria-hidden="true">+${more}</i>more</li>` : ''}</ul>`;
}
