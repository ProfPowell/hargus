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
  const start = { scrollX, scrollY, focused, docH: document.documentElement.scrollHeight };
  const root = document.documentElement;
  // The restore state is recorded as each change is made, so kbRestore can undo a kbStart that timed out halfway.
  const styles = new WeakMap();
  const kb = { styles, pseudo: new WeakMap(), pseudoSeen: new WeakSet(), near: new WeakMap(), ids: new WeakMap(), els: [], next: 1, prevEl: null, start: { scrollX, scrollY }, aside: [], confineEl: null, confineTool: null, consentEl: null, marker: null, scrolls: new Map(), scrolled: new Set(), onScroll: null };
  window.__hargusKb = kb;
  // Smooth scrolling would leave a focused element mid-scroll when it is measured; instant until kbRestore.
  kb.hadStyle = root.hasAttribute('style');
  kb.prior = root.style.getPropertyValue('scroll-behavior');
  kb.priorPrio = root.style.getPropertyPriority('scroll-behavior');
  root.style.setProperty('scroll-behavior', 'auto', 'important');
  kb.behaviorSet = true;
  document.activeElement?.blur?.();
  scrollTo({ left: 0, top: 0, behavior: 'instant' });
  const FOCUSABLE = 'a[href], area[href], button, input:not([type="hidden" i]), select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"], audio[controls], video[controls]';
  const up = (node) => node.parentElement || node.getRootNode?.()?.host || null;
  // Every candidate, through open shadow roots (bounded).
  const all = [];
  let seen = 0;
  // Inside a closed <details> (other than its first summary) or a [hidden] subtree: not reachable, so not counted.
  const closedAway = (el) => {
    for (let n = el; n; n = up(n)) {
      if (n.hasAttribute?.('hidden')) return true;
      const p = n.parentElement;
      if (p && p.localName === 'details' && !p.open && !(n.localName === 'summary' && n === [...p.children].find((c) => c.localName === 'summary'))) return true;
    }
    return false;
  };
  const visit = (rootNode) => {
    for (const el of rootNode.querySelectorAll('*')) {
      if (++seen > 60000) return;
      if (el.matches(FOCUSABLE)) all.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  if (document.body) visit(document.body);
  // Whether an element renders and is reachable (not in a closed <details> or [hidden] subtree): read once per element.
  const reach = new Map();
  const reachable = (el) => {
    if (!reach.has(el)) reach.set(el, el.getClientRects().length > 0 && !closedAway(el));
    return reach.get(el);
  };
  // A ::before or ::after that exists (content is not 'none'): its styles too, as a ring may be drawn on one. Every
  // node looked at is remembered, so describeFocus knows a pseudo-element missing here was absent while unfocused.
  const snapPseudo = (node) => {
    kb.pseudoSeen.add(node);
    const out = {};
    for (const p of ['::before', '::after']) {
      const pcs = getComputedStyle(node, p);
      if (pcs.content && pcs.content !== 'none') out[p] = Object.fromEntries(KEYS.map((k) => [k, pcs[k]]));
    }
    if (Object.keys(out).length) kb.pseudo.set(node, out);
  };
  // Ancestor boxes are shared by many focusables: each is measured once.
  const boxes = new Map();
  const boxOf = (x) => { if (!boxes.has(x)) boxes.set(x, x.getBoundingClientRect()); return boxes.get(x); };
  let n = 0;
  for (const el of all) {
    if (++n > 5000) break;
    const cs = getComputedStyle(el);
    styles.set(el, Object.fromEntries(KEYS.map((k) => [k, cs[k]])));
    // Relatives only for a stop Tab can land on as the page is now.
    if (!reachable(el)) continue;
    snapPseudo(el);
    // The ring is often drawn on a wrapper (:focus-within) or a child: up to 4 ancestors that contain the element's
    // box (give or take 4px: Le Monde's card heading sits 2px above its click area, which is the 4th such ancestor on
    // its lifestyle cards), and its first child, are snapshotted too so describeFocus can compare them.
    const near = [];
    const r = el.getBoundingClientRect();
    const RELS = ['parent', 'grandparent', 'ancestor', 'ancestor'];
    let levels = 0;
    for (let x = up(el); x && x !== document.body && x !== root && near.length < 4 && ++levels <= 12; x = up(x)) {
      const b = boxOf(x);
      if (b.left <= r.left + 4 && b.top <= r.top + 4 && b.right >= r.right - 4 && b.bottom >= r.bottom - 4) near.push({ rel: RELS[near.length], node: x });
    }
    if (el.firstElementChild) near.push({ rel: 'child', node: el.firstElementChild });
    for (const { node } of near) {
      if (styles.has(node)) continue;
      const ncs = getComputedStyle(node);
      styles.set(node, Object.fromEntries(KEYS.map((k) => [k, ncs[k]])));
      snapPseudo(node);
    }
    if (near.length) kb.near.set(el, near);
  }
  const inInert = (el) => { for (let x = el; x; x = up(x)) if (x.hasAttribute?.('inert')) return true; return false; };
  const tabbable = all.filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && reachable(el) && getComputedStyle(el).visibility === 'visible');
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
  // Else an inline banner (gov.uk's): a block in the normal flow that holds the first Tab stop, is about cookies or
  // consent (its rendered text), has an accept or reject button, and is no more than 40% of the document's height.
  // The innermost one, widened only through wrappers that add no Tab stop of their own (so a wrapper that also holds
  // the skip link or the header is never taken). It is only reported (kind 'inline'); it never holds focus, so it is
  // never set aside.
  let inline = false;
  if (!consentEl && tabbable[0]) {
    const docH = root.scrollHeight;
    const REAL_BUTTONS = 'button, [role="button"], input[type="button" i], input[type="submit" i]';
    const choice = (b) => /\b(accept|reject|agree|decline|allow|deny)\b/i.test(b.innerText || b.textContent || b.value || '');
    const within = (el, a) => { for (let n = el; n; n = up(n)) if (n === a) return true; return false; };
    // Normal flow: nothing from the stop up to the body is fixed or absolute.
    let flow = true;
    for (let x = up(tabbable[0]); x && x !== document.body && x !== root; x = up(x)) {
      if (x.nodeType === 1 && /^(fixed|absolute)$/.test(getComputedStyle(x).position)) { flow = false; break; }
    }
    for (let x = up(tabbable[0]); flow && x && x !== document.body && x !== root; x = up(x)) {
      if (x.nodeType !== 1 || !x.matches('[role="region"], [role="dialog"], section, div, aside, form')) continue;
      if (x.getBoundingClientRect().height > 0.4 * docH) continue;
      if (!/\b(cookies?|consent)\b/i.test((x.innerText || '').slice(0, 4000))) continue;
      if ([...x.querySelectorAll(REAL_BUTTONS)].slice(0, 50).some(choice) && shown(x)) { consentEl = x; inline = true; break; }
    }
    if (consentEl) {
      for (let p = up(consentEl); p && p !== document.body && p !== root; p = up(p)) {
        if (tabbable.some((t) => within(t, p) && !within(t, consentEl))) break;
        consentEl = p;
      }
    }
  }
  if (consentEl) {
    // The outermost element of the same banner: a fixed wrapper, or another of the tool's containers around it.
    for (let x = up(consentEl); !inline && x && x !== document.body && x !== root; x = up(x)) {
      const pos = getComputedStyle(x).position;
      if (pos === 'fixed' || pos === 'sticky' || (consentTool && cmps.find((c) => c.tool === consentTool)?.sels.some((s) => { try { return x.matches(s); } catch { return false; } }))) consentEl = x;
    }
    start.consent = { sel: keyPath(consentEl), ...(consentTool ? { tool: consentTool } : {}), ...(inline ? { kind: 'inline' } : {}) };
    kb.consentEl = consentEl;
    kb.consentInline = inline;
  }

  // Inner scroll containers the walk scrolls are put back by kbRestore: remember the ones not at 0 now, and
  // (capture-phase listener: scroll events do not bubble) every element that scrolls during the walk.
  let k = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (++k > 20000) break;
    if (el.scrollTop || el.scrollLeft) kb.scrolls.set(el, { left: el.scrollLeft, top: el.scrollTop });
  }
  kb.onScroll = (e) => { if (e.target?.nodeType === 1 && e.target !== root && e.target !== document.body) kb.scrolled.add(e.target); };
  document.addEventListener('scroll', kb.onScroll, { capture: true, passive: true });
  // Chrome starts Tab from where focus last was (an autofocus field, a clicked search box), even after blur().
  // Focusing a first-in-order element at the very start of the body makes the first Tab land where a fresh load's
  // would: the lowest positive tabindex, else the first focusable. It is removed as soon as focus has moved on.
  if (document.body) {
    const marker = document.createElement('span');
    marker.tabIndex = 1;
    marker.setAttribute('aria-hidden', 'true');
    marker.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);';
    document.body.prepend(marker);
    kb.marker = marker;
    marker.focus({ preventScroll: true });
  }
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
 * found at load is marked inConsent, and a stop that banner covers while shown is marked obscured ('full' | 'half';
 * obscuredFrame when the banner is a full-screen cross-origin frame, whose painted part cannot be seen).
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
  let visible = r.width > 0 && r.height > 0 && cs.visibility === 'visible' && !transparent && !clipped;
  // A native input made see-through or clipped on purpose, with its visible label or control laid over it (the
  // custom checkbox/switch pattern): if what is painted at its centre, or one of its labels, is visible and covers
  // at least half of its box, the stop is seen through that.
  let overlaid = false;
  if (!visible && el.localName === 'input' && r.width > 0 && r.height > 0 && cs.visibility === 'visible' && (cs.opacity === '0' || clipped)) {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const rootNode = el.getRootNode?.();
    const hit = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight ? (rootNode?.elementFromPoint ? rootNode : document).elementFromPoint(cx, cy) : null;
    const area = r.width * r.height;
    const covers = (x) => {
      if (!x || x === el) return false;
      const b = x.getBoundingClientRect();
      const w = Math.min(b.right, r.right) - Math.max(b.left, r.left);
      const h = Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top);
      if (w <= 0 || h <= 0 || w * h < area / 2) return false;
      for (let n = x; n && n.nodeType === 1; n = up(n)) {
        const s = getComputedStyle(n);
        if (s.visibility === 'hidden' || s.opacity === '0' || s.display === 'none') return false;
      }
      return true;
    };
    // Only what belongs to the control counts: one of its labels (or inside one), or inside its own wrapper. An
    // unrelated element painted there (a sticky header, an overlay) says nothing about this input.
    const labels = [...(el.labels || [])];
    const wrap = el.parentElement && el.parentElement !== document.body && el.parentElement !== document.documentElement ? el.parentElement : null;
    const related = (x) => !!x && (labels.some((l) => l.contains(x)) || (wrap && wrap.contains(x)));
    if ((related(hit) && covers(hit)) || labels.some(covers)) { visible = true; overlaid = true; }
  }
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
    ...(overlaid ? { overlaid: true } : {}),
    onScreen,
    tabindex: el.hasAttribute('tabindex') ? el.tabIndex : null,
    before: kb.styles.get(el) || null,
    after: Object.fromEntries(KEYS.map((k) => [k, cs[k]])),
  };
  // Wrapper or child styles (a ring drawn on a relative), and the ::before/::after of the element and its relatives;
  // capture.js looks at them only when the element's own styles show no change. Only those whose styles differ are
  // sent, which keeps the payload small. A pseudo-element kbStart looked for and found absent (content none) that
  // exists now (Le Monde's card ring: `.clickarea:has(a:focus-visible)::after`) is compared against "absent": no
  // outline, shadow, border or background, so it counts only when it draws one. A relative that also holds the previous stop is
  // skipped: moving focus between two stops inside one container (a nav with :focus-within, a header restyled since
  // kbStart) changes nothing visible on it.
  if (out.before) {
    const prev = kb.prevEl && kb.prevEl !== el && kb.prevEl.isConnected ? kb.prevEl : null;
    const holdsPrev = (node) => { for (let n = prev; n; n = up(n)) if (n === node) return true; return false; };
    const near = [];
    const pseudoOf = (rel, node) => {
      const had = kb.pseudo?.get(node) || {};
      const looked = !!kb.pseudoSeen?.has(node);
      for (const p of ['::before', '::after']) {
        if (!had[p] && !looked) continue;
        const pcs = getComputedStyle(node, p);
        if (!had[p] && (!pcs.content || pcs.content === 'none' || pcs.display === 'none')) continue;
        const after = Object.fromEntries(KEYS.map((k) => [k, pcs[k]]));
        // An appeared one that only adds a background draws nothing as an empty inline box: it needs a box of its own.
        if (!had[p]) {
          const ring = (after.outlineStyle !== 'none' && parseFloat(after.outlineWidth) > 0) || after.boxShadow !== 'none' || parseFloat(after.borderWidth) > 0;
          if (!ring && pcs.display === 'inline' && pcs.position !== 'absolute' && pcs.position !== 'fixed') continue;
        }
        const b = had[p] || { ...after, outlineStyle: 'none', outlineWidth: '0px', boxShadow: 'none', borderWidth: '0px', backgroundColor: 'rgba(0, 0, 0, 0)' };
        if (KEYS.some((k) => b[k] !== after[k])) near.push({ rel, pseudo: p, before: b, after, ...(had[p] ? {} : { appeared: true }) });
      }
    };
    pseudoOf('self', el);
    for (const { rel, node } of kb.near?.get(el) || []) {
      const b = kb.styles.get(node);
      if (!b || !node.isConnected || holdsPrev(node)) continue;
      const ncs = getComputedStyle(node);
      const after = Object.fromEntries(KEYS.map((k) => [k, ncs[k]]));
      if (KEYS.some((k) => b[k] !== after[k])) near.push({ rel, before: b, after });
      pseudoOf(rel, node);
    }
    if (near.length) out.near = near;
  }
  kb.prevEl = el;
  if (fixed) {
    // Pinned to the screen: the document box above is only right for this scroll position.
    out.fixed = true;
    out.vp = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    out.scrollY = Math.round(scrollY);
  }
  if (kb.consentEl) for (let n = el; n; n = up(n)) if (n === kb.consentEl) { out.inConsent = true; break; }
  // A stop the consent banner covers while it has focus (WCAG 2.4.11): only while the banner is shown, was not set
  // aside and is not an inline (in-flow) one, which cannot cover anything. The banner's box is its own when it paints
  // (an iframe, a background image, or a background colour with alpha 0.95 or more), else (a transparent wrapper, a
  // see-through backdrop) its largest visible child's. Covered entirely is 'full' when the banner is what is painted at
  // the stop's centre (else 'half'); at least half of the stop's area is 'half'.
  const c = kb.consentEl;
  const asideC = kb.aside?.length && kb.confineEl && (kb.confineEl === c || kb.confineEl.contains(c) || c?.contains(kb.confineEl));
  if (c && !kb.consentInline && !out.inConsent && visible && onScreen && r.width > 0 && r.height > 0 && c.isConnected && !asideC) {
    const ccs = getComputedStyle(c);
    if (ccs.display !== 'none' && ccs.visibility !== 'hidden' && ccs.opacity !== '0') {
      // The colour's alpha: "rgba(0, 0, 0, 0.4)", "rgb(…)", or a modern "… / 0.4" form.
      const alpha = (col) => {
        if (!col || col === 'transparent') return 0;
        const inner = /\(([^)]*)\)/.exec(col)?.[1];
        if (!inner) return 1;
        const a = inner.includes('/') ? inner.split('/')[1] : inner.split(',').length === 4 ? inner.split(',')[3] : null;
        if (a == null) return 1;
        const v = parseFloat(a);
        return Number.isFinite(v) ? (a.trim().endsWith('%') ? v / 100 : v) : 1;
      };
      // display: contents paints no box of its own.
      const painted = c.localName === 'iframe' || (ccs.display !== 'contents' && c.getClientRects().length > 0
        && (ccs.backgroundImage !== 'none' || alpha(ccs.backgroundColor) >= 0.95));
      // The largest visible child box of a list of elements.
      const largest = (xs, view = window) => {
        let best = 0;
        let out = null;
        for (const x of xs) {
          if (!x.getClientRects().length) continue;
          const xcs = view.getComputedStyle(x);
          if (xcs.visibility === 'hidden' || xcs.opacity === '0') continue;
          const q = x.getBoundingClientRect();
          if (q.width * q.height > best) { best = q.width * q.height; out = { el: x, rect: q }; }
        }
        return out;
      };
      let b = null;
      let cover = null;
      if (painted) { b = c.getBoundingClientRect(); cover = c; }
      else {
        const big = largest([...c.children, ...(c.shadowRoot?.children || [])]);
        if (big) { b = big.rect; cover = big.el; }
      }
      // A frame covering (nearly) the whole viewport: its own box says nothing, as a consent frame is often a
      // see-through full-screen layer with a smaller dialog painted inside. Same-origin: the dialog is measured (the
      // largest visible box in the frame's body, in this page's coordinates). Cross-origin: stops are at most half
      // judged (obscuredFrame), as what the frame paints cannot be seen.
      let frameUnsure = false;
      if (b && cover?.localName === 'iframe' && b.width * b.height >= 0.9 * innerWidth * innerHeight) {
        let doc = null;
        try { doc = cover.contentDocument; } catch { /* cross-origin */ }
        const inner = doc?.body ? largest([...doc.body.children], doc.defaultView || window) : null;
        if (inner) {
          const ox = b.left + cover.clientLeft;
          const oy = b.top + cover.clientTop;
          const q = inner.rect;
          b = { left: q.left + ox, top: q.top + oy, right: q.right + ox, bottom: q.bottom + oy };
        } else if (!doc) frameUnsure = true;
        else b = null;
      }
      if (b) {
        const w = Math.min(b.right, r.right) - Math.max(b.left, r.left);
        const h = Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top);
        if (b.left <= r.left + 1 && b.top <= r.top + 1 && b.right >= r.right - 1 && b.bottom >= r.bottom - 1) {
          // Confirm with the browser: something above the banner (a sticky header) leaves the stop half judged.
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const hit = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight ? document.elementFromPoint(cx, cy) : null;
          let onTop = false;
          for (let n = hit; n && !onTop; n = up(n)) onTop = n === c;
          out.obscured = (onTop || !hit) && !frameUnsure ? 'full' : 'half';
        } else if (w > 0 && h > 0 && w * h >= 0.5 * r.width * r.height) out.obscured = 'half';
        if (out.obscured && frameUnsure) out.obscuredFrame = true;
      }
    }
  }
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
      // A display:contents target has no box of its own: it is there when a child has one (nested display:contents
      // children are followed, 3 deep), or when a Range over its text has rects.
      const boxed = (n, depth) => {
        for (const c of n.children) {
          if (c.getClientRects().length > 0) return true;
          if (depth < 3 && getComputedStyle(c).display === 'contents' && boxed(c, depth + 1)) return true;
        }
        const range = document.createRange();
        range.selectNodeContents(n);
        return [...range.getClientRects()].some((q) => q.width > 0 && q.height > 0);
      };
      out.skip = {
        href: `#${id}`,
        exists: !!t,
        visible: !!t && (t.getClientRects().length > 0 || (tcs.display === 'contents' && boxed(t, 0))) && tcs.visibility !== 'hidden' && !t.closest('[hidden], [aria-hidden="true"]'),
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
 * What holds focus. For a first phase that looked confined: the stops' nearest common container (through shadow
 * hosts). For a frame that held focus (`frame: true`, one uid): the frame itself and its ancestors. Then the
 * container that qualifies on that chain: a known consent tool's (the outermost of its containers), a dialog
 * (role dialog/alertdialog, aria-modal, <dialog open>), or a fixed or sticky element with z-index 10 or more.
 * Returns { sel, kind: 'cmp' | 'dialog' | 'fixed' | null, tool?, modal, consent, inside, wrapper }: `inside` counts
 * the focusable elements in it (inert subtrees left out), `wrapper` marks an app root (#root, #__next, …).
 * Null when the stops share nothing below the body. args: { uids, cmps, frame }.
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
  // A single stop is not a container, unless it is a frame: then the frame's own chain is what is judged.
  if (anc && els.includes(anc) && !args?.frame) anc = up(anc);
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
  const judged = container || anc;
  // Focusable elements inside, through open shadow roots, leaving out inert subtrees (as kbStart's focusableCount).
  const FOCUSABLE = 'a[href], area[href], button, input:not([type="hidden" i]), select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"], audio[controls], video[controls]';
  let inside = 0;
  let seen = 0;
  const count = (rootNode) => {
    for (const el of rootNode.querySelectorAll('*')) {
      if (++seen > 60000) return;
      if (el.shadowRoot) count(el.shadowRoot);
      if (!el.matches(FOCUSABLE) || el.tabIndex < 0 || el.matches(':disabled') || !el.getClientRects().length || getComputedStyle(el).visibility !== 'visible') continue;
      let inert = false;
      for (let x = el; x && !inert; x = up(x)) inert = !!x.hasAttribute?.('inert');
      if (!inert) inside++;
    }
  };
  count(judged);
  const WRAPPERS = '#root, #__next, #app, #__nuxt, #___gatsby, #svelte, [data-reactroot], [ng-version]';
  const wrapper = chain(judged).some((n) => n.nodeType === 1 && n !== top && n !== document.documentElement && matches(n, WRAPPERS));
  if (!container) return { sel: keyPath(anc), kind: null, inside, wrapper };
  const modal = chain(anc).some((n) => n.nodeType === 1 && (((role(n) === 'dialog' || role(n) === 'alertdialog') && n.getAttribute('aria-modal') === 'true') || matches(n, ':modal')));
  const words = /\b(cookies?|consent|privacy)\b/i;
  const frameWords = args?.frame && els[0].localName === 'iframe' && /consent|cookie|privacy|cmp/i.test(`${els[0].id} ${els[0].getAttribute('src') || ''} ${els[0].title || ''}`);
  const consent = kind === 'cmp' || frameWords || words.test((container.textContent || '').slice(0, 5000)) || (!!kb.consentEl && (kb.consentEl === container || kb.consentEl.contains(container) || container.contains(kb.consentEl)));
  if (!args?.peek) { kb.confineEl = container; kb.confineTool = tool; }
  return { sel: keyPath(container), kind, ...(tool ? { tool } : {}), modal, consent, inside, wrapper };
}
kbConfine.pageDeps = { keyPath: KEYPATH_SRC };

