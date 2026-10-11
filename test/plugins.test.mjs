import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarRecorder } from '../extension/core/recorder.js';
import { createReading, makeTarget, findings } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';
import { getPlugins } from '../extension/plugins/index.js';
import vitalsPlugin from '../extension/plugins/vitals.js';
import pagespeedPlugin from '../extension/plugins/pagespeed.js';
import { parseRobots } from '../extension/plugins/well-known.js';
import { feedNavigation, mockFetch } from './helpers.mjs';

const json = (body, status = 200) => ({ status, body });
const text = (body, type = 'text/plain') => ({ body, headers: { 'content-type': type } });

const DNS = {
  'www.example.com|A': [{ name: 'www.example.com.', type: 5, TTL: 300, data: 'www.example.com.cdn.cloudflare.net.' }, { name: 'www.example.com.cdn.cloudflare.net.', type: 1, TTL: 300, data: '104.16.1.1' }],
  'www.example.com|AAAA': [{ name: 'www.example.com.', type: 28, TTL: 300, data: '2606:4700::6810:101' }],
  'example.com|NS': [{ name: 'example.com.', type: 2, TTL: 300, data: 'ada.ns.cloudflare.com.' }, { name: 'example.com.', type: 2, TTL: 300, data: 'bob.ns.cloudflare.com.' }],
  'example.com|MX': [{ name: 'example.com.', type: 15, TTL: 300, data: '1 aspmx.l.google.com.' }],
  'example.com|TXT': ['"v=spf1 include:_spf.google.com include:sendgrid.net ~all"', '"google-site-verification=abc"', '"atlassian-domain-verification=xyz"', '"acme-domain-verification=123"']
    .map((data) => ({ name: 'example.com.', type: 16, TTL: 300, data })),
  'example.com|CAA': [{ name: 'example.com.', type: 257, TTL: 300, data: '0 issue "letsencrypt.org"' }],
  'example.com|SOA': [{ name: 'example.com.', type: 6, TTL: 300, data: 'ada.ns.cloudflare.com. dns.cloudflare.com. 2350000000 10000 2400 604800 1800' }],
  '_dmarc.example.com|TXT': [{ name: '_dmarc.example.com.', type: 16, TTL: 300, data: '"v=DMARC1; p=quarantine; rua=mailto:x@rua.dmarcian.com"' }],
  'google._domainkey.example.com|TXT': [{ name: 'google._domainkey.example.com.', type: 16, TTL: 300, data: '"v=DKIM1; k=rsa; p=MIIB"' }],
  '14.215.184.93.in-addr.arpa|PTR': [{ name: '14.215.184.93.in-addr.arpa.', type: 12, TTL: 300, data: 'edge.example.net.' }],
  '14.215.184.93.origin.asn.cymru.com|TXT': [{ name: 'x', type: 16, TTL: 300, data: '"14061 | 93.184.215.0/24 | US | arin | 2008-06-02"' }],
  'AS14061.asn.cymru.com|TXT': [{ name: 'x', type: 16, TTL: 300, data: '"14061 | US | arin | 2012-09-25 | DIGITALOCEAN-ASN - DigitalOcean, LLC, US"' }],
};

