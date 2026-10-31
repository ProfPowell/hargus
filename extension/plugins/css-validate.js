// CSS conformance via the W3C CSS Validation Service (jigsaw.w3.org/css-validator, or a self-hosted
// copy). Validates the site's own stylesheets from recorded bodies; without bodies, asks the
// validator to fetch the page itself (public pages only). The validator lags the newest CSS
// (some nesting, @scope or anchor positioning syntax may be reported) — read errors with that in mind.

import { resourceType, bodyText, hostOf } from '../core/har-util.js';
import { HttpError } from '../core/plugin-host.js';

/** The validator's JSON template can emit stray commas; tolerate them. */
export function parseValidatorJSON(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  return JSON.parse(text.replace(/,\s*([\]}])/g, '$1').replace(/\[\s*,/g, '['));
}

async function validate(ctx, endpoint, { text, uri }) {
  const params = { profile: ctx.options.profile || 'css3svg', output: 'json', warning: '2', vextwarning: 'true', usermedium: 'all', lang: 'en' };
  let r;
  if (text != null) {
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, v);
    form.append('text', text);
    r = await ctx.fetch(endpoint, { method: 'POST', body: form, headers: { accept: 'application/json' } });
  } else {
    const url = new URL(endpoint);
    for (const [k, v] of Object.entries({ ...params, uri })) url.searchParams.set(k, v);
    r = await ctx.fetch(url.href, { headers: { accept: 'application/json' } });
  }
  if (!r.ok) throw new HttpError(r.status, endpoint);
  const j = parseValidatorJSON(await r.text()).cssvalidation || {};
  return {
    errors: (j.errors || []).map((e) => ({ line: e.line, message: String(e.message || '').trim(), context: String(e.context || '').trim(), type: e.type })),
    warnings: (j.warnings || []).filter((w) => (w.level ?? 0) <= 1).map((w) => ({ line: w.line, message: String(w.message || '').trim() })),
    level: j.csslevel,
  };
}

/** A validator's line number as a place line: a whole number (or a numeric string), else none. */
const lineOf = (v) => { const n = typeof v === 'string' && v.trim() ? Number(v) : v; return Number.isInteger(n) && n >= 0 ? n : undefined; };

/**
 * Where each error is: its stylesheet (or the page, when the validator fetched it), line and the CSS context
 * the validator quotes, with the message as a note. Sheet by sheet, at most 200.
 */
function errorPlaces(results) {
  const out = [];
  for (const x of results) {
    for (const e of x.errors) {
      if (out.length >= 200) return out;
      out.push({
        url: x.url, ...(lineOf(e.line) != null ? { line: lineOf(e.line) } : {}),
        ...(e.context ? { text: e.context } : {}), ...(e.message ? { note: e.message } : {}),
      });
    }
  }
  return out;
}

async function run(reading, ctx) {
  const endpoint = String(ctx.options.endpoint || 'https://jigsaw.w3.org/css-validator/validator');
  const site = ctx.target.site;
  const max = Number(ctx.options.maxSheets) || 6;
  const sheets = reading.log.entries
    .filter((e) => resourceType(e) === 'stylesheet' && !ctx.util.isThirdParty(hostOf(e.request.url), site))
    .map((e) => ({ url: e.request.url, text: bodyText(e) }));
  const withText = sheets.filter((s) => s.text && s.text.length < 1_500_000).slice(0, max);
  const results = [];
  if (withText.length) {
    for (const [i, s] of withText.entries()) { // sequential and spaced: W3C asks for about 1 s between requests
      if (i) await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        results.push({ url: s.url, bytes: s.text.length, ...(await validate(ctx, endpoint, { text: s.text })) });
      } catch (e) {
        results.push({ url: s.url, error: String(e.message || e), errors: [], warnings: [] });
      }
    }
  } else if (/^https?:/.test(ctx.target.finalUrl || '')) {
    results.push({ url: ctx.target.finalUrl, mode: 'validator fetched the page', ...(await validate(ctx, endpoint, { uri: ctx.target.finalUrl })) });
  } else {
    ctx.skip('no first-party stylesheets recorded');
  }
  if (results.every((x) => x.error)) throw new Error(results[0].error);

  const errors = results.reduce((n, x) => n + x.errors.length, 0);
  const warnings = results.reduce((n, x) => n + x.warnings.length, 0);
  const grouped = new Map();
  for (const x of results) for (const e of x.errors) grouped.set(e.message, (grouped.get(e.message) || 0) + 1);
  const top = [...grouped].sort((a, b) => b[1] - a[1]);
  const findings = errors ? [{
    severity: errors >= 50 ? 'medium' : 'low', category: 'quality',
    title: `${errors} CSS validation errors in ${results.filter((x) => x.errors.length).length} stylesheets`,
    detail: 'The W3C validator lags the newest CSS; treat errors on modern syntax with care.',
    evidence: top.slice(0, 10).map(([m, n]) => `${n}× ${m}`).join('\n'),
    places: errorPlaces(results),
  }] : [];
  return {
    data: { endpoint, sheets: results, grouped: top.slice(0, 60).map(([message, count]) => ({ count, message })), skippedSheets: sheets.length - withText.length, kinds: grouped.size },
    findings,
    summary: [
      { label: 'Errors', headline: true, value: `${errors} (${grouped.size} kinds)` },
      { label: 'Warnings', value: warnings },
      { label: 'Checked', value: `${results.length} stylesheet${results.length === 1 ? '' : 's'}${results[0]?.mode ? ` (${results[0].mode})` : ''}` },
    ],
  };
}

