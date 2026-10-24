// Translated views: page functions run in the captured tab's main world through capture.evaluate().
// Each is serialised on its own (fnSource), so each is self-contained: no shared helpers, no imports.
// Translation uses Chrome's on-device Translator only; no text leaves the machine.
// Page state: window.__harplusTranslated ([node, original, translated] per text node), window.__harplusTranslatedAttrs
// ([element, name, original, translated]) and window.__harplusTranslateKeep (the keeper, plus what leftoverText needs).

/**
 * Translate the page's visible text and a few text attributes from `source` to `target`.
 * Throws with the API's message when the translator cannot be made (the caller classifies it).
 */
export async function translatePage({ source, target, timeoutMs = 60_000, budgetMs = 100_000, cap = 5000 }) {
  if (typeof Translator === 'undefined') throw new Error('Translator is not defined in this browser');
  const t0 = performance.now();
  const race = (p) => {
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Translator create timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs); });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  };
  const make = () => race(Translator.create({ sourceLanguage: source, targetLanguage: target }));
  let translator;
  // The first create() in a browser session fails with NotSupportedError; a second one works.
  try { translator = await make(); } catch (e) {
    if (e?.name !== 'NotSupportedError') throw e;
    translator = await make();
  }

  window.__harplusTranslateKeep?.observer?.disconnect(); // an earlier view's keeper, if its restore failed
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|SVG)$/i;
  // Skipped like the Long text view, plus translate="no" and passages marked as another language than the source.
  const blocked = (el) => {
    let langSeen = false;
    for (; el; el = el.parentElement) {
      if (SKIP.test(el.tagName) || el.getAttribute('translate') === 'no') return true;
      if (!langSeen && el.hasAttribute('lang')) {
        langSeen = true;
        const l = (el.getAttribute('lang') || '').trim().toLowerCase().split(/[-_]/)[0];
        if (l && l !== source) return true;
      }
    }
    return false;
  };
  const shownCache = new Map();
  const shown = (el) => {
    if (!shownCache.has(el)) shownCache.set(el, el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible');
    return shownCache.get(el);
  };
  const eligible = (n) => !!n.textContent.trim() && !!n.parentElement && !blocked(n.parentElement);

  // One translate() per distinct string (repeated labels are common); sequential, as parallel calls give no speed-up.
  const cache = new Map();
  let failure = null; // the first translate() error: a translator that fails every string fails the view
  let queue = Promise.resolve();
  const translate = (core) => {
    if (!cache.has(core)) {
      const p = queue.then(() => (performance.now() - t0 > budgetMs ? core : translator.translate(core))).then((out) => String(out ?? core), (e) => { failure ||= e; return core; });
      queue = p;
      cache.set(core, p);
    }
    return cache.get(core);
  };
  const split = (text) => { const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text); return [m[1], m[2], m[3]]; };

  const top = document.body || document.documentElement;
  const saved = (window.__harplusTranslated = []);
  const attrs = (window.__harplusTranslatedAttrs = []);
  const entries = new Map(); // node → its [node, original, translated] entry
  const handled = new WeakMap(); // node → the text it should hold now (our translation, or what the translator left unchanged)
  // stopped: set by restoreTranslation, so a translation still in flight never lands on the restored page.
  const keep = (window.__harplusTranslateKeep = { count: 0, source, handled, stopped: false });
  const apply = async (n) => {
    const text = n.textContent;
    const [lead, core, trail] = split(text);
    const out = await translate(core);
    if (keep.stopped || n.textContent !== text) return false; // restored, or the page changed it meanwhile (the keeper sees that)
    if (out === core) { handled.set(n, text); return false; }
    const written = lead + out + trail;
    let entry = entries.get(n);
    if (!entry) { entry = [n, text, written]; saved.push(entry); entries.set(n, entry); }
    entry[1] = text; // the page's latest text is what restoreTranslation puts back
    entry[2] = written;
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
        const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
        for (let t = w.nextNode(); t; t = w.nextNode()) hit = redo(t) || hit;
      }
    }
    if (hit) keep.count++;
  });
  keep.observer.observe(top, { subtree: true, childList: true, characterData: true });

  const nodes = [];
  const walker = document.createTreeWalker(top, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && nodes.length < cap; n = walker.nextNode()) if (eligible(n) && shown(n.parentElement)) nodes.push(n);
  const results = await Promise.all(nodes.map(apply));

  // Attributes, translated once at the start.
  const jobs = [];
  for (const el of top.querySelectorAll('[placeholder], [alt], [aria-label], [title], input[type=submit], input[type=button], input[type=reset]')) {
    if (jobs.length >= cap) break;
    if (blocked(el)) continue;
    const names = ['placeholder', 'alt', 'aria-label', 'title'].filter((a) => el.getAttribute(a)?.trim());
    if (el.matches('input[type=submit], input[type=button], input[type=reset]') && el.value.trim()) names.push('value');
    for (const name of names) {
      const original = name === 'value' ? el.value : el.getAttribute(name);
      jobs.push(translate(original.trim()).then((out) => {
        const now = name === 'value' ? el.value : el.getAttribute(name);
        if (keep.stopped || out === original.trim() || now !== original) return;
        if (name === 'value') el.value = out; else el.setAttribute(name, out);
        attrs.push([el, name, original, out]);
      }));
    }
  }
  await Promise.all(jobs);
  const translated = results.filter(Boolean).length + attrs.length;
  if (!translated && failure) throw failure;
  return { translated, eligible: nodes.length + jobs.length };
}

