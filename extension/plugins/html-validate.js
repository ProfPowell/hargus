// HTML conformance via the Nu Html Checker (validator.w3.org/nu or your own vnu.jar).
// Uses the recorded response body when available; otherwise re-fetches the page (no cookies).

import { mainEntry } from '../core/har-util.js';
import { HttpError } from '../core/plugin-host.js';

const decodeBase64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

/** A validator's line number as a place line: a whole number (or a numeric string), else none. */
const lineOf = (v) => { const n = typeof v === 'string' && v.trim() ? Number(v) : v; return Number.isInteger(n) && n >= 0 ? n : undefined; };

/**
 * Where each error is: its line and the source the checker quotes, with the message as a note. An error with
 * neither a line nor a quote has no location, so it stays in the counts and the kinds only. At most 200.
 */
function errorPlaces(errors) {
  const out = [];
  for (const e of errors) {
    if (out.length >= 200) break;
    const line = lineOf(e.line);
    const text = typeof e.extract === 'string' && e.extract.trim() ? e.extract : undefined;
    if (line == null && !text) continue;
    out.push({ ...(line != null ? { line } : {}), ...(text ? { text } : {}), ...(e.message ? { note: String(e.message) } : {}) });
  }
  return out;
}

async function run(reading, ctx) {
  const main = mainEntry(reading);
  const content = main?.response?.content;
  let html = content?.text ? (content.encoding === 'base64' ? decodeBase64(content.text) : content.text) : '';
  let source = 'recorded response';
  if (!html) {
    const r = await ctx.fetch(ctx.target.finalUrl);
    if (!r.ok) throw new HttpError(r.status, ctx.target.finalUrl);
    html = await r.text();
    source = 're-fetched without cookies';
  }
  const endpoint = String(ctx.options.endpoint || 'https://validator.w3.org/nu/').replace(/\/?$/, '/');
  const r = await ctx.fetch(`${endpoint}?out=json`, {
    method: 'POST', headers: { 'content-type': 'text/html; charset=utf-8' }, body: html,
  });
  if (!r.ok) throw new HttpError(r.status, endpoint);
  const j = await r.json();
  const messages = (j.messages || []).map((m) => ({
    type: m.type === 'info' && m.subType === 'warning' ? 'warning' : m.type,
    line: m.lastLine, column: m.firstColumn, message: m.message, extract: (m.extract || '').slice(0, 160),
  }));
  const errors = messages.filter((m) => m.type === 'error');
  const warnings = messages.filter((m) => m.type === 'warning');
  const grouped = new Map();
  for (const m of errors) grouped.set(m.message, (grouped.get(m.message) || 0) + 1);
  const top = [...grouped].sort((a, b) => b[1] - a[1]);

  const findings = [];
  if (errors.length) {
    findings.push({
      severity: errors.length >= 25 ? 'medium' : 'low', category: 'quality',
      title: `${errors.length} HTML validation errors (${grouped.size} kinds)`,
      evidence: top.slice(0, 8).map(([msg, n]) => `${n}× ${msg}`).join('\n'),
      places: errorPlaces(errors),
    });
  }
  return {
    data: {
      endpoint, source, bytes: html.length, errors: errors.slice(0, 300), warnings: warnings.slice(0, 300), grouped: top.slice(0, 50).map(([message, count]) => ({ count, message })),
      counts: { errors: errors.length, warnings: warnings.length, kinds: grouped.size }, // true counts: the lists above are capped
    },
    findings,
    summary: [
      { label: 'Errors', headline: true, value: `${errors.length} (${grouped.size} kinds)` },
      { label: 'Warnings', value: warnings.length },
      { label: 'Checked', value: `${source} · ${endpoint.replace(/^https?:\/\//, '')}` },
    ],
  };
}

/**
 * Answer first (errors, kinds, warnings), then the errors grouped by kind and the warnings.
 * Each error's line, quote and message are the places of the "HTML validation errors" issue (the first 200, in
 * document order), so the render no longer lists error locations.
 */
function render(r, h) {
  const d = r.data;
  // Readings from before `counts` have only the capped lists.
  const c = d.counts || { errors: d.errors.length, warnings: d.warnings.length, kinds: d.grouped.length };
  return h.html`
    ${h.stats([
      h.stat({ label: 'Errors', value: c.errors }),
      h.stat({ label: 'Kinds of error', value: c.kinds }),
      h.stat({ label: 'Warnings', value: c.warnings }),
    ])}
    ${d.grouped.length ? h.sub('Errors by kind', h.table(d.grouped, [{ key: 'count', label: 'Count' }, { key: 'message', label: 'Message' }])) : ''}
    ${d.warnings.length ? h.sub('Warnings', h.table(d.warnings.slice(0, 100), [{ key: 'line', label: 'Line' }, { key: 'message', label: 'Message' }])) : ''}
  `;
}

export default {
  id: 'html-validate',
  group: 'quality',
  area: 'build',
  name: 'HTML validation',
  version: '0.1.0',
  phase: 'enrich',
  description: 'Validates the document HTML with the Nu Html Checker.',
  disclosure: 'Uploads the page HTML to the validator endpoint (validator.w3.org by default — use a self-hosted vnu.jar for private pages).',
  tags: ['quality'],
  options: [
    { key: 'endpoint', label: 'Checker endpoint', type: 'text', default: 'https://validator.w3.org/nu/' },
  ],
  timeoutMs: 45_000,
  run,
  render,
};
