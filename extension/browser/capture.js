// Capture layer: drives a tab through chrome.debugger (Chrome DevTools Protocol).
// Records the network conversation, captures screenshots, and runs page-phase plugins.
// Everything that needs the live page happens here; analysis happens after detaching.

import { HarRecorder } from '../core/recorder.js';
import { createReading, makeTarget, entriesFromResourceTiming } from '../core/harplus.js';
import { runPlugins } from '../core/plugin-host.js';
import { focusChanges } from '../core/focus.js';
import { DEVICE_VIEWS, VIEW_LABELS, VISION_VIEWS, DISPLAY_VIEWS, VISION_DEFICIENCY, MEDIA_EMULATION, SPACING_CSS } from '../core/views.js';

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
    clipped,
    truncated,
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

/** Set dir="rtl" on <html> (on) or put the original dir back (off). */
function flipDir(on) {
  const root = document.documentElement;
  if (on) {
    window.__harplusDir = root.getAttribute('dir');
    root.setAttribute('dir', 'rtl');
  } else {
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

function focusUnmark() {
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
    spacing: !!document.getElementById('harplus-spacing'),
    width: innerWidth,
    rootFont: getComputedStyle(document.documentElement).fontSize,
  };
}

/** Inject the WCAG 1.4.12 text-spacing stylesheet (css given) or remove it (css null). */
function textSpacing(css) {
  const old = document.getElementById('harplus-spacing');
  if (css == null) { old?.remove(); return; }
  const s = old || document.createElement('style');
  s.id = 'harplus-spacing';
  s.textContent = css;
  (document.head || document.documentElement).append(s);
}

/** Pseudo-localize visible text — accented and ~40% longer (on) — or restore every original (off). */
function pseudoText(on) {
  if (!on) {
    for (const [node, text] of window.__harplusPseudo || []) node.textContent = text;
    delete window.__harplusPseudo;
    return true;
  }
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
  const nodes = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && nodes.length < 5000; n = walker.nextNode()) if (keep(n)) nodes.push(n);
  const saved = (window.__harplusPseudo = []);
  for (const n of nodes) {
    const text = n.textContent;
    saved.push([n, text]);
    const core = text.trim();
    const dots = Math.ceil(core.length * 0.4);
    const pad = core.length >= 3 ? ' ' + Array.from({ length: Math.ceil(dots / 5) }, (_, k) => '·'.repeat(Math.min(5, dots - k * 5))).join(' ') : '';
    n.textContent = text.replace(/[A-Za-z]/g, (ch) => MAP[ch] || ch).replace(/\s*$/, (ws) => pad + ws);
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
    const grabFold = async (id, measured, scale) => ({ id, shots: await this.shoot(id, { fullPage: false, scale }), measured: measured ? await measure() : null });
    const view = async (id, { runMs, restoreMs, run, restore }) => {
      if (want[id] === false || (VISION_VIEWS.includes(id) && want.vision === false)) { skipped.push({ view: id, reason: 'disabled' }); return; }
      if (this.detached) { skipped.push({ view: id, reason: `debugger detached (${this.detached})` }); return; }
      if (this.viewsAborted) { skipped.push({ view: id, reason: this.viewsAborted }); return; }
      const label = `${VIEW_LABELS[id]} view`;
      this.report('views', label);
      const p = run();
      try {
        const got = await withTimeout(p, runMs, label);
        hp.screenshots.push(...got.shots);
        if (got.measured) views[id] = got.measured;
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
    await view('rtl', {
      runMs: 30_000,
      restoreMs: 20_000,
      run: async () => {
        await this.evaluate(flipDir, true, 'main');
        await sleep(400);
        return grab('rtl');
      },
      restore: () => this.evaluate(flipDir, false, 'main'),
    });
    await view('pseudo', {
      runMs: 30_000,
      restoreMs: 20_000,
      run: async () => {
        await this.evaluate(pseudoText, true, 'main');
        await sleep(400);
        return grab('pseudo');
      },
      restore: () => this.evaluate(pseudoText, false, 'main'),
    });
    const a11yWanted = [...VISION_VIEWS, ...DISPLAY_VIEWS, 'spacing', 'reflow', 'text200'].some((id) => want[id] !== false);
    if (a11yWanted) {
      hp.capture.prefs = await withTimeout(this.evaluate(prefsProbe, null, 'main'), 5000, 'prefs probe')
        .catch((e) => { this.warnings.push(`preferences probe failed: ${e.message}`); return undefined; });
    }
    for (const id of VISION_VIEWS) {
      await view(id, {
        runMs: 30_000,
        restoreMs: 10_000,
        run: async () => {
          await this.send('Emulation.setEmulatedVisionDeficiency', { type: VISION_DEFICIENCY[id] });
          await sleep(300);
          return grabFold(id, false, 'css');
        },
        restore: () => this.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' }),
      });
    }
    for (const id of DISPLAY_VIEWS) {
      await view(id, {
        runMs: 30_000,
        restoreMs: 10_000,
        run: async () => {
          await this.send('Emulation.setEmulatedMedia', MEDIA_EMULATION[id]);
          await sleep(300);
          return grabFold(id, true);
        },
        restore: () => this.send('Emulation.setEmulatedMedia', { media: '', features: [] }),
      });
    }
    await view('spacing', {
      runMs: 30_000,
      restoreMs: 10_000,
      run: async () => {
        await this.evaluate(textSpacing, SPACING_CSS, 'main');
        await sleep(600);
        return grabFold('spacing', true);
      },
      restore: () => this.evaluate(textSpacing, null, 'main'),
    });
    await view('reflow', {
      runMs: 30_000,
      restoreMs: 10_000,
      run: async () => {
        await this.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
        await sleep(600);
        return grabFold('reflow', true);
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
          await sleep(600);
          return grabFold('text200', true);
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
    if (!this.detached) hp.capture.restoreCheck = await withTimeout(this.evaluate(restoreProbe, null, 'main'), 3000, 'restore check').catch(() => undefined);
    hp.capture.views = views;
    hp.capture.viewsMs = Date.now() - t0;
    if (skipped.length) hp.capture.viewsSkipped = skipped;
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
      const marked = await step(this.evaluate(focusSamples, null, 'main'), 'focus sampling');
      if (!marked?.samples?.length) {
        hp.capture.focus = { samples: [], outlineNone: marked?.outlineNone || 0 };
        return;
      }
      const before = await step(this.evaluate(focusStyles, null, 'main'), 'focus styles');
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
      const after = await step(this.evaluate(focusStyles, null, 'main'), 'focus styles');
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
    await quiet(this.evaluate(focusUnmark, null, 'main'), 'focus unmark');
    await quiet(this.send('CSS.disable'), 'CSS.disable');
    await quiet(this.send('DOM.disable'), 'DOM.disable');
  }

  /** Undo every accessibility emulation. Safe to repeat; each step is best effort. */
  async resetA11y(base) {
    const quiet = (p) => withTimeout(Promise.resolve(p), 5000, 'reset').catch(() => {});
    await quiet(this.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' }));
    await quiet(this.send('Emulation.setEmulatedMedia', { media: '', features: [] }));
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

  /** scale 'css': one image pixel per CSS pixel (the vision views; their detail is not worth the bytes). */
  async shoot(view, { thumb = false, fullPage = true, scale: shotScale } = {}) {
    const shots = [];
    const m = await withTimeout(this.send('Page.getLayoutMetrics'), 5000, 'layout metrics');
    const vp = m.cssLayoutViewport || m.layoutViewport;
    const content = m.cssContentSize || m.contentSize;
    const dpr = (await withTimeout(this.evaluate(() => devicePixelRatio, null, 'main'), 3000, 'dpr').catch(() => 1)) || 1;

    if (thumb) this.report('screenshot', 'Capturing screenshots');
    const css = shotScale === 'css';
    const shot = await withTimeout(this.send('Page.captureScreenshot', {
      format: 'webp', quality: 80,
      ...(css ? { clip: { x: 0, y: 0, width: vp.clientWidth, height: vp.clientHeight, scale: 1 / dpr } } : {}),
    }), 20_000, 'screenshot');
    shots.push({
      kind: 'viewport', view, mimeType: 'image/webp', encoding: 'base64', dpr, ...(css ? { scale: Math.round((1 / dpr) * 1000) / 1000 } : {}),
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
        evaluate: (fn, args, world) => this.evaluate(fn, args, world),
        inject: (urls, world) => this.inject(urls, world),
        onProgress: (p) => this.report('plugin', p),
      });
      if (!this.detached) await this.captureViews(reading).catch(async (e) => { this.warnings.push(`views failed: ${e.message}`); await this.resetA11y(); });
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
