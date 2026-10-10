// Capture layer: drives a tab through chrome.debugger (Chrome DevTools Protocol).
// Records the network conversation, captures screenshots, and runs page-phase plugins.
// Everything that needs the live page happens here; analysis happens after detaching.

import { HarRecorder } from '../core/recorder.js';
import { createReading, makeTarget, entriesFromResourceTiming } from '../core/harplus.js';
import { runPlugins } from '../core/plugin-host.js';
import { DEVICE_VIEWS, VIEW_LABELS } from '../core/views.js';

const NET_ENABLE = { maxTotalBufferSize: 200_000_000, maxResourceBufferSize: 20_000_000, maxPostDataSize: 65_536 };

const DEVICES = {
  mobile: {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
  tablet: {
    width: 820, height: 1180, deviceScaleFactor: 2, mobile: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
};

// Screenshot views use the device presets plus desktop. In place — no user-agent change.
const VIEW_DEVICES = { desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, ...DEVICES };

// Lighthouse-style presets (bytes/second).
const THROTTLE = {
  'slow-4g': { latency: 150, down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8, cpu: 4 },
  '3g': { latency: 300, down: (700 * 1024) / 8, up: (700 * 1024) / 8, cpu: 4 },
};

const MAX_FULLPAGE_CSS_HEIGHT = 20_000;
const MAX_IMAGE_PX = 16_000;   // WebP limit is 16383
const THUMB_WIDTH = 480;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
]);
const sessions = new Map();

/** Source text for a function so it can be evaluated in the page; tolerates method shorthand. */
export function fnSource(fn) {
  const s = fn.toString();
  if (/^(async\s+)?(function\b|\(|[\w$]+\s*=>)/.test(s)) return s;
  return s.replace(/^(async\s+)?/, (m, a) => `${a || ''}function `);
}

function pageInfo() {
  return { url: location.href, title: document.title, ua: navigator.userAgent, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio };
}

function resourceTiming() {
  const nav = performance.getEntriesByType('navigation')[0];
  const keys = ['name', 'initiatorType', 'startTime', 'duration', 'transferSize', 'encodedBodySize', 'decodedBodySize',
    'nextHopProtocol', 'responseStatus', 'contentType', 'deliveryType', 'fetchStart', 'domainLookupStart',
    'domainLookupEnd', 'connectStart', 'connectEnd', 'secureConnectionStart', 'requestStart', 'responseStart', 'responseEnd'];
  const pick = (e) => Object.fromEntries(keys.map((k) => [k, e[k]]));
  return {
    timeOrigin: performance.timeOrigin,
    dcl: nav ? nav.domContentLoadedEventEnd : -1,
    load: nav ? nav.loadEventEnd : -1,
    entries: [nav, ...performance.getEntriesByType('resource')].filter(Boolean).map(pick),
  };
}

async function scrollPage(maxMs) {
  const start = performance.now();
  const step = Math.max(200, innerHeight * 0.8);
  for (let y = 0; y < document.documentElement.scrollHeight && performance.now() - start < maxMs; y += step) {
    scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 250));
}

/** What a reader can see in this view. Runs in the page (main world). */
function measureView() {
  const shown = (el) => el.getClientRects().length > 0;
  const imgs = [...document.querySelectorAll('img')].filter(shown);
  return {
    cssWidth: innerWidth,
    cssHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().length,
    links: [...document.querySelectorAll('a[href]')].filter(shown).length,
    images: imgs.length,
    imagesWithAlt: imgs.filter((i) => i.hasAttribute('alt')).length,
    noscript: [...document.querySelectorAll('noscript')].reduce((n, e) => n + (e.innerText || '').replace(/\s+/g, ' ').trim().length, 0) >= 200,
  };
}

