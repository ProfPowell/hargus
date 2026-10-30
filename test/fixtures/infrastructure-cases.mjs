// Representative inputs for the Infrastructure area's enrich plugins (ct-logs, dns, history, ip-intel, well-known,
// whois), shared by test/infrastructure.test.mjs and infrastructure-findings-baseline.json, which was taken from the
// plugins before places were added. score-check cannot replay enrich plugins, so this is what proves every finding
// field but `places` is unchanged. Date.now is frozen at NOW for every case (ages and expiry depend on it).

import * as util from '../../extension/core/har-util.js';

export const NOW = Date.parse('2026-10-30T12:00:00Z');

/** Run fn with Date.now frozen at NOW; restores it even when fn throws. */
export async function frozen(fn, now = NOW) {
  const real = Date.now;
  Date.now = () => now;
  try { return await fn(); } finally { Date.now = real; }
}

const res = (body, status = 200, { type = 'application/json', url = '' } = {}) => ({
  ok: status >= 200 && status < 300, status, url,
  headers: { get: (k) => (/content-type/i.test(k) ? type : null) },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const err = (status, url) => Object.assign(new Error(`HTTP ${status}`), { status, url });

const reading = (entries = []) => ({ log: { entries, pages: [], _harplus: {} } });
const skip = (m) => { throw new Error(`skip: ${m}`); };

/* ---------------------------------------------------------------- ct-logs */

const cert = (names, notBefore, issuer = "C=US, O=Let's Encrypt, CN=R11") => ({ issuer_name: issuer, name_value: names.join('\n'), not_before: notBefore });
const ctCtx = (rows, options = { includeExpired: false }, domain = 'example.com') => ({
  target: { domain }, options, util, skip, fetch: async (url) => res(rows, 200, { url }),
});
export const ODD_HOST = 'staging.<b>&"x".example.com';
export const LONG_HOST = `dev.${'a'.repeat(700)}.example.com`;

/** name → () => [reading, ctx] for ct-logs.run */
export const CT_LOGS = {
  base: () => [reading(), ctCtx([
    cert(['www.example.com', 'example.com'], '2026-08-01T00:00:00'),
    cert(['*.staging.example.com'], '2026-09-01T00:00:00', 'C=US, O=Google Trust Services, CN=WE1'),
    cert(['vpn.example.com', 'other.test'], '2026-07-01T00:00:00', "C=US, O=Let's Encrypt, CN=R10"),
    cert(['admin.example.com', 'www.example.com'], '2025-01-01T00:00:00'),
  ])],
  'nothing notable': () => [reading(), ctCtx([cert(['www.example.com', 'example.com', 'shop.example.com'], '2026-08-01T00:00:00')], { includeExpired: true })],
  'one name': () => [reading(), ctCtx([cert(['example.com'], '2026-08-01T00:00:00')])],
  'odd and crowded': () => [reading(), ctCtx([
    cert([ODD_HOST, LONG_HOST], '2026-10-01T00:00:00'),
    ...Array.from({ length: 300 }, (_, i) => cert([`qa${i}.example.com`, `www${i}.example.com`], `2026-0${1 + (i % 9)}-01T00:00:00`)),
  ])],
};

/* ---------------------------------------------------------------- dns */

const A = (type, data) => ({ name: 'x', type, ttl: 300, data });
const dnsCtx = (records, { host = 'www.example.com', domain = 'example.com', errors = [], selectors = 'google selector1' } = {}) => ({
  target: { host, domain }, util, skip, options: { dkimSelectors: selectors },
  dns: async (name, type) => {
    const k = `${name}|${type}`;
    if (errors.includes(k)) return { status: 'ERROR', error: 'timeout', answers: [] };
    return { status: 'NOERROR', answers: records[k] || [] };
  },
});
const GOOD_DNS = {
  'www.example.com|A': [A('CNAME', 'www.example.com.cdn.cloudflare.net.'), A('A', '104.16.1.1'), A('A', '104.16.2.2')],
  'www.example.com|AAAA': [A('AAAA', '2606:4700::6810:101')],
  'example.com|NS': [A('NS', 'ada.ns.cloudflare.com.'), A('NS', 'bob.ns.cloudflare.com.')],
  'example.com|MX': [A('MX', '1 aspmx.l.google.com.'), A('MX', '5 alt1.aspmx.l.google.com.')],
  'example.com|TXT': ['"v=spf1 include:_spf.google.com include:sendgrid.net -all"', '"google-site-verification=abc"', '"some other token"'].map((d) => A('TXT', d)),
  'example.com|CAA': [A('CAA', '0 issue "letsencrypt.org"')],
  'example.com|SOA': [A('SOA', 'ada.ns.cloudflare.com. dns.cloudflare.com. 2350000000 10000 2400 604800 1800')],
  'example.com|DS': [A('DS', '2371 13 2 abc')],
  '_dmarc.example.com|TXT': [A('TXT', '"v=DMARC1; p=reject; rua=mailto:x@rua.dmarcian.com"')],
  'google._domainkey.example.com|TXT': [A('TXT', '"v=DKIM1; k=rsa; p=MIIB"')],
};

/** name → () => [reading, ctx] for dns.run */
export const DNS = {
  'well configured': () => [reading(), dnsCtx(GOOD_DNS)],
  'bare domain': () => [reading(), dnsCtx({ 'example.com|A': [A('A', '93.184.215.14')], 'example.com|NS': [A('NS', 'ns1.sedoparking.com.')] }, { host: 'example.com' })],
  'weak mail': () => [reading(), dnsCtx({
    ...GOOD_DNS,
    'example.com|TXT': [A('TXT', '"v=spf1 a mx include:a.test include:b.test include:c.test include:d.test include:e.test include:f.test include:g.test include:h.test include:i.test +all"'), A('TXT', '"v=spf1 ?all"')],
    '_dmarc.example.com|TXT': [A('TXT', '"v=DMARC1; p=none"')], 'example.com|CAA': [], 'example.com|DS': [],
  })],
  'partial dmarc, lookups failing': () => [reading(), dnsCtx({ ...GOOD_DNS, '_dmarc.example.com|TXT': [A('TXT', '"v=DMARC1; p=quarantine; pct=50"')] }, { errors: ['example.com|CAA', 'example.com|DS', 'example.com|MX'] })],
};

/* ---------------------------------------------------------------- history */

const histCtx = (routes, { tranco = true, host = 'www.example.com', domain = 'example.com' } = {}) => ({
  target: { host, domain }, util, skip, options: { tranco },
  fetchJSON: async (url) => {
    const hit = routes.find(([re]) => re.test(url));
    if (!hit || hit[1] instanceof Error) throw hit ? hit[1] : err(404, url);
    return hit[1];
  },
});
const cdx = (rows) => [['timestamp', 'statuscode', 'digest'], ...rows];

/** name → () => [reading, ctx] for history.run */
export const HISTORY = {
  'old and ranked': () => [reading(), histCtx([
    [/web\.archive\.org/, cdx([['19961019000000', '200', 'a'], ['20050101000000', '200', 'a'], ['20200101000000', '200', 'b'], ['20261001000000', '200', 'c']])],
    [/tranco/, { ranks: [{ date: '2026-10-01', rank: 120 }, { date: '2026-09-01', rank: 99 }] }],
  ])],
  'new site': () => [reading(), histCtx([[/web\.archive\.org/, cdx([['20260601000000', '200', 'a']])]], { tranco: false })],
  'never archived, not ranked': () => [reading(), histCtx([[/web\.archive\.org/, []], [/tranco/, err(404, 'tranco')]])],
  'wayback down': () => [reading(), histCtx([[/web\.archive\.org/, new Error('HTTP 503')], [/tranco/, { ranks: [{ date: '2026-10-01', rank: 5000 }] }]])],
};

/* ---------------------------------------------------------------- ip-intel */

const entry = (url, ip) => ({
  request: { url, method: 'GET', headers: [] }, _resourceType: 'document', serverIPAddress: ip,
  response: { status: 200, headers: [], content: { mimeType: 'text/html', size: 100 }, bodySize: 100, headersSize: 0 },
  timings: {}, time: 1, startedDateTime: new Date(0).toISOString(),
});
const asset = (url, ip) => ({ ...entry(url, ip), _resourceType: 'script' });
const IP_DNS = {
  '14.215.184.93.in-addr.arpa|PTR': [A('PTR', 'edge.example.net.')],
  '14.215.184.93.origin.asn.cymru.com|TXT': [A('TXT', '"14061 | 93.184.215.0/24 | US | arin | 2008-06-02"')],
  'AS14061.asn.cymru.com|TXT': [A('TXT', '"14061 | US | arin | 2012-09-25 | DIGITALOCEAN-ASN - DigitalOcean, LLC, US"')],
  '1.1.16.104.origin.asn.cymru.com|TXT': [A('TXT', '"13335 | 104.16.0.0/13 | US | arin | 2014-03-28"')],
  'AS13335.asn.cymru.com|TXT': [A('TXT', '"13335 | US | arin | 2010-07-14 | CLOUDFLARENET - Cloudflare, Inc., US"')],
  '9.113.0.203.origin.asn.cymru.com|TXT': [A('TXT', '"16509 | 203.0.113.0/24 | US | arin | 2010-01-01"')],
  'AS16509.asn.cymru.com|TXT': [A('TXT', '"16509 | US | arin | 2000-05-04 | AMAZON-02 - Amazon.com, Inc., US"')],
};
const ipCtx = (options = {}, { failAll = false } = {}) => ({
  target: { site: 'example.com', host: 'www.example.com' }, util, skip, keys: {},
  options: { maxIps: 8, rdapIps: 2, geo: 'none', rdapEndpoint: 'https://rdap.org', ...options },
  dns: async (name, type) => (failAll ? { status: 'ERROR', error: 'DoH down', answers: [] } : { status: 'NOERROR', answers: IP_DNS[`${name}|${type}`] || [] }),
  fetchJSON: async (url) => {
    if (failAll) throw err(503, url);
    if (/rdap\.org\/ip\/93/.test(url)) return { name: 'DIGITALOCEAN-93', handle: 'NET-93', startAddress: '93.184.208.0', endAddress: '93.184.223.255', cidr0_cidrs: [{ v4prefix: '93.184.208.0', length: 20 }], entities: [{ roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'DigitalOcean, LLC']]] }] };
    if (/ipinfo\.io\//.test(url)) return { city: 'Los Angeles', region: 'California', country: 'US', org: 'AS14061 DigitalOcean, LLC' };
    throw err(404, url);
  },
});

