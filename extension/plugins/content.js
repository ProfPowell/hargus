// Content: reading level, structure / information architecture and links on the page.
// collect() runs in the page (self-contained); analyze() is pure and unit-tested.

const VAGUE = new Set(['click here', 'here', 'read more', 'learn more', 'more', 'click', 'this', 'link', 'details', 'continue']);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const SESSION = /^(sid|sessionid|jsessionid|phpsessid)$/i;

function collect() {
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const EX = 'nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], script, style, noscript, template';
  const body = document.body;
  if (!body) return { url: location.href, lang: '', text: '', bodyTextBytes: 0, paragraphs: [], headings: [], navs: [], breadcrumb: false, links: [], ids: [] };
  const main = document.querySelector('main, [role=main]');
  const articles = document.querySelectorAll('article');
  const root = main || (articles.length === 1 ? articles[0] : body);
  const scoped = root === body;
  // Visible text of the live DOM; in the whole-body fallback, skip chrome subtrees without mutating the page.
  // innerText of an unrendered element (display:none, [hidden]) is its raw text, so test rendering explicitly.
  const shown = (el) => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);
  const gather = (el) => {
    if (el.matches(EX) || !shown(el)) return [];
    if (!el.querySelector(EX)) return [el.innerText || ''];
    return [...el.childNodes].flatMap((n) => (n.nodeType === 3 ? [n.textContent] : n.nodeType === 1 ? gather(n) : []));
  };
  const text = scoped ? gather(body).join('\n') : (root.innerText || '');
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
  for (const a of [...document.querySelectorAll('a[href]')].slice(0, 3000)) {
    let href;
    try { href = new URL(a.getAttribute('href'), document.baseURI).href; } catch { continue; }
    links.push({ href, text: clean(a.innerText || a.textContent).slice(0, 120), aria: clean(a.getAttribute('aria-label')).slice(0, 120) });
  }
  const ids = [...document.querySelectorAll('[id], a[name]')].map((el) => el.id || el.getAttribute('name')).filter(Boolean);
  return {
    url: location.href,
    lang: document.documentElement.lang || '',
    text: text.slice(0, 200_000),
    bodyTextBytes: new TextEncoder().encode(body.innerText || '').length,
    paragraphs,
    headings: [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((x) => shown(x) && !x.closest('[aria-hidden="true"]')).slice(0, 300).map((x) => ({ level: Number(x.tagName[1]), text: clean(x.innerText || x.textContent).slice(0, 300) })),
    navs, breadcrumb, links, ids: [...new Set(ids)].slice(0, 5000),
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
  return text.split(/[.!?]+(?=\s|$)|[。！？]+/).map((s) => s.trim()).filter((s) => /[\p{L}\p{N}]/u.test(s));
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
    .map((s) => ({ text: s.length > 120 ? `${s.slice(0, 120)}…` : s, words: countWords(s), chars: [...s.replace(/\s/g, '')].length }))
    .sort((a, b) => (cjk ? b.chars - a.chars : b.words - a.words))
    .slice(0, 5);
}

const noHash = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return null; } };
const siteOfHost = (host) => host.replace(/^www\./, '');

function englishText(lang, text) {
  if (lang) return /^en\b/i.test(lang);
  const letters = text.match(/\p{L}/gu) || [];
  return letters.length > 0 && letters.filter((c) => /[a-z]/i.test(c)).length / letters.length > 0.9;
}

