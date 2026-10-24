// International: how the page holds up in translation and right-to-left — from the Long text and
// Right-to-left views measured during capture, the CSS plugin's property counts and the page's
// lang / dir / hreflang. Offline, so it re-runs and works in the CLI on any reading that has the data.

import { baseView, A11Y_MIN_OVERFLOW, VIEW_LABELS, failedChecks, extraClipped as clipExtra } from '../core/views.js';
import { TRANSLATED_VIEWS } from '../core/translation.js';
import { languageName, primary } from '../core/language.js';

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

const CAUSE_WORDS = {
  iframe: (n) => `${n} in an embedded frame`,
  cssContent: (n) => `${n} CSS-generated`,
  svg: (n) => `${n} inside an SVG`,
  canvas: (n) => `${n} drawn on a canvas`,
  late: (n) => `${n} added after translation`,
  budget: (n) => `${n} not translated in time`,
  error: (n) => `${n} translation ${n === 1 ? 'error' : 'errors'}`,
  cap: (n, l) => `page too long: only the first ${Number(l.cap || 5000).toLocaleString('en')} text blocks were translated`,
};
const leftoverDetail = (l) => {
  const causes = Object.entries(l.causes || {}).filter(([k, n]) => n > 0 && CAUSE_WORDS[k]).map(([k, n]) => CAUSE_WORDS[k](n, l));
  const ex = (l.examples || []).slice(0, 3).map((e) => `"${e}"`);
  return [causes.length ? `${causes.join(', ')}.` : '', ex.length ? `For example: ${ex.join(', ')}.` : ''].filter(Boolean).join(' ');
};
/** Frames and canvases can't be translated at all: they are counted apart from text. */
const embedded = (l) => (l?.causes?.iframe || 0) + (l?.causes?.canvas || 0);
const textLeft = (l) => Math.max(0, (l?.count || 0) - embedded(l));
/** The leftovers finding fires from 3 pieces of text, or whenever the page outgrew the node cap. */
const leftoversFire = (l) => textLeft(l) >= 3 || !!l?.causes?.cap;
const sideways = (v, ref) => v.scrollsX !== false && (v.overflowX || 0) - (ref.overflowX || 0) >= A11Y_MIN_OVERFLOW && !(ref.overflowX > 0);

/** One translated view against its reference (Arabic: the right-to-left view when it ran, else the base view). */
function translatedResult(tv, t, views, base, check) {
  const out = { id: tv.id, label: tv.label, status: t?.status, reason: t?.reason, unverified: t?.status === 'failed' && check?.ok === false, extraClipped: null, sideways: false, note: '', leftovers: null };
  if (t?.status !== 'ok') return out;
  const v = views[tv.id];
  if (v && base) {
    let ref = base;
    if (tv.id === 'translated-ar') {
      if (views.rtl) ref = views.rtl;
      else out.note = ' (compared with the original layout; the right-to-left view did not run)';
    }
    out.extraClipped = Math.max(0, clipExtra(v, ref));
    out.sideways = sideways(v, ref);
    out.overflowX = v.overflowX || 0;
  }
  if (t.leftovers?.count > 0) out.leftovers = t.leftovers;
  return out;
}

