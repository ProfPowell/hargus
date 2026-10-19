// Network waterfall model: pure functions over a reading — the timeline (bars, phases, ticks, page markers),
// sorting and, from Task 2, the plain-English facts and wire text of one request. No DOM: report.js renders it.

import { transferSize, resourceType } from '../core/har-util.js';

export const PHASES = [
  { key: 'blocked', label: 'Queued' },
  { key: 'dns', label: 'DNS' },
  { key: 'connect', label: 'Connect' },
  { key: 'ssl', label: 'TLS' },
  { key: 'send', label: 'Send' },
  { key: 'wait', label: 'Waiting (TTFB)' },
  { key: 'receive', label: 'Download' },
];

export const MARKERS = [
  { key: 'fcp', label: 'FCP' },
  { key: 'dcl', label: 'DOMContentLoaded' },
  { key: 'lcp', label: 'LCP' },
  { key: 'load', label: 'Load' },
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const round2 = (x) => Math.round(x * 100) / 100;

/** The bar's segments in HAR order. -1/missing/zero phases are dropped; HAR's connect includes ssl, so it is drawn without it. */
export function phaseSegments(timings, time) {
  const t = timings || {};
  const ssl = num(t.ssl);
  const segments = [];
  for (const { key } of PHASES) {
    let ms = num(t[key]);
    if (key === 'connect' && ssl > 0 && ms >= ssl) ms -= ssl;
    if (ms > 0) segments.push({ key, ms: Math.round(ms * 1000) / 1000 });
  }
  return { segments, known: num(time) > 0 && segments.length > 0 };
}

/** Round ruler ticks: a 1, 2, 2.5 or 5 × 10^n step giving four or five ticks from 0 up to the span. */
export function niceTicks(span) {
  if (!(span > 0)) return [0];
  const raw = span / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const out = [];
  for (let k = 0; k * step <= span + 1e-9; k++) out.push(Math.round(k * step * 1000) / 1000);
  return out;
}

/** Page events in ms from the page start: DOMContentLoaded and load from the HAR page, FCP and LCP from the vitals plugin. */
export function pageMarkers(reading) {
  const pt = reading?.log?.pages?.[0]?.pageTimings || {};
  const v = reading?.log?._harplus?.plugins?.vitals?.data || {};
  const at = { dcl: num(pt.onContentLoad), load: num(pt.onLoad), fcp: num(v.fcp), lcp: num(v.lcp?.time) };
  return MARKERS.filter((m) => at[m.key] > 0).map((m) => ({ ...m, ms: at[m.key] })).sort((a, b) => a.ms - b.ms);
}

/** Everything the waterfall draws, as percentages of one span (the last request end or the last marker, whichever is later). */
export function timelineModel(reading) {
  const log = reading?.log || {};
  const entries = log.entries || [];
  const starts = entries.map((e) => Date.parse(e.startedDateTime));
  const pageStart = Date.parse(log.pages?.[0]?.startedDateTime);
  let t0 = Number.isFinite(pageStart) ? pageStart : Infinity;
  for (const s of starts) if (Number.isFinite(s) && s < t0) t0 = s;
  if (!Number.isFinite(t0)) t0 = 0;
  const pageOffset = Number.isFinite(pageStart) ? pageStart - t0 : 0;
  const markers = pageMarkers(reading).map((m) => ({ ...m, at: m.ms + pageOffset }));
  const rel = starts.map((s) => (Number.isFinite(s) ? Math.max(0, s - t0) : NaN));
  let span = 0;
  entries.forEach((e, i) => { if (Number.isFinite(rel[i])) span = Math.max(span, rel[i] + Math.max(0, num(e.time) || 0)); });
  for (const m of markers) span = Math.max(span, m.at);
  span = Math.max(1, span);
  const pct = (ms) => round2(Math.max(0, Math.min(100, (ms / span) * 100)));
  const bars = entries.map((e, i) => {
    const { segments, known } = phaseSegments(e.timings, e.time);
    const ok = Number.isFinite(rel[i]);
    return { start: ok ? rel[i] : null, left: ok ? pct(rel[i]) : 0, width: known && ok ? pct(e.time) : 0, segments, known: known && ok };
  });
  return {
    t0, span,
    ticks: niceTicks(span).map((ms) => ({ ms, left: pct(ms) })),
    markers: markers.map((m) => ({ ...m, left: pct(m.at) })),
    bars,
  };
}

const SORT_KEYS = {
  index: ({ i }) => i,
  status: ({ e }) => (e._error ? -1 : num(e.response?.status) || 0),
  type: ({ e }) => resourceType(e),
  name: ({ e }) => e.request?.url || '',
  size: ({ e }) => transferSize(e),
  time: ({ e }) => (num(e.time) >= 0 ? e.time : -1),
  start: ({ e }) => { const s = Date.parse(e.startedDateTime); return Number.isFinite(s) ? s : Infinity; },
};

/** Rows ({e, i}) sorted by a column; ties keep capture order in both directions. */
export function sortRows(rows, key = 'index', dir = 'asc') {
  const f = SORT_KEYS[key] || SORT_KEYS.index;
  const sign = dir === 'desc' ? -1 : 1;
  return rows.map((r) => ({ r, k: f(r) })).sort((a, b) => {
    const c = typeof a.k === 'string' ? a.k.localeCompare(b.k) : a.k - b.k;
    return c ? sign * c : a.r.i - b.r.i;
  }).map((x) => x.r);
}

/** Shorten from the middle so both the host and the end of the path stay readable. */
export function midTrunc(s, max = 64) {
  s = String(s ?? '');
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}
