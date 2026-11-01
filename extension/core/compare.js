// Comparing readings: overall, area and metric winners, ties, and each site's strengths and weaknesses.
// Pure (no DOM, no chrome.*). Readings are scored again here with one profile so every site is judged alike.

import { AREAS, scoreReading, resolveProfile } from './score.js';
import { METRICS, metricValues, formatMetric } from './metrics.js';
import { screenshotURL } from './harplus.js';
import { hostOf } from './har-util.js';

/** Overall and area scores this close to the top tie. */
export const TIE_POINTS = 3;
/** Metric values within this share of the better one tie. */
export const TIE_PCT = 0.10;
/** The smallest difference per unit that can separate two metric values. */
export const FLOOR = { ms: 100, cls: 0.02, count: 1, bytes: 10240, grams: 0.02 };
/** The most readings one comparison takes. */
export const MAX_SITES = 8;
/** From this many sites the headers become a compact strip. */
export const STRIP_AT = 5;
/** Readings recorded more than this many days apart get a dates line in the conditions. */
export const DATE_SPREAD_DAYS = 7;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const AREA_LABEL = Object.fromEntries(AREAS.map((a) => [a.id, a.label]));

/** Highest score first; every key within TIE_POINTS of the top wins; null scores are left out. */
export function rankScores(entries) {
  const present = entries.filter((e) => num(e.score) != null);
  const order = present.slice().sort((a, b) => b.score - a.score);
  const top = order[0]?.score;
  const winners = order.filter((e) => top - e.score <= TIE_POINTS).map((e) => e.key);
  return { winners, tie: winners.length >= 2, order: order.map((e) => e.key) };
}

// Two last places tie on score when within TIE_POINTS, as at the top.
function lastPlace(order, scores) {
  if (order.length < 2) return null;
  const last = order[order.length - 1];
  const next = order[order.length - 2];
  return scores[next] - scores[last] > TIE_POINTS ? last : null;
}

const overlap = (r, s) => r.min <= s.max && s.min <= r.max;
const hasRange = (r) => r && num(r.min) != null && num(r.max) != null;

// Whether two metric entries tie: run ranges decide when both have them, otherwise 10% or the unit's floor.
function ties(metric, x, y) {
  if (formatMetric(metric.id, x.value) === formatMetric(metric.id, y.value)) return true;
  if (hasRange(x.range) && hasRange(y.range)) return overlap(x.range, y.range);
  const better = metric.better === 'higher' ? Math.max(x.value, y.value) : Math.min(x.value, y.value);
  return Math.abs(x.value - y.value) <= Math.max(TIE_PCT * Math.abs(better), FLOOR[metric.unit] ?? 0);
}

/** Winners, a tie flag, and the outright best and worst for one metric; shown is false with fewer than 2 values. */
export function rankMetric(metric, entries) {
  const present = entries.filter((e) => num(e.value) != null);
  if (present.length < 2) return { winners: [], tie: false, best: null, worst: null, shown: false };
  const sign = metric.better === 'higher' ? -1 : 1;
  const order = present.slice().sort((a, b) => sign * (a.value - b.value));
  const [lead] = order;
  const winners = order.filter((e) => e === lead || ties(metric, lead, e)).map((e) => e.key);
  const tie = winners.length >= 2;
  const last = order[order.length - 1];
  // Ranges can overlap non-transitively: a site that is also a winner is never the worst.
  const worst = ties(metric, order[order.length - 2], last) || winners.includes(last.key) ? null : last.key;
  return { winners, tie, best: tie ? null : lead.key, worst, shown: true };
}

/** The host, or host plus path when another of the URLs shares that host. */
export function siteLabel(url, allUrls = []) {
  const host = hostOf(url);
  const shared = new Set(allUrls.filter((u) => u && hostOf(u) === host)).size > 1;
  if (!shared) return host;
  try {
    const u = new URL(url);
    return host + u.pathname + u.search;
  } catch {
    return host;
  }
}

const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i;

