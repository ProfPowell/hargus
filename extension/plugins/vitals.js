// In-page performance readings: navigation timing, paint, LCP, CLS, long animation frames.
// Lab data from one load on your machine — directional, not field (CrUX) data.

import { formatMs } from '../core/har-util.js';
import { RUN_METRICS, sampleOf, spreadAll } from '../core/runs.js';

async function collect() {
  const observe = (type) => new Promise((resolve) => {
    const list = [];
    try {
      const po = new PerformanceObserver((l) => list.push(...l.getEntries()));
      po.observe({ type, buffered: true });
      setTimeout(() => { po.disconnect(); resolve(list); }, 200);
    } catch { resolve([]); }
  });
  // HARgus scrolls the page to load lazy content; entries after that are caused by us, not the page.
  const mark = performance.getEntriesByName('harplus:scroll-start')[0];
  const cut = mark ? mark.startTime : Infinity;
  const before = (xs) => xs.filter((e) => e.startTime < cut);
  const [lcpEntries, shifts, loafs] = (await Promise.all([
    observe('largest-contentful-paint'), observe('layout-shift'), observe('long-animation-frame'),
  ])).map(before);

  // CLS: largest session window (1s gap, 5s max) of shifts without recent input
  let cls = 0; let session = 0; let first = 0; let last = 0; let win = []; let best = [];
  for (const s of shifts) {
    if (s.hadRecentInput) continue;
    if (session && s.startTime - last < 1000 && s.startTime - first < 5000) { session += s.value; win.push(s); }
    else { session = s.value; first = s.startTime; win = [s]; }
    last = s.startTime;
    if (session > cls) { cls = session; best = win.slice(); }
  }

  const lcp = lcpEntries.at(-1);
  const describe = (el) => {
    if (!el) return null;
    let d = el.localName;
    if (el.id) d += `#${el.id}`;
    else if (el.classList?.length) d += `.${[...el.classList].slice(0, 2).join('.')}`;
    return d;
  };
  const rect = (r) => (r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null);
  const clsSources = best.sort((a, b) => b.value - a.value).slice(0, 3).map((s) => ({
    value: Math.round(s.value * 1000) / 1000,
    sources: (s.sources || []).slice(0, 3).map((x) => ({ node: describe(x.node) || '(removed)', previous: rect(x.previousRect), current: rect(x.currentRect) })),
  }));
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, e.startTime]));
  const resources = performance.getEntriesByType('resource');
  const blockingTime = loafs.reduce((t, f) => t + Math.max(0, (f.blockingDuration ?? f.duration - 50)), 0);

  return {
    visibility: document.visibilityState,
    navigation: nav ? {
      type: nav.type,
      protocol: nav.nextHopProtocol,
      ttfb: nav.responseStart - (nav.activationStart || 0),
      domInteractive: nav.domInteractive,
      domContentLoaded: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      transferSize: nav.transferSize,
      redirectCount: nav.redirectCount,
      serverTiming: (nav.serverTiming || []).map((s) => ({ name: s.name, duration: s.duration, description: s.description })),
    } : null,
    fcp: paint['first-contentful-paint'] ?? null,
    lcp: lcp ? { time: lcp.startTime, size: lcp.size, element: describe(lcp.element), url: lcp.url || undefined } : null,
    cls: Math.round(cls * 1000) / 1000,
    clsSources,
    longAnimationFrames: loafs.length,
    blockingTime: Math.round(blockingTime),
    resources: resources.length,
    renderBlocking: resources.filter((r) => r.renderBlockingStatus === 'blocking').map((r) => r.name).slice(0, 200), // RB_CAP in ui/waterfall.js
    domElements: document.getElementsByTagName('*').length,
    cutAt: Number.isFinite(cut) ? Math.round(cut) : null,
  };
}

// web.dev thresholds: [good, poor]
export const LIMITS = { lcp: [2500, 4000], fcp: [1800, 3000], ttfb: [800, 1800], cls: [0.1, 0.25] };
export const BLOCKING = [200, 600]; // Lighthouse total-blocking-time thresholds (ms)
const sec = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

const band = (value, [good, poor]) => (value <= good ? 'good' : value <= poor ? 'needs improvement' : 'poor');

function rate(metric, value) {
  return value == null ? null : band(value, LIMITS[metric]);
}

