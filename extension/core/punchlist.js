// Punch list: a reading's high/medium/low findings as a Markdown checklist with stable item IDs, plus a
// machine-readable block the recheck reads back. Pure; shared by the extension's export and the Node recheck.
// Item ID: "HG-" + FNV-1a 32-bit of "plugin|rule|path+query|subject" — never counts, timings, sizes, selectors or places.

import { findings, placeText, MD_PLACES } from './harplus.js';
import { ruleInfo } from './rules.js';
import { resultArea } from './score.js';
import { CAPTURE_DEFAULTS, THROTTLE_WORD } from './compare.js';
import { VISION_VIEWS, shotsByView, isBreakpointView } from './views.js';
import { JS_UNAVAILABLE } from './coverage.js';
import { mainEntry } from './har-util.js';

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

/** Remote plugins (ids "remote:…") answer from someone else's server: their findings are not tracked. */
const isRemote = (plugin) => String(plugin || '').startsWith('remote:');

/** The active high/medium/low findings of built-in plugins. */
const tracked = (reading) => findings(reading).filter((f) => INCLUDED.includes(f.severity) && !isRemote(f.plugin));

/** True when every non-info active finding of a built-in plugin carries a rule id (false: item IDs would be unreliable). */
export function hasRuleIds(reading) {
  return findings(reading).every((f) => f.severity === 'info' || isRemote(f.plugin) || !!f.id);
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** One line, at most `n` characters. */
const brief = (s, n = 80) => {
  const t = oneLine(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Why one view (an option key, or a breakpoint edge such as bp900-below) has no usable measurements in a reading, or
 * null: skipped (itself or every view), its self-check failed, its translation did not finish ok, or not measured.
 */
function viewMissing(reading, view) {
  const c = reading.log._harplus?.capture || {};
  const skipped = Array.isArray(c.viewsSkipped) ? c.viewsSkipped : [];
  const skip = skipped.find((s) => s?.view === view) || skipped.find((s) => s?.view === 'all');
  if (skip) return `${view} view skipped${skip.reason ? `: ${brief(skip.reason)}` : ''}`;
  const check = c.viewChecks?.[view];
  if (check?.ok === false) return `${view} view could not be verified${check.detail ? `: ${brief(check.detail)}` : ''}`;
  const tr = c.translation?.[view];
  if (tr && tr.status !== 'ok') return `${view} view ${tr.status || 'did not run'}${tr.reason ? `: ${brief(tr.reason)}` : ''}`;
  const measured = Object.keys(isObj(c.views) ? c.views : {});
  return (view === 'breakpoints' ? measured.some(isBreakpointView) : measured.includes(view)) ? null : `${view} view not recorded`;
}

/** Why this reading can't export a punch list (null when it can). */
export function punchListBlocker(reading) {
  if (reading.log._harplus?.capture?.mode === 'record') return 'Punch lists cover one page; open a single-page reading';
  if (!hasRuleIds(reading)) return 'Record this page again to export a punch list';
  return null;
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
  const items = tracked(reading).map((f) => {
    const area = resultArea(results[f.plugin], plugins);
    const extra = f.plugin === 'axe' ? { help: String(f.title || '').replace(/\s*\(\d[\d,]*\)$/, ''), url: f.ref, tags: f.tags } : {};
    const info = ruleInfo(f.plugin, f.id, area, extra);
    const consoleOnly = f.plugin === 'console';
    const places = (f.places || []).map((p) => placeText(p, consoleOnly)).filter(Boolean);
    const ref = refOf(info, f);
    // The rule's views this reading measured: a recheck must measure them again before it can call the item fixed.
    const seen = info.views ? info.views.filter((v) => !viewMissing(reading, v)) : null;
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
      ...(seen ? { views: seen.length ? seen : info.views } : {}),
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

const ITEM_ID = /^HG-[0-9a-f]{8}(?:-\d+)?$/;

/** Dismissed entries as [{ id, title }]: from IDs or { id, title } objects, valid IDs only, first of each kept. */
function dismissedList(list) {
  const out = new Map();
  for (const d of Array.isArray(list) ? list : []) {
    const id = typeof d === 'string' ? d : d?.id;
    if (typeof id === 'string' && ITEM_ID.test(id) && !out.has(id)) out.set(id, typeof d?.title === 'string' ? d.title : '');
  }
  return [...out].map(([id, title]) => ({ id, title }));
}

/** The "How to use this list" section: who fixes what, how to recheck locally, exit codes, setup. */
function howTo(path) {
  return [
    '## How to use this list',
    '',
    'HARgus saw this page from outside and cannot see its source. Fix **Page** items and recheck locally; verify ' +
      '**Deploy** and **Timing** items after you deploy. Recheck a local production build (build, then preview) at the ' +
      'same path and query, swapping only scheme and host:',
    '',
    `\`node <path-to-hargus>/cli/harplus.mjs recheck <this file> --url http://localhost:<port>${safeUrl(path)}\``,
    '',
    'Add `--local` if the host is not seen as local, `--path <path-and-query>` if the local route differs, `--settings <file>` ' +
      'for validator endpoints, keys and plugin options. Exit 0: nothing still there or new; 1: something is; 2: could not ' +
      'check. Deleting an item line dismisses it for good. Setup, once, in the HARgus folder: `npm install` and ' +
      '`npx playwright install chromium`.',
  ];
}

/**
 * The punch list as Markdown: header, High / Medium / When you have time sections, `## New since last check` for
 * `added`, and the `<!-- hargus-punchlist {json} -->` block as the last line (the recheck's source of truth).
 * `statuses` ({ [id]: { status, since?, reason? } }) come from a recheck; `url` keeps the list's own URL when the
 * reading is a recheck of another host; `checkedAt` and `summary` add a "Rechecked" line; `dismissed` (IDs, or
 * { id, title }, of entries a person deleted) is kept in the block so a recheck never brings them back, and listed under
 * `## Dismissed`; `ran` (plugin ids that finished ok in the original reading) defaults to this reading's, null leaves it out.
 */
export function punchMarkdown(reading, items, { statuses = {}, added = [], url: listUrl, checkedAt, summary, dismissed = [], ran } = {}) {
  const hp = reading.log._harplus || {};
  const t = hp.target || {};
  const url = listUrl || targetUrl(reading);
  const pageUrl = t.finalUrl || url;
  const s = captureSettings(reading);
  const counts = Object.fromEntries(INCLUDED.map((sev) => [sev, items.filter((i) => i.severity === sev).length]));
  const remote = findings(reading).filter((f) => INCLUDED.includes(f.severity) && isRemote(f.plugin)).length;
  const gone = dismissedList(dismissed);
  const lines = [
    `# Punch list: ${text(t.title || t.host || url)}`,
    '',
    `<${safeUrl(url)}>`,
    '',
    `Recorded ${hp.capturedAt ? new Date(hp.capturedAt).toLocaleString() : 'at an unknown time'} · ${s.device} · ` +
      `${THROTTLE_WORD[s.throttle] ?? s.throttle} · ${s.runs} run${s.runs === 1 ? '' : 's'}`,
    '',
    `${items.length} item${items.length === 1 ? '' : 's'} (${counts.high} high / ${counts.medium} medium / ${counts.low} low)`,
    ...(remote ? ['', `${remote} finding${remote === 1 ? '' : 's'} from remote plugins not tracked`] : []),
    '',
    `Recheck: \`node <path-to-hargus>/cli/harplus.mjs recheck <this file> --url ${safeUrl(url)}\``,
  ];
  if (checkedAt != null) lines.push('', `Rechecked ${new Date(checkedAt).toLocaleString()}${summary ? ` · ${text(summary)}` : ''}`);
  lines.push('', ...howTo(pathOf(url)));
  for (const [sev, heading] of SECTIONS) {
    const list = items.filter((i) => i.severity === sev);
    if (!list.length) continue;
    lines.push('', `## ${heading}`, '', ...list.map((it) => itemMarkdown(it, pageUrl, statuses[it.id])));
  }
  if (added.length) lines.push('', '## New since last check', '', ...added.map((it) => itemMarkdown(it, pageUrl)));
  // Not checkbox lines: a dismissed ID listed here is never read back as an item.
  if (gone.length) lines.push('', '## Dismissed', '', ...gone.map((d) => `- \`${d.id}\`${d.title ? ` ${text(d.title)}` : ''}`));
  const okRan = Object.values(hp.plugins || {}).filter((r) => r?.status === 'ok' && r.id).map((r) => r.id).sort();
  const block = {
    v: 1, url, path: pathOf(url), capturedAt: hp.capturedAt, settings: s,
    ...(ran === null ? {} : { ran: Array.isArray(ran) ? ran : okRan }),
    items: Object.fromEntries([
      ...items.map((i) => [i.id, { ...blockStatus(statuses[i.id]), item: snapshot(i) }]),
      ...added.map((i) => [i.id, { status: 'open', item: snapshot(i) }]),
    ]),
    dismissed: gone,
  };
  // Page-derived strings must not open or close an HTML comment ("<" and ">" as \u003c / \u003e) nor break the
  // block's line (U+2028 / U+2029, which JSON.stringify writes raw, as \u2028 / \u2029).
  const json = JSON.stringify(block).replace(/[<>\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  lines.push('', `<!-- ${BLOCK} ${json} -->`);
  return `${lines.join('\n')}\n`;
}

// ---- Recheck ----

const BLOCK_LINE = new RegExp(`^<!-- ${BLOCK} (\\{[^\\n]*\\}) -->\\s*$`);
const CHECKBOX = /^\s*[-*] \[[ xX]\] /;
const ID_TOKEN = /`(HG-[0-9a-f]{8}(?:-\d+)?)`/g;
const BARE_ID = /(?:^|\s)(HG-[0-9a-f]{8}(?:-\d+)?)\s*$/;

/**
 * A punch list read back: { meta (the block), visibleIds (IDs still on a checkbox line) }; null when the block is
 * missing or unreadable. The ID is the last backticked HG- token of a `- [ ]` / `- [x]` line, else a bare HG- token
 * that ends the line (as a person or a tool may rewrite it).
 */
export function parsePunchList(md) {
  const lines = String(md ?? '').split('\n');
  let meta = null;
  for (let i = lines.length - 1; i >= 0 && !meta; i--) {
    const m = lines[i].match(BLOCK_LINE);
    if (!m) continue;
    try { meta = JSON.parse(m[1]); } catch { return null; }
  }
  if (!meta || meta.v !== 1 || typeof meta.url !== 'string' || !meta.url) return null;
  if (!meta.items || typeof meta.items !== 'object' || Array.isArray(meta.items)) return null;
  const visibleIds = new Set();
  for (const line of lines) {
    if (!CHECKBOX.test(line)) continue;
    const ids = [...line.matchAll(ID_TOKEN)];
    const bare = ids.length ? null : line.match(BARE_ID);
    if (ids.length) visibleIds.add(ids.at(-1)[1]);
    else if (bare) visibleIds.add(bare[1]);
  }
  return { meta, visibleIds };
}

/** True for a loopback or private address: 127/8, 0.0.0.0, 10/8, 172.16/12, 192.168/16, [::1], fc00::/7, fe80::/10. */
function privateHost(host) {
  if (['localhost', '0.0.0.0', '[::1]'].includes(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return /^\[f[cd][0-9a-f]{0,2}:/.test(host) || /^\[fe[89ab][0-9a-f]?:/.test(host);
}

/**
 * True for a local development URL (localhost, loopback and private addresses, names ending .localhost, .test, .local
 * or .internal), or always when `force`.
 */
export function isLocalUrl(url, force = false) {
  if (force) return true;
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
  return privateHost(host) || /\.(localhost|test|local|internal)$/.test(host);
}

const scheme = (url) => {
  try { return new URL(String(url)).protocol; } catch { return ''; }
};

/** True when a recheck of `checkUrl` judges as local: a local URL, `force`, or an https list rechecked over http. */
export function isLocalRecheck(listUrl, checkUrl, force = false) {
  return isLocalUrl(checkUrl, force) || (scheme(listUrl) === 'https:' && scheme(checkUrl) === 'http:');
}

/** Why the new reading is an error page (main document 400 or more, or none), or null when it loaded. */
export function pageError(reading) {
  const status = Number(mainEntry(reading)?.response?.status) || 0;
  if (status > 0 && status < 400) return null;
  return `the page returned ${status > 0 ? status : 'no response'}; fix the server and recheck`;
}

/** Validators that upload the page, with their default endpoints (html-validate.js, css-validate.js). */
const UPLOADERS = { 'html-validate': 'https://validator.w3.org/nu/', 'css-validate': 'https://jigsaw.w3.org/css-validator/validator' };

const hostName = (url) => {
  try { return new URL(String(url)).host; } catch { return String(url); }
};

/**
 * Which plugins a recheck turns off: { off: [ids], held: { id: reason } }. Off: every one of `ids` not in the list's
 * `ran` (plugins that finished ok in the original reading), and on a local URL the validators that upload the page to
 * a public endpoint (their items read can't check with the `held` reason). `extra` (--settings) keeps a plugin on when
 * it sets enabled: true, or a validator on when its endpoint is local. A list without `ran` turns off only the validators.
 */
export function recheckPlugins(meta, { ids = [], local = false, extra = {} } = {}) {
  const want = isObj(extra?.plugins) ? extra.plugins : {};
  const ran = Array.isArray(meta?.ran) ? new Set(meta.ran) : null;
  const off = [];
  const held = {};
  for (const id of ids) {
    const p = isObj(want[id]) ? want[id] : {};
    if (p.enabled === true) continue;
    if (ran && !ran.has(id)) { off.push(id); continue; }
    if (!local || !Object.hasOwn(UPLOADERS, id)) continue;
    const endpoint = typeof p.options?.endpoint === 'string' && p.options.endpoint ? p.options.endpoint : UPLOADERS[id];
    if (isLocalUrl(endpoint)) continue;
    off.push(id);
    held[id] = `${id} sends the page to ${hostName(endpoint)}; enable it with --settings (or point it at a local validator)`;
  }
  return { off, held };
}

/** `now` as the local calendar date YYYY-MM-DD. */
function localDate(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Why a plugin's missing finding proves nothing in this reading, or null when the plugin finished ok. */
function pluginGap(reading, plugin) {
  const r = reading.log._harplus?.plugins?.[plugin];
  if (!r) return `${plugin} did not run`;
  if (r.status === 'ok') return null;
  return `${plugin} ${r.status || 'did not finish'}${r.error ? `: ${brief(r.error)}` : ''}`;
}

/**
 * Why a view-dependent item cannot be judged in this reading, or null. Its views: the one its subject names (a
 * breakpoint edge such as bp900-below), else the views stored with the item (those its finding was measured in), else
 * the rule's views. Any one skipped, unverified or missing is enough.
 */
function viewGap(reading, item) {
  const subject = String(item.subject || '');
  const stored = Array.isArray(item.views) ? item.views.filter((v) => typeof v === 'string') : [];
  const views = viewKey(subject) ? [subject] : stored.length ? stored : ruleInfo(item.plugin, item.rule).views || [];
  for (const v of views) {
    const why = viewMissing(reading, v);
    if (why) return why;
  }
  return null;
}

const KIND_NAME = { js: 'JS', css: 'CSS' };

/**
 * Why a coverage item (unused-js / unused-css) cannot be judged: its kind was skipped in this reading while the
 * plugin still finished ok on the other kind (Playwright's Chromium refuses JS coverage to extensions). Null otherwise.
 */
function coverageGap(reading, item) {
  const kind = item.plugin === 'coverage' ? /^unused-(js|css)$/.exec(item.rule || '')?.[1] : null;
  const skip = kind && reading.log._harplus?.coverage?.[kind]?.skipped;
  if (!skip) return null;
  if (skip === JS_UNAVAILABLE) return `${KIND_NAME[kind]} coverage not available here`;
  return `${KIND_NAME[kind]} coverage not measured: ${brief(skip)}`;
}

/**
 * The capture settings a reading did not apply, one plain sentence each: another device or throttling, fewer timing
 * runs, coverage (or one kind of it) not recorded, and wanted views skipped (with the reason) or missing. `settings`
 * is the block's { device, throttle, runs, coverage, views }; a key it lacks is not checked.
 */
export function unappliedSettings(settings, reading) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const hp = reading.log._harplus || {};
  const c = hp.capture || {};
  const notes = [];
  if (s.device && c.device && s.device !== c.device) notes.push(`device ${s.device} wanted, recorded as ${c.device}`);
  if (s.throttle && c.throttle && s.throttle !== c.throttle) notes.push(`throttling ${s.throttle} wanted, recorded as ${c.throttle}`);
  const done = Number(c.runs) || 1;
  if (Number(s.runs) > done) notes.push(`only ${done} of ${s.runs} timing runs recorded`);
  if (s.coverage) {
    const cov = hp.coverage;
    if (!cov || cov.skipped) notes.push(`coverage not recorded here${cov?.skipped ? ` (${brief(cov.skipped)})` : ''}`);
    else {
      for (const kind of ['js', 'css']) {
        if (cov[kind]?.skipped) notes.push(`${KIND_NAME[kind]} coverage not recorded here (${brief(cov[kind].skipped)})`);
      }
    }
  }
  const wanted = s.views && typeof s.views === 'object' ? s.views : {};
  for (const skip of c.viewsSkipped || []) {
    if (!skip?.view || skip.reason === 'disabled') continue;
    if (skip.view === 'all' || wanted[viewKey(skip.view)]) {
      notes.push(`${skip.view} view not recorded here${skip.reason ? ` (${brief(skip.reason)})` : ''}`);
    }
  }
  const got = viewSettings(reading);
  // "vision" is the umbrella of the simulated-vision views, which each report themselves.
  for (const k of VIEW_KEYS) if (k !== 'vision' && wanted[k] === true && !got[k]) notes.push(`${k} view not recorded here`);
  return notes;
}

const ENV_TAGS = ['Deploy', 'Timing'];

/** True when a block entry's stored item can be shown and judged again. */
function usableItem(x) {
  return !!x && typeof x === 'object' && typeof x.plugin === 'string' && !!x.plugin && typeof x.title === 'string' &&
    INCLUDED.includes(x.severity) && typeof x.tag === 'string' && Array.isArray(x.places);
}

/** A stand-in for a block entry whose stored item is damaged: shown and kept as can't check. */
function damagedItem(id, x) {
  const o = x && typeof x === 'object' ? x : {};
  return {
    id, plugin: '', rule: '', severity: INCLUDED.includes(o.severity) ? o.severity : 'low', tag: 'Deploy',
    title: typeof o.title === 'string' && o.title ? o.title : 'Damaged list entry', places: [], placesTotal: 0,
  };
}

/**
 * Merges a parsed list with a new reading of `url` (default the list's URL). Items match by ID only, computed with
 * `path` (default the rechecked URL's path). Items whose visible entry was deleted join `dismissed` ({ id, title }) and
 * are never reported again. Status: still (found), fixed (gone and checkable; `since` = local date of `now`, or the
 * first fix's date), deploy (Deploy/Timing item on a local recheck, see isLocalRecheck), cantcheck (its plugin is
 * `held` back, did not finish ok, one of its views was not recorded, or its block entry is damaged; keeps an earlier
 * fix's `since`). `added`: new IDs, leaving out dismissed ones and, locally, Deploy/Timing ones. `pathMismatch`: the
 * IDs' path differs from the list's, no listed item matched, yet a new item shares a plugin and rule with one (the
 * page was found under another path). exitCode 0 when nothing is still there and nothing is new, else 1.
 */
export function recheckList(list, reading, { url, path, local = false, now = Date.now(), plugins = [], held = {} } = {}) {
  const { meta, visibleIds } = list;
  const checkUrl = url || meta.url;
  const idPath = path || pathOf(checkUrl);
  const isLocal = isLocalRecheck(meta.url, checkUrl, local);
  const found = new Map(punchItems(reading, { plugins, path: idPath }).map((i) => [i.id, i]));
  const today = localDate(now);
  const dismissed = new Map(dismissedList(meta.dismissed).map((d) => [d.id, d.title]));
  const items = [];
  const statuses = {};
  for (const [id, entry] of Object.entries(meta.items)) {
    if (dismissed.has(id)) continue;
    if (!visibleIds.has(id)) { dismissed.set(id, typeof entry?.item?.title === 'string' ? entry.item.title : ''); continue; }
    const prev = blockStatus(entry && typeof entry === 'object' ? entry : null);
    // The date of an earlier fix, carried through can't-check so a later fix keeps it.
    const fixedSince = ['fixed', 'cantcheck'].includes(prev.status) && typeof prev.since === 'string' ? prev.since : '';
    const hit = found.get(id);
    const ok = hit || usableItem(entry?.item);
    const item = hit || (ok ? { id, ...entry.item } : damagedItem(id, entry?.item));
    let status;
    if (!ok) status = { status: 'cantcheck', reason: 'list entry damaged', ...(fixedSince ? { since: fixedSince } : {}) };
    else if (isLocal && ENV_TAGS.includes(item.tag)) status = { status: 'deploy' };
    else if (hit) status = { status: 'still' };
    else {
      const why = Object.hasOwn(held, item.plugin) ? held[item.plugin] : null;
      const gap = why || pluginGap(reading, item.plugin) || coverageGap(reading, item) || viewGap(reading, item);
      status = gap ? { status: 'cantcheck', reason: gap, ...(fixedSince ? { since: fixedSince } : {}) }
        : { status: 'fixed', since: fixedSince || today };
    }
    items.push(item);
    statuses[id] = status;
  }
  const added = [...found.values()].filter((i) => !Object.hasOwn(meta.items, i.id) && !dismissed.has(i.id) &&
    !(isLocal && ENV_TAGS.includes(i.tag)));
  const count = (s) => Object.values(statuses).filter((x) => x.status === s).length;
  const cant = count('cantcheck');
  const summary = `${items.length} item${items.length === 1 ? '' : 's'}: ${count('fixed')} fixed, ${count('still')} still there, ` +
    `${count('deploy')} verify after deploy${cant ? `, ${cant} can't check` : ''}; ${added.length} new` +
    `${dismissed.size ? `; ${dismissed.size} dismissed` : ''}`;
  const listPath = typeof meta.path === 'string' ? meta.path : pathOf(meta.url);
  const pairs = new Set(items.map((i) => `${i.plugin}|${i.rule}`));
  const pathMismatch = idPath !== listPath && items.length > 0 && !items.some((i) => found.has(i.id)) &&
    [...found.values()].some((i) => pairs.has(`${i.plugin}|${i.rule}`));
  return {
    items, statuses, added, dismissed: [...dismissed].map(([id, title]) => ({ id, title })), summary, pathMismatch,
    exitCode: count('still') || added.length ? 1 : 0,
  };
}