// The first declared icon whose HAR entry has an image body, as a data URL; null otherwise.
function faviconOf(reading) {
  const meta = reading.log._harplus?.plugins?.meta;
  const icons = meta?.status === 'ok' && Array.isArray(meta.data?.icons) ? meta.data.icons : [];
  for (const icon of icons) {
    const e = (reading.log.entries || []).find((x) => x.request?.url === icon?.href);
    const c = e?.response?.content;
    const mime = String(c?.mimeType || '').split(';')[0].trim();
    if (!c?.text || !IMAGE_MIME.test(mime)) continue;
    if (c.encoding === 'base64') {
      if (/^[A-Za-z0-9+/=]+$/.test(c.text)) return `data:${mime};base64,${c.text}`;
      continue;
    }
    try {
      const bytes = new TextEncoder().encode(c.text);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `data:${mime};base64,${btoa(bin)}`;
    } catch { /* not encodable: try the next icon */ }
  }
  return null;
}

// Relative gap between two values, 0 when both are 0.
const gap = (a, b) => {
  const d = Math.max(Math.abs(a), Math.abs(b));
  return d ? Math.abs(a - b) / d : 0;
};

// The metric in an area with the largest relative gap from the winner to the last-placed site, as "LCP 2.00 s vs 3.40 s".
function whyOf(areaId, winner, last, metrics) {
  if (!winner || !last || winner === last) return '';
  // Prefer metrics the winner took outright; otherwise any metric where it is merely better.
  const find = (outright) => {
    let best = null;
    for (const m of metrics) {
      if (m.area !== areaId || (outright && m.best !== winner)) continue;
      const w = m.values[winner]?.value;
      const l = m.values[last]?.value;
      if (w == null || l == null) continue;
      const better = m.better === 'higher' ? w > l : w < l;
      const g = gap(w, l);
      if (better && g > 0 && (!best || g > best.g)) best = { m, g };
    }
    return best;
  };
  const pick = find(true) || find(false);
  return pick ? `${pick.m.label} ${pick.m.values[winner].text} vs ${pick.m.values[last].text}` : '';
}

const siteUrl = (s) => (s.reading
  ? s.reading.log._harplus?.target?.finalUrl || s.reading.log._harplus?.target?.url || ''
  : s.url || '');

/**
 * One label per compareReadings site: siteLabel, and where two still match, the differing device, then throttling,
 * then the local capture date ("harvard.edu (mobile)", "harvard.edu · 31 Oct"); a number as the last resort.
 */
export function siteLabels(sites) {
  const urls = sites.map(siteUrl);
  const out = sites.map((s, i) => (urls[i] ? siteLabel(urls[i], urls) : s.host || ''));
  const info = sites.map((s) => (s.reading ? settingsOf(s.reading) : null));
  const tags = [
    (x) => x && `(${x.device})`,
    (x) => x && `(${x.throttle})`,
    (x) => (x && Number.isFinite(x.at) ? `· ${dayMonth(x.at)}` : null),
  ];
  const groups = new Map();
  out.forEach((l, i) => groups.set(l, [...(groups.get(l) || []), i]));
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const distinct = () => new Set(group.map((i) => out[i])).size === group.length;
    for (const tag of tags) {
      if (distinct()) break;
      const vals = group.map((i) => tag(info[i]));
      if (new Set(vals).size < 2) continue;
      group.forEach((i, j) => { if (vals[j]) out[i] = `${out[i]} ${vals[j]}`; });
    }
    const seen = new Map();
    for (const i of group) {
      const n = (seen.get(out[i]) || 0) + 1;
      seen.set(out[i], n);
      if (n > 1) out[i] = `${out[i]} (${n})`;
    }
  }
  return out;
}

