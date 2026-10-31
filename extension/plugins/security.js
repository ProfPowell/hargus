// Offline security review of the recording: transport, TLS certificate, security headers,
// CSP quality, cookie flags, mixed content and information disclosure.

import { mainEntry, redirectChain, resHeader, headerAll, hostOf, originOf, daysBetween, plural, resourceType } from '../core/har-util.js';

function parseCSP(value = '') {
  const map = {};
  for (const part of value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name && !(name.toLowerCase() in map)) map[name.toLowerCase()] = sources;
  }
  return map;
}

const SESSIONISH = /sess|sid|auth|token|jwt|login|remember/i;

function run(reading, ctx) {
  const main = mainEntry(reading);
  if (!main) ctx.skip('no main document in the recording');
  const findings = [];
  // places: the requests, scripts or cookies a finding is about, capped at 200; evidence is kept as it was.
  const add = (severity, title, detail, evidence, ref, places) => findings.push({ severity, category: 'security', title, detail, evidence, ref, ...(places?.length ? { places: places.slice(0, 200) } : {}) });
  const url = main.request.url;
  const https = url.startsWith('https:');
  const h = (name) => resHeader(main, name);
  const synthetic = !!main._synthetic;
  if (synthetic) ctx.skip('snapshot reading has no response headers — take a reload reading');

  // Transport
  const chain = redirectChain(reading, main);
  if (!https) add('high', 'Page is served over plain HTTP');
  const upgraded = chain.length > 1 && chain[0].request.url.startsWith('http:') && https;

  // Security headers
  const hsts = h('strict-transport-security');
  const maxAge = Number((hsts?.match(/max-age=(\d+)/i) || [])[1] || 0);
  const cspHeaders = headerAll(main.response.headers, 'content-security-policy');
  const cspHeader = cspHeaders.join(', ') || undefined;
  const cspRO = h('content-security-policy-report-only');
  const cspMeta = ctx.results.meta?.data?.cspMeta;
  const cspValue = cspHeaders[0] || cspMeta || '';
  const csp = parseCSP(cspValue);
  const xfo = h('x-frame-options');
  // frame-ancestors only works when delivered as a header (browsers ignore it in <meta>); any header policy counts.
  const frameAncestors = cspHeaders.map(parseCSP).find((p) => p['frame-ancestors'])?.['frame-ancestors'];
  const headers = [
    { label: 'Strict-Transport-Security', value: hsts || (https ? undefined : 'n/a — page is HTTP'), ok: https && maxAge >= 15_552_000 },
    { label: 'Content-Security-Policy', value: cspHeader || (cspMeta ? `${cspMeta} (meta)` : cspRO ? `${cspRO} (report-only)` : undefined), ok: !!cspValue },
    { label: 'Clickjacking (X-Frame-Options / frame-ancestors)', value: xfo || (frameAncestors ? `frame-ancestors ${frameAncestors.join(' ')}` : undefined), ok: !!(xfo || frameAncestors) },
    { label: 'X-Content-Type-Options', value: h('x-content-type-options'), ok: /nosniff/i.test(h('x-content-type-options') || '') },
    { label: 'Referrer-Policy', value: h('referrer-policy'), ok: !!h('referrer-policy') },
    { label: 'Permissions-Policy', value: h('permissions-policy'), ok: !!h('permissions-policy') },
    { label: 'Cross-Origin-Opener-Policy', value: h('cross-origin-opener-policy'), ok: !!h('cross-origin-opener-policy') },
  ];

  if (https && !hsts) add('medium', 'No Strict-Transport-Security header', 'Browsers may be downgraded to HTTP on first visit.', undefined, 'https://developer.mozilla.org/docs/Web/HTTP/Headers/Strict-Transport-Security');
  else if (https && maxAge < 15_552_000) add('low', `HSTS max-age is short (${Math.round(maxAge / 86400)} days)`, 'Six months or more is recommended.');
  if (!cspValue) add(cspRO ? 'low' : 'medium', cspRO ? 'Content-Security-Policy is report-only' : 'No Content-Security-Policy', 'CSP is the main defence-in-depth against XSS.', undefined, 'https://developer.mozilla.org/docs/Web/HTTP/CSP');
  else {
    const script = csp['script-src'] || csp['default-src'] || [];
    const hasNonceOrHash = script.some((s) => /^'(nonce|sha\d+)-/.test(s));
    if (script.includes("'unsafe-inline'") && !hasNonceOrHash && !script.includes("'strict-dynamic'")) add('medium', "CSP allows 'unsafe-inline' scripts");
    if (script.includes("'unsafe-eval'")) add('low', "CSP allows 'unsafe-eval'");
    if (script.some((s) => s === '*' || s === 'https:' || s === 'http:' || s === 'data:')) add('medium', 'CSP script sources include a wildcard or scheme-only source', script.join(' '));
    if (!csp['object-src'] && !(csp['default-src'] || []).includes("'none'")) add('low', 'CSP has no object-src restriction');
    if (!csp['base-uri']) add('info', 'CSP has no base-uri directive');
  }
  if (!xfo && !frameAncestors) add('medium', 'Page can be framed by other sites (no X-Frame-Options or frame-ancestors)');
  if (!/nosniff/i.test(h('x-content-type-options') || '')) add('low', 'Missing X-Content-Type-Options: nosniff');
  if (!h('referrer-policy')) add('info', 'No Referrer-Policy (browser default applies)');
  if (!h('permissions-policy')) add('info', 'No Permissions-Policy');

  // Information disclosure
  const disclosure = [];
  const server = h('server');
  if (server && /\d/.test(server)) disclosure.push(`Server: ${server}`);
  for (const name of ['x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version', 'x-generator', 'x-runtime', 'x-backend-server']) {
    const v = h(name);
    if (v) disclosure.push(`${name}: ${v}`);
  }
  if (disclosure.length) add('low', 'Response headers disclose software versions', undefined, disclosure.join('\n'));
  if (h('access-control-allow-origin') === '*') add('info', 'Main document allows any origin to read it (Access-Control-Allow-Origin: *)');

  // Cookies set by first-party responses
  const cookies = [];
  const setBy = new Map(); // cookie → the response that set it (for places; not saved in data)
  for (const e of reading.log.entries) {
    const host = hostOf(e.request.url);
    if (ctx.util.isThirdParty(host, ctx.target.site)) continue;
    for (const c of e.response.cookies || []) {
      if (cookies.some((x) => x.name === c.name && x.host === host)) continue;
      const cookie = { name: c.name, host, domain: c.domain, secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || '' };
      cookies.push(cookie);
      setBy.set(cookie, e.request.url);
    }
  }
  const cookiePlaces = (cs) => cs.map((c) => ({ text: String(c.name), url: setBy.get(c) }));
  const insecure = cookies.filter((c) => https && !c.secure);
  const scriptable = cookies.filter((c) => !c.httpOnly && SESSIONISH.test(c.name));
  const noneNoSecure = cookies.filter((c) => /none/i.test(c.sameSite) && !c.secure);
  if (insecure.length) add('medium', `${plural(insecure.length, 'cookie')} set without the Secure flag`, undefined, insecure.map((c) => c.name).join(', '), undefined, cookiePlaces(insecure));
  if (scriptable.length) add('medium', `${plural(scriptable.length, 'session-like cookie')} readable by JavaScript (no HttpOnly)`, undefined, scriptable.map((c) => c.name).join(', '), undefined, cookiePlaces(scriptable));
  if (noneNoSecure.length) add('medium', 'SameSite=None cookies without Secure (rejected by browsers)', undefined, noneNoSecure.map((c) => c.name).join(', '), undefined, cookiePlaces(noneNoSecure));

  // Mixed content
  // Mixed content = http: subresources. Navigations (incl. the http→https redirect hop) are not.
  const navigations = new Set(chain);
  for (const p of reading.log.pages) {
    const first = reading.log.entries.find((e) => e.pageref === p.id && resourceType(e) === 'document' && !e._target);
    if (first) for (const e of redirectChain(reading, first)) navigations.add(e);
  }
  const mixedPlaces = https ? reading.log.entries.map((e, entry) => ({ e, entry })).filter(({ e }) => !navigations.has(e) && e.request.url.startsWith('http:') &&
    !/^http:\/\/(localhost|127\.)/.test(e.request.url)).map(({ e, entry }) => ({ url: e.request.url, status: e.response.status > 0 ? e.response.status : 'ERR', entry })) : [];
  const mixed = mixedPlaces.map((m) => m.url);
  if (mixed.length) add('medium', `${plural(mixed.length, 'insecure (http:) subresource')} on an HTTPS page`, undefined, mixed.slice(0, 10).join('\n'), undefined, mixedPlaces);

  // Subresource Integrity on third-party scripts
  const scripts = ctx.results.meta?.data?.scripts || [];
  const noSri = scripts.filter((s) => ctx.util.isThirdParty(hostOf(s.src), ctx.target.site) && !s.integrity);
  if (noSri.length) add('info', `${plural(noSri.length, 'third-party script')} without Subresource Integrity`, 'SRI only suits versioned files; analytics loaders usually cannot use it.', noSri.slice(0, 10).map((s) => s.src).join('\n'), undefined, noSri.map((s) => ({ url: s.src })));

  // TLS certificates
  const tlsAll = reading.log._harplus.capture?.tls || {};
  const tls = tlsAll[originOf(url)];
  const certs = Object.entries(tlsAll).map(([origin, t]) => ({ origin, ...t, daysLeft: -daysBetween(t.validTo) }));
  if (tls) {
    const days = -daysBetween(tls.validTo);
    if (days < 0) add('high', 'TLS certificate has expired', tls.validTo);
    else if (days < 14) add('high', `TLS certificate expires in ${days} days`, tls.validTo);
    else if (days < 30) add('medium', `TLS certificate expires in ${days} days`, tls.validTo);
    if (/TLS 1\.[01]$|SSL/i.test(tls.protocol)) add('high', `Outdated TLS protocol: ${tls.protocol}`);
    if (tls.ctCompliance === 'not-compliant') add('medium', 'Certificate is not Certificate Transparency compliant');
  }
  for (const c of certs) {
    if (c.origin !== originOf(url) && c.daysLeft >= 0 && c.daysLeft < 14) add('low', `Certificate for ${hostOf(c.origin)} expires in ${c.daysLeft} days`, undefined, undefined, undefined, [{ url: c.origin }]);
  }

  const present = headers.filter((x) => x.ok).length;
  return {
    data: {
      url, https, upgraded, headers, csp: cspValue ? csp : null, cspReportOnly: cspRO || null,
      disclosure, cookies: cookies.slice(0, 200), mixed: mixed.slice(0, 50), tls: tls || null, certificates: certs,
      sriMissing: noSri.slice(0, 50).map((s) => s.src),
      // The true counts: mixed and sriMissing are capped at 50 (score.js reads neither).
      mixedCount: mixed.length, sriMissingCount: noSri.length,
    },
    findings,
    summary: [
      { label: 'Transport', headline: true, value: https ? `HTTPS${hsts ? ` · HSTS ${Math.round(maxAge / 86400)}d` : ' · no HSTS'}${upgraded ? ' · HTTP→HTTPS redirect' : ''}` : 'HTTP (insecure)' },
      { label: 'TLS', value: tls ? `${tls.protocol} · ${tls.issuer} · ${-daysBetween(tls.validTo)} days left` : '' },
      { label: 'Certificate names', value: tls ? `${tls.sanCount} (${tls.sanList.slice(0, 4).join(', ')}${tls.sanCount > 4 ? '…' : ''})` : '' },
      { label: 'Security headers', headline: true, value: `${present}/${headers.length} present` },
      { label: 'CSP', value: cspHeader ? 'enforced' : cspMeta ? 'meta tag' : cspRO ? 'report-only' : 'none' },
      { label: 'Cookies (first-party)', value: cookies.length ? `${cookies.length} set · ${insecure.length + scriptable.length + noneNoSecure.length} with weak flags` : 'none set' },
    ],
  };
}

/**
 * Answer first (headers present, mixed content, disclosed versions, scripts without SRI), then what the glance's
 * checks, certificate timeline and cookie bar do not show: each header's value, the CSP directives, the rest of the
 * certificate and each cookie's flags. The mixed-content URLs, disclosed versions and scripts without SRI are their
 * findings' places and evidence, so they are not drawn again here.
 */
function render(r, h) {
  const d = r.data || {};
  const headers = d.headers || [];
  const certs = d.certificates || [];
  const cookies = d.cookies || [];
  const tls = d.tls;
  const sans = tls?.sanList || [];
  return h.html`${h.stats([
    h.stat({ label: 'Security headers', value: `${headers.filter((x) => x.ok).length} of ${headers.length}`, note: 'passing' }),
    h.stat({ label: 'Mixed content', value: d.mixedCount ?? (d.mixed || []).length, note: d.https ? 'http: subresources' : 'page is HTTP' }),
    h.stat({ label: 'Disclosed versions', value: (d.disclosure || []).length }),
    h.stat({ label: 'Scripts without SRI', value: d.sriMissingCount ?? (d.sriMissing || []).length, note: 'third-party' }),
  ])}
    ${h.sub('Header values', h.kv(headers.map((x) => [x.label, cspShort(x, d) ?? headerValue(x, d.https)])))}
    ${d.csp ? h.sub('Content-Security-Policy', h.kv(Object.entries(d.csp).map(([k, v]) => [k, (v || []).join(' ')]))) : ''}
    ${tls ? h.sub('TLS (main origin)', h.html`${h.kv([
      ['Cipher', tls.cipher], ['Key exchange', tls.keyExchangeGroup || tls.keyExchange], ['Subject', tls.subjectName], ['SCTs', tls.sctCount],
    ])}${h.more('Subject alternative names', h.list(sans, { fold: false }), String(tls.sanCount ?? sans.length))}`) : ''}
    ${certs.length > 1 ? h.sub('Certificates seen', h.table(certs.map((c) => ({ origin: h.url(c.origin), issuer: c.issuer, protocol: c.protocol, days: c.daysLeft, names: c.sanCount })), [
    { key: 'origin', label: 'Origin' }, { key: 'issuer', label: 'Issuer' }, { key: 'protocol', label: 'Protocol' }, { key: 'days', label: 'Days left' }, { key: 'names', label: 'Names' },
  ])) : ''}
    ${cookies.length ? h.sub('First-party cookies', h.table(cookies.map((c) => ({ name: c.name, host: c.host, secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || '—' })), [
    { key: 'name', label: 'Cookie' }, { key: 'host', label: 'Host' }, { key: 'secure', label: 'Secure' }, { key: 'httpOnly', label: 'HttpOnly' }, { key: 'sameSite', label: 'SameSite' },
  ])) : ''}
  `;
}

/**
 * The CSP is drawn once, directive by directive, under its own heading: its Header values row gives the count. The
 * whole value stays when more than one policy was sent (only the first is parsed) or none was parsed.
 */
function cspShort(x, d) {
  if (x.label !== 'Content-Security-Policy' || !x.value || !d.csp || x.value.includes(', ')) return undefined;
  const n = Object.keys(d.csp).length;
  return `${n} ${n === 1 ? 'directive' : 'directives'}${/ \(meta\)$/.test(x.value) ? ' (meta tag)' : ''}`;
}

// Why a header that is present still fails its check (the CSP and plain-HTTP values already say so).
function headerValue(x, https) {
  if (!x.value) return 'missing';
  const why = { 'Strict-Transport-Security': https ? 'too short' : 'ignored over HTTP', 'X-Content-Type-Options': 'not nosniff' }[x.label];
  return x.ok || !why || /^n\/a/.test(x.value) ? x.value : `${x.value} (${why})`;
}

// The recorder saves ISO strings; older readings and CDP hold seconds.
const toMs = (t) => (typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t));

