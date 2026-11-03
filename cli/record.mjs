// Headless recording: Playwright Chromium with the unpacked extension takes a reload reading of a URL, as the
// extension's own capture does. Shared by scripts/calibrate.mjs and `hargus recheck`.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../extension');

/** Playwright, from the project or a global install; throws Error('Recording needs Playwright: npm install') without it. */
export async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* fall back to a global install */ }
  try {
    const root = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return await import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
  } catch {
    throw new Error('Recording needs Playwright: npm install');
  }
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
 * Launches Chromium with the extension and writes `settings.capture` (device, throttle, bypassCache, runs, coverage;
 * `views` merged into the stored views) into its settings, with the reading page not opening and history off.
 * `record(url, { timeoutSec })` resolves with the finished reading (analysis done); a timeout rejects with
 * Error('timed out') labelled with the URL. `close()` ends the browser and removes its profile.
 */
export async function openRecorder({ settings = {}, headless = true } = {}) {
  const { chromium } = await loadPlaywright();
  const profile = await mkdtemp(join(tmpdir(), 'hargus-rec-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const close = async () => {
    await context.close().catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const ours = (w) => w.url().endsWith('/background.js');
    let sw = context.serviceWorkers().find(ours);
    sw ||= await context.waitForEvent('serviceworker', { predicate: ours });
    for (let i = 0; i < 50 && !(await sw.evaluate(() => !!(globalThis.harplus && chrome.tabs)).catch(() => false)); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const extId = new URL(sw.url()).host;
    await sw.evaluate(async (want) => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      const old = settings.capture || {};
      const capture = { ...old, ...want, ...(want.views ? { views: { ...(old.views || {}), ...want.views } } : {}) };
      await chrome.storage.local.set({ settings: { ...settings, capture, ui: { openWhenDone: false }, plugins: { ...(settings.plugins || {}), history: { enabled: false } } } });
    }, settings.capture || {});
    const viewer = await context.newPage();
    await viewer.goto(`chrome-extension://${extId}/ui/library.html`);
    const getReading = (id) => viewer.evaluate(async (rid) => (await import('/browser/store.js')).getReading(rid), id);

    const record = async (url, { timeoutSec = 300 } = {}) => {
      const page = await context.newPage();
      try {
        // The reading reloads the page itself; ad-heavy sites may never fire `load` within the timeout.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(2000);
        const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
        if (!tabId) throw new Error(`no tab for ${page.url()}`);
        // One deadline covers the capture call and the wait for analysis; `stopped` ends the poll once it passes.
        let stopped = false;
        return await withDeadline((async () => {
          const id = await sw.evaluate((t) => globalThis.harplus.capture(t, { mode: 'reload' }), tabId);
          for (; !stopped;) {
            const r = await getReading(id);
            if (r?.log._harplus.analysis === 'done') return r;
            await new Promise((res) => setTimeout(res, 1000));
          }
          return null;
        })(), timeoutSec * 1000, url).finally(() => { stopped = true; });
      } finally {
        await page.close().catch(() => {});
      }
    };
    return { record, close };
  } catch (e) {
    await close();
    throw e;
  }
}
