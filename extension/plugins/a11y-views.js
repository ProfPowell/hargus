// Accessibility views: findings from the display-preference, print and WCAG views measured during
// capture (capture.views), compared against the base view. Offline — works in the CLI on any reading
// that has them.

import { baseView, VIEW_LABELS, DISPLAY_VIEWS, WCAG_VIEWS } from '../core/views.js';

const MEASURED = [...DISPLAY_VIEWS, ...WCAG_VIEWS];
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const has = (v) => Number.isFinite(Number(v)) && v !== null && v !== undefined;

function run(reading, ctx) {
  const cap = reading.log._harplus?.capture || {};
  const views = cap.views || {};
  const baseId = baseView(reading);
  const base = views[baseId];
  const present = MEASURED.filter((id) => views[id]);
  if (!base || !present.length) ctx.skip('no accessibility views in this reading — take a new reading');
  const prefs = cap.prefs || {};
  const css = ctx.results?.css?.status === 'ok' ? ctx.results.css.data || {} : {};
  const feature = (name) => !!(prefs.mediaFeatures?.[name] || css.mediaFeatures?.[name]);
  const printStyles = !!prefs.mediaPrint || Object.keys(css.media || {}).some((k) => /\bprint\b/i.test(k));
  const findings = [];
  const summary = [];
  const checks = [];
  const add = (severity, title, detail, category = 'accessibility') => findings.push({ severity, category, title, ...(detail ? { detail } : {}) });
  const extraClipped = (v) => num(v.clipped) - num(base.clipped);
  const newOverflow = (v) => num(v.overflowX) > num(base.overflowX);

  const reflow = views.reflow;
  if (reflow) {
    const over = num(reflow.overflowX);
    const extra = extraClipped(reflow);
    if (over > 0) add('medium', 'Page scrolls horizontally at 320 px (WCAG 1.4.10)', `Content is ${over} px wider than a 320 px viewport.`);
    if (extra >= 3) add('medium', `${extra} more text boxes clip at 320 px (WCAG 1.4.10)`);
    const ok = over === 0 && extra < 3;
    summary.push({ label: 'Reflow 320 px', value: ok ? 'fits' : [over ? `${over} px overflow` : '', extra >= 3 ? `${extra} more clipped` : ''].filter(Boolean).join(' · '), rating: ok ? 'good' : 'poor' });
    checks.push({ id: 'reflow', ok });
  }

  const spacing = views.spacing;
  if (spacing) {
    const extra = extraClipped(spacing);
    const bad = extra >= 3 || newOverflow(spacing);
    if (bad) add('medium', 'Text clips with WCAG text spacing (1.4.12)', `${Math.max(0, extra)} more clipped text boxes; ${num(spacing.overflowX)} px horizontal overflow.`);
    summary.push({ label: 'Text spacing', value: bad ? `${Math.max(0, extra)} more clipped` : 'ok', rating: bad ? 'poor' : 'good' });
    checks.push({ id: 'spacing', ok: !bad });
  }

  const big = views.text200;
  if (big && has(big.bodyFont) && has(base.bodyFont) && num(base.bodyFont) > 0) {
    const grew = num(big.bodyFont) > num(base.bodyFont);
    const clips = extraClipped(big) >= 3 || newOverflow(big);
    if (!grew) add('low', 'Text ignores the browser\'s font-size setting', `Body text stays ${num(big.bodyFont)} px when the default font size doubles.`);
    else if (clips) add('medium', 'Text clips at 200% size (WCAG 1.4.4)', `${Math.max(0, extraClipped(big))} more clipped text boxes; ${num(big.overflowX)} px horizontal overflow.`);
    summary.push({ label: '200% text', value: `${num(base.bodyFont)} → ${num(big.bodyFont)} px`, rating: !grew ? 'needs-improvement' : clips ? 'poor' : 'good' });
    checks.push({ id: 'text200', ok: grew && !clips });
  }

  const dark = views.dark;
  if (dark && has(dark.bg) && has(base.bg)) {
    const same = Math.abs(num(dark.bg) - num(base.bg)) < 0.1;
    if (same && !feature('prefers-color-scheme')) add('info', 'No dark mode');
    if (same && /\bdark\b/i.test(prefs.colorScheme || '')) add('low', 'Declares dark color-scheme but stays light');
    summary.push({ label: 'Dark mode', value: same ? 'no change' : 'changes' });
    checks.push({ id: 'dark', ok: !same });
  }

  const forced = views.forced;
  if (forced) {
    const optOut = num(forced.forcedNone);
    const icons = num(forced.iconOnly);
    if (optOut >= 20) add('low', `${optOut} elements opt out of forced colours`);
    if (icons >= 1) {
      add('low', `${icons} icon-only controls may vanish in forced colours`,
        'Forced colours replace the page\'s colours but not image content, so a background-image icon can disappear against the system background. Use an SVG with currentColor, or visible text.');
    }
    checks.push({ id: 'forced', ok: optOut < 20 && icons === 0 });
  }

  if (views.morecontrast) {
    const styled = feature('prefers-contrast');
    if (!styled) add('info', 'No high-contrast styles');
    checks.push({ id: 'morecontrast', ok: styled });
  }

  const print = views.print;
  if (print) {
    const issues = [];
    if (print.chrome) { add('low', 'Navigation and site chrome still print', undefined, 'content'); issues.push('site chrome'); }
    const overlays = Array.isArray(print.fixed) ? print.fixed.length : 0;
    if (overlays >= 1) { add('low', `${overlays} fixed or sticky overlays print over content`, undefined, 'content'); issues.push(`${overlays} overlays`); }
    if (!printStyles) { add('info', 'No print styles', undefined, 'content'); issues.push('no print styles'); }
    summary.push({ label: 'Print', value: issues.length ? issues.join(', ') : 'clean', rating: issues.length ? 'needs-improvement' : 'good' });
    checks.push({ id: 'print', ok: !issues.length });
  }

  return {
    data: { base: baseId, views: Object.fromEntries([[baseId, base], ...present.map((id) => [id, views[id]])]), prefs, printStyles, checks },
    findings,
    summary,
  };
}

