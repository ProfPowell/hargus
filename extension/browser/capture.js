// Capture layer: drives a tab through chrome.debugger (Chrome DevTools Protocol).
// Records the network conversation, captures screenshots, and runs page-phase plugins.
// Everything that needs the live page happens here; analysis happens after detaching.

import { HarRecorder } from '../core/recorder.js';
import { createReading, makeTarget, entriesFromResourceTiming, mergeViewsPatch } from '../core/harplus.js';
import { runPlugins } from '../core/plugin-host.js';
import { chromeDetector, primary } from '../core/language.js';
import { TRANSLATED_VIEWS, TRANSLATED_BUDGET_MS, classifyError, sameAsPage, needsFallback, viewBudget } from '../core/translation.js';
import { translatePage, restoreTranslation, leftoverText } from './translate-view.js';
import { focusChanges } from '../core/focus.js';
import { consoleEntryFrom, addConsoleEntry } from '../core/console.js';
import { pickBreakpoints, viewLabel } from '../core/views.js';
import { imageStats, visionCheck } from '../core/view-checks.js';
import { DEVICE_VIEWS, VISION_VIEWS, DISPLAY_VIEWS, VISION_DEFICIENCY, MEDIA_EMULATION, SPACING_CSS } from '../core/views.js';

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

// The media query each display view's emulation should make true in the page (its self-check).
const MEDIA_QUERY = { dark: '(prefers-color-scheme: dark)', forced: '(forced-colors: active)', morecontrast: '(prefers-contrast: more)', print: 'print' };

// Lighthouse-style presets (bytes/second).
const THROTTLE = {
  'slow-4g': { latency: 150, down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8, cpu: 4 },
  '3g': { latency: 300, down: (700 * 1024) / 8, up: (700 * 1024) / 8, cpu: 4 },
};

const MAX_FULLPAGE_CSS_HEIGHT = 20_000;
const MAX_IMAGE_PX = 16_000;   // WebP limit is 16383
const THUMB_WIDTH = 480;

// The no-images view pauses these requests. Image and Media fail at once. What a script fetches (XHR, Fetch, Other)
// is decided by its response's Content-Type: Chrome's own images-off setting leaves script fetches alone, so only
// what really is a picture or a stream fails.
const IMAGES_OFF_PATTERNS = [
  { resourceType: 'Image' }, { resourceType: 'Media' },
  ...['XHR', 'Fetch', 'Other'].map((resourceType) => ({ resourceType, requestStage: 'Response' })),
];
const MEDIA_TYPE = /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)$)/;
// Stream segments often come with a generic type (YouTube's application/vnd.yt-ump, octet-stream): their path says what they are.
const STREAM_PATH = /(\/videoplayback|\.(m3u8|mpd|m4s|ts))$/i;
const NOT_A_STREAM = /\.d\.ts$/i; // TypeScript definitions, which servers often label video/mp2t
const CODE_TYPE = /(javascript|typescript|json|html|css|xml)/; // a .ts path served as code is source, not a segment
const NEVER_BLOCKED = /^(Document|Script|Stylesheet|Font)$/;

/**
 * Does the no-images view fail this request? Image and Media: always (request stage). A script fetch: by its response's
 * content type (contentType undefined → not answered yet → continue). Raster images, video, audio and stream manifests fail;
 * an SVG fetched as markup (icon libraries inline it) does not, because a reader with images off still sees it.
 */
export function blockedByImagesOff(url, resourceType, contentType) {
  if (resourceType === 'Image' || resourceType === 'Media') return true;
  if (NEVER_BLOCKED.test(resourceType || '') || contentType == null) return false;
  let path;
  try { path = new URL(url).pathname; } catch { return false; }
  if (NOT_A_STREAM.test(path)) return false;
  const type = String(contentType).split(';')[0].trim().toLowerCase();
  if (type.startsWith('image/')) return type !== 'image/svg+xml';
  return MEDIA_TYPE.test(type) || (STREAM_PATH.test(path) && !CODE_TYPE.test(type));
}

// Emulations every frame must share (a cross-origin iframe renders in its own target), with their reset values.
const FRAME_EMULATION_RESET = {
  'Emulation.setEmulatedVisionDeficiency': { type: 'none' },
  'Emulation.setEmulatedMedia': { media: '', features: [] },
};

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
  if (!performance.getEntriesByName('harplus:scroll-start').length) performance.mark('harplus:scroll-start');
  const start = performance.now();
  const step = Math.max(200, innerHeight * 0.8);
  for (let y = 0; y < document.documentElement.scrollHeight && performance.now() - start < maxMs; y += step) {
    // Instant: a smooth-scrolling page would otherwise animate each step and never reach the bottom.
    scrollTo({ left: 0, top: y, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 120));
  }
  scrollTo({ left: 0, top: 0, behavior: 'instant' });
  await new Promise((r) => setTimeout(r, 250));
}

/** Wait until the page width stops changing after a resize or font change. Runs in the page (main world). */
async function settleLayout(maxMs) {
  const start = performance.now();
  let last = -1;
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const w = document.documentElement.scrollWidth;
    const elapsed = performance.now() - start;
    if ((w === last && elapsed >= 600) || elapsed >= maxMs) return;
    last = w;
  }
}

/** Wait until the page has painted and stopped changing size. Runs in the page (main world). */
export async function settleRender(maxMs) {
  const start = performance.now();
  // rAF does not fire in hidden tabs; fall back to a 50 ms tick.
  const frame = () => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 50); });
  await frame();
  await frame();
  await Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 500))]);
  let last = '';
  let stable = 0;
  while (performance.now() - start < maxMs) {
    await frame();
    const now = `${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}`;
    stable = now === last ? stable + 1 : 0;
    last = now;
    if (stable >= 2) return;
  }
}

/** What a reader can see in this view. Runs in the page (main world). */
export function measureView() {
  const t0 = performance.now();
  let truncated = false;
  const shown = (el) => el.getClientRects().length > 0;
  const imgs = [...document.querySelectorAll('img')].filter(shown);
  const root = document.body || document.documentElement;
  let clipped = 0;
  let walked = 0;
  let forcedNone = 0;
  const fixed = [];
  const vpArea = innerWidth * innerHeight;
  for (const el of root.querySelectorAll('*')) {
    if (++walked > 3000 || performance.now() - t0 > 1500) { truncated = true; break; }
    const cs = getComputedStyle(el);
    // Count opt-out roots only: forced-color-adjust is inherited, so descendants of a root repeat it.
    if (cs.forcedColorAdjust === 'none' && (!el.parentElement || getComputedStyle(el.parentElement).forcedColorAdjust !== 'none')) forcedNone++;
    // Sticky elements stay in flow in print; only fixed ones repeat over the content.
    if (cs.position === 'fixed' && fixed.length < 20 && cs.visibility === 'visible' && Number(cs.opacity) !== 0) {
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= 0.1 * vpArea) fixed.push({ tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) });
    }
    if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
    const x = el.scrollWidth > el.clientWidth + 1 && (/hidden|clip/.test(cs.overflowX) || cs.textOverflow === 'ellipsis');
    const y = el.scrollHeight > el.clientHeight + 1 && /hidden|clip/.test(cs.overflowY);
    if (x || y) clipped++;
  }
  // Any computed colour (rgb(), oklch(), color(), lab() …) resolved to sRGB by painting it on a 1×1 canvas.
  let paint = null;
  const lum = (c) => {
    paint ||= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = 'rgba(0, 0, 0, 0)';
    paint.fillStyle = c;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
    if (!a) return null;
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return Math.round((0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)) * 1000) / 1000;
  };
  let bg = null;
  try {
    for (let el = document.body || document.documentElement; el && bg == null; el = el.parentElement) bg = lum(getComputedStyle(el).backgroundColor);
    if (bg == null) {
      // No opaque background up to html: the canvas shows, dark only for a dark-scheme page on a dark-preferring browser.
      const meta = document.querySelector('meta[name="color-scheme" i]')?.getAttribute('content') || '';
      const darkScheme = /dark/.test(getComputedStyle(document.documentElement).colorScheme || '') || /dark/i.test(meta);
      bg = matchMedia('(prefers-color-scheme: dark)').matches && darkScheme ? 0 : 1;
    }
  } catch { bg = null; }
  // Site-wide chrome only: a header or footer inside a sectioning element belongs to that section.
  const chromeEl = [...document.querySelectorAll('nav, [role=navigation], header, footer, [role=banner], [role=contentinfo]')]
    .some((el) => shown(el) && (el.matches('nav, [role=navigation], [role=banner], [role=contentinfo]') || !el.parentElement?.closest('article, aside, main, nav, section')));
  let iconOnly = 0;
  let seenControls = 0;
  for (const el of document.querySelectorAll('a, button')) {
    if (++seenControls > 2000 || performance.now() - t0 > 1500) { truncated = true; break; }
    if (el.textContent.trim() || el.getAttribute('aria-label') || el.querySelector('img, svg')) continue;
    if (shown(el) && getComputedStyle(el).backgroundImage !== 'none') iconOnly++;
  }
  const RTL = /(?=\p{L})[\p{Script=Hebrew}\p{Script=Arabic}]/gu;
  const LETTER = /\p{L}/u;
  let letters = 0;
  let rtl = 0;
  let unmarked = 0;
  let nodesSeen = 0;
  const dirOf = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (++nodesSeen > 20000 || performance.now() - t0 > 1500) { truncated = true; break; }
    const p = n.parentElement;
    if (p && /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) continue;
    const text = n.textContent;
    let l = 0;
    for (const ch of text) if (LETTER.test(ch)) l++;
    if (!l) continue;
    letters += l;
    let r = 0;
    for (const _ of text.matchAll(RTL)) r++;
    if (!r) continue;
    rtl += r;
    if (p) {
      if (!dirOf.has(p)) dirOf.set(p, getComputedStyle(p).direction);
      if (dirOf.get(p) !== 'rtl') unmarked += r;
    }
  }
  const share = (x) => (letters ? Math.round((x / letters) * 1000) / 1000 : 0);
  const vpath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
      let p = n.localName;
      if (n.id) { parts.unshift(`${p}#${n.id}`); break; }
      if (n.classList.length) p += `.${[...n.classList].slice(0, 2).join('.')}`;
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const overflowers = [];
  let overflowTruncated = false;
  if (document.documentElement.scrollWidth > innerWidth + 1) {
    const cands = [];
    let seen = 0;
    const w0 = performance.now();
    // Content clipped by an ancestor, or position: fixed, does not add to scrollWidth.
    // The viewport takes its direction from <body> (CSS Writing Modes), so <body dir="rtl"> is a right-to-left page.
    const rtlDoc = getComputedStyle(document.body ?? document.documentElement).direction === 'rtl';
    const clipped = (el, side) => {
      if (getComputedStyle(el).position === 'fixed') return true;
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        if (a === document.body) break;
        if (getComputedStyle(a).overflowX === 'visible') continue;
        const ar = a.getBoundingClientRect();
        if (side === 'right' ? ar.right <= innerWidth + 1 : ar.left >= -1) return true;
      }
      return false;
    };
    for (const el of root.querySelectorAll('*')) {
      if (++seen > 3000 || cands.length >= 300 || performance.now() - w0 > 800) { overflowTruncated = true; break; }
      const r = el.getBoundingClientRect();
      if (r.width <= 0) continue;
      const side = rtlDoc ? (r.left < -1 ? 'left' : null) : (r.right > innerWidth + 1 ? 'right' : null);
      if (side && !clipped(el, side)) cands.push({ el, r, side });
    }
    const inner = cands.filter((c) => !cands.some((o) => o !== c && c.el.contains(o.el)));
    inner.sort((a, b) => (b.side === 'left' ? -b.r.left : b.r.right - innerWidth) - (a.side === 'left' ? -a.r.left : a.r.right - innerWidth));
    for (const c of inner.slice(0, 5)) overflowers.push({
      selector: vpath(c.el), width: Math.round(c.r.width),
      over: Math.round(c.side === 'left' ? -c.r.left : c.r.right - innerWidth),
      side: c.side, offscreen: c.r.right <= 0 || c.r.left >= innerWidth,
    });
  }
  // Confirm the page really scrolls sideways: a stale scrollWidth from before a resize can over-report.
  let scrollsX = false;
  const sw = document.documentElement.scrollWidth;
  if (sw > innerWidth) {
    const x0 = scrollX;
    const y0 = scrollY;
    // RTL overflow extends leftwards, so scrollX goes negative: try the positive direction, then the negative one.
    scrollTo({ left: sw, top: y0, behavior: 'instant' });
    let moved = scrollX !== x0;
    if (!moved) {
      scrollTo({ left: -sw, top: y0, behavior: 'instant' });
      moved = scrollX !== x0;
    }
    scrollsX = moved;
    scrollTo({ left: x0, top: y0, behavior: 'instant' });
  }
  return {
    cssWidth: innerWidth,
    cssHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().length,
    links: [...document.querySelectorAll('a[href]')].filter(shown).length,
    images: imgs.length,
    imagesWithAlt: imgs.filter((i) => i.hasAttribute('alt')).length,
    noscript: [...document.querySelectorAll('noscript')].reduce((n, e) => n + (e.innerText || '').replace(/\s+/g, ' ').trim().length, 0) >= 200,
    overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    // html or body hides horizontal overflow, so the page cannot scroll sideways whatever overflowX says.
    rootClipX: [document.documentElement, document.body].some((el) => el && /hidden|clip/.test(getComputedStyle(el).overflowX)),
    scrollsX,
    clipped,
    truncated,
    overflowers,
    overflowTruncated,
    rtlChars: share(rtl),
    rtlUnmarked: share(unmarked),
    dir: document.documentElement.getAttribute('dir') || getComputedStyle(document.documentElement).direction,
    bodyFont: parseFloat(getComputedStyle(document.body || document.documentElement).fontSize) || 0,
    bg,
    fixed,
    chrome: chromeEl,
    forcedNone,
    iconOnly,
  };
}

