import { test } from 'node:test';
import assert from 'node:assert/strict';
import tech from '../extension/plugins/tech.js';
import { h } from '../extension/ui/render.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';

const S = 'https://s.test/';
const entry = (url, type = 'script') => ({
  _resourceType: type, startedDateTime: '2026-10-30T00:00:00Z', time: 1,
  request: { method: 'GET', url, headers: [], cookies: [] },
  response: { status: 200, headers: [], cookies: [], content: { size: 0, mimeType: 'text/javascript' } },
});

async function analyze() {
  const reading = createReading({
    entries: [entry(S, 'document'), entry(`${S}js/jquery-3.4.1.min.js`), entry('https://static.hotjar.com/c/hotjar-1.js?sv=6'), entry('https://www.clarity.ms/tag/abc')],
    target: makeTarget(S, 'S', S),
  });
  reading.log._harplus.probes = { tech: { globals: {}, dom: {}, meta: {}, scripts: [], customElements: ['x-a', 'x-b'], serviceWorker: false, errors: [] } };
  await runPlugins(reading, [tech], { phases: ['analyze'], settings: { plugins: { tech: { options: { fingerprintDb: false } } } } });
  const r = reading.log._harplus.plugins.tech;
  assert.equal(r.status, 'ok', r.error);
  return r;
}

test('findings: names stay evidence, no places; data keeps the fields Built with reads', async () => {
  const r = await analyze();
  const trackers = r.findings.find((f) => /advertising \/ session-replay vendors/.test(f.title));
  assert.equal(trackers.title, '2 advertising / session-replay vendors');
  assert.equal(trackers.detail, 'Hotjar, Microsoft Clarity');
  assert.ok(r.findings.some((f) => /jQuery below 3\.5\.0/.test(f.title)));
  for (const f of r.findings.filter((x) => x.severity !== 'info')) assert.ok(f.id, `no rule id: ${f.title}`);
  for (const f of r.findings) assert.equal(f.places, undefined, f.title);
  const jq = r.data.technologies.find((t) => t.name === 'jQuery');
  assert.deepEqual(Object.keys(jq).sort(), ['category', 'evidence', 'name', 'version']);
  assert.equal(jq.version, '3.4.1');
});

test('glance: the first 8 technologies as chips by category, the rest under "+N more"', () => {
  const technologies = Array.from({ length: 11 }, (_, i) => ({ name: `T${i}`, category: i < 6 ? 'CMS' : 'CDN' }));
  const s = String(tech.glance({ status: 'ok', data: { technologies } }, h));
  assert.match(s, /<h4>Technology stack · 11<\/h4>/);
  const [open, folded] = s.split('<details');
  assert.equal((open.match(/<li class="badge">/g) || []).length, 8);
  assert.equal((folded.match(/<li class="badge">/g) || []).length, 3);
  assert.match(folded, /^ class="disclosure"><summary>\+3 more<\/summary>/);
  assert.match(folded, /<h4>CDN<\/h4>/);
  assert.doesNotMatch(s, /class="badge more"/, 'no dead-end "+N" chip');
  const few = String(tech.glance({ status: 'ok', data: { technologies: technologies.slice(0, 8) } }, h));
  assert.doesNotMatch(few, /<details/);
  assert.equal(String(tech.glance({ status: 'ok', data: { technologies: [] } }, h)), '');
});

test('render: stats first; request and script URLs in evidence as parts; custom element names left to HTML composition', async () => {
  const r = await analyze();
  const data = { ...r.data, technologies: [...r.data.technologies, { name: 'Cut', category: 'CDN', evidence: [`request https://cdn.test/${'a'.repeat(80)}…`, 'script https://x.test/s.js?q=<b>'] }] };
  const s = String(tech.render({ ...r, data }, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<table'), 'stats first');
  assert.match(s, /Technologies<\/span><div class="stat-value">\d+/);
  assert.match(s, /Ad and replay vendors<\/span><div class="stat-value">2/);
  assert.match(s, /request <span class="url" title="https:\/\/static\.hotjar\.com\/c\/hotjar-1\.js\?sv=6"><span class="url-host">static\.hotjar\.com<\/span>/);
  assert.match(s, /<span class="url-path">\/a{80}<\/span><\/span>…/, 'the cut mark sits outside the parts, not percent-encoded');
  assert.match(s, /script <span class="url"[^>]*><span class="url-host">x\.test<\/span><span class="url-path">\/s\.js<\/span><span class="url-query">\?q=%3Cb%3E<\/span>/);
  assert.doesNotMatch(s, /<b>/);
  assert.doesNotMatch(s, /x-a, x-b/, 'tag names are HTML composition\'s');
  assert.match(s, /Custom elements[^]*?2 tags/);
});
