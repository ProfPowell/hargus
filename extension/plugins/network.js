// Offline analysis of the recorded conversation: weight, composition, hosts, protocols,
// compression, caching, errors and redirects.

import {
  resourceType, transferSize, plural, decodedSize, hostOf, mainEntry, redirectChain, resHeader, formatBytes, formatMs,
} from '../core/har-util.js';
import { isBrokenAsset } from '../core/broken.js';

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
  const uncompressed = []; const noCache = []; const errors = []; const assetErrors = []; const otherErrors = []; const failed = [];
  let bytes = 0; let decoded = 0; let span = 0; let thirdBytes = 0; let thirdReqs = 0; let redirects = 0; let cached = 0;

  for (const [i, e] of entries.entries()) {
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
    // An HTTP error counts as one even when the request also has a net error (ORB blocks a 404 image's body),
    // so a broken asset is listed once, under asset errors, which Link check can supersede.
    if (status >= 400) { errors.push({ url, status }); (isBrokenAsset(e, main) ? assetErrors : otherErrors).push({ url, status, entry: i }); }
    else if (e._error && !e._canceled) failed.push({ url, error: e._error, entry: i });
    if (status >= 300 && status < 400) redirects++;
    if (e._fromCache) cached++;
    const start = Date.parse(e.startedDateTime) - t0;
    span = Math.max(span, start + Math.max(0, e.time || 0));

    if (!synthetic && !e._fromCache && status === 200) {
      const mime = e.response.content?.mimeType || '';
      if (TEXT_MIME.test(mime) && dsize > 1400 && !resHeader(e, 'content-encoding')) {
        uncompressed.push({ url, bytes: dsize, mime, entry: i });
      }
      if (STATIC.has(type) && !third && !resHeader(e, 'cache-control') && !resHeader(e, 'expires')) {
        noCache.push({ url, type, entry: i });
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
  // places: every request a finding is about (capped at 200), each linked to its row in the Network pane by `entry`.
  const add = (id, severity, category, title, detail, evidence, places) => findings.push({ id, severity, category, title, detail, evidence, ...(places?.length ? { places: places.slice(0, 200) } : {}) });
  if (bytes > 8 * 1024 ** 2) add('heavy-page', 'medium', 'performance', `Heavy page: ${formatBytes(bytes)} transferred`);
  else if (bytes > 4 * 1024 ** 2) add('heavy-page', 'low', 'performance', `Page transfers ${formatBytes(bytes)}`);
  if (entries.length > 150) add('many-requests', 'low', 'performance', `${entries.length} requests`);
  const js = byType.script?.bytes || 0;
  if (js > 1024 ** 2) add('heavy-javascript', 'medium', 'performance', `${formatBytes(js)} of JavaScript transferred`);
  else if (js > 500 * 1024) add('heavy-javascript', 'low', 'performance', `${formatBytes(js)} of JavaScript transferred`);
  if (uncompressed.length) {
    add('uncompressed-text', 'medium', 'performance', `${plural(uncompressed.length, 'text response')} served without compression`,
      `${formatBytes(uncompressed.reduce((s, u) => s + u.bytes, 0))} uncompressed`, uncompressed.slice(0, 10).map((u) => u.url).join('\n'),
      uncompressed.map((u) => ({ url: u.url, status: 200, entry: u.entry, note: `${formatBytes(u.bytes)} ${u.mime}` })));
  }
  if (noCache.length) {
    add('no-cache-headers', 'low', 'performance', `${plural(noCache.length, 'first-party static asset')} without cache headers`, undefined, noCache.slice(0, 10).map((u) => u.url).join('\n'),
      noCache.map((u) => ({ url: u.url, status: 200, entry: u.entry, note: u.type })));
  }
  const errorFinding = (id, title, list) => {
    if (list.length) {
      findings.push({ id, severity: 'medium', category: 'quality', title, evidence: list.slice(0, 10).map((x) => `${x.status} ${x.url}`).join('\n'),
        places: list.slice(0, 200).map((x) => ({ url: x.url, status: x.status, entry: x.entry })) });
    }
  };
  errorFinding('asset-errors', `${plural(assetErrors.length, 'asset request')} returned HTTP errors`, assetErrors);
  errorFinding('request-errors', `${plural(otherErrors.length, 'other request')} returned HTTP errors`, otherErrors);
  if (failed.length) {
    add('failed-requests', 'low', 'quality', `${plural(failed.length, 'request')} failed`, undefined, failed.slice(0, 10).map((x) => `${x.error} ${x.url}`).join('\n'),
      failed.map((x) => ({ url: x.url, status: 'ERR', entry: x.entry, note: x.error })));
  }
  if (chain.length > 2) {
    add('long-redirect-chain', 'low', 'performance', `Main document is reached through ${plural(chain.length - 1, 'redirect')}`, chain.map((e) => e.request.url).join(' → '), undefined,
      chain.map((e) => ({ url: e.request.url, status: e.response.status, entry: entries.indexOf(e) })));
  }
  if (main && /^http\/1/i.test(main.response.httpVersion)) add('http1-main-document', 'low', 'performance', 'Main document served over HTTP/1.1');
  if (thirdHosts.length > 25) add('many-third-party-hosts', 'low', 'privacy', `Page contacts ${thirdHosts.length} third-party hosts`);
  const bigImages = entries.filter((e) => resourceType(e) === 'image' && transferSize(e) > 1024 ** 2);
  if (bigImages.length) {
    add('large-images', 'low', 'performance', `${plural(bigImages.length, 'image')} over 1 MB`, undefined, bigImages.map((e) => e.request.url).join('\n'),
      bigImages.map((e) => ({ url: e.request.url, status: e.response.status, entry: entries.indexOf(e), note: formatBytes(transferSize(e)) })));
  }
  if (synthetic) add('snapshot-reading', 'info', 'quality', 'Snapshot reading: network data comes from Resource Timing (no headers, approximate sizes)');

  const h3 = /h3/.test(resHeader(main, 'alt-svc') || '');
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '0%');
  const typeOrder = ['document', 'script', 'stylesheet', 'image', 'font', 'xhr', 'media', 'other'];
  return {
    data: {
      totals: { requests: entries.length, bytes, decoded, spanMs: span, thirdParty: { requests: thirdReqs, bytes: thirdBytes }, redirects, cached, hosts: hosts.size },
      byType: typeOrder.filter((k) => byType[k]).map((k) => byType[k]),
      hosts: hostList.slice(0, 40),
      protocols,
      http3Advertised: h3,
      largest: bySize,
      slowest: bySpeed,
      uncompressed: uncompressed.slice(0, 50).map(({ entry, ...x }) => x),
      noCache: noCache.slice(0, 50).map(({ entry, ...x }) => x),
      errors: errors.slice(0, 50),
      failed: failed.slice(0, 50).map(({ entry, ...x }) => x),
      counts: { uncompressed: uncompressed.length, errors: errors.length, failed: failed.length }, // true counts: the lists above are capped
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

/**
 * Answer first (requests, transferred, third party, hosts, span), then what neither the glance nor the Network pane
 * shows: requests and decoded size per type, every host, protocols, the redirect chain, uncompressed text and errors.
 * The weight donut and party bars are the glance's; the largest and slowest requests are the Network pane's sorts.
 */
function render(r, h) {
  const d = r.data || {};
  const t = d.totals || {};
  const third = t.thirdParty || {};
  const hosts = d.hosts || [];
  const total = Object.values(d.protocols || {}).reduce((n, v) => n + v, 0);
  const protocols = Object.entries(d.protocols || {}).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${total ? Math.round((v / total) * 100) : 0}%`).join(', ');
  // hosts and the URL lists are capped (40, 50): say so when one stops short of its count. Older readings lack the counts.
  const firstOf = (list, n) => (n > (list || []).length ? { sub: `first ${list.length} of ${n}` } : {});
  const counts = d.counts || {};
  const urlRows = (xs, extra) => (xs || []).map((x) => ({ ...x, ...extra(x), url: h.url(x.url) }));
  return h.html`${h.stats([
    h.stat({ label: 'Requests', value: t.requests ?? 0, note: t.cached ? `${t.cached} from cache` : '' }),
    h.stat({ label: 'Transferred', value: h.bytes(t.bytes), note: `${h.bytes(t.decoded)} decoded` }),
    h.stat({ label: 'Third party', value: `${third.requests ?? 0} requests`, note: h.bytes(third.bytes) }),
    h.stat({ label: 'Hosts', value: t.hosts ?? hosts.length }), // data.hosts is capped at 40; older readings lack totals.hosts
    h.stat({ label: 'Network span', value: h.ms(t.spanMs) }),
  ])}
    ${h.kv([['Protocols', protocols + (d.http3Advertised ? ' · h3 advertised' : '')], ['Redirects', t.redirects]])}
    ${h.sub('By type', h.table((d.byType || []).map((x) => ({ type: TYPE_LABEL[x.type] || x.type, requests: x.requests, decoded: h.bytes(x.decoded) })),
    [{ key: 'type', label: 'Type' }, { key: 'requests', label: 'Requests' }, { key: 'decoded', label: 'Decoded' }]))}
    ${h.sub('Hosts', h.table(hosts.map((x) => ({ host: x.host, party: x.thirdParty ? 'third' : 'first', requests: x.requests, bytes: h.bytes(x.bytes) })),
    [{ key: 'host', label: 'Host' }, { key: 'party', label: 'Party' }, { key: 'requests', label: 'Requests' }, { key: 'bytes', label: 'Transferred' }]), firstOf(hosts, t.hosts))}
    ${(d.redirectChain || []).length > 1 ? h.sub('Redirect chain', h.table(urlRows(d.redirectChain, () => ({})), [{ key: 'status', label: 'Status' }, { key: 'url', label: 'URL' }])) : ''}
    ${(d.uncompressed || []).length ? h.sub('Uncompressed text', h.table(urlRows(d.uncompressed, (x) => ({ bytes: h.bytes(x.bytes) })),
    [{ key: 'bytes', label: 'Size' }, { key: 'mime', label: 'Type' }, { key: 'url', label: 'URL' }]), firstOf(d.uncompressed, counts.uncompressed)) : ''}
    ${(d.errors || []).length ? h.sub('HTTP errors', h.table(urlRows(d.errors, () => ({})), [{ key: 'status', label: 'Status' }, { key: 'url', label: 'URL' }]), firstOf(d.errors, counts.errors)) : ''}
    ${(d.failed || []).length ? h.sub('Failed', h.table(urlRows(d.failed, () => ({})), [{ key: 'error', label: 'Error' }, { key: 'url', label: 'URL' }]), firstOf(d.failed, counts.failed)) : ''}
  `;
}

const TYPE_LABEL = { document: 'HTML', script: 'JavaScript', stylesheet: 'CSS', image: 'Images', font: 'Fonts', xhr: 'Fetch / XHR', media: 'Media', other: 'Other' };

function glance(r, h) {
  const d = r.data;
  const t = d.totals;
  const [num, unit] = h.bytes(t.bytes).split(/\s/);
  const first = { requests: t.requests - t.thirdParty.requests, bytes: t.bytes - t.thirdParty.bytes };
  const party = (label, a, b, fmt) => h.stackBar({ label, legend: label === 'Requests', segments: [
    { label: 'First party', value: a, display: fmt(a), color: 'var(--c1)' },
    { label: 'Third party', value: b, display: fmt(b), color: 'var(--c2)' },
  ] });
  return h.html`<div class="glance-grid">
    <section class="card"><h4>Page weight by type</h4>${h.donut({
      label: 'Page weight by type', center: { value: num, unit }, format: h.bytes,
      segments: d.byType.map((x) => ({ label: TYPE_LABEL[x.type] || x.type, value: x.bytes, display: h.bytes(x.bytes), other: x.type === 'other' })),
    })}</section>
    <section class="card"><h4>First vs third party</h4>
      ${party('Requests', first.requests, t.thirdParty.requests, String)}
      ${party('Transferred', first.bytes, t.thirdParty.bytes, h.bytes)}
      <h4>Top hosts by requests</h4>${h.hbars({ label: 'Requests by host', rows: d.hosts.slice(0, 6).map((x) => ({
        label: x.host, value: x.requests, display: `${x.requests}${x.thirdParty ? ' · third party' : ''}`, color: x.thirdParty ? 'var(--c2)' : 'var(--c1)',
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
