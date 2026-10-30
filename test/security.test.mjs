import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../extension/plugins/security.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';
import { h } from '../extension/ui/render.js';

const S = 'https://s.test/';
const LONG = `http://s.test/${'deep/'.repeat(120)}x.png?v=${'x'.repeat(100)}`;
const ODD = 'http://s.test/odd.png?q=<b>&r="1"';
const day = 86_400_000;
const iso = (days) => new Date(Date.now() + days * day).toISOString();

const entry = (url, { status = 200, type = 'other', headers = [], cookies = [], ...extra } = {}) => ({
  startedDateTime: new Date(1000).toISOString(), time: 10, _resourceType: type,
  request: { method: 'GET', url, headers: [] },
  response: { status, httpVersion: 'h2', headers, cookies, redirectURL: '', bodySize: 10, headersSize: 0, content: { mimeType: 'text/plain', size: 10 } },
  timings: {}, ...extra,
});

/** An HTTPS page with mixed content, weak cookies, third-party scripts without SRI and a soon-expiring second certificate. */
function sample({ mixed = [`http://s.test/a.png`, `http://s.test/b.css`] } = {}) {
  const entries = [
    entry(S, {
      type: 'document',
      headers: [{ name: 'server', value: 'nginx/1.25.3' }, { name: 'x-powered-by', value: 'PHP/8.2' }, { name: 'x-content-type-options', value: 'nosniff' }],
      cookies: [{ name: 'sessionid', secure: false, httpOnly: false, sameSite: 'None' }, { name: 'prefs', secure: true, httpOnly: true, sameSite: 'Lax' }],
    }),
    entry(`${S}api`, { cookies: [{ name: 'auth<b>', secure: false, httpOnly: false }] }),
    ...mixed.map((u, i) => entry(u, { type: 'image', status: i === 1 ? 0 : 200 })),
  ];
  const tls = {
    'https://s.test': { protocol: 'TLS 1.3', issuer: 'R11', cipher: 'AES_128_GCM', subjectName: 's.test', validFrom: iso(-30), validTo: iso(60), sctCount: 2, sanCount: 12, sanList: Array.from({ length: 12 }, (_, i) => `n${i}.s.test`) },
    'https://cdn.s.test': { protocol: 'TLS 1.3', issuer: 'R10', validFrom: iso(-80), validTo: iso(5), sanCount: 1, sanList: ['cdn.s.test'] },
  };
  const reading = createReading({ entries, tls, target: makeTarget(S, 'S', S) });
  reading.log._harplus.plugins.meta = { status: 'ok', data: { scripts: [{ src: 'https://cdn.other.test/lib.js' }, { src: 'https://cdn.other.test/sri.js', integrity: 'sha384-x' }, { src: `${S}own.js` }] } };
  return reading;
}

async function runIt(opts) {
  const reading = sample(opts);
  await runPlugins(reading, [plugin], {});
  const r = reading.log._harplus.plugins.security;
  assert.equal(r.status, 'ok', r.error);
  return r;
}
const byTitle = (r, re) => r.findings.find((f) => re.test(f.title));

test('places: mixed content with status and entry, scripts without SRI, weak cookies, an expiring certificate; evidence kept', async () => {
  const r = await runIt();
  const mixed = byTitle(r, /insecure \(http:\)/);
  assert.deepEqual(mixed.places, [{ url: 'http://s.test/a.png', status: 200, entry: 2 }, { url: 'http://s.test/b.css', status: 'ERR', entry: 3 }]);
  assert.equal(mixed.evidence, 'http://s.test/a.png\nhttp://s.test/b.css');

  const sri = byTitle(r, /Subresource Integrity/);
  assert.deepEqual(sri.places, [{ url: 'https://cdn.other.test/lib.js' }]);
  assert.equal(sri.evidence, 'https://cdn.other.test/lib.js');

  const insecure = byTitle(r, /without the Secure flag/);
  assert.deepEqual(insecure.places, [{ text: 'sessionid', url: S }, { text: 'auth<b>', url: `${S}api` }]);
  assert.equal(insecure.evidence, 'sessionid, auth<b>');
  assert.deepEqual(byTitle(r, /readable by JavaScript/).places, [{ text: 'sessionid', url: S }, { text: 'auth<b>', url: `${S}api` }]);
  assert.deepEqual(byTitle(r, /SameSite=None/).places, [{ text: 'sessionid', url: S }]);

  assert.deepEqual(byTitle(r, /Certificate for cdn\.s\.test/).places, [{ url: 'https://cdn.s.test' }]);

  const disclosed = byTitle(r, /disclose software versions/);
  assert.equal(disclosed.places, undefined, 'header lines are free text: evidence only');
  assert.equal(disclosed.evidence, 'Server: nginx/1.25.3\nx-powered-by: PHP/8.2');
  assert.equal(byTitle(r, /No Strict-Transport-Security/).places, undefined);
});

test('odd values: 12 mixed URLs are all places (evidence names 10); a very long URL is capped; "<" is escaped when drawn', async () => {
  const urls = [LONG, ODD, ...Array.from({ length: 10 }, (_, i) => `http://s.test/m${i}.png`)];
  const r = await runIt({ mixed: urls });
  const f = byTitle(r, /12 insecure/);
  assert.equal(f.places.length, 12);
  assert.equal(f.evidence.split('\n').length, 10);
  assert.equal(f.places[0].url, LONG.slice(0, 500));
  assert.equal(f.places[1].url, ODD);
  assert.equal(r.data.mixed.length, 12, 'data shape unchanged');
  const drawn = String(h.places(f.places));
  assert.match(drawn, /q=&lt;b&gt;&amp;r=&quot;1&quot;/);
  assert.doesNotMatch(drawn, /<b>&/);
  const cookies = String(h.places(byTitle(r, /without the Secure flag/).places));
  assert.match(cookies, /“<bdi>auth&lt;b&gt;<\/bdi>”/);
});

