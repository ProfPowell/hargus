// Structure: outline-grade accessibility rules (headings, landmarks, names, links, references, alt,
// autocomplete, target size, small text, focus order) plus focus-style findings from the capture's
// focus probe and keyboard findings from the capture's keyboard walk (core/keyboard.js). collect() runs in the page (self-contained); analyzeStructure() is pure.

import { baseView } from '../core/views.js';
import { KIND_LABELS } from '../core/focus.js';
import { suppressedBy } from '../core/a11y-overlap.js';
import { buildOutline, landmarkLabel } from '../core/outline.js';
import { analyzeKeyboard, walkComplete, ENDED_LABELS } from '../core/keyboard.js';

function collect(args = {}) {
  const $$ = (s) => [...document.querySelectorAll(s)];
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible' && !el.closest('[aria-hidden="true"], [hidden]');
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
  // A selector that names one element (an id, or nth-of-type steps), the same as the keyboard walk's stops
  // (browser/keyboard-walk.js keyPath): the walk's findings and the Page map's structure markers use it.
  const keyPath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      let p = n.localName;
      if (n.id && document.querySelectorAll(`#${CSS.escape(n.id)}`).length === 1) { parts.unshift(`${p}#${CSS.escape(n.id)}`); break; }
      if (n.classList.length) p += `.${[...n.classList].slice(0, 2).map((c) => CSS.escape(c)).join('.')}`;
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.localName === n.localName) : [];
      if (same.length > 1) p += `:nth-of-type(${same.indexOf(n) + 1})`;
      parts.unshift(p);
      if (n.localName === 'body') break;
    }
    return parts.join(' > ');
  };
  const text = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const byIds = (ids) => String(ids || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean);
  const name = (el) => el.getAttribute('aria-label')?.trim() || byIds(el.getAttribute('aria-labelledby')).map(text).join(' ')
    || text(el) || el.getAttribute('title')?.trim() || [...el.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ').trim();
  const sample = (el, label) => ({ selector: path(el), text: String(label ?? text(el)).slice(0, 80) });
  const bag = (els, f = (e) => sample(e)) => ({ count: els.length, samples: els.slice(0, 5).map(f) });

  const labelOf = (el) => el.getAttribute('aria-label')?.trim() || byIds(el.getAttribute('aria-labelledby')).map(text).join(' ') || '';
  const topLevel = (el) => !el.parentElement?.closest('article, aside, main, nav, section');

  // Landmark of an element (or null): explicit role, else the tag's implicit role. header/footer only count
  // outside article/aside/main/nav/section; section and form only with an accessible name.
  const LM_ROLES = ['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'region', 'form', 'search'];
  const lmRole = (el) => {
    const r = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (LM_ROLES.includes(r)) return r;
    if (r) return null; // an explicit non-landmark role (none, presentation, group...) overrides the tag's implicit one
    switch (el.localName) {
      case 'header': return topLevel(el) ? 'banner' : null;
      case 'footer': return topLevel(el) ? 'contentinfo' : null;
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'aside': return 'complementary';
      case 'search': return 'search';
      case 'section': return labelOf(el) ? 'region' : null;
      case 'form': return labelOf(el) ? 'form' : null;
      default: return null;
    }
  };
  // Landmarks get an id by first sight, so two navs with the same path stay distinct. Chains run OUTERMOST first.
  const lmIds = new Map();
  const lmCache = new Map();
  const lmOf = (el) => {
    if (lmCache.has(el)) return lmCache.get(el);
    const role = lmRole(el);
    let lm = null;
    if (role) {
      if (!lmIds.has(el)) lmIds.set(el, lmIds.size + 1);
      lm = { role, label: labelOf(el).slice(0, 80), id: lmIds.get(el), pos: docPos.get(el) };
    }
    lmCache.set(el, lm);
    return lm;
  };
  const chainOf = (el) => {
    const chain = [];
    for (let n = el.parentElement; n; n = n.parentElement) { const lm = lmOf(n); if (lm) chain.unshift(lm); }
    return chain;
  };
  const docPos = new Map($$('h1, h2, h3, h4, h5, h6, [role], header, footer, nav, main, aside, section, form, search').map((el, i) => [el, i]));

  const headings = [];
  const hiddenHeadings = [];
  for (const el of $$('h1, h2, h3, h4, h5, h6, [role="heading"]')) {
    if (headings.length >= 300 && hiddenHeadings.length >= 300) break;
    const level = Number(el.getAttribute('aria-level')) || (/^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : 2);
    const isShown = shown(el);
    const list = isShown ? headings : hiddenHeadings;
    if (list.length < 300) list.push(isShown ? { level, text: name(el).slice(0, 200), selector: path(el), key: keyPath(el), landmarks: chainOf(el), pos: docPos.get(el) } : { level, text: name(el).slice(0, 200), selector: path(el) });
  }
  const landmarkList = [];
  for (const el of $$('[role], header, footer, nav, main, aside, section, form, search')) {
    if (landmarkList.length >= 200) break;
    const lm = lmOf(el);
    if (lm && shown(el)) landmarkList.push({ ...lm, sel: path(el), key: keyPath(el), landmarks: chainOf(el), pos: docPos.get(el) });
  }

  const landmarks = {
    mains: $$('main, [role="main"]').filter(shown).length,
    hasMain: !!document.querySelector('main, [role="main"]'),
    navs: $$('nav, [role="navigation"]').filter(shown).map(labelOf),
    asides: $$('aside, [role="complementary"]').filter(shown).map(labelOf),
    banners: $$('header, [role="banner"]').filter((el) => shown(el) && (el.getAttribute('role') === 'banner' || topLevel(el))).length,
    contentinfos: $$('footer, [role="contentinfo"]').filter((el) => shown(el) && (el.getAttribute('role') === 'contentinfo' || topLevel(el))).length,
  };

  // Visible text without aria-hidden decoration (icons, arrows); compared letters and digits only.
  const visibleText = (el) => {
    const c = el.cloneNode(true);
    for (const x of c.querySelectorAll('[aria-hidden="true"]')) x.remove();
    return c.textContent || '';
  };
  const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const labelInName = $$('a, button, [role="button"], [role="link"]').filter((el) => {
    if (!shown(el) || !el.hasAttribute('aria-label')) return false;
    const vis = words(visibleText(el));
    const al = words(el.getAttribute('aria-label'));
    return /[\p{L}\p{N}]{2,}/u.test(vis) && al && !al.includes(vis);
  });

  const https = location.protocol === 'https:';
  const links = $$('a[href]').filter(shown);
  const httpLinks = https ? links.filter((a) => /^http:/i.test(a.getAttribute('href') || '') || a.href.startsWith('http:')) : [];
  const byHref = new Map();
  for (const a of links) {
    if ((a.getAttribute('href') || '').startsWith('#')) continue;
    const u = a.href.split('#')[0];
    const tx = norm(text(a) || a.getAttribute('aria-label'));
    if (!tx) continue;
    if (!byHref.has(u)) byHref.set(u, new Set());
    byHref.get(u).add(tx);
  }
  const multi = [...byHref].filter(([, s]) => s.size > 1);
  const here = location.href.split('#')[0];
  const noCurrent = $$('nav a[href]').filter((a) => shown(a) && !(a.getAttribute('href') || '').startsWith('#') && a.href.split('#')[0] === here && !a.hasAttribute('aria-current')).length;

  const missing = (attr) => $$(`[${attr}]`).filter((el) => String(el.getAttribute(attr) || '').split(/\s+/).filter(Boolean).some((id) => !document.getElementById(id)));
  // A form field with a broken aria-labelledby is a11y-basics' "Form fields without a label"; don't count it twice.
  // aria-describedby (help and error text) is checked only here, so fields stay in.
  const nonField = (el) => !el.matches('input, select, textarea');
  const labelRefs = [...missing('aria-labelledby').filter(nonField), ...missing('aria-describedby'), ...$$('label[for]').filter((l) => l.htmlFor && !document.getElementById(l.htmlFor))];
  const ariaRefs = [...missing('aria-controls'), ...missing('aria-owns'), ...missing('aria-activedescendant')];

  const BAD_ALT = [/^(image|photo|picture|graphic|icon) of\b/i, /^(image|photo|picture|placeholder|img|graphic|logo)$/i, /\.(jpe?g|png|gif|webp|avif|svg)$/i, /^[\w-]*\d{3,}[\w-]*$/];
  const badAlt = $$('img[alt]').filter((i) => { const a = i.getAttribute('alt').trim(); return a && (a.length > 150 || BAD_ALT.some((r) => r.test(a))); });

  const AUTOFILL = new Set(['name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name', 'honorific-suffix', 'nickname', 'username', 'new-password', 'current-password', 'one-time-code', 'organization-title', 'organization', 'street-address', 'address-line1', 'address-line2', 'address-line3', 'address-level4', 'address-level3', 'address-level2', 'address-level1', 'country', 'country-name', 'postal-code', 'cc-name', 'cc-given-name', 'cc-additional-name', 'cc-family-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-type', 'transaction-currency', 'transaction-amount', 'language', 'bday', 'bday-day', 'bday-month', 'bday-year', 'sex', 'url', 'photo', 'tel', 'tel-country-code', 'tel-national', 'tel-area-code', 'tel-local', 'tel-extension', 'email', 'impp', 'webauthn',
    'on', 'off', 'shipping', 'billing', 'home', 'work', 'mobile', 'fax', 'pager']);
  const badAuto = $$('input[autocomplete], select[autocomplete], textarea[autocomplete]').filter((el) => {
    const toks = String(el.getAttribute('autocomplete')).trim().toLowerCase().split(/\s+/).filter(Boolean);
    return toks.length && !toks.every((tk) => AUTOFILL.has(tk) || tk.startsWith('section-'));
  });
  const resetButtons = $$('input[type="reset" i], button[type="reset" i]').length;

  const TARGET = 'a[href], button, input:not([type="hidden" i]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
  // Not targets: sr-only (as contrast.js), entirely off-screen (skip links), and browser-sized native checkboxes/radios (2.5.8 exception).
  const pointable = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if ((r.width <= 1 && r.height <= 1) || cs.clip === 'rect(0px, 0px, 0px, 0px)' || /^inset\(50%/.test(cs.clipPath)) return false;
    if (r.right + scrollX < 0 || r.bottom + scrollY < 0 || r.left + scrollX > Math.max(innerWidth, document.documentElement.scrollWidth)) return false;
    if (el.matches('input[type="checkbox" i], input[type="radio" i]') && cs.appearance !== 'none') return false;
    return true;
  };
  const targets = $$(TARGET).filter((el) => shown(el) && pointable(el)).slice(0, 1500).map((el) => {
    const r = el.getBoundingClientRect();
    let inline = false;
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') {
      let blk = el.parentElement;
      while (blk && ['inline', 'contents'].includes(getComputedStyle(blk).display)) blk = blk.parentElement;
      inline = !!blk && (blk.textContent || '').trim().length > (el.textContent || '').trim().length;
    }
    return { el, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, inline };
  });
  const small24 = targets.filter((tg) => !tg.inline && (tg.w < 24 || tg.h < 24)
    && targets.some((o) => o !== tg && Math.hypot(o.cx - tg.cx, o.cy - tg.cy) < 24)).map((tg) => tg.el);
  const small44 = targets.filter((tg) => !tg.inline && (tg.w < 44 || tg.h < 44)).map((tg) => tg.el);

  let smallText = 0;
  let walked = 0;
  for (const el of (document.body || document.documentElement).querySelectorAll('*')) {
    if (++walked > 4000) break;
    if (!/\S/.test([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''))) continue;
    if (!shown(el)) continue;
    if (parseFloat(getComputedStyle(el).fontSize) < 12) smallText++;
  }
  const smallFields = $$('input:not([type="hidden" i]):not([type="checkbox" i]):not([type="radio" i]):not([type="submit" i]):not([type="button" i]), select, textarea')
    .filter((el) => shown(el) && parseFloat(getComputedStyle(el).fontSize) < 16);

  const focusables = $$('a[href], button, input:not([type="hidden" i]), select, textarea, summary, [tabindex], [contenteditable="true"], iframe')
    .filter((el) => shown(el) && !el.matches(':disabled') && el.tabIndex >= 0);
  const pinned = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { if (['fixed', 'sticky'].includes(getComputedStyle(n).position)) return true; } return false; };
  const order = [...focusables.filter((el) => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex), ...focusables.filter((el) => el.tabIndex === 0)].filter((el) => !pinned(el));
  const jumps = [];
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1].getBoundingClientRect();
    const b = order[i].getBoundingClientRect();
    if (b.top < a.top - 200 && b.left < a.right && b.right > a.left) jumps.push(order[i]);
  }
  // Scroll containers take tabindex so keyboards can scroll them; they need no role.
  const scroller = (el) => { const cs = getComputedStyle(el); return [cs.overflow, cs.overflowX, cs.overflowY].some((v) => /\b(auto|scroll)\b/.test(v)); };
  const noRole = $$('div[tabindex], span[tabindex]').filter((el) => el.tabIndex >= 0 && !el.getAttribute('role') && shown(el) && !scroller(el));

  // Clickable but not in the tab order: an onclick attribute or a button/link role, not disabled, not inside a
  // focusable control or a label (the click lands there). Listeners added by script can't be seen from here.
  const clickables = $$('[onclick], [role="button"], [role="link"]').filter((el) => el !== document.body && el !== document.documentElement
    // Chromium reports tabIndex 0 for <a> without href, yet it is not focusable without a tabindex attribute.
    && (el.tabIndex < 0 || (el.localName === 'a' && !el.hasAttribute('href') && !el.hasAttribute('tabindex'))) && !el.matches(':disabled') && shown(el)
    && !el.parentElement?.closest('a[href], button, summary, label, select, textarea, input, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'))
    .slice(0, 100).map((el) => ({ selector: keyPath(el), text: text(el).slice(0, 80) }));
  const positiveTabindex = $$('[tabindex]').filter((el) => el.tabIndex > 0 && shown(el)).slice(0, 100).map((el) => ({ selector: keyPath(el), tabindex: el.tabIndex }));
  // Unnamed walk stops that axe already reported under a name rule: matched by element, as the selectors differ.
  const find = (sel) => { try { return sel && !sel.includes('>>>') ? document.querySelector(sel) : null; } catch { return null; } };
  const axeEls = new Set((args?.axeNameTargets || []).map(find).filter(Boolean));
  const kbAxeNamed = axeEls.size ? (args?.kbUnnamed || []).filter((sel) => axeEls.has(find(sel))) : [];

  return {
    headings, hiddenHeadings, landmarks, landmarkList,
    labelInName: bag(labelInName, (el) => sample(el, `${text(el)} ≠ ${el.getAttribute('aria-label')}`)),
    httpLinks: bag(httpLinks, (a) => sample(a, a.href)),
    multiText: { count: multi.length, samples: multi.slice(0, 5).map(([u, s]) => ({ selector: u, text: [...s].slice(0, 3).join(' | ') })) },
    noCurrent,
    labelRefs: bag(labelRefs), ariaRefs: bag(ariaRefs),
    badAlt: bag(badAlt, (i) => sample(i, i.getAttribute('alt'))),
    badAuto: bag(badAuto, (el) => sample(el, el.getAttribute('autocomplete'))),
    resetButtons,
    targets24: bag(small24), targets44: bag(small44),
    smallText: { count: smallText },
    smallFields: bag(smallFields),
    focusJumps: bag(jumps), noRole: bag(noRole),
    clickables, positiveTabindex, kbAxeNamed, focusableCount: focusables.length,
  };
}