/** "1 of 3 runs was poor": the runs whose band differs from the median's, one phrase per other band; '' when none. */
function straddle(m, limits) {
  if (!m?.bands) return '';
  const own = band(m.median, limits);
  return Object.entries(m.bands).filter(([b, k]) => k && b !== own)
    .map(([b, k]) => `${k} of ${m.n} runs ${b === 'needs improvement' ? 'needed improvement' : `${k === 1 ? 'was' : 'were'} ${b}`}`).join('; ');
}

/** "3.0–5.0 s": both ends in one unit when they share it. */
function range(min, max, fmt) {
  let a = fmt(min);
  let b = fmt(max);
  if (min !== max && a === b) {
    // The ends round to the same text while the metric varies: show one more digit, or whole milliseconds.
    if (a.endsWith(' s')) {
      a = `${(min / 1000).toFixed(2)} s`; b = `${(max / 1000).toFixed(2)} s`;
      if (a === b) { a = `${Math.round(min)} ms`; b = `${Math.round(max)} ms`; }
    } else if (!a.includes(' ')) { a = min.toFixed(3); b = max.toFixed(3); }
  }
  const unit = (x) => x.split(' ')[1];
  return unit(a) && unit(a) === unit(b) ? `${a.split(' ')[0]}–${b}` : `${a}–${b}`;
}

/** The note under a tile: its range across the runs, how many, and whether they disagree. */
const runNote = (m, fmt) => (m ? `${range(m.min, m.max, fmt)} · ${m.n} runs · ${m.varies ? 'varies' : 'steady'}` : '');

/**
 * The elements a metric finding is about: the LCP element (with its resource), or every element in the saved
 * layout-shift sources (clsSources) once, with the score of the first shift it appears in. Elements the page removed are left out. Other metrics have none.
 */
function placesFor(metric, c) {
  if (metric === 'lcp' && c.lcp?.element) return [{ selector: c.lcp.element, ...(c.lcp.url ? { url: c.lcp.url } : {}) }];
  if (metric !== 'cls') return [];
  const seen = new Map();
  for (const s of c.clsSources || []) {
    for (const x of s.sources || []) if (x.node && x.node !== '(removed)' && !seen.has(x.node)) seen.set(x.node, s.value);
  }
  return [...seen].map(([selector, value]) => ({ selector, note: `shift ${value}` }));
}

