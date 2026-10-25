// Area scores, grades and the one-line narrative for a reading. Pure (no DOM, no chrome.*):
// shared by the viewer, the standalone export and the CLI. Formula documented in docs/PLUGINS.md.

import { SEVERITIES, SEVERITY_RANK } from './har-util.js';

export const AREAS = [
  { id: 'performance', label: 'Performance', weight: 18 },
  { id: 'accessibility', label: 'Accessibility', weight: 18 },
  { id: 'security', label: 'Security', weight: 18 },
  { id: 'content', label: 'Content', weight: 12 },
  { id: 'build', label: 'Build', weight: 10 },
  { id: 'infrastructure', label: 'Infrastructure', weight: 9 },
  { id: 'international', label: 'International', weight: 8 },
  { id: 'sustainability', label: 'Sustainability', weight: 7 },
];
const AREA_IDS = new Set(AREAS.map((a) => a.id));
const LABEL = Object.fromEntries(AREAS.map((a) => [a.id, a.label]));

const w = (performance, accessibility, security, content, build, infrastructure, international, sustainability) =>
  ({ performance, accessibility, security, content, build, infrastructure, international, sustainability });
export const PROFILES = {
  general: { id: 'general', label: 'General', weights: w(18, 18, 18, 12, 10, 9, 8, 7), critical: [] },
  content: { id: 'content', label: 'Brochure / content site', weights: w(18, 20, 8, 22, 10, 6, 8, 8), critical: ['content'] },
  commerce: { id: 'commerce', label: 'Commerce', weights: w(22, 16, 22, 12, 8, 8, 7, 5), critical: ['performance', 'security'] },
  webapp: { id: 'webapp', label: 'Web app', weights: w(20, 18, 22, 6, 16, 8, 6, 4), critical: ['security'] },
  public: { id: 'public', label: 'Public sector / education', weights: w(14, 24, 10, 14, 6, 6, 14, 12), critical: ['accessibility', 'international'] },
};

/** A preset id, a custom object { weights, critical }, or nothing → { id, label, weights, critical }. */
export function resolveProfile(p) {
  if (p && typeof p === 'object') {
    const weights = { ...PROFILES.general.weights };
    for (const [k, v] of Object.entries(p.weights || {})) if (AREA_IDS.has(k) && Number.isFinite(Number(v)) && Number(v) >= 0) weights[k] = Number(v);
    return { id: 'custom', label: 'Custom', weights, critical: (p.critical || []).filter((id) => AREA_IDS.has(id)) };
  }
  return PROFILES[p] || PROFILES.general;
}

export function profileFromSettings(settings) {
  const s = settings?.scoring;
  if (s?.profile === 'custom') return { id: 'custom', ...(s.custom || {}) };
  return s?.profile && PROFILES[s.profile] ? s.profile : 'general';
}

export const CATEGORY_AREA = {
  performance: 'performance', accessibility: 'accessibility', security: 'security', privacy: 'security',
  quality: 'build', seo: 'content', content: 'content', infrastructure: 'infrastructure', intel: 'infrastructure',
  international: 'international', sustainability: 'sustainability',
};
export const GROUP_AREA = { build: 'build', security: 'security', infrastructure: 'infrastructure', quality: 'performance', other: 'build' };
export const DEDUCT = { high: 15, medium: 6, low: 2, info: 0 };
export const CAP = { high: 55, medium: 30, low: 15, info: 0 };
export const VERDICT = { good: 'good', warning: 'needs work', serious: 'poor', critical: 'failing', none: 'not measured' };
const RATING_SCORE = { good: 100, 'needs-improvement': 60, poor: 20 };

// Carbon: piecewise-linear in ln(grams) through the rating boundaries; 5× the F threshold scores 0.
const CARBON_ANCHORS = [[0.040, 100], [0.079, 90], [0.145, 80], [0.209, 70], [0.278, 60], [0.359, 50], [1.795, 0]];
const RATING_GRAMS = { 'A+': 0.040, A: 0.079, B: 0.145, C: 0.209, D: 0.278, E: 0.359, F: 0.359 };
export function carbonScore(grams) {
  const g = Number(grams);
  if (grams == null || !Number.isFinite(g)) return null;
  if (g <= CARBON_ANCHORS[0][0]) return 100;
  for (let i = 1; i < CARBON_ANCHORS.length; i++) {
    const [g1, s1] = CARBON_ANCHORS[i];
    if (g <= g1) {
      const [g0, s0] = CARBON_ANCHORS[i - 1];
      return s0 + ((Math.log(g) - Math.log(g0)) / (Math.log(g1) - Math.log(g0))) * (s1 - s0);
    }
  }
  return 0;
}

export const pluginArea = (plugin) => (AREA_IDS.has(plugin?.area) ? plugin.area : GROUP_AREA[plugin?.group] || 'build');
export function resultArea(result, plugins = []) {
  const plugin = plugins.find((p) => p.id === result?.id);
  if (plugin) return pluginArea(plugin);
  return AREA_IDS.has(result?.area) ? result.area : pluginArea(null);
}

export function normRating(r) {
  const k = r ? String(r).trim().toLowerCase().replace(/\s+/g, '-') : '';
  return k in RATING_SCORE ? k : null;
}

export function grade(score) {
  if (score == null) return null;
  const s = Math.round(score);
  if (s < 60) return 'F';
  const low = s >= 90 ? 90 : s >= 80 ? 80 : s >= 70 ? 70 : 60;
  const letter = { 90: 'A', 80: 'B', 70: 'C', 60: 'D' }[low];
  return letter + (s >= low + 7 ? '+' : s <= low + 2 ? '−' : '');
}

