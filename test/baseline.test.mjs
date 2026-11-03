import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import baseline from '../extension/plugins/baseline.js';
import { h } from '../extension/ui/render.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';
import { mockFetch } from './helpers.mjs';

const S = 'https://s.test/';
const WF = readFileSync(new URL('./fixtures/web-features-subset.json', import.meta.url), 'utf8');

async function analyze() {
  const reading = createReading({ entries: [], target: makeTarget(S, 'S', S) });
  const hp = reading.log._harplus;
  hp.plugins.css = { id: 'css', status: 'ok', data: {
    usage: { properties: { display: 3, 'anchor-name': 1 }, values: { display: ['grid'] }, functions: { 'light-dark': 1 }, units: {}, pseudoClasses: { has: 1 }, pseudoElements: {} },
    atRules: { container: 1 }, mediaFeatures: {}, stats: { nested: 0 },
  } };
  hp.plugins.javascript = { id: 'javascript', status: 'ok', data: { apis: { 'api.IntersectionObserver': [`${S}a.js`] } } };
  await runPlugins(reading, [baseline], { phases: ['analyze'], fetch: mockFetch([[/web-features/, { body: WF }]]) });
  const r = hp.plugins.baseline;
  assert.equal(r.status, 'ok', r.error);
  return r;
}

test('findings: feature lists stay evidence (names, not locations); no places', async () => {
  const r = await analyze();
  assert.ok(r.findings.length, 'the subset yields at least one finding');
  for (const f of r.findings) {
    assert.equal(f.places, undefined, f.title);
    assert.match(f.evidence, /^.+ \((css|html|http|since [\d-]+)[^)]*\)(\n.+ \(.+\))*$/);
  }
});

test('render: stats first count what the findings count; limited and newly open; widely closed and not folded twice', async () => {
  const r0 = await analyze();
  const extra = Array.from({ length: 9 }, (_, i) => ({ id: `w${i}`, name: `W${i}`, baseline: 'widely', since: '2020-01-01', group: '', sources: ['css'], keys: [`css.properties.w${i}`] }));
  const r = { ...r0, data: { ...r0.data, features: [...r0.data.features, ...extra] } };
  const widely = r.data.features.filter((x) => x.baseline === 'widely');
  const s = String(baseline.render(r, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<table'), 'stats first');
  // The fixture's CSS uses anchor-name: Anchor positioning is limited and used (not only referenced).
  const limited = r.findings.find((x) => /limited browser availability/.test(x.title));
  assert.ok(limited, 'the fixture has a limited feature in use');
  assert.match(limited.evidence, /^Anchor positioning \(css\)$/m);
  const n = limited.title.match(/^(\d+) /)[1];
  assert.ok(Number(n) >= 1);
  assert.match(s, new RegExp(`Limited, in use</span><div class="stat-value">${n}<`));
  assert.match(s, /Referenced in scripts only<\/span><div class="stat-value">1</);
  assert.ok(widely.length > 8, 'enough widely features to fold');
  assert.match(s, new RegExp(`<details class="disclosure"><summary>Widely available<span class="disclosure-meta">${widely.length} features</span>`));
  const inside = s.slice(s.indexOf('<summary>Widely available'));
  assert.doesNotMatch(inside, /<summary>\d+ more<\/summary>/, 'one fold, not two');
  assert.match(s, /Baseline data: <a href="https:\/\/cdn\.jsdelivr\.net\/npm\/web-features@3\/data\.json"[^>]*><span class="url"/);
});

test('headline: Features detected reads on its own', async () => {
  const head = (await analyze()).summary.filter((x) => x.headline);
  assert.equal(head.length, 1);
  assert.match(`${head[0].label} ${head[0].value}`, /^Features detected \d+ \(\d+ widely · \d+ newly · \d+ limited\)$/);
});

test('rule ids: limited-availability and newly-available (info)', async () => {
  const r = await analyze();
  for (const f of r.findings) assert.ok(['limited-availability', 'newly-available'].includes(f.id), f.id);
});
