// Translated views: page functions run in the captured tab's main world through capture.evaluate().
// Each is serialised on its own (fnSource), so each is self-contained: no shared helpers, no imports.
// Translation uses Chrome's on-device Translator only; no text leaves the machine.
// Page state: window.__harplusTranslated ([node, original, translated] per text node; translated is null for text
// that could not be translated), window.__harplusTranslatedAttrs ([element, name, original, translated]),
// window.__harplusTranslateKeep (the keeper, its translator, plus what leftoverText needs) and
// window.__harplusTranslateCancelled (set by restoreTranslation: a create() that resolves late must not translate).
// The page is walked as the reader sees it: the document, its open shadow roots and its same-origin frames.

/**
 * Translate the page's visible text and a few text attributes from `source` to `target` (canonical primary subtags).
 * Throws with the API's message when the translator cannot be made, and when nothing at all could be translated.
 * Bounded: create() (with its retry) by timeoutMs; translating by budgetMs (counted from when the translator is
 * ready); the whole call by totalMs (counted from the start); each call at most callMs; at most `cap` text blocks.
 */
export async function translatePage({ source, target, timeoutMs = 60_000, budgetMs = 100_000, totalMs = Infinity, callMs = 5000, cap = 5000 }) {
  const start = performance.now();
  const gen = (window.__harplusTranslateGen = (window.__harplusTranslateGen || 0) + 1);
  window.__harplusTranslateCancelled = false;
  if (typeof Translator === 'undefined') throw new Error('Translator is not defined in this browser');
  const race = (p, ms, message) => {
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(message), { name: 'TimeoutError' })), ms); });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  };
  const destroy = (t) => { try { t?.destroy?.(); } catch { /* already gone */ } };
  const make = () => {
    const p = Promise.resolve().then(() => Translator.create({ sourceLanguage: source, targetLanguage: target }));
    const ms = Math.max(1, timeoutMs - (performance.now() - start));
    // A create() given up on that resolves later is destroyed, so its model is not held for nothing.
    return race(p, ms, `Translator create timed out after ${Math.round(timeoutMs / 1000)}s`).catch((e) => { p.then(destroy, () => {}); throw e; });
  };
  let translator;
  // The first create() in a browser session fails with NotSupportedError; a second one works.
  try { translator = await make(); } catch (e) {
    if (e?.name !== 'NotSupportedError') throw e;
    translator = await make();
  }
  // The view was given up (restored) while create() was pending, or a newer view started: leave the page alone.
  if (window.__harplusTranslateCancelled || window.__harplusTranslateGen !== gen) {
    destroy(translator);
    return { translated: 0, eligible: 0, cancelled: true };
  }
  const t0 = performance.now(); // the budget starts once the model is ready: a download does not eat it
  const left = () => Math.min(budgetMs - (performance.now() - t0), totalMs - (performance.now() - start));

  const stale = window.__harplusTranslateKeep; // an earlier view's keeper, if its restore failed
  if (stale) { stale.stopped = true; stale.observer?.disconnect(); destroy(stale.translator); }
  const html = document.documentElement;
  // A stale keeper means <html> may still hold that view's language: the page's own is the one it saved.
  const origLang = stale && 'origLang' in stale ? stale.origLang : html.getAttribute('lang');
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|SVG)$/i;
  // Primary subtag, canonicalised as core/language.js primary() does (iw → he, …).
  const ALIAS = { iw: 'he', in: 'id', ji: 'yi', jw: 'jv', mo: 'ro', tl: 'fil', nb: 'no', nn: 'no' };
  const primary = (tag) => { const m = /^\s*([a-z]{2,3})(?![a-z])/i.exec(String(tag ?? '')); if (!m) return ''; const c = m[1].toLowerCase(); return ALIAS[c] || c; };
  // The page's own lang on <html>: the view sets the target there, which must not block the page's own text.
  const langOf = (el) => (el === html ? origLang : el.getAttribute('lang'));
  // Up the tree, across shadow boundaries (a shadow root's top elements have the host above them).
  const up = (el) => el.parentElement || el.parentNode?.host || null;
  // Skipped like the Long text view, plus translate="no" and passages marked as another language than the source.
  const blocked = (el) => {
    let langSeen = false;
    for (; el; el = up(el)) {
      if (SKIP.test(el.tagName) || el.getAttribute('translate') === 'no') return true;
      const lang = langSeen ? null : langOf(el);
      if (lang != null) {
        langSeen = true;
        const l = primary(lang);
        if (l && l !== source) return true;
      }
    }
    return false;
  };
  const shownCache = new Map();
  const shown = (el) => {
    if (!shownCache.has(el)) shownCache.set(el, el.getClientRects().length > 0 && (el.ownerDocument.defaultView || window).getComputedStyle(el).visibility === 'visible');
    return shownCache.get(el);
  };
  // The document, then each open shadow root and same-origin frame in document order (leftoverText walks the same).
  const roots = [];
  const addRoot = (root) => {
    if (!root || roots.length >= 500) return;
    roots.push(root);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) addRoot(el.shadowRoot);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let doc = null;
        try { doc = el.contentDocument; } catch { /* cross-origin */ }
        if (doc?.body && shown(el)) addRoot(doc.body);
      }
    }
  };
  addRoot(document.body || html);
  const eligible = (n) => !!n.textContent.trim() && !!n.parentElement && !blocked(n.parentElement);

  // One translate() per distinct string (repeated labels are common); sequential, as parallel calls give no speed-up.
  // Each resolves to { out } or { miss: 'budget' | 'error' }: a miss is untranslated text, never "returned unchanged".
  const cache = new Map();
  let failure = null; // the first translate() error, for the "nothing could be translated" message
  let queue = Promise.resolve();
  const translate = (core) => {
    if (!cache.has(core)) {
      const p = queue.then(async () => {
        const ms = left();
        if (ms <= 0) return { miss: 'budget' };
        try {
          const out = await race(Promise.resolve(translator.translate(core)), Math.min(callMs, ms), 'translate() timed out');
          return { out: String(out ?? core) };
        } catch (e) {
          failure ||= e;
          return { miss: e?.name === 'TimeoutError' && left() <= 0 ? 'budget' : 'error' };
        }
      });
      queue = p;
      cache.set(core, p);
    }
    return cache.get(core);
  };
  const split = (text) => { const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text); return [m[1], m[2], m[3]]; };

  const saved = (window.__harplusTranslated = []);
  const attrs = (window.__harplusTranslatedAttrs = []);
  const entries = new Map(); // node → its [node, original, translated] entry
  const handled = new WeakMap(); // node → the text it should hold now (our translation, or what the translator left unchanged)
  const untranslated = new WeakMap(); // node → 'budget' | 'error', for text the translator never translated
  // stopped: set by restoreTranslation, so a translation still in flight never lands on the restored page.
  // capped: eligible text blocks beyond `cap`, never translated.
  const keep = (window.__harplusTranslateKeep = { count: 0, source, target, origLang, cap, capped: 0, translator, handled, untranslated, stopped: false });
  // The view's language on <html> (restoreTranslation puts the page's own back).
  html.setAttribute('lang', target);
  const entryFor = (n, text) => {
    let entry = entries.get(n);
    if (!entry) { entry = [n, text, null]; saved.push(entry); entries.set(n, entry); }
    entry[1] = text; // the page's latest text is what restoreTranslation puts back
    return entry;
  };
  const apply = async (n) => {
    const text = n.textContent;
    const [lead, core, trail] = split(text);
    const got = await translate(core);
    if (keep.stopped || n.textContent !== text) return false; // restored, or the page changed it meanwhile (the keeper sees that)
    if (got.miss) {
      // Counted by the self-check (it holds no translation) and by leftoverText; restore leaves it alone.
      entryFor(n, text)[2] = null;
      untranslated.set(n, got.miss);
      return false;
    }
    untranslated.delete(n);
    if (got.out === core) { handled.set(n, text); return false; }
    const written = lead + got.out + trail;
    entryFor(n, text)[2] = written;
    handled.set(n, written);
    n.textContent = written;
    return true;
  };

  // Keeper, watching from the start: text the page writes or adds while the view is up is translated too — up to
  // 200 rounds, so a page that fights back cannot livelock the tab. Our own writes are recognised by `handled`.
  const redo = (n) => {
    if (n.nodeType !== 3 || n.textContent === handled.get(n)) return false;
    const entry = entries.get(n);
    if (entry) entry[1] = n.textContent; // a saved node the page rewrote: restore must put back this latest text
    else if (saved.length >= 20000) return false;
    if (!eligible(n)) return false;
    apply(n);
    return true;
  };
  keep.observer = new MutationObserver((records) => {
    if (keep.count >= 200) { keep.observer.disconnect(); keep.gaveUp = true; return; }
    let hit = false;
    for (const m of records) {
      if (m.type === 'characterData') { hit = redo(m.target) || hit; continue; }
      for (const n of m.addedNodes) {
        if (n.nodeType === 3) { hit = redo(n) || hit; continue; }
        if (n.nodeType !== 1) continue;
        const w = n.ownerDocument.createTreeWalker(n, NodeFilter.SHOW_TEXT);
        for (let t = w.nextNode(); t; t = w.nextNode()) hit = redo(t) || hit;
      }
    }
    if (hit) keep.count++;
  });
  for (const root of roots) keep.observer.observe(root, { subtree: true, childList: true, characterData: true });

  // Eligible, visible text blocks, counted the same way by leftoverText: the first `cap` are translated.
  const nodes = [];
  for (const root of roots) {
    const walker = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!eligible(n) || !shown(n.parentElement)) continue;
      if (nodes.length < cap) nodes.push(n);
      else if (++keep.capped >= 100_000) break;
    }
  }
  const results = await Promise.all(nodes.map(apply));

  // Attributes, translated once at the start.
  const jobs = [];
  for (const root of roots) {
    for (const el of root.querySelectorAll('[placeholder], [alt], [aria-label], [title], input[type=submit], input[type=button], input[type=reset]')) {
      if (jobs.length >= cap) break;
      if (blocked(el)) continue;
      const names = ['placeholder', 'alt', 'aria-label', 'title'].filter((a) => el.getAttribute(a)?.trim());
      if (el.matches('input[type=submit], input[type=button], input[type=reset]') && el.value.trim()) names.push('value');
      for (const name of names) {
        const original = name === 'value' ? el.value : el.getAttribute(name);
        jobs.push(translate(original.trim()).then((got) => {
          const now = name === 'value' ? el.value : el.getAttribute(name);
          if (keep.stopped || got.miss || got.out === original.trim() || now !== original) return;
          if (name === 'value') el.value = got.out; else el.setAttribute(name, got.out);
          attrs.push([el, name, original, got.out]);
        }));
      }
    }
  }
  await Promise.all(jobs);
  const translated = results.filter(Boolean).length + attrs.length;
  const total = nodes.length + jobs.length;
  if (total && !translated) {
    destroy(translator);
    keep.translator = null;
    throw new Error(`nothing could be translated${failure ? `: ${failure.message}` : ''}`);
  }
  return { translated, eligible: total, ...(keep.capped ? { capped: keep.capped } : {}) };
}