/** name → () => [reading, ctx] for ip-intel.run */
export const IP_INTEL = {
  'origin and cdn': () => [reading([
    entry('https://www.example.com/', '93.184.215.14'), asset('https://cdn.example.com/a.js', '104.16.1.1'),
    asset('https://static.example.com/b.js', '203.0.113.9'), asset('https://third.test/c.js', '203.0.113.9'),
  ]), ipCtx({ geo: 'ipinfo' })],
  'behind a cdn': () => [reading([entry('https://www.example.com/', '104.16.1.1')]), ipCtx()],
  'private main': () => [reading([entry('http://intranet.example.com/', '10.0.0.5'), asset('https://www.example.com/x.js', '93.184.215.14')]), ipCtx({ rdapIps: 0 })],
};

/* ---------------------------------------------------------------- well-known */

const ORIGIN = 'https://www.example.com';
const wkCtx = (files, { manifest, meta = {}, headers = [] } = {}) => {
  const doc = { ...entry(`${ORIGIN}/`, '93.184.215.14'), response: { ...entry(`${ORIGIN}/`, '1').response, headers } };
  return [reading([doc]), {
    target: { origin: ORIGIN, url: `${ORIGIN}/`, finalUrl: `${ORIGIN}/` }, util, skip, options: {},
    results: { meta: { data: { manifest, ...meta } } },
    fetch: async (url) => {
      const path = url.startsWith(ORIGIN) ? url.slice(ORIGIN.length) : url;
      const f = files[path];
      if (!f) return res('<!doctype html><title>Not found</title>', 404, { type: 'text/html', url });
      const [body, type = 'text/plain', status = 200] = f;
      return res(body, status, { type, url });
    },
  }];
};
const SITEMAP = ['<?xml version="1.0"?><urlset><url><loc>a</loc></url><url><loc>b</loc></url></urlset>', 'application/xml'];

