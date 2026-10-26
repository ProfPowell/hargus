// Runs plugins against a reading. Environment-neutral: the caller supplies fetch, settings and,
// for page-phase plugins, an evaluate() bridge into a live page. Used by the extension service
// worker (capture), the viewer (re-run lookups) and the Node CLI.

import * as util from './har-util.js';
import { resolve as dohResolve } from './doh.js';
import { pluginArea, normRating } from './score.js';

export const PHASES = ['page', 'analyze', 'enrich'];

export class SkipError extends Error {
  constructor(msg) { super(msg); this.name = 'SkipError'; }
}
export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} from ${util.hostOf(url)}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export function pluginEnabled(plugin, settings = {}) {
  if (settings.phases?.[plugin.phase] === false) return false;
  return settings.plugins?.[plugin.id]?.enabled ?? plugin.defaultEnabled !== false;
}

export function pluginOptions(plugin, settings = {}) {
  const defaults = Object.fromEntries((plugin.options || []).map((o) => [o.key, o.default]));
  return { ...defaults, ...(settings.plugins?.[plugin.id]?.options || {}) };
}

/**
 * env: {
 *   phases:   which phases to run (default all)
 *   settings: { plugins: {id:{enabled,options}}, keys: {...}, phases: {enrich:false}, lookups: {resolver} }
 *   fetch:    fetch implementation (default globalThis.fetch)
 *   evaluate(fn, args, world): run a self-contained function in the live page (page phase)
 *   inject(urls, world):       load vendor scripts into the page before collect (page phase)
 *   onProgress({ plugin, name, status })
 *   only:     [ids] run exactly these plugins, ignoring enabled flags
 *   timeoutMs default per-plugin timeout
 *   views:    Promise resolved once the reading has its views (optional)
 * }
 */
export async function runPlugins(reading, plugins, env = {}) {
  const hp = reading.log._harplus;
  hp.plugins ||= {};
  const shared = { dnsCache: new Map() };
  const phases = env.phases || PHASES;
  const active = (phase) => plugins.filter((p) => p.phase === phase &&
    (env.only ? env.only.includes(p.id) : pluginEnabled(p, env.settings)));
  const held = heldBack(phases.flatMap(active));
  const runSet = async (list) => {
    let pending = list;
    while (pending.length) {
      const ids = new Set(pending.map((p) => p.id));
      let ready = pending.filter((p) => !(p.after || []).some((d) => ids.has(d)));
      if (!ready.length) ready = pending; // dependency cycle: run them together
      await Promise.all(ready.map((p) => runOne(p, reading, env, shared)));
      pending = pending.filter((p) => !ready.includes(p));
    }
  };
  for (const phase of phases) {
    if (phase === 'page' && env.evaluate) await runProbes(reading, plugins, env);
    await runSet(active(phase).filter((p) => !held.has(p.id)));
  }
  if (held.size) {
    if (env.views) await env.views;
    for (const phase of phases) await runSet(active(phase).filter((p) => held.has(p.id)));
  }
  return reading;
}

/** Plugins that need the views, plus every plugin transitively `after` one of them. */
export function heldBack(plugins) {
  const held = new Set(plugins.filter((p) => (p.needs || []).includes('views')).map((p) => p.id));
  for (let grew = true; grew;) {
    grew = false;
    for (const p of plugins) if (!held.has(p.id) && (p.after || []).some((d) => held.has(d))) { held.add(p.id); grew = true; }
  }
  return held;
}

// Probes let non-page plugins sense the live page during capture and interpret it later
// (offline, re-runnable). Output is stored in _harplus.probes[pluginId].
async function runProbes(reading, plugins, env) {
  const hp = reading.log._harplus;
  hp.probes ||= {};
  const list = plugins.filter((p) => p.probe && p.phase !== 'page' &&
    (env.only ? env.only.includes(p.id) : pluginEnabled(p, env.settings)));
  const shared = { dnsCache: new Map() };
  for (const p of list) {
    const ms = p.timeoutMs ?? env.timeoutMs ?? 20_000;
    const contacted = new Map();
    try {
      // probe.args may be a function of ctx (e.g. derived from downloaded reference data)
      const args = typeof p.probe.args === 'function'
        ? await p.probe.args(makeContext(p, reading, env, shared, AbortSignal.timeout(ms), contacted))
        : p.probe.args ?? {};
      hp.probes[p.id] = await Promise.race([
        env.evaluate(p.probe.collect, args, p.probe.world || 'isolated'),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`probe timed out after ${ms / 1000}s`)), ms)),
      ]);
    } catch (e) {
      hp.probes[p.id] = { error: String(e?.message || e) };
    }
    // Hosts contacted while preparing the probe are reported with the plugin's result.
    if (contacted.size && hp.probes[p.id] && typeof hp.probes[p.id] === 'object') {
      hp.probes[p.id]._contacted = [...contacted].map(([host, count]) => ({ host, count }));
    }
  }
}

function mergeContacted(map, extra = []) {
  const out = new Map(map);
  for (const { host, count } of Array.isArray(extra) ? extra : []) out.set(host, (out.get(host) || 0) + (count || 0));
  return [...out].map(([host, count]) => ({ host, count }));
}

