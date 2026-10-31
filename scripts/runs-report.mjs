#!/usr/bin/env node
// Prints the run-to-run spread of a calibrate --runs N output directory: one row per site and metric
// (median, range as a percent of the median, whether it varies), and the seconds each extra run costs.
// Usage: node scripts/runs-report.mjs <runs-dir> [--baseline <1-run dir>]
// Reads <dir>/digest.json (entries carry vitalsRuns = vitals runs.metrics, and durationMs) and each reading's capture.durationMs.

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BASELINE = '/Users/tpowell/src/har-plus/test/e2e/out/calibrate';

/** The median of numbers (the mean of the middle two when even); null when there are none. */
export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** [{ site, metric, median, rangePct, varies }] from a calibrate digest. Sites that failed or had no runs add none. */
export function rows(digest) {
  return digest.flatMap((d) => Object.entries(d.vitalsRuns?.metrics || {}).filter(([, m]) => m).map(([metric, m]) => ({
    site: d.url,
    metric,
    median: m.median,
    rangePct: m.median > 0 ? Math.round(((m.max - m.min) / m.median) * 100) : (m.max === m.min ? 0 : null),
    varies: !!m.varies,
  })));
}

/** Seconds one extra run adds: (median 3-run capture - median 1-run capture) / 2, to the nearest second; null without data. */
export function extraRunSeconds(durations3, durations1, extra = 2) {
  const a = median(durations3), b = median(durations1);
  return a === null || b === null ? null : Math.round((a - b) / extra / 1000);
}

/** A text table of the rows and the share that vary. */
export function formatRows(list) {
  const lines = list.map((r) => `| ${r.site} | ${r.metric} | ${Number.isFinite(r.median) ? Math.round(r.median * 1000) / 1000 : '–'} | ${r.rangePct === null ? '–' : `${r.rangePct}%`} | ${r.varies ? 'varies' : 'steady'} |`);
  const n = list.filter((r) => r.varies).length;
  const share = list.length ? Math.round((n / list.length) * 100) : 0;
  return ['| Site | Metric | Median | Range | Varies |', '| --- | --- | --- | --- | --- |', ...lines, '', `${n} of ${list.length} site-metric pairs vary (${share}%)`].join('\n');
}

async function durations(dir, names) {
  const out = {};
  for (const f of names) {
    try { out[f] = JSON.parse(await readFile(join(dir, f), 'utf8')).log._harplus.capture.durationMs; } catch { /* no reading */ }
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const bi = argv.indexOf('--baseline');
  const baseline = bi >= 0 ? argv[bi + 1] : DEFAULT_BASELINE;
  const dir = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--baseline');
  if (!dir) { console.error('Usage: node scripts/runs-report.mjs <runs-dir> [--baseline <1-run dir>]'); process.exit(2); }
  const digest = JSON.parse(await readFile(join(resolve(dir), 'digest.json'), 'utf8'));
  console.log(formatRows(rows(digest)));
  const hars = (await readdir(dir)).filter((f) => f.endsWith('.har'));
  const d3 = await durations(dir, hars);
  const d1 = await durations(baseline, hars);
  const shared = hars.filter((f) => Number.isFinite(d3[f]) && Number.isFinite(d1[f]));
  const sec = extraRunSeconds(shared.map((f) => d3[f]), shared.map((f) => d1[f]));
  console.log(`\nCapture time (${shared.length} sites in both): 3 runs median ${(median(shared.map((f) => d3[f])) / 1000).toFixed(1)} s, 1 run median ${(median(shared.map((f) => d1[f])) / 1000).toFixed(1)} s`);
  console.log(`Seconds per extra run: ${sec ?? 'n/a'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
