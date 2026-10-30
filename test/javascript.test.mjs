import { test } from 'node:test';
import assert from 'node:assert/strict';
import js from '../extension/plugins/javascript.js';
import { h } from '../extension/ui/render.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';

const S = 'https://s.test/';
const script = (url, text = '', headers = []) => ({
  _resourceType: 'script', startedDateTime: '2026-10-30T00:00:00Z', time: 1,
  request: { method: 'GET', url, headers: [] },
  response: { status: 200, headers: [{ name: 'content-type', value: 'text/javascript' }, ...headers], content: { size: text.length, mimeType: 'text/javascript', text }, bodySize: text.length },
});
const unminified = (n) => Array.from({ length: n }, (_, i) => `var line${i} = ${i};`).join('\n');

/** Run the plugin over these scripts; the result is as the saved reading keeps it (through normalize). */
async function analyze(entries) {
  const reading = createReading({ entries, target: makeTarget(S, 'S', S) });
  await runPlugins(reading, [js], { phases: ['analyze'] });
  const r = reading.log._harplus.plugins.javascript;
  assert.equal(r.status, 'ok', r.error);
  return r;
}
const find = (r, re) => r.findings.find((f) => re.test(f.title));

const SITE = () => [
  script(`${S}app.js`, `${'x'.repeat(3000)}\n//# sourceMappingURL=app.js.map`),
  script(`${S}inline-map.js`, `${'y'.repeat(3000)}\n//# sourceMappingURL=data:application/json;base64,e30=`),
  script(`${S}big.js?v=1`, `eval("1"); new Function("x"); document.write("a"); document.write("b");\n${unminified(1500)}`),
  script('https://cdn.polyfill.io/v3/polyfill.min.js', 'eval("2")'),
];

test('places: compromised host, source maps, unminified, eval and document.write name their scripts; evidence unchanged', async () => {
  const r = await analyze(SITE());
  const cdn = find(r, /^Script loaded from cdn\.polyfill\.io$/);
  assert.equal(cdn.evidence, 'https://cdn.polyfill.io/v3/polyfill.min.js');
  assert.deepEqual(cdn.places, [{ url: 'https://cdn.polyfill.io/v3/polyfill.min.js' }]);
  const maps = find(r, /publish source maps/);
  assert.equal(maps.title, '2 scripts publish source maps');
  assert.equal(maps.evidence, `${S}app.js.map\ninline (data: URL)`);
  assert.deepEqual(maps.places, [{ url: `${S}app.js.map` }, { url: `${S}inline-map.js`, note: 'inline (data: URL)' }]);
  const big = find(r, /not minified/);
  assert.match(big.evidence, /^https:\/\/s\.test\/big\.js\?v=1 \(\d+(\.\d+)? KB\)$/);
  assert.deepEqual(big.places, [{ url: `${S}big.js?v=1`, note: big.evidence.match(/\((.+)\)$/)[1] }]);
  const ev = find(r, /^eval\(\)\/new Function used/);
  assert.equal(ev.title, 'eval()/new Function used 3 times');
  assert.equal(ev.detail, 'Requires unsafe-eval in a Content-Security-Policy.');
  assert.equal(ev.evidence, undefined);
  assert.deepEqual(ev.places, [{ url: `${S}big.js?v=1`, note: '×2' }, { url: 'https://cdn.polyfill.io/v3/polyfill.min.js', note: '×1' }]);
  const dw = find(r, /^document\.write in/);
  assert.equal(dw.evidence, `${S}big.js?v=1`);
  assert.deepEqual(dw.places, [{ url: `${S}big.js?v=1`, note: '×2' }]);
  for (const f of r.findings.filter((x) => /third-party|legacy/.test(x.title))) assert.equal(f.places, undefined, f.title);
});

test('odd values: 250 source maps give 200 places while the evidence names 10; a long URL is cut to 500; "<" is escaped when drawn', async () => {
  const long = `${S}${'p/'.repeat(300)}x.js`;
  const many = Array.from({ length: 250 }, (_, i) => script(`${S}m${i}.js`, `${'z'.repeat(10)}\n//# sourceMappingURL=m${i}.js.map`));
  const r = await analyze([script(long, 'document.write(1)'), script(`${S}q.js?a=<b>`, 'eval(1)'), ...many]);
  const maps = find(r, /publish source maps/);
  assert.equal(maps.title, '250 scripts publish source maps');
  assert.equal(maps.evidence.split('\n').length, 10);
  assert.equal(maps.places.length, 200);
  assert.equal(find(r, /document\.write/).places[0].url.length, 500);
  const drawn = String(h.places(find(r, /^eval/).places));
  assert.doesNotMatch(drawn, /<b>/);
  assert.match(drawn, /a=&lt;b&gt;/);
});

test('headline: Scripts reads on its own', async () => {
  const r = await analyze(SITE());
  const head = r.summary.filter((x) => x.headline);
  assert.equal(head.length, 1);
  assert.match(`${head[0].label} ${head[0].value}`, /^Scripts 4 files · \S+ \S+ \(\d+% third-party\)$/);
});

test('render: stats first; script URLs as parts; glance totals not repeated; API chips fold', async () => {
  const apis = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`api.X${i}`, [`${S}app.js`]]));
  const r = await analyze(SITE());
  const s = String(js.render({ ...r, data: { ...r.data, apis } }, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<table'), 'stats first');
  assert.match(s, /Minified<\/span><div class="stat-value">2 of 3<\/div><span class="stat-note">sizable scripts/);
  assert.match(s, /Source maps<\/span><div class="stat-value">2/);
  assert.match(s, /APIs referenced<\/span><div class="stat-value">10/);
  assert.match(s, /<dt>Build tooling<\/dt><dd>no bundler fingerprint/);
  assert.match(s, /<span class="url-host">s\.test<\/span><span class="url-path">\/big\.js<\/span><span class="url-query">\?v=1<\/span>/);
  assert.match(s, /<a href="https:\/\/s\.test\/app\.js\.map"[^>]*>map<\/a>/);
  assert.doesNotMatch(s, /Script bytes|First party/, 'the glance has the totals');
  assert.equal((s.match(/<span class="tag">api\.X\d<\/span>/g) || []).length, 10);
  assert.match(s, /<summary>2 more<\/summary>/);
});

test('render: a script URL that does not parse no longer throws', async () => {
  const r = await analyze(SITE());
  const data = { ...r.data, scripts: [...r.data.scripts, { ...r.data.scripts[0], url: 'not a url', host: '' }] };
  assert.match(String(js.render({ ...r, data }, h)), /<span class="url-path">not a url<\/span>/);
});
