// Turns Chrome DevTools Protocol Network/Page events into HAR 1.2 pages and entries.
// Environment-neutral: feed it events (from chrome.debugger, Puppeteer, Playwright CDPSession…)
// and call build(). The capture layer decides which response bodies to fetch.

import { originOf } from './har-util.js';

const round = (n) => Math.round(n * 1000) / 1000;
const encoder = new TextEncoder();

export class HarRecorder {
  constructor({ bodies = 'text', maxBodyBytes = 1_000_000 } = {}) {
    this.opts = { bodies, maxBodyBytes };
    this.mainFrameId = null;
    this.live = new Map();    // key → newest record for a requestId
    this.records = [];        // every request hop, in start order
    this.extra = new Map();   // key → { req: [], res: [] } ExtraInfo events (raw headers, cookies)
    this.pages = [];
    this.tls = {};            // origin → certificate/connection summary
    this.base = null;         // { ts, wall } maps CDP monotonic time to wall-clock time
    this.inflight = new Set();
    this.lastActivity = Date.now();
    this.lastBusyActivity = this.lastActivity; // activity from requests that count towards "busy"
    this.loadedAt = null;                      // set by the capture layer: lets touch() judge long-lived requests
    this.targets = new Map(); // child sessionId → target type (iframe, worker)
  }

  key(sessionId, requestId) { return `${sessionId || ''}|${requestId}`; }
  wall(ts) { return this.base ? this.base.wall + (ts - this.base.ts) : Date.now() / 1000; }
  currentPage() { return this.pages[this.pages.length - 1]; }

  // A cross-site iframe's document request starts in the parent target's session but its
  // response/finish events arrive in the iframe's own session — fall back to the parent's record.
  resolveKey(sessionId, requestId) {
    const own = this.key(sessionId, requestId);
    if (!sessionId || this.live.has(own)) return own;
    const parent = this.key(undefined, requestId);
    return this.live.has(parent) ? parent : own;
  }
  get(requestId, sessionId) { return this.live.get(this.resolveKey(sessionId, requestId)); }
  touch(rec) {
    const now = Date.now();
    this.lastActivity = now;
    if (!rec || this.counts(rec, now, this.loadedAt)) this.lastBusyActivity = now;
  }

  /** Does this request keep the page "busy"? Streams, sockets, media and long-polls after load do not. */
  counts(rec, now, loadedAt, longMs = 5000) {
    if (['WebSocket', 'EventSource', 'Media'].includes(rec?.type)) return false;
    if (loadedAt != null && loadedAt <= now && rec?.startedAt != null && now - rec.startedAt > longMs) return false;
    return true;
  }

  /** In-flight requests that count towards "busy". */
  busy(now, loadedAt) {
    let n = 0;
    for (const key of this.inflight) if (this.counts(this.live.get(key), now, loadedAt)) n++;
    return n;
  }

  /** Feed one CDP event. Returns the affected record (if any). */
  handle(method, p, sessionId) {
    switch (method) {
      case 'Network.requestWillBeSent': return this.onRequest(p, sessionId);
      case 'Network.requestWillBeSentExtraInfo': return this.onExtra('req', p, sessionId);
      case 'Network.responseReceivedExtraInfo': return this.onExtra('res', p, sessionId);
      case 'Network.responseReceived': return this.onResponse(p, sessionId);
      case 'Network.dataReceived': {
        const rec = this.get(p.requestId, sessionId);
        if (rec) { rec.dataLength += p.dataLength || 0; this.touch(rec); }
        return rec;
      }
      case 'Network.requestServedFromCache': {
        const rec = this.get(p.requestId, sessionId);
        if (rec) rec.fromMemoryCache = true;
        return rec;
      }
      case 'Network.loadingFinished': return this.onDone(p, sessionId);
      case 'Network.loadingFailed': return this.onDone(p, sessionId, true);
      case 'Page.domContentEventFired': return this.onPageTiming('onContentLoad', p, sessionId);
      case 'Page.loadEventFired': return this.onPageTiming('onLoad', p, sessionId);
      case 'Page.frameNavigated':
        if (!sessionId && !p.frame.parentId) {
          this.mainFrameId ??= p.frame.id;
          const page = this.currentPage();
          if (page) page.url = p.frame.url;
        }
        return undefined;
      default: return undefined;
    }
  }

