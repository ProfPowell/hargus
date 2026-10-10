// Area scores, grades and the one-line narrative for a reading. Pure (no DOM, no chrome.*):
// shared by the viewer, the standalone export and the CLI. Formula documented in docs/PLUGINS.md.

import { SEVERITIES, SEVERITY_RANK } from './har-util.js';

export const AREAS = [
  { id: 'performance', label: 'Performance', weight: 25 },
  { id: 'accessibility', label: 'Accessibility', weight: 25 },
  { id: 'security', label: 'Security', weight: 25 },
  { id: 'build', label: 'Build & content', weight: 15 },
  { id: 'infrastructure', label: 'Infrastructure', weight: 10 },
];
const AREA_IDS = new Set(AREAS.map((a) => a.id));
const WEIGHT = Object.fromEntries(AREAS.map((a) => [a.id, a.weight]));

export const CATEGORY_AREA = {
  performance: 'performance', accessibility: 'accessibility', security: 'security', privacy: 'security',
  quality: 'build', seo: 'build', infrastructure: 'infrastructure', intel: 'infrastructure',
};
export const GROUP_AREA = { build: 'build', security: 'security', infrastructure: 'infrastructure', quality: 'performance', other: 'build' };
export const DEDUCT = { high: 15, medium: 6, low: 2, info: 0 };
export const CAP = { high: 60, medium: 30, low: 15, info: 0 };
export const VERDICT = { good: 'good', warning: 'needs work', serious: 'poor', critical: 'failing', none: 'not measured' };
const RATING_SCORE = { good: 100, 'needs-improvement': 60, poor: 20 };

export const pluginArea = (plugin) => (AREA_IDS.has(plugin?.area) ? plugin.area : GROUP_AREA[plugin?.group] || 'build');
export const resultArea = (result, plugins = []) =>
  (AREA_IDS.has(result?.area) ? result.area : pluginArea(plugins.find((p) => p.id === result?.id)));

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
  return null;
}

export function scoreReading(reading, plugins = []) {
  const results = reading.log._harplus?.plugins || {};
  const areas = Object.fromEntries(AREAS.map((a) => [a.id, {
    ...a, score: null, grade: null, status: 'none', measured: false,
    counts: { high: 0, medium: 0, low: 0, info: 0 }, deductions: [], inputs: [],
  }]));
  for (const r of Object.values(results)) {
    const home = resultArea(r, plugins);
    if (r.status === 'ok') areas[home].measured = true;
    for (const f of r.findings || []) {
      const area = CATEGORY_AREA[f.category] || home;
      const sev = SEVERITY_RANK[f.severity] != null ? f.severity : 'info';
      areas[area].counts[sev]++;
      areas[area].deductions.push({ finding: { ...f, severity: sev, plugin: r.id, pluginName: r.name, area }, points: DEDUCT[sev] });
    }
  }
  for (const a of Object.values(areas)) {
    if (!a.measured) continue;
    const fromFindings = 100 - SEVERITIES.reduce((n, s) => n + Math.min(CAP[s], DEDUCT[s] * a.counts[s]), 0);
    a.inputs.push({ label: 'Findings', score: fromFindings });
    const metric = metricInput(a.id, results);
    if (metric) a.inputs.push(metric);
    a.score = Math.round(metric ? (fromFindings + metric.score) / 2 : fromFindings);
    a.grade = grade(a.score);
    a.status = status(a.score);
  }
  const measured = AREAS.filter((a) => areas[a.id].measured);
  const weight = measured.reduce((n, a) => n + a.weight, 0);
  const score = weight ? Math.round(measured.reduce((n, a) => n + areas[a.id].score * a.weight, 0) / weight) : null;
  const findings = Object.values(areas).reduce((n, a) => n + a.deductions.length, 0);
  return { overall: { score, grade: grade(score), status: status(score), findings }, areas };
}

export function topFindings(scores, n = 5, areaId = null, { includeInfo = false } = {}) {
  return Object.values(scores.areas)
    .filter((a) => !areaId || a.id === areaId)
    .flatMap((a) => a.deductions.map((d) => d.finding))
    .filter((f) => includeInfo || f.severity !== 'info')
    .sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || WEIGHT[y.area] - WEIGHT[x.area])
    .slice(0, n);
}

export function summarize(scores) {
  const measured = AREAS.map((a) => scores.areas[a.id]).filter((a) => a.score != null);
  if (!measured.length) return 'No areas measured yet — enable plugins and re-run analysis.';
  const best = measured.reduce((x, y) => (y.score > x.score ? y : x));
  const worst = measured.reduce((x, y) => (y.score < x.score ? y : x));
  const name = (a) => a.label.toLowerCase();
  const parts = [best.score >= 85 ? `Strong on ${name(best)}` : `Best area: ${name(best)} (${best.score})`];
  if (worst !== best) parts.push(worst.score < 70 ? `weak on ${name(worst)}` : `no area below ${worst.score}`);
  let text = `${parts.join(', ')}.`;
  const top = topFindings(scores, 1)[0];
  if (top && (top.severity === 'high' || top.severity === 'medium')) text += ` Top issue: ${top.title.replace(/\.$/, '')}.`;
  return text;
}
