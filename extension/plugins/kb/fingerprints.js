// Loader and matcher for Wappalyzer-format technology fingerprints.
// Default source: the community-maintained webappanalyzer database (github.com/enthec/webappanalyzer,
// ~7,600 technologies). That data is GPL-3.0, so HARgus does not ship it: it is downloaded at
// runtime, cached for a week, and only the matcher below lives in this repo.
// Pattern syntax: "regex\;version:\1\;confidence:50" (https://github.com/enthec/webappanalyzer/blob/main/README.md)

export const DEFAULT_SOURCE = 'https://raw.githubusercontent.com/enthec/webappanalyzer/main/src';
const FILES = ['_', ...'abcdefghijklmnopqrstuvwxyz'];
import { cachedJSON, TTL } from './reference.js';

let memo = null;

export async function loadFingerprints(fetchFn, source = DEFAULT_SOURCE) {
  source = String(source || DEFAULT_SOURCE).replace(/\/$/, '');
  if (memo?.source === source && Date.now() - memo.at < TTL) return memo.db;
  const [categories, ...parts] = await Promise.all([
    cachedJSON(fetchFn, `${source}/categories.json`),
    ...FILES.map((f) => cachedJSON(fetchFn, `${source}/technologies/${f}.json`)),
  ]);
  const db = compile({ categories, technologies: Object.assign({}, ...parts), source });
  memo = { source, at: Date.now(), db };
  return db;
}

/* ------------------------------------------------------------ compiling */

const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function parsePattern(raw) {
  const [source, ...tags] = String(raw ?? '').split('\\;');
  const p = { source, version: '', confidence: 100, re: null };
  for (const t of tags) {
    const i = t.indexOf(':');
    const key = i < 0 ? t : t.slice(0, i);
    const val = i < 0 ? '' : t.slice(i + 1);
    if (key === 'version') p.version = val;
    else if (key === 'confidence') p.confidence = Number(val) || 0;
  }
  try { p.re = new RegExp(source, 'i'); } catch { p.re = null; }
  return p;
}

const patterns = (v) => list(v).map(parsePattern);
const keyed = (obj, lower = true) => Object.entries(obj || {}).map(([k, v]) => [lower ? k.toLowerCase() : k, patterns(v)]);

function compileDom(dom) {
  if (!dom) return [];
  const plain = (sel) => ({ sel, exists: true, text: null, attributes: [], properties: [] });
  if (typeof dom === 'string' || Array.isArray(dom)) return list(dom).filter((s) => typeof s === 'string').map(plain);
  return Object.entries(dom).map(([sel, spec]) => (!spec || typeof spec !== 'object' ? plain(sel) : {
    sel,
    exists: 'exists' in spec,
    text: spec.text != null ? parsePattern(spec.text) : null,
    attributes: keyed(spec.attributes, false),
    properties: keyed(spec.properties, false),
  }));
}

export function compile({ categories = {}, technologies = {}, source }) {
  const techs = Object.entries(technologies).map(([name, t]) => ({
    name,
    cats: list(t.cats),
    website: t.website,
    description: t.description,
    oss: t.oss,
    saas: t.saas,
    cpe: t.cpe,
    url: patterns(t.url),
    html: patterns(t.html),
    css: patterns(t.css),
    scriptSrc: patterns(t.scriptSrc),
    scripts: patterns(t.scripts),
    xhr: patterns(t.xhr),
    certIssuer: patterns(t.certIssuer),
    headers: keyed(t.headers),
    cookies: keyed(t.cookies),
    meta: keyed(t.meta),
    js: keyed(t.js, false),
    dom: compileDom(t.dom),
    implies: list(t.implies),
    requires: list(t.requires),
    requiresCategory: list(t.requiresCategory),
    excludes: list(t.excludes),
  }));
  return { categories, techs, source, count: techs.length };
}

/** What the in-page probe must collect for this database: global paths and DOM selectors. */
export function probeNeeds(db) {
  const globals = new Set();
  const dom = new Map();
  for (const t of db.techs) {
    for (const [path] of t.js) globals.add(path);
    for (const d of t.dom) {
      const need = dom.get(d.sel) || { sel: d.sel, attrs: new Set(), props: new Set(), text: false };
      d.attributes.forEach(([a]) => need.attrs.add(a));
      d.properties.forEach(([p]) => need.props.add(p));
      if (d.text) need.text = true;
      dom.set(d.sel, need);
    }
  }
  return {
    globals: [...globals],
    dom: [...dom.values()].map((d) => ({ sel: d.sel, attrs: [...d.attrs], props: [...d.props], text: d.text })),
  };
}

/* ------------------------------------------------------------- matching */

function resolveVersion(template, m) {
  if (!template) return '';
  let v = template;
  for (let i = m.length - 1; i >= 0; i--) {
    v = v.replace(new RegExp(`\\\\${i}\\?([^:]*):(.*)`), (_, yes, no) => (m[i] ? yes : no));
    v = v.split(`\\${i}`).join(m[i] || '');
  }
  return v.trim();
}

/**
 * signals: { url, html, css, scriptSrc[], scripts[], xhr[], certIssuer, headers{name:[values]},
 *            cookies{name:value}, meta{name:[values]}, js{path:value}, dom{sel:[{attrs,props,text}]} }
 * Returns detections: [{ name, categories, version, confidence, evidence[], website, description }]
 */