/** name → () => [reading, ctx] for well-known.run */
export const WELL_KNOWN = {
  'everything published': () => wkCtx({
    '/robots.txt': ['User-agent: *\nDisallow: /admin\nCrawl-delay: 5\nNoindex: /x\nFoo: bar\n\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: gptbot\nAllow: /a\n\nSitemap: https://www.example.com/sitemap.xml\n'],
    '/.well-known/security.txt': ['Contact: mailto:sec@example.com\nExpires: 2099-01-01T00:00:00Z\nPolicy: https://www.example.com/policy\n'],
    '/sitemap.xml': SITEMAP,
    '/ads.txt': ['google.com, pub-1, DIRECT, f08c47fec0942fa0\nappnexus.com, 2, RESELLER\n'],
    '/llms.txt': ['# Example Inc\n\n- [Docs](https://www.example.com/docs)\n'],
    '/ai.txt': ['User-Agent: *\nDisallow: /\n'],
    '/humans.txt': ['/* TEAM */\nDev: Ada\n'],
    '/.well-known/apple-app-site-association': [JSON.stringify({ applinks: { details: [{ appIDs: ['ABCDE.com.example.ios'] }] } }), 'application/json'],
    '/.well-known/assetlinks.json': [JSON.stringify([{ target: { package_name: 'com.example.app' } }]), 'application/json'],
    '/favicon.ico': ['icon', 'image/x-icon'],
    '/manifest.json': [JSON.stringify({ name: 'Example', display: 'standalone', icons: [{}, {}] }), 'application/json'],
  }, { manifest: `${ORIGIN}/manifest.json` }),
  'nothing published': () => wkCtx({ '/favicon.ico': ['icon', 'image/x-icon'] }),
  'blocked and expired': () => wkCtx({
    '/robots.txt': ['User-agent: *\nDisallow: /\n'],
    '/security.txt': ['Contact: mailto:sec@example.com\nExpires: 2001-01-01T00:00:00Z\n'],
    '/sitemap.xml': SITEMAP,
  }, { headers: [{ name: 'X-Robots-Tag', value: 'noindex' }] }),
  'home allowed, googlebot blocked': () => wkCtx({
    '/robots.txt': ['User-agent: *\nDisallow: /\nAllow: /$\n\nUser-agent: Googlebot\nDisallow: /\n\nUser-agent: Bingbot\nDisallow: /\n'],
    '/robots-sitemap.xml': SITEMAP,
  }),
};

