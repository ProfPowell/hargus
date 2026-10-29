// Screens for a design review: loads the unpacked extension into Chromium (Playwright), takes a reading of each URL,
// and captures every screen of the tool — popup, progress, each report pane, library, options — and its exports,
// light and dark, wide and narrow. Rerun after a redesign to compare.
// Usage: node scripts/screens.mjs [--out <dir>] [url …]   (default: SITES below; the first site gets the full set)
// Output: screens/*.png (or <dir>/*.png with --out, resolved from the working directory), screens/manifest.json (file → what it shows), export-print.pdf, brief.md.
// screens/OVERVIEW.md is written by hand and kept: the script only replaces what it generates.

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const EXT = resolve(here, '../extension');
const ARGS = process.argv.slice(2);
const outAt = ARGS.indexOf('--out');
if (outAt !== -1 && !ARGS[outAt + 1]) throw new Error('--out needs a folder');
const OUT = outAt === -1 ? resolve(here, '../screens') : resolve(process.cwd(), ARGS[outAt + 1]);

const SITES = [
  'https://en.wikipedia.org/wiki/Web_accessibility', // long-form content, many findings, broken links in every group
  'https://www.gov.uk/',                              // a mature site that scores well
];
const PANES = ['overview', 'area-performance', 'area-accessibility', 'area-security', 'area-content', 'area-build',
  'area-infrastructure', 'area-international', 'area-sustainability', 'findings', 'network', 'screens', 'notes'];
const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 844 };
const TALLEST = 12_000;

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* fall back to a global install */ }
  const root = execSync('npm root -g').toString().trim();
  return import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
}

const log = (...a) => console.log('·', ...a);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const manifest = [];
let seq = 0;

/**
 * One screenshot, numbered in capture order. full: the whole page, taken by growing the viewport to the page's height
 * (Playwright's fullPage repeats the report, whose sidebar is sticky at 100vh). Restores the viewport afterwards.
 */
async function shot(page, name, about, { full = false, theme = 'light', locator } = {}) {
  const file = `${String(++seq).padStart(2, '0')}-${name}.png`;
  const vp = page.viewportSize();
  if (locator) {
    // A close-up scrolls its element into view, where the sticky app bar would cover its top.
    const style = await page.addStyleTag({ content: '.appbar { position: static !important; }' });
    await locator.screenshot({ path: join(OUT, file) });
    await style.evaluate((s) => s.remove());
  }
  else if (full) {
    const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
    await page.setViewportSize({ width: vp.width, height: Math.min(Math.max(h, vp.height), TALLEST) });
    await pause(300);
    await page.screenshot({ path: join(OUT, file) });
    await page.setViewportSize(vp);
  } else await page.screenshot({ path: join(OUT, file) });
  manifest.push({ file, about, width: vp.width, ...(full ? { full: true } : {}), theme });
  log(file);
}

async function showPane(page, pane) {
  await page.evaluate((p) => { location.hash = p; window.scrollTo(0, 0); }, pane);
  await page.waitForFunction((p) => getComputedStyle(document.getElementById(p)).display !== 'none', pane);
  await pause(400);
}