/** Put the original text, attributes and lang back; a value the page set since (not our translation) is kept. */
export function restoreTranslation() {
  // A create() still pending for this view must not translate once it resolves.
  window.__harplusTranslateCancelled = true;
  const keep = window.__harplusTranslateKeep;
  if (keep) keep.stopped = true;
  keep?.observer?.disconnect();
  try { keep?.translator?.destroy?.(); } catch { /* already gone */ }
  delete window.__harplusTranslateKeep;
  for (const [node, original, translated] of window.__harplusTranslated || []) if (translated != null && node.textContent === translated) node.textContent = original;
  for (const [el, name, original, translated] of window.__harplusTranslatedAttrs || []) {
    if (name === 'value') { if (el.value === translated) el.value = original; } else if (el.getAttribute(name) === translated) el.setAttribute(name, original);
  }
  delete window.__harplusTranslated;
  delete window.__harplusTranslatedAttrs;
  if (keep && 'origLang' in keep) {
    const html = document.documentElement;
    if (keep.origLang == null) html.removeAttribute('lang'); else html.setAttribute('lang', keep.origLang);
  }
  return true;
}

/**
 * Visible text (2+ words) the translation never reached, after it settled. Text the translator returned unchanged
 * and skipped text (translate="no", other-language passages, code) are not leftovers. Text the translator was given
 * but could not translate counts as `budget` (time ran out) or `error`; text past the node cap counts once as `cap`.
 * Walks what translatePage walks: the document, open shadow roots and same-origin frames.
 */
