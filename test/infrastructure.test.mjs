import { test } from 'node:test';
import assert from 'node:assert/strict';
import ctLogs from '../extension/plugins/ct-logs.js';
import dns from '../extension/plugins/dns.js';
import history from '../extension/plugins/history.js';
import ipIntel from '../extension/plugins/ip-intel.js';
import wellKnown from '../extension/plugins/well-known.js';
import whois from '../extension/plugins/whois.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';
import { h } from '../extension/ui/render.js';
import {
  CT_LOGS, DNS, HISTORY, IP_INTEL, WELL_KNOWN, WHOIS, ODD_HOST, LONG_HOST, runCase, frozen,
} from './fixtures/infrastructure-cases.mjs';
import BASELINE from './fixtures/infrastructure-findings-baseline.json' with { type: 'json' };

const PLUGINS = {
  'ct-logs': [ctLogs, CT_LOGS], dns: [dns, DNS], history: [history, HISTORY],
  'ip-intel': [ipIntel, IP_INTEL], 'well-known': [wellKnown, WELL_KNOWN], whois: [whois, WHOIS],
};

const draw = (plugin, out) => frozen(() => String(plugin.render({ status: 'ok', ...out }, h)));
const heads = (out) => out.summary.filter((x) => x.headline).map((x) => `${x.label} ${x.value}`);

test('findings: every field but places is unchanged from before places (score-check cannot replay enrich plugins)', async () => {
  for (const [id, [plugin, cases]] of Object.entries(PLUGINS)) {
    for (const [name, make] of Object.entries(cases)) {
      const out = await runCase(plugin, make);
      // Through JSON, as the baseline was saved: undefined fields (normalize drops them too) are not differences.
      assert.deepEqual(JSON.parse(JSON.stringify(out.findings.map(({ places, ...f }) => f))), BASELINE[id][name], `${id}: ${name}`);
    }
  }
});

/** Pass one plugin result through normalize(), as a real run does. */
async function normalized(out) {
  const reading = createReading({ entries: [], target: makeTarget('https://www.example.com/', 'E', 'https://www.example.com/') });
  await runPlugins(reading, [{ id: 'n', name: 'N', phase: 'analyze', run: async () => out }], {});
  return reading.log._harplus.plugins.n;
}

test('only the ct-logs notable-hostnames finding has places (the rest name no hosts or URLs in their evidence)', async () => {
  for (const [id, [plugin, cases]] of Object.entries(PLUGINS)) {
    for (const [name, make] of Object.entries(cases)) {
      const r = await normalized(await runCase(plugin, make));
      for (const f of r.findings) {
        const notable = id === 'ct-logs' && /admin-looking hostnames/.test(f.title);
        assert.equal(!!f.places, notable, `${id}: ${name}: ${f.title}`);
      }
    }
  }
});

test('ct-logs: each notable hostname is a place; the evidence still names them one a line', async () => {
  const r = await normalized(await runCase(ctLogs, CT_LOGS.base));
  const f = r.findings.find((x) => /admin-looking/.test(x.title));
  assert.deepEqual(f.places, [{ url: 'https://staging.example.com/' }, { url: 'https://vpn.example.com/' }, { url: 'https://admin.example.com/' }]);
  assert.equal(f.evidence, 'staging.example.com\nvpn.example.com\nadmin.example.com');
  assert.equal(r.findings.find((x) => /hostnames on certificates/.test(x.title)).places, undefined);
});

test('ct-logs odd values: 302 notable names give 200 places, a long name is cut, markup in a name is escaped', async () => {
  const r = await normalized(await runCase(ctLogs, CT_LOGS['odd and crowded']));
  const f = r.findings.find((x) => /admin-looking/.test(x.title));
  assert.match(f.title, /^302 /);
  assert.equal(f.places.length, 200);
  assert.equal(f.evidence.split('\n').length, 25, 'evidence still names the first 25');
  assert.equal(f.places[0].url, `https://${ODD_HOST.toLowerCase()}/`);
  assert.equal(f.places[1].url.length, 500, 'normalize cuts the long name');
  assert.ok(`https://${LONG_HOST}/`.startsWith(f.places[1].url));
  const s = String(h.places(f.places));
  assert.doesNotMatch(s, /<b>/);
  assert.match(s, /staging\.&lt;b&gt;&amp;&quot;x&quot;\.example\.com/);
});

