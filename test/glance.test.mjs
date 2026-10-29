import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../extension/ui/render.js';
import { getPlugins } from '../extension/plugins/index.js';

const plugin = (id) => getPlugins().find((p) => p.id === id);
const ok = (data, extra = {}) => ({ status: 'ok', data, findings: [], summary: [], ...extra });
const G = (id, data, ctx = {}) => String(plugin(id).glance(ok(data), h, ctx));

test('vitals glance: four threshold meters plus blocking time', () => {
  const s = G('vitals', {
    lcp: { time: 3100, element: 'img' }, cls: 0.04, fcp: 1200, blockingTime: 610,
    navigation: { ttfb: 420 }, ratings: { lcp: 'needs improvement', cls: 'good', fcp: 'good', ttfb: 'good' },
  });
  assert.equal((s.match(/class="chart meter"/g) || []).length, 5);
  assert.match(s, /Largest contentful paint/);
  assert.match(s, /3\.1 s/);
  assert.match(s, /data-status="fair">Needs improvement/);
  assert.match(s, /data-status="poor">Poor/); // blocking 610 > 600
});

test('vitals summary carries ratings and the LCP headline', async () => {
  const v = plugin('vitals');
  const out = v.run({ log: { entries: [] } }, {
    collected: { navigation: { ttfb: 100 }, fcp: 900, lcp: { time: 3000 }, cls: 0.3, blockingTime: 0, renderBlocking: [], domElements: 10, visibility: 'visible' },
    skip: () => { throw new Error('skip'); },
  });
  const lcp = out.summary.find((s) => s.label === 'LCP');
  assert.deepEqual(lcp, { label: 'LCP', value: '3.00 s', rating: 'needs improvement', headline: true });
  assert.equal(out.summary.find((s) => s.label === 'CLS').rating, 'poor');
});

test('network glance: weight donut, party bars, top hosts', () => {
  const s = G('network', {
    totals: { requests: 10, bytes: 2_500_000, decoded: 6_000_000, thirdParty: { requests: 4, bytes: 500_000 } },
    byType: [{ type: 'image', requests: 3, bytes: 1_000_000 }, { type: 'script', requests: 4, bytes: 900_000 }, { type: 'font', requests: 2, bytes: 600_000 }],
    hosts: [{ host: 'a.com', requests: 6, bytes: 2_000_000, thirdParty: false }, { host: 'gtm.com', requests: 4, bytes: 500_000, thirdParty: true }],
  });
  assert.match(s, /class="chart donut"/);
  assert.match(s, />2\.38<\/text>/);
  assert.match(s, /class="unit"[^>]*>MB</);
  assert.match(s, /aria-label="Requests: First party 6, Third party 4"/);
  assert.match(s, /a\.com/);
  assert.match(s, /width:66\.7%;background:var\(--c2\)/);
});

test('pagespeed glance: one ring per Lighthouse category', () => {
  const s = G('pagespeed', { strategy: 'mobile', lab: { scores: { performance: 0.42, accessibility: 0.95, 'best-practices': 1, seo: null } } });
  assert.equal((s.match(/class="chart ring"/g) || []).length, 3);
  assert.match(s, /Lighthouse Performance: 42 of 100/);
  assert.equal(G('pagespeed', { lab: null }), '');
});

test('a11y-basics glance: issues by check and structure checklist', () => {
  const s = G('a11y-basics', {
    rules: [{ id: 'image-alt', help: 'Images without alt', count: 4 }, { id: 'input-label', help: 'Unlabelled inputs', count: 2 }],
    stats: { landmarks: 3, skipLink: false },
  });
  assert.match(s, /Images without alt/);
  assert.match(s, /<b>4<\/b>/);
  assert.match(s, /Skip link/);
  assert.equal((s.match(/data-status="poor"/g) || []).length, 3); // skip link, image alt, labels
  assert.match(G('a11y-basics', { rules: [], stats: { landmarks: 0, skipLink: true } }), /No issues found by the basic checks/);
});

test('axe glance: top violations by elements', () => {
  const s = G('axe', { violations: [{ id: 'x', help: 'Contrast', impact: 'serious', nodes: 9 }], passes: 40, incomplete: [{ id: 'a' }, { id: 'b' }] });
  assert.match(s, /Contrast/);
  assert.match(s, /<b>9<\/b>/);
});

test('security glance: header checklist, certificate timeline, cookie flags', () => {
  const now = Date.now() / 1000;
  const s = G('security', {
    https: true,
    headers: [{ label: 'Strict-Transport-Security', ok: true }, { label: 'Content-Security-Policy', ok: false }],
    tls: { protocol: 'TLS 1.3', issuer: 'R11', validFrom: now - 30 * 86400, validTo: now + 60 * 86400 },
    cookies: [{ name: 'a', secure: true, httpOnly: true }, { name: 'b', secure: false, httpOnly: false }],
  });
  assert.equal((s.match(/data-status="good"/g) || []).length, 2); // HTTPS + HSTS
  assert.match(s, /TLS certificate · 60 days left/);
  assert.match(s, /class="chart timeline"/);
  assert.match(s, /Weak flags/);
});