const ROUTES = [
  [/cloudflare-dns\.com\/dns-query/, (u) => {
    const p = new URL(u).searchParams;
    return json({ Status: 0, AD: false, Answer: DNS[`${p.get('name')}|${p.get('type')}`] || [] });
  }],
  [/rdap\.org\/domain\/example\.com/, json({
    handle: '2336799_DOMAIN_COM-VRSN', ldhName: 'EXAMPLE.COM', status: ['client transfer prohibited', 'client delete prohibited'],
    events: [{ eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' }, { eventAction: 'expiration', eventDate: '2099-08-13T04:00:00Z' }],
    nameservers: [{ ldhName: 'ADA.NS.CLOUDFLARE.COM' }], secureDNS: { delegationSigned: false },
    entities: [{
      roles: ['registrar'], publicIds: [{ type: 'IANA Registrar ID', identifier: '376' }],
      vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Example Registrar, Inc.']]],
      entities: [{ roles: ['abuse'], vcardArray: ['vcard', [['fn', {}, 'text', 'Abuse'], ['email', {}, 'text', 'abuse@registrar.test']]] }],
    }],
    links: [{ rel: 'related', href: 'https://rdap.registrar.test/domain/example.com', type: 'application/rdap+json' }],
  })],
  [/rdap\.registrar\.test\/domain/, json({
    entities: [{ roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'REDACTED FOR PRIVACY'], ['org', {}, 'text', 'Example Corp'], ['adr', { cc: 'US' }, 'text', ['', '', '', '', 'CA', '', 'US']]]] }],
  })],
  [/rdap\.org\/ip\//, json({ name: 'DIGITALOCEAN-93', handle: 'NET-93-184-208-0-1', startAddress: '93.184.208.0', endAddress: '93.184.223.255', cidr0_cidrs: [{ v4prefix: '93.184.208.0', length: 20 }], entities: [{ roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'DigitalOcean, LLC']]] }] })],
  [/ipinfo\.io\//, json({ ip: '93.184.215.14', city: 'Los Angeles', region: 'California', country: 'US', loc: '34,-118', org: 'AS14061 DigitalOcean, LLC' })],
  [/internetdb\.shodan\.io\/93\.184\.215\.14/, json({ ip: '93.184.215.14', ports: [80, 443, 3306], vulns: ['CVE-2023-0001'], tags: ['eol-product'], hostnames: ['example.com'], cpes: ['cpe:/a:nginx:nginx'] })],
  [/internetdb\.shodan\.io\//, json({ detail: 'No information available' }, 404)],
  [/www\.example\.com\/robots\.txt/, text('User-agent: *\nDisallow: /admin\n\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nSitemap: https://www.example.com/sitemap.xml\n')],
  [/www\.example\.com\/sitemap\.xml/, text('<?xml version="1.0"?><urlset><url><loc>a</loc></url><url><loc>b</loc></url></urlset>', 'application/xml')],
  [/www\.example\.com\/llms\.txt/, text('# Example Inc\n\n- [Docs](https://www.example.com/docs)\n')],
  [/www\.example\.com\/ads\.txt/, text('google.com, pub-1, DIRECT, f08c47fec0942fa0\nappnexus.com, 2, RESELLER\n')],
  [/www\.example\.com\/\.well-known\/assetlinks\.json/, json([{ target: { namespace: 'android_app', package_name: 'com.example.app' } }])],
  [/www\.example\.com\/$/, text('<!doctype html><html><body><div></div></div></body></html>', 'text/html')],
  [/validator\.w3\.org\/nu/, json({ messages: [{ type: 'error', message: 'Stray end tag “div”.', lastLine: 10, firstColumn: 3, extract: '</div>' }, { type: 'info', subType: 'warning', message: 'Consider adding a lang attribute.' }] })],
  [/crt\.sh\/\?q=%25\.example\.com/, json([
    { issuer_name: 'C=US, O=Let\'s Encrypt, CN=R11', name_value: 'www.example.com\nexample.com', not_before: '2026-08-01T00:00:00' },
    { issuer_name: 'C=US, O=Google Trust Services, CN=WE1', name_value: '*.staging.example.com', not_before: '2026-09-01T00:00:00' },
    { issuer_name: 'C=US, O=Let\'s Encrypt, CN=R10', name_value: 'vpn.example.com\nother.test', not_before: '2026-07-01T00:00:00' },
  ])],
  [/localhost:8787/, (u, init) => json({ summary: [{ label: 'Body bytes', value: String(init.body.length) }], findings: [{ severity: 'low', category: 'performance', title: 'Remote says hi' }] })],
];

const OFFLINE = { plugins: { tech: { options: { fingerprintDb: false } } } };

function sampleReading() {
  const rec = new HarRecorder();
  feedNavigation(rec);
  const built = rec.build({ dropImplicit: true });
  const reading = createReading({ ...built, target: makeTarget('http://www.example.com/', 'Example', 'https://www.example.com/') });
  // stand-in for the page-phase meta plugin and tech probe
  reading.log._harplus.plugins.meta = {
    id: 'meta', name: 'Page metadata', phase: 'page', status: 'ok', summary: [], findings: [],
    data: { generator: ['WordPress 6.4.2'], cspMeta: null, manifest: null, scripts: [{ src: 'https://www.googletagmanager.com/gtm.js?id=GTM-1' }] },
  };
  reading.log._harplus.probes = { tech: { globals: { jQuery: true, 'jQuery.fn.jquery': '3.4.1' }, dom: {}, meta: {}, customElements: ['zing-grid'], serviceWorker: false } };
  return reading;
}

test('analyze plugins: network, security, tech', async () => {
  const reading = sampleReading();
  await runPlugins(reading, getPlugins(), { phases: ['analyze'], settings: OFFLINE });
  const p = reading.log._harplus.plugins;
  assert.equal(p.network.status, 'ok', p.network.error);
  assert.equal(p.network.data.totals.requests, 3);
  assert.equal(p.network.data.redirectChain.length, 2);

  assert.equal(p.security.status, 'ok', p.security.error);
  assert.ok(p.security.data.upgraded);
  const sec = p.security.findings.map((f) => f.title);
  assert.ok(sec.includes('No Content-Security-Policy'));
  assert.ok(sec.some((t) => /framed/.test(t)));
  assert.ok(sec.some((t) => /without the Secure flag/.test(t)), 'trk cookie lacks Secure');
  assert.match(p.security.summary.find((s) => s.label === 'TLS').value, /TLS 1\.3 · R11/);

  assert.equal(p.tech.status, 'ok', p.tech.error);
  const names = p.tech.data.technologies.map((t) => `${t.name}${t.version ? ` ${t.version}` : ''}`);
  assert.ok(names.includes('Google Tag Manager'));
  assert.ok(names.includes('WordPress 6.4.2'));
  assert.ok(names.includes('jQuery 3.4.1'));
  assert.ok(names.some((n) => n.startsWith('Custom elements')));
  assert.ok(p.tech.findings.some((f) => /jQuery below 3\.5\.0/.test(f.title)));
});

test('enrich plugins with mocked services', async () => {
  const reading = sampleReading();
  const calls = [];
  const settings = {
    keys: {},
    plugins: { 'html-validate': { enabled: true }, 'ct-logs': { enabled: true }, tech: { options: { fingerprintDb: false } } },
    remotes: [{ id: 'echo', name: 'Echo', url: 'http://localhost:8787/', send: 'reading-lite' }],
  };
  await runPlugins(reading, getPlugins(settings), { phases: ['analyze', 'enrich'], settings, fetch: mockFetch(ROUTES, calls) });
  const p = reading.log._harplus.plugins;

  assert.equal(p.dns.status, 'ok', p.dns.error);
  assert.deepEqual(p.dns.data.providers.dns, ['Cloudflare']);
  assert.deepEqual(p.dns.data.providers.mail, ['Google Workspace']);
  assert.deepEqual(p.dns.data.providers.senders, ['Google Workspace', 'SendGrid']);
  assert.deepEqual(p.dns.data.providers.web, ['Cloudflare']);
  assert.deepEqual(p.dns.data.verifications, ['Google Search Console', 'Atlassian', 'Acme']);
  assert.equal(p.dns.data.dmarc.p, 'quarantine');
  assert.deepEqual(p.dns.data.dmarcReporters, ['rua.dmarcian.com']);
  assert.equal(p.dns.data.caa[0].value, 'letsencrypt.org');
  assert.equal(p.dns.data.dkim[0].selector, 'google');
  assert.equal(p.dns.data.soa.contact, 'dns@cloudflare.com');
  assert.ok(p.dns.findings.some((f) => /DNSSEC/.test(f.title)));

  assert.equal(p.whois.status, 'ok', p.whois.error);
  assert.equal(p.whois.data.registrar.name, 'Example Registrar, Inc.');
  assert.equal(p.whois.data.registrar.ianaId, '376');
  assert.equal(p.whois.data.registrant.org, 'Example Corp');
  assert.equal(p.whois.data.registrant.name, undefined, 'redacted name dropped');
  assert.equal(p.whois.data.abuse.email, 'abuse@registrar.test');
  assert.match(p.whois.summary.find((s) => s.label === 'Registered').value, /^1995-08-14 \(\d+\.\d years\)/);

  assert.equal(p['ip-intel'].status, 'ok', p['ip-intel'].error);
  const main = p['ip-intel'].data.servers.find((s) => s.main);
  assert.equal(main.asn, 14061);
  assert.equal(main.provider, 'DigitalOcean');
  assert.equal(main.kind, 'cloud');
  assert.deepEqual(main.ptr, ['edge.example.net']);
  assert.equal(main.network.cidr, '93.184.208.0/20');
  assert.equal(main.geo.city, 'Los Angeles');

  assert.equal(p.exposure.status, 'ok', p.exposure.error);
  assert.ok(p.exposure.findings.some((f) => f.severity === 'high' && /CVE/.test(f.title)));
  assert.ok(p.exposure.findings.some((f) => /3306 MySQL/.test(f.detail || '')));

  assert.equal(p['well-known'].status, 'ok', p['well-known'].error);
  const wk = p['well-known'].data;
  assert.equal(wk.robots.aiBots.GPTBot.status, 'blocked');
  assert.equal(wk.robots.aiBots.ClaudeBot.status, 'blocked');
  assert.equal(wk.robots.aiBots.CCBot.status, 'partial');
  assert.equal(wk.sitemap.urls, 2);
  assert.equal(wk.llms.title, 'Example Inc');
  assert.equal(wk.ads.systems.length, 2);
  assert.deepEqual(wk.androidApps, ['com.example.app']);
  assert.equal(wk.security, null);

  assert.equal(p['ct-logs'].status, 'ok', p['ct-logs'].error);
  assert.deepEqual(p['ct-logs'].data.subdomains.map((x) => x.name), ['staging.example.com', 'www.example.com', 'example.com', 'vpn.example.com']);
  assert.deepEqual(p['ct-logs'].data.notable, ['staging.example.com', 'vpn.example.com']);
  assert.equal(p['ct-logs'].data.issuers[0].name, "Let's Encrypt");

  assert.equal(p.reputation.status, 'skipped');
  assert.equal(p['html-validate'].status, 'ok', p['html-validate'].error);
  assert.equal(p['html-validate'].data.errors.length, 1);
  assert.equal(p['html-validate'].data.source, 're-fetched without cookies');

  assert.equal(p['remote:echo'].status, 'ok', p['remote:echo'].error);
  assert.equal(p['remote:echo'].findings[0].title, 'Remote says hi');

  assert.ok(p.dns.contacted.some((c) => c.host === 'cloudflare-dns.com'));
  assert.ok(findings(reading).length > 10);
});

test('lookups fail loudly when the network is down', async () => {
  const reading = sampleReading();
  const down = async () => { throw new TypeError('fetch failed'); };
  await runPlugins(reading, getPlugins(), { phases: ['enrich'], fetch: down, only: ['dns', 'whois', 'ip-intel', 'well-known'] });
  const p = reading.log._harplus.plugins;
  for (const id of ['dns', 'whois', 'ip-intel', 'well-known']) assert.equal(p[id].status, 'error', `${id}: ${p[id].status}`);
});

test('robots parser', () => {
  const r = parseRobots('User-agent: *\nAllow: /\n\nUser-agent: Google-Extended\nDisallow: /\n');
  assert.equal(r.everyone, 'allowed');
  assert.equal(r.aiBots['Google-Extended'].status, 'blocked');
  assert.equal(r.aiBots.GPTBot.status, 'allowed');
});

test('dns: failed lookups do not become findings; SPF all parsing', async () => {
  const reading = sampleReading();
  const routes = [[/cloudflare-dns\.com/, (u) => {
    const p = new URL(u).searchParams;
    if (p.get('type') === 'TXT') return { status: 503, body: 'down' };
    if (p.get('name') === 'example.com' && p.get('type') === 'MX') return json({ Status: 0, Answer: [] });
    return json({ Status: 0, Answer: [] });
  }]];
  await runPlugins(reading, getPlugins(), { phases: ['enrich'], only: ['dns'], fetch: mockFetch(routes) });
  const titles = reading.log._harplus.plugins.dns.findings.map((f) => f.title);
  assert.ok(!titles.some((t) => /SPF|DMARC/.test(t)), titles.join(' | '));

  const spfRoutes = (spf) => [[/cloudflare-dns\.com/, (u) => {
    const p = new URL(u).searchParams;
    const ans = p.get('name') === 'example.com' && p.get('type') === 'TXT' ? [{ name: 'example.com.', type: 16, TTL: 1, data: `"${spf}"` }] : [];
    return json({ Status: 0, Answer: ans });
  }]];
  for (const [spf, expected] of [['v=spf1 include:_spf.firewall.com -all', '-'], ['v=spf1 a mx all', '+'], ['v=spf1 mx ~all', '~']]) {
    const r = sampleReading();
    await runPlugins(r, getPlugins(), { phases: ['enrich'], only: ['dns'], fetch: mockFetch(spfRoutes(spf)) });
    assert.equal(r.log._harplus.plugins.dns.data.spfAll, expected, spf);
  }
});

test('security: redirect hop is not mixed content; meta frame-ancestors does not count', async () => {
  const reading = sampleReading();
  reading.log._harplus.plugins.meta.data.cspMeta = "default-src 'self'; frame-ancestors 'none'";
  await runPlugins(reading, getPlugins(), { phases: ['analyze'], only: ['security'], settings: OFFLINE });
  const titles = reading.log._harplus.plugins.security.findings.map((f) => f.title);
  assert.ok(!titles.some((t) => /insecure \(http:\)/.test(t)), 'no mixed content from the redirect');
  assert.ok(titles.some((t) => /can be framed/.test(t)), 'meta frame-ancestors ignored');
});

test('whois falls back to an HTTP WHOIS service when the TLD has no RDAP', async () => {
  const reading = sampleReading();
  reading.log._harplus.target = { ...reading.log._harplus.target, host: 'www.ucsd.edu', domain: 'ucsd.edu', site: 'ucsd.edu' };
  const routes = [
    [/rdap\.org\/domain\/ucsd\.edu/, { status: 404, body: { errorCode: 404 } }],
    [/who-dat\.as93\.net\/v1\/whois\/ucsd\.edu/, json({
      query: 'ucsd.edu', domain: 'ucsd.edu', tld: 'edu', isRegistered: true, id: null,
      registrar: { name: null }, status: [], nameservers: [{ name: 'NS-AUTH1.UCSD.EDU' }],
      dnssec: { signed: false, dsData: [] },
      dates: { created: '1986-05-05T00:00:00Z', updated: '2024-07-10T00:00:00Z', expires: '2027-07-31T00:00:00Z' },
      contacts: { registrant: { organization: 'University of California, San Diego', address: { city: 'La Jolla', country: 'USA' }, redacted: false } },
      meta: { source: 'whois', server: 'whois.educause.edu' },
    })],
  ];
  await runPlugins(reading, getPlugins(), { phases: ['enrich'], only: ['whois'], fetch: mockFetch(routes) });
  const w = reading.log._harplus.plugins.whois;
  assert.equal(w.status, 'ok', w.error);
  assert.match(w.data.source, /WHOIS via who-dat\.as93\.net \(whois\.educause\.edu\)/);
  assert.equal(w.data.registrant.org, 'University of California, San Diego');
  assert.equal(w.summary.find((x) => x.label === 'Registrar').value, 'EDUCAUSE (registry)');
  assert.ok(!w.findings.some((f) => /transfer-locked/.test(f.title)), 'no EPP lock finding for .edu');

  // port-43 path (CLI) wins over the HTTP service when available
  const r2 = sampleReading();
  r2.log._harplus.target = reading.log._harplus.target;
  const text = 'Domain Name: UCSD.EDU\n\nRegistrant:\n\tUniversity of California, San Diego\n\tUSA\n\nDomain record activated:    05-May-1986\nDomain expires:             31-Jul-2027\n';
  await runPlugins(r2, getPlugins(), { phases: ['enrich'], only: ['whois'], fetch: mockFetch(routes), whois: async () => ({ text, server: 'whois.educause.edu' }) });
  assert.equal(r2.log._harplus.plugins.whois.data.source, 'WHOIS (whois.educause.edu)');
  assert.equal(r2.log._harplus.plugins.whois.data.created.slice(0, 10), '1986-05-05');

  // an RDAP outage or rate limit also falls through
  const r3 = sampleReading();
  r3.log._harplus.target = reading.log._harplus.target;
  await runPlugins(r3, getPlugins(), { phases: ['enrich'], only: ['whois'], fetch: mockFetch([[/rdap\.org/, { status: 429, body: {} }], routes[1]]) });
  assert.equal(r3.log._harplus.plugins.whois.status, 'ok', r3.log._harplus.plugins.whois.error);
});

test('tech: community fingerprint database (Wappalyzer format) merges with built-ins', async () => {
  const reading = sampleReading();
  reading.log._harplus.probes.tech.dom = { 'link[href*="fonts.bunny.net"]': { attrs: { href: 'https://fonts.bunny.net/css?family=x' }, props: {} } };
  reading.log._harplus.probes.tech.globals['Drupal.settings'] = true;
  // current probe format: one record per matching element; page-controlled names stay plain keys
  reading.log._harplus.probes.tech.dom.button = [{ attrs: {}, props: {}, text: 'Menu' }, { attrs: {}, props: {}, text: 'Search' }, { attrs: {}, props: {}, text: 'Continue with Apple' }];
  reading.log._harplus.probes.tech.meta = { ...reading.log._harplus.probes.tech.meta, constructor: ['x'], __proto__: null };
  const db = {
    'categories.json': { 1: { name: 'CMS', priority: 1 }, 17: { name: 'Font scripts', priority: 9 }, 59: { name: 'JavaScript libraries', priority: 8 }, 27: { name: 'Programming languages', priority: 5 } },
    'd.json': { Drupal: { cats: [1], js: { 'Drupal.settings': '' }, implies: 'PHP', website: 'https://drupal.org' } },
    'b.json': { 'Bunny Fonts': { cats: [17], dom: { 'link[href*="fonts.bunny.net"]': { attributes: { href: 'fonts\\.bunny\\.net' } } } } },
    'j.json': { jQuery: { cats: [59], js: { 'jQuery.fn.jquery': '([\\d.]+)\\;version:\\1' } } },
    'p.json': { PHP: { cats: [27], headers: { 'X-Powered-By': 'php/?([\\d.]+)?\\;version:\\1' } } },
    'a.json': { 'Apple Sign-in': { cats: [69], dom: { button: { text: 'Continue with Apple' } } }, Constructo: { cats: [1], meta: { constructor: 'zzz' } } },
  };
  const routes = [[/raw\.githubusercontent\.com\/enthec\/webappanalyzer\/main\/src\/(?:technologies\/)?([\w.]+)$/, (u) => {
    const file = u.split('/').pop();
    return { body: db[file] || {} };
  }]];
  await runPlugins(reading, getPlugins(), { phases: ['analyze'], only: ['tech'], fetch: mockFetch(routes) });
  const t = reading.log._harplus.plugins.tech;
  assert.equal(t.status, 'ok', t.error);
  assert.equal(t.data.fingerprints.count, 6);
  const names = t.data.technologies.map((x) => x.name);
  for (const n of ['Drupal', 'Bunny Fonts', 'PHP', 'jQuery', 'WordPress', 'Apple Sign-in']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('Constructo'));
  assert.equal(names.filter((n) => n === 'jQuery').length, 1, 'built-in and database entries merge');
  assert.equal(t.data.technologies.find((x) => x.name === 'Drupal').website, 'https://drupal.org');
  assert.match(t.summary[0].value, /technologies in \d+ categories/);
});

/* ------------------------------------------------ composition & outside tools */

// A subset of the real web-features data (Apache-2.0); point HARPLUS_WEB_FEATURES at a full data.json to test against everything.
const WF_DATA = process.env.HARPLUS_WEB_FEATURES || new URL('./fixtures/web-features-subset.json', import.meta.url).pathname;

function withScripts() {
  const reading = sampleReading();
  const e = reading.log.entries;
  const script = (url, text, headers = []) => ({
    ...structuredClone(e[2]),
    request: { ...e[2].request, url },
    response: { ...e[2].response, headers: [{ name: 'content-type', value: 'text/javascript' }, ...headers], content: { size: text.length, mimeType: 'text/javascript', text } },
  });
  e.push(script('https://www.example.com/static/js/main.1a2b3c4d.js',
    '(()=>{var __webpack_require__={};self.webpackChunkapp=[];new IntersectionObserver(()=>{});customElements.define("x-a",class extends HTMLElement{});structuredClone({})})();\n' + 'x'.repeat(3000) + '\n//# sourceMappingURL=main.1a2b3c4d.js.map'));
  e.push(script('https://cdn.polyfill.io/v3/polyfill.min.js', 'var regeneratorRuntime={};'));
  return reading;
}

test('javascript: build fingerprints, source maps, compromised CDNs, API references', async () => {
  const reading = withScripts();
  await runPlugins(reading, getPlugins(), { phases: ['analyze'], only: ['javascript'] });
  const j = reading.log._harplus.plugins.javascript;
  assert.equal(j.status, 'ok', j.error);
  assert.ok(j.data.builds.includes('webpack'));
  assert.ok(j.data.builds.includes('Create React App'));
  assert.equal(j.data.totals.sourceMaps, 1);
  assert.equal(j.data.scripts.find((s) => s.sourceMap).sourceMap, 'https://www.example.com/static/js/main.1a2b3c4d.js.map');
  assert.ok(j.findings.some((f) => f.severity === 'high' && /polyfill\.io/.test(f.title)));
  for (const k of ['api.IntersectionObserver', 'api.CustomElementRegistry.define', 'api.structuredClone']) assert.ok(j.data.apis[k], k);
});

test('baseline: maps observed features to Baseline status', async () => {
  const { readFileSync } = await import('node:fs');
  const reading = withScripts();
  const hp = reading.log._harplus;
  hp.plugins.css = { id: 'css', status: 'ok', data: {
    usage: { properties: { display: 3, 'aspect-ratio': 1, '--brand': 1, 'anchor-name': 1 }, values: { display: ['grid', 'flex'] }, functions: { clamp: 2, oklch: 1, 'light-dark': 1 }, units: { dvh: 1, cqi: 1 }, pseudoClasses: { has: 1, 'focus-visible': 1 }, pseudoElements: {} },
    atRules: { layer: 2, container: 1, media: 4 }, mediaFeatures: { 'prefers-color-scheme': 1, 'range-syntax': 1 }, stats: { nested: 3 },
  } };
  hp.plugins.html = { id: 'html', status: 'ok', data: {
    elements: { dialog: 1, search: 1, div: 10 }, attrPairs: { 'img.loading': 2, 'img.fetchpriority': 1 }, globalAttrs: { popover: 1, inert: 1 },
    inputTypes: { date: 1 }, linkRels: { preload: 1, modulepreload: 1 }, scriptTypes: { module: 1, importmap: 1, speculationrules: 1 },
    components: { customTags: ['x-a'], defined: 1, shadowRoots: 1, dsd: 0 },
  } };
  const data = readFileSync(WF_DATA, 'utf8');
  await runPlugins(reading, getPlugins(), { phases: ['analyze'], only: ['javascript', 'baseline'], fetch: mockFetch([[/web-features/, { body: data }]]) });
  const b = hp.plugins.baseline;
  assert.equal(b.status, 'ok', b.error);
  const ids = new Set(b.data.features.map((f) => f.id));
  for (const id of ['grid', 'aspect-ratio', 'cascade-layers', 'container-queries', 'has', 'nesting', 'dialog', 'popover', 'loading-lazy',
    'js-modules', 'import-maps', 'oklab', 'light-dark', 'min-max-clamp', 'viewport-unit-variants', 'prefers-color-scheme',
    'media-query-range-syntax', 'intersection-observer', 'autonomous-custom-elements', 'speculation-rules', 'anchor-positioning', 'brotli']) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  assert.ok(b.data.features.some((f) => f.baseline === 'limited'));
  assert.match(b.summary[0].value, /widely · \d+ newly · \d+ limited/);
});

test('css-validate tolerates the validator\'s stray-comma JSON', async () => {
  const reading = sampleReading();
  const sheet = structuredClone(reading.log.entries[1]);
  sheet.request.url = 'https://www.example.com/site.css';
  sheet._resourceType = 'stylesheet';
  sheet.response.content = { size: 30, mimeType: 'text/css', text: 'a { colr: red } .b { color: blue }' };
  reading.log.entries.push(sheet);
  const body = '{ "cssvalidation" : { "uri" : "file://localhost/TextArea", "csslevel" : "css3", "validity" : false, "result" : { "errorcount" : 1, "warningcount" : 0 } , "errors" : [ { "source" : "x", "line" : 1, "context" : " a ", "type" : "noexistence", "message" : "Property \\u201Ccolr\\u201D doesn\'t exist" } ] , "warnings" : [ , ] } }';
  await runPlugins(reading, getPlugins(), { phases: ['enrich'], only: ['css-validate'], fetch: mockFetch([[/jigsaw\.w3\.org/, { body }]]) });
  const c = reading.log._harplus.plugins['css-validate'];
  assert.equal(c.status, 'ok', c.error);
  assert.equal(c.data.sheets[0].errors.length, 1);
  assert.match(c.data.sheets[0].errors[0].message, /colr/);
  assert.match(c.findings[0].title, /1 CSS validation errors in 1 stylesheets/);
});

test('observatory, pagespeed and history parse their services', async () => {
  const reading = sampleReading();
  const lhr = { lighthouseVersion: '13.5.0', categories: { performance: { title: 'Performance', score: 0.61, auditRefs: [{ id: 'lcp' }] } }, audits: { lcp: { id: 'lcp', title: 'Largest Contentful Paint', score: 0.3, scoreDisplayMode: 'numeric', displayValue: '4.9 s' } } };
  const routes = [
    [/observatory-api\.mdn\.mozilla\.net\/api\/v2\/scan\?host=www\.example\.com/, json({ id: 1, details_url: 'https://developer.mozilla.org/en-US/observatory/analyze?host=www.example.com', algorithm_version: 4, scanned_at: '2026-10-08T17:00:00Z', error: null, grade: 'D', score: 30, status_code: 200, tests_failed: 5, tests_passed: 5, tests_quantity: 10 })],
    [/pagespeedonline\/v5\/runPagespeed/, json({ lighthouseResult: lhr, loadingExperience: { overall_category: 'SLOW', metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4200, category: 'SLOW' }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: 'FAST' } } } })],
    [/web\.archive\.org\/cdx/, json([['timestamp', 'statuscode', 'digest'], ['19961019000000', '200', 'A'], ['20100101000000', '200', 'B'], ['20261001000000', '200', 'B']])],
    [/tranco-list\.eu\/api\/ranks\/domain\/example\.com/, json({ domain: 'example.com', ranks: [{ date: '2026-10-01', rank: 120 }, { date: '2026-09-01', rank: 99 }] })],
  ];
  const settings = { keys: { pagespeed: 'k' }, plugins: { observatory: { enabled: true } } };
  await runPlugins(reading, getPlugins(settings), { phases: ['enrich'], only: ['observatory', 'pagespeed', 'history'], settings, fetch: mockFetch(routes) });
  const p = reading.log._harplus.plugins;
  assert.equal(p.observatory.status, 'ok', p.observatory.error);
  assert.equal(p.observatory.findings[0].severity, 'high');
  assert.equal(p.pagespeed.status, 'ok', p.pagespeed.error);
  assert.equal(p.pagespeed.data.field.metrics[0].p75, '4.2 s');
  assert.ok(p.pagespeed.findings.some((f) => /Real users: LCP p75 4\.2 s \(poor\)/.test(f.title)));
  assert.equal(p.history.status, 'ok', p.history.error);
  assert.equal(p.history.data.wayback.first, '1996-10-19');
  assert.equal(p.history.data.wayback.changes, 1);
  assert.equal(p.history.data.tranco.rank, 120);
  assert.equal(p.history.data.tranco.best, 99);
});

