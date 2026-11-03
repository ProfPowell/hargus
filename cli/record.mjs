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

/** The run counts the extension takes. */
export const RUNS = [1, 3, 5];

/** The allowed run count nearest `n` (ties go up: 2 → 3, 4 → 5; above 5 → 5, below 1 → 1). */
export const nearestRuns = (n) => RUNS.reduce((best, r) => (Math.abs(r - n) <= Math.abs(best - n) ? r : best), RUNS[0]);

/** Rejects with Error('timed out') (and .label) if the promise has not settled within ms. */
export function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { label })), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * The extension settings a headless recording uses: `stored` with `want` written over it. `want.capture` is merged
 * into the stored capture (its `views` into the stored views); `want.plugins` per plugin (its `options` merged too);
 * `want.keys` and `want.lookups` key by key; `want.remotes` replaces the list. The reading page never opens and
 * history is always off. Pure.
 */
export function recorderSettings(stored = {}, want = {}) {
  const s = isObj(stored) ? stored : {};
  const w = isObj(want) ? want : {};
  const wc = isObj(w.capture) ? w.capture : {};
  const old = isObj(s.capture) ? s.capture : {};
  const capture = { ...old, ...wc, ...(isObj(wc.views) ? { views: { ...(isObj(old.views) ? old.views : {}), ...wc.views } } : {}) };
  const plugins = { ...(isObj(s.plugins) ? s.plugins : {}) };
  for (const [id, p] of Object.entries(isObj(w.plugins) ? w.plugins : {})) {
    if (!isObj(p)) continue;
    const prev = isObj(plugins[id]) ? plugins[id] : {};
    plugins[id] = { ...prev, ...p, ...(isObj(p.options) ? { options: { ...(isObj(prev.options) ? prev.options : {}), ...p.options } } : {}) };
  }
  plugins.history = { ...(isObj(plugins.history) ? plugins.history : {}), enabled: false };
  const out = { ...s, capture, plugins, ui: { ...(isObj(s.ui) ? s.ui : {}), openWhenDone: false } };
  for (const k of ['keys', 'lookups']) if (isObj(w[k])) out[k] = { ...(isObj(s[k]) ? s[k] : {}), ...w[k] };
  if (Array.isArray(w.remotes)) out.remotes = w.remotes;
  return out;
}

/**
 * Launches Chromium with the extension and writes `settings` over its stored settings (see recorderSettings: capture,
 * plugins, keys, lookups, remotes), with the reading page not opening and history off.
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
    const { settings: stored = {} } = await sw.evaluate(() => chrome.storage.local.get('settings'));
    await sw.evaluate((next) => chrome.storage.local.set({ settings: next }), recorderSettings(stored, settings));
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