/** Turn every stylesheet, adopted sheet and style attribute off (on=true) or back on (on=false). */
function stripStyles(on) {
  const roots = [document];
  const walk = (root) => { for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); } };
  walk(document);
  const store = (window.__harplusStyles ||= { sheets: [], adopted: [] });
  if (on) {
    for (const root of roots) {
      for (const sheet of root.styleSheets) if (!sheet.disabled) { sheet.disabled = true; store.sheets.push(sheet); }
      if (root.adoptedStyleSheets?.length) { store.adopted.push([root, root.adoptedStyleSheets]); root.adoptedStyleSheets = []; }
      for (const el of root.querySelectorAll('[style]')) { el.setAttribute('data-harplus-style', el.getAttribute('style')); el.removeAttribute('style'); }
    }
  } else {
    for (const sheet of store.sheets) sheet.disabled = false;
    for (const [root, sheets] of store.adopted) root.adoptedStyleSheets = sheets;
    for (const root of roots) {
      for (const el of root.querySelectorAll('[data-harplus-style]')) { el.setAttribute('style', el.getAttribute('data-harplus-style')); el.removeAttribute('data-harplus-style'); }
    }
    delete window.__harplusStyles;
  }
  return true;
}

/** Break every image so the browser shows alt text, and drop background images (on) — or restore. */
function stripImages(on) {
  const SRC = 'data-harplus-src';
  const SET = 'data-harplus-srcset';
  const POSTER = 'data-harplus-poster';
  const move = (el, from, to) => { if (el.hasAttribute(from)) { el.setAttribute(to, el.getAttribute(from)); el.removeAttribute(from); } };
  if (on) {
    // Broken images fire `error`; stop it in the capture phase so the page's own onerror handlers don't run.
    const guard = (e) => { if (e.target?.getAttribute?.('src') === 'about:invalid#harplus') e.stopImmediatePropagation(); };
    window.__harplusImgGuard = guard;
    window.addEventListener('error', guard, true);
    for (const img of document.querySelectorAll('img')) {
      img.setAttribute(SRC, img.getAttribute('src') ?? '');
      move(img, 'srcset', SET);
      img.setAttribute('src', 'about:invalid#harplus');
    }
    for (const source of document.querySelectorAll('picture > source')) move(source, 'srcset', SET);
    for (const video of document.querySelectorAll('video[poster]')) move(video, 'poster', POSTER);
    const style = document.createElement('style');
    style.id = 'harplus-noimg';
    style.textContent = '*, *::before, *::after { background-image: none !important; }';
    (document.head || document.documentElement).append(style);
  } else {
    for (const img of document.querySelectorAll(`img[${SRC}]`)) {
      const src = img.getAttribute(SRC);
      if (src) img.setAttribute('src', src); else img.removeAttribute('src');
      img.removeAttribute(SRC);
      move(img, SET, 'srcset');
    }
    for (const source of document.querySelectorAll(`source[${SET}]`)) move(source, SET, 'srcset');
    for (const video of document.querySelectorAll(`video[${POSTER}]`)) move(video, POSTER, 'poster');
    document.getElementById('harplus-noimg')?.remove();
    window.removeEventListener('error', window.__harplusImgGuard, true);
    delete window.__harplusImgGuard;
  }
  return true;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function thumbnail(base64, mimeType) {
  const blob = await (await fetch(`data:${mimeType};base64,${base64}`)).blob();
  const bmp = await createImageBitmap(blob);
  const w = Math.min(THUMB_WIDTH, bmp.width);
  const h = Math.round(Math.min(bmp.height, bmp.width * 0.75) * (w / bmp.width));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, 0, 0, bmp.width, h * (bmp.width / w), 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.7 });
  return { data: toBase64(await out.arrayBuffer()), width: w, height: h };
}

export class CaptureSession {
  constructor(tabId, opts, report = () => {}) {
    this.tabId = tabId;
    this.opts = opts;
    this.timeline = [];
    this.setReporter(report);
    this.recorder = new HarRecorder({ bodies: opts.bodies, maxBodyBytes: (opts.maxBodyKB ?? 1024) * 1024 });
    this.bodyJobs = [];
    this.warnings = [];
    this.loaded = false;
    this.detached = null;
    this.isolated = null;
    this.started = Date.now();
    this.onEvent = this.onEvent.bind(this);
    this.onDetach = this.onDetach.bind(this);
  }

  setReporter(report) {
    this.report = (stage, detail) => {
      if (stage !== 'plugin') this.timeline.push({ stage, ms: Date.now() - this.started });
      report(stage, detail);
    };
  }