function run(reading, ctx) {
  const c = ctx.collected;
  if (!c) ctx.skip('no page data');
  // Several runs: every figure below is the median of the timing runs plus the full run. With fewer than two values it is the full run's.
  const runs = reading?.log?._harplus?.runs;
  const all = [...(runs?.samples || []), { run: runs?.requested, full: true, ...sampleOf(c) }];
  const limits = { ...LIMITS, blockingTime: BLOCKING };
  const spreads = all.length >= 2 ? spreadAll(all, limits) : null;
  const pick = (k, full) => spreads?.[k]?.median ?? full;
  const blockingTime = pick('blockingTime', c.blockingTime);
  const findings = [];
  const measured = c.cutAt != null ? `Measured up to ${sec(c.cutAt)}, before HARgus scrolled the page.` : '';
  const withNote = (...parts) => parts.filter(Boolean).join(' ');
  const metrics = {
    ttfb: pick('ttfb', c.navigation?.ttfb), fcp: pick('fcp', c.fcp), lcp: pick('lcp', c.lcp?.time),
    // a median of two floats is a mean (0.15000000000000002); round it as collect() rounds cls
    cls: spreads?.cls ? Math.round(spreads.cls.median * 1000) / 1000 : c.cls,
  };
  const ratings = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, rate(k, v)]));
  const names = { ttfb: 'Time to first byte', fcp: 'First contentful paint', lcp: 'Largest contentful paint', cls: 'Cumulative layout shift' };
  for (const [k, r] of Object.entries(ratings)) {
    if (r === 'good' || !r) continue;
    const v = k === 'cls' ? metrics[k] : formatMs(metrics[k]);
    const shifted = k === 'cls' ? [...new Set((c.clsSources || []).flatMap((s) => s.sources.map((x) => x.node)))].slice(0, 3) : [];
    const detail = withNote(shifted.length ? `Shifted: ${shifted.join(', ')}` : '', k === 'lcp' || k === 'cls' ? measured : '');
    const places = placesFor(k, c);
    const evidence = straddle(spreads?.[k], limits[k]);
    findings.push({
      id: 'slow-metric', subject: k,
      severity: r === 'poor' ? 'medium' : 'low',
      category: 'performance',
      title: `${names[k]} ${r}: ${v}`,
      ref: `https://web.dev/articles/${k}`,
      ...(detail ? { detail } : {}),
      ...(evidence ? { evidence } : {}),
      ...(places.length ? { places } : {}),
    });
  }
  if (blockingTime > 300) {
    const evidence = straddle(spreads?.blockingTime, BLOCKING);
    findings.push({ id: 'main-thread-blocked', severity: 'low', category: 'performance', title: `Main thread blocked for ${formatMs(blockingTime)} by long animation frames`, ...(measured ? { detail: measured } : {}), ...(evidence ? { evidence } : {}) });
  }
  if (c.renderBlocking.length > 5) findings.push({ id: 'render-blocking', severity: 'low', category: 'performance', title: `${c.renderBlocking.length} render-blocking resources`, places: c.renderBlocking.slice(0, 200).map((url) => ({ url })) });
  if (c.domElements > 1500) findings.push({ id: 'large-dom', severity: 'low', category: 'performance', title: `Large DOM: ${c.domElements.toLocaleString()} elements` });
  if (c.visibility !== 'visible') findings.push({ id: 'tab-hidden', severity: 'info', category: 'performance', title: 'Tab was not visible during capture — paint metrics may be missing' });

  return {
    data: {
      ...c,
      ratings,
      ...(spreads ? {
        runs: { n: all.length, requested: runs?.requested ?? all.length, samples: all, skipped: runs?.skipped || [], metrics: spreads },
        median: { lcp: metrics.lcp, fcp: metrics.fcp, ttfb: metrics.ttfb, cls: metrics.cls, blockingTime },
      } : {}),
    },
    findings,
    summary: [
      { label: 'LCP', value: metrics.lcp == null ? '—' : formatMs(metrics.lcp), rating: ratings.lcp, headline: true },
      { label: 'CLS', value: metrics.cls == null ? '—' : String(metrics.cls), rating: ratings.cls },
      { label: 'FCP', value: metrics.fcp == null ? '—' : formatMs(metrics.fcp), rating: ratings.fcp },
      { label: 'TTFB', value: metrics.ttfb == null ? '—' : formatMs(metrics.ttfb), rating: ratings.ttfb },
      { label: 'DOMContentLoaded · load', value: c.navigation ? `${formatMs(pick('domContentLoaded', c.navigation.domContentLoaded))} · ${formatMs(pick('load', c.navigation.load))}` : '' },
    ],
  };
}

/** Every run's timings (the full reading marked), the median, and the runs that did not finish. Closed until opened; print opens it. */
function eachRun(runs, h) {
  const t = (v) => (v == null ? '—' : h.ms(v));
  const cls = (v) => (v == null ? '—' : Number(v).toFixed(2));
  const row = (label, s) => ({ run: label, lcp: t(s.lcp), fcp: t(s.fcp), ttfb: t(s.ttfb), cls: cls(s.cls), blocking: t(s.blockingTime), load: t(s.load) });
  const med = Object.fromEntries(RUN_METRICS.map((k) => [k, runs.metrics?.[k]?.median]));
  const rows = [
    ...(runs.samples || []).map((s) => row(s.full ? `${s.run} (full reading)` : String(s.run), s)),
    row('Median', med),
  ];
  const cols = [{ key: 'run', label: 'Run' }, { key: 'lcp', label: 'LCP' }, { key: 'fcp', label: 'FCP' }, { key: 'ttfb', label: 'TTFB' }, { key: 'cls', label: 'CLS' }, { key: 'blocking', label: 'Blocking' }, { key: 'load', label: 'Load' }];
  const skipped = (runs.skipped || []).map((s) => `Run ${s.run}: ${s.reason || 'did not finish'}`);
  return h.more('Each run', h.html`${h.table(rows, cols, { fold: false })}${skipped.length ? h.list(skipped, { fold: false }) : ''}`);
}