const n = (b) => Number(b?.count) || 0;
/** "1 target", "3 targets": the count with the noun (and verb) that agrees with it. */
const cnt = (b, one, many) => `${n(b)} ${n(b) === 1 ? one : many}`;
const ev = (b) => (b?.samples?.length ? b.samples.map((s) => s.selector).join('\n') : undefined);

export function analyzeStructure(c, { mobile = false, focus, axe, keyboard } = {}) {
  const findings = [];
  const add = (id, severity, title, evidence, detail) => suppressedBy('a11y-structure', id, axe) || findings.push({ id, severity, category: 'accessibility', title, ...(evidence ? { evidence } : {}), ...(detail ? { detail } : {}) });
  const heads = c.headings || [];
  let skipped = 0;
  heads.forEach((x, i) => { if (i && x.level > heads[i - 1].level + 1) skipped++; });
  const empty = heads.filter((x) => !String(x.text || '').trim()).length;
  const seen = new Map();
  for (const x of heads) { const k = String(x.text || '').toLowerCase().replace(/\s+/g, ' ').trim(); if (k) seen.set(k, (seen.get(k) || 0) + 1); }
  const dupes = [...seen.values()].filter((v) => v > 1).length;
  if (skipped) add('headings-skipped', 'low', `${skipped} skipped heading levels`);
  if (empty) add('headings-empty', 'medium', `${empty} empty headings`);
  if (dupes) add('headings-duplicate', 'info', `${dupes} duplicate heading texts`);

  const L = c.landmarks || {};
  if (!L.hasMain) add('no-main', 'low', 'No <main> landmark');
  if ((L.mains || 0) > 1) add('multiple-main', 'medium', `${L.mains} main landmarks`);
  const indistinct = (labels = []) => labels.length >= 2 && new Set(labels.filter(Boolean)).size < labels.length;
  if (indistinct(L.navs)) add('nav-indistinct', 'low', `${L.navs.length} navigation landmarks without distinct labels`);
  if (indistinct(L.asides)) add('aside-indistinct', 'low', `${L.asides.length} complementary landmarks without distinct labels`);
  if ((L.banners || 0) > 1) add('banner-multiple', 'low', 'Multiple banner landmarks');
  if ((L.contentinfos || 0) > 1) add('contentinfo-multiple', 'low', 'Multiple contentinfo landmarks');

  if (n(c.labelInName)) add('label-in-name', 'medium', `${cnt(c.labelInName, 'control whose accessible name hides its visible label', 'controls whose accessible name hides their visible label')} (WCAG 2.5.3)`, ev(c.labelInName));
  if (n(c.httpLinks)) add('http-links', 'low', cnt(c.httpLinks, 'link uses plain HTTP', 'links use plain HTTP'), ev(c.httpLinks));
  if (n(c.multiText)) add('multi-text', 'info', cnt(c.multiText, 'URL linked with different text', 'URLs linked with different text'), ev(c.multiText));
  if (c.noCurrent) add('no-current', 'info', 'Current page link has no aria-current');
  if (n(c.labelRefs)) add('label-refs', 'medium', cnt(c.labelRefs, 'label or description reference points to a missing id', 'label or description references point to missing ids'), ev(c.labelRefs));
  if (n(c.ariaRefs)) add('aria-refs', 'low', cnt(c.ariaRefs, 'ARIA reference points to a missing id', 'ARIA references point to missing ids'), ev(c.ariaRefs));
  if (n(c.badAlt)) add('bad-alt', 'low', cnt(c.badAlt, 'image with unhelpful alt text', 'images with unhelpful alt text'), ev(c.badAlt));
  if (n(c.badAuto)) add('bad-autocomplete', 'low', `${cnt(c.badAuto, 'invalid autocomplete value', 'invalid autocomplete values')} (WCAG 1.3.5)`, ev(c.badAuto));
  if (c.resetButtons) add('reset-button', 'info', 'Reset button present');

  if (n(c.targets24)) add('targets-24', 'medium', `${cnt(c.targets24, 'target', 'targets')} smaller than 24×24 px (WCAG 2.5.8)`, ev(c.targets24));
  if (mobile && n(c.targets44)) add('targets-44', 'info', `${cnt(c.targets44, 'target', 'targets')} under 44×44 px (advisory)`, ev(c.targets44));
  if (n(c.smallText)) add('small-text', 'low', `${cnt(c.smallText, 'text element', 'text elements')} under 12 px`);
  if (mobile && n(c.smallFields)) add('small-fields', 'low', `${cnt(c.smallFields, 'form field', 'form fields')} under 16 px (iOS zooms in)`, ev(c.smallFields));
  // A full keyboard walk measures the real order, so the DOM-inferred jump finding stays only without one.
  const walked = walkComplete(keyboard);
  if (n(c.focusJumps) && !walked) add('focus-jumps', 'low', `Focus order jumps back up the page ${n(c.focusJumps)} times`, ev(c.focusJumps));
  if (n(c.noRole)) add('no-role', 'low', cnt(c.noRole, 'focusable element without a role', 'focusable elements without a role'), ev(c.noRole));

  const samples = Array.isArray(focus?.samples) ? focus.samples : [];
  const blind = samples.filter((s) => !(s.changed || []).length);
  const outlineDetail = Number(focus?.outlineNone) > 0 ? `Stylesheets remove the focus outline in ${focus.outlineNone} rules without a replacement.` : undefined;
  // A full keyboard walk sees every stop's real focus style, so its finding replaces the probe's sampled ones.
  if (walked) {
    // reported as kb-no-focus-style below
  } else if (samples.length >= 2 && blind.length === samples.length) {
    add('focus-none', 'medium', 'No visible focus indicator on any sampled control (WCAG 2.4.7)', blind.map((s) => s.selector).join('\n'), outlineDetail);
  } else {
    for (const s of blind) add(`focus-${s.kind}`, 'low', `${KIND_LABELS[s.kind] || s.kind} show no visible focus indicator`, s.selector, outlineDetail);
  }

  const axeOk = axe?.status === 'ok';
  const kb = analyzeKeyboard(keyboard, { focusables: c.positiveTabindex || [], clickables: c.clickables || [], focusableCount: c.focusableCount, nameCovered: axeOk ? c.kbAxeNamed || [] : [] });
  for (const f of kb.findings) add(f.id, f.severity, f.title, f.evidence, f.id === 'kb-no-focus-style' && outlineDetail ? `${f.detail} ${outlineDetail}` : f.detail);

  const summary = [
    { label: 'Headings', value: `${heads.length}${skipped ? ` · ${skipped} skipped` : ''}` },
    { label: 'Landmarks', value: `main ${L.mains || 0} · nav ${(L.navs || []).length} · aside ${(L.asides || []).length}` },
    { label: 'Targets', value: `${n(c.targets24)} under 24 px` },
  ];
  if (samples.length) summary.push({ label: 'Focus', value: `${samples.length - blind.length} of ${samples.length} kinds visible`, headline: true, rating: blind.length === 0 ? 'good' : blind.length === samples.length ? 'poor' : 'needs-improvement' });
  if (kb.summary) summary.push(kb.summary);
  const kbData = keyboard && (Array.isArray(keyboard.stops) || keyboard.skipped || keyboard.error) ? keyboard : null;
  return { data: { ...c, mobile, keyboard: kbData, focus: samples.length ? { samples, outlineNone: Number(focus?.outlineNone) || 0 } : null, skipped, empty }, findings, summary };
}

