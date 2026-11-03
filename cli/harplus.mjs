#!/usr/bin/env node
// HARgus command line: upgrade any HAR file to HAR-PLUS with the same analyze/enrich plugins
// the extension uses, and print readouts. No dependencies (Node 20+).

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ensureHarPlus, findings, severityCounts, summaryValue, toMarkdown } from '../extension/core/harplus.js';
import { interstitialNotice } from '../extension/core/interstitial.js';
import { punchItems, punchMarkdown, punchListBlocker, parsePunchList, recheckList, pathOf } from '../extension/core/punchlist.js';
import { runPlugins, pluginEnabled } from '../extension/core/plugin-host.js';
import { getPlugins, PHASE_LABELS } from '../extension/plugins/index.js';
import { PROFILES, AREAS, scoreReading, profileFromSettings } from '../extension/core/score.js';
import { standaloneDocument } from '../extension/ui/report.js';
import { whois } from './whois.mjs';
import { openRecorder } from './record.mjs';

const USAGE = `HARgus — take a reading of any web page (files are saved as HAR-PLUS)

Usage:
  hargus analyze <file.har> [options]   add analysis + lookups, write a HAR-PLUS file
  hargus summary <file.har> [--md] [--report <out.html>]   print the readout and findings
  hargus punchlist <file.har> [-o out.md]   write the reading's punch list (default <name>.punchlist.md)
  hargus recheck <list.md> [options]    record the page again and mark each item of the list
  hargus plugins                        list plugins
  (the older name "harplus" still works)

Options for analyze:
  -o, --out <file>        output path (default: <name>.plus.har)
      --report <file>     also write a standalone HTML report
      --no-lookups        offline only (skip the enrich phase)
      --no-link-check     skip the link check (links plugin)
      --only <ids>        run only these plugins (comma-separated)
      --enable <ids>      also run plugins that are off by default (e.g. html-validate)
      --skip <ids>        skip these plugins
      --resolver <name>   DoH resolver: cloudflare | google | https://…
      --remote <url>      add a remote plugin endpoint (repeatable)
      --quiet             no progress output
      --profile <id>      scoring profile: general | content | commerce | webapp | public

Options for recheck:
      --url <url>         page to record (default: the list's URL; IDs use this URL's path)
  -o, --out <file>        write the rechecked list here (default: rewrite the list in place)
      --local             judge as a local server: Deploy and timing items wait for the deploy
      --reading <file>    use a saved reading instead of recording (needs Playwright otherwise)
      --timeout <S>       seconds for the recording (default 300 per timing run)
  Prints a one-line summary. Exit 0: nothing still there and nothing new; 1: otherwise;
  2: recording failed, a bot check or waiting page, or the list's block is missing.

API keys come from the environment:
  PAGESPEED_API_KEY, HARPLUS_IPINFO_TOKEN, ABUSEIPDB_KEY, VT_API_KEY, GREYNOISE_KEY
`;

const tty = process.stdout.isTTY;
const color = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = { dim: color(2), bold: color(1), red: color(31), yellow: color(33), blue: color(34), cyan: color(36), green: color(32) };
const SEV = { high: C.red, medium: C.yellow, low: C.blue, info: C.dim };
const list = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);

function printReadout(reading, settings = {}) {
  const hp = reading.log._harplus;
  const t = hp.target;
  console.log(`\n${C.bold(t.title || t.host)}  ${C.cyan(t.finalUrl || t.url)}`);
  const { overall } = scoreReading(reading, getPlugins(), { profile: profileFromSettings(settings) });
  const label = (id) => AREAS.find((a) => a.id === id)?.label || id;
  const names = (ids) => ids.map(label).join(', ');
  const notice = interstitialNotice(reading);
  if (notice) console.log(C.yellow(notice));
  let line = overall.score == null ? 'Overall not measured' : `Overall ${overall.score} ${overall.grade}`;
  line += ` · scored as ${overall.profile.label}`;
  if (overall.capped) line += ` · capped at D (${names(overall.capped.areas)})`;
  else if (overall.failingCritical.length) line += ` · failing critical: ${names(overall.failingCritical)}`;
  console.log(C.bold(line));
  console.log(C.dim(`${hp.capturedAt} · ${reading.log.entries.length} requests · ${hp.capture?.mode || 'reading'}`));
  for (const r of Object.values(hp.plugins)) {
    if (!r.summary?.length && r.status === 'ok') continue;
    const status = r.status === 'ok' ? C.green('●') : r.status === 'error' ? C.red('●') : C.dim('○');
    console.log(`\n${status} ${C.bold(r.name)}${r.status !== 'ok' ? C.dim(` — ${r.status}: ${r.error}`) : ''}`);
    for (const s of r.summary || []) console.log(`  ${C.dim(s.label.padEnd(24))} ${summaryValue(s)}`);
  }
  const all = findings(reading);
  const counts = severityCounts(reading);
  console.log(`\n${C.bold('Findings')}  ${Object.entries(counts).map(([k, v]) => SEV[k](`${v} ${k}`)).join('  ')}`);
  for (const f of all.filter((x) => x.severity !== 'info')) {
    console.log(`  ${SEV[f.severity](f.severity.toUpperCase().padEnd(6))} ${C.dim(f.category.padEnd(14))} ${f.title}`);
  }
  console.log();
}

