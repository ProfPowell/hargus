// The metrics compared across readings: one small pure extractor per metric, in display order.
// Pure (no DOM, no chrome.*). Consumed by core/compare.js (winners, ties) and the compare page.

import { spreadAll, sampleOf } from './runs.js';
import { transferSize, formatMs, formatBytes } from './har-util.js';

const dataOf = (reading, id) => {
  const r = reading?.log?._harplus?.plugins?.[id];
  return r?.status === 'ok' ? r.data || null : null;
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// The vitals data and its per-timing spreads: the stored ones when present, otherwise computed from the joined samples.
function vitalsOf(reading) {
  const d = dataOf(reading, 'vitals');
  if (!d) return null;
  if (d.runs?.metrics) return { d, spreads: d.runs.metrics };
  const all = [...(reading.log._harplus.runs?.samples || []), sampleOf(d)];
  return { d, spreads: all.length >= 2 ? spreadAll(all) : null };
}

// A run-based timing: the median when runs exist, else the full run's own figure; the spread's min and max as the range.
const timing = (id, own) => ({
  get(reading) {
    const v = vitalsOf(reading);
    return v ? num(v.d.median?.[id] ?? v.spreads?.[id]?.median ?? own(v.d)) : null;
  },
  range(reading) {
    const s = vitalsOf(reading)?.spreads?.[id];
    return s && s.n >= 2 ? { min: s.min, max: s.max, n: s.n } : null;
  },
});

// High plus medium findings in an area; null when the area was not measured (or no scores were given).
const findings = (area) => (reading, scores) => {
  const a = scores?.areas?.[area];
  return a?.measured ? a.counts.high + a.counts.medium : null;
};
const fromPlugin = (id, pick) => (reading) => num(pick(dataOf(reading, id)));
const entriesOf = (reading) => reading?.log?.entries || [];

const metric = (id, area, label, unit, best, worst, impl, better = 'lower') => ({ id, area, label, unit, better, best, worst, ...impl });
const value = (get) => ({ get });

/** Every metric, in display order. get(reading, scores) → number | null; range(reading) → { min, max, n } | null on the run-based timings. */
export const METRICS = [
  metric('lcp', 'performance', 'LCP', 'ms', 'Fastest LCP', 'Slowest LCP', timing('lcp', (d) => d.lcp?.time)),
  metric('fcp', 'performance', 'FCP', 'ms', 'Fastest FCP', 'Slowest FCP', timing('fcp', (d) => d.fcp)),
  metric('ttfb', 'performance', 'TTFB', 'ms', 'Fastest server response', 'Slowest server response', timing('ttfb', (d) => d.navigation?.ttfb)),
  metric('cls', 'performance', 'CLS', 'cls', 'Most stable layout', 'Least stable layout', timing('cls', (d) => d.cls)),
  metric('blockingTime', 'performance', 'Blocking time', 'ms', 'Least blocking', 'Most blocking', timing('blockingTime', (d) => d.blockingTime)),
  metric('load', 'performance', 'Load', 'ms', 'Fastest load', 'Slowest load', timing('load', (d) => d.navigation?.load || null)),
  metric('bytes', 'performance', 'Page weight', 'bytes', 'Lightest page', 'Heaviest page', value((r) => entriesOf(r).reduce((n, e) => n + transferSize(e), 0))),
  metric('requests', 'performance', 'Requests', 'count', 'Fewest requests', 'Most requests', value((r) => entriesOf(r).length)),
  metric('a11yFindings', 'accessibility', 'Accessibility findings', 'count', 'Fewest accessibility issues', 'Most accessibility issues', value(findings('accessibility'))),
  metric('contrastFailures', 'accessibility', 'Contrast failures', 'count', 'Fewest contrast failures', 'Most contrast failures', value(fromPlugin('contrast', (d) => d?.totals?.failing))),
  metric('securityFindings', 'security', 'Security findings', 'count', 'Fewest security issues', 'Most security issues', value(findings('security'))),
  metric('securityHeaders', 'security', 'Security headers', 'count', 'Most security headers', 'Fewest security headers',
    value(fromPlugin('security', (d) => (Array.isArray(d?.headers) ? d.headers.filter((h) => h.ok).length : null))), 'higher'),
  metric('contentFindings', 'content', 'Content findings', 'count', 'Fewest content issues', 'Most content issues', value(findings('content'))),
  metric('thirdPartyRequests', 'build', 'Third-party requests', 'count', 'Fewest third-party requests', 'Most third-party requests', value(fromPlugin('network', (d) => d?.totals?.thirdParty?.requests))),
  metric('jsBytes', 'build', 'JS bytes', 'bytes', 'Least JavaScript', 'Most JavaScript', value(fromPlugin('javascript', (d) => d?.totals?.bytes))),
  metric('cssBytes', 'build', 'CSS bytes', 'bytes', 'Least CSS', 'Most CSS', value(fromPlugin('css', (d) => d?.totalBytes))),
  metric('infrastructureFindings', 'infrastructure', 'Infrastructure findings', 'count', 'Fewest infrastructure issues', 'Most infrastructure issues', value(findings('infrastructure'))),
  metric('internationalFindings', 'international', 'International findings', 'count', 'Fewest international issues', 'Most international issues', value(findings('international'))),
  metric('carbon', 'sustainability', 'Carbon per visit', 'grams', 'Lowest carbon', 'Highest carbon', value(fromPlugin('carbon', (d) => d?.grams))),
];

/** { [metric id]: { value, range } } for one reading; scores is scoreReading's result (the findings metrics are null without it). */
export function metricValues(reading, scores) {
  return Object.fromEntries(METRICS.map((m) => [m.id, { value: m.get(reading, scores), range: m.range ? m.range(reading) : null }]));
}

/** A metric value as text ('—' when missing). */
export function formatMetric(id, v) {
  const m = METRICS.find((x) => x.id === id);
  if (v == null || !m) return '—';
  if (m.unit === 'ms') return formatMs(v);
  if (m.unit === 'bytes') return formatBytes(v);
  if (m.unit === 'grams') return `${Math.round(v * 100) / 100} g`;
  if (m.unit === 'cls') return String(Math.round(v * 1000) / 1000);
  return String(v);
}
