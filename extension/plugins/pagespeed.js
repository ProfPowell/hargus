// PageSpeed Insights: Lighthouse run on Google's servers plus Chrome UX Report field data (how real
// users experience the page, when Google has enough traffic). Needs a free Google API key
// (Options → API keys → PageSpeed Insights). Google fetches the page itself — public URLs only.

import { toPluginResult } from './kb/lighthouse.js';
import { baseView } from '../core/views.js';

const FIELD = [
  ['LARGEST_CONTENTFUL_PAINT_MS', 'LCP', (v) => `${(v / 1000).toFixed(1)} s`],
  ['INTERACTION_TO_NEXT_PAINT', 'INP', (v) => `${v} ms`],
  ['CUMULATIVE_LAYOUT_SHIFT_SCORE', 'CLS', (v) => (v / 100).toFixed(2)],
  ['FIRST_CONTENTFUL_PAINT_MS', 'FCP', (v) => `${(v / 1000).toFixed(1)} s`],
  ['EXPERIMENTAL_TIME_TO_FIRST_BYTE', 'TTFB', (v) => `${(v / 1000).toFixed(2)} s`],
];
const RATING = { FAST: 'good', AVERAGE: 'needs improvement', SLOW: 'poor' };

export function fieldData(exp) {
  if (!exp?.metrics) return null;
  return {
    scope: exp.origin_fallback ? 'origin' : 'page',
    overall: RATING[exp.overall_category] || exp.overall_category,
    metrics: FIELD.filter(([k]) => exp.metrics[k]).map(([k, label, fmt]) => ({
      metric: label, p75: fmt(exp.metrics[k].percentile), rating: RATING[exp.metrics[k].category] || exp.metrics[k].category,
    })),
  };
}

async function run(reading, ctx) {
  const key = ctx.keys.pagespeed;
  if (!key) ctx.skip('add a PageSpeed Insights API key in Options → API keys');
  const target = ctx.target.finalUrl;
  if (!/^https?:\/\//.test(target || '') || ctx.util.isIP(ctx.target.host)) ctx.skip('PageSpeed needs a public URL');
  const chosen = ctx.options.strategy;
  const strategy = chosen === 'mobile' || chosen === 'desktop' ? chosen : (baseView(reading) === 'mobile' ? 'mobile' : 'desktop');
  const url = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  url.searchParams.set('url', target);
  url.searchParams.set('strategy', strategy);
  for (const c of ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO']) url.searchParams.append('category', c);
  url.searchParams.set('key', key);
  const r = await ctx.fetch(url.href);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`PageSpeed Insights: ${j.error?.message || `HTTP ${r.status}`}`);
  const lab = j.lighthouseResult ? toPluginResult(j.lighthouseResult) : { summary: [], findings: [], data: null };
  const field = fieldData(j.loadingExperience) || fieldData(j.originLoadingExperience);
  const findings = [...lab.findings];
  for (const m of field?.metrics || []) {
    if (m.rating === 'poor') findings.unshift({ severity: 'medium', category: 'performance', title: `Real users: ${m.metric} p75 ${m.p75} (poor)`, detail: `Chrome UX Report, ${field.scope}-level data` });
  }
  // The summary rows are labelled with the category titles, which Lighthouse localizes ("Leistung"): find the
  // performance row by its category id's title, not by the English word.
  const perfTitle = j.lighthouseResult?.categories?.performance?.title;
  const isPerf = (s) => perfTitle != null && s.label === perfTitle;
  return {
    data: { strategy, lab: lab.data, field },
    findings,
    summary: [
      // The Lighthouse performance score is the headline; without a lab run, the real-user line is.
      ...lab.summary.map((s) => (isPerf(s) ? { ...s, headline: true } : s)),
      {
        label: `Field (${field?.scope || 'n/a'})`,
        value: field ? field.metrics.map((m) => `${m.metric} ${m.p75}`).join(' · ') : 'not enough real-user data',
        ...(lab.summary.some(isPerf) ? {} : { headline: true }),
      },
    ],
  };
}

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const STATUS = { good: 'good', 'needs improvement': 'fair', poor: 'poor' };
const STAT_RATING = { good: 'good', 'needs improvement': 'needs-improvement', poor: 'poor' };

/**
 * Answer first: the real-user p75 of each metric with its rating in words (Chrome UX Report), then the lab run's
 * version, device and page. The Lighthouse score rings are the glance's, so the scores are not repeated here.
 */
function render(r, h) {
  const d = r.data || {};
  const field = d.field;
  const lab = d.lab;
  return h.html`
    ${field ? h.sub(`Real users (Chrome UX Report, ${field.scope})`, h.html`${h.stats((field.metrics || []).map((m) => h.stat({ label: m.metric, value: m.p75, rating: STAT_RATING[m.rating] })))}
      ${field.overall ? h.html`<p class="note">Overall ${h.status(STATUS[field.overall] || 'none', cap(field.overall))}</p>` : ''}`) : h.html`<p class="note">No Chrome UX Report data for this page or origin.</p>`}
    ${lab ? h.sub('Lab', h.kv([
      ['Lighthouse', lab.lighthouseVersion],
      ['Device', d.strategy],
      ['Page', lab.url ? h.link(lab.url) : ''],
      ['Run at', lab.fetchTime],
    ])) : ''}
  `;
}

const LH_NAMES = { performance: 'Performance', accessibility: 'Accessibility', 'best-practices': 'Best practices', seo: 'SEO' };

function glance(r, h) {
  const s = r.data?.lab?.scores || {};
  const rings = Object.entries(LH_NAMES).filter(([k]) => s[k] != null).map(([k, label]) => {
    const v = Math.round(s[k] * 100);
    const status = v >= 90 ? 'good' : v >= 50 ? 'warning' : 'critical'; // Lighthouse's own bands
    return h.html`<figure class="ring-fig">${h.ring({ value: v, size: 64, status, label: `Lighthouse ${label}` })}<figcaption>${label}</figcaption></figure>`;
  });
  return rings.length ? h.html`<section class="card"><h4>Lighthouse · ${r.data.strategy || 'mobile'}</h4><div class="ring-row">${rings}</div></section>` : '';
}

export default {
  id: 'pagespeed',
  group: 'quality',
  name: 'PageSpeed Insights',
  version: '0.1.0',
  phase: 'enrich',
  description: 'Lighthouse scores from Google plus real-user Core Web Vitals (Chrome UX Report). Needs a free API key.',
  disclosure: 'Sends the page URL to Google PageSpeed Insights, which loads the page.',
  tags: ['performance', 'accessibility', 'seo'],
  options: [{ key: 'strategy', label: 'Device', type: 'select', default: 'auto', choices: ['auto', 'mobile', 'desktop'] }],
  timeoutMs: 120_000,
  run,
  render,
  glance,
};
