import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderReport, timeBuckets, PANES, issuesList, issueDetail, filterIssues, shownIssueKey, issueNeedsReveal, defaultIssueFilters, issueFiltersActive, standaloneDocument, networkTable, requestDetail, NET_PAGE } from '../extension/ui/report.js';
import { scoreReading, VERDICT } from '../extension/core/score.js';
import { allIssues } from '../extension/core/issues.js';
import { readingStatus } from '../extension/core/readout.js';
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
  assert.match(out, />Fix first<\/h2>/);
  assert.match(out, /id="issues-list"/);
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
  assert.match(issuesList([]).toString(), /No issues\./);
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
  assert.match(css, /\.st-chip\.st-redir\s*\{[^}]*color:\s*var\(--ink\)[^}]*color-mix\(in srgb, var\(--c1\) 16%, transparent\)/);
  assert.doesNotMatch(css, /td:nth-child\(5\)/);
  const pair = (name) => css.match(new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`, 'i')).slice(1, 3);
  const [text, c1] = ['ink', 'c1'].map(pair);
  for (const name of ['surface', 'surface-sunk', 'accent-soft']) { // all plain light-dark(#hex, #hex) pairs
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

test('page map: with no error markers the summary word is "passing"', () => {
  const out = renderReport(withMarks(MARKS.filter((m) => m.category !== 'error')), getPlugins());
  assert.match(mapPanel(out), /<span class="status" data-status="good">passing<\/span><\/summary>/);
});

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
  assert.match(p, /<span class="status" data-status="poor">failing<\/span><\/summary>/, 'summary status reflects errors');
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
  const un = withMarks(MARKS);
  un.log._harplus.plugins['a11y-map'].data.marksUnresolved = 3;
  assert.match(mapPanel(renderReport(un, getPlugins())), /3 flagged elements could not be placed \(not found, no size, inside a frame or shadow DOM, or not reached in time\)\. Keyboard stops that are sticky or fixed are not drawn\./);
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
  // Nothing withheld below it: no line, no note.
  const none = withMarks([{ category: 'error', label: 'x', ruleId: 'x', sel: '#a', box: { x: 10, y: 100, w: 10, h: 10 } }],
    { doc: { w: 1280, h: 4400, refs: [[0, 50, 100, 20], [0, 2300, 100, 20]] } });
  none.log._harplus.screenshots.find((s) => s.kind === 'fullpage' && s.view === 'desktop').refs = [[0, 50, 100, 20], [0, 2000, 100, 20]];
  const q = mapPanel(renderReport(none, getPlugins()));
  assert.doesNotMatch(q, /pm-shift|dashed line/);
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

test('accessibility scoring details show Affected, Breadth and Extent; performance shows Points', () => {
  const mk = () => {
    const r = load();
    const hp = r.log._harplus;
    hp.plugins = { ...hp.plugins,
      'a11y-basics': { id: 'a11y-basics', name: 'Accessibility basics', status: 'ok', durationMs: 1, area: 'accessibility', findings: [
        { id: 'x', severity: 'high', category: 'accessibility', title: 'Links have no name', count: 65, of: 819, unit: 'links' }] },
      network: { id: 'network', name: 'Network', status: 'ok', durationMs: 1, area: 'performance', findings: [
        { id: 'y', severity: 'high', category: 'performance', title: 'Big payload' }] } };
    return r;
  };
  const out = renderReport(mk(), getPlugins());
  const det = [...out.matchAll(/<details class="scoring">[\s\S]*?<\/details>/g)].map((m) => m[0]);
  const a = det.find((d) => d.includes('65 of 819 links (7.9%)'));
  assert.ok(a, 'accessibility details present');
  for (const t of ['Affected', 'Breadth', 'Extent', '−9', 'Findings score', 'capped at 55, 30 and 15']) assert.ok(a.includes(t), t);
  assert.ok(!a.includes('capped at 60'));
  const p = det.find((d) => d.includes('Big payload'));
  assert.ok(p, 'performance details present');
  assert.ok(p.includes('Points') && p.includes('High · 1 finding') && !p.includes('Extent'));
  assert.ok(standaloneDocument(mk(), getPlugins()).includes('65 of 819 links (7.9%)'));
});

/* ------------------------------------------------------------ Issues pane */

const emptyReading = () => ({ log: { entries: [], pages: [], _harplus: { plugins: {}, target: {}, capture: {}, screenshots: [], capturedAt: '2026-10-09T00:00:00Z' } } });

test('Issues pane: one list, one detail per issue, keys as ids, #findings alias, no tables', () => {
  const reading = load();
  const plugins = getPlugins();
  const out = renderReport(reading, plugins, { interactive: false });
  assert.ok(PANES.includes('issues') && !PANES.includes('findings'));
  assert.match(out, /<section class="pane" id="issues"/); assert.match(out, /<span id="findings" class="pane-alias"><\/span>/);
  assert.match(out, /<h1 id="issues-h">Issues <b>\d+<\/b><\/h1><div class="tools" id="issues-tools"><\/div>/);
  const keys = allIssues(scoreReading(reading, plugins)).map((i) => i.key);
  assert.ok(keys.length > 0);
  for (const k of keys) assert.ok(out.includes(`id="issue-${k}"`), k);
  assert.equal((out.match(/<article class="issue-detail"/g) || []).length, keys.length);
  assert.ok(!out.includes('class="data findings"') && !out.includes('finding-list'));
  assert.ok(!out.includes('All findings'));
  assert.match(out, /href="#issues" data-pane="issues">[^]*?Issues<b>\d+<\/b>/);
});

test('Fix first and area issues use the same row and link to the detail', () => {
  const reading = load();
  const plugins = getPlugins();
  const out = renderReport(reading, plugins, { interactive: false });
  const top = allIssues(scoreReading(reading, plugins))[0];
  assert.ok((out.match(new RegExp(`href="#issue-${top.key}"`, 'g')) || []).length >= 3); // Fix first, area pane, Issues list
  const overview = out.slice(out.indexOf('id="overview"'), out.indexOf('id="area-'));
  assert.match(overview, /Fix first<\/h2><\/div>\s*<div class="panel-body"><ul class="issues">/);
  assert.match(overview, /<a href="#issues">All \d+ issues →<\/a>/);
  assert.doesNotMatch(overview, /\d+ findings?</);
  const start = out.indexOf(`id="area-${top.area}"`);
  const part = out.slice(out.indexOf(`id="${top.area}-issues"`, start), out.indexOf(`id="${top.area}-measurements"`, start));
  assert.match(part, /<h3 class="issue-group">[^]*?<ul class="issues">/);
  assert.match(part, new RegExp(`href="#issue-${top.key}"`));
});

test('area pane: Open in Issues links to #issues with its area, however few issues', () => {
  const out = renderReport(load(), getPlugins(), { interactive: false });
  assert.match(out, /<a class="more" href="#issues" data-area="security">Open in Issues →<\/a>/);
  assert.doesNotMatch(out, /All issues →/);
});

const mkIssue = (o) => ({ severity: 'medium', area: 'content', category: 'quality', plugin: 'content', pluginName: 'Content', title: 'T', key: 'content-0', ...o });

test('detail: places when present, else escaped Evidence; Reference closed; no what/why/how', () => {
  const withPlaces = String(issueDetail(mkIssue({ key: 'links-a', places: [{ url: 'https://x.test/a', status: 404 }], evidence: 'ignored' }), { interactive: false }));
  assert.match(withPlaces, /<article class="issue-detail" id="issue-links-a" aria-labelledby="ih-links-a" tabindex="-1">/);
  assert.match(withPlaces, /<h2 id="ih-links-a" tabindex="-1">T<\/h2>/);
  assert.match(withPlaces, /<ul class="places">/);
  assert.match(withPlaces, /1 place</);
  assert.doesNotMatch(withPlaces, /Evidence/);
  const objEv = String(issueDetail(mkIssue({ key: 'b', evidence: { a: '<x>' } }), {}));
  assert.match(objEv, /<details class="disclosure"><summary>Evidence<\/summary><div class="disclosure-body"><pre>[^]*&lt;x&gt;[^]*<\/pre>/);
  assert.doesNotMatch(objEv, /\[object Object\]|<x>/);
  const arrEv = String(issueDetail(mkIssue({ key: 'c', evidence: ['one', 'two'] }), {}));
  assert.match(arrEv, /<pre>\[\n  &quot;one&quot;/);
  const strEv = String(issueDetail(mkIssue({ key: 'd', evidence: 'a <b> c', detail: 'D <i>' }), {}));
  assert.match(strEv, /<pre>a &lt;b&gt; c<\/pre>/);
  assert.match(strEv, /<p>D &lt;i&gt;<\/p>/);
  for (const d of [withPlaces, objEv, arrEv, strEv]) {
    assert.ok(!/What’s wrong|Why it matters|How to fix/.test(d));
    assert.doesNotMatch(d, /Reference/);
  }
  const a11y = String(issueDetail(mkIssue({ key: 'a11y-basics-fieldset-legend', area: 'accessibility', plugin: 'a11y-basics', pluginName: 'Accessibility basics', id: 'fieldset-legend', title: 'Fieldsets without a legend (2)', ref: 'https://example.test/rule' }), {}));
  const refBlock = a11y.match(/<details class="disclosure"><summary>Reference<\/summary>[^]*?<\/details>/);
  assert.ok(refBlock, 'Reference is a closed disclosure');
  assert.match(refBlock[0], /Add &lt;legend&gt; as the first child/);
  assert.ok(!/What’s wrong|Why it matters|How to fix/.test(a11y.replace(refBlock[0], '')), 'reference text only inside the disclosure');
  assert.match(a11y, /href="https:\/\/example\.test\/rule"[^>]*>reference<\/a>/);
});

test('detail: chips, footer with headline, nav, and Copy buttons only when interactive', () => {
  const results = { content: { id: 'content', summary: [{ label: 'Words', value: 812 }, { label: 'Reading level', value: 'Grade 8', headline: true }] } };
  const issue = mkIssue({ key: 'content-x', places: [{ url: 'https://x.test/a' }, { selector: 'h1' }] });
  const prev = mkIssue({ key: 'content-p' });
  const next = mkIssue({ key: 'content-n' });
  const live = String(issueDetail(issue, { prev, next, interactive: true, results }));
  assert.match(live, /class="sev sev-pill" data-sev="medium"/);
  assert.match(live, /<a class="chip" href="#area-content">Content<\/a>/);
  assert.match(live, /<a class="chip" href="#pd-content">Content<\/a>/);
  assert.match(live, /2 places/);
  assert.match(live, /Found by Content/);
  assert.match(live, /Reading level Grade 8/);
  assert.match(live, /<a href="#pd-content">All Content data →<\/a>/, 'the body, so Chrome opens the closed details');
  assert.match(live, /class="issue-nav"[^]*href="#issue-content-p"[^]*Previous[^]*href="#issue-content-n"[^]*Next/);
  assert.match(live, /data-act="copy-md" data-key="content-x">Copy as Markdown<\/button>/);
  assert.match(live, /data-act="copy-urls" data-key="content-x">Copy all URLs<\/button>/);
  const noUrls = String(issueDetail(mkIssue({ key: 'k', places: [{ selector: 'h1' }] }), { interactive: true }));
  assert.match(noUrls, /data-act="copy-md"/);
  assert.doesNotMatch(noUrls, /copy-urls/);
  const still = String(issueDetail(issue, { prev, next, interactive: false, results }));
  assert.doesNotMatch(still, /data-act=/);
  assert.match(still, /class="issue-nav"/);
  assert.doesNotMatch(String(issueDetail(issue, { next })), /Previous/);
});

test('issuesList: groups by severity, Low and Info folded with their count; by area and source', () => {
  const list = [
    mkIssue({ key: 'h1', severity: 'high', area: 'security', plugin: 'security', pluginName: 'Security' }),
    mkIssue({ key: 'l1', severity: 'low' }), mkIssue({ key: 'l2', severity: 'low', area: 'security', plugin: 'security', pluginName: 'Security' }),
    mkIssue({ key: 'i1', severity: 'info' }),
  ];
  const out = String(issuesList(list));
  assert.match(out, /<h2 class="issue-group"><span class="sev" data-sev="high">[^]*?High<\/span> <span class="issue-group-count">1<\/span><\/h2>/);
  assert.doesNotMatch(out, /data-sev="medium"/);
  assert.match(out, /<details class="disclosure issue-fold" data-group="low"><summary><h2 class="issue-group"><span class="sev" data-sev="low">[^]*?Low<\/span> · 2<\/h2><\/summary>/);
  assert.match(out, /<details class="disclosure issue-fold" data-group="info"><summary><h2 class="issue-group"><span class="sev" data-sev="info">[^]*?Info<\/span> · 1<\/h2><\/summary>/);
  assert.ok(out.indexOf('#issue-h1') < out.indexOf('#issue-l1') && out.indexOf('#issue-l2') < out.indexOf('#issue-i1'));
  const byArea = String(issuesList(list, { group: 'area' }));
  assert.ok(byArea.indexOf('class="issue-group">Security') < byArea.indexOf('class="issue-group">Content'), 'areas in AREAS order');
  assert.doesNotMatch(byArea, /issue-fold/);
  const bySource = String(issuesList(list, { group: 'plugin' }));
  assert.match(bySource, /class="issue-group">Security <span class="issue-group-count">2<\/span>/);
  assert.match(String(issuesList([])), /No issues\./);
});

test('issuesList: open folds by key or all, showArea to rows, heading level', () => {
  const list = [
    mkIssue({ key: 'h1', severity: 'high', area: 'security', plugin: 'security', pluginName: 'Headers' }),
    mkIssue({ key: 'l1', severity: 'low' }), mkIssue({ key: 'i1', severity: 'info' }),
  ];
  const closed = String(issuesList(list));
  assert.match(closed, /<details class="disclosure issue-fold" data-group="low"><summary>/);
  const lowOpen = String(issuesList(list, { open: new Set(['low']) }));
  assert.match(lowOpen, /<details class="disclosure issue-fold" data-group="low" open>/);
  assert.match(lowOpen, /<details class="disclosure issue-fold" data-group="info">/);
  const allOpen = String(issuesList(list, { open: true }));
  assert.equal((allOpen.match(/issue-fold" data-group="\w+" open>/g) || []).length, 2);
  assert.match(closed, /<span class="issue-meta"><span>Security<\/span><span>Headers<\/span><\/span>/, 'rows name their area by default');
  const noArea = String(issuesList(list, { showArea: false }));
  assert.doesNotMatch(noArea, /<span class="issue-meta"><span>Security<\/span>/);
  assert.match(noArea, /<span class="issue-meta"><span>Headers<\/span><\/span>/);
  assert.match(noArea, /<span class="issue-meta"><span>Content<\/span><\/span>/, 'the source plugin stays');
  const h3 = String(issuesList(list, { level: 3 }));
  assert.doesNotMatch(h3, /<h2/);
  assert.match(h3, /<h3 class="issue-group"><span class="sev" data-sev="high">/);
  assert.match(h3, /<summary><h3 class="issue-group">[^]*?<\/h3><\/summary>/);
  assert.match(String(issuesList(list, { group: 'area', level: 3 })), /<h3 class="issue-group">Security <span class="issue-group-count">1<\/span><\/h3>/);
});

test('issue filters: defaults keep the grouping; active means anything narrows the list', () => {
  const d = defaultIssueFilters('area');
  assert.deepEqual([...d.sev], ['high', 'medium', 'low', 'info']);
  assert.deepEqual({ ...d, sev: null }, { sev: null, area: '', source: '', group: 'area', q: '' });
  assert.equal(defaultIssueFilters().group, 'severity');
  assert.equal(issueFiltersActive(d), false);
  assert.equal(issueFiltersActive({ ...d, group: 'plugin' }), false, 'grouping is not a filter');
  assert.equal(issueFiltersActive({ ...d, sev: new Set(['high']) }), true);
  assert.equal(issueFiltersActive({ ...d, area: 'content' }), true);
  assert.equal(issueFiltersActive({ ...d, source: 'links' }), true);
  assert.equal(issueFiltersActive({ ...d, q: 'x' }), true);
});

test('issueNeedsReveal: only an existing issue the filters hide', () => {
  assert.equal(issueNeedsReveal('b', ['a'], ['a', 'b']), true);
  assert.equal(issueNeedsReveal('a', ['a'], ['a', 'b']), false, 'already listed');
  assert.equal(issueNeedsReveal('nope', ['a'], ['a', 'b']), false, 'not in this reading');
  assert.equal(issueNeedsReveal(null, ['a'], ['a', 'b']), false);
});

test('no findings: "No issues." and no issue-detail', () => {
  const out = renderReport(emptyReading(), getPlugins(), { interactive: false });
  assert.match(out, /No issues\./); assert.ok(!out.includes('class="issue-detail"'));
});

test('export: no <script>, every detail present, Copy buttons absent, Prev/Next anchors present', () => {
  const doc = standaloneDocument(load(), getPlugins(), { css: '' });
  assert.ok(!/<script/i.test(doc)); assert.ok(!doc.includes('data-act="copy-md"')); assert.match(doc, /class="issue-nav"[^]*href="#issue-/);
  const n = allIssues(scoreReading(load(), getPlugins())).length;
  assert.equal((doc.match(/<article class="issue-detail"/g) || []).length, n);
  assert.match(renderReport(load(), getPlugins(), { interactive: true }), /data-act="copy-md"/);
});

test('theme: issue details by :target, first by default, split at 1100px, print shows all', () => {
  const css = readFileSync(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  assert.match(css, /\.issue-details > \.issue-detail \{ display: none; \}/);
  assert.match(css, /\.issue-details > \.issue-detail:target, \.issue-details:not\(:has\(\.issue-detail:target\)\) > \.issue-detail:first-child \{ display: block; \}/);
  assert.match(css, /@media \(min-width: 1100px\) \{\s*\.split \{/);
  assert.match(css, /\.issue-details > \.issue-detail \{ display: block !important; \}/);
  assert.match(css, /\.issue-nav[^{]*\{ display: none !important; \}/);
  assert.match(css, /\.pane-alias \{ display: none; \}/);
  assert.match(css, /@media \(min-width: 1100px\) \{[^@]*\.issue-details \{\s*position: sticky; top: calc\(var\(--appbar-h, 0px\) \+ 0\.75rem\);\s*max-height: calc\(100dvh - var\(--appbar-h, 0px\) - 0\.75rem\); overflow: auto;/);
  assert.match(css, /@media print \{[^]*\.issue-details \{ position: static; max-height: none; overflow: visible; \}/);
  assert.match(css, /@media print \{[^]*:is\(\.panel, details\.plugin, \.places\) span\.url \{ display: inline; white-space: normal; overflow-wrap: anywhere; \}/, 'inline URLs stay in their sentence');
});

test('filterIssues: severity set, area, source, text', () => {
  const list = [{ severity: 'high', area: 'accessibility', plugin: 'axe', title: 'Contrast', pluginName: 'axe-core' }, { severity: 'low', area: 'content', plugin: 'links', title: 'Redirects', pluginName: 'Link check' }];
  assert.deepEqual(filterIssues(list, { sev: new Set(['high']), area: '', source: '', q: '' }).map((i) => i.plugin), ['axe']);
  assert.deepEqual(filterIssues(list, { sev: new Set(['high', 'low']), area: 'content', source: '', q: '' }).map((i) => i.plugin), ['links']);
  assert.deepEqual(filterIssues(list, { sev: new Set(['high', 'low']), area: '', source: 'links', q: 'redir' }).map((i) => i.plugin), ['links']);
});

test('shownIssueKey: the hash issue when listed, else the first listed, else none', () => {
  assert.equal(shownIssueKey('b', ['a', 'b']), 'b');
  assert.equal(shownIssueKey('z', ['a', 'b']), 'a', 'a filtered-out or dead key falls back to the first listed');
  assert.equal(shownIssueKey(null, ['a', 'b']), 'a');
  assert.equal(shownIssueKey('a', []), null);
});

test('sidebar: areas by issue count with a high mark; no area rings or scores', () => {
  const out = renderReport(load(), getPlugins(), { interactive: false });
  const nav = out.slice(out.indexOf('<nav class="sidebar"'), out.indexOf('</nav>'));
  assert.match(nav, /<p class="sidebar-label" id="sidebar-areas-label">Areas · issues<\/p>/);
  assert.doesNotMatch(nav, /<h\d/, 'the sidebar has no heading ahead of the pane h1');
  assert.match(nav, /<div class="sidebar-group" role="group" aria-labelledby="sidebar-areas-label"><a href="#area-/);
  assert.match(nav, /<span class="sev" data-sev="high"><span class="sev-ico" aria-hidden="true"><\/span><span class="sr-only">includes high severity<\/span><\/span>/);
  assert.match(nav, /href="#area-accessibility"[^]*?<b>\d+<\/b>/);
  assert.match(nav, /includes high severity/);
  assert.equal((nav.match(/class="chart ring"/g) || []).length, 1);
  assert.doesNotMatch(nav, />High</);
  for (const id of PANES) assert.match(nav, new RegExp(`data-pane="${id}"`), id);
});

test('help: one popover, labelled dialog, close button, five sections; export has the button and no script', () => {
  const reading = load();
  const out = renderReport(reading, getPlugins(), { interactive: false });
  assert.equal((out.match(/id="help"/g) || []).length, 1);
  assert.match(out, /<div id="help" popover class="help" role="dialog" aria-labelledby="help-h">/);
  assert.match(out, /<h2 id="help-h">Reading this report<\/h2>/);
  assert.match(out, /popovertargetaction="hide" autofocus>Close<\/button>/);
  for (const h2 of ['How to read this report', 'How scores work', 'Severities', 'The eight areas', 'Reading health']) assert.ok(out.includes(h2), h2);
  const doc = standaloneDocument(reading, getPlugins(), { css: '' });
  assert.match(doc, /class="btn help-btn" popovertarget="help"/);
  assert.ok(!/<script/i.test(doc));
});

test('help text: 250-450 words, names every area and verdict word', async () => {
  const { helpOverlay } = await import('../extension/ui/help.js');
  const { AREAS, VERDICT } = await import('../extension/core/score.js');
  const text = String(helpOverlay()).replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 250 && words <= 450, `${words} words`); // 400 until the "Not used during load" section (about 60 words)
  assert.match(text, /adds noticeable work during load/);
  assert.match(text, /menus, forms and later pages/);
  assert.match(text, /don't compare with readings taken without it/);
  assert.match(text, /If Chrome doesn't allow JavaScript coverage for extensions, only CSS is measured and the panel says so\./);
  assert.doesNotMatch(text, /slightly|unused|dead code|isn't available to Chrome/i);
  for (const a of AREAS) assert.ok(text.includes(a.label), a.label);
  for (const k of ['good', 'warning', 'serious', 'critical']) assert.ok(text.includes(VERDICT[k]), VERDICT[k]);
});

/* ------------------------------------------------------------ Overview (phase 3) */

const overviewOf = (out) => out.slice(out.indexOf('id="overview"'), out.indexOf('<section class="pane" id="area-'));
const overviewHtml = (reading, opts = {}) => overviewOf(renderReport(reading, getPlugins(), { interactive: false, ...opts }));
const okR = (id, findings = [], data = {}) => ({ id, name: id, status: 'ok', findings, summary: [], data });
const mini = (plugins, capture = {}, extra = {}) => ({
  log: { entries: [], pages: [], _harplus: { plugins, target: { title: 'Mini', url: 'https://mini.test/', finalUrl: 'https://mini.test/', host: 'mini.test', site: 'mini.test' }, capture, ...extra } },
});

test('overview: verdict sentence, status strip, no area cards or findings chart', () => {
  const out = overviewHtml(load());
  assert.match(out, /<p class="verdict">[^<]+<\/p>/);
  assert.match(out, /<p class="status-strip">[^]*?Reading (complete|partial|failed)/);
  assert.match(out, /Scored as General/);
  // The hero shows the page address in full, scheme included, not as URL parts.
  assert.match(out, /<div class="url"><a href="(https?:\/\/[^"]+)" target="_blank" rel="noopener noreferrer">\1<\/a><\/div>/);
  const t = load(); t.log._harplus.target.finalUrl = 'http://plain.test/a?b=1';
  assert.ok(overviewHtml(t).includes('<div class="url"><a href="http://plain.test/a?b=1" target="_blank" rel="noopener noreferrer">http://plain.test/a?b=1</a></div>'));
  t.log._harplus.target.finalUrl = 'javascript:alert(1)';
  assert.ok(overviewHtml(t).includes('<div class="url">javascript:alert(1)</div>'), 'never linked unless http(s)');
  assert.ok(!out.includes('area-card') && !out.includes('area-bars'));
  assert.ok(!out.includes('class="narrative"') && !out.includes('Fix these first'));
  // order: hero, Fix first, Areas, At a glance, Built with, Reading health
  const at = (s) => out.indexOf(s);
  const order = ['class="card hero"', '>Fix first</h2>', '>Areas</h2>', '>At a glance</h2>', '>Built with</h2>', 'id="reading-health"'].map(at);
  assert.ok(order.every((n) => n > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(out, /<div class="overall">[^]*?class="chart ring"[^]*?<small>(good|needs work|poor|failing|not measured)<\/small>/);
});

test('overview: areas table worst first with mix and count; legend', () => {
  const reading = load();
  const scores = scoreReading(reading, getPlugins());
  const out = overviewHtml(reading, { scores });
  const table = out.slice(out.indexOf('<table class="data areas"'), out.indexOf('</table>'));
  const ids = [...table.matchAll(/href="#area-([a-z]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 8);
  const sc = ids.map((id) => scores.areas[id].score);
  const measured = sc.filter((s) => s != null);
  assert.deepEqual(measured, [...measured].sort((a, b) => a - b), 'worst first');
  assert.ok(sc.indexOf(null) < 0 || sc.slice(sc.indexOf(null)).every((s) => s == null), 'unmeasured last');
  assert.equal((table.match(/class="score-bar"/g) || []).length, 8);
  const withIssues = ids.filter((id) => { const c = scores.areas[id].counts; return c.high + c.medium + c.low + c.info > 0; });
  assert.equal((table.match(/class="mix"/g) || []).length, withIssues.length);
  for (const id of ids) {
    const a = scores.areas[id];
    const row = table.slice(table.indexOf(`href="#area-${id}"`)).split('</tr>')[0];
    assert.ok(row.includes(VERDICT[a.status]), `${id} verdict word`);
    assert.match(row, new RegExp(`<td role="cell" class="num">${a.counts.high + a.counts.medium + a.counts.low + a.counts.info}</td>`), `${id} count`);
  }
  assert.match(table, /<th scope="col" role="columnheader"[^>]*>Issues by severity<\/th>/);
  // explicit roles: the narrow layout changes display on table, tbody and tr
  assert.match(table, /^<table class="data areas" role="table">/);
  assert.match(table, /<thead role="rowgroup"><tr role="row">/);
  assert.match(table, /<tbody role="rowgroup">/);
  assert.equal((table.match(/<tr role="row">/g) || []).length, 9);
  assert.equal((table.match(/<th scope="row" role="rowheader">/g) || []).length, 8);
  assert.equal((table.match(/<td role="cell"/g) || []).length, 32);
  assert.equal((table.match(/role="columnheader"/g) || []).length, 5);
  const legend = out.slice(out.indexOf('class="sev-legend"'));
  for (const s of ['high', 'medium', 'low', 'info']) {
    const total = Object.values(scores.areas).reduce((n, a) => n + a.counts[s], 0);
    assert.match(legend, new RegExp(`data-sev="${s}"[^]*?</span>\\s*<b>${total}</b>`), s);
  }
});

test('overview: fix first footer counts the rest', () => {
  const f = (severity, i) => ({ severity, category: 'security', title: `${severity} issue ${i}` });
  const findings = [...Array(6).fill(0).map((_, i) => f('high', i)), ...Array(9).fill(0).map((_, i) => f('medium', i)), f('info', 0)];
  const out = overviewHtml(mini({ security: okR('security', findings) }));
  const fix = out.slice(out.indexOf('>Fix first</h2>'), out.indexOf('>Areas</h2>'));
  assert.equal((fix.match(/<li><a class="issue"/g) || []).length, 5);
  assert.match(fix, /Then: 1 more high, 9 medium\./);
  assert.match(fix, /<a href="#issues">All 16 issues →<\/a>/);
  const few = overviewHtml(mini({ security: okR('security', [f('high', 1), f('medium', 1)]) }));
  assert.doesNotMatch(few, /Then:/);
  const onlyMed = overviewHtml(mini({ security: okR('security', [...Array(5).fill(0).map((_, i) => f('high', i)), f('medium', 1), f('medium', 2)]) }));
  assert.match(onlyMed, /Then: 2 medium\./);
});

test('overview: at a glance shows only stats with a source; no empty tiles', () => {
  const full = overviewHtml(load());
  const glance = (out) => out.slice(out.indexOf('>At a glance</h2>'), out.indexOf('id="reading-health"'));
  const g = glance(full);
  for (const label of ['Load (LCP)', 'Layout shift (CLS)', 'Page weight', 'Requests', 'CO₂ per visit']) assert.ok(g.includes(label), label);
  assert.equal((g.match(/class="stat"/g) || []).length, 5);
  assert.match(g, /\d+\.\d\d g<\/div>[^]*?rating [A-F]/);
  assert.match(g, /\d+ third-party · \d+ hosts?/);
  for (const gone of ['Hosts contacted', 'Technologies', 'Requests over time']) assert.ok(!full.includes(gone), gone);
  // Built with: 8 chips at most, then a link to Build
  const r = load();
  const tech = r.log._harplus.plugins.tech.data.technologies;
  while (tech.length < 11) tech.push({ name: `Tech ${tech.length}`, category: 'Misc' });
  const bw = overviewHtml(r);
  const built = bw.slice(bw.indexOf('>Built with</h2>'), bw.indexOf('id="reading-health"'));
  assert.equal((built.match(/<li class="badge">/g) || []).length, 8);
  assert.match(built, new RegExp(`<a href="#area-build">\\+${tech.length - 8} more in Build →</a>`));

  const r2 = load();
  delete r2.log._harplus.plugins.carbon;
  delete r2.log._harplus.plugins.tech;
  const out = overviewHtml(r2);
  assert.equal((glance(out).match(/class="stat"/g) || []).length, 4);
  assert.ok(!out.includes('CO₂') && !out.includes('Built with'));
});

test('overview: reading health closed, plain reasons, raw text under Technical detail', () => {
  const r = load();
  const raw = 'TimeoutError: Translator create timed out after 60s';
  r.log._harplus.capture.viewsSkipped = [{ view: 'translated-de', reason: raw }, { view: 'pseudo', reason: 'not needed' }, { view: 'protanopia', reason: 'disabled' }];
  r.log._harplus.capture.warnings = [`German view failed: ${raw}`]; // as capture.js words it
  r.log._harplus.tags = ['q3'];
  const out = overviewHtml(r);
  const views = readingStatus(r).views;
  const health = out.slice(out.indexOf('<details class="disclosure health" id="reading-health">'));
  assert.ok(health.length > 0);
  assert.match(health, new RegExp(`<summary>Reading health<span class="disclosure-meta">1 of ${views + 1} views skipped</span></summary>`));
  assert.match(health, /German: skipped — the on-device translator didn&#39;t load in time\./);
  assert.ok(!health.includes('Long text'), 'a fallback that was not needed is not a skip');
  assert.ok(!/protanopia|Protanopia|disabled/.test(health), 'a view switched off in settings is not a skip, nor raw text');
  assert.match(health, /tag: q3/);
  const tech = health.slice(health.indexOf('Technical detail'));
  assert.equal(tech.split(raw).length - 1, 1, 'raw reason listed once, not again beside its warning');
  assert.ok(health.indexOf('<details class="disclosure">') < health.indexOf(raw), 'raw text sits in the nested details');
  assert.match(out, /<a href="#reading-health-detail">1 view skipped<\/a>/);
  assert.match(health, /<div class="disclosure-body" id="reading-health-detail">/);
  assert.match(out, /Reading partial/);
  const clean = load();
  for (const [id, res] of Object.entries(clean.log._harplus.plugins)) if (res.status !== 'ok') delete clean.log._harplus.plugins[id];
  assert.match(overviewHtml(clean), /id="reading-health"><summary>Reading health<span class="disclosure-meta">complete<\/span>/);
  assert.match(overviewHtml(clean), /Reading complete/);
});

test('overview: no screenshot and failed reading still render', () => {
  const r = mini({ security: { id: 'security', name: 'Security', status: 'error', error: 'boom', findings: [], summary: [] } });
  let out;
  assert.doesNotThrow(() => { out = overviewHtml(r); });
  assert.match(out, /No screenshot/);
  assert.match(out, /Reading failed/);
  assert.match(out, /<span class="disclosure-meta">1 check didn&#39;t run<\/span>/);
  assert.match(out, /Checks that didn(&#39;|')t run: Security\./);
  assert.equal((out.match(/not measured/g) || []).length >= 8, true);
  assert.doesNotMatch(out, /undefined|NaN/);
});

test('reading.js opens #reading-health and #reading-health-detail on hashchange', () => {
  const js = readFileSync(new URL('../extension/ui/reading.js', import.meta.url), 'utf8');
  assert.match(js, /addEventListener\('hashchange', \(\) => \{[^\n]*openHealth\(\)/);
  assert.match(js, /HEALTH_HASHES = \['#reading-health', '#reading-health-detail'\]/);
  assert.match(js, /HEALTH_HASHES\.includes\(location\.hash\)\) document\.getElementById\('reading-health'\)\?\.setAttribute\('open', ''\)/);
  // a second click on the strip's link while the hash is already set fires no hashchange
  assert.match(js, /closest\?\.\('a\[href="#reading-health"\], a\[href="#reading-health-detail"\]'\)\) document\.getElementById\('reading-health'\)\?\.setAttribute\('open', ''\)/);
});

test('overview: not-applicable views and skipped checks get their own lines and do not make a reading partial', () => {
  const r = mini({
    security: okR('security'),
    focus: { id: 'focus', name: 'Focus', status: 'skipped', error: 'needs a live page — take a new reading', findings: [], summary: [] },
  }, { mode: 'snapshot', views: { desktop: {} }, viewsSkipped: [
    { view: 'noimages', reason: 'not in reload mode' }, { view: 'nojs', reason: 'not in reload mode' },
    { view: 'translated-de', reason: 'page is already in German' }, { view: 'breakpoints', reason: 'no px breakpoints' },
  ] });
  const out = overviewHtml(r);
  assert.match(out, /Reading complete/);
  assert.doesNotMatch(out, /Reading partial|views? skipped<\/a>/);
  assert.match(out, /<span class="disclosure-meta">complete<\/span>/);
  assert.match(out, /<p>Not applicable: No images \(not available in snapshot mode\), No JavaScript \(not available in snapshot mode\), German \(the page is already in German\), Breakpoints \(the page has no width breakpoints\)\.<\/p>/);
  assert.match(out, /<p>1 check skipped: Focus \(needs a live page — take a new reading\)\.<\/p>/);
  assert.doesNotMatch(out, /not in reload mode|no px breakpoints/, 'the raw not-applicable reasons are not repeated as technical detail');
  // A real failure next to them: only it is counted.
  r.log._harplus.capture.viewsSkipped.push({ view: 'translated-ja', reason: 'out of time for translated views' });
  const partial = overviewHtml(r);
  assert.match(partial, /Reading partial/);
  assert.match(partial, /<a href="#reading-health-detail">1 view skipped<\/a>/);
  assert.match(partial, /<span class="disclosure-meta">1 of 2 views skipped<\/span>/);
  assert.match(partial, /Japanese: skipped — it took too long\./);
});

test('overview: the status strip of an imported HAR has no device or mode', () => {
  const imported = overviewHtml(mini({ security: okR('security') }, { source: 'DevTools' }));
  const strip = imported.slice(imported.indexOf('<p class="status-strip">'), imported.indexOf('</p>', imported.indexOf('<p class="status-strip">')));
  assert.doesNotMatch(strip, /desktop|mode/);
  assert.match(imported, /<li>imported from DevTools<\/li>/);
  const own = overviewHtml(mini({ security: okR('security') }, { mode: 'snapshot', device: 'mobile' }));
  const ownStrip = own.slice(own.indexOf('<p class="status-strip">'), own.indexOf('</p>', own.indexOf('<p class="status-strip">')));
  assert.match(ownStrip, /<span>mobile<\/span><span>snapshot mode<\/span>/);
});

test('theme: the narrow Areas panel hides only the mix column; the score number stays', () => {
  const css = readFileSync(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  const narrow = css.slice(css.indexOf('@container areas (max-width: 30rem)'));
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /</, 'no "<" in rules: the export escapes it, which breaks range syntax');
  assert.match(css, /\.areas-panel \{ container: areas \/ inline-size; \}/);
  assert.match(narrow, /table\.areas \.mix-col \{ display: none; \}/);
  assert.doesNotMatch(css, /score-num[^{]*\{[^}]*display: none/);
});

/* ------------------------------------------------------- area pane (phase 4) */

const paneOf = (out, id) => {
  const s = String(out);
  const i = s.indexOf(`<section class="pane" id="area-${id}"`);
  const j = s.indexOf('<section class="pane"', i + 1);
  return s.slice(i, j < 0 ? undefined : j);
};
const areaHtml = (id, reading = load(), opts = {}, plugins = getPlugins()) => paneOf(renderReport(reading, plugins, { interactive: false, ...opts }), id);
const PARTS = ['checks', 'issues', 'measurements', 'data'];
/** One of the pane's own sections: from its id to the next one's (Plugin data runs to the end). */
const partOf = (pane, area, part) => {
  const i = pane.indexOf(`id="${area}-${part}"`);
  const next = PARTS[PARTS.indexOf(part) + 1];
  return pane.slice(i, next ? pane.indexOf(`id="${area}-${next}"`) : undefined);
};
// plugins of our own, so the test controls glance and area: p1 draws a chart, p2 has only rated tiles, v visits content from build
const ownPlugins = [
  { id: 'p1', name: 'Chart plugin', area: 'content', glance: (r, hh) => hh.html`<b class="g1">G1</b>` },
  { id: 'p2', name: 'Tile plugin', area: 'content' },
  { id: 'v', name: 'Visitor', area: 'build' },
  { id: 'q', name: 'Quiet', area: 'content' },
];
const ownReading = () => mini({
  p1: { ...okR('p1', [{ severity: 'high', category: 'content', title: 'Big' }, { severity: 'low', category: 'content', title: 'Small' }]), name: 'Chart plugin', durationMs: 12, summary: [{ label: 'Score', value: '40', headline: true }] },
  p2: { ...okR('p2'), name: 'Tile plugin', summary: [{ label: 'Speed', value: '1 s', rating: 'good' }, { label: 'Plain', value: 'unrated' }] },
  v: { ...okR('v', [{ severity: 'medium', category: 'content', title: 'Visiting' }]), name: 'Visitor' },
  q: { id: 'q', name: 'Quiet', status: 'skipped', findings: [], summary: [] },
});

test('plugin data meta line: the three busiest hosts, the rest folded', () => {
  const reading = ownReading();
  const hosts = (n) => Array.from({ length: n }, (_, i) => ({ host: `h${i}.test`, count: i + 1 }));
  reading.log._harplus.plugins.p1.contacted = hosts(5);
  reading.log._harplus.plugins.p2.contacted = hosts(2);
  const pane = areaHtml('content', reading, {}, ownPlugins);
  const p1 = pane.slice(pane.indexOf('id="p-p1"'), pane.indexOf('id="p-p2"'));
  assert.match(p1, /<p class="meta">12 ms · contacted h4\.test ×5, h3\.test ×4, h2\.test ×3<\/p><details class="disclosure fold"><summary>2 more hosts<\/summary><div class="disclosure-body"><p class="meta">h1\.test ×2, h0\.test ×1<\/p>/);
  const p2 = pane.slice(pane.indexOf('id="p-p2"'));
  assert.match(p2, /<p class="meta">contacted h1\.test ×2, h0\.test ×1<\/p>/);
  assert.doesNotMatch(p2.slice(0, p2.indexOf('</details>')), /more host/);
});

test('area pane: five parts in order, jump bar links resolve to section ids', () => {
  const pane = areaHtml('accessibility');
  const order = ['class="card area-head', 'class="jump"', 'id="accessibility-checks"', 'id="accessibility-issues"', 'id="accessibility-measurements"', 'id="accessibility-data"'];
  assert.deepEqual(order.map((s) => pane.indexOf(s)).every((i, n, a) => i > -1 && (n === 0 || i > a[n - 1])), true);
  for (const s of PARTS) assert.match(pane, new RegExp(`href="#accessibility-${s}"`));
  assert.match(pane, /<nav class="jump" aria-label="Accessibility sections">/);
  for (const s of PARTS) assert.match(pane, new RegExp(`<section class="panel[^"]*" id="accessibility-${s}" aria-labelledby="accessibility-${s}-h">`));
  // header: ring, h1 with the grade (class grade) and the verdict word, the sentence, scoring details
  const head = pane.slice(0, pane.indexOf('class="jump"'));
  assert.match(head, /<h1 id="area-accessibility-h">Accessibility <span class="grade status-[a-z]+">[A-F]<\/span> <span class="verdict-word status-[a-z]+">[a-z ]+<\/span><\/h1>/);
  assert.match(head, /<p class="area-sum">[^<]* from \d+ checks( \([^)]*\))?\.[^<]*<\/p>/);
  assert.match(head, /<details class="scoring">/);
  assert.doesNotMatch(pane, /Plugin detail/);
});

