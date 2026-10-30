// Console: uncaught errors, console errors, CSP and mixed-content violations, deprecations and browser
// Issues recorded during the load (capture.console). Offline — re-runs in the CLI on readings that have it.

const sum = (xs) => xs.reduce((n, e) => n + (Number(e.count) || 1), 0);
const where = (e) => (e.url ? ` (${e.url}${e.line ? `:${e.line}` : ''})` : '');

/**
 * Places for entries that report a line: the line only. Console text and script URLs can carry user data
 * (a path with an account id, a message quoting a form value), so a place never holds either. At most 200.
 */
// Each line once, first seen first; line 0 counts as no line, as in the detail and the render.
const linePlaces = (xs) => [...new Set(xs.map((e) => e.line).filter((l) => Number.isInteger(l) && l > 0))].slice(0, 200).map((line) => ({ line }));

function run(reading, ctx) {
  const con = reading.log._harplus?.capture?.console;
  if (!con) ctx.skip('no console recording in this reading — take a new reading');
  const entries = con.entries || [];
  const of = (fn) => entries.filter(fn);
  const exceptions = of((e) => e.kind === 'exception');
  const errors = of((e) => e.kind === 'console-error');
  const warnings = of((e) => e.kind === 'console-warn');
  // Chrome often reports one event both as an Issue and as a log entry, so the two channels are not summed:
  // count the Issues when there are any, otherwise fall back to the matching log entries.
  const cspIssues = of((e) => e.kind === 'issue' && e.code === 'ContentSecurityPolicyIssue');
  const cspLogs = of((e) => e.kind === 'log' && e.source === 'security' && /Content Security Policy/i.test(e.text || ''));
  const csp = cspIssues.length ? cspIssues : cspLogs;
  const mixed = of((e) => e.kind === 'issue' && e.code === 'MixedContentIssue');
  const deprecationIssues = of((e) => e.kind === 'issue' && e.code === 'DeprecationIssue');
  const deprecationLogs = of((e) => e.kind === 'log' && e.source === 'deprecation');
  const deprecated = deprecationIssues.length ? deprecationIssues : deprecationLogs;
  const cookies = of((e) => e.kind === 'issue' && /^Cookie/.test(e.code || ''));
  const failed = of((e) => e.kind === 'log' && e.source === 'network' && e.level === 'error');
  const issues = of((e) => e.kind === 'issue');
  const findings = [];
  const add = (severity, category, title, detail, places) => findings.push({ severity, category, title, ...(detail ? { detail } : {}), ...(places?.length ? { places } : {}) });
  // Detail lists only the entries that have text; an entry without text adds nothing readable.
  const texts = (xs, fn = (e) => e.text) => xs.filter((e) => e.text).slice(0, 3).map(fn).join('; ');
  if (exceptions.length) add('medium', 'quality', `${sum(exceptions)} uncaught JavaScript errors`, texts(exceptions, (e) => `${e.text}${where(e)}`), linePlaces(exceptions));
  if (errors.length) add('low', 'quality', `${sum(errors)} console errors`, texts(errors, (e) => `${e.text}${where(e)}`), linePlaces(errors));
  if (csp.length) add('medium', 'security', `${sum(csp)} Content-Security-Policy violations`, texts(csp));
  // Info only: the security plugin already scores mixed content from the HAR.
  if (mixed.length) add('info', 'security', `${sum(mixed)} mixed-content requests blocked or upgraded`);
  if (deprecated.length) add('info', 'quality', `${sum(deprecated)} deprecated features used`, texts(deprecated));
  if (cookies.length) add('low', 'quality', `${sum(cookies)} cookie issues reported by the browser`);
  if (failed.length) add('info', 'quality', `${sum(failed)} failed requests logged by the browser`);
  // "issues" = DevTools Issues (kind 'issue') only.
  const counts = { exceptions: sum(exceptions), errors: sum(errors), warnings: sum(warnings), issues: sum(issues) };
  return {
    data: { entries, dropped: con.dropped || 0, counts },
    findings,
    summary: [{
      label: 'Console', headline: true,
      value: `${counts.exceptions} exceptions · ${counts.errors} errors · ${counts.warnings} warnings · ${counts.issues} issues`,
      rating: counts.exceptions ? 'poor' : counts.errors || counts.warnings || counts.issues ? 'needs-improvement' : 'good',
    }],
  };
}

/** Answer first (the four counts), then every kept entry: message, where it came from and how often. */
function render(r, h) {
  const d = r.data;
  const c = d.counts || {};
  return h.html`${h.stats([
    h.stat({ label: 'Exceptions', value: c.exceptions ?? 0 }),
    h.stat({ label: 'Errors', value: c.errors ?? 0 }),
    h.stat({ label: 'Warnings', value: c.warnings ?? 0 }),
    h.stat({ label: 'Issues', value: c.issues ?? 0, note: 'from DevTools' }),
  ])}
  ${h.table(d.entries.map((e) => ({
    kind: e.code || e.kind, text: e.text || '—',
    where: e.url ? h.html`${h.url(e.url)}${e.line ? ` line ${e.line}` : ''}` : '', count: String(e.count || 1),
  })), [{ key: 'kind', label: 'Kind' }, { key: 'text', label: 'Message' }, { key: 'where', label: 'Location' }, { key: 'count', label: 'Count' }])}
  ${d.dropped ? h.html`<p class="note">${d.dropped} more entries not kept.</p>` : ''}`;
}

export default {
  id: 'console',
  name: 'Console',
  version: '0.1.0',
  phase: 'analyze',
  group: 'build',
  area: 'build',
  description: 'Uncaught errors, console errors, CSP and mixed-content violations, deprecations and browser Issues during the load.',
  tags: ['quality'],
  run,
  render,
};
