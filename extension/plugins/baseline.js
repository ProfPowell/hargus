// Web platform features used by the page, labelled with Baseline status from the W3C WebDX
// web-features dataset (Apache-2.0, downloaded at runtime and cached). Collects browser-compat-data
// keys from the HTML, CSS and JavaScript plugins plus HTTP traffic and maps them to features:
//   Widely available (Baseline high) · Newly available (Baseline low) · Limited availability.

import { cachedJSON } from './kb/reference.js';
import { resourceType, resHeader } from '../core/har-util.js';

export const DEFAULT_DATA = 'https://cdn.jsdelivr.net/npm/web-features@3/data.json';
const FALLBACK_DATA = 'https://unpkg.com/web-features@3/data.json';

let indexMemo = null;

async function loadIndex(ctx) {
  const url = ctx.options.dataUrl || DEFAULT_DATA;
  if (indexMemo?.url === url) return indexMemo;
  let data;
  try {
    data = await cachedJSON(ctx.fetch, url);
  } catch (e) {
    if (url !== DEFAULT_DATA) throw e;
    data = await cachedJSON(ctx.fetch, FALLBACK_DATA);
  }
  const byKey = new Map();
  for (const [id, f] of Object.entries(data.features || {})) {
    if (f.kind && f.kind !== 'feature') continue;
    for (const key of f.compat_features || []) byKey.set(key, [...(byKey.get(key) || []), id]);
  }
  indexMemo = { url, features: data.features, groups: data.groups || {}, byKey };
  return indexMemo;
}

const VIEWPORT = { d: 'dynamic', s: 'small', l: 'large' };
const unitKey = (unit) => {
  const v = unit.match(/^([dsl])v(h|w|i|b|min|max)$/);
  if (v) return `css.types.length.viewport_percentage_units_${VIEWPORT[v[1]]}`;
  if (/^cq(i|w|h|b|min|max)$/.test(unit)) return 'css.types.length.container_query_length_units';
  return `css.types.length.${unit}`;
};
const FN_PREFIXES = ['css.types.', 'css.types.color.', 'css.types.gradient.', 'css.types.image.', 'css.types.transform-function.',
  'css.types.easing-function.', 'css.types.filter-function.', 'css.types.basic-shape.'];

/** Candidate browser-compat-data keys from the other plugins' observations. */
export function candidateKeys(reading, results) {
  const keys = new Map(); // key → Set(source)
  const add = (key, source) => { if (!keys.has(key)) keys.set(key, new Set()); keys.get(key).add(source); };

  const css = results.css?.data;
  if (css) {
    const u = css.usage;
    for (const prop of Object.keys(u.properties)) {
      if (prop.startsWith('--')) { add('css.properties.custom-property', 'css'); continue; }
      const p = prop.replace(/^-(webkit|moz|ms|o)-/, '');
      add(p === 'font-display' ? 'css.at-rules.font-face.font-display' : `css.properties.${p}`, 'css');
      for (const kw of u.values[prop] || []) add(`css.properties.${p}.${kw}`, 'css');
    }
    for (const fn of Object.keys(u.functions)) for (const pre of FN_PREFIXES) add(`${pre}${fn}`, 'css');
    for (const unit of Object.keys(u.units)) add(unitKey(unit), 'css');
    for (const pc of Object.keys(u.pseudoClasses)) add(`css.selectors.${pc}`, 'css');
    for (const pe of Object.keys(u.pseudoElements)) add(`css.selectors.${pe}`, 'css');
    for (const at of Object.keys(css.atRules)) add(`css.at-rules.${at}`, 'css');
    for (const f of Object.keys(css.mediaFeatures)) add(f === 'range-syntax' ? 'css.at-rules.media.range_syntax' : `css.at-rules.media.${f}`, 'css');
    if (css.stats?.nested) add('css.selectors.nesting', 'css');
  }

  const html = results.html?.data;
  if (html) {
    for (const tag of Object.keys(html.elements)) add(`html.elements.${tag}`, 'html');
    for (const pair of Object.keys(html.attrPairs)) add(`html.elements.${pair}`, 'html');
    for (const g of Object.keys(html.globalAttrs)) add(`html.global_attributes.${g}`, 'html');
    for (const t of Object.keys(html.inputTypes)) add(`html.elements.input.type_${t}`, 'html');
    for (const r of Object.keys(html.linkRels)) add(`html.elements.link.rel.${r}`, 'html');
    for (const t of Object.keys(html.scriptTypes)) if (t !== 'classic') add(`html.elements.script.type.${t}`, 'html');
    if (html.components?.customTags?.length && html.components.defined) add('api.CustomElementRegistry.define', 'html');
    if (html.components?.shadowRoots) add('api.Element.attachShadow', 'html');
    if (html.components?.dsd) add('html.elements.template.shadowrootmode', 'html');
  }

  for (const key of Object.keys(results.javascript?.data?.apis || {})) add(key, 'js (referenced)');

  for (const e of reading.log.entries) {
    const enc = (resHeader(e, 'content-encoding') || '').toLowerCase();
    if (enc === 'br' || enc === 'zstd') add(`http.headers.Content-Encoding.${enc}`, 'http');
    if (resourceType(e) === 'image') {
      const mime = e.response.content?.mimeType || '';
      if (/avif/.test(mime)) add('feature:avif', 'http');
      if (/webp/.test(mime)) add('feature:webp', 'http');
      if (/jxl/.test(mime)) add('feature:jpegxl', 'http');
    }
    if (/^h3/i.test(e.response.httpVersion || '')) add('feature:http3', 'http');
  }
  return keys;
}