test('jump bar counts: checks, issues and plugin data', () => {
  const pane = areaHtml('content', ownReading(), {}, ownPlugins);
  const nav = pane.slice(pane.indexOf('<nav class="jump"'), pane.indexOf('</nav>'));
  assert.match(nav, /href="#content-checks">Checks <b>4<\/b><\/a>/);
  assert.match(nav, /href="#content-issues">Issues <b>3<\/b><\/a>/);
  assert.match(nav, /href="#content-measurements">Measurements<\/a>/);
  assert.match(nav, /href="#content-data">Plugin data <b>3<\/b><\/a>/);
});

test('checks table: one row per Checks row, result word, counts link, data link, roles', () => {
  const pane = areaHtml('content', ownReading(), {}, ownPlugins);
  const checks = partOf(pane, 'content', 'checks');
  assert.match(checks, /<h2 id="content-checks-h">Checks<\/h2>/);
  assert.match(checks, /<table class="data checks" role="table">/);
  for (const c of ['Check', 'Result', 'Reading', 'Issues', 'Data']) assert.match(checks, new RegExp(`<th scope="col" role="columnheader"[^>]*>${c}</th>`));
  const rows = [...checks.matchAll(/<tr role="row">([^]*?)<\/tr>/g)].map((m) => m[1]).slice(1);
  assert.equal(rows.length, 4, 'p1, p2, q home; v visiting');
  const [p1, p2, q, v] = rows;
  assert.match(p1, /<th scope="row" role="rowheader">Chart plugin<\/th>/);
  assert.match(p1, /<span class="status" data-status="poor">failing<\/span>/);
  assert.match(p1, /<td role="cell" class="reading">Score 40<\/td>/);
  assert.match(p1, /<a href="#content-issues">1 high · 1 low<\/a>/);
  assert.match(p1, /<a href="#pd-p1">Data<span class="sr-only"> for Chart plugin<\/span><\/a>/);
  assert.match(p2, /data-status="good">passing</);
  assert.match(p2, /<td role="cell" class="issues">No issues<\/td>/, 'reads alone at 390 px, where the header is hidden');
  assert.match(q, /<span class="status" data-status="none">skipped<\/span>/, 'the state word alone, with no hidden (unknown)');
  assert.match(q, /<td role="cell" class="reading">—<\/td>/, 'no error text: a dash');
  assert.match(v, /Visitor[^]*data-status="fair">needs work<[^]*1 medium[^]*href="#pd-v"/);
  for (const r of rows) assert.equal((r.match(/role="cell"/g) || []).length, 4);
});

