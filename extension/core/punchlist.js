// Punch list: a reading's high/medium/low findings as a Markdown checklist with stable item IDs, plus a
// machine-readable block the recheck reads back. Pure; shared by the extension's export and the Node recheck.
// Item ID: "HG-" + FNV-1a 32-bit of "plugin|rule|path+query|subject" — never counts, timings, sizes, selectors or places.

import { findings, placeText, MD_PLACES } from './harplus.js';
import { ruleInfo } from './rules.js';
import { resultArea } from './score.js';
import { CAPTURE_DEFAULTS, THROTTLE_WORD } from './compare.js';
import { VISION_VIEWS, shotsByView } from './views.js';

const INCLUDED = ['high', 'medium', 'low'];
const SECTIONS = [['high', 'High'], ['medium', 'Medium'], ['low', 'When you have time']];
const BLOCK = 'hargus-punchlist';
/** The view option keys (DEFAULTS.capture.views in browser/settings.js; a test pins the two equal). */
export const VIEW_KEYS = [
  'desktop', 'tablet', 'mobile', 'nojs', 'nocss', 'noimages', 'rtl', 'translated-de', 'translated-ar', 'translated-ja', 'pseudo',
  'vision', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred', 'lowcontrast',
  'dark', 'forced', 'morecontrast', 'print', 'spacing', 'reflow', 'text200', 'breakpoints',
];

/** FNV-1a 32-bit over the UTF-8 bytes of `text`, as 8 lowercase hex digits. */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** The stable item ID for one rule on one page path (and its subject, when the rule emits several per page). */
export const itemId = (plugin, rule, pathAndQuery, subject = '') => `HG-${fnv1a(`${plugin}|${rule}|${pathAndQuery}|${subject || ''}`)}`;

/** A URL's path and query, without scheme, host or fragment; "/" for an empty path. */
export function pathOf(url) {
  try {
    const u = new URL(String(url));
    return `${u.pathname || '/'}${u.search}`;
  } catch {
    return '/';
  }
}

const targetUrl = (reading) => {
  const t = reading.log._harplus?.target || {};
  return t.url || t.finalUrl || '';
};

/** True when every non-info active finding carries a rule id (false means item IDs would be unreliable). */
export function hasRuleIds(reading) {
  return findings(reading).every((f) => f.severity === 'info' || !!f.id);
}

/** The finding's reference link: the rule's (WCAG or rule page), else a URL the finding itself carries. */
function refOf(info, f) {
  if (info.ref) return info.ref;
  if (typeof f.ref === 'string' && /^https?:\/\//.test(f.ref)) {
    try { return { label: new URL(f.ref).host, url: f.ref }; } catch { /* not a URL */ }
  }
  return undefined;
}

/**
 * The punch list items for a reading: active high/medium/low findings in report order, each with a stable `id`.
 * `plugins` (optional) resolves the area of results saved without one.
 */
export function punchItems(reading, { plugins = [], path = pathOf(targetUrl(reading)) } = {}) {
  const results = reading.log._harplus?.plugins || {};
  const items = findings(reading).filter((f) => INCLUDED.includes(f.severity)).map((f) => {
    const area = resultArea(results[f.plugin], plugins);
    const extra = f.plugin === 'axe' ? { help: String(f.title || '').replace(/\s*\(\d[\d,]*\)$/, ''), url: f.ref, tags: f.tags } : {};
    const info = ruleInfo(f.plugin, f.id, area, extra);
    const consoleOnly = f.plugin === 'console';
    const places = (f.places || []).map((p) => placeText(p, consoleOnly)).filter(Boolean);
    const ref = refOf(info, f);
    return {
      id: itemId(f.plugin, f.id || '', path, f.subject),
      plugin: f.plugin,
      rule: f.id || '',
      ...(f.subject ? { subject: f.subject } : {}),
      severity: f.severity,
      tag: info.tag,
      title: f.title,
      // Console details quote the page's own messages, which can carry user data: titles and line numbers only.
      // axe's detail is its WCAG tag list, not a description: its title says what is wrong.
      ...(f.detail && !consoleOnly && f.plugin !== 'axe' ? { detail: String(f.detail).replace(/\s+/g, ' ').trim() } : {}),
      places: places.slice(0, MD_PLACES),
      placesTotal: places.length,
      ...(info.expected ? { expected: info.expected } : {}),
      ...(ref ? { ref } : {}),
    };
  });
  // Same-ID findings: sorted by subject then title, the first keeps the ID and the rest get -2, -3.
  const groups = new Map();
  for (const it of items) groups.set(it.id, [...(groups.get(it.id) || []), it]);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => cmp(a.subject || '', b.subject || '') || cmp(String(a.title), String(b.title)));
    sorted.forEach((it, i) => { if (i) it.id = `${it.id}-${i + 1}`; });
  }
  return items;
}