  onRequest(p, sessionId) {
    const url = p.request?.url || '';
    const key = this.key(sessionId, p.requestId);
    const prev = this.live.get(key);
    if (prev && p.redirectResponse) {
      prev.response = p.redirectResponse;
      prev.respTs = p.timestamp;
      prev.endTs = p.timestamp;
      prev.encodedDataLength = p.redirectResponse.encodedDataLength || 0;
      this.noteTLS(prev.request.url, p.redirectResponse);
    }
    // Not part of the site's conversation: inline data, blobs, and other extensions' resources.
    if (/^(data|blob|chrome-extension|moz-extension|safari-web-extension|chrome|devtools|about):/i.test(url)) {
      // A content blocker redirecting a request to its own stub: keep the redirect hop, ignore the stub.
      if (prev && p.redirectResponse) { this.live.delete(key); this.inflight.delete(key); this.touch(); }
      return undefined;
    }
    if (!this.base && p.wallTime) this.base = { ts: p.timestamp, wall: p.wallTime };
    const isNav = p.type === 'Document' && !sessionId && p.requestId === p.loaderId &&
      (this.mainFrameId == null || p.frameId === this.mainFrameId);
    if (isNav && !p.redirectResponse) this.startPage(p);
    if (!this.currentPage()) this.startPage(p, true);

    const rec = {
      key, sessionId, requestId: p.requestId,
      hop: prev && p.redirectResponse ? prev.hop + 1 : 0,
      frameId: p.frameId, type: p.type, request: p.request, initiator: p.initiator,
      wsTs: p.timestamp, wallTime: p.wallTime ?? this.wall(p.timestamp),
      startedAt: Date.now(),
      pageref: this.currentPage().id, dataLength: 0, encodedDataLength: 0,
      targetType: sessionId ? this.targets.get(sessionId) || 'child' : undefined,
    };
    this.live.set(key, rec);
    this.records.push(rec);
    this.inflight.add(key);
    this.touch(rec);
    return rec;
  }

  onExtra(kind, p, sessionId) {
    const key = this.resolveKey(sessionId, p.requestId);
    const ex = this.extra.get(key) || { req: [], res: [] };
    ex[kind].push(p);
    this.extra.set(key, ex);
    return undefined;
  }

  onResponse(p, sessionId) {
    const rec = this.get(p.requestId, sessionId);
    if (!rec) return undefined;
    rec.response = p.response;
    rec.respTs = p.timestamp;
    rec.type = p.type || rec.type;
    this.noteTLS(rec.request.url, p.response);
    this.touch(rec);
    return rec;
  }

  onDone(p, sessionId, failed = false) {
    const key = this.resolveKey(sessionId, p.requestId);
    const rec = this.live.get(key);
    this.inflight.delete(key);
    this.touch(rec);
    if (!rec) return undefined;
    rec.endTs = p.timestamp;
    if (failed) rec.failed = { errorText: p.errorText, canceled: p.canceled, blockedReason: p.blockedReason };
    else rec.encodedDataLength = p.encodedDataLength ?? rec.encodedDataLength;
    return rec;
  }

  onPageTiming(field, p, sessionId) {
    if (sessionId) return undefined;
    const page = this.currentPage();
    if (page && page[field] < 0) page[field] = (p.timestamp - page.startTs) * 1000;
    return undefined;
  }

  startPage(p, implicit = false) {
    this.pages.push({
      id: `page_${this.pages.length + 1}`,
      startTs: p.timestamp,
      wall: p.wallTime ?? this.wall(p.timestamp),
      url: p.request?.url || p.documentURL || '',
      title: '',
      onContentLoad: -1,
      onLoad: -1,
      implicit,
    });
  }

  setPageTitle(title, pageId = this.currentPage()?.id) {
    const page = this.pages.find((x) => x.id === pageId);
    if (page && title) page.title = title;
  }

  noteTLS(url, response) {
    const sd = response?.securityDetails;
    const origin = originOf(url);
    if (!sd || !origin || this.tls[origin]) return;
    this.tls[origin] = {
      protocol: sd.protocol,
      keyExchange: sd.keyExchange || undefined,
      keyExchangeGroup: sd.keyExchangeGroup,
      cipher: sd.cipher,
      subjectName: sd.subjectName,
      issuer: sd.issuer,
      validFrom: new Date(sd.validFrom * 1000).toISOString(),
      validTo: new Date(sd.validTo * 1000).toISOString(),
      sanList: (sd.sanList || []).slice(0, 200),
      sanCount: (sd.sanList || []).length,
      sctCount: (sd.signedCertificateTimestampList || []).length,
      ctCompliance: sd.certificateTransparencyCompliance,
      ip: response.remoteIPAddress,
      httpProtocol: response.protocol,
    };
  }