test('css: recorded bodies are also keyed by the URLs that redirected to them', async () => {
  const css = getPlugins().find((p) => p.id === 'css');
  const util = await import('../extension/core/har-util.js');
  const entry = (url, status, extra = {}) => ({
    _resourceType: 'stylesheet', request: { method: 'GET', url, headers: [] },
    response: { status, headers: extra.location ? [{ name: 'location', value: extra.location }] : [], redirectURL: extra.location || '', content: { size: 0, mimeType: 'text/css', text: extra.text } },
  });
  const har = { log: { entries: [
    entry('https://cdn.test/lib/style.css', 302, { location: 'https://cdn.test/lib@1.2.3/style.css' }),
    entry('https://cdn.test/lib@1.2.3/style.css', 200, { text: '.x{color:red}' }),
  ] } };
  const { sheets } = css.collectArgs({ har, util });
  assert.equal(sheets.length, 1);
  assert.deepEqual(sheets[0].aliases, ['https://cdn.test/lib/style.css']);
});

test('vitals: CLS finding names the shifted elements; render lists shifts', async () => {
  const { h } = await import('../extension/ui/render.js');
  const collected = { visibility: 'visible', navigation: { ttfb: 100 }, fcp: 500, lcp: { time: 1000 }, cls: 0.3, blockingTime: 0, longAnimationFrames: 0, renderBlocking: [], domElements: 10, resources: 1,
    clsSources: [{ value: 0.2, sources: [{ node: 'div.ad', previous: { x: 0, y: 0, w: 300, h: 0 }, current: { x: 0, y: 0, w: 300, h: 250 } }] }, { value: 0.1, sources: [{ node: 'img.hero', previous: null, current: { x: 0, y: 0, w: 10, h: 10 } }] }] };
  const out = vitalsPlugin.run({}, { collected, skip: () => {} });
  const f = out.findings.find((x) => /Cumulative layout shift/.test(x.title));
  assert.equal(f.detail, 'Shifted: div.ad, img.hero');
  const html = String(vitalsPlugin.render({ status: 'ok', ...out }, h));
  assert.match(html, /div\.ad/);
  assert.doesNotMatch(html, /NaN|undefined/);
});

