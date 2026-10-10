// Dependency-free accessibility smoke checks. Catches the common, mechanical failures.
// Not a WCAG audit — enable the axe plugin (after vendoring axe-core) for that.

function collect() {
  const $$ = (s) => [...document.querySelectorAll(s)];
  const visible = (el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && !el.closest('[hidden],[aria-hidden="true"]');
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
    [...el.querySelectorAll('img[alt], svg title')].map((i) => i.getAttribute('alt') || i.textContent).join(' ').trim() ||
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

  let headings = [];
  try { headings = $$('h1,h2,h3,h4,h5,h6').filter(visible); } catch (e) { errors.push(`headings: ${e.message}`); }
  check('heading-order', 'moderate', 'Heading levels skip (e.g. h2 → h4)',
    () => headings.filter((h, i) => i > 0 && Number(h.tagName[1]) > Number(headings[i - 1].tagName[1]) + 1));
  check('empty-heading', 'minor', 'Empty headings', () => headings.filter((h) => !name(h)));
  check('duplicate-id', 'minor', 'Duplicate id values', () => {
    const seen = new Map();
    for (const el of $$('[id]')) {
      const id = el.id.trim();
      if (!id) continue; // id="" is invalid but not a duplicate
      if (seen.has(id)) seen.get(id).push(el); else seen.set(id, [el]);
    }
    return [...seen.values()].filter((els) => els.length > 1).map((els) => els[1]);
  });
  flag('landmark-main', 'moderate', 'No <main> landmark', () => !document.querySelector('main, [role="main"]'));
  check('tabindex', 'serious', 'Positive tabindex values (break focus order)', () => $$('[tabindex]').filter((e) => Number(e.getAttribute('tabindex')) > 0));
  check('autoplay-audio', 'moderate', 'Media that autoplays with sound', () => $$('video[autoplay]:not([muted]), audio[autoplay]:not([muted])'));
  check('focusable-hidden', 'serious', 'Focusable elements inside aria-hidden',
    () => $$('[aria-hidden="true"] a[href], [aria-hidden="true"] button, [aria-hidden="true"] input, [aria-hidden="true"] [tabindex]:not([tabindex="-1"])'));

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
  const findings = c.rules.map((r) => ({
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
      { label: 'Issues', value: total ? `${total} across ${c.rules.length} checks` : 'none found by basic checks' },
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
    <p class="note">Basic heuristics only. Colour contrast, focus visibility and ARIA validity need a full engine — enable the axe plugin.</p>
  `;
}

export default {
  id: 'a11y-basics',
  group: 'quality',
  name: 'Accessibility basics',
  version: '0.1.0',
  phase: 'page',
  world: 'isolated',
  description: 'Dependency-free checks: alt text, labels, names, lang, zoom, headings, landmarks, tabindex.',
  tags: ['accessibility'],
  collect,
  run,
  render,
};