async function load(file) {
  const har = JSON.parse(await readFile(file, 'utf8'));
  return ensureHarPlus(har, { fileName: file.split('/').pop() });
}

const THEME = fileURLToPath(new URL('../extension/ui/theme.css', import.meta.url));

async function writeReport(reading, plugins, file, settings = {}) {
  await writeFile(file, standaloneDocument(reading, plugins, { css: await readFile(THEME, 'utf8'), settings }));
  process.stderr.write(`${C.dim('wrote')} ${file}\n`);
}

async function analyze(file, opts) {
  const reading = await load(file);
  const enable = list(opts.enable);
  const skip = list(opts.skip);
  const settings = {
    keys: {
      pagespeed: process.env.PAGESPEED_API_KEY, ipinfo: process.env.HARPLUS_IPINFO_TOKEN, abuseipdb: process.env.ABUSEIPDB_KEY,
      virustotal: process.env.VT_API_KEY, greynoise: process.env.GREYNOISE_KEY,
    },
    lookups: { resolver: opts.resolver || 'cloudflare' },
    phases: { enrich: !opts['no-lookups'] },
    plugins: {
      ...(opts['no-lookups'] ? { tech: { options: { fingerprintDb: false } } } : {}), // fully offline
      ...Object.fromEntries([...enable.map((id) => [id, { enabled: true }]), ...skip.map((id) => [id, { enabled: false }])]),
      ...(opts['no-link-check'] ? { links: { enabled: false } } : {}),
    },
    remotes: (opts.remote || []).map((url, i) => ({ id: `cli-${i + 1}`, name: `Remote ${i + 1}`, url, send: 'reading-lite' })),
  };
  const plugins = getPlugins(settings);
  const only = list(opts.only).filter((id) => !(opts['no-link-check'] && id === 'links'));
  await runPlugins(reading, plugins, {
    phases: ['analyze', 'enrich'],
    settings,
    whois,
    only: list(opts.only).length ? only : undefined,
    onProgress: (p) => {
      if (opts.quiet || p.status === 'running') return;
      const mark = p.status === 'ok' ? C.green('✓') : p.status === 'error' ? C.red('✗') : C.dim('–');
      process.stderr.write(`${mark} ${p.name}${p.error ? C.dim(` (${p.error})`) : ''}\n`);
    },
  });
  const out = opts.out || file.replace(/(\.plus)?\.(har|json)$/i, '') + '.plus.har';
  await writeFile(out, JSON.stringify(reading, null, 1));
  if (!opts.quiet) printReadout(reading, { scoring: { profile: opts.profile || 'general' } });
  process.stderr.write(`${C.dim('wrote')} ${out}\n`);
  if (opts.report) await writeReport(reading, plugins, opts.report, { scoring: { profile: opts.profile || 'general' } });
}

/** An Error that ends the command with `exitCode` (2: the punch list or recheck could not be made). */
const failure = (message, exitCode = 2) => Object.assign(new Error(message), { exitCode });

async function punchlist(file, opts) {
  const reading = await load(file);
  const blocker = punchListBlocker(reading);
  if (blocker) throw failure(blocker);
  const out = opts.out || file.replace(/(\.plus)?\.(har|json)$/i, '') + '.punchlist.md';
  await writeFile(out, punchMarkdown(reading, punchItems(reading, { plugins: getPlugins() })));
  process.stderr.write(`${C.dim('wrote')} ${out}\n`);
}

/** Seconds for one recording: --timeout, else 300 per timing run. Throws on a value that is not a usable timer. */
function recheckTimeout(value, runs) {
  if (value === undefined) return 300 * ([1, 3, 5].includes(runs) ? runs : 1);
  const sec = Number(value);
  // Node clamps a timer above 2^31-1 ms to 1 ms, so "Infinity" would time out at once.
  if (!(sec > 0 && sec <= 2147483)) throw failure('--timeout must be a positive number of seconds, at most 2147483');
  return sec;
}

