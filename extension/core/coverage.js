// Load coverage: V8 precise block coverage and CSS rule usage → a compact per-file summary of bytes not used.
// Pure: used by capture (one load window) and the coverage plugin. Offsets are characters, treated as bytes.

import { siteOf, isThirdParty, hostOf } from './har-util.js';

export const COVERAGE_CAP = 100;
export const SKIP = {
  snapshot: 'needs a reload: the page was already loaded',
  record: 'a recording spans several pages',
  off: 'turned off in Options',
};

const KEPT_SCHEME = /^(https?|file):/i;
const noHash = (u) => String(u || '').split('#')[0];

/** Unused bytes of one script's block coverage: inner ranges override outer ones; segments ending at count 0 are unused. */
function unusedOf(ranges) {
  const points = [];
  for (const r of ranges) {
    points.push({ offset: r.startOffset, start: true, r });
    points.push({ offset: r.endOffset, start: false, r });
  }
  const len = (r) => r.endOffset - r.startOffset;
  points.sort((a, b) => a.offset - b.offset
    || (a.start === b.start ? (a.start ? len(b.r) - len(a.r) : len(a.r) - len(b.r)) : a.start ? 1 : -1));
  const stack = [];
  let last = 0;
  let unused = 0;
  for (const p of points) {
    if (stack.length && stack[stack.length - 1] === 0) unused += p.offset - last;
    last = p.offset;
    if (p.start) stack.push(p.r.count); else stack.pop();
  }
  return unused;
}

/** Merge rows: inline rows sum into one; a URL seen twice keeps the largest size and smallest unused. */
function collect(rows) {
  const byUrl = new Map();
  let inline = null;
  for (const row of rows) {
    if (row.inline) {
      inline ||= { url: '', bytes: 0, unusedBytes: 0, inline: true };
      inline.bytes += row.bytes;
      inline.unusedBytes += row.unusedBytes;
      continue;
    }
    const seen = byUrl.get(row.url);
    if (!seen) byUrl.set(row.url, { url: row.url, bytes: row.bytes, unusedBytes: row.unusedBytes });
    else { seen.bytes = Math.max(seen.bytes, row.bytes); seen.unusedBytes = Math.min(seen.unusedBytes, row.unusedBytes); }
  }
  return inline ? [...byUrl.values(), inline] : [...byUrl.values()];
}

/** Profiler.takePreciseCoverage `result` → File[]; document-URL scripts form one inline row; eval, data:, blob: and extension scripts are left out. */
export function jsFiles(profileResult = [], { documentUrl = '' } = {}) {
  const doc = noHash(documentUrl);
  const rows = [];
  for (const s of profileResult || []) {
    const url = s?.url || '';
    if (!KEPT_SCHEME.test(url)) continue;
    const ranges = (s.functions || []).flatMap((f) => f.ranges || []);
    if (!ranges.length) continue;
    const bytes = Math.max(...ranges.map((r) => r.endOffset));
    const unusedBytes = unusedOf(ranges);
    rows.push(noHash(url) === doc ? { bytes, unusedBytes, inline: true } : { url, bytes, unusedBytes });
  }
  return collect(rows);
}

/** CSS.stopRuleUsageTracking `ruleUsage` + styleSheetAdded headers → File[]; unused = length − union of used rule ranges. */
export function cssFiles(ruleUsage = [], headers = new Map(), { documentUrl = '', mainFrameId } = {}) {
  const doc = noHash(documentUrl);
  const used = new Map();
  for (const u of ruleUsage || []) {
    if (!used.has(u.styleSheetId)) used.set(u.styleSheetId, []);
    if (u.used) used.get(u.styleSheetId).push([u.startOffset, u.endOffset]);
  }
  const rows = [];
  for (const [id, spans] of used) {
    const h = headers?.get(id);
    if (!h) continue;
    if (mainFrameId && h.frameId !== mainFrameId) continue;
    const url = h.sourceURL || '';
    const inline = Boolean(h.isInline || h.isConstructed || !url || noHash(url) === doc);
    if (!inline && !KEPT_SCHEME.test(url)) continue;
    const bytes = Math.max(0, h.length || 0);
    let covered = 0;
    let end = 0;
    for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
      const from = Math.max(a, end, 0);
      const to = Math.min(b, bytes);
      if (to > from) covered += to - from;
      end = Math.max(end, b);
    }
    const unusedBytes = Math.max(0, bytes - covered);
    rows.push(inline ? { bytes, unusedBytes, inline: true } : { url, bytes, unusedBytes });
  }
  return collect(rows);
}

/** File[] → { files (largest `cap` by unusedBytes, with thirdParty), totalBytes, unusedBytes, fileCount } with true totals. */
export function summarize(files = [], { site, cap = COVERAGE_CAP } = {}) {
  let totalBytes = 0;
  let unusedBytes = 0;
  for (const f of files) { totalBytes += f.bytes; unusedBytes += f.unusedBytes; }
  const top = [...files]
    .sort((a, b) => b.unusedBytes - a.unusedBytes || b.bytes - a.bytes || a.url.localeCompare(b.url))
    .slice(0, cap)
    .map((f) => ({ ...f, thirdParty: f.url ? isThirdParty(hostOf(f.url), site) : false }));
  return { files: top, totalBytes, unusedBytes, fileCount: files.length };
}

/** Raw CDP coverage for one load → the stored `log._harplus.coverage` shape. */
export function buildCoverage({ profile, ruleUsage, headers, documentUrl = '', mainFrameId, idle = true } = {}) {
  const site = siteOf(hostOf(documentUrl));
  return {
    window: 'load',
    idle: idle !== false,
    js: summarize(jsFiles(profile, { documentUrl }), { site }),
    css: summarize(cssFiles(ruleUsage, headers, { documentUrl, mainFrameId }), { site }),
  };
}