  send(method, params = {}, sessionId) {
    const target = sessionId ? { tabId: this.tabId, sessionId } : { tabId: this.tabId };
    return chrome.debugger.sendCommand(target, method, params);
  }

  async attach() {
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
    } catch (e) {
      throw new Error(`Cannot inspect this tab (${e.message}). Browser pages, the Web Store and other extensions are off limits.`);
    }
    this.attached = true;
    chrome.debugger.onEvent.addListener(this.onEvent);
    chrome.debugger.onDetach.addListener(this.onDetach);
    await this.send('Page.enable');
    await this.send('Network.enable', NET_ENABLE);
    const { frameTree } = await this.send('Page.getFrameTree');
    this.mainFrameId = frameTree.frame.id;
    this.recorder.mainFrameId = this.mainFrameId;
    this.initialUrl = frameTree.frame.url;
    try {
      // Cross-site iframes and workers run in their own targets; attach so their traffic is recorded too.
      await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      this.childTargets = true;
    } catch (e) {
      this.childTargets = false;
      this.warnings.push(`child targets not recorded: ${e.message}`);
    }
    await this.emulate();
  }

  async emulate() {
    const d = DEVICES[this.opts.device];
    if (d) {
      await this.send('Emulation.setDeviceMetricsOverride', { width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.mobile });
      await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    const t = THROTTLE[this.opts.throttle];
    if (t) await this.send('Emulation.setCPUThrottlingRate', { rate: t.cpu });
    await this.networkOverrides();
  }

  /** User agent, throttling and cache settings — per target, so child sessions need them too. */
  async networkOverrides(sessionId) {
    const d = DEVICES[this.opts.device];
    const t = THROTTLE[this.opts.throttle];
    if (d) await this.send('Network.setUserAgentOverride', { userAgent: d.userAgent }, sessionId);
    if (t) await this.send('Network.emulateNetworkConditions', { offline: false, latency: t.latency, downloadThroughput: t.down, uploadThroughput: t.up }, sessionId);
    if (this.opts.bypassCache) await this.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
  }

  onEvent(source, method, params) {
    if (source.tabId !== this.tabId) return;
    const sid = source.sessionId;
    if (method === 'Target.attachedToTarget') { this.onChild(params, sid); return; }
    if (method === 'Target.detachedFromTarget') { this.recorder.dropSession(params.sessionId); return; }
    if (method === 'Page.javascriptDialogOpening') {
      // alert()/confirm()/beforeunload block the page (and our evaluate calls) — dismiss and note it.
      this.warnings.push(`dismissed a ${params.type} dialog: ${String(params.message || '').slice(0, 80)}`);
      this.send('Page.handleJavaScriptDialog', { accept: true }, sid).catch(() => {});
      return;
    }
    const rec = this.recorder.handle(method, params, sid);
    if (method === 'Network.loadingFinished' && rec && !this.viewsRunning && this.recorder.wantsBody(rec)) this.bodyJobs.push(this.fetchBody(rec, sid));
    if (!sid && method === 'Page.frameStartedLoading' && params.frameId === this.mainFrameId) this.loaded = false;
    if (!sid && method === 'Page.loadEventFired') {
      this.loaded = true;
      const page = this.recorder.currentPage();
      // Only keep the title if the page hasn't navigated on before the evaluate ran.
      this.titleJob = withTimeout(this.evaluate(() => ({ t: document.title, u: location.href }), null, 'main'), 3000, 'title')
        .then(({ t, u }) => { if (page && u === page.url) this.recorder.setPageTitle(t, page.id); }).catch(() => {});
    }
  }

  async onChild({ sessionId, targetInfo, waitingForDebugger }, parentSid) {
    this.recorder.targets.set(sessionId, targetInfo.type);
    try {
      if (targetInfo.type === 'iframe' || targetInfo.type === 'worker') {
        await this.send('Network.enable', NET_ENABLE, sessionId);
        await this.networkOverrides(sessionId);
        if (targetInfo.type === 'iframe') await this.send('Page.enable', {}, sessionId).catch(() => {});
        if (targetInfo.type === 'iframe') {
          await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
        }
      }
    } catch (e) {
      if (!this.childWarned) { this.warnings.push(`child target not recorded: ${e.message}`); this.childWarned = true; }
    } finally {
      if (waitingForDebugger) {
        try {
          await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
        } catch {
          await this.send('Target.detachFromTarget', { sessionId }, parentSid).catch(() => {});
        }
      }
    }
  }

  onDetach(source, reason) {
    if (source.tabId === this.tabId) this.detached = reason || 'detached';
  }

  async fetchBody(rec, sessionId) {
    try {
      // The body lives in the session that delivered loadingFinished (a cross-site iframe's own session).
      const r = await withTimeout(this.send('Network.getResponseBody', { requestId: rec.requestId }, sessionId), 10_000, 'body');
      rec.body = { text: r.body, base64: r.base64Encoded };
    } catch { /* evicted, redirected or streaming — skip */ }
  }

  async isolatedContext() {
    if (this.isolated) return this.isolated;
    const { executionContextId } = await this.send('Page.createIsolatedWorld', { frameId: this.mainFrameId, worldName: 'harplus' });
    this.isolated = executionContextId;
    return executionContextId;
  }

  /** Run a self-contained function in the page. world: 'main' (page JS globals) or 'isolated' (DOM only). */
  async evaluate(fn, args, world = 'isolated') {
    const params = {
      expression: `(${fnSource(fn)})(${JSON.stringify(args ?? null)})`,
      returnByValue: true,
      awaitPromise: true,
    };
    if (world === 'isolated') params.contextId = await this.isolatedContext();
    const r = await this.send('Runtime.evaluate', params);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'page error').split('\n')[0]);
    return r.result.value;
  }

  async inject(urls, world = 'isolated') {
    for (const url of urls) {
      let text;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(String(r.status));
        text = await r.text();
      } catch {
        throw new Error(`Missing ${url.split('/').pop()} — see the plugin's setup notes (e.g. scripts/vendor-axe.sh)`);
      }
      const params = { expression: text, returnByValue: false };
      if (world === 'isolated') params.contextId = await this.isolatedContext();
      const r = await this.send('Runtime.evaluate', params);
      if (r.exceptionDetails) throw new Error(`Injecting ${url.split('/').pop()} failed: ${r.exceptionDetails.text}`);
    }
  }

  async reload() {
    this.loaded = false;
    this.report('loading', 'Reloading the page');
    await this.send('Page.reload', { ignoreCache: !!this.opts.bypassCache });
  }

  async waitForIdle({ idleMs = 1500, maxMs = 30_000, quiet: silent = false } = {}) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      await sleep(250);
      if (this.detached) throw new Error(`Debugger detached (${this.detached})`);
      if (!this.loaded) continue;
      const quiet = Date.now() - this.recorder.lastActivity;
      const inflight = this.recorder.inflight.size;
      if (quiet >= idleMs && (inflight === 0 || (inflight <= 2 && Date.now() - start > maxMs / 2))) return true;
    }
    if (silent) return false;
    const open = [...this.recorder.inflight].map((k) => this.recorder.live.get(k)?.request.url).filter(Boolean);
    this.warnings.push(`network did not settle within ${Math.round(maxMs / 1000)}s${open.length ? ` (${open.length} open: ${open.slice(0, 3).join(', ')})` : ''}`);
    return false;
  }

  async scrollThrough() {
    this.report('scrolling', 'Scrolling to load lazy content');
    await withTimeout(this.evaluate(scrollPage, 6000, 'main'), 10_000, 'scroll').catch((e) => this.warnings.push(`scroll failed: ${e.message}`));
  }

  get baseView() {
    return DEVICES[this.opts.device] ? this.opts.device : 'desktop';
  }

  /** Emulate a device view in place; the desktop base view simply clears the override. */
  async applyDevice(id) {
    if (id === 'desktop' && !DEVICES[this.opts.device]) {
      await this.send('Emulation.clearDeviceMetricsOverride');
      await this.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      return;
    }
    const d = VIEW_DEVICES[id];
    await this.send('Emulation.setDeviceMetricsOverride', { width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.mobile });
    await this.send('Emulation.setTouchEmulationEnabled', d.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  }

  /** Wait for a short network lull without adding "did not settle" warnings to the reading. */
  async settle(maxMs) {
    await this.waitForIdle({ idleMs: 500, maxMs, quiet: true }).catch(() => false);
  }

  async reloadQuiet() {
    this.loaded = false;
    this.isolated = null;
    await this.send('Page.reload', { ignoreCache: false });
  }

  /**
   * Extra screenshots after the reading is built: other devices (in place), no CSS and no images
   * (toggled in place), no JavaScript (one reload, then a normal reload to restore the tab).
   * Each view is isolated: a failure becomes a warning and a viewsSkipped entry. A view's run is
   * timed; its restore is separate and always runs. Results are committed only if the run finished in time.
   */
  async captureViews(reading) {
    const t0 = Date.now();
    this.viewsRunning = true;
    // The reading is built; views must not inherit its cache bypass or throttling, and their traffic is discarded.
    if (this.opts.bypassCache) await this.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
    if (THROTTLE[this.opts.throttle]) {
      await this.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
      await this.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    }
    const hp = reading.log._harplus;
    const want = this.opts.views || {};
    const base = this.baseView;
    const views = {};
    const skipped = [];
    const measure = () => withTimeout(this.evaluate(measureView, null, 'main'), 5000, 'measure');
    // Collect a view's shots and measurements into locals; the caller commits them on success.
    const grab = async (id) => ({ id, shots: await this.shoot(id), measured: await measure() });
    const view = async (id, { runMs, restoreMs, run, restore }) => {
      if (want[id] === false) { skipped.push({ view: id, reason: 'disabled' }); return; }
      if (this.detached) { skipped.push({ view: id, reason: `debugger detached (${this.detached})` }); return; }
      if (this.viewsAborted) { skipped.push({ view: id, reason: this.viewsAborted }); return; }
      const label = `${VIEW_LABELS[id]} view`;
      this.report('views', label);
      const p = run();
      try {
        const got = await withTimeout(p, runMs, label);
        hp.screenshots.push(...got.shots);
        views[id] = got.measured;
      } catch (e) {
        skipped.push({ view: id, reason: e.message });
        if (/screenshot/.test(e.message) && /timed out/.test(e.message)) this.viewsAborted = 'tab hidden or not painting — screenshots timed out';
        this.warnings.push(`${label} failed: ${e.message}`);
        // The run is not cancelled: let it finish (bounded) so it cannot overlap the restore.
        await withTimeout(p, 45_000, 'restore').catch(() => {});
      }
      await withTimeout(restore(), restoreMs, `${label} restore`).catch((e) => this.warnings.push(`${label} restore failed: ${e.message}`));
    };

    await measure().then((m) => { views[base] = m; }).catch((e) => this.warnings.push(`measuring the page failed: ${e.message}`));
    for (const id of DEVICE_VIEWS) {
      if (id === base) continue;
      await view(id, {
        runMs: 30_000,
        restoreMs: 20_000,
        run: async () => {
          await this.applyDevice(id);
          await sleep(1000);
          await this.settle(4000);
          return grab(id);
        },
        restore: () => this.applyDevice(base),
      });
    }
    await view('nocss', {
      runMs: 30_000,
      restoreMs: 20_000,
      run: async () => {
        await this.evaluate(stripStyles, true, 'main');
        await sleep(300);
        return grab('nocss');
      },
      restore: () => this.evaluate(stripStyles, false, 'main'),
    });
    await view('noimages', {
      runMs: 30_000,
      restoreMs: 20_000,
      run: async () => {
        await this.evaluate(stripImages, true, 'main');
        await sleep(300);
        return grab('noimages');
      },
      restore: () => this.evaluate(stripImages, false, 'main'),
    });
    if (want.nojs !== false && this.opts.mode !== 'reload') {
      skipped.push({ view: 'nojs', reason: 'not in reload mode' });
    } else {
      await view('nojs', {
        runMs: 60_000,
        restoreMs: 30_000,
        run: async () => {
          await this.send('Emulation.setScriptExecutionDisabled', { value: true });
          await this.reloadQuiet();
          await this.settle(15_000);
          if (!this.loaded) throw new Error('page did not finish loading without JavaScript');
          return grab('nojs');
        },
        restore: async () => {
          await this.send('Emulation.setScriptExecutionDisabled', { value: false }).catch(() => {});
          await this.reloadQuiet().catch(() => {});
          await this.settle(15_000);
        },
      });
    }
    hp.capture.views = views;
    hp.capture.viewsMs = Date.now() - t0;
    if (skipped.length) hp.capture.viewsSkipped = skipped;
  }

  /** The base view as captured: viewport + thumbnail (+ full page). */
  screenshots() {
    return this.shoot(this.baseView, { thumb: true });
  }

  async shoot(view, { thumb = false } = {}) {
    const shots = [];
    const m = await withTimeout(this.send('Page.getLayoutMetrics'), 5000, 'layout metrics');
    const vp = m.cssLayoutViewport || m.layoutViewport;
    const content = m.cssContentSize || m.contentSize;
    const dpr = (await withTimeout(this.evaluate(() => devicePixelRatio, null, 'main'), 3000, 'dpr').catch(() => 1)) || 1;

    if (thumb) this.report('screenshot', 'Capturing screenshots');
    const shot = await withTimeout(this.send('Page.captureScreenshot', { format: 'webp', quality: 80 }), 20_000, 'screenshot');
    shots.push({
      kind: 'viewport', view, mimeType: 'image/webp', encoding: 'base64', dpr,
      cssWidth: vp.clientWidth, cssHeight: vp.clientHeight, data: shot.data,
    });
    if (thumb) {
      try {
        const t = await thumbnail(shot.data, 'image/webp');
        shots.push({ kind: 'thumbnail', mimeType: 'image/webp', encoding: 'base64', width: t.width, height: t.height, data: t.data });
      } catch (e) { this.warnings.push(`thumbnail failed: ${e.message}`); }
    }

    if (this.opts.fullPage) {
      const cssW = Math.min(Math.ceil(content.width), Math.ceil(vp.clientWidth * 1.5));
      const cssH = Math.min(Math.ceil(content.height), MAX_FULLPAGE_CSS_HEIGHT);
      const scale = Math.min(1, MAX_IMAGE_PX / (cssH * dpr), MAX_IMAGE_PX / (cssW * dpr));
      try {
        const full = await withTimeout(this.send('Page.captureScreenshot', {
          format: 'webp', quality: 70, captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: cssW, height: cssH, scale },
        }), 30_000, 'full-page screenshot');
        shots.push({
          kind: 'fullpage', view, mimeType: 'image/webp', encoding: 'base64', dpr, scale: Math.round(scale * 1000) / 1000,
          cssWidth: cssW, cssHeight: cssH, truncated: content.height > cssH, data: full.data,
        });
      } catch (e) { this.warnings.push(`full-page screenshot failed: ${e.message}`); }
    }
    return shots;
  }

  /** Collect everything that needs the live page, then build the reading. */
  async finish({ plugins, settings }) {
    const live = !this.detached;
    let info = {};
    let shots = [];
    let rt = null;
    if (live) {
      this.report('collecting', 'Reading the page');
      const tree = await this.send('Page.getFrameTree').catch(() => null);
      if (tree) this.mainFrameId = tree.frameTree.frame.id;
      this.isolated = null;
      info = await withTimeout(this.evaluate(pageInfo, null, 'main'), 5000, 'page info').catch(() => ({}));
      await this.titleJob;
      this.recorder.setPageTitle(info.title);
      shots = await this.screenshots().catch((e) => { this.warnings.push(`screenshots failed: ${e.message}`); return []; });
      if (this.opts.mode === 'snapshot') rt = await withTimeout(this.evaluate(resourceTiming, null, 'main'), 5000, 'resource timing').catch(() => null);
    } else {
      this.warnings.push(`debugger detached early (${this.detached}); no screenshots or in-page plugins`);
    }
    this.report('bodies', 'Collecting response bodies');
    await Promise.race([Promise.allSettled(this.bodyJobs), sleep(5000)]);

    const built = this.recorder.build({ dropImplicit: this.opts.mode === 'reload' });
    if (rt) {
      built.pages = [{ startedDateTime: new Date(rt.timeOrigin).toISOString(), id: 'page_1', title: info.title || info.url, pageTimings: { onContentLoad: rt.dcl, onLoad: rt.load } }];
      built.entries = entriesFromResourceTiming(rt.entries, { pageref: 'page_1', timeOrigin: rt.timeOrigin });
    }
    const { mode, device, throttle, bypassCache, bodies, maxBodyKB, scroll, fullPage } = this.opts;
    const finalUrl = info.url || this.recorder.currentPage()?.url || this.initialUrl;
    const reading = createReading({
      pages: built.pages,
      entries: built.entries,
      tls: { ...built.tls },
      target: makeTarget(this.initialUrl, info.title || '', finalUrl),
      capture: {
        mode, device, throttle, bypassCache, bodies, maxBodyKB, scroll, fullPage,
        userAgent: info.ua,
        viewport: info.vw ? { width: info.vw, height: info.vh, dpr: info.dpr } : undefined,
        startedAt: new Date(this.started).toISOString(),
        durationMs: Date.now() - this.started,
        reachedIdle: this.reachedIdle,
        timeline: this.timeline,
        childTargets: this.childTargets,
        warnings: this.warnings,
      },
      screenshots: shots,
      browser: { name: 'Chrome', version: (info.ua?.match(/Chrome\/([\d.]+)/) || [])[1] || '' },
    });
    if (live) {
      this.report('sensing', 'Running in-page plugins');
      await runPlugins(reading, plugins, {
        phases: ['page'],
        settings,
        evaluate: (fn, args, world) => this.evaluate(fn, args, world),
        inject: (urls, world) => this.inject(urls, world),
        onProgress: (p) => this.report('plugin', p),
      });
      if (!this.detached) await this.captureViews(reading).catch((e) => this.warnings.push(`views failed: ${e.message}`));
    }
    return reading;
  }

  async detach() {
    chrome.debugger.onEvent.removeListener(this.onEvent);
    chrome.debugger.onDetach.removeListener(this.onDetach);
    if (this.attached && !this.detached) await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
  }
}

