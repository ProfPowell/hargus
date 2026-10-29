// Broken links and assets: which recorded requests count as assets, the places each broken URL is used,
// and the on-page / internal / external groups Link check reports. Pure — no DOM, no chrome.*, no fetch.

import { bodyText, hostOf, mainEntry, resourceType } from './har-util.js';

export const ASSET_KINDS = ['image', 'script', 'stylesheet', 'font', 'media', 'frame'];

/**
 * The asset kind of a recorded request, or null when it isn't one that can be broken.
 * `main` is the main document entry (har-util.mainEntry). A redirect hop (3xx) is never a frame:
 * the main document's chain is all 3xx up to `main`, and a hop can't be broken anyway.
 * With no `main` a document can't be told from the page itself, so it is never a frame.
 */
export function assetKind(entry, main) {
  const type = resourceType(entry);
  if (type === 'document' || entry._resourceType === 'iframe') {
    const s = entry.response?.status;
    if (!main || entry === main || (s >= 300 && s < 400)) return null;
    return 'frame';
  }
  return ASSET_KINDS.includes(type) ? type : null;
}

/** True for a recorded request that is an asset (assetKind) and came back with an HTTP error. */
export function isBrokenAsset(entry, main) {
  return assetKind(entry, main) != null && entry.response?.status >= 400;
}

/* ------------------------------------------------------------ source lines */

const REFUSED = [401, 403, 429];
const MAX_SOURCES = 20;
const RAW_CUT = 500; // Content keeps at most this much of a raw href
const noHash = (u) => String(u).split('#')[0];
const amp = (s) => s.replace(/&/g, '&amp;');
const lineAt = (text, pos) => text.slice(0, pos).split('\n').length;

// Every offset where needle (or its &amp; form) starts, in order.
function offsets(text, needle) {
  const out = new Set();
  for (const n of new Set([needle, amp(needle)])) {
    for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1)) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/** The 1-based line of the first of `needles` found in text (each also tried with & as &amp;), or null. */
export function lineOf(text, needles) {
  if (!text) return null;
  for (const n of [].concat(needles)) {
    const [at] = n ? offsets(text, n) : [];
    if (at != null) return lineAt(text, at);
  }
  return null;
}

// The character references an href is likely to be written with: &amp; &quot; &apos; and numeric ones (&#038; &#x26;).
const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
function decode(s) {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (m, hex, dec, name) => {
    if (name) return NAMED[name.toLowerCase()] ?? m;
    const cp = hex ? parseInt(hex, 16) : Number(dec);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

// <a … href=value>, double-, single- or unquoted. Only <a>: <link>, <base> and <use> hrefs are not links.
const A_HREF = /<a\b[^>]*?[\s"'/]href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi;

/**
 * Every <a href> written in an HTML text, read once: Map(decoded href → [1-based lines]), each list in order.
 * Lines come from the newline offsets by binary search, so a big page with many links stays fast.
 */
export function hrefIndex(text) {
  const index = new Map();
  if (!text) return index;
  const nl = [];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) nl.push(i);
  const line = (pos) => {
    let lo = 0; let hi = nl.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < pos) lo = mid + 1; else hi = mid; }
    return lo + 1;
  };
  for (const m of text.matchAll(A_HREF)) {
    const value = decode(m[1] ?? m[2] ?? m[3]);
    if (!index.has(value)) index.set(value, []);
    index.get(value).push(line(m.index + m[0].length - 1)); // the line the value ends on
  }
  return index;
}

// The lines a raw href is written on. A raw cut at Content's limit matches every href it begins.
function hrefLines(index, raw) {
  if (raw.length < RAW_CUT) return index.get(raw) || [];
  const out = [];
  for (const [value, lines] of index) if (value.startsWith(raw)) out.push(...lines);
  return out.sort((a, b) => a - b);
}

// The page's host is left off; any other host stays, so a vendor's file reads as theirs.
const fileOf = (u, pageHost) => { try { const x = new URL(u); return (x.hostname === pageHost ? '' : x.host) + x.pathname + x.search; } catch { return u; } };

/**
 * Where a recorded asset was asked for, from its _initiator: [{ via, file, line? }], or [{ note: 'source unknown' }].
 * Only the direct initiator; the chain is not walked back.
 */
