// Layout: breakage at the edges of the site's busiest breakpoints, and 100vw widths.
// Offline — compares the breakpoint-edge views measured during capture.

import { baseView, breakpointFindings, isBreakpointView, viewLabel } from '../core/views.js';

function run(reading, ctx) {
  const cap = reading.log._harplus?.capture || {};
  const views = cap.views || {};
  const css = ctx.results?.css?.status === 'ok' ? ctx.results.css.data || {} : null;
  const bps = cap.breakpoints || [];
  const edgeIds = Object.keys(views).filter(isBreakpointView);
  if (!edgeIds.length && !css) ctx.skip('no breakpoint views or CSS data in this reading');
  const baseId = baseView(reading);
  const baseM = views[baseId] || {};
  const findings = breakpointFindings(views, bps, baseM);
  const vw = Number(css?.vwRules) || 0;
  const shot = (reading.log._harplus?.screenshots || []).find((s) => s.kind === 'viewport' && (s.view || baseId) === baseId);
  const vh = Number(shot?.cssHeight) || 900;
  if (vw >= 1 && (Number(baseM.cssHeight) || 0) > vh) {
    findings.push({ severity: 'low', category: 'quality', title: `${vw} rules use width: 100vw (adds horizontal scroll when a vertical scrollbar is present)` });
  }
  const pick = (v) => ({ overflowX: Number(v?.overflowX) || 0, clipped: Number(v?.clipped) || 0, overflowers: v?.overflowers || [] });
  return {
    data: { breakpoints: bps, views: Object.fromEntries(edgeIds.map((id) => [id, pick(views[id])])), vwRules: vw },
    findings,
    summary: [{ label: 'Breakpoints', value: bps.length ? bps.map((b) => `${b} px`).join(', ') : 'none detected' }],
  };
}

function glance(r, h) {
  const ids = Object.keys(r.data.views);
  return ids.length ? h.html`<section class="card"><h4>Breakpoint edges</h4>${h.checklist(ids.map((id) => {
    const v = r.data.views[id];
    return { label: viewLabel(id), ok: v.overflowX === 0, note: v.overflowX ? `${v.overflowers[0]?.selector || 'overflow'} +${v.overflowX} px` : 'fits' };
  }))}</section>` : '';
}

function render(r, h) {
  return h.table(Object.entries(r.data.views).map(([id, v]) => ({
    view: viewLabel(id), overflow: `${v.overflowX} px`, clipped: String(v.clipped), culprits: v.overflowers.map((o) => `${o.selector} (${o.width} px)`).join(', '),
  })), [{ key: 'view', label: 'Width' }, { key: 'overflow', label: 'Overflow' }, { key: 'clipped', label: 'Clipped' }, { key: 'culprits', label: 'Wider than the viewport' }]);
}

export default {
  id: 'layout',
  name: 'Layout',
  version: '0.1.0',
  phase: 'analyze',
  group: 'build',
  area: 'build',
  description: 'Layout breakage at the edges of the busiest CSS breakpoints, and 100vw widths.',
  tags: ['quality'],
  run,
  glance,
  render,
};