function glance(r, h) {
  const d = r.data;
  const tls = d.tls;
  const days = tls ? Math.round((toMs(tls.validTo) - Date.now()) / 86_400_000) : null;
  const year = (t) => new Date(toMs(t)).toISOString().slice(0, 10);
  const good = d.cookies.filter((c) => c.secure && c.httpOnly).length;
  return h.html`<div class="glance-grid">
    <section class="card"><h4>Transport &amp; headers</h4>${h.checklist([
      { label: d.https ? 'HTTPS' : 'HTTPS (page is plain HTTP)', ok: !!d.https },
      ...d.headers.map((x) => ({ label: x.label, ok: !!x.ok })),
    ])}</section>
    <section class="card">
      ${tls ? h.html`<h4>TLS certificate · ${days} days left</h4>${h.timeline({
        start: toMs(tls.validFrom), end: toMs(tls.validTo), startLabel: `Issued ${year(tls.validFrom)}`,
        endLabel: `Expires ${year(tls.validTo)}`, label: 'TLS certificate validity',
      })}<p class="note">${[tls.issuer, tls.protocol].filter(Boolean).join(' · ')}</p>` : h.html`<h4>TLS certificate</h4><p class="muted">No certificate recorded.</p>`}
      ${d.cookies.length ? h.html`<h4>First-party cookies · ${d.cookies.length}</h4>${h.stackBar({ segments: [
        { label: 'Secure + HttpOnly', value: good, color: 'var(--c1)' },
        { label: 'Weak flags', value: d.cookies.length - good, color: 'var(--c2)' },
      ] })}` : ''}
    </section>
  </div>`;
}

export default {
  id: 'security',
  group: 'security',
  name: 'Security',
  version: '0.1.0',
  phase: 'analyze',
  after: ['meta'],
  description: 'HTTPS/HSTS, TLS certificate, security headers, CSP quality, cookie flags, mixed content, version disclosure.',
  tags: ['security'],
  run,
  render,
  glance,
};