export function assetSources(entry, har, pageUrl) {
  const init = entry._initiator;
  if (!init?.url) return [{ note: 'source unknown' }];
  const onPage = noHash(init.url) === noHash(pageUrl);
  const from = (har?.log?.entries || []).find((e) => noHash(e.request.url) === noHash(init.url));
  const type = from ? resourceType(from) : init.type === 'script' ? 'script' : '';
  const via = !onPage && ['stylesheet', 'script'].includes(type) ? type : 'page';
  const src = { via, file: onPage ? 'this page' : fileOf(init.url, hostOf(pageUrl)) };
  if (Number.isInteger(init.lineNumber)) src.line = init.lineNumber + 1; // CDP lines are 0-based
  else {
    let needles = [entry.request.url];
    try { const { pathname, search } = new URL(entry.request.url); needles = [...needles, pathname + search, pathname, pathname.split('/').pop()]; } catch { /* keep the URL */ }
    const line = lineOf(bodyText(onPage ? mainEntry(har) : from), needles);
    if (line) src.line = line;
  }
  return [src];
}

/**
 * Link sources with their line in the page's HTML. mainText is the main document's body, or null when none was
 * recorded; index is its hrefIndex, passed in when the caller already has one. The nth anchor with the same raw href
 * takes the nth place it is written; past those it was added by a script.
 */
export function linkSources(srcs, mainText, index = mainText == null ? null : hrefIndex(mainText)) {
  const used = new Map();
  return (srcs || []).map(({ raw, text, region, selector }) => {
    const s = { ...(text ? { text } : {}), ...(region ? { region } : {}), ...(selector ? { selector } : {}) };
    if (mainText == null) return { ...s, note: 'source not in the recording' };
    if (raw == null) return s; // older readings kept no raw href
    const hits = hrefLines(index, raw);
    const n = used.get(raw) || 0;
    used.set(raw, n + 1);
    return n < hits.length ? { ...s, line: hits[n] } : { ...s, note: 'added by a script' };
  });
}

/* ---------------------------------------------------------------- grouping */

const places = (it) => it.sources.length + it.moreSources;
const byStatus = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));
const order = (a, b) => places(b) - places(a) || byStatus(a.status, b.status) || a.url.localeCompare(b.url);
const capped = ({ url, status, kind, all, more }) =>
  ({ url, status, kind, sources: all.slice(0, MAX_SOURCES), moreSources: Math.max(0, all.length - MAX_SOURCES) + more });

/**
 * Broken links and assets, grouped: { page, internal, external, others }, each item { url, status, kind, sources, moreSources }.
 * checked = Link check's results; sources = Content's linkTargets.sources; missing = Content's links.missing.
 * A recorded asset's status wins over Link check's: the browser fetched it as a visitor would, with cookies.
 * others = external assets only other sites' code asked for (an ad network's sync pixels): not the site's to fix,
 * so not counted. The site asked when an initiator is on its own site or unknown, or the page links to the URL.
 */
export function groupBroken({ checked = [], sources = {}, missing = [], har, pageUrl, siteOf }) {
  const main = mainEntry(har);
  const mainText = bodyText(main) || null;
  const index = mainText == null ? null : hrefIndex(mainText);
  const site = siteOf(hostOf(pageUrl));
  const ours = (u) => siteOf(hostOf(u)) === site;
  // With no page site, or an initiator with no host (blob:, about:srcdoc), who asked is unknown: count it.
  const siteAsked = (u) => { const h = hostOf(u); return !site || !h || siteOf(h) === site; };
  const items = new Map();
  const loaded = new Set();
  for (const e of har?.log?.entries || []) {
    const status = e.response?.status;
    const url = noHash(e.request.url);
    if (!isBrokenAsset(e, main)) {
      // Loaded means a 2xx (or a 304 from cache): a 3xx hop says nothing about where it ends up.
      if (assetKind(e, main) && ((status >= 200 && status < 300) || status === 304)) loaded.add(url);
      continue; // no status: Network's "requests failed"
    }
    const kind = assetKind(e, main);
    if (!items.has(url)) items.set(url, { url, status, kind, all: [], more: 0, asked: false });
    const it = items.get(url);
    it.all.push(...assetSources(e, har, pageUrl));
    if (!e._initiator?.url || siteAsked(e._initiator.url)) it.asked = true;
  }
  for (const c of checked) {
    if (c.skipped || !(c.status >= 400) || REFUSED.includes(c.status)) continue;
    if (items.has(c.url)) items.get(c.url).asked = true; // the page links to it
    else if (!loaded.has(noHash(c.url))) items.set(c.url, { url: c.url, status: c.status, kind: 'page', all: [], more: 0, asked: true });
  }
  for (const it of items.values()) {
    const s = sources?.[it.url];
    if (s) { it.all.push(...linkSources(s.list, mainText, index)); it.more += s.more || 0; it.asked = true; }
  }
  const out = { page: [], internal: [], external: [], others: [] };
  for (const it of items.values()) out[ours(it.url) ? 'internal' : it.asked ? 'external' : 'others'].push(capped(it));

  const anchors = new Map(); // href -> link sources
  for (const l of missing || []) {
    if (!anchors.has(l.href)) anchors.set(l.href, []);
    anchors.get(l.href).push({ raw: l.raw, text: (l.text || l.aria || '').slice(0, 80), region: l.region, selector: l.selector });
  }
  for (const [url, links] of anchors) out.page.push(capped({ url, status: 'no such id', kind: 'anchor', all: linkSources(links, mainText, index), more: 0 }));
  for (const g of Object.values(out)) g.sort(order);
  return out;
}

