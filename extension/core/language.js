// Pure helpers for the "Language & text" check: script detection, language-tag
// comparison, charset normalisation, shared text patterns, and a wrapper around
// chrome.i18n.detectLanguage. No DOM or chrome access at import time.

// Pattern sources are {source, flags} pairs (not RegExp objects) so they can be
// passed as arguments into a function that is serialised into the page.
export const PATTERNS = {
  date: { source: String.raw`\b(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}\b`, flags: 'g' },
  time: { source: String.raw`\b\d{1,2}:\d{2}\s?(?:am|pm|a\.m\.|p\.m\.)`, flags: 'gi' },
  money: { source: String.raw`[$€£¥₹]\s?\d|\d\s?[$€£¥₹]`, flags: 'g' },
  mojibake: { source: String.raw`Ã[\u0080-¿]|â€[\u0080-¿™œ"“”–—˜]|Â[ -¿]`, flags: 'g' },
  replacement: { source: '\\uFFFD', flags: 'g' },
};

const CONTEXT = 10;

export function countMatches(text, kind, { max = 10 } = {}) {
  const p = PATTERNS[kind];
  const out = { count: 0, examples: [] };
  if (!p || !text) return out;
  const str = String(text);
  const re = new RegExp(p.source, p.flags);
  const ctx = kind === 'mojibake' || kind === 'replacement';
  for (const m of str.matchAll(re)) {
    if (kind === 'date') {
      if (+m[1] > 12 || +m[2] > 12) continue;
      // Dotted versions and IPs (v2.1.10, 1.2.11.35, 10.1.12.30) are not dates.
      const before = str.slice(Math.max(0, m.index - 2), m.index);
      const after = str.slice(m.index + m[0].length, m.index + m[0].length + 2);
      if (/\d\.$|[vV]$/.test(before) || /^\.\d/.test(after)) continue;
    }
    out.count++;
    if (out.examples.length < max) {
      out.examples.push(ctx
        ? str.slice(Math.max(0, m.index - CONTEXT), m.index + m[0].length + CONTEXT)
        : m[0]);
    }
  }
  return out;
}

const SCRIPTS = [
  ['Latin', /\p{Script=Latin}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Han', /\p{Script=Han}/u],
  ['Kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['Hangul', /\p{Script=Hangul}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Thai', /\p{Script=Thai}/u],
];

export function scriptOf(text) {
  const counts = new Map();
  let total = 0;
  for (const ch of String(text || '')) {
    if (!/\p{L}/u.test(ch)) continue;
    total++;
    // U+30FC (prolonged sound mark) is Script=Common but is Japanese kana in practice.
    const name = ch === '\u30FC' ? 'Kana' : SCRIPTS.find(([, re]) => re.test(ch))?.[0] || 'Other';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  if (!total) return { script: null, share: 0 };
  let best = null;
  for (const [name, n] of counts) if (!best || n > best[1]) best = [name, n];
  return { script: best[0], share: best[1] / total };
}

export const SCRIPT_OF_LANG = {
  en: ['Latin'], de: ['Latin'], fr: ['Latin'], es: ['Latin'], it: ['Latin'], pt: ['Latin'],
  nl: ['Latin'], sv: ['Latin'], da: ['Latin'], no: ['Latin'], nb: ['Latin'], nn: ['Latin'],
  fi: ['Latin'], pl: ['Latin'], cs: ['Latin'], sk: ['Latin'], hu: ['Latin'], ro: ['Latin'],
  tr: ['Latin'], id: ['Latin'], ms: ['Latin'], vi: ['Latin'], ca: ['Latin'], hr: ['Latin'],
  ru: ['Cyrillic'], uk: ['Cyrillic'], bg: ['Cyrillic'], sr: ['Cyrillic', 'Latin'],
  el: ['Greek'], ar: ['Arabic'], fa: ['Arabic'], ur: ['Arabic'], he: ['Hebrew'],
  ja: ['Han', 'Kana'], zh: ['Han'], ko: ['Hangul', 'Han'],
  hi: ['Devanagari'], mr: ['Devanagari'], ne: ['Devanagari'], th: ['Thai'],
};

export function primary(tag) {
  const m = /^\s*([a-z]{2,3})(?![a-z])/i.exec(String(tag ?? ''));
  return m ? m[1].toLowerCase() : '';
}

export function sameLanguage(a, b) {
  const pa = primary(a);
  return pa !== '' && pa === primary(b);
}

export function normCharset(s) {
  const v = String(s ?? '').trim().replace(/^["']+|["']+$/g, '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'utf8') return 'utf-8';
  if (v === 'iso-8859-1' || v === 'latin1' || v === 'us-ascii') return 'windows-1252';
  return v;
}

export function languageName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch { return code; }
}

export function chromeDetector({ timeoutMs = 2000 } = {}) {
  const detect = globalThis.chrome?.i18n?.detectLanguage;
  if (typeof detect !== 'function') return undefined;
  return (text) => new Promise((resolve) => {
    let timer;
    const finish = (v) => { clearTimeout(timer); resolve(v); };
    const done = (r) => {
      const top = r?.languages?.[0];
      const code = primary(top?.language);
      const pct = top?.percentage;
      const num = typeof pct === 'number' || (typeof pct === 'string' && pct.trim() !== '') ? Number(pct) : NaN;
      if (!code || code === 'und' || !Number.isFinite(num)) return finish(null);
      finish({ code, share: num / 100, reliable: !!r.isReliable });
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    try {
      // Callback form; MV3 also returns a promise (and may skip the callback) — accept either.
      const p = globalThis.chrome.i18n.detectLanguage(text, done);
      if (p && typeof p.then === 'function') p.then(done, () => finish(null));
    } catch { finish(null); }
  });
}
