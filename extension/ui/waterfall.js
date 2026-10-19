// Network waterfall model: pure functions over a reading — the timeline (bars, phases, ticks, page markers),
// sorting and the plain-English facts and wire text of one request. No DOM: report.js renders it.

import { transferSize, resourceType, hostOf, originOf, isThirdParty, resHeader, formatBytes, formatMs } from '../core/har-util.js';

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

/* ------------------------------------------------------------- one request */

/** The vitals plugin stores at most this many render-blocking URLs (plugins/vitals.js). */
export const RB_CAP = 200;

const PROTO = { h2: 'HTTP/2', 'http/2': 'HTTP/2', 'http/2.0': 'HTTP/2', h3: 'HTTP/3', 'http/3': 'HTTP/3', 'http/1.1': 'HTTP/1.1', 'http/1.0': 'HTTP/1.0' };
export const protocolName = (v) => (v ? PROTO[String(v).toLowerCase()] || String(v).toUpperCase() : '');

const REASON = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 410: 'Gone', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const ELEMENT = { stylesheet: 'a <link rel="stylesheet">', script: 'a <script>', image: 'an <img>', media: 'a <video> or <audio>', document: 'a frame', font: 'a font' };

/** Who asked for the request, as a sentence. CDP line numbers are 0-based. */
export function requestedBy(e) {
  const i = e?._initiator;
  if (!i?.type) return '';
  const line = Number.isFinite(i.lineNumber) ? `line ${i.lineNumber + 1}` : '';
  const where = i.url ? ` (${[i.url, line].filter(Boolean).join(', ')})` : line ? ` (${line})` : '';
  switch (i.type) {
    case 'parser': return `${ELEMENT[resourceType(e)] || 'an element'} in the page's HTML${where}`;
    case 'script': return `a script${where}`;
    case 'preload': return `a preload${where}`;
    case 'preflight': return 'a CORS preflight';
    case 'redirect': return `a redirect${i.url ? ` from ${i.url}` : ''}`;
    case 'SignedExchange': return 'a signed exchange';
    default: return 'the browser (other)';
  }
}

export function originFact(url, pageUrl, site) {
  const o = originOf(url);
  const host = hostOf(url);
  if (!o || !host) return '';
  if (pageUrl && o === originOf(pageUrl)) return 'same origin as the page';
  if (site && !isThirdParty(host, site)) return 'same site, other origin';
  return `third-party (${host})`;
}

const ENCODING = { br: 'brotli', gzip: 'gzip', zstd: 'zstd', deflate: 'deflate' };

export function sizeFact(e) {
  const wire = transferSize(e);
  const decoded = num(e?.response?.content?.size);
  const enc = String(resHeader(e, 'content-encoding') || '').toLowerCase().trim();
  let s = `${formatBytes(wire)} on the wire`;
  if (decoded > 0) s += ` · ${formatBytes(decoded)} decoded`;
  if (wire > 0 && decoded > wire) s += ` (${ENCODING[enc] ? `${ENCODING[enc]}, ` : ''}${Math.round((1 - wire / decoded) * 100)}% smaller)`;
  return s;
}