async function runOne(plugin, reading, env, shared) {
  const started = Date.now();
  const contacted = new Map();
  const timeoutMs = plugin.timeoutMs ?? env.timeoutMs ?? 20_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  env.onProgress?.({ plugin: plugin.id, name: plugin.name, status: 'running' });
  let result;
  try {
    const ctx = makeContext(plugin, reading, env, shared, ctrl.signal, contacted);
    if (plugin.phase === 'page') {
      if (!env.evaluate) throw new SkipError('needs a live page — take a new reading');
      if (plugin.inject?.length) await withAbort(env.inject(plugin.inject, plugin.world || 'isolated'), ctrl.signal);
      if (plugin.collect) {
        const args = plugin.collectArgs ? plugin.collectArgs(ctx) : ctx.options;
        ctx.collected = await withAbort(env.evaluate(plugin.collect, args, plugin.world || 'isolated'), ctrl.signal);
      }
    }
    const out = plugin.run
      ? await withAbort(Promise.resolve().then(() => plugin.run(reading, ctx)), ctrl.signal)
      : { data: ctx.collected };
    result = { status: 'ok', ...normalize(out) };
  } catch (e) {
    result = {
      status: e?.name === 'SkipError' ? 'skipped' : 'error',
      error: String(e?.message || e),
      data: null, findings: [], summary: [],
    };
  } finally {
    clearTimeout(timer);
  }
  reading.log._harplus.plugins[plugin.id] = {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    phase: plugin.phase,
    area: pluginArea(plugin),
    ranAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    ...result,
    contacted: mergeContacted(contacted, reading.log._harplus.probes?.[plugin.id]?._contacted),
  };
  env.onProgress?.({ plugin: plugin.id, name: plugin.name, status: result.status, error: result.error });
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function makeContext(plugin, reading, env, shared, signal, contacted) {
  const settings = env.settings || {};
  const baseFetch = env.fetch || globalThis.fetch.bind(globalThis);
  const fetch = (url, init = {}) => {
    const host = util.hostOf(String(url));
    contacted.set(host, (contacted.get(host) || 0) + 1);
    return baseFetch(url, { credentials: 'omit', ...init, signal: init.signal || signal });
  };
  const fetchJSON = async (url, init) => {
    const r = await fetch(url, init);
    if (!r.ok) throw new HttpError(r.status, String(url));
    return r.json();
  };
  const resolver = settings.lookups?.resolver || 'cloudflare';
  const dns = (name, type) => {
    const k = `${name}|${type}`;
    if (!shared.dnsCache.has(k)) {
      shared.dnsCache.set(k, dohResolve(fetch, resolver, name, type)
        .catch((e) => ({ status: 'ERROR', error: String(e.message || e), ad: false, answers: [] })));
    }
    return shared.dnsCache.get(k);
  };
  return {
    har: reading,
    target: reading.log._harplus.target || {},
    options: pluginOptions(plugin, settings),
    keys: settings.keys || {},
    results: reading.log._harplus.plugins,
    probe: reading.log._harplus.probes?.[plugin.id],
    whois: env.whois,     // optional port-43 WHOIS (Node CLI only): (domain) => { text, server }
    cache: env.cache,     // optional shared cache for large reference data (fingerprints, web-features)
    detectLanguage: env.detectLanguage, // optional text-language detector: (text) => Promise<{ code, share, reliable } | null>
    fetch,
    fetchJSON,
    dns,
    signal,
    util,
    skip(msg) { throw new SkipError(msg); },
    progress(text) { env.onProgress?.({ plugin: plugin.id, name: plugin.name, status: 'running', text: String(text) }); },
    collected: undefined,
  };
}

function normalize(out = {}) {
  const findings = (out.findings || []).filter((f) => f && f.title).map((f) => {
    const n = {
      severity: util.SEVERITY_RANK[f.severity] != null ? f.severity : 'info',
      category: f.category || 'quality',
      title: String(f.title),
    };
    if (f.detail) n.detail = String(f.detail);
    if (f.evidence != null) n.evidence = f.evidence;
    if (f.ref) n.ref = String(f.ref);
    if (Array.isArray(f.tags) && f.tags.length) n.tags = f.tags.slice(0, 20).map(String);
    if (f.id) n.id = String(f.id);
    // Extent fields (core/extent.js): how many elements a finding affects, out of which population.
    const posInt = (x) => Number.isInteger(x) && x > 0;
    if (posInt(f.count)) n.count = f.count;
    if (posInt(f.of)) n.of = f.of;
    if (typeof f.unit === 'string' && f.unit) n.unit = f.unit.slice(0, 40);
    return n;
  });
  const summary = (out.summary || [])
    .filter((s) => s && s.label && s.value != null && s.value !== '')
    .map((s) => {
      const n = { label: String(s.label), value: String(s.value) };
      const rating = normRating(s.rating);
      if (rating) n.rating = rating;
      if (s.headline) n.headline = true;
      return n;
    });
  return { data: out.data ?? null, findings, summary };
}