test('security glance: certificate times as the recorder saves them (ISO strings)', () => {
  const iso = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
  const s = G('security', {
    https: true, headers: [],
    tls: { protocol: 'TLS 1.3', issuer: 'R11', validFrom: iso(-30), validTo: iso(60) },
    cookies: [],
  });
  assert.match(s, /TLS certificate · 60 days left/);
  assert.ok(!/NaN/.test(s), 'no NaN in the days or the timeline');
  assert.match(s, /33\.3% elapsed/);
});

test('observatory glance: grade ring', () => {
  const s = G('observatory', { grade: 'B', score: 75, tests_passed: 8, tests_failed: 2 });
  assert.match(s, /Mozilla Observatory: 75 of 100/);
  assert.match(s, /Grade B/);
});

test('html glance: semantic share and landmarks', () => {
  const s = G('html', { total: 1000, semantic: 620, generic: 310, landmarks: { header: 1, main: 1, footer: 1 } });
  assert.match(s, /HTML elements · 1,000/);
  assert.match(s, /Semantic/);
  assert.match(s, /<em>62%<\/em>/);
  assert.equal((s.match(/data-status="poor"/g) || []).length, 1); // no <nav>
});

test('css glance: rule, !important, custom property and palette tiles', () => {
  const s = G('css', { stats: { styleRules: 4210, declarations: 2000, important: 120 }, custom: { defined: 212, used: 180 }, colorCount: 34, fontFamilies: ['a', 'b'] });
  assert.match(s, /4,210/);
  assert.match(s, /6%/);
  assert.match(s, /data-status="fair">Needs improvement/);
  assert.match(s, /212/);
});

test('javascript glance: first vs third-party bytes', () => {
  const s = G('javascript', { totals: { count: 12, bytes: 1_000_000, thirdPartyBytes: 580_000 } });
  assert.match(s, /Script bytes/);
  assert.match(s, /Third party/);
});

test('baseline glance: widely / newly / limited', () => {
  const s = G('baseline', { features: [{ baseline: 'widely' }, { baseline: 'widely' }, { baseline: 'newly' }, { baseline: 'limited' }] });
  assert.match(s, /Platform features · 4/);
  assert.match(s, /aria-label="Baseline: Widely available 2, Newly available 1, Limited 1"/);
});

test('tech glance: badges grouped by category', () => {
  const s = G('tech', { technologies: [{ name: 'Shopify', category: 'CMS' }, { name: 'React', category: 'UI', version: '18' }, { name: 'Vue', category: 'UI' }] });
  assert.match(s, /<h4>CMS<\/h4>/);
  assert.match(s, /<h4>UI<\/h4>/);
  assert.match(s, /React 18/);
});

test('dns glance: request path uses ip-intel when present; DNS posture checklist', () => {
  const data = {
    host: 'www.acme.com', ns: ['ada.ns.cloudflare.com'], ipv4: ['1.1.1.1'], ipv6: [], cnames: [], caa: [], dnssec: false,
    dmarc: { p: 'reject' }, spf: 'v=spf1 -all', providers: { dns: ['Cloudflare'], web: ['Shopify'], mail: ['Google Workspace'], senders: [] },
  };
  const ctx = { results: { 'ip-intel': { status: 'ok', data: { servers: [{ ip: '1.1.1.1', main: true, provider: 'Cloudflare', asn: 13335, geo: { country: 'US' } }] } } }, target: { host: 'www.acme.com' } };
  const s = G('dns', data, ctx);
  assert.equal((s.match(/class="node"/g) || []).length, 4); // domain, web host, server, mail
  assert.match(s, /AS13335/);
  assert.match(s, /Google Workspace/);
  assert.match(s, /DMARC enforced/);
  assert.equal((s.match(/data-status="poor"/g) || []).length, 3); // IPv6, DNSSEC, CAA
  assert.equal((G('dns', data).match(/class="node"/g) || []).length, 3, 'no ip-intel → no server node');
});

test('whois glance: registration lifetime', () => {
  const s = G('whois', { created: '2012-03-01T00:00:00Z', expires: '2028-03-01T00:00:00Z', ageDays: 5000, daysLeft: 500 });
  assert.match(s, /Registered 2012/);
  assert.match(s, /Expires 2028/);
  assert.equal(G('whois', { created: null, expires: null }), '');
});

test('well-known glance: files checklist', () => {
  const s = G('well-known', { robots: { rules: 2 }, sitemap: { urls: 2 }, security: null, llms: null, manifest: null });
  assert.equal((s.match(/data-status="good"/g) || []).length, 2);
  assert.match(s, /security\.txt/);
});

test('network glance donut: one Other slice, sized in bytes', () => {
  const types = ['document', 'script', 'stylesheet', 'image', 'font', 'xhr', 'media', 'other'];
  const s = G('network', {
    totals: { requests: 8, bytes: 80_000, decoded: 80_000, thirdParty: { requests: 0, bytes: 0 } },
    // 'other' is the third-largest type, so today it is kept *and* a second "Other" fold is appended.
    byType: types.map((type, i) => ({ type, requests: 1, bytes: type === 'other' ? 15_000 : 20_000 - i * 2000 })),
    hosts: [{ host: 'a.com', requests: 8, bytes: 80_000, thirdParty: false }],
  });
  const legend = s.slice(s.indexOf('<ul class="legend">'));
  assert.equal((legend.match(/<span>Other<\/span>/g) || []).length, 1);
  assert.doesNotMatch(legend, /<span>Other<\/span><em>[\d,]+<\/em>/);
});
