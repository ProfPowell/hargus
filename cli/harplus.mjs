#!/usr/bin/env node
// HAR-PLUS command line: upgrade any HAR file to HAR-PLUS with the same analyze/enrich plugins
// the extension uses, and print readouts. No dependencies (Node 20+).

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ensureHarPlus, findings, severityCounts, summaryValue, toMarkdown } from '../extension/core/harplus.js';
import { runPlugins, pluginEnabled } from '../extension/core/plugin-host.js';
import { getPlugins, PHASE_LABELS } from '../extension/plugins/index.js';
import { standaloneDocument } from '../extension/ui/report.js';
import { whois } from './whois.mjs';

const USAGE = `HAR-PLUS — a tricorder for web pages

Usage:
  harplus analyze <file.har> [options]   add analysis + lookups, write a HAR-PLUS file
  harplus summary <file.har> [--md] [--report <out.html>]   print the readout and findings
  harplus plugins                        list plugins

Options for analyze:
  -o, --out <file>        output path (default: <name>.plus.har)
      --report <file>     also write a standalone HTML report
      --no-lookups        offline only (skip the enrich phase)
      --only <ids>        run only these plugins (comma-separated)
      --enable <ids>      also run plugins that are off by default (e.g. html-validate)
      --skip <ids>        skip these plugins
      --resolver <name>   DoH resolver: cloudflare | google | https://…
      --remote <url>      add a remote plugin endpoint (repeatable)
      --quiet             no progress output

API keys come from the environment:
  PAGESPEED_API_KEY, HARPLUS_IPINFO_TOKEN, ABUSEIPDB_KEY, VT_API_KEY, GREYNOISE_KEY
`;

const tty = process.stdout.isTTY;
const color = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = { dim: color(2), bold: color(1), red: color(31), yellow: color(33), blue: color(34), cyan: color(36), green: color(32) };
const SEV = { high: C.red, medium: C.yellow, low: C.blue, info: C.dim };
const list = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);

function printReadout(reading) {
  const hp = reading.log._harplus;
  const t = hp.target;
  console.log(`\n${C.bold(t.title || t.host)}  ${C.cyan(t.finalUrl || t.url)}`);
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

async function writeReport(reading, plugins, file) {
  await writeFile(file, standaloneDocument(reading, plugins, { css: await readFile(THEME, 'utf8') }));
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
    },
    remotes: (opts.remote || []).map((url, i) => ({ id: `cli-${i + 1}`, name: `Remote ${i + 1}`, url, send: 'reading-lite' })),
  };
  const plugins = getPlugins(settings);
  const only = list(opts.only);
  await runPlugins(reading, plugins, {
    phases: ['analyze', 'enrich'],
    settings,
    whois,
    only: only.length ? only : undefined,
    onProgress: (p) => {
      if (opts.quiet || p.status === 'running') return;
      const mark = p.status === 'ok' ? C.green('✓') : p.status === 'error' ? C.red('✗') : C.dim('–');
      process.stderr.write(`${mark} ${p.name}${p.error ? C.dim(` (${p.error})`) : ''}\n`);
    },
  });
  const out = opts.out || file.replace(/(\.plus)?\.(har|json)$/i, '') + '.plus.har';
  await writeFile(out, JSON.stringify(reading, null, 1));
  if (!opts.quiet) printReadout(reading);
  process.stderr.write(`${C.dim('wrote')} ${out}\n`);
  if (opts.report) await writeReport(reading, plugins, opts.report);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      'no-lookups': { type: 'boolean' },
      only: { type: 'string' },
      enable: { type: 'string' },
      skip: { type: 'string' },
      resolver: { type: 'string' },
      remote: { type: 'string', multiple: true },
      md: { type: 'boolean' },
      report: { type: 'string' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
    },
  });
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
  if (!file) throw new Error(`missing <file.har>\n\n${USAGE}`);
  if (cmd === 'analyze') return analyze(file, values);
  if (cmd === 'summary') {
    const reading = await load(file);
    if (values.md) process.stdout.write(toMarkdown(reading));
    else printReadout(reading);
    if (values.report) await writeReport(reading, getPlugins(), values.report);
    return;
  }
  throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
}

main().catch((e) => {
  console.error(C.red(`harplus: ${e.message}`));
  process.exit(1);
});
