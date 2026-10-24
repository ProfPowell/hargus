// Dependency-free accessibility smoke checks. Catches the common, mechanical failures.
// Not a WCAG audit: the axe plugin does that, and where its rules cover the same problem these findings yield to it.

import { suppressedBy } from '../core/a11y-overlap.js';

function collect() {
  const $$ = (s) => [...document.querySelectorAll(s)];
  const visible = (el) => {
    if (el.closest('[hidden],[aria-hidden="true"]')) return false;
    // A display:contents element has no box of its own: it is as visible as its parent.
    if (getComputedStyle(el).display === 'contents') return el.parentElement ? visible(el.parentElement) : true;
    // checkVisibility covers display:none and visibility:hidden on any ancestor.
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      let p = n.localName;
      if (n.id) { parts.unshift(`${p}#${n.id}`); break; }
      if (n.classList.length) p += `.${[...n.classList].slice(0, 2).join('.')}`;
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const snippet = (el) => String(el?.outerHTML || '').replace(/\s+/g, ' ').slice(0, 160);
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const byIds = (ids) => (ids || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean);
  const name = (el) => text(el) || el.getAttribute('aria-label')?.trim() ||
    byIds(el.getAttribute('aria-labelledby')).map(text).join(' ') || el.getAttribute('title')?.trim() ||
    [...el.querySelectorAll('img[alt], svg title, [role="img"][aria-label], svg[aria-label], [aria-labelledby]')]
      // Hidden descendants don't name the control; an SVG <title> is never rendered, so it is exempt.
      .filter((i) => !i.closest('[aria-hidden="true"]') && (i.matches('svg title') || i.checkVisibility?.({ visibilityProperty: true }) !== false))
      .map((i) => (i.hasAttribute('aria-labelledby') && byIds(i.getAttribute('aria-labelledby')).map(text).join(' ').trim()) ||
        (i.getAttribute('alt') ?? i.getAttribute('aria-label') ?? (i.hasAttribute('aria-labelledby') ? '' : i.textContent)))
      .join(' ').trim() ||
    el.getAttribute('value')?.trim() || '';

  const rules = [];
  const errors = [];
  // Each check is isolated: a surprise in one page's markup must not sink the others.
  const check = (id, impact, help, find) => {
    try {
      const els = find().filter(Boolean);
      if (els.length) rules.push({ id, impact, help, count: els.length, samples: els.slice(0, 5).map((e) => ({ selector: path(e), html: snippet(e) })) });
    } catch (e) {
      errors.push(`${id}: ${e.message}`);
    }
  };
  const flag = (id, impact, help, when, samples = []) => {
    try { if (when()) rules.push({ id, impact, help, count: 1, samples }); } catch (e) { errors.push(`${id}: ${e.message}`); }
  };

  flag('html-lang', 'serious', '<html> has no lang attribute', () => !document.documentElement.getAttribute('lang')?.trim());
  flag('document-title', 'serious', 'Document has no <title>', () => !document.title.trim());

  check('image-alt', 'critical', 'Images without an alt attribute',
    () => $$('img:not([alt])').filter((i) => !/presentation|none/.test(i.getAttribute('role') || '') && visible(i)));
  check('input-label', 'critical', 'Form fields without a label', () => $$('input, select, textarea').filter((el) => {
    if (/^(hidden|submit|button|image|reset)$/i.test(el.type) || !visible(el)) return false;
    const labelled = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label') ||
      el.getAttribute('aria-label')?.trim() || byIds(el.getAttribute('aria-labelledby')).length || el.getAttribute('title')?.trim();
    return !labelled;
  }));
  check('button-name', 'critical', 'Buttons without an accessible name',
    () => $$('button, [role="button"], input[type="button" i], input[type="submit" i]').filter((b) => visible(b) && !name(b)));
  check('link-name', 'serious', 'Links without an accessible name', () => $$('a[href]').filter((a) => visible(a) && !name(a)));
  check('frame-title', 'serious', 'Iframes without a title',
    () => $$('iframe').filter((f) => visible(f) && !f.title?.trim() && !f.getAttribute('aria-label')));

  const vp = document.querySelector('meta[name="viewport" i]')?.content || '';
  const maxScale = Number((vp.match(/maximum-scale\s*=\s*([\d.]+)/i) || [])[1]);
  flag('meta-viewport', 'serious', 'Viewport meta disables or limits zoom',
    () => /user-scalable\s*=\s*(no|0)/i.test(vp) || (maxScale && maxScale < 2), [{ selector: 'meta[name=viewport]', html: vp }]);

  check('duplicate-id', 'minor', 'Duplicate id values', () => {
    const seen = new Map();
    for (const el of $$('[id]')) {
      const id = el.id.trim();
      if (!id) continue; // id="" is invalid but not a duplicate
      if (seen.has(id)) seen.get(id).push(el); else seen.set(id, [el]);
    }
    return [...seen.values()].filter((els) => els.length > 1).map((els) => els[1]);
  });
  check('tabindex', 'serious', 'Positive tabindex values (break focus order)', () => $$('[tabindex]').filter((e) => Number(e.getAttribute('tabindex')) > 0));
  check('autoplay-audio', 'moderate', 'Media that autoplays with sound', () => $$('video[autoplay]:not([muted]), audio[autoplay]:not([muted])'));
  check('focusable-hidden', 'serious', 'Focusable elements inside aria-hidden',
    () => $$('[aria-hidden="true"] :is(a[href], area[href], button, input, select, textarea, summary, iframe, [contenteditable=""], [contenteditable="true"], [tabindex])').filter((el) => {
      const ti = el.getAttribute('tabindex');
      if (ti !== null && ti.trim() !== '' && Number(ti) < 0) return false;
      if (el.matches(':disabled, input[type="hidden" i]') || el.closest('[inert]')) return false;
      if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
      return el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
    }));

  return {
    rules,
    errors,
    stats: {
      images: $$('img').length,
      formFields: $$('input, select, textarea').length,
      links: $$('a[href]').length,
      buttons: $$('button, [role="button"]').length,
      landmarks: $$('main, nav, header, footer, aside, [role="main"], [role="navigation"], [role="banner"], [role="contentinfo"]').length,
      skipLink: $$('a[href^="#"]').slice(0, 3).some((a) => /skip|jump to/i.test(a.textContent)),
    },
  };
}

const SEVERITY = { critical: 'high', serious: 'medium', moderate: 'low', minor: 'info' };

function run(reading, ctx) {
  const c = ctx.collected;
  if (!c) ctx.skip('no page data');
  const findings = c.rules.filter((r) => !suppressedBy('a11y-basics', r.id, ctx.results?.axe)).map((r) => ({
    id: r.id,
    severity: SEVERITY[r.impact] || 'low',
    category: 'accessibility',
    title: `${r.help}${r.count > 1 ? ` (${r.count})` : ''}`,
    evidence: r.samples.map((s) => s.selector).join('\n') || undefined,
  }));
  const total = c.rules.reduce((n, r) => n + r.count, 0);
  return {
    data: c,
    findings,
    summary: [
      { label: 'Issues', headline: true, value: total ? `${total} across ${c.rules.length} checks` : 'none found by basic checks' },
      { label: 'Landmarks', value: c.stats.landmarks },
      { label: 'Skip link', value: c.stats.skipLink ? 'yes' : 'no' },
    ],
  };
}

function render(r, h) {
  const rows = r.data.rules.map((x) => ({
    rule: x.id, impact: x.impact, count: x.count, help: x.help,
    samples: h.list(x.samples.map((s) => h.html`<code>${s.selector}</code>`)),
  }));
  return h.html`
    ${rows.length ? h.table(rows, ['impact', 'rule', 'count', 'help', 'samples']) : h.html`<p>No issues from the basic checks.</p>`}
    ${r.data.errors?.length ? h.html`<p class="note">Checks that could not run: ${r.data.errors.join('; ')}</p>` : ''}
    <p class="note">Basic heuristics only. Contrast, headings, landmarks and focus styles are checked by the Contrast and Structure plugins; the axe plugin runs the full WCAG audit, and its results replace the matching checks here.</p>
  `;
}

function glance(r, h) {
  const d = r.data;
  const has = (id) => d.rules.some((x) => x.id === id);
  const rows = [...d.rules].sort((a, b) => b.count - a.count).slice(0, 8).map((x) => ({ label: x.help, value: x.count }));
  return h.html`<div class="glance-grid">
    <section class="card"><h4>Issues by check</h4>${rows.length ? h.hbars({ rows, label: 'Accessibility issues by check' }) : h.html`<p class="muted">No issues found by the basic checks.</p>`}</section>
    <section class="card"><h4>Structure</h4>${h.checklist([
      { label: 'Skip link', ok: !!d.stats.skipLink },
      { label: `Landmarks (${d.stats.landmarks})`, ok: d.stats.landmarks > 0 },
      { label: 'Images have alt text', ok: !has('image-alt') },
      { label: 'Form fields are labelled', ok: !has('input-label') },
      { label: 'Page language set', ok: !has('html-lang') },
      { label: 'Zoom allowed', ok: !has('meta-viewport') },
    ])}</section>
  </div>`;
}

export default {
  id: 'a11y-basics',
  group: 'quality',
  area: 'accessibility',
  name: 'Accessibility basics',
  version: '0.1.0',
  phase: 'page',
  world: 'isolated',
  after: ['axe'],
  description: 'Dependency-free checks: alt text, labels, names, title, lang, zoom, duplicate ids, tabindex, autoplay, hidden focusables.',
  tags: ['accessibility'],
  collect,
  run,
  render,
  glance,
};
