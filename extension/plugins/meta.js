// Page metadata: <head> tags, Open Graph / Twitter cards, JSON-LD, headings, links, forms,
// contact and social signals. Runs in an isolated world (DOM access, no page JS).

import { SOCIAL, classify } from './kb/providers.js';
import { hostOf, truncate } from '../core/har-util.js';
import { previewModel, renderPreviews } from '../ui/previews.js';

function collect() {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const content = (s) => $(s)?.getAttribute('content') ?? null;
  const prefixed = (prefix) => {
    const out = {};
    for (const m of $$(`meta[property^="${prefix}"], meta[name^="${prefix}"]`)) {
      const k = m.getAttribute('property') || m.getAttribute('name');
      if (!(k in out)) out[k] = m.getAttribute('content');
    }
    return out;
  };
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();

  const jsonld = [];
  const jsonldErrors = [];
  for (const s of $$('script[type="application/ld+json"]')) {
    try { jsonld.push(JSON.parse(s.textContent)); } catch (e) { jsonldErrors.push(String(e.message).slice(0, 120)); }
  }
  const jsonldText = JSON.stringify(jsonld);

  const here = location.hostname;
  let internal = 0; let external = 0; let nofollow = 0;
  const externalUrls = new Set(); const emails = new Set(); const phones = new Set();
  for (const a of $$('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (/^mailto:/i.test(href)) { emails.add(decodeURIComponent(href.slice(7).split('?')[0])); continue; }
    if (/^tel:/i.test(href)) { phones.add(href.slice(4)); continue; }
    let u;
    try { u = new URL(href, document.baseURI); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (u.hostname === here) internal++;
    else { external++; if (externalUrls.size < 400) externalUrls.add(u.origin + u.pathname); }
    if (/nofollow/i.test(a.rel)) nofollow++;
  }

  const imgs = $$('img');
  const all = document.getElementsByTagName('*');
  const customElements = new Set();
  for (const el of all) if (el.localName.includes('-')) customElements.add(el.localName);
  const inline = $$('script:not([src])').filter((s) => !s.type || /javascript|module/.test(s.type));

  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.getAttribute('lang'),
    dir: document.documentElement.getAttribute('dir'),
    charset: document.characterSet,
    doctype: document.doctype?.name ?? null,
    compatMode: document.compatMode,
    base: $('base')?.href ?? null,
    description: content('meta[name="description" i]'),
    keywords: content('meta[name="keywords" i]'),
    robots: content('meta[name="robots" i]'),
    googlebot: content('meta[name="googlebot" i]'),
    viewport: content('meta[name="viewport" i]'),
    themeColor: content('meta[name="theme-color" i]'),
    colorScheme: content('meta[name="color-scheme" i]'),
    generator: $$('meta[name="generator" i]').map((m) => m.content),
    author: content('meta[name="author" i]'),
    applicationName: content('meta[name="application-name" i]'),
    appleItunesApp: content('meta[name="apple-itunes-app" i]'),
    referrer: content('meta[name="referrer" i]'),
    cspMeta: content('meta[http-equiv="content-security-policy" i]'),
    verification: Object.fromEntries($$('meta[name$="-verification" i], meta[name="msvalidate.01" i], meta[name="p:domain_verify" i]')
      .map((m) => [m.name, m.content])),
    canonical: $('link[rel="canonical" i]')?.href ?? null,
    manifest: $('link[rel="manifest" i]')?.href ?? null,
    amphtml: $('link[rel="amphtml" i]')?.href ?? null,
    og: prefixed('og:'),
    twitter: prefixed('twitter:'),
    article: prefixed('article:'),
    icons: $$('link[rel~="icon" i], link[rel~="apple-touch-icon" i], link[rel="mask-icon" i]')
      .map((l) => ({ rel: l.getAttribute('rel'), href: l.href, sizes: l.getAttribute('sizes') || undefined })),
    hreflang: $$('link[rel="alternate" i][hreflang]').map((l) => ({ hreflang: l.hreflang, href: l.href })),
    feeds: $$('link[rel="alternate" i][type*="rss"], link[rel="alternate" i][type*="atom"], link[rel="alternate" i][type*="feed+json"]')
      .map((l) => ({ type: l.type, title: l.title || undefined, href: l.href })),
    hints: $$('link[rel~="preconnect" i], link[rel~="dns-prefetch" i], link[rel~="preload" i], link[rel~="modulepreload" i], link[rel~="prefetch" i]')
      .slice(0, 100).map((l) => ({ rel: l.getAttribute('rel'), href: l.href, as: l.getAttribute('as') || undefined })),
    jsonld: jsonldText.length < 150_000 ? jsonld : [],
    jsonldTruncated: jsonldText.length >= 150_000,
    jsonldErrors,
    microdata: [...new Set($$('[itemtype]').map((e) => e.getAttribute('itemtype')))].slice(0, 50),
    // hidden: not rendered or inside aria-hidden, the same test Content uses for its outline (which lists only the shown ones).
    headings: $$('h1,h2,h3,h4,h5,h6').slice(0, 300).map((h) => ({
      level: Number(h.tagName[1]), text: clean(h.textContent).slice(0, 140),
      ...((h.checkVisibility ? !h.checkVisibility() : !h.getClientRects().length) || h.closest('[aria-hidden="true"]') ? { hidden: true } : {}),
    })),
    links: { internal, external, nofollow, externalUrls: [...externalUrls] },
    emails: [...emails].slice(0, 50),
    phones: [...phones].slice(0, 50),
    images: {
      total: imgs.length,
      missingAlt: imgs.filter((i) => !i.hasAttribute('alt')).length,
      lazy: imgs.filter((i) => i.loading === 'lazy').length,
      noDimensions: imgs.filter((i) => !i.hasAttribute('width') || !i.hasAttribute('height')).length,
      responsive: imgs.filter((i) => i.srcset || i.closest('picture')).length,
    },
    scripts: $$('script[src]').slice(0, 300).map((s) => ({
      src: s.src, async: s.async || undefined, defer: s.defer || undefined, type: s.type || undefined,
      integrity: s.integrity || undefined, crossorigin: s.crossOrigin || undefined,
    })),
    inlineScripts: { count: inline.length, bytes: inline.reduce((n, s) => n + s.textContent.length, 0) },
    stylesheets: $$('link[rel~="stylesheet" i]').map((l) => l.href).slice(0, 200),
    inlineStyles: $$('style').length,
    forms: $$('form').slice(0, 50).map((f) => ({
      action: f.action, method: (f.getAttribute('method') || 'get').toLowerCase(),
      password: !!f.querySelector('input[type="password" i]'), fields: f.elements.length, id: f.id || undefined,
    })),
    iframes: $$('iframe').slice(0, 50).map((i) => i.src).filter(Boolean),
    customElements: [...customElements].sort(),
    undefinedElements: document.querySelectorAll(':not(:defined)').length,
    domElements: all.length,
    counts: { title: [...document.querySelectorAll('title')].filter((t) => !t.closest('svg')).length, description: $$('meta[name="description" i]').length, viewport: $$('meta[name="viewport" i]').length },
    dupProps: (() => {
      const seen = new Map();
      for (const m of $$('meta[property^="og:" i], meta[name^="og:" i], meta[property^="twitter:" i], meta[name^="twitter:" i]')) {
        const k = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
        if (/^og:image(:|$)|^og:locale:alternate$|^article:tag$/.test(k)) continue; // arrays are allowed
        seen.set(k, (seen.get(k) || 0) + 1);
      }
      return [...seen].filter(([, n]) => n > 1).slice(0, 10).map(([k, n]) => `${k} ×${n}`);
    })(),
    words: (document.body?.innerText || '').split(/\s+/).filter(Boolean).length,
  };
}

const ORG_TYPES = /^(Organization|Corporation|LocalBusiness|NGO|EducationalOrganization|GovernmentOrganization|OnlineStore|Store|Restaurant|MedicalOrganization|NewsMediaOrganization|ProfessionalService)$/;

function walkJsonLd(value, visit) {
  if (Array.isArray(value)) return value.forEach((v) => walkJsonLd(v, visit));
  if (!value || typeof value !== 'object') return;
  visit(value);
  if (value['@graph']) walkJsonLd(value['@graph'], visit);
}

// Title and description lengths the findings use; tagChecks() checks against the same numbers.
export const TITLE_MIN = 15;
export const TITLE_MAX = 65;
export const DESC_MIN = 50;
export const DESC_MAX = 170;

/** Recommended tags the page lacks, with a paste-ready snippet filled from what the page already has. */
export function missingTags(d = {}, target = {}) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const og = d.og || {};
  const tw = d.twitter || {};
  const url = d.canonical || target.finalUrl || target.url || '…';
  let host = target.host || '…';
  try { host = new URL(url).host || host; } catch { /* keep */ }
  const want = [
    ['og:title', !og['og:title'], `<meta property="og:title" content="${esc(d.title || '…')}">`],
    ['og:description', !og['og:description'], `<meta property="og:description" content="${esc(d.description || '…')}">`],
    ['og:image', !og['og:image'], '<meta property="og:image" content="https://…">'],
    ['og:url', !og['og:url'], `<meta property="og:url" content="${esc(url)}">`],
    ['og:type', !og['og:type'], '<meta property="og:type" content="website">'],
    ['og:site_name', !og['og:site_name'], `<meta property="og:site_name" content="${esc(host)}">`],
    ['twitter:card', !tw['twitter:card'], `<meta name="twitter:card" content="${og['og:image'] ? 'summary_large_image' : 'summary'}">`],
    ['description', !d.description, '<meta name="description" content="…">'],
    ['canonical', !d.canonical, `<link rel="canonical" href="${esc(target.finalUrl || target.url || '…')}">`],
  ].filter(([, missing]) => missing).map(([tag, , html]) => ({ tag, html }));
  return { tags: want, snippet: want.map((w) => w.html).join('\n') };
}

