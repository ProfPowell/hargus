import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderReport, timeBuckets, PANES, findingsTable, standaloneDocument, networkTable, requestDetail, NET_PAGE } from '../extension/ui/report.js';
import { parseRgb, composite, wcagRatio } from '../extension/core/color.js';
import { lcpPath } from '../extension/ui/waterfall.js';
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
  assert.match(doc, /<title>&lt;\/title&gt;&lt;script&gt;x&lt;\/script&gt; — HARgus report<\/title>/);
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

const addTranslated = (r, specs, translation) => {
  const hp = r.log._harplus;
  for (const id of Object.keys(specs)) hp.screenshots.push({ kind: 'viewport', view: id, mimeType: 'image/png', data: PNG, cssWidth: 1280, cssHeight: 800 });
  hp.capture.views.desktop = { ...hp.capture.views.desktop, overflowX: 0, clipped: 1 };
  Object.assign(hp.capture.views, specs);
  hp.capture.translation = translation;
};

test('screens: translated views show chips; Arabic compares with right-to-left; no Long text without pseudo', () => {
  const r = withViews();
  const d = { overflowX: 0, clipped: 1 };
  const ok = { status: 'ok' };
  addTranslated(r, {
    rtl: { ...d, clipped: 5 }, 'translated-de': { ...d, clipped: 1 }, 'translated-ar': { ...d, clipped: 6 }, 'translated-ja': { ...d, clipped: 6 },
  }, { 'translated-de': ok, 'translated-ar': ok, 'translated-ja': ok });
  const s = screens(renderReport(r, getPlugins()));
  assert.match(s, /<b>German<\/b>[\s\S]*?fits/);
  assert.match(s, /<b>Arabic<\/b>[\s\S]*?\+1 clipped/);
  assert.match(s, /<b>Japanese<\/b>[\s\S]*?\+5 clipped/);
  assert.doesNotMatch(s, /Long text/);
});

