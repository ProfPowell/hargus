// Chart kit: pure functions returning escaped HTML/SVG (no DOM) — shared by the viewer, the
// standalone HTML export and the CLI, and handed to plugins on `h`. Colours come from theme.css
// custom properties (--c1…--c8 categorical, --st-* status). Every chart carries a text alternative.

import { html } from './html.js';

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
