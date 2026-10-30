// Content: reading level, structure / information architecture and links on the page.
// collect() runs in the page (self-contained); analyze() is pure and unit-tested.

import { VAGUE_LINK_WORDS } from '../core/link-text.js';

const VAGUE = new Set(VAGUE_LINK_WORDS);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const SESSION = /^(sid|sessionid|jsessionid|phpsessid)$/i;
const MAX_SOURCES = 20; // places kept per link target; the rest are counted in `more`
const MAX_LINK_TARGETS = 5000; // per list; linkTargets.totals keeps the true counts so Link check can report the rest

function collect() {
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const EX = 'nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], script, style, noscript, template';
  const body = document.body;
  if (!body) return { url: location.href, lang: '', text: '', bodyTextBytes: 0, paragraphs: [], headings: [], navs: [], breadcrumb: false, links: [], ids: [], lineLengths: [] };
  const main = document.querySelector('main, [role=main]');
  const articles = document.querySelectorAll('article');
  const root = main || (articles.length === 1 ? articles[0] : body);
  const scoped = root === body;
  // Visible text of the live DOM; in the whole-body fallback, skip chrome subtrees without mutating the page.
  // innerText of an unrendered element (display:none, [hidden]) is its raw text, so test rendering explicitly.
  const shown = (el) => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);
  // Inline pieces join with nothing and collapsed whitespace (source newlines are not line breaks); only block-level children get '\n'.
  const gather = (el) => {
    if (el.matches(EX) || !shown(el)) return '';
    if (!el.querySelector(EX)) return el.innerText || '';
    return [...el.childNodes].map((n) => {
      if (n.nodeType === 3) return n.textContent.replace(/\s+/g, ' ');
      if (n.nodeType !== 1) return '';
      const piece = gather(n);
      return /^(inline|contents|none)/.test(getComputedStyle(n).display) ? piece : `\n${piece}\n`;
    }).join('');
  };
  const text = scoped ? gather(body) : (root.innerText || '');
  const paragraphs = [...root.querySelectorAll('p, li, dd, blockquote')]
    .filter((p) => shown(p) && (!scoped || !p.closest(EX)))
    .map((p) => clean(p.innerText))
    .filter((t) => t.length >= 20).slice(0, 400).map((t) => ({ text: t.slice(0, 3000) }));
  const depthOf = (el) => {
    let max = 0;
    for (const l of el.querySelectorAll('ul, ol')) {
      let d = 0;
      for (let p = l; p && p !== el; p = p.parentElement) if (p.matches('ul, ol')) d++;
      max = Math.max(max, d);
    }
    return max;
  };
  const navs = [...document.querySelectorAll('nav, [role=navigation]')].slice(0, 20).map((n) => ({
    links: n.querySelectorAll('a[href]').length, depth: depthOf(n), label: clean(n.getAttribute('aria-label') || n.className || '').slice(0, 60),
  }));
  const breadcrumb = !!document.querySelector('nav[aria-label*="breadcrumb" i], [class*="breadcrumb" i]');
  const links = [];
  const anchors = [...document.querySelectorAll('a[href]')];
  const anchorsRead = Math.min(anchors.length, 10_000); // literal: collect() is serialised into the page
  // Where each link sits: nearest landmark by element or ARIA role (the first known role of a role list), and a
  // short selector (at most 4 steps, stopping at an id). Same-name siblings are listed once per parent.
  const roles = new Map([['banner', 'header'], ['navigation', 'nav'], ['main', 'main'], ['complementary', 'aside'], ['contentinfo', 'footer'], ['form', 'form'], ['search', 'form']]);
  const tags = new Map([['header', 'header'], ['nav', 'nav'], ['main', 'main'], ['aside', 'aside'], ['footer', 'footer'], ['form', 'form']]);
  const siblings = new Map(); // parent element -> Map(localName -> [children])
  const sameName = (e) => {
    let byName = siblings.get(e.parentElement);
    if (!byName) {
      byName = new Map();
      for (const x of e.parentElement.children) {
        if (!byName.has(x.localName)) byName.set(x.localName, []);
        byName.get(x.localName).push(x);
      }
      siblings.set(e.parentElement, byName);
    }
    return byName.get(e.localName);
  };
  for (const a of anchors.slice(0, anchorsRead)) {
    let href;
    try { href = new URL(a.getAttribute('href'), document.baseURI).href; } catch { continue; }
    let region = 'body';
    for (let p = a.parentElement; p && p !== document.body; p = p.parentElement) {
      const role = (p.getAttribute('role') || '').trim().toLowerCase().split(/\s+/).find((x) => roles.has(x));
      const r = role ? roles.get(role) : tags.get(p.localName);
      if (r) { region = r; break; }
    }
    const steps = [];
    for (let e = a; e && e.nodeType === 1 && steps.length < 4; e = e.parentElement) {
      if (e.id) { steps.unshift(`#${CSS.escape(e.id)}`); break; }
      if (e === document.body || e === document.documentElement) { steps.unshift(e.localName); break; }
      const same = e.parentElement ? sameName(e) : [];
      steps.unshift(same.length > 1 ? `${e.localName}:nth-of-type(${same.indexOf(e) + 1})` : e.localName);
    }
    links.push({
      href, raw: (a.getAttribute('href') || '').slice(0, 500), text: clean(a.innerText || a.textContent).slice(0, 120), aria: clean(a.getAttribute('aria-label')).slice(0, 120),
      region, selector: steps.join(' > '),
    });
  }
  const ids = [...document.querySelectorAll('[id], a[name]')].map((el) => el.id || el.getAttribute('name')).filter(Boolean);
  // Characters per rendered line: a paragraph's text length over its distinct line tops (within 2 px is one line).
  const lineLengths = [];
  const pool = [...document.querySelectorAll('main p, [role="main"] p, article p')];
  const paras = pool.length ? pool : [...document.querySelectorAll('body p')].filter((p) => !p.closest('nav, header, footer, aside'));
  for (const p of paras) {
    if (lineLengths.length >= 200) break;
    if (!shown(p)) continue;
    const ptext = clean(p.innerText);
    if (ptext.length < 80) continue;
    const range = document.createRange();
    range.selectNodeContents(p);
    const tops = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map((r) => Math.round(r.top)).sort((a, b) => a - b);
    let lines = 0;
    tops.forEach((t, i) => { if (i === 0 || t - tops[i - 1] > 2) lines++; });
    if (lines) lineLengths.push(Math.round(ptext.length / lines));
  }
  return {
    url: location.href,
    lang: document.documentElement.lang || '',
    text: text.slice(0, 200_000),
    bodyTextBytes: new TextEncoder().encode(body.innerText || '').length,
    paragraphs,
    headings: [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((x) => shown(x) && !x.closest('[aria-hidden="true"]')).slice(0, 300).map((x) => ({ level: Number(x.tagName[1]), text: clean(x.innerText || x.textContent).slice(0, 300) })),
    navs, breadcrumb, links, anchorsTotal: anchors.length, anchorsRead, ids: [...new Set(ids)].slice(0, 5000), lineLengths,
  };
}

