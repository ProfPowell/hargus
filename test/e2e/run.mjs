// End-to-end test: loads the unpacked extension into Chromium (Playwright), serves a local
// test site, takes readings in reload / mobile / snapshot / record modes and renders the viewer.
// Needs Playwright with Chromium: `npm i -g playwright && npx playwright install chromium`.
// Output (screenshots + exported readings) goes to test/e2e/out/.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from './server.mjs';
import { stripStyles, fnSource, measureView, hideInlineImages, viewProbe } from '../../extension/browser/capture.js';
import { translatePage, restoreTranslation, leftoverText } from '../../extension/browser/translate-view.js';
import content from '../../extension/plugins/content.js';
import contrastPlugin from '../../extension/plugins/contrast.js';
import a11yBasics from '../../extension/plugins/a11y-basics.js';
import a11yStructure from '../../extension/plugins/a11y-structure.js';
import { VAGUE_LINK_WORDS } from '../../extension/core/link-text.js';
import { JS_UNAVAILABLE } from '../../extension/core/coverage.js';

const A11Y_NAMES_PAGE = `<body>
  <button type="button" class="contents-btn" style="display:contents"></button>
  <div style="display:none"><button type="button" class="contents-in-hidden" style="display:contents"></button></div>
  <button type="button" class="hidden-img-btn"><img alt="Search" style="display:none"></button>
  <a href="/x" class="svg-title-link"><svg width="10" height="10"><title>Home</title><circle cx="5" cy="5" r="4"/></svg></a>
  <a href="/y" class="lb-link"><span aria-label="" aria-labelledby="lb-text"></span></a><span id="lb-text">Labelled</span>
</body>`;

// A stand-in for Chrome's on-device Translator (Playwright's Chromium cannot translate). Test-only: the harness
// injects it into the captured tab's main world; the extension has no test branch. German grows each word by
// "ung", Arabic and Japanese replace each word with a fixed word in their own script.
const FAKE_TRANSLATOR = () => {
  const word = { ar: 'كلمة', ja: 'テキスト' };
  const fake = (text, lang) => String(text).replace(/\S+/g, (w) => (lang === 'de' ? `${w}ung` : word[lang] || w));
  globalThis.Translator = {
    availability: async () => 'downloadable',
    create: async ({ targetLanguage }) => ({ translate: async (t) => fake(t, targetLanguage), destroy() {} }),
  };
};
const NO_TRANSLATOR = () => { delete globalThis.Translator; };
const TRANSLATED = ['translated-de', 'translated-ar', 'translated-ja'];

const here = fileURLToPath(new URL('.', import.meta.url));
const EXT = resolve(here, '../../extension');
const OUT = process.env.HARPLUS_E2E_OUT || join(here, 'out');
// Baseline data: a small fixture unless HARPLUS_E2E_WF points at a full web-features data.json.
process.env.HARPLUS_E2E_WF ||= resolve(here, '../fixtures/web-features-subset.json');
const FULL_FINGERPRINTS = !!process.env.HARPLUS_E2E_WA; // path to a webappanalyzer/src checkout

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* fall back to a global install */ }
  const root = execSync('npm root -g').toString().trim();
  return import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
}

const log = (...a) => console.log('·', ...a);

/**
 * In the page: every visible element under `selectors` that holds its own text, with its text colour composited over
 * the nearest opaque background (alpha layers on the way down are composited too). Colours go through a 1×1 canvas,
 * so light-dark(), color-mix() and color(srgb …) all come back as sRGB bytes.
 */
function collectTextColours(selectors) {
  const cv = Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => {
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = '#000';
    cx.fillStyle = c;
    cx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = cx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const background = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c.a > 0) layers.push(c);
      if (c.a >= 1) break;
    }
    let bg = layers.at(-1)?.a >= 1 ? layers.pop() : { r: 255, g: 255, b: 255, a: 1 };
    for (const l of layers.reverse()) bg = over(l, bg);
    return bg;
  };
  const out = [];
  for (const sel of selectors) {
    for (const root of document.querySelectorAll(sel)) {
      for (const el of [root, ...root.querySelectorAll('*')]) {
        const own = [...el.childNodes].filter((t) => t.nodeType === 3).map((t) => t.textContent).join('').trim();
        if (!own || !el.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) || el.closest('.sr-only')) continue;
        const cs = getComputedStyle(el);
        const bg = background(el);
        out.push({ sel, text: own.slice(0, 40), fg: over(rgba(cs.color), bg), bg, size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) || 400 });
      }
    }
  }
  return out;
}

/** WCAG 1.4.3 failures among collectTextColours' results: 4.5:1, or 3:1 for large text (24px, or 18.66px bold). */
async function contrastFailures(page, selectors) {
  const { wcagRatio } = await import('../../extension/core/color.js');
  const items = await page.evaluate(collectTextColours, selectors);
  const checked = items.map((x) => ({ ...x, ratio: wcagRatio(x.fg, x.bg), need: x.size >= 24 || (x.size >= 18.66 && x.weight >= 700) ? 3 : 4.5 }));
  return { checked, failures: checked.filter((x) => x.ratio < x.need).map((x) => `${x.sel} “${x.text}” ${x.ratio.toFixed(2)}:1 < ${x.need}`), min: Math.min(...checked.map((x) => x.ratio)) };
}

/** Whole-page contrast in light and dark: no failures, at least one text checked; logs the minimum ratio. */
async function pageContrast(page, label, selectors = ['body']) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    const c = await contrastFailures(page, selectors);
    assert.ok(c.checked.length > 0, `${label} ${scheme}: contrast found text to check`);
    assert.deepEqual(c.failures, [], `${label} ${scheme} contrast`);
    log(`${label} contrast ${scheme}: ${c.checked.length} texts, min ${c.min.toFixed(2)}:1`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Help opens from its button, is centred, fits 85dvh, scrolls inside itself with Close in reach; Esc and Close hide it and focus returns. */
async function checkHelp(page, label) {
  const btn = page.locator('button.help-btn');
  const isOpen = () => page.evaluate(() => document.getElementById('help').matches(':popover-open'));
  const onButton = () => page.evaluate(() => document.activeElement?.matches('button.help-btn'));
  await btn.click();
  assert.equal(await isOpen(), true, `${label}: Help opens`);
  assert.equal(await page.evaluate(() => document.activeElement?.matches('#help .help-close')), true, `${label}: Close has focus when Help opens`);
  const geo = await page.evaluate(() => {
    const help = document.getElementById('help');
    const r = help.getBoundingClientRect();
    help.scrollTop = help.scrollHeight;
    const c = document.querySelector('#help .help-close').getBoundingClientRect();
    const hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
    const res = {
      dx: Math.abs(r.left - (innerWidth - r.right)), dy: Math.abs(r.top - (innerHeight - r.bottom)),
      tall: r.height / innerHeight, scrolls: help.scrollHeight > help.clientHeight, scrolledTo: help.scrollTop,
      closeInView: c.top >= r.top && c.bottom <= r.bottom && c.left >= r.left && c.right <= r.right, closeHit: !!hit?.closest('.help-close'),
      backdrop: getComputedStyle(help, '::backdrop').backgroundColor, sideways: help.scrollWidth - help.clientWidth,
    };
    help.scrollTop = 0;
    return res;
  });
  assert.ok(geo.dx <= 2 && geo.dy <= 2, `${label}: Help is centred ${JSON.stringify(geo)}`);
  assert.ok(geo.tall <= 0.851, `${label}: Help is at most 85dvh tall ${JSON.stringify(geo)}`);
  assert.ok(!geo.scrolls || geo.scrolledTo > 0, `${label}: Help scrolls inside itself ${JSON.stringify(geo)}`);
  assert.ok(geo.closeInView && geo.closeHit, `${label}: Close is in reach when scrolled to the end ${JSON.stringify(geo)}`);
  assert.ok(geo.sideways <= 1, `${label}: Help does not scroll sideways ${JSON.stringify(geo)}`);
  assert.notEqual(geo.backdrop, 'rgba(0, 0, 0, 0)', `${label}: Help has a backdrop`);
  await page.keyboard.press('Escape');
  assert.equal(await isOpen(), false, `${label}: Esc closes Help`);
  assert.equal(await onButton(), true, `${label}: focus returns to Help after Esc`);
  await btn.click();
  await page.locator('#help .help-close').click();
  assert.equal(await isOpen(), false, `${label}: Close closes Help`);
  assert.equal(await onButton(), true, `${label}: focus returns to Help after Close`);
  return geo;
}

/** Help at both widths and in both schemes. */
async function checkHelpEverywhere(page, label) {
  const vp = page.viewportSize();
  for (const [w, h] of [[1280, 800], [390, 844]]) {
    for (const scheme of ['light', 'dark']) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme });
      await checkHelp(page, `${label} ${w} ${scheme}`);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize(vp);
}

