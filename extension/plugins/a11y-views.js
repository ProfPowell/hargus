// Accessibility views: findings from the display-preference, print and WCAG views measured during
// capture (capture.views), compared against the base view. Offline — works in the CLI on any reading
// that has them.

import {
  baseView, VIEW_LABELS, DISPLAY_VIEWS, WCAG_VIEWS, A11Y_VIEWS, A11Y_CLIP_EXTRA, A11Y_MIN_OVERFLOW, A11Y_FORCED_OPT_OUTS, extraClipped as clippedBeyond, reflowScroll, darkState, failedChecks,
} from '../core/views.js';

const MEASURED = [...DISPLAY_VIEWS, ...WCAG_VIEWS];
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const has = (v) => Number.isFinite(Number(v)) && v !== null && v !== undefined;

/** The widest elements past the 320 px edge (capture keeps up to 5): where the sideways scroll comes from. */
// Older readings have no `over`: then the note gives the width alone.
const overflowPlaces = (list) => (Array.isArray(list) ? list : []).filter((o) => o?.selector)
  .map((o) => ({ selector: String(o.selector), note: `${num(o.width)} px wide${has(o.over) ? `, ${num(o.over)} px past the ${o.side === 'left' ? 'left' : 'right'} edge` : ''}` }));

function run(reading, ctx) {
  const cap = reading.log._harplus?.capture || {};
  // Vision ids are noted when their check fails, but no measurements are taken from them.
  const unverified = failedChecks(reading).filter(([id]) => A11Y_VIEWS.includes(id));
  const views = Object.fromEntries(Object.entries(cap.views || {}).filter(([id]) => !unverified.some(([bad]) => bad === id)));
  const baseId = baseView(reading);
  const base = views[baseId];
  const present = MEASURED.filter((id) => views[id]);
  if (!base || (!present.length && !unverified.length)) ctx.skip('no accessibility views in this reading — take a new reading');
  const prefs = cap.prefs || {};
  const cssOk = ctx.results?.css?.status === 'ok';
  const css = cssOk ? ctx.results.css.data || {} : {};
  // Cross-origin sheets the probe could not read, and no css plugin result that did: absence is not proven.
  const unread = num(prefs.unreadableSheets) > 0 && !cssOk ? 'Some stylesheets could not be read; styles for this preference may exist in them.' : undefined;
  const feature = (name) => !!(prefs.mediaFeatures?.[name] || css.mediaFeatures?.[name]);
  const printStyles = !!prefs.mediaPrint || Object.keys(css.media || {}).some((k) => /\bprint\b/i.test(k));
  const findings = [];
  const summary = [];
  const checks = [];
  const add = (id, severity, title, detail, category = 'accessibility', places) => findings.push({ id, severity, category, title, ...(detail ? { detail } : {}), ...(places?.length ? { places } : {}) });
  for (const [id, c] of unverified) add('views-unverified', 'info', `${VIEW_LABELS[id] || id} view could not be verified — ${c.detail}`);
  const extraClipped = (v) => clippedBeyond(v, base);
  const newOverflow = (v) => num(v.overflowX) > num(base.overflowX);

  const reflow = views.reflow;
  if (reflow) {
    const over = reflowScroll(reflow, base);
    const extra = extraClipped(reflow);
    // scrollsX is false when the page could not actually be scrolled sideways (stale width); undefined on older readings.
    const scrolls = over > 0 && reflow.scrollsX !== false;
    if (scrolls) {
      const own = num(base.overflowX);
      const o = (reflow.overflowers || [])[0];
      const none = !o && Array.isArray(reflow.overflowers) && !reflow.overflowTruncated;
      const lead = o ? `${o.selector} is ${o.width} px wide in a 320 px view. `
        : none ? 'No single element was found wider than the viewport; the extra width may come from margins or transforms. ' : '';
      add('reflow-scroll', 'medium', 'Page scrolls horizontally at 320 px (WCAG 1.4.10)',
        `${lead}Content is ${over} px wider than a 320 px viewport${own ? `, beyond the ${own} px the ${VIEW_LABELS[baseId] || baseId} view already overflows` : ''}.`,
        'accessibility', overflowPlaces(reflow.overflowers));
    }
    if (extra >= A11Y_CLIP_EXTRA) add('reflow-clip', 'medium', `${extra} more text boxes clip at 320 px (WCAG 1.4.10)`);
    const ok = !scrolls && extra < A11Y_CLIP_EXTRA;
    summary.push({ label: 'Reflow 320 px', value: ok ? 'fits' : [scrolls ? `${over} px overflow` : '', extra >= A11Y_CLIP_EXTRA ? `${extra} more clipped` : ''].filter(Boolean).join(' · '), rating: ok ? 'good' : 'poor' });
    checks.push({ id: 'reflow', ok });
  }

  const spacing = views.spacing;
  if (spacing) {
    const extra = extraClipped(spacing);
    const clips = extra >= A11Y_CLIP_EXTRA;
    const grew = num(spacing.overflowX) - num(base.overflowX);
    const scrolls = !clips && grew >= A11Y_MIN_OVERFLOW && spacing.scrollsX !== false;
    if (clips) add('spacing-clip', 'medium', 'Text clips with WCAG text spacing (1.4.12)', `${extra} more clipped text boxes.`);
    else if (scrolls) add('spacing-scroll', 'low', 'Page scrolls sideways with WCAG text spacing', `Content is ${num(spacing.overflowX)} px wider than the viewport.`);
    summary.push({ label: 'Text spacing', value: clips ? `${extra} more clipped` : scrolls ? `${num(spacing.overflowX)} px overflow` : 'ok', rating: clips ? 'poor' : scrolls ? 'needs-improvement' : 'good' });
    checks.push({ id: 'spacing', ok: !clips });
  }

  const big = views.text200;
  if (big && has(big.bodyFont) && has(base.bodyFont) && num(base.bodyFont) > 0) {
    const grew = num(big.bodyFont) > num(base.bodyFont);
    const extraBig = extraClipped(big);
    const clips = extraBig >= A11Y_CLIP_EXTRA;
    const scrolls = !clips && newOverflow(big) && big.scrollsX !== false;
    if (!grew) add('text200-ignored', 'low', 'Text ignores the browser\'s font-size setting', `Body text stays ${num(big.bodyFont)} px when the default font size doubles.`);
    else if (clips) add('text200-clip', 'medium', 'Text clips at 200% size (WCAG 1.4.4)', `${extraBig} more clipped text boxes.`);
    else if (scrolls) add('text200-scroll', 'low', 'Page scrolls sideways at 200% text size', `Content is ${num(big.overflowX)} px wider than the viewport.`);
    summary.push({ label: '200% text', value: `${num(base.bodyFont)} → ${num(big.bodyFont)} px`, rating: !grew || scrolls ? 'needs-improvement' : clips ? 'poor' : 'good' });
    checks.push({ id: 'text200', ok: grew && !clips });
  }

  const dark = views.dark;
  const state = dark && darkState(dark, base);
  if (state) {
    // Only a page that still looks light in dark mode lacks one; an already-dark page needs none.
    const light = state === 'no change';
    if (light && !feature('prefers-color-scheme')) add('dark-none', 'info', 'No dark mode', unread);
    if (light && /\bdark\b/i.test(prefs.colorScheme || '')) add('dark-light', 'low', 'Declares dark color-scheme but stays light');
    summary.push({ label: 'Dark mode', value: state });
    checks.push({ id: 'dark', ok: !light });
  }

  const forced = views.forced;
  if (forced) {
    const optOut = num(forced.forcedNone);
    const icons = num(forced.iconOnly);
    if (optOut >= A11Y_FORCED_OPT_OUTS) add('forced-optout', 'low', `${optOut} elements opt out of forced colours`);
    if (icons >= 1) {
      add('forced-icons', 'low', `${icons} icon-only controls may vanish in forced colours`,
        'Forced colours replace the page\'s colours but not image content, so a background-image icon can disappear against the system background. Use an SVG with currentColor, or visible text.');
    }
    checks.push({ id: 'forced', ok: optOut < A11Y_FORCED_OPT_OUTS && icons === 0 });
  }

  if (views.morecontrast) {
    const styled = feature('prefers-contrast');
    if (!styled) add('morecontrast-none', 'info', 'No high-contrast styles', unread);
    checks.push({ id: 'morecontrast', ok: styled });
  }

  const print = views.print;
  if (print) {
    const issues = [];
    if (print.chrome) { add('print-chrome', 'low', 'Navigation and site chrome still print', undefined, 'content'); issues.push('site chrome'); }
    const overlays = Array.isArray(print.fixed) ? print.fixed.length : 0;
    if (overlays >= 1) { add('print-overlays', 'low', `${overlays} fixed or sticky overlays print over content`, undefined, 'content'); issues.push(`${overlays} overlays`); }
    if (!printStyles) { add('print-none', 'info', 'No print styles', unread, 'content'); issues.push('no print styles'); }
    summary.push({ label: 'Print', value: issues.length ? issues.join(', ') : 'clean', rating: issues.length ? 'needs-improvement' : 'good' });
    checks.push({ id: 'print', ok: !issues.length });
  }

  if (checks.length) {
    const passed = checks.filter((c) => c.ok).length;
    summary.unshift({ label: 'Views', value: `${passed} of ${checks.length} pass`, headline: true, rating: passed === checks.length ? 'good' : 'needs-improvement' });
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

/** Answer first (views passed), then each view's raw measurements; which check passed is the glance's checklist. */
function render(r, h) {
  const checks = r.data.checks || [];
  const failed = checks.filter((c) => !c.ok).map((c) => VIEW_LABELS[c.id] || c.id);
  const answer = checks.length ? h.stats([
    h.stat({ label: 'Views pass', value: `${checks.length - failed.length} of ${checks.length}` }),
    // Each view name stays on one line ("Zoom 200%" must not break); the list may wrap between names.
    failed.length ? h.stat({ label: 'Fail', value: h.html`${failed.map((f, i) => h.html`${i ? ', ' : ''}${h.value(f)}`)}` }) : '',
  ]) : '';
  const rows = Object.entries(r.data.views).map(([id, v]) => ({
    view: VIEW_LABELS[id] || id,
    overflow: h.value(num(v.overflowX), 'px'),
    clipped: String(num(v.clipped)),
    font: has(v.bodyFont) ? h.value(num(v.bodyFont), 'px') : '—',
    bg: has(v.bg) ? num(v.bg).toFixed(2) : '—',
    fixed: String(Array.isArray(v.fixed) ? v.fixed.length : 0),
    chrome: v.chrome ? 'yes' : 'no',
  }));
  return h.html`${answer}${h.table(rows, [
    { key: 'view', label: 'View' }, { key: 'overflow', label: 'Overflow' }, { key: 'clipped', label: 'Clipped' },
    { key: 'font', label: 'Body font' }, { key: 'bg', label: 'Background luminance' }, { key: 'fixed', label: 'Fixed overlays' },
    { key: 'chrome', label: 'Site chrome' },
  ])}`;
}

export default {
  id: 'a11y-views',
  name: 'Accessibility views',
  version: '0.1.0',
  phase: 'analyze',
  needs: ['views'],
  group: 'quality',
  area: 'accessibility',
  after: ['css'],
  description: 'Reflow, text spacing, 200% text, dark mode, forced colours, contrast preference and print, from the views measured during capture.',
  tags: ['accessibility'],
  run,
  glance,
  render,
};