/**
 * Answer first (errors, kinds, warnings, stylesheets checked), then each sheet's counts and the errors by kind.
 * Errors by line stay, closed: the issue's places hold only the first 200 errors, so they can't all be read there.
 */
function render(r, h) {
  const d = r.data;
  const errors = d.sheets.reduce((n, x) => n + x.errors.length, 0);
  const warnings = d.sheets.reduce((n, x) => n + x.warnings.length, 0);
  const withErrors = d.sheets.filter((x) => x.errors.length);
  // Kinds are stored capped at 60 and each sheet's errors are drawn up to 60: say so when a list stops short.
  const firstOf = (shown, n) => (n > shown ? { sub: `first ${shown} of ${n}` } : {});
  const at = (x) => (/^https?:/i.test(x.url) ? h.link(x.url) : h.url(x.url));
  return h.html`
    ${h.stats([
      h.stat({ label: 'Errors', value: errors }),
      // Readings from before `kinds` have only the capped list of kinds.
      h.stat({ label: 'Kinds of error', value: d.kinds ?? d.grouped.length }),
      h.stat({ label: 'Warnings', value: warnings }),
      h.stat({ label: 'Stylesheets checked', value: d.sheets.length, note: d.skippedSheets ? `${d.skippedSheets} not checked` : d.sheets[0]?.mode || '' }),
    ])}
    ${h.table(d.sheets.map((x) => ({ stylesheet: at(x), errors: x.error ? `error: ${x.error}` : String(x.errors.length), warnings: String(x.warnings.length) })),
    [{ key: 'stylesheet', label: 'Stylesheet' }, { key: 'errors', label: 'Errors' }, { key: 'warnings', label: 'Warnings' }])}
    ${d.grouped.length ? h.sub('Errors by kind', h.table(d.grouped, [{ key: 'count', label: 'Count' }, { key: 'message', label: 'Message' }]), firstOf(d.grouped.length, d.kinds ?? d.grouped.length)) : ''}
    ${h.more('Errors by line', withErrors.map((x) => h.sub(at(x), h.table(x.errors.slice(0, 60).map((e) => ({ line: e.line, message: e.message, context: h.html`<code>${e.context}</code>` })),
    [{ key: 'line', label: 'Line' }, { key: 'message', label: 'Message' }, { key: 'context', label: 'Context' }], { fold: false }), firstOf(Math.min(60, x.errors.length), x.errors.length))), `${withErrors.length} stylesheet${withErrors.length === 1 ? '' : 's'}`)}
  `;
}

export default {
  id: 'css-validate',
  group: 'quality',
  area: 'build',
  name: 'CSS validation',
  version: '0.1.1',
  phase: 'enrich',
  description: 'Validates first-party stylesheets with the W3C CSS Validation Service.',
  disclosure: 'Uploads first-party CSS to jigsaw.w3.org (or your own validator); without recorded CSS, the validator fetches the page URL.',
  tags: ['quality', 'composition'],
  options: [
    { key: 'endpoint', label: 'Validator endpoint', type: 'text', default: 'https://jigsaw.w3.org/css-validator/validator' },
    { key: 'profile', label: 'Profile', type: 'select', default: 'css3svg', choices: ['css3svg', 'css3', 'css21'] },
    { key: 'maxSheets', label: 'Max stylesheets', type: 'number', default: 6 },
  ],
  timeoutMs: 90_000,
  run,
  render,
};