function run(reading, ctx) {
  const c = ctx.collected;
  if (!c) ctx.skip('no page data');
  const findings = [];
  // places: the URLs a finding is about (a form's action, a share image, og:url and the canonical).
  const add = (severity, category, title, detail, places) => findings.push({ severity, category, title, detail, ...(places?.length ? { places } : {}) });

  const types = new Set();
  let org = null;
  const sameAs = new Set();
  walkJsonLd(c.jsonld, (node) => {
    for (const t of [].concat(node['@type'] || [])) types.add(String(t));
    if (!org && [].concat(node['@type'] || []).some((t) => ORG_TYPES.test(t))) {
      org = {
        name: node.name, legalName: node.legalName, url: node.url,
        logo: typeof node.logo === 'string' ? node.logo : node.logo?.url,
        telephone: node.telephone, email: node.email, foundingDate: node.foundingDate,
        address: typeof node.address === 'string' ? node.address
          : [node.address?.streetAddress, node.address?.addressLocality, node.address?.addressRegion,
            node.address?.addressCountry?.name || node.address?.addressCountry].filter(Boolean).join(', ') || undefined,
      };
    }
    for (const s of [].concat(node.sameAs || [])) sameAs.add(String(s));
  });

  const social = {};
  for (const url of [...c.links.externalUrls, ...sameAs]) {
    const m = classify(SOCIAL, hostOf(url));
    if (m && !social[m.label]) social[m.label] = url;
  }

  const h1 = c.headings.filter((h) => h.level === 1).length;
  if (!c.title) add('medium', 'seo', 'Missing <title>');
  else if (c.title.length > TITLE_MAX) add('low', 'seo', `Title is long (${c.title.length} characters)`, 'Search results usually truncate titles beyond ~60 characters.');
  else if (c.title.length < TITLE_MIN) add('low', 'seo', `Title is short (${c.title.length} characters)`);
  if (!c.description) add('low', 'seo', 'Missing meta description');
  else if (c.description.length > DESC_MAX) add('info', 'seo', `Meta description is long (${c.description.length} characters)`);
  const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (c.description && (c.description.length < DESC_MIN || squash(c.description) === squash(c.title))) {
    add('low', 'seo', 'Meta description is too short or repeats the title');
  }
  if (!c.canonical) add('low', 'seo', 'No canonical URL declared');
  else if (hostOf(c.canonical) !== hostOf(c.url)) add('info', 'seo', `Canonical points to another host (${hostOf(c.canonical)})`);
  if (`${c.robots || ''} ${c.googlebot || ''}`.toLowerCase().split(/[\s,]+/).some((t) => t === 'noindex' || t === 'none')) add('medium', 'seo', 'Page asks search engines not to index it (noindex)');
  if (!c.viewport) add('medium', 'quality', 'No viewport meta tag — page will not adapt to mobile screens');
  if (h1 === 0) add('low', 'seo', 'No <h1> on the page');
  else if (h1 > 1) add('info', 'seo', `${h1} <h1> elements on the page`);
  if (!c.og['og:title'] || !c.og['og:image']) add('low', 'seo', 'Incomplete Open Graph tags', 'Link previews on social and chat apps may look bare.');
  const normUrl = (u) => {
    try {
      const x = new URL(u, c.url);
      x.hash = '';
      for (const k of [...x.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(k)) x.searchParams.delete(k);
      x.searchParams.sort();
      if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/$/, '');
      return x.href;
    } catch { return String(u); }
  };
  if (c.og['og:url'] && c.canonical && normUrl(c.og['og:url']) !== normUrl(c.canonical)) {
    add('low', 'seo', 'og:url differs from the canonical URL', `${c.og['og:url']} vs ${c.canonical}`,
      [{ url: String(c.og['og:url']), note: 'og:url' }, { url: String(c.canonical), note: 'canonical' }]);
  }
  const relTags = [['og:image', c.og['og:image']], ['twitter:image', c.twitter?.['twitter:image']]].filter(([, v]) => v && !/^https?:\/\//i.test(v));
  const relImages = relTags.map(([, v]) => v);
  if (relImages.length) add('low', 'seo', 'Share image URL is relative (og:image / twitter:image must be absolute)', relImages.join(', '), relTags.map(([tag, v]) => ({ url: String(v), note: tag })));
  const dups = [
    c.counts?.title > 1 && `${c.counts.title} title`, c.counts?.description > 1 && `${c.counts.description} description`,
    c.counts?.viewport > 1 && `${c.counts.viewport} viewport`, ...(c.dupProps || []),
  ].filter(Boolean);
  if (dups.length) add('low', 'seo', `Duplicate meta tags: ${dups.join(', ')}`);
  if (!c.twitter?.['twitter:card']) add('low', 'seo', 'No Twitter card tag');
  if (!c.jsonld.length) add('info', 'seo', 'No structured data (JSON-LD)');
  if (!c.icons.length) add('low', 'quality', 'No favicon declared in <head>');
  for (const e of c.jsonldErrors) add('low', 'seo', 'JSON-LD block does not parse', e);
  if (c.compatMode === 'BackCompat') add('medium', 'quality', 'Page renders in quirks mode', 'Missing or invalid <!doctype html>.');
  if (c.charset && c.charset.toUpperCase() !== 'UTF-8') add('low', 'quality', `Document encoding is ${c.charset}, not UTF-8`);
  if (c.images.noDimensions > 0) add('low', 'performance', `${c.images.noDimensions} of ${c.images.total} images lack width/height attributes`, 'Unsized images cause layout shift while loading.');

  const pageIsHttps = c.url.startsWith('https:');
  for (const f of c.forms) {
    if (pageIsHttps && f.action.startsWith('http:')) add('high', 'security', 'Form submits over plain HTTP', f.action, [{ url: f.action }]);
    if (f.password && !pageIsHttps) add('high', 'security', 'Password field on a page served over HTTP');
    const actionHost = hostOf(f.action);
    if (actionHost && ctx.util.isThirdParty(actionHost, ctx.target.site)) {
      add('info', 'intel', `Form posts to a third party: ${actionHost}`, undefined, [{ url: f.action }]);
    }
  }

  const generator = c.generator.join(', ');
  const summary = [
    { label: 'Title', value: c.title ? truncate(c.title, 90) : 'missing', headline: true },
    { label: 'Description', value: truncate(c.description || '', 140) },
    { label: 'Language', value: c.lang || '—' },
    { label: 'Generator', value: generator },
    { label: 'Organization', value: org?.name || org?.legalName },
    { label: 'Structured data', value: [...types].slice(0, 8).join(', ') },
    { label: 'Social', value: Object.keys(social).join(', ') },
    { label: 'Contacts', value: [c.emails.length && `${c.emails.length} email`, c.phones.length && `${c.phones.length} phone`].filter(Boolean).join(', ') },
    { label: 'Words · elements', value: `${c.words.toLocaleString()} · ${c.domElements.toLocaleString()}` },
    { label: 'Custom elements', value: c.customElements.length ? `${c.customElements.length} (${c.customElements.slice(0, 5).join(', ')}${c.customElements.length > 5 ? '…' : ''})` : '' },
  ];

  return { data: { ...c, structuredTypes: [...types], organization: org, social }, findings, summary };
}

const isUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);
const asLink = (v, h) => (isUrl(v) ? h.link(v) : v);