/** The comparison model the compare page draws: sites, overall, areas, metrics, face-off, the single-run note and layout. */
export function compareReadings(sites, plugins = [], { profile } = {}) {
  const prof = resolveProfile(profile);
  const allUrls = sites.map(siteUrl);
  const labels = siteLabels(sites);
  const live = [];
  const out = sites.map((s, i) => {
    const url = allUrls[i];
    if (!s.reading) {
      return {
        key: s.key, host: s.host || hostOf(url), label: labels[i], url,
        score: null, grade: null, status: 'none', thumb: '', favicon: null, capturedAt: null,
        gap: s.gap || 'reading deleted', strengths: [], weaknesses: [],
      };
    }
    const hp = s.reading.log._harplus || {};
    const scores = scoreReading(s.reading, plugins, { profile });
    const shots = hp.screenshots || [];
    const thumb = shots.find((x) => x.kind === 'thumbnail') || shots.find((x) => x.kind === 'viewport');
    live.push({ key: s.key, scores, values: metricValues(s.reading, scores) });
    return {
      key: s.key, host: hp.target?.host || hostOf(url), label: labels[i], url,
      score: scores.overall.score, grade: scores.overall.grade, status: scores.overall.status,
      thumb: screenshotURL(thumb), favicon: faviconOf(s.reading), capturedAt: hp.capturedAt || null,
      strengths: [], weaknesses: [],
    };
  });
  const keys = live.map((l) => l.key);
  const zero = () => Object.fromEntries(keys.map((k) => [k, 0]));

  // Overall: no winner without at least two scored sites.
  const overallRank = rankScores(live.map((l) => ({ key: l.key, score: l.scores.overall.score })));
  const overall = overallRank.order.length >= 2
    ? { winners: overallRank.winners, tie: overallRank.tie, areaWins: zero(), ties: 0 }
    : { winners: [], tie: false, areaWins: zero(), ties: 0 };

  // Metrics: only those at least two sites have.
  const metrics = [];
  for (const m of METRICS) {
    const entries = live.map((l) => ({ key: l.key, ...l.values[m.id] }));
    const r = rankMetric(m, entries);
    if (!r.shown) continue;
    const values = Object.fromEntries(entries.map((e) => {
      const v = num(e.value);
      return [e.key, { value: v, text: formatMetric(m.id, v) }];
    }));
    metrics.push({ id: m.id, area: m.area, label: m.label, better: m.better, best: r.best, worst: r.worst, winners: r.winners, tie: r.tie, values, def: m });
  }

  // Areas: a site that could not measure an area takes no part; an area needs two measured sites to have a winner.
  const areaBest = [];
  const areaWorst = [];
  const areas = AREAS.map((a) => {
    const scores = Object.fromEntries(live.map((l) => {
      const x = l.scores.areas[a.id];
      return [l.key, x?.measured ? num(x.score) : null];
    }));
    const r = rankScores(keys.map((key) => ({ key, score: scores[key] })));
    if (r.order.length < 2) return { id: a.id, label: a.label, winners: [], tie: false, scores, why: '' };
    const last = lastPlace(r.order, scores);
    if (r.tie) overall.ties++;
    else {
      overall.areaWins[r.winners[0]]++;
      areaBest.push({ key: r.winners[0], area: a.id, score: scores[r.winners[0]] });
    }
    if (last) areaWorst.push({ key: last, area: a.id, score: scores[last] });
    const why = r.tie ? '' : whyOf(a.id, r.winners[0], r.order[r.order.length - 1], metrics);
    return { id: a.id, label: a.label, winners: r.winners, tie: r.tie, scores, why };
  });

  // Face-off totals.
  const faceoff = { wins: zero(), ties: 0, total: metrics.length };
  for (const m of metrics) {
    if (m.tie) faceoff.ties++;
    else faceoff.wins[m.winners[0]]++;
  }

  // Strengths and weaknesses: outright metric wins and last places by margin, then area wins and losses fill in.
  for (const site of out) {
    if (site.gap) continue;
    const mine = (end) => metrics.filter((m) => m[end] === site.key).map((m) => {
      const own = m.values[site.key].value;
      const others = Object.entries(m.values).filter(([k, v]) => k !== site.key && v.value != null).map(([, v]) => v.value);
      // The runner-up: the nearest other value.
      const near = others.reduce((n, v) => Math.min(n, gap(own, v)), Infinity);
      return { label: m.def[end], value: m.values[site.key].text, margin: near };
    }).sort((x, y) => y.margin - x.margin);
    const fill = (list, rows, word) => {
      for (const r of rows) {
        if (list.length >= 2) break;
        if (r.key === site.key) list.push({ label: `${word} ${AREA_LABEL[r.area]}`, value: String(r.score) });
      }
      return list;
    };
    site.strengths = fill(mine('best').slice(0, 2).map(({ label, value }) => ({ label, value })), areaBest, 'Best');
    site.weaknesses = fill(mine('worst').slice(0, 2).map(({ label, value }) => ({ label, value })), areaWorst, 'Worst');
  }

  const singleRunNote = live.some((l) => METRICS.some((m) => m.range && l.values[m.id].value != null && !l.values[m.id].range));

  return {
    profile: { id: prof.id, label: prof.label },
    sites: out,
    overall,
    areas,
    metrics: metrics.map(({ def, better, ...m }) => m),
    faceoff,
    singleRunNote,
    layout: sites.length >= STRIP_AT ? 'strip' : 'columns',
  };
}