export function countWords(text = '') {
  const cjk = (text.match(CJK) || []).length;
  const rest = text.replace(CJK, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return rest + Math.round(cjk / 2);
}

export function syllables(word = '') {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export function flesch({ words, sentences, syllables: syl }) {
  if (!words || !sentences) return null;
  const wps = words / sentences;
  const spw = syl / words;
  return { ease: 206.835 - 1.015 * wps - 84.6 * spw, grade: 0.39 * wps + 11.8 * spw - 15.59 };
}

export function splitSentences(text = '') {
  return text.split(/[.!?]+(?=\s|$)|[。！？]+|\n+/).map((s) => s.trim()).filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/** Fragments that read as prose: headlines, nav labels and buttons are shorter. */
export function proseSentences(sentences = [], script = 'latin') {
  return sentences.filter((s) => (script === 'cjk' ? [...s.replace(/\s/g, '')].length >= 10 : countWords(s) >= 4));
}

export function scriptOf(text = '') {
  const counts = { latin: 0, cyrillic: 0, greek: 0, arabic: 0, cjk: 0, hebrew: 0, other: 0 };
  let seen = 0;
  for (const ch of String(text)) {
    if (++seen > 20000) break;
    if (!/\p{L}/u.test(ch)) continue;
    if (/\p{Script=Latin}/u.test(ch)) counts.latin++;
    else if (/\p{Script=Cyrillic}/u.test(ch)) counts.cyrillic++;
    else if (/\p{Script=Greek}/u.test(ch)) counts.greek++;
    else if (/\p{Script=Arabic}/u.test(ch)) counts.arabic++;
    else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)) counts.cjk++;
    else if (/\p{Script=Hebrew}/u.test(ch)) counts.hebrew++;
    else counts.other++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n ? best : 'other';
}

export const ari = ({ letters, words, sentences }) => (words && sentences ? 4.71 * (letters / words) + 0.5 * (words / sentences) - 21.43 : null);
// AARI per sentence (ruling): the published form multiplies total letters, which grows with page length.
export const aari = ({ letters, words, sentences }) => (words && sentences ? 3.28 * (letters / sentences) + 1.43 * (letters / words) + 1.24 * (words / sentences) : null);

export function hardest(sentences = [], script = 'latin') {
  const cjk = script === 'cjk';
  return sentences
    .map((s) => ({ text: [...s].length > 120 ? `${[...s].slice(0, 120).join('')}…` : s, words: countWords(s), chars: [...s.replace(/\s/g, '')].length }))
    .sort((a, b) => (cjk ? b.chars - a.chars : b.words - a.words))
    .slice(0, 5);
}

/** A link as a place: where it points, its text, and where it sits on the page (older readings have no region or selector). */
const linkPlace = (l) => {
  const text = l.text || l.aria;
  return { url: String(l.href), ...(text ? { text } : {}), ...(l.region ? { region: l.region } : {}), ...(l.selector ? { selector: l.selector } : {}) };
};

const noHash = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return null; } };
const siteOfHost = (host) => host.replace(/^www\./, '');

