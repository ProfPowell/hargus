// Console: uncaught errors, console errors, CSP and mixed-content violations, deprecations and browser
// Issues recorded during the load (capture.console). Offline — re-runs in the CLI on readings that have it.

const sum = (xs) => xs.reduce((n, e) => n + (Number(e.count) || 1), 0);
const where = (e) => (e.url ? ` (${e.url}${e.line ? `:${e.line}` : ''})` : '');

function run(reading, ctx) {
  const con = reading.log._harplus?.capture?.console;
  if (!con) ctx.skip('no console recording in this reading — take a new reading');
  const entries = con.entries || [];
  const of = (fn) => entries.filter(fn);
  const exceptions = of((e) => e.kind === 'exception');
  const errors = of((e) => e.kind === 'console-error');
  const warnings = of((e) => e.kind === 'console-warn');
  const csp = of((e) => (e.kind === 'issue' && e.code === 'ContentSecurityPolicyIssue') || (e.kind === 'log' && e.source === 'security' && /Content Security Policy/i.test(e.text || '')));
  const mixed = of((e) => e.kind === 'issue' && e.code === 'MixedContentIssue');
  const deprecated = of((e) => (e.kind === 'issue' && e.code === 'DeprecationIssue') || (e.kind === 'log' && e.source === 'deprecation'));
  const cookies = of((e) => e.kind === 'issue' && /^Cookie/.test(e.code || ''));
  const failed = of((e) => e.kind === 'log' && e.source === 'network' && e.level === 'error');
  const issues = of((e) => e.kind === 'issue');
  const findings = [];
  const add = (severity, category, title, detail) => findings.push({ severity, category, title, ...(detail ? { detail } : {}) });
  if (exceptions.length) add('medium', 'quality', `${sum(exceptions)} uncaught JavaScript errors`, exceptions.slice(0, 3).map((e) => `${e.text}${where(e)}`).join('; '));
  if (errors.length) add('low', 'quality', `${sum(errors)} console errors`, errors.slice(0, 3).map((e) => `${e.text}${where(e)}`).join('; '));
  if (csp.length) add('medium', 'security', `${sum(csp)} Content-Security-Policy violations`, csp.slice(0, 3).map((e) => e.text).join('; '));
  if (mixed.length) add('medium', 'security', `${sum(mixed)} mixed-content requests blocked or upgraded`);
  if (deprecated.length) add('info', 'quality', `${sum(deprecated)} deprecated features used`, deprecated.slice(0, 3).map((e) => e.text).join('; '));
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

function render(r, h) {
  return h.html`${h.table(r.data.entries.map((e) => ({
    kind: e.code || e.kind, text: e.text || '—', where: e.url ? `${e.url}${e.line ? `:${e.line}` : ''}` : '', count: String(e.count || 1),
  })), [{ key: 'kind', label: 'Kind' }, { key: 'text', label: 'Message' }, { key: 'where', label: 'Location' }, { key: 'count', label: 'Count' }])}
  ${r.data.dropped ? h.html`<p class="note">${r.data.dropped} more entries not kept.</p>` : ''}`;
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