test('pagespeed: strategy auto follows the reading base view', async () => {
  const urls = [];
  const mk = (device) => ({
    reading: { log: { entries: [], _harplus: { capture: { device } } } },
    ctx: { keys: { pagespeed: 'k' }, options: { strategy: 'auto' }, target: { finalUrl: 'https://s.test/', host: 's.test' }, util: { isIP: () => false },
      fetch: async (u) => { urls.push(String(u)); return new Response(JSON.stringify({}), { status: 200 }); }, skip: (m) => { throw new Error(m); } },
  });
  const m = mk('mobile');
  const outM = await pagespeedPlugin.run(m.reading, m.ctx);
  const d = mk('desktop');
  const outD = await pagespeedPlugin.run(d.reading, d.ctx);
  assert.match(urls[0], /strategy=mobile/);
  assert.match(urls[1], /strategy=desktop/);
  assert.equal(outM.data.strategy, 'mobile');
  assert.equal(outD.data.strategy, 'desktop');
  assert.equal(pagespeedPlugin.options.find((o) => o.key === 'strategy').default, 'auto');
  assert.deepEqual(pagespeedPlugin.options.find((o) => o.key === 'strategy').choices, ['auto', 'mobile', 'desktop']);
});

import meta from '../extension/plugins/meta.js';
import * as hu from '../extension/core/har-util.js';

