#!/usr/bin/env node
// Coverage overhead check: compares calibration runs taken back to back, with load coverage on and off.
//   node scripts/coverage-overhead.mjs <dirOn>[,<dirOn2>…] <dirOff>[,<dirOff2>…]
// Each state may have several passes (comma-separated folders); a site's value per state is the median of its passes.
// Prints, per site present in both states, LCP and blocking time (vitals plugin data) on and off with their percent
// change, the median changes, and the Performance grade of each "on" reading with and without the coverage result.
// A site's LCP is left out of the median when both state values are under LCP_FLOOR ms, and its blocking time when
// both are under BLOCKING_FLOOR ms: there, a few ms of noise is a large percentage.
// Verdict: `revisit thresholds` if any site's Performance grade moves by more than one step because of coverage,
// else `default off` if the median LCP or blocking-time change is above +5%, else `default on`.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getPlugins } from '../extension/plugins/index.js';
import { scoreReading } from '../extension/core/score.js';

export const OVERHEAD_LIMIT = 5; // percent
export const MAX_GRADE_STEPS = 1;
export const LCP_FLOOR = 500; // ms
export const BLOCKING_FLOOR = 50; // ms
/** grade()'s values, best first: one index apart is one grade step. */
export const GRADE_STEPS = ['A+', 'A', 'A−', 'B+', 'B', 'B−', 'C+', 'C', 'C−', 'D+', 'D', 'D−', 'F'];

/** The median of the finite numbers in `xs`; null when there are none. */
export function median(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Percent change from `off` to `on`; 0 when both are 0, null when either is missing or `off` alone is 0. */
export function percentChange(on, off) {
  if (!Number.isFinite(on) || !Number.isFinite(off)) return null;
  if (off === 0) return on === 0 ? 0 : null;
  return ((on - off) / off) * 100;
}

/** Whether a site's on/off pair counts towards the median: false when both values are under `floor` (or missing). */
export function counts(on, off, floor) {
  return Number.isFinite(on) && Number.isFinite(off) && !(on < floor && off < floor);
}

/** Signed grade steps from grade `a` to grade `b` (positive = worse); null when either is not a grade. */
export function gradeSteps(a, b) {
  const i = GRADE_STEPS.indexOf(a);
  const j = GRADE_STEPS.indexOf(b);
  return i < 0 || j < 0 ? null : j - i;
}

/** LCP and blocking time (ms) from a reading's vitals plugin data. */
export function timings(reading) {
  const d = reading?.log?._harplus?.plugins?.vitals?.data || {};
  const num = (x) => (Number.isFinite(x) ? x : null);
  return { lcp: num(d.lcp?.time), blocking: num(d.blockingTime) };
}

/** Performance { score, grade } of a reading, optionally with one plugin's result left out. */
export function performance(reading, plugins = [], { without } = {}) {
  const h = reading.log._harplus;
  const results = { ...(h.plugins || {}) };
  if (without) delete results[without];
  const a = scoreReading({ ...reading, log: { ...reading.log, _harplus: { ...h, plugins: results } } }, plugins).areas.performance;
  return { score: a.score, grade: a.grade };
}

/** The verdict from the per-site rows and the medians. */
export function verdict(rows, medians) {
  if (rows.some((r) => r.steps != null && Math.abs(r.steps) > MAX_GRADE_STEPS)) return 'revisit thresholds';
  if ((medians.lcp ?? 0) > OVERHEAD_LIMIT || (medians.blocking ?? 0) > OVERHEAD_LIMIT) return 'default off';
  return 'default on';
}

async function readDir(dir) {
  const out = new Map();
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.har')).sort()) {
    out.set(f.replace(/\.har$/, ''), JSON.parse(await readFile(join(dir, f), 'utf8')));
  }
  return out;
}

/** The median timing of one site across passes (Maps of site → reading); null for a metric no pass has. */
export function passMedian(runs, site) {
  const t = runs.map((m) => m.get(site)).filter(Boolean).map(timings);
  return { lcp: median(t.map((x) => x.lcp)), blocking: median(t.map((x) => x.blocking)), passes: t.length };
}

