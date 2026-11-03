// Language & text: is the declared language the language of the text, is the encoding consistent,
// and will the text survive translation (untagged passages, untranslated attributes, hard-coded
// formats, garbled characters). The page-side collector gathers samples; this file decides.
// Detection uses chrome.i18n.detectLanguage via ctx.detectLanguage, else a writing-system check.

import { PATTERNS, classifyFormat, hasGarbled, stripGarbled, scriptOf, SCRIPT_OF_LANG, primary, sameLanguage, normCharset, languageName } from '../core/language.js';
import { resHeader, resourceType } from '../core/har-util.js';

const PAGE_MIN = 200;
const BLOCK_MIN = 60;
const MIN_SHARE = 0.6;
const ITEM_MIN_LETTERS = 20; // an alt or label shorter than this is not judged for language
const MAX_ITEMS = 60; // per group, so a page with thousands of alts doesn't stall
const SCRIPT_SHARE = 0.8;

// 'und', 'mul', 'zxx' and '' mean "no usable language": never compared, on either side.
const NO_LANG = new Set(['', 'und', 'mul', 'zxx']);
const usable = (tag) => !NO_LANG.has(primary(tag));
const differs = (a, b) => usable(a) && usable(b) && !sameLanguage(a, b);
// Kanji-only text reads as Chinese or Japanese alike: without kana it is taken as the page's own language on a ja or zh page.
const CJK = new Set(['ja', 'zh']);
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const hanAsPage = (code, declared, text) => CJK.has(primary(code)) && CJK.has(primary(declared)) && !KANA.test(String(text || ''));

const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const num = (n) => (Number.isFinite(n) ? n : 0);
const count = (o) => num(o?.count);
const MAX_PLACES = 200;
// Places are the elements (by selector) with a short quote of their text, or a quote alone where no element is known.
const quote = (t) => clip(t, 120);
const elementPlaces = (list, pick) => list.slice(0, MAX_PLACES).map(pick).filter((p) => p.selector || p.text);
const quotePlaces = (examples) => (Array.isArray(examples) ? examples : []).filter((e) => e != null && String(e).trim())
  .slice(0, MAX_PLACES).map((e) => ({ text: String(e) }));
const sel = (x) => (typeof x === 'string' ? x : '');

// HAR main document per spec 1.3.
function mainDocument(reading, target = {}) {
  const docs = (reading?.log?.entries || []).filter((e) => resourceType(e) === 'document');
  return docs.find((e) => e.request?.url && (e.request.url === target.finalUrl || e.request.url === target.url)) || docs[0] || null;
}

function headerCharset(entry) {
  const m = /charset\s*=\s*("?)([^;"\s]+)\1/i.exec(resHeader(entry, 'content-type') || '');
  return m ? m[2].toLowerCase() : null;
}

