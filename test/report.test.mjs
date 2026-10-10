import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderReport, timeBuckets, PANES, findingsTable, standaloneDocument, networkTable } from '../extension/ui/report.js';
import { getPlugins } from '../extension/plugins/index.js';
import { runPlugins } from '../extension/core/plugin-host.js';

const FIXTURE = new URL('./fixtures/local-site.har', import.meta.url);
const load = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));
// screenshot payloads are base64; strip them so a letter run like "NaN" in the data is not mistaken for a render bug
const noData = (s) => String(s).replace(/data:[^"')\s]+/g, 'data:');

test('fixture reading renders every pane with no undefined/NaN', () => {
  const out = renderReport(load(), getPlugins());
  for (const id of PANES) assert.match(out, new RegExp(`<section class="pane" id="${id}"`), id);
  assert.doesNotMatch(noData(out), /undefined|NaN|Infinity|\[object Object\]/);
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
  assert.doesNotMatch(noData(out), /undefined|NaN|Infinity/);
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
  assert.doesNotMatch(noData(out), /chart failed|Render failed|undefined|NaN/);
});

test('unparseable startedDateTime renders without NaN', () => {
  const r = load();
  r.log.entries[0].startedDateTime = 'garbage';
  const out = renderReport(r, getPlugins());
  assert.doesNotMatch(noData(out), /NaN/);
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
  assert.doesNotMatch(noData(out), /undefined|NaN/);
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

test('report shows the scoring profile and uses the settings profile', () => {
  const r = load();
  const out = renderReport(r, getPlugins(), { settings: { scoring: { profile: 'public' } } });
  assert.match(out, /Scored as Public sector \/ education/);
  const doc = standaloneDocument(r, getPlugins(), { settings: { scoring: { profile: 'commerce' } } });
  assert.match(doc, /Scored as Commerce/);
  assert.match(renderReport(r, getPlugins()), /Scored as General/);
});

const withA11yViews = () => {
  const r = withViews();
  const hp = r.log._harplus;
  const shot = (view) => ({ kind: 'viewport', view, mimeType: 'image/png', encoding: 'base64', data: PNG, cssWidth: view === 'reflow' ? 320 : 1280, cssHeight: 800, dpr: 1 });
  for (const v of ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred', 'lowcontrast', 'dark', 'forced', 'morecontrast', 'print', 'spacing', 'reflow', 'text200']) hp.screenshots.push(shot(v));
  const m = { text: 1000, links: 20, clipped: 2, overflowX: 0, bodyFont: 16, bg: 1, fixed: [], chrome: true, forcedNone: 0, iconOnly: 0 };
  Object.assign(hp.capture.views, {
    dark: { ...m, bg: 0.04 }, forced: { ...m }, morecontrast: { ...m }, print: { ...m, chrome: false, fixed: [{ tag: 'div', w: 1280, h: 120 }] },
    spacing: { ...m, clipped: 6 }, reflow: { ...m, overflowX: 40 }, text200: { ...m, bodyFont: 32 },
  });
  hp.capture.views.desktop = { ...hp.capture.views.desktop, ...m };
  return r;
};

test('screens pane: accessibility views section with vision grid and measured rows', () => {
  const s = screens(renderReport(withA11yViews(), getPlugins()));
  assert.match(s, /<h2>Accessibility views<\/h2>/);
  assert.match(s, /<h3>Vision<\/h3>/);
  for (const label of ['Protanopia', 'Deuteranopia', 'Tritanopia', 'Achromatopsia', 'Blurred vision', 'Reduced contrast']) assert.match(s, new RegExp(`<b>${label}</b>`));
  assert.match(s, /<h3>Display and WCAG<\/h3>/);
  assert.match(s, /<b>320 px reflow<\/b>[\s\S]*?40 px overflow/);
  assert.match(s, /<b>200% text<\/b>[\s\S]*?16 → 32 px/);
  assert.match(s, /<b>Text spacing<\/b>[\s\S]*?\+4 clipped/);
  assert.match(s, /<b>Dark mode<\/b>[\s\S]*?changes/);
  assert.match(s, /<b>Print<\/b>[\s\S]*?1 overlay/);
  assert.doesNotMatch(s, /undefined|NaN/);
});

/** The chips in one view's figcaption, as "rating:text" pairs. */
const chipsOf = (s, label) => {
  const cap = s.slice(s.indexOf(`<b>${label}</b>`), s.indexOf('</figcaption>', s.indexOf(`<b>${label}</b>`)));
  return [...cap.matchAll(/rating-([a-z-]+)">(?:<svg[\s\S]*?<\/svg>)?([^<]*)</g)].map((m) => `${m[1]}:${m[2]}`);
};
const setA11y = (r, checks) => {
  const p = r.log._harplus.plugins;
  if (checks) p['a11y-views'] = { status: 'ok', data: { checks: Object.entries(checks).map(([id, ok]) => ({ id, ok })) }, findings: [], summary: [] };
  else delete p['a11y-views'];
  return r;
};

test('screens pane: accessibility chips take their rating from the a11y-views plugin', () => {
  const r = withA11yViews();
  Object.assign(r.log._harplus.capture.views, { reflow: { ...r.log._harplus.capture.views.reflow, overflowX: 0, clipped: 7 }, spacing: { ...r.log._harplus.capture.views.spacing, clipped: 4 } });
  const s = screens(renderReport(setA11y(r, { reflow: false, spacing: true, text200: true, dark: true, forced: true, morecontrast: true, print: true }), getPlugins()));
  assert.deepEqual(chipsOf(s, '320 px reflow'), ['poor:+5 clipped'], 'not "fits" when the plugin says it clips');
  assert.deepEqual(chipsOf(s, 'Text spacing'), ['good:+2 clipped']);
  assert.deepEqual(chipsOf(s, '200% text'), ['good:16 → 32 px']);
  assert.deepEqual(chipsOf(s, 'Forced colours'), ['good:clean']);
  assert.deepEqual(chipsOf(s, 'More contrast'), ['good:clean']);
  const bad = screens(renderReport(setA11y(withA11yViews(), { reflow: true, text200: false, dark: false, forced: false, morecontrast: false, print: false }), getPlugins()));
  assert.deepEqual(chipsOf(bad, 'More contrast'), ['poor:no contrast styles']);
  assert.deepEqual(chipsOf(bad, '200% text'), ['poor:16 → 32 px']);
});

test('screens pane: accessibility chips fall back to the plugin thresholds without a plugin result', () => {
  const r = setA11y(withA11yViews());
  const v = r.log._harplus.capture.views;
  r.log._harplus.capture.prefs = { mediaPrint: true, mediaFeatures: { 'prefers-contrast': 1 } };
  Object.assign(v, { spacing: { ...v.spacing, clipped: 4 }, reflow: { ...v.reflow, overflowX: 0, clipped: 7 }, print: { ...v.print, fixed: [] } });
  const s = screens(renderReport(r, getPlugins()));
  assert.deepEqual(chipsOf(s, 'Text spacing'), ['good:+2 clipped'], 'below 3 extra clipped boxes');
  assert.deepEqual(chipsOf(s, '320 px reflow'), ['poor:+5 clipped']);
  assert.deepEqual(chipsOf(s, 'Forced colours'), ['good:clean']);
  assert.deepEqual(chipsOf(s, 'More contrast'), ['good:clean']);
  assert.deepEqual(chipsOf(s, 'Print'), ['good:clean']);
  // Base-relative reflow: the base already overflows as much.
  Object.assign(v, { desktop: { ...v.desktop, overflowX: 200 }, reflow: { ...v.reflow, overflowX: 200, clipped: 2 } });
  assert.deepEqual(chipsOf(screens(renderReport(r, getPlugins())), '320 px reflow'), ['good:fits']);
  Object.assign(v, { reflow: { ...v.reflow, overflowX: 240 } });
  assert.deepEqual(chipsOf(screens(renderReport(r, getPlugins())), '320 px reflow'), ['poor:40 px overflow']);
});

test('screens pane: dark chip says already dark for a dark page', () => {
  const r = setA11y(withA11yViews());
  const v = r.log._harplus.capture.views;
  Object.assign(v, { desktop: { ...v.desktop, bg: 0.05 }, dark: { ...v.dark, bg: 0.05 } });
  assert.deepEqual(chipsOf(screens(renderReport(r, getPlugins())), 'Dark mode'), ['good:already dark']);
  assert.deepEqual(chipsOf(screens(renderReport(setA11y(r, { dark: true }), getPlugins())), 'Dark mode'), ['good:already dark']);
  Object.assign(v, { desktop: { ...v.desktop, bg: 1 }, dark: { ...v.dark, bg: 0.98 } });
  assert.deepEqual(chipsOf(screens(renderReport(setA11y(r), getPlugins())), 'Dark mode'), ['poor:no change']);
});

test('screens pane: no accessibility section for readings without those views', () => {
  assert.doesNotMatch(screens(renderReport(withViews(), getPlugins())), /Accessibility views/);
});

test('screens pane: Breakpoints section with edge shots and overflow chips', () => {
  const r = withViews();
  const hp = r.log._harplus;
  for (const v of ['bp900-below', 'bp900-at']) hp.screenshots.push({ kind: 'viewport', view: v, mimeType: 'image/png', encoding: 'base64', data: PNG, cssWidth: v.endsWith('below') ? 899 : 900, cssHeight: 800, dpr: 1 });
  hp.capture.views['bp900-below'] = { overflowX: 20, clipped: 0, overflowers: [{ selector: 'div.edge', width: 920, over: 20 }] };
  hp.capture.views['bp900-at'] = { overflowX: 0, clipped: 0 };
  hp.capture.breakpoints = [900];
  const s = screens(renderReport(r, getPlugins()));
  assert.match(s, /<h2>Breakpoints<\/h2>/);
  assert.match(s, /<b>899 px<\/b>[\s\S]*?div\.edge/);
  assert.match(s, /<b>900 px<\/b>[\s\S]*?fits/);
  assert.doesNotMatch(screens(renderReport(withViews(), getPlugins())), /<h2>Breakpoints<\/h2>/);
});