/**
 * A frame held focus and is not a banner: move past it. A start marker (tabindex 0) right after the frame takes
 * focus, so the next Tab lands on the next element after the frame in the page's order. args: { uid }.
 */
export function kbSkipFrame(args) {
  const kb = window.__hargusKb;
  const frame = kb?.els?.[args?.uid];
  if (!frame || !frame.isConnected) return false;
  frame.blur?.();
  document.activeElement?.blur?.();
  if (kb.marker) kb.marker.remove();
  const marker = document.createElement('span');
  marker.tabIndex = 0;
  marker.setAttribute('aria-hidden', 'true');
  marker.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);';
  frame.after(marker);
  kb.marker = marker;
  marker.focus({ preventScroll: true });
  return document.activeElement === marker || marker.getRootNode().activeElement === marker;
}

/**
 * Set the confining container aside without clicking anything: hide it and the same tool's overlay or backdrop parts
 * that sit beside it or its ancestors (or a plain backdrop there), remove the inert and aria-hidden set on the page
 * content around it, and lift a scroll lock on html and body. Every attribute changed is recorded on
 * window.__hargusKb.aside for kbRestore. args: { cmps }. Returns { ok, hidden, attrs, scroll }: ok when the
 * container no longer renders.
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
  const sibs = (a) => [...(a.parentNode?.children || [])].filter((s) => s !== a && s !== kb.marker);
  const chain = [];
  for (let a = c; a && a !== document.body && a !== document.documentElement; a = up(a)) chain.push(a);
  hide(c);
  // The same tool's overlay parts, only beside the container or one of its ancestors.
  const tool = cmps.find((t) => t.tool === kb.confineTool);
  const near = new Set(chain.flatMap(sibs));
  const matches = (n, s) => { try { return n.matches(s); } catch { return false; } };
  for (const s of near) if ((tool?.parts || []).some((p) => matches(s, p)) && rendered(s)) hide(s);
  // A plain backdrop beside the container or its ancestors: fixed, covering half the viewport or more, nothing focusable.
  const FOCUSABLE = 'a[href], button, input, select, textarea, iframe, [tabindex]';
  for (const s of near) {
    if (s.localName === 'script' || s.localName === 'style' || !rendered(s)) continue;
    if (getComputedStyle(s).position !== 'fixed') continue;
    const r = s.getBoundingClientRect();
    if (r.width * r.height >= 0.5 * innerWidth * innerHeight && !s.querySelector(FOCUSABLE)) hide(s);
  }
  // inert and aria-hidden on the page content around it (the tool's way to keep focus in): taken off, recorded.
  let attrs = 0;
  for (const s of near) {
    if (s.hasAttribute('inert')) { snap(s, 'inert'); s.removeAttribute('inert'); attrs++; }
    if (s.getAttribute('aria-hidden') === 'true') { snap(s, 'aria-hidden'); s.removeAttribute('aria-hidden'); attrs++; }
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
  kb.prevEl = null;
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
 * After the walk (also on an error, an abort, a kbStart that timed out or a navigation that never committed): put the
 * set-aside banner, attributes and styles back exactly, then blur and put inner scrollers, scroll-behavior and the
 * scroll position back. Only what kbStart recorded is undone; without its state (a new document) nothing is touched.
 * Reports what it left, the document height reached and whether the banner shows again.
 */
