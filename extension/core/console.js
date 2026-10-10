// Console and DevTools Issues recorded during capture: redaction, CDP event → entry, de-duplicated store.
// Pure: used by capture (recording) and the console plugin.

export const CONSOLE_MAX = 100;
export const TEXT_MAX = 300;

export function redact(text = '') {
  return String(text)
    .replace(/\b(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/g, '$1?…')
    .replace(/[A-Za-z0-9_\-+=]{24,}/g, (m) => (/\d/.test(m) ? '…' : m))
    .slice(0, TEXT_MAX);
}

const noQuery = (u) => (u ? String(u).split(/[?#]/)[0] : undefined);
const frame = (st) => st?.callFrames?.[0];

function issueText(issue) {
  const d = issue?.details || {};
  const csp = d.contentSecurityPolicyIssueDetails;
  if (csp) return `${csp.violatedDirective || 'CSP'} blocked ${csp.blockedURL || 'inline content'}`;
  const mixed = d.mixedContentIssueDetails;
  if (mixed) return `${mixed.resolutionStatus || 'mixed content'} ${mixed.insecureURL || ''}`.trim();
  const dep = d.deprecationIssueDetails;
  if (dep) return String(dep.type || 'deprecation');
  const cookie = d.cookieIssueDetails;
  if (cookie) return `${cookie.cookie?.name || 'cookie'}: ${[...(cookie.cookieWarningReasons || []), ...(cookie.cookieExclusionReasons || [])].join(', ')}`;
  return String(issue?.code || 'issue');
}

/** A CDP event → a console entry (unredacted except URLs), or null for events we don't record. */
export function consoleEntryFrom(method, params = {}) {
  if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails || {};
    const f = frame(d.stackTrace);
    const text = String(d.exception?.description || d.text || 'Uncaught exception').split('\n')[0];
    const line = d.lineNumber ?? f?.lineNumber;
    return { kind: 'exception', text: redact(text), url: noQuery(d.url || f?.url), line: line == null ? undefined : line + 1 };
  }
  if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'warning')) {
    const f = frame(params.stackTrace);
    const text = (params.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');
    return { kind: params.type === 'error' ? 'console-error' : 'console-warn', text: redact(text), url: noQuery(f?.url), line: f?.lineNumber == null ? undefined : f.lineNumber + 1 };
  }
  if (method === 'Log.entryAdded') {
    const e = params.entry || {};
    if (e.level !== 'error' && e.level !== 'warning') return null;
    return { kind: 'log', source: e.source, level: e.level, text: redact(e.text || ''), url: noQuery(e.url) };
  }
  if (method === 'Audits.issueAdded') {
    const issue = params.issue || {};
    return { kind: 'issue', code: issue.code, text: redact(issueText(issue)) };
  }
  return null;
}

const keyOf = (e) => [e.kind, e.code || '', e.text, e.url || '', e.line ?? ''].join('|');

/** Add an entry to { entries, dropped }: redact, de-duplicate (count), cap at CONSOLE_MAX. */
export function addConsoleEntry(store, e) {
  const entry = Object.fromEntries(Object.entries({ ...e, text: redact(e.text), url: e.url ? noQuery(e.url) : undefined }).filter(([, v]) => v !== undefined));
  const k = keyOf(entry);
  const same = store.entries.find((x) => keyOf(x) === k);
  if (same) { same.count += 1; return; }
  if (store.entries.length >= CONSOLE_MAX) { store.dropped += 1; return; }
  store.entries.push({ ...entry, count: 1 });
}