/** Code-unit order: the same in every browser and in Node, unlike localeCompare. */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A recorded view name as its option key: breakpoint edges (bp641-below…) are "breakpoints"; null for none. */
function viewKey(name) {
  const v = String(name || '');
  if (/^bp\d/.test(v) || v === 'breakpoints') return 'breakpoints';
  return VIEW_KEYS.includes(v) ? v : null;
}

/**
 * The view options a reading was recorded with, as { [option key]: boolean } over every key: on for a view measured,
 * shot or skipped for a reason other than "disabled" (skipped views were wanted; the pseudo-view "all" is dropped).
 */
function viewSettings(reading) {
  const hp = reading.log._harplus || {};
  const c = hp.capture || {};
  const on = new Set();
  const names = [
    ...Object.keys(c.views && typeof c.views === 'object' && !Array.isArray(c.views) ? c.views : {}),
    ...Object.keys(shotsByView(reading)),
    ...(c.viewsSkipped || []).filter((s) => s?.reason !== 'disabled').map((s) => s?.view),
  ];
  for (const n of names) {
    const k = viewKey(n);
    if (k) on.add(k);
  }
  if (VISION_VIEWS.some((v) => on.has(v))) on.add('vision');
  return Object.fromEntries(VIEW_KEYS.map((k) => [k, on.has(k)]));
}