/**
 * Pause playing media and running animations (on) so every view shows the same frame; resume exactly those (off).
 * Running CSS transitions are finished rather than paused, so the page is shown in its settled state.
 * A second `on` adds to what the first paused. `off` resumes only what is still paused and live: an animation a
 * view cancelled (no CSS, a media change) has been replaced by the page's own, and a removed <audio>/<video> stays quiet.
 */
export function freezeMedia(on) {
  if (on) {
    const f = (window.__harplusFrozen ||= { media: [], anims: [] });
    const walk = (root) => {
      for (const m of root.querySelectorAll('video, audio')) if (!m.paused) { m.pause(); if (!f.media.includes(m)) f.media.push(m); }
      for (const el of root.querySelectorAll ? root.querySelectorAll('*') : []) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    const anims = (document.getAnimations ? document.getAnimations() : []).filter((a) => a.playState === 'running');
    for (const a of anims) {
      // A CSS transition is the page moving to a settled state (often one a view's restore just set off): finish it,
      // or it would be held at its start in every later view. Animations are paused, and resumed by `off`.
      if (a.transitionProperty != null) { try { a.finish(); continue; } catch { /* fall through to pause */ } }
      a.pause(); if (!f.anims.includes(a)) f.anims.push(a);
    }
    return true;
  }
  const f = window.__harplusFrozen;
  if (!f) return true;
  for (const m of f.media) if (m.isConnected && m.paused) m.play?.()?.catch?.(() => {});
  for (const a of f.anims) if (a.playState === 'paused') a.play();
  delete window.__harplusFrozen;
  return true;
}

/** Turn every stylesheet, adopted sheet and style attribute off (on=true) or back on (on=false). */
export function stripStyles(on) {
  const roots = [document];
  const walk = (root) => { for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); } };
  walk(document);
  const store = (window.__harplusStyles ||= { sheets: [], adopted: [] });
  if (on) {
    window.__harplusKeep?.observer?.disconnect(); // an earlier view's keeper, if its restore failed
    for (const root of roots) {
      for (const sheet of root.styleSheets) if (!sheet.disabled) { sheet.disabled = true; store.sheets.push(sheet); }
      // adoptedStyleSheets is a live array: copy it before clearing, or the saved reference empties too.
      if (root.adoptedStyleSheets?.length) { store.adopted.push([root, [...root.adoptedStyleSheets]]); root.adoptedStyleSheets = []; }
      for (const el of root.querySelectorAll('[style]')) { el.setAttribute('data-harplus-style', el.getAttribute('style')); el.removeAttribute('style'); }
    }
    // Keeper: page scripts that add sheets or inline styles afterwards are switched off too.
    // It gives up after 200 re-applications, so a page that fights back cannot livelock the tab.
    const keep = (window.__harplusKeep = { count: 0 });
    const tired = () => { if (keep.count < 200) return false; keep.observer.disconnect(); keep.gaveUp = true; return true; };
    const offSheet = (node) => {
      const off = () => { if (node.sheet && !node.sheet.disabled) { node.sheet.disabled = true; store.sheets.push(node.sheet); return true; } return false; };
      if (node.localName === 'link' && !node.sheet) node.addEventListener('load', () => { if (window.__harplusKeep === keep && !tired() && off()) keep.count++; }, { once: true });
      return off();
    };
    // A script writing el.style.x after the strip leaves only that declaration: merge it into the saved style, don't replace it.
    const scratch = document.createElement('div');
    const offStyle = (el) => {
      if (!el.hasAttribute?.('style')) return false;
      const before = el.getAttribute('data-harplus-style');
      let css = el.getAttribute('style');
      if (before != null && el.style) {
        scratch.setAttribute('style', before);
        for (const prop of el.style) scratch.style.setProperty(prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop));
        css = scratch.getAttribute('style') || '';
      }
      el.setAttribute('data-harplus-style', css);
      el.removeAttribute('style');
      return true;
    };
    const SHEET = 'style, link[rel~="stylesheet" i]';
    keep.observer = new MutationObserver((records) => {
      if (tired()) return;
      let hit = false;
      for (const m of records) {
        if (m.type === 'attributes') { hit = offStyle(m.target) || hit; continue; }
        // Rewriting a <style>'s text gives it a new, enabled sheet.
        const owner = m.type === 'characterData' ? m.target.parentElement : m.target;
        if (owner?.matches?.(SHEET)) hit = offSheet(owner) || hit;
        if (m.type === 'characterData') continue;
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          for (const el of [n, ...n.querySelectorAll('*')]) {
            if (el.matches(SHEET)) hit = offSheet(el) || hit;
            hit = offStyle(el) || hit;
          }
        }
      }
      if (hit) keep.count++;
    });
    for (const root of roots) keep.observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style'] });
  } else {
    window.__harplusKeep?.observer?.disconnect();
    delete window.__harplusKeep;
    for (const sheet of store.sheets) sheet.disabled = false;
    for (const [root, sheets] of store.adopted) root.adoptedStyleSheets = sheets;
    for (const root of roots) {
      for (const el of root.querySelectorAll('[data-harplus-style]')) { el.setAttribute('style', el.getAttribute('data-harplus-style')); el.removeAttribute('data-harplus-style'); }
    }
    delete window.__harplusStyles;
  }
  return true;
}