/** The pass/fail state of the tags the findings test, one check each (the findings carry the detail). */
function tagChecks(d) {
  const len = (d.title || '').length;
  const desc = (d.description || '').length;
  const squash = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const noindex = `${d.robots || ''} ${d.googlebot || ''}`.toLowerCase().split(/[\s,]+/).some((t) => t === 'noindex' || t === 'none');
  const og = d.og || {};
  return [
    { label: 'Title', ok: len >= TITLE_MIN && len <= TITLE_MAX, note: len ? `${len} characters` : 'missing' },
    { label: 'Description', ok: desc >= DESC_MIN && desc <= DESC_MAX && squash(d.description) !== squash(d.title), note: desc ? `${desc} characters` : 'missing' },
    { label: 'Canonical', ok: !!d.canonical, note: d.canonical ? '' : 'missing' },
    { label: 'Viewport', ok: !!d.viewport, note: d.viewport ? '' : 'missing' },
    { label: 'Indexable', ok: !noindex, note: noindex ? 'noindex' : '' },
    { label: 'Open Graph', ok: !!(og['og:title'] && og['og:image']), note: [!og['og:title'] && 'no og:title', !og['og:image'] && 'no og:image'].filter(Boolean).join(', ') },
    { label: 'Twitter card', ok: !!d.twitter?.['twitter:card'], note: d.twitter?.['twitter:card'] || 'missing' },
    { label: 'Structured data', ok: (d.jsonld || []).length > 0, note: (d.jsonld || []).length ? '' : 'no JSON-LD' },
    { label: 'Favicon', ok: (d.icons || []).length > 0, note: (d.icons || []).length ? '' : 'missing' },
  ];
}