  /** Should the capture layer fetch this record's body via Network.getResponseBody? */
  wantsBody(rec) {
    const { bodies, maxBodyBytes } = this.opts;
    if (!rec || bodies === 'none' || rec.failed || !rec.response) return false;
    if (rec.dataLength > maxBodyBytes) return false;
    const t = rec.type;
    const mime = rec.response.mimeType || '';
    if (['Media', 'WebSocket', 'EventSource'].includes(t)) return false;
    if (bodies === 'document') return t === 'Document';
    if (bodies === 'text') {
      return ['Document', 'Script', 'Stylesheet', 'XHR', 'Fetch', 'Manifest'].includes(t) ||
        /^text\/|json|xml|javascript|svg/.test(mime);
    }
    return true;
  }

  /** A child target went away: its unfinished requests will never complete. */
  dropSession(sessionId) {
    for (const key of [...this.inflight]) if (key.startsWith(`${sessionId}|`)) this.inflight.delete(key);
    this.touch();
  }

  // Match ExtraInfo events (raw headers incl. cookies) to request hops. Hops served from cache or
  // synthesized by Chrome (HSTS 307 "internal redirect") produce no ExtraInfo, so match by order
  // among network hops and confirm with the status code.
  assignExtra() {
    const byKey = new Map();
    for (const r of this.records) {
      if (!byKey.has(r.key)) byKey.set(r.key, []);
      byKey.get(r.key).push(r);
    }
    for (const [key, hops] of byKey) {
      const ex = this.extra.get(key);
      if (!ex) continue;
      let qi = 0; let si = 0;
      for (const rec of hops) {
        const res = rec.response;
        const internal = res && Object.keys(res.headers || {}).some((h) => h.toLowerCase() === 'non-authoritative-reason');
        const network = !internal && !rec.fromMemoryCache && !res?.fromDiskCache && !res?.fromPrefetchCache;
        if (!network) continue;
        if (ex.req[qi]) rec.reqX = ex.req[qi++];
        const cand = ex.res[si];
        if (res && cand && (cand.statusCode == null || cand.statusCode === res.status)) { rec.resX = cand; si++; }
      }
    }
  }

  /** Assemble HAR pages + entries. dropImplicit: discard traffic from before the first real navigation. */
  build({ dropImplicit = false } = {}) {
    this.assignExtra();
    let pages = this.pages;
    if (dropImplicit && pages.some((p) => !p.implicit)) pages = pages.filter((p) => !p.implicit);
    const keep = new Set(pages.map((p) => p.id));
    const entries = this.records
      .filter((r) => keep.has(r.pageref))
      .sort((a, b) => a.wsTs - b.wsTs)
      .map((r) => this.toEntry(r))
      .filter(Boolean);
    return {
      pages: pages.map((p) => ({
        startedDateTime: new Date(p.wall * 1000).toISOString(),
        id: p.id,
        title: p.title || p.url,
        pageTimings: { onContentLoad: round(p.onContentLoad), onLoad: round(p.onLoad) },
      })),
      entries,
      tls: this.tls,
    };
  }

  toEntry(rec) {
    const req = rec.request;
    const res = rec.response;
    let url;
    try { url = new URL(req.url); } catch { return null; }
    const reqX = rec.reqX;
    const resX = rec.resX;
    const reqHeaders = toHarHeaders(reqX?.headers || req.headers);
    const resHeaders = res ? toHarHeaders(resX?.headers || res.headers) : [];
    const timings = computeTimings(rec);
    const time = round(['blocked', 'dns', 'connect', 'send', 'wait', 'receive']
      .reduce((s, k) => s + Math.max(0, timings[k]), 0));
    const httpVersion = res?.protocol || '';
    const transfer = rec.encodedDataLength || 0;
    const headersSize = resX?.headersText ? resX.headersText.length : -1;

    const content = { size: rec.dataLength || 0, mimeType: res?.mimeType || 'x-unknown' };
    if (rec.body) {
      content.text = rec.body.text;
      if (rec.body.base64) content.encoding = 'base64';
    }

    const entry = {
      pageref: rec.pageref,
      startedDateTime: new Date(rec.wallTime * 1000).toISOString(),
      time,
      request: {
        method: req.method,
        url: req.url,
        httpVersion,
        cookies: parseCookieHeader(findHeader(reqHeaders, 'cookie')),
        headers: reqHeaders,
        queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
        headersSize: -1,
        bodySize: req.postData ? encoder.encode(req.postData).length : 0,
      },
      response: {
        status: res?.status ?? 0,
        statusText: res?.statusText ?? '',
        httpVersion,
        cookies: parseSetCookies(resHeaders.filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value)),
        headers: resHeaders,
        content,
        redirectURL: findHeader(resHeaders, 'location') || '',
        headersSize,
        bodySize: res ? (headersSize > 0 ? Math.max(0, transfer - headersSize) : transfer) : -1,
        _transferSize: transfer,
      },
      cache: {},
      timings,
    };
    if (req.postData) entry.request.postData = { mimeType: findHeader(reqHeaders, 'content-type') || '', text: req.postData };
    if (res?.remoteIPAddress) entry.serverIPAddress = res.remoteIPAddress.replace(/^\[|\]$/g, '');
    if (res?.connectionId) entry.connection = String(res.connectionId);
    entry._resourceType = (rec.type || 'Other').toLowerCase();
    if (req.initialPriority) entry._priority = req.initialPriority;
    if (rec.initiator) entry._initiator = compactInitiator(rec.initiator);
    if (res?.fromDiskCache) entry._fromCache = 'disk';
    else if (rec.fromMemoryCache) entry._fromCache = 'memory';
    if (res?.fromServiceWorker) entry._fromServiceWorker = true;
    if (res?.remotePort) entry._remotePort = res.remotePort;
    if (rec.failed) {
      entry._error = rec.failed.errorText + (rec.failed.blockedReason ? ` (${rec.failed.blockedReason})` : '');
      if (rec.failed.canceled) entry._canceled = true;
    }
    if (!rec.endTs && !rec.failed) entry._incomplete = true;
    if (rec.targetType) entry._target = rec.targetType;
    return entry;
  }
}

