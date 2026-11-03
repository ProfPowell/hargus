// Punch list: a reading's high/medium/low findings as a Markdown checklist with stable item IDs, plus a
// machine-readable block the recheck reads back. Pure; shared by the extension's export and the Node recheck.
// Item ID: "HG-" + FNV-1a 32-bit of "plugin|rule|path+query|subject" — never counts, timings, sizes, selectors or places.

import { findings, placeText, MD_PLACES } from './harplus.js';
import { ruleInfo } from './rules.js';
import { resultArea } from './score.js';
import { CAPTURE_DEFAULTS, THROTTLE_WORD } from './compare.js';

const INCLUDED = ['high', 'medium', 'low'];
const SECTIONS = [['high', 'High'], ['medium', 'Medium'], ['low', 'When you have time']];
const BLOCK = 'hargus-punchlist';

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
export function punchItems(reading, { plugins = [] } = {}) {
  const results = reading.log._harplus?.plugins || {};
  const path = pathOf(targetUrl(reading));
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
      ...(f.detail && !consoleOnly ? { detail: String(f.detail).replace(/\s+/g, ' ').trim() } : {}),
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
    const sorted = [...group].sort((a, b) => (a.subject || '').localeCompare(b.subject || '') || String(a.title).localeCompare(String(b.title)));
    sorted.forEach((it, i) => { if (i) it.id = `${it.id}-${i + 1}`; });
  }
  return items;
}

/** The capture settings the recheck reuses, with defaults for readings that did not store one. */
function captureSettings(reading) {
  const hp = reading.log._harplus || {};
  const c = hp.capture || {};
  const pick = (k) => c[k] ?? CAPTURE_DEFAULTS[k];
  const sk = hp.runs?.skipped;
  const skipped = Array.isArray(sk) ? sk.length : Number(sk) || 0;
  const views = [...new Set([...Object.keys(c.views || {}), ...(c.viewsSkipped || []).map((s) => s.view)])].filter(Boolean);
  return {
    device: pick('device'), throttle: pick('throttle'), bypassCache: !!pick('bypassCache'),
    runs: (Number(c.runs) || CAPTURE_DEFAULTS.runs) + skipped, coverage: !!pick('coverage'), views,
  };
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Page-derived text as inert Markdown: one line, and "<" escaped so markup (a tag, an HTML comment) stays text. */
const text = (s) => oneLine(s).replace(/</g, '\\<');

/** One item as a Markdown checklist entry. */
function itemMarkdown(it, pageUrl) {
  const lines = [`- [ ] **${text(it.title)}** · ${it.severity} · ${it.tag} · \`${it.id}\``, `  - **Where:** ${pageUrl}`];
  lines.push(...it.places.map((p) => `    - ${text(p)}`));
  const more = it.placesTotal - it.places.length;
  if (more > 0) lines.push(`    - …and ${more} more place${more === 1 ? '' : 's'}`);
  lines.push(`  - **What's wrong:** ${text(it.detail || it.title)}`);
  if (it.expected) lines.push(`  - **Expected:** ${text(it.expected)}`);
  if (it.ref) lines.push(`  - **Reference:** ${it.ref.label ? `${text(it.ref.label)} — ` : ''}<${it.ref.url}>`);
  return lines.join('\n');
}

/** A status as the block stores it: { status, since? }, "open" when none is given. */
function blockStatus(s) {
  if (!s) return { status: 'open' };
  if (typeof s === 'string') return { status: s };
  return { status: s.status || 'open', ...(s.since ? { since: s.since } : {}) };
}

/**
 * The punch list as Markdown: header, High / Medium / When you have time sections, and the
 * `<!-- hargus-punchlist {json} -->` block as the last line (the recheck's source of truth).
 */
export function punchMarkdown(reading, items, { statuses = {} } = {}) {
  const hp = reading.log._harplus || {};
  const t = hp.target || {};
  const url = targetUrl(reading);
  const pageUrl = t.finalUrl || url;
  const s = captureSettings(reading);
  const counts = Object.fromEntries(INCLUDED.map((sev) => [sev, items.filter((i) => i.severity === sev).length]));
  const lines = [
    `# Punch list: ${text(t.title || t.host || url)}`,
    '',
    `<${url}>`,
    '',
    `Recorded ${hp.capturedAt ? new Date(hp.capturedAt).toLocaleString() : 'at an unknown time'} · ${s.device} · ` +
      `${THROTTLE_WORD[s.throttle] ?? s.throttle} · ${s.runs} run${s.runs === 1 ? '' : 's'}`,
    '',
    `${items.length} item${items.length === 1 ? '' : 's'} (${counts.high} high / ${counts.medium} medium / ${counts.low} low)`,
    '',
    `Recheck: \`node <path-to-hargus>/cli/harplus.mjs recheck <this file> --url ${url}\``,
  ];
  for (const [sev, heading] of SECTIONS) {
    const list = items.filter((i) => i.severity === sev);
    if (!list.length) continue;
    lines.push('', `## ${heading}`, '', ...list.map((it) => itemMarkdown(it, pageUrl)));
  }
  const block = {
    v: 1, url, path: pathOf(url), capturedAt: hp.capturedAt, settings: s,
    items: Object.fromEntries(items.map((i) => [i.id, blockStatus(statuses[i.id])])),
  };
  // Page-derived strings must not close the HTML comment: ">" becomes > inside the JSON.
  lines.push('', `<!-- ${BLOCK} ${JSON.stringify(block).replace(/>/g, '\\u003e')} -->`);
  return `${lines.join('\n')}\n`;
}
