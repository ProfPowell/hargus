// International: how the page holds up in translation and right-to-left — from the Long text and
// Right-to-left views measured during capture, the CSS plugin's property counts and the page's
// lang / dir / hreflang. Offline, so it re-runs and works in the CLI on any reading that has the data.

import { baseView } from '../core/views.js';

export const LANG_TAG = /^[a-zA-Z]{2,3}(-[a-zA-Z]{4})?(-([a-zA-Z]{2}|\d{3}))?(-([a-zA-Z0-9]{5,8}|\d[a-zA-Z0-9]{3}))*$/;
const PHYSICAL = /^(margin|padding)-(left|right)$|^(left|right)$|^border-(left|right)(-(width|color|style))?$|^border-(top|bottom)-(left|right)-radius$/;
const LOGICAL = /^(margin|padding|inset|border)-inline|^border-(start|end)-(start|end)-radius$/;
const RTL_SHARE = 0.05;

export function cssDirection(props = {}) {
  let physical = 0;
  let logical = 0;
  for (const [k, n] of Object.entries(props)) {
    if (PHYSICAL.test(k)) physical += n;
    else if (LOGICAL.test(k)) logical += n;
  }
  return { physical, logical };
}

const mostlyPhysical = (css) => css.physical >= 20 && css.physical > 3 * css.logical;
const norm = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/$/, '') + x.search; } catch { return String(u || ''); } };
const normNoQuery = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/$/, ''); } catch { return String(u || ''); } };

function run(reading, ctx) {
  const views = reading.log._harplus?.capture?.views || {};
  const base = views[baseView(reading)];
  const props = ctx.results.css?.status === 'ok' ? ctx.results.css.data?.usage?.properties : null;
  const meta = ctx.results.meta?.status === 'ok' ? ctx.results.meta.data : null;
  if (!base && !props && !meta) ctx.skip('no view measurements, CSS or page metadata in this reading');
  const findings = [];
  const add = (severity, title, detail) => findings.push({ severity, category: 'international', title, detail });

  let extraClipped = null;
  let longSideways = false;
  if (base && views.pseudo) {
    extraClipped = Math.max(0, (views.pseudo.clipped || 0) - (base.clipped || 0));
    longSideways = views.pseudo.overflowX > 0 && !(base.overflowX > 0);
    if (extraClipped >= 3) add('medium', 'Text gets cut off when translated', `${extraClipped} more text boxes clip their content when the text is about 40% longer.`);
    if (longSideways) add('medium', 'Longer text makes the page scroll sideways', `The page becomes ${views.pseudo.overflowX}px wider than the window.`);
  }
  const rtlMeasured = !!(base && views.rtl);
  const rtlSideways = rtlMeasured && views.rtl.overflowX > 0 && !(base.overflowX > 0);
  if (rtlSideways) add('medium', 'Right-to-left layout scrolls sideways', `With dir="rtl" the page becomes ${views.rtl.overflowX}px wider than the window.`);
  const rtlUnmarked = base?.rtlUnmarked ?? 0;
  if (rtlUnmarked >= RTL_SHARE) add('medium', 'Right-to-left text without dir="rtl"', `${Math.round(rtlUnmarked * 100)}% of the text is Arabic or Hebrew shown left-to-right — mark it with dir="rtl" (or dir="auto").`);

  const css = props ? cssDirection(props) : null;
  if (css && mostlyPhysical(css)) add('low', 'Layout CSS uses left/right instead of logical properties', `${css.physical} physical vs ${css.logical} logical declarations — margin-inline-start, inset-inline-end and friends mirror automatically in right-to-left.`);
  const lang = meta?.lang ?? null;
  const langOk = lang == null || LANG_TAG.test(lang);
  if (lang != null && !langOk) add('low', `lang "${lang}" is not a valid language tag`, 'Use a BCP 47 tag such as en, en-US or zh-Hant.');
  const alts = meta?.hreflang || [];
  const hreflangIssues = [];
  if (alts.length) {
    const isDefault = (a) => String(a.hreflang).toLowerCase() === 'x-default';
    const bad = alts.filter((a) => !isDefault(a) && !LANG_TAG.test(a.hreflang)).map((a) => a.hreflang);
    if (bad.length) hreflangIssues.push(`invalid codes: ${bad.join(', ')}`);
    const same = meta.canonical
      ? (a) => norm(a.href) === norm(meta.canonical)
      : (a) => normNoQuery(a.href) === normNoQuery(ctx.target.finalUrl);
    if (!alts.some(same)) hreflangIssues.push('no hreflang entry points at this page');
    if (alts.length >= 3 && !alts.some(isDefault)) hreflangIssues.push('no x-default');
    if (hreflangIssues.length) add('low', 'hreflang problems', hreflangIssues.join('; '));
  }

  const summary = [];
  if (extraClipped != null) {
    const fits = extraClipped === 0 && !longSideways;
    summary.push({
      label: 'Long text', value: fits ? 'fits' : `${extraClipped} clipped${longSideways ? ' · scrolls sideways' : ''}`,
      rating: fits ? 'good' : extraClipped < 3 && !longSideways ? 'needs-improvement' : 'poor', headline: true,
    });
  }
  if (rtlMeasured) summary.push({ label: 'Right-to-left', value: rtlSideways ? 'scrolls sideways' : 'fits' });
  if (css) summary.push({ label: 'Logical CSS', value: `${css.logical} logical · ${css.physical} physical` });
  if (meta) summary.push({ label: 'Language', value: [lang || 'no lang', meta.dir || 'ltr', `${alts.length} hreflang`].join(' · ') });
  return {
    data: { extraClipped, longSideways, rtlMeasured, rtlSideways, rtlUnmarked, dirMeasured: base?.rtlUnmarked != null, css, lang, langOk, dir: meta?.dir ?? null, hreflang: alts, hreflangIssues },
    findings,
    summary,
  };
}

function glance(r, h) {
  const d = r.data;
  const items = [
    d.lang != null && { label: `lang="${d.lang}" is a valid tag`, ok: d.langOk },
    d.dirMeasured && { label: 'Text direction matches the script', ok: d.rtlUnmarked < RTL_SHARE },
    d.hreflang.length > 0 && { label: `hreflang (${d.hreflang.length})`, ok: !d.hreflangIssues.length, note: d.hreflangIssues.join('; ') },
    d.css && { label: 'Logical CSS', ok: !mostlyPhysical(d.css) },
    d.extraClipped != null && { label: 'Long text fits', ok: d.extraClipped < 3 && !d.longSideways },
    d.rtlMeasured && { label: 'Right-to-left fits', ok: !d.rtlSideways },
  ].filter(Boolean);
  return h.html`<div class="glance-grid">
    <section class="card"><h4>Translation and right-to-left</h4>${h.checklist(items)}</section>
    ${d.css ? h.html`<section class="card"><h4>CSS direction</h4>${h.stackBar({ label: 'Declarations', segments: [
      { label: 'Logical', value: d.css.logical, color: 'var(--c1)' },
      { label: 'Physical (left/right)', value: d.css.physical, color: 'var(--c2)' },
    ] })}</section>` : ''}
  </div>`;
}

export default {
  id: 'international',
  name: 'International',
  version: '0.1.0',
  phase: 'analyze',
  needs: ['views'],
  area: 'international',
  group: 'other',
  description: 'Translation and right-to-left readiness: longer text, mirrored layout, text direction, logical CSS, lang and hreflang.',
  tags: ['i18n'],
  run,
  glance,
};