export function match(db, signals, { maxScriptChars = 600_000, maxValueChars = 2_000 } = {}) {
  const hits = new Map();
  const hit = (t, p, value, evidence) => {
    if (!p.re) return false;
    const m = String(value ?? '').match(p.re);
    if (!m) return false;
    const h = hits.get(t.name) || { tech: t, confidence: 0, version: '', evidence: [] };
    h.confidence = Math.min(100, h.confidence + p.confidence);
    const v = resolveVersion(p.version, m);
    if (v && (!h.version || v.length > h.version.length)) h.version = v;
    if (h.evidence.length < 4 && !h.evidence.includes(evidence)) h.evidence.push(evidence);
    hits.set(t.name, h);
    return true;
  };
  // Community patterns are not written for adversarial input: cap every short signal so a single
  // pathological value (a megabyte-long URL or header) cannot stall matching.
  const cap = (v) => String(v ?? '').slice(0, maxValueChars);
  const own = (obj, k) => obj != null && Object.prototype.hasOwnProperty.call(obj, k);
  const capList = (v) => [].concat(v ?? []).map(cap);
  const capMap = (obj) => {
    const out = new Map();
    for (const k of Object.keys(obj || {})) out.set(k, capList(obj[k]));
    return out;
  };
  const html = String(signals.html || '');
  const css = String(signals.css || '');
  let budget = maxScriptChars;
  const scripts = (signals.scripts || []).map((s) => {
    const part = String(s).slice(0, Math.max(0, budget));
    budget -= part.length;
    return part;
  }).filter(Boolean);
  const url = cap(signals.url);
  const scriptSrc = capList(signals.scriptSrc);
  const xhr = capList(signals.xhr);
  const certIssuer = signals.certIssuer ? cap(signals.certIssuer) : '';
  const headers = capMap(signals.headers);
  const meta = capMap(signals.meta);
  const cookies = new Map(Object.keys(signals.cookies || {}).map((k) => [k, cap(signals.cookies[k])]));
  const js = signals.js || {};
  const dom = signals.dom || {};
  const exists = parsePattern('');

  for (const t of db.techs) {
    for (const p of t.url) hit(t, p, url, 'url');
    if (html) for (const p of t.html) hit(t, p, html, 'html');
    if (css) for (const p of t.css) hit(t, p, css, 'css');
    for (const p of t.scriptSrc) for (const src of scriptSrc) hit(t, p, src, `script ${src.slice(0, 90)}`);
    for (const p of t.scripts) for (const s of scripts) hit(t, p, s, 'script content');
    for (const p of t.xhr) for (const x of xhr) hit(t, p, x, `request ${x}`);
    if (certIssuer) for (const p of t.certIssuer) hit(t, p, certIssuer, `certificate issuer ${certIssuer}`);
    for (const [name, ps] of t.headers) {
      for (const v of headers.get(name) || []) for (const p of ps) hit(t, p, v, `header ${name}: ${v.slice(0, 60)}`);
    }
    for (const [name, ps] of t.cookies) {
      if (cookies.has(name)) for (const p of ps) hit(t, p, cookies.get(name), `cookie ${name}`);
    }
    for (const [name, ps] of t.meta) {
      for (const v of meta.get(name) || []) for (const p of ps) hit(t, p, v, `meta ${name}: ${v.slice(0, 60)}`);
    }
    for (const [path, ps] of t.js) {
      if (own(js, path)) {
        const v = js[path];
        for (const p of ps) hit(t, p, v === true ? '' : cap(v), `global ${path}`);
      }
    }
    for (const d of t.dom) {
      if (!own(dom, d.sel)) continue;
      // Probe records one entry per matching element (older readings: a single object).
      const els = [].concat(dom[d.sel]).filter(Boolean);
      if (!els.length) continue;
      if (d.exists) hit(t, exists, '', `DOM ${d.sel}`);
      // Each pattern counts once, on the first element it matches.
      if (d.text) els.some((el) => hit(t, d.text, cap(el.text), `DOM ${d.sel} text`));
      for (const [a, ps] of d.attributes) {
        for (const p of ps) els.some((el) => own(el.attrs, a) && hit(t, p, cap(el.attrs[a]), `DOM ${d.sel}[${a}]`));
      }
      for (const [pr, ps] of d.properties) {
        for (const p of ps) els.some((el) => own(el.props, pr) && hit(t, p, cap(el.props[pr]), `DOM ${d.sel}.${pr}`));
      }
    }
  }

  // implies (with optional confidence), then requires / requiresCategory / excludes
  const byName = new Map(db.techs.map((t) => [t.name, t]));
  const queue = [...hits.values()];
  while (queue.length) {
    const h = queue.shift();
    for (const raw of h.tech.implies) {
      const p = parsePattern(raw);
      const t = byName.get(p.source);
      if (!t || hits.has(t.name)) continue;
      const implied = { tech: t, confidence: Math.min(h.confidence, p.confidence), version: '', evidence: [`implied by ${h.tech.name}`] };
      hits.set(t.name, implied);
      queue.push(implied);
    }
  }
  const catsFound = new Set([...hits.values()].flatMap((h) => h.tech.cats.map(String)));
  for (const [name, h] of [...hits]) {
    const t = h.tech;
    if (t.requires.length && !t.requires.some((r) => hits.has(r))) hits.delete(name);
    else if (t.requiresCategory.length && !t.requiresCategory.some((c) => catsFound.has(String(c)))) hits.delete(name);
  }
  for (const h of [...hits.values()]) for (const ex of h.tech.excludes) hits.delete(ex);

  const catName = (id) => db.categories[id]?.name || `Category ${id}`;
  const catRank = (id) => db.categories[id]?.priority ?? 9;
  return [...hits.values()].map((h) => ({
    name: h.tech.name,
    categories: [...h.tech.cats].sort((a, b) => catRank(a) - catRank(b)).map(catName),
    version: h.version || undefined,
    confidence: h.confidence,
    evidence: h.evidence,
    website: h.tech.website,
    description: h.tech.description,
    oss: h.tech.oss,
    saas: h.tech.saas,
  }));
}