/**
 * Answer first: a check per tag the findings test. Then the values, the organisation and contacts; the full
 * Open Graph and Twitter tag lists are raw dumps, so they sit closed. The heading outline is Content's (one home per
 * fact); only the headings Content cannot show, the hidden ones, are listed here, closed.
 */
function render(r, h) {
  const d = r.data;
  const og = Object.entries(d.og || {});
  const tw = Object.entries(d.twitter || {});
  const hidden = (d.headings || []).filter((x) => x.hidden); // older readings carry no flag: nothing listed
  return h.html`
    ${h.checks(tagChecks(d))}
    ${h.kv([
    ['Title', d.title], ['Description', d.description], ['Canonical', h.link(d.canonical)],
    ['Language / dir', [d.lang, d.dir].filter(Boolean).join(' / ')], ['Charset', d.charset],
    ['Viewport', d.viewport], ['Robots', d.robots], ['Generator', (d.generator || []).join(', ')],
    ['Theme color', d.themeColor], ['Manifest', h.link(d.manifest)], ['App banner', d.appleItunesApp],
  ])}
    ${d.organization ? h.sub('Organization (JSON-LD)', h.kv(Object.entries(d.organization).map(([k, v]) => [k, asLink(v, h)]))) : ''}
    ${Object.keys(d.social || {}).length ? h.sub('Social profiles', h.kv(Object.entries(d.social).map(([k, v]) => [k, h.link(v)]))) : ''}
    ${d.emails.length || d.phones.length ? h.sub('Contact', h.list([...d.emails, ...d.phones])) : ''}
    ${og.length ? h.more('Open Graph', h.kv(og.map(([k, v]) => [k, asLink(v, h)])), `${og.length} tags`) : ''}
    ${tw.length ? h.more('Twitter / X card', h.kv(tw.map(([k, v]) => [k, asLink(v, h)])), `${tw.length} tags`) : ''}
    ${d.structuredTypes.length ? h.sub('Structured data types', h.tags(d.structuredTypes)) : ''}
    ${hidden.length ? h.more('Hidden headings', h.outline(hidden), String(hidden.length)) : ''}
    ${h.sub('Links & media', h.kv([
    ['Links', `${d.links.internal} internal · ${d.links.external} external · ${d.links.nofollow} nofollow`],
    ['Images', `${d.images.total} total · ${d.images.missingAlt} missing alt · ${d.images.lazy} lazy · ${d.images.responsive} responsive`],
    ['Scripts', `${d.scripts.length} external · ${d.inlineScripts.count} inline (${h.bytes(d.inlineScripts.bytes)})`],
    ['Stylesheets', `${d.stylesheets.length} linked · ${d.inlineStyles} inline`],
    ['Iframes', d.iframes.length], ['Feeds', h.list((d.feeds || []).map((f) => h.link(f.href)))],
    ['hreflang', d.hreflang.map((x) => x.hreflang).join(', ')],
  ]))}
    ${d.forms.length ? h.sub('Forms', h.table(d.forms.map((f) => ({ ...f, action: h.url(f.action) })), [{ key: 'method', label: 'method' }, { key: 'action', label: 'action' }, { key: 'fields', label: 'fields' }, { key: 'password', label: 'password' }])) : ''}
    ${d.hints.length ? h.sub('Resource hints', h.table(d.hints.map((x) => ({ ...x, href: h.url(x.href) })), [{ key: 'rel', label: 'rel' }, { key: 'href', label: 'href' }, { key: 'as', label: 'as' }])) : ''}
    ${d.customElements.length ? h.sub('Custom elements', h.tags(d.customElements)) : ''}
    ${(() => {
    const m = missingTags(d, { finalUrl: d.url });
    return m.tags.length ? h.sub(`Missing tags (${m.tags.length})`, h.html`<pre class="snippet">${m.snippet}</pre><button class="btn" type="button" data-copy="${m.snippet}">Copy tags</button>`) : '';
  })()}
  `;
}