export async function kbRestore(start) {
  const kb = window.__hargusKb;
  if (!kb) return { gone: true };
  const docH = document.documentElement.scrollHeight;
  if (kb.marker) kb.marker.remove();
  // Newest first, so an attribute changed twice ends at its first recorded value.
  let aside = 0;
  for (const c of [...(kb.aside || [])].reverse()) {
    try {
      if (c.had) c.el.setAttribute(c.name, c.value);
      else c.el.removeAttribute(c.name);
      aside++;
    } catch { /* the element went away */ }
  }
  const banner = kb.confineEl && kb.aside?.length ? kb.confineEl.getClientRects().length > 0 : null;
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  el?.blur?.();
  document.activeElement?.blur?.();
  const root = document.documentElement;
  let restored = 0;
  let off = 0;
  // Scroll events arrive with the next frame: let the last stop's arrive before the listener goes.
  await Promise.race([new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))), new Promise((r) => setTimeout(r, 150))]);
  if (kb.onScroll) document.removeEventListener('scroll', kb.onScroll, { capture: true });
  for (const s of kb.scrolled || []) {
    const o = kb.scrolls?.get(s) || { left: 0, top: 0 };
    s.scrollLeft = o.left;
    s.scrollTop = o.top;
    restored++;
    if (Math.abs(s.scrollLeft - o.left) > 1 || Math.abs(s.scrollTop - o.top) > 1) off++;
  }
  if (kb.behaviorSet) {
    if (kb.prior) root.style.setProperty('scroll-behavior', kb.prior, kb.priorPrio);
    else root.style.removeProperty('scroll-behavior');
    if (!kb.hadStyle && !root.getAttribute('style')) root.removeAttribute('style');
  }
  const to = start || kb.start;
  if (to) scrollTo({ left: to.scrollX || 0, top: to.scrollY || 0, behavior: 'instant' });
  delete window.__hargusKb;
  return { active: document.activeElement?.localName || null, scrollX, scrollY, scrollers: restored, scrollersOff: off, docH, aside, ...(banner === null ? {} : { banner }) };
}