/**
 * Answer first (the load milestones the glance does not show), then the LCP element, render-blocking resources,
 * Server-Timing and layout shifts. The rated LCP, CLS, FCP, TTFB and blocking-time tiles are the glance's.
 */
function render(r, h) {
  const d = r.data || {};
  const nav = d.navigation || {};
  const blocking = Array.isArray(d.renderBlocking) ? d.renderBlocking : [];
  const m = d.runs?.metrics;
  const dcl = m?.domContentLoaded?.median ?? nav.domContentLoaded;
  const load = m?.load?.median ?? nav.load;
  return h.html`${h.stats([
    dcl != null ? h.stat({ label: 'DOMContentLoaded', value: h.ms(dcl), note: runNote(m?.domContentLoaded, formatMs) }) : '',
    load != null ? h.stat({ label: 'Load', value: h.ms(load), note: runNote(m?.load, formatMs) }) : '',
    h.stat({ label: 'Render-blocking', value: blocking.length }),
    d.domElements != null ? h.stat({ label: 'DOM elements', value: Number(d.domElements).toLocaleString() }) : '',
  ])}
    ${h.kv([
      ['LCP element', d.lcp?.element || ''],
      ['LCP resource', d.lcp?.url ? h.url(d.lcp.url) : ''],
      ['DOM interactive', nav.domInteractive != null ? h.ms(nav.domInteractive) : ''],
      ['Long animation frames', d.longAnimationFrames != null ? `${d.longAnimationFrames} (${h.ms(d.blockingTime)} blocking)` : ''],
      ['Resources', d.resources],
      ['Protocol', nav.protocol],
    ])}
    ${d.runs ? eachRun(d.runs, h) : ''}
    ${blocking.length ? h.sub('Render-blocking resources', h.list(blocking.map((u) => h.url(u)))) : ''}
    ${nav.serverTiming?.length ? h.sub('Server-Timing', h.table(nav.serverTiming, ['name', 'duration', 'description'])) : ''}
    ${(d.clsSources || []).length ? h.sub('Layout shifts', h.table(d.clsSources.flatMap((s) => s.sources.map((x) => ({
      value: String(s.value), node: x.node,
      move: `${x.previous ? `${x.previous.w}×${x.previous.h} @${x.previous.x},${x.previous.y}` : '—'} → ${x.current ? `${x.current.w}×${x.current.h} @${x.current.x},${x.current.y}` : '—'}`,
    }))), [{ key: 'value', label: 'Shift' }, { key: 'node', label: 'Element' }, { key: 'move', label: 'Before → after' }])) : ''}
  `;
}

function glance(r, h) {
  const d = r.data;
  const med = d.median || {};
  const spreads = d.runs?.metrics || {};
  const cls2 = (v) => Number(v).toFixed(2);
  // With runs the tile shows the median and a note under it; otherwise the full run, as before.
  const tile = (label, value, rating, fmt, [good, poor], spread) => (value == null ? '' : h.stat({
    label, value: fmt(value), rating: rating || h.rate(value, good, poor),
    ...(d.runs && spread ? { note: runNote(spread, fmt) } : {}),
    meter: h.meter({ value, good, poor, format: fmt, label }),
  }));
  return h.html`<div class="tiles">
    ${tile('Largest contentful paint', med.lcp ?? d.lcp?.time, d.ratings?.lcp, sec, LIMITS.lcp, spreads.lcp)}
    ${tile('Cumulative layout shift', med.cls ?? d.cls, d.ratings?.cls, cls2, LIMITS.cls, spreads.cls)}
    ${tile('First contentful paint', med.fcp ?? d.fcp, d.ratings?.fcp, sec, LIMITS.fcp, spreads.fcp)}
    ${tile('Time to first byte', med.ttfb ?? d.navigation?.ttfb, d.ratings?.ttfb, sec, LIMITS.ttfb, spreads.ttfb)}
    ${tile('Blocking time', med.blockingTime ?? d.blockingTime, null, sec, BLOCKING, spreads.blockingTime)}
  </div>`;
}

export default {
  id: 'vitals',
  group: 'quality',
  name: 'Web vitals',
  version: '0.1.0',
  phase: 'page',
  world: 'main',
  description: 'LCP, CLS, FCP, TTFB, blocking time and render-blocking resources from the browser\'s performance timeline.',
  tags: ['performance'],
  collect,
  run,
  render,
  glance,
};
