// Calibration run: loads the unpacked extension into Chromium (Playwright), takes a reload
// reading of each URL with default settings, and writes every reading plus a findings digest
// for triaging false positives and noise across real sites.
// Usage: node scripts/calibrate.mjs [url …]   (default: the SITES list below)
// Output: test/e2e/out/calibrate/<slug>.har, digest.md, digest.json

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPlugins } from '../extension/plugins/index.js';
import { detectInterstitial } from '../extension/core/interstitial.js';
import { scoreReading } from '../extension/core/score.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const EXT = resolve(here, '../extension');
const OUT = join(here, '../test/e2e/out/calibrate');

const SITES = [
  'https://www.bbc.com/news',                  // news, heavy ads/scripts
  'https://www.gov.uk/',                       // accessibility-mature public sector
  'https://developer.mozilla.org/en-US/docs/Web/HTML', // docs
  'https://react.dev/',                        // SPA
  'https://www.patagonia.com/home/',           // commerce
  'https://www.lemonde.fr/',                   // French news
  'https://www.aljazeera.net/',                // Arabic, RTL
  'https://www.asahi.com/',                     // Japanese
  'https://en.wikipedia.org/wiki/Web_accessibility', // long-form content
  'https://example.com/',                      // near-empty baseline
];

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* fall back to a global install */ }
  const root = execSync('npm root -g').toString().trim();
  return import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
}

const slug = (u) => new URL(u).host.replace(/^www\d?\./, '').replace(/[^a-z0-9]+/gi, '-');
const log = (...a) => console.log('·', ...a);

async function main() {
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : SITES;
  const { chromium } = await loadPlaywright();
  await mkdir(OUT, { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), 'harplus-cal-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const plugins = getPlugins();
  const digest = [];
  try {
    const ours = (w) => w.url().endsWith('/background.js');
    let sw = context.serviceWorkers().find(ours);
    sw ||= await context.waitForEvent('serviceworker', { predicate: ours });
    for (let i = 0; i < 50 && !(await sw.evaluate(() => !!(globalThis.harplus && chrome.tabs)).catch(() => false)); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const extId = new URL(sw.url()).host;
    await sw.evaluate(async () => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, ui: { openWhenDone: false }, plugins: { ...(settings.plugins || {}), history: { enabled: false } } } });
    });
    const viewer = await context.newPage();
    await viewer.goto(`chrome-extension://${extId}/ui/library.html`);
    const getReading = (id) => viewer.evaluate(async (rid) => (await import('/browser/store.js')).getReading(rid), id);

    for (const url of urls) {
      const t0 = Date.now();
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
        await page.waitForTimeout(2000);
        const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
        if (!tabId) throw new Error(`no tab for ${page.url()}`);
        const id = await sw.evaluate((t) => globalThis.harplus.capture(t, { mode: 'reload' }), tabId);
        let reading;
        for (const start = Date.now(); ;) {
          reading = await getReading(id);
          if (reading?.log._harplus.analysis === 'done') break;
          if (Date.now() - start > 300_000) throw new Error('analysis not done after 300 s');
          await new Promise((r) => setTimeout(r, 1000));
        }
        await writeFile(join(OUT, `${slug(url)}.har`), JSON.stringify(reading));
        const scores = scoreReading(reading, plugins);
        const results = reading.log._harplus.plugins;
        digest.push({
          url, ms: Date.now() - t0,
          overall: scores.overall.score,
          areas: Object.fromEntries(Object.values(scores.areas).map((a) => [a.id, a.score])),
          timing: reading.log._harplus.timing || null,
          interstitial: detectInterstitial(reading),
          failed: Object.values(results).filter((r) => r.status === 'error').map((r) => `${r.id}: ${String(r.error || '').slice(0, 120)}`),
          findings: Object.values(results).flatMap((r) => (r.findings || []).map((f) => ({ plugin: r.id, severity: f.severity, category: f.category, title: f.title, detail: String(f.detail || '').slice(0, 240) }))),
        });
        log(url, `${((Date.now() - t0) / 1000).toFixed(0)} s`, `score ${scores.overall.score}`);
      } catch (e) {
        digest.push({ url, error: e.message });
        log(url, 'FAILED', e.message);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await context.close();
  }
  await writeFile(join(OUT, 'digest.json'), JSON.stringify(digest, null, 2));
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  const md = digest.map((d) => d.error ? `## ${d.url}\n\nFAILED: ${d.error}\n` : [
    `## ${d.url} — overall ${d.overall} (${(d.ms / 1000).toFixed(0)} s)`,
    `Areas: ${Object.entries(d.areas).map(([k, v]) => `${k} ${v ?? '–'}`).join(' · ')}`,
    d.timing ? `Timing: core ${(d.timing.coreMs / 1000).toFixed(1)} s · views ${((d.timing.viewsMs ?? 0) / 1000).toFixed(1)} s · analysis ${((d.timing.analysisMs ?? 0) / 1000).toFixed(1)} s · total ${((d.timing.totalMs ?? 0) / 1000).toFixed(1)} s` : '',
    d.interstitial ? `**Interstitial:** ${d.interstitial.vendor} — ${d.interstitial.reason}` : '',
    d.failed.length ? `Plugin errors: ${d.failed.join('; ')}` : '',
    '',
    ...d.findings.sort((a, b) => order[a.severity] - order[b.severity]).map((f) => `- **${f.severity}** [${f.plugin}/${f.category}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`),
    '',
  ].join('\n')).join('\n');
  await writeFile(join(OUT, 'digest.md'), md);
  log('digest written', join(OUT, 'digest.md'));
}

main().catch((e) => { console.error(e); process.exit(1); });
