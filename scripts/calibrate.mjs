// Calibration run: loads the unpacked extension into Chromium (Playwright), takes a reload
// reading of each URL with default settings, and writes every reading plus a findings digest
// for triaging false positives and noise across real sites.
// Usage: node scripts/calibrate.mjs [--round 1|2 | --all | --a11y] [--out dir] [--coverage on|off] [--runs 1|3|5] [--timeout S] [url …]   (default: the SITES list below)
// Output: <out>/<slug>.har (out defaults to test/e2e/out/calibrate), digest.md, digest.json

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPlugins } from '../extension/plugins/index.js';
import { detectInterstitial } from '../extension/core/interstitial.js';
import { scoreReading } from '../extension/core/score.js';
import { activeFindings } from '../extension/core/supersede.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const EXT = resolve(here, '../extension');
const DEFAULT_OUT = join(here, '../test/e2e/out/calibrate');

export const SITES = [
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

export const SITES_2 = [
  'https://www.usa.gov/',                       // US government
  'https://www.ikea.com/us/en/',                // commerce
  'https://stripe.com/',                        // SaaS marketing
  'https://github.com/microsoft/vscode',        // app-like
  'https://www.ynet.co.il/',                    // Hebrew, RTL
  'https://habr.com/ru/articles/',              // Russian
  'https://www.naver.com/',                     // Korean
  'https://www.smashingmagazine.com/2024/05/modern-guide-making-css-shapes/', // blog article
  'https://docs.python.org/3/library/asyncio.html', // docs
  'https://www.spiegel.de/',                    // German news
];

// The accessibility calibration: the GDS accessibility-tool-audit test cases, and a real small-business site.
export const SITES_A11Y = [
  'https://alphagov.github.io/accessibility-tool-audit/test-cases.html',
  'https://www.thymecare.com/',
];

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* fall back to a global install */ }
  const root = execSync('npm root -g').toString().trim();
  return import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
}

const slug = (u) => new URL(u).host.replace(/^www\d?\./, '').replace(/[^a-z0-9]+/gi, '-');
const log = (...a) => console.log('·', ...a);

const USAGE = 'Usage: node scripts/calibrate.mjs [--round 1|2 | --all | --a11y] [--out dir] [--coverage on|off] [--runs 1|3|5] [--timeout S] [url …]';

/** The URLs to read: the given URLs, else --all, else the round's list (SITES by default). null when --round is not 1 or 2. */
export function pickUrls(args) {
  let round = SITES;
  if (args.includes('--round')) {
    const value = args[args.indexOf('--round') + 1];
    if (value !== '1' && value !== '2') return null;
    round = value === '2' ? SITES_2 : SITES;
  }
  if (args.includes('--a11y')) round = SITES_A11Y;
  if (args.includes('--all')) round = [...SITES, ...SITES_2];
  const given = args.filter((a, i) => !a.startsWith('--') && !['--round', '--out', '--coverage', '--runs', '--timeout'].includes(args[i - 1]));
  return given.length ? given : round;
}

/** Rejects with Error('timed out') (and .label) if the promise has not settled within ms. */
export function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { label })), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The command line as { urls, out, coverage, runs, timeoutSec }: urls null when --round is invalid,
 * coverage undefined unless --coverage on|off. Throws an Error on a bad --runs, --coverage, --out or --timeout.
 */
export function parseArgs(argv) {
  const has = (flag) => argv.includes(flag);
  const value = (flag) => (has(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const cov = value('--coverage');
  if (has('--coverage') && cov !== 'on' && cov !== 'off') throw new Error('--coverage must be on or off');
  const out = value('--out');
  if (has('--out') && (out === undefined || out.startsWith('--'))) throw new Error('--out needs a directory');
  const runs = has('--runs') ? Number(value('--runs')) : 1;
  if (![1, 3, 5].includes(runs)) throw new Error('--runs must be 1, 3 or 5');
  let timeoutSec = 300 * (has('--runs') ? runs : 1);
  if (has('--timeout')) {
    timeoutSec = Number(value('--timeout'));
    if (!(timeoutSec > 0)) throw new Error('--timeout must be a positive number of seconds');
  }
  return { urls: pickUrls(argv), out: out ?? DEFAULT_OUT, coverage: cov === 'on' ? true : cov === 'off' ? false : undefined, runs, timeoutSec };
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const { urls, out: OUT, coverage, runs, timeoutSec } = args;
  if (!urls) {
    console.error(USAGE);
    process.exit(2);
  }
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
    await sw.evaluate(async ({ cov, runs }) => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      const capture = { ...(settings.capture || {}), runs, ...(cov === undefined ? {} : { coverage: cov }) };
      await chrome.storage.local.set({ settings: { ...settings, capture, ui: { openWhenDone: false }, plugins: { ...(settings.plugins || {}), history: { enabled: false } } } });
    }, { cov: coverage, runs });
    const viewer = await context.newPage();
    await viewer.goto(`chrome-extension://${extId}/ui/library.html`);
    const getReading = (id) => viewer.evaluate(async (rid) => (await import('/browser/store.js')).getReading(rid), id);

    for (const url of urls) {
      const t0 = Date.now();
      const page = await context.newPage();
      try {
        // The reading reloads the page itself; ad-heavy sites may never fire `load` within the timeout.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(2000);
        const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
        if (!tabId) throw new Error(`no tab for ${page.url()}`);
        // One deadline covers the capture call and the wait for analysis; `stopped` ends the poll once it passes.
        let stopped = false;
        const reading = await withDeadline((async () => {
          const id = await sw.evaluate((t) => globalThis.harplus.capture(t, { mode: 'reload' }), tabId);
          for (; !stopped;) {
            const r = await getReading(id);
            if (r?.log._harplus.analysis === 'done') return r;
            await new Promise((res) => setTimeout(res, 1000));
          }
          return null;
        })(), timeoutSec * 1000, url).finally(() => { stopped = true; });
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
          findings: Object.values(results).flatMap((r) => activeFindings(r, results).map((f) => ({ plugin: r.id, severity: f.severity, category: f.category, title: f.title, detail: String(f.detail || '').slice(0, 240) }))),
        });
        log(url, `${((Date.now() - t0) / 1000).toFixed(0)} s`, `score ${scores.overall.score}`);
      } catch (e) {
        if (e.label === url && e.message === 'timed out') {
          digest.push({ url, error: 'timed out' });
          log(`TIMEOUT ${url} after ${timeoutSec} s`);
        } else {
          digest.push({ url, error: e.message });
          log(url, 'FAILED', e.message);
        }
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

// Run only as a script, so tests can import pickUrls.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch((e) => { console.error(e); process.exit(1); });