async function run(reading, ctx) {
  const c = ctx.collected;
  if (!c || !(c.regions || []).some((r) => num(r.chars) > 0)) ctx.skip('No visible text to check');
  const doc = mainDocument(reading, ctx.target);
  const hdrCharset = doc ? headerCharset(doc) : null;
  const contentLanguage = doc ? (resHeader(doc, 'content-language') || '').trim() || null : null;
  const declared = String(c.htmlLang ?? '').trim();
  const declaredName = declared ? languageName(primary(declared)) : '';
  const regions = c.regions || [];
  const blocks = c.blocks || [];
  const attrs = c.attrs || [];

  // ---- detection (cached; the detector may be absent, throw, or resolve null)
  const cache = new Map();
  let usedDetector = false;
  const callDetector = async (text) => {
    if (typeof ctx.detectLanguage !== 'function') return null;
    try {
      const r = await ctx.detectLanguage(text);
      const code = primary(r?.code);
      return code && Number.isFinite(r.share) ? { code, share: r.share, reliable: !!r.reliable } : null;
    } catch { return null; }
  };
  const detect = (text, minChars) => {
    const key = `${minChars}\u0000${text}`;
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        const len = String(text || '').length;
        const r = await callDetector(text);
        if (r) {
          usedDetector = true;
          return { method: 'detector', code: r.code, share: r.share, counted: r.reliable && len >= minChars && r.share >= MIN_SHARE };
        }
        const s = scriptOf(text);
        return { method: 'script', script: s.script, share: s.share, counted: len >= minChars && !!s.script && s.share >= SCRIPT_SHARE };
      })());
    }
    return cache.get(key);
  };
  const countedCode = (d) => (d.counted && d.method === 'detector' && usable(d.code) ? d.code : null);

  const findings = [];
  let method = 'script';
  const flags = {};
  const pending = [];
  const add = (id, severity, title, detail, extra = {}, m, places = [], subject) => pending.push({ id, subject, severity, title, detail, extra, m, places });

  // L1
  if (!declared || !usable(declared)) add('missing-lang', 'medium', "The page doesn't say which language it is in", 'Add <html lang="…"> so browsers, translators and screen readers pick the right language.');

  // L3 / L4: blocks
  // Blocks with mojibake or U+FFFD are not detected: the garbage skews the result.
  const blockDet = await Promise.all(blocks.map((b) => (hasGarbled(b.text)
    ? { method: 'skipped', counted: false }
    : detect(String(b.text || ''), BLOCK_MIN))));
  const detectedCodes = {};
  let detectedBlocks = 0;
  const untagged = new Map();
  const wrong = new Map();
  blocks.forEach((b, i) => {
    const code = countedCode(blockDet[i]);
    if (!code) return;
    detectedBlocks++;
    detectedCodes[code] = (detectedCodes[code] || 0) + 1;
    if (b.own == null) {
      if (differs(code, b.lang)) {
        if (!untagged.has(code)) untagged.set(code, []);
        untagged.get(code).push(b);
      }
    } else if (differs(code, b.own)) {
      const key = primary(b.own); // 'DE' and 'de' are one group
      if (!wrong.has(key)) wrong.set(key, { label: b.own, list: [] });
      wrong.get(key).list.push({ b, code });
    }
  });
  // The most common detection per L4 group; a block inheriting that lang and reading as the same
  // language is already covered by the L4 finding, so L3 stays quiet for it.
  const wrongTop = new Map();
  for (const [key, { list }] of wrong) {
    const tally = new Map();
    for (const e of list) tally.set(e.code, (tally.get(e.code) || 0) + 1);
    wrongTop.set(key, [...tally].sort((a, b) => b[1] - a[1])[0][0]);
  }
  for (const [code, list] of untagged) {
    const kept = list.filter((b) => wrongTop.get(primary(b.lang)) !== code);
    if (kept.length) untagged.set(code, kept); else untagged.delete(code);
  }

  // L2: the declared region's whole sample
  let detected = null;
  let detectedScript = null;
  let majority = false;
  if (declared && usable(declared)) {
    // Untagged blocks in the declared language first (they are whole paragraphs), then topped up from the regions.
    // Passages that read as another language (the L3 candidates) are left out, so one German paragraph
    // cannot make an English page look German -- unless they are most of the page's block text, in which
    // case the page itself is mislabelled: they stay in, and L3 is dropped for the language L2 reports.
    const cands = blocks.filter((b) => b.own == null && sameLanguage(b.lang, declared) && !hasGarbled(b.text));
    const passages = new Set([...untagged.values()].flat());
    const len = (list) => list.reduce((s, b) => s + String(b.text || '').length, 0);
    const excluded = cands.filter((b) => passages.has(b));
    // "Most of the page" is measured against all the declared-language text, not just the long blocks:
    // a lone German paragraph can be the only long block on an English page full of short UI text.
    const pageText = Math.max(len(cands), regions.filter((r) => sameLanguage(r.lang, declared)).reduce((s, r) => s + num(r.chars), 0));
    majority = excluded.length > 0 && len(excluded) * 2 >= pageText;
    const drop = majority ? [] : excluded;
    let joined = cands.filter((b) => !drop.includes(b)).map((b) => String(b.text || '')).join(' ').slice(0, 4000);
    for (const r of regions) {
      if (joined.length >= 4000) break;
      if (!sameLanguage(r.lang, declared)) continue;
      let s = String(r.sample || '');
      for (const b of drop) s = s.split(String(b.text || '')).join(' ');
      joined = `${joined}${joined ? ' ' : ''}${s}`.slice(0, 4000);
    }
    const sample = stripGarbled(joined);
    if (sample) {
      const d = await detect(sample, PAGE_MIN);
      if (d.method === 'detector') {
        if (d.counted && usable(d.code)) detected = { code: d.code, share: d.share };
        if (detected && differs(d.code, declared)) {
          flags.mismatch = true;
          if (majority) { // the page is mislabelled: its passages in this language are not separate findings
            const kept = (untagged.get(d.code) || []).filter((b) => !sameLanguage(b.lang, declared));
            if (kept.length) untagged.set(d.code, kept); else untagged.delete(d.code);
          }
          add('declared-lang-mismatch', 'high', `Page says lang="${declared}" but its text is mostly ${languageName(d.code)} (${Math.round(d.share * 100)}%)`,
            'Screen readers and translation tools trust the lang attribute, so they will mispronounce or mistranslate the text.', {}, 'detector');
        }
      } else if (d.counted) {
        const expected = SCRIPT_OF_LANG[primary(declared)];
        if (expected && d.script !== 'Other' && !expected.includes(d.script)) {
          flags.mismatch = true;
          detectedScript = d.script;
          add('declared-lang-mismatch', 'high', `Page says lang="${declared}" but its text is mostly ${d.script} script`,
            'Screen readers and translation tools trust the lang attribute, so they will mispronounce or mistranslate the text.', {}, 'script');
        }
      }
    }
  }

  const pageChars = regions.reduce((s, r) => s + num(r.chars), 0);
  let untaggedBlocks = 0;
  for (const [code, list] of untagged) {
    untaggedBlocks += list.length;
    const share = pageChars ? list.reduce((s, b) => s + String(b.text || '').length, 0) / pageChars : 0;
    const n = list.length;
    add('untagged-passages', n >= 3 || share >= 0.15 ? 'medium' : 'low',
      `${n} ${plural(n, 'passage')} in ${languageName(code)} ${n === 1 ? 'has' : 'have'} no lang attribute`,
      `Mark them up, for example <span lang="${code}">. ${list.slice(0, 5).map((b) => b.sel).join(', ')}`,
      { selectors: list.slice(0, 5).map((b) => b.sel) }, 'detector',
      elementPlaces(list, (b) => ({ selector: sel(b.sel), text: quote(b.text) })), code);
  }
  let wrongBlocks = 0;
  for (const [key, { label: x, list }] of wrong) {
    wrongBlocks += list.length;
    const code = wrongTop.get(key);
    add('wrong-lang-attribute', 'medium', `lang="${x}" is on text that reads as ${languageName(code)}`,
      `${list.slice(0, 5).map((e) => e.b.sel).join(', ')} — “${clip(list[0].b.text, 60)}”`,
      { selectors: list.slice(0, 5).map((e) => e.b.sel) }, 'detector',
      elementPlaces(list, (e) => ({ selector: sel(e.b.sel), text: quote(e.b.text), note: `reads as ${languageName(e.code)}` })), key);
  }

  // L5: attribute text, one batch per group
  const attrIssues = [];
  let attrChecked = false;
  let attrDetected = false;
  if (declared && usable(declared)) {
    for (const [group, noun, pick] of [['alt', 'alt', (a) => a.name === 'alt'], ['label', 'label', (a) => a.name !== 'alt']]) {
      const list = attrs.filter((a) => pick(a) && !a.cross && (!usable(a.lang) || sameLanguage(a.lang, declared))
        && (String(a.text || '').match(/\p{L}/gu) || []).length >= ITEM_MIN_LETTERS);
      if (list.length < 3) continue;
      attrChecked = true;
      // One text at a time: a few long texts in another language must not drag short ones along.
      const judged = list.slice(0, MAX_ITEMS);
      const dets = await Promise.all(judged.map((a) => detect(String(a.text || ''), 0)));
      const buckets = new Map();
      judged.forEach((a, i) => {
        const code = countedCode(dets[i]);
        if (!code) return;
        attrDetected = true;
        if (hanAsPage(code, declared, a.text)) return;
        if (!buckets.has(code)) buckets.set(code, []);
        buckets.get(code).push(a);
      });
      // One text in another language (a place name, a brand) is not a pattern: a language needs 2 texts or more.
      for (const [code, items] of buckets) {
        if (!differs(code, declared) || items.length < 2) continue;
        if (!attrIssues.includes(group)) attrIssues.push(group);
        const n = items.length;
        add('attribute-text-language', 'medium', `${n} ${noun} texts are in ${languageName(code)} on a ${declaredName} page`,
          `${items.slice(0, 5).map((a) => a.sel).join(', ')}`, { selectors: items.slice(0, 5).map((a) => a.sel) }, 'detector',
          elementPlaces(items, (a) => ({ selector: sel(a.sel), text: quote(a.text), note: `${a.name} attribute` })), `${group}-${code}`);
      }
    }
  }

  // L6
  if (contentLanguage && usable(declared)) {
    const entries = contentLanguage.split(',').map((s) => s.trim()).filter(usable);
    if (entries.length && !entries.some((e) => sameLanguage(e, declared))) {
      add('content-language-mismatch', 'low', `Content-Language says "${contentLanguage}" but the page says lang="${declared}"`, 'Make the header and the lang attribute agree, or drop the header.');
    }
  }

  // L7 / L8
  const metaCs = c.metaCharset ? String(c.metaCharset) : null;
  const docCs = c.docCharset ? String(c.docCharset) : null;
  const seen = [['Content-Type header', hdrCharset], ['meta tag', metaCs], ['browser', docCs]].filter(([, v]) => normCharset(v));
  const inconsistent = new Set(seen.map(([, v]) => normCharset(v))).size > 1;
  if (inconsistent) add('encoding-inconsistent', 'medium', 'Character encoding is declared inconsistently', seen.map(([k, v]) => `${k}: ${v}`).join('; '));
  const undeclared = !!doc && !normCharset(hdrCharset) && !normCharset(metaCs);
  if (undeclared) add('encoding-undeclared', 'low', 'No character encoding is declared', 'Send Content-Type: text/html; charset=utf-8, or add <meta charset="utf-8"> early in <head>.');

  // L9 / L10
  const moji = count(c.mojibake);
  const repl = count(c.replacement);
  const mojiExample = (c.mojibake?.examples || [])[0];
  if (moji >= 3) {
    add('garbled-text', 'high', `Text shows garbled characters such as "${mojiExample ?? '…'}"`, `${moji} places look like UTF-8 text decoded with the wrong encoding.`, {}, undefined, quotePlaces(c.mojibake?.examples));
  }
  if (repl >= 3) add('replacement-characters', 'medium', `${repl} replacement characters (�) appear in the text`, 'Characters that could not be decoded were replaced; check the file encoding.', {}, undefined, quotePlaces(c.replacement?.examples));

  // L11
  const f = { dates: { count: 0, examples: [] }, times: { count: 0, examples: [] }, money: { count: 0, examples: [] } };
  const bucket = { date: f.dates, time: f.times, money: f.money };
  for (const k of c.formats?.candidates || []) {
    const b = bucket[k?.kind];
    if (!b || !classifyFormat(k.kind, k.match, k.before, k.after)) continue;
    b.count++;
    if (b.examples.length < 10) b.examples.push(String(k.match));
  }
  const fmtTotal = count(f.dates) + count(f.times) + count(f.money);
  if (fmtTotal >= 3) {
    const part = (label, o) => `${label}: ${count(o)}${(o?.examples || []).length ? ` (${o.examples.slice(0, 3).join(', ')})` : ''}`;
    add('regional-formats', 'low', "Dates, times or prices are written in one region's format",
      [part('dates', f.dates), part('times', f.times), part('prices', f.money)].join('; '));
  }

  // L12
  const imgs = c.textImages || [];
  if (imgs.length) {
    add('text-in-images', 'info', `${imgs.length} large ${plural(imgs.length, 'image')} may contain text that can't be translated`,
      "If the words are part of the image, translators can't reach them.", { selectors: imgs.slice(0, 5).map((i) => i.sel) }, undefined,
      elementPlaces(imgs, (i) => ({ selector: sel(i.sel), ...(i.alt ? { text: quote(i.alt), note: 'alt text' } : {}) })));
  }
  if (c.truncated) add('sampling-truncated', 'info', 'Text sampling stopped early', 'The page has a lot of text; only part of it was checked.');

  method = usedDetector ? 'detector' : 'script';
  for (const p of pending) {
    findings.push({
      id: p.id, ...(p.subject ? { subject: p.subject } : {}),
      severity: p.severity, category: 'international', title: p.title,
      ...(p.detail ? { detail: p.detail } : {}),
      evidence: { ...p.extra, method: p.m || method },
      ...(p.places.length ? { places: p.places } : {}),
    });
  }

  const encoding = (normCharset(hdrCharset) ? hdrCharset : normCharset(metaCs) ? metaCs : docCs) || null;
  const summary = [];
  summary.push({
    label: 'Language',
    value: [declared || 'no lang', detected ? `${languageName(detected.code)} ${Math.round(detected.share * 100)}%` : detectedScript ? `${detectedScript} script` : null].filter(Boolean).join(' · '),
    rating: !usable(declared) || flags.mismatch ? 'poor' : 'good',
    headline: true,
  });
  if (encoding || undeclared) {
    summary.push({ label: 'Encoding', value: encoding ? String(encoding).toUpperCase() : 'undeclared', rating: inconsistent || moji >= 3 ? 'poor' : undeclared ? 'needs-improvement' : 'good' });
  }
  summary.push({ label: 'Formats', value: String(fmtTotal), rating: fmtTotal >= 3 ? 'needs-improvement' : 'good' });

  return {
    data: {
      method, declared: declared || null, detected, headerCharset: hdrCharset, contentLanguage, metaCharset: metaCs, docCharset: docCs,
      counts: {
        dates: count(f.dates), times: count(f.times), money: count(f.money), mojibake: moji, replacement: repl,
        textImages: imgs.length, untagged: untaggedBlocks, wrongLang: wrongBlocks, blocks: blocks.length, attrs: attrs.length,
      },
      detectedBlocks, detectedCodes, mismatch: !!flags.mismatch, detectedScript, attrIssues, attrChecked, attrDetected, inconsistent, undeclared, hasDoc: !!doc,
      mojibakeExample: mojiExample ?? null, truncated: !!c.truncated,
    },
    findings,
    summary,
  };
}