async function run(reading, ctx) {
  if (!ctx.results.css && !ctx.results.html && !ctx.results.javascript) ctx.skip('needs the HTML, CSS or JavaScript plugins');
  const index = await loadIndex(ctx);
  const keys = candidateKeys(reading, ctx.results);
  const found = new Map();
  for (const [key, sources] of keys) {
    const ids = key.startsWith('feature:') ? [key.slice(8)] : index.byKey.get(key) || [];
    for (const id of ids) {
      const f = index.features[id];
      if (!f) continue;
      const rec = found.get(id) || { id, name: f.name, keys: [], sources: new Set(), status: f.status || {}, group: [].concat(f.group || [])[0] };
      if (rec.keys.length < 6) rec.keys.push(key);
      sources.forEach((s) => rec.sources.add(s));
      found.set(id, rec);
    }
  }
  const features = [...found.values()].map((f) => ({
    id: f.id,
    name: f.name,
    baseline: f.status.baseline === 'high' ? 'widely' : f.status.baseline === 'low' ? 'newly' : 'limited',
    since: f.status.baseline_high_date || f.status.baseline_low_date || null,
    group: index.groups[f.group]?.name || f.group || '',
    sources: [...f.sources],
    keys: f.keys,
  })).sort((a, b) => String(b.since || '9999').localeCompare(String(a.since || '9999')));

  const by = (b) => features.filter((f) => f.baseline === b);
  const widely = by('widely');
  const newly = by('newly');
  const limited = by('limited');
  const used = (list) => list.filter((f) => !(f.sources.length === 1 && f.sources[0] === 'js (referenced)'));
  const findings = [];
  const limitedUsed = used(limited);
  if (limitedUsed.length) {
    findings.push({
      severity: 'info', category: 'quality',
      title: `${limitedUsed.length} features with limited browser availability`,
      detail: 'Not Baseline yet — check they are progressive enhancements with fallbacks.',
      evidence: limitedUsed.map((f) => `${f.name} (${f.sources.join(', ')})`).join('\n'),
    });
  }
  const newest = used(newly);
  if (newest.length) {
    findings.push({
      severity: 'info', category: 'quality', title: `${newest.length} newly available Baseline features`,
      detail: 'Supported in all core browsers, but recently — older browsers in the wild may lack them.',
      evidence: newest.map((f) => `${f.name} (since ${String(f.since).slice(0, 10)})`).join('\n'),
    });
  }
  const names = (list, n = 8) => list.slice(0, n).map((f) => f.name).join(', ') + (list.length > n ? '…' : '');
  return {
    data: { features, source: index.url },
    findings,
    summary: [
      { label: 'Features detected', headline: true, value: `${features.length} (${widely.length} widely · ${newly.length} newly · ${limited.length} limited)` },
      { label: 'Newly available', value: names(newly) },
      { label: 'Limited availability', value: names(limited) },
      { label: 'Newest widely available', value: names(widely, 6) },
    ],
  };
}

function render(r, h) {
  const d = r.data;
  const label = { widely: 'Widely available', newly: 'Newly available', limited: 'Limited availability' };
  const section = (b) => {
    const list = d.features.filter((f) => f.baseline === b);
    if (!list.length) return '';
    return h.sub(`${label[b]} (${list.length})`, h.table(list.map((f) => ({
      feature: h.link(`https://web-platform-dx.github.io/web-features-explorer/features/${f.id}/`, f.name),
      since: f.since ? String(f.since).slice(0, 10) : '—',
      group: f.group,
      'seen in': f.sources.join(', '),
      via: h.html`<code>${f.keys.slice(0, 3).join(' ')}</code>`,
    })), ['feature', 'since', 'group', 'seen in', 'via']));
  };
  return h.html`
    <p class="note">Baseline status from the W3C WebDX web-features data (${h.link(d.source)}). "js (referenced)" means the API name appears in script source — feature detection and polyfills count too.</p>
    ${section('limited')}${section('newly')}${section('widely')}
  `;
}

function glance(r, h) {
  const fs = r.data?.features || [];
  const n = (b) => fs.filter((f) => f.baseline === b).length;
  return h.html`<section class="card"><h4>Platform features · ${fs.length}</h4>${h.stackBar({ label: 'Baseline', segments: [
    { label: 'Widely available', value: n('widely'), color: 'var(--c3)' },
    { label: 'Newly available', value: n('newly'), color: 'var(--c4)' },
    { label: 'Limited', value: n('limited'), color: 'var(--c2)' },
  ] })}</section>`;
}

export default {
  id: 'baseline',
  group: 'build',
  name: 'Platform features (Baseline)',
  version: '0.1.0',
  phase: 'analyze',
  after: ['javascript'],
  description: 'Web platform features used by the page (HTML, CSS, JS, HTTP) with Baseline availability from the W3C web-features dataset.',
  disclosure: 'Downloads the web-features dataset (≈5 MB, weekly, cached) from jsDelivr. Nothing about the page is sent.',
  tags: ['composition', 'quality'],
  options: [{ key: 'dataUrl', label: 'web-features data.json URL', type: 'text', default: DEFAULT_DATA }],
  timeoutMs: 60_000,
  run,
  render,
  glance,
};
