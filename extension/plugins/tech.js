// Technology fingerprinting: CMS, frameworks, CDN/hosting, analytics, marketing, ads, consent…
// Analysis runs offline over the recording; a small `probe` senses page globals and DOM
// during capture so the analysis can be re-run later without the live page.

import { SIGNATURES, VERSION_RULES } from './tech-signatures.js';
import { mainEntry, redirectChain, cookieNames, header, truncate, resourceType, bodyText, hostOf, originOf } from '../core/har-util.js';
import { loadFingerprints, probeNeeds, match as matchFingerprints, DEFAULT_SOURCE } from './kb/fingerprints.js';

function probeCollect(args) {
  // Null-prototype maps: page-controlled names such as "constructor" or "__proto__" stay plain keys.
  const out = { globals: Object.create(null), dom: Object.create(null), meta: Object.create(null), scripts: [], customElements: [], ngVersion: null, serviceWorker: false, errors: [] };
  const section = (label, fn) => { try { fn(); } catch (e) { out.errors.push(`${label}: ${e.message}`); } };
  section('globals', () => {
    for (const path of args.globals) {
      try {
        let v = window;
        for (const k of path.split('.')) { if (v == null) break; v = v[k]; }
        if (v != null) out.globals[path] = typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 60) : true;
      } catch { /* hostile getter */ }
    }
  });
  section('dom', () => {
    for (const d of args.dom) {
      try {
        const needs = (d.attrs?.length || d.props?.length || d.text);
        // Generic selectors (button, script, style) need several elements checked, not just the first.
        const els = [];
        if (needs) { for (const el of document.querySelectorAll(d.sel)) { els.push(el); if (els.length >= 20) break; } }
        else { const el = document.querySelector(d.sel); if (el) els.push(el); }
        if (!els.length) continue;
        out.dom[d.sel] = els.map((el) => {
          const rec = { attrs: {}, props: {} };
          for (const a of d.attrs || []) { const v = el.getAttribute(a); if (v != null) rec.attrs[a] = v.slice(0, 200); }
          for (const pr of d.props || []) {
            try { const v = el[pr]; if (v != null) rec.props[pr] = typeof v === 'object' ? true : String(v).slice(0, 200); } catch { /* ignore */ }
          }
          if (d.text) rec.text = (el.textContent || '').trim().slice(0, 300);
          return rec;
        });
      } catch { /* invalid selector for this browser */ }
    }
  });
  section('meta', () => {
    for (const m of document.querySelectorAll('meta[name], meta[property], meta[http-equiv]')) {
      const name = (m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('http-equiv') || '').trim().toLowerCase();
      if (!name) continue;
      const list = out.meta[name] || (out.meta[name] = []);
      if (list.length < 10) list.push((m.getAttribute('content') || '').slice(0, 300));
    }
  });
  // http(s) only, capped: inline data: scripts (e.g. deferred-JS plugins) can be megabytes long
  section('scripts', () => { out.scripts = [...document.scripts].map((s) => s.src).filter((u) => /^https?:/i.test(u)).map((u) => u.slice(0, 500)).slice(0, 300); });
  section('angular', () => { out.ngVersion = document.querySelector('[ng-version]')?.getAttribute('ng-version') || null; });
  section('custom elements', () => {
    const ce = new Set();
    for (const el of document.getElementsByTagName('*')) if (el.localName.includes('-')) ce.add(el.localName);
    out.customElements = [...ce].slice(0, 100);
  });
  section('service worker', () => { out.serviceWorker = !!navigator.serviceWorker?.controller; });
  return out;
}

const BUILTIN_NEEDS = (() => {
  const globals = new Set(); const dom = new Set();
  for (const s of SIGNATURES) {
    (s.g || []).forEach((x) => globals.add(x));
    if (s.v) globals.add(s.v);
    (s.d || []).forEach((x) => dom.add(x));
  }
  return { globals: [...globals], dom: [...dom].map((sel) => ({ sel, attrs: [], props: [], text: false })) };
})();