function englishText(lang, text) {
  if (lang) return /^en\b/i.test(lang);
  const letters = text.match(/\p{L}/gu) || [];
  return letters.length > 0 && letters.filter((c) => /[a-z]/i.test(c)).length / letters.length > 0.9;
}

/** Pure analysis of collected page data. meta: meta plugin data; docBytes: HTML document size from the HAR. */
// `covered`: the accessibility plugins that ran and report the same link problems with page marks, so these findings are not repeated
// (the items stay in the panel table): { vague, anchors }.
export function analyze(c, { meta = {}, url = c.url, docBytes = 0, siteOf = siteOfHost, covered = {} } = {}) {
  const findings = [];
  // places: the links a finding is about, capped at 200 (the detail still names the first 10).
  const add = (severity, title, detail, id, places) => findings.push({ severity, category: 'content', title, ...(detail ? { detail } : {}), ...(id ? { id } : {}), ...(places?.length ? { places: places.slice(0, 200) } : {}) });

  // Reading
  const words = countWords(c.text);
  const script = scriptOf(c.text);
  const english = englishText(c.lang, c.text);
  const fragments = splitSentences(c.text);
  const sentences = proseSentences(fragments, script);
  const prose = sentences.join(' ');
  const proseWords = countWords(prose);
  const enough = sentences.length >= 5 && proseWords >= 100;
  const lens = sentences.map((s) => countWords(s));
  const longShare = lens.length ? lens.filter((n) => n > 25).length / lens.length : 0;
  const paraWords = c.paragraphs.map((p) => countWords(p.text));
  const walls = c.paragraphs.filter((_, i) => paraWords[i] > 150);
  const syl = english && enough ? (prose.match(/[A-Za-z]+/g) || []).reduce((n, w) => n + syllables(w), 0) : 0;
  const f = english && enough ? flesch({ words: proseWords, sentences: sentences.length, syllables: syl }) : null;
  const letterCount = enough ? (prose.match(/[\p{L}\p{N}]/gu) || []).length : 0;
  const counts = { letters: letterCount, words: proseWords, sentences: sentences.length };
  const ariVal = enough && !english && ['latin', 'cyrillic', 'greek'].includes(script) ? ari(counts) : null;
  const aariVal = enough && !english && script === 'arabic' ? aari(counts) : null;
  const cjkCps = enough && !english && script === 'cjk'
    ? Math.round(sentences.reduce((n, x) => n + [...x.replace(/\s/g, '')].length, 0) / sentences.length) : null;
  const reading = {
    words, minutes: Math.max(1, Math.ceil(words / 230)), sentences: fragments.length,
    proseSentences: sentences.length,
    avgSentence: lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0,
    longShare, paragraphs: c.paragraphs.length,
    avgParagraph: paraWords.length ? Math.round(paraWords.reduce((a, b) => a + b, 0) / paraWords.length) : 0,
    walls: walls.length, english,
    flesch: f ? Math.round(f.ease) : null, grade: f ? Math.round(f.grade) : null,
    script,
    ari: ariVal == null ? null : Math.round(ariVal * 10) / 10,
    aari: aariVal == null ? null : Math.round(aariVal),
    cjkCharsPerSentence: cjkCps,
    hardest: hardest(sentences, script),
    readability: !enough ? 'not enough prose' : english ? (f ? 'flesch' : 'not enough text') : ariVal != null ? 'ari' : aariVal != null ? 'aari' : cjkCps != null ? 'cjk' : `not applicable: ${script}`,
    buckets: [[1, 10], [11, 15], [16, 20], [21, 25], [26, 35], [36, Infinity]].map(([lo, hi]) => ({
      label: hi === Infinity ? `${lo}+` : `${lo}–${hi}`, value: lens.filter((n) => n >= lo && n <= hi).length,
    })),
  };
  if (enough && lens.length && longShare > 0.3) add('low', `Many long sentences (${Math.round(longShare * 100)}% over 25 words)`);
  if (walls.length) add('low', `${walls.length} wall-of-text paragraphs`, walls.slice(0, 3).map((p) => `“${p.text.slice(0, 80)}…”`).join(' '));
  if (words < 250) add('info', `Thin content (${words} words)`);
  if (f && f.ease < 50) add(f.ease < 30 ? 'medium' : 'low', `Hard to read (Flesch ${Math.round(f.ease)}, grade ${Math.round(f.grade)})`);
  if (ariVal != null && ariVal > 12) add(ariVal > 16 ? 'medium' : 'low', `Hard to read (ARI grade ${Math.round(ariVal)})`);
  const textShare = docBytes ? c.bodyTextBytes / docBytes : null;
  if (textShare != null && textShare < 0.1) add('low', `Mostly markup (${Math.round(textShare * 100)}% text)`);

  // Structure
  const heads = c.headings;
  let skipped = 0;
  heads.forEach((x, i) => { if (i && x.level > heads[i - 1].level + 1) skipped++; });
  const empty = heads.filter((x) => !x.text).length;
  const longHeads = heads.filter((x) => x.text.length > 120).length;
  if (longHeads) add('info', `${longHeads} very long headings`);
  const title = (meta.title || '').trim();
  const h1 = heads.find((x) => x.level === 1)?.text || '';
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  let host = '';
  try { host = new URL(url).hostname; } catch { /* keep empty */ }
  const brand = siteOf(host).split('.')[0] || '';
  const siteName = meta.og?.['og:site_name'] || '';
  if (title && h1 && norm(title) === norm(h1)) add('info', 'Title repeats the h1');
  else if (title && ((siteName && norm(title) === norm(siteName)) || (brand && norm(title).split(' ').every((w) => w === brand)))) add('info', 'Title is only the site name');
  const navLinks = c.navs.reduce((n, x) => n + x.links, 0);
  if (navLinks > 60) add('low', `Menu overload (${navLinks} links in navigation)`);
  let path = '/';
  let params = [];
  try { const u = new URL(url); path = u.pathname; params = [...u.searchParams.keys()]; } catch { /* keep defaults */ }
  const depth = path.split('/').filter(Boolean).length;
  const breadcrumbs = c.breadcrumb || (meta.structuredTypes || []).includes('BreadcrumbList');
  if (!breadcrumbs && depth >= 2) add('info', `No breadcrumbs on a page ${depth} levels deep`);
  const shape = [
    depth > 4 && `depth ${depth}`, url.length > 100 && `${url.length} characters`,
    /[A-Z]/.test(path) && 'uppercase', path.includes('_') && 'underscores', params.some((p) => SESSION.test(p)) && 'session id',
  ].filter(Boolean);
  if (shape.length) add('info', `URL shape: ${shape.join(', ')}`);

  // Links
  const here = noHash(c.url || url);
  const site = siteOf(host);
  const kinds = { internal: 0, external: 0, mailto: 0, tel: 0, fragment: 0, other: 0 };
  const internal = []; const external = [];
  const sources = {}; // dest -> { list, more }: every place a listed target is linked from
  const seen = { internal: new Set(), external: new Set() };
  const byText = new Map();
  const vague = []; const missing = [];
  const idSet = new Set(c.ids);
  for (const l of c.links) {
    let u;
    if (typeof l.href !== 'string') { kinds.other++; continue; }
    try { u = new URL(l.href, url); } catch { kinds.other++; continue; }
    const label = (l.text || l.aria || '').toLowerCase().trim();
    if (VAGUE.has(label)) vague.push(l);
    if (u.protocol === 'mailto:') { kinds.mailto++; continue; }
    if (u.protocol === 'tel:') { kinds.tel++; continue; }
    if (!/^https?:$/.test(u.protocol)) { kinds.other++; continue; }
    const dest = noHash(u.href);
    if (dest === here && (u.hash || l.href.endsWith('#'))) {
      kinds.fragment++;
      let id = u.hash.slice(1);
      try { id = decodeURIComponent(id); } catch { /* keep raw */ }
      if (id && id !== 'top' && !/^[/!]/.test(id) && !idSet.has(id)) missing.push(l);
      continue;
    }
    const isInternal = siteOf(u.hostname) === site;
    kinds[isInternal ? 'internal' : 'external']++;
    const kind = isInternal ? 'internal' : 'external';
    if (!seen[kind].has(dest)) {
      seen[kind].add(dest);
      const bucket = isInternal ? internal : external;
      if (bucket.length < MAX_LINK_TARGETS) { bucket.push(dest); sources[dest] = { list: [], more: 0 }; }
    }
    if (sources[dest]) {
      const entry = sources[dest];
      if (entry.list.length < MAX_SOURCES) {
        const text = (l.text || l.aria || '').slice(0, 80);
        entry.list.push({ ...(l.raw != null ? { raw: l.raw } : {}), text, ...(l.region ? { region: l.region } : {}), ...(l.selector ? { selector: l.selector } : {}) });
      } else entry.more++;
    }
    if (label) {
      if (!byText.has(label)) byText.set(label, new Set());
      byText.get(label).add(dest);
    }
  }
  const conflicting = [...byText].filter(([, d]) => d.size > 1);
  const pageLinks = kinds.internal + kinds.external;
  const perThousandWords = words ? Math.round((pageLinks / words) * 1000) : 0;
  if (vague.length && !covered.vague) add('low', `${vague.length} links with vague text`, vague.slice(0, 10).map((l) => `“${l.text || l.aria}” → ${l.href}`).join('; '), undefined, vague.map(linkPlace));
  if (conflicting.length) {
    add('low', `${conflicting.length} link texts point to different places`, conflicting.slice(0, 10).map(([t, d]) => `“${t}”: ${[...d].join(', ')}`).join('; '), undefined,
      conflicting.flatMap(([t, d]) => [...d].map((url) => ({ url, text: t }))));
  }
  if (missing.length && !covered.anchors) add('medium', `${missing.length} links to missing in-page anchors`, missing.slice(0, 10).map((l) => l.href).join(', '), 'missing-anchors', missing.map(linkPlace));
  if (words >= 200 && perThousandWords > 100) add('low', `Very link-dense (${perThousandWords} links per 1,000 words)`);

  const ll = (c.lineLengths || []).filter((n) => n > 0).sort((a, b) => a - b);
  const lineLength = {
    median: ll.length ? ll[Math.floor((ll.length - 1) / 2)] : 0,
    ideal: ll.length ? Math.round((ll.filter((n) => n >= 45 && n <= 75).length / ll.length) * 100) : 0,
    count: ll.length,
  };
  if (lineLength.count >= 5 && lineLength.median > 80) add('low', `Lines are long (median ${lineLength.median} characters)`);
  else if (lineLength.count >= 5 && lineLength.median > 0 && lineLength.median < 35) add('info', `Lines are short (median ${lineLength.median} characters)`);

  const readExtra = reading.flesch != null ? ` · Flesch ${reading.flesch}`
    : reading.ari != null ? ` · ARI ${Math.round(reading.ari)}`
      : reading.aari != null ? ` · AARI ${reading.aari}`
        : reading.cjkCharsPerSentence != null ? ` · ${reading.cjkCharsPerSentence} chars/sentence` : '';
  const summary = [
    { label: 'Reading', value: `${words.toLocaleString()} words · ${reading.minutes} min${readExtra}`, headline: true },
    ...(lineLength.count > 0 ? [{ label: 'Line length', value: `median ${lineLength.median} chars · ${lineLength.ideal}% in 45–75` }] : []),
    { label: 'Links', value: `${kinds.internal} internal · ${kinds.external} external`, headline: true },
    { label: 'Headings', value: `${heads.length}${skipped ? ` · ${skipped} skipped levels` : ''}` },
    { label: 'Navigation', value: c.navs.length ? `${c.navs.length} nav · ${navLinks} links` : 'none' },
  ];
  return {
    data: {
      reading, textShare, lineLength,
      structure: { headings: heads, skipped, empty, navs: c.navs, navLinks, breadcrumbs, depth, shape },
      links: {
        kinds, perThousandWords, vague: vague.slice(0, 20), vagueCount: vague.length,
        conflicting: conflicting.slice(0, 20).map(([t, d]) => ({ text: t, destinations: [...d] })), conflictingCount: conflicting.length,
        missing: missing.slice(0, 200), missingCount: missing.length,
      },
      linkTargets: { internal, external, sources, totals: { internal: seen.internal.size, external: seen.external.size },
        ...(c.anchorsTotal != null ? { anchors: { total: c.anchorsTotal, read: c.anchorsRead } } : {}) },
    },
    findings, summary,
  };
}