/* ---------------------------------------------------------------- helpers */

export function toHarHeaders(obj) {
  return Object.entries(obj || {}).flatMap(([name, v]) =>
    String(v).split('\n').map((value) => ({ name, value })));
}

function findHeader(headers, name) {
  return headers.find((h) => h.name.toLowerCase() === name)?.value;
}

export function parseCookieHeader(value) {
  if (!value) return [];
  return value.split(/;\s*/).filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    return i < 0 ? { name: pair.trim(), value: '' } : { name: pair.slice(0, i).trim(), value: pair.slice(i + 1) };
  });
}

export function parseSetCookies(lines = []) {
  return lines.filter(Boolean).map((line) => {
    const [nv, ...attrs] = line.split(';');
    const i = nv.indexOf('=');
    const cookie = { name: (i < 0 ? nv : nv.slice(0, i)).trim(), value: i < 0 ? '' : nv.slice(i + 1).trim() };
    for (const a of attrs) {
      const [k, ...rest] = a.split('=');
      const key = k.trim().toLowerCase();
      const val = rest.join('=').trim();
      if (key === 'path') cookie.path = val;
      else if (key === 'domain') cookie.domain = val;
      else if (key === 'expires') {
        const d = new Date(val);
        if (!isNaN(d)) cookie.expires = d.toISOString();
      } else if (key === 'max-age') cookie._maxAge = Number(val);
      else if (key === 'httponly') cookie.httpOnly = true;
      else if (key === 'secure') cookie.secure = true;
      else if (key === 'samesite') cookie.sameSite = val;
      else if (key === 'partitioned') cookie._partitioned = true;
    }
    return cookie;
  });
}

function compactInitiator(i) {
  const frame = i.stack?.callFrames?.[0];
  const out = { type: i.type };
  const url = i.url || frame?.url;
  if (url) out.url = url;
  const line = i.lineNumber ?? frame?.lineNumber;
  if (line != null) out.lineNumber = line;
  return out;
}

/** HAR timings from CDP ResourceTiming (all offsets in ms relative to timing.requestTime). */
export function computeTimings(rec) {
  const t = rec.response?.timing;
  const end = rec.endTs ?? rec.respTs ?? rec.wsTs;
  const out = { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 0, receive: 0 };
  if (!t) {
    const respTs = rec.respTs ?? end;
    out.wait = round(Math.max(0, (respTs - rec.wsTs) * 1000));
    out.receive = round(Math.max(0, (end - respTs) * 1000));
    return out;
  }
  const queued = Math.max(0, (t.requestTime - rec.wsTs) * 1000);
  const firstStart = [t.dnsStart, t.connectStart, t.sendStart].find((v) => v >= 0) ?? 0;
  out.blocked = round(queued + Math.max(0, firstStart));
  if (t.dnsStart >= 0) out.dns = round(t.dnsEnd - t.dnsStart);
  if (t.connectStart >= 0) out.connect = round(t.connectEnd - t.connectStart);
  if (t.sslStart >= 0) out.ssl = round(t.sslEnd - t.sslStart);
  out.send = round(Math.max(0, t.sendEnd - t.sendStart));
  out.wait = round(Math.max(0, t.receiveHeadersEnd - t.sendEnd));
  out.receive = round(Math.max(0, (end - t.requestTime) * 1000 - t.receiveHeadersEnd));
  return out;
}