test('checks: the Not run note sits under the table, interactive only', () => {
  const plugins = [...ownPlugins, { id: 'nr', name: 'Never ran', area: 'content' }];
  const live = partOf(areaHtml('content', ownReading(), { interactive: true }, plugins), 'content', 'checks');
  assert.match(live, /<\/table>[^]*<p class="note">Not run: Never ran/);
  assert.doesNotMatch(partOf(areaHtml('content', ownReading(), {}, plugins), 'content', 'checks'), /Not run/);
});

test('issues: grouped with h3 headings, Open in Issues link always present when there are issues', () => {
  const pane = areaHtml('content', ownReading(), {}, ownPlugins);
  const part = partOf(pane, 'content', 'issues');
  assert.match(part, /<h2 id="content-issues-h">Issues<\/h2>/);
  assert.match(part, /<h3 class="issue-group">/);
  assert.doesNotMatch(part, /<h2 class="issue-group">/);
  assert.match(part, /<details class="disclosure issue-fold" data-group="low">/, 'Low folded, closed');
  assert.match(part, /<a class="more" href="#issues" data-area="content">Open in Issues →<\/a>/);
  assert.doesNotMatch(part, /<span>Content<\/span>/, 'no area on the rows');
  const empty = partOf(areaHtml('international', ownReading(), {}, ownPlugins), 'international', 'issues');
  assert.match(empty, /No issues\./);
  assert.doesNotMatch(empty, /Open in Issues/);
});