function glance(r, h) {
  const d = r.data;
  const n = d.counts;
  const items = [
    (d.detected || d.mismatch)
      ? { label: 'Declared language matches the text', ok: !d.mismatch, note: d.mismatch ? `reads as ${d.detected ? languageName(d.detected.code) : `${d.detectedScript} script`}` : '' }
      : usable(d.declared) && { label: 'Declared language matches the text', ok: null, note: "couldn't determine" },
    d.method === 'detector' && n.blocks > 0 && (d.detectedBlocks > 0
      ? { label: 'No untagged passages in other languages', ok: n.untagged + n.wrongLang === 0, note: n.untagged + n.wrongLang ? `${n.untagged} untagged, ${n.wrongLang} mislabelled` : '' }
      : { label: 'No untagged passages in other languages', ok: null, note: "couldn't determine" }),
    d.attrChecked && (d.attrDetected
      ? { label: 'Labels and alt text in the page language', ok: !d.attrIssues.length, note: d.attrIssues.join(', ') }
      : { label: 'Labels and alt text in the page language', ok: null, note: "couldn't determine" }),
    (d.hasDoc || d.metaCharset) && { label: 'Encoding declared and consistent', ok: !d.inconsistent && !d.undeclared, note: d.inconsistent ? 'declarations differ' : d.undeclared ? 'none declared' : '' },
    { label: 'No garbled characters', ok: n.mojibake < 3 && n.replacement < 3, note: n.mojibake >= 3 && d.mojibakeExample != null ? h.html`“${d.mojibakeExample}”` : n.replacement >= 3 ? `${n.replacement} replacement characters` : '' },
    { label: 'Dates and prices in a neutral format', ok: n.dates + n.times + n.money < 3, note: n.dates + n.times + n.money ? `${n.dates} dates, ${n.times} times, ${n.money} prices` : '' },
  ].filter(Boolean);
  return h.html`<div class="glance-grid"><section class="card"><h4>Language and text</h4>${h.checklist(items)}</section></div>`;
}

