// Resilience: how much of the page survives without JavaScript, CSS or images. Compares the
// measurements the capture took for each view (capture.views) — offline, so it re-runs and works
// in the CLI on any reading that has them.

import { compareViews, baseView, NOCSS_HIDDEN, ratingFor, VIEW_LABELS, LAYOUT_VIEWS, failedChecks } from '../core/views.js';
import { TRANSLATED_VIEWS } from '../core/translation.js';

const RESILIENT = new Set(['nojs', 'nocss', 'noimages']);
const TRANSLATED = new Set(TRANSLATED_VIEWS.map((t) => t.id));
const pct = (r) => `${Math.round(r * 100)}%`;

// The no-JS thresholds the findings use; render() checks against the same numbers.
export const NOJS_ALMOST_NONE = 0.2; // text share below this: "almost no content"
export const NOJS_TEXT_OK = 0.6; // text share below this: "much of the content needs JavaScript"
export const NOJS_LINKS_OK = 0.5; // link share below this: "most links need JavaScript"
export const NOJS_MIN_LINKS = 5; // fewer links on the base view: too few to judge

function run(reading, ctx) {
  const unverified = failedChecks(reading).filter(([id]) => RESILIENT.has(id));
  const bad = new Set(unverified.map(([id]) => id));
  const measured = Object.fromEntries(Object.entries(reading.log._harplus?.capture?.views || {}).filter(([id]) => !bad.has(id)));
  const cmp = compareViews(measured, baseView(reading));
  const findings = [];
  const summary = [];
  for (const [id, c] of unverified) findings.push({ id: 'view-unverified', subject: id, severity: 'info', category: 'quality', title: `${VIEW_LABELS[id] || id} view could not be verified — ${c.detail}`, detail: 'Its measurements may not reflect the setting, so they are not used.' });
  if (!cmp || Object.keys(cmp.views).length < 2) {
    if (!unverified.length) ctx.skip('no view measurements in this reading — take a new reading with views enabled');
    return { data: { base: baseView(reading), views: {} }, findings, summary };
  }
  const { views } = cmp;
  const base = views[cmp.base];

  const js = views.nojs;
  if (js) {
    if (js.textRatio < NOJS_ALMOST_NONE) {
      findings.push({
        id: 'nojs-almost-no-content', severity: js.noscript ? 'medium' : 'high', category: 'quality',
        title: 'Page shows almost no content without JavaScript',
        detail: `${pct(js.textRatio)} of the text is visible${js.noscript ? '; a <noscript> fallback exists' : ''}.`,
      });
    } else if (js.textRatio < NOJS_TEXT_OK) {
      findings.push({ id: 'nojs-partial-content', severity: 'medium', category: 'quality', title: 'Much of the content needs JavaScript', detail: `${pct(js.textRatio)} of the text is visible without JavaScript.` });
    }
    if (base.links >= NOJS_MIN_LINKS && js.linkRatio < NOJS_LINKS_OK) {
      findings.push({ id: 'nojs-links-missing', severity: 'medium', category: 'quality', title: 'Most links need JavaScript', detail: `${js.links} of ${base.links} links are visible without JavaScript.` });
    }
    summary.push({ label: 'Without JavaScript', value: `${pct(js.textRatio)} of text · ${pct(js.linkRatio)} of links`, rating: ratingFor(js.textRatio), headline: true });
  }
  const css = views.nocss;
  if (css) {
    if (css.textRatio > NOCSS_HIDDEN) {
      findings.push({ id: 'nocss-hidden-content', severity: 'info', category: 'quality', title: 'Hidden content appears without CSS', detail: 'Menus, screen-reader text or duplicated content become visible — check the reading order.' });
    }
    summary.push({ label: 'Without CSS', value: `${pct(css.textRatio)} of text` });
  }
  const img = views.noimages;
  if (img) summary.push({ label: 'Without images', value: `${img.imagesWithAlt} of ${img.images} images have alt text` });
  // Without a no-JS view the first row stands for the check (labels make "Without CSS 92% of text" read on its own).
  if (summary.length && !summary.some((s) => s.headline)) summary[0].headline = true;
  return { data: cmp, findings, summary };
}

// Translated views change the text itself (German is longer, Japanese shorter): their text counts say nothing about resilience.
const present = (r) => LAYOUT_VIEWS.filter((id) => !TRANSLATED.has(id) && r.data?.views?.[id]);

function glance(r, h) {
  const rows = (key) => present(r).map((id) => ({
    // One colour: the row label already names the view, and a second colour with no word for it would mean nothing.
    label: VIEW_LABELS[id], value: Math.round(r.data.views[id][key] * 100), display: pct(r.data.views[id][key]),
  }));
  return h.html`<section class="card"><h4>Visible text vs. ${VIEW_LABELS[r.data.base]}</h4>${h.hbars({ rows: rows('textRatio'), label: 'Visible text per view' })}
    <h4>Visible links</h4>${h.hbars({ rows: rows('linkRatio'), label: 'Visible links per view' })}</section>`;
}

/**
 * Answer first: pass / fail per view, at the thresholds the findings use. Then the measured counts per view;
 * the glance has the same views as percentages of the base, so the table shows counts only.
 */
function render(r, h) {
  const views = r.data?.views || {};
  const base = views[r.data?.base];
  const js = views.nojs;
  const css = views.nocss;
  // No alt-text check: it has no finding here, and alt text's home is the Accessibility area.
  const items = [];
  if (js) {
    items.push({ label: 'Content shows without JavaScript', ok: js.textRatio >= NOJS_TEXT_OK, note: `${pct(js.textRatio)} of text` });
    // The links finding needs NOJS_MIN_LINKS links on the base view to judge.
    items.push({ label: 'Links show without JavaScript', ok: base?.links >= NOJS_MIN_LINKS ? js.linkRatio >= NOJS_LINKS_OK : undefined, note: base?.links >= NOJS_MIN_LINKS ? `${js.links} of ${base.links}` : 'too few links to judge' });
  }
  if (css) items.push({ label: 'No hidden content appears without CSS', ok: css.textRatio <= NOCSS_HIDDEN, note: `${pct(css.textRatio)} of text` });
  return h.html`${h.checks(items)}
  ${h.table(present(r).map((id) => {
    const v = views[id];
    return { view: VIEW_LABELS[id], text: v.text, links: v.links, images: `${v.imagesWithAlt} of ${v.images}`, size: v.cssWidth && v.cssHeight ? `${v.cssWidth}×${v.cssHeight}` : '' };
  }), [
    { key: 'view', label: 'View' }, { key: 'text', label: 'Visible text' }, { key: 'links', label: 'Links' },
    { key: 'images', label: 'Images with alt' }, { key: 'size', label: 'Viewport × page height' },
  ])}`;
}

export default {
  id: 'resilience',
  name: 'Resilience',
  version: '0.1.0',
  phase: 'analyze',
  needs: ['views'],
  group: 'build',
  description: 'How much of the page survives without JavaScript, CSS or images, from the views measured during capture.',
  tags: ['quality', 'progressive-enhancement'],
  run,
  render,
  glance,
};