/** After an images-off load: what still paints an image? */
function imagesProbe() {
  const shown = (el) => el.getClientRects().length > 0;
  let imgPainted = 0, mediaPlaying = 0;
  const walk = (root) => {
    for (const img of root.querySelectorAll('img')) if (shown(img) && img.complete && img.naturalWidth > 0) imgPainted++;
    for (const v of root.querySelectorAll('video')) if (shown(v) && v.readyState >= 2) mediaPlaying++;
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  const IMG = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)(\?|#|$)/i;
  const bgPainted = performance.getEntriesByType('resource')
    .filter((e) => (e.initiatorType === 'img' || (e.initiatorType === 'css' && IMG.test(e.name))) && (e.decodedBodySize > 0 || e.transferSize > 0)).length;
  // hideInlineImages' keeper gave up: a page that kept putting inline images back.
  const inlineGaveUp = !!window.__harplusInline?.keep?.gaveUp;
  return { imgPainted, bgPainted, mediaPlaying, inlineGaveUp };
}

/**
 * The no-images view's second half: images that never touch the network. Hides (on) every <img> showing a data: or blob:
 * source, and data:/blob: CSS backgrounds and pseudo-element images, or puts them back (off). Returns how many it hid.
 * Gradients are left alone (they are not images), so only inline url() backgrounds go, element by element.
 */
export function hideInlineImages(on) {
  const INLINE = /^\s*(data|blob):/i;
  const URL_INLINE = /url\(\s*["']?\s*(data|blob):/i;
  const OFF = 'about:invalid#harplus';
  const roots = [];
  const walk = (root) => { roots.push(root); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot); };
  walk(document);
  const state = window.__harplusInline;
  if (!on) {
    if (window.__harplusKeep === state?.keep) { state.keep.observer.disconnect(); delete window.__harplusKeep; }
    if (state) window.removeEventListener('error', state.quiet, true);
    const put = (el, attr, saved) => {
      if (!el.hasAttribute(saved)) return;
      el.setAttribute(attr, el.getAttribute(saved));
      el.removeAttribute(saved);
    };
    for (const root of roots) {
      for (const img of root.querySelectorAll(`img[src="${OFF}"]`)) {
        if (!img.hasAttribute('data-harplus-src')) img.removeAttribute('src');
        put(img, 'src', 'data-harplus-src');
        put(img, 'srcset', 'data-harplus-srcset');
      }
      for (const src of root.querySelectorAll('source[data-harplus-srcset]')) put(src, 'srcset', 'data-harplus-srcset');
      for (const el of root.querySelectorAll('[data-harplus-bg]')) {
        const [value, priority] = JSON.parse(el.getAttribute('data-harplus-bg'));
        if (value) el.style.setProperty('background-image', value, priority); else el.style.removeProperty('background-image');
        el.removeAttribute('data-harplus-bg');
      }
      for (const el of root.querySelectorAll('[data-harplus-pseudo]')) el.removeAttribute('data-harplus-pseudo');
      if (state && root.adoptedStyleSheets) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== state.sheet);
    }
    delete window.__harplusInline;
    return 0;
  }
  window.__harplusKeep?.observer?.disconnect(); // an earlier view's keeper, if its restore failed
  // A constructed sheet, not a <style> (a strict CSP blocks that): it hides the pseudo-element images marked below.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(['before', 'after'].map((p) => `[data-harplus-pseudo~="${p}-bg"]::${p} { background-image: none !important; }
    [data-harplus-pseudo~="${p}-content"]::${p} { content: none !important; }`).join('\n'));
  const keep = { count: 0 };
  // The page must not see our break as its own error: an onerror that puts the placeholder back would fight the keeper.
  // Capture phase on window runs before the image's own handlers.
  const quiet = (e) => { if (e.target?.localName === 'img' && e.target.getAttribute('src') === OFF) e.stopImmediatePropagation(); };
  window.addEventListener('error', quiet, true);
  const store = (window.__harplusInline = { sheet, keep, quiet, hidden: 0 });
  const adopt = (root) => { if (root.adoptedStyleSheets && !root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]; };
  const hideImg = (img) => {
    const src = img.getAttribute('src') || '';
    if (src === OFF) return false;
    const srcset = img.getAttribute('srcset') || '';
    // A <picture> picks its <source> before the <img> (and currentSrc can lag a new node): its sources count, and move aside too.
    const sources = img.parentElement?.localName === 'picture' ? [...img.parentElement.querySelectorAll('source[srcset]')] : [];
    if (![img.currentSrc || '', src, srcset, ...sources.map((s) => s.getAttribute('srcset'))].some((u) => INLINE.test(u))) return false;
    if (img.hasAttribute('src')) img.setAttribute('data-harplus-src', src);
    if (img.hasAttribute('srcset')) { img.setAttribute('data-harplus-srcset', srcset); img.removeAttribute('srcset'); }
    for (const s of sources) { s.setAttribute('data-harplus-srcset', s.getAttribute('srcset')); s.removeAttribute('srcset'); }
    img.setAttribute('src', OFF);
    return true;
  };
  const hideBg = (el) => {
    let hit = false;
    const cs = getComputedStyle(el);
    if (URL_INLINE.test(cs.backgroundImage) && !el.hasAttribute('data-harplus-bg')) {
      el.setAttribute('data-harplus-bg', JSON.stringify([el.style.getPropertyValue('background-image'), el.style.getPropertyPriority('background-image')]));
      el.style.setProperty('background-image', 'none', 'important');
      hit = true;
    }
    const marks = new Set((el.getAttribute('data-harplus-pseudo') || '').split(' ').filter(Boolean));
    const before = marks.size;
    for (const p of ['before', 'after']) {
      const ps = getComputedStyle(el, `::${p}`);
      if (URL_INLINE.test(ps.backgroundImage)) marks.add(`${p}-bg`);
      if (URL_INLINE.test(ps.content)) marks.add(`${p}-content`);
    }
    if (marks.size > before) { el.setAttribute('data-harplus-pseudo', [...marks].join(' ')); hit = true; }
    return hit;
  };
  const hide = (el) => (el.localName === 'img' ? hideImg(el) : false) + (hideBg(el) ? 1 : 0);
  for (const root of roots) {
    adopt(root);
    for (const el of root.querySelectorAll('*')) store.hidden += hide(el);
  }
  // Keeper: inline images the page adds or re-sets later are hidden too — up to 200 times, so a page that fights back cannot livelock the tab.
  window.__harplusKeep = keep;
  keep.observer = new MutationObserver((records) => {
    if (keep.count >= 200) { keep.observer.disconnect(); keep.gaveUp = true; return; }
    let hit = 0;
    for (const m of records) {
      if (m.type === 'attributes') {
        const el = m.target;
        // The page swapped a hidden placeholder for a real (network, so blocked) image: that image is the page's now.
        if (el.localName === 'img' && m.attributeName === 'src' && el.getAttribute('src') !== OFF && !INLINE.test(el.getAttribute('src') || '')) el.removeAttribute('data-harplus-src');
        hit += hide(el);
        continue;
      }
      for (const n of m.addedNodes) if (n.nodeType === 1) for (const el of [n, ...n.querySelectorAll('*')]) hit += hide(el);
    }
    keep.observer.takeRecords(); // drop the records our own writes queued
    if (hit) { keep.count++; store.hidden += hit; }
  });
  for (const root of roots) keep.observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'style', 'class'] });
  return store.hidden;
}

/** Set dir="rtl" on <html> (on) or put the original dir back (off). */
function flipDir(on) {
  const root = document.documentElement;
  if (on) {
    window.__harplusKeep?.observer?.disconnect(); // an earlier view's keeper, if its restore failed
    window.__harplusDir = root.getAttribute('dir');
    root.setAttribute('dir', 'rtl');
    // Keeper: a page script that resets dir on <html> gets rtl back — up to 200 times, so a page that fights back cannot livelock the tab.
    const keep = (window.__harplusKeep = { count: 0 });
    keep.observer = new MutationObserver(() => {
      if (keep.count >= 200) { keep.observer.disconnect(); keep.gaveUp = true; return; }
      const html = document.documentElement;
      if (html.getAttribute('dir') !== 'rtl') { html.setAttribute('dir', 'rtl'); keep.count++; }
    });
    keep.observer.observe(root, { attributes: true, attributeFilter: ['dir'] });
  } else {
    window.__harplusKeep?.observer?.disconnect();
    delete window.__harplusKeep;
    if (!('__harplusDir' in window)) return true;
    const d = window.__harplusDir;
    if (d == null) root.removeAttribute('dir'); else root.setAttribute('dir', d);
    delete window.__harplusDir;
  }
  return true;
}

/** Mark one visible sample per focusable kind with data-harplus-focus; count :focus rules that kill the outline. */
function focusSamples() {
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible'
    && !el.closest('[aria-hidden="true"], [hidden]') && !el.matches(':disabled');
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      let p = n.localName;
      if (n.id) { parts.unshift(`${p}#${n.id}`); break; }
      if (n.classList.length) p += `.${[...n.classList].slice(0, 2).join('.')}`;
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const first = (sel, extra = () => true) => [...document.querySelectorAll(sel)].find((el) => !el.hasAttribute('data-harplus-focus') && shown(el) && extra(el));
  const kinds = [
    ['inline-link', () => first('p a[href], li a[href]', (a) => !a.closest('nav')
      && (a.parentElement.textContent || '').trim().length > (a.textContent || '').trim().length)],
    ['nav-link', () => first('nav a[href]')],
    ['button', () => first('button, [role="button"]')],
    ['text-input', () => first('input[type="text" i], input[type="email" i], input[type="search" i], input[type="tel" i], input[type="url" i], input[type="password" i], input:not([type]), textarea')],
    ['select', () => first('select')],
    ['checkbox', () => first('input[type="checkbox" i], input[type="radio" i]')],
    ['summary', () => first('summary')],
    ['custom', () => first('[tabindex="0"][role]', (el) => !el.matches('a, button, input, select, textarea, summary'))],
  ];
  const samples = [];
  for (const [kind, pick] of kinds) {
    const el = pick();
    if (!el || el.hasAttribute('data-harplus-focus')) continue;
    el.setAttribute('data-harplus-focus', kind);
    samples.push({ kind, selector: path(el) });
  }
  // Freeze transitions/animations on the samples so the forced-state read sees final values, not a frame mid-transition.
  // An inline !important style via CSSOM (page CSP can't block it); focusUnmark restores the original the same way.
  for (const el of document.querySelectorAll('[data-harplus-focus]')) {
    if (el.hasAttribute('data-harplus-focus-style')) continue;
    el.setAttribute('data-harplus-focus-style', JSON.stringify(el.hasAttribute('style') ? el.style.cssText : null));
    el.style.setProperty('transition', 'none', 'important');
    el.style.setProperty('animation', 'none', 'important');
  }
  let outlineNone = 0;
  const walk = (rules, depth) => {
    for (const r of rules || []) {
      const sel = r.selectorText || '';
      // `:not(:focus-visible)` rules are the recommended pattern; `:focus-within` alone is not an own-focus rule.
      if (sel && !/:not\(\s*:focus-visible\s*\)/.test(sel) && /:focus(?!-within)/.test(sel)) {
        const s = r.style;
        const killed = /^(none|0(px)?)$/.test((s.outlineStyle || '').trim()) || s.outlineWidth === '0px' || /^(none|0)\b/.test((s.outline || '').trim());
        // A real replacement: a value that is set and is not none/0/transparent/initial (shorthand wins over its longhands).
        const real = (v) => { const t = (v || '').trim().toLowerCase(); return t && !/^(none|0|0px|transparent|initial|inherit|unset)(\s+(none|0|0px|initial))*$/.test(t); };
        const replaced = real(s.boxShadow) || (s.border ? real(s.border) : real(s.borderColor) || real(s.borderWidth))
          || (s.background ? real(s.background) : real(s.backgroundColor)) || real(s.textDecoration) || real(s.textDecorationLine);
        if (killed && !replaced) outlineNone++;
      }
      if (r.cssRules && depth < 4) walk(r.cssRules, depth + 1);
    }
  };
  for (const sh of document.styleSheets) { try { walk(sh.cssRules, 0); } catch { /* cross-origin sheet */ } }
  return { samples, outlineNone };
}

/** Computed focus-relevant styles of each marked sample, keyed by kind. */
function focusStyles() {
  const out = {};
  for (const el of document.querySelectorAll('[data-harplus-focus]')) {
    const cs = getComputedStyle(el);
    out[el.getAttribute('data-harplus-focus')] = {
      outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow,
      borderColor: cs.borderColor, borderWidth: cs.borderWidth, backgroundColor: cs.backgroundColor,
      textDecorationLine: cs.textDecorationLine, color: cs.color,
    };
  }
  return out;
}

/** Undo focusSamples: restore each sample's style attribute and drop the marks. Safe to repeat. */
function focusUnmark() {
  for (const el of document.querySelectorAll('[data-harplus-focus-style]')) {
    let style = null;
    try { style = JSON.parse(el.getAttribute('data-harplus-focus-style')); } catch { /* malformed: drop the inline style */ }
    if (style == null) el.removeAttribute('style'); else el.style.cssText = style;
    el.removeAttribute('data-harplus-focus-style');
  }
  for (const el of document.querySelectorAll('[data-harplus-focus]')) el.removeAttribute('data-harplus-focus');
}

/** The page's own colour-scheme and print/media-feature styles (readable stylesheets only). */
function prefsProbe() {
  const meta = document.querySelector('meta[name="color-scheme" i]')?.getAttribute('content') || '';
  const colorScheme = `${meta} ${getComputedStyle(document.documentElement).colorScheme || ''}`.trim();
  const mediaFeatures = {};
  let mediaPrint = !!document.querySelector('link[media*="print" i], style[media*="print" i]');
  const walk = (rules, depth) => {
    for (const r of rules || []) {
      const text = r.conditionText || r.media?.mediaText || '';
      if (text) {
        if (/\bprint\b/i.test(text)) mediaPrint = true;
        for (const m of text.matchAll(/\(\s*(?:not\s+)?([a-z-]+)\s*[:)]/gi)) {
          const k = m[1].toLowerCase();
          mediaFeatures[k] = (mediaFeatures[k] || 0) + 1;
        }
      }
      if (r.cssRules && depth < 4) walk(r.cssRules, depth + 1);
    }
  };
  let unreadableSheets = 0;
  for (const s of document.styleSheets) { try { walk(s.cssRules, 0); } catch { unreadableSheets++; /* cross-origin sheet */ } }
  return { colorScheme, mediaPrint, mediaFeatures, unreadableSheets };
}

/** The browser's real default font sizes (px), read from `font: medium`, so they can be restored exactly. */
function defaultFontSizes() {
  const probe = (family) => {
    const s = document.createElement('span');
    s.style.cssText = `font: medium ${family}; position: absolute; visibility: hidden`;
    (document.body || document.documentElement).append(s);
    const px = parseFloat(getComputedStyle(s).fontSize);
    s.remove();
    return px;
  };
  // No fallback: guessed sizes would overwrite the user's real settings on restore. The caller checks these.
  return { standard: probe('sans-serif'), fixed: probe('monospace') };
}

/** What a restored tab should look like, for the reading's diagnostics. */
function restoreProbe() {
  return {
    print: matchMedia('print').matches,
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    spacing: !!window.__harplusSpacing,
    width: innerWidth,
    rootFont: getComputedStyle(document.documentElement).fontSize,
  };
}

/**
 * Apply the WCAG 1.4.12 text-spacing stylesheet (css given) or remove it (css null). A constructed sheet, not a <style>:
 * a strict style-src CSP blocks an injected <style> but not document.adoptedStyleSheets. window.__harplusSpacing is that sheet.
 */
function textSpacing(css) {
  const old = window.__harplusSpacing;
  if (old) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== old);
    delete window.__harplusSpacing;
  }
  if (css == null) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  window.__harplusSpacing = sheet;
}

