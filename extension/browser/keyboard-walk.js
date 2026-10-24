// Page helpers for the keyboard walk (capture.js keyboardWalk). Each function is self-contained: it is
// serialised with fnSource and run in the page's isolated world, so it may use nothing from this module.
// `keyPath` comes from core/keypath-src.js through `pageDeps` (fnSource compiles it in front of the function).
// State between calls lives on window.__hargusKb (the isolated world's own global, invisible to the page).

import { KEYPATH_SRC } from '../core/keypath-src.js';

/**
 * Before the walk: remember the scroll, blur, scroll to the top, snapshot unfocused styles, start Tab at the document
 * start. Also counts the focusable elements (through open shadow roots; `focusableCount` leaves out inert subtrees,
 * `focusableAll` keeps them, as a consent tool may make the page inert) and finds a consent banner visible at load.
 * args: { cmps: [{ tool, sels }] } (core/keyboard.js CMP_TOOLS).
 */
export function kbStart(args) {
  const cmps = Array.isArray(args?.cmps) ? args.cmps : [];
  const KEYS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderColor', 'borderWidth', 'backgroundColor', 'textDecorationLine', 'color'];
  // What had focus before (an autofocus field, say): recorded, since the walk must not start from there.
  const had = document.activeElement;
  const hadName = had?.getAttribute?.('name');
  const focused = had && had !== document.body && had !== document.documentElement ? `${had.localName}${hadName ? `[name="${hadName}"]` : ''}` : null;
  const start = { scrollX, scrollY, focused };
  const root = document.documentElement;
  // Smooth scrolling would leave a focused element mid-scroll when it is measured; instant until kbRestore.
  const hadStyle = root.hasAttribute('style');
  const prior = root.style.getPropertyValue('scroll-behavior');
  const priorPrio = root.style.getPropertyPriority('scroll-behavior');
  root.style.setProperty('scroll-behavior', 'auto', 'important');
  document.activeElement?.blur?.();
  scrollTo({ left: 0, top: 0, behavior: 'instant' });
  const styles = new WeakMap();
  const FOCUSABLE = 'a[href], area[href], button, input:not([type="hidden" i]), select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"], audio[controls], video[controls]';
  const up = (node) => node.parentElement || node.getRootNode?.()?.host || null;
  // Every candidate, through open shadow roots (bounded).
  const all = [];
  let seen = 0;
  const visit = (rootNode) => {
    for (const el of rootNode.querySelectorAll('*')) {
      if (++seen > 60000) return;
      if (el.matches(FOCUSABLE)) all.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  if (document.body) visit(document.body);
  let n = 0;
  for (const el of all) {
    if (++n > 5000) break;
    const cs = getComputedStyle(el);
    styles.set(el, Object.fromEntries(KEYS.map((k) => [k, cs[k]])));
  }
  const inInert = (el) => { for (let x = el; x; x = up(x)) if (x.hasAttribute?.('inert')) return true; return false; };
  const tabbable = all.filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible');
  start.focusableAll = tabbable.length;
  start.focusableCount = tabbable.filter((el) => !inInert(el)).length;

  // A consent banner visible at load: a known tool's container, else a fixed or sticky box about cookies or consent
  // that has buttons. The outermost match, so stops anywhere inside it count as reaching it.
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const rects = (x) => { const r = x.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
    if (rects(el)) return true;
    return [...el.querySelectorAll('*')].slice(0, 300).some((x) => rects(x) && getComputedStyle(x).visibility === 'visible');
  };
  const BUTTONS = 'button, a[href], [role="button"], input[type="button" i], input[type="submit" i]';
  let consentEl = null;
  let consentTool = null;
  for (const { tool, sels } of cmps) {
    for (const s of sels || []) {
      let el = null;
      try { el = document.querySelector(s); } catch { /* a selector this browser rejects */ }
      if (el && shown(el) && (el.matches('iframe') || el.querySelector(BUTTONS) || el.shadowRoot)) { consentEl = el; consentTool = tool; break; }
    }
    if (consentEl) break;
  }
  if (!consentEl && document.body) {
    let m = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (++m > 15000) break;
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const text = (el.textContent || '').slice(0, 4000);
      if (/\b(cookies?|consent)\b/i.test(text) && el.querySelector(BUTTONS) && shown(el)) { consentEl = el; break; }
    }
  }
  if (consentEl) {
    // The outermost element of the same banner: a fixed wrapper, or another of the tool's containers around it.
    for (let x = up(consentEl); x && x !== document.body && x !== root; x = up(x)) {
      const pos = getComputedStyle(x).position;
      if (pos === 'fixed' || pos === 'sticky' || (consentTool && cmps.find((c) => c.tool === consentTool)?.sels.some((s) => { try { return x.matches(s); } catch { return false; } }))) consentEl = x;
    }
    start.consent = { sel: keyPath(consentEl), ...(consentTool ? { tool: consentTool } : {}) };
  }

  // Inner scroll containers the walk scrolls are put back by kbRestore: remember the ones not at 0 now, and
  // (capture-phase listener: scroll events do not bubble) every element that scrolls during the walk.
  const scrolls = new Map();
  let k = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (++k > 20000) break;
    if (el.scrollTop || el.scrollLeft) scrolls.set(el, { left: el.scrollLeft, top: el.scrollTop });
  }
  const scrolled = new Set();
  const onScroll = (e) => { if (e.target?.nodeType === 1 && e.target !== root && e.target !== document.body) scrolled.add(e.target); };
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  // Chrome starts Tab from where focus last was (an autofocus field, a clicked search box), even after blur().
  // Focusing a first-in-order element at the very start of the body makes the first Tab land where a fresh load's
  // would: the lowest positive tabindex, else the first focusable. It is removed as soon as focus has moved on.
  let marker = null;
  if (document.body) {
    marker = document.createElement('span');
    marker.tabIndex = 1;
    marker.setAttribute('aria-hidden', 'true');
    marker.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);';
    document.body.prepend(marker);
    marker.focus({ preventScroll: true });
  }
  window.__hargusKb = { styles, ids: new WeakMap(), els: [], next: 1, prior, priorPrio, hadStyle, marker, scrolls, scrolled, onScroll, consentEl, aside: [], confineEl: null, confineTool: null };
  return start;
}
kbStart.pageDeps = { keyPath: KEYPATH_SRC };

