// Pure helpers for the "Language & text" check: script detection, language-tag
// comparison, charset normalisation, shared text patterns, and a wrapper around
// chrome.i18n.detectLanguage. No DOM or chrome access at import time.

// Pattern sources are {source, flags} pairs (not RegExp objects) so they can be
// passed as arguments into a function that is serialised into the page.
export const PATTERNS = {
  date: { source: String.raw`\b(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}\b`, flags: 'g' },
  time: { source: String.raw`\b\d{1,2}:\d{2}\s?(?:am|pm|a\.m\.|p\.m\.)`, flags: 'gi' },
  money: { source: String.raw`[$€£¥₹]\s?\d|\d\s?[$€£¥₹]`, flags: 'g' },
  mojibake: { source: String.raw`Ã[\u0080-¿ŒœŠšŸŽž‚ƒ„…†‡ˆ‰‹›‘’“”•–—˜™€]|â€[\u0080-¿™œ"“”–—˜]|Â[ -¿]`, flags: 'g' },
  replacement: { source: '\\uFFFD', flags: 'g' },
};

const CONTEXT = 10;

// One rule for "does this raw match count": ambiguous numeric dates only (both parts <= 12),
// and not part of a dotted version or IP (v2.1.10, 1.2.11.35, 10.1.12.30). `before` and `after`
// are the (up to) 2 characters around the match. Times and money always count.
export function classifyFormat(kind, match, before = '', after = '') {
  if (kind !== 'date') return true;
  const m = /^(\d{1,2})[/.-](\d{1,2})/.exec(String(match));
  if (!m || +m[1] > 12 || +m[2] > 12) return false;
  return !(/\d\.$|[vV]$/.test(String(before)) || /^\.\d/.test(String(after)));
}

// Fresh RegExp per call (no shared lastIndex state).
const compile = (kind, flags) => new RegExp(PATTERNS[kind].source, flags ?? PATTERNS[kind].flags);

// True when the text holds mojibake or U+FFFD: language detection on it is noise.
export function hasGarbled(text) {
  const s = String(text ?? '');
  return compile('mojibake', '').test(s) || compile('replacement', '').test(s);
}

// Text with mojibake and U+FFFD runs replaced by a space.
export function stripGarbled(text) {
  return String(text ?? '').replace(compile('mojibake', 'g'), ' ').replace(compile('replacement', 'g'), ' ');
}

export function countMatches(text, kind, { max = 10 } = {}) {
  const p = PATTERNS[kind];
  const out = { count: 0, examples: [] };
  if (!p || !text) return out;
  const str = String(text);
  const re = new RegExp(p.source, p.flags);
  const ctx = kind === 'mojibake' || kind === 'replacement';
  for (const m of str.matchAll(re)) {
    if (kind === 'date') {
      const before = str.slice(Math.max(0, m.index - 2), m.index);
      const after = str.slice(m.index + m[0].length, m.index + m[0].length + 2);
      if (!classifyFormat('date', m[0], before, after)) continue;
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
  tr: ['Latin'], id: ['Latin'], ms: ['Latin'], vi: ['Latin'], ca: ['Latin'], hr: ['Latin'], bs: ['Latin'], sh: ['Latin'], fil: ['Latin'], jv: ['Latin'],
  ru: ['Cyrillic'], uk: ['Cyrillic'], bg: ['Cyrillic'], sr: ['Cyrillic', 'Latin'],
  el: ['Greek'], ar: ['Arabic'], fa: ['Arabic'], ur: ['Arabic'], he: ['Hebrew'], yi: ['Hebrew'],
  ja: ['Han', 'Kana'], zh: ['Han'], ko: ['Hangul', 'Han'],
  hi: ['Devanagari'], mr: ['Devanagari'], ne: ['Devanagari'], th: ['Thai'],
};

// Legacy and alias primary subtags -> the canonical one. Chrome's detector returns the old codes
// (iw, no, fil); pages declare the modern ones. Every comparison goes through primary().
const ALIAS = { iw: 'he', in: 'id', ji: 'yi', jw: 'jv', mo: 'ro', tl: 'fil', nb: 'no', nn: 'no' };

export function primary(tag) {
  const m = /^\s*([a-z]{2,3})(?![a-z])/i.exec(String(tag ?? ''));
  if (!m) return '';
  const code = m[1].toLowerCase();
  return ALIAS[code] || code;
}

// CLD3 cannot tell these apart, so they compare as one language (display names still use primary()).
const GROUP = { bs: 'hr', sr: 'hr', sh: 'hr' };
const groupOf = (tag) => { const p = primary(tag); return GROUP[p] || p; };

export function sameLanguage(a, b) {
  const ga = groupOf(a);
  return ga !== '' && ga === groupOf(b);
}

// WHATWG encoding labels -> canonical name, so declared and actual encodings compare equal.
const CHARSET_GROUPS = {
  'utf-8': ['utf8', 'unicode-1-1-utf-8'],
  gbk: ['gb2312', 'gb_2312-80', 'gb_2312', 'chinese', 'csgb2312', 'csiso58gb231280', 'iso-ir-58', 'x-gbk'],
  'euc-kr': ['ks_c_5601-1987', 'ks_c_5601-1989', 'korean', 'windows-949', 'cseuckr', 'csksc56011987', 'iso-ir-149'],
  shift_jis: ['shift-jis', 'sjis', 'x-sjis', 'ms_kanji', 'ms932', 'windows-31j', 'csshiftjis'],
  'euc-jp': ['x-euc-jp', 'cseucpkdfmtjapanese'],
  big5: ['big5-hkscs', 'cn-big5', 'x-x-big5', 'csbig5'],
  'windows-1254': ['iso-8859-9', 'latin5', 'l5', 'iso8859-9', 'iso88599', 'csisolatin5'],
  'windows-874': ['tis-620', 'iso-8859-11', 'iso8859-11', 'dos-874'],
  'windows-1252': ['iso-8859-1', 'iso8859-1', 'latin1', 'l1', 'us-ascii', 'ascii', 'ansi_x3.4-1968', 'cp1252', 'x-cp1252', 'iso_8859-1', 'csisolatin1'],
};
const CHARSET = new Map(Object.entries(CHARSET_GROUPS).flatMap(([canon, labels]) => labels.map((l) => [l, canon])));

export function normCharset(s) {
  const v = String(s ?? '').trim().replace(/^["']+|["']+$/g, '').trim().toLowerCase();
  if (!v) return null;
  return CHARSET.get(v) || v;
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