/**
 * Is the view's change in effect right now? Runs in the page just before the shot.
 * evaluate() passes one argument, so [kind, arg] is accepted as well as (kind, arg).
 */
export function viewProbe(kind, arg) {
  if (Array.isArray(kind)) [kind, arg] = kind;
  const k = window.__harplusKeep;
  const kept = k?.count ? ` (re-applied ${k.count} times)` : '';
  const gaveUp = k?.gaveUp ? ` (the page fought back; stopped after ${k.count} re-applications)` : '';
  if (kind === 'nocss') {
    const live = [...document.styleSheets].filter((s) => !s.disabled).length + (document.adoptedStyleSheets?.length || 0);
    const styled = document.querySelectorAll('[style]').length;
    return live || styled ? { ok: false, detail: `${live} style sheets and ${styled} style attributes still active${gaveUp}` } : { ok: true, detail: `all styles off${kept}` };
  }
  if (kind === 'rtl') {
    const ok = document.documentElement.getAttribute('dir') === 'rtl' && getComputedStyle(document.body || document.documentElement).direction === 'rtl';
    return ok ? { ok: true, detail: `right-to-left${kept}` } : { ok: false, detail: `the page removed the RTL direction${gaveUp}` };
  }
  if (kind === 'translated') {
    const t = window.__harplusTranslateKeep;
    const tKept = t?.count ? ` (re-applied ${t.count} times)` : '';
    const tGaveUp = t?.gaveUp ? ` (the page fought back; stopped after ${t.count} re-applications)` : '';
    const capped = t?.capped ? ` (page too long: only the first ${t.cap.toLocaleString('en')} text blocks were translated)` : '';
    // The Arabic view (arg 'ar') is right-to-left as well: the page may have reset dir.
    if (arg === 'ar' && document.documentElement.getAttribute('dir') !== 'rtl') return { ok: false, detail: `the page removed the RTL direction${gaveUp}` };
    const saved = (window.__harplusTranslated || []).filter(([n]) => n.isConnected);
    const live = saved.filter(([n, , tr]) => n.textContent === tr).length;
    const share = saved.length ? live / saved.length : 1;
    if (share >= 0.9) return { ok: true, detail: `${Math.round(share * 100)}% of text translated${tKept}${capped}` };
    // Not shown translated: text the translator never translated (out of time, or errors), or text the page put back.
    const why = { budget: 0, error: 0 };
    for (const [n, , tr] of saved) if (tr == null) { const m = t?.untranslated?.get(n); if (m in why) why[m]++; }
    const pct = (k) => Math.round((k / saved.length) * 100);
    const restored = saved.length - live - why.budget - why.error;
    const top = Math.max(why.budget, why.error, restored);
    const detail = top === why.budget ? `${pct(why.budget)}% not translated in time`
      : top === why.error ? `${pct(why.error)}% could not be translated`
      : `the page restored ${pct(restored)}% of the text${tGaveUp}`;
    return { ok: false, detail: `${detail}${capped}` };
  }
  if (kind === 'pseudo') {
    // Only text still in the page counts: nodes the page re-rendered away are neither shown nor restored.
    const saved = (window.__harplusPseudo || []).filter(([n]) => n.isConnected);
    const live = saved.filter(([n, orig]) => n.textContent !== orig).length;
    const share = saved.length ? live / saved.length : 1;
    return share >= 0.9 ? { ok: true, detail: `${Math.round(share * 100)}% of text pseudo-localised${kept}` } : { ok: false, detail: `the page restored ${Math.round((1 - share) * 100)}% of the text${gaveUp}` };
  }
  if (kind === 'media') return matchMedia(arg).matches ? { ok: true, detail: `${arg} active` } : { ok: false, detail: `${arg} not active in the page` };
  if (kind === 'spacing') {
    const ok = !!window.__harplusSpacing && getComputedStyle(document.body || document.documentElement).letterSpacing !== 'normal';
    return ok ? { ok: true, detail: 'text spacing applied' } : { ok: false, detail: 'text spacing not applied' };
  }
  if (kind === 'width') return Math.abs(innerWidth - arg) <= 1 ? { ok: true, detail: `${innerWidth} px wide` } : { ok: false, detail: `viewport is ${innerWidth} px, expected ${arg}` };
  // Device emulation sets the screen; the layout width is the page's own business (no viewport meta → 980 px).
  if (kind === 'device') {
    const lays = innerWidth !== screen.width ? ` (page lays out at ${innerWidth} px)` : '';
    return screen.width === arg ? { ok: true, detail: `${screen.width} px screen${lays}` } : { ok: false, detail: `screen is ${screen.width} px, expected ${arg}` };
  }
  // The browser's default text size (arg: its minimum in px). Media-query ems use that default, whatever the page sets on <html>.
  if (kind === 'fontSetting') {
    const ok = matchMedia(`(max-width: ${innerWidth / arg}em)`).matches;
    const root = `(page root font ${parseFloat(getComputedStyle(document.documentElement).fontSize)} px)`;
    return ok ? { ok: true, detail: `browser text size at least ${arg} px ${root}` } : { ok: false, detail: `browser text size below ${arg} px ${root}` };
  }
  return { ok: true, detail: 'not measured' };
}