/** The walk's unnamed stops and axe's name-rule targets, so collect() can tell which axe already reported. */
const NAME_RULES = ['button-name', 'link-name', 'input-button-name', 'aria-command-name'];
function collectArgs(ctx) {
  const axe = ctx.results?.axe;
  const stops = ctx.har?.log?._harplus?.capture?.keyboard?.stops;
  if (axe?.status !== 'ok' || !Array.isArray(stops)) return {};
  const kbUnnamed = [...new Set(stops.filter((s) => !s.none && !String(s.name || '').trim()).map((s) => s.sel))];
  const axeNameTargets = (axe.data?.violations || []).filter((v) => NAME_RULES.includes(v.id)).flatMap((v) => v.targets || v.samples?.map((x) => x.target) || []);
  return kbUnnamed.length && axeNameTargets.length ? { kbUnnamed, axeNameTargets } : {};
}

function run(reading, ctx) {
  if (!ctx.collected) ctx.skip('no page data');
  const hp = reading.log?._harplus || {};
  return analyzeStructure(ctx.collected, { mobile: baseView(reading) === 'mobile', focus: hp.capture?.focus, axe: ctx.results?.axe, keyboard: hp.capture?.keyboard });
}

function glance(r, h) {
  const d = r.data;
  const z = (b) => !(Number(b?.count) > 0);
  return h.html`<div class="glance-grid">
    <section class="card"><h4>Structure</h4>${h.checklist([
      { label: 'Heading levels in order', ok: !d.skipped },
      { label: '<main> landmark', ok: !!d.landmarks?.hasMain },
      { label: 'Labels match accessible names', ok: z(d.labelInName) },
      { label: 'References resolve', ok: z(d.labelRefs) && z(d.ariaRefs) },
      { label: 'Targets at least 24 px', ok: z(d.targets24) },
      { label: 'Focus visible', ok: !d.focus || d.focus.samples.every((s) => (s.changed || []).length) },
    ])}</section>
    ${d.focus ? h.html`<section class="card"><h4>Focus styles (forced :focus-visible)</h4>${h.table(d.focus.samples.map((s) => ({
      kind: s.kind, sample: h.html`<code>${s.selector}</code>`, changed: (s.changed || []).length ? s.changed.join(', ') : 'nothing',
    })), [{ key: 'kind', label: 'Kind' }, { key: 'sample', label: 'Sample' }, { key: 'changed', label: 'Changes on focus' }])}</section>` : ''}
  </div>`;
}