function glance(r, h) {
  return h.html`<section class="card"><h4>Accessibility views</h4>${h.checklist((r.data.checks || []).map((c) => ({ label: VIEW_LABELS[c.id], ok: c.ok })))}</section>`;
}

function render(r, h) {
  const rows = Object.entries(r.data.views).map(([id, v]) => ({
    view: VIEW_LABELS[id] || id,
    overflow: `${num(v.overflowX)} px`,
    clipped: String(num(v.clipped)),
    font: has(v.bodyFont) ? `${num(v.bodyFont)} px` : '—',
    bg: has(v.bg) ? num(v.bg).toFixed(2) : '—',
    fixed: String(Array.isArray(v.fixed) ? v.fixed.length : 0),
    chrome: v.chrome ? 'yes' : 'no',
  }));
  return h.table(rows, [
    { key: 'view', label: 'View' }, { key: 'overflow', label: 'Overflow' }, { key: 'clipped', label: 'Clipped' },
    { key: 'font', label: 'Body font' }, { key: 'bg', label: 'Background luminance' }, { key: 'fixed', label: 'Fixed overlays' },
    { key: 'chrome', label: 'Site chrome' },
  ]);
}

export default {
  id: 'a11y-views',
  name: 'Accessibility views',
  version: '0.1.0',
  phase: 'analyze',
  group: 'quality',
  area: 'accessibility',
  after: ['css'],
  description: 'Reflow, text spacing, 200% text, dark mode, forced colours, contrast preference and print, from the views measured during capture.',
  tags: ['accessibility'],
  run,
  glance,
  render,
};
