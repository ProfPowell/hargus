// Resilience: how much of the page survives without JavaScript, CSS or images. Compares the
// measurements the capture took for each view (capture.views) — offline, so it re-runs and works
// in the CLI on any reading that has them.

import { compareViews, baseView, NOCSS_HIDDEN, ratingFor, VIEW_LABELS, VIEWS } from '../core/views.js';

const pct = (r) => `${Math.round(r * 100)}%`;

function run(reading, ctx) {
  const cmp = compareViews(reading.log._harplus?.capture?.views, baseView(reading));
  if (!cmp || Object.keys(cmp.views).length < 2) ctx.skip('no view measurements in this reading — take a new reading with views enabled');
  const { views } = cmp;
  const base = views[cmp.base];
  const findings = [];
  const summary = [];

  const js = views.nojs;
  if (js) {
    if (js.textRatio < 0.2) {
      findings.push({
        severity: js.noscript ? 'medium' : 'high', category: 'quality',
        title: 'Page shows almost no content without JavaScript',
        detail: `${pct(js.textRatio)} of the text is visible${js.noscript ? '; a <noscript> fallback exists' : ''}.`,
      });
    } else if (js.textRatio < 0.6) {
      findings.push({ severity: 'medium', category: 'quality', title: 'Much of the content needs JavaScript', detail: `${pct(js.textRatio)} of the text is visible without JavaScript.` });
    }
    if (base.links >= 5 && js.linkRatio < 0.5) {
      findings.push({ severity: 'medium', category: 'quality', title: 'Most links need JavaScript', detail: `${js.links} of ${base.links} links are visible without JavaScript.` });
    }
    summary.push({ label: 'Without JavaScript', value: `${pct(js.textRatio)} of text · ${pct(js.linkRatio)} of links`, rating: ratingFor(js.textRatio), headline: true });
  }
  const css = views.nocss;
  if (css) {
    if (css.textRatio > NOCSS_HIDDEN) {
      findings.push({ severity: 'info', category: 'quality', title: 'Hidden content appears without CSS', detail: 'Menus, screen-reader text or duplicated content become visible — check the reading order.' });
    }
    summary.push({ label: 'Without CSS', value: `${pct(css.textRatio)} of text` });
  }
  const img = views.noimages;
  if (img) summary.push({ label: 'Without images', value: `${img.imagesWithAlt} of ${img.images} images have alt text` });
  return { data: cmp, findings, summary };
}

const present = (r) => VIEWS.filter((id) => r.data?.views?.[id]);
const RESILIENT = new Set(['nojs', 'nocss', 'noimages']);

function glance(r, h) {
  const rows = (key) => present(r).map((id) => ({
    label: VIEW_LABELS[id], value: Math.round(r.data.views[id][key] * 100), display: pct(r.data.views[id][key]),
    color: RESILIENT.has(id) ? 'var(--c2)' : 'var(--c1)',
  }));
  return h.html`<section class="card"><h4>Visible text vs. ${VIEW_LABELS[r.data.base]}</h4>${h.hbars({ rows: rows('textRatio'), label: 'Visible text per view' })}
    <h4>Visible links</h4>${h.hbars({ rows: rows('linkRatio'), label: 'Visible links per view' })}</section>`;
}

function render(r, h) {
  return h.table(present(r).map((id) => {
    const v = r.data.views[id];
    return { view: VIEW_LABELS[id], text: `${v.text} (${pct(v.textRatio)})`, links: `${v.links} (${pct(v.linkRatio)})`, images: `${v.imagesWithAlt}/${v.images} with alt`, size: `${v.cssWidth}×${v.cssHeight}` };
  }), [
    { key: 'view', label: 'View' }, { key: 'text', label: 'Visible text' }, { key: 'links', label: 'Links' },
    { key: 'images', label: 'Images' }, { key: 'size', label: 'Viewport × page height' },
  ]);
}

export default {
  id: 'resilience',
  name: 'Resilience',
  version: '0.1.0',
  phase: 'analyze',
  group: 'build',
  description: 'How much of the page survives without JavaScript, CSS or images, from the views measured during capture.',
  tags: ['quality', 'progressive-enhancement'],
  run,
  render,
  glance,
};