test('ct-logs render: answer first, true hostname count past the 1000 cap, both tables folded', async () => {
  const out = await runCase(ctLogs, CT_LOGS['odd and crowded']);
  const s = await draw(ctLogs, out);
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<table'));
  assert.match(s, /Hostnames<\/span><div class="stat-value">602</);
  assert.match(s, /Notable<\/span><div class="stat-value">302</);
  assert.match(s, /Certificates<\/span><div class="stat-value">301</);
  assert.match(s, /<h4>Hostnames \(300 of 602\)<\/h4>/);
  assert.match(s, /<summary>292 more<\/summary>/, 'the hostname table folds past 8');
  // An older reading without the true count falls back to the list.
  const old = { ...out, data: { ...out.data, hostnames: undefined } };
  assert.match(await draw(ctLogs, old), /Hostnames<\/span><div class="stat-value">602</);
  const many = { ...out, data: { ...out.data, hostnames: 1500, subdomains: out.data.subdomains } };
  assert.match(await draw(ctLogs, many), /<h4>Hostnames \(300 of 1500\)<\/h4>/);
  const base = await draw(ctLogs, await runCase(ctLogs, CT_LOGS.base));
  assert.match(base, /<h4>Hostnames<\/h4>/);
  assert.match(base, /<th scope="col">Wildcard<\/th>/);
  assert.match(base, /<td>staging\.example\.com<\/td><td>1<\/td><td>2026-09-01<\/td><td>2026-09-01<\/td><td>yes<\/td>/);
});

test('ct-logs headline reads on its own', async () => {
  assert.deepEqual(heads(await runCase(ctLogs, CT_LOGS.base)), ['Hostnames 5 from 4 certificates (unexpired)']);
});

test('dns render: counts first; no host or DNSSEC row (the glance has them); records follow', async () => {
  const out = await runCase(dns, DNS['well configured']);
  const s = await draw(dns, out);
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<dl'));
  assert.match(s, /Addresses<\/span><div class="stat-value">3<\/div><span class="stat-note">2 IPv4 · 1 IPv6/);
  assert.match(s, /Nameservers<\/span><div class="stat-value">2/);
  assert.match(s, /Mail servers<\/span><div class="stat-value">2/);
  assert.match(s, /TXT records<\/span><div class="stat-value">3<\/div><span class="stat-note">1 SaaS verifications/);
  assert.doesNotMatch(s, /<dt>(Host|DNSSEC)<\/dt>/);
  assert.match(s, /<dt>CNAME chain<\/dt><dd>www\.example\.com\.cdn\.cloudflare\.net<\/dd>/);
  assert.match(s, /<dt>SPF<\/dt>/);
  assert.match(s, /<th scope="col">Tag<\/th>/);
  assert.deepEqual(heads(out), ['Web host (CNAME) Cloudflare']);
  assert.deepEqual(heads(await runCase(dns, DNS['bare domain'])), ['Web host (CNAME) none (no CNAME)']);
  assert.match(String(dns.render({ status: 'ok', data: {} }, h)), /class="stats"/, 'an empty reading still renders');
});