/** The capture settings the recheck reuses, with defaults for readings that did not store one. */
function captureSettings(reading) {
  const hp = reading.log._harplus || {};
  const c = hp.capture || {};
  const pick = (k) => c[k] ?? CAPTURE_DEFAULTS[k];
  const sk = hp.runs?.skipped;
  const skipped = Array.isArray(sk) ? sk.length : Number(sk) || 0;
  return {
    device: pick('device'), throttle: pick('throttle'), bypassCache: !!pick('bypassCache'),
    runs: (Number(c.runs) || CAPTURE_DEFAULTS.runs) + skipped, coverage: !!pick('coverage'), views: viewSettings(reading),
  };
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Page-derived text as inert Markdown: one line; backslash, "<", backtick and "*" escaped so markup, code and bold stay text. */
const text = (s) => oneLine(s).replace(/[\\<`*]/g, '\\$&');
/** A URL safe inside an autolink or a code span: whitespace, "<", ">" and backticks percent-encoded. */
const safeUrl = (u) => String(u ?? '').trim().replace(/[\s<>`]/g, (ch) => encodeURIComponent(ch));

/** A status as the Markdown shows it after the item's ID ('' for open). */
function statusWords(s) {
  switch (s?.status) {
    case 'fixed': return `fixed ${s.since || ''}`.trim();
    case 'still': return 'still there';
    case 'deploy': return 'verify after deploy';
    case 'cantcheck': return `can't check: ${text(s.reason || 'unknown reason')}`;
    default: return '';
  }
}

/** One item as a Markdown checklist entry; ticked only when fixed. */
function itemMarkdown(it, pageUrl, status) {
  const s = blockStatus(status);
  const words = statusWords(s);
  const head = `- [${s.status === 'fixed' ? 'x' : ' '}] **${text(it.title)}** · ${it.severity} · ${it.tag} · \`${it.id}\`${words ? ` — ${words}` : ''}`;
  const lines = [head, `  - **Where:** ${safeUrl(pageUrl)}`];
  lines.push(...it.places.map((p) => `    - ${text(p)}`));
  const more = it.placesTotal - it.places.length;
  if (more > 0) lines.push(`    - …and ${more} more place${more === 1 ? '' : 's'}`);
  if (it.detail && oneLine(it.detail) !== oneLine(it.title)) lines.push(`  - **What's wrong:** ${text(it.detail)}`);
  if (it.expected) lines.push(`  - **Expected:** ${text(it.expected)}`);
  if (it.ref) lines.push(`  - **Reference:** ${it.ref.label ? `${text(it.ref.label)} — ` : ''}<${safeUrl(it.ref.url)}>`);
  return lines.join('\n');
}

/** A status as the block stores it: { status, since?, reason? }, "open" when none is given. */
function blockStatus(s) {
  if (!s) return { status: 'open' };
  if (typeof s === 'string') return { status: s };
  return { status: s.status || 'open', ...(s.since ? { since: s.since } : {}), ...(s.reason ? { reason: s.reason } : {}) };
}

/** An item as the block keeps it (without its id, the block's key), so a fixed or unchecked item can be shown again. */
const snapshot = (it) => Object.fromEntries(Object.entries(it).filter(([k]) => k !== 'id'));

/**
 * The punch list as Markdown: header, High / Medium / When you have time sections, `## New since last check` for
 * `added`, and the `<!-- hargus-punchlist {json} -->` block as the last line (the recheck's source of truth).
 * `statuses` ({ [id]: { status, since?, reason? } }) come from a recheck; `url` keeps the list's own URL when the
 * reading is a recheck of another host; `checkedAt` and `summary` add a "Rechecked" line.
 */
export function punchMarkdown(reading, items, { statuses = {}, added = [], url: listUrl, checkedAt, summary } = {}) {
  const hp = reading.log._harplus || {};
  const t = hp.target || {};
  const url = listUrl || targetUrl(reading);
  const pageUrl = t.finalUrl || url;
  const s = captureSettings(reading);
  const counts = Object.fromEntries(INCLUDED.map((sev) => [sev, items.filter((i) => i.severity === sev).length]));
  const lines = [
    `# Punch list: ${text(t.title || t.host || url)}`,
    '',
    `<${safeUrl(url)}>`,
    '',
    `Recorded ${hp.capturedAt ? new Date(hp.capturedAt).toLocaleString() : 'at an unknown time'} · ${s.device} · ` +
      `${THROTTLE_WORD[s.throttle] ?? s.throttle} · ${s.runs} run${s.runs === 1 ? '' : 's'}`,
    '',
    `${items.length} item${items.length === 1 ? '' : 's'} (${counts.high} high / ${counts.medium} medium / ${counts.low} low)`,
    '',
    `Recheck: \`node <path-to-hargus>/cli/harplus.mjs recheck <this file> --url ${safeUrl(url)}\``,
  ];
  if (checkedAt != null) lines.push('', `Rechecked ${new Date(checkedAt).toLocaleString()}${summary ? ` · ${text(summary)}` : ''}`);
  for (const [sev, heading] of SECTIONS) {
    const list = items.filter((i) => i.severity === sev);
    if (!list.length) continue;
    lines.push('', `## ${heading}`, '', ...list.map((it) => itemMarkdown(it, pageUrl, statuses[it.id])));
  }
  if (added.length) lines.push('', '## New since last check', '', ...added.map((it) => itemMarkdown(it, pageUrl)));
  const block = {
    v: 1, url, path: pathOf(url), capturedAt: hp.capturedAt, settings: s,
    items: Object.fromEntries([
      ...items.map((i) => [i.id, { ...blockStatus(statuses[i.id]), item: snapshot(i) }]),
      ...added.map((i) => [i.id, { status: 'open', item: snapshot(i) }]),
    ]),
  };
  // Page-derived strings must not open or close an HTML comment: every "<" and ">" in the JSON is written as a \u003c or \u003e escape.
  lines.push('', `<!-- ${BLOCK} ${JSON.stringify(block).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`);
  return `${lines.join('\n')}\n`;
}

// ---- Recheck ----

const BLOCK_LINE = new RegExp(`^<!-- ${BLOCK} (\\{.*\\}) -->\\s*$`);
const CHECKBOX = /^\s*[-*] \[[ xX]\] /;
const ID_TOKEN = /`(HG-[0-9a-f]{8}(?:-\d+)?)`/g;

/**
 * A punch list read back: { meta (the block), visibleIds (IDs still on a checkbox line) }; null when the block is
 * missing or unreadable. The ID is the last backticked HG- token of a `- [ ]` / `- [x]` line.
 */
export function parsePunchList(md) {
  const lines = String(md ?? '').split('\n');
  let meta = null;
  for (let i = lines.length - 1; i >= 0 && !meta; i--) {
    const m = lines[i].match(BLOCK_LINE);
    if (!m) continue;
    try { meta = JSON.parse(m[1]); } catch { return null; }
  }
  if (!meta || meta.v !== 1 || !meta.items || typeof meta.items !== 'object' || Array.isArray(meta.items)) return null;
  const visibleIds = new Set();
  for (const line of lines) {
    if (!CHECKBOX.test(line)) continue;
    const ids = [...line.matchAll(ID_TOKEN)];
    if (ids.length) visibleIds.add(ids.at(-1)[1]);
  }
  return { meta, visibleIds };
}

/** True for a local development URL (localhost, 127.0.0.1, [::1], *.localhost, *.test), or always when `force`. */
export function isLocalUrl(url, force = false) {
  if (force) return true;
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
  return ['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.localhost') || host.endsWith('.test');
}

/** `now` as the local calendar date YYYY-MM-DD. */
function localDate(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const brief = (s, n = 80) => {
  const t = oneLine(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Why a plugin's missing finding proves nothing in this reading, or null when the plugin finished ok. */
function pluginGap(reading, plugin) {
  const r = reading.log._harplus?.plugins?.[plugin];
  if (!r) return `${plugin} did not run`;
  if (r.status === 'ok') return null;
  return `${plugin} ${r.status || 'did not finish'}${r.error ? `: ${brief(r.error)}` : ''}`;
}

/** Why an item about one view (its subject names a view) cannot be judged in this reading, or null. */
function viewGap(reading, subject) {
  const view = String(subject || '');
  if (!view || !viewKey(view)) return null;
  const c = reading.log._harplus?.capture || {};
  const skip = (c.viewsSkipped || []).find((s) => s?.view === view);
  if (skip) return `${view} view skipped${skip.reason ? `: ${brief(skip.reason)}` : ''}`;
  const measured = new Set([
    ...Object.keys(c.views && typeof c.views === 'object' && !Array.isArray(c.views) ? c.views : {}),
    ...Object.keys(shotsByView(reading)),
  ]);
  return measured.has(view) ? null : `${view} view not recorded`;
}

const ENV_TAGS = ['Deploy', 'Timing'];

/**
 * Merges a parsed list with a new reading of `url` (default the list's URL). Items match by ID only, computed with the
 * rechecked URL's path; items whose visible entry was deleted are dropped. Status: still (found), fixed (gone and
 * checkable; `since` = local date of `now`), deploy (Deploy/Timing item on a local URL), cantcheck (its plugin did not
 * finish ok, or its view was not recorded). `added`: new IDs, leaving out Deploy/Timing ones on a local URL.
 * exitCode 0 when nothing is still there and nothing is new, else 1.
 */
export function recheckList(list, reading, { url, local = false, now = Date.now(), plugins = [] } = {}) {
  const { meta, visibleIds } = list;
  const checkUrl = url || meta.url;
  const isLocal = isLocalUrl(checkUrl, local);
  const found = new Map(punchItems(reading, { plugins, path: pathOf(checkUrl) }).map((i) => [i.id, i]));
  const today = localDate(now);
  const items = [];
  const statuses = {};
  for (const [id, entry] of Object.entries(meta.items)) {
    if (!visibleIds.has(id)) continue;
    const prev = blockStatus(entry);
    const hit = found.get(id);
    const item = hit || { id, ...(entry?.item || {}) };
    if (!item.plugin) continue; // a block entry with no item to show cannot be kept
    let status;
    if (isLocal && ENV_TAGS.includes(item.tag)) status = { status: 'deploy' };
    else if (hit) status = { status: 'still' };
    else {
      const gap = pluginGap(reading, item.plugin) || viewGap(reading, item.view || item.subject);
      status = gap ? { status: 'cantcheck', reason: gap }
        : { status: 'fixed', since: prev.status === 'fixed' && prev.since ? prev.since : today };
    }
    items.push(item);
    statuses[id] = status;
  }
  const added = [...found.values()].filter((i) => !Object.hasOwn(meta.items, i.id) && !(isLocal && ENV_TAGS.includes(i.tag)));
  const count = (s) => Object.values(statuses).filter((x) => x.status === s).length;
  const cant = count('cantcheck');
  const summary = `${items.length} item${items.length === 1 ? '' : 's'}: ${count('fixed')} fixed, ${count('still')} still there, ` +
    `${count('deploy')} verify after deploy${cant ? `, ${cant} can't check` : ''}; ${added.length} new`;
  return { items, statuses, added, summary, exitCode: count('still') || added.length ? 1 : 0 };
}
