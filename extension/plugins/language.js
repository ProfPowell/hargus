// Language & text: is the declared language the language of the text, is the encoding consistent,
// and will the text survive translation (untagged passages, untranslated attributes, hard-coded
// formats, garbled characters). The page-side collector gathers samples; this file decides.
// Detection uses chrome.i18n.detectLanguage via ctx.detectLanguage, else a writing-system check.

import { PATTERNS, scriptOf, SCRIPT_OF_LANG, primary, sameLanguage, normCharset, languageName } from '../core/language.js';
import { resHeader, resourceType } from '../core/har-util.js';

const PAGE_MIN = 200;
const BLOCK_MIN = 60;
const MIN_SHARE = 0.6;
const SCRIPT_SHARE = 0.8;

const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const num = (n) => (Number.isFinite(n) ? n : 0);
const count = (o) => num(o?.count);

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
  if (!c) ctx.skip('No visible text to check');
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
  const countedCode = (d) => (d.counted && d.method === 'detector' ? d.code : null);

  const findings = [];
  let method = 'script';
  const flags = {};
  const pending = [];
  const add = (severity, title, detail, extra = {}, m) => pending.push({ severity, title, detail, extra, m });

  // L1
  if (!declared) add('medium', "The page doesn't say which language it is in", 'Add <html lang="…"> so browsers, translators and screen readers pick the right language.');

  // L2: the declared region's whole sample
  let detected = null;
  if (declared) {
    const rs = regions.filter((r) => r.lang === declared);
    const sample = rs.length === 1 ? String(rs[0].sample || '') : rs.map((r) => r.sample || '').join(' ');
    if (sample) {
      const d = await detect(sample, PAGE_MIN);
      if (d.method === 'detector') {
        if (d.counted) detected = { code: d.code, share: d.share };
        if (d.counted && !sameLanguage(d.code, declared)) {
          flags.mismatch = true;
          add('high', `Page says lang="${declared}" but its text is mostly ${languageName(d.code)} (${Math.round(d.share * 100)}%)`,
            'Screen readers and translation tools trust the lang attribute, so they will mispronounce or mistranslate the text.', {}, 'detector');
        }
      } else if (d.counted) {
        const expected = SCRIPT_OF_LANG[primary(declared)];
        if (expected && d.script !== 'Other' && !expected.includes(d.script)) {
          flags.mismatch = true;
          add('high', `Page says lang="${declared}" but its text is mostly ${d.script} script`,
            'Screen readers and translation tools trust the lang attribute, so they will mispronounce or mistranslate the text.', {}, 'script');
        }
      }
    }
  }

  // L3 / L4: blocks
  const blockDet = await Promise.all(blocks.map((b) => detect(String(b.text || ''), BLOCK_MIN)));
  const untagged = new Map();
  const wrong = new Map();
  blocks.forEach((b, i) => {
    const code = countedCode(blockDet[i]);
    if (!code) return;
    if (!b.lang) {
      if (declared && !sameLanguage(code, declared)) {
        if (!untagged.has(code)) untagged.set(code, []);
        untagged.get(code).push(b);
      }
    } else if (!sameLanguage(code, b.lang)) {
      if (!wrong.has(b.lang)) wrong.set(b.lang, []);
      wrong.get(b.lang).push({ b, code });
    }
  });
  const pageChars = regions.reduce((s, r) => s + num(r.chars), 0);
  let untaggedBlocks = 0;
  for (const [code, list] of untagged) {
    untaggedBlocks += list.length;
    const share = pageChars ? list.reduce((s, b) => s + String(b.text || '').length, 0) / pageChars : 0;
    const n = list.length;
    add(n >= 3 || share >= 0.15 ? 'medium' : 'low',
      `${n} ${plural(n, 'passage')} in ${languageName(code)} ${n === 1 ? 'has' : 'have'} no lang attribute`,
      `Mark them up, for example <span lang="${code}">. ${list.slice(0, 5).map((b) => b.sel).join(', ')}`,
      { selectors: list.slice(0, 5).map((b) => b.sel) }, 'detector');
  }
  let wrongBlocks = 0;
  for (const [x, list] of wrong) {
    wrongBlocks += list.length;
    const code = list[0].code;
    add('medium', `lang="${x}" is on text that reads as ${languageName(code)}`,
      `${list.slice(0, 5).map((e) => e.b.sel).join(', ')} — “${clip(list[0].b.text, 60)}”`,
      { selectors: list.slice(0, 5).map((e) => e.b.sel) }, 'detector');
  }

  // L5: attribute text, one batch per group
  const attrIssues = [];
  let attrChecked = false;
  if (declared) {
    for (const [group, noun, pick] of [['alt', 'alt', (a) => a.name === 'alt'], ['label', 'label', (a) => a.name !== 'alt']]) {
      const list = attrs.filter((a) => pick(a) && (!a.lang || sameLanguage(a.lang, declared)));
      if (list.length < 3) continue;
      attrChecked = true;
      const d = await detect(list.map((a) => String(a.text || '')).join(' '), BLOCK_MIN);
      const code = countedCode(d);
      if (code && !sameLanguage(code, declared)) {
        attrIssues.push(group);
        const n = list.length;
        add('medium', `${n} ${noun} ${plural(n, 'text')} ${n === 1 ? 'is' : 'are'} in ${languageName(code)} on a ${declaredName} page`,
          `${list.slice(0, 5).map((a) => a.sel).join(', ')}`, { selectors: list.slice(0, 5).map((a) => a.sel) }, 'detector');
      }
    }
  }

  // L6
  if (contentLanguage && declared) {
    const entries = contentLanguage.split(',').map((s) => s.trim()).filter(Boolean);
    if (entries.length && !entries.some((e) => sameLanguage(e, declared))) {
      add('low', `Content-Language says "${contentLanguage}" but the page says lang="${declared}"`, 'Make the header and the lang attribute agree, or drop the header.');
    }
  }

  // L7 / L8
  const metaCs = c.metaCharset ? String(c.metaCharset) : null;
  const docCs = c.docCharset ? String(c.docCharset) : null;
  const seen = [['Content-Type header', hdrCharset], ['meta tag', metaCs], ['browser', docCs]].filter(([, v]) => normCharset(v));
  const inconsistent = new Set(seen.map(([, v]) => normCharset(v))).size > 1;
  if (inconsistent) add('medium', 'Character encoding is declared inconsistently', seen.map(([k, v]) => `${k}: ${v}`).join('; '));
  const undeclared = !!doc && !normCharset(hdrCharset) && !normCharset(metaCs);
  if (undeclared) add('low', 'No character encoding is declared', 'Send Content-Type: text/html; charset=utf-8, or add <meta charset="utf-8"> early in <head>.');

  // L9 / L10
  const moji = count(c.mojibake);
  const repl = count(c.replacement);
  const mojiExample = (c.mojibake?.examples || [])[0];
  if (moji >= 3 && mojiExample != null) {
    add('high', `Text shows garbled characters such as "${mojiExample}"`, `${moji} places look like UTF-8 text decoded with the wrong encoding.`);
  }
  if (repl >= 3) add('medium', `${repl} replacement characters (�) appear in the text`, 'Characters that could not be decoded were replaced; check the file encoding.');

  // L11
  const f = c.formats || {};
  const fmtTotal = count(f.dates) + count(f.times) + count(f.money);
  if (fmtTotal >= 3) {
    const part = (label, o) => `${label}: ${count(o)}${(o?.examples || []).length ? ` (${o.examples.slice(0, 3).join(', ')})` : ''}`;
    add('low', "Dates, times or prices are written in one region's format",
      [part('dates', f.dates), part('times', f.times), part('prices', f.money)].join('; '));
  }

  // L12
  const imgs = c.textImages || [];
  if (imgs.length) {
    add('info', `${imgs.length} large ${plural(imgs.length, 'image')} may contain text that can't be translated`,
      "If the words are part of the image, translators can't reach them.", { selectors: imgs.slice(0, 5).map((i) => i.sel) });
  }
  if (c.truncated) add('info', 'Text sampling stopped early', 'The page has a lot of text; only part of it was checked.');

  method = usedDetector ? 'detector' : 'script';
  for (const p of pending) {
    findings.push({
      severity: p.severity, category: 'international', title: p.title,
      ...(p.detail ? { detail: p.detail } : {}),
      evidence: { ...p.extra, method: p.m || method },
    });
  }

  const encoding = (normCharset(hdrCharset) ? hdrCharset : normCharset(metaCs) ? metaCs : docCs) || null;
  const summary = [];
  summary.push({
    label: 'Language',
    value: [declared || 'no lang', detected ? `${languageName(detected.code)} ${Math.round(detected.share * 100)}%` : null].filter(Boolean).join(' · '),
    rating: !declared || flags.mismatch ? 'poor' : 'good',
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
      mismatch: !!flags.mismatch, attrIssues, attrChecked, inconsistent, undeclared, hasDoc: !!doc,
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
    d.declared && d.detected && { label: 'Declared language matches the text', ok: !d.mismatch, note: d.mismatch ? `reads as ${languageName(d.detected.code)}` : '' },
    d.method === 'detector' && n.blocks > 0 && { label: 'No untagged passages in other languages', ok: n.untagged + n.wrongLang === 0, note: n.untagged + n.wrongLang ? `${n.untagged} untagged, ${n.wrongLang} mislabelled` : '' },
    d.attrChecked && { label: 'Labels and alt text in the page language', ok: !d.attrIssues.length, note: d.attrIssues.join(', ') },
    (d.hasDoc || d.metaCharset) && { label: 'Encoding declared and consistent', ok: !d.inconsistent && !d.undeclared, note: d.inconsistent ? 'declarations differ' : d.undeclared ? 'none declared' : '' },
    { label: 'No garbled characters', ok: n.mojibake < 3 && n.replacement < 3, note: n.mojibake >= 3 && d.mojibakeExample != null ? h.html`“${d.mojibakeExample}”` : n.replacement >= 3 ? `${n.replacement} replacement characters` : '' },
    { label: 'Dates and prices in a neutral format', ok: n.dates + n.times + n.money < 3, note: n.dates + n.times + n.money ? `${n.dates} dates, ${n.times} times, ${n.money} prices` : '' },
  ].filter(Boolean);
  return h.html`<div class="glance-grid"><section class="card"><h4>Language and text</h4>${h.checklist(items)}</section></div>`;
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
  collectArgs: () => ({ patterns: PATTERNS }),
  run,
  glance,
};
