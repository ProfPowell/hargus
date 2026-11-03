// Layout: breakage at the edges of the site's busiest breakpoints, and 100vw widths.
// Offline — compares the breakpoint-edge views measured during capture.

import { baseView, breakpointFindings, edgeOverflow, isBreakpointView, viewLabel } from '../core/views.js';

function run(reading, ctx) {
  const cap = reading.log._harplus?.capture || {};
  const views = cap.views || {};
  const css = ctx.results?.css?.status === 'ok' ? ctx.results.css.data || {} : null;
  const bps = cap.breakpoints || [];
  const bpSkip = (cap.viewsSkipped || []).find((s) => s.view === 'breakpoints');
  const bpSummary = bps.length ? bps.map((b) => `${b} px`).join(', ')
    : bpSkip ? String(bpSkip.reason || 'skipped') : cap.breakpoints === undefined ? 'not captured' : 'none detected';
  const edgeIds = Object.keys(views).filter(isBreakpointView);
  if (!edgeIds.length && !css) ctx.skip('no breakpoint views or CSS data in this reading');
  const baseId = baseView(reading);
  const baseM = views[baseId] || {};
  const findings = breakpointFindings(views, bps, baseM);
  const vw = Number(css?.vwRules) || 0;
  const shot = (reading.log._harplus?.screenshots || []).find((s) => s.kind === 'viewport' && (s.view || baseId) === baseId);
  const vh = Number(shot?.cssHeight) || 900;
  // A page that hides horizontal overflow on html or body can't scroll sideways, whatever its height.
  if (vw >= 1 && !baseM.rootClipX && (Number(baseM.cssHeight) || 0) > vh) {
    findings.push({ id: 'viewport-width-100vw', severity: 'low', category: 'quality', title: `${vw} rules use width: 100vw (adds horizontal scroll when a vertical scrollbar is present)` });
  }
  const pick = (v) => ({ overflowX: Number(v?.overflowX) || 0, clipped: Number(v?.clipped) || 0, overflowers: v?.overflowers || [], ...(v?.rootClipX ? { rootClipX: true } : {}), ...(v?.scrollsX === false ? { scrollsX: false } : {}) });
  return {
    data: { breakpoints: bps, views: Object.fromEntries(edgeIds.map((id) => [id, pick(views[id])])), vwRules: vw },
    findings,
    summary: [{ label: 'Breakpoints', headline: true, value: bpSummary }],
  };
}

function glance(r, h) {
  const ids = Object.keys(r.data.views);
  return ids.length ? h.html`<section class="card"><h4>Breakpoint edges</h4>${h.checklist(ids.map((id) => {
    const v = r.data.views[id];
    const over = edgeOverflow(v);
    return { label: viewLabel(id), ok: over === 0, note: over ? `${v.overflowers[0]?.selector || 'overflow'} +${over} px` : 'fits' };
  }))}</section>` : '';
}

/**
 * Answer first (breakpoints, edge views that fit, 100vw rules), then per edge view what the glance doesn't show:
 * clipped text and every element wider than the viewport (the glance names the first, with the overflow).
 */
function render(r, h) {
  const d = r.data;
  const ids = Object.keys(d.views);
  const bps = d.breakpoints || [];
  return h.html`
    ${h.stats([
      h.stat({ label: 'Breakpoints', value: bps.length, note: bps.length ? h.html`${bps.map((b, i) => h.html`${i ? ', ' : ''}${h.value(b, 'px')}`)}` : '' }),
      ids.length ? h.stat({ label: 'Edge views that fit', value: `${ids.filter((id) => edgeOverflow(d.views[id]) === 0).length} of ${ids.length}` }) : '',
      h.stat({ label: 'width: 100vw rules', value: Number(d.vwRules) || 0 }),
    ])}
    ${h.table(ids.map((id) => {
    const v = d.views[id];
    const wide = v.overflowers.map((o) => (Number.isFinite(Number(o.width)) ? `${o.selector} (${Math.round(o.width)} px)` : o.selector)).join(', ');
    const hidden = v.rootClipX ? '(hidden by html/body)' : '';
    return { view: viewLabel(id), clipped: String(v.clipped), culprits: [wide, hidden].filter(Boolean).join(' ') };
  }), [{ key: 'view', label: 'Width' }, { key: 'clipped', label: 'Clipped text' }, { key: 'culprits', label: 'Wider than the viewport' }])}
  `;
}

export default {
  id: 'layout',
  name: 'Layout',
  version: '0.1.0',
  phase: 'analyze',
  needs: ['views'],
  group: 'build',
  area: 'build',
  description: 'Layout breakage at the edges of the busiest CSS breakpoints, and 100vw widths.',
  tags: ['quality'],
  run,
  glance,
  render,
};
