// Offline analysis of the recorded conversation: weight, composition, hosts, protocols,
// compression, caching, errors and redirects.

import {
  resourceType, transferSize, plural, decodedSize, hostOf, mainEntry, redirectChain, resHeader, formatBytes, formatMs,
} from '../core/har-util.js';

const TEXT_MIME = /text\/|javascript|ecmascript|json|xml|svg/;
const STATIC = new Set(['script', 'stylesheet', 'font', 'image']);

function run(reading, ctx) {
  const entries = reading.log.entries;
  if (!entries.length) ctx.skip('no requests recorded');
  const site = ctx.target.site;
  const main = mainEntry(reading);
  const page = reading.log.pages.find((p) => p.id === main?.pageref) || reading.log.pages[0];
  const t0 = Date.parse(page?.startedDateTime || entries[0].startedDateTime);
  const synthetic = entries.some((e) => e._synthetic);

  const byType = {}; const hosts = new Map(); const protocols = {};
  const uncompressed = []; const noCache = []; const errors = []; const failed = [];
  let bytes = 0; let decoded = 0; let span = 0; let thirdBytes = 0; let thirdReqs = 0; let redirects = 0; let cached = 0;

  for (const e of entries) {
    const url = e.request.url;
    const type = resourceType(e);
    const size = transferSize(e);
    const dsize = decodedSize(e);
    const host = hostOf(url);
    const third = ctx.util.isThirdParty(host, site);
    const t = (byType[type] ||= { type, requests: 0, bytes: 0, decoded: 0 });
    t.requests++; t.bytes += size; t.decoded += dsize;
    const hrec = hosts.get(host) || { host, requests: 0, bytes: 0, thirdParty: third };
    hrec.requests++; hrec.bytes += size;
    hosts.set(host, hrec);
    const proto = e._fromCache ? 'cache' : (e.response.httpVersion || (e._error ? 'failed' : 'n/a')).toLowerCase();
    protocols[proto] = (protocols[proto] || 0) + 1;
    bytes += size; decoded += dsize;
    if (third) { thirdBytes += size; thirdReqs++; }
    const status = e.response.status;
    if (e._error && !e._canceled) failed.push({ url, error: e._error });
    else if (status >= 400) errors.push({ url, status });
    if (status >= 300 && status < 400) redirects++;
    if (e._fromCache) cached++;
    const start = Date.parse(e.startedDateTime) - t0;
    span = Math.max(span, start + Math.max(0, e.time || 0));

    if (!synthetic && !e._fromCache && status === 200) {
      const mime = e.response.content?.mimeType || '';
      if (TEXT_MIME.test(mime) && dsize > 1400 && !resHeader(e, 'content-encoding')) {
        uncompressed.push({ url, bytes: dsize, mime });
      }
      if (STATIC.has(type) && !third && !resHeader(e, 'cache-control') && !resHeader(e, 'expires')) {
        noCache.push({ url, type });
      }
    }
  }

  const bySize = [...entries].sort((a, b) => transferSize(b) - transferSize(a)).slice(0, 10)
    .map((e) => ({ url: e.request.url, type: resourceType(e), bytes: transferSize(e) }));
  const bySpeed = [...entries].sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 10)
    .map((e) => ({ url: e.request.url, type: resourceType(e), time: e.time }));
  const hostList = [...hosts.values()].sort((a, b) => b.bytes - a.bytes);
  const thirdHosts = hostList.filter((h) => h.thirdParty);
  const chain = redirectChain(reading, main);

  const findings = [];
  const add = (severity, category, title, detail, evidence) => findings.push({ severity, category, title, detail, evidence });
  if (bytes > 8 * 1024 ** 2) add('medium', 'performance', `Heavy page: ${formatBytes(bytes)} transferred`);
  else if (bytes > 4 * 1024 ** 2) add('low', 'performance', `Page transfers ${formatBytes(bytes)}`);
  if (entries.length > 150) add('low', 'performance', `${entries.length} requests`);
  const js = byType.script?.bytes || 0;
  if (js > 1024 ** 2) add('medium', 'performance', `${formatBytes(js)} of JavaScript transferred`);
  else if (js > 500 * 1024) add('low', 'performance', `${formatBytes(js)} of JavaScript transferred`);
  if (uncompressed.length) {
    add('medium', 'performance', `${plural(uncompressed.length, 'text response')} served without compression`,
      `${formatBytes(uncompressed.reduce((s, u) => s + u.bytes, 0))} uncompressed`, uncompressed.slice(0, 10).map((u) => u.url).join('\n'));
  }
  if (noCache.length) add('low', 'performance', `${plural(noCache.length, 'first-party static asset')} without cache headers`, undefined, noCache.slice(0, 10).map((u) => u.url).join('\n'));
  if (errors.length) add('medium', 'quality', `${plural(errors.length, 'request')} returned HTTP errors`, undefined, errors.slice(0, 10).map((x) => `${x.status} ${x.url}`).join('\n'));
  if (failed.length) add('low', 'quality', `${plural(failed.length, 'request')} failed`, undefined, failed.slice(0, 10).map((x) => `${x.error} ${x.url}`).join('\n'));
  if (chain.length > 2) add('low', 'performance', `Main document is reached through ${plural(chain.length - 1, 'redirect')}`, chain.map((e) => e.request.url).join(' → '));
  if (main && /^http\/1/i.test(main.response.httpVersion)) add('low', 'performance', 'Main document served over HTTP/1.1');
  if (thirdHosts.length > 25) add('low', 'privacy', `Page contacts ${thirdHosts.length} third-party hosts`);
  const bigImages = entries.filter((e) => resourceType(e) === 'image' && transferSize(e) > 1024 ** 2);
  if (bigImages.length) add('low', 'performance', `${plural(bigImages.length, 'image')} over 1 MB`, undefined, bigImages.map((e) => e.request.url).join('\n'));
  if (synthetic) add('info', 'quality', 'Snapshot reading: network data comes from Resource Timing (no headers, approximate sizes)');

  const h3 = /h3/.test(resHeader(main, 'alt-svc') || '');
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '0%');
  const typeOrder = ['document', 'script', 'stylesheet', 'image', 'font', 'xhr', 'media', 'other'];
  return {
    data: {
      totals: { requests: entries.length, bytes, decoded, spanMs: span, thirdParty: { requests: thirdReqs, bytes: thirdBytes }, redirects, cached },
      byType: typeOrder.filter((k) => byType[k]).map((k) => byType[k]),
      hosts: hostList.slice(0, 40),
      protocols,
      http3Advertised: h3,
      largest: bySize,
      slowest: bySpeed,
      uncompressed: uncompressed.slice(0, 50),
      noCache: noCache.slice(0, 50),
      errors: errors.slice(0, 50),
      failed: failed.slice(0, 50),
      redirectChain: chain.map((e) => ({ url: e.request.url, status: e.response.status })),
      synthetic,
    },
    findings,
    summary: [
      { label: 'Requests', value: `${entries.length} (${pct(thirdReqs, entries.length)} third-party)`, headline: true },
      { label: 'Transferred', value: `${formatBytes(bytes)} (${formatBytes(decoded)} decoded)`, headline: true },
      { label: 'Hosts', value: `${hosts.size} (${thirdHosts.length} third-party)` },
      { label: 'Network span', value: formatMs(span) },
      { label: 'JS · CSS · images · fonts', value: ['script', 'stylesheet', 'image', 'font'].map((k) => formatBytes(byType[k]?.bytes || 0)).join(' · ') },
      { label: 'Protocols', value: Object.entries(protocols).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, entries.length)}`).join(', ') + (h3 ? ' · h3 advertised' : '') },
    ],
  };
}

function render(r, h) {
  const d = r.data;
  return h.html`
    ${h.sub('By type', h.table(d.byType.map((t) => ({ ...t, bytes: h.bytes(t.bytes), decoded: h.bytes(t.decoded) })), ['type', 'requests', 'bytes', 'decoded']))}
    ${h.sub('Hosts', h.table(d.hosts.map((x) => ({ host: x.host, party: x.thirdParty ? 'third' : 'first', requests: x.requests, bytes: h.bytes(x.bytes) })), ['host', 'party', 'requests', 'bytes']))}
    ${h.sub('Largest', h.table(d.largest.map((x) => ({ ...x, bytes: h.bytes(x.bytes) })), ['bytes', 'type', 'url']))}
    ${h.sub('Slowest', h.table(d.slowest.map((x) => ({ ...x, time: h.ms(x.time) })), ['time', 'type', 'url']))}
    ${d.redirectChain.length > 1 ? h.sub('Redirect chain', h.table(d.redirectChain, ['status', 'url'])) : ''}
    ${d.uncompressed.length ? h.sub('Uncompressed text', h.table(d.uncompressed.map((x) => ({ ...x, bytes: h.bytes(x.bytes) })), ['bytes', 'mime', 'url'])) : ''}
    ${d.errors.length ? h.sub('HTTP errors', h.table(d.errors, ['status', 'url'])) : ''}
    ${d.failed.length ? h.sub('Failed', h.table(d.failed, ['error', 'url'])) : ''}
  `;
}

const TYPE_LABEL = { document: 'HTML', script: 'JavaScript', stylesheet: 'CSS', image: 'Images', font: 'Fonts', xhr: 'Fetch / XHR', media: 'Media', other: 'Other' };

function glance(r, h) {
  const d = r.data;
  const t = d.totals;
  const [num, unit] = h.bytes(t.bytes).split(' ');
  const first = { requests: t.requests - t.thirdParty.requests, bytes: t.bytes - t.thirdParty.bytes };
  const party = (label, a, b, fmt) => h.stackBar({ label, legend: label === 'Requests', segments: [
    { label: 'First party', value: a, display: fmt(a), color: 'var(--c1)' },
    { label: 'Third party', value: b, display: fmt(b), color: 'var(--c2)' },
  ] });
  return h.html`<div class="glance-grid">
    <section class="card"><h4>Page weight by type</h4>${h.donut({
      label: 'Page weight by type', center: { value: num, unit },
      segments: d.byType.map((x) => ({ label: TYPE_LABEL[x.type] || x.type, value: x.bytes, display: h.bytes(x.bytes) })),
    })}</section>
    <section class="card"><h4>First vs third party</h4>
      ${party('Requests', first.requests, t.thirdParty.requests, String)}
      ${party('Transferred', first.bytes, t.thirdParty.bytes, h.bytes)}
      <h4>Top hosts by requests</h4>${h.hbars({ label: 'Requests by host', rows: d.hosts.slice(0, 6).map((x) => ({
        label: x.host, value: x.requests, color: x.thirdParty ? 'var(--c2)' : 'var(--c1)',
      })) })}
    </section>
  </div>`;
}

export default {
  id: 'network',
  group: 'quality',
  name: 'Network',
  version: '0.1.0',
  phase: 'analyze',
  description: 'Page weight, request mix, hosts, protocols, compression, caching, errors and redirects.',
  tags: ['performance'],
  run,
  render,
  glance,
};