/* ------------------------------------------------------------- public API */

export const isBusy = (tabId) => sessions.has(tabId);

/** Forget a session whose tab went away (the debugger detaches on its own). */
export async function discard(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  await s.detach();
}
export const isRecording = (tabId) => sessions.get(tabId)?.recording === true;

/** One-shot reading: reload (or snapshot) → idle → scroll → screenshots → page plugins. */
export async function takeReading(tabId, opts, ctx) {
  if (sessions.has(tabId)) throw new Error('This tab is already being captured');
  const s = new CaptureSession(tabId, opts, ctx.report);
  sessions.set(tabId, s);
  try {
    await s.attach();
    if (opts.mode === 'snapshot') s.loaded = true;
    else {
      await s.reload();
      s.reachedIdle = await s.waitForIdle({ idleMs: opts.idleMs, maxMs: opts.maxWaitSec * 1000 });
      s.report('loaded', s.reachedIdle ? 'Network idle' : 'Network still busy — continuing');
      if (opts.scroll) {
        await s.scrollThrough();
        await s.waitForIdle({ idleMs: 800, maxMs: 8000 });
      }
    }
    return await s.finish(ctx);
  } finally {
    sessions.delete(tabId);
    await s.detach();
  }
}

/** Start recording: everything the tab does until stopRecording (multi-page flows, SPAs). */
export async function startRecording(tabId, opts, ctx) {
  if (sessions.has(tabId)) throw new Error('This tab is already being captured');
  const s = new CaptureSession(tabId, { ...opts, mode: 'record' }, ctx.report);
  s.recording = true;
  sessions.set(tabId, s);
  try {
    await s.attach();
    s.loaded = true;
    if (opts.reloadFirst) await s.reload();
  } catch (e) {
    sessions.delete(tabId);
    await s.detach();
    throw e;
  }
}

export async function stopRecording(tabId, ctx) {
  const s = sessions.get(tabId);
  if (!s?.recording) throw new Error('This tab is not being recorded');
  s.recording = false;
  s.setReporter(ctx.report);
  try {
    return await s.finish(ctx);
  } finally {
    sessions.delete(tabId);
    await s.detach();
  }
}