// What a reading without a stored setting was recorded with (the defaults in browser/settings.js).
const CAPTURE_DEFAULTS = { device: 'desktop', throttle: 'none', bypassCache: true, runs: 1, coverage: false, mode: 'reload' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;
// The throttle settings as the settings pages word them.
const THROTTLE_WORD = { none: 'no throttling', 'slow-4g': 'Slow 4G + 4× CPU', '3g': '3G + 4× CPU' };

// One reading's capture settings with defaults filled in; runs counts those planned, skipped ones included.
function settingsOf(reading) {
  const hp = reading.log?._harplus || {};
  const c = hp.capture || {};
  const pick = (k) => c[k] ?? CAPTURE_DEFAULTS[k];
  const sk = hp.runs?.skipped;
  const skipped = Array.isArray(sk) ? sk.length : num(sk) || 0;
  const done = num(c.runs) ?? CAPTURE_DEFAULTS.runs;
  return {
    device: pick('device'), throttle: THROTTLE_WORD[pick('throttle')] ?? pick('throttle'), cache: pick('bypassCache') ? 'cleared' : 'kept',
    runs: done + skipped, coverage: pick('coverage') ? 'on' : 'off', mode: pick('mode'),
    done, skipped, at: Date.parse(hp.capturedAt),
  };
}

const dayMonth = (t) => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };

// One line for a setting: a lone smaller group is named against "the others"; otherwise every value is listed.
function differ(rows, field, minority, all) {
  const groups = new Map();
  for (const r of rows) groups.set(r[field], [...(groups.get(r[field]) || []), r.label]);
  if (groups.size < 2) return null;
  if (groups.size === 2) {
    const [[v1, n1], [v2, n2]] = [...groups];
    if (n1.length !== n2.length) {
      const [mv, mn, ov] = n1.length < n2.length ? [v1, n1, v2] : [v2, n2, v1];
      return minority(mn.join(' and '), mn.length === 1 ? 'was' : 'were', mv, ov);
    }
  }
  return all(rows.map((r) => `${r.label} ${r[field]}`).join(', '));
}

/**
 * Plain lines naming how the readings were recorded differently (device, throttle, cache, runs, coverage, mode, dates).
 * sites: the compareReadings input, Array<{ key, reading }>; gap entries { key, gap } are skipped.
 * Callers pass a stable key per site (its URL) so the same site matches across rounds.
 */
export function conditions(sites) {
  const labels = siteLabels(sites);
  const rows = sites.map((s, i) => (s.reading ? { ...settingsOf(s.reading), label: labels[i] || s.key } : null)).filter(Boolean);
  const lines = [
    differ(rows, 'device', (n, be, v, o) => `${n} ${be} recorded on ${v}, the others on ${o}`, (l) => `Devices differ: ${l}`),
    differ(rows, 'throttle', (n, be, v, o) => `${n} ${be} recorded with ${v}, the others with ${o}`, (l) => `Throttling differs: ${l}`),
    differ(rows, 'cache', (n, be, v, o) => `${n} ${be} recorded with the cache ${v}, the others with it ${o}`, (l) => `Cache use differs: ${l}`),
    differ(rows, 'runs', (n, be, v, o) => `${n} used ${v} ${v === 1 ? 'run' : 'runs'}, the others ${o}`, (l) => `Runs differ: ${l}`),
    differ(rows, 'coverage', (n, be, v, o) => `${n} ${be} recorded with coverage ${v}, the others ${o}`, (l) => `Coverage differs: ${l}`),
    differ(rows, 'mode', (n, be, v, o) => `${n} ${be} recorded in ${v} mode, the others in ${o}`, (l) => `Modes differ: ${l}`),
  ].filter(Boolean);
  const times = rows.map((r) => r.at).filter((t) => Number.isFinite(t));
  if (times.length >= 2) {
    const lo = Math.min(...times);
    const hi = Math.max(...times);
    if ((hi - lo) / DAY_MS > DATE_SPREAD_DAYS) lines.push(`Recorded between ${dayMonth(lo)} and ${dayMonth(hi)}`);
  }
  for (const r of rows) if (r.skipped > 0) lines.push(`${r.label}: ${r.done} of ${r.runs} runs`);
  return lines;
}

