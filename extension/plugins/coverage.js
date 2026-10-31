// Code coverage: the JavaScript that did not run and the CSS rules that matched nothing while the page loaded,
// from the summary capture stores at log._harplus.coverage. Offline, so it re-runs on saved readings.
// Not used during load is not dead code: menus, forms and later pages may use it. Every label says so.

import { transferSize, formatBytes } from '../core/har-util.js';
import { SkipError } from '../core/plugin-host.js';

const KB = 1024;
/** Estimated transfer waste per kind: a finding at `low` or `medium`; files under `minFile` don't count towards it. */
export const THRESHOLDS = {
  js: { low: 40 * KB, medium: 150 * KB, minFile: 10 * KB },
  css: { low: 15 * KB, medium: 50 * KB, minFile: 5 * KB },
};
const NAME = { js: 'JavaScript', css: 'CSS' };
const SHORT = { js: 'JS', css: 'CSS' };
const INLINE = { js: 'inline scripts', css: 'inline styles' };
const EVIDENCE_LINES = 10;

const pctOf = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

/** URL → transfer size of the first entry with that URL and a positive transfer size (the recorder keeps main-frame requests). */
function transferByUrl(entries = []) {
  const map = new Map();
  for (const e of entries) {
    const url = e?.request?.url;
    if (!url || map.has(url)) continue;
    const size = transferSize(e);
    if (size > 0) map.set(url, size);
  }
  return map;
}

/** One kind's stored summary → files with estimated waste (unused share × transfer, or unused decoded bytes), splits and totals. */
function analyseKind(kind, stored = {}, transfers) {
  const first = { bytes: 0, unusedBytes: 0 };
  const third = { bytes: 0, unusedBytes: 0 };
  const files = (stored.files || []).map((f) => {
    const bytes = Math.max(0, Number(f.bytes) || 0);
    const unusedBytes = Math.min(bytes, Math.max(0, Number(f.unusedBytes) || 0));
    const transfer = f.url ? transfers.get(f.url) || 0 : 0;
    const decodedOnly = !(transfer > 0 && bytes > 0);
    const waste = decodedOnly ? unusedBytes : Math.round((unusedBytes / bytes) * transfer);
    const side = f.thirdParty ? third : first;
    side.bytes += bytes; side.unusedBytes += unusedBytes;
    return {
      url: f.url || '', kind, bytes, unusedBytes, pct: pctOf(unusedBytes, bytes), thirdParty: Boolean(f.thirdParty), waste, decodedOnly,
      ...(f.inline ? { inline: true } : {}),
    };
  }).sort((a, b) => b.waste - a.waste || b.unusedBytes - a.unusedBytes);
  return {
    totalBytes: Math.max(0, Number(stored.totalBytes) || 0),
    unusedBytes: Math.max(0, Number(stored.unusedBytes) || 0),
    fileCount: Math.max(0, Number(stored.fileCount) || 0), // true count: files is capped at 100
    waste: files.reduce((n, f) => n + f.waste, 0),
    first,
    third,
    files,
  };
}

/** At most one finding per kind, from the files whose estimated waste reaches the per-file minimum. */
function finding(kind, k) {
  const t = THRESHOLDS[kind];
  const counted = k.files.filter((f) => f.waste >= t.minFile);
  const waste = counted.reduce((n, f) => n + f.waste, 0);
  if (waste < t.low) return null;
  const pct = pctOf(k.unusedBytes, k.totalBytes);
  const detail = `${pct}% of ${formatBytes(k.totalBytes)} of ${NAME[kind]} (before compression) was not used during load: `
    + `${formatBytes(k.first.unusedBytes)} first party, ${formatBytes(k.third.unusedBytes)} third party. `
    + `About ${formatBytes(waste)} of transfer across ${counted.length} file${counted.length === 1 ? '' : 's'}.`;
  const line = (f) => `${formatBytes(f.waste)} est. transfer · ${formatBytes(f.unusedBytes)} of ${formatBytes(f.bytes)} not used during load (${f.pct}%)`
    + `${f.decodedOnly ? ' · size before compression' : ''} · ${f.inline ? INLINE[kind] : f.url}`;
  const lines = counted.slice(0, EVIDENCE_LINES).map(line);
  if (counted.length > EVIDENCE_LINES) lines.push(`… ${counted.length - EVIDENCE_LINES} more`);
  const places = counted.filter((f) => f.url).slice(0, 200).map((f) => ({ url: f.url }));
  return {
    severity: waste >= t.medium ? 'medium' : 'low',
    category: 'performance',
    title: `${NAME[kind]} not used during load: about ${formatBytes(waste)}`,
    detail,
    evidence: lines.join('\n'),
    ...(places.length ? { places } : {}),
  };
}

const skipOf = (k) => (k?.skipped ? String(k.skipped) : null);
const FILES = { js: (n) => `${n} script${n === 1 ? '' : 's'}`, css: (n) => `${n} stylesheet${n === 1 ? '' : 's'}` };

