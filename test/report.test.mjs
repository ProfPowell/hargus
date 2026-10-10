import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderReport, timeBuckets, PANES, findingsTable, standaloneDocument, networkTable } from '../extension/ui/report.js';
import { getPlugins } from '../extension/plugins/index.js';
import { runPlugins } from '../extension/core/plugin-host.js';

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
  assert.doesNotMatch(out, /Enable plugins/);
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

test('offline plugin run renders cleanly with an area on every result', async () => {
  const r = load();
  r.log._harplus.plugins = {}; // drop stored results; the fixture predates `area`
  await runPlugins(r, getPlugins(), { phases: ['analyze'], settings: { phases: { enrich: false }, plugins: { tech: { options: { fingerprintDb: false } } } } });
  for (const [id, res] of Object.entries(r.log._harplus.plugins)) assert.ok(res.area, `${id} has area`);
  const out = renderReport(r, getPlugins());
  assert.doesNotMatch(out, /chart failed|Render failed|undefined|NaN/);
});

test('unparseable startedDateTime renders without NaN', () => {
  const r = load();
  r.log.entries[0].startedDateTime = 'garbage';
  const out = renderReport(r, getPlugins());
  assert.doesNotMatch(out, /NaN/);
  assert.doesNotMatch(networkTable(r, r.log.entries.map((e, i) => ({ e, i }))).toString(), /NaN/);
});

const PNG = 'iVBORw0KGgo=';
const withViews = () => {
  const r = load();
  const hp = r.log._harplus;
  hp.capture.device = 'desktop';
  const shot = (view, kind, cssWidth, cssHeight) => ({ kind, view, mimeType: 'image/png', encoding: 'base64', data: PNG, cssWidth, cssHeight, dpr: 1 });
  hp.screenshots = [
    shot('desktop', 'viewport', 1280, 800), { kind: 'thumbnail', mimeType: 'image/png', data: PNG }, shot('desktop', 'fullpage', 1280, 4000),
    shot('tablet', 'viewport', 820, 1180), shot('tablet', 'fullpage', 820, 5200),
    shot('mobile', 'viewport', 390, 844), shot('mobile', 'fullpage', 390, 9000),
    shot('nojs', 'viewport', 1280, 800), shot('nocss', 'viewport', 1280, 800), shot('noimages', 'viewport', 1280, 800),
  ];
  hp.capture.views = {
    desktop: { text: 1000, links: 20, images: 10, imagesWithAlt: 8, cssWidth: 1280, cssHeight: 4000 },
    nojs: { text: 40, links: 2, images: 10, imagesWithAlt: 8, cssWidth: 1280, cssHeight: 900 },
    nocss: { text: 1400, links: 20, images: 10, imagesWithAlt: 8, cssWidth: 1280, cssHeight: 9000 },
    noimages: { text: 1000, links: 20, images: 10, imagesWithAlt: 8, cssWidth: 1280, cssHeight: 3900 },
  };
  return r;
};
const screens = (out) => out.slice(out.indexOf('id="screens"'), out.indexOf('id="notes"'));

test('screens pane: device line-up at relative scale and resilience grid with chips', () => {
  const s = screens(renderReport(withViews(), getPlugins()));
  assert.match(s, /<h2>Devices<\/h2>/);
  assert.match(s, /<h2>Resilience<\/h2>/);
  assert.match(s, /flex:0 1 51\.41%/, 'desktop share of 1280+820+390');
  assert.match(s, /flex:0 1 15\.66%/, 'phone share');
  assert.match(s, /<b>Phone<\/b> · 390×844/);
  assert.match(s, /<b>As designed<\/b>/);
  assert.match(s, /rating-poor[^>]*>[\s\S]*?4% of text/);
  assert.match(s, /140% of text/);
  assert.match(s, /8 of 10 images have alt text/);
  assert.match(s, /type="radio" name="devices-shot" value="fold" checked/);
  assert.match(s, /type="radio" name="resilience-shot" value="full"/);
  assert.match(s, /data-zoom="6"/, 'phone full page zooms to screenshot index 6');
});

test('screens pane: chip text is escaped', () => {
  const r = withViews();
  r.log._harplus.capture.views.noimages.imagesWithAlt = '<b>x';
  const s = screens(renderReport(r, getPlugins()));
  assert.match(s, /&lt;b&gt;x/);
  assert.doesNotMatch(s, /<b>x/);
});