/* ---------------------------------------------------------------- whois */

const rdap = ({ created, expires, status = ['client transfer prohibited'] }) => ({
  handle: 'X', status, events: [{ eventAction: 'registration', eventDate: created }, { eventAction: 'expiration', eventDate: expires }].filter((e) => e.eventDate),
  nameservers: [{ ldhName: 'NS1.EXAMPLE.NET' }], secureDNS: { delegationSigned: false },
  entities: [{ roles: ['registrar'], publicIds: [{ type: 'IANA Registrar ID', identifier: '376' }], vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar, Inc.']]] }],
});
const whoisCtx = (body, { domain = 'example.com', whois, service } = {}) => ({
  target: { domain }, util, skip,
  options: { endpoint: 'https://rdap.org', followRegistrar: false, whoisService: service ? 'https://who-dat.test' : '' },
  ...(whois ? { whois } : {}),
  fetchJSON: async (url) => { if (body instanceof Error) throw body; return body; },
  fetch: async (url) => res(service, 200, { url }),
});

/** name → () => [reading, ctx] for whois.run */
export const WHOIS = {
  'established and locked': () => [reading(), whoisCtx(rdap({ created: '1995-08-14T04:00:00Z', expires: '2030-08-13T04:00:00Z' }))],
  'new, expiring soon, unlocked': () => [reading(), whoisCtx(rdap({ created: '2026-10-20T00:00:00Z', expires: '2026-11-15T00:00:00Z', status: ['active'] }))],
  'young, expiring in 45 days, on hold': () => [reading(), whoisCtx(rdap({ created: '2026-06-01T00:00:00Z', expires: '2026-12-14T12:00:00Z', status: ['client hold', 'client transfer prohibited'] }))],
  expired: () => [reading(), whoisCtx(rdap({ created: '2010-01-01T00:00:00Z', expires: '2026-01-01T00:00:00Z' }))],
  'port 43 fallback': () => [reading(), whoisCtx(Object.assign(new Error('nope'), { status: 404 }), {
    domain: 'ucsd.edu',
    whois: async () => ({ server: 'whois.educause.edu', text: 'Domain Name: UCSD.EDU\nRegistrant:\n   University of California, San Diego\n   9500 Gilman Drive\n   La Jolla, CA 92093\n   USA\nDomain record activated:    05-May-1986\nDomain expires:             31-Jul-2027\n' }),
  })],
};

/** Run one case with Date.now frozen; throws what the plugin throws. */
export const runCase = (plugin, make) => frozen(() => { const [r, ctx] = make(); return plugin.run(r, ctx); });
