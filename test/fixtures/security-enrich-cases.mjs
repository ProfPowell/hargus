// Representative inputs for the Security area's enrich plugins (exposure, observatory, reputation), shared by
// test/security-enrich.test.mjs and security-enrich-findings-baseline.json, which was taken from the plugins
// before places were added. score-check cannot replay enrich plugins, so this is what proves every finding field
// but `places` is unchanged.

import * as util from '../../extension/core/har-util.js';

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const doc = (url, ip) => ({
  request: { url, method: 'GET', headers: [] }, _resourceType: 'document', serverIPAddress: ip,
  response: { status: 200, headers: [], content: { mimeType: 'text/html', size: 100 }, bodySize: 100, headersSize: 0 },
  timings: {}, time: 1, startedDateTime: new Date(0).toISOString(),
});
const asset = (url, ip) => ({ ...doc(url, ip), _resourceType: 'script', response: { ...doc(url, ip).response, content: { mimeType: 'text/javascript', size: 10 } } });

const reading = (entries) => ({ log: { entries, pages: [], _harplus: {} } });

export const cves = (n, prefix = 'CVE-2024-') => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(4, '0')}`);
export const ODD_CVE = 'CVE-2024-<b>&"1"';
export const LONG_CVE = `CVE-2024-${'9'.repeat(700)}`;

/** Shodan InternetDB by IP; anything missing is a 404. */
const shodan = (byIp) => async (url) => {
  const ip = url.split('/').pop();
  return byIp[ip] ? json(byIp[ip]) : json({ detail: 'No information available' }, 404);
};

const exposureCtx = (fetch, { intel = [], options = { scope: 'all' } } = {}) => ({
  results: { 'ip-intel': { data: { servers: intel } } }, options, util, target: { site: 'example.com', host: 'www.example.com' },
  fetch, skip: (m) => { throw new Error(`skip: ${m}`); },
});

/** name → () => [reading, ctx] for exposure.run */
export const EXPOSURE = {
  base: () => [reading([doc('https://www.example.com/', '93.184.215.14'), asset('https://cdn.example.com/a.js', '151.101.1.1'), asset('https://img.example.com/x.js', '203.0.113.9')]),
    exposureCtx(shodan({
      '93.184.215.14': { ports: [22, 80, 443, 3306, 8080], vulns: cves(20), tags: ['eol-product', 'self-signed', 'cloud'], hostnames: ['example.com'], cpes: ['cpe:/a:nginx:nginx'] },
      '151.101.1.1': { ports: [80, 443], vulns: cves(3), tags: ['cdn'], hostnames: [], cpes: [] },
    }))],
  'ip-intel cdn': () => [reading([doc('https://www.example.com/', '93.184.215.14')]),
    exposureCtx(shodan({ '93.184.215.14': { ports: [80, 443], vulns: cves(2), tags: [] } }), { intel: [{ ip: '93.184.215.14', kind: 'cdn' }] })],
  'quiet host': () => [reading([doc('https://www.example.com/', '93.184.215.14')]),
    exposureCtx(shodan({ '93.184.215.14': { ports: [80, 443], vulns: [], tags: [] } }))],
  'odd and crowded': () => [reading([doc('https://www.example.com/', '93.184.215.14')]),
    exposureCtx(shodan({ '93.184.215.14': { ports: [23, 6379, 9999], vulns: [ODD_CVE, LONG_CVE, ...cves(248)], tags: ['compromised', 'malware'] } }))],
};

const obsCtx = (body, status = 200) => ({
  target: { host: 'www.example.com' }, options: {}, util,
  fetch: async () => json(body, status), skip: (m) => { throw new Error(`skip: ${m}`); },
});
const obs = (grade, score, failed) => ({
  id: 1, details_url: 'https://developer.mozilla.org/en-US/observatory/analyze?host=www.example.com', algorithm_version: 4,
  scanned_at: '2026-10-08T17:00:00Z', error: null, grade, score, status_code: 200, tests_failed: failed, tests_passed: 10 - failed, tests_quantity: 10,
});

/** name → () => [reading, ctx] for observatory.run */
export const OBSERVATORY = {
  'grade D': () => [reading([]), obsCtx(obs('D', 30, 5))],
  'grade C+': () => [reading([]), obsCtx(obs('C+', 60, 3))],
  'grade B': () => [reading([]), obsCtx(obs('B', 75, 2))],
  'grade A': () => [reading([]), obsCtx(obs('A', 95, 0))],
};

const repCtx = (routes, keys = { abuseipdb: 'a', virustotal: 'v', greynoise: 'g' }) => {
  const pick = (url) => routes.find(([re]) => re.test(url))?.[1];
  return {
    keys, options: {}, util, results: { 'ip-intel': { data: { mainIp: '93.184.215.14' } } }, target: { domain: 'example.com' },
    fetch: async (url) => pick(url) || json({}, 404),
    fetchJSON: async (url) => { const r = pick(url); if (!r?.ok) throw new Error(`HTTP ${r?.status ?? 404}`); return r.json(); },
    skip: (m) => { throw new Error(`skip: ${m}`); },
  };
};
const abuse = (score) => [/abuseipdb/, json({ data: { abuseConfidenceScore: score, totalReports: score, usageType: 'Data Center', isp: 'DO', isTor: false, isWhitelisted: false, lastReportedAt: null } })];
const vt = (malicious, suspicious) => [/virustotal/, json({ data: { attributes: { last_analysis_stats: { malicious, suspicious, harmless: 60 }, reputation: 0, categories: { a: 'business', b: 'business', c: 'tech' }, popularity_ranks: { Tranco: { rank: 1000 } } } } })];
const gn = (body, status = 200) => [/greynoise/, json(body, status)];

/** name → () => [reading, ctx] for reputation.run */
export const REPUTATION = {
  'all flagged high': () => [reading([]), repCtx([abuse(80), vt(4, 0), gn({ noise: true, riot: false, classification: 'malicious', name: 'x' })])],
  'all flagged lower': () => [reading([]), repCtx([abuse(30), vt(1, 0), gn({ noise: true, riot: false, classification: 'unknown' })])],
  suspicious: () => [reading([]), repCtx([abuse(5), vt(0, 2), gn({ message: 'not observed' }, 404)])],
  clean: () => [reading([]), repCtx([abuse(0), vt(0, 0), gn({ noise: false, riot: true, classification: 'benign', name: 'Google' })])],
};

/** Run one case; throws what the plugin throws. */
export const runCase = (plugin, make) => { const [r, ctx] = make(); return plugin.run(r, ctx); };