test('render: answer first, header values, no check marks, mixed content left to its finding, SANs folded', async () => {
  const r = await runIt();
  const s = String(plugin.render(r, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<h4>'), 'stats before any section');
  assert.match(s, /Security headers<\/span><div class="stat-value">1 of 7<\/div><span class="stat-note">passing/);
  assert.match(s, /Mixed content<\/span><div class="stat-value">2/);
  assert.match(s, /Disclosed versions<\/span><div class="stat-value">2/);
  assert.match(s, /Scripts without SRI<\/span><div class="stat-value">1/);
  assert.match(s, /<dt>X-Content-Type-Options<\/dt><dd>nosniff<\/dd>/);
  assert.match(s, /<dt>Referrer-Policy<\/dt><dd>missing<\/dd>/);
  assert.doesNotMatch(s, /class="check /, 'no glyph-only marks');
  assert.doesNotMatch(s, /a\.png/, 'mixed-content URLs are the finding\'s places');
  assert.doesNotMatch(s, /Disclosed versions<\/h4>/);
  assert.match(s, /<details class="disclosure"><summary>Subject alternative names<span class="disclosure-meta">12<\/span>/);
  assert.match(s, /<details class="disclosure fold"><summary>4 more<\/summary>/, 'the 12 names fold past 8');
  assert.match(s, /<span class="url-host">cdn\.s\.test<\/span>/, 'certificate origins as URL parts');
  assert.match(s, /<th scope="col">Secure<\/th>/);
  assert.match(s, /<td>sessionid<\/td><td>s\.test<\/td><td>no<\/td><td>no<\/td><td>None<\/td>/, 'flags as words');
  assert.doesNotMatch(s, /<dt>(Issuer|Protocol|Valid)<\/dt>/, 'issuer, protocol and validity are the glance\'s');
});

test('render: older readings without the optional lists still draw', () => {
  const s = String(plugin.render({ status: 'ok', data: { https: true, headers: [{ label: 'Referrer-Policy', ok: false }], cookies: [], certificates: [], disclosure: [] } }, h));
  assert.match(s, /Security headers<\/span><div class="stat-value">0 of 1/);
});

test('headlines: Transport and Security headers', async () => {
  const r = await runIt();
  const heads = r.summary.filter((x) => x.headline).map((x) => `${x.label} ${x.value}`);
  assert.deepEqual(heads, ['Transport HTTPS · no HSTS', 'Security headers 1/7 present']);
});

test('render: stats count every mixed subresource and script without SRI, not the 50 saved in data', async () => {
  const reading = sample({ mixed: Array.from({ length: 120 }, (_, i) => `http://s.test/m${i}.png`) });
  reading.log._harplus.plugins.meta.data.scripts = Array.from({ length: 60 }, (_, i) => ({ src: `https://cdn.other.test/s${i}.js` }));
  await runPlugins(reading, [plugin], {});
  const r = reading.log._harplus.plugins.security;
  assert.equal(r.data.mixed.length, 50);
  assert.equal(r.data.sriMissing.length, 50);
  assert.equal(r.data.mixedCount, 120);
  assert.equal(r.data.sriMissingCount, 60);
  assert.ok(r.findings.some((f) => f.title.startsWith('120 insecure')));
  const s = String(plugin.render(r, h));
  assert.match(s, /Mixed content<\/span><div class="stat-value">120/);
  assert.match(s, /Scripts without SRI<\/span><div class="stat-value">60/);
  const old = String(plugin.render({ status: 'ok', data: { ...r.data, mixedCount: undefined, sriMissingCount: undefined } }, h));
  assert.match(old, /Mixed content<\/span><div class="stat-value">50/, 'older readings fall back to the saved list');
});

test('render: a header that is present but failing says why', () => {
  const headers = [
    { label: 'Strict-Transport-Security', value: 'max-age=86400', ok: false },
    { label: 'Content-Security-Policy', value: "default-src 'self' (report-only)", ok: false },
    { label: 'X-Content-Type-Options', value: 'sniff-away', ok: false },
    { label: 'Referrer-Policy', value: 'no-referrer', ok: true },
    { label: 'Permissions-Policy', ok: false },
  ];
  const s = String(plugin.render({ status: 'ok', data: { https: true, headers, cookies: [], certificates: [] } }, h));
  assert.match(s, /<dd>max-age=86400 \(too short\)<\/dd>/);
  assert.match(s, /<dd>default-src &#39;self&#39; \(report-only\)<\/dd>|<dd>default-src 'self' \(report-only\)<\/dd>/);
  assert.match(s, /<dd>sniff-away \(not nosniff\)<\/dd>/);
  assert.match(s, /<dd>no-referrer<\/dd>/);
  assert.match(s, /<dt>Permissions-Policy<\/dt><dd>missing<\/dd>/);
  const http = String(plugin.render({ status: 'ok', data: { https: false, headers: [headers[0], { label: 'Strict-Transport-Security', value: 'n/a — page is HTTP', ok: false }], cookies: [], certificates: [] } }, h));
  assert.match(http, /max-age=86400 \(ignored over HTTP\)/);
  assert.match(http, /<dd>n\/a — page is HTTP<\/dd>/);
});