export function status(score) {
  if (score == null) return 'none';
  return score >= 85 ? 'good' : score >= 70 ? 'warning' : score >= 50 ? 'serious' : 'critical';
}

function metricInput(areaId, results) {
  const lab = results.pagespeed?.status === 'ok' ? results.pagespeed.data?.lab?.scores : null;
  if (areaId === 'performance') {
    if (lab?.performance != null) return { label: 'Lighthouse performance', score: Math.round(lab.performance * 100) };
    const ratings = results.vitals?.status === 'ok'
      ? Object.values(results.vitals.data?.ratings || {}).map(normRating).filter(Boolean) : [];
    if (ratings.length) {
      return { label: 'Web vitals ratings', score: Math.round(ratings.reduce((n, r) => n + RATING_SCORE[r], 0) / ratings.length) };
    }
  }
  if (areaId === 'accessibility' && lab?.accessibility != null) {
    return { label: 'Lighthouse accessibility', score: Math.round(lab.accessibility * 100) };
  }
  if (areaId === 'sustainability' && results.carbon?.status === 'ok') {
    const d = results.carbon.data || {};
    const s = carbonScore(d.grams) ?? carbonScore(RATING_GRAMS[d.rating]);
    if (s != null) return { label: 'Carbon per visit', score: Math.round(s) };
  }
  return null;
}

export function scoreReading(reading, plugins = [], { profile } = {}) {
  const prof = resolveProfile(profile);
  const results = reading.log._harplus?.plugins || {};
  const areas = Object.fromEntries(AREAS.map((a) => [a.id, {
    ...a, weight: prof.weights[a.id], critical: prof.critical.includes(a.id),
    score: null, grade: null, status: 'none', measured: false,
    counts: { high: 0, medium: 0, low: 0, info: 0 }, deductions: [], inputs: [],
  }]));
  for (const r of Object.values(results)) {
    const home = resultArea(r, plugins);
    if (r.status === 'ok') areas[home].measured = true;
    for (const f of r.findings || []) {
      const area = CATEGORY_AREA[f.category] || home;
      const sev = SEVERITY_RANK[f.severity] != null ? f.severity : 'info';
      if (r.status === 'ok') areas[area].measured = true;
      areas[area].counts[sev]++;
      areas[area].deductions.push({ finding: { ...f, severity: sev, plugin: r.id, pluginName: r.name, area }, points: DEDUCT[sev] });
    }
  }
  for (const a of Object.values(areas)) {
    if (!a.measured) continue;
    const fromFindings = Math.max(0, 100 - SEVERITIES.reduce((n, s) => n + Math.min(CAP[s], DEDUCT[s] * a.counts[s]), 0));
    a.inputs.push({ label: 'Findings', score: fromFindings });
    const metric = metricInput(a.id, results);
    if (metric) a.inputs.push(metric);
    a.score = metric
      ? Math.round((2 * Math.min(fromFindings, metric.score) + Math.max(fromFindings, metric.score)) / 3)
      : fromFindings;
    a.grade = grade(a.score);
    a.status = status(a.score);
  }
  const measured = AREAS.filter((a) => areas[a.id].measured);
  const weight = measured.reduce((n, a) => n + prof.weights[a.id], 0);
  let score = weight ? Math.round(measured.reduce((n, a) => n + areas[a.id].score * prof.weights[a.id], 0) / weight) : null;
  const failing = prof.critical.filter((id) => areas[id].measured && areas[id].score < 60);
  let capped = null;
  if (score != null && failing.length && score > 69) {
    capped = { areas: failing, from: score };
    score = 69;
  }
  const findings = Object.values(areas).reduce((n, a) => n + a.deductions.length, 0);
  return {
    overall: { score, grade: grade(score), status: status(score), findings, profile: { id: prof.id, label: prof.label }, capped, failingCritical: failing },
    areas,
    weights: prof.weights,
  };
}

export function topFindings(scores, n = 5, areaId = null, { includeInfo = false } = {}) {
  return Object.values(scores.areas)
    .filter((a) => !areaId || a.id === areaId)
    .flatMap((a) => a.deductions.map((d) => d.finding))
    .filter((f) => includeInfo || f.severity !== 'info')
    .sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || (scores.weights?.[y.area] ?? 0) - (scores.weights?.[x.area] ?? 0))
    .slice(0, n);
}

export function summarize(scores) {
  const measured = AREAS.map((a) => scores.areas[a.id]).filter((a) => a.score != null);
  if (!measured.length) return 'No areas measured yet — enable plugins and re-run analysis.';
  const cap = scores.overall.capped;
  const capText = cap
    ? `Capped at D: ${cap.areas.map((id) => LABEL[id]).join(' and ')} ${cap.areas.length > 1 ? 'are' : 'is'} failing (critical for ${scores.overall.profile.label}). `
    : scores.overall.failingCritical?.length
      ? `${scores.overall.failingCritical.map((id) => LABEL[id]).join(' and ')} ${scores.overall.failingCritical.length > 1 ? 'are' : 'is'} failing (critical for ${scores.overall.profile.label}). `
      : '';
  const best = measured.reduce((x, y) => (y.score > x.score ? y : x));
  const worst = measured.reduce((x, y) => (y.score < x.score ? y : x));
  const name = (a) => a.label.toLowerCase();
  const parts = [best.score >= 85 ? `Strong on ${name(best)}` : `Best area: ${name(best)} (${best.score})`];
  if (worst !== best) parts.push(worst.score < 70 ? `weak on ${name(worst)}` : `no area below ${worst.score}`);
  let text = `${capText}${parts.join(', ')}.`;
  const top = topFindings(scores, 1)[0];
  if (top && (top.severity === 'high' || top.severity === 'medium')) text += ` Top issue: ${top.title.replace(/\.$/, '')}.`;
  return text;
}
