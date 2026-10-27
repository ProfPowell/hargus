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

/* ------------------------------------------------------------ source lines */

const REFUSED = [401, 403, 429];
const MAX_SOURCES = 20;
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

/** Every 1-based line where needle (or its &amp; form) appears, one per occurrence, in order. */
export function linesOf(text, needle) {
  return text && needle ? offsets(text, needle).map((i) => lineAt(text, i)) : [];
}

const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };

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
  const src = { via, file: onPage ? 'this page' : pathOf(init.url) };
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
 * recorded. The nth anchor with the same raw href takes the nth place it is written; past those it was added by a script.
 */
export function linkSources(srcs, mainText) {
  const used = new Map();
  return (srcs || []).map(({ raw, text, region, selector }) => {
    const s = { ...(text ? { text } : {}), ...(region ? { region } : {}), ...(selector ? { selector } : {}) };
    if (mainText == null) return { ...s, note: 'source not in the recording' };
    if (raw == null) return s; // older readings kept no raw href
    // The href attribute as written, in its usual quotings.
    const hits = [`href="${raw}"`, `href='${raw}'`, `href=${raw}>`, `href=${raw} `]
      .flatMap((n) => linesOf(mainText, n)).sort((a, b) => a - b);
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
 * Broken links and assets, grouped: { page, internal, external }, each item { url, status, kind, sources, moreSources }.
 * checked = Link check's results; sources = Content's linkTargets.sources; missing = Content's links.missing.
 * A recorded asset's status wins over Link check's: the browser fetched it as a visitor would, with cookies.
 */
export function groupBroken({ checked = [], sources = {}, missing = [], har, pageUrl, siteOf }) {
  const main = mainEntry(har);
  const mainText = bodyText(main) || null;
  const items = new Map();
  const loaded = new Set();
  for (const e of har?.log?.entries || []) {
    const kind = assetKind(e, main);
    const status = e.response?.status;
    if (!kind || !(status > 0)) continue; // no status: Network's "requests failed"
    const url = noHash(e.request.url);
    if (status < 400) { loaded.add(url); continue; }
    if (!items.has(url)) items.set(url, { url, status, kind, all: [], more: 0 });
    items.get(url).all.push(...assetSources(e, har, pageUrl));
  }
  for (const c of checked) {
    if (c.skipped || !(c.status >= 400) || REFUSED.includes(c.status)) continue;
    if (!items.has(c.url) && !loaded.has(noHash(c.url))) items.set(c.url, { url: c.url, status: c.status, kind: 'page', all: [], more: 0 });
  }
  for (const it of items.values()) {
    const s = sources?.[it.url];
    if (s) { it.all.push(...linkSources(s.list, mainText)); it.more += s.more || 0; }
  }
  const site = siteOf(hostOf(pageUrl));
  const out = { page: [], internal: [], external: [] };
  for (const it of items.values()) out[siteOf(hostOf(it.url)) === site ? 'internal' : 'external'].push(capped(it));

  const anchors = new Map(); // href -> link sources
  for (const l of missing || []) {
    if (!anchors.has(l.href)) anchors.set(l.href, []);
    anchors.get(l.href).push({ raw: l.raw, text: (l.text || l.aria || '').slice(0, 80), region: l.region, selector: l.selector });
  }
  for (const [url, links] of anchors) out.page.push(capped({ url, status: 'no such id', kind: 'anchor', all: linkSources(links, mainText), more: 0 }));
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

// The page's own anchors by fragment, internal URLs by path, external ones with their host.
function shortUrl(group, url) {
  try {
    const u = new URL(url);
    return group === 'page' ? u.hash : (group === 'external' ? u.host : '') + u.pathname + u.search;
  } catch { return url; }
}

/** The medium Content finding for one group ('page' | 'internal' | 'external'), or null when it is empty. */
export function groupFinding(group, items) {
  if (!items?.length) return null;
  const n = items.length;
  let title = `${n} broken link${n === 1 ? '' : 's'} on this page`;
  if (group !== 'page') {
    const kinds = KIND_ORDER.map((k) => [k, items.filter((i) => i.kind === k).length]).filter(([, c]) => c).map(([k, c]) => plural(c, k));
    title = `${n} broken ${group} ${n === 1 ? 'link or asset' : 'links and assets'} (${kinds.join(', ')})`;
  }
  const detail = items.slice(0, 3).map((it) => {
    const more = it.sources.length - 1 + it.moreSources;
    return `${it.status} ${shortUrl(group, it.url)} — ${it.kind}, ${it.sources.length ? sourceText(it.sources[0]) : 'source unknown'}` +
      (more > 0 ? ` …and in ${more} more place${more === 1 ? '' : 's'}` : '');
  }).join('; ');
  return {
    id: `broken-${group}`, severity: 'medium', category: 'content', title, detail,
    evidence: items.slice(0, 10).map((i) => i.url).join('\n'),
    count: n, unit: group === 'page' ? 'broken links' : 'broken links and assets',
  };
}