/* ---------------------------------------------------------------- findings */

const KIND_ORDER = ['page', 'image', 'script', 'stylesheet', 'font', 'media', 'frame'];
const plural = (n, word) => `${n} ${n === 1 || word === 'media' ? word : `${word}s`}`;

// One source in words: "used in /css/site.css line 212", "loaded by /js/x.js line 40", "used in “Our team” · nav · line 41".
function sourceText(s) {
  if (s.file) return `${s.via === 'script' ? 'loaded by' : 'used in'} ${s.file}${s.line ? ` line ${s.line}` : ''}`;
  const parts = [s.text && `“${s.text}”`, s.region, s.line ? `line ${s.line}` : s.note].filter(Boolean);
  return s.text || s.region ? `used in ${parts.join(' · ')}` : parts.join(' · ') || 'source unknown';
}

// The page's own anchors by fragment, URLs on the page's host by path, any other host (a subdomain too) with it.
function shortUrl(group, url, pageHost) {
  try {
    const u = new URL(url);
    if (group === 'page') return u.hash;
    const other = pageHost ? u.hostname !== pageHost : group === 'external';
    return (other ? u.host : '') + u.pathname + u.search;
  } catch { return url; }
}

// One broken item as a finding place: its URL and status, where its first source is, and how many more there are.
function itemPlace(it, entryOf) {
  const p = { url: it.url, status: it.status };
  const s = it.sources?.[0] || {};
  for (const k of ['text', 'region', 'line', 'selector', 'file']) if (s[k] != null && s[k] !== '') p[k] = s[k];
  const more = (it.sources?.length || 0) - 1 + (it.moreSources || 0);
  if (more > 0) p.note = `and ${more} more place${more === 1 ? '' : 's'}`;
  const entry = entryOf?.(it.url);
  if (Number.isInteger(entry)) p.entry = entry;
  return p;
}

/**
 * The medium Content finding for one group ('page' | 'internal' | 'external'), or null when it is empty.
 * pageUrl is the page's final URL; missingCount is Content's count of links to missing anchors, which can be
 * more than the links it kept (the title then says how many were checked). entryOf(url) is the HAR index of the
 * recorded request for a URL, or undefined; it gives each place its entry.
 */
export function groupFinding(group, items, { pageUrl, missingCount, entryOf } = {}) {
  if (!items?.length) return null;
  const n = items.length;
  let title = `${n} broken link${n === 1 ? '' : 's'} on this page`;
  if (group === 'page') {
    const kept = items.reduce((sum, it) => sum + places(it), 0);
    if (missingCount > kept) title += ` (first ${kept} checked)`;
  } else {
    const kinds = KIND_ORDER.map((k) => [k, items.filter((i) => i.kind === k).length]).filter(([, c]) => c).map(([k, c]) => plural(c, k));
    title = `${n} broken ${group} ${n === 1 ? 'link or asset' : 'links and assets'} (${kinds.join(', ')})`;
  }
  const pageHost = hostOf(pageUrl || '');
  const detail = items.slice(0, 3).map((it) => {
    const more = it.sources.length - 1 + it.moreSources;
    return `${it.status} ${shortUrl(group, it.url, pageHost)} — ${it.kind}, ${it.sources.length ? sourceText(it.sources[0]) : 'source unknown'}` +
      (more > 0 ? ` …and in ${more} more place${more === 1 ? '' : 's'}` : '');
  }).join('; ');
  return {
    id: `broken-${group}`, severity: 'medium', category: 'content', title, detail,
    evidence: items.slice(0, 10).map((i) => i.url).join('\n'),
    // On-page anchors are the page itself plus a fragment: no request of their own to open.
    places: items.map((it) => itemPlace(it, group === 'page' ? undefined : entryOf)),
    count: n, unit: group === 'page' ? 'broken links' : 'broken links and assets',
  };
}