/** The element that has focus, through open shadow roots; null when it is the body (or nothing). Frames are not entered. */
export function kbActive() {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return !el || el === document.body || el === document.documentElement || el === window.__hargusKb?.marker ? null : el;
}

/**
 * Describe the focused element (called with it as `this`). Document-coordinate box; visible (has size, not hidden,
 * not transparent, not clipped away); onScreen (in the viewport after the browser scrolled to it); the unfocused
 * style taken by kbStart and the focused one now (capture.js compares them); skip-link target on the first stop.
 * A fixed or sticky stop also gets its viewport box and the scroll it was seen at; a stop inside the consent banner
 * found at load is marked inConsent.
 */
export async function describeFocus({ first = false } = {}) {
  const el = this;
  const KEYS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderColor', 'borderWidth', 'backgroundColor', 'textDecorationLine', 'color'];
  const kb = window.__hargusKb || { styles: new WeakMap(), ids: new WeakMap(), els: [], next: 1 };
  if (kb.marker) { kb.marker.remove(); kb.marker = null; }
  if (!kb.ids.has(el)) kb.ids.set(el, kb.next++);
  if (kb.els) kb.els[kb.ids.get(el)] = el;
  // Let finite focus transitions finish (bounded), so the focused style is the final one.
  try {
    const running = el.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming?.().endTime));
    if (running.length) await Promise.race([Promise.all(running.map((a) => a.finished)).catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
  } catch { /* getAnimations unsupported */ }
  const up = (node) => node.parentElement || node.getRootNode?.()?.host || null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  let transparent = cs.opacity === '0';
  let fixed = cs.position === 'fixed' || cs.position === 'sticky';
  // An ancestor that clips its overflow to nothing, or with the stop wholly outside it. Only ancestors in the
  // containing-block chain clip: above a fixed element (or above an absolute one, up to its positioned ancestor)
  // overflow does not apply.
  let candidate = false;
  let mode = cs.position === 'fixed' ? 'fixed' : cs.position === 'absolute' ? 'abs' : 'flow';
  for (let n = up(el); n && n.nodeType === 1; n = up(n)) {
    const s = getComputedStyle(n);
    if (s.opacity === '0') transparent = true;
    if (s.position === 'fixed' || s.position === 'sticky') fixed = true;
    const block = s.transform !== 'none' || s.filter !== 'none' || /paint|layout|strict|content/.test(s.contain || '');
    const positioned = s.position !== 'static';
    const clips = mode === 'flow' || (mode === 'abs' && (positioned || block)) || (mode === 'fixed' && block);
    if (clips && n !== document.body && n !== document.documentElement && /hidden|clip/.test(`${s.overflowX} ${s.overflowY}`)) {
      const a = n.getBoundingClientRect();
      if (a.width === 0 || a.height === 0 || r.right <= a.left || r.left >= a.right || r.bottom <= a.top || r.top >= a.bottom) candidate = true;
    }
    if (s.position === 'fixed') mode = block ? 'flow' : 'fixed';
    else if (s.position === 'absolute') mode = 'abs';
    else if ((mode === 'abs' && (positioned || block)) || (mode === 'fixed' && block)) mode = 'flow';
  }
  // Confirm with the browser: at the stop's centre (the browser has scrolled it into view), is something else painted?
  let clippedAway = candidate;
  if (candidate) {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
      const rootNode = el.getRootNode?.();
      const hit = (rootNode?.elementFromPoint ? rootNode : document).elementFromPoint(cx, cy);
      if (hit && (hit === el || el.contains(hit))) clippedAway = false;
    }
  }
  const clipped = clippedAway || cs.clip === 'rect(0px, 0px, 0px, 0px)' || /^inset\(50%/.test(cs.clipPath) || (r.width <= 1 && r.height <= 1);
  const visible = r.width > 0 && r.height > 0 && cs.visibility === 'visible' && !transparent && !clipped;
  const onScreen = r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  const text = (n) => (n?.innerText || n?.textContent || '').replace(/\s+/g, ' ').trim();
  const byIds = (ids) => String(ids || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean);
  // A DOM approximation; capture.js prefers the browser's computed name and role when it can get them.
  const name = el.getAttribute('aria-label')?.trim() || byIds(el.getAttribute('aria-labelledby')).map(text).join(' ')
    || [...(el.labels || [])].map(text).join(' ') || (el.matches('input[type="button" i], input[type="submit" i], input[type="reset" i]') ? el.value : '')
    || (el.matches('input[type="image" i], area') ? el.getAttribute('alt') : '') || (el.matches('input, textarea, select') ? '' : text(el))
    || [...el.querySelectorAll('img[alt], svg title')].map((i) => i.alt || i.textContent).join(' ').trim() || el.getAttribute('title')?.trim() || el.getAttribute('placeholder')?.trim() || '';
  const ROLES = { a: 'link', area: 'link', button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button', iframe: 'iframe' };
  const role = el.getAttribute('role') || (el.localName === 'input' ? ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button', reset: 'button', image: 'button' }[el.type] || 'textbox') : ROLES[el.localName] || '');
  const out = {
    uid: kb.ids.get(el),
    sel: keyPath(el),
    role,
    name: String(name || '').slice(0, 200),
    tag: el.localName,
    box: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
    visible,
    onScreen,
    tabindex: el.hasAttribute('tabindex') ? el.tabIndex : null,
    before: kb.styles.get(el) || null,
    after: Object.fromEntries(KEYS.map((k) => [k, cs[k]])),
  };
  if (fixed) {
    // Pinned to the screen: the document box above is only right for this scroll position.
    out.fixed = true;
    out.vp = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    out.scrollY = Math.round(scrollY);
  }
  if (kb.consentEl) for (let n = el; n; n = up(n)) if (n === kb.consentEl) { out.inConsent = true; break; }
  if (el.localName === 'iframe' || el.localName === 'frame') out.frame = true;
  if (first && el.localName === 'a') {
    const raw = el.getAttribute('href') || '';
    const samePage = raw.startsWith('#') || (el.href.split('#')[0] === location.href.split('#')[0] && el.hash);
    const id = (el.hash || raw).replace(/^#/, '');
    if (samePage && id) {
      let decoded = id;
      try { decoded = decodeURIComponent(id); } catch { /* malformed escape */ }
      const t = document.getElementById(decoded) || document.getElementsByName(decoded)[0] || null;
      const tcs = t && getComputedStyle(t);
      out.skip = {
        href: `#${id}`,
        exists: !!t,
        visible: !!t && t.getClientRects().length > 0 && tcs.visibility !== 'hidden' && !t.closest('[hidden], [aria-hidden="true"]'),
        focusable: !!t && (t.tabIndex >= 0 || t.hasAttribute('tabindex')),
        landmark: !!t && t.matches('main, nav, aside, header, footer, form[aria-label], form[aria-labelledby], section[aria-label], section[aria-labelledby], [role="main"], [role="navigation"], [role="region"], [role="complementary"], [role="banner"], [role="contentinfo"], [role="search"], [role="form"]'),
        heading: !!t && t.matches('h1, h2, h3, h4, h5, h6, [role="heading"]'),
      };
    }
  }
  return out;
}
describeFocus.pageDeps = { keyPath: KEYPATH_SRC };

/**
 * After the first phase looked confined: what holds focus. The stops' nearest common container (through shadow
 * hosts), then the container that qualifies above it: a known consent tool's (the outermost of its containers), a
 * dialog (role dialog/alertdialog, aria-modal, <dialog open>), or a fixed or sticky element with z-index 10 or more.
 * Returns { sel, kind: 'cmp' | 'dialog' | 'fixed', tool?, modal, consent } or { sel, kind: null } for a container
 * that does not qualify, or null when the stops share nothing below the body. args: { uids, cmps }.
 */
export function kbConfine(args) {
  const kb = window.__hargusKb;
  if (!kb) return null;
  const cmps = Array.isArray(args?.cmps) ? args.cmps : [];
  const els = (args?.uids || []).map((u) => kb.els?.[u]).filter((el) => el && el.isConnected);
  if (!els.length) return null;
  const up = (node) => node.parentElement || node.getRootNode?.()?.host || null;
  const chain = (el) => { const c = []; for (let n = el; n; n = up(n)) c.push(n); return c; };
  let common = chain(els[0]);
  for (const el of els.slice(1)) { const set = new Set(chain(el)); common = common.filter((n) => set.has(n)); }
  let anc = common[0];
  if (anc && els.includes(anc)) anc = up(anc);
  const top = document.body;
  if (!anc || anc === top || anc === document.documentElement) return null;
  const path = chain(anc).filter((n) => n !== top && n !== document.documentElement);
  const matches = (n, s) => { try { return n.matches(s); } catch { return false; } };
  const toolOf = (n) => cmps.find((c) => (c.sels || []).some((s) => matches(n, s)))?.tool || null;
  let container = null;
  let kind = null;
  let tool = null;
  for (const n of path) { const t = toolOf(n); if (t) { container = n; tool = t; kind = 'cmp'; } }
  const role = (n) => (n.getAttribute('role') || '').trim().split(/\s+/)[0];
  if (!container) {
    const d = path.find((n) => role(n) === 'dialog' || role(n) === 'alertdialog' || n.getAttribute('aria-modal') === 'true' || (n.localName === 'dialog' && n.hasAttribute('open')));
    if (d) { container = d; kind = 'dialog'; }
  }
  if (!container) {
    for (const n of path) {
      const s = getComputedStyle(n);
      if ((s.position === 'fixed' || s.position === 'sticky') && (parseInt(s.zIndex, 10) || 0) >= 10) { container = n; kind = 'fixed'; }
    }
  }
  if (!container) return { sel: keyPath(anc), kind: null };
  const modal = chain(anc).some((n) => n.nodeType === 1 && (((role(n) === 'dialog' || role(n) === 'alertdialog') && n.getAttribute('aria-modal') === 'true') || matches(n, ':modal')));
  const consent = kind === 'cmp' || /\b(cookies?|consent|privacy)\b/i.test((container.textContent || '').slice(0, 5000)) || (!!kb.consentEl && (kb.consentEl === container || kb.consentEl.contains(container) || container.contains(kb.consentEl)));
  kb.confineEl = container;
  kb.confineTool = tool;
  return { sel: keyPath(container), kind, ...(tool ? { tool } : {}), modal, consent };
}
kbConfine.pageDeps = { keyPath: KEYPATH_SRC };

/**
 * Set the confining container aside without clicking anything: hide it and the same tool's overlay (or a backdrop
 * beside it), remove the inert and aria-hidden set on the page content around it, and lift a scroll lock on html and
 * body. Every attribute changed is recorded on window.__hargusKb.aside for kbRestore. args: { cmps }.
 * Returns { ok, hidden, attrs, scroll }: ok when the container no longer renders.
 */
export function kbSetAside(args) {
  const kb = window.__hargusKb;
  const c = kb?.confineEl;
  if (!c || !c.isConnected) return { ok: false };
  const cmps = Array.isArray(args?.cmps) ? args.cmps : [];
  const changes = kb.aside || (kb.aside = []);
  const snap = (el, name) => changes.push({ el, name, had: el.hasAttribute(name), value: el.getAttribute(name) });
  const hidden = [];
  const hide = (el) => {
    if (hidden.some((h) => h === el || h.contains(el))) return;
    snap(el, 'style');
    el.style.setProperty('display', 'none', 'important');
    hidden.push(el);
  };
  const rendered = (el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
  const up = (node) => node.parentElement || node.getRootNode?.()?.host || null;
  hide(c);
  // The same tool's other parts (an overlay, a dark filter) outside the container.
  const tool = cmps.find((t) => t.tool === kb.confineTool);
  for (const s of tool?.sels || []) {
    let list = [];
    try { list = [...document.querySelectorAll(s)]; } catch { /* rejected selector */ }
    for (const el of list.slice(0, 50)) if (!c.contains(el) && !el.contains(c) && rendered(el)) hide(el);
  }
  // A backdrop beside the container or its ancestors: fixed, covering half the viewport or more, with nothing focusable.
  const FOCUSABLE = 'a[href], button, input, select, textarea, iframe, [tabindex]';
  const sibs = (a) => [...(a.parentNode?.children || [])].filter((s) => s !== a && s !== kb.marker);
  const chain = [];
  for (let a = c; a && a !== document.body && a !== document.documentElement; a = up(a)) chain.push(a);
  for (const a of chain) {
    for (const s of sibs(a)) {
      if (s.localName === 'script' || s.localName === 'style' || !rendered(s)) continue;
      const cs = getComputedStyle(s);
      if (cs.position !== 'fixed') continue;
      const r = s.getBoundingClientRect();
      if (r.width * r.height >= 0.5 * innerWidth * innerHeight && !s.querySelector(FOCUSABLE)) hide(s);
    }
  }
  // inert and aria-hidden on the page content around it (the tool's way to keep focus in): taken off, recorded.
  let attrs = 0;
  for (const a of chain) {
    for (const s of sibs(a)) {
      if (s.hasAttribute('inert')) { snap(s, 'inert'); s.removeAttribute('inert'); attrs++; }
      if (s.getAttribute('aria-hidden') === 'true') { snap(s, 'aria-hidden'); s.removeAttribute('aria-hidden'); attrs++; }
    }
  }
  // A scroll lock: overflow hidden (or a fixed body) on html or body.
  let scroll = false;
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    const cs = getComputedStyle(el);
    const locked = /hidden|clip/.test(`${cs.overflowX} ${cs.overflowY}`);
    const pinned = el === document.body && cs.position === 'fixed';
    if (!locked && !pinned) continue;
    snap(el, 'style');
    if (locked) el.style.setProperty('overflow', 'visible', 'important');
    if (pinned) { el.style.setProperty('position', 'static', 'important'); el.style.setProperty('top', 'auto', 'important'); }
    scroll = true;
  }
  return { ok: c.getClientRects().length === 0, hidden: hidden.length, attrs, scroll };
}

/** The page phase starts like the first: focus nowhere, scrolled to the top, Tab from a marker at the start of the body. */
export function kbRestart() {
  const kb = window.__hargusKb;
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  el?.blur?.();
  document.activeElement?.blur?.();
  scrollTo({ left: 0, top: 0, behavior: 'instant' });
  if (!kb || !document.body) return false;
  if (kb.marker) kb.marker.remove();
  const marker = document.createElement('span');
  marker.tabIndex = 1;
  marker.setAttribute('aria-hidden', 'true');
  marker.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);';
  document.body.prepend(marker);
  marker.focus({ preventScroll: true });
  kb.marker = marker;
  return document.activeElement === marker;
}

/**
 * After the walk (also on an error or abort): put the set-aside banner, attributes and styles back exactly, then blur
 * and put inner scrollers, scroll-behavior and the scroll position back. Reports what it left, the document height
 * reached and whether the banner shows again.
 */
export async function kbRestore(start) {
  const kb = window.__hargusKb;
  const docH = document.documentElement.scrollHeight;
  if (kb?.marker) kb.marker.remove();
  // Newest first, so an attribute changed twice ends at its first recorded value.
  let aside = 0;
  for (const c of [...(kb?.aside || [])].reverse()) {
    try {
      if (c.had) c.el.setAttribute(c.name, c.value);
      else c.el.removeAttribute(c.name);
      aside++;
    } catch { /* the element went away */ }
  }
  const banner = kb?.confineEl && kb.aside?.length ? kb.confineEl.getClientRects().length > 0 : null;
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  el?.blur?.();
  document.activeElement?.blur?.();
  const root = document.documentElement;
  let restored = 0;
  let off = 0;
  if (kb) {
    // Scroll events arrive with the next frame: let the last stop's arrive before the listener goes.
    await Promise.race([new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))), new Promise((r) => setTimeout(r, 150))]);
    document.removeEventListener('scroll', kb.onScroll, { capture: true });
    for (const s of kb.scrolled) {
      const o = kb.scrolls.get(s) || { left: 0, top: 0 };
      s.scrollLeft = o.left;
      s.scrollTop = o.top;
      restored++;
      if (Math.abs(s.scrollLeft - o.left) > 1 || Math.abs(s.scrollTop - o.top) > 1) off++;
    }
    if (kb.prior) root.style.setProperty('scroll-behavior', kb.prior, kb.priorPrio);
    else root.style.removeProperty('scroll-behavior');
    if (!kb.hadStyle && !root.getAttribute('style')) root.removeAttribute('style');
  }
  if (start) scrollTo({ left: start.scrollX || 0, top: start.scrollY || 0, behavior: 'instant' });
  delete window.__hargusKb;
  return { active: document.activeElement?.localName || null, scrollX, scrollY, scrollers: restored, scrollersOff: off, docH, aside, ...(banner === null ? {} : { banner }) };
}