function run(reading, ctx) {
  const c = ctx.collected;
  if (!c) ctx.skip('no page data');
  const meta = ctx.results?.meta?.data || {};
  const url = ctx.target?.finalUrl || ctx.target?.url || c.url;
  const doc = ctx.util?.mainEntry?.(reading);
  const covered = { vague: ctx.results?.['a11y-structure']?.status === 'ok' && !ctx.results['a11y-structure'].data?.vagueSkipped, anchors: ctx.results?.['a11y-basics']?.status === 'ok' };
  return analyze(c, { meta, url, docBytes: Math.max(0, doc?.response?.content?.size || 0), siteOf: ctx.util?.siteOf, covered });
}

const fleschStatus = (e) => (e == null ? 'none' : e >= 60 ? 'good' : e >= 50 ? 'warning' : e >= 30 ? 'serious' : 'critical');
// The ring's colour as a word beside it (rule 5), from the same status.
const BAND = { good: ['good', 'plain'], warning: ['fair', 'fairly hard'], serious: ['poor', 'hard'], critical: ['poor', 'very hard'] };
const bandWord = (st, h) => (BAND[st] ? h.html`${h.status(BAND[st][0], BAND[st][1])} ` : '');

function readabilityCard(rd, h) {
  if (rd.flesch != null) {
    const st = fleschStatus(rd.flesch);
    return h.html`<section class="card"><h4>Readability</h4>${h.ring({ value: Math.max(0, Math.min(100, rd.flesch)), size: 72, status: st, label: 'Flesch reading ease' })}<p class="note">${bandWord(st, h)}Flesch ${rd.flesch} · grade ${rd.grade}</p></section>`;
  }
  if (rd.ari != null) {
    const status = rd.ari > 16 ? 'critical' : rd.ari > 12 ? 'serious' : 'good';
    return h.html`<section class="card"><h4>Readability</h4>${h.ring({ value: Math.max(0, Math.min(100, Math.round(100 - (rd.ari - 6) * 8))), size: 72, status, label: 'ARI grade' })}<p class="note">${bandWord(status, h)}ARI grade ${Math.round(rd.ari)}</p></section>`;
  }
  if (rd.aari != null) return h.html`<section class="card"><h4>Readability</h4>${h.stat({ label: 'AARI', value: String(rd.aari), note: 'Arabic readability index' })}</section>`;
  if (rd.cjkCharsPerSentence != null) return h.html`<section class="card"><h4>Readability</h4>${h.stat({ label: 'Sentence length', value: String(rd.cjkCharsPerSentence), note: 'characters per sentence' })}</section>`;
  if (rd.readability === 'not enough prose') return h.html`<section class="card"><h4>Readability</h4><p class="note">Not enough prose to score${rd.proseSentences != null ? ` (${rd.proseSentences} of ${rd.sentences} lines are prose)` : ''}</p></section>`;
  return '';
}