test('meta: description quality, Twitter card, no structured data', () => {
  const collected = (over) => ({
    url: 'https://s.test/', title: 'A good page title here', description: 'A good page title here', canonical: 'https://s.test/',
    robots: '', googlebot: '', viewport: 'width=device-width', og: { 'og:title': 'x', 'og:image': 'y' }, twitter: {}, icons: ['/f.ico'],
    jsonld: [], jsonldErrors: [], compatMode: 'CSS1Compat', charset: 'UTF-8', images: { noDimensions: 0, total: 0 },
    forms: [], headings: [{ level: 1, text: 'H' }], links: { externalUrls: [] }, generator: [], emails: [], phones: [],
    words: 10, domElements: 10, customElements: [], ...over,
  });
  const run = (c) => meta.run({}, { collected: c, util: hu, target: { site: 's.test' }, skip: (m) => { throw new Error(m); } });
  const t = (c) => run(c).findings.map((f) => f.title);
  assert.ok(t(collected()).includes('Meta description is too short or repeats the title'));
  assert.ok(t(collected({ description: 'Short one' })).includes('Meta description is too short or repeats the title'));
  assert.ok(!t(collected({ description: 'A properly long description that says what the page offers to readers.' })).includes('Meta description is too short or repeats the title'));
  assert.ok(t(collected()).includes('No Twitter card tag'));
  assert.ok(!t(collected({ twitter: { 'twitter:card': 'summary' } })).includes('No Twitter card tag'));
  assert.ok(t(collected()).includes('No structured data (JSON-LD)'));
  assert.ok(!t(collected({ jsonld: [{ '@type': 'Organization' }] })).includes('No structured data (JSON-LD)'));
  const f = run(collected()).findings;
  assert.equal(f.find((x) => x.title === 'No Twitter card tag').category, 'seo');
  assert.equal(f.find((x) => x.title === 'No structured data (JSON-LD)').severity, 'info');
});