test('measurements: one panel per glance, Key readings for rated summaries, empty line when none', () => {
  const part = partOf(areaHtml('content', ownReading(), {}, ownPlugins), 'content', 'measurements');
  assert.match(part, /<h2 id="content-measurements-h">Measurements<\/h2>/);
  assert.match(part, /<div class="measure-grid">/);
  assert.match(part, /<section class="panel measure" aria-labelledby="m-p1-h"><div class="panel-head"><h3 id="m-p1-h">Chart plugin<\/h3><\/div><div class="panel-body"><b class="g1">G1<\/b>/);
  assert.match(part, /<h3 id="m-content-key-h">Key readings<\/h3>[^]*<div class="stats">[^]*Speed[^]*1 s/);
  assert.doesNotMatch(part, /unrated/, 'only rated tiles');
  assert.doesNotMatch(part, /class="glance"/);
  const empty = partOf(areaHtml('international', ownReading(), {}, ownPlugins), 'international', 'measurements');
  assert.match(empty, /<p class="muted">No measurements\.<\/p>/);
});

test('plugin data: closed details.plugin with p-<id> for home plugins; a11y-map open with the page map after it', () => {
  const pane = areaHtml('content', ownReading(), {}, ownPlugins);
  const part = partOf(pane, 'content', 'data');
  assert.match(part, /<h2 id="content-data-h">Plugin data<\/h2>/);
  assert.deepEqual([...part.matchAll(/<details class="plugin disclosure" id="p-([a-z0-9-]+)"( open)?>/g)].map((m) => [m[1], !!m[2]]), [['p1', false], ['p2', false], ['q', false]]);
  assert.doesNotMatch(pane, /id="p-v"/, 'a visitor keeps its panel in its home pane');
  assert.match(areaHtml('build', ownReading(), {}, ownPlugins), /id="p-v"/);
  const p1 = part.slice(part.indexOf('id="p-p1"'), part.indexOf('</details>', part.indexOf('id="p-p1"')));
  assert.match(p1, /<summary><span class="name">Chart plugin<\/span><span class="plugin-count">2 issues<\/span><span class="status" data-status="poor">failing<\/span><\/summary>/);
  assert.match(p1, /<div class="content" id="pd-p1"><p class="meta">12 ms<\/p>/);
  assert.match(part, /<details class="raw" data-raw="p1"><summary>Raw data<\/summary><\/details>/);
  // a11y-map: open, the page map right after it
  const a11y = areaHtml('accessibility', withMarks(MARKS));
  assert.match(a11y, /<details class="plugin disclosure" id="p-a11y-map" open>/);
  const end = a11y.indexOf('</details>', a11y.indexOf('<details class="raw" data-raw="a11y-map">'));
  assert.match(a11y.slice(end), /^<\/details>\s*<\/div>\s*<\/details>\s*<details class="plugin pm-panel" id="p-page-map" open>/);
});