/** Pseudo-localize visible text — accented and ~40% longer (on) — or restore every original (off). */
function pseudoText(on) {
  if (!on) {
    window.__harplusKeep?.observer?.disconnect();
    delete window.__harplusKeep;
    for (const [node, text] of window.__harplusPseudo || []) node.textContent = text;
    delete window.__harplusPseudo;
    return true;
  }
  window.__harplusKeep?.observer?.disconnect(); // an earlier view's keeper, if its restore failed
  const MAP = {
    a: 'á', b: 'ƀ', c: 'ć', d: 'đ', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ĺ', m: 'ḿ', n: 'ń', o: 'ó', p: 'ṕ',
    r: 'ŕ', s: 'ś', t: 'ţ', u: 'ú', w: 'ẃ', y: 'ý', z: 'ź', A: 'Á', C: 'Ć', E: 'É', I: 'Í', N: 'Ń', O: 'Ó', S: 'Ś', U: 'Ú', Y: 'Ý', Z: 'Ź',
  };
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|SVG)$/i;
  const keep = (n) => {
    if (!n.textContent.trim()) return false;
    for (let el = n.parentElement; el; el = el.parentElement) {
      if (SKIP.test(el.tagName) || el.getAttribute('translate') === 'no') return false;
    }
    return true;
  };
  const pseudo = (text) => {
    const core = text.trim();
    const dots = Math.ceil(core.length * 0.4);
    const pad = core.length >= 3 ? ' ' + Array.from({ length: Math.ceil(dots / 5) }, (_, k) => '·'.repeat(Math.min(5, dots - k * 5))).join(' ') : '';
    return text.replace(/[A-Za-z]/g, (ch) => MAP[ch] || ch).replace(/\s*$/, (ws) => pad + ws);
  };
  const top = document.body || document.documentElement;
  const nodes = [];
  const walker = document.createTreeWalker(top, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && nodes.length < 5000; n = walker.nextNode()) if (keep(n)) nodes.push(n);
  const saved = (window.__harplusPseudo = []);
  const entries = new Map(); // node → its [node, original] entry in saved
  const written = new Map(); // node → the pseudo text we wrote
  // Text pseudo-localisation leaves unchanged (digits, symbols) is not saved: it has nothing to restore.
  const apply = (n) => {
    const text = n.textContent;
    const fake = pseudo(text);
    if (fake === text) return false;
    let entry = entries.get(n);
    if (!entry) { entry = [n, text]; saved.push(entry); entries.set(n, entry); }
    entry[1] = text; // the page's latest text is what pseudoText(false) puts back
    n.textContent = fake;
    written.set(n, fake);
    return true;
  };
  for (const n of nodes) apply(n);
  // Keeper: text the page writes or adds afterwards is pseudo-localised too — up to 200 times, so a page that fights back cannot livelock the tab.
  const keepState = (window.__harplusKeep = { count: 0 });
  const redo = (n) => {
    if (n.nodeType !== 3 || n.textContent === written.get(n)) return false;
    // A saved node the page rewrote: whatever happens next, pseudoText(false) must put back this latest text.
    const entry = entries.get(n);
    if (entry) entry[1] = n.textContent;
    else if (saved.length >= 20000) return false;
    return keep(n) && apply(n);
  };
  keepState.observer = new MutationObserver((records) => {
    if (keepState.count >= 200) { keepState.observer.disconnect(); keepState.gaveUp = true; return; }
    // A `writing` flag cannot work here (records arrive after the write), so drop the records our own writes queue instead.
    let hit = false;
    for (const m of records) {
      if (m.type === 'characterData') { hit = redo(m.target) || hit; continue; }
      for (const n of m.addedNodes) {
        if (n.nodeType === 3) { hit = redo(n) || hit; continue; }
        if (n.nodeType !== 1) continue;
        const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
        for (let t = w.nextNode(); t; t = w.nextNode()) hit = redo(t) || hit;
      }
    }
    keepState.observer.takeRecords();
    if (hit) keepState.count++;
  });
  keepState.observer.observe(top, { subtree: true, childList: true, characterData: true });
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
    // Throttled, ordinary resources after load can take well over 5 s: don't mistake them for long-polls.
    if (THROTTLE[opts.throttle]) this.recorder.longMs = 30_000;
    this.bodyJobs = [];
    this.warnings = [];
    this.console = { entries: [], dropped: 0 };
    this.mainContexts = new Set();
    this.loaded = false;
    this.loadedAt = null;
    this.blockingImages = false;
    this.fetchSessions = new Set();
    this.frameEmulations = new Map(); // method → params, active on the page and every frame
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
    await this.send('Runtime.enable').catch(() => {});
    await this.send('Log.enable').catch(() => {});
    await this.send('Audits.enable').catch(() => {});
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
    if (method === 'Fetch.requestPaused') {
      // The no-images view: fail image and media requests (and pictures or streams fetched by script) so the page loads as with images off.
      // A script fetch pauses at its response (responseStatusCode set): its Content-Type decides. Redirects carry no content type and continue.
      const atResponse = params.responseStatusCode != null || params.responseErrorReason != null;
      const contentType = atResponse ? (params.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '' : undefined;
      const fail = this.blockingImages && blockedByImagesOff(params.request?.url, params.resourceType, contentType);
      this.send(fail ? 'Fetch.failRequest' : 'Fetch.continueRequest', fail ? { requestId: params.requestId, errorReason: 'BlockedByClient' } : { requestId: params.requestId }, sid).catch(() => {});
      return;
    }
    if (method === 'Target.attachedToTarget') { this.onChild(params, sid); return; }
    if (method === 'Target.detachedFromTarget') { this.recorder.dropSession(params.sessionId); this.recorder.targets.delete(params.sessionId); this.fetchSessions.delete(params.sessionId); return; }
    if (method === 'Page.javascriptDialogOpening') {
      // alert()/confirm()/beforeunload block the page (and our evaluate calls) — dismiss and note it.
      this.warnings.push(`dismissed a ${params.type} dialog: ${String(params.message || '').slice(0, 80)}`);
      this.send('Page.handleJavaScriptDialog', { accept: true }, sid).catch(() => {});
      return;
    }
    if (!sid && method === 'Runtime.executionContextCreated') {
      // Default contexts are the page's main worlds; other extensions' content scripts run in isolated ones.
      if (params.context?.auxData?.isDefault === true) this.mainContexts.add(params.context.id);
    }
    if (!sid && method === 'Runtime.executionContextsCleared') this.mainContexts.clear();
    if (!sid && !this.viewsRunning && this.fromMainWorld(method, params)) {
      const entry = consoleEntryFrom(method, params);
      if (entry) addConsoleEntry(this.console, entry);
    }
    const rec = this.recorder.handle(method, params, sid);
    if (method === 'Network.loadingFinished' && rec && !this.viewsRunning && this.recorder.wantsBody(rec)) this.bodyJobs.push(this.fetchBody(rec, sid));
    if (!sid && method === 'Page.frameStartedLoading' && params.frameId === this.mainFrameId) {
      this.loaded = false;
      // Enabling Runtime/Log/Audits replays the old document's messages; in reload mode only the new load counts.
      if (this.opts.mode === 'reload' && !this.viewsRunning) this.console = { entries: [], dropped: 0 };
    }
    if (!sid && method === 'Page.loadEventFired') {
      this.loaded = true;
      this.loadedAt = Date.now();
      this.recorder.loadedAt = this.loadedAt;
      const page = this.recorder.currentPage();
      // Only keep the title if the page hasn't navigated on before the evaluate ran.
      this.titleJob = withTimeout(this.evaluate(() => ({ t: document.title, u: location.href }), null, 'main'), 3000, 'title')
        .then(({ t, u }) => { if (page && u === page.url) this.recorder.setPageTitle(t, page.id); }).catch(() => {});
    }
  }

  /** Runtime messages count only from a default (main-world) context; before any context is seen, record everything. */
  fromMainWorld(method, params) {
    if (!this.mainContexts.size) return true;
    if (method === 'Runtime.exceptionThrown') return this.mainContexts.has(params.exceptionDetails?.executionContextId);
    if (method === 'Runtime.consoleAPICalled') return this.mainContexts.has(params.executionContextId);
    return true;
  }

  async onChild({ sessionId, targetInfo, waitingForDebugger }, parentSid) {
    this.recorder.targets.set(sessionId, targetInfo.type);
    try {
      if (this.blockingImages) {
        // First, so a failure further down cannot leave this child unblocked.
        await this.send('Fetch.enable', { patterns: IMAGES_OFF_PATTERNS }, sessionId).then(() => this.fetchSessions.add(sessionId)).catch(() => {});
        await this.send('Network.setBypassServiceWorker', { bypass: true }, sessionId).catch(() => {});
        // Blocking ended while this was in flight: undo both.
        if (!this.blockingImages) {
          this.fetchSessions.delete(sessionId);
          await this.send('Fetch.disable', {}, sessionId).catch(() => {});
          await this.send('Network.setBypassServiceWorker', { bypass: false }, sessionId).catch(() => {});
        }
      }
      if (targetInfo.type === 'iframe' || targetInfo.type === 'worker') {
        await this.send('Network.enable', NET_ENABLE, sessionId);
        await this.networkOverrides(sessionId);
        if (targetInfo.type === 'iframe') {
          await this.send('Page.enable', {}, sessionId).catch(() => {});
          // A frame that appears mid-view gets the view's emulation before it runs.
          for (const [method, params] of this.frameEmulations) await this.send(method, params, sessionId).catch(() => {});
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

  childSessionIds() {
    return [...this.recorder.targets.keys()];
  }

  /** Child sessions that render a frame (cross-origin iframes, nested ones included). */
  frameSessionIds() {
    return [...this.recorder.targets].filter(([, type]) => type === 'iframe').map(([sid]) => sid);
  }

  /**
   * Set an emulation on the page and every frame, and keep it for frames that attach later (onChild);
   * params null resets it everywhere. The page goes first and its failure throws; frames follow in parallel,
   * each bounded, so a slow ad frame cannot hold a restore past its deadline.
   */
  async emulateFrames(method, params) {
    if (params) this.frameEmulations.set(method, params); else this.frameEmulations.delete(method);
    const value = params || FRAME_EMULATION_RESET[method];
    await this.send(method, value);
    await Promise.allSettled(this.frameSessionIds().map((sid) => withTimeout(this.send(method, value, sid), 2000, 'frame emulation')));
  }

  /**
   * Block images and media (the no-images view): main session plus every child session. A service worker
   * is bypassed meanwhile, or it could answer image requests from its cache without passing the interception.
   */
  async blockImages(on) {
    if (on) {
      this.blockingImages = true;
      for (const sid of [undefined, ...this.childSessionIds()]) {
        await this.send('Fetch.enable', { patterns: IMAGES_OFF_PATTERNS }, sid).then(() => this.fetchSessions.add(sid ?? '')).catch(() => {});
        await this.send('Network.setBypassServiceWorker', { bypass: true }, sid).catch(() => {});
      }
    } else {
      this.blockingImages = false;
      for (const sid of this.fetchSessions) await this.send('Fetch.disable', {}, sid || undefined).catch(() => {});
      this.fetchSessions.clear();
      for (const sid of [undefined, ...this.childSessionIds()]) await this.send('Network.setBypassServiceWorker', { bypass: false }, sid).catch(() => {});
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

  /**
   * Run a self-contained function in the page. world: 'main' (page JS globals) or 'isolated' (DOM only).
   * userGesture: run it as if the user had clicked (APIs such as Translator.create need user activation).
   */
  async evaluate(fn, args, world = 'isolated', { userGesture = false } = {}) {
    const params = {
      expression: `(${fnSource(fn)})(${JSON.stringify(args ?? null)})`,
      returnByValue: true,
      awaitPromise: true,
    };
    if (userGesture) params.userGesture = true;
    if (world === 'isolated') params.contextId = await this.isolatedContext();
    const r = await this.send('Runtime.evaluate', params);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'page error').split('\n')[0]);
    return r.result.value;
  }

  /**
   * Run a self-contained function in the page's main world and in every cross-origin frame (each its own session).
   * Returns the page's value first; frames (in parallel, 2 s each) that fail or time out are left out. The page's own failure throws.
   */
  async evaluateFrames(fn, args, ms = 5000) {
    const out = [await withTimeout(this.evaluate(fn, args, 'main'), ms, 'page')];
    const expression = `(${fnSource(fn)})(${JSON.stringify(args ?? null)})`;
    const frames = await Promise.allSettled(this.frameSessionIds().map((sid) =>
      withTimeout(this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid), 2000, 'frame')));
    for (const f of frames) if (f.status === 'fulfilled' && !f.value.exceptionDetails) out.push(f.value.result.value);
    return out;
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
    this.loaded = false; this.loadedAt = null; this.recorder.loadedAt = null;
    this.report('loading', 'Reloading the page');
    await this.send('Page.reload', { ignoreCache: !!this.opts.bypassCache });
  }

  async waitForIdle({ idleMs = 1500, maxMs = 30_000, quiet: silent = false } = {}) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      await sleep(250);
      if (this.detached) throw new Error(`Debugger detached (${this.detached})`);
      if (!this.loaded) continue;
      // Sockets, streams, media and requests open > 5 s after load don't keep the page "busy".
      const quiet = Date.now() - this.recorder.lastBusyActivity;
      const inflight = this.recorder.busy(Date.now(), this.loadedAt);
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

  async reloadQuiet({ ignoreCache = false } = {}) {
    this.loaded = false; this.loadedAt = null; this.recorder.loadedAt = null;
    this.isolated = null;
    await this.send('Page.reload', { ignoreCache });
  }

  /** Decode a base64 screenshot and return imageStats (null if decoding isn't available or fails). */
  async decodeStats(data, mimeType) {
    try {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: mimeType || 'image/webp' }));
      const w = Math.min(bmp.width, 640), h = Math.max(1, Math.round((bmp.height * w) / bmp.width));
      const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0, w, h); bmp.close?.();
      return imageStats(g.getImageData(0, 0, w, h).data, w, h);
    } catch { return null; }
  }

  /**
   * Extra screenshots after the reading is built: other devices and no CSS (toggled in place),
   * then the reload-based views at the end: no images and no JavaScript (each blocks something, reloads, then a normal reload restores the tab).
   * Each view is isolated: a failure becomes a warning and a viewsSkipped entry. A view's run is
   * timed; its restore is separate and always runs. Results are committed only if the run finished in time.
   */
  async captureViews(reading) {
    const patch = { screenshots: [], capture: {}, warnings: [] };
    const w0 = this.warnings.length;
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
    const checks = {};
    const skipped = [];
    const measure = () => withTimeout(this.evaluate(measureView, null, 'main'), 5000, 'measure');
    // Collect a view's shots and measurements into locals; the caller commits them on success.
    const grab = async (id) => ({ id, shots: await this.shoot(id), measured: await measure() });
    const grabFold = async (id, measured) => ({ id, shots: await this.shoot(id, { fullPage: false }), measured: measured ? await measure() : null });
    const settled = (cap) => withTimeout(this.evaluate(settleRender, cap, 'main'), cap + 2000, 'settle').catch(() => {});
    // Is the view's change in effect? Probed just before the shot: a full-page grab can resize the page.
    const probe = (kind, arg) => withTimeout(this.evaluate(viewProbe, [kind, arg ?? null], 'main'), 3000, 'view check').catch(() => ({ ok: true, detail: 'not measured' }));
    // grab/grabFold, with the check taken first.
    const checked = async (check, shoot) => { const c = await check; return { ...(await shoot()), check: c }; };
    const viewTimings = [];
    const view = async (id, { runMs, restoreMs, run, restore }) => {
      if (want[id] === false || (VISION_VIEWS.includes(id) && want.vision === false)) { skipped.push({ view: id, reason: 'disabled' }); return; }
      if (this.detached) { skipped.push({ view: id, reason: `debugger detached (${this.detached})` }); return; }
      if (this.viewsAborted) { skipped.push({ view: id, reason: this.viewsAborted }); return; }
      const label = `${viewLabel(id)} view`;
      this.report('views', label);
      const t0 = Date.now();
      let ok = false;
      // Set once the run is given up and before the restore. A run calls live() after each await, so a late
      // finish stops instead of applying its remaining steps to the restored page.
      let cancelled = false;
      const live = () => { if (cancelled) throw new Error(`${label} cancelled`); };
      const p = run(live);
      try {
        const got = await withTimeout(p, runMs, label);
        patch.screenshots.push(...got.shots);
        if (got.measured) views[id] = got.measured;
        if (got.check) { checks[id] = got.check; if (got.check.ok === false) this.warnings.push(`${label}: may not reflect the setting — ${got.check.detail}`); }
        ok = true;
      } catch (e) {
        cancelled = true;
        skipped.push({ view: id, reason: e.message });
        if (/screenshot/.test(e.message) && /timed out/.test(e.message)) this.viewsAborted = 'tab hidden or not painting — screenshots timed out';
        this.warnings.push(`${label} failed: ${e.message}`);
        // Let the run reach its next live() check (bounded) so it does not overlap the restore.
        await withTimeout(p, 45_000, 'restore').catch(() => {});
      }
      cancelled = true;
      const runElapsed = Date.now() - t0;
      const r0 = Date.now();
      await withTimeout(restore(), restoreMs, `${label} restore`).catch((e) => this.warnings.push(`${label} restore failed: ${e.message}`));
      viewTimings.push({ view: id, runMs: runElapsed, restoreMs: Date.now() - r0, ok });
    };

    await measure().then((m) => { views[base] = m; }).catch((e) => this.warnings.push(`measuring the page failed: ${e.message}`));
    await withTimeout(this.evaluate(freezeMedia, true, 'main'), 3000, 'freeze media').catch(() => {});
    for (const id of DEVICE_VIEWS) {
      if (id === base) continue;
      await view(id, {
        runMs: 30_000,
        restoreMs: 20_000,
        run: async () => {
          await this.applyDevice(id);
          await settled(1500);
          await this.settle(4000);
          return checked(probe('device', VIEW_DEVICES[id].width), () => grab(id));
        },
        restore: () => this.applyDevice(base),
      });
    }
    await view('nocss', {
      runMs: 30_000,
      restoreMs: 20_000,
      run: async () => {
        await this.evaluate(stripStyles, true, 'main');
        await settled(1000);
        return checked(probe('nocss'), () => grab('nocss'));
      },
      restore: () => this.evaluate(stripStyles, false, 'main'),
    });
    // Turning the styles off cancelled the frozen CSS animations and the restore started new ones: freeze those too
    // (the restore's transitions, from unstyled to styled values, are finished rather than held at their start).
    await withTimeout(this.evaluate(freezeMedia, true, 'main'), 3000, 'freeze media').catch(() => {});
    await view('rtl', {
      runMs: 30_000,
      restoreMs: 20_000,
      run: async () => {
        await this.evaluate(flipDir, true, 'main');
        await settled(1000);
        return checked(probe('rtl'), () => grab('rtl'));
      },
      restore: () => this.evaluate(flipDir, false, 'main'),
    });
    await this.translatedViews(view, { want, skipped, checks, patch, settled, probe, checked, grab });
    // Long text stands in only when a translated view failed (or runs as itself when pseudo is switched off: view() records that).
    if (want.pseudo === false || needsFallback(patch.capture.translation, want)) {
      await view('pseudo', {
        runMs: 30_000,
        restoreMs: 20_000,
        run: async () => {
          await this.evaluate(pseudoText, true, 'main');
          await settled(1000);
          return checked(probe('pseudo'), () => grab('pseudo'));
        },
        restore: () => this.evaluate(pseudoText, false, 'main'),
      });
    } else skipped.push({ view: 'pseudo', reason: 'not needed' });
    const a11yWanted = [...VISION_VIEWS, ...DISPLAY_VIEWS, 'spacing', 'reflow', 'text200'].some((id) => want[id] !== false);
    if (a11yWanted) {
      patch.capture.prefs = await withTimeout(this.evaluate(prefsProbe, null, 'main'), 5000, 'prefs probe')
        .catch((e) => { this.warnings.push(`preferences probe failed: ${e.message}`); return undefined; });
    }
    // A reference shot of the frozen page: the vision checks compare against it, not the (moving) base shot.
    let refStats = null;
    const visionWanted = want.vision !== false && VISION_VIEWS.some((id) => want[id] !== false);
    if (visionWanted) {
      const ref = await withTimeout(this.send('Page.captureScreenshot', { format: 'webp', quality: 80 }), 20_000, 'reference shot').catch(() => null);
      refStats = ref ? await this.decodeStats(ref.data, 'image/webp') : null;
    }
    // Two committed frames after the filter changes (a 200 ms cap covers hidden tabs where rAF doesn't fire).
    const frames = () => withTimeout(this.evaluate(() => new Promise((r) => { let n = 0; const t = () => (++n >= 2 ? r(true) : requestAnimationFrame(t)); requestAnimationFrame(t); setTimeout(() => r(true), 200); }), null, 'main'), 2000, 'frames').catch(() => {});
    for (const id of VISION_VIEWS) {
      await view(id, {
        runMs: 30_000,
        restoreMs: 10_000,
        run: async () => {
          await this.emulateFrames('Emulation.setEmulatedVisionDeficiency', { type: VISION_DEFICIENCY[id] });
          await settled(500);
          await frames();
          // Unclipped: through chrome.debugger a clipped capture skips the vision-deficiency filter.
          const got = await grabFold(id, false);
          const shot = got.shots.find((s) => s.kind === 'viewport');
          const stats = shot ? await this.decodeStats(shot.data, shot.mimeType) : null;
          return { ...got, check: visionCheck(id, stats, refStats) };
        },
        restore: () => this.emulateFrames('Emulation.setEmulatedVisionDeficiency', null),
      });
    }
    for (const id of DISPLAY_VIEWS) {
      await view(id, {
        runMs: 30_000,
        restoreMs: 10_000,
        run: async () => {
          await this.emulateFrames('Emulation.setEmulatedMedia', MEDIA_EMULATION[id]);
          await settled(1000);
          return checked(probe('media', MEDIA_QUERY[id]), () => grabFold(id, true));
        },
        restore: () => this.emulateFrames('Emulation.setEmulatedMedia', null),
      });
    }
    await view('spacing', {
      runMs: 30_000,
      restoreMs: 10_000,
      run: async () => {
        await this.evaluate(textSpacing, SPACING_CSS, 'main');
        await settled(1000);
        return checked(probe('spacing'), () => grabFold('spacing', true));
      },
      restore: () => this.evaluate(textSpacing, null, 'main'),
    });
    await view('reflow', {
      runMs: 30_000,
      restoreMs: 10_000,
      run: async () => {
        await this.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
        await withTimeout(this.evaluate(settleLayout, 3000, 'main'), 5000, 'settle').catch(() => {});
        return checked(probe('width', 320), () => grabFold('reflow', true));
      },
      restore: () => this.applyDevice(base),
    });
    // The user's real defaults, restored afterwards (the setting is browser-wide state we must not clobber).
    // Without them the view is skipped: restoring guessed sizes would clobber the user's settings.
    const fonts = want.text200 === false || this.detached ? null
      : await withTimeout(this.evaluate(defaultFontSizes, null, 'main'), 3000, 'font sizes').catch(() => null);
    const usable = !!fonts && [fonts.standard, fonts.fixed].every((v) => Number.isFinite(v) && v > 0);
    if (usable) this.fontDefaults = { standard: fonts.standard, fixed: fonts.fixed };
    if (usable || want.text200 === false || this.detached || this.viewsAborted) {
      await view('text200', {
        runMs: 30_000,
        restoreMs: 10_000,
        run: async () => {
          this.fontsChanged = true;
          await this.send('Page.setFontSizes', { fontSizes: { standard: this.fontDefaults.standard * 2, fixed: this.fontDefaults.fixed * 2 } });
          await withTimeout(this.evaluate(settleLayout, 3000, 'main'), 5000, 'settle').catch(() => {});
          return checked(probe('fontSetting', this.fontDefaults.standard * 1.8), () => grabFold('text200', true));
        },
        restore: async () => {
          await this.send('Page.setFontSizes', { fontSizes: this.fontDefaults });
          this.fontsChanged = false;
        },
      });
    } else {
      skipped.push({ view: 'text200', reason: 'could not read default font sizes' });
    }
    if (a11yWanted) await this.resetA11y(base);
    if (want.breakpoints === false) {
      skipped.push({ view: 'breakpoints', reason: 'disabled' });
    } else {
      const css = hp.plugins?.css;
      const bps = css?.status === 'ok' ? pickBreakpoints(css.data?.media || []) : [];
      if (!bps.length) skipped.push({ view: 'breakpoints', reason: css?.status === 'ok' ? 'no px breakpoints' : 'css plugin not ok' });
      else {
        patch.capture.breakpoints = bps;
        const height = base !== 'desktop' && VIEW_DEVICES[base]
          ? VIEW_DEVICES[base].height
          : await withTimeout(this.evaluate(() => innerHeight, null, 'main'), 3000, 'viewport height').catch(() => 800);
        for (const b of bps) {
          for (const [id, width] of [[`bp${b}-below`, b - 1], [`bp${b}-at`, b]]) {
            await view(id, {
              runMs: 30_000,
              restoreMs: 10_000,
              run: async () => {
                await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
                await settled(1000);
                return checked(probe('width', width), () => grabFold(id, true));
              },
              restore: () => this.applyDevice(base),
            });
          }
        }
      }
    }
    await withTimeout(this.evaluate(freezeMedia, false, 'main'), 3000, 'unfreeze media').catch(() => {});
    if (want.noimages !== false && this.opts.mode !== 'reload') {
      skipped.push({ view: 'noimages', reason: 'not in reload mode' });
    } else {
      await view('noimages', {
        runMs: 60_000,
        restoreMs: 30_000,
        // live() before every step after an await: a run that outlives its timeout must not touch the restored page.
        run: async (live) => {
          await this.blockImages(true);
          live();
          // Skip the cache so memory-cached images cannot bypass the request blocking.
          await this.reloadQuiet({ ignoreCache: true });
          live();
          await this.settle(15_000);
          live();
          if (!this.loaded) throw new Error('page did not finish loading without images');
          // data: and blob: images never reach the network: hide them in the page and in every frame.
          const hidden = await this.evaluateFrames(hideInlineImages, true).then((n) => n.reduce((a, b) => a + (b || 0), 0)).catch(() => null);
          live();
          if (hidden) { await settled(500); live(); }
          await withTimeout(this.evaluate(freezeMedia, true, 'main'), 3000, 'freeze media').catch(() => {});
          live();
          const shots = await this.shoot('noimages');
          live();
          const got = { id: 'noimages', shots, measured: await measure() };
          live();
          // Cross-origin frames (an embedded video player) are their own sessions: probe each and add them up.
          const perFrame = await this.evaluateFrames(imagesProbe, null).catch(() => null);
          live();
          const p = perFrame && {
            imgPainted: 0, bgPainted: 0, mediaPlaying: 0, framesProbed: perFrame.length, inlineHidden: hidden ?? 0,
          };
          for (const f of perFrame || []) for (const k of ['imgPainted', 'bgPainted', 'mediaPlaying']) p[k] += f?.[k] || 0;
          if (perFrame?.some((f) => f?.inlineGaveUp)) p.inlineGaveUp = true;
          const left = p ? [p.imgPainted && `${p.imgPainted} images still painted`, p.bgPainted && `${p.bgPainted} image files loaded`, p.mediaPlaying && `${p.mediaPlaying} videos playing`].filter(Boolean) : ['not measured'];
          const note = (hidden ? ` (${hidden} inline images and backgrounds hidden)` : '') + (p?.inlineGaveUp ? ' (the page fought back; stopped after 200 re-applications)' : '');
          return { ...got, measured: got.measured && p ? { ...got.measured, ...p } : got.measured, check: { ok: !!p && left.length === 0, detail: p ? `${left.join(', ') || 'no images, backgrounds or video'}${note}` : 'not measured' } };
        },
        restore: async () => {
          await this.blockImages(false);
          await this.reloadQuiet().catch(() => {});
          await this.settle(15_000);
        },
      });
    }
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
          return { ...(await grab('nojs')), check: { ok: true, detail: 'scripts disabled by the browser' } };
        },
        restore: async () => {
          await this.send('Emulation.setScriptExecutionDisabled', { value: false }).catch(() => {});
          await this.reloadQuiet().catch(() => {});
          await this.settle(15_000);
        },
      });
    }
    if (!this.detached) patch.capture.restoreCheck = await withTimeout(this.evaluate(restoreProbe, null, 'main'), 3000, 'restore check').catch(() => undefined);
    patch.capture.views = views;
    patch.capture.viewChecks = checks;
    patch.capture.viewsMs = Date.now() - t0;
    patch.capture.viewTimings = viewTimings;
    if (skipped.length) patch.capture.viewsSkipped = skipped;
    patch.warnings = this.warnings.slice(w0);
    patch.timing = { viewsMs: patch.capture.viewsMs };
    patch.finishedAt = new Date().toISOString();
    return patch;
  }

  /**
   * German, Arabic and Japanese, translated in the page by Chrome's on-device Translator. Each outcome is recorded in
   * patch.capture.translation[id]; an error that would fail every language (no translator, blocked by the site,
   * model not loading) fails the remaining views with the same reason instead of trying each. The three share one
   * time budget (TRANSLATED_BUDGET_MS); once it is spent the rest fail "out of time", which brings in the fallback.
   */
  async translatedViews(view, { want, skipped, checks, patch, settled, probe, checked, grab }) {
    const started = Date.now();
    const translation = (patch.capture.translation = {});
    let htmlLang = null;
    if (TRANSLATED_VIEWS.some(({ id }) => want[id] !== false)) {
      htmlLang = await withTimeout(this.evaluate(() => document.documentElement.getAttribute('lang'), null, 'main'), 3000, 'page language').catch(() => null);
    }
    const source = primary(htmlLang) || 'en';
    let bail = null;
    for (const { id, lang, label } of TRANSLATED_VIEWS) {
      if (want[id] === false) {
        translation[id] = { status: 'skipped', reason: 'turned off' };
        await view(id, {}); // records the skip in viewsSkipped
        continue;
      }
      if (sameAsPage(lang, source)) {
        const reason = `page is already in ${label}`;
        translation[id] = { status: 'skipped', reason };
        skipped.push({ view: id, reason });
        continue;
      }
      const budget = bail ? null : viewBudget(TRANSLATED_BUDGET_MS - (Date.now() - started));
      if (!bail && !budget) bail = 'out of time for translated views';
      if (bail) {
        translation[id] = { status: 'failed', reason: bail };
        skipped.push({ view: id, reason: bail });
        continue;
      }
      const rtl = lang === 'ar';
      let leftovers = null;
      const before = skipped.length;
      const { runMs, timeoutMs, budgetMs, totalMs } = budget;
      await view(id, {
        runMs,
        restoreMs: 20_000,
        run: async (live) => {
          // Arabic is right-to-left: the rtl view's direction logic (and its keeper) goes on first.
          if (rtl) { await this.evaluate(flipDir, true, 'main'); live(); }
          // create() may download the model (about 80 MB, first time only); the report cannot tell, so it says "may".
          this.report('views', `${label} view — may download the translation model (first time only)`);
          await this.evaluate(translatePage, { source, target: lang, timeoutMs, budgetMs, totalMs }, 'main', { userGesture: true });
          live();
          this.report('views', `${label} view`);
          await settled(1000);
          live();
          const got = await checked(probe('translated', lang), () => grab(id));
          live();
          leftovers = await withTimeout(this.evaluate(leftoverText, null, 'main'), 5000, 'leftovers').catch(() => null);
          return got;
        },
        restore: async () => {
          try {
            await this.evaluate(restoreTranslation, null, 'main');
          } finally {
            if (rtl) await this.evaluate(flipDir, false, 'main');
          }
        },
      });
      const failedRun = skipped.slice(before).find((s) => s.view === id);
      if (failedRun) {
        const { reason, scope } = classifyError(failedRun.reason);
        translation[id] = { status: 'failed', reason };
        if (scope === 'all') bail = reason;
      } else if (checks[id]?.ok === false) {
        translation[id] = { status: 'failed', reason: checks[id].detail };
      } else if (checks[id]) {
        translation[id] = { status: 'ok', ...(leftovers ? { leftovers } : {}) };
      }
    }
  }

  /** Force :focus/:focus-visible on one sample per kind via CDP (no focus events, no page scripts) and diff styles.
   *  Every CDP call has its own short timeout; `state.aborted` stops a late finish from writing the result. */
  async focusProbe(hp, state = {}) {
    // Each step is bounded, and an abort (outer timeout) throws straight to the finally so no further CDP work starts.
    const step = async (p, label) => {
      if (state.aborted) throw new Error('focus probe aborted');
      const v = await withTimeout(Promise.resolve(p), 3000, label);
      if (state.aborted) throw new Error('focus probe aborted');
      return v;
    };
    const nodes = [];
    try {
      const marked = await step(this.evaluate(focusSamples, null, 'isolated'), 'focus sampling');
      if (!marked?.samples?.length) {
        hp.capture.focus = { samples: [], outlineNone: marked?.outlineNone || 0 };
        return;
      }
      const before = await step(this.evaluate(focusStyles, null, 'isolated'), 'focus styles');
      await step(this.send('DOM.enable'), 'DOM.enable');
      await step(this.send('CSS.enable'), 'CSS.enable');
      const { root } = await step(this.send('DOM.getDocument', { depth: 0 }), 'DOM.getDocument');
      const { nodeIds } = await step(this.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-harplus-focus]' }), 'DOM.querySelectorAll');
      await step((async () => {
        for (const nodeId of nodeIds) {
          if (state.aborted) return;
          nodes.push(nodeId);
          await this.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
        }
      })(), 'forcing focus states');
      const after = await step(this.evaluate(focusStyles, null, 'isolated'), 'focus styles');
      hp.capture.focus = {
        samples: marked.samples.map((s) => ({ ...s, changed: focusChanges(before?.[s.kind], after?.[s.kind]) })),
        outlineNone: marked.outlineNone || 0,
      };
    } finally {
      await this.focusCleanup(nodes);
    }
  }

  /** Best-effort undo of the probe: clear forced states, remove the marks, drop the CSS/DOM domains. */
  async focusCleanup(nodes = []) {
    const quiet = (p, label) => withTimeout(Promise.resolve(p), 3000, label).catch(() => {});
    for (const nodeId of nodes) await quiet(this.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }), 'focus reset');
    await quiet(this.evaluate(focusUnmark, null, 'isolated'), 'focus unmark');
    await quiet(this.send('CSS.disable'), 'CSS.disable');
    await quiet(this.send('DOM.disable'), 'DOM.disable');
  }

  /** Undo every accessibility emulation. Safe to repeat; each step is best effort. */
  async resetA11y(base) {
    const quiet = (p) => withTimeout(Promise.resolve(p), 5000, 'reset').catch(() => {});
    await quiet(this.emulateFrames('Emulation.setEmulatedVisionDeficiency', null));
    await quiet(this.emulateFrames('Emulation.setEmulatedMedia', null));
    await quiet(this.evaluate(textSpacing, null, 'main'));
    await quiet(this.applyDevice(base || this.baseView));
    // Fonts only if the 200% text view changed them and did not put them back: the setting is the user's.
    if (this.fontsChanged && this.fontDefaults) {
      await withTimeout(this.send('Page.setFontSizes', { fontSizes: this.fontDefaults }), 5000, 'reset')
        .then(() => { this.fontsChanged = false; }, () => {});
    }
  }

  /** The base view as captured: viewport + thumbnail (+ full page). */
  screenshots() {
    return this.shoot(this.baseView, { thumb: true });
  }

  async shoot(view, { thumb = false, fullPage = true } = {}) {
    const shots = [];
    const m = await withTimeout(this.send('Page.getLayoutMetrics'), 5000, 'layout metrics');
    const vp = m.cssLayoutViewport || m.layoutViewport;
    const content = m.cssContentSize || m.contentSize;
    const dpr = (await withTimeout(this.evaluate(() => devicePixelRatio, null, 'main'), 3000, 'dpr').catch(() => 1)) || 1;

    if (thumb) this.report('screenshot', 'Capturing screenshots');
    const shot = await withTimeout(this.send('Page.captureScreenshot', {
      format: 'webp', quality: 80,
    }), 20_000, 'screenshot');
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

    if (this.opts.fullPage && fullPage) {
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
          cssWidth: cssW, cssHeight: cssH, docWidth: Math.ceil(content.width), docHeight: Math.ceil(content.height), truncated: content.height > cssH, data: full.data,
        });
      } catch (e) { this.warnings.push(`full-page screenshot failed: ${e.message}`); }
    }
    return shots;
  }

  /** Collect everything that needs the live page, then build the reading. */
  async finish(ctx) {
    const { plugins, settings } = ctx;
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
        console: this.console,
      },
      screenshots: shots,
      browser: { name: 'Chrome', version: (info.ua?.match(/Chrome\/([\d.]+)/) || [])[1] || '' },
    });
    if (live) {
      if (settings?.capture?.focusCheck !== false && !this.detached) {
        const state = { aborted: false };
        const probe = this.focusProbe(reading.log._harplus, state);
        await withTimeout(probe, 10_000, 'focus probe')
          .catch(async (e) => {
            state.aborted = true;
            this.warnings.push(`focus probe failed: ${e.message}`);
            // Let the probe stop and run its own cleanup (within one 3 s step) before anything else touches the page.
            await withTimeout(probe.catch(() => {}), 5000, 'focus probe stop').catch(() => {});
            await this.focusCleanup();
          });
      }
      this.report('sensing', 'Running in-page plugins');
      await runPlugins(reading, plugins, {
        phases: ['page'],
        settings,
        detectLanguage: chromeDetector(),
        evaluate: (fn, args, world) => this.evaluate(fn, args, world),
        inject: (urls, world) => this.inject(urls, world),
        onProgress: (p) => this.report('plugin', p),
      });
    }
    const willView = live && !this.detached;
    const hp = reading.log._harplus;
    if (willView) hp.capture.viewsPending = true;
    const id = ctx.onCore ? await ctx.onCore(reading) : null;
    if (willView) {
      const w0 = this.warnings.length;
      let patch;
      try {
        patch = await this.captureViews(reading);
      } catch (e) {
        this.warnings.push(`views failed: ${e.message}`);
        await this.resetA11y().catch(() => {});
        await withTimeout(this.evaluate(freezeMedia, false, 'main'), 3000, 'unfreeze media').catch(() => {});
        patch = { screenshots: [], capture: { viewsSkipped: [{ view: 'all', reason: e.message }] }, warnings: this.warnings.slice(w0) };
      } finally {
        patch ??= { screenshots: [], capture: { viewsSkipped: [{ view: 'all', reason: 'views did not finish' }] }, warnings: [] };
        patch.id = id ?? hp.id;
        patch.readingId = patch.id;
        if (ctx.onViews) await ctx.onViews(patch).catch(() => {});
        else mergeViewsPatch(reading, patch); // callers without the hand-off get the old, merged reading
      }
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
      s.report('plugin', s.reachedIdle ? 'Network idle' : 'Network still busy — continuing');
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