test('screens: a failed translated view says it could not be verified; Long text shows when pseudo exists', () => {
  const r = withViews();
  const d = { overflowX: 0, clipped: 1 };
  addTranslated(r, { 'translated-de': { ...d, clipped: 9 }, pseudo: { ...d, clipped: 3 } }, { 'translated-de': { status: 'failed', reason: 'x' } });
  const s = screens(renderReport(r, getPlugins()));
  assert.match(s, /couldn(&#39;|')t be verified/);
  assert.doesNotMatch(s, /<b>German<\/b>[^]*?\+8 clipped/);
  assert.match(s, /<b>Long text<\/b>/);
});

test('screens: a truncated walk is not counted as extra clipping in the international chips', () => {
  const r = withViews();
  const d = { overflowX: 0, clipped: 1 };
  addTranslated(r, { 'translated-de': { ...d, clipped: 9, truncated: true } }, { 'translated-de': { status: 'ok' } });
  const s = screens(renderReport(r, getPlugins()));
  assert.match(s, /<b>German<\/b>[\s\S]*?fits/);
  assert.doesNotMatch(s, /\+8 clipped/);
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

test('screens pane: chips follow the plugin on scrollsX (stale width is not overflow; sideways-only 200% is not green)', () => {
  const r = withA11yViews();
  const v = r.log._harplus.capture.views;
  Object.assign(v, { reflow: { ...v.reflow, overflowX: 408, scrollsX: false }, text200: { ...v.text200, overflowX: 30, scrollsX: true } });
  const checks = { reflow: true, spacing: true, text200: true, dark: true, forced: true, morecontrast: true, print: true };
  for (const withPlugin of [true, false]) {
    const s = screens(renderReport(setA11y(r, withPlugin ? checks : null), getPlugins()));
    assert.deepEqual(chipsOf(s, '320 px reflow'), ['good:fits'], 'no overflow text when the page could not scroll sideways');
    assert.deepEqual(chipsOf(s, '200% text'), ['needs-improvement:16 → 32 px']);
  }
  v.text200.scrollsX = false;
  assert.deepEqual(chipsOf(screens(renderReport(setA11y(r, checks), getPlugins())), '200% text'), ['good:16 → 32 px']);
});

test('screens pane: scroll-only text spacing is amber, like 200% text; older readings without scrollsX unchanged', () => {
  const r = withA11yViews();
  const v = r.log._harplus.capture.views;
  Object.assign(v, { spacing: { ...v.spacing, clipped: 2, overflowX: 30, scrollsX: true } });
  const checks = { reflow: true, spacing: true, text200: true, dark: true, forced: true, morecontrast: true, print: true };
  for (const withPlugin of [true, false]) {
    assert.deepEqual(chipsOf(screens(renderReport(setA11y(r, withPlugin ? checks : null), getPlugins())), 'Text spacing'), ['needs-improvement:+0 clipped'], `plugin: ${withPlugin}`);
  }
  v.spacing.overflowX = 5; // below the 8 px floor
  assert.deepEqual(chipsOf(screens(renderReport(setA11y(r, checks), getPlugins())), 'Text spacing'), ['good:+0 clipped']);
  v.spacing = { ...v.spacing, overflowX: 30, scrollsX: false };
  assert.deepEqual(chipsOf(screens(renderReport(setA11y(r, checks), getPlugins())), 'Text spacing'), ['good:+0 clipped']);
  delete v.spacing.scrollsX; // an older reading: today's behaviour
  assert.deepEqual(chipsOf(screens(renderReport(setA11y(r, checks), getPlugins())), 'Text spacing'), ['good:+0 clipped']);
  assert.deepEqual(chipsOf(screens(renderReport(setA11y(r, null), getPlugins())), 'Text spacing'), ['poor:+0 clipped']);
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

test('screens pane: breakpoint chips use the effective overflow and show extra clipping', () => {
  const r = withViews();
  const hp = r.log._harplus;
  for (const v of ['bp900-below', 'bp900-at']) hp.screenshots.push({ kind: 'viewport', view: v, mimeType: 'image/png', encoding: 'base64', data: PNG, cssWidth: v.endsWith('below') ? 899 : 900, cssHeight: 800, dpr: 1 });
  hp.capture.views['bp900-below'] = { overflowX: 20, rootClipX: true, clipped: 0, overflowers: [{ selector: 'div.edge', width: 920, over: 20 }] };
  hp.capture.views['bp900-at'] = { overflowX: 0, clipped: 5 };
  hp.capture.breakpoints = [900];
  const s = screens(renderReport(r, getPlugins()));
  assert.deepEqual(chipsOf(s, '899 px'), ['good:fits'], 'the root clips overflow-x: nothing scrolls sideways');
  assert.deepEqual(chipsOf(s, '900 px'), ['needs-improvement:+5 clipped']);
  hp.capture.views['bp900-at'].truncated = true;
  assert.deepEqual(chipsOf(screens(renderReport(r, getPlugins())), '900 px'), ['good:fits'], 'truncated walk: no clip comparison');
});

test('interstitial reading shows the bot-check banner; normal reading does not', async () => {
  const { detectInterstitial } = await import('../extension/core/interstitial.js');
  const normal = load();
  assert.equal(detectInterstitial(normal), null);
  assert.doesNotMatch(renderReport(normal, getPlugins()), /bot check or waiting page/);
  const gate = load();
  gate.log.entries.push({ ...gate.log.entries[0], request: { ...gate.log.entries[0].request, url: 'https://www.example.com/home/botfailoveroriginal_files/spin.min.js' } });
  const out = renderReport(gate, getPlugins());
  assert.match(out, /class="card alert"/);
  assert.match(out, /This looks like a bot check or waiting page \(Akamai\), not the real page\./);
});

test('interstitial banner escapes the page title (Review Focus 3)', () => {
  const r = load();
  r.log._harplus.target.title = 'Just a moment <img src=x onerror=alert(1)>';
  r.log._harplus.plugins.content = { ...(r.log._harplus.plugins.content || {}), status: 'ok', data: { ...(r.log._harplus.plugins.content?.data || {}), reading: { ...(r.log._harplus.plugins.content?.data?.reading || {}), words: 20 } } };
  const out = renderReport(r, getPlugins());
  assert.match(out, /class="card alert"/);
  assert.doesNotMatch(out, /<img src=x onerror/);
});

test('screens pane: a failed view self-check adds a note, once, and passing checks add none', () => {
  const r = withViews();
  r.log._harplus.screenshots.push({ kind: 'viewport', view: 'protanopia', mimeType: 'image/png', encoding: 'base64', data: PNG, cssWidth: 1280, cssHeight: 800, dpr: 1 });
  r.log._harplus.capture.viewChecks = { protanopia: { ok: false, detail: 'colours unchanged (0% of pixels shifted)' }, nocss: { ok: true, detail: 'all styles off' } };
  const s = screens(renderReport(r, getPlugins()));
  const note = 'May not reflect the setting — colours unchanged (0% of pixels shifted)';
  assert.equal(s.split(note).length - 1, 1);
  assert.equal(s.split('May not reflect').length - 1, 1);
  assert.doesNotMatch(s, /all styles off/);
  r.log._harplus.capture.viewChecks.nocss = { ok: false, detail: '<i>x' };
  const e = screens(renderReport(r, getPlugins()));
  assert.match(e, /&lt;i&gt;x/);
  assert.doesNotMatch(e, /<i>x/);
});

test('screens pane: no viewChecks, no note', () => {
  const s = screens(renderReport(withViews(), getPlugins()));
  assert.doesNotMatch(s, /May not reflect/);
});

const allRows = (r) => r.log.entries.map((e, i) => ({ e, i }));

test('waterfall: phase segments, ruler, markers and a legend of only the phases present', () => {
  const r = load();
  for (const e of r.log.entries) e.timings = { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 5, receive: 2 };
  const out = String(networkTable(r, allRows(r)));
  assert.match(out, /<i class="ph-wait" style="flex:5">/);
  assert.match(out, /class="ruler"/);
  assert.match(out, /class="mk mk-dcl"/, 'DOMContentLoaded line from pageTimings');
  const legend = out.slice(out.indexOf('class="wf-legend"'), out.indexOf('</p>', out.indexOf('class="wf-legend"')));
  assert.match(legend, /Waiting \(TTFB\)/);
  assert.match(legend, /Download/);
  assert.doesNotMatch(legend, /TLS|DNS|Queued/);
  assert.match(legend, /DOMContentLoaded \d+ ms/);
  assert.doesNotMatch(out, /NaN|undefined|Infinity/);
});

test('waterfall: -1 timings and a bad date give a dashed "no timing" bar, never NaN', () => {
  const r = load();
  r.log.entries[0].startedDateTime = 'garbage';
  r.log.entries[1].timings = { blocked: -1, dns: -1, connect: -1, ssl: -1, send: -1, wait: -1, receive: -1 };
  const out = String(networkTable(r, allRows(r)));
  assert.match(out, /class="bar none"[^>]*title="no timing/);
  assert.doesNotMatch(out, /NaN|undefined|Infinity/);
});

test('waterfall: sortable headers, sorted rows, status chips', () => {
  const r = load();
  const out = String(networkTable(r, allRows(r), { sort: { key: 'size', dir: 'desc' } }));
  assert.match(out, /<th scope="col" aria-sort="descending"><button type="button" class="sort" data-sort="size">/);
  const sizes = [...out.matchAll(/data-bytes="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
  assert.match(out, /class="st-chip st-ok">200</);
  assert.match(out, /aria-controls="ed-0"/);
});

test('waterfall: "Show more" past 200 rows; the standalone export lists every row with no button (Review Focus 5)', () => {
  const r = load();
  const base = r.log.entries;
  r.log.entries = Array.from({ length: 250 }, (_, k) => structuredClone(base[k % base.length]));
  const out = String(networkTable(r, allRows(r)));
  assert.equal(NET_PAGE, 200);
  assert.equal(out.match(/<tr data-entry=/g).length, 200);
  assert.match(out, /Showing 200 of 250 · <button type="button" data-net-more>Show 50 more<\/button>/);
  const doc = standaloneDocument(r, getPlugins(), { css: '' });
  const net = doc.slice(doc.indexOf('id="net-table"'));
  assert.equal(net.match(/<tr data-entry=/g).length, 250);
  assert.doesNotMatch(net, /data-net-more/);
});

test('waterfall with zero entries keeps the empty message and draws nothing (Review Focus 2)', () => {
  const r = load();
  r.log.entries = [];
  const out = String(networkTable(r, []));
  assert.match(out, /No requests recorded\./);
  assert.doesNotMatch(out, /wf-legend|ruler/);
});

test('requestDetail: five tabs, Overview open, facts, timing, wire format', () => {
  const r = load();
  const out = String(requestDetail(r, 0));
  for (const t of ['overview', 'timing', 'headers', 'wire', 'body']) assert.match(out, new RegExp(`id="ed-0-t-${t}"`));
  assert.match(out, /role="tab" id="ed-0-t-overview" aria-controls="ed-0-p-overview" aria-selected="true" tabindex="0"/);
  assert.match(out, /id="ed-0-p-overview" aria-labelledby="ed-0-t-overview" tabindex="0">/, 'overview is not hidden');
  assert.match(out, /id="ed-0-p-wire" aria-labelledby="ed-0-t-wire" tabindex="0" hidden>/);
  assert.match(out, /<dt>Requested by<\/dt>/);
  assert.match(out, /<span class="w-s">GET \/ HTTP\/1\.1<\/span>/);
  assert.match(out, /class="ph-row"/);
  assert.doesNotMatch(out, /NaN|undefined|Infinity/);
});

test('standalone export Network section has no dead controls; the interactive table keeps them', () => {
  const r = load();
  const doc = standaloneDocument(r, getPlugins(), { css: '' });
  const net = doc.slice(doc.indexOf('id="net-table"'), doc.indexOf('</section>', doc.indexOf('id="net-table"')));
  assert.doesNotMatch(net, /class="disclose"|data-sort|<button/);
  assert.match(net, /<th scope="col">Status<\/th>/);
  assert.equal(net.match(/<tr data-entry=/g).length, r.log.entries.length);
  const live = String(networkTable(r, allRows(r)));
  assert.match(live, /class="disclose"/);
  assert.match(live, /data-sort=/);
});

test('network: counts are locale-formatted (1,240) and sort glyphs are aria-hidden', () => {
  const r = load();
  const base = r.log.entries;
  r.log.entries = Array.from({ length: 1240 }, (_, k) => base[k % base.length]);
  const out = String(networkTable(r, allRows(r), { sort: { key: 'time', dir: 'desc' } }));
  assert.match(out, /1,240 of 1,240 requests/);
  assert.match(out, /Showing 200 of 1,240 · <button type="button" data-net-more>Show 200 more/);
  assert.match(out, /<span aria-hidden="true"> ▾<\/span>/);
});

test('network: hostile strings in every field are escaped in the table and the detail', () => {
  const r = load();
  const x = '"><img src=x onerror=alert(1)>';
  const e = r.log.entries[0];
  e.request.url = `https://example.com/${x}`;
  e.request.headers = [{ name: `X-${x}`, value: x }];
  e.request.postData = { mimeType: 'text/plain', text: x };
  e.response.headers = [{ name: 'X-Resp', value: x }];
  e.response.statusText = x;
  e.response.content = { ...e.response.content, mimeType: 'text/plain', text: x };
  e._initiator = { type: 'script', url: x };
  e._error = x;
  assert.doesNotMatch(String(networkTable(r, allRows(r))), /<img src=x/);
  assert.doesNotMatch(String(requestDetail(r, 0)), /<img src=x/);
});

test('interactive table: path and group toggles, overview strip with slider handles, reset disabled when not zoomed', () => {
  const r = load();
  const out = String(networkTable(r, allRows(r)));
  assert.match(out, /<button type="button" class="tog" data-wf-path aria-pressed="false"><span aria-hidden="true">◆<\/span> LCP path<\/button>/);
  assert.match(out, /data-wf-groups aria-pressed="false">Group by site</);
  assert.match(out, /id="wf-overview" data-span="\d+(\.\d+)?"/);
  assert.equal(out.match(/role="slider"/g).length, 2);
  assert.match(out, /aria-label="Zoom start" aria-valuemin="0"/);
  assert.match(out, /<button type="button" data-wf-reset disabled>Reset zoom<\/button>/);
  assert.match(out, /class="table-wrap net scroll"/);
  delete r.log._harplus.plugins.vitals.data.lcp;
  assert.match(String(networkTable(r, allRows(r))), /data-wf-path aria-pressed="false" disabled title="No LCP recorded for this reading"/);
});

test('LCP path: summary line, off-path rows dimmed, render-blocking tagged', () => {
  const r = load();
  const path = lcpPath(r);
  const out = String(networkTable(r, allRows(r), { path }));
  assert.match(out, /<p class="lcp-sum">LCP \d+ ms — text \(main\)/);
  assert.match(out, /data-wf-path aria-pressed="true"/);
  assert.ok((out.match(/class="off-path"/g) || []).length > 0, 'rows off the path are dimmed');
  assert.ok((out.match(/class="on-path"/g) || []).length >= 1 + path.blocking.length);
  if (path.blocking.length) assert.match(out, /<span class="rb-tag">blocks render<\/span>/);
});

test('groups: a third-party site collapses to one row; open shows members; a path member lights the group (Review Focus 1)', () => {
  const r = load();
  const closed = String(networkTable(r, allRows(r), { groups: true }));
  assert.match(closed, /<tr class="grp" data-group="localhost">/);
  assert.match(closed, /aria-label="Show 5 requests from localhost"/);
  assert.match(closed, /<td>5 requests<\/td>/);
  assert.doesNotMatch(closed, /grp-member/);
  const open = String(networkTable(r, allRows(r), { groups: true, openGroups: new Set(['localhost']) }));
  assert.equal((open.match(/grp-member/g) || []).length, 5);
  assert.match(open, /class="disclose grp-disc" aria-expanded="true"/);
  const path = lcpPath(r);
  const lh = r.log.entries.findIndex((e) => e.request.url.includes('localhost'));
  path.blocking.push(lh);
  assert.match(String(networkTable(r, allRows(r), { groups: true, path })), /<tr class="grp on-path" data-group="localhost">/);
});

test('zoom: bars crossing the window are clipped with cues; reset enabled; window text', () => {
  const r = load();
  const span = Number(String(networkTable(r, allRows(r))).match(/data-span="([\d.]+)"/)[1]);
  const out = String(networkTable(r, allRows(r), { window: { from: span * 0.2, to: span * 0.3 } }));
  assert.match(out, /<button type="button" data-wf-reset>Reset zoom<\/button>/);
  assert.match(out, /id="wf-zoom-text">Showing \d+ ms–\d+ ms of /);
  assert.doesNotMatch(out, /NaN|undefined|Infinity/);
  // Two known bars: A runs 0–100 ms, B 200–300 ms. A window of 50–250 ms straddles A's end... and B's start.
  const r2 = load();
  const t0 = Date.parse(r2.log.pages[0].startedDateTime);
  const mk = (url, start, time) => ({ ...structuredClone(r2.log.entries[0]), startedDateTime: new Date(t0 + start).toISOString(), time, timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: time, receive: 0 }, request: { ...r2.log.entries[0].request, url } });
  r2.log.entries = [mk('https://a.test/a.js', 0, 100), mk('https://a.test/b.js', 200, 100)];
  r2.log._harplus.plugins.vitals.data = { lcp: { time: 400 } };
  const clipped = String(networkTable(r2, allRows(r2), { window: { from: 50, to: 250 } }));
  const rowA = clipped.slice(clipped.indexOf('a.js'), clipped.indexOf('b.js'));
  const rowB = clipped.slice(clipped.indexOf('b.js'));
  assert.match(rowA, /class="bar clip-s"/, 'A starts before the window');
  assert.match(rowA, /class="clip-cue s"/);
  assert.doesNotMatch(rowA, /clip-e|clip-cue e/);
  assert.match(rowB, /class="bar clip-e"/, 'B ends after the window');
  assert.match(rowB, /class="clip-cue e"/);
  assert.doesNotMatch(rowB, /clip-s|clip-cue s/);
});

test('groups on with no multi-request third-party site says so', () => {
  const r = load();
  assert.doesNotMatch(String(networkTable(r, allRows(r), { groups: true })), /no site has 2\+ requests/);
  r.log.entries = r.log.entries.slice(0, 1);
  const out = String(networkTable(r, allRows(r), { groups: true }));
  assert.match(out, /no site has 2\+ requests/);
  assert.doesNotMatch(String(networkTable(r, allRows(r))), /no site has 2\+ requests/);
  assert.match(out, /<span aria-hidden="true">◆<\/span> LCP path<\/button>/);
});

test('standalone export: no toolbar, strip, brush, dimming or scroll box', () => {
  const doc = standaloneDocument(load(), getPlugins(), { css: '' });
  const net = doc.slice(doc.indexOf('id="net-table"'));
  assert.doesNotMatch(net, /wf-overview|data-wf-path|data-wf-groups|role="slider"|off-path|class="table-wrap net scroll"/);
});

test('networkTable with toggles and a window renders 5,000 rows quickly', () => {
  const r = load();
  const base = r.log.entries;
  r.log.entries = Array.from({ length: 5000 }, (_, k) => structuredClone(base[k % base.length]));
  const rows = allRows(r);
  const t0 = performance.now();
  networkTable(r, rows, { groups: true, path: lcpPath(r), window: { from: 1, to: 10 } });
  assert.ok(performance.now() - t0 < 50 * 4, 'one re-render well within budget (4× slack for CI)');
});

test('Network table: a data: URL never reaches the page; type cell is classed in both modes', () => {
  const payload = 'Q'.repeat(4000);
  const r = load();
  const base = r.log.entries[0];
  r.log.entries = [
    { ...base, request: { method: 'GET', url: `data:image/gif;base64,${payload}`, headers: [] }, response: { status: 200, headers: [], content: {} } },
    { ...base, request: { method: 'GET', url: 'https://a.test/', headers: [] }, response: { status: 301, headers: [], redirectURL: 'https://a.test/x', content: {} } },
  ];
  for (const interactive of [true, false]) {
    const out = String(networkTable(r, allRows(r), { interactive })) + String(requestDetail(r, 0));
    assert.doesNotMatch(out, new RegExp(payload.slice(0, 64)));
    assert.match(out, /data:image\/gif;base64,…/);
    assert.equal((out.match(/<td class="type">/g) || []).length, 2);
  }
  assert.match(String(networkTable(r, allRows(r))), /class="st-chip st-redir">301</);
});

test('theme: st-redir chip contrast >= 4.5 in light and dark; no nth-child column rule', () => {
  const css = readFileSync(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  assert.match(css, /\.st-chip\.st-redir\s*\{[^}]*color:\s*var\(--text\)[^}]*color-mix\(in srgb, var\(--c1\) 16%, transparent\)/);
  assert.doesNotMatch(css, /td:nth-child\(5\)/);
  const pair = (name) => css.match(new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`, 'i')).slice(1, 3);
  const [text, c1] = ['text', 'c1'].map(pair);
  for (const name of ['panel', 'panel-2', 'accent-soft']) { // all plain light-dark(#hex, #hex) pairs
    const bgPair = pair(name);
    for (const m of [0, 1]) {
      const bg = composite({ ...parseRgb(c1[m]), a: 0.16 }, parseRgb(bgPair[m]));
      assert.ok(wcagRatio(parseRgb(text[m]), bg) >= 4.5, `${name} mode ${m}`);
    }
  }
});

test('Network table with the LCP path on: a data: LCP image never leaks its payload', () => {
  const payload = 'Z'.repeat(3000);
  const url = `data:image/png;base64,${payload}`;
  const r = load();
  r.log.entries = [{ ...r.log.entries[0], request: { method: 'GET', url, headers: [] }, response: { status: 200, headers: [], content: {} } }];
  r.log._harplus.plugins.vitals = { data: { lcp: { time: 600, url } } };
  const path = lcpPath(r);
  assert.ok(path);
  const out = String(networkTable(r, allRows(r), { path }));
  assert.doesNotMatch(out, new RegExp(payload.slice(0, 64)));
  assert.match(out, /data:image\/png;base64,…/);
});

/* ---------------------------------------------------------------- Page map */

const withMarks = (marks, { fullpage = true, doc = { w: 1280, h: 4000 } } = {}) => {
  const r = withViews();
  const hp = r.log._harplus;
  if (!fullpage) hp.screenshots = hp.screenshots.filter((s) => s.kind !== 'fullpage');
  else Object.assign(hp.screenshots.find((s) => s.kind === 'fullpage' && s.view === 'desktop'), { docWidth: 1280, docHeight: 4000 });
  hp.plugins['a11y-map'] = { id: 'a11y-map', name: 'Images & alt text', status: 'ok', area: 'accessibility', durationMs: 5, findings: [], summary: [],
    data: { images: [], counts: {}, doc, marks } };
  return r;
};
const MARKS = [
  { category: 'feature', label: 'Alt text', ruleId: 'alt-ok', sel: 'img.hero', box: { x: 100, y: 200, w: 300, h: 150 }, alt: `<script>alert(1)</script> “Tent” ${'x'.repeat(80)}` },
  { category: 'error', label: 'Images must have alternate text', ruleId: 'image-alt', sel: '#a', box: { x: 640, y: 1000, w: 40, h: 40 } },
  { category: 'keyboard', label: 'Tab stop 1: link “Home”', ruleId: 'kb-stop', rule: 'Keyboard order', sel: 'a.home', box: { x: 0, y: 0, w: 128, h: 40 }, n: 1, glyph: '1' },
  { category: 'keyboard', label: 'Tab stop 2: link “Shop”', ruleId: 'kb-stop', rule: 'Keyboard order', sel: 'a.shop', box: { x: 128, y: 0, w: 128, h: 40 }, n: 2, glyph: '2' },
  { category: 'structure', label: 'Heading 1: “Gear”', ruleId: 'heading', sel: 'h1', box: { x: 0, y: 5000, w: 100, h: 40 }, glyph: 'H1' },
];
const mapPanel = (out) => {
  const s = String(out);
  const i = s.indexOf('id="p-page-map"');
  return i < 0 ? '' : s.slice(i, s.indexOf('</section>', i));
};

test('page map: markers at percentages, escaped and truncated alt labels, legend checkboxes, numbered list', () => {
  const out = renderReport(withMarks(MARKS), getPlugins());
  const p = mapPanel(out);
  assert.ok(p, 'Page map panel present');
  assert.ok(out.indexOf('id="p-a11y-map"') < out.indexOf('id="p-page-map"'), 'right after the Images panel');
  assert.match(p, /class="pm-mark c-error pm-out"[^>]*style="left:50%;top:25%;width:3\.125%;height:1%/);
  assert.match(p, /class="pm-alt"/);
  assert.doesNotMatch(p, /<script>alert/);
  assert.match(p, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const alt = p.match(/class="pm-alt"[^>]*>([^<]*)</)[1];
  assert.ok(alt.replace(/&[a-z]+;|&#\d+;/g, '_').length <= 62, `alt label truncated to 60 characters: ${alt}`);
  assert.match(alt, /…/);
  for (const c of ['error', 'contrast', 'alert', 'feature', 'structure', 'aria', 'keyboard']) {
    assert.match(p, new RegExp(`<input type="checkbox" class="pm-t" id="pm-t-${c}" checked>`), c);
  }
  assert.match(p, /<path class="step" d="M5 0\.5L15 0\.5"\/>/, 'keyboard path through the stop centres');
  assert.match(p, /id="pm-t-path" checked/, 'a separate path toggle');
  assert.match(p, /<ul class="pm-list">/);
  assert.equal((p.match(/<li id="pm-i-/g) || []).length, 4, 'one row per placed marker');
  assert.equal((p.match(/<li class="pm-group c-/g) || []).length, 3, 'grouped by category and rule: error, keyboard, feature');
  assert.match(p, /<li class="pm-group c-keyboard"><details><summary>.*Keyboard order <span class="pm-n">2 elements · #2–#3<\/span>/);
  assert.match(p, /<a class="pm-go" href="#pm-m-1"[^>]*>#1<\/a>/, 'each row links to its marker');
  assert.match(p, /<span class="pm-mark c-error pm-out" id="pm-m-1"/);
  assert.match(p, /class="status-dot status-error" title="1 error"/, 'summary status reflects errors');
  assert.match(String(out), /<details class="plugin pm-panel" id="p-page-map" open>/);
  assert.match(p, /1 marker lies beyond the captured image/);
  assert.doesNotMatch(noData(p), /undefined|NaN/);
});

test('page map: CSS toggles hide a category with sibling selectors; print shows every marker', () => {
  const css = readFileSync(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  assert.match(css, /#pm-t-error:not\(:checked\) ~ \.pm-frame \.c-error/);
  assert.match(css, /#pm-t-keyboard:not\(:checked\) ~ \.pm-frame \.pm-path/);
  assert.match(css, /@media print[\s\S]*\.pm-mark[^{]*\{[^}]*display:\s*block !important/);
  for (const c of ['error', 'contrast', 'alert', 'feature', 'structure', 'aria', 'keyboard']) assert.match(css, new RegExp(`--pm-${c}:`), c);
});

test('page map: mismatch, cap and viewport-fallback notes', () => {
  const mis = mapPanel(renderReport(withMarks(MARKS, { doc: { w: 1280, h: 4200 } }), getPlugins()));
  assert.match(mis, /page changed size/i);
  const many = Array.from({ length: 450 }, (_, i) => ({ category: 'alert', label: 'x', ruleId: 'x', sel: `#x${i}`, box: { x: i, y: i, w: 5, h: 5 } }));
  assert.match(mapPanel(renderReport(withMarks(many), getPlugins())), /50 more not drawn/);
  const vp = mapPanel(renderReport(withMarks(MARKS, { fullpage: false }), getPlugins()));
  assert.match(vp, /No full-page screenshot/);
  assert.match(vp, /<img class="pm-shot"/);
  assert.equal((vp.match(/<li id="pm-i-/g) || []).length, 3, 'only marks inside the first viewport (1280×800)');
});

test('page map: absent without marks; the standalone export has the markers and no script', () => {
  assert.equal(mapPanel(renderReport(withViews(), getPlugins())), '');
  const doc = standaloneDocument(withMarks(MARKS), getPlugins(), { css: 'body{}' });
  assert.doesNotMatch(doc, /<script/i);
  assert.match(doc, /class="pm-mark c-feature pm-img pm-out"[^>]*>.*class="pm-alt"/);
  assert.match(doc, /id="pm-t-error" checked/);
  assert.match(doc, /title="#1 /, 'details as title text');
  assert.equal((doc.match(/crop-r[0-9a-z]+\{background-image/g) || []).length, 1, 'the screenshot is inlined once for thumbnails and map');
  // groups are open in the export, so #pm-i-N targets show in every browser; the live panel keeps them closed
  assert.match(mapPanel(doc), /<li class="pm-group c-keyboard"><details open><summary>/);
  assert.match(p0(), /<li class="pm-group c-keyboard"><details><summary>/);
});

const p0 = () => mapPanel(renderReport(withMarks(MARKS), getPlugins()));

test('page map: the corner icon sits left of the box when there is room, inside it when not', () => {
  const near = [{ category: 'error', label: 'x', ruleId: 'x', sel: '#a', box: { x: 2, y: 100, w: 300, h: 30 } },
    { category: 'error', label: 'y', ruleId: 'x', sel: '#b', box: { x: 200, y: 200, w: 300, h: 30 } }];
  const p = mapPanel(renderReport(withMarks(near), getPlugins()));
  assert.match(p, /class="pm-mark c-error" id="pm-m-1"/, 'no room at the left edge: stays inside');
  assert.match(p, /class="pm-mark c-error pm-out" id="pm-m-2"/);
  const css = readFileSync(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  assert.match(css, /\.pm-mark\.pm-out \.pm-icon \{[^}]*right: calc\(100% \+/);
});

test('a cluster anchor shows +N and members are not drawn', () => {
  const crowd = [0, 8, 16].map((x, i) => ({ category: 'feature', label: 'Image with alt text', ruleId: 'alt-ok', sel: `#i${i}`, box: { x, y: 1000, w: 10, h: 10 }, image: true, alt: 'Logo' }));
  const p = mapPanel(renderReport(withMarks(crowd), getPlugins()));
  assert.match(p, /id="pm-m-1"[^>]*>[^]*?title="#1 Feature: Image with alt text — #i0 — with #2, #3">✓<span class="pm-more">\+2<\/span><\/a>/);
  assert.match(p, /<span class="pm-mark c-feature pm-member" id="pm-m-2" data-pm="1" style="[^"]*"><\/span>/);
  assert.match(p, /<span class="pm-mark c-feature pm-member" id="pm-m-3" data-pm="2" style="[^"]*"><\/span>/);
  assert.equal((p.match(/class="pm-icon"/g) || []).length, 1, 'one icon drawn');
  assert.equal((p.match(/<li id="pm-i-/g) || []).length, 3, 'list entries unchanged');
});

test('page map: a moved reference box draws the line markers below it are withheld at', () => {
  const r = withMarks([{ category: 'error', label: 'x', ruleId: 'x', sel: '#a', box: { x: 10, y: 100, w: 10, h: 10 } }, { category: 'error', label: 'x', ruleId: 'x', sel: '#b', box: { x: 10, y: 3000, w: 10, h: 10 } }],
    { doc: { w: 1280, h: 4400, refs: [[0, 50, 100, 20], [0, 2300, 100, 20]] } });
  r.log._harplus.screenshots.find((s) => s.kind === 'fullpage' && s.view === 'desktop').refs = [[0, 50, 100, 20], [0, 2000, 100, 20]];
  const p = mapPanel(renderReport(r, getPlugins()));
  assert.match(p, /Markers below the dashed line are withheld because the page changed after the screenshot \(1 marker\)\./);
  assert.match(p, /<i class="pm-shift" style="top:50%"/);
  assert.doesNotMatch(p, /The page grew after the screenshot/);
});

test('screenshot export: a hostile mimeType or data never reaches the document', () => {
  const r = withMarks(MARKS);
  const shot = r.log._harplus.screenshots.find((s) => s.kind === 'fullpage' && s.view === 'desktop');
  shot.mimeType = 'x)}</style><script>alert(7)</script>';
  let doc = standaloneDocument(r, getPlugins(), { css: 'body{}' });
  assert.doesNotMatch(doc, /<script/i);
  assert.doesNotMatch(doc, /alert\(7\)/);
  assert.doesNotMatch(doc, /crop-r[0-9a-z]+\{background-image/, 'no rule at all, so the crops show placeholders');
  const r2 = withMarks(MARKS);
  const s2 = r2.log._harplus.screenshots.find((s) => s.kind === 'fullpage' && s.view === 'desktop');
  s2.data = 'AAAA)}</style><script>alert(2)</script>';
  doc = standaloneDocument(r2, getPlugins(), { css: 'body{}' });
  assert.doesNotMatch(doc, /<script/i);
  assert.doesNotMatch(doc, /alert\(2\)/);
});