test('screens pane: partial views', () => {
  const r = withViews();
  r.log._harplus.screenshots = r.log._harplus.screenshots.filter((s) => !['tablet', 'nocss'].includes(s.view));
  const s = screens(renderReport(r, getPlugins()));
  assert.doesNotMatch(s, /<b>Tablet<\/b>/);
  assert.doesNotMatch(s, /<b>No CSS<\/b>/);
  assert.match(s, /<b>No JavaScript<\/b>/);
});

test('screens pane: old reading without views shows the base device only', () => {
  const r = load();
  r.log._harplus.screenshots = [
    { kind: 'viewport', mimeType: 'image/png', encoding: 'base64', data: PNG, cssWidth: 1280, cssHeight: 800, dpr: 1 },
    { kind: 'thumbnail', mimeType: 'image/png', data: PNG },
    { kind: 'fullpage', mimeType: 'image/png', encoding: 'base64', data: PNG, cssWidth: 1280, cssHeight: 4000, dpr: 1 },
  ];
  const s = screens(renderReport(r, getPlugins()));
  assert.match(s, /<h2>Devices<\/h2>/);
  assert.match(s, /<b>Desktop<\/b> · 1280×800/);
  assert.doesNotMatch(s, /<h2>Resilience<\/h2>/);
  assert.doesNotMatch(s, /undefined|NaN/);
});

test('hero uses the base viewport by index; thumbnail-only reading falls back', () => {
  const r = withViews();
  r.log._harplus.screenshots.unshift({ kind: 'viewport', view: 'nojs', mimeType: 'image/png', data: PNG, cssWidth: 1280, cssHeight: 800 });
  const out = renderReport(r, getPlugins());
  const hero = out.slice(out.indexOf('class="card hero"'), out.indexOf('class="hero-text"'));
  assert.match(hero, /data-zoom="1"/, 'skips the leading nojs viewport');
  const lite = load();
  lite.log._harplus.screenshots = [{ kind: 'thumbnail', mimeType: 'image/png', data: PNG }];
  const out2 = renderReport(lite, getPlugins());
  assert.match(out2.slice(out2.indexOf('class="card hero"'), out2.indexOf('class="hero-text"')), /data-zoom="0"/);
  assert.match(screens(out2), /No screenshots in this reading/);
});

test('report has eight area panes and sidebar links', () => {
  const out = renderReport(load(), getPlugins());
  for (const id of ['international', 'sustainability', 'content', 'build']) {
    assert.match(out, new RegExp(`id="area-${id}"`));
    assert.match(out, new RegExp(`href="#area-${id}"`));
  }
  assert.doesNotMatch(out, /undefined|NaN/);
});

test('screens: international section with chips', () => {
  const r = withViews();
  const hp = r.log._harplus;
  hp.screenshots.push(
    { kind: 'viewport', view: 'rtl', mimeType: 'image/png', data: PNG, cssWidth: 1280, cssHeight: 800 },
    { kind: 'viewport', view: 'pseudo', mimeType: 'image/png', data: PNG, cssWidth: 1280, cssHeight: 800 },
  );
  hp.capture.views.desktop = { ...hp.capture.views.desktop, overflowX: 0, clipped: 1 };
  hp.capture.views.rtl = { ...hp.capture.views.desktop, overflowX: 30 };
  hp.capture.views.pseudo = { ...hp.capture.views.desktop, clipped: 5, overflowX: 0 };
  const s = screens(renderReport(r, getPlugins()));
  assert.match(s, /<h2>International<\/h2>/);
  assert.match(s, /name="international-shot"/);
  assert.match(s, /<b>Right-to-left<\/b>/);
  assert.match(s, /rating-poor[^>]*>[\s\S]*?scrolls sideways/);
  assert.match(s, /rating-poor[^>]*>[\s\S]*?\+4 clipped/);
});

test('screens: international section absent for old readings', () => {
  assert.doesNotMatch(screens(renderReport(withViews(), getPlugins())), /<h2>International<\/h2>/);
});

test('screens: no long-text chip when the base view was not measured', () => {
  const r = withViews();
  const hp = r.log._harplus;
  hp.screenshots.push({ kind: 'viewport', view: 'pseudo', mimeType: 'image/png', data: PNG, cssWidth: 1280, cssHeight: 800 });
  hp.capture.views.pseudo = { clipped: 5, overflowX: 0 };
  delete hp.capture.views.desktop;
  const s = screens(renderReport(r, getPlugins()));
  assert.match(s, /<b>Long text<\/b>/);
  assert.doesNotMatch(s, /clipped/);
});
