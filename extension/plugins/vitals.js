// In-page performance readings: navigation timing, paint, LCP, CLS, long animation frames.
// Lab data from one load on your machine — directional, not field (CrUX) data.

import { formatMs } from '../core/har-util.js';

async function collect() {
  const observe = (type) => new Promise((resolve) => {
    const list = [];
    try {
      const po = new PerformanceObserver((l) => list.push(...l.getEntries()));
      po.observe({ type, buffered: true });
      setTimeout(() => { po.disconnect(); resolve(list); }, 200);
    } catch { resolve([]); }
  });
  const [lcpEntries, shifts, loafs] = await Promise.all([
    observe('largest-contentful-paint'), observe('layout-shift'), observe('long-animation-frame'),
  ]);

  // CLS: largest session window (1s gap, 5s max) of shifts without recent input
  let cls = 0; let session = 0; let first = 0; let last = 0;
  for (const s of shifts) {
    if (s.hadRecentInput) continue;
    if (session && s.startTime - last < 1000 && s.startTime - first < 5000) session += s.value;
    else { session = s.value; first = s.startTime; }
    last = s.startTime;
    cls = Math.max(cls, session);
  }

  const lcp = lcpEntries.at(-1);
  const describe = (el) => {
    if (!el) return null;
    let d = el.localName;
    if (el.id) d += `#${el.id}`;
    else if (el.classList?.length) d += `.${[...el.classList].slice(0, 2).join('.')}`;
    return d;
  };
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
    longAnimationFrames: loafs.length,
    blockingTime: Math.round(blockingTime),
    resources: resources.length,
    renderBlocking: resources.filter((r) => r.renderBlockingStatus === 'blocking').map((r) => r.name).slice(0, 30),
    domElements: document.getElementsByTagName('*').length,
  };
}

// web.dev thresholds: [good, poor]
const LIMITS = { lcp: [2500, 4000], fcp: [1800, 3000], ttfb: [800, 1800], cls: [0.1, 0.25] };

function rate(metric, value) {
  if (value == null) return null;
  const [good, poor] = LIMITS[metric];
  return value <= good ? 'good' : value <= poor ? 'needs improvement' : 'poor';
}

function run(reading, ctx) {
  const c = ctx.collected;
  if (!c) ctx.skip('no page data');
  const findings = [];
  const metrics = {
    ttfb: c.navigation?.ttfb, fcp: c.fcp, lcp: c.lcp?.time, cls: c.cls,
  };
  const ratings = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, rate(k, v)]));
  const names = { ttfb: 'Time to first byte', fcp: 'First contentful paint', lcp: 'Largest contentful paint', cls: 'Cumulative layout shift' };
  for (const [k, r] of Object.entries(ratings)) {
    if (r === 'good' || !r) continue;
    const v = k === 'cls' ? metrics[k] : formatMs(metrics[k]);
    findings.push({
      severity: r === 'poor' ? 'medium' : 'low',
      category: 'performance',
      title: `${names[k]} ${r}: ${v}`,
      ref: `https://web.dev/articles/${k}`,
    });
  }
  if (c.blockingTime > 300) findings.push({ severity: 'low', category: 'performance', title: `Main thread blocked for ${formatMs(c.blockingTime)} by long animation frames` });
  if (c.renderBlocking.length > 5) findings.push({ severity: 'low', category: 'performance', title: `${c.renderBlocking.length} render-blocking resources` });
  if (c.domElements > 1500) findings.push({ severity: 'low', category: 'performance', title: `Large DOM: ${c.domElements.toLocaleString()} elements` });
  if (c.visibility !== 'visible') findings.push({ severity: 'info', category: 'performance', title: 'Tab was not visible during capture — paint metrics may be missing' });

  const fmt = (k) => (metrics[k] == null ? '—' : `${k === 'cls' ? metrics[k] : formatMs(metrics[k])} (${ratings[k]})`);
  return {
    data: { ...c, ratings },
    findings,
    summary: [
      { label: 'LCP', value: fmt('lcp') },
      { label: 'CLS', value: fmt('cls') },
      { label: 'FCP', value: fmt('fcp') },
      { label: 'TTFB', value: fmt('ttfb') },
      { label: 'DOMContentLoaded · load', value: c.navigation ? `${formatMs(c.navigation.domContentLoaded)} · ${formatMs(c.navigation.load)}` : '' },
    ],
  };
}

function render(r, h) {
  const d = r.data;
  const row = (label, v, k) => [label, h.html`${v} ${k && d.ratings[k] ? h.rating(d.ratings[k]) : ''}`];
  return h.html`
    ${h.kv([
      row('Largest contentful paint', d.lcp ? `${h.ms(d.lcp.time)} — ${d.lcp.element || ''}` : '—', 'lcp'),
      row('Cumulative layout shift', d.cls, 'cls'),
      row('First contentful paint', h.ms(d.fcp), 'fcp'),
      row('Time to first byte', h.ms(d.navigation?.ttfb), 'ttfb'),
      ['DOM interactive', h.ms(d.navigation?.domInteractive)],
      ['DOMContentLoaded', h.ms(d.navigation?.domContentLoaded)],
      ['Load', h.ms(d.navigation?.load)],
      ['Blocking time (LoAF)', `${h.ms(d.blockingTime)} over ${d.longAnimationFrames} frames`],
      ['Resources', d.resources],
      ['DOM elements', d.domElements],
      ['Protocol', d.navigation?.protocol],
    ])}
    ${d.renderBlocking.length ? h.sub('Render-blocking resources', h.list(d.renderBlocking)) : ''}
    ${d.navigation?.serverTiming?.length ? h.sub('Server-Timing', h.table(d.navigation.serverTiming, ['name', 'duration', 'description'])) : ''}
  `;
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
};
