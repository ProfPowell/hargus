#!/usr/bin/env node
// Score check: re-runs plugins on saved readings and proves scores and findings did not move.
//   node scripts/score-check.mjs <harDir> --write <baseline.json>
//   node scripts/score-check.mjs <harDir> --compare <baseline.json>   (prints differences, exits 1 if any)
//   node scripts/score-check.mjs <harDir> --compare <baseline.json> --ignore-ids   (as --compare, ignoring finding id/subject)
//   node scripts/score-check.mjs <harDir> --ids   (lists non-info findings without a rule id and id collisions, for the plugins it re-runs)
// Analyze plugins re-run offline. Page plugins whose saved `data` is the page's collected input (or that input plus
// fields run() derives from it) re-run too: their collect() is replayed from the saved data (REPLAY below), so their
// run() is checked like any analyze plugin. The rest keep their saved results as they are:
//   content, images, language: the saved data is run()'s analysis, not the collected input, so run() cannot take it
//     back (content and language skip or fail on it; images re-derives different data);
//   contrast: saves colour pairs, not the per-element colours it collected;
//   enrich plugins: they need the network (lookups are off here).
// Date.now is frozen to each reading's capture time while it runs, so date-relative findings (certificate days left)
// read the same on every run. Reference data the analyze plugins download (web-features) is cached on disk next to
// the baseline, so a dataset release mid-phase cannot move the result.
// Deleting score-check-cache may require rewriting the baseline (web-features floats).

import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ensureHarPlus } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';
import { getPlugins } from '../extension/plugins/index.js';
import { AREAS, scoreReading } from '../extension/core/score.js';

/** JSON with object keys sorted, so equal values always print the same. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** Area scores plus overall, and every plugin's findings without `places`, in a stable order. */
export function snapshot(reading, plugins) {
  const { overall, areas } = scoreReading(reading, plugins);
  const scores = { ...Object.fromEntries(AREAS.map((a) => [a.id, areas[a.id].score])), overall: overall.score };
  const results = reading.log._harplus.plugins || {};
  const findings = {};
  for (const id of Object.keys(results).sort()) {
    const list = (results[id].findings || []).map(({ places, ...f }) => JSON.parse(canonical(f)));
    findings[id] = list.sort((x, y) => (canonical(x) < canonical(y) ? -1 : canonical(x) > canonical(y) ? 1 : 0));
  }
  return { scores, findings };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Every difference between two snapshots (or maps of them) as "path: before → after"; arrays compare as multisets. */
export function compare(a, b, path = '') {
  const at = (k) => (path ? `${path}.${k}` : k);
  if (isObj(a) && isObj(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((k) => compare(a[k], b[k], at(k)));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const left = a.map(canonical);
    const right = b.map(canonical);
    const out = [];
    const pool = [...right];
    for (const s of left) {
      const i = pool.indexOf(s);
      if (i >= 0) pool.splice(i, 1);
      else out.push(`${path}: - ${s}`);
    }
    return [...out, ...pool.map((s) => `${path}: + ${s}`)];
  }
  const show = (v) => (v === undefined ? '(missing)' : canonical(v));
  return canonical(a) === canonical(b) && (a === undefined) === (b === undefined) ? [] : [`${path}: ${show(a)} → ${show(b)}`];
}

/** fetch with an on-disk cache: the first run downloads, later runs never touch the network. */
function cachedFetch(dir) {
  return async (url, init) => {
    const file = join(dir, `${createHash('sha256').update(String(url)).digest('hex').slice(0, 24)}.body`);
    try {
      return new Response(await readFile(file), { status: 200 });
    } catch { /* not cached yet */ }
    const r = await fetch(url, init);
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      await mkdir(dir, { recursive: true });
      // Temp file then rename: an interrupted run never leaves a truncated body for later runs to trust.
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, buf);
      await rename(tmp, file);
      return new Response(buf, { status: r.status });
    }
    return r;
  };
}

/**
 * Page plugins that re-run from their saved data: it holds everything collect() returned (data is the collected
 * object, or it spread with derived fields). a11y-map's saved data lacks the marker boxes, which only feed the
 * Page map markers, not its findings. Checked by replay: each one's re-run data equals its saved data on the
 * calibration readings (a11y-map and a11y-structure aside, where the extra fields come from the capture).
 */
export const REPLAY = ['meta', 'html', 'css', 'vitals', 'a11y-basics', 'axe', 'a11y-structure', 'a11y-map'];

/** Page plugins that cannot be replayed, with the reason (see the header). A new page plugin must go in REPLAY or here. */
export const NOT_REPLAYED = {
  content: 'saved data is the analysis, not the collected input',
  images: 'saved data is the analysis; re-deriving it gives different data',
  language: 'saved data is the analysis, not the collected input',
  contrast: 'saves colour pairs, not the per-element colours it collected',
};