// Places by overall score, 1-based; unscored sites get none.
function placesOf(model) {
  const r = rankScores(model.sites.map((s) => ({ key: s.key, score: s.score })));
  return Object.fromEntries(r.order.map((k, i) => [k, i + 1]));
}

const delta = (a, b) => (a != null && b != null ? b - a : null);
const signed = (n) => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);

/**
 * Two rounds of the same sites side by side: score, rank, area and metric changes, and a one-line verdict.
 * Sites are matched across rounds by key, so callers pass the same stable key (the URL) for a site in both models.
 */
export function compareRounds(before, after) {
  const bSite = new Map(before.sites.map((s) => [s.key, s]));
  const aSite = new Map(after.sites.map((s) => [s.key, s]));
  const keys = [...after.sites.map((s) => s.key), ...before.sites.map((s) => s.key).filter((k) => !aSite.has(k))];
  const bRank = placesOf(before);
  const aRank = placesOf(after);
  const sites = keys.map((key) => {
    const b = bSite.get(key);
    const a = aSite.get(key);
    const bs = num(b?.score);
    const as = num(a?.score);
    return {
      key,
      grade: { before: b?.grade ?? null, after: a?.grade ?? null },
      score: { before: bs, after: as, change: delta(bs, as) },
      rank: { before: bRank[key] ?? null, after: aRank[key] ?? null },
      status: b && a ? 'both' : a ? 'new' : 'gone',
    };
  });
  const areas = [...new Set([...after.areas, ...before.areas].map((x) => x.id))].map((id) => {
    const b = before.areas.find((x) => x.id === id)?.scores || {};
    const a = after.areas.find((x) => x.id === id)?.scores || {};
    const changes = {};
    for (const key of keys) {
      const bv = num(b[key]);
      const av = num(a[key]);
      const change = delta(bv, av);
      changes[key] = { before: bv, after: av, change, same: change != null && Math.abs(change) <= TIE_POINTS };
    }
    return { id, changes };
  });
  const metrics = [...new Set([...after.metrics, ...before.metrics].map((x) => x.id))].map((id) => {
    const def = METRICS.find((m) => m.id === id);
    const b = before.metrics.find((x) => x.id === id)?.values || {};
    const a = after.metrics.find((x) => x.id === id)?.values || {};
    const changes = {};
    for (const key of keys) {
      const bv = num(b[key]?.value);
      const av = num(a[key]?.value);
      changes[key] = { before: bv, after: av, same: bv != null && av != null && !!def && ties(def, { value: bv }, { value: av }) };
    }
    return { id, changes };
  });
  const label = (key) => aSite.get(key)?.label || bSite.get(key)?.label || key;
  const moved = sites.filter((s) => s.score.change != null);
  const rise = moved.filter((s) => s.score.change > TIE_POINTS).sort((x, y) => y.score.change - x.score.change)[0];
  const fall = moved.filter((s) => s.score.change < -TIE_POINTS).sort((x, y) => x.score.change - y.score.change)[0];
  const parts = [];
  if (rise) parts.push(`${label(rise.key)} improved most (${signed(rise.score.change)})`);
  if (fall) parts.push(`${label(fall.key)} fell (${signed(fall.score.change)})`);
  const verdict = parts.length ? parts.join('; ') : `No site changed by more than ${TIE_POINTS} points`;
  return { sites, areas, metrics, verdict };
}