test('html plugin no longer reports a missing <main>', async () => {
  const { default: html } = await import('../extension/plugins/html.js');
  assert.doesNotMatch(String(html.run), /No <main> element/);
});

import { missingTags } from '../extension/plugins/meta.js';

test('meta: og:url vs canonical, relative share images, duplicates', () => {
  const base = {
    url: 'https://s.test/a', title: 'A good page title here', description: 'A long enough description of the page for search.', canonical: 'https://s.test/a',
    robots: '', googlebot: '', viewport: 'width=device-width', og: { 'og:title': 'x', 'og:image': 'https://s.test/i.png', 'og:url': 'https://s.test/a/?utm_source=x#top' },
    twitter: { 'twitter:card': 'summary' }, icons: ['/f.ico'], jsonld: [{ '@type': 'Organization' }], jsonldErrors: [], compatMode: 'CSS1Compat', charset: 'UTF-8',
    images: { noDimensions: 0, total: 0 }, forms: [], headings: [{ level: 1, text: 'H' }], links: { externalUrls: [] }, generator: [], emails: [], phones: [],
    words: 10, domElements: 10, customElements: [], counts: { title: 1, description: 1, viewport: 1 }, dupProps: [],
  };
  const t = (c) => meta.run({}, { collected: c, util: hu, target: { site: 's.test' }, skip: (m) => { throw new Error(m); } }).findings.map((f) => f.title);
  assert.ok(!t(base).includes('og:url differs from the canonical URL'), 'trailing slash, utm and hash are ignored');
  assert.ok(t({ ...base, og: { ...base.og, 'og:url': 'https://s.test/b' } }).includes('og:url differs from the canonical URL'));
  assert.ok(t({ ...base, og: { ...base.og, 'og:image': '/i.png' } }).includes('Share image URL is relative (og:image / twitter:image must be absolute)'));
  assert.ok(t({ ...base, counts: { title: 1, description: 1, viewport: 2 }, dupProps: ['og:title ×2'] }).includes('Duplicate meta tags: 2 viewport, og:title ×2'));
  assert.ok(!t(base).some((x) => x.startsWith('Duplicate meta tags')));
});

test('missingTags: fills known values, escapes, lists everything for a bare page', () => {
  const bare = missingTags({ title: 'Tents & "Stoves"', description: '', og: {}, twitter: {} }, { finalUrl: 'https://s.test/p', host: 's.test' });
  assert.deepEqual(bare.tags.map((x) => x.tag), ['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'og:site_name', 'twitter:card', 'description', 'canonical']);
  assert.match(bare.snippet, /<meta property="og:title" content="Tents &amp; &quot;Stoves&quot;">/);
  assert.match(bare.snippet, /<meta property="og:url" content="https:\/\/s\.test\/p">/);
  assert.match(bare.snippet, /<meta property="og:site_name" content="s\.test">/);
  assert.match(bare.snippet, /<meta name="twitter:card" content="summary">/);
  assert.doesNotMatch(bare.snippet, /undefined/);
  const full = missingTags({ title: 'T', description: 'D', canonical: 'https://s.test/p', og: { 'og:title': 1, 'og:description': 1, 'og:image': 1, 'og:url': 1, 'og:type': 1, 'og:site_name': 1 }, twitter: { 'twitter:card': 'summary' } }, {});
  assert.deepEqual(full.tags, []);
  assert.equal(full.snippet, '');
});