/** Pure analysis of collected page data. meta: meta plugin data; docBytes: HTML document size from the HAR. */
export function analyze(c, { meta = {}, url = c.url, docBytes = 0, siteOf = siteOfHost } = {}) {
  const findings = [];
  const add = (severity, title, detail) => findings.push({ severity, category: 'content', title, ...(detail ? { detail } : {}) });

  // Reading
  const words = countWords(c.text);
  const sentences = splitSentences(c.text);
  const lens = sentences.map((s) => countWords(s));
  const longShare = lens.length ? lens.filter((n) => n > 25).length / lens.length : 0;
  const paraWords = c.paragraphs.map((p) => countWords(p.text));
  const walls = c.paragraphs.filter((_, i) => paraWords[i] > 150);
  const english = englishText(c.lang, c.text);
  const syl = english ? (c.text.match(/[A-Za-z]+/g) || []).reduce((n, w) => n + syllables(w), 0) : 0;
  const f = english ? flesch({ words, sentences: sentences.length, syllables: syl }) : null;
  const script = scriptOf(c.text);
  const letterCount = (String(c.text).match(/[\p{L}\p{N}]/gu) || []).length;
  const counts = { letters: letterCount, words, sentences: sentences.length };
  const ariVal = !english && ['latin', 'cyrillic', 'greek'].includes(script) ? ari(counts) : null;
  const aariVal = !english && script === 'arabic' ? aari(counts) : null;
  const cjkCps = !english && script === 'cjk' && sentences.length
    ? Math.round(sentences.reduce((n, x) => n + [...x.replace(/\s/g, '')].length, 0) / sentences.length) : null;
  const reading = {
    words, minutes: Math.max(1, Math.ceil(words / 230)), sentences: sentences.length,
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
    readability: english ? (f ? 'flesch' : 'not enough text') : ariVal != null ? 'ari' : aariVal != null ? 'aari' : cjkCps != null ? 'cjk' : `not applicable: ${script}`,
    buckets: [[1, 10], [11, 15], [16, 20], [21, 25], [26, 35], [36, Infinity]].map(([lo, hi]) => ({
      label: hi === Infinity ? `${lo}+` : `${lo}–${hi}`, value: lens.filter((n) => n >= lo && n <= hi).length,
    })),
  };
  if (lens.length && longShare > 0.3) add('low', `Many long sentences (${Math.round(longShare * 100)}% over 25 words)`);
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
    const bucket = isInternal ? internal : external;
    if (!bucket.includes(dest) && bucket.length < 500) bucket.push(dest);
    if (label) {
      if (!byText.has(label)) byText.set(label, new Set());
      byText.get(label).add(dest);
    }
  }
  const conflicting = [...byText].filter(([, d]) => d.size > 1);
  const pageLinks = kinds.internal + kinds.external;
  const perThousandWords = words ? Math.round((pageLinks / words) * 1000) : 0;
  if (vague.length) add('low', `${vague.length} links with vague text`, vague.slice(0, 10).map((l) => `“${l.text || l.aria}” → ${l.href}`).join('; '));
  if (conflicting.length) add('low', `${conflicting.length} link texts point to different places`, conflicting.slice(0, 10).map(([t, d]) => `“${t}”: ${[...d].join(', ')}`).join('; '));
  if (missing.length) add('medium', `${missing.length} links to missing in-page anchors`, missing.slice(0, 10).map((l) => l.href).join(', '));
  if (words >= 200 && perThousandWords > 100) add('low', `Very link-dense (${perThousandWords} links per 1,000 words)`);

  const summary = [
    { label: 'Reading', value: `${words.toLocaleString()} words · ${reading.minutes} min${reading.flesch != null ? ` · Flesch ${reading.flesch}` : ''}`, headline: true },
    { label: 'Links', value: `${kinds.internal} internal · ${kinds.external} external`, headline: true },
    { label: 'Headings', value: `${heads.length}${skipped ? ` · ${skipped} skipped levels` : ''}` },
    { label: 'Navigation', value: c.navs.length ? `${c.navs.length} nav · ${navLinks} links` : 'none' },
  ];
  return {
    data: {
      reading, textShare,
      structure: { headings: heads, skipped, empty, navs: c.navs, navLinks, breadcrumbs, depth, shape },
      links: { kinds, perThousandWords, vague: vague.slice(0, 20), conflicting: conflicting.slice(0, 20).map(([t, d]) => ({ text: t, destinations: [...d] })), missing: missing.slice(0, 20) },
      linkTargets: { internal, external },
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
  return analyze(c, { meta, url, docBytes: Math.max(0, doc?.response?.content?.size || 0), siteOf: ctx.util?.siteOf });
}

const fleschStatus = (e) => (e == null ? 'none' : e >= 60 ? 'good' : e >= 50 ? 'warning' : e >= 30 ? 'serious' : 'critical');

function readabilityCard(rd, h) {
  if (rd.flesch != null) return h.html`<section class="card"><h4>Readability</h4>${h.ring({ value: Math.max(0, Math.min(100, rd.flesch)), size: 72, status: fleschStatus(rd.flesch), label: 'Flesch reading ease' })}<p class="note">Flesch ${rd.flesch} · grade ${rd.grade}</p></section>`;
  if (rd.ari != null) {
    const status = rd.ari > 16 ? 'critical' : rd.ari > 12 ? 'serious' : 'good';
    return h.html`<section class="card"><h4>Readability</h4>${h.ring({ value: Math.max(0, Math.min(100, Math.round(100 - (rd.ari - 6) * 8))), size: 72, status, label: 'ARI grade' })}<p class="note">ARI grade ${Math.round(rd.ari)}</p></section>`;
  }
  if (rd.aari != null) return h.html`<section class="card"><h4>Readability</h4>${h.stat({ label: 'AARI', value: String(rd.aari), note: 'Arabic readability index' })}</section>`;
  if (rd.cjkCharsPerSentence != null) return h.html`<section class="card"><h4>Readability</h4>${h.stat({ label: 'Sentence length', value: String(rd.cjkCharsPerSentence), note: 'characters per sentence' })}</section>`;
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
  </div>
  <div class="glance-grid">
    ${readabilityCard(rd, h)}
    <section class="card"><h4>Sentence length</h4>${h.hbars({ label: 'Sentences by length in words', rows: rd.buckets.map((b) => ({ label: b.label, value: b.value, display: String(b.value) })) })}</section>
  </div>`;
}

function render(r, h) {
  const d = r.data;
  const s = d.structure;
  return h.html`
    ${h.sub('Reading', h.kv([
      ['Words', `${d.reading.words} · ${d.reading.minutes} min`], ['Sentences', `${d.reading.sentences} · average ${d.reading.avgSentence} words`],
      ['Paragraphs', `${d.reading.paragraphs} · average ${d.reading.avgParagraph} words`], ['Readability', readabilityRow(d.reading)],
      ['Text vs markup', d.textShare != null ? `${Math.round(d.textShare * 100)}% text` : ''],
    ]))}
    ${h.sub('Hardest sentences', h.list((d.reading.hardest || []).map((x) => `${x.text} (${x.words} words)`)))}
    ${h.sub('Heading outline', h.outline(s.headings))}
    ${h.sub('Navigation', h.kv([
      ['Menus', s.navs.length ? s.navs.map((n) => `${n.label || 'nav'}: ${n.links} links, depth ${n.depth}`).join(' · ') : 'none'],
      ['Breadcrumbs', s.breadcrumbs ? 'yes' : 'no'], ['URL', s.shape.length ? s.shape.join(', ') : `depth ${s.depth}`],
    ]))}
    ${h.sub('Vague link text', h.table(d.links.vague.map((l) => ({ text: l.text || l.aria, href: h.link(l.href) })), [{ key: 'text', label: 'Text' }, { key: 'href', label: 'Link' }]))}
    ${h.sub('Same text, different places', h.table(d.links.conflicting.map((x) => ({ text: x.text, to: x.destinations.join(' · ') })), [{ key: 'text', label: 'Text' }, { key: 'to', label: 'Destinations' }]))}
    ${h.sub('Missing in-page anchors', h.list(d.links.missing.map((l) => l.href)))}
  `;
}

export default {
  id: 'content',
  group: 'quality',
  area: 'content',
  name: 'Content',
  version: '0.1.0',
  phase: 'page',
  after: ['meta'],
  description: 'Reading level, heading structure, navigation and links on the page.',
  tags: ['content'],
  collect,
  run,
  glance,
  render,
};
