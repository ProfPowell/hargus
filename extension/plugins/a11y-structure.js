// Structure: outline-grade accessibility rules (headings, landmarks, names, links, references, alt,
// autocomplete, target size, small text, focus order) plus focus-style findings from the capture's
// focus probe. collect() runs in the page (self-contained); analyzeStructure() is pure.

import { baseView } from '../core/views.js';
import { KIND_LABELS } from '../core/focus.js';

function collect() {
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
  const text = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const byIds = (ids) => String(ids || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean);
  const name = (el) => el.getAttribute('aria-label')?.trim() || byIds(el.getAttribute('aria-labelledby')).map(text).join(' ')
    || text(el) || el.getAttribute('title')?.trim() || [...el.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ').trim();
  const sample = (el, label) => ({ selector: path(el), text: String(label ?? text(el)).slice(0, 80) });
  const bag = (els, f = (e) => sample(e)) => ({ count: els.length, samples: els.slice(0, 5).map(f) });

  const headings = [];
  const hiddenHeadings = [];
  for (const el of $$('h1, h2, h3, h4, h5, h6, [role="heading"]')) {
    if (headings.length >= 300 && hiddenHeadings.length >= 300) break;
    const level = Number(el.getAttribute('aria-level')) || (/^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : 2);
    const list = shown(el) ? headings : hiddenHeadings;
    if (list.length < 300) list.push({ level, text: name(el).slice(0, 200), selector: path(el) });
  }

  const labelOf = (el) => el.getAttribute('aria-label')?.trim() || byIds(el.getAttribute('aria-labelledby')).map(text).join(' ') || '';
  const topLevel = (el) => !el.parentElement?.closest('article, aside, main, nav, section');
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
  // Form fields with a broken reference are a11y-basics' "Form fields without a label"; don't count them twice.
  const nonField = (el) => !el.matches('input, select, textarea');
  const labelRefs = [...missing('aria-labelledby').filter(nonField), ...missing('aria-describedby').filter(nonField), ...$$('label[for]').filter((l) => l.htmlFor && !document.getElementById(l.htmlFor))];
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

  return {
    headings, hiddenHeadings, landmarks,
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
  };
}

const n = (b) => Number(b?.count) || 0;
const ev = (b) => (b?.samples?.length ? b.samples.map((s) => s.selector).join('\n') : undefined);

export function analyzeStructure(c, { mobile = false, focus } = {}) {
  const findings = [];
  const add = (severity, title, evidence, detail) => findings.push({ severity, category: 'accessibility', title, ...(evidence ? { evidence } : {}), ...(detail ? { detail } : {}) });
  const heads = c.headings || [];
  let skipped = 0;
  heads.forEach((x, i) => { if (i && x.level > heads[i - 1].level + 1) skipped++; });
  const empty = heads.filter((x) => !String(x.text || '').trim()).length;
  const seen = new Map();
  for (const x of heads) { const k = String(x.text || '').toLowerCase().replace(/\s+/g, ' ').trim(); if (k) seen.set(k, (seen.get(k) || 0) + 1); }
  const dupes = [...seen.values()].filter((v) => v > 1).length;
  if (skipped) add('low', `${skipped} skipped heading levels`);
  if (empty) add('medium', `${empty} empty headings`);
  if (dupes) add('info', `${dupes} duplicate heading texts`);

  const L = c.landmarks || {};
  if (!L.hasMain) add('low', 'No <main> landmark');
  if ((L.mains || 0) > 1) add('medium', `${L.mains} main landmarks`);
  const indistinct = (labels = []) => labels.length >= 2 && new Set(labels.filter(Boolean)).size < labels.length;
  if (indistinct(L.navs)) add('low', `${L.navs.length} navigation landmarks without distinct labels`);
  if (indistinct(L.asides)) add('low', `${L.asides.length} complementary landmarks without distinct labels`);
  if ((L.banners || 0) > 1) add('low', 'Multiple banner landmarks');
  if ((L.contentinfos || 0) > 1) add('low', 'Multiple contentinfo landmarks');

  if (n(c.labelInName)) add('medium', `${n(c.labelInName)} controls whose accessible name hides their visible label (WCAG 2.5.3)`, ev(c.labelInName));
  if (n(c.httpLinks)) add('low', `${n(c.httpLinks)} links use plain HTTP`, ev(c.httpLinks));
  if (n(c.multiText)) add('info', `${n(c.multiText)} URLs linked with different text`, ev(c.multiText));
  if (c.noCurrent) add('info', 'Current page link has no aria-current');
  if (n(c.labelRefs)) add('medium', `${n(c.labelRefs)} label or description references point to missing ids`, ev(c.labelRefs));
  if (n(c.ariaRefs)) add('low', `${n(c.ariaRefs)} ARIA references point to missing ids`, ev(c.ariaRefs));
  if (n(c.badAlt)) add('low', `${n(c.badAlt)} images with unhelpful alt text`, ev(c.badAlt));
  if (n(c.badAuto)) add('low', `${n(c.badAuto)} invalid autocomplete values (WCAG 1.3.5)`, ev(c.badAuto));
  if (c.resetButtons) add('info', 'Reset button present');

  if (n(c.targets24)) add('medium', `${n(c.targets24)} targets smaller than 24×24 px (WCAG 2.5.8)`, ev(c.targets24));
  if (mobile && n(c.targets44)) add('info', `${n(c.targets44)} targets under 44×44 px (advisory)`, ev(c.targets44));
  if (n(c.smallText)) add('low', `${n(c.smallText)} text elements under 12 px`);
  if (mobile && n(c.smallFields)) add('low', `${n(c.smallFields)} form fields under 16 px (iOS zooms in)`, ev(c.smallFields));
  if (n(c.focusJumps)) add('low', `Focus order jumps back up the page ${n(c.focusJumps)} times`, ev(c.focusJumps));
  if (n(c.noRole)) add('low', `${n(c.noRole)} focusable elements without a role`, ev(c.noRole));

  const samples = Array.isArray(focus?.samples) ? focus.samples : [];
  const blind = samples.filter((s) => !(s.changed || []).length);
  const outlineDetail = Number(focus?.outlineNone) > 0 ? `Stylesheets remove the focus outline in ${focus.outlineNone} rules without a replacement.` : undefined;
  if (samples.length >= 2 && blind.length === samples.length) {
    add('medium', 'No visible focus indicator on any sampled control (WCAG 2.4.7)', blind.map((s) => s.selector).join('\n'), outlineDetail);
  } else {
    for (const s of blind) add('low', `${KIND_LABELS[s.kind] || s.kind} show no visible focus indicator`, s.selector, outlineDetail);
  }

  const summary = [
    { label: 'Headings', value: `${heads.length}${skipped ? ` · ${skipped} skipped` : ''}` },
    { label: 'Landmarks', value: `main ${L.mains || 0} · nav ${(L.navs || []).length} · aside ${(L.asides || []).length}` },
    { label: 'Targets', value: `${n(c.targets24)} under 24 px` },
  ];
  if (samples.length) summary.push({ label: 'Focus', value: `${samples.length - blind.length} of ${samples.length} kinds visible`, headline: true, rating: blind.length === 0 ? 'good' : blind.length === samples.length ? 'poor' : 'needs-improvement' });
  return { data: { ...c, mobile, focus: samples.length ? { samples, outlineNone: Number(focus?.outlineNone) || 0 } : null, skipped, empty }, findings, summary };
}

function run(reading, ctx) {
  if (!ctx.collected) ctx.skip('no page data');
  const hp = reading.log?._harplus || {};
  return analyzeStructure(ctx.collected, { mobile: baseView(reading) === 'mobile', focus: hp.capture?.focus });
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

function render(r, h) {
  const d = r.data;
  const rows = [
    ['Label not in name', d.labelInName], ['Plain HTTP links', d.httpLinks], ['URLs with different text', d.multiText],
    ['Broken label/description refs', d.labelRefs], ['Broken ARIA refs', d.ariaRefs], ['Unhelpful alt text', d.badAlt],
    ['Invalid autocomplete', d.badAuto], ['Targets under 24 px', d.targets24], ['Small form fields', d.smallFields],
    ['Focus jumps', d.focusJumps], ['Focusable without role', d.noRole],
  ].filter(([, b]) => Number(b?.count) > 0);
  return h.html`
    ${h.sub('Heading outline', h.outline(d.headings || []))}
    ${(d.hiddenHeadings || []).length ? h.sub('Hidden headings (not counted)', h.list(d.hiddenHeadings.map((x) => `h${x.level} ${x.text || '(empty)'}`))) : ''}
    ${rows.length ? h.table(rows.map(([rule, b]) => ({ rule, count: String(b.count), samples: h.list(b.samples.map((s) => h.html`<code>${s.selector}</code> ${s.text}`)) })),
      [{ key: 'rule', label: 'Rule' }, { key: 'count', label: 'Count' }, { key: 'samples', label: 'Samples' }]) : h.html`<p class="muted">No structure issues.</p>`}`;
}

export default {
  id: 'a11y-structure',
  name: 'Structure',
  version: '0.1.0',
  phase: 'page',
  group: 'quality',
  area: 'accessibility',
  description: 'Headings, landmarks, label-in-name, links, ARIA references, alt text, autocomplete, target size, focus order and focus styles.',
  tags: ['accessibility'],
  timeoutMs: 15_000,
  collect,
  run,
  glance,
  render,
};