/** The walk's stops in order: number, role, name, selector and what is wrong with each. */
function keyboardOrder(k, h) {
  if (!k) return '';
  if (k.skipped) return h.sub('Keyboard order', h.html`<p class="muted">Keyboard walk: ${k.skipped}.</p>`);
  if (k.error && !Array.isArray(k.stops)) return h.sub('Keyboard order', h.html`<p class="muted">Keyboard walk failed: ${k.error}</p>`);
  const stops = k.stops || [];
  const chip = (rating, label) => h.html`<span class="chip-r rating-${rating}">${label}</span>`;
  const rows = stops.map((s, i) => {
    if (s.none) return { n: String(i + 1), role: '', name: h.html`<em class="muted">focus lost (on the page body)</em>`, sel: '', flags: chip('needs-improvement', 'focus lost') };
    const flags = [];
    if (!s.visible) flags.push('hidden');
    else if (!s.onScreen) flags.push('off-screen');
    if (s.changed === false) flags.push('no visible focus');
    if (Number(s.tabindex) > 0) flags.push(`positive tabindex (${s.tabindex})`);
    if (s.frame) flags.push(`inside a frame${s.presses > 1 ? ` (${s.presses} presses)` : ''}`);
    const named = String(s.name || '').trim();
    return {
      n: String(i + 1),
      role: s.role || s.tag || '',
      name: named ? named.slice(0, 120) : chip('poor', 'no accessible name'),
      sel: h.html`<code>${s.sel || ''}</code>`,
      flags: flags.length ? h.html`${flags.map((f) => h.html`${chip('needs-improvement', f)} `)}` : '',
    };
  });
  const secs = Number.isFinite(k.ms) ? ` ${(k.ms / 1000).toFixed(1)} s.` : '';
  return h.sub('Keyboard order', h.html`
    <p class="muted">${stops.filter((s) => !s.none).length} stops by pressing Tab from the top. ${ENDED_LABELS[k.ended] || ''}${k.ended === 'error' && k.error ? ` ${k.error}.` : ''}${secs}</p>
    ${stops.some((s) => s.frame) ? h.html`<p class="muted">A frame keeps focus while Tab moves through the elements inside it, so each frame is one row; the presses it took are in its flag.</p>` : ''}
    ${rows.length ? h.html`<div class="kb-order">${h.table(rows, [{ key: 'n', label: '#' }, { key: 'role', label: 'Role' }, { key: 'name', label: 'Name' }, { key: 'sel', label: 'Element' }, { key: 'flags', label: 'Flags' }])}</div>` : h.html`<p class="muted">Tab reached no element.</p>`}`);
}