/** Re-run the page plugins in REPLAY (collect replayed from saved data), then the analyze phase as `hargus analyze --no-lookups` would; snapshot it. */
export async function checkFile(file, { fetch: fetchFn, ran } = {}) {
  const reading = ensureHarPlus(JSON.parse(await readFile(file, 'utf8')), { fileName: basename(file) });
  const settings = { phases: { enrich: false }, plugins: { tech: { options: { fingerprintDb: false } } } };
  const plugins = getPlugins(settings);
  const saved = reading.log._harplus.plugins || {};
  // Only plugins that ran ok when the reading was taken; `only` also keeps runPlugins from running any probe.
  const replay = plugins.filter((p) => p.phase === 'page' && REPLAY.includes(p.id) && saved[p.id]?.status === 'ok' && p.collect);
  const dataOf = new Map(replay.map((p) => [p.collect, saved[p.id].data]));
  const evaluate = async (fn) => {
    if (!dataOf.has(fn)) throw new Error('not replayed');
    return structuredClone(dataOf.get(fn));
  };
  // `ran` (optional out-list): the plugin ids this run re-ran; the rest keep their saved findings.
  if (ran) ran.push(...new Set([...replay.map((p) => p.id), ...plugins.filter((p) => p.phase === 'analyze').map((p) => p.id)]));
  const at = Date.parse(reading.log._harplus.capturedAt);
  const realNow = Date.now;
  if (Number.isFinite(at)) Date.now = () => at;
  try {
    if (replay.length) await runPlugins(reading, plugins, { phases: ['page'], only: replay.map((p) => p.id), settings, evaluate, inject: async () => {}, fetch: fetchFn });
    await runPlugins(reading, plugins, { phases: ['analyze'], settings, fetch: fetchFn });
  } finally {
    Date.now = realNow;
  }
  return snapshot(reading, plugins);
}

/**
 * Findings without a rule id (non-info) and plugin/id/subject groups that repeat within one reading, for the plugins
 * score-check re-ran (`ranBy`: site → plugin ids). Plugins it keeps saved results for are only counted, in `notRun`.
 */
export function auditIds(sites, ranBy = {}) {
  const missing = [];
  const collisions = [];
  const notRun = {};
  for (const [site, snap] of Object.entries(sites)) {
    const seen = new Map();
    const ran = new Set(ranBy[site] || Object.keys(snap.findings));
    for (const [plugin, list] of Object.entries(snap.findings)) {
      for (const f of list) {
        if (!ran.has(plugin)) {
          if (f.severity !== 'info' && !f.id) notRun[plugin] = (notRun[plugin] || 0) + 1;
          continue;
        }
        if (f.severity === 'info') continue;
        if (!f.id) { missing.push(`${site} ${plugin}: ${f.title}`); continue; }
        const key = `${plugin}/${f.id}${f.subject ? `/${f.subject}` : ''}`;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
    for (const [key, n] of seen) if (n > 1) collisions.push(`${site} ${key} x${n}`);
  }
  return { missing, collisions, notRun };
}

async function main() {
  const args = process.argv.slice(2);
  const ignoreIds = args.includes('--ignore-ids');
  const [dir, mode, out] = args.filter((a) => a !== '--ignore-ids');
  if (!dir || !['--write', '--compare', '--ids'].includes(mode) || (mode !== '--ids' && !out)) {
    console.error('usage: node scripts/score-check.mjs <harDir> (--write | --compare [--ignore-ids]) <baseline.json> | <harDir> --ids');
    process.exit(2);
  }
  const files = (await readdir(dir)).filter((f) => f.endsWith('.har')).sort();
  const fetchFn = cachedFetch(join(dirname(resolve(out || join(dir, 'x'))), 'score-check-cache'));
  const sites = {};
  const ranBy = {};
  for (const f of files) {
    const site = f.replace(/\.har$/, '');
    ranBy[site] = [];
    sites[site] = await checkFile(join(dir, f), { fetch: fetchFn, ran: ranBy[site] });
  }
  if (mode === '--ids') {
    const { missing, collisions, notRun } = auditIds(sites, ranBy);
    console.log(`${missing.length} findings without id`);
    for (const m of missing) console.log(`  ${m}`);
    console.log(`${collisions.length} collisions`);
    for (const c of collisions) console.log(`  ${c}`);
    const total = Object.values(notRun).reduce((n, m) => n + m, 0);
    const by = Object.entries(notRun).sort().map(([p, n]) => `${p} ${n}`).join(', ');
    console.log(`${total} findings from plugins not re-run (ids checked by unit tests)${by ? `: ${by}` : ''}`);
    process.exit(missing.length || collisions.length ? 1 : 0);
  }
  const count = Object.values(sites).reduce((n, s) => n + Object.values(s.findings).reduce((m, l) => m + l.length, 0), 0);
  if (mode === '--write') {
    await writeFile(out, `${JSON.stringify(sites, null, 1)}\n`);
    console.log(`wrote ${out}: ${files.length} readings, ${count} findings`);
    return;
  }
  const dropIds = (o) => {
    for (const s of Object.values(o)) for (const list of Object.values(s.findings)) for (const f of list) { delete f.id; delete f.subject; }
    return o;
  };
  const baseline = JSON.parse(await readFile(out, 'utf8'));
  const diffs = ignoreIds ? compare(dropIds(baseline), dropIds(sites)) : compare(baseline, sites);
  for (const d of diffs) console.log(d);
  console.log(`${files.length} readings, ${count} findings: ${diffs.length ? `${diffs.length} difference${diffs.length === 1 ? '' : 's'}` : 'no differences'}`);
  process.exit(diffs.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
