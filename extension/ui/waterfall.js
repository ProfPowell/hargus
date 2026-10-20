// Network waterfall model: pure functions over a reading — the timeline (bars, phases, ticks, page markers),
// sorting and the plain-English facts and wire text of one request. No DOM: report.js renders it.

import { transferSize, resourceType, hostOf, originOf, isThirdParty, siteOf, resHeader, formatBytes, formatMs } from '../core/har-util.js';

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

const niceStep = (width) => {
  const raw = width / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
};

/** Round ruler ticks: a 1, 2, 2.5 or 5 × 10^n step giving four to six ticks across [from, to]. */
export function niceTicks(to, from = 0) {
  const width = to - from;
  if (!(width > 0)) return [from > 0 ? from : 0];
  const step = niceStep(width);
  const out = [];
  for (let k = Math.ceil((from - 1e-9) / step); k * step <= to + 1e-9; k++) out.push(Math.round(k * step * 1000) / 1000 + 0);
  return out;
}

/** Page events in ms from the page start: DOMContentLoaded and load from the HAR page, FCP and LCP from the vitals plugin. */
export function pageMarkers(reading) {
  const pt = reading?.log?.pages?.[0]?.pageTimings || {};
  const v = reading?.log?._harplus?.plugins?.vitals?.data || {};
  const at = { dcl: num(pt.onContentLoad), load: num(pt.onLoad), fcp: num(v.fcp), lcp: num(v.lcp?.time) };
  return MARKERS.filter((m) => at[m.key] > 0).map((m) => ({ ...m, ms: at[m.key] })).sort((a, b) => a.ms - b.ms);
}

/**
 * Everything the waterfall draws. `span` is the whole load (the last request end or the last marker); `view`
 * ({from, to} in ms) zooms the drawing to a window of it: percentages are of the window, bars crossing an edge
 * are clipped and flagged, ticks and markers outside are dropped.
 */