function run(reading, ctx) {
  const unverified = failedChecks(reading).filter(([id]) => id === 'rtl' || id === 'pseudo');
  const views = Object.fromEntries(Object.entries(reading.log._harplus?.capture?.views || {}).filter(([id]) => !unverified.some(([bad]) => bad === id)));
  const base = views[baseView(reading)];
  const props = ctx.results.css?.status === 'ok' ? ctx.results.css.data?.usage?.properties : null;
  const meta = ctx.results.meta?.status === 'ok' ? ctx.results.meta.data : null;
  if (!base && !props && !meta) ctx.skip('no view measurements, CSS or page metadata in this reading');
  const findings = [];
  const add = (severity, title, detail) => findings.push({ severity, category: 'international', title, detail });
  for (const [id, c] of unverified) add('info', `${VIEW_LABELS[id] || id} view could not be verified — ${c.detail}`);

  let extraClipped = null;
  let longSideways = false;
  if (base && views.pseudo) {
    extraClipped = Math.max(0, clipExtra(views.pseudo, base));
    longSideways = sideways(views.pseudo, base);
    if (extraClipped >= 3) add('medium', 'Text gets cut off when translated', `${extraClipped} more text boxes clip their content when the text is about 40% longer.`);
    if (longSideways) add('medium', 'Longer text makes the page scroll sideways', `The page becomes ${views.pseudo.overflowX}px wider than the window.`);
  }
  const translation = reading.log._harplus?.capture?.translation || {};
  const viewChecks = reading.log._harplus?.capture?.viewChecks || {};
  const translated = TRANSLATED_VIEWS.map((tv) => translatedResult(tv, translation[tv.id], views, base, viewChecks[tv.id]));
  // All three failed the same way (no translator, blocked by the site, out of time): one note, not three.
  const failed = translated.filter((t) => t.status === 'failed');
  const pageWide = failed.length === translated.length && failed.every((t) => !t.unverified && t.reason === failed[0].reason);
  if (pageWide) add('info', `Translated views could not run — ${failed[0].reason || 'unknown reason'}`);
  for (const t of translated) if (t.status === 'failed' && !pageWide) add('info', `${t.label} view could not ${t.unverified ? 'be verified' : 'run'} — ${t.reason || 'unknown reason'}`);
  // One finding per defect, naming every language that shows it (each language still has to pass its own threshold),
  // so the same broken layout is not scored three times.
  const names = (list) => list.map((t) => t.label).join(', ');
  const clipped = translated.filter((t) => t.extraClipped >= 3);
  if (clipped.length) {
    const max = Math.max(...clipped.map((t) => t.extraClipped));
    add('medium', `Text gets cut off when translated (${names(clipped)}): up to ${max} more text boxes clip`,
      `More text boxes clip their content than in the original: ${clipped.map((t) => `${t.label} ${t.extraClipped}${t.note}`).join('; ')}.`);
  }
  const wide = translated.filter((t) => t.sideways);
  if (wide.length) {
    add('medium', `Translated text makes the page scroll sideways (${names(wide)})`,
      `The page becomes wider than the window: ${wide.map((t) => `${t.label} by ${t.overflowX}px${t.note}`).join('; ')}.`);
  }
  // Leftovers: text that stayed in the source language (frames and canvases apart); the node cap is a detail line.
  const sourceName = (l) => languageName(primary(l?.source || meta?.lang || 'en') || 'en');
  const perLanguage = (list) => list.map((t) => `${t.label}: ${leftoverDetail(t.leftovers)}`).join(' ');
  const leftLangs = translated.filter((t) => textLeft(t.leftovers) >= 3);
  if (leftLangs.length) {
    const max = Math.max(...leftLangs.map((t) => textLeft(t.leftovers)));
    const capped = translated.filter((t) => t.leftovers?.causes?.cap && !leftLangs.includes(t));
    add('low', `Up to ${max} pieces of text stayed in ${sourceName(leftLangs[0].leftovers)} when translated (${names(leftLangs)})`,
      [perLanguage(leftLangs), capped.length ? perLanguage(capped) : ''].filter(Boolean).join(' '));
  } else {
    const capped = translated.filter((t) => t.leftovers?.causes?.cap);
    const emb = translated.filter((t) => embedded(t.leftovers) > 0);
    if (capped.length) {
      // Past the node cap untranslated text is not counted piece by piece, so the 3-piece threshold cannot see it.
      add('low', `Text stayed in ${sourceName(capped[0].leftovers)} when translated (${names(capped)})`, perLanguage(capped));
    } else if (emb.length) {
      const n = Math.max(...emb.map((t) => embedded(t.leftovers)));
      add('info', `${n} embedded ${n === 1 ? 'area' : 'areas'} can't be translated (${names(emb)})`, perLanguage(emb));
    }
  }
  for (const t of translated) if (t.status === 'ok') t.leftoversFire = leftoversFire(t.leftovers);
  const rtlMeasured = !!(base && views.rtl);
  const rtlGrew = rtlMeasured ? (views.rtl.overflowX || 0) - (base.overflowX || 0) : 0;
  const rtlSideways = rtlMeasured && views.rtl.scrollsX !== false && rtlGrew >= A11Y_MIN_OVERFLOW && !(base.overflowX > 0);
  if (rtlSideways) {
    const o = (views.rtl.overflowers || [])[0];
    const detail = o?.offscreen
      ? `${o.selector} sits ${o.over} px off-screen. In a right-to-left page it pushes the layout sideways — position or move it with logical properties (inset-inline-start, translate with the inline direction) instead.`
      : o ? `${o.selector} is ${o.width} px wide; with dir="rtl" the page becomes ${views.rtl.overflowX}px wider than the window.`
      : `With dir="rtl" the page becomes ${views.rtl.overflowX}px wider than the window.`;
    add('medium', 'Right-to-left layout scrolls sideways', detail);
  }
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
    data: { translated, extraClipped, longSideways, rtlMeasured, rtlSideways, rtlUnmarked, dirMeasured: base?.rtlUnmarked != null, css, lang, langOk, dir: meta?.dir ?? null, hreflang: alts, hreflangIssues },
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
    ...(d.translated || []).map((t) => {
      if (t.status === 'skipped' && /^page is already in/.test(t.reason || '')) return { label: `Fits in ${t.label}`, ok: null, note: t.reason };
      if (t.extraClipped == null) return false;
      return { label: `Fits in ${t.label}`, ok: t.extraClipped < 3 && !t.sideways, note: t.extraClipped > 0 ? `${t.extraClipped} more clipped` : '' };
    }),
    (d.translated || []).some((t) => t.status === 'ok') && {
      label: 'All text translated', ok: !(d.translated || []).some((t) => t.leftoversFire),
      // Counts only, per language with leftovers: the finding carries the causes and examples.
      note: (d.translated || []).filter((t) => t.status === 'ok' && t.leftovers).map((t) => `${t.label}: ${[
        textLeft(t.leftovers) && `${textLeft(t.leftovers)} ${textLeft(t.leftovers) === 1 ? 'piece' : 'pieces'} of text left`,
        embedded(t.leftovers) && `${embedded(t.leftovers)} embedded`,
        t.leftovers.causes?.cap && 'page too long to translate in full',
      ].filter(Boolean).join(' · ')}`).join('; '),
    },
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
