// The area pane's data: one row per check (plugin) that belongs to or scored in an area, and the
// header sentence. Pure; the pane (ui/report.js) draws it.

import { resultArea } from './score.js';

const rank = (plugins, id) => { const i = plugins.findIndex((p) => p.id === id); return i < 0 ? 999 : i; };
export const SEVS = ['high', 'medium', 'low', 'info'];

/** A check's result word and band from its status and its issue counts by severity. */
export function resultWord(status, counts) {
  if (status === 'error') return { result: 'error', band: 'poor' };
  if (status === 'skipped') return { result: 'skipped', band: 'none' };
  if (counts.high) return { result: 'failing', band: 'poor' };
  if (counts.medium || counts.low) return { result: 'needs work', band: 'fair' };
  return { result: 'passing', band: 'good' };
}

/** The result word for a list of issues or findings (anything with a severity), e.g. a plugin's issues in every area. */
export function resultWordFor(status, list = []) {
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const i of list) if (i?.severity in counts) counts[i.severity]++;
  return resultWord(status, counts);
}

function readingText(r) {
  if (r.status !== 'ok') {
    const err = String(r.error || '');
    return err.length > 120 ? `${err.slice(0, 119)}…` : err;
  }
  const items = Array.isArray(r.summary) ? r.summary : [];
  const heads = items.filter((s) => s.headline).map((s) => s.value);
  if (heads.length) return heads.join(' · ');
  if (items.length) return `${items[0].label} ${items[0].value}`;
  return '—';
}

/** Rows for the Checks table of one area; issue counts cover only issues scored in this area. */
export function areaChecks(areaId, reading, plugins = [], issues = []) {
  const results = reading?.log?._harplus?.plugins || {};
  const here = issues.filter((i) => i.area === areaId);
  const rows = [];
  for (const r of Object.values(results)) {
    const home = resultArea(r, plugins) === areaId;
    const counts = { high: 0, medium: 0, low: 0, info: 0 };
    for (const i of here) if (i.plugin === r.id && i.severity in counts) counts[i.severity]++;
    const total = SEVS.reduce((n, s) => n + counts[s], 0);
    if (!home && !total) continue;
    rows.push({ id: r.id, name: r.name, status: r.status, home, ...resultWord(r.status, counts), reading: readingText(r), counts, total });
  }
  return rows.sort((x, y) => (x.home !== y.home ? (x.home ? -1 : 1)
      : x.home ? rank(plugins, x.id) - rank(plugins, y.id) : String(x.name).localeCompare(String(y.name))));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The header sentence: severity counts, check count, and where the biggest wins are. */
export function areaSummary(area, rows) {
  if (area.score == null) return 'Not measured — no plugin in this area ran successfully.';
  const c = area.counts;
  const parts = SEVS.filter((s) => c[s]).map((s) => `${c[s]} ${s}`);
  const skipped = rows.filter((r) => r.status === 'skipped').length;
  const errors = rows.filter((r) => r.status === 'error').length;
  const aside = [skipped ? `${skipped} skipped` : '', errors ? plural(errors, 'error') : ''].filter(Boolean).join(', ');
  const checks = plural(rows.length, 'check') + (aside ? ` (${aside})` : '');
  let text;
  if (!parts.length) text = `No issues from ${checks}.`;
  else {
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    const n = SEVS.reduce((t, s) => t + (c[s] || 0), 0);
    text = `${list} ${n === 1 ? 'issue' : 'issues'} from ${checks}.`;
  }
  const wins = rows.filter((r) => r.counts.high || r.counts.medium)
    .sort((x, y) => y.counts.high - x.counts.high || y.counts.medium - x.counts.medium)
    .slice(0, 2).map((r) => r.name);
  if (wins.length === 1) text += ` The biggest win is in ${wins[0]}.`;
  else if (wins.length === 2) text += ` The biggest wins are in ${wins[0]} and ${wins[1]}.`;
  return text;
}
