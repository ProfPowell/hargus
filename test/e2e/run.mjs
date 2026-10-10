// End-to-end test: loads the unpacked extension into Chromium (Playwright), serves a local
// test site, takes readings in reload / mobile / snapshot / record modes and renders the viewer.
// Needs Playwright with Chromium: `npm i -g playwright && npx playwright install chromium`.
// Output (screenshots + exported readings) goes to test/e2e/out/.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from './server.mjs';

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
    page.on('pageerror', (e) => errors.push(`site: ${e.message}`));
    await page.goto(`${base}/old`);
    await page.waitForLoadState('load');
    const tabId = await sw.evaluate(async (pattern) => (await chrome.tabs.query({ url: pattern }))[0]?.id, `${base}/*`);
    assert.ok(tabId, 'found the test tab');

    // Settings for the run: keep lookups on (they hit the local site / skip private IPs).
    await sw.evaluate(async ({ base, full }) => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, ui: { openWhenDone: false }, plugins: {
        axe: { enabled: true },
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
    const id1 = await sw.evaluate((t) => globalThis.harplus.capture(t, { mode: 'reload' }), tabId);
    log('reload reading', id1, `${Date.now() - t0} ms`);
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
      const pending1 = await getReading(id1);
      assert.equal(pending1.log._harplus.analysis, 'pending', 'saved before analysis');
      const tabUrls = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url));
      assert.ok(tabUrls.some((u) => {
        try {
          const q = new URL(u).searchParams;
          return u.includes('/ui/reading.html') && (q.get('capture') === String(tabId) || q.get('id') === id1);
        } catch { return false; }
      }), `progress tab open: ${tabUrls.join(', ')}`);
      r1 = await waitDone(id1);
    } finally {
      polling = false;
      await poller;
    }
    assert.ok(progressTexts.some((t) => /Checking links \d+\/\d+/.test(t)), `link check progress shown: ${progressTexts.filter(Boolean).slice(-5).join(' || ')}`);
    const pc = r1.log._harplus.plugins;
    assert.equal(pc.content?.status, 'ok', `content: ${pc.content?.error}`);
    assert.ok(pc.content.findings.some((f) => f.title === '1 links with vague text'), 'vague link found');
    assert.ok(pc.content.findings.some((f) => f.title === '1 links to missing in-page anchors'), 'missing anchor found');
    assert.equal(pc.links?.status, 'ok', `links: ${pc.links?.error}`);
    assert.ok(pc.links.findings.some((f) => f.title === 'Broken link: 404 /missing-page'), 'broken link found');
    assert.ok(pc.links.findings.some((f) => /links redirect/.test(f.title)), 'redirect found');
    assert.equal(pc.links.data.ogImage?.width, 1600);
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
    const faint = pcx.findings.find((f) => /^Text contrast 2\.\d:1 \(#999999 on #ffffff\)/.test(f.title));
    assert.ok(faint, pcx.findings.map((f) => f.title).join(' | '));
    assert.equal(faint.severity, 'low', 'a pair on one element is low');
    const pst = r1.log._harplus.plugins['a11y-structure'];
    assert.equal(pst?.status, 'ok', `a11y-structure: ${pst?.error}`);
    const st = pst.findings.map((f) => f.title);
    for (const re of [/targets smaller than 24×24 px \(WCAG 2\.5\.8\)$/, /label or description references point to missing ids$/,
      /images with unhelpful alt text$/, /invalid autocomplete values \(WCAG 1\.3\.5\)$/]) assert.ok(st.some((x) => re.test(x)), `${re} in ${st.join(' | ')}`);
    assert.equal(pst.data.labelRefs.count, 1, `only the button's broken describedby; the input is a11y-basics': ${JSON.stringify(pst.data.labelRefs)}`);
    assert.ok((r1.log._harplus.plugins['a11y-basics']?.findings || []).some((f) => /^Form fields without a label/.test(f.title)), 'a11y-basics reports the input');
    assert.ok(st.includes('Inline links show no visible focus indicator'), st.join(' | '));
    assert.ok(!st.includes('Buttons show no visible focus indicator'), 'buttons keep the default focus ring');
    assert.ok(pst.data.headings.some((x) => x.text === 'Field notes' && x.level === 2), 'role=heading counted');
    const fs = r1.log._harplus.capture.focus;
    assert.ok(fs?.samples?.find((s) => s.kind === 'button')?.changed.length > 0, `button focus changes: ${JSON.stringify(fs)}`);
    assert.ok(fs.outlineNone >= 1, 'a:focus outline:none rule counted');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-harplus-focus], [data-harplus-focus-style]').length), 0, 'no probe attributes left');
    for (const id of ['a11y-basics', 'html', 'content']) {
      const titles = (r1.log._harplus.plugins[id]?.findings || []).map((f) => f.title);
      assert.ok(!titles.some((x) => /skipped heading levels|Heading levels skip|No <main>|empty headings|Empty headings/.test(x)), `${id} has no duplicated heading/main findings`);
    }
    log('contrast + structure passed');
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
    assert.deepEqual(shotViews(r1), ['achromatopsia', 'blurred', 'dark', 'desktop', 'deuteranopia', 'forced', 'lowcontrast', 'mobile', 'morecontrast',
      'nocss', 'noimages', 'nojs', 'print', 'protanopia', 'pseudo', 'reflow', 'rtl', 'spacing', 'tablet', 'text200', 'tritanopia']);
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
    assert.equal(hp.capture.viewsSkipped, undefined, `nothing skipped: ${JSON.stringify(hp.capture.viewsSkipped)}`);
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
      assert.equal(s.scale, Math.round((1 / s.dpr) * 1000) / 1000, `${id}: CSS-pixel scale recorded`);
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
    assert.equal(await page.evaluate(() => !!document.getElementById('harplus-spacing')), false);
    assert.equal(await page.evaluate(() => matchMedia('print').matches || matchMedia('(prefers-color-scheme: dark)').matches), false);
    assert.equal(await page.evaluate(() => innerWidth), widthBefore);
    assert.equal(r1.log.entries.filter((e) => e.request.url === `${base}/`).length, 1, 'one document entry');
    assert.equal(r1.log.entries.filter((e) => e.request.url.endsWith('/main.js')).length, 1, 'main.js recorded once');
    assert.equal(hp.target.title, 'Terra Test Outfitters — gear for the field');
    for (const id of ['meta', 'vitals', 'a11y-basics', 'tech', 'network', 'security', 'well-known', 'ip-intel']) {
      assert.equal(p[id]?.status, 'ok', `${id}: ${p[id]?.status} ${p[id]?.error || ''}`);
    }
    assert.equal(p.dns.status, 'skipped');
    if (existsSync(join(EXT, 'plugins/vendor/axe.min.js'))) {
      assert.equal(p.axe.status, 'ok', `axe: ${p.axe.error}`);
      assert.ok(p.axe.data.violations.some((v) => v.id === 'image-alt'), 'axe found image-alt');
      log('axe-core', p.axe.data.engine, '—', p.axe.data.violations.length, 'violations');
    } else {
      assert.equal(p.axe.status, 'error');
      assert.match(p.axe.error, /vendor-axe/);
      log('axe-core not vendored — plugin reports setup hint');
    }
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
    assert.ok(intl.includes('Text gets cut off when translated'), JSON.stringify({ intl, base: iv.desktop, pseudo: iv.pseudo }));
    assert.ok(intl.includes('Right-to-left text without dir="rtl"'), JSON.stringify({ intl, base: iv.desktop }));
    // The tab is restored after the international views.
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('dir')), null, 'dir restored');
    assert.equal(await page.evaluate(() => document.querySelector('.tags li').textContent), 'Free shipping', 'text restored');
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
    // The no-images view breaks every src; the page's own onerror handlers must not run (snapshot mode does not reload).
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById('onerror-img')).display), 'none', 'onerror handler did not fire during the no-images view');
    log('mobile + snapshot readings passed');

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
    await page2.waitForSelector('#overview .area-card');
    // every pane renders and every ring/donut label fits inside its hole
    const panes = ['overview', 'area-performance', 'area-accessibility', 'area-security', 'area-content', 'area-build', 'area-infrastructure', 'area-international', 'area-sustainability', 'findings', 'network', 'screens', 'notes'];
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
    // a deep link survives a fresh load (script-inserted panes do not get :target by themselves)
    await page2.goto(extUrl(`ui/reading.html?id=${id1}#area-security`));
    await page2.waitForSelector('#overview .area-card', { state: 'attached' });
    assert.ok(await page2.evaluate(() => getComputedStyle(document.getElementById('area-security')).display !== 'none'), 'deep link shows its pane');
    await page2.evaluate(() => { location.hash = 'screens'; });
    assert.ok(await page2.locator('#screens h2', { hasText: 'Accessibility views' }).count() === 1, 'accessibility views section');
    assert.ok(await page2.locator('#screens .vision-grid figure').count() === 7, '6 vision views + as designed');
    await page2.evaluate(() => { location.hash = 'network'; });
    await page2.click('#network tbody tr');
    await page2.waitForSelector('#dlg[open]');
    await page2.screenshot({ path: join(OUT, 'reading-request-dialog.png') });
    await page2.click('#dlg-close');
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
    await page2.setViewportSize({ width: 390, height: 844 });
    await page2.screenshot({ path: join(OUT, 'reading-narrow.png') });
    await page2.setViewportSize({ width: 1280, height: 800 });
    await page2.emulateMedia({ colorScheme: 'dark' });
    await page2.screenshot({ path: join(OUT, 'reading-dark.png'), fullPage: true });
    await page2.evaluate(() => { location.hash = 'area-performance'; for (const d of document.querySelectorAll('details.plugin')) d.open = true; });
    await page2.screenshot({ path: join(OUT, 'reading-plugins-dark.png'), fullPage: true });
    await page2.emulateMedia({ colorScheme: 'light' });
    await page2.goto(extUrl('ui/library.html'));
    await page2.waitForSelector('.reading-card');
    assert.equal(await page2.locator('.reading-card').count(), 4);
    assert.ok(await page2.locator('.reading-card .card-score svg.ring').count() >= 1, 'library cards show a score ring');
    await page2.screenshot({ path: join(OUT, 'library.png') });
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
    await page2.screenshot({ path: join(OUT, 'options.png'), fullPage: true });
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 640 });
    await popup.goto(extUrl(`ui/popup.html?tab=${tabId}`));
    await popup.waitForSelector('#title:not(:empty)');
    await popup.click('#plugin-opts summary');
    await popup.screenshot({ path: join(OUT, 'popup.png') });

    // 5. import a plain HAR through the library (strip _harplus to simulate DevTools export)
    const plain = structuredClone(r1);
    delete plain.log._harplus;
    plain.log.creator = { name: 'WebInspector', version: '537.36' };
    const importPath = join(OUT, 'plain.har');
    await writeFile(importPath, JSON.stringify(plain));
    await page2.goto(extUrl('ui/library.html'));
    await page2.setInputFiles('#import', importPath);
    await page2.waitForFunction(() => document.querySelectorAll('.reading-card').length === 5, null, { timeout: 15000 });
    log('import passed');

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
