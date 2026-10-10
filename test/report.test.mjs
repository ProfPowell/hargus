import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderReport, timeBuckets, PANES, findingsTable, standaloneDocument } from '../extension/ui/report.js';
import { getPlugins } from '../extension/plugins/index.js';

const FIXTURE = new URL('./fixtures/local-site.har', import.meta.url);
const load = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));

test('fixture reading renders every pane with no undefined/NaN', () => {
  const out = renderReport(load(), getPlugins());
  for (const id of PANES) assert.match(out, new RegExp(`<section class="pane" id="${id}"`), id);
  assert.doesNotMatch(out, /undefined|NaN|Infinity|\[object Object\]/);
  assert.match(out, /class="sidebar"/);
  assert.match(out, /Overall/);
  assert.match(out, /Fix these first/);
  assert.match(out, /id="findings-table"/);
  assert.match(out, /id="net-table"/);
});

test('old reading without area renders (Review Focus 1)', () => {
  const r = load();
  for (const p of Object.values(r.log._harplus.plugins)) delete p.area;
  const out = renderReport(r, getPlugins());
  const a11y = out.slice(out.indexOf('id="area-accessibility"'), out.indexOf('id="area-security"'));
  assert.match(a11y, /id="p-a11y-basics"/, 'a11y-basics panel lives on the Accessibility page');
  assert.doesNotMatch(out, /undefined/);
});

test('error and skipped results do not call glance (Review Focus 2)', () => {
  const r = load();
  r.log._harplus.plugins.network = { id: 'network', name: 'Network', status: 'error', error: 'boom', data: null, findings: [], summary: [] };
  r.log._harplus.plugins.vitals = { id: 'vitals', name: 'Web vitals', status: 'skipped', error: 'no page', data: null, findings: [], summary: [] };
  const out = renderReport(r, getPlugins());
  assert.match(out, /Error — boom/);
  assert.doesNotMatch(out, /chart failed/);
});

test('throwing glance is contained (Review Focus 3)', () => {
  const plugins = getPlugins().map((p) => (p.id === 'security' ? { ...p, glance: () => { throw new Error('bad data'); } } : p));
  const out = renderReport(load(), plugins);
  assert.match(out, /Security: chart failed — bad data/);
  assert.match(out, /id="area-infrastructure"/);
});

test('page strings are escaped (Review Focus 4)', () => {
  const r = load();
  r.log._harplus.target.title = '<script>alert(1)</script>';
  r.log._harplus.plugins.tech.data.technologies.push({ name: '"><img src=x onerror=alert(1)>', category: 'Evil' });
  r.log._harplus.plugins.security.findings.push({ severity: 'high', category: 'security', title: '<b>x</b>' });
  const out = renderReport(r, getPlugins());
  assert.doesNotMatch(out, /<script>alert|<img src=x|<b>x<\/b>/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('empty reading renders (Review Focus 5)', () => {
  const r = { log: { entries: [], pages: [], _harplus: { plugins: {}, target: {}, capture: {}, screenshots: [], capturedAt: '2026-10-09T00:00:00Z' } } };
  const out = renderReport(r, getPlugins());
  assert.doesNotMatch(out, /undefined|NaN|Infinity/);
  assert.match(out, /No areas measured yet/);
  assert.match(out, /No requests recorded/);
  assert.deepEqual(timeBuckets([]), []);
});

test('timeBuckets spreads request starts', () => {
  const e = (ms) => ({ startedDateTime: new Date(1_000_000 + ms).toISOString() });
  assert.deepEqual(timeBuckets([e(0), e(0), e(500), e(1000)], 4), [2, 0, 1, 1]);
});

test('non-interactive report has no notes form', () => {
  const out = renderReport(load(), getPlugins(), { interactive: false });
  assert.doesNotMatch(out, /<form id="notes-form"/);
  assert.match(findingsTable([]).toString(), /No findings match/);
});

test('standalone document: inlined css, no scripts, escaped title', () => {
  const r = load();
  r.log._harplus.target.title = '</title><script>x</script>';
  const doc = standaloneDocument(r, getPlugins(), { css: '.x{color:red}' });
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /<style>\.x\{color:red\}<\/style>/);
  assert.doesNotMatch(doc, /<script/i);
  assert.match(doc, /<title>&lt;\/title&gt;&lt;script&gt;x&lt;\/script&gt; — HAR-PLUS report<\/title>/);
  assert.match(doc, /class="reading standalone"/);
  assert.match(doc, /id="area-performance"/);
  assert.doesNotMatch(doc, /<form id="notes-form"/);
});

test('standalone document refuses a css payload that closes the style element', () => {
  const doc = standaloneDocument(load(), getPlugins(), { css: 'a{}</style><script>x</script>' });
  assert.doesNotMatch(doc, /<script>x/);
});