export function leftoverText() {
  const keep = window.__harplusTranslateKeep || {};
  const { handled, untranslated } = keep;
  const source = keep.source || 'en';
  const cap = keep.cap || 5000;
  const causes = { iframe: 0, cssContent: 0, svg: 0, canvas: 0, late: 0, budget: 0, error: 0, cap: 0 };
  const examples = [];
  const note = (cause, text) => {
    causes[cause]++;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t && examples.length < 5 && !examples.includes(t)) examples.push(t.length > 80 ? `${t.slice(0, 79)}…` : t);
  };
  const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
  const shownCache = new Map();
  const shown = (el) => {
    if (!shownCache.has(el)) shownCache.set(el, el.getClientRects().length > 0 && (el.ownerDocument.defaultView || window).getComputedStyle(el).visibility === 'visible');
    return shownCache.get(el);
  };
  const html = document.documentElement;
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|SVG)$/i;
  const ALIAS = { iw: 'he', in: 'id', ji: 'yi', jw: 'jv', mo: 'ro', tl: 'fil', nb: 'no', nn: 'no' };
  const primary = (tag) => { const m = /^\s*([a-z]{2,3})(?![a-z])/i.exec(String(tag ?? '')); if (!m) return ''; const c = m[1].toLowerCase(); return ALIAS[c] || c; };
  // <html> holds the view's language while the view is up: the page's own is what counts.
  const langOf = (el) => (el === html && 'origLang' in keep ? keep.origLang : el.getAttribute('lang'));
  const up = (el) => el.parentElement || el.parentNode?.host || null;
  // What translatePage skips on purpose: not a leftover. skipTags false: only translate="no" and other-language marks.
  const blocked = (el, skipTags = true) => {
    let langSeen = false;
    for (; el; el = up(el)) {
      if ((skipTags && SKIP.test(el.tagName)) || el.getAttribute('translate') === 'no') return true;
      const lang = langSeen ? null : langOf(el);
      if (lang != null) {
        langSeen = true;
        const l = primary(lang);
        if (l && l !== source) return true;
      }
    }
    return false;
  };
  const roots = [];
  const addRoot = (root) => {
    if (!root || roots.length >= 500) return;
    roots.push(root);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) addRoot(el.shadowRoot);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let doc = null;
        try { doc = el.contentDocument; } catch { /* cross-origin */ }
        if (doc?.body && shown(el)) addRoot(doc.body);
        else if (!doc && shown(el)) {
          let host = '';
          try { host = new URL(el.src, location.href).host; } catch { /* no src */ }
          note('iframe', host || 'iframe');
        }
      }
    }
  };
  addRoot(document.body || html);

  let walked = 0;
  for (const root of roots) {
    for (const el of root.querySelectorAll('*')) {
      if (++walked > 5000) break;
      for (const pe of ['::before', '::after']) {
        const c = (el.ownerDocument.defaultView || window).getComputedStyle(el, pe).content;
        if (!c || c === 'none' || c === 'normal' || !c.includes('"')) continue;
        const text = [...c.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('');
        if (words(text) >= 2 && shown(el) && !blocked(el, false)) note('cssContent', text);
      }
    }
    for (const t of root.querySelectorAll('svg text')) if (words(t.textContent) >= 2 && shown(t) && !blocked(t, false)) note('svg', t.textContent);
    for (const c of root.querySelectorAll('canvas')) if (c.width && c.height && shown(c)) note('canvas', '');
  }

  if (handled) {
    // Eligible, visible text blocks in translatePage's order: past the cap they were never meant to be translated.
    let n = 0;
    walk: for (const root of roots) {
      const w = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        if (!t.textContent.trim() || !t.parentElement || blocked(t.parentElement) || !shown(t.parentElement)) continue;
        if (n++ >= cap) break walk;
        if (handled.get(t) === t.textContent || words(t.textContent) < 2) continue;
        note(untranslated?.get(t) || 'late', t.textContent);
      }
    }
    if (keep.capped) causes.cap = 1; // once per view: the page is longer than the cap
  }
  const count = Object.values(causes).reduce((a, b) => a + b, 0);
  return { count, examples, causes, source, ...(causes.cap ? { cap } : {}) };
}