const age = (s) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`);

export function cacheFact(e) {
  const src = e?._fromCache === 'disk' ? 'from disk cache'
    : e?._fromCache === 'memory' ? 'from memory cache'
      : e?._fromServiceWorker ? 'from the service worker'
        : 'fetched over the network';
  const cc = resHeader(e, 'cache-control');
  if (!cc) return src;
  const m = /max-age=(\d+)/i.exec(cc);
  const note = !m ? '' : Number(m[1]) === 0 ? ' (revalidated every time)' : ` (fresh for ${age(Number(m[1]))})`;
  return `${src} · ${cc}${note}`;
}

/** The Overview tab: [label, sentence] pairs, in a fixed order, with empty ones dropped. */
export function requestFacts(e, { entries = [], index = -1, pageUrl, site, renderBlocking, start } = {}) {
  const url = e?.request?.url || '';
  const reused = e?.connection && entries.slice(0, Math.max(0, index)).some((x) => x.connection === e.connection);
  const protocol = [protocolName(e?.response?.httpVersion || e?.request?.httpVersion), e?._priority && `priority ${e._priority}`, reused && 'reused connection'].filter(Boolean).join(' · ');
  const st = num(e?.response?.status);
  const status = st > 0 ? `${st} ${e.response.statusText || REASON[st] || ''}`.trim() : '';
  let blocking = '';
  if (Array.isArray(renderBlocking)) blocking = renderBlocking.includes(url) ? 'yes' : renderBlocking.length >= RB_CAP ? '' : 'no';
  const timing = Number.isFinite(start) && num(e?.time) >= 0 ? `starts at ${formatMs(start)}, takes ${formatMs(e.time)}` : '';
  return [
    ['URL', url], ['Requested by', requestedBy(e)], ['Origin', originFact(url, pageUrl, site)], ['Protocol', protocol],
    ['Status', status], ['Size', sizeFact(e)], ['Cache', cacheFact(e)], ['Render blocking', blocking], ['Timing', timing],
    ['Error', e?._error || ''],
  ].filter(([, v]) => v);
}

const HEADER_LINES = 12;
const BODY_CHARS = 2000;

function headerLines(headers, extra) {
  const hs = [...extra, ...(headers || []).filter((x) => !String(x.name).startsWith(':'))];
  const lines = hs.slice(0, HEADER_LINES).map((x) => ({ kind: 'header', name: x.name, text: `${x.name}: ${x.value}` }));
  if (hs.length > HEADER_LINES) lines.push({ kind: 'more', text: `…${hs.length - HEADER_LINES} more headers` });
  return lines;
}

function bodyLines(text, encoding, size) {
  if (text == null || text === '') return size > 0 ? [{ kind: 'more', text: `[body not captured, ${formatBytes(size)}]` }] : [];
  if (encoding === 'base64') return [{ kind: 'more', text: `[binary body, ${formatBytes(size > 0 ? size : Math.floor((text.length * 3) / 4))}]` }];
  const out = [{ kind: 'body', text: text.slice(0, BODY_CHARS) }];
  if (text.length > BODY_CHARS) out.push({ kind: 'more', text: `…${text.length - BODY_CHARS} more characters` });
  return out;
}

/** The request and response as HTTP/1.1-style text (whatever the protocol), trimmed for reading. */
export function wireText(e) {
  const req = e?.request || {};
  const res = e?.response || {};
  const proto = protocolName(req.httpVersion || res.httpVersion) || 'HTTP/1.1';
  let path = req.url || '';
  try { const u = new URL(req.url); path = u.pathname + u.search; } catch { /* keep the raw URL */ }
  const host = hostOf(req.url);
  const hasHost = (req.headers || []).some((x) => /^host$/i.test(x.name));
  const request = [{ kind: 'start', text: `${req.method || 'GET'} ${path} ${proto}` }, ...headerLines(req.headers, hasHost || !host ? [] : [{ name: 'Host', value: host }])];
  if (req.postData?.text) request.push({ kind: 'blank', text: '' }, ...bodyLines(req.postData.text, req.postData.encoding, req.postData.text.length));
  const st = num(res.status);
  if (!(st > 0)) return { request, response: [{ kind: 'more', text: `(no response — ${e?._error || 'request failed'})` }] };
  const c = res.content || {};
  const response = [{ kind: 'start', text: `${protocolName(res.httpVersion) || proto} ${st} ${res.statusText || REASON[st] || ''}`.trim() }, ...headerLines(res.headers, [])];
  const body = bodyLines(c.text, c.encoding, num(c.size));
  if (body.length) response.push({ kind: 'blank', text: '' }, ...body);
  return { request, response };
}
