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
  const worst = ties(metric, order[order.length - 2], last) ? null : last.key;
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
  let pick = null;
  for (const m of metrics) {
    if (m.area !== areaId) continue;
    const w = m.values[winner]?.value;
    const l = m.values[last]?.value;
    if (w == null || l == null) continue;
    const better = m.better === 'higher' ? w > l : w < l;
    const g = gap(w, l);
    if (better && g > 0 && (!pick || g > pick.g)) pick = { m, g };
  }
  return pick ? `${pick.m.label} ${pick.m.values[winner].text} vs ${pick.m.values[last].text}` : '';
}

/** The comparison model the compare page draws: sites, overall, areas, metrics, face-off, the single-run note and layout. */
export function compareReadings(sites, plugins = [], { profile } = {}) {
  const prof = resolveProfile(profile);
  const allUrls = sites.map((s) => s.reading
    ? s.reading.log._harplus?.target?.finalUrl || s.reading.log._harplus?.target?.url || ''
    : s.url || '');
  const live = [];
  const out = sites.map((s, i) => {
    const url = allUrls[i];
    if (!s.reading) {
      return {
        key: s.key, host: s.host || hostOf(url), label: url ? siteLabel(url, allUrls) : s.host || '', url,
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
      key: s.key, host: hp.target?.host || hostOf(url), label: siteLabel(url, allUrls), url,
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