async function probeArgs(ctx) {
  if (!ctx.options.fingerprintDb) return BUILTIN_NEEDS;
  try {
    const needs = probeNeeds(await loadFingerprints(ctx.fetch, ctx.options.fingerprintSource));
    const seen = new Set(needs.dom.map((d) => d.sel));
    return {
      globals: [...new Set([...BUILTIN_NEEDS.globals, ...needs.globals])],
      dom: [...needs.dom, ...BUILTIN_NEEDS.dom.filter((d) => !seen.has(d.sel))],
    };
  } catch {
    return BUILTIN_NEEDS; // offline: built-in signatures still work
  }
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const CATEGORY_ORDER = ['CMS', 'Headless CMS', 'Page builders', 'Blogs', 'Static site generator', 'Ecommerce',
  'Framework', 'Web frameworks', 'JavaScript frameworks', 'Web components', 'UI frameworks', 'UI library',
  'JavaScript libraries', 'JS library', 'Data visualization', 'Programming languages', 'Language', 'Databases',
  'Web servers', 'Web server', 'Reverse proxies', 'Hosting', 'PaaS', 'IaaS', 'CDN', 'Caching', 'Cache', 'Security',
  'Authentication', 'Identity', 'Backend as a service', 'Analytics', 'Tag managers', 'Tag manager',
  'Customer data platform', 'Session replay', 'RUM', 'Monitoring', 'Advertising', 'Retargeting', 'Intent data / ABM',
  'Marketing automation', 'Email', 'CRM', 'Live chat', 'Customer support', 'A/B testing', 'A/B Testing',
  'Feature flags', 'Feature management', 'Personalisation', 'Consent management', 'Cookie compliance', 'Payments',
  'Payment processors', 'Buy now pay later', 'Font scripts', 'Fonts', 'Video players', 'Video', 'Maps',
  'Search engines', 'Search', 'Reviews', 'Surveys', 'Forms', 'Scheduling', 'Accessibility', 'Translation',
  'Performance', 'Development', 'Miscellaneous'];
// Same technology, different names in the built-in table and the community database.
const ALIASES = { apachehttpserver: 'apache', microsoftiis: 'iis', facebookpixel: 'metapixel', amazonwebservices: 'aws',
  googlefontapi: 'googlefonts', amazonelasticloadbalancing: 'awselasticloadbalancing', vuejs: 'vuejs', reactjs: 'react' };
const keyOf = (name) => { const k = String(name).toLowerCase().replace(/[^a-z0-9]/g, ''); return ALIASES[k] || k; };
const rank = (cat) => { const i = CATEGORY_ORDER.indexOf(cat); return i < 0 ? 99 : i; };
const TRACKING = ['Advertising', 'Session replay', 'Retargeting'];

async function run(reading, ctx) {
  const probe = ctx.probe && !ctx.probe.error ? ctx.probe : null;
  const main = mainEntry(reading);
  const headerSets = redirectChain(reading, main).map((e) => e.response.headers);
  const urls = reading.log.entries.map((e) => e.request.url);
  const cookies = [...cookieNames(reading)];
  const metas = Object.assign(Object.create(null), probe?.meta);
  const gen = ctx.results.meta?.data?.generator;
  if (!metas.generator && gen?.length) metas.generator = gen;

  const found = new Map();
  const hit = (sig, how, version) => {
    const f = found.get(sig.name) || { name: sig.name, category: sig.cat, version: undefined, evidence: [] };
    if (version && !f.version) f.version = version;
    if (!f.evidence.includes(how) && f.evidence.length < 4) f.evidence.push(how);
    found.set(sig.name, f);
  };

  for (const sig of SIGNATURES) {
    for (const [name, re] of Object.entries(sig.h || {})) {
      for (const hs of headerSets) {
        const v = header(hs, name);
        const m = v != null && String(v).match(re);
        if (m) hit(sig, `header ${name}: ${truncate(v, 60)}`, m[1]);
      }
    }
    if (sig.u) {
      const u = urls.find((x) => sig.u.test(x));
      if (u) hit(sig, `request ${truncate(u, 90)}`, u.match(sig.u)[1]);
    }
    if (sig.c) {
      const n = cookies.find((x) => sig.c.test(x));
      if (n) hit(sig, `cookie ${n}`);
    }
    for (const [name, re] of Object.entries(sig.m || {})) {
      for (const v of [].concat(metas[name] || [])) {
        const m = String(v).match(re);
        if (m) hit(sig, `meta ${name}: ${truncate(v, 60)}`, m[1]);
      }
    }
    if (probe) {
      const globals = probe.globals || {};
      for (const g of sig.g || []) if (Object.hasOwn(globals, g)) hit(sig, `global ${g}`);
      const ver = sig.v && Object.hasOwn(globals, sig.v) ? globals[sig.v] : null;
      if (ver != null) hit(sig, `global ${sig.v}`, typeof ver === 'string' ? ver : undefined);
      for (const d of sig.d || []) if (Object.hasOwn(probe.dom || {}, d)) hit(sig, `DOM ${d}`);
    }
  }
  if (found.has('Angular') && probe?.ngVersion) found.get('Angular').version ||= probe.ngVersion;
  for (const f of [...found.values()]) {
    for (const imp of SIGNATURES.find((s) => s.name === f.name)?.implies || []) {
      if (!found.has(imp)) {
        const sig = SIGNATURES.find((s) => s.name === imp);
        found.set(imp, { name: imp, category: sig?.cat || 'Framework', evidence: [`implied by ${f.name}`] });
      }
    }
  }
  if (probe?.customElements?.length) {
    found.set('Custom elements', {
      name: 'Custom elements', category: 'Web components',
      version: `${probe.customElements.length} tags`, evidence: [probe.customElements.slice(0, 8).join(', ')],
    });
  }
  if (probe?.serviceWorker) found.set('Service worker', { name: 'Service worker', category: 'Framework', evidence: ['page is controlled by a service worker'] });

  // Community fingerprint database (Wappalyzer format) — far broader coverage than the built-in table.
  let db = null;
  let dbError = null;
  if (ctx.options.fingerprintDb) {
    try {
      db = await loadFingerprints(ctx.fetch, ctx.options.fingerprintSource);
    } catch (e) {
      dbError = String(e.message || e);
    }
  }
  if (db) {
    const entries = reading.log.entries;
    const scripts = entries.filter((e) => resourceType(e) === 'script');
    const headers = Object.create(null);
    for (const hs of headerSets) for (const { name, value } of hs) (headers[name.toLowerCase()] ||= []).push(value);
    const cookieValues = Object.create(null);
    for (const e of entries) for (const c of [...(e.request?.cookies || []), ...(e.response?.cookies || [])]) cookieValues[c.name] ??= c.value;
    const tls = reading.log._harplus.capture?.tls?.[originOf(main?.request?.url || '')];
    const hits = matchFingerprints(db, {
      url: ctx.target.finalUrl,
      html: bodyText(main).slice(0, 800_000),
      css: entries.filter((e) => resourceType(e) === 'stylesheet').map(bodyText).join('\n').slice(0, 600_000),
      scriptSrc: [...new Set([...scripts.map((e) => e.request.url), ...(probe?.scripts || [])])],
      scripts: scripts.map(bodyText).filter(Boolean),
      xhr: [...new Set(entries.filter((e) => resourceType(e) === 'xhr').map((e) => hostOf(e.request.url)))],
      certIssuer: tls?.issuer,
      headers,
      cookies: cookieValues,
      meta: metas,
      js: probe?.globals || {},
      dom: probe?.dom || {},
    });
    const byKey = new Map([...found.values()].map((f) => [keyOf(f.name), f]));
    for (const d of hits) {
      const existing = byKey.get(keyOf(d.name));
      if (existing) {
        existing.version ||= d.version;
        existing.website ||= d.website;
        existing.description ||= d.description;
        existing.evidence = [...new Set([...existing.evidence, ...d.evidence])].slice(0, 5);
        continue;
      }
      const f = { name: d.name, category: d.categories[0], version: d.version, evidence: d.evidence, website: d.website,
        description: d.description, confidence: d.confidence < 100 ? d.confidence : undefined, source: 'fingerprints' };
      found.set(d.name, f);
      byKey.set(keyOf(d.name), f);
    }
  }

  const technologies = [...found.values()].sort((a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name));

  const findings = [];
  for (const rule of VERSION_RULES) {
    const f = found.get(rule.name);
    if (!f) continue;
    if (rule.below === '99' || (f.version && cmpVersion(f.version, rule.below) < 0 &&
      (!rule.from || cmpVersion(f.version, rule.from) >= 0))) {
      findings.push({ severity: rule.severity, category: 'security', title: rule.title, detail: f.version ? `Detected ${f.name} ${f.version}` : undefined });
    }
  }
  const byCat = (cats) => technologies.filter((x) => cats.includes(x.category)).map((x) => x.name);
  const trackers = byCat(TRACKING);
  if (trackers.length) {
    findings.push({ severity: trackers.length > 5 ? 'low' : 'info', category: 'privacy', title: `${trackers.length} advertising / session-replay vendors`, detail: trackers.join(', ') });
  }
  const abm = byCat(['Intent data / ABM']);
  if (abm.length) findings.push({ severity: 'info', category: 'intel', title: 'Identifies business visitors (intent / ABM data)', detail: abm.join(', ') });

  const groups = new Map();
  for (const x of technologies) {
    const list = groups.get(x.category) || [];
    list.push(x.version && !/tags$/.test(x.version) ? `${x.name} ${x.version}` : x.name);
    groups.set(x.category, list);
  }
  const summary = [
    { label: 'Detected', headline: true, value: technologies.length ? `${technologies.length} technologies in ${groups.size} categories` : 'nothing recognised' },
    ...[...groups].slice(0, 14).map(([label, names]) => ({ label, value: names.join(', ') })),
  ];
  return {
    data: {
      technologies, probe: !!probe, probeError: ctx.probe?.error, probeErrors: probe?.errors?.length ? probe.errors : undefined,
      fingerprints: db ? { source: db.source, count: db.count } : dbError ? { error: dbError } : null,
    },
    findings,
    summary,
  };
}

/** An evidence line; a request or script URL in it shows as URL parts (a cut URL keeps its "…" outside the parts). */
function evidenceLine(line, h) {
  const m = String(line).match(/^(request|script) (https?:\/\/\S+)$/);
  if (!m) return line;
  const cut = m[2].endsWith('…');
  return h.html`${m[1]} ${h.url(cut ? m[2].slice(0, -1) : m[2])}${cut ? '…' : ''}`;
}

/**
 * Answer first (technologies, categories, ad and session-replay vendors), then each technology with its evidence.
 * The glance draws the names as chips; the table adds what it lacks (version, evidence, description). Custom
 * element tag names are listed by HTML composition, so their row shows the count only.
 */
function render(r, h) {
  const techs = r.data.technologies;
  const rows = techs.map((x) => ({
    category: x.category,
    technology: h.html`${x.website ? h.link(x.website, x.name) : x.name}${x.description ? h.html`<div class="note">${truncate(x.description, 140)}</div>` : ''}`,
    version: x.version || '',
    evidence: x.name === 'Custom elements' && x.category === 'Web components' ? '' : h.list((x.evidence || []).map((e) => evidenceLine(e, h))),
  }));
  const fp = r.data.fingerprints;
  const trackers = techs.filter((x) => TRACKING.includes(x.category)).length;
  return h.html`
    ${rows.length ? h.stats([
      h.stat({ label: 'Technologies', value: techs.length }),
      h.stat({ label: 'Categories', value: new Set(techs.map((x) => x.category)).size }),
      h.stat({ label: 'Ad and replay vendors', value: trackers }),
    ]) : ''}
    ${rows.length ? h.table(rows, ['category', 'technology', 'version', 'evidence']) : h.html`<p>Nothing recognised.</p>`}
    ${fp?.count ? h.html`<p class="note">Built-in signatures plus ${fp.count.toLocaleString()} community fingerprints (webappanalyzer, GPL-3.0) from ${h.link(fp.source)}.</p>` : ''}
    ${fp?.error ? h.html`<p class="note">Community fingerprints unavailable (${fp.error}) — built-in signatures only.</p>` : ''}
    ${r.data.probeError ? h.html`<p class="note">The in-page probe failed (${r.data.probeError}) — headers, URLs, bodies and cookies only.</p>`
      : r.data.probe ? '' : h.html`<p class="note">No in-page probe data (imported reading) — headers, URLs, bodies and cookies only.</p>`}
    ${r.data.probeErrors?.length ? h.html`<p class="note">Probe parts that could not run: ${r.data.probeErrors.join('; ')}</p>` : ''}
  `;
}

const CHIPS = 8;

/** Chips grouped by category; the first 8 technologies show, the rest fold under "+N more", grouped the same way. */
function glance(r, h) {
  const techs = (r.data?.technologies || []).filter((t) => t && t.name);
  if (!techs.length) return '';
  const grouped = (list) => {
    const groups = new Map();
    for (const t of list) {
      const k = t.category || 'Other';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ name: t.name, version: t.version });
    }
    return h.html`<div class="tech-groups">${[...groups].map(([cat, xs]) => h.html`<div><h4>${cat}</h4>${h.badges(xs)}</div>`)}</div>`;
  };
  const rest = techs.slice(CHIPS);
  return h.html`<section class="card"><h4>Technology stack · ${techs.length}</h4>${grouped(techs.slice(0, CHIPS))}${rest.length ? h.more(`+${rest.length} more`, grouped(rest)) : ''}</section>`;
}

export default {
  id: 'tech',
  group: 'build',
  name: 'Technology stack',
  version: '0.2.1',
  phase: 'analyze',
  after: ['meta'],
  description: 'Fingerprints CMS, frameworks, servers, CDN, analytics, ads, marketing, consent and payment vendors.',
  tags: ['intel', 'security'],
  probe: { world: 'main', collect: probeCollect, args: probeArgs },
  options: [
    { key: 'fingerprintDb', label: 'Use the community fingerprint database (~7,600 technologies)', type: 'checkbox', default: true },
    { key: 'fingerprintSource', label: 'Fingerprint database URL (Wappalyzer format)', type: 'text', default: DEFAULT_SOURCE },
  ],
  disclosure: 'Downloads the fingerprint database from GitHub (weekly, cached). Nothing about the page is sent.',
  timeoutMs: 60_000,
  run,
  render,
  glance,
};