function readabilityRow(rd) {
  if (rd.flesch != null) return `Flesch ${rd.flesch} · grade ${rd.grade}`;
  if (rd.ari != null) return `ARI grade ${Math.round(rd.ari)}`;
  if (rd.aari != null) return `AARI ${rd.aari}`;
  if (rd.cjkCharsPerSentence != null) return `${rd.cjkCharsPerSentence} characters per sentence`;
  return rd.readability || '';
}

function glance(r, h) {
  const d = r.data;
  const rd = d.reading;
  return h.html`<div class="tiles">
    ${h.stat({ label: 'Words', value: rd.words.toLocaleString(), note: `${rd.minutes} min read` })}
    ${h.stat({ label: 'Average sentence', value: `${rd.avgSentence} words`, note: `${Math.round(rd.longShare * 100)}% over 25 words` })}
    ${h.stat({ label: 'Paragraphs', value: String(rd.paragraphs), note: rd.walls ? `${rd.walls} walls of text` : 'none over 150 words' })}
    ${h.stat({ label: 'Links', value: `${d.links.kinds.internal} · ${d.links.kinds.external}`, note: 'internal · external' })}
    ${d.lineLength?.count ? h.stat({ label: 'Line length', value: `${d.lineLength.median} characters`, note: `${d.lineLength.ideal}% in 45–75` }) : ''}
  </div>
  <div class="glance-grid">
    ${readabilityCard(rd, h)}
    <section class="card"><h4>Sentence length</h4>${h.hbars({ label: 'Sentences by length in words', rows: rd.buckets.map((b) => ({ label: b.label, value: b.value, display: String(b.value) })) })}</section>
  </div>`;
}