export function timelineModel(reading, view) {
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
  const win = view ? clampWindow(view, span) : { from: 0, to: span };
  const width = win.to - win.from;
  const rawPct = (ms) => Math.max(0, Math.min(100, ((ms - win.from) / width) * 100));
  const pct = (ms) => round2(rawPct(ms));
  // Width from the unrounded edges, so an unclipped bar keeps exactly the width it had before windows existed (33.33, not 33.34).
  const place = (a, b) => ({
    left: pct(a), width: round2(Math.max(0, rawPct(b) - rawPct(a))),
    clipStart: a < win.from && b > win.from, clipEnd: b > win.to && a < win.to,
  });
  const bars = entries.map((e, i) => {
    const { segments, known } = phaseSegments(e.timings, e.time);
    const ok = Number.isFinite(rel[i]);
    if (!ok) return { start: null, end: null, left: 0, width: 0, segments, known: false, clipStart: false, clipEnd: false };
    const end = rel[i] + Math.max(0, num(e.time) || 0);
    const p = place(rel[i], end);
    return { start: rel[i], end, left: p.left, width: known ? p.width : 0, segments, known, clipStart: known && p.clipStart, clipEnd: known && p.clipEnd };
  });
  return {
    t0, span, window: win, place,
    ticks: niceTicks(win.to, win.from).map((ms) => ({ ms, left: pct(ms) })),
    markers: markers.filter((m) => m.at >= win.from && m.at <= win.to).map((m) => ({ ...m, left: pct(m.at) })),
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
  const where = i.url ? ` (${[displayUrl(i.url), line].filter(Boolean).join(', ')})` : line ? ` (${line})` : '';
  switch (i.type) {
    case 'parser': return `${ELEMENT[resourceType(e)] || 'an element'} in the page's HTML${where}`;
    case 'script': return `a script${where}`;
    case 'preload': return `a preload${where}`;
    case 'preflight': return 'a CORS preflight';
    case 'redirect': return `a redirect${i.url ? ` from ${displayUrl(i.url)}` : ''}`;
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

/** A data: URL is its whole payload; show its type and size instead. Any other URL is returned unchanged. */
export function displayUrl(url) {
  const u = String(url ?? '');
  if (!/^data:/i.test(u)) return u;
  const comma = u.indexOf(',');
  if (comma < 0) return `data:… (${formatBytes(u.length - 5)})`; // malformed: no payload marker, so never echo any of it
  const head = u.slice(5, comma);
  const payload = u.slice(comma + 1);
  const base64 = /;base64$/i.test(head);
  const mime = midTrunc(head.split(';')[0], 40);
  const size = base64 ? Math.max(0, Math.floor((payload.length * 3) / 4) - (payload.match(/=*$/)[0].length)) : payload.length;
  return `data:${mime}${base64 ? ';base64' : ''},… (${base64 ? '' : '~'}${formatBytes(size)})`; // non-base64: the encoded length, so approximate
}

const directive = (cc, name) => {
  const m = new RegExp(`(?:^|[\\s,])${name}=(\\d+)(?=$|[\\s,])`, 'i').exec(cc);
  return m && Number.isFinite(Number(m[1])) ? Number(m[1]) : null;
};
const has = (cc, name, bare = false) => new RegExp(`(?:^|[\\s,])${name}(?=$|[\\s,${bare ? '' : '='}])`, 'i').test(cc);

/** The note a Cache-Control value earns on its own; '' when it says nothing about freshness. */
function ccNote(cc) {
  if (!cc) return '';
  if (has(cc, 'no-store')) return 'not stored';
  const n = directive(cc, 'max-age');
  const sm = directive(cc, 's-maxage');
  if (has(cc, 'no-cache', true) || n === 0) return 'revalidated every time';
  if (n > 0) {
    let t = `fresh for ${age(n)}`;
    if (has(cc, 'immutable')) t += ', never revalidated';
    const swr = directive(cc, 'stale-while-revalidate');
    if (swr != null) t += `, then served stale for ${age(swr)} while revalidating`;
    if (sm != null && sm !== n) t += `; shared caches: ${age(sm)}`;
    if (has(cc, 'private', true)) t += '; browser only';
    return t;
  }
  return sm != null ? `fresh in shared caches for ${age(sm)}` : '';
}

/** The note from Expires against Date (or the request start); an unparseable Expires is already expired (RFC 9111 §5.3). */
function expiresNote(e, exp) {
  const at = Date.parse(exp);
  if (!Number.isFinite(at)) return 'expired on arrival';
  const from = Date.parse(resHeader(e, 'date')) || Date.parse(e?.startedDateTime);
  if (!Number.isFinite(from)) return '';
  const d = (at - from) / 1000;
  return d > 0 ? `fresh for ${age(Math.round(d))}` : 'expired on arrival';
}

export function cacheFact(e) {
  const src = e?._fromCache === 'disk' ? 'from disk cache'
    : e?._fromCache === 'memory' ? 'from memory cache'
      : e?._fromServiceWorker ? 'from the service worker'
        : 'fetched over the network';
  const cc = resHeader(e, 'cache-control');
  const exp = resHeader(e, 'expires');
  const head = cc ? `${src} · ${cc}` : src;
  const note = ccNote(cc);
  if (note) return `${head} (${note})`;
  if (exp == null || exp === '') return head;
  // The note comes from Expires, so the fact shows the header it came from.
  const en = expiresNote(e, exp);
  return `${head} · Expires: ${exp}${en ? ` (${en})` : ''}`;
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
    ['URL', displayUrl(url)], ['Requested by', requestedBy(e)], ['Origin', originFact(url, pageUrl, site)], ['Protocol', protocol],
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
  if (/^data:/i.test(req.url || '')) path = displayUrl(req.url);
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

/* ------------------------------------------------------------- LCP path */

export const MAX_HOPS = 20;

const fileName = (url) => {
  if (/^data:/i.test(String(url || ''))) return displayUrl(url);
  try { const u = new URL(url); return u.pathname.split('/').filter(Boolean).pop() || u.hostname; } catch { return String(url || ''); }
};
const okStatus = (e) => { const s = num(e?.response?.status); return s >= 200 && s < 400; };
const absolute = (url, base) => { try { return new URL(url, base).href; } catch { return ''; } };

/**
 * The parent of request i: the latest-starting request at or before it that redirected to it,
 * or else the one whose URL is its initiator's URL. -1 when there is none.
 */
function parentOf(entries, model, i) {
  const e = entries[i];
  const start = model.bars[i].start;
  const before = (k) => k !== i && (start == null || model.bars[k].start == null ? k < i : model.bars[k].start <= start);
  const url = e.request?.url;
  let best = -1;
  // A redirect hop carries its original request's initiator (CDP gives no `redirect` type), so the redirecting request comes first.
  entries.forEach((x, k) => {
    const to = x.response?.redirectURL;
    if (to && absolute(to, x.request?.url) === url && before(k) && (best < 0 || (model.bars[k].start ?? -1) >= (model.bars[best].start ?? -1))) best = k;
  });
  if (best >= 0) return best;
  const iu = e._initiator?.url;
  if (iu) {
    entries.forEach((x, k) => {
      if (x.request?.url === iu && before(k) && (best < 0 || (model.bars[k].start ?? -1) >= (model.bars[best].start ?? -1))) best = k;
    });
  }
  return best;
}

/** The requests that led to LCP: the initiator chain to the LCP resource (or the document for text), plus render-blocking requests that finished first. */
export function lcpPath(reading) {
  const log = reading?.log || {};
  const entries = log.entries || [];
  const v = log._harplus?.plugins?.vitals?.data || {};
  const ms = num(v.lcp?.time);
  if (!(ms >= 0) || !entries.length) return null;
  const model = timelineModel(reading);
  const t = log._harplus?.target || {};
  const docUrl = t.finalUrl || t.url;
  let doc = entries.findIndex((e) => resourceType(e) === 'document' && e.request?.url === docUrl);
  if (doc < 0) doc = entries.findIndex((e) => resourceType(e) === 'document');
  if (doc < 0) doc = 0;
  const url = v.lcp.url;
  let target = -1;
  if (url) {
    target = entries.findIndex((e) => e.request?.url === url && okStatus(e));
    if (target < 0) target = entries.findIndex((e) => e.request?.url === url);
  }
  const kind = target >= 0 ? 'resource' : 'text';
  const missing = Boolean(url) && target < 0;
  const hops = [];
  if (kind === 'resource') {
    const seen = new Set();
    for (let cur = target; cur >= 0 && !seen.has(cur) && hops.length < MAX_HOPS; cur = parentOf(entries, model, cur)) {
      seen.add(cur);
      hops.unshift(cur);
    }
  } else hops.push(doc);
  const lcpAt = model.markers.find((m) => m.key === 'lcp')?.at ?? ms;
  const rb = new Set(Array.isArray(v.renderBlocking) ? v.renderBlocking : []);
  const blocking = [];
  const seenUrl = new Set();
  entries.forEach((e, i) => {
    const u = e.request?.url;
    if (!rb.has(u) || seenUrl.has(u) || hops.includes(i)) return;
    seenUrl.add(u);
    const b = model.bars[i];
    if (b.start != null && b.start + Math.max(0, num(e.time) || 0) <= lcpAt) blocking.push(i);
  });
  const label = missing ? 'LCP resource not in the request list'
    : kind === 'resource' ? fileName(entries[target].request.url)
      : `text${v.lcp.element ? ` (${v.lcp.element})` : ''}`;
  return { kind, ms, label, hops, blocking, missing };
}

/** One line naming each hop and its time, for the summary above the table. */
export function pathSummary(reading, path, visible) {
  if (!path) return '';
  const entries = reading?.log?.entries || [];
  const name = (i) => (resourceType(entries[i]) === 'document' ? 'document' : fileName(entries[i].request?.url));
  const hidden = (i) => (visible && !visible.has(i) ? ' (hidden by filter)' : '');
  const hop = (i) => `${name(i)} ${formatMs(entries[i].time)}${hidden(i)}`;
  const n = path.blocking.length;
  if (path.kind === 'resource') {
    return `LCP ${formatMs(path.ms)} — ${path.label}, reached in ${path.hops.length} hop${path.hops.length === 1 ? '' : 's'}: ${path.hops.map(hop).join(' → ')}${n ? ` (+${n} render-blocking)` : ''}`;
  }
  return `LCP ${formatMs(path.ms)} — ${path.label}: ${path.hops.map(hop).join(' → ')}${n ? ` + ${n} render-blocking (${path.blocking.map(name).join(', ')})` : ''}`;
}

/* ------------------------------------------------------------ site groups */

/** Third-party sites with 2+ rows collapse into one group, placed where their first row was; everything else passes through. */
export function groupRows(rows, site, model) {
  const keyOf = (r) => { const h = hostOf(r.e.request?.url); return h && isThirdParty(h, site) ? siteOf(h) : null; };
  const buckets = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const out = [];
  const placed = new Set();
  for (const r of rows) {
    const k = keyOf(r);
    const members = k ? buckets.get(k) : null;
    if (!members || members.length < 2) { out.push(r); continue; }
    if (placed.has(k)) continue;
    placed.add(k);
    let start = Infinity, end = -Infinity;
    for (const m of members) {
      const s = model.bars[m.i]?.start;
      if (s == null) continue;
      start = Math.min(start, s);
      end = Math.max(end, s + Math.max(0, num(m.e.time) || 0));
    }
    if (!Number.isFinite(start)) { start = 0; end = 0; }
    out.push({ group: k, rows: members, count: members.length, bytes: members.reduce((t, m) => t + transferSize(m.e), 0), start, end });
  }
  return out;
}

/* ------------------------------------------------------------ zoom window */

export const MIN_WINDOW = 10;

/** A window inside [0, span], at least MIN_WINDOW wide (or the whole span when it is shorter); anything invalid → the whole load. */
export function clampWindow(w, span) {
  const S = num(span) > 0 ? span : 1;
  const from = num(w?.from);
  const to = num(w?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return { from: 0, to: S };
  const width = Math.min(S, Math.max(MIN_WINDOW, to - from));
  let f = Math.max(0, Math.min(from, S - width));
  if (f <= 1e-6) f = 0;
  return { from: f, to: f + width >= S - 1e-6 ? S : f + width };
}

/** Zoom by `factor` (< 1 zooms in) keeping `center` (ms) at the same place on screen. */
export function zoomAt(w, center, factor, span) {
  const cur = clampWindow(w, span);
  const width = (cur.to - cur.from) * factor;
  const frac = (center - cur.from) / (cur.to - cur.from);
  const from = center - frac * width;
  return clampWindow({ from, to: from + width }, span);
}

export const isZoomed = (w, span) => Boolean(w) && (w.from > 0 || w.to < span);

/** Bars for the overview strip, on the whole-load span: each in the first lane free at its start, else the lane that frees soonest. */
export function overviewLanes(model, laneCount = 12) {
  laneCount = Math.max(1, laneCount | 0 || 12);
  const ends = Array(laneCount).fill(-Infinity);
  const out = [];
  const order = model.bars.map((b, i) => [b, i]).filter(([b]) => b.start != null).sort((a, b) => a[0].start - b[0].start || a[1] - b[1]);
  for (const [b, i] of order) {
    let lane = ends.findIndex((x) => x <= b.start);
    if (lane < 0) lane = ends.indexOf(Math.min(...ends));
    ends[lane] = b.end;
    out.push({ i, lane, left: round2((b.start / model.span) * 100), width: round2(((b.end - b.start) / model.span) * 100) });
  }
  return out;
}