test('plugin data: the summary word covers the same issues as its count (all areas), never "passing" beside an issue', () => {
  // v lives in Build but its one issue scores in Content: its row in Build has no issues, its summary still does.
  const v = (reading) => { const s = areaHtml('build', reading, {}, ownPlugins); return s.slice(s.indexOf('id="p-v"'), s.indexOf('</summary>', s.indexOf('id="p-v"'))); };
  assert.match(v(ownReading()), /<span class="plugin-count">1 issue<\/span><span class="status" data-status="fair">needs work<\/span>$/);
  const high = ownReading();
  high.log._harplus.plugins.v.findings[0].severity = 'high';
  assert.match(v(high), /<span class="plugin-count">1 issue<\/span><span class="status" data-status="poor">failing<\/span>$/);
  const none = ownReading();
  none.log._harplus.plugins.v.findings = [];
  assert.match(v(none), /<span class="name">Visitor<\/span><span class="status" data-status="good">passing<\/span>$/);
  assert.doesNotMatch(v(ownReading()), /passing/);
});

test('theme: in print the large area panels, sub-panels and Views cards may break; measurement panels stay whole', () => {
  const css = readFileSync(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  const print = css.slice(css.indexOf('@media print'));
  const block = print.slice(0, print.indexOf('\n  }\n'));
  assert.match(block, /\.panel, \.stat \{ break-inside: avoid; \}/);
  const auto = block.match(/\n\s*([^{}\n]*)\{ break-inside: auto; \}/);
  assert.ok(auto, 'a break-inside: auto rule');
  const sels = auto[1].split(',').map((x) => x.trim());
  for (const sel of ['.area-part', '.panel.sub', '.card.views']) assert.ok(sels.includes(sel), sel);
  assert.ok(block.indexOf('break-inside: auto') > block.indexOf('.panel, .stat { break-inside: avoid; }'), 'after the avoid rule, so it wins');
  assert.ok(!sels.some((x) => /measure|fix-first|areas-panel/.test(x)), 'small panels keep avoid');
  assert.match(css, /\.area-head \{ display: flex; align-items: flex-start;/);
});

test('every area pane has the same five sections, even when nothing ran', () => {
  const r = { log: { entries: [], pages: [], _harplus: { plugins: {}, target: {}, capture: {}, screenshots: [] } } };
  const out = renderReport(r, getPlugins(), { interactive: false });
  for (const a of ['performance', 'accessibility', 'security', 'content', 'build', 'infrastructure', 'international', 'sustainability']) {
    const pane = paneOf(out, a);
    for (const s of PARTS) assert.match(pane, new RegExp(`id="${a}-${s}"`), `${a}-${s}`);
    assert.match(partOf(pane, a, 'checks'), /<p class="muted">No checks ran\.<\/p>/);
    assert.match(partOf(pane, a, 'measurements'), /<p class="muted">No measurements\.<\/p>/);
    assert.match(partOf(pane, a, 'data'), /<p class="muted">No plugins in this area ran\.<\/p>/);
    assert.match(pane, /Not measured — no plugin in this area ran successfully\./);
    assert.match(pane, /<span class="verdict-word status-none">not measured<\/span>/);
  }
});

test('export: no <script>; jump links are plain anchors', () => {
  const doc = standaloneDocument(load(), getPlugins());
  assert.doesNotMatch(doc, /<script/i);
  const at = doc.indexOf('<nav class="jump" aria-label="Security sections">');
  assert.ok(at > -1);
  const nav = doc.slice(at, doc.indexOf('</nav>', at));
  assert.match(nav, /^<nav class="jump" aria-label="Security sections"><a href="#security-checks">/);
  assert.doesNotMatch(nav, /onclick|data-pane|<button/);
});

test('theme: jump bar hidden in print; Checks table reflows under max-width; measurements two columns', () => {
  const css = readFileSync(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  const print = css.slice(css.indexOf('@media print'));
  assert.match(print.slice(0, print.indexOf('\n  }\n')), /nav\.jump/);
  assert.match(css, /@media \(max-width: 560px\) \{[^]*?table\.checks tr \{ display: grid;/);
  assert.match(css, /\.measure-grid \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 26rem\), 1fr\)\)/);
  assert.doesNotMatch(css, /\.plugin-detail|\.glance \{|\.glance \.card/);
});

test('theme: h.checks status styles stay on ul.checks; the Checks table drops every last-row border; glance cards draw flat in Measurements', () => {
  const css = readFileSync(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  assert.match(css, /\n  ul\.checks \.status \{/);
  assert.doesNotMatch(css, /\n  \.checks \.status \{/, 'not table.checks too');
  assert.match(css, /table\.checks tbody tr:last-child > \* \{ border-bottom: 0; \}/);
  assert.match(css, /\.area-issues \.panel-foot a\.more \{ margin: 0; margin-inline-start: auto; \}/);
  assert.match(css, /, \.measure \.card \{ border: 0; background: none; \}/);
  // A measurement table's first column gets a floor, not overflow-wrap: normal/break-word (a long URL would overflow).
  assert.match(css, /\.measure table\.data td:first-child \{ min-width: 9ch; \}/);
  assert.doesNotMatch(css, /\.measure table\.data td:first-child \{ overflow-wrap/);
});

test('export inlines Instrument Sans as data: URLs and no url() points off-file', () => {
  const css = '@font-face{src:url("fonts/instrument-sans-latin-wght.woff2") format("woff2")}'
    + '@font-face{font-family:"IBM Plex Mono";src:url("fonts/ibm-plex-mono-latin-400.woff2") format("woff2")}a{color:red}';
  const doc = standaloneDocument(withViews(), getPlugins(), { css, fonts: { 'fonts/instrument-sans-latin-wght.woff2': 'AAAA' } });
  const style = doc.slice(doc.indexOf('<style>'), doc.indexOf('</style>'));
  assert.match(style, /url\("?data:font\/woff2;base64,AAAA"?\)/);
  assert.ok(!/fonts\//.test(style), 'unmapped font-face blocks are dropped');
  assert.match(style, /a\{color:red\}/);
  assert.ok(!/url\((?!"?data:)/.test(style));
});

test('theme.css: compact app bar at narrow widths, darker Help backdrop, bordered Help', () => {
  const css = readFileSync(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 560px\)\s*\{[\s\S]*?\.appbar-title[^{]*\{\s*display: none/);
  assert.match(css, /\.help::backdrop\s*\{\s*background: light-dark\(rgb\(0 0 0 \/ 0\.45\), rgb\(0 0 0 \/ 0\.7\)\)/);
  assert.match(css, /\.help\s*\{[^}]*border: 1px solid var\(--line-strong\)/);
  assert.ok(!css.replace(/\/\*[\s\S]*?\*\//g, '').includes('<'), 'no < outside comments');
});

test('screens pane has a pane-head like Issues and Network', () => {
  assert.match(screens(renderReport(withViews(), getPlugins())), /<header class="pane-head"><h1 id="screens-h">Screens<\/h1><\/header>/);
});