/**
 * Share previews: one check line for the share image, then the seven platform previews in a closed disclosure,
 * so a page without an image does not spend a screen on text-only cards.
 */
function glance(r, h, ctx = {}) {
  const d = r.data || {};
  const ogImage = ctx.results?.links?.data?.ogImage;
  const m = previewModel(d, { target: ctx.target || { finalUrl: d.url }, ogImage, interactive: ctx.interactive === true });
  const declared = d.og?.['og:image'] || d.twitter?.['twitter:image'];
  // The check agrees with the findings: a relative URL fails (meta), and so does an image Link check could not load.
  const relative = declared && !/^https?:\/\//i.test(declared);
  const loads = !ogImage || (ogImage.status >= 200 && ogImage.status < 400);
  const size = ogImage?.width ? `${ogImage.width}×${ogImage.height}` : '';
  const note = !declared ? 'og:image is not set' : relative ? 'relative URL' : !loads ? `does not load (${ogImage.status || ogImage.error || 'failed'})` : size;
  const line = h.checks([{ label: declared ? 'Share image' : 'No share image', ok: !!declared && !relative && loads, note }]);
  const grid = h.html`<div class="pv-grid">${renderPreviews(m, h)}</div>`;
  // With an image the previews are the answer and stay open; without one they are text-only cards, so they sit closed.
  return h.html`<section class="card previews"><h4>Share previews</h4>${line}${declared ? grid : h.more('Previews', grid, '7 platforms')}</section>`;
}

export default {
  id: 'meta',
  group: 'quality',
  area: 'content',
  name: 'Page metadata',
  version: '0.1.0',
  phase: 'page',
  world: 'isolated',
  description: 'Head tags, social cards, JSON-LD, outline, links, forms, contact and social signals.',
  tags: ['seo', 'intel'],
  collect,
  run,
  render,
  glance,
};