/** Rows for every site present in both states. `on` and `off` are a Map of site → reading, or an array of them (passes). */
export function compareRuns(on, off, plugins = getPlugins()) {
  const onRuns = Array.isArray(on) ? on : [on];
  const offRuns = Array.isArray(off) ? off : [off];
  const sites = [...new Set(onRuns.flatMap((m) => [...m.keys()]))].sort()
    .filter((site) => offRuns.some((m) => m.has(site)));
  const rows = sites.map((site) => {
    const a = passMedian(onRuns, site);
    const b = passMedian(offRuns, site);
    const grades = onRuns.map((m) => m.get(site)).filter(Boolean).map((r) => {
      const withCov = performance(r, plugins);
      const withoutCov = performance(r, plugins, { without: 'coverage' });
      return {
        coverage: r.log._harplus.plugins?.coverage?.status ?? 'none',
        gradeWith: withCov.grade, gradeWithout: withoutCov.grade, scoreWith: withCov.score, scoreWithout: withoutCov.score,
        steps: gradeSteps(withoutCov.grade, withCov.grade),
      };
    });
    const worst = grades.reduce((x, g) => (Math.abs(g.steps ?? 0) > Math.abs(x?.steps ?? 0) ? g : x), grades[0]);
    return {
      site, passesOn: a.passes, passesOff: b.passes,
      lcpOn: a.lcp, lcpOff: b.lcp, lcpPct: percentChange(a.lcp, b.lcp), lcpCounts: counts(a.lcp, b.lcp, LCP_FLOOR),
      blockingOn: a.blocking, blockingOff: b.blocking, blockingPct: percentChange(a.blocking, b.blocking),
      blockingCounts: counts(a.blocking, b.blocking, BLOCKING_FLOOR),
      grades, ...worst,
    };
  });
  const medians = {
    lcp: median(rows.filter((r) => r.lcpCounts).map((r) => r.lcpPct)),
    blocking: median(rows.filter((r) => r.blockingCounts).map((r) => r.blockingPct)),
    lcpSites: rows.filter((r) => r.lcpCounts && r.lcpPct != null).length,
    blockingSites: rows.filter((r) => r.blockingCounts && r.blockingPct != null).length,
  };
  return { rows, medians, verdict: verdict(rows, medians) };
}

const ms = (x) => (x == null ? '—' : `${Math.round(x)}`);
const pc = (x) => (x == null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(1)}%`);

async function main() {
  const [onArg, offArg] = process.argv.slice(2);
  if (!onArg || !offArg) {
    console.error('Usage: node scripts/coverage-overhead.mjs <dirOn>[,<dirOn2>…] <dirOff>[,<dirOff2>…]');
    process.exit(2);
  }
  const on = await Promise.all(onArg.split(',').map(readDir));
  const off = await Promise.all(offArg.split(',').map(readDir));
  const { rows, medians, verdict: v } = compareRuns(on, off);
  const all = (runs) => new Set(runs.flatMap((m) => [...m.keys()]));
  const [allOn, allOff] = [all(on), all(off)];
  const missing = [...new Set([...allOn, ...allOff])].filter((s) => !allOn.has(s) || !allOff.has(s));
  const mark = (x, ok) => `${pc(x)}${ok ? '' : ' (floor)'}`;
  console.log(`Passes: ${on.length} on, ${off.length} off; per-state values are the median of a site's passes.`);
  console.log(`(floor) = left out of the median: both under ${LCP_FLOOR} ms (LCP) or ${BLOCKING_FLOOR} ms (blocking time).\n`);
  console.log('| Site | Passes on/off | LCP on | LCP off | LCP Δ | Blocking on | Blocking off | Blocking Δ |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) console.log(`| ${r.site} | ${r.passesOn}/${r.passesOff} | ${ms(r.lcpOn)} | ${ms(r.lcpOff)} | ${mark(r.lcpPct, r.lcpCounts)} | ${ms(r.blockingOn)} | ${ms(r.blockingOff)} | ${mark(r.blockingPct, r.blockingCounts)} |`);
  console.log(`\nMedian change: LCP ${pc(medians.lcp)} (${medians.lcpSites} sites), blocking time ${pc(medians.blocking)} (${medians.blockingSites} sites)`);
  if (missing.length) console.log(`Not in both states: ${missing.join(', ')}`);
  console.log('\n| Site | Pass | Coverage result | Performance with coverage | without | Steps |');
  console.log('|---|---:|---|---|---|---:|');
  for (const r of rows) r.grades.forEach((g, i) => console.log(`| ${r.site} | ${i + 1} | ${g.coverage} | ${g.gradeWith} (${g.scoreWith}) | ${g.gradeWithout} (${g.scoreWithout}) | ${g.steps ?? '—'} |`));
  const maxSteps = Math.max(0, ...rows.flatMap((r) => r.grades.map((g) => Math.abs(g.steps ?? 0))));
  console.log(`\nLargest grade shift: ${maxSteps} step${maxSteps === 1 ? '' : 's'}`);
  console.log(`Verdict: ${v}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch((e) => { console.error(e); process.exit(1); });
