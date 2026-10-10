// HTML composition: how the markup is built. Semantic structure vs. generic containers, landmarks,
// inline styles/handlers, obsolete markup, ARIA, forms, media, scripts, web components and
// class-naming conventions. Element/attribute usage feeds the Baseline plugin.

function collect() {
  const all = [...document.getElementsByTagName('*')];
  const errors = [];
  const safe = (label, fn, fallback) => { try { return fn(); } catch (e) { errors.push(`${label}: ${e.message}`); return fallback; } };
  // Capped histograms: Map keeps size O(1), so huge pages stay linear.
  const counter = (cap) => { const m = new Map(); return { m, add(k, n = 1) { if (m.has(k)) m.set(k, m.get(k) + n); else if (m.size < cap) m.set(k, n); } }; };
  const obj = (c) => Object.fromEntries(c.m);
  const inc = (map, k, n = 1) => { map[k] = (map[k] || 0) + n; };
  const elements = counter(2000);
  const attrPairs = counter(600);
  const globalAttrs = counter(100);
  const handlers = counter(200);
  const dataAttrs = counter(300);
  const roles = counter(200);
  const classes = counter(20_000);
  let inlineStyles = 0; let aria = 0; let classAttrs = 0; let classTokens = 0; let lang = 0;
  const GLOBAL = new Set(['accesskey', 'autocapitalize', 'autofocus', 'contenteditable', 'dir', 'draggable', 'enterkeyhint',
    'exportparts', 'hidden', 'inert', 'inputmode', 'is', 'itemscope', 'itemprop', 'lang', 'nonce', 'part', 'popover',
    'slot', 'spellcheck', 'tabindex', 'title', 'translate', 'writingsuggestions']);
  let vueScoped = 0; let angularScoped = 0; let astroScoped = 0;
  all.forEach((el, i) => {
    try {
      const tag = el.localName;
      elements.add(tag);
      let vue = false; let ng = false; let astro = false;
      for (const a of el.attributes) {
        const n = a.name;
        if (i < 2000) {
          vue ||= /^data-v-[0-9a-f]{6,8}$/.test(n);
          ng ||= n.startsWith('_ngcontent-');
          astro ||= n.startsWith('data-astro-cid-');
        }
        if (n.startsWith('on')) { handlers.add(n); continue; }
        if (n.startsWith('data-')) { dataAttrs.add(n); continue; }
        if (n.startsWith('aria-')) { aria++; continue; }
        if (n === 'style') { inlineStyles++; continue; }
        if (n === 'role') { roles.add(`${a.value}`.trim().split(/\s+/)[0]); continue; }
        if (n === 'lang' && el !== document.documentElement) lang++;
        if (n === 'class') {
          classAttrs++;
          for (const c of el.classList || []) { classTokens++; classes.add(c); }
          continue;
        }
        if (GLOBAL.has(n)) globalAttrs.add(n);
        else if (!n.includes(':') && !n.startsWith('_ng') && !n.startsWith('ng-')) attrPairs.add(`${tag}.${n}`);
      }
      vueScoped += vue; angularScoped += ng; astroScoped += astro;
    } catch (e) { if (errors.length < 5) errors.push(`element: ${e.message}`); }
  });
  const q = (s) => safe(s, () => document.querySelectorAll(s).length, 0);
  const inputTypes = safe('inputs', () => { const o = {}; for (const i of document.querySelectorAll('input')) inc(o, (i.getAttribute('type') || 'text').toLowerCase()); return o; }, {});
  // <link> inside SVG/MathML is not an HTMLLinkElement and has no relList
  const linkRels = safe('links', () => { const o = {}; for (const l of document.querySelectorAll('link[rel]')) for (const r of (l.getAttribute('rel') || '').split(/\s+/)) if (r) inc(o, r.toLowerCase()); return o; }, {});
  const scriptTypes = safe('scripts', () => { const o = {}; for (const s of document.scripts) inc(o, (s.type || 'classic').toLowerCase()); return o; }, {});
  const imgExt = safe('images', () => {
    const o = {};
    for (const img of document.images) {
      const src = img.currentSrc || img.src || '';
      const ext = (src.match(/^data:image\/([\w+]+)/) || src.split(/[?#]/)[0].match(/\.(avif|webp|png|jpe?g|gif|svg|ico|bmp|jxl)$/i) || [])[1];
      inc(o, ext ? ext.toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg') : 'other');
    }
    return o;
  }, {});
  // Shadow roots, including roots nested inside other components' shadow roots (open only).
  let shadowRoots = 0; const shadowHosts = new Set();
  safe('shadow roots', () => {
    const queue = all.filter((el) => el.shadowRoot);
    while (queue.length && shadowRoots < 300) {
      const host = queue.shift();
      shadowRoots++; shadowHosts.add(host.localName);
      for (const el of host.shadowRoot.querySelectorAll('*')) if (el.shadowRoot) queue.push(el);
    }
  });
  const elementCounts = obj(elements);
  const customTags = Object.keys(elementCounts).filter((t) => t.includes('-'));
  const blankNoOpener = safe('links', () => [...document.querySelectorAll('a[target="_blank"]')].filter((a) => !/noopener|noreferrer/i.test(a.rel)).length, 0);
  const dataEntries = [...dataAttrs.m];
  return {
    total: all.length,
    elements: elementCounts,
    attrPairs: obj(attrPairs),
    globalAttrs: obj(globalAttrs),
    handlers: obj(handlers),
    dataAttrs: dataEntries.sort((a, b) => b[1] - a[1]).slice(0, 40),
    dataAttrCount: dataEntries.reduce((n, [, v]) => n + v, 0),
    roles: obj(roles),
    aria,
    inlineStyles,
    lang,
    classes: [...classes.m].sort((a, b) => b[1] - a[1]).slice(0, 4000).map(([c]) => c),
    classAttrs,
    classTokens,
    ids: q('[id]'),
    inputTypes,
    linkRels,
    scriptTypes,
    imgExt,
    media: {
      img: document.images.length, picture: q('picture'), srcset: q('img[srcset], source[srcset]'), sizes: q('[sizes]'),
      lazy: q('[loading="lazy"]'), decodingAsync: q('img[decoding="async"]'), fetchpriority: q('[fetchpriority]'),
      sized: q('img[width][height]'), svgInline: q('svg'), video: q('video'), audio: q('audio'), track: q('track'),
      canvas: q('canvas'), iframe: q('iframe'), iframeLazy: q('iframe[loading="lazy"]'), iframeSandbox: q('iframe[sandbox]'),
    },
    forms: { count: document.forms.length, autocomplete: q('[autocomplete]'), validation: q('[required], [pattern], input[min], input[max], [minlength], [maxlength]'), novalidate: q('form[novalidate]'), fieldset: q('fieldset'), labels: q('label') },
    components: {
      customTags,
      defined: customTags.filter((t) => { try { return !!document.querySelector(`${CSS.escape(t)}:defined`); } catch { return false; } }).length,
      undefinedCount: q(':not(:defined)'), shadowRoots, shadowHosts: [...shadowHosts], templates: q('template'), slots: q('slot'),
      dsd: q('template[shadowrootmode]'), customizedBuiltins: q('[is]'),
    },
    a11yHints: {
      blankNoOpener, fakeButtons: q('div[role="button"], span[role="button"], a[role="button"]:not([href])'),
      clickDivs: q('div[onclick], span[onclick]'), tabindex: q('[tabindex]'), ariaHidden: q('[aria-hidden="true"]'),
    },
    doctype: document.doctype ? `<!DOCTYPE ${document.doctype.name}${document.doctype.publicId ? ` PUBLIC "${document.doctype.publicId}"` : ''}>` : null,
    vueScoped: q('[data-v-app]') + vueScoped,
    angularScoped,
    astroScoped: q('[data-astro-cid], [data-astro-source-file]') + astroScoped,
    errors,
  };
}

const SEMANTIC = ['header', 'nav', 'main', 'article', 'section', 'aside', 'footer', 'figure', 'figcaption', 'details',
  'summary', 'dialog', 'time', 'mark', 'address', 'search', 'hgroup', 'menu', 'blockquote', 'cite', 'abbr', 'dl', 'dt', 'dd',
  'ol', 'ul', 'li', 'table', 'caption', 'thead', 'tbody', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'button', 'label',
  'output', 'progress', 'meter', 'data', 'picture', 'code', 'pre', 'kbd', 'samp', 'var', 'em', 'strong', 'small', 'q', 'dfn'];
const OBSOLETE = ['center', 'font', 'marquee', 'blink', 'frame', 'frameset', 'noframes', 'big', 'strike', 'tt', 'acronym',
  'applet', 'basefont', 'dir', 'isindex', 'listing', 'plaintext', 'xmp', 'nobr', 'spacer', 'bgsound', 'keygen', 'menuitem'];
const PRESENTATIONAL = ['align', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'valign', 'hspace', 'vspace', 'background', 'color', 'face', 'nowrap'];

/** Guess the class-naming convention(s) from class tokens. */
export function classConventions(classes, extras = {}) {
  const scoped = [extras.vueScoped && 'Vue scoped styles', extras.angularScoped && 'Angular emulated encapsulation'].filter(Boolean);
  if (classes.length < 30) return scoped; // too few classes to call a convention
  const n = classes.length;
  const share = (re) => classes.filter((c) => re.test(c)).length / n;
  const out = [];
  const utility = share(/^(-?(m|p)[trblxyse]?-|w-|h-|min-|max-|text-|bg-|flex|grid|gap-|rounded|shadow|font-|leading-|tracking-|border|items-|justify-|place-|inset|top-|left-|right-|bottom-|z-|opacity-|space-[xy]|col-span|row-span|overflow-|cursor-|transition|duration-|ease-|ring|sr-only|hidden$|block$|inline|absolute$|relative$|fixed$|sticky$)/);
  const variants = share(/^[a-z0-9-]+:[\w[\]-]/);
  const arbitrary = share(/\[[^\]]+\]/);
  if (variants > 0.02 || (utility > 0.35 && arbitrary > 0.005)) out.push('utility-first (Tailwind-style)');
  else if (utility > 0.35) out.push('utility classes');
  if (share(/^[a-z][a-z0-9]*(-[a-z0-9]+)*(__[a-z0-9]+(-[a-z0-9]+)*)?(--[a-z0-9]+(-[a-z0-9]+)*)?$/) > 0.15 && share(/__|--/) > 0.08) out.push('BEM');
  if (share(/^[A-Za-z][\w]*_[A-Za-z][\w]*__[\w-]{5}$/) > 0.05) out.push('CSS Modules');
  if (share(/^sc-[a-zA-Z0-9]{5,}$/) > 0.01) out.push('styled-components');
  if (share(/^css-[a-z0-9]{5,}(-[\w]+)?$/) > 0.02) out.push('Emotion (CSS-in-JS)');
  if (share(/^makeStyles-|^jss\d+$/) > 0.01) out.push('JSS');
  if (share(/^Mui[A-Z]/) > 0.02) out.push('Material UI');
  if (share(/^svelte-[a-z0-9]{5,}$/) > 0.01) out.push('Svelte scoped styles');
  if (share(/^astro-[A-Z0-9]{8}$/) > 0.005 || extras.astroScoped) out.push('Astro scoped styles');
  if (extras.vueScoped) out.push('Vue scoped styles');
  if (extras.angularScoped) out.push('Angular emulated encapsulation');
  if (share(/^(col-(xs|sm|md|lg|xl|xxl)-\d+|btn-(primary|secondary|outline)|navbar|container-fluid|d-(none|flex|block)|mb-\d|mt-\d)$/) > 0.03) out.push('Bootstrap classes');
  if (share(/^(wp-block-|has-[\w-]+-(color|background-color|font-size)$|is-layout-)/) > 0.02) out.push('WordPress block classes');
  if (share(/^w-(nav|button|container|richtext|embed|inline-block|layout)/) > 0.02) out.push('Webflow classes');
  if (share(/^(u|o|c|l|is|has|js)-[a-z]/) > 0.2) out.push('namespaced (ITCSS / SMACSS-style)');
  return out;
}

function run(reading, ctx) {
  const c = ctx.collected;
  if (!c) ctx.skip('no page data');
  const count = (tags) => tags.reduce((n, t) => n + (c.elements[t] || 0), 0);
  const generic = count(['div', 'span']);
  const semantic = count(SEMANTIC);
  const pct = (n, d = c.total) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const landmarks = Object.fromEntries(['header', 'nav', 'main', 'aside', 'footer', 'search', 'form', 'section'].filter((t) => c.elements[t]).map((t) => [t, c.elements[t]]));
  const obsolete = OBSOLETE.filter((t) => c.elements[t]).map((t) => `<${t}> ×${c.elements[t]}`);
  const presentational = Object.entries(c.attrPairs).filter(([k]) => PRESENTATIONAL.includes(k.split('.')[1])).map(([k, n]) => `${k} ×${n}`);
  const handlers = Object.values(c.handlers).reduce((n, v) => n + v, 0);
  const conventions = classConventions(c.classes, { vueScoped: c.vueScoped, angularScoped: c.angularScoped, astroScoped: c.astroScoped });
  const heads = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((h) => c.elements[h] || 0);

  const findings = [];
  const add = (severity, category, title, detail, evidence) => findings.push({ severity, category, title, detail, evidence });
  if (c.total > 300 && pct(generic) > 60 && pct(semantic) < 15) add('low', 'quality', `Mostly generic markup: ${pct(generic)}% <div>/<span>, ${pct(semantic)}% semantic elements`, 'Semantic elements give structure to assistive technology, search and reader modes.');
  if (!c.elements.main) add('low', 'accessibility', 'No <main> element');
  if (handlers) add('low', 'quality', `${handlers} inline event-handler attributes`, 'on* attributes mix behaviour into markup and block a strict CSP.', Object.entries(c.handlers).map(([k, n]) => `${k} ×${n}`).join(', '));
  if (c.inlineStyles > 50) add('info', 'quality', `${c.inlineStyles} inline style attributes`);
  if (obsolete.length) add('low', 'quality', 'Obsolete HTML elements', undefined, obsolete.join(', '));
  if (presentational.length) add('info', 'quality', 'Presentational HTML attributes (use CSS instead)', undefined, presentational.slice(0, 15).join(', '));
  if (c.a11yHints.fakeButtons + c.a11yHints.clickDivs) add('low', 'accessibility', `${c.a11yHints.fakeButtons + c.a11yHints.clickDivs} non-button elements acting as buttons`, 'A real <button> brings focus, keyboard and semantics for free.');
  if (c.media.img > 10 && !c.media.lazy) add('info', 'performance', `${c.media.img} images and none lazy-loaded`);
  if (c.doctype && c.doctype !== '<!DOCTYPE html>') add('info', 'quality', `Legacy doctype: ${c.doctype}`);
  if (c.components.undefinedCount > 0 && c.components.customTags.length) add('info', 'quality', `${c.components.undefinedCount} custom elements were never defined`, 'Undefined custom elements render as plain inline elements.');

  const imgFormats = Object.entries(c.imgExt).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
  return {
    data: { ...c, generic, semantic, landmarks, obsolete, presentational, conventions, headings: heads, inlineHandlers: handlers },
    findings,
    summary: [
      { label: 'Elements', headline: true, value: `${c.total.toLocaleString()} · ${pct(semantic)}% semantic · ${pct(generic)}% div/span` },
      { label: 'Landmarks', value: Object.entries(landmarks).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ') || 'none' },
      { label: 'Headings h1–h6', value: heads.join(' · ') },
      { label: 'Class style', value: conventions.join(', ') || (c.classTokens ? 'no clear convention' : 'no classes') },
      { label: 'Web components', value: c.components.customTags.length ? `${c.components.customTags.length} custom tags · ${c.components.shadowRoots} shadow roots` : '' },
      { label: 'Scripts', value: Object.entries(c.scriptTypes).map(([k, n]) => `${k} ${n}`).join(', ') },
      { label: 'Images', value: c.media.img ? `${c.media.img} (${imgFormats}) · ${c.media.lazy} lazy · ${c.media.picture} <picture> · ${c.media.srcset} srcset` : '' },
      { label: 'Forms', value: c.forms.count ? `${c.forms.count} · ${Object.entries(c.inputTypes).map(([k, n]) => `${k} ${n}`).join(', ')}` : '' },
      { label: 'Inline', value: `${c.inlineStyles} style attrs · ${handlers} on* handlers · ${c.aria} aria-* attrs` },
    ],
  };
}

const MEDIA_LABELS = {
  img: '<img>', picture: '<picture>', srcset: 'srcset', sizes: 'sizes', lazy: 'loading=lazy', decodingAsync: 'decoding=async',
  fetchpriority: 'fetchpriority', sized: 'images with width+height', svgInline: 'inline <svg>', video: '<video>', audio: '<audio>',
  track: '<track> (captions)', canvas: '<canvas>', iframe: '<iframe>', iframeLazy: 'lazy iframes', iframeSandbox: 'sandboxed iframes',
};
const FORM_LABELS = { count: 'forms', autocomplete: 'autocomplete attrs', validation: 'native validation attrs', novalidate: 'novalidate forms', fieldset: '<fieldset>', labels: '<label>' };

function render(r, h) {
  const d = r.data;
  const top = (obj, n = 40) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ×${v}`);
  return h.html`
    ${h.kv([
      ['Doctype', d.doctype], ['Elements', d.total], ['Semantic / generic', `${d.semantic} / ${d.generic}`],
      ['Landmarks', Object.entries(d.landmarks).map(([k, n]) => `${k} ×${n}`).join(', ')],
      ['Headings h1–h6', d.headings.join(' · ')], ['Class conventions', d.conventions.join(', ')],
      ['Classes per element', d.classAttrs ? (d.classTokens / d.classAttrs).toFixed(1) : ''], ['IDs', d.ids],
      ['data-* attributes', `${d.dataAttrCount}`], ['ARIA attributes', d.aria], ['Roles', top(d.roles, 15).join(', ')],
      ['Elements with lang', d.lang],
    ])}
    ${h.sub('Element usage', h.tags(top(d.elements, 60)))}
    ${h.sub('Web components', h.kv([
      ['Custom elements', d.components.customTags.join(', ')], ['Defined', d.components.defined],
      ['Shadow roots (open)', d.components.shadowRoots], ['Hosts', d.components.shadowHosts.join(', ')],
      ['<template> / <slot>', `${d.components.templates} / ${d.components.slots}`], ['Customized built-ins (is=)', d.components.customizedBuiltins],
    ]))}
    ${h.sub('Media', h.kv(Object.entries(d.media).filter(([, v]) => v).map(([k, v]) => [MEDIA_LABELS[k] || k, v])
      .concat([['image formats', Object.entries(d.imgExt).map(([k, n]) => `${k} ${n}`).join(', ')]])))}
    ${d.forms.count ? h.sub('Forms', h.kv([...Object.entries(d.forms).filter(([, v]) => v).map(([k, v]) => [FORM_LABELS[k] || k, v]),
      ['input types', Object.entries(d.inputTypes).map(([k, n]) => `${k} ${n}`).join(', ')]])) : ''}
    ${h.sub('Scripts & links', h.kv([['script types', Object.entries(d.scriptTypes).map(([k, n]) => `${k} ${n}`).join(', ')], ['link rel', top(d.linkRels, 20).join(', ')]]))}
    ${d.dataAttrs.length ? h.sub('Top data-* attributes', h.tags(d.dataAttrs.map(([k, n]) => `${k} ×${n}`))) : ''}
    ${Object.keys(d.handlers).length ? h.sub('Inline event handlers', h.tags(top(d.handlers))) : ''}
    ${d.obsolete.length ? h.sub('Obsolete elements', h.tags(d.obsolete)) : ''}
    ${h.sub('Sample classes', h.tags(d.classes.slice(0, 60)))}
    ${d.errors?.length ? h.html`<p class="note">Parts that could not be read: ${d.errors.join('; ')}</p>` : ''}
  `;
}

function glance(r, h) {
  const d = r.data;
  const pct = (n) => `${d.total ? Math.round((n / d.total) * 100) : 0}%`;
  const other = Math.max(0, d.total - d.semantic - d.generic);
  return h.html`<section class="card"><h4>HTML elements · ${d.total.toLocaleString('en-US')}</h4>
    ${h.stackBar({ label: '', segments: [
      { label: 'Semantic', value: d.semantic, display: pct(d.semantic), color: 'var(--c1)' },
      { label: 'div / span', value: d.generic, display: pct(d.generic), color: 'var(--c2)' },
      { label: 'Other', value: other, display: pct(other), color: 'var(--c-other)' },
    ] })}
    <h4>Landmarks</h4>${h.checklist(['header', 'nav', 'main', 'footer'].map((t) => ({ label: `<${t}>`, ok: !!d.landmarks?.[t] })))}
  </section>`;
}

export default {
  id: 'html',
  group: 'build',
  name: 'HTML composition',
  version: '0.1.1',
  phase: 'page',
  world: 'isolated',
  description: 'Semantic structure, landmarks, class conventions (BEM, utility, CSS-in-JS), web components, media, forms, inline styles/handlers, obsolete markup.',
  tags: ['quality', 'composition'],
  collect,
  run,
  render,
  glance,
};
