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
        baseline: { options: { dataUrl: `${base}/__data/web-features.json` } },
        tech: { options: { fingerprintDb: full, fingerprintSource: `${base}/__data/wa` } },
      } } });
    }, { base, full: FULL_FINGERPRINTS });

    // 1. reload reading (desktop)
    const t0 = Date.now();
    const id1 = await sw.evaluate((t) => globalThis.harplus.capture(t, { mode: 'reload' }), tabId);
    log('reload reading', id1, `${Date.now() - t0} ms`);
    const getReading = (id) => page2.evaluate(async (rid) => (await import('/browser/store.js')).getReading(rid), id);
    const page2 = await context.newPage();
    page2.on('pageerror', (e) => errors.push(`viewer: ${e.message}`));
    page2.on('console', (m) => { if (m.type() === 'error') errors.push(`viewer console: ${m.text()}`); });
    await page2.goto(extUrl('ui/library.html'));
    const r1 = await getReading(id1);
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
    assert.deepEqual(hp.screenshots.map((s) => s.kind).sort(), ['fullpage', 'thumbnail', 'viewport']);
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
    const r2 = await getReading(id2);
    assert.equal(r2.log._harplus.capture.device, 'mobile');
    assert.ok(r2.log._harplus.capture.viewport.width < 700, 'mobile layout viewport');
    assert.match(r2.log._harplus.capture.userAgent, /iPhone/);
    const frameJs = r2.log.entries.find((e) => e.request.url.endsWith('/frame.js'));
    const ua = frameJs.request.headers.find((x) => x.name.toLowerCase() === 'user-agent')?.value || '';
    assert.match(ua, /iPhone/, 'cross-site iframe requests use the emulated user agent');
    const frameDoc = r1.log.entries.find((e) => e.request.url.endsWith('/frame.html'));
    assert.ok(frameDoc.response.content.text?.includes('Cross-site frame'), 'cross-site iframe document body captured');
    const id3 = await sw.evaluate((t) => globalThis.harplus.capture(t, { mode: 'snapshot' }), tabId);
    const r3 = await getReading(id3);
    assert.ok(r3.log.entries.length >= 3 && r3.log.entries.every((e) => e._synthetic));
    log('mobile + snapshot readings passed');

    // 3. record a two-page flow
    await sw.evaluate((t) => globalThis.harplus.record(t), tabId);
    await page.goto(`${base}/`);
    await page.waitForLoadState('load');
    await page.goto(`${base}/page2.html`);
    await page.waitForLoadState('load');
    await page.waitForTimeout(500);
    const id4 = await sw.evaluate((t) => globalThis.harplus.stop(t), tabId);
    const r4 = await getReading(id4);
    assert.ok(r4.log.pages.length >= 2, `record mode pages: ${r4.log.pages.length}`);
    assert.equal(r4.log._harplus.target.title, 'Page two');
    log('record reading passed:', r4.log.pages.map((x) => x.title).join(' → '));

    // 4. viewer pages render
    await page2.goto(extUrl(`ui/reading.html?id=${id1}`));
    await page2.waitForSelector('#overview .area-card');
    // every pane renders and every ring/donut label fits inside its hole
    const panes = ['overview', 'area-performance', 'area-accessibility', 'area-security', 'area-build', 'area-infrastructure', 'findings', 'network', 'screens', 'notes'];
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