async function main() {
  const urls = ARGS.filter((a, i) => !a.startsWith('--') && !(outAt !== -1 && i === outAt + 1));
  const sites = urls.length ? urls : SITES;
  const { chromium } = await loadPlaywright();
  await mkdir(OUT, { recursive: true });
  for (const f of await readdir(OUT)) if (f !== 'OVERVIEW.md') await rm(join(OUT, f), { recursive: true, force: true });
  const profile = await mkdtemp(join(tmpdir(), 'harplus-screens-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: WIDE, acceptDownloads: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  try {
    const ours = (w) => w.url().endsWith('/background.js');
    let sw = context.serviceWorkers().find(ours);
    sw ||= await context.waitForEvent('serviceworker', { predicate: ours });
    for (let i = 0; i < 50 && !(await sw.evaluate(() => !!(globalThis.harplus && chrome.tabs)).catch(() => false)); i++) await pause(100);
    const extId = new URL(sw.url()).host;
    const ext = (p) => `chrome-extension://${extId}/${p}`;
    await sw.evaluate(async () => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, ui: { openWhenDone: false }, plugins: { ...(settings.plugins || {}), history: { enabled: false } } } });
    });
    const viewer = await context.newPage();
    await viewer.goto(ext('ui/library.html'));
    const getReading = (id) => viewer.evaluate(async (rid) => (await import('/browser/store.js')).getReading(rid), id);

    const ids = [];
    for (const [i, url] of sites.entries()) {
      const first = i === 0;
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await pause(2000);
      const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
      if (!tabId) throw new Error(`no tab for ${page.url()}`);

      if (first) {
        const popup = await context.newPage();
        await popup.setViewportSize({ width: 360, height: 640 });
        await popup.goto(ext(`ui/popup.html?tab=${tabId}`));
        await pause(600);
        await shot(popup, 'popup', 'Toolbar popup: the page to read, Take reading / Record / Snapshot, Capture options and Plugins (collapsed)');
        const sum = (text) => popup.locator('summary', { hasText: text }).first();
        await sum('Capture options').click().catch(() => {});
        await pause(300);
        await shot(popup, 'popup-capture-options', 'Toolbar popup with Capture options open: device, network, bodies, and the views to capture', { full: true });
        await sum('Capture options').click().catch(() => {});
        await sum('Plugins').click().catch(() => {});
        await pause(300);
        await shot(popup, 'popup-plugins', 'Toolbar popup with Plugins open: every plugin by phase, each with a checkbox', { full: true });
        await sum('Plugins').click().catch(() => {});
        await popup.emulateMedia({ colorScheme: 'dark' });
        await shot(popup, 'popup-dark', 'Toolbar popup, dark theme', { theme: 'dark' });
        await popup.close();
      }

      // The reading tab opens beside the page and shows progress while the capture runs, then becomes the report.
      let captured = false;
      const capture = sw.evaluate((t) => globalThis.harplus.capture(t, { mode: 'reload' }), tabId).finally(() => { captured = true; });
      let progress = null;
      if (first) {
        const texts = new Set();
        for (let last = 0; !captured && texts.size < 4;) {
          progress ||= context.pages().find((p) => p.url().includes('/ui/reading.html'));
          const text = progress && await progress.evaluate(() => [...document.querySelectorAll('.prog-text')].map((x) => x.textContent).join(' | ')).catch(() => '');
          if (text && !texts.has(text) && Date.now() - last > 2500) {
            texts.add(text);
            last = Date.now();
            await progress.setViewportSize(WIDE).catch(() => {});
            await shot(progress, `progress-${texts.size}`, `Reading tab while the capture runs: “${text.slice(0, 80)}”`).catch(() => {});
          }
          await pause(300);
        }
      }
      const id = await capture;
      ids.push(id);
      for (const start = Date.now(); ;) {
        const reading = await getReading(id);
        if (reading?.log._harplus.analysis === 'done') break;
        if (Date.now() - start > 300_000) throw new Error(`${url}: analysis not done after 300 s`);
        progress ||= context.pages().find((p) => p.url().includes('/ui/reading.html'));
        if (first && progress && reading?.log._harplus.analysis === 'pending' && !manifest.some((m) => m.file.includes('progress-analysing'))) {
          await progress.setViewportSize(WIDE).catch(() => {});
          await shot(progress, 'progress-analysing', 'Reading tab after capture, while lookups and analysis finish').catch(() => {});
        }
        await pause(1000);
      }
      log(url, 'read');
      if (progress) await progress.close().catch(() => {});
      await page.close().catch(() => {});

      const r = await context.newPage();
      await r.setViewportSize(WIDE);
      await r.goto(ext(`ui/reading.html?id=${id}`));
      await r.waitForSelector('#overview .area-card');
      await pause(800);
      const host = new URL(url).host.replace(/^www\./, '');
      if (!first) {
        await shot(r, `${host}-overview`, `Report overview for ${host}, a site that scores well`, { full: true });
        await r.setViewportSize(NARROW);
        await shot(r, `${host}-overview-narrow`, `Report overview for ${host} at phone width`);
        await r.close();
        continue;
      }

      await shot(r, 'report-overview-fold', 'Report overview, first screen: app bar, sidebar of areas with scores, summary card, area cards');
      for (const pane of PANES) {
        await showPane(r, pane);
        await shot(r, `report-${pane}`, `Report pane “${pane}”, whole length, plugin panels as they open by default`, { full: true });
      }
      // Area panes with every plugin panel open: what the detail looks like.
      for (const pane of ['area-content', 'area-accessibility', 'area-performance']) {
        await showPane(r, pane);
        await r.evaluate((p) => { for (const d of document.querySelectorAll(`#${p} details.plugin`)) d.open = true; }, pane);
        await pause(500);
        await shot(r, `report-${pane}-expanded`, `Report pane “${pane}” with every plugin panel open`, { full: true });
      }
      await showPane(r, 'area-content');
      const linkCheck = r.locator('#area-content details.plugin', { has: r.locator('details.broken-item') }).first();
      if (await linkCheck.count()) {
        await linkCheck.evaluate((d) => { d.open = true; d.querySelector('details.broken-item').open = true; });
        const broken = linkCheck.locator('section.sub', { has: r.locator('h4', { hasText: 'Broken' }) }).first();
        await shot(r, 'report-link-check-broken', 'Link check panel, Broken section: links grouped on this page / internal / external, the first opened to show where it is used', { locator: broken });
      }
      // A finding with its fix open.
      await showPane(r, 'findings');
      const fix = r.locator('#findings tbody tr', { has: r.locator('details.fix') }).first();
      if (await fix.count()) {
        await fix.locator('details.fix > summary').click();
        await pause(300);
        await shot(r, 'report-finding-fix', 'All findings: one row with its What / Why / How to fix open', { locator: fix });
      }
      // A request opened in the network table.
      await showPane(r, 'network');
      const disc = r.locator('#net-table tr[data-entry="0"] button.disclose');
      if (await disc.count()) {
        await disc.click();
        await r.waitForSelector('#ed-0 .req-detail');
        await shot(r, 'report-network-request', 'Network: the first request opened in place, with its tabs');
      }
      // Export menu, then the exports themselves.
      await showPane(r, 'overview');
      await r.click('button[popovertarget="export-menu"]');
      await pause(300);
      await shot(r, 'report-export-menu', 'Export menu open');
      // The standalone report embeds every screenshot (tens of MB), so it is opened from the profile, not kept.
      const [report] = await Promise.all([r.waitForEvent('download'), r.click('[data-export="report"]')]);
      const reportFile = join(profile, 'report.html');
      await report.saveAs(reportFile);
      await r.click('button[popovertarget="export-menu"]');
      const [md] = await Promise.all([r.waitForEvent('download'), r.click('[data-export="markdown"]')]).catch(() => [null]);
      if (md) {
        await md.saveAs(join(OUT, 'brief.md'));
        manifest.push({ file: 'brief.md', about: 'The Markdown brief export, as downloaded' });
      }
      await r.keyboard.press('Escape');
      const exp = await context.newPage();
      await exp.setViewportSize(WIDE);
      await exp.goto(pathToFileURL(reportFile).href);
      await pause(800);
      await shot(exp, 'export-report-overview', 'Exported standalone HTML report (no script), overview', { full: true });
      await exp.goto(`${pathToFileURL(reportFile).href}#area-content`);
      await pause(600);
      await shot(exp, 'export-report-content', 'Exported standalone HTML report, Content pane', { full: true });
      await exp.emulateMedia({ media: 'print' });
      await exp.pdf({ path: join(OUT, 'export-print.pdf'), format: 'A4', printBackground: true, pageRanges: '1-8' });
      manifest.push({ file: 'export-print.pdf', about: 'The standalone report as printed (Print or save as PDF), A4, first 8 pages' });
      await exp.close();

      // Dark theme and phone width.
      await r.emulateMedia({ colorScheme: 'dark' });
      for (const pane of ['overview', 'area-content', 'findings', 'network']) {
        await showPane(r, pane);
        await shot(r, `report-${pane}-dark`, `Report pane “${pane}”, dark theme`, { full: pane === 'overview', theme: 'dark' });
      }
      await r.emulateMedia({ colorScheme: 'light' });
      await r.setViewportSize(NARROW);
      for (const pane of ['overview', 'area-accessibility', 'findings']) {
        await showPane(r, pane);
        await shot(r, `report-${pane}-narrow`, `Report pane “${pane}” at phone width, first screen`);
      }
      await showPane(r, 'overview');
      await shot(r, 'report-overview-narrow-full', 'Report overview at phone width, whole length', { full: true });
      await r.close();
    }

    const lib = await context.newPage();
    await lib.setViewportSize(WIDE);
    await lib.goto(ext('ui/library.html'));
    await lib.waitForSelector('.reading-card');
    await pause(500);
    await shot(lib, 'library', 'Readings library: one card per saved reading');
    await lib.emulateMedia({ colorScheme: 'dark' });
    await shot(lib, 'library-dark', 'Readings library, dark theme', { theme: 'dark' });
    await lib.emulateMedia({ colorScheme: 'light' });
    await lib.goto(ext('ui/options.html'));
    await lib.waitForSelector('#plugins input');
    await pause(500);
    await shot(lib, 'options', 'Options page, first screen');
    await shot(lib, 'options-full', 'Options page, whole length: capture settings and every plugin’s options', { full: true });
    await lib.close();
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`${manifest.length} files in ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