/** Put the original text and attributes back; a value the page set since (not our translation) is kept. */
export function restoreTranslation() {
  const keep = window.__harplusTranslateKeep;
  if (keep) keep.stopped = true;
  keep?.observer?.disconnect();
  delete window.__harplusTranslateKeep;
  for (const [node, original, translated] of window.__harplusTranslated || []) if (node.textContent === translated) node.textContent = original;
  for (const [el, name, original, translated] of window.__harplusTranslatedAttrs || []) {
    if (name === 'value') { if (el.value === translated) el.value = original; } else if (el.getAttribute(name) === translated) el.setAttribute(name, original);
  }
  delete window.__harplusTranslated;
  delete window.__harplusTranslatedAttrs;
  return true;
}

/**
 * Visible text (2+ words) the translation never reached, after it settled. Text the translator returned unchanged
 * and skipped text (translate="no", other-language passages, code) are not leftovers.
 */
export function leftoverText() {
  const keep = window.__harplusTranslateKeep || {};
  const handled = keep.handled;
  const source = keep.source || 'en';
  const causes = { iframe: 0, cssContent: 0, svg: 0, canvas: 0, late: 0 };
  const examples = [];
  const note = (cause, text) => {
    causes[cause]++;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t && examples.length < 5 && !examples.includes(t)) examples.push(t.length > 80 ? `${t.slice(0, 79)}…` : t);
  };
  const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
  const top = document.body || document.documentElement;

  for (const f of top.querySelectorAll('iframe')) {
    let reachable = false;
    try { reachable = !!f.contentDocument; } catch { /* cross-origin */ }
    if (reachable || !shown(f)) continue;
    let host = '';
    try { host = new URL(f.src, location.href).host; } catch { /* no src */ }
    note('iframe', host || 'iframe');
  }
  let walked = 0;
  for (const el of top.querySelectorAll('*')) {
    if (++walked > 5000) break;
    for (const pe of ['::before', '::after']) {
      const c = getComputedStyle(el, pe).content;
      if (!c || c === 'none' || c === 'normal' || !c.includes('"')) continue;
      const text = [...c.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('');
      if (words(text) >= 2 && shown(el)) note('cssContent', text);
    }
  }
  for (const t of top.querySelectorAll('svg text')) if (words(t.textContent) >= 2 && shown(t)) note('svg', t.textContent);
  for (const c of top.querySelectorAll('canvas')) if (c.width && c.height && shown(c)) note('canvas', '');

  if (handled) {
    const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|SVG)$/i;
    const blocked = (el) => {
      let langSeen = false;
      for (; el; el = el.parentElement) {
        if (SKIP.test(el.tagName) || el.getAttribute('translate') === 'no') return true;
        if (!langSeen && el.hasAttribute('lang')) {
          langSeen = true;
          const l = (el.getAttribute('lang') || '').trim().toLowerCase().split(/[-_]/)[0];
          if (l && l !== source) return true;
        }
      }
      return false;
    };
    const w = document.createTreeWalker(top, NodeFilter.SHOW_TEXT);
    let n = 0;
    for (let t = w.nextNode(); t && n < 5000; t = w.nextNode(), n++) {
      if (handled.get(t) === t.textContent || words(t.textContent) < 2 || !t.parentElement) continue;
      if (blocked(t.parentElement) || !shown(t.parentElement)) continue;
      note('late', t.textContent);
    }
  }
  const count = Object.values(causes).reduce((a, b) => a + b, 0);
  return { count, examples, causes };
}