test('history render: first capture and counts first; captures per year closed; headline reads on its own', async () => {
  const out = await runCase(history, HISTORY['old and ranked']);
  const s = await draw(history, out);
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<dl'));
  assert.match(s, /First capture<\/span><div class="stat-value">1996-10-19/);
  assert.match(s, /Days captured<\/span><div class="stat-value">4/);
  assert.match(s, /Content changes<\/span><div class="stat-value">2/);
  assert.match(s, /Tranco rank<\/span><div class="stat-value">#120<\/div><span class="stat-note">best #99/);
  assert.match(s, /<details class="disclosure"><summary>Captures per year<span class="disclosure-meta">4<\/span>/);
  assert.doesNotMatch(s, /<details class="disclosure" open/);
  assert.match(s, /<a href="https:\/\/web\.archive\.org\/web\/19961019000000\/www\.example\.com"[^>]*>1996-10-19<\/a>/);
  assert.doesNotMatch(s, /<dt>Best rank<\/dt>/);
  assert.deepEqual(heads(out), ['Archived since 1996-10-19 (30.1 years)']);
  const down = await runCase(history, HISTORY['wayback down']);
  assert.match(await draw(history, down), /First capture<\/span><div class="stat-value">error<\/div><span class="stat-note">HTTP 503/);
  assert.deepEqual(heads(await runCase(history, HISTORY['never archived, not ranked'])), ['Archived since never']);
});

test('ip-intel render: answer first with the true IP count; a row\'s hosts fold past 8', async () => {
  const out = await runCase(ipIntel, IP_INTEL['origin and cdn']);
  assert.equal(out.data.ipCount, 3);
  const s = await draw(ipIntel, out);
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<table'));
  assert.match(s, /Server IPs<\/span><div class="stat-value">3<\/div>/);
  assert.match(s, /Providers<\/span><div class="stat-value">3<\/div><span class="stat-note">3 first-party/);
  assert.match(s, /Main network<\/span><div class="stat-value">AS14061<\/div><span class="stat-note">DigitalOcean/);
  assert.match(s, /<th scope="col">Reverse DNS<\/th>/);
  const capped = await frozen(() => { const [r, ctx] = IP_INTEL['origin and cdn'](); return ipIntel.run(r, { ...ctx, options: { ...ctx.options, maxIps: 1 } }); });
  assert.match(await draw(ipIntel, capped), /Server IPs<\/span><div class="stat-value">3<\/div><span class="stat-note">1 looked up/);
  const hosts = Array.from({ length: 11 }, (_, i) => `h${i}.example.com`);
  const wide = { ...out, data: { ...out.data, servers: [{ ...out.data.servers[0], hosts }] } };
  assert.match(await draw(ipIntel, wide), /<summary>3 more<\/summary>/);
  assert.deepEqual(heads(out), ['Hosting DigitalOcean · cloud']);
});

test('well-known render: answer first, one row per file folded past 8, robots sitemaps as links, humans.txt closed', async () => {
  const out = await runCase(wellKnown, WELL_KNOWN['everything published']);
  const s = await draw(wellKnown, out);
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<table'));
  assert.match(s, /Crawl allowed<\/span><div class="stat-value">6 of 8<\/div>/);
  assert.match(s, /Index allowed<\/span><div class="stat-value">8 of 8<\/div>/);
  assert.match(s, /AI crawlers blocked<\/span><div class="stat-value">2 of 19<\/div>/);
  assert.match(s, /Sitemap<\/span><div class="stat-value">2<\/div><span class="stat-note">URLs/);
  assert.match(s, /<td>robots\.txt<\/td><td>found<\/td>/);
  assert.match(s, /<summary>2 more<\/summary>/, '10 files: the last 2 fold');
  assert.match(s, /<td>App associations<\/td><td>found<\/td><td>ABCDE\.com\.example\.ios, com\.example\.app<\/td>/);
  assert.match(s, /<h4>Sitemaps listed in robots\.txt<\/h4>[\s\S]*?<a href="https:\/\/www\.example\.com\/sitemap\.xml"[^>]*><span class="url"/);
  assert.match(s, /<details class="disclosure"><summary>humans\.txt<\/summary>[\s\S]*?<pre>\/\* TEAM \*\//);
  assert.doesNotMatch(s, /<dt>/, 'no file kv any more');
  const none = await draw(wellKnown, await runCase(wellKnown, WELL_KNOWN['nothing published']));
  assert.match(none, /<td>robots\.txt<\/td><td>missing<\/td>/);
  assert.match(none, /Sitemap<\/span><div class="stat-value">missing/);
  assert.doesNotMatch(none, /humans\.txt<\/summary>/);
  // ads.txt systems: every system, folded (no longer cut at 30)
  const ads = { ...out, data: { ...out.data, ads: { ...out.data.ads, systems: Array.from({ length: 40 }, (_, i) => ({ name: `ads${i}.test`, count: 1 })) } } };
  assert.match(await draw(wellKnown, ads), /<summary>32 more<\/summary>/);
  assert.deepEqual(heads(out), ['robots.txt 3 rules · 1 sitemaps · crawlers partial']);
  assert.deepEqual(heads(await runCase(wellKnown, WELL_KNOWN['nothing published'])), ['robots.txt missing']);
});

test('well-known render escapes file contents', async () => {
  const out = await runCase(wellKnown, WELL_KNOWN['everything published']);
  const odd = { ...out, data: { ...out.data, humans: '<script>x</script>', llms: { ...out.data.llms, title: '<b>t</b>' }, robots: { ...out.data.robots, sitemaps: ['javascript:alert(1)'] } } };
  const s = await draw(wellKnown, odd);
  assert.doesNotMatch(s, /<script>|<b>t|href="javascript/);
  assert.match(s, /&lt;script&gt;x&lt;\/script&gt;/);
});

test('whois render: age, expiry and registrar first; expired says so; raw WHOIS closed; headline reads on its own', async () => {
  const out = await runCase(whois, WHOIS['established and locked']);
  const s = await draw(whois, out);
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<dl'));
  assert.match(s, /Domain age<\/span><div class="stat-value">31\.2 years<\/div><span class="stat-note">registered 1995-08-14/);
  assert.match(s, /Expires in<\/span><div class="stat-value">3\.8 years<\/div><span class="stat-note">2030-08-13/);
  assert.match(s, /Registrar<\/span><div class="stat-value">Example Registrar, Inc\.<\/div><span class="stat-note">IANA #376/);
  assert.doesNotMatch(s, /<dt>(Registered|Expires|Registrar)<\/dt>/);
  assert.match(s, /<dt>Sources<\/dt><dd><ul class="plain"><li><a href="https:\/\/rdap\.org\/domain\/example\.com"/);
  assert.deepEqual(heads(out), ['Registered 1995-08-14 (31.2 years)']);
  const gone = await draw(whois, await runCase(whois, WHOIS.expired));
  assert.match(gone, /Expires in<\/span><div class="stat-value">expired<\/div>/);
  const raw = await draw(whois, await runCase(whois, WHOIS['port 43 fallback']));
  assert.match(raw, /<details class="disclosure"><summary>Raw WHOIS<\/summary>[\s\S]*?<pre class="json">Domain Name: UCSD\.EDU/);
});