/** The new reading: a saved one (--reading), else a headless recording of `url` with the list's capture settings. */
async function recheckReading(url, settings, opts) {
  if (opts.reading) return load(opts.reading);
  const timeoutSec = recheckTimeout(opts.timeout, settings.runs);
  const keys = ['device', 'throttle', 'bypassCache', 'runs', 'coverage', 'views'];
  const capture = Object.fromEntries(keys.filter((k) => settings[k] !== undefined).map((k) => [k, settings[k]]));
  let recorder;
  try {
    recorder = await openRecorder({ settings: { capture } });
    const reading = await recorder.record(url, { timeoutSec });
    if (!reading) throw new Error('no reading');
    return ensureHarPlus(reading, { fileName: 'recheck.har' });
  } catch (e) {
    throw failure(e.message === 'timed out' ? `recording ${url} timed out after ${timeoutSec} s` : `recording ${url} failed: ${e.message}`);
  } finally {
    await recorder?.close();
  }
}

async function recheck(file, opts) {
  if (opts.timeout !== undefined) recheckTimeout(opts.timeout, 1);
  const list = parsePunchList(await readFile(file, 'utf8'));
  if (!list) throw failure(`${file} has no readable punch list block: export a fresh list from the reading`);
  const url = opts.url || list.meta.url;
  const settings = list.meta.settings && typeof list.meta.settings === 'object' ? list.meta.settings : {};
  const reading = await recheckReading(url, settings, opts);
  const notice = interstitialNotice(reading);
  if (notice) throw failure(`${notice} The list was not changed.`);
  const blocker = punchListBlocker(reading);
  if (blocker) throw failure(blocker);
  const now = Date.now();
  const out = recheckList(list, reading, { url, local: !!opts.local, now, plugins: getPlugins() });
  const t = reading.log._harplus.target || {};
  const finalPath = pathOf(t.finalUrl || t.url || url);
  const summary = `${out.summary}${finalPath !== pathOf(url) ? ` (redirected to ${finalPath})` : ''}`;
  const md = punchMarkdown(reading, out.items, {
    statuses: out.statuses, added: out.added, dismissed: out.dismissed, url: list.meta.url, checkedAt: now, summary,
  });
  await writeFile(opts.out || file, md);
  console.log(summary);
  process.exitCode = out.exitCode;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      'no-lookups': { type: 'boolean' },
      'no-link-check': { type: 'boolean' },
      only: { type: 'string' },
      enable: { type: 'string' },
      skip: { type: 'string' },
      resolver: { type: 'string' },
      remote: { type: 'string', multiple: true },
      md: { type: 'boolean' },
      report: { type: 'string' },
      quiet: { type: 'boolean', short: 'q' },
      profile: { type: 'string' },
      url: { type: 'string' },
      local: { type: 'boolean' },
      reading: { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.profile && !PROFILES[values.profile]) throw new Error(`unknown profile "${values.profile}" (use ${Object.keys(PROFILES).join(', ')})`);
  const scoring = { scoring: { profile: values.profile || 'general' } };
  const [cmd, file] = positionals;
  if (values.help || !cmd) { console.log(USAGE); return; }
  if (cmd === 'plugins') {
    for (const [phase, label] of Object.entries(PHASE_LABELS)) {
      console.log(`\n${C.bold(label)} ${C.dim(`(${phase})`)}`);
      for (const p of getPlugins().filter((x) => x.phase === phase)) {
        const where = phase === 'page' ? C.dim(' [extension only]') : '';
        console.log(`  ${(pluginEnabled(p) ? C.green('on ') : C.dim('off'))} ${p.id.padEnd(14)} ${p.description}${where}`);
      }
    }
    console.log();
    return;
  }
  if (cmd === 'recheck') {
    if (!file) throw failure(`missing <list.md>\n\n${USAGE}`);
    return recheck(file, values);
  }
  if (!file) throw new Error(`missing <file.har>\n\n${USAGE}`);
  if (cmd === 'punchlist') return punchlist(file, values);
  if (cmd === 'analyze') return analyze(file, values);
  if (cmd === 'summary') {
    const reading = await load(file);
    if (values.md) process.stdout.write(toMarkdown(reading));
    else printReadout(reading, scoring);
    if (values.report) await writeReport(reading, getPlugins(), values.report, scoring);
    return;
  }
  throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
}

// Any failure of recheck (bad options included) exits 2: its exit 1 means "items still there".
const command = process.argv.slice(2).find((a) => !a.startsWith('-'));
main().catch((e) => {
  console.error(C.red(`harplus: ${e.message}`));
  process.exit(e.exitCode ?? (command === 'recheck' ? 2 : 1));
});