const METHOD_WORDS = { detector: "Chrome's language detector", script: 'writing-system check' };

/**
 * Answer first: declared against detected, how much text could be judged, and the encoding. Then what the glance's
 * pass/fail list doesn't show: the languages the passages read as, and every encoding declaration side by side.
 */
function render(r, h) {
  const d = r.data || {};
  const n = d.counts || {};
  const detectedValue = d.detected ? `${languageName(d.detected.code)} ${Math.round(d.detected.share * 100)}%`
    : d.detectedScript ? `${d.detectedScript} script` : "couldn't tell";
  const encoding = normCharset(d.headerCharset) ? d.headerCharset : normCharset(d.metaCharset) ? d.metaCharset : d.docCharset;
  const codes = Object.entries(d.detectedCodes || {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return h.html`${h.stats([
    h.stat({ label: 'Declared', value: d.declared || 'none', note: d.declared ? languageName(primary(d.declared)) : '' }),
    h.stat({ label: 'Detected', value: detectedValue, note: METHOD_WORDS[d.method] || '' }),
    h.stat({ label: 'Passages judged', value: `${num(d.detectedBlocks)} of ${num(n.blocks)}`, note: `${num(n.attrs)} attribute ${plural(num(n.attrs), 'text')}${d.truncated ? ' · sampling stopped early' : ''}` }),
    h.stat({ label: 'Encoding', value: encoding ? String(encoding).toUpperCase() : 'undeclared' }),
  ])}
  ${codes.length ? h.sub('Passages by detected language', h.table(codes.map(([code, k]) => ({ lang: `${languageName(code)} (${code})`, n: k })),
    [{ key: 'lang', label: 'Language' }, { key: 'n', label: 'Passages' }])) : ''}
  ${h.sub('Declarations', h.kv([
    ['Content-Type charset', d.headerCharset || (d.hasDoc ? 'none' : '')],
    ['meta charset', d.metaCharset || 'none'],
    ['Browser decoded as', d.docCharset || ''],
    ['Content-Language', d.contentLanguage || ''],
  ]))}`;
}

// Runs inside the page (serialised): self-contained, no imports, no module scope.
function collect(args) {
  const T0 = Date.now();
  const MAX_NODES = 20000;
  const MAX_MS = 1500;
  const re = {};
  for (const [k, p] of Object.entries(args?.patterns || {})) re[k] = new RegExp(p.source, p.flags);
  const root = document.documentElement;
  const htmlLangRaw = root.getAttribute('lang');
  const htmlLang = (htmlLangRaw || '').trim();
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE', 'KBD', 'SAMP', 'TEXTAREA', 'svg']);
  const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,figcaption,label,button,dd,dt';
  const out = {
    htmlLang: htmlLangRaw, regions: [], blocks: [], attrs: [],
    formats: { candidates: [] },
    mojibake: { count: 0, examples: [] }, replacement: { count: 0, examples: [] },
    metaCharset: null, docCharset: document.characterSet || null, textImages: [], truncated: false,
  };
  const m1 = document.querySelector('meta[charset]');
  if (m1) out.metaCharset = m1.getAttribute('charset');
  else {
    for (const m of document.querySelectorAll('meta[http-equiv]')) {
      if (/^content-type$/i.test(m.getAttribute('http-equiv') || '')) {
        const mm = /charset\s*=\s*([^;\s"']+)/i.exec(m.getAttribute('content') || '');
        if (mm) { out.metaCharset = mm[1]; break; }
      }
    }
  }

  const effLang = (el) => {
    const h = el.closest('[lang]');
    return h ? (h.getAttribute('lang') || '').trim() : htmlLang;
  };
  const selOf = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id && !/\s/.test(el.id)) return `${s}#${CSS.escape(el.id.slice(0, 40))}`;
    const c = el.classList && el.classList[0];
    if (c) s += `.${CSS.escape(c.slice(0, 40))}`;
    const par = el.parentElement;
    if (par) {
      const same = [...par.children].filter((x) => x.tagName === el.tagName);
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return s;
  };
  const skipped = new Map();
  const selfSkip = (el) => {
    if (SKIP.has(el.tagName) || SKIP.has(el.localName)) return true;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || el.getAttribute('translate') === 'no') return true;
    return typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true });
  };
  // Iterative: walk up to the nearest cached ancestor, then settle the path top-down.
  const isSkipped = (el) => {
    const path = [];
    let cur = el;
    let res = false;
    while (cur && cur !== root) {
      if (skipped.has(cur)) { res = skipped.get(cur); break; }
      path.push(cur);
      cur = cur.parentElement;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      res = res || selfSkip(path[i]);
      skipped.set(path[i], res);
    }
    return res;
  };
  // Collapse ASCII whitespace only: U+00A0 must survive (the commonest mojibake is "Â" + no-break space).
  // A run of only spaces and no-break spaces is layout padding, not text.
  const norm = (t) => { const s = t.replace(/[ \t\r\n\f]+/g, ' ').replace(/^ | $/g, ''); return /^[ \u00A0]*$/.test(s) ? '' : s; };
  const CONTEXT = 10;
  // Example with ~20 characters of context, snapped outward to word boundaries.
  const snap = (text, i, len) => {
    let a = Math.max(0, i - CONTEXT);
    let z = Math.min(text.length, i + len + CONTEXT);
    for (let k = 0; k < 10 && a > 0 && text[a - 1] !== ' '; k++) a--;
    for (let k = 0; k < 10 && z < text.length && text[z] !== ' '; k++) z++;
    return text.slice(a, z);
  };
  const tally = (kind, text, bucket) => {
    const rx = re[kind];
    if (!rx || !text) return;
    for (const m of text.matchAll(rx)) {
      bucket.count++;
      if (bucket.examples.length < 5) bucket.examples.push(snap(text, m.index, m[0].length));
    }
  };
  const perKind = { date: 0, time: 0, money: 0 };
  const candidates = (text) => {
    for (const kind of ['date', 'time', 'money']) {
      const rx = re[kind];
      if (!rx) continue;
      for (const m of text.matchAll(rx)) {
        if (perKind[kind] >= 200) break;
        perKind[kind]++;
        out.formats.candidates.push({
          kind, match: m[0],
          before: text.slice(Math.max(0, m.index - 2), m.index),
          after: text.slice(m.index + m[0].length, m.index + m[0].length + 2),
        });
      }
    }
  };

  const regions = new Map();
  const blockEls = new Map(); // element -> its own visible text pieces
  const addRegion = (lang, text) => {
    let r = regions.get(lang);
    if (!r) { r = { lang, chars: 0, sample: '' }; regions.set(lang, r); }
    r.chars += text.length;
    if (r.sample.length < 4000) r.sample = `${r.sample}${r.sample ? ' ' : ''}${text}`.slice(0, 4000);
  };

  // Skipped elements are rejected whole, so their subtrees never consume the node budget.
  const mkWalker = (top) => document.createTreeWalker(top, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 ? (isSkipped(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT),
  });
  // Scripts without word spaces: attributes and alt text are measured in characters, not words.
  const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/gu;
  const spaceless = (t) => (t.match(SPACELESS) || []).length;

  let nodes = 0;
  const walker = mkWalker(document.body || root);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (++nodes > MAX_NODES || Date.now() - T0 > MAX_MS) { out.truncated = true; break; }
    const el = n.parentElement;
    if (!el || isSkipped(el)) continue;
    const raw = n.nodeValue || '';
    const text = norm(raw);
    if (!text) continue;
    addRegion(effLang(el), text);
    tally('mojibake', text, out.mojibake);
    tally('replacement', text, out.replacement);
    if (!el.closest('time[datetime]')) candidates(raw);
    const b = el.closest(BLOCK);
    if (b && !isSkipped(b)) {
      if (!blockEls.has(b)) blockEls.set(b, []);
      blockEls.get(b).push(text);
    }
  }
  out.regions = [...regions.values()];

  // Blocks. Elements whose lang differs from <html lang> go first (any length), so a page with many
  // long blocks cannot starve them; their text comes from the same skip-aware walk.
  const seen = new Set();
  const pushBlock = (el, text) => {
    if (seen.has(el) || out.blocks.length >= 200) return;
    seen.add(el);
    const own = el.hasAttribute('lang') ? (el.getAttribute('lang') || '').trim() : null;
    out.blocks.push({ sel: selOf(el), own, lang: effLang(el), text: text.slice(0, 400) });
  };
  const visibleText = (el) => {
    const pieces = [];
    let len = 0;
    const w = mkWalker(el);
    for (let n = w.nextNode(), i = 0; n && len < 400 && i < 2000 && Date.now() - T0 <= MAX_MS; n = w.nextNode(), i++) {
      const pe = n.parentElement;
      if (!pe || isSkipped(pe)) continue;
      const t = norm(n.nodeValue || '');
      if (t) { pieces.push(t); len += t.length + 1; }
    }
    if (Date.now() - T0 > MAX_MS) out.truncated = true; // the deadline cut this element's text short
    return pieces.join(' ');
  };
  for (const el of document.querySelectorAll('[lang]')) {
    if (out.blocks.length >= 200) break;
    if (Date.now() - T0 > MAX_MS) { out.truncated = true; break; }
    if (el === root || isSkipped(el)) continue;
    if ((el.getAttribute('lang') || '').trim().toLowerCase() === htmlLang.toLowerCase()) continue;
    const text = visibleText(el);
    // Under 60 characters can never count as a block: don't let it fill the 200 cap.
    if (text.length >= 60) pushBlock(el, text);
  }
  for (const [el, pieces] of blockEls) {
    const text = pieces.join(' ');
    if (text.length >= 60) pushBlock(el, text);
  }

  // Attribute text (two words or more)
  const ATTRS = [['alt', 'img[alt]'], ['title', '[title]'], ['aria-label', '[aria-label]'], ['placeholder', '[placeholder]'],
    ['value', 'input[type=submit],input[type=button],input[type=reset]']];
  for (const [name, q] of ATTRS) {
    if (Date.now() - T0 > MAX_MS) { out.truncated = true; break; }
    for (const el of document.querySelectorAll(q)) {
      if (out.attrs.length >= 300) break;
      if (Date.now() - T0 > MAX_MS) { out.truncated = true; break; }
      if (isSkipped(el)) continue;
      const t = norm(el.getAttribute(name) || '');
      if (t.split(' ').length < 2 && spaceless(t) < 4) continue;
      // An ad or embed title is the other site's text, not this page's.
      let cross = false;
      if (name === 'title' && el.localName === 'iframe') {
        try { cross = new URL(el.src, location.href).origin !== location.origin; } catch { /* no usable src */ }
      }
      out.attrs.push({ sel: selOf(el), name, lang: effLang(el), text: t.slice(0, 200), ...(cross ? { cross: true } : {}) });
    }
  }

  // Large images whose alt text suggests words in the picture
  for (const img of document.querySelectorAll('img[alt]')) {
    if (out.textImages.length >= 10) break;
    const alt = (img.getAttribute('alt') || '').trim();
    if ((alt.split(/\s+/).length < 6 && spaceless(alt) < 12) || isSkipped(img)) continue;
    const r = img.getBoundingClientRect();
    if (r.width >= 200 && r.height >= 60) out.textImages.push({ sel: selOf(img), alt: alt.slice(0, 120) });
  }
  return out;
}

export default {
  id: 'language',
  name: 'Language & text',
  version: '0.1.0',
  phase: 'page',
  world: 'isolated',
  area: 'international',
  group: 'other',
  tags: ['i18n'],
  description: 'Declared versus detected language, untagged passages, untranslated labels, character encoding, garbled text and hard-coded date and price formats.',
  collect,
  collectArgs: () => ({ patterns: PATTERNS }),
  run,
  render,
  glance,
};