function outlineNodes(nodes, h) {
  return h.html`<ul class="outline tree">${nodes.map((n) => {
    const marks = n.issues.map((i) => h.html` <span class="chip-r rating-poor">${i === 'skipped' ? 'skipped level' : 'empty'}</span>`);
    return n.kind === 'landmark'
      ? h.html`<li class="lm"><span class="chip-r">${landmarkLabel(n)}</span>${n.children.length ? outlineNodes(n.children, h) : ''}</li>`
      : h.html`<li><span class="lvl">h${n.level}</span>${n.text || h.html`<em>(empty)</em>`}${marks}${n.children.length ? outlineNodes(n.children, h) : ''}</li>`;
  })}</ul>`;
}

/** Headings nested inside the landmarks they sit in, with empty and skipped levels in red. */
function structureOutline(d, h) {
  const tree = buildOutline(d.headings || [], d.landmarkList || []);
  return h.sub('Structure outline', tree.length ? outlineNodes(tree, h) : h.html`<p class="muted">No headings or landmarks.</p>`);
}

function render(r, h) {
  const d = r.data;
  const rows = [
    ['Label not in name', d.labelInName], ['Plain HTTP links', d.httpLinks], ['URLs with different text', d.multiText],
    ['Broken label/description refs', d.labelRefs], ['Broken ARIA refs', d.ariaRefs], ['Unhelpful alt text', d.badAlt],
    ['Invalid autocomplete', d.badAuto], ['Targets under 24 px', d.targets24], ['Small form fields', d.smallFields],
    ['Focus jumps', d.focusJumps], ['Focusable without role', d.noRole],
  ].filter(([, b]) => Number(b?.count) > 0);
  return h.html`
    ${structureOutline(d, h)}
    ${(d.hiddenHeadings || []).length ? h.sub('Hidden headings (not counted)', h.list(d.hiddenHeadings.map((x) => `h${x.level} ${x.text || '(empty)'}`))) : ''}
    ${rows.length ? h.table(rows.map(([rule, b]) => ({ rule, count: String(b.count), samples: h.list(b.samples.map((s) => h.html`<code>${s.selector}</code> ${s.text}`)) })),
      [{ key: 'rule', label: 'Rule' }, { key: 'count', label: 'Count' }, { key: 'samples', label: 'Samples' }]) : h.html`<p class="muted">No structure issues.</p>`}
    ${keyboardOrder(d.keyboard, h)}`;
}

export default {
  id: 'a11y-structure',
  name: 'Structure',
  version: '0.1.0',
  phase: 'page',
  group: 'quality',
  area: 'accessibility',
  after: ['axe'],
  description: 'Headings, landmarks, label-in-name, links, ARIA references, alt text, autocomplete, target size, focus order, focus styles and the keyboard walk.',
  tags: ['accessibility'],
  timeoutMs: 15_000,
  collect,
  collectArgs,
  run,
  glance,
  render,
};
