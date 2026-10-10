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
  const add = (severity, title, detail, evidence, ref) => findings.push({ severity, category: 'security', title, detail, evidence, ref });
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
  for (const e of reading.log.entries) {
    const host = hostOf(e.request.url);
    if (ctx.util.isThirdParty(host, ctx.target.site)) continue;
    for (const c of e.response.cookies || []) {
      if (cookies.some((x) => x.name === c.name && x.host === host)) continue;
      cookies.push({ name: c.name, host, domain: c.domain, secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || '' });
    }
  }
  const insecure = cookies.filter((c) => https && !c.secure);
  const scriptable = cookies.filter((c) => !c.httpOnly && SESSIONISH.test(c.name));
  const noneNoSecure = cookies.filter((c) => /none/i.test(c.sameSite) && !c.secure);
  if (insecure.length) add('medium', `${plural(insecure.length, 'cookie')} set without the Secure flag`, undefined, insecure.map((c) => c.name).join(', '));
  if (scriptable.length) add('medium', `${plural(scriptable.length, 'session-like cookie')} readable by JavaScript (no HttpOnly)`, undefined, scriptable.map((c) => c.name).join(', '));
  if (noneNoSecure.length) add('medium', 'SameSite=None cookies without Secure (rejected by browsers)', undefined, noneNoSecure.map((c) => c.name).join(', '));

  // Mixed content
  // Mixed content = http: subresources. Navigations (incl. the http→https redirect hop) are not.
  const navigations = new Set(chain);
  for (const p of reading.log.pages) {
    const first = reading.log.entries.find((e) => e.pageref === p.id && resourceType(e) === 'document' && !e._target);
    if (first) for (const e of redirectChain(reading, first)) navigations.add(e);
  }
  const mixed = https ? reading.log.entries.filter((e) => !navigations.has(e) && e.request.url.startsWith('http:') &&
    !/^http:\/\/(localhost|127\.)/.test(e.request.url)).map((e) => e.request.url) : [];
  if (mixed.length) add('medium', `${plural(mixed.length, 'insecure (http:) subresource')} on an HTTPS page`, undefined, mixed.slice(0, 10).join('\n'));

  // Subresource Integrity on third-party scripts
  const scripts = ctx.results.meta?.data?.scripts || [];
  const noSri = scripts.filter((s) => ctx.util.isThirdParty(hostOf(s.src), ctx.target.site) && !s.integrity);
  if (noSri.length) add('info', `${plural(noSri.length, 'third-party script')} without Subresource Integrity`, 'SRI only suits versioned files; analytics loaders usually cannot use it.', noSri.slice(0, 10).map((s) => s.src).join('\n'));

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
    if (c.origin !== originOf(url) && c.daysLeft >= 0 && c.daysLeft < 14) add('low', `Certificate for ${hostOf(c.origin)} expires in ${c.daysLeft} days`);
  }

  const present = headers.filter((x) => x.ok).length;
  return {
    data: {
      url, https, upgraded, headers, csp: cspValue ? csp : null, cspReportOnly: cspRO || null,
      disclosure, cookies: cookies.slice(0, 200), mixed: mixed.slice(0, 50), tls: tls || null, certificates: certs,
      sriMissing: noSri.slice(0, 50).map((s) => s.src),
    },
    findings,
    summary: [
      { label: 'Transport', value: https ? `HTTPS${hsts ? ` · HSTS ${Math.round(maxAge / 86400)}d` : ' · no HSTS'}${upgraded ? ' · HTTP→HTTPS redirect' : ''}` : 'HTTP (insecure)' },
      { label: 'TLS', value: tls ? `${tls.protocol} · ${tls.issuer} · ${-daysBetween(tls.validTo)} days left` : '' },
      { label: 'Certificate names', value: tls ? `${tls.sanCount} (${tls.sanList.slice(0, 4).join(', ')}${tls.sanCount > 4 ? '…' : ''})` : '' },
      { label: 'Security headers', value: `${present}/${headers.length} present` },
      { label: 'CSP', value: cspHeader ? 'enforced' : cspMeta ? 'meta tag' : cspRO ? 'report-only' : 'none' },
      { label: 'Cookies (first-party)', value: cookies.length ? `${cookies.length} set · ${insecure.length + scriptable.length + noneNoSecure.length} with weak flags` : 'none set' },
    ],
  };
}

function render(r, h) {
  const d = r.data;
  return h.html`
    ${h.sub('Security headers', h.table(d.headers.map((x) => ({ status: h.check(x.ok), header: x.label, value: x.value || '—' })), ['status', 'header', 'value']))}
    ${d.csp ? h.sub('Content-Security-Policy', h.kv(Object.entries(d.csp).map(([k, v]) => [k, v.join(' ')]))) : ''}
    ${d.tls ? h.sub('TLS (main origin)', h.kv([
      ['Protocol', d.tls.protocol], ['Cipher', d.tls.cipher], ['Key exchange', d.tls.keyExchangeGroup || d.tls.keyExchange],
      ['Subject', d.tls.subjectName], ['Issuer', d.tls.issuer], ['Valid', `${d.tls.validFrom.slice(0, 10)} → ${d.tls.validTo.slice(0, 10)}`],
      ['SCTs', d.tls.sctCount], ['Subject alternative names', h.tags(d.tls.sanList)],
    ])) : ''}
    ${d.certificates.length > 1 ? h.sub('Certificates seen', h.table(d.certificates.map((c) => ({ origin: c.origin, issuer: c.issuer, protocol: c.protocol, 'days left': c.daysLeft, names: c.sanCount })), ['origin', 'issuer', 'protocol', 'days left', 'names'])) : ''}
    ${d.cookies.length ? h.sub('First-party cookies', h.table(d.cookies.map((c) => ({ ...c, secure: h.check(c.secure), httpOnly: h.check(c.httpOnly) })), ['name', 'host', 'secure', 'httpOnly', 'sameSite'])) : ''}
    ${d.disclosure.length ? h.sub('Disclosed versions', h.list(d.disclosure)) : ''}
    ${d.mixed.length ? h.sub('Mixed content', h.list(d.mixed)) : ''}
  `;
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
};