/**
 * Answer first: the structure and link counts, which the glance does not show. Then only the reading detail the glance
 * lacks (words, average sentence, readability and the sentence bars are the glance's), the outline (folded whole past
 * 8 headings), navigation and the link lists. The link lists stay: when the accessibility plugins cover vague links
 * or missing anchors, Content raises no finding, so these tables are the only place the items appear.
 */
function render(r, h) {
  const d = r.data;
  const s = d.structure;
  const rd = d.reading;
  const lk = d.links;
  const counted = (n, list) => (Number.isInteger(n) ? n : (list || []).length); // older readings: the capped list's length
  const issue = (n) => (n ? 'needs-improvement' : 'good');
  const vagueN = counted(lk.vagueCount, lk.vague);
  const conflictN = counted(lk.conflictingCount, lk.conflicting);
  const missingN = counted(lk.missingCount, lk.missing);
  const scored = rd.flesch != null || rd.ari != null || rd.aari != null || rd.cjkCharsPerSentence != null || rd.readability === 'not enough prose';
  const heads = s.headings || [];
  const outline = heads.length > 8 ? h.more(`Heading outline · ${heads.length} headings`, h.outline(heads)) : h.outline(heads);
  return h.html`
    ${h.stats([
    h.stat({ label: 'Headings', value: heads.length, note: s.skipped ? `${s.skipped} skipped levels` : 'no skipped levels' }),
    h.stat({ label: 'Menus', value: s.navs.length, note: `${s.navLinks} links` }),
    h.stat({ label: 'Vague link text', value: vagueN, rating: issue(vagueN) }),
    h.stat({ label: 'Same text, different places', value: conflictN, rating: issue(conflictN) }),
    h.stat({ label: 'Missing in-page anchors', value: missingN, rating: issue(missingN) }),
  ])}
    ${h.sub('Reading', h.kv([
    ['Sentences', `${rd.proseSentences != null ? `${rd.sentences} lines · ${rd.proseSentences} prose` : rd.sentences} · average ${rd.avgSentence} words`],
    ['Average paragraph', `${rd.avgParagraph} words`], ['Readability', scored ? '' : readabilityRow(rd)],
    ['Text vs markup', d.textShare != null ? `${Math.round(d.textShare * 100)}% text` : ''],
  ]))}
    ${h.sub('Hardest sentences', h.list((rd.hardest || []).map((x) => `${x.text} (${rd.script === 'cjk' && x.chars != null ? `${x.chars} characters` : `${x.words} words`})`)))}
    ${h.sub('Heading outline', outline)}
    ${h.sub('Navigation', h.kv([
    ['Menus', s.navs.length ? s.navs.map((n) => `${n.label || 'nav'}: ${n.links} links, depth ${n.depth}`).join(' · ') : 'none'],
    ['Breadcrumbs', s.breadcrumbs ? 'yes' : 'no'], ['URL', s.shape.length ? s.shape.join(', ') : `depth ${s.depth}`],
  ]))}
    ${h.sub('Vague link text', h.html`${h.table(lk.vague.map((l) => ({ text: l.text || l.aria, href: h.link(l.href) })), [{ key: 'text', label: 'Text' }, { key: 'href', label: 'Link' }])}<p class="note">Links that are hidden on the page are not checked.</p>`)}
    ${h.sub('Same text, different places', h.table(lk.conflicting.map((x) => ({ text: x.text, to: h.list(x.destinations.map((u) => h.link(u))) })), [{ key: 'text', label: 'Text' }, { key: 'to', label: 'Destinations' }]))}
    ${h.sub('Missing in-page anchors', h.list(lk.missing.map((l) => h.url(l.href))))}
  `;
}

export default {
  id: 'content',
  group: 'quality',
  area: 'content',
  name: 'Content',
  version: '0.1.0',
  phase: 'page',
  after: ['meta', 'a11y-structure', 'a11y-basics'],
  description: 'Reading level, heading structure, navigation and links on the page.',
  tags: ['content'],
  collect,
  run,
  glance,
  render,
};