function run(reading) {
  const cov = reading?.log?._harplus?.coverage;
  if (!cov) throw new SkipError('not measured in this reading');
  if (cov.skipped) throw new SkipError(String(cov.skipped));
  const [jsSkip, cssSkip] = [skipOf(cov.js), skipOf(cov.css)];
  if (jsSkip && cssSkip) throw new SkipError(jsSkip === cssSkip ? jsSkip : `${jsSkip}; ${cssSkip}`);
  const transfers = transferByUrl(reading.log.entries);
  // A skipped kind keeps only its reason: no finding, no headline, "not measured" in the panel.
  const js = jsSkip ? { skipped: jsSkip } : analyseKind('js', cov.js, transfers);
  const css = cssSkip ? { skipped: cssSkip } : analyseKind('css', cov.css, transfers);
  const measured = [['js', js], ['css', css]].filter(([, k]) => !k.skipped);
  const findings = measured.map(([kind, k]) => finding(kind, k)).filter(Boolean);
  const share = (k) => (k.totalBytes > 0 ? `${pctOf(k.unusedBytes, k.totalBytes)}%` : 'none measured');
  return {
    data: { js, css, idle: cov.idle !== false },
    findings,
    summary: [
      ...measured.map(([kind, k]) => ({ label: `${SHORT[kind]} not used`, value: share(k), headline: true })),
      { label: 'Est. transfer not used during load', value: measured.map(([kind, k]) => `${formatBytes(k.waste)} ${SHORT[kind]}`).join(' · ') },
      { label: 'Files measured', value: measured.map(([kind, k]) => FILES[kind](k.fileCount)).join(' · ') },
    ],
  };
}

/** Stats, the first- and third-party split, then the files with the most bytes not used during load. Help explains the term. */
function render(r, h) {
  const d = r.data || {};
  const js = d.js || {};
  const css = d.css || {};
  if (!js.totalBytes && !css.totalBytes) {
    const reason = js.skipped || css.skipped;
    return h.notice(`No scripts or stylesheets measured during load.${reason ? ` ${reason}.` : ''}`);
  }
  const kindStat = (kind, k) => (k.skipped
    ? h.stat({ label: `${SHORT[kind]} not used during load`, value: 'not measured', note: k.skipped })
    : h.stat({
      label: `${SHORT[kind]} not used during load`,
      value: k.totalBytes ? h.value(pctOf(k.unusedBytes, k.totalBytes), '%') : 'none',
      note: k.totalBytes ? h.html`${h.bytes(k.unusedBytes)} of ${h.bytes(k.totalBytes)}` : '',
    }));
  const split = [['js', js], ['css', css]].filter(([, k]) => k.totalBytes).flatMap(([kind, k]) => [['First party', k.first], ['Third party', k.third]]
    .filter(([, p]) => p?.bytes)
    .map(([party, p]) => ({ kind: NAME[kind], party, size: h.bytes(p.bytes), unused: h.bytes(p.unusedBytes), pct: h.value(pctOf(p.unusedBytes, p.bytes), '%') })));
  const files = [...(js.files || []), ...(css.files || [])].sort((a, b) => b.unusedBytes - a.unusedBytes || b.waste - a.waste);
  const rows = files.map((f) => ({
    file: f.inline ? INLINE[f.kind] : h.link(f.url),
    kind: NAME[f.kind],
    size: h.bytes(f.bytes),
    unused: h.bytes(f.unusedBytes),
    pct: h.value(f.pct, '%'),
    party: f.thirdParty ? 'third' : 'first',
    waste: f.decodedOnly ? h.html`${h.bytes(f.waste)} <small class="muted">size before compression</small>` : h.bytes(f.waste),
  }));
  const count = (js.fileCount || 0) + (css.fileCount || 0);
  return h.html`${d.idle === false ? h.notice('Coverage was taken while the page was still loading, so more code may have been about to run.', { state: 'fair' }) : ''}
    ${h.stats([
    kindStat('js', js),
    kindStat('css', css),
    h.stat({ label: 'Files measured', value: count, note: [['js', js], ['css', css]].filter(([, k]) => !k.skipped).map(([kind, k]) => FILES[kind](k.fileCount || 0)).join(' · ') }),
  ])}
    ${h.sub('First and third party', h.table(split, [
    { key: 'kind', label: 'Kind' }, { key: 'party', label: 'Party' }, { key: 'size', label: 'Size' },
    { key: 'unused', label: 'Not used during load' }, { key: 'pct', label: 'Share' },
  ]))}
    ${h.sub('Most not used during load', h.table(rows, [
    { key: 'file', label: 'File' }, { key: 'kind', label: 'Kind' }, { key: 'size', label: 'Size' },
    { key: 'unused', label: 'Not used during load' }, { key: 'pct', label: 'Share' }, { key: 'party', label: 'Party' },
    { key: 'waste', label: 'Est. transfer' },
  ]), count > files.length ? { sub: `first ${files.length} of ${count}` } : {})}`;
}

export default {
  id: 'coverage',
  name: 'Code coverage',
  version: '0.1.0',
  phase: 'analyze',
  group: 'quality',
  area: 'performance',
  description: 'JavaScript and CSS not used during load, with the estimated transfer it costs.',
  tags: ['performance'],
  run,
  render,
};
