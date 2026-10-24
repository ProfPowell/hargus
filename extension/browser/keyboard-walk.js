// Page helpers for the keyboard walk (capture.js keyboardWalk). Each function is self-contained: it is
// serialised with fnSource and run in the page's isolated world, so it may use nothing from this module.
// State between calls lives on window.__hargusKb (the isolated world's own global, invisible to the page).

/** Before the walk: remember the scroll, blur, scroll to the top, snapshot unfocused styles, start Tab at the document start. */
export function kbStart() {
  const KEYS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderColor', 'borderWidth', 'backgroundColor', 'textDecorationLine', 'color'];
  const start = { scrollX, scrollY };
  const root = document.documentElement;
  // Smooth scrolling would leave a focused element mid-scroll when it is measured; instant until kbRestore.
  const hadStyle = root.hasAttribute('style');
  const prior = root.style.getPropertyValue('scroll-behavior');
  const priorPrio = root.style.getPropertyPriority('scroll-behavior');
  root.style.setProperty('scroll-behavior', 'auto', 'important');
  document.activeElement?.blur?.();
  scrollTo({ left: 0, top: 0, behavior: 'instant' });
  const styles = new WeakMap();
  const sel = 'a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"], audio[controls], video[controls]';
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (++n > 5000) break;
    const cs = getComputedStyle(el);
    styles.set(el, Object.fromEntries(KEYS.map((k) => [k, cs[k]])));
  }
  window.__hargusKb = { styles, ids: new WeakMap(), next: 1, prior, priorPrio, hadStyle };
  // Sequential focus navigation starts from the selection: put it at the very start of the body.
  try { if (document.body) getSelection().collapse(document.body, 0); } catch { /* no selection API */ }
  return start;
}

/** The element that has focus, through open shadow roots; null when it is the body (or nothing). Frames are not entered. */
export function kbActive() {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return !el || el === document.body || el === document.documentElement ? null : el;
}

/**
 * Describe the focused element (called with it as `this`). Document-coordinate box; visible (has size, not hidden,
 * not transparent, not clipped away); onScreen (in the viewport after the browser scrolled to it); the unfocused
 * style taken by kbStart and the focused one now (capture.js compares them); skip-link target on the first stop.
 */
export async function describeFocus({ first = false } = {}) {
  const el = this;
  const KEYS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderColor', 'borderWidth', 'backgroundColor', 'textDecorationLine', 'color'];
  const kb = window.__hargusKb || { styles: new WeakMap(), ids: new WeakMap(), next: 1 };
  if (!kb.ids.has(el)) kb.ids.set(el, kb.next++);
  // Let finite focus transitions finish (bounded), so the focused style is the final one.
  try {
    const running = el.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming?.().endTime));
    if (running.length) await Promise.race([Promise.all(running.map((a) => a.finished)).catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
  } catch { /* getAnimations unsupported */ }
  const keyPath = (node) => {
    const parts = [];
    for (let n = node; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      let p = n.localName;
      if (n.id && document.querySelectorAll(`#${CSS.escape(n.id)}`).length === 1) { parts.unshift(`${p}#${CSS.escape(n.id)}`); break; }
      if (n.classList.length) p += `.${[...n.classList].slice(0, 2).map((c) => CSS.escape(c)).join('.')}`;
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.localName === n.localName) : [];
      if (same.length > 1) p += `:nth-of-type(${same.indexOf(n) + 1})`;
      parts.unshift(p);
      if (n.localName === 'body') break;
    }
    const host = node.getRootNode?.()?.host;
    return host ? `${keyPath(host)} >>> ${parts.join(' > ')}` : parts.join(' > ');
  };
  const up = (node) => node.parentElement || node.getRootNode?.()?.host || null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  let transparent = false;
  let fixed = false;
  for (let n = el; n && n.nodeType === 1; n = up(n)) {
    const s = getComputedStyle(n);
    if (s.opacity === '0') transparent = true;
    if (s.position === 'fixed' || s.position === 'sticky') fixed = true;
  }
  const clipped = cs.clip === 'rect(0px, 0px, 0px, 0px)' || /^inset\(50%/.test(cs.clipPath) || (r.width <= 1 && r.height <= 1);
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
  if (fixed) out.fixed = true;
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

/** After the walk: blur, drop the selection, put scroll-behavior and the scroll position back. Reports what it left. */
export function kbRestore(start) {
  const kb = window.__hargusKb;
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  el?.blur?.();
  document.activeElement?.blur?.();
  try { getSelection().removeAllRanges(); } catch { /* no selection API */ }
  const root = document.documentElement;
  if (kb) {
    if (kb.prior) root.style.setProperty('scroll-behavior', kb.prior, kb.priorPrio);
    else root.style.removeProperty('scroll-behavior');
    if (!kb.hadStyle && !root.getAttribute('style')) root.removeAttribute('style');
  }
  if (start) scrollTo({ left: start.scrollX || 0, top: start.scrollY || 0, behavior: 'instant' });
  delete window.__hargusKb;
  return { active: document.activeElement?.localName || null, scrollX, scrollY };
}