async function main() {
  const { chromium } = await loadPlaywright();
  await mkdir(OUT, { recursive: true });
  const site = await startServer();
  const base = `http://127.0.0.1:${site.port}`;
  const profile = await mkdtemp(join(tmpdir(), 'harplus-e2e-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const errors = [];
  try {
    const ours = (w) => w.url().endsWith('/background.js');
    let sw = context.serviceWorkers().find(ours);
    sw ||= await context.waitForEvent('serviceworker', { predicate: ours });
    // The worker can be visible before extension APIs are bound — wait until it is ready.
    for (let i = 0; i < 50 && !(await sw.evaluate(() => !!(globalThis.harplus && chrome.tabs)).catch(() => false)); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const extId = new URL(sw.url()).host;
    const extUrl = (p) => `chrome-extension://${extId}/${p}`;
    log('extension loaded', extId);

    const page = await context.newPage();
    page.on('pageerror', (e) => { if (!/e2e uncaught/.test(e.message)) errors.push(`site: ${e.message}`); });
    await page.addInitScript(FAKE_TRANSLATOR);
    await page.goto(`${base}/old`);
    await page.waitForLoadState('load');
    const tabId = await sw.evaluate(async (pattern) => (await chrome.tabs.query({ url: pattern }))[0]?.id, `${base}/*`);
    assert.ok(tabId, 'found the test tab');

    // Settings for the run: keep lookups on (they hit the local site / skip private IPs). Load coverage is on
    // explicitly, so the coverage check passes whatever the default is.
    await sw.evaluate(async ({ base, full }) => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, capture: { ...(settings.capture || {}), coverage: true }, ui: { openWhenDone: false }, plugins: {
        history: { enabled: false },
        'html-validate': { options: { endpoint: `${base}/__mock/nu/` } },
        'css-validate': { options: { endpoint: `${base}/__mock/css` } },
        carbon: { options: { endpoint: `${base}/__mock/greencheck/` } },
        baseline: { options: { dataUrl: `${base}/__data/web-features.json` } },
        tech: { options: { fingerprintDb: full, fingerprintSource: `${base}/__data/wa` } },
      } } });
    }, { base, full: FULL_FINGERPRINTS });

    const widthBefore = await page.evaluate(() => innerWidth);
    const rootFontBefore = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    // 1. reload reading (desktop)
    const t0 = Date.now();
    const page2 = await context.newPage();
    page2.on('pageerror', (e) => errors.push(`viewer: ${e.message}`));
    page2.on('console', (m) => { if (m.type() === 'error') errors.push(`viewer console: ${m.text()}`); });
    await page2.goto(extUrl('ui/library.html'));
    const progressTexts = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        for (const pg of context.pages()) {
          if (!pg.url().includes('/ui/reading.html')) continue;
          try { progressTexts.push(await pg.evaluate(() => [...document.querySelectorAll('.prog-text')].map((x) => x.textContent).join('|'))); } catch { /* navigating */ }
        }
        await new Promise((res) => setTimeout(res, 100));
      }
    })();
    await sw.evaluate((t) => { globalThis.__cap1 = globalThis.harplus.capture(t, { mode: 'reload' }); }, tabId);
    let coreSeen = null;
    for (const until = Date.now() + 90_000; Date.now() < until && !coreSeen;) {
      const rid = await sw.evaluate((t) => globalThis.harplus.status.get(t)?.readingId ?? null, tabId).catch(() => null);
      if (rid) {
        const r = await page2.evaluate(async (x) => (await import('/browser/store.js')).getReading(x), rid);
        if (r?.log._harplus.capture.viewsPending) coreSeen = { rid, hasViews: !!r.log._harplus.capture.views };
      }
      if (!coreSeen) await new Promise((res) => setTimeout(res, 200));
    }
    const id1 = await sw.evaluate(() => globalThis.__cap1);
    assert.ok(coreSeen, 'the core reading was saved with viewsPending before the views finished');
    assert.equal(coreSeen.rid, id1);
    assert.equal(coreSeen.hasViews, false, 'core reading has no views yet');
    log('reload reading', id1, `${Date.now() - t0} ms`);
    const getReading = (id) => page2.evaluate(async (rid) => (await import('/browser/store.js')).getReading(rid), id);
    const waitDone = async (rid, ms = 120_000) => {
      const t = Date.now();
      for (;;) {
        const r = await getReading(rid);
        if (r && r.log._harplus.analysis === 'done') return r;
        if (Date.now() - t > ms) throw new Error(`analysis for ${rid} not done after ${ms / 1000}s`);
        await new Promise((res) => setTimeout(res, 500));
      }
    };
    let r1;
    try {
      const tabUrls = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url));
      assert.ok(tabUrls.some((u) => {
        try {
          const q = new URL(u).searchParams;
          return u.includes('/ui/reading.html') && (q.get('capture') === String(tabId) || q.get('id') === id1);
        } catch { return false; }
      }), `progress tab open: ${tabUrls.join(', ')}`);
      r1 = await waitDone(id1);
      const hp1 = r1.log._harplus;
      assert.equal(hp1.capture.viewsPending, undefined, 'views merged');
      assert.ok(hp1.capture.views && Object.keys(hp1.capture.views).length > 3, 'views present');
      assert.ok(hp1.timing && hp1.timing.totalMs >= hp1.timing.coreMs && hp1.timing.analysisMs > 0, `timing: ${JSON.stringify(hp1.timing)}`);
      const timed = new Set((hp1.capture.viewTimings || []).map((v) => v.view));
      for (const v of new Set(hp1.screenshots.map((s) => s.view).filter((v) => v && v !== hp1.capture.device && v !== 'desktop'))) assert.ok(timed.has(v), `viewTimings has ${v}`);
      assert.equal(await page2.evaluate(async (x) => (await import('/browser/store.js')).getViewsPatch(x), id1), null, 'patch deleted after merge');
    } finally {
      polling = false;
      await poller;
    }
    assert.ok(progressTexts.some((t) => /Checking links \d+\/\d+/.test(t)), `link check progress shown: ${progressTexts.filter(Boolean).slice(-5).join(' || ')}`);
    const pc = r1.log._harplus.plugins;
    const cov = r1.log._harplus.coverage;
    const covShape = JSON.stringify(cov && { js: cov.js?.skipped ?? cov.js?.fileCount, css: cov.css?.skipped ?? cov.css?.fileCount, skipped: cov.skipped });
    assert.ok(cov?.css?.fileCount > 0, `load coverage measured stylesheets: ${covShape}`);
    assert.ok(cov.js?.fileCount > 0 || cov.js?.skipped === JS_UNAVAILABLE, `JS coverage is measured or carries the skip reason: ${covShape}`);
    assert.equal(pc.coverage?.status, 'ok', `coverage: ${pc.coverage?.error || pc.coverage?.reason}`);
    log('load coverage:', `JS ${cov.js.skipped ? 'skipped' : `${cov.js.fileCount} scripts`}, ${cov.css.fileCount} stylesheets`);
    assert.equal(pc.content?.status, 'ok', `content: ${pc.content?.error}`);
    // The accessibility plugins ran, so Content keeps vague links and missing anchors in its panel data but emits no finding for them.
    assert.ok(!pc.content.findings.some((f) => /links? with vague text|missing in-page anchors/.test(f.title)), 'Content yields vague-link and anchor findings');
    assert.ok(pc.content.data.links.vague.length >= 1 && pc.content.data.links.missing.length >= 2, 'the items stay in the Content panel data');

    assert.equal(pc.links?.status, 'ok', `links: ${pc.links?.error}`);
    const bk = pc.links.data.broken;
    const mp = bk.internal.find((x) => x.url.endsWith('/missing-page'));
    assert.ok(mp && mp.status === 404 && mp.sources.length === 2 && mp.sources.every((s) => s.line > 0), `/missing-page used twice with lines: ${JSON.stringify(mp)}`);
    assert.ok(mp.sources.some((s) => s.region && s.selector), `a link source carries region and selector (Content collect): ${JSON.stringify(mp.sources)}`);
    assert.ok(mp.sources.every((s) => s.region === 'main'), `/missing-page is linked from <main>: ${JSON.stringify(mp.sources)}`);
    assert.ok(!bk.internal.some((x) => /#nowhere$/.test(x.url)), `#nowhere is not an internal item: ${JSON.stringify(bk.internal.map((x) => x.url))}`);
    const mbg = bk.internal.find((x) => x.url.endsWith('/img/missing-bg.png'));
    assert.ok(mbg && mbg.kind === 'image' && mbg.sources.some((s) => /app\.css$/.test(s.file || '') && s.line > 0), `CSS background image broken with file + line: ${JSON.stringify(mbg)}`);
    assert.ok(bk.page.some((x) => x.url.endsWith('#nowhere')), `#nowhere on this page: ${JSON.stringify(bk.page)}`);
    assert.ok(pc.links.supersedes.includes('network:asset-errors'), `supersedes: ${pc.links.supersedes}`);
    assert.ok(pc.links.findings.some((f) => /links redirect/.test(f.title)), 'redirect found');
    assert.equal(pc.links.data.ogImage?.width, 1600);
    const chk = pc.links.data.checked.find((x) => x.url.endsWith('/head-400'));
    assert.deepEqual([chk?.status, chk?.method], [200, 'GET'], JSON.stringify(chk));
    assert.ok(!pc.links.findings.some((f) => /head-400/.test(f.title)), 'HEAD-hostile page not reported broken');
    assert.match(pc.links.summary.find((s) => s.label === 'Link check').value, /^\d+ of \d+ checked · /);
    log('content + link check passed');
    const av = r1.log._harplus.plugins['a11y-views'];
    assert.equal(av?.status, 'ok', `a11y-views: ${av?.error}`);
    const avTitles = av.findings.map((f) => f.title);
    assert.ok(avTitles.includes('Page scrolls horizontally at 320 px (WCAG 1.4.10)'), avTitles.join(' | '));
    assert.ok(avTitles.includes('1 fixed or sticky overlays print over content'), avTitles.join(' | '));
    assert.ok(!avTitles.includes('No print styles'), 'the site has a print rule');
    assert.ok(avTitles.includes('Text ignores the browser\'s font-size setting'), 'px-sized body text flagged');
    log('accessibility views passed');
    const pcx = r1.log._harplus.plugins.contrast;
    assert.equal(pcx?.status, 'ok', `contrast: ${pcx?.error}`);
    // One contrast-pair finding covers every failing element; the pairs themselves are in data.pairs.
    const pairs = pcx.data?.pairs || [];
    const faint = pairs.find((p) => p.fg === '#999999' && p.bg === '#ffffff' && p.ratio >= 2 && p.ratio < 3 && !p.pass);
    assert.ok(faint, pairs.map((p) => `${p.fg} on ${p.bg}`).join(' | '));
    const cf = pcx.findings.find((f) => f.id === 'contrast-pair');
    assert.ok(cf && /text elements? fails? contrast/.test(cf.title), pcx.findings.map((f) => f.title).join(' | '));
    assert.equal(cf.severity, 'low', 'pairs on one or two elements are low');
    assert.ok(Number.isInteger(cf.count) && cf.count >= 1 && cf.of >= cf.count, `count ${cf.count} of ${cf.of}`);
    assert.ok(!pairs.some((p) => p.fg === '#dddddd' && !p.pass), 'text over a ::before background image is unknown, not failing');
    assert.ok(pcx.findings.some((f) => /could not be checked \(over images, gradients or layered backgrounds\)$/.test(f.title)), 'unknown count reported');
    const pst = r1.log._harplus.plugins['a11y-structure'];
    assert.equal(pst?.status, 'ok', `a11y-structure: ${pst?.error}`);
    const st = pst.findings.map((f) => f.title);
    for (const re of [/targets smaller than 24×24 px \(WCAG 2\.5\.8\)$/, /label or description references point to missing ids$/]) assert.ok(st.some((x) => re.test(x)), `${re} in ${st.join(' | ')}`);
    // Extent fields survive the plugin host into the saved reading.
    const t24 = pst.findings.find((f) => f.id === 'targets-24');
    assert.ok(Number.isInteger(t24?.count) && Number.isInteger(t24?.of) && t24.of >= t24.count, `targets-24 count ${t24?.count} of ${t24?.of}`);
    // Alt quality belongs to the Images panel (a11y-map) once it ran: Structure still records the images but no longer reports them.
    assert.ok(pst.data.badAlt.count > 0, 'Structure still detects the unhelpful alt text');
    assert.ok(!pst.findings.some((f) => f.id === 'bad-alt'), 'bad-alt is dropped when a11y-map ran');
    // autocomplete-valid ran in axe, so the matching HARgus finding yields (the data still records it).
    assert.ok(pst.data.badAuto.count > 0 && !st.some((x) => /invalid autocomplete/.test(x)), 'autocomplete finding yields to axe');
    // The button's and the postcode field's broken aria-describedby count here; the unlabelled input's broken
    // aria-labelledby is a11y-basics' "Form fields without a label" and is not counted twice.
    assert.equal(pst.data.labelRefs.count, 2, `button + postcode describedby only: ${JSON.stringify(pst.data.labelRefs)}`);
    assert.ok(pst.data.labelRefs.samples.some((s) => /input/.test(s.selector)), 'a form field with a broken aria-describedby is reported');
    assert.ok((r1.log._harplus.plugins['a11y-basics']?.data.rules || []).some((r) => r.id === 'input-label'), 'a11y-basics still detects the input (its finding yields to axe)');
    // The WAVE-style fixtures on the test page trip their checks (data is kept even where axe's finding takes over).
    const ba = r1.log._harplus.plugins['a11y-basics'].data.rules;
    for (const id of ['fieldset-legend', 'link-broken-anchor', 'link-redundant', 'label-orphaned', 'title-redundant', 'layout-table']) assert.ok(ba.some((x) => x.id === id), `fixture trips ${id}`);
    for (const k of ['possibleHeadings', 'possibleLists', 'tinyText', 'justified', 'underlined', 'vagueLinks']) assert.ok(pst.data[k]?.count >= 1, `fixture trips ${k}`);
    assert.ok(pst.findings.some((f) => f.id === 'possible-heading') && pst.findings.some((f) => f.id === 'tiny-text'), 'WAVE-style findings emitted');
    // The full keyboard walk replaces the probe's sampled focus findings (kb-no-focus-style below); the probe data stays.
    assert.ok(pst.data.headings.some((x) => x.text === 'Field notes' && x.level === 2), 'role=heading counted');
    const fs = r1.log._harplus.capture.focus;
    assert.ok(fs?.samples?.find((s) => s.kind === 'button')?.changed.length > 0, `button focus changes: ${JSON.stringify(fs)}`);
    assert.ok(fs.outlineNone >= 1, 'a:focus outline:none rule counted');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-harplus-focus], [data-harplus-focus-style]').length), 0, 'no probe attributes left');
    // Keyboard walk: real Tab presses from the top; the trap widget at the end of the page stops it.
    const kb = r1.log._harplus.capture.keyboard;
    const kbStops = (kb?.stops || []).filter((x) => !x.none);
    assert.ok(kbStops.length > 5, `keyboard stops: ${JSON.stringify(kb).slice(0, 400)}`);
    assert.equal(kb.ended, 'trap', `walk ended: ${kb.ended}`);
    assert.ok(kb.ms < 60_000, `walk took ${kb.ms} ms`);
    assert.ok(kb.trapped.some((x) => /kb-trap-a/.test(x)) && kb.trapped.some((x) => /kb-trap-b/.test(x)), `trapped: ${kb.trapped}`);
    assert.equal(kb.startFocus, 'input[name="postcode"]', 'the autofocus field had focus when the walk began');
    assert.match(kbStops[0].sel, /kb-skip/, 'the skip link is the first stop, not the stop after the autofocus field');
    assert.equal(kbStops[0].skip?.exists, false, 'its target is missing');
    assert.match(kbStops[1].sel, /kb-pos/, 'the tabindex=3 button comes next');
    assert.equal(kbStops[1].tabindex, 3);
    assert.ok(kbStops.some((x) => /Off-screen link/.test(x.name) && !x.onScreen), 'off-screen link recorded as off-screen');
    assert.ok(kbStops.some((x) => x.tag === 'button' && !x.name), 'the empty form button has no name');
    assert.ok(kbStops.some((x) => x.tag === 'button' && x.changed === true), 'buttons show the default focus ring');
    assert.ok(kbStops.some((x) => x.tag === 'a' && x.changed === false), 'a:focus { outline: none } links show no change');
    assert.ok(!kbStops.some((x) => /kb-clicky/.test(x.sel)), 'the clickable div is not a stop');
    assert.ok(kbStops.some((x) => /Clipped link/.test(x.name) && !x.visible), 'a link clipped to nothing by its parent is hidden');
    assert.ok(kbStops.some((x) => /Strip three/.test(x.name)), 'the walk reached the scrolled strip');
    assert.ok(kb.restored?.scrollers >= 1 && kb.restored.scrollersOff === 0, `inner scrollers put back: ${JSON.stringify(kb.restored)}`);
    assert.equal(kb.trapOnFirst, undefined, 'the trap is the widget, not a return to the first stop');
    assert.deepEqual(kb.restored && [kb.restored.active, kb.restored.scrollY], ['body', kb.restored?.startScrollY], `restored: ${JSON.stringify(kb.restored)}`);
    const kbIds = pst.findings.map((f) => f.id);
    for (const id of ['kb-trap', 'kb-hidden', 'kb-no-focus-style', 'kb-clickable']) assert.ok(kbIds.includes(id), `${id} in ${kbIds.join(', ')}`);
    // Unnamed stops axe reported (the empty form button) drop out; the rest (an unlabelled field, an empty-alt image link) stay ours.
    const axeV = (id) => (r1.log._harplus.plugins.axe?.data?.violations || []).some((v) => v.id === id);
    assert.ok(kbIds.includes('kb-no-name'), `kb-no-name in ${kbIds.join(', ')}`);
    const noNameEv = pst.findings.find((f) => f.id === 'kb-no-name').evidence;
    if (axeV('button-name')) assert.doesNotMatch(noNameEv, /form > button/, 'the button axe reported is not repeated');
    assert.ok(kbIds.includes('kb-skip-target') || axeV('skip-link'), 'broken skip link reported (by axe or the walk)');
    // One problem, one finding: across axe, a11y-basics, a11y-structure and a11y-map the unnamed form button and the broken skip link are each reported once.
    const a11yFindings = ['axe', 'a11y-basics', 'a11y-structure', 'a11y-map'].flatMap((id) => (r1.log._harplus.plugins[id]?.findings || []).map((f) => ({ ...f, plugin: id })));
    const about = (re) => a11yFindings.filter((f) => re.test(String(f.evidence || '')));
    assert.ok(!a11yFindings.some((f) => f.plugin === 'a11y-basics' && f.id === 'button-name'), 'a11y-basics:button-name yields to axe (input-button-name was inapplicable, which still counts as run)');
    assert.equal(about(/(^|\n)form > button/).length, axeV('button-name') ? 1 : about(/(^|\n)form > button/).length, `unnamed form button: ${JSON.stringify(about(/form > button/).map((f) => `${f.plugin}:${f.id}`))}`);
    assert.ok(!a11yFindings.some((f) => f.plugin === 'a11y-basics' && f.id === 'link-broken-anchor' && /kb-skip/.test(f.evidence || '')), 'the broken skip link is not repeated as a broken in-page link');
    const skipTarget = about(/\.kb-skip\b/).filter((f) => ['skip-link', 'link-broken-anchor', 'kb-skip-target'].includes(f.id));
    assert.equal(skipTarget.length, 1, `broken skip link target: ${JSON.stringify(skipTarget.map((f) => `${f.plugin}:${f.id}`))}`);
    assert.equal(pst.findings.find((f) => f.id === 'kb-trap').severity, 'high');
    assert.equal(pst.findings.find((f) => f.id === 'kb-trap').title, 'Keyboard focus gets trapped');
    assert.match(pst.findings.find((f) => f.id === 'kb-clickable').evidence, /kb-clicky\b/);
    assert.match(pst.findings.find((f) => f.id === 'kb-clickable').evidence, /kb-clicky-a/, '<a role=button> without href is not focusable');
    // The probe's sampled focus findings give way to the walk's.
    assert.ok(!kbIds.some((x) => /^focus-/.test(x)), `probe focus findings replaced: ${kbIds.join(', ')}`);
    // A positive tabindex is axe's "tabindex" rule; ours yields to it when axe ran it (the stop still carries the flag).
    const axeTab = (r1.log._harplus.plugins.axe?.data?.violations || []).some((v) => v.id === 'tabindex');
    assert.ok(kbIds.includes('kb-positive-tabindex') || axeTab, 'positive tabindex reported (by axe or the walk)');
    assert.ok(!kbIds.includes('focus-jumps'), 'the walk replaces the DOM-inferred focus-jump finding');
    // After the capture the views have reloaded the tab, so the autofocus field may hold focus again; nothing else may.
    assert.equal(await page.evaluate(() => document.activeElement === document.body || document.activeElement?.name === 'postcode'), true, 'no stop left focused after the capture');
    log('keyboard walk:', `${kbStops.length} stops, ended ${kb.ended}, ${kb.ms} ms`);
    for (const id of ['a11y-basics', 'html', 'content']) {
      const titles = (r1.log._harplus.plugins[id]?.findings || []).map((f) => f.title);
      assert.ok(!titles.some((x) => /skipped heading levels|Heading levels skip|No <main>|empty headings|Empty headings/.test(x)), `${id} has no duplicated heading/main findings`);
    }
    log('contrast + structure passed');
    const P = r1.log._harplus.plugins;
    const titles = (id) => (P[id]?.findings || []).map((f) => f.title);
    assert.equal(P.console?.status, 'ok', `console: ${P.console?.error}`);
    assert.ok(titles('console').some((x) => /^\d+ uncaught JavaScript errors$/.test(x)), titles('console').join(' | '));
    assert.ok(titles('console').some((x) => /^\d+ console errors$/.test(x)));
    assert.ok(titles('console').some((x) => /^\d+ Content-Security-Policy violations$/.test(x)));
    assert.equal(P['head-order']?.status, 'ok', `head-order: ${P['head-order']?.error}`);
    assert.ok(titles('head-order').some((x) => /<head> elements out of optimal order$/.test(x)), titles('head-order').join(' | '));
    assert.equal(P.layout?.status, 'ok', `layout: ${P.layout?.error}`);
    const lb = P.layout.findings.find((f) => f.title === 'Layout breaks at 899 px (just below the 900 px breakpoint)');
    assert.ok(lb && /edge/.test(lb.detail || ''), JSON.stringify(P.layout.findings));
    log('build signals passed');
    const wk = r1.log._harplus.plugins['well-known'];
    const ix = Object.fromEntries((wk.data.indexing || []).map((r) => [r.token, r]));
    assert.equal(ix.googlebot?.crawl, true, JSON.stringify(wk.data.indexing));
    assert.equal(ix.gptbot?.crawl, false);
    assert.ok(wk.findings.some((f) => f.title === 'robots.txt sets crawl-delay (Google ignores it)'));
    assert.ok(wk.findings.some((f) => /^robots\.txt blocks \d+ AI crawlers from this page$/.test(f.title)));
    const og = r1.log._harplus.plugins.links.data.ogImage;
    assert.match(og?.thumb || '', /^data:image\/webp;base64,/, 'og:image thumbnail');
    const rd = r1.log._harplus.plugins.content.data;
    assert.equal(rd.reading.readability, 'flesch');
    assert.ok(rd.reading.hardest.length >= 1);
    assert.ok(rd.lineLength.count >= 1 && rd.lineLength.median > 0, JSON.stringify(rd.lineLength));
    log('content and sharing passed');
    for (let i = 0; i < 20; i++) {
      const b = await sw.evaluate((t) => globalThis.harplus.status.get(t)?.badges || [], tabId);
      if (b.at(-1) === '✓') break;
      await new Promise((res) => setTimeout(res, 250));
    }
    const badges = await sw.evaluate((t) => globalThis.harplus.status.get(t)?.badges || [], tabId);
    assert.ok(badges.includes('VIEW') && badges.includes('LOOK') && badges.at(-1) === '✓', `badge sequence: ${badges.join(' ')}`);
    const hp = r1.log._harplus;
    const p = hp.plugins;
    const urls = r1.log.entries.map((e) => e.request.url);
    assert.ok(urls.some((u) => u.endsWith('/app.css')), 'recorded stylesheet');
    assert.ok(urls.some((u) => u.endsWith('/api/data.json')), 'recorded fetch');
    assert.ok(urls.some((u) => u.includes('localhost') && u.endsWith('/frame.html')), 'recorded cross-site iframe document');
    assert.ok(urls.some((u) => u.endsWith('/frame-data.json')), 'recorded request made inside the cross-site iframe');
    assert.ok(urls.some((u) => u.endsWith('/img/lazy.svg')), 'scrolling triggered the lazy image');
    const doc = r1.log.entries.find((e) => e.request.url === `${base}/`);
    assert.equal(doc.response.status, 200);
    assert.ok(doc.response.content.text?.includes('Terra Test'), 'captured document body');
    assert.ok(doc.request.headers.length > 0 && doc.response.headers.some((h) => h.name.toLowerCase() === 'set-cookie'));
    assert.equal(r1.log.pages.length, 1);
    assert.ok(r1.log.pages[0].pageTimings.onLoad > 0);
    const shotViews = (r) => [...new Set(r.log._harplus.screenshots.filter((s) => s.kind === 'viewport').map((s) => s.view))].sort();
    const shotWidth = (r, v) => r.log._harplus.screenshots.find((s) => s.view === v && s.kind === 'viewport')?.cssWidth;
    assert.deepEqual(shotViews(r1), ['achromatopsia', 'blurred', 'bp880-at', 'bp880-below', 'bp900-at', 'bp900-below', 'dark', 'desktop', 'deuteranopia', 'forced', 'lowcontrast', 'mobile', 'morecontrast',
      'nocss', 'noimages', 'nojs', 'print', 'protanopia', 'reflow', 'rtl', 'spacing', 'tablet', 'text200', 'translated-ar', 'translated-de', 'translated-ja', 'tritanopia']);
    assert.deepEqual(hp.screenshots.filter((s) => s.view === 'desktop').map((s) => s.kind).sort(), ['fullpage', 'viewport']);
    assert.equal(hp.screenshots.filter((s) => s.kind === 'thumbnail').length, 1);
    assert.equal(shotWidth(r1, 'desktop'), 1280);
    assert.equal(shotWidth(r1, 'tablet'), 820);
    assert.equal(shotWidth(r1, 'mobile'), 390);
    assert.ok(hp.screenshots.some((s) => s.view === 'nojs' && s.kind === 'fullpage'), 'no-JS full page');
    const mv = hp.capture.views;
    assert.ok(mv.desktop.text > 0 && mv.nojs.text < mv.desktop.text, `no-JS text ${mv.nojs.text} < ${mv.desktop.text}`);
    assert.ok(mv.nojs.links < mv.desktop.links, 'script-rendered links missing without JS');
    assert.ok(mv.noimages.images >= 1, 'broken images still rendered with alt text');
    // Every translated view worked, so the Long text fallback is not needed: the only skip.
    assert.deepEqual(hp.capture.viewsSkipped, [{ view: 'pseudo', reason: 'not needed' }], `only the fallback skipped: ${JSON.stringify(hp.capture.viewsSkipped)}`);
    // The tab is left as it was: scripts run (the script-rendered section is back), original width,
    // and the views' reloads did not leak into the HAR.
    await page.waitForSelector('#js-content');
    const A11Y = ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred', 'lowcontrast', 'dark', 'forced', 'morecontrast', 'print', 'spacing', 'reflow', 'text200'];
    for (const id of A11Y) {
      const kinds = hp.screenshots.filter((s) => s.view === id).map((s) => s.kind);
      assert.deepEqual(kinds, ['viewport'], `${id}: viewport only, got ${kinds}`);
    }
    for (const id of ['dark', 'forced', 'morecontrast', 'print', 'spacing', 'reflow', 'text200']) assert.ok(mv[id], `${id} measured`);
    for (const id of ['protanopia', 'achromatopsia']) assert.equal(mv[id], undefined, `${id} not measured`);
    const baseShot = hp.screenshots.find((s) => s.view === 'desktop' && s.kind === 'viewport').data;
    assert.notEqual(hp.screenshots.find((s) => s.view === 'achromatopsia').data, baseShot, 'vision emulation reaches the screenshot');
    assert.ok(mv.reflow.overflowX > 0, `promo overflows at 320 px (overflowX ${mv.reflow.overflowX})`);
    assert.deepEqual(hp.capture.breakpoints, [900, 880]);
    for (const id of ['bp900-below', 'bp900-at', 'bp880-below', 'bp880-at']) {
      assert.deepEqual(hp.screenshots.filter((s) => s.view === id).map((s) => s.kind), ['viewport'], `${id} viewport only`);
      assert.ok(mv[id], `${id} measured`);
    }
    assert.ok(mv['bp900-below'].overflowX > 0 && mv['bp900-at'].overflowX === 0, 'overflows only at 899');
    assert.ok(mv['bp900-below'].overflowers.some((o) => /edge/.test(o.selector)), JSON.stringify(mv['bp900-below'].overflowers));
    assert.ok(mv.reflow.overflowers.some((o) => /promo/.test(o.selector)), 'reflow culprit is the promo box');
    assert.ok(!mv['bp900-below'].overflowers.some((o) => /slide|div/.test(o.selector) && o.width === 2000), 'clipped carousel is not a culprit');
    const con = hp.capture.console;
    assert.equal(con.entries.find((e) => e.kind === 'console-error' && /e2e console error/.test(e.text))?.count, 1, 'console error recorded once');
    assert.ok(con?.entries.some((e) => e.kind === 'console-error' && /e2e console error/.test(e.text)), JSON.stringify(con));
    assert.ok(con.entries.some((e) => e.kind === 'exception' && /e2e uncaught/.test(e.text)), 'uncaught exception recorded');
    assert.ok(con.entries.some((e) => (e.kind === 'issue' && e.code === 'ContentSecurityPolicyIssue') || (e.kind === 'log' && /Content Security Policy/.test(e.text))), 'CSP violation recorded');
    // The test site sets body { font: 16px … } in px, so doubling the default font size does not grow it —
    // exactly the case the plugin flags. The root font does grow (rem-based margins), proving the emulation ran.
    assert.equal(mv.text200.bodyFont, mv.desktop.bodyFont, 'px-sized body text does not follow the browser font size');
    assert.ok(mv.print.fixed.length >= 1, 'cookie banner is a fixed overlay in print');
    assert.equal(mv.print.chrome, false, 'header hidden in print; the page has no nav or footer');
    assert.ok(typeof mv.dark.bg === 'number' && typeof mv.desktop.bg === 'number');
    assert.equal(hp.capture.prefs?.mediaPrint, true, 'print media rule detected');
    assert.equal(hp.capture.prefs.unreadableSheets, 1, 'the cross-origin theme.css cannot be read in the page');
    assert.equal(mv.reflow.rootClipX, false, 'the test site does not clip overflow-x on html or body');
    for (const id of ['protanopia', 'lowcontrast']) {
      const s = hp.screenshots.find((x) => x.view === id);
      assert.equal(s.scale, undefined, `${id}: unclipped capture (a clip would skip the vision filter)`);
    }
    assert.equal(hp.screenshots.find((x) => x.view === 'dark').scale, undefined, 'display views keep full resolution');
    assert.ok(hp.capture.viewsMs < 120_000, `views took ${hp.capture.viewsMs} ms`);
    // Restores: the tab is back to normal after the accessibility views.
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), rootFontBefore);
    // Checked inside the page before the debugger detached (detaching alone would clear emulated media).
    const rc = hp.capture.restoreCheck;
    assert.ok(rc, 'restoreCheck recorded');
    assert.equal(rc.print, false, 'print emulation cleared');
    assert.equal(rc.spacing, false, 'spacing stylesheet removed');
    assert.equal(rc.width, widthBefore, 'width restored');
    assert.equal(rc.rootFont, rootFontBefore, 'root font size restored');
    assert.deepEqual(await page.evaluate(() => [!!window.__harplusSpacing, document.adoptedStyleSheets.length]), [false, 0], 'spacing sheet removed');
    // Every view recorded a self-check, and the pixels back it up (the filter really is in the shot).
    const vc = r1.log._harplus.capture.viewChecks || {};
    for (const id of ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred', 'lowcontrast']) assert.equal(vc[id]?.ok, true, `${id} check: ${JSON.stringify(vc[id])}`);
    const statsOf = (view) => page2.evaluate(async ([shots, v]) => {
      const s = shots.find((x) => x.view === v && x.kind === 'viewport');
      const { imageStats } = await import('/core/view-checks.js');
      const bmp = await createImageBitmap(await (await fetch(`data:${s.mimeType};base64,${s.data}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
      const st = imageStats(g.getImageData(0, 0, bmp.width, bmp.height).data, bmp.width, bmp.height);
      return { sat: st.sat, edge: st.edge };
    }, [r1.log._harplus.screenshots.filter((x) => x.kind === 'viewport'), view]);
    const achro = await statsOf('achromatopsia');
    assert.ok(achro.sat <= 0.03, `achromatopsia shot is grey (saturation ${achro.sat})`);
    assert.ok((await statsOf('blurred')).edge < (await statsOf('desktop')).edge, 'blurred shot has softer edges than desktop');
    // The cross-origin frame renders in its own process: the vision emulation must reach it too. Its red block is vivid
    // in the desktop shot and grey in the achromatopsia shot.
    const frameBox = await page.evaluate(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height }; });
    const vividInFrame = (view) => page2.evaluate(async ([shots, v, box]) => {
      const s = shots.find((x) => x.view === v && x.kind === 'viewport');
      const bmp = await createImageBitmap(await (await fetch(`data:${s.mimeType};base64,${s.data}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
      const k = s.dpr || 1;
      const px = g.getImageData(Math.round((box.x + 2) * k), Math.round((box.y + 2) * k), Math.round((box.w - 4) * k), Math.round((box.h - 4) * k)).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) { const mx = Math.max(px[i], px[i + 1], px[i + 2]), mn = Math.min(px[i], px[i + 1], px[i + 2]); if (mx > 120 && (mx - mn) / mx > 0.5) n++; }
      return n;
    }, [r1.log._harplus.screenshots.filter((x) => x.kind === 'viewport'), view, frameBox]);
    assert.ok(await vividInFrame('desktop') > 500, `the frame's red block is in the desktop shot (${JSON.stringify(frameBox)})`);
    assert.equal(await vividInFrame('achromatopsia'), 0, 'the cross-origin frame is grey in the achromatopsia shot');
    // The no-CSS restore starts the page's transitions from unstyled values: later views show them settled, not frozen at the start.
    const faderBox = await page.evaluate(() => { const r = document.querySelector('.fader').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const darkInFader = (view) => page2.evaluate(async ([shots, v, box]) => {
      const s = shots.find((x) => x.view === v && x.kind === 'viewport');
      const bmp = await createImageBitmap(await (await fetch(`data:${s.mimeType};base64,${s.data}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
      const k = s.dpr || 1;
      const px = g.getImageData(Math.round((box.x + 4) * k), Math.round((box.y + 4) * k), Math.round((box.w - 8) * k), Math.round((box.h - 8) * k)).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 120) n++;
      return n;
    }, [r1.log._harplus.screenshots.filter((x) => x.kind === 'viewport'), view, faderBox]);
    for (const v of ['rtl', 'translated-de', 'achromatopsia']) assert.equal(await darkInFader(v), 0, `the fade is settled (invisible) in the ${v} shot`);
    assert.equal(vc.noimages?.ok, true, `noimages check: ${JSON.stringify(vc.noimages)}`);
    const ni = r1.log._harplus.capture.views.noimages;
    assert.deepEqual([ni.imgPainted, ni.bgPainted, ni.mediaPlaying], [0, 0, 0], 'no image, background or video in the images-off load (Review Focus 1, 2)');
    assert.ok(ni.framesProbed >= 2, `the probe ran in the page and the cross-origin frame: ${ni.framesProbed}`);
    assert.ok(ni.inlineHidden >= 1, `the data: image was hidden: ${ni.inlineHidden}`);
    assert.match(vc.noimages.detail, /^no images, backgrounds or video \(\d+ inline images and backgrounds hidden\)$/);
    assert.equal(vc.rtl?.ok, true, `rtl kept despite the page resetting dir: ${JSON.stringify(vc.rtl)}`);
    assert.match(vc.rtl.detail, /re-applied/);
    for (const id of ['nocss', ...TRANSLATED, 'dark', 'forced', 'morecontrast', 'print', 'spacing', 'reflow', 'text200']) assert.equal(vc[id]?.ok, true, `${id} check: ${JSON.stringify(vc[id])}`);
    // The tab is clean after the views: direction back, the looping video playing again after both reloads.
    assert.notEqual(await page.evaluate(() => document.documentElement.dir), 'rtl', 'page direction restored');
    await page.waitForFunction(() => { const v = document.querySelector('video.loop'); return v && !v.paused; }, null, { timeout: 5000 });
    log('view self-checks', JSON.stringify(vc));
    // Review Focus 2: the cross-origin frame's image is blocked too. The server saw the frame image on normal loads, but nothing
    // asked for an image between the images-off reload (the last cache-skipping document request) and the restore reload after it.
    assert.ok(site.hits.some((h) => h.search === '?frame'), 'the frame image is requested on normal loads');
    const offAt = site.hits.findLastIndex((h) => h.path === '/' && h.cache === 'no-cache');
    assert.ok(offAt >= 0, 'the images-off reload reached the server');
    const nextDoc = site.hits.findIndex((h, i) => i > offAt && h.path === '/');
    const offWindow = site.hits.slice(offAt + 1, nextDoc < 0 ? undefined : nextDoc);
    const during = offWindow.filter((h) => h.path === '/img/lazy-a.png' || (h.path === '/img/loop.webm' && h.search !== '?stream'));
    assert.deepEqual(during, [], `no image or video requests, including the frame's, during the images-off load: ${JSON.stringify(during)}`);
    // A script fetch is decided by its response's Content-Type, so the stream reaches the server and its video/webm answer is failed (mediaPlaying 0 above).
    assert.ok(offWindow.some((h) => h.path === '/img/loop.webm' && h.search === '?stream'), 'the script-fetched stream is judged at its response');
    assert.ok(site.hits.some((h) => h.path === '/img/loop.webm' && h.search === '?stream'), 'the stream is fetched on normal loads');
    // The no-CSS view must restore constructed stylesheets (adoptedStyleSheets is a live array).
    const strip = (on) => page.evaluate(`(${fnSource(stripStyles)})(${on})`);
    await strip(true);
    assert.equal(await page.evaluate(() => document.querySelector('hp-card').shadowRoot.adoptedStyleSheets.length), 0, 'no-CSS view clears adopted sheets');
    await strip(false);
    assert.equal(await page.evaluate(() => document.querySelector('hp-card').shadowRoot.adoptedStyleSheets.length), 1, 'no-CSS view restores adopted sheets');
    // collect() on a page with no <main>: a sentence interrupted by an inline link and a script stays whole.
    const bare = await context.newPage();
    await bare.setContent('<body><div><p>Text with <a href="#">link</a>\n continues here.<script>1</script></p><p>Second line with <a href="#">another</a> <script>2</script> sentence carries on.</p></div><h1>Title</h1></body>');
    const bareText = (await bare.evaluate(`(${fnSource(content.collect)})()`)).text;
    // contrast collect(): an in-flow ::before bullet does not hide the background; an absolute one does.
    await bare.setContent(`<style>li::before{content:'';display:inline-block;width:8px;height:8px;background-image:linear-gradient(red,red)}
      .o{position:relative}.o::before{content:'';position:absolute;inset:0;background-image:linear-gradient(red,blue)}</style>
      <body><ul><li>Bullet item text</li></ul><p class="o">Over art</p></body>`);
    const pseudo = (await bare.evaluate(`(${fnSource(contrastPlugin.collect)})()`)).elements;
    assert.ok(!pseudo.find((e) => /li$/.test(e.selector)).unknown, 'in-flow pseudo-element bullet is not an overlay');
    assert.ok(pseudo.find((e) => /p\.o$/.test(e.selector)).unknown, 'absolute pseudo-element background is an overlay');
    // a11y-basics collect(): display:contents is as visible as its parent; hidden descendants don't name a control;
    // a descendant's aria-labelledby beats its aria-label; an SVG <title> still names a link.
    await bare.setContent(A11Y_NAMES_PAGE);
    const named = await bare.evaluate(`(${fnSource(a11yBasics.collect)})()`);
    const samplesOf = (id) => (named.rules.find((r) => r.id === id)?.samples || []).map((s) => s.html).join(' ');
    assert.match(samplesOf('button-name'), /contents-btn/, 'a display:contents button in a visible parent is checked');
    assert.doesNotMatch(samplesOf('button-name'), /contents-in-hidden/, 'a display:contents button in a hidden parent is not');
    assert.match(samplesOf('button-name'), /hidden-img-btn/, 'a display:none img alt does not name the button');
    assert.doesNotMatch(samplesOf('link-name'), /svg-title-link|lb-link/, `SVG title and aria-labelledby name links: ${samplesOf('link-name')}`);
    // a11y-structure collect(): an explicit non-landmark role overrides the tag's implicit landmark.
    await bare.setContent('<!doctype html><body><nav role="none"><h2>Plain</h2></nav><header role="group"></header><nav aria-label="Real"><h2>In nav</h2></nav><main><h1>T</h1></main></body>');
    const lm = await bare.evaluate(`(${fnSource(a11yStructure.collect)})()`);
    assert.deepEqual(lm.landmarkList.map((l) => l.role), ['navigation', 'main'], 'role=none/group elements are not landmarks');
    assert.deepEqual(lm.headings.map((x) => x.landmarks.map((l) => l.role)), [[], ['navigation'], ['main']], 'chains');
    // WAVE-style collectors, each at its trigger and just below it (counts are exact).
    await bare.setContent(`<!doctype html><body style="font-size:16px">
      <fieldset class="fs-bad"><input aria-label="a"></fieldset><fieldset><legend>Group</legend><input aria-label="b"></fieldset><fieldset class="fs-blank"><legend> </legend><input aria-label="c"></fieldset>
      <label for="e1" class="lab-empty"></label><input id="e1"><label for="e2">Name</label><input id="e2"><label for="e2" class="lab-again">Again</label>
      <label class="lab-sel-empty"><select><option>OptionText</option></select></label><label>Pick <select><option>One</option></select></label>
      <label class="lab-orphan">Orphan</label><label for="nothing" class="lab-missing">Missing id</label><label for="hid">Hidden target</label><input id="hid" type="hidden"><label>Wraps <input></label>
      <a href="#missing" class="a-missing">x</a><a href="#">y</a><a href="#top">z</a><a href="#!/route">r</a><a href="#present">p</a><a href="#anch">q</a><a name="anch"></a><p id="present">t</p>
      <a href="/r1" class="r1a">A</a> <a href="/r1" class="r1b">B</a>
      <a href="/r2">A</a>, <a href="/r2">B</a>
      <a href="/r3">A</a><a href="/r4">B</a>
      <button title="Save" class="t-same">Save</button><button title="Save draft">Save</button><img src="data:," alt="Logo" title="logo" class="t-alt">
      <video class="v-bad" width="100" height="50"></video><video class="v-deco" width="100" height="50" muted loop></video><video class="v-muted-controls" width="100" height="50" muted loop controls></video><video class="v-muted-plain" width="100" height="50" muted></video><video class="v-ok" width="100" height="50"><track kind="captions" src="c.vtt"></video><video width="100" height="50"><track src="c.vtt"></video>
      <iframe class="yt" title="Player" src="https://www.youtube-nocookie.com/embed/abc" width="100" height="50" loading="lazy"></iframe><iframe title="Other" src="about:blank" width="100" height="50"></iframe>
      <table class="lay-one"><tr><td>one</td></tr></table>
      <table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>
      <table><tr><th>h</th></tr></table><table role="presentation"><tr><td>x</td></tr></table><table><caption>c</caption><tr><td>x</td></tr></table>
      <table class="lay-nest"><tr><td>a</td><td><table><tr><td>b</td><td>c</td></tr><tr><td>d</td><td>e</td></tr></table></td></tr><tr><td>f</td><td>g</td></tr></table>
    </body>`);
    const wb = await bare.evaluate(`(${fnSource(a11yBasics.collect)})()`);
    const wrule = (id) => wb.rules.find((r) => r.id === id);
    const wcount = (id) => wrule(id)?.count || 0;
    assert.equal(wcount('fieldset-legend'), 2, `fieldsets without or with an empty legend: ${JSON.stringify(wrule('fieldset-legend')?.samples)}`);
    assert.equal(wcount('label-empty'), 2, 'an empty label and a label holding only a select');
    assert.match(JSON.stringify(wrule('label-empty').samples), /lab-empty/);
    assert.equal(wcount('label-orphaned'), 2, `no for and no control, and for= a hidden input; for= a missing id is label-refs': ${JSON.stringify(wrule('label-orphaned')?.samples)}`);
    assert.doesNotMatch(JSON.stringify(wrule('label-orphaned').samples), /lab-missing/);
    assert.equal(wcount('label-multiple'), 1, 'two labels on one field');
    assert.equal(wcount('link-broken-anchor'), 1, `only #missing: ${JSON.stringify(wrule('link-broken-anchor')?.samples)}`);
    assert.match(JSON.stringify(wrule('link-broken-anchor').samples), /a-missing/);
    assert.equal(wcount('link-redundant'), 1, 'adjacent same-href links; text or another href between breaks the run');
    assert.match(JSON.stringify(wrule('link-redundant').samples), /r1b/);
    assert.equal(wcount('title-redundant'), 2, 'title equal to the text, and to the alt');
    assert.equal(wcount('video-captions'), 3, `no track, muted with controls, muted but neither loop nor autoplay; a captions track, a track with no kind (subtitles) and a muted decorative loop pass: ${JSON.stringify(wrule('video-captions')?.samples)}`);
    assert.match(JSON.stringify(wrule('video-captions').samples), /v-bad/);
    assert.doesNotMatch(JSON.stringify(wrule('video-captions').samples), /v-deco/);
    assert.equal(wb.stats.decorativeVideos, 1, 'the decorative loop is counted in stats only');
    assert.equal(wcount('media-embed'), 1, 'the YouTube player only');
    assert.equal(wcount('layout-table'), 2, `a one-cell table and a table with nested tables: ${JSON.stringify(wrule('layout-table')?.samples)}`);
    assert.match(JSON.stringify(wrule('layout-table').samples), /lay-one/);
    // The sample selectors name one element each (the Page map resolves only unambiguous ones).
    assert.ok(wb.rules.filter((r) => ['fieldset-legend', 'label-empty', 'link-redundant'].includes(r.id)).every((r) => r.samples.every((x) => !x.selector.includes('NaN') && x.selector.length > 3)));

    const ls = 'Orders ship within two days of purchase. '.repeat(13); // 520 characters
    await bare.setContent(`<!doctype html><body style="font-size:16px">
      <div class="h-bold"><p style="font-weight:700;margin:0">Shipping and returns</p><p>Orders ship in two days.</p></div>
      <div class="h-49"><p style="font-weight:700;margin:0">${'a'.repeat(49)}</p><p>Body</p></div>
      <div class="h-50"><p style="font-weight:700;margin:0">${'b'.repeat(50)}</p><p>Body</p></div>
      <div class="h-big"><div style="font-size:19.2px">Big words</div><p>Body</p></div>
      <div class="h-small"><div style="font-size:19px">Almost big</div><p>Body</p></div>
      <div class="h-plain"><p>Short plain</p><p>Body</p></div>
      <div class="h-last"><p>Intro</p><p style="font-weight:700;margin:0">Last one</p></div>
      <div class="h-real"><h2 style="font-size:2em">Real heading</h2><p>Body</p></div>
      <div class="l-three"><p>• Tents</p><p>• Stoves</p><p>• Lanterns</p></div>
      <div class="l-two"><p>• Tents</p><p>• Stoves</p></div>
      <div class="l-mixed"><p>• Tents</p><p>- Stoves</p><p>• Lanterns</p></div>
      <div class="l-split"><p>• Tents</p><p>• Stoves</p><p>Note</p><p>• Lanterns</p></div>
      <p class="l-br">1. First<br>2. Second<br>3. Third</p>
      <p class="l-brtwo">1. First<br>2. Second</p>
      <ul><li>• Tents</li><li>• Stoves</li><li>• Lanterns</li></ul>
      <a href="/a" class="v1">Click here</a> <a href="/b" class="v2">Read more…</a> <a href="/c">Read the returns policy</a> <a href="/d">More tents</a> <a href="/e" class="v3">here</a> <a href="/f" class="v4">Click to start</a> <a href="/g">Clicker training</a> <a href="/h"><img alt="more" src="data:,"></a>
      <p class="s-11" style="font-size:11px">eleven</p><p class="s-9" style="font-size:9px">tiny nine</p><p class="s-99" style="font-size:9.9px">tiny nine nine</p><p style="font-size:10px">ten</p><p style="font-size:2px">two</p>
      <p class="j-yes" style="text-align:justify">${ls}</p><p style="text-align:justify">${ls.slice(0, 495)}</p><p>${ls}</p><div class="j-wrap" style="text-align:justify"><p>${ls}</p></div>
      <span class="u-span" style="text-decoration:underline">under</span><u class="u-tag">tag</u><a href="/x" style="text-decoration:underline">docs</a><abbr title="t">abbr</abbr>
      <span style="text-decoration:underline dotted">dots</span><span role="button" tabindex="0" style="text-decoration:underline">button</span>
    </body>`);
    const ws = await bare.evaluate(`(${fnSource(a11yStructure.collect)})(${JSON.stringify({ vague: VAGUE_LINK_WORDS })})`);
    const wsel = (b) => b.samples.map((x) => x.selector).join(' | ');
    assert.equal(ws.possibleHeadings.count, 3, `bold 49-char p, bold short p, 1.2x div: ${wsel(ws.possibleHeadings)}`);
    assert.match(wsel(ws.possibleHeadings), /h-bold[\s\S]*h-49[\s\S]*h-big/);
    assert.doesNotMatch(wsel(ws.possibleHeadings), /h-50|h-small|h-plain|h-last|h-real/);
    assert.equal(ws.possibleLists.count, 2, `three bullet paragraphs in a row, and three numbered lines split by <br>; not two, mixed bullets, a broken run or a real list: ${wsel(ws.possibleLists)}`);
    assert.match(wsel(ws.possibleLists), /l-three/);
    assert.match(wsel(ws.possibleLists), /l-br/);
    assert.doesNotMatch(wsel(ws.possibleLists), /l-two|l-mixed|l-brtwo|ul/);
    assert.equal(ws.vagueLinks.count, 5, `Click here, Read more, here, Click to start, and the image alt "more": ${JSON.stringify(ws.vagueLinks.samples)}`);
    assert.equal(ws.tinyText.count, 2, `9px and 9.9px; not 10px or the 2px hiding trick: ${wsel(ws.tinyText)}`);
    assert.equal(ws.smallText.count, 2, 'small-text is 10 to under 12 px (11px, 10px); tiny text is not counted twice');
    assert.equal(ws.justified.count, 2, `over 500 justified characters, and a paragraph that inherits justify; not 495 or unjustified: ${wsel(ws.justified)}`);
    assert.match(wsel(ws.justified), /j-yes[\s\S]*j-wrap/);
    assert.equal(ws.underlined.count, 2, `the span and the u; not the link, abbr, dotted or button: ${wsel(ws.underlined)}`);
    // The visible label leaves out screen-reader-only text; with no vague list the vague-link check is skipped.
    await bare.setContent(`<!doctype html><style>.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}.sr2{position:absolute;clip-path:inset(50%)}</style><body>
      <button aria-label="Search the site" class="lin-ok"><span class="sr">GOV.UK</span>Search</button>
      <button aria-label="Search the site" class="lin-ok2"><span class="sr2">GOV.UK</span>Search</button>
      <button aria-label="Find" class="lin-bad"><span>Search</span></button>
      <a href="/a">Click here</a></body>`);
    const lin = await bare.evaluate(`(${fnSource(a11yStructure.collect)})(${JSON.stringify({ vague: VAGUE_LINK_WORDS })})`);
    assert.equal(lin.labelInName.count, 1, `only the button whose visible label is missing from its name: ${wsel(lin.labelInName)}`);
    assert.match(wsel(lin.labelInName), /lin-bad/);
    const noVague = await bare.evaluate(`(${fnSource(a11yStructure.collect)})({})`);
    assert.equal(noVague.vagueSkipped, true);
    assert.equal(noVague.vagueLinks.count, 0, 'no list, no vague check');
    // measureView(): <body dir="rtl"> makes the page right-to-left, so a skip link off the left edge is the culprit.
    await bare.setContent('<!doctype html><body dir="rtl"><a href="#m" class="skip-link" style="position:absolute;left:-9999px">Skip</a><p id="m">نص</p></body>');
    const bodyRtl = await bare.evaluate(`(${fnSource(measureView)})()`);
    assert.ok(bodyRtl.overflowers.some((o) => /skip-link/.test(o.selector) && o.side === 'left'), `body dir=rtl culprit: ${JSON.stringify(bodyRtl.overflowers)}`);
    // hideInlineImages(): data: images, <picture> sources, data: backgrounds and pseudo-element images go; gradients and network images stay; off puts all back.
    await bare.setContent(`<style>.pb::before{content:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'/%3E")}</style><body>
      <img id="d" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'/%3E" alt="d">
      <picture><source srcset="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'/%3E"><img id="p" alt="p"></picture>
      <img id="n" src="/x.png" alt="n">
      <div id="bg" style="width:9px;height:9px;background-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E')"></div>
      <div id="gr" style="width:9px;height:9px;background-image:linear-gradient(red,blue)"></div>
      <p class="pb">Icon</p>
      <img id="f" alt="f" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" onerror="this.src='data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='"></body>`);
    const hideIn = (on) => bare.evaluate(`(${fnSource(hideInlineImages)})(${on})`);
    const imgState = () => bare.evaluate(() => ({
      d: document.getElementById('d').getAttribute('src').slice(0, 10), p: document.getElementById('p').getAttribute('src'),
      source: document.querySelector('source').getAttribute('srcset')?.slice(0, 10) ?? null, n: document.getElementById('n').getAttribute('src'),
      bg: getComputedStyle(document.getElementById('bg')).backgroundImage.slice(0, 10), gr: getComputedStyle(document.getElementById('gr')).backgroundImage.slice(0, 15),
      pb: getComputedStyle(document.querySelector('.pb'), '::before').content.slice(0, 9),
    }));
    const shown = await imgState();
    assert.equal(await hideIn(true), 5, 'three images, a background and a pseudo-element image hidden');
    // A page whose onerror puts the placeholder back (spiegel.de) never sees the break, so it cannot fight the keeper.
    await bare.waitForTimeout(300);
    assert.deepEqual(await bare.evaluate(() => [document.getElementById('f').getAttribute('src'), window.__harplusKeep.count]), ['about:invalid#harplus', 0], 'the page\'s onerror did not run');
    assert.deepEqual(await imgState(), { d: 'about:inva', p: 'about:invalid#harplus', source: null, n: '/x.png', bg: 'none', gr: 'linear-gradient', pb: 'none' });
    await bare.evaluate(() => { const i = document.createElement('img'); i.id = 'late'; i.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='; document.body.append(i); });
    await bare.waitForFunction(() => document.getElementById('late').getAttribute('src') === 'about:invalid#harplus', null, { timeout: 2000 });
    await hideIn(false);
    assert.deepEqual(await imgState(), shown, 'hideInlineImages(false) restores every image');
    // translatePage(): a translate() that never settles is cut off; untranslated text never counts as translated.
    // <html lang="iw"> is Hebrew (canonicalised), so nothing is blocked as "another language".
    await bare.setContent(`<!doctype html><html lang="iw"><style>.c::before{content:"Sale today now"}.n::before{content:"Brand name here"}</style><body>
      <p>Quick words here</p><p>Stuck first words</p><p>Stuck second words</p><p>Stuck third words</p><p>Other quick words</p>
      <span class="c"></span> <span class="n" translate="no"></span></body></html>`);
    await bare.evaluate(() => {
      globalThis.Translator = { create: async () => ({ translate: (t) => (/Stuck/.test(t) ? new Promise(() => {}) : Promise.resolve(`X ${t}`)) }) };
    });
    // callMs 600 against budget 1000: the second stuck call always ends the budget, so the last quick string is never reached (timing-proof).
    const tStart = Date.now();
    const tp = await bare.evaluate(`(${fnSource(translatePage)})(${JSON.stringify({ source: 'he', target: 'de', budgetMs: 1000, callMs: 600 })})`);
    const tpMs = Date.now() - tStart;
    assert.ok(tpMs < 3000, `translatePage returned within its budget: ${tpMs} ms`);
    assert.deepEqual(tp, { translated: 1, eligible: 5 }, `the string before the stuck ones is translated under lang="iw"; the one after is out of budget: ${JSON.stringify(tp)}`);
    const tProbe = await bare.evaluate(`(${fnSource(viewProbe)})('translated')`);
    assert.equal(tProbe.ok, false, `untranslated text fails the self-check: ${JSON.stringify(tProbe)}`);
    assert.match(tProbe.detail, /^\d+% (not translated in time|could not be translated)$/, `the self-check says why (misses, not the page restoring text): ${JSON.stringify(tProbe)}`);
    const tLeft = await bare.evaluate(`(${fnSource(leftoverText)})()`);
    assert.ok(tLeft.causes.error >= 1 && tLeft.causes.budget >= 1 && tLeft.causes.error + tLeft.causes.budget === 4, `stuck strings are leftovers: ${JSON.stringify(tLeft)}`);
    assert.equal(tLeft.causes.cssContent, 1, `translate="no" generated text is not a leftover: ${JSON.stringify(tLeft)}`);
    await bare.evaluate(`(${fnSource(restoreTranslation)})()`);
    assert.deepEqual(await bare.evaluate(() => [...document.querySelectorAll('p')].map((p) => p.textContent)),
      ['Quick words here', 'Stuck first words', 'Stuck second words', 'Stuck third words', 'Other quick words'], 'restored');
    // A translator that fails every string fails the view, with a clear reason.
    await bare.evaluate(() => { globalThis.Translator = { create: async () => ({ translate: async () => { throw new Error('boom'); } }) }; });
    await assert.rejects(bare.evaluate(`(${fnSource(translatePage)})(${JSON.stringify({ source: 'he', target: 'de' })})`), /nothing could be translated: boom/);
    await bare.evaluate(`(${fnSource(restoreTranslation)})()`);
    // Open shadow roots and same-origin frames are translated and restored; <html lang> holds the target meanwhile;
    // restore destroys the translator.
    await bare.setContent(`<!doctype html><html><body><p>Plain page sentence here</p><div id="host"></div>
      <iframe id="fr" srcdoc="<p>Framed sentence goes here</p>" width="300" height="60"></iframe></body></html>`);
    await bare.waitForFunction(() => document.getElementById('fr').contentDocument?.body?.textContent.includes('Framed'));
    await bare.evaluate(() => {
      document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<p>Shadow sentence lives here</p>';
      globalThis.__destroyed = 0;
      globalThis.Translator = { create: async () => ({ translate: async (t) => t.replace(/\S+/g, (w) => `${w}ung`), destroy: () => { globalThis.__destroyed++; } }) };
    });
    const tpRoots = await bare.evaluate(`(${fnSource(translatePage)})(${JSON.stringify({ source: 'en', target: 'de' })})`);
    const inView = await bare.evaluate(() => ({
      plain: document.querySelector('p').textContent, shadow: document.getElementById('host').shadowRoot.textContent,
      frame: document.getElementById('fr').contentDocument.body.textContent, lang: document.documentElement.getAttribute('lang'),
    }));
    assert.deepEqual(inView, { plain: 'Plainung pageung sentenceung hereung', shadow: 'Shadowung sentenceung livesung hereung', frame: 'Framedung sentenceung goesung hereung', lang: 'de' }, JSON.stringify({ inView, tpRoots }));
    const rootsLeft = await bare.evaluate(`(${fnSource(leftoverText)})()`);
    assert.equal(rootsLeft.count, 0, `nothing left over in the shadow root or the frame: ${JSON.stringify(rootsLeft)}`);
    await bare.evaluate(`(${fnSource(restoreTranslation)})()`);
    const afterRoots = await bare.evaluate(() => ({
      shadow: document.getElementById('host').shadowRoot.textContent, frame: document.getElementById('fr').contentDocument.body.textContent,
      lang: document.documentElement.hasAttribute('lang'), destroyed: globalThis.__destroyed,
    }));
    assert.deepEqual(afterRoots, { shadow: 'Shadow sentence lives here', frame: 'Framed sentence goes here', lang: false, destroyed: 1 }, JSON.stringify(afterRoots));
    // The node cap: past it nothing is translated, and the overflow is one "cap" leftover named in the self-check.
    await bare.setContent(`<!doctype html><html lang="en-GB"><body>${[1, 2, 3, 4, 5].map((i) => `<p>Block number ${i} here</p>`).join('')}</body></html>`);
    const tpCap = await bare.evaluate(`(${fnSource(translatePage)})(${JSON.stringify({ source: 'en', target: 'de', cap: 3 })})`);
    assert.deepEqual(tpCap, { translated: 3, eligible: 3, capped: 2 }, JSON.stringify(tpCap));
    const capLeft = await bare.evaluate(`(${fnSource(leftoverText)})()`);
    assert.equal(capLeft.causes.cap, 1, `cap counted once: ${JSON.stringify(capLeft)}`);
    assert.equal(capLeft.causes.late, 0, `blocks past the cap are not "late": ${JSON.stringify(capLeft)}`);
    assert.equal(capLeft.cap, 3);
    const capProbe = await bare.evaluate(`(${fnSource(viewProbe)})('translated')`);
    assert.ok(capProbe.ok && /page too long: only the first 3 text blocks were translated/.test(capProbe.detail), JSON.stringify(capProbe));
    await bare.evaluate(`(${fnSource(restoreTranslation)})()`);
    assert.equal(await bare.evaluate(() => document.documentElement.getAttribute('lang')), 'en-GB', 'the page\'s own lang is back');
    // A create() that resolves after the view was restored leaves the page alone and destroys its translator.
    await bare.evaluate(() => {
      globalThis.__destroyed = 0;
      globalThis.__release = null;
      globalThis.Translator = { create: () => new Promise((res) => { globalThis.__release = () => res({ translate: async (t) => `X ${t}`, destroy: () => { globalThis.__destroyed++; } }); }) };
    });
    await bare.evaluate(`(globalThis.__latePromise = (${fnSource(translatePage)})(${JSON.stringify({ source: 'en', target: 'de' })}), 0)`);
    await bare.waitForFunction(() => typeof globalThis.__release === 'function');
    await bare.evaluate(`(${fnSource(restoreTranslation)})()`);
    const late = await bare.evaluate(async () => { globalThis.__release(); const r = await globalThis.__latePromise; return { r, text: document.querySelector('p').textContent, lang: document.documentElement.getAttribute('lang'), destroyed: globalThis.__destroyed }; });
    assert.deepEqual(late, { r: { translated: 0, eligible: 0, cancelled: true }, text: 'Block number 1 here', lang: 'en-GB', destroyed: 1 }, JSON.stringify(late));
    // The Arabic self-check fails when the page dropped dir="rtl".
    const arProbe = await bare.evaluate(`(${fnSource(viewProbe)})(['translated', 'ar'])`);
    assert.deepEqual([arProbe.ok, arProbe.detail], [false, 'the page removed the RTL direction'], JSON.stringify(arProbe));
    await bare.close();
    assert.ok(/Second line with another sentence carries on\./.test(bareText.replace(/ +/g, ' ')), `mid-sentence script keeps the sentence whole: ${JSON.stringify(bareText)}`);
    assert.ok(/Text with link continues here\./.test(bareText), `inline pieces join into one sentence: ${JSON.stringify(bareText)}`);
    assert.equal(await page.evaluate(() => matchMedia('print').matches || matchMedia('(prefers-color-scheme: dark)').matches), false);
    assert.equal(await page.evaluate(() => innerWidth), widthBefore);
    assert.equal(r1.log.entries.filter((e) => e.request.url === `${base}/`).length, 1, 'one document entry');
    assert.equal(r1.log.entries.filter((e) => e.request.url.endsWith('/main.js')).length, 1, 'main.js recorded once');
    assert.equal(hp.target.title, 'Terra Test Outfitters — gear for the field');
    for (const id of ['meta', 'vitals', 'a11y-basics', 'tech', 'network', 'security', 'well-known', 'ip-intel']) {
      assert.equal(p[id]?.status, 'ok', `${id}: ${p[id]?.status} ${p[id]?.error || ''}`);
    }
    assert.ok(!p.meta.findings.some((f) => /Duplicate meta tags:.*\btitle\b/.test(f.title)), 'SVG <title> is not a duplicate document title');
    const fh = p['a11y-basics'].data.rules.find((r) => r.id === 'focusable-hidden');
    const ab = p['a11y-basics'].data.rules;
    const btn = ab.find((r) => r.id === 'button-name');
    assert.ok(btn, 'button-name rule has samples to exclude from');
    assert.ok(!(btn?.samples || []).some((s) => /hidden-arrow|invisible-arrow/.test(s.html)), `hidden buttons not counted: ${JSON.stringify(btn?.samples)}`);
    const lnk = ab.find((r) => r.id === 'link-name');
    assert.ok(!(lnk?.samples || []).some((s) => /svg-logo/.test(s.html)), 'SVG role=img aria-label names the link');
    assert.equal(fh?.count, 1, `only the visible link counts: ${JSON.stringify(fh?.samples)}`);
    assert.equal(typeof p.vitals.data.cutAt, 'number', 'scroll-start mark seen by vitals');
    if (p.vitals.data.lcp) assert.ok(p.vitals.data.lcp.time < p.vitals.data.cutAt, 'LCP before the scroll');
    assert.equal(typeof mv.reflow.scrollsX, 'boolean', 'reflow view records the scroll test');
    assert.equal(p.dns.status, 'skipped');
    // axe-core is bundled and on by default (the run no longer enables it).
    assert.equal(p.axe.status, 'ok', `axe: ${p.axe.error}`);
    assert.match(p.axe.data.engine, /^4\./, 'axe engine version recorded');
    assert.ok(p.axe.data.violations.some((v) => v.id === 'image-alt'), 'axe found image-alt');
    assert.ok(Array.isArray(p.axe.data.incomplete) && p.axe.data.passedIds.length > 0, 'incomplete + passedIds collected');
    assert.ok(!p['a11y-basics'].findings.some((f) => f.id === 'image-alt'), 'a11y-basics yields image-alt to axe');
    log('axe-core', p.axe.data.engine, '—', p.axe.data.violations.length, 'violations,', p.axe.data.incomplete.length, 'need review');
    assert.equal(p.meta.data.organization.name, 'Terra Test Outfitters');
    assert.ok(p.meta.data.social.LinkedIn);
    assert.ok(p['a11y-basics'].data.rules.some((r) => r.id === 'image-alt'));
    assert.ok(p['a11y-basics'].data.rules.some((r) => r.id === 'meta-viewport'));
    const tech = p.tech.data.technologies.map((t) => t.name);
    for (const name of ['Eleventy', 'jQuery', 'Nginx', 'PHP', 'Custom elements']) assert.ok(tech.includes(name), `tech: ${name}`);
    assert.ok(p.security.findings.some((f) => /disclose software versions/.test(f.title)));
    assert.equal(p['well-known'].data.robots.aiBots.GPTBot.status, 'blocked');
    assert.equal(p['well-known'].data.sitemap.urls, 2);
    assert.equal(p['well-known'].data.llms.title, 'Terra Test Outfitters');
    // composition plugins
    assert.equal(p['a11y-basics'].status, 'ok', p['a11y-basics'].error);
    assert.ok(p['a11y-basics'].data.rules.some((r) => r.id === 'duplicate-id'), 'duplicate ids found despite id=""');
    for (const id of ['html', 'css', 'javascript', 'baseline', 'html-validate', 'css-validate']) assert.equal(p[id]?.status, 'ok', `${id}: ${p[id]?.error}`);
    assert.equal(p.resilience?.status, 'ok', `resilience: ${p.resilience?.error}`);
    assert.ok(p.resilience.summary.some((s) => s.label === 'Without JavaScript'));
    assert.equal(p.images?.status, 'ok', `images: ${p.images?.error}`);
    assert.ok(p.images.findings.some((f) => /larger than (it's|they're) shown/.test(f.title) && /big\.jpg/.test(f.detail || '')), 'oversized big.jpg');
    const bigImg = p.images.data.images.find((i) => i.src.endsWith('/img/big.jpg'));
    assert.ok(bigImg.webpNeeded > 0 && bigImg.webpNeeded < bigImg.bytes, `big.jpg re-encoded smaller: ${JSON.stringify(bigImg)}`);
    assert.equal(p.carbon?.status, 'ok', `carbon: ${p.carbon?.error}`);
    assert.ok(p.carbon.data.grams > 0 && /^(A\+|[A-F])$/.test(p.carbon.data.rating));
    assert.equal(p.carbon.data.hosts.find((x) => x.host === 'localhost')?.green, true, 'green check answered by the mock');
    assert.equal(p.international?.status, 'ok', `international: ${p.international?.error}`);
    const intl = p.international.findings.map((f) => f.title);
    const iv = hp.capture.views;
    // Translated views (fake translator): each ran, was measured and shot; the fallback did not run.
    const tr = hp.capture.translation || {};
    for (const id of TRANSLATED) {
      assert.equal(tr[id]?.status, 'ok', `${id}: ${JSON.stringify(tr[id])} (warnings ${JSON.stringify(hp.capture.warnings)})`);
      assert.ok(hp.screenshots.some((s) => s.view === id && s.kind === 'viewport'), `${id} screenshot`);
      assert.match(vc[id]?.detail || '', /^\d+% of text translated/, `${id} check: ${JSON.stringify(vc[id])}`);
    }
    assert.equal(typeof iv['translated-de']?.clipped, 'number', `German measured: ${JSON.stringify(iv['translated-de'])}`);
    assert.equal(iv['translated-ar']?.dir, 'rtl', `the Arabic view is right-to-left: ${iv['translated-ar']?.dir}`);
    assert.equal(iv['translated-de']?.dir, 'ltr', 'the German view is not');
    assert.equal(iv.pseudo, undefined, 'Long text did not run: no translated view failed');
    assert.ok(!intl.includes('Text gets cut off when translated'), 'no Long text finding without the fallback');
    assert.ok(!intl.some((t) => /view could not run/.test(t)), `no "could not run" finding on the main reading: ${JSON.stringify(intl)}`);
    // One finding per defect, whichever languages show it.
    assert.ok(!intl.some((t) => /^Text gets cut off in |^(German|Arabic|Japanese) text makes| in the (German|Arabic|Japanese) view$/.test(t)), `no per-language titles: ${JSON.stringify(intl)}`);
    for (const re of [/^Text gets cut off when translated \(/, /^Translated text makes the page scroll sideways \(/, /stayed in \w+ when translated \(/, /can't be translated \(/]) assert.ok(intl.filter((t) => re.test(t)).length <= 1, `grouped (${re}): ${JSON.stringify(intl)}`);
    assert.ok(intl.some((t) => /^Text gets cut off when translated \(German\): up to \d+ more text boxes clip$/.test(t)), `the German clipping on the fixture is named: ${JSON.stringify(intl)}`);
    const left = tr['translated-de'].leftovers;
    assert.ok(left?.causes?.cssContent >= 1, `the ::before "Sale today" is a leftover: ${JSON.stringify(left)}`);
    assert.ok(left.causes.iframe >= 1, `the cross-origin frame is a leftover: ${JSON.stringify(left)}`);
    assert.ok(left.examples.includes('Sale today') && left.examples.length <= 5, JSON.stringify(left.examples));
    assert.ok(intl.includes('Right-to-left text without dir="rtl"'), JSON.stringify({ intl, base: iv.desktop }));
    const rtlFinding = p.international.findings.find((f) => f.title === 'Right-to-left layout scrolls sideways');
    assert.ok(rtlFinding && /skip-link sits \d+ px off-screen\. In a right-to-left page/.test(rtlFinding.detail) && /logical properties \(inset-inline-start/.test(rtlFinding.detail), rtlFinding?.detail);
    const rtlOver = iv.rtl.overflowers || [];
    assert.ok(!rtlOver.some((o) => /carousel/.test(o.selector)), `carousel children are clipped, not culprits (Review Focus 3): ${JSON.stringify(rtlOver)}`);
    const lang = p.language;
    assert.equal(lang?.status, 'ok', `language: ${lang?.status} ${lang?.error || ''}`);
    assert.equal(lang.data.method, 'detector', `Chrome's detector is wired in: ${JSON.stringify(lang.data)}`);
    const lt = lang.findings.map((f) => f.title);
    assert.ok(lt.some((t) => /passages? in German ha(s|ve) no lang attribute/.test(t)), JSON.stringify({ lt, data: lang.data }));
    assert.ok(lt.some((t) => /garbled characters such as "/.test(t)), JSON.stringify(lt));
    // Three "cafÃ©" plus one "Â" + no-break space: the last only survives if collect keeps U+00A0.
    assert.ok(p.language.data.counts.mojibake >= 4, `mojibake count ${p.language.data.counts.mojibake}`);
    assert.ok(lt.includes("Dates, times or prices are written in one region's format"), JSON.stringify({ lt, counts: lang.data.counts }));
    assert.ok(lang.data.detectedCodes?.ar >= 1, `the Arabic block was actually detected: ${JSON.stringify(lang.data.detectedCodes)}`);
    assert.ok(!lt.some((t) => /in Italian/.test(t)), `garbled text is not sent to the detector: ${JSON.stringify(lt)}`);
    assert.ok(!lt.some((t) => /lang="ar" is on text/.test(t)), `Arabic paragraph is not mislabelled: ${JSON.stringify(lt)}`);
    // Chrome answers "iw" for Hebrew; the canonical code keeps a correct lang="he" quiet.
    assert.ok(!lt.some((t) => /lang="he"|in Hebrew/.test(t)), `Hebrew paragraph is not flagged: ${JSON.stringify(lt)}`);
    assert.ok(lang.data.detectedCodes?.he >= 1, `the Hebrew block was detected as he: ${JSON.stringify(lang.data.detectedCodes)}`);
    assert.ok(!lt.some((t) => /^Page says lang="en"/.test(t)), `one German paragraph does not make the page German: ${JSON.stringify(lt)}`);
    // Short language-switcher links never reach the block list.
    assert.ok(!lang.findings.some((f) => /Deutsch|Français|日本語|Español|Italiano/.test(`${f.title} ${f.detail || ''}`)), `language links are not reported: ${JSON.stringify(lt)}`);
    // The tab is restored after the international views.
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('dir')), null, 'dir restored');
    assert.equal(await page.evaluate(() => document.querySelector('.tags li').textContent), 'Free shipping', 'text restored');
    // The translations are gone: original text, attributes and the re-rendering ticker are back in English.
    const restored = await page.evaluate(() => ({ text: document.body.innerText, ticker: document.querySelector('.ticker').textContent, ph: document.querySelector('input[type=email]').placeholder, alt: document.querySelector('img.inline-square').alt }));
    assert.deepEqual([restored.ticker, restored.ph, restored.alt], ['Fresh stock daily', 'Email', 'Green square'], JSON.stringify(restored));
    assert.ok(!/[A-Za-z]ung\b|كلمة|テキスト/.test(restored.text), `no translated text left: ${(/\S*(ung\b|كلمة|テキスト)\S*/.exec(restored.text) || [])[0]}`);
    // The open shadow root and the same-origin frame were translated (no leftovers from them) and are restored, as is <html lang>.
    assert.ok(!left.examples.some((e) => /Trail maps|Framed note/.test(e)), `shadow and frame text reached by the translation: ${JSON.stringify(left)}`);
    const reached = await page.evaluate(() => ({
      shadow: document.querySelector('.shadow-note').shadowRoot.textContent,
      frame: document.querySelector('iframe.same-frame').contentDocument.body.textContent,
      frameTitle: document.querySelector('iframe.same-frame').title,
      lang: document.documentElement.getAttribute('lang'),
    }));
    assert.deepEqual(reached, { shadow: 'Trail maps for every season', frame: 'Framed note about camping stoves', frameTitle: 'Store note', lang: 'en' }, JSON.stringify(reached));
    const comp = p.html.data.components;
    assert.ok(comp.customTags.includes('hp-card') && comp.shadowRoots >= 1, 'web components seen');
    assert.ok(p.html.data.scriptTypes.module && p.html.data.scriptTypes.importmap, 'module + import map');
    const css = p.css.data;
    assert.equal(css.sheets.find((x) => x.href?.includes('localhost'))?.parsedFrom, 'recorded body', 'cross-origin sheet parsed from body');
    assert.ok(css.sheets.some((x) => x.kind === 'shadow'), 'shadow-root adopted sheet parsed');
    assert.deepEqual(css.layers.slice(0, 3), ['reset', 'tokens', 'components']);
    assert.ok(css.atRules.container && css.usage.pseudoClasses.has && css.stats.nested > 0);
    assert.ok(css.usage.functions['light-dark'], 'shadow sheet function counted');
    assert.ok(css.custom.undefinedUsed.includes('--gap-missing') && css.custom.unused.includes('--unused-token'));
    assert.ok(p.javascript.data.totals.sourceMaps >= 1 && p.javascript.data.apis['api.CustomElementRegistry.define']);
    const feats = new Set(p.baseline.data.features.map((f) => f.id));
    for (const f of ['cascade-layers', 'container-queries', 'has', 'nesting', 'dialog', 'popover', 'import-maps', 'js-modules', 'oklab']) assert.ok(feats.has(f), `baseline: ${f}`);
    assert.equal(p['html-validate'].data.errors.length, 2);
    assert.match(p['css-validate'].data.sheets[0].errors[0].message, /oklch/, 'CSS sent as multipart form data');
    log('tech:', p.tech.data.technologies.length, 'technologies', p.tech.data.fingerprints ? JSON.stringify(p.tech.data.fingerprints) : '(built-in only)');
    log('baseline:', p.baseline.summary[0].value);
    if (FULL_FINGERPRINTS) assert.ok(p.tech.data.fingerprints?.count > 5000, 'community fingerprints loaded in the extension');
    log('capture notes:', JSON.stringify(hp.capture.warnings), 'timeline', JSON.stringify(hp.capture.timeline));
    log('reload reading checks passed:', r1.log.entries.length, 'entries,', Object.keys(p).length, 'plugin results');

    // Report tab closed mid-views: the patch waits in the store and is merged when the reading is reopened.
    await sw.evaluate((t) => { globalThis.__cap4 = globalThis.harplus.capture(t, { mode: 'reload' }); }, tabId);
    let rid4 = null;
    for (const until = Date.now() + 90_000; Date.now() < until && !rid4;) {
      rid4 = await sw.evaluate((t) => globalThis.harplus.status.get(t)?.readingId ?? null, tabId).catch(() => null);
      if (!rid4 || rid4 === id1) { rid4 = null; await new Promise((res) => setTimeout(res, 100)); }
    }
    assert.ok(rid4, 'core reading id for the closed-tab case');
    await sw.evaluate(async (rid) => {
      for (const t of await chrome.tabs.query({})) if (t.url?.includes('/ui/reading.html') && (t.url.includes(`id=${rid}`) || t.url.includes('capture='))) await chrome.tabs.remove(t.id);
    }, rid4);
    await sw.evaluate(() => globalThis.__cap4);
    const patch4 = await page2.evaluate(async (x) => (await import('/browser/store.js')).getViewsPatch(x), rid4);
    if (patch4) assert.ok(patch4.capture?.views, 'patch stored while no reading tab was open');
    else log('closed-tab case: the reading tab merged the patch before it was closed');
    // A separate page: the reading tab's own lookups probe URLs that 404 by design, which page2's error watcher would flag.
    const reopened = await context.newPage();
    await reopened.goto(extUrl(`ui/reading.html?id=${rid4}`));
    const rClosed = await waitDone(rid4);
    assert.ok(rClosed.log._harplus.capture.views && !rClosed.log._harplus.capture.viewsPending, 'reopened tab merged the patch');
    assert.equal(await page2.evaluate(async (x) => (await import('/browser/store.js')).getViewsPatch(x), rid4), null);
    log('closed-tab case: patch', patch4 ? 'stored then merged on reopen' : 'already merged');
    await reopened.close();

    // Run-to-run spread: 3 runs of the local page. The timing runs leave no traffic in the HAR and the report shows the spread.
    const idRuns = await sw.evaluate((t) => globalThis.harplus.capture(t, { mode: 'reload', runs: 3 }), tabId);
    const rRuns = await waitDone(idRuns);
    {
      const hpR = rRuns.log._harplus;
      const rr = hpR.runs || { samples: [], skipped: [] };
      assert.equal(rr.samples.length + 1 + rr.skipped.length, 3, `3 runs accounted for: ${JSON.stringify({ samples: rr.samples.length, skipped: rr.skipped })}`);
      assert.ok(hpR.capture.runs >= 2 || rr.skipped.length > 0, `capture.runs ${hpR.capture.runs} (or a recorded skip)`);
      assert.equal(hpR.capture.runs, 1 + rr.samples.length, 'capture.runs counts the full run and the timing samples');
      assert.ok(hpR.capture.fullRunAt, 'capture.fullRunAt is recorded');
      const fullAt = Date.parse(hpR.capture.fullRunAt);
      const early = rRuns.log.entries.filter((e) => Date.parse(e.startedDateTime) < fullAt - 50);
      assert.deepEqual(early.map((e) => e.request.url), [], 'no timing-run traffic in the HAR (every entry starts at or after the full run)');
      const runsPage = await context.newPage();
      await runsPage.goto(extUrl(`ui/reading.html?id=${idRuns}#area-performance`));
      await runsPage.waitForSelector('#area-performance details');
      const shown = await runsPage.evaluate(() => {
        const pane = document.getElementById('area-performance');
        const each = [...pane.querySelectorAll('details')].find((d) => /Each run/.test(d.querySelector('summary')?.textContent || ''));
        return { each: !!each, stats: [...pane.querySelectorAll('.stat')].map((s) => s.textContent.replace(/\s+/g, ' ').trim()) };
      });
      assert.ok(rr.samples.length >= 1, `the local page records at least one timing sample: ${JSON.stringify(rr.skipped)}`);
      assert.ok(shown.each, 'the Performance pane renders the "Each run" section');
      assert.ok(shown.stats.some((t) => /Largest contentful paint/.test(t) && /· 3 runs/.test(t)), `the LCP tile says 3 runs: ${JSON.stringify(shown.stats)}`);
      await runsPage.close();
      log('3-run reading:', rr.samples.length, 'timing samples,', rr.skipped.length, 'skipped, fullRunAt', hpR.capture.fullRunAt);
    }

    // 2. mobile + snapshot
    const id2 = await sw.evaluate((t) => globalThis.harplus.capture(t, { mode: 'reload', device: 'mobile', fullPage: false }), tabId);
    const r2 = await waitDone(id2);
    assert.equal(shotWidth(r2, 'mobile'), 390, 'mobile base view');
    assert.equal(shotWidth(r2, 'desktop'), 1280, 'desktop view from a mobile reading');
    assert.equal(r2.log._harplus.capture.device, 'mobile');
    assert.ok(r2.log._harplus.capture.viewport.width < 700, 'mobile layout viewport');
    assert.match(r2.log._harplus.capture.userAgent, /iPhone/);
    const frameJs = r2.log.entries.find((e) => e.request.url.endsWith('/frame.js'));
    const ua = frameJs.request.headers.find((x) => x.name.toLowerCase() === 'user-agent')?.value || '';
    assert.match(ua, /iPhone/, 'cross-site iframe requests use the emulated user agent');
    const frameDoc = r1.log.entries.find((e) => e.request.url.endsWith('/frame.html'));
    assert.ok(frameDoc.response.content.text?.includes('Cross-site frame'), 'cross-site iframe document body captured');
    const id3 = await sw.evaluate((t) => globalThis.harplus.capture(t, { mode: 'snapshot' }), tabId);
    const r3 = await waitDone(id3);
    assert.ok(r3.log.entries.length >= 3 && r3.log.entries.every((e) => e._synthetic));
    assert.ok(!r3.log._harplus.screenshots.some((s) => s.view === 'nojs'), 'snapshot: no no-JS shot');
    assert.ok(r3.log._harplus.capture.viewsSkipped?.some((s) => s.view === 'nojs' && s.reason === 'not in reload mode'));
    assert.ok(!r3.log._harplus.screenshots.some((s) => s.view === 'noimages'), 'snapshot: no no-images shot');
    assert.ok(r3.log._harplus.capture.viewsSkipped?.some((s) => s.view === 'noimages' && s.reason === 'not in reload mode'));
    // The no-images view breaks every src; the page's own onerror handlers must not run (snapshot mode does not reload).
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById('onerror-img')).display), 'none', 'onerror handler did not fire during the no-images view');
    // The views hand the page's own CSS animation back running, once: no replayed copy of what the no-CSS view cancelled.
    const spin = await page.evaluate(() => {
      const el = document.querySelector('.spinner');
      const mine = document.getAnimations().filter((a) => a.effect?.target === el);
      return { n: mine.length, running: mine.filter((a) => a.playState === 'running').length, script: mine.filter((a) => !(a instanceof CSSAnimation)).length, names: mine.map((a) => `${a.constructor.name}:${a.playState}`) };
    });
    assert.ok(spin.n === 1 && spin.running === 1 && spin.script === 0, `snapshot: the spinner has exactly one running CSS animation, got ${JSON.stringify(spin.names)}`);
    log('mobile + snapshot readings passed');

    // A strict style CSP (gov.uk's kind): an injected <style> is blocked, yet the text-spacing view applies.
    const cspPage = await context.newPage();
    await cspPage.goto(`${base}/csp.html`);
    assert.equal(await cspPage.evaluate(() => { const s = document.createElement('style'); s.textContent = 'body { letter-spacing: 7px }'; document.head.append(s); const ls = getComputedStyle(document.body).letterSpacing; s.remove(); return ls; }), 'normal', 'the CSP blocks an inline <style>');
    const cspTab = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, `${base}/csp.html`);
    const onlySpacing = Object.fromEntries(['desktop', 'tablet', 'mobile', 'nojs', 'nocss', 'noimages', 'rtl', ...TRANSLATED, 'pseudo', 'vision', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred', 'lowcontrast',
      'dark', 'forced', 'morecontrast', 'print', 'reflow', 'text200', 'breakpoints'].map((v) => [v, false]));
    const idCsp = await sw.evaluate(([t, views]) => globalThis.harplus.capture(t, { mode: 'snapshot', views: { ...views, spacing: true } }), [cspTab, onlySpacing]);
    const rCsp = await waitDone(idCsp);
    const cspCheck = rCsp.log._harplus.capture.viewChecks?.spacing;
    assert.deepEqual(cspCheck, { ok: true, detail: 'text spacing applied' }, `spacing under a strict CSP: ${JSON.stringify(cspCheck)}`);
    assert.ok(rCsp.log._harplus.screenshots.some((s) => s.view === 'spacing'), 'spacing shot taken');
    // Translated views switched off are recorded as skips (no fallback for those).
    for (const id of TRANSLATED) assert.deepEqual(rCsp.log._harplus.capture.translation?.[id], { status: 'skipped', reason: 'turned off' }, `${id}: ${JSON.stringify(rCsp.log._harplus.capture.translation)}`);
    assert.equal(await cspPage.evaluate(() => document.adoptedStyleSheets.length), 0, 'spacing sheet removed after the view');
    await page2.evaluate(async (x) => (await import('/browser/store.js')).deleteReading(x), idCsp);
    await cspPage.close();
    log('text spacing under a strict CSP passed');

    // A OneTrust-like consent banner holds focus on load: the walk records it as the banner phase, sets it aside
    // without choosing anything, walks the page behind it, and puts it back exactly.
    const ctPage = await context.newPage();
    await ctPage.goto(`${base}/consent.html`);
    await ctPage.waitForLoadState('load');
    // The banner's style attribute changes, for the message if the restore check fails.
    await ctPage.evaluate(() => { window.__mlog = []; const el = document.getElementById('onetrust-consent-sdk'); new MutationObserver((rs) => { for (const r of rs) window.__mlog.push(`${Math.round(performance.now())} ${r.attributeName}=${JSON.stringify(el.getAttribute(r.attributeName))}`); }).observe(el, { attributes: true }); });
    const ctTab = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, `${base}/consent.html`);
    const idCt = await sw.evaluate(([t, views]) => globalThis.harplus.capture(t, { mode: 'snapshot', views }), [ctTab, { ...onlySpacing, spacing: false }]);
    const rCt = await waitDone(idCt);
    const kbCt = rCt.log._harplus.capture.keyboard;
    const ctReal = (xs) => (xs || []).filter((x) => !x.none);
    assert.ok(kbCt?.banner, `banner recorded: ${JSON.stringify(kbCt).slice(0, 600)}`);
    assert.equal(kbCt.banner.kind, 'cmp');
    assert.equal(kbCt.banner.tool, 'OneTrust');
    assert.equal(kbCt.banner.setAside, true, JSON.stringify(kbCt.banner).slice(0, 400));
    assert.equal(kbCt.banner.modal, false);
    assert.deepEqual([...new Set(ctReal(kbCt.banner.stops).map((x) => x.name))].sort(), ['Accept All', 'Decline All', 'Manage Preferences'], 'the three banner buttons are the banner stops');
    assert.ok(ctReal(kbCt.banner.stops).every((x) => /onetrust/.test(x.sel)), 'banner stops are inside the banner');
    const ctStops = ctReal(kbCt.stops);
    assert.ok(ctStops.length > 20, `page phase: ${ctStops.length} stops, ended ${kbCt.ended}`);
    assert.ok(ctStops.some((x) => x.name === 'Later page link 18') && ctStops.some((x) => x.name === 'Last footer link'), 'the page phase reaches the later links');
    assert.ok(!ctStops.some((x) => /onetrust/.test(x.sel)), 'no banner stop in the page phase');
    assert.ok(kbCt.focusableCount >= 30, `focusableCount ${kbCt.focusableCount}`);
    assert.equal(kbCt.consent?.tool, 'OneTrust', 'the banner was seen at load');
    assert.equal(kbCt.restored?.banner, true, `banner shown again: ${JSON.stringify(kbCt.restored)}`);
    const ctFind = rCt.log._harplus.plugins['a11y-structure'].findings;
    const ctTrap = ctFind.find((f) => f.id === 'kb-banner-trap');
    assert.equal(ctTrap?.title, "Cookie banner traps keyboard focus but isn't a modal dialog", ctFind.map((f) => f.id).join(', '));
    assert.equal(ctTrap.severity, 'medium');
    assert.ok(!ctFind.some((f) => ['kb-trap', 'kb-confined', 'kb-banner-unreachable', 'kb-stopped'].includes(f.id)), ctFind.map((f) => f.id).join(', '));
    // Put back exactly: the banner shows, <main> is aria-hidden again, the scroll lock is back, nothing was chosen.
    const ctAfter = await ctPage.evaluate(() => ({
      sdk: getComputedStyle(document.getElementById('onetrust-consent-sdk')).display,
      sdkStyle: document.getElementById('onetrust-consent-sdk').getAttribute('style'),
      banner: document.getElementById('onetrust-banner-sdk').getClientRects().length > 0,
      hidden: document.querySelector('main').getAttribute('aria-hidden'),
      overflow: document.body.style.overflow,
      rootStyle: document.documentElement.getAttribute('style'),
      choices: window.__choices,
    }));
    const ctLog = await ctPage.evaluate(() => window.__mlog);
    assert.deepEqual(ctAfter, { sdk: 'block', sdkStyle: null, banner: true, hidden: 'true', overflow: 'hidden', rootStyle: null, choices: [] }, `${JSON.stringify(ctAfter)} banner style changes: ${JSON.stringify(ctLog)}`);
    await page2.evaluate(async (x) => (await import('/browser/store.js')).deleteReading(x), idCt);
    await ctPage.close();
    log('consent banner walk:', `banner ${ctReal(kbCt.banner.stops).length} stops, page ${ctStops.length} stops, ended ${kbCt.ended}`);

    // An ordinary frame with 70 links in the middle of the page holds focus for more than 50 presses: it is not a
    // banner, so the walk moves past it and reaches the links after it.
    const frPage = await context.newPage();
    await frPage.goto(`${base}/frame-walk.html`);
    await frPage.waitForLoadState('load');
    const frTab = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, `${base}/frame-walk.html`);
    const idFr = await sw.evaluate(([t, views]) => globalThis.harplus.capture(t, { mode: 'snapshot', views }), [frTab, { ...onlySpacing, spacing: false }]);
    const kbFr = (await waitDone(idFr)).log._harplus.capture.keyboard;
    const frStops = (kbFr?.stops || []).filter((x) => !x.none);
    const frFrame = frStops.find((x) => x.frame);
    assert.ok(frFrame && frFrame.presses > 50 && frFrame.skipped === true, `the frame is one stop, walked past: ${JSON.stringify(frFrame)}`);
    assert.notEqual(kbFr.ended, 'frame', `walk ended: ${kbFr.ended}`);
    assert.ok(frStops.some((x) => x.name === 'After frame link 5'), `reached the links after the frame: ${frStops.map((x) => x.name).join(' | ')}`);
    assert.equal(kbFr.banner, undefined);
    assert.equal(kbFr.confined, undefined);
    await page2.evaluate(async (x) => (await import('/browser/store.js')).deleteReading(x), idFr);
    await frPage.close();
    log('large frame walk:', `${frStops.length} stops, frame ${frFrame.presses} presses, ended ${kbFr.ended}`);

    // Stop facts: a skip link to a display:contents <main> is a visible target; a see-through checkbox laid over its
    // label is visible (overlaid); links inside a closed <details> are not counted.
    const kdPage = await context.newPage();
    await kdPage.goto(`${base}/kb-dom.html`);
    await kdPage.waitForLoadState('load');
    const kdTab = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, `${base}/kb-dom.html`);
    const idKd = await sw.evaluate(([t, views]) => globalThis.harplus.capture(t, { mode: 'snapshot', views }), [kdTab, { ...onlySpacing, spacing: false }]);
    const rKd = await waitDone(idKd);
    const kbKd = rKd.log._harplus.capture.keyboard;
    const kdStops = (kbKd?.stops || []).filter((x) => !x.none);
    assert.equal(kdStops[0]?.skip?.visible, true, `display:contents target: ${JSON.stringify(kdStops[0]?.skip)}`);
    const kdBox = kdStops.find((x) => /kbd-menu-checkbox/.test(x.sel));
    assert.ok(kdBox && kdBox.visible === true && kdBox.overlaid === true, `overlaid checkbox: ${JSON.stringify(kdBox)}`);
    assert.equal(kbKd.focusableCount, 5, `skip link, checkbox, ghost input, open link and the summary; not the 5 closed links: ${kbKd.focusableCount}`);
    const kdGhost = kdStops.find((x) => /kbd-ghost/.test(x.sel));
    assert.ok(kdGhost && kdGhost.visible === false && !kdGhost.overlaid, `unlabelled see-through input stays hidden: ${JSON.stringify(kdGhost)}`);
    const kdIds = rKd.log._harplus.plugins['a11y-structure'].findings.map((f) => f.id);
    assert.ok(!kdIds.includes('kb-skip-target'), kdIds.join(', '));
    const kdHidden = rKd.log._harplus.plugins['a11y-structure'].findings.find((f) => f.id === 'kb-hidden');
    assert.match(kdHidden?.evidence || '', /kbd-ghost/, 'the ghost input is reported hidden');
    assert.doesNotMatch(kdHidden?.evidence || '', /kbd-menu-checkbox/, 'the overlaid checkbox is not');
    await page2.evaluate(async (x) => (await import('/browser/store.js')).deleteReading(x), idKd);
    await kdPage.close();
    log('stop facts:', `${kdStops.length} stops, focusableCount ${kbKd.focusableCount}`);

    // Keyboard walks of banner shapes and focus rings. Each page is read with only the keyboard walk's views.
    const walkPage = async (file) => {
      const pg = await context.newPage();
      await pg.goto(`${base}/${file}`);
      await pg.waitForLoadState('load');
      const tab = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, `${base}/${file}`);
      const id = await sw.evaluate(([t, views]) => globalThis.harplus.capture(t, { mode: 'snapshot', views }), [tab, { ...onlySpacing, spacing: false }]);
      const r = await waitDone(id);
      const done = async () => { await page2.evaluate(async (x) => (await import('/browser/store.js')).deleteReading(x), id); await pg.close(); };
      return { pg, kb: r.log._harplus.capture.keyboard, finds: r.log._harplus.plugins['a11y-structure'].findings, stops: (r.log._harplus.capture.keyboard?.stops || []).filter((x) => !x.none), done };
    };

    // A Sourcepoint-like banner: a cross-origin frame in a translucent fixed wrapper, focus in the frame on load.
    {
      const w = await walkPage('consent-sp.html');
      const b = w.kb.banner;
      const ids = w.finds.map((f) => f.id).join(', ');
      assert.ok(b, `banner recorded:${JSON.stringify({ ...w.kb, stops: w.kb.stops.map((x) => x.name + (x.frame ? `#frame${x.presses}` : '')) })}`);
      assert.equal(b.tool, 'Sourcepoint', JSON.stringify(b).slice(0, 300));
      assert.equal(b.setAside, true, JSON.stringify(b).slice(0, 400));
      // The frame path: the frame held Tab past the cap and was set aside as a banner (not a page-phase cycle).
      assert.equal(b.ended, 'frame', JSON.stringify(b).slice(0, 400));
      assert.ok(b.stops.length === 1 && b.stops[0].frame && b.stops[0].presses > 50, JSON.stringify(b.stops));
      assert.equal(w.kb.restored?.banner, true, `banner shown again: ${JSON.stringify(w.kb.restored)}`);
      assert.ok(w.stops.some((x) => x.skip) && w.stops.filter((x) => /^Page link \d+$/.test(x.name)).length === 10, `page phase: ${w.stops.map((x) => x.name).join(' | ')}`);
      assert.ok(w.finds.some((f) => f.id === (b.modal ? 'kb-banner-modal' : 'kb-banner-trap')), `banner finding (modal ${b.modal}): ${ids}`);
      assert.ok(!w.finds.some((f) => f.id === 'kb-focus-lost'), ids);
      assert.ok(!w.finds.some((f) => f.id === 'kb-obscured'), ids);
      await w.done();
      log('cross-origin consent frame walk passed');
    }

    // A gov.uk-like inline banner inside a wrapper shared with the skip link and the header.
    {
      const w = await walkPage('consent-inline.html');
      const ids = w.finds.map((f) => f.id).join(', ');
      assert.equal(w.kb.consent?.kind, 'inline', JSON.stringify(w.kb.consent));
      assert.match(w.kb.consent.sel, /cookie-banner/, `the banner, not the shared wrapper: ${w.kb.consent.sel}`);
      assert.equal(w.kb.banner, undefined, 'an inline banner is not set aside');
      assert.ok(w.stops.some((x) => x.skip), 'the skip link is a stop');
      assert.equal(w.stops.filter((x) => /^\/?.*nav/.test(x.sel) && x.tag === 'a').length, 5, `5 header links: ${w.stops.map((x) => x.sel).join(' | ')}`);
      for (const id of ['kb-no-skip-link', 'kb-banner-unreachable', 'kb-obscured']) assert.ok(!w.finds.some((f) => f.id === id), `${id}: ${ids}`);
      await w.done();
      log('inline cookie banner walk passed');
    }

    // An opaque fixed banner over a fixed band of 3 links, not trapping: those 3 stops are hidden behind it.
    {
      const w = await walkPage('kb-covered.html');
      const f = w.finds.find((x) => x.id === 'kb-obscured');
      assert.equal(f?.title, '3 keyboard stops are hidden behind the cookie banner', w.finds.map((x) => x.id).join(', '));
      assert.equal(f.severity, 'medium');
      assert.ok(!w.finds.some((x) => x.id === 'kb-banner-trap'), 'the banner does not trap');
      await w.done();
      log('stops behind a banner passed');
    }

    // A translucent full-viewport backdrop around a small dialog: the page behind it is not reported hidden.
    {
      const w = await walkPage('kb-backdrop.html');
      assert.ok(w.kb.consent?.sel, `a consent banner was detected: ${JSON.stringify(w.kb.consent)}`);
      assert.equal(w.stops.filter((x) => /^Behind link \d$/.test(x.name)).length, 4, `behind links: ${w.stops.map((x) => x.name).join(' | ')}`);
      assert.ok(!w.finds.some((x) => x.id === 'kb-obscured'), w.finds.map((x) => `${x.id}: ${x.evidence || ''}`).join('; '));
      await w.done();
      log('translucent backdrop passed');
    }

    // A focus ring drawn on the wrapper (:focus-within) counts as a focus style, named as the parent's.
    {
      const w = await walkPage('kb-wrapper-ring.html');
      for (const sel of ['ring-parent', 'ring-swap']) {
        const s = w.stops.find((x) => x.sel?.includes(sel));
        assert.ok(s && s.changed === true && s.changedOn === 'parent', `${sel}: ${JSON.stringify(s)}`);
      }
      // A ring drawn by the wrapper's ::after (:has(a:focus-visible)) counts too.
      const card = w.stops.find((x) => x.sel?.includes('ring-after'));
      assert.ok(card && card.changed === true && card.changedOn === 'parent' && card.changedPseudo === '::after', `ring-after: ${JSON.stringify(card)}`);
      assert.ok(!w.finds.some((x) => x.id === 'kb-no-focus-style'), w.finds.map((x) => `${x.id}: ${x.evidence || ''}`).join('; '));
      await w.done();
      log('wrapper focus ring passed');
    }

    // Le Monde's live shape: the ring is a click area's ::after that only exists while the link inside has
    // :focus-visible (no pseudo-element at kbStart), the link sits 2px above the click area's box, and on a lifestyle
    // card the click area is the 4th ancestor around it. It counts; the same shape drawing nothing on focus does not.
    {
      const w = await walkPage('kb-pseudo-ring.html');
      const card = w.stops.find((x) => x.sel?.includes('ring-appear') && !/blank|gone|inline/.test(x.sel));
      assert.ok(card && card.changed === true && card.changedOn === 'ancestor' && card.changedPseudo === '::after' && card.changes?.includes('outline'), `ring-appear: ${JSON.stringify(card)}`);
      const deep = w.stops.find((x) => x.sel?.includes('ring-deep'));
      assert.ok(deep && deep.changed === true && deep.changedOn === 'ancestor' && deep.changedPseudo === '::after', `ring-deep: ${JSON.stringify(deep)}`);
      // Nothing drawn: a pseudo-element that appears without a ring, one with an outline but display:none, and an
      // empty inline one with only a background.
      const blanks = ['ring-appear-blank', 'ring-appear-gone', 'ring-appear-inline'];
      for (const id of blanks) {
        const s = w.stops.find((x) => x.sel?.includes(id));
        assert.equal(s?.changed, false, `${id}: ${JSON.stringify(s)}`);
      }
      const f = w.finds.find((x) => x.id === 'kb-no-focus-style');
      assert.equal(f?.title, '3 keyboard stops show no visible focus change', w.finds.map((x) => `${x.id}: ${x.evidence || ''}`).join('; '));
      for (const id of blanks) assert.match(f.evidence, new RegExp(id), f.evidence);
      await w.done();
      log('pseudo-element ring that appears on focus passed');
    }

    // A nav whose :focus-within background is the only change, around 3 links with no style of their own: entering
    // it from the lead link is a visible change (nav one is credited); moving inside it is not (nav two and three).
    {
      const w = await walkPage('kb-nav-ring.html');
      const f = w.finds.find((x) => x.id === 'kb-no-focus-style');
      assert.equal(f?.title, '2 keyboard stops show no visible focus change', w.finds.map((x) => `${x.id}: ${x.evidence || ''}`).join('; '));
      assert.deepEqual(f.evidence.split('\n').map((x) => /nav-\d/.exec(x)?.[0]), ['nav-2', 'nav-3'], f.evidence);
      const one = w.stops.find((x) => x.sel?.includes('nav-1'));
      assert.ok(one?.changed === true && one.changedOn === 'parent', `nav-1: ${JSON.stringify(one)}`);
      await w.done();
      log('shared wrapper ring passed');
    }

    // BBC's shape: a see-through full-screen cross-origin consent frame that does not hold focus. What it paints
    // cannot be seen, so the stops behind it are not reported hidden behind it.
    {
      const w = await walkPage('consent-sp-open.html');
      const ids = w.finds.map((x) => x.id).join(', ');
      assert.equal(w.kb.consent?.tool, 'Sourcepoint', JSON.stringify(w.kb.consent));
      assert.equal(w.kb.banner, undefined, `the frame does not hold focus: ${JSON.stringify(w.kb.banner)?.slice(0, 300)}`);
      const behind = w.stops.filter((x) => /^Open link \d$/.test(x.name));
      assert.equal(behind.length, 4, w.stops.map((x) => x.name).join(' | '));
      assert.ok(behind.every((x) => x.obscured !== 'full'), JSON.stringify(behind.map((x) => [x.name, x.obscured, x.obscuredFrame])));
      assert.ok(behind.some((x) => x.obscuredFrame), `graded as may be covered: ${JSON.stringify(behind.map((x) => [x.name, x.obscured]))}`);
      assert.ok(!w.finds.some((x) => x.id === 'kb-obscured'), ids);
      assert.ok(!w.finds.some((x) => x.id === 'kb-focus-lost'), ids);
      // Those stops get one info note instead, counted from the stops graded may-be-covered.
      const unsure = w.finds.filter((x) => x.id === 'kb-obscured-unsure');
      const maybe = new Set(w.stops.filter((x) => x.obscured && x.obscuredFrame).map((x) => x.sel));
      assert.equal(unsure.length, 1, ids);
      assert.equal(unsure[0].severity, 'info');
      assert.equal(unsure[0].title, `Cookie banner may cover ${maybe.size} keyboard ${maybe.size === 1 ? 'stop' : 'stops'}`);
      await w.done();
      log('full-screen consent frame passed');
    }

    // No on-device translator (the init script removes it): the three translated views fail with one reason
    // and the Long text view runs as the fallback. Only the international views run.
    const fbPage = await context.newPage();
    await fbPage.addInitScript(NO_TRANSLATOR);
    await fbPage.goto(`${base}/?fallback=1`);
    await fbPage.waitForLoadState('load');
    assert.equal(await fbPage.evaluate(() => typeof globalThis.Translator), 'undefined', 'no Translator in the fallback tab');
    const fbTab = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u })).find((t) => t.url.includes('fallback=1'))?.id, `${base}/*`);
    assert.ok(fbTab && fbTab !== tabId, 'found the fallback tab');
    const onlyIntl = { ...onlySpacing, spacing: false, rtl: true, pseudo: true, ...Object.fromEntries(TRANSLATED.map((v) => [v, true])) };
    const idFb = await sw.evaluate(([t, views]) => globalThis.harplus.capture(t, { mode: 'snapshot', views }), [fbTab, onlyIntl]);
    const rFb = await waitDone(idFb);
    const hpFb = rFb.log._harplus;
    for (const id of TRANSLATED) assert.deepEqual(hpFb.capture.translation?.[id], { status: 'failed', reason: 'translation unavailable in this browser' }, `${id}: ${JSON.stringify(hpFb.capture.translation)}`);
    assert.ok(hpFb.capture.views?.pseudo, `Long text ran as the fallback: ${JSON.stringify(hpFb.capture.viewsSkipped)}`);
    const fbTimed = (hpFb.capture.viewTimings || []).map((v) => v.view);
    assert.ok(fbTimed.includes('translated-de') && !fbTimed.includes('translated-ar') && !fbTimed.includes('translated-ja'), `bail-out: only German was tried: ${fbTimed}`);
    assert.equal(hpFb.capture.viewChecks.pseudo?.ok, true, `pseudo check: ${JSON.stringify(hpFb.capture.viewChecks.pseudo)}`);
    assert.ok(hpFb.screenshots.some((s) => s.view === 'pseudo') && !hpFb.screenshots.some((s) => TRANSLATED.includes(s.view)), 'a Long text shot, no translated shots');
    const intlFb = hpFb.plugins.international;
    assert.equal(intlFb?.status, 'ok', `international: ${intlFb?.error}`);
    assert.ok(intlFb.findings.some((f) => f.title === 'Text gets cut off when translated'), JSON.stringify({ intl: intlFb.findings.map((f) => f.title), pseudo: hpFb.capture.views.pseudo }));
    const couldNot = intlFb.findings.filter((f) => f.severity === 'info' && /could not run/.test(f.title));
    assert.deepEqual(couldNot.map((f) => f.title), ['Translated views could not run — translation unavailable in this browser'], `one page-wide note: ${JSON.stringify(intlFb.findings.map((f) => f.title))}`);
    const fbWarn = (hpFb.capture.warnings || []).filter((w) => /German|Arabic|Japanese/.test(w));
    assert.equal(fbWarn.length, 1, `one warning for the three: ${JSON.stringify(hpFb.capture.warnings)}`);
    await page2.evaluate(async (x) => (await import('/browser/store.js')).deleteReading(x), idFb);
    await fbPage.close();
    log('translation fallback passed');

    // 3. record a two-page flow
    await sw.evaluate((t) => globalThis.harplus.record(t), tabId);
    await page.goto(`${base}/`);
    await page.waitForLoadState('load');
    await page.goto(`${base}/page2.html`);
    await page.waitForLoadState('load');
    await page.waitForTimeout(500);
    const id4 = await sw.evaluate((t) => globalThis.harplus.stop(t), tabId);
    const r4 = await waitDone(id4);
    assert.ok(r4.log.pages.length >= 2, `record mode pages: ${r4.log.pages.length}`);
    assert.equal(r4.log._harplus.target.title, 'Page two');
    log('record reading passed:', r4.log.pages.map((x) => x.title).join(' → '));

    // 4. viewer pages render
    await page2.goto(extUrl(`ui/reading.html?id=${id1}`));
    await page2.waitForSelector('#overview table.areas');
    // every pane renders and every ring/donut label fits inside its hole
    const panes = ['overview', 'area-performance', 'area-accessibility', 'area-security', 'area-content', 'area-build', 'area-infrastructure', 'area-international', 'area-sustainability', 'issues', 'network', 'screens', 'notes'];
    for (const pane of panes) {
      await page2.evaluate((p) => { location.hash = p; }, pane);
      await page2.waitForFunction((p) => getComputedStyle(document.getElementById(p)).display !== 'none', pane);
      const bad = await page2.evaluate(() => [...document.querySelectorAll('svg.ring, svg.donut')]
        .filter((svg) => svg.getBoundingClientRect().width > 0)
        .flatMap((svg) => {
          const c = svg.querySelector('circle');
          const inner = 2 * (Number(c.getAttribute('r')) - Number(c.getAttribute('stroke-width')) / 2);
          return [...svg.querySelectorAll('text')].map((t) => ({ text: t.textContent, w: t.getBBox().width, limit: inner * 0.8 }));
        })
        .filter((x) => x.w > x.limit));
      assert.deepEqual(bad, [], `ring labels overflow on ${pane}`);
      for (const width of [1280, 800]) {
        await page2.setViewportSize({ width, height: 800 });
        const overflow = await page2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `${pane} overflows horizontally by ${overflow}px at ${width}px`);
      }
      await page2.setViewportSize({ width: 1280, height: 800 });
      await page2.screenshot({ path: join(OUT, `reading-${pane}.png`), fullPage: true });
    }
    // The Performance pane has the coverage panel.
    await page2.evaluate(() => { location.hash = 'area-performance'; });
    const covPanel = await page2.evaluate(() => {
      const d = document.querySelector('#area-performance details#p-coverage');
      if (!d) return null;
      d.open = true;
      return d.textContent;
    });
    assert.ok(covPanel && /not used during load/.test(covPanel), `the Performance pane renders the coverage panel: ${covPanel?.slice(0, 200)}`);
    log('coverage panel rendered');
    // The Overview: the Areas table, worst first; Reading health from the strip; the page fits a phone; Help; contrast.
    await page2.evaluate(() => { location.hash = 'overview'; });
    const areaRows = await page2.evaluate(() => [...document.querySelectorAll('#overview table.areas tbody tr')].map((tr) => tr.querySelector('.score-num').textContent.trim()));
    assert.equal(areaRows.length, 8, `eight area rows: ${JSON.stringify(areaRows)}`);
    const scored = areaRows.filter((s) => /^\d+$/.test(s)).map(Number);
    assert.ok(scored.length && scored[0] === Math.min(...scored) && /^\d+$/.test(areaRows[0]), `lowest score first: ${JSON.stringify(areaRows)}`);
    assert.deepEqual(scored, [...scored].sort((a, b) => a - b), `scores ascend: ${JSON.stringify(areaRows)}`);
    assert.equal(await page2.locator('#reading-health').evaluate((d) => d.open), false, 'Reading health starts closed');
    const skippedLink = page2.locator('#overview .status-strip a[href="#reading-health-detail"]');
    if (await skippedLink.count()) await skippedLink.click();
    else await page2.evaluate(() => { location.hash = 'reading-health'; });
    await page2.waitForFunction(() => document.getElementById('reading-health').open);
    assert.ok(await page2.evaluate(() => getComputedStyle(document.getElementById('overview')).display !== 'none'), 'the Overview stays shown on #reading-health');
    await page2.evaluate(() => { document.getElementById('reading-health').open = false; location.hash = 'overview'; });
    const fitsPanel = (pg) => pg.evaluate(() => { const t = document.querySelector('#overview table.areas'); return t.getBoundingClientRect().right - t.closest('.panel-body').getBoundingClientRect().right + parseFloat(getComputedStyle(t.closest('.panel-body')).paddingRight); });
    for (const width of [1100, 1180, 1280, 800]) {
      await page2.setViewportSize({ width, height: 800 });
      assert.ok(await fitsPanel(page2) <= 1, `the Areas table stays inside its panel at ${width}: ${await fitsPanel(page2)}px over`);
    }
    await page2.setViewportSize({ width: 1280, height: 800 });
    assert.equal(await page2.locator('#overview table.areas th.mix-col').isVisible(), true, 'the full Areas table, with its severity mix, at 1280');
    await page2.setViewportSize({ width: 390, height: 844 });
    const narrowOv = await page2.evaluate(() => ({ doc: document.documentElement.scrollWidth, table: (() => { const t = document.querySelector('#overview table.areas'); return t.scrollWidth - t.clientWidth; })(), strip: (() => { const s = document.querySelector('#overview .status-strip'); return s.scrollWidth - s.clientWidth; })() }));
    assert.ok(narrowOv.doc <= 390 && narrowOv.table <= 1 && narrowOv.strip <= 1, `Overview fits 390px: ${JSON.stringify(narrowOv)}`);
    // The app bar is one row at 390: Re-run, Help, Export and Delete all show, side by side.
    const bar = await page2.evaluate(() => {
      const b = document.querySelector('.appbar');
      const btns = ['#rerun', 'button.help-btn', 'button[popovertarget="export-menu"]', '#delete'].map((s) => document.querySelector(s));
      const rs = btns.map((x) => x.getBoundingClientRect());
      return {
        height: b.getBoundingClientRect().height,
        visible: btns.map((x) => x.checkVisibility()),
        inView: rs.every((r) => r.width > 0 && r.left >= 0 && r.right <= innerWidth),
        tops: rs.map((r) => Math.round(r.top)),
      };
    });
    assert.ok(bar.height < 64, `the app bar is one row at 390: ${JSON.stringify(bar)}`);
    assert.deepEqual(bar.visible, [true, true, true, true], `all four app bar buttons show at 390: ${JSON.stringify(bar)}`);
    assert.ok(bar.inView && Math.max(...bar.tops) - Math.min(...bar.tops) <= 2, `the app bar buttons share one row at 390: ${JSON.stringify(bar)}`);
    await page2.setViewportSize({ width: 1280, height: 800 });
    await checkHelpEverywhere(page2, 'extension');
    const CONTRAST = ['#overview .hero .verdict', '#overview .status-strip', '#overview table.areas', '#overview .stat-label', '#overview .stat-note'];
    for (const scheme of ['light', 'dark']) {
      await page2.emulateMedia({ colorScheme: scheme });
      const ov = await contrastFailures(page2, CONTRAST);
      await page2.click('button.help-btn');
      const helpC = await contrastFailures(page2, ['#help']);
      await page2.keyboard.press('Escape');
      const kinds = new Set(ov.checked.map((x) => x.sel));
      assert.equal(kinds.size, CONTRAST.length, `every Overview contrast target has text: ${JSON.stringify([...kinds])}`);
      assert.deepEqual([...ov.failures, ...helpC.failures], [], `${scheme} contrast`);
      log(`overview contrast ${scheme}: ${ov.checked.length} texts, min ${ov.min.toFixed(2)}:1; help ${helpC.checked.length} texts, min ${helpC.min.toFixed(2)}:1`);
    }
    await page2.emulateMedia({ colorScheme: 'light' });
    // Help is not printed (print opens every details instead).
    await page2.click('button.help-btn');
    await page2.emulateMedia({ media: 'print' });
    assert.equal(await page2.evaluate(() => getComputedStyle(document.getElementById('help')).display), 'none', 'Help is hidden in print');
    await page2.emulateMedia({ media: 'screen' });
    await page2.keyboard.press('Escape');
    log('overview, reading health, help and contrast passed');
    // The area pane: the Checks rows add up to the sidebar count; a jump link brings its section to the top; it fits a phone; contrast.
    const areaShown = (p) => page2.evaluate((x) => getComputedStyle(document.getElementById(x)).display !== 'none', p);
    await page2.evaluate(() => { location.hash = 'area-accessibility'; });
    await page2.waitForFunction(() => getComputedStyle(document.getElementById('area-accessibility')).display !== 'none');
    const checkSums = await page2.evaluate(() => {
      const cells = [...document.querySelectorAll('#accessibility-checks table.checks tbody tr td.issues')].map((td) => td.textContent.trim());
      const sum = cells.reduce((n, t) => n + (t === 'No issues' ? 0 : t.split('·').reduce((m, part) => m + parseInt(part, 10), 0)), 0);
      return { cells, sum, sidebar: Number(document.querySelector('.sidebar a[data-pane="area-accessibility"] > b').textContent),
        listed: document.querySelectorAll('#accessibility-issues a.issue').length };
    });
    assert.ok(checkSums.cells.length > 0 && checkSums.sidebar > 0, `Accessibility has checks and issues: ${JSON.stringify(checkSums)}`);
    assert.equal(checkSums.sum, checkSums.sidebar, `the Checks rows add up to the sidebar count: ${JSON.stringify(checkSums)}`);
    assert.equal(checkSums.listed, checkSums.sidebar, 'the Issues section lists every Accessibility issue');
    await page2.locator('#area-accessibility nav.jump a[href="#accessibility-measurements"]').click();
    await page2.waitForFunction(() => location.hash === '#accessibility-measurements');
    await page2.waitForFunction(() => { const t = document.getElementById('accessibility-measurements').getBoundingClientRect().top; return t >= 0 && t <= 100; }, null, { timeout: 5000 })
      .catch(() => {}); // safe: a timeout only means the wait gave up; the measureTop assertion below still fails with the real value
    const measureTop = await page2.evaluate(() => document.getElementById('accessibility-measurements').getBoundingClientRect().top);
    assert.ok(await areaShown('area-accessibility'), 'the pane stays shown on #accessibility-measurements');
    assert.ok(measureTop >= 0 && measureTop <= 100, `Measurements is at the top: ${measureTop}px`);
    // A Checks "Data" link targets the plugin's body (#pd-<id>) and opens its closed details; the pane stays current.
    const dataHref = await page2.evaluate(() => [...document.querySelectorAll('#accessibility-checks td.data-link a')]
      .map((a) => a.getAttribute('href')).find((h) => { const d = document.getElementById(h.slice(1))?.closest('details.plugin'); return d && !d.open; }));
    assert.ok(dataHref && dataHref.startsWith('#pd-'), `a Data link to a closed plugin body: ${dataHref}`);
    await page2.locator(`#accessibility-checks td.data-link a[href="${dataHref}"]`).click();
    await page2.waitForFunction((h) => location.hash === h && document.getElementById(h.slice(1)).closest('details.plugin').open, dataHref, { timeout: 5000 });
    assert.ok(await areaShown('area-accessibility'), `the pane stays shown on ${dataHref}`);
    assert.equal(await page2.evaluate(() => document.querySelector('.sidebar a[aria-current="page"]')?.dataset.pane), 'area-accessibility', `${dataHref} marks the Accessibility pane current`);
    await page2.evaluate((h) => { document.getElementById(h.slice(1)).closest('details.plugin').open = false; }, dataHref);
    // Clicking it again (no hashchange) opens it too.
    await page2.locator(`#accessibility-checks td.data-link a[href="${dataHref}"]`).click();
    await page2.waitForFunction((h) => document.getElementById(h.slice(1)).closest('details.plugin').open, dataHref, { timeout: 5000 });
    await page2.evaluate((h) => { document.getElementById(h.slice(1)).closest('details.plugin').open = false; }, dataHref);
    const AREA_CONTRAST = (a) => [`#${a}-checks table.checks thead`, `#${a}-checks table.checks tbody`, `#area-${a} .area-head p.area-sum`, `#area-${a} .area-head h1`];
    for (const scheme of ['light', 'dark']) {
      await page2.emulateMedia({ colorScheme: scheme });
      for (const a of ['accessibility', 'content']) {
        await page2.evaluate((x) => { location.hash = `area-${x}`; }, a);
        await page2.waitForFunction((x) => getComputedStyle(document.getElementById(`area-${x}`)).display !== 'none', a);
        const ac = await contrastFailures(page2, AREA_CONTRAST(a));
        // Every target has visible text (thead is visually hidden only at phone width).
        assert.equal(new Set(ac.checked.map((x) => x.sel)).size, 4, `${a}: every area contrast target has text: ${JSON.stringify([...new Set(ac.checked.map((x) => x.sel))])}`);
        assert.deepEqual(ac.failures, [], `${a} ${scheme} area contrast`);
        log(`area ${a} contrast ${scheme}: ${ac.checked.length} texts, min ${ac.min.toFixed(2)}:1`);
      }
    }
    await page2.emulateMedia({ colorScheme: 'light' });
    await page2.setViewportSize({ width: 390, height: 844 });
    for (const a of ['accessibility', 'content']) {
      await page2.evaluate((x) => { location.hash = `area-${x}`; }, a);
      await page2.waitForFunction((x) => getComputedStyle(document.getElementById(`area-${x}`)).display !== 'none', a);
      const w = await page2.evaluate((x) => ({ doc: document.documentElement.scrollWidth, pane: document.getElementById(`area-${x}`).scrollWidth,
        checks: (() => { const t = document.querySelector(`#${x}-checks table.checks`); return t ? t.scrollWidth - t.clientWidth : 0; })() }), a);
      assert.ok(w.doc <= 390 && w.pane <= 390 && w.checks <= 1, `area-${a} fits 390px: ${JSON.stringify(w)}`);
    }
    await page2.setViewportSize({ width: 1280, height: 800 });
    log('area pane: checks add up, jump bar, contrast, 390px passed');
    // Accessibility: the Images & alt text panel is first, open, and lists the fixtures with verdicts and thumbnails.
    await page2.evaluate(() => { location.hash = 'area-accessibility'; });
    const mapPanel = page2.locator('#area-accessibility #p-a11y-map');
    assert.equal(await mapPanel.count(), 1, 'Images & alt text panel');
    assert.equal(await page2.evaluate(() => document.querySelector('#area-accessibility details.plugin')?.id), 'p-a11y-map', 'panel is first');
    assert.equal(await mapPanel.getAttribute('open'), '');
    const verdictOf = async (needle) => (await mapPanel.locator('tbody tr', { hasText: needle }).first().locator('.chip-r').first().innerText()).trim();
    for (const [needle, verdict] of [['“image of a tent”', 'suspicious'], ['“Summer clearance”', 'redundant'], ['“IMG_4821”', 'file name'],
      ['“Camp stove”', 'repeated'], ['“Green square”', 'ok'], ['“Trail at dawn”', 'ok'], ['“A very long description', 'too long'], ['name: “Home”', 'ok']]) {
      assert.equal(await verdictOf(needle), verdict, `verdict for ${needle}`);
    }
    assert.ok(await mapPanel.locator('tbody tr', { hasText: 'empty (decorative)' }).count() >= 1, 'decorative row');
    assert.ok(await mapPanel.locator('tbody tr', { hasText: 'empty in link' }).count() >= 1, 'empty linked row');
    assert.ok(await mapPanel.locator('tbody tr', { hasText: 'no alt' }).count() >= 1, 'missing alt row');
    const thumbs = await page2.evaluate(() => {
      const all = [...document.querySelectorAll('#p-a11y-map .crop:not(.crop-none)')];
      const bg = all.filter((c) => /^url\("data:image\/webp/.test(getComputedStyle(c).backgroundImage)).length;
      return { n: all.length, bg, sized: all.filter((c) => parseFloat(getComputedStyle(c).width) > 0).length };
    });
    assert.ok(thumbs.n >= 8, `thumbnails: ${thumbs.n}`);
    assert.equal(thumbs.bg, thumbs.n, 'every thumbnail draws the screenshot');
    assert.equal(thumbs.sized, thumbs.n);
    log('images panel:', JSON.stringify(thumbs));
    await mapPanel.screenshot({ path: join(OUT, 'reading-images-panel.png') });
    // Page map: markers over the screenshot, alt text on the images, the keyboard path; legend checkboxes hide by CSS.
    const pm = page2.locator('#area-accessibility #p-page-map');
    assert.equal(await pm.count(), 1, 'Page map panel');
    assert.equal(await page2.evaluate(() => document.querySelector('#p-a11y-map').nextElementSibling?.id), 'p-page-map', 'right after the Images panel');
    const pmStats = await page2.evaluate(() => {
      const q = (s) => [...document.querySelectorAll(`#p-page-map ${s}`)];
      const canvas = document.querySelector('#p-page-map .pm-canvas');
      const cats = {};
      for (const m of q('.pm-mark')) { const c = [...m.classList].find((x) => x.startsWith('c-')); cats[c] = (cats[c] || 0) + 1; }
      return { marks: q('.pm-mark').length, cats, alts: q('.pm-alt').map((e) => e.textContent), path: q('.pm-path path.step').length,
        list: q('.pm-rows li').length, groups: q('.pm-list > .pm-group').length, bg: getComputedStyle(canvas).backgroundImage.slice(0, 26), height: canvas.getBoundingClientRect().height,
        trail: q('.pm-mark.pm-img').find((m) => m.textContent.includes('Trail at dawn'))?.getAttribute('style') || '' };
    });
    log('page map:', JSON.stringify({ ...pmStats, alts: pmStats.alts.length }));
    assert.ok(pmStats.marks >= 10, `markers drawn: ${pmStats.marks}`);
    assert.ok(pmStats.alts.includes('“Trail at dawn”'), `alt label on the image: ${pmStats.alts}`);
    assert.ok(pmStats.cats['c-keyboard'] >= 3 && pmStats.cats['c-error'] >= 1 && pmStats.cats['c-feature'] >= 1 && pmStats.cats['c-structure'] >= 1, JSON.stringify(pmStats.cats));
    assert.equal(pmStats.path, 1, 'keyboard path drawn');
    assert.equal(pmStats.list, pmStats.marks, 'a list row per marker');
    assert.ok(pmStats.groups > 1 && pmStats.groups < pmStats.marks, `rows grouped by rule: ${pmStats.groups}`);
    // Every heading and landmark gets a structure marker (resolved by its unique key).
    const sd = await page2.evaluate(async (x) => {
      const p = (await (await import('/browser/store.js')).getReading(x)).log._harplus.plugins;
      return { h: p['a11y-structure'].data.headings.length, l: p['a11y-structure'].data.landmarkList.length, s: p['a11y-map'].data.marks.filter((m) => m.category === 'structure').length };
    }, id1);
    assert.ok(sd.h + sd.l > 5, JSON.stringify(sd));
    assert.equal(sd.s, sd.h + sd.l, `structure markers for every heading and landmark: ${JSON.stringify(sd)}`);
    assert.equal(pmStats.cats['c-structure'], sd.s, 'all drawn');
    assert.match(pmStats.bg, /^url\("data:image\/webp/, 'the map draws the full-page shot');
    assert.ok(pmStats.height > 200, `map height ${pmStats.height}`);
    // Alignment: the Trail at dawn marker sits where the image is on the live page (percent of the document).
    const live = await context.newPage();
    if (page.viewportSize()) await live.setViewportSize(page.viewportSize());
    await live.goto(`${base}/`);
    await live.waitForLoadState('load');
    const trailLive = await live.evaluate(() => {
      const r = document.querySelector('img[alt="Trail at dawn"]').getBoundingClientRect();
      const de = document.documentElement;
      return { left: ((r.left + scrollX) / de.scrollWidth) * 100, top: ((r.top + scrollY) / de.scrollHeight) * 100 };
    });
    await live.close();
    const [, mLeft, mTop] = pmStats.trail.match(/left:([\d.]+)%;top:([\d.]+)%/).map(Number);
    assert.ok(Math.abs(mLeft - trailLive.left) < 1.5 && Math.abs(mTop - trailLive.top) < 1.5, `Trail marker ${mLeft},${mTop} vs live ${trailLive.left},${trailLive.top}`);
    // Toggling Features hides their markers and list entries through CSS alone.
    const shownFeatures = () => page2.evaluate(() => [...document.querySelectorAll('#p-page-map .c-feature')].filter((e) => e.matches('.pm-mark, li') && getComputedStyle(e).display !== 'none').length);
    assert.ok(await shownFeatures() > 0);
    await pm.locator('label[for="pm-t-feature"]').click();
    assert.equal(await shownFeatures(), 0, 'features hidden');
    await pm.locator('label[for="pm-t-keyboard"]').click();
    assert.equal(await page2.evaluate(() => getComputedStyle(document.querySelector('#p-page-map .pm-path')).display), 'none', 'path hidden with the keyboard category');
    await pm.locator('label[for="pm-t-keyboard"]').click();
    await pm.locator('label[for="pm-t-feature"]').click();
    assert.ok(await shownFeatures() > 0, 'features back');
    // Selecting a marker shows its details and highlights its list entry.
    await pm.locator('.pm-mark.c-error .pm-icon').first().click();
    assert.equal(await pm.locator('#pm-detail').isVisible(), true, 'details shown');
    assert.match(await pm.locator('#pm-detail').innerText(), /Error/);
    // The marker's details carry the fix-it reference: what, how to fix and WCAG criteria linked to their pages.
    assert.match(await pm.locator('#pm-detail').innerText(), /How to fix:/, 'axe marker: fix text');
    await pm.locator('.pm-mark .pm-icon[title*="Fieldset without a legend"]').first().click();
    const detailText = await pm.locator('#pm-detail').innerText();
    for (const re of [/What:/, /Why it matters:/, /How to fix:.*legend/, /WCAG:\s*1\.3\.1 Info and Relationships, 3\.3\.2 Labels or Instructions/]) assert.match(detailText, re, detailText);
    assert.equal(await pm.locator('#pm-detail a[href="https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html"]').count(), 1, 'WCAG criterion linked');
    await pm.locator('#pm-detail').screenshot({ path: join(OUT, 'reading-page-map-detail.png') });
    // A WAVE-style heuristic marker explains itself too (HARgus's own text, not axe's rule page).
    await pm.locator('.pm-group', { hasText: 'Fieldset without a legend' }).first().evaluate((d) => { d.querySelector('details').open = true; });
    const fsGroup = await pm.locator('.pm-group', { hasText: 'Fieldset without a legend' }).first().innerText();
    assert.match(fsGroup, /Add <legend> as the first child/, 'group shows the fix');
    assert.match(fsGroup, /1\.3\.1 Info and Relationships/);
    assert.equal(await pm.locator('.pm-rows li.selected').count(), 1, 'list row highlighted');
    assert.equal(await pm.locator('.pm-rows li.selected').evaluate((li) => li.closest('details').open), true, 'its group opened');
    assert.ok(!(await page2.evaluate(() => location.hash)).startsWith('#pm-i-'), 'the viewer does not follow the marker link');
    // Keyboard: Enter on a marker number in the list selects that marker and moves focus to its details.
    const kbGroup = pm.locator('.pm-group.c-keyboard > details');
    await kbGroup.locator('summary').focus();
    await page2.keyboard.press('Enter');
    assert.equal(await kbGroup.evaluate((d) => d.open), true, 'Enter opens a group');
    await kbGroup.locator('.pm-go').nth(2).focus();
    await page2.keyboard.press('Enter');
    assert.equal(await page2.evaluate(() => document.activeElement?.id), 'pm-detail', 'focus moves to the details');
    assert.match(await pm.locator('#pm-detail').innerText(), /Keyboard/);
    const goN = await kbGroup.locator('.pm-go').nth(2).getAttribute('href');
    assert.equal(await pm.locator(`.pm-mark.selected`).getAttribute('id'), goN.slice(1), 'that marker is selected');
    await pm.locator('.pm-mark.pm-img', { hasText: 'Trail at dawn' }).scrollIntoViewIfNeeded();
    await pm.screenshot({ path: join(OUT, 'reading-page-map.png') });
    await page2.evaluate(() => { document.querySelector('#p-page-map .pm-frame').style.maxHeight = 'none'; });
    await pm.locator('.pm-frame').screenshot({ path: join(OUT, 'reading-page-map-full.png') });
    await page2.evaluate(() => { document.querySelector('#p-page-map .pm-frame').style.maxHeight = ''; });
    // The Issues pane: a list row per issue, one detail at a time by :target, its reference on demand.
    const paneShown = (id) => page2.evaluate((p) => getComputedStyle(document.getElementById(p)).display !== 'none', id);
    const shownDetails = () => page2.evaluate(() => [...document.querySelectorAll('#issues article.issue-detail')].filter((a) => getComputedStyle(a).display !== 'none').map((a) => a.id));
    const issuesInPage = () => page2.evaluate(async (x) => {
      const [{ getReading }, { scoreReading, profileFromSettings }, { allIssues }, { getPlugins }, { getSettings }, { issueMarkdown }] = await Promise.all([
        import('/browser/store.js'), import('/core/score.js'), import('/core/issues.js'), import('/plugins/index.js'), import('/browser/settings.js'), import('/core/harplus.js')]);
      const all = allIssues(scoreReading(await getReading(x), getPlugins(), { profile: profileFromSettings(await getSettings()) }));
      return all.map((i) => ({ key: i.key, severity: i.severity, md: issueMarkdown(i) }));
    }, id1);
    const issueList = await issuesInPage();
    await page2.evaluate(() => { location.hash = 'issues'; });
    assert.ok(await paneShown('issues'), 'the Issues pane shows');
    assert.equal(await page2.locator('#issues-list a.issue').count(), issueList.length, 'a row per issue');
    // At 1280 the detail sticks beside the list: opening a row far down leaves the page where it was.
    const farRow = await page2.evaluate(() => {
      for (const d of document.querySelectorAll('#issues-list details.issue-fold')) d.open = true; // the whole list, so it runs well past the fold
      const rows = [...document.querySelectorAll('#issues-list a.issue')];
      const row = rows[rows.length - 1];
      row.scrollIntoView({ block: 'center' });
      return { href: row.getAttribute('href'), y: scrollY };
    });
    assert.ok(farRow.y > 200, `the list is long enough to scroll (scrollY ${farRow.y})`);
    await page2.locator(`#issues-list a.issue[href="${farRow.href}"]`).click();
    await page2.waitForSelector(`#issues-list a.issue[href="${farRow.href}"][aria-current="true"]`); // after hashchange
    const opened = await page2.evaluate((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return { y: scrollY, top: r.top, bottom: r.bottom, h: innerHeight };
    }, farRow.href.slice(1));
    assert.ok(Math.abs(opened.y - farRow.y) < 50, `the page stays put (scrollY ${farRow.y} → ${opened.y})`);
    assert.ok(opened.top >= 0 && opened.top < opened.h && opened.bottom > 0, `the detail is in view (top ${opened.top})`);
    const currentRows = () => page2.$$eval('#issues-list a.issue[aria-current="true"]', (xs) => xs.map((x) => x.getAttribute('href')));
    assert.deepEqual(await currentRows(), [farRow.href], 'the opened row is the current one');
    await page2.evaluate(() => { for (const d of document.querySelectorAll('#issues-list details.issue-fold')) d.open = false; scrollTo(0, 0); });
    // A row opens its detail, and only that one shows.
    const fixLink = page2.locator('#issues-list a.issue', { hasText: 'Fieldsets without a legend' }).first();
    assert.equal(await fixLink.count(), 1, 'the fieldset issue is in the list');
    const fixHash = (await fixLink.getAttribute('href')).slice(1);
    await fixLink.click();
    await page2.waitForSelector(`#issues-list a.issue[href="#${fixHash}"][aria-current="true"]`);
    assert.equal(await page2.evaluate(() => location.hash), `#${fixHash}`);
    assert.match(fixHash, /^issue-/);
    assert.deepEqual(await shownDetails(), [fixHash], 'only the clicked issue’s detail shows');
    assert.deepEqual(await currentRows(), [`#${fixHash}`], 'aria-current on the clicked row only');
    const fixRow = page2.locator(`#${fixHash}`);
    await fixRow.locator('details.disclosure > summary', { hasText: 'Reference' }).click();
    const fixText = await fixRow.innerText();
    for (const re of [/What:/, /Why it matters:/, /How to fix:/, /WCAG:\s*1\.3\.1 Info and Relationships/]) assert.match(fixText, re);
    assert.equal(await fixRow.locator('a[href="https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html"]').count(), 1, 'criterion links to its page');
    assert.ok(await page2.locator('#issues article.issue-detail details.disclosure', { hasText: 'Follow the rule page' }).count() >= 1, 'axe findings use the rule page');
    await fixRow.screenshot({ path: join(OUT, 'reading-issue-detail.png') });
    // Copy as Markdown puts the issue's Markdown (the brief's line, its places below) on the clipboard and says so.
    await page2.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
    await fixRow.locator('button[data-act="copy-md"]').click();
    await page2.waitForSelector('.toast:text("Issue copied")');
    assert.equal(await page2.evaluate(() => window.__copied), issueList.find((i) => `issue-${i.key}` === fixHash).md, 'Copy as Markdown copies issueMarkdown');
    // Next hides the detail that held the focus: focus lands in the one that shows, and its row is current.
    const nextHref = await fixRow.locator('.issue-nav a[rel="next"]').getAttribute('href');
    await fixRow.locator('.issue-nav a[rel="next"]').click();
    await page2.waitForSelector(`#issues-list a.issue[href="${nextHref}"][aria-current="true"]`); // after hashchange
    const focusIn = await page2.evaluate(() => ({ tag: document.activeElement?.tagName, art: document.activeElement?.closest('article.issue-detail')?.id }));
    assert.equal(focusIn.art, nextHref.slice(1), `focus is in the shown detail, not ${focusIn.tag}`);
    assert.deepEqual(await shownDetails(), [nextHref.slice(1)]);
    assert.deepEqual(await currentRows(), [nextHref], 'aria-current follows Next');
    // Severity chips draw the shared severity badge; Low stays open across re-renders; filters announce the count.
    assert.equal(await page2.locator('#issues-tools button[data-sev="high"][aria-pressed="true"] > .sev[data-sev="high"]').count(), 1, 'the chip uses h.sev');
    assert.equal(await page2.locator('#issues-tools .sev-high').count(), 0, 'no old sev-x markup');
    const fold = (g) => page2.locator(`#issues-list details.issue-fold[data-group="${g}"]`);
    assert.equal(await fold('low').evaluate((d) => d.open), false, 'Low starts folded');
    await fold('low').locator('summary').click();
    await page2.click('#issues-tools button[data-sev="high"]');
    for (const g of ['low', 'info']) if (await fold(g).count()) assert.equal(await fold(g).evaluate((d) => d.open), true, `a filter opens ${g}`);
    await page2.waitForFunction(() => /^\d+ of \d+ issues shown$/.test(document.getElementById('issues-live')?.textContent || ''));
    const said = await page2.locator('#issues-live').textContent();
    assert.equal(said, `${await page2.locator('#issues-list a.issue').count()} of ${issueList.length} issues shown`, `announced: ${said}`);
    await page2.click('#issues-tools button[data-sev="high"]');
    assert.equal(await fold('low').evaluate((d) => d.open), true, 'Low stays open after the re-render');
    if (await fold('info').count()) assert.equal(await fold('info').evaluate((d) => d.open), false, 'Info goes back to folded');
    await fold('low').locator('summary').click();
    // High only: the list has only High rows; a link to a Low issue clears the filters and shows it.
    for (const sv of ['medium', 'low', 'info']) await page2.click(`#issues-tools button[data-sev="${sv}"]`);
    const rowSevs = await page2.$$eval('#issues-list a.issue > .sev', (xs) => xs.map((x) => x.dataset.sev));
    assert.ok(rowSevs.length > 0 && rowSevs.every((s) => s === 'high'), `only High rows: ${rowSevs.join(', ')}`);
    const lowKey = issueList.find((i) => i.severity === 'low')?.key;
    assert.ok(lowKey, 'the test page has a Low issue');
    await page2.evaluate((k) => { location.hash = `issue-${k}`; }, lowKey);
    await page2.waitForSelector('.toast:text("Filters cleared to show this issue")');
    assert.deepEqual(await shownDetails(), [`issue-${lowKey}`], 'the requested issue shows');
    assert.deepEqual(await page2.$$eval('#issues-tools button[data-sev]', (xs) => xs.map((x) => x.getAttribute('aria-pressed'))), ['true', 'true', 'true', 'true'], 'every severity chip is on again');
    assert.equal(await page2.locator('#issues-list a.issue').count(), issueList.length, 'every severity back');
    assert.deepEqual(await currentRows(), [`#issue-${lowKey}`], 'its row is current');
    // The old pane name and an issue this reading doesn't have land on the Issues pane.
    for (const hash of ['findings', 'issue-nope']) {
      await page2.evaluate(() => { location.hash = 'overview'; });
      await page2.evaluate((x) => { location.hash = x; }, hash);
      await page2.waitForFunction(() => getComputedStyle(document.getElementById('issues')).display !== 'none', null, { timeout: 5000 });
      assert.equal((await shownDetails()).length, 1, `#${hash}: one detail shows`);
    }
    // A broken link's status code opens its request in Network (the fixture records a 404 asset that Link check groups).
    await page2.evaluate(() => { location.hash = 'issues'; });
    const placeCode = page2.locator('#issues article.issue-detail a.place-code[data-entry]').first();
    assert.ok(await placeCode.count() > 0, 'the test page has a broken-link place with a recorded request');
    const entry = await placeCode.getAttribute('data-entry');
    const art = await placeCode.evaluate((a) => a.closest('article').id);
    assert.equal(await page2.locator('#issues article.issue-detail[id$="broken-page"] a.place-code[data-entry]').count(), 0, 'on-page anchors carry no entry');
    await page2.evaluate((id) => { location.hash = id; }, art);
    await placeCode.click();
    await page2.waitForSelector(`#ed-${entry}`);
    assert.ok(await paneShown('network'), 'the status code opens Network');
    await page2.click(`#net-table tr[data-entry="${entry}"] button.disclose`);
    assert.equal(await page2.locator(`#ed-${entry}`).count(), 0, 'collapsed again');
    // An area's "Open in Issues →" lands on Issues with that area chosen (every area with issues has it): Accessibility's.
    const areaMore = page2.locator('#area-accessibility a.more[data-area][href="#issues"]');
    assert.equal(await areaMore.count(), 1, 'Accessibility has an Open in Issues link');
    const area = await areaMore.getAttribute('data-area');
    assert.equal(area, 'accessibility');
    const inArea = await page2.locator(`#${area}-issues a.issue`).count();
    await page2.evaluate((a) => { location.hash = `area-${a}`; }, area);
    await page2.locator(`#area-${area} a.more[data-area]`).click();
    await page2.waitForFunction(() => getComputedStyle(document.getElementById('issues')).display !== 'none');
    assert.equal(await page2.locator('#f-area').inputValue(), area, 'the area is selected');
    assert.ok(inArea > 0 && await page2.locator('#issues-list a.issue').count() === inArea, 'its issues are listed');
    await page2.selectOption('#f-area', '');
    await page2.evaluate(() => { location.hash = 'area-accessibility'; });
    // The Keyboard order table in the Structure panel: every stop, the trap, unnamed stops in red.
    const kbPanel = page2.locator('#area-accessibility #p-a11y-structure');
    await kbPanel.evaluate((d) => { d.open = true; });
    const outSub = kbPanel.locator('section.sub', { has: page2.locator('h4', { hasText: 'Structure outline' }) });
    assert.equal(await outSub.count(), 1, 'Structure outline');
    assert.ok(await outSub.locator('li.lm > .chip-r', { hasText: 'banner' }).count() >= 1, 'banner landmark badge');
    assert.ok(await outSub.locator('li.lm', { hasText: 'main' }).locator('li', { hasText: 'Gear for the field' }).count() >= 1, 'h1 nested in main');
    assert.ok(await outSub.locator('.chip-r.rating-poor', { hasText: 'skipped level' }).count() >= 1, 'skipped level in red');
    await outSub.screenshot({ path: join(OUT, 'reading-structure-outline.png') });
    const kbSub = kbPanel.locator('section.sub', { has: page2.locator('h4', { hasText: 'Keyboard order' }) });
    assert.equal(await kbSub.count(), 1, 'Keyboard order table');
    assert.match(await kbSub.locator('p.muted').first().innerText(), /trapped/);
    assert.ok(await kbSub.locator('tbody tr').count() > 5, 'a row per stop');
    assert.ok(await kbSub.locator('.chip-r.rating-poor', { hasText: 'no accessible name' }).count() >= 1, 'unnamed stop in red');
    assert.ok(await kbSub.locator('tbody tr', { hasText: 'Off-screen link' }).locator('.chip-r', { hasText: 'off-screen' }).count() === 1, 'off-screen flag');
    await kbSub.screenshot({ path: join(OUT, 'reading-keyboard-order.png') });
    // a deep link survives a fresh load (script-inserted panes do not get :target by themselves)
    await page2.goto(extUrl(`ui/reading.html?id=${id1}#area-security`));
    await page2.waitForSelector('#overview table.areas', { state: 'attached' });
    assert.ok(await page2.evaluate(() => getComputedStyle(document.getElementById('area-security')).display !== 'none'), 'deep link shows its pane');
    await page2.evaluate(() => { location.hash = 'area-content'; });
    assert.equal(await page2.locator('#area-content .pv-card').count(), 7, 'seven share previews');
    assert.ok(await page2.locator('#area-content .pv-card img[src^="data:image/webp"]').count() >= 1, 'previews use the thumbnail');
    await page2.evaluate(() => { location.hash = 'screens'; });
    assert.ok(await page2.locator('#screens h2', { hasText: 'Accessibility views' }).count() === 1, 'accessibility views section');
    assert.equal(await page2.locator('#screens h2', { hasText: 'Breakpoints' }).count(), 1, 'breakpoints section');
    assert.ok(await page2.locator('#screens .vision-grid figure').count() === 7, '6 vision views + as designed');
    await page2.evaluate(() => { location.hash = 'network'; });
    // The waterfall: phase segments and the page-event lines.
    assert.ok(await page2.locator('#net-table tbody tr[data-entry] .bar i').count() > 1, 'bars are split into phases');
    assert.ok(await page2.locator('#net-table tr[data-entry] .mk-dcl').count() > 0, 'DOMContentLoaded line drawn');
    assert.ok(await page2.locator('#net-table tr[data-entry] .mk-load').count() > 0, 'load line drawn');
    // Enter on the disclosure expands the row in place; the Overview tab is open.
    const disc = page2.locator('#net-table tr[data-entry="0"] button.disclose');
    await disc.focus();
    await page2.keyboard.press('Enter');
    await page2.waitForSelector('#ed-0 .req-detail');
    assert.equal(await disc.getAttribute('aria-expanded'), 'true');
    assert.match(await page2.locator('#ed-0-p-overview').innerText(), /Requested by/);
    // The arrow keys move between tabs; the Wire tab shows the request line.
    await page2.locator('#ed-0-t-overview').focus();
    await page2.keyboard.press('ArrowRight');
    assert.equal(await page2.locator('#ed-0-t-timing').getAttribute('aria-selected'), 'true');
    assert.equal(await page2.locator('#ed-0-p-overview').isHidden(), true);
    await page2.keyboard.press('ArrowRight');
    await page2.keyboard.press('ArrowRight');
    assert.equal(await page2.evaluate(() => document.activeElement.id), 'ed-0-t-wire');
    assert.match(await page2.locator('#ed-0-p-wire pre').first().innerText(), /^GET \S+ HTTP\//);
    await page2.screenshot({ path: join(OUT, 'reading-request-detail.png') });
    // Escape collapses it and leaves focus on the row.
    await page2.keyboard.press('Escape');
    assert.equal(await page2.locator('#ed-0').count(), 0, 'detail row removed');
    assert.equal(await page2.evaluate(() => document.activeElement.closest('tr')?.dataset.entry), '0', 'focus back on the row');
    // Sort by size: the second click is descending.
    await page2.click('#net-table button[data-sort="size"]');
    await page2.click('#net-table button[data-sort="size"]');
    const sizes = await page2.$$eval('#net-table td[data-bytes]', (tds) => tds.map((td) => Number(td.dataset.bytes)));
    assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a), 'sorted by size, descending');
    assert.equal(await page2.locator('#net-table th[aria-sort="descending"] button[data-sort="size"]').count(), 1);
    assert.equal(await page2.evaluate(() => document.activeElement?.dataset.sort), 'size', 'focus stays on the sort button');
    // Review Focus 3: expanding a row, then filtering it out, leaves no orphaned detail; clearing the filter brings it back.
    await page2.locator('#net-table tr[data-entry="0"] button.disclose').click();
    await page2.waitForSelector('#ed-0');
    await page2.fill('#n-q', 'no-such-request-zzz');
    assert.equal(await page2.locator('#net-table .detail-row').count(), 0, 'no orphaned detail row');
    assert.equal(await page2.evaluate(() => document.activeElement.id), 'n-q', 'filtering keeps focus in the search box');
    await page2.fill('#n-q', '');
    await page2.waitForSelector('#ed-0 .req-detail');
    await page2.keyboard.press('Escape');
    // LCP path: dims rows off the path and names the LCP in a summary line.
    await page2.click('#net-table [data-wf-path]');
    assert.equal(await page2.locator('#net-table [data-wf-path]').getAttribute('aria-pressed'), 'true');
    assert.ok(await page2.locator('#net-table tr.off-path').count() > 0, 'off-path rows dimmed');
    assert.match(await page2.locator('#net-table .lcp-sum').innerText(), /^LCP \d+ ms — /);
    assert.equal(await page2.evaluate(() => document.activeElement?.hasAttribute('data-wf-path')), true, 'focus stays on the toggle');
    await page2.click('#net-table [data-wf-path]');
    assert.equal(await page2.locator('#net-table tr.off-path').count(), 0);
    // Group by site: localhost (third-party to 127.0.0.1) collapses; expanding shows its requests.
    await page2.click('#net-table [data-wf-groups]');
    const grp = page2.locator('#net-table tr[data-group]').first();
    assert.match(await grp.innerText(), /\d+ requests/);
    await grp.locator('button.grp-disc').click();
    assert.ok(await page2.locator('#net-table tr.grp-member').count() >= 2, 'members shown');
    assert.equal(await page2.locator('#net-table tr[data-group] button.grp-disc').first().getAttribute('aria-expanded'), 'true');
    await page2.click('#net-table [data-wf-groups]');
    // Overview brush: draw a window, the text changes and Reset is enabled; Reset returns to the whole load.
    const whole = await page2.locator('#wf-zoom-text').innerText();
    const ov = await page2.locator('#wf-overview').boundingBox();
    await page2.mouse.move(ov.x + ov.width * 0.02, ov.y + ov.height / 2);
    await page2.mouse.down();
    await page2.mouse.move(ov.x + ov.width * 0.4, ov.y + ov.height / 2, { steps: 5 });
    await page2.mouse.up();
    assert.notEqual(await page2.locator('#wf-zoom-text').innerText(), whole, 'brush zoomed the timeline');
    assert.equal(await page2.locator('[data-wf-reset]').isDisabled(), false);
    // Review Focus 2: filtering while zoomed keeps the window.
    const zoomed = await page2.locator('#wf-zoom-text').innerText();
    await page2.fill('#n-q', '127.0.0.1');
    assert.equal(await page2.locator('#wf-zoom-text').innerText(), zoomed, 'filter keeps the zoom');
    await page2.fill('#n-q', '');
    await page2.click('[data-wf-reset]');
    assert.equal(await page2.locator('#wf-zoom-text').innerText(), whole);
    // Keyboard on the end handle.
    const endH = page2.locator('#wf-overview .ov-h[data-edge="to"]');
    const endBefore = Number(await endH.getAttribute('aria-valuenow'));
    await endH.focus();
    await page2.keyboard.press('Shift+ArrowLeft');
    const endAfter = page2.locator('#wf-overview .ov-h[data-edge="to"]');
    assert.ok(Number(await endAfter.getAttribute('aria-valuenow')) < endBefore, 'ArrowLeft moved the end handle');
    assert.equal(await page2.evaluate(() => document.activeElement?.dataset.edge), 'to', 'focus stays on the handle');
    await page2.click('[data-wf-reset]');
    // Mouse-dragging a handle leaves focus on it after the re-render.
    const hb = await page2.locator('#wf-overview .ov-h[data-edge="to"]').boundingBox();
    await page2.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page2.mouse.down();
    await page2.mouse.move(hb.x - 80, hb.y + hb.height / 2, { steps: 5 });
    await page2.mouse.up();
    assert.equal(await page2.evaluate(() => document.activeElement?.dataset.edge), 'to', 'focus is on the end handle after a mouse drag');
    await page2.click('[data-wf-reset]');
    // Ctrl-wheel over the timeline zooms; over the summary line it does not (Review Focus 5).
    const tlCell = page2.locator('#net-table tr[data-entry] td.tl').first();
    const note = page2.locator('#net-table p.note').first();
    const twoFrames = () => page2.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page2.evaluate(() => { window.__wheelPrevented = []; document.addEventListener('wheel', (e) => window.__wheelPrevented.push(e.defaultPrevented)); });
    await tlCell.hover({ position: { x: 60, y: 10 } }); // hover scrolls into view and waits for layout to settle; a stale boundingBox hit the toolbar
    await page2.keyboard.down('Control');
    await page2.mouse.wheel(0, -200);
    await page2.keyboard.up('Control');
    await twoFrames();
    assert.deepEqual(await page2.evaluate(() => window.__wheelPrevented), [true], 'Ctrl-wheel over the timeline is prevented');
    assert.notEqual(await page2.locator('#wf-zoom-text').innerText(), whole, 'Ctrl-wheel over the timeline zooms');
    await page2.click('[data-wf-reset]');
    await note.hover({ position: { x: 5, y: 5 } });
    await page2.keyboard.down('Control');
    await page2.mouse.wheel(0, -200);
    await page2.keyboard.up('Control');
    await twoFrames();
    assert.deepEqual(await page2.evaluate(() => window.__wheelPrevented), [true, false], 'Ctrl-wheel outside the timeline is not prevented (page zoom stays)');
    assert.equal(await page2.locator('#wf-zoom-text').innerText(), whole, 'Ctrl-wheel outside the timeline leaves the zoom alone');
    // Pinned header: open a request so the box scrolls, scroll it, and the header stays at the top of the box.
    await page2.locator('#net-table tr[data-entry="0"] button.disclose').click();
    const pinned = await page2.evaluate(() => {
      const box = document.querySelector('#net-table .table-wrap.net');
      box.scrollTop = 200;
      return { scrolled: box.scrollTop, boxTop: box.getBoundingClientRect().top, headTop: box.querySelector('thead th').getBoundingClientRect().top };
    });
    assert.ok(pinned.scrolled > 0, 'the table box scrolls');
    assert.ok(Math.abs(pinned.headTop - pinned.boxTop) <= 2, `header pinned: ${JSON.stringify(pinned)}`);
    // The scroll position survives a re-render (Ctrl-wheel zoom over the pinned ruler) instead of jumping to row 1.
    const ruler = page2.locator('#net-table .tl-head .ruler');
    await ruler.hover({ position: { x: 90, y: 6 } });
    await page2.keyboard.down('Control');
    await page2.mouse.wheel(0, -200);
    await page2.keyboard.up('Control');
    await twoFrames();
    assert.notEqual(await page2.locator('#wf-zoom-text').innerText(), whole, 'wheel zoomed while scrolled');
    assert.equal(await page2.evaluate(() => document.querySelector('#net-table .table-wrap.net').scrollTop), pinned.scrolled, 'zoom keeps the table scroll position');
    await page2.click('[data-wf-reset]');
    assert.equal(await page2.evaluate(() => document.querySelector('#net-table .table-wrap.net').scrollTop), pinned.scrolled, 'reset keeps the table scroll position');
    // Ruler drag shows its selection while dragging, then zooms; Escape cancels a drag (Task 3).
    const dragRuler = async (afterMove) => {
      await ruler.hover({ position: { x: 90, y: 6 } }); // settles layout before measuring
      const rb = await ruler.boundingBox();
      await page2.mouse.move(rb.x + rb.width * 0.1, rb.y + rb.height / 2);
      await page2.mouse.down();
      await page2.mouse.move(rb.x + rb.width * 0.4, rb.y + rb.height / 2, { steps: 5 });
      await afterMove();
      await page2.mouse.up();
      await twoFrames();
    };
    await dragRuler(async () => { assert.equal(await page2.locator('.ruler-sel').count(), 1, 'ruler drag shows its selection'); });
    assert.notEqual(await page2.locator('#wf-zoom-text').innerText(), whole, 'ruler drag zooms');
    assert.notEqual(await page2.locator('#net-table .tl-head .ruler span').first().innerText(), '0 ms', 'first tick above 0');
    assert.equal(await page2.locator('.ruler-sel').count(), 0, 'selection removed after the drag');
    await page2.click('[data-wf-reset]');
    await dragRuler(async () => { await page2.keyboard.press('Escape'); });
    assert.equal(await page2.locator('#wf-zoom-text').innerText(), whole, 'Escape cancels a ruler drag');
    assert.equal(await page2.locator('.ruler-sel').count(), 0, 'Escape removes the selection');
    // Pan: dragging the brush keeps its width and moves it.
    await page2.locator('#wf-overview .ov-h[data-edge="to"]').focus();
    for (let k = 0; k < 5; k++) await page2.keyboard.press('Shift+ArrowLeft');
    const handles = async () => page2.evaluate(() => ({ from: Number(document.querySelector('#wf-overview .ov-h[data-edge="from"]').getAttribute('aria-valuenow')), to: Number(document.querySelector('#wf-overview .ov-h[data-edge="to"]').getAttribute('aria-valuenow')) }));
    const w0 = await handles();
    const bb = await page2.locator('#wf-overview .ov-brush').boundingBox();
    await page2.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page2.mouse.down();
    await page2.mouse.move(bb.x + bb.width / 2 + 60, bb.y + bb.height / 2, { steps: 5 });
    await page2.mouse.up();
    const w1 = await handles();
    assert.ok(Math.abs((w1.to - w1.from) - (w0.to - w0.from)) <= 1, `pan keeps width ${JSON.stringify([w0, w1])}`);
    assert.ok(w1.from > w0.from, 'pan moves right');
    await page2.click('[data-wf-reset]');
    // Focus survives a wheel zoom's re-render.
    await page2.locator('#net-table button.sort[data-sort="time"]').focus();
    await tlCell.hover({ position: { x: 60, y: 10 } });
    await page2.keyboard.down('Control');
    await page2.mouse.wheel(0, -200);
    await page2.keyboard.up('Control');
    await twoFrames();
    assert.equal(await page2.evaluate(() => document.activeElement?.dataset.sort), 'time', 'wheel zoom keeps focus');
    await page2.click('[data-wf-reset]');
    // A focused detail tabpanel keeps focus through a wheel zoom's re-render.
    await page2.locator('#net-table tr[data-entry="0"] button.disclose').click();
    await page2.click('#ed-0-t-timing');
    await page2.locator('#ed-0-p-timing').focus();
    await tlCell.hover({ position: { x: 60, y: 10 } });
    await page2.keyboard.down('Control');
    await page2.mouse.wheel(0, -200);
    await page2.keyboard.up('Control');
    await twoFrames();
    assert.equal(await page2.evaluate(() => document.activeElement?.id), 'ed-0-p-timing', 'wheel zoom keeps focus on a detail tabpanel');
    await page2.click('[data-wf-reset]');
    await page2.locator('#net-table tr[data-entry="0"] button.disclose').click();
    // Ctrl-wheel during a ruler drag neither zooms nor throws; the drag still completes.
    await ruler.hover({ position: { x: 90, y: 6 } });
    const rb2 = await ruler.boundingBox();
    await page2.mouse.move(rb2.x + rb2.width * 0.1, rb2.y + rb2.height / 2);
    await page2.mouse.down();
    await page2.mouse.move(rb2.x + rb2.width * 0.4, rb2.y + rb2.height / 2, { steps: 5 });
    await page2.keyboard.down('Control');
    await page2.mouse.wheel(0, -200);
    await page2.keyboard.up('Control');
    await twoFrames();
    assert.equal(await page2.locator('.ruler-sel').count(), 1, 'the ruler selection survives a wheel during the drag');
    assert.equal(await page2.locator('#wf-zoom-text').innerText(), whole, 'a wheel during a drag does not zoom');
    await page2.mouse.up();
    await twoFrames();
    assert.notEqual(await page2.locator('#wf-zoom-text').innerText(), whole, 'the drag still zooms on release');
    await page2.click('[data-wf-reset]');
    // Filtering while zoomed keeps the input focused.
    await page2.locator('#wf-overview .ov-h[data-edge="to"]').focus();
    await page2.keyboard.press('Shift+ArrowLeft');
    await page2.locator('#n-q').focus();
    await page2.keyboard.type('img');
    assert.equal(await page2.evaluate(() => document.activeElement?.id), 'n-q', 'filter input keeps focus while zoomed');
    assert.equal(await page2.inputValue('#n-q'), 'img', 'typed text is kept');
    await page2.fill('#n-q', '');
    await page2.click('[data-wf-reset]');
    // The open row's detail tab survives a re-render.
    await page2.locator('#net-table tr[data-entry="0"] button.disclose').click();
    await page2.click('#ed-0-t-timing');
    await page2.click('#net-table button.sort[data-sort="size"]');
    assert.equal(await page2.getAttribute('#ed-0-t-timing', 'aria-selected'), 'true', 'tab survives a sort');
    // Closing and reopening the row starts on Overview again, and a sort keeps it there.
    await page2.locator('#net-table tr[data-entry="0"] button.disclose').click();
    await page2.locator('#net-table tr[data-entry="0"] button.disclose').click();
    assert.equal(await page2.getAttribute('#ed-0-t-overview', 'aria-selected'), 'true', 'reopened row shows Overview');
    await page2.click('#net-table button.sort[data-sort="size"]');
    assert.equal(await page2.getAttribute('#ed-0-t-overview', 'aria-selected'), 'true', 'a sort keeps Overview after reopening');
    await page2.click('#net-table button.sort[data-sort="index"]');
    await page2.locator('#net-table tr[data-entry="0"] button.disclose').focus();
    await page2.keyboard.press('Escape');
    assert.equal(await page2.locator('#ed-0').count(), 0, 'Escape closes the open row');
    await page2.evaluate(() => { document.querySelector('#net-table .table-wrap.net').scrollTop = 0; });
    // Zoom into the early part of the load with the LCP path on: this is the documented state (and the print check below).
    await page2.click('#net-table [data-wf-path]');
    const ov2 = await page2.locator('#wf-overview').boundingBox();
    await page2.mouse.move(ov2.x + 2, ov2.y + ov2.height / 2);
    await page2.mouse.down();
    await page2.mouse.move(ov2.x + ov2.width * 0.03, ov2.y + ov2.height / 2, { steps: 5 });
    await page2.mouse.up();
    assert.ok(await page2.locator('#net-table tr.off-path').count() > 0, 'path on while zoomed');
    assert.equal(await page2.locator('[data-wf-reset]').isDisabled(), false);
    await page2.screenshot({ path: join(OUT, 'reading-network-zoom.png') });
    // Printing shows the whole load: beforeprint drops zoom, path and groups; afterprint brings them back.
    await page2.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    assert.equal(await page2.locator('#net-table .off-path').count(), 0, 'print: no dimmed rows');
    assert.equal(await page2.locator('#net-table tr.grp').count(), 0, 'print: no group rows');
    assert.equal(await page2.locator('#net-table .clip-cue').count(), 0, 'print: no clip cues');
    assert.equal(await page2.locator('#net-table .tl-head .ruler span').first().innerText(), '0 ms');
    assert.equal(await page2.locator('#net-table .lcp-sum').count(), 0, 'print: no path summary');
    await page2.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    assert.ok(await page2.locator('#net-table tr.off-path').count() > 0, 'afterprint restores the path');
    assert.equal(await page2.locator('[data-wf-reset]').isDisabled(), false, 'afterprint restores the zoom');
    await page2.click('[data-wf-reset]');
    await page2.click('#net-table [data-wf-path]');
    // print shows every pane
    await page2.emulateMedia({ media: 'print' });
    const hidden = await page2.evaluate((ids) => ids.filter((p) => getComputedStyle(document.getElementById(p)).display === 'none'), panes);
    assert.deepEqual(hidden, [], 'print hides panes');
    await page2.pdf({ path: join(OUT, 'reading.pdf') }).catch(() => {}); // pdf() needs headless Chromium
    await page2.emulateMedia({ media: 'screen' });
    // standalone export downloads a report
    await page2.evaluate(() => { location.hash = 'overview'; });
    await page2.click('button[popovertarget="export-menu"]');
    const [dl] = await Promise.all([page2.waitForEvent('download'), page2.click('[data-export="report"]')]);
    assert.match(dl.suggestedFilename(), /\.report\.html$/);
    await dl.saveAs(join(OUT, dl.suggestedFilename()));
    // The export's Page map: markers and alt labels, no script, CSS toggles; print shows every marker regardless.
    const exported = readFileSync(join(OUT, dl.suggestedFilename()), 'utf8');
    assert.doesNotMatch(exported, /<script/i, 'export has no script');
    assert.match(exported, /class="pm-mark c-feature pm-img"/);
    // The export makes no requests from its CSS: every url( is a data: URL. Instrument Sans comes inlined.
    const expCss = [...exported.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
    const offFileUrls = [...expCss.matchAll(/url\(\s*(["']?)([^"')]*)/g)].map((m) => m[2]).filter((u) => !u.startsWith('data:'));
    assert.deepEqual(offFileUrls, [], 'every url( in the export CSS is a data: URL');
    assert.match(expCss, /font-family:\s*["']?Instrument Sans/, 'the export carries the Instrument Sans @font-face');
    const exp = await context.newPage();
    await exp.goto(pathToFileURL(join(OUT, dl.suggestedFilename())).href);
    const expFont = await exp.evaluate(async () => {
      const faces = await document.fonts.load('13px "Instrument Sans"');
      await document.fonts.ready;
      return { family: getComputedStyle(document.body).fontFamily, faces: faces.length, check: document.fonts.check('13px "Instrument Sans"') };
    });
    assert.ok(expFont.family.startsWith('"Instrument Sans"') && expFont.faces > 0 && expFont.check, `the export's body is set in Instrument Sans: ${JSON.stringify(expFont)}`);
    log('export font:', JSON.stringify(expFont));
    await exp.goto(pathToFileURL(join(OUT, dl.suggestedFilename())).href + '#area-accessibility');
    const expShown = () => exp.evaluate(() => [...document.querySelectorAll('#p-page-map .pm-mark.c-error')].filter((e) => getComputedStyle(e).display !== 'none').length);
    assert.ok(await expShown() > 0, 'export draws error markers');
    await exp.locator('label[for="pm-t-error"]').click();
    assert.equal(await expShown(), 0, 'export toggles by CSS');
    await exp.emulateMedia({ media: 'print' });
    assert.ok(await expShown() > 0, 'print shows every marker');
    await exp.emulateMedia({ media: 'screen' });
    // The export's Issues pane shows by :target alone, without the live viewer's Copy buttons.
    await exp.goto(pathToFileURL(join(OUT, dl.suggestedFilename())).href + '#issues');
    assert.ok(await exp.evaluate(() => getComputedStyle(document.getElementById('issues')).display !== 'none'), 'the export shows the Issues pane');
    assert.ok(await exp.locator('#issues-list a.issue').count() > 0, 'export lists issues');
    assert.equal(await exp.locator('[data-act="copy-md"], [data-act="copy-urls"]').count(), 0, 'no Copy buttons in the export');
    assert.equal(await exp.locator('script').count(), 0, 'no script in the export');
    await exp.screenshot({ path: join(OUT, 'export-issues.png'), fullPage: true });
    // The export's area sections show their pane by :target alone (the pane :has(:target)).
    await exp.goto(pathToFileURL(join(OUT, dl.suggestedFilename())).href + '#content-data');
    assert.ok(await exp.evaluate(() => getComputedStyle(document.getElementById('area-content')).display !== 'none'), 'export: #content-data shows the Content pane');
    assert.ok(await exp.locator('#content-data').isVisible(), 'export: the Plugin data section is shown');
    assert.equal(await exp.locator('script').count(), 0, 'no script in the export');
    // The export has no script: a Checks Data link targets the plugin body (#pd-<id>) inside the closed details, and
    // Chrome opens the details itself.
    await exp.goto(pathToFileURL(join(OUT, dl.suggestedFilename())).href + '#area-accessibility');
    const expData = await exp.evaluate(() => [...document.querySelectorAll('#accessibility-checks td.data-link a')]
      .map((a) => a.getAttribute('href')).find((h) => { const d = document.getElementById(h.slice(1))?.closest('details.plugin'); return d && !d.open; }));
    assert.ok(expData && expData.startsWith('#pd-'), `export: a Data link to a closed plugin body: ${expData}`);
    await exp.locator(`#accessibility-checks td.data-link a[href="${expData}"]`).click();
    await exp.waitForFunction((h) => document.getElementById(h.slice(1)).closest('details.plugin').open, expData, { timeout: 5000 });
    assert.ok(await exp.evaluate(() => getComputedStyle(document.getElementById('area-accessibility')).display !== 'none'), `export: ${expData} shows the Accessibility pane`);
    await exp.evaluate((h) => { document.getElementById(h.slice(1)).closest('details.plugin').open = false; location.hash = 'area-accessibility'; }, expData);
    await exp.evaluate((h) => { location.hash = h.slice(1); }, expData);
    await exp.waitForFunction((h) => document.getElementById(h.slice(1)).closest('details.plugin').open, expData, { timeout: 5000 });
    assert.equal(await exp.locator('script').count(), 0, 'no script in the export');
    // The export's Help is the same popover, with no script: it opens, centres, scrolls and closes the same way.
    await exp.goto(pathToFileURL(join(OUT, dl.suggestedFilename())).href);
    await checkHelpEverywhere(exp, 'export');
    await exp.setViewportSize({ width: 1280, height: 800 });
    for (const width of [1100, 1180, 1280]) {
      await exp.setViewportSize({ width, height: 800 });
      assert.ok(await fitsPanel(exp) <= 1, `the export's Areas table stays inside its panel at ${width}: ${await fitsPanel(exp)}px over`);
    }
    await exp.setViewportSize({ width: 390, height: 844 });
    assert.ok(await exp.evaluate(() => document.documentElement.scrollWidth) <= 390, 'the export Overview fits 390px');
    await exp.setViewportSize({ width: 1280, height: 800 });
    // The export has no script: the strip's "N views skipped" targets content inside the closed Reading health, and
    // Chrome opens a closed details when a fragment targets something inside it.
    assert.equal(await exp.locator('#reading-health').evaluate((d) => d.open), false, 'export: Reading health starts closed');
    const expSkipped = exp.locator('#overview .status-strip a[href="#reading-health-detail"]');
    if (await expSkipped.count()) await expSkipped.click();
    else {
      assert.equal(await exp.locator('#reading-health #reading-health-detail').count(), 1, 'export: Reading health has a detail body to link to');
      await exp.evaluate(() => { location.hash = 'reading-health-detail'; });
    }
    await exp.waitForFunction(() => document.getElementById('reading-health').open, null, { timeout: 5000 });
    assert.ok(await exp.evaluate(() => getComputedStyle(document.getElementById('overview')).display !== 'none'), 'export: the Overview stays shown on #reading-health-detail');
    await exp.evaluate(() => { document.getElementById('reading-health').open = false; });
    // Print: every detail, the details column unstuck, whole URLs (no ellipsis).
    await exp.setViewportSize({ width: 1280, height: 800 });
    await exp.emulateMedia({ media: 'print' });
    const printed = await exp.evaluate(() => ({
      pos: getComputedStyle(document.querySelector('.issue-details')).position,
      hidden: [...document.querySelectorAll('#issues article.issue-detail')].filter((a) => getComputedStyle(a).display === 'none').length,
      ellipsis: [...document.querySelectorAll('.places .url, .places .url > span')].filter((e) => getComputedStyle(e).textOverflow === 'ellipsis' || getComputedStyle(e).whiteSpace === 'nowrap').length,
    }));
    assert.deepEqual(printed, { pos: 'static', hidden: 0, ellipsis: 0 }, 'print shows every detail, unstuck, URLs whole');
    await exp.emulateMedia({ media: 'screen' });
    await exp.close();
    // If a font cannot be read, the export still downloads, without that @font-face, and a toast says so.
    let dlNoFont;
    try {
      await page2.evaluate(() => {
        const real = window.fetch;
        window.__realFetch = real;
        window.fetch = (u, ...a) => (String(u).includes('fonts/instrument-sans-latin-ext') ? Promise.reject(new TypeError('blocked')) : real(u, ...a));
      });
      await page2.click('button[popovertarget="export-menu"]');
      [dlNoFont] = await Promise.all([page2.waitForEvent('download'), page2.click('[data-export="report"]')]);
      await page2.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent === 'Exported without the custom font'), null, { timeout: 5000 });
    } finally {
      await page2.evaluate(() => { if (window.__realFetch) window.fetch = window.__realFetch; });
    }
    const noFontPath = join(OUT, `nofont-${dlNoFont.suggestedFilename()}`);
    await dlNoFont.saveAs(noFontPath);
    const noFont = readFileSync(noFontPath, 'utf8');
    assert.doesNotMatch(noFont, /<script/i, 'the export without the font has no script');
    assert.doesNotMatch(noFont, /url\(\s*["']?fonts\//, 'the export without the font points at no font file');
    assert.match(noFont, /data:font\/woff2;base64,/, 'the font that did load is still inlined');
    log('export without the custom font passed');
    await page2.setViewportSize({ width: 390, height: 844 });
    await page2.screenshot({ path: join(OUT, 'reading-narrow.png') });
    await page2.setViewportSize({ width: 1280, height: 800 });
    await page2.emulateMedia({ colorScheme: 'dark' });
    await page2.screenshot({ path: join(OUT, 'reading-dark.png'), fullPage: true });
    await page2.evaluate(() => { location.hash = 'area-performance'; for (const d of document.querySelectorAll('details.plugin')) d.open = true; });
    assert.ok(await page2.locator('details.broken-item').count() >= 1, 'the report lists broken items as details.broken-item');
    await page2.screenshot({ path: join(OUT, 'reading-plugins-dark.png'), fullPage: true });
    await page2.emulateMedia({ colorScheme: 'light' });
    await page2.goto(extUrl('ui/library.html'));
    await page2.waitForSelector('.reading-card');
    assert.equal(await page2.locator('.reading-card').count(), 6); // the 3-run reading is one more
    assert.ok(await page2.locator('.reading-card .card-score svg.ring').count() >= 1, 'library cards show a score ring');
    const fonts = await page2.evaluate(async () => { await document.fonts.ready; return { family: getComputedStyle(document.body).fontFamily, size: getComputedStyle(document.body).fontSize, lh: getComputedStyle(document.body).lineHeight, loaded: document.fonts.check('16px "Instrument Sans"') }; });
    assert.ok(fonts.family.startsWith('"Instrument Sans"'), `body uses Instrument Sans, got ${fonts.family}`);
    assert.ok(fonts.loaded, 'Instrument Sans is loaded');
    assert.equal(fonts.size, '13px', 'body uses the 13px redesign base');
    console.log('· fonts', JSON.stringify(fonts));
    await page2.screenshot({ path: join(OUT, 'library.png') });
    await pageContrast(page2, 'library');
    await page2.goto(extUrl('ui/options.html'));
    await page2.waitForSelector('#plugins input');
    const before = await page2.evaluate(async () => (await (await import('/browser/store.js')).listReadings()).map((r) => [r.id, r.score, r.profile]));
    await page2.check('#scoring input[name="profile"][value="public"]');
    await page2.waitForFunction(() => /Re-scored \d+ readings/.test(document.querySelector('#rescore')?.textContent || ''), null, { timeout: 30000 });
    const after = await page2.evaluate(async () => (await (await import('/browser/store.js')).listReadings()).map((r) => [r.id, r.score, r.profile]));
    assert.ok(after.every(([, , p]) => p === 'public'), 'index re-scored with Public sector');
    assert.ok(after.some(([id, s]) => s !== before.find((b) => b[0] === id)?.[1]), 'at least one overall score changed');
    await page2.evaluate(() => { document.querySelector('#rescore').textContent = ''; });
    await page2.check('#scoring input[name="profile"][value="general"]');
    await page2.waitForFunction(() => /Re-scored \d+ readings/.test(document.querySelector('#rescore')?.textContent || ''), null, { timeout: 30000 });
    const back = await page2.evaluate(async () => (await (await import('/browser/store.js')).listReadings()).map((r) => r.profile));
    assert.ok(back.length > 0 && back.every((p) => p === 'general'), `index back on General: ${back.join(',')}`);
    // The translated views have their own toggles (on by default); Long text is labelled as the fallback.
    for (const id of TRANSLATED) assert.equal(await page2.locator(`input[data-path="capture.views.${id}"]`).isChecked(), true, `${id} toggle on`);
    assert.match(await page2.locator('label.chip:has(input[data-path="capture.views.pseudo"])').textContent(), /Long text \(fallback\)/);
    await page2.locator('input[data-path="capture.views.translated-de"]').uncheck();
    const storedDe = (want) => page2.waitForFunction(async (v) => (await chrome.storage.local.get('settings')).settings?.capture?.views?.['translated-de'] === v, want, { timeout: 5000 });
    await storedDe(false); // unchecking German is saved
    await page2.locator('input[data-path="capture.views.translated-de"]').check();
    await storedDe(true);
    await page2.screenshot({ path: join(OUT, 'options.png'), fullPage: true });
    await pageContrast(page2, 'options');
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 640 });
    await popup.goto(extUrl(`ui/popup.html?tab=${tabId}`));
    await popup.waitForSelector('#title:not(:empty)');
    for (const id of TRANSLATED) assert.equal(await popup.locator(`input[name="views.${id}"]`).isChecked(), true, `popup: ${id} toggle on`);
    // The two disclosures open and close from the keyboard (Enter and Space) and the popup never scrolls sideways.
    const isOpenD = (id) => popup.locator(`#${id}`).evaluate((d) => d.open);
    const popupWide = () => popup.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(await popupWide() <= 360, `the popup fits 360px: ${await popupWide()}`);
    for (const id of ['capture-opts', 'plugin-opts']) {
      assert.equal(await isOpenD(id), false, `popup: ${id} starts closed`);
      await popup.locator(`#${id} > summary`).focus();
      await popup.keyboard.press('Enter');
      assert.equal(await isOpenD(id), true, `popup: Enter opens ${id}`);
      assert.ok(await popupWide() <= 360, `the popup fits 360px with ${id} open: ${await popupWide()}`);
      await popup.keyboard.press('Enter');
      assert.equal(await isOpenD(id), false, `popup: Enter closes ${id}`);
      await popup.keyboard.press('Space');
      assert.equal(await isOpenD(id), true, `popup: Space opens ${id}`);
    }
    assert.ok(await popupWide() <= 360, `the popup fits 360px with both open: ${await popupWide()}`);
    await pageContrast(popup, 'popup');
    await popup.locator('#capture-opts').evaluate((d) => { d.open = false; });
    await popup.screenshot({ path: join(OUT, 'popup.png') });

    // 5. import a plain HAR through the library (strip _harplus to simulate DevTools export)
    const plain = structuredClone(r1);
    delete plain.log._harplus;
    plain.log.creator = { name: 'WebInspector', version: '537.36' };
    const importPath = join(OUT, 'plain.har');
    await writeFile(importPath, JSON.stringify(plain));
    await page2.goto(extUrl('ui/library.html'));
    await page2.setInputFiles('#import', importPath);
    await page2.waitForFunction(() => document.querySelectorAll('.reading-card').length === 6, null, { timeout: 15000 });
    log('import passed');

    // 5b. Network pane "Show more": 450 rows page 200 -> 400 -> 450 and focus lands on the first new row.
    {
      const big = structuredClone(r1);
      const bigId = `bigshowmore-${Date.now()}`;
      big.log._harplus.id = bigId;
      const src = r1.log.entries;
      big.log.entries = Array.from({ length: 450 }, (_, k) => {
        const e = structuredClone(src[k % src.length]);
        e.request.url = `${e.request.url}${e.request.url.includes('?') ? '&' : '?'}n=${k}`;
        return e;
      });
      await page2.evaluate(async (b) => (await import('/browser/store.js')).saveReading(b), big);
      await page2.goto(extUrl(`ui/reading.html?id=${bigId}`));
      await page2.evaluate(() => { location.hash = 'network'; });
      const rowsLoc = page2.locator('#net-table tr[data-entry]');
      const moreLoc = page2.locator('#net-table [data-net-more]');
      await rowsLoc.first().waitFor({ timeout: 15000 });
      assert.equal(await rowsLoc.count(), 200, 'first page is 200 rows');
      await moreLoc.waitFor({ state: 'visible' });
      const focusedRowIs = (idx) => page2.evaluate((i) => {
        const row = document.querySelectorAll('#net-table tr[data-entry]')[i];
        return !!row && document.activeElement === row.querySelector('button.disclose');
      }, idx);
      await moreLoc.click();
      await page2.waitForFunction(() => document.querySelectorAll('#net-table tr[data-entry]').length === 400);
      assert.equal(await rowsLoc.count(), 400, 'second page is 400 rows');
      // While more rows remain, the button survives the re-render and keeps focus (so repeated paging works from the keyboard).
      assert.ok(await page2.evaluate(() => document.activeElement?.matches('#net-table [data-net-more]')), 'focus stays on Show more while rows remain');
      await moreLoc.click();
      await page2.waitForFunction(() => document.querySelectorAll('#net-table tr[data-entry]').length === 450);
      assert.equal(await rowsLoc.count(), 450, 'third page is 450 rows');
      assert.equal(await moreLoc.count(), 0, 'no Show more once everything is shown');
      assert.ok(await focusedRowIs(400), 'focus is on the first new row after the second Show more');
      await page2.evaluate(async (x) => (await import('/browser/store.js')).deleteReading(x), bigId);
      log('show more passed');
    }

    // Export the main reading as a fixture for the CLI test (without big screenshots).
    const lite = await page2.evaluate(async (rid) => {
      const { getReading } = await import('/browser/store.js');
      const { stripForSharing } = await import('/core/harplus.js');
      return stripForSharing(await getReading(rid), { screenshots: 'thumbnail', bodies: true });
    }, id1);
    await writeFile(join(OUT, 'local-site.har'), JSON.stringify(lite, null, 1));
    await writeFile(join(OUT, 'local-site.full.har'), JSON.stringify(r1));

    assert.deepEqual(errors, [], `page errors:\n${errors.join('\n')}`);
    log(`all e2e checks passed — artifacts in ${OUT}`);
  } finally {
    await context.close();
    await site.close();
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
