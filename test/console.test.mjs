import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, consoleEntryFrom, addConsoleEntry, CONSOLE_MAX } from '../extension/core/console.js';
import { stripForSharing } from '../extension/core/harplus.js';

test('redact: query strings, long tokens; short text and paths untouched', () => {
  assert.equal(redact('GET https://api.x.com/v1/users?token=abc&id=5 failed'), 'GET https://api.x.com/v1/users?… failed');
  assert.equal(redact('Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijkl'), 'Bearer …');
  assert.equal(redact('Uncaught TypeError: x is undefined'), 'Uncaught TypeError: x is undefined');
  assert.equal(redact('at https://cdn.example.com/assets/javascripts/application.js:12'), 'at https://cdn.example.com/assets/javascripts/application.js:12');
  assert.equal(redact('ResizeObserverLoopCompletedWithUndeliveredNotifications'), 'ResizeObserverLoopCompletedWithUndeliveredNotifications');
  assert.equal(redact('x'.repeat(10) + ' ' + 'y'.repeat(400)).length <= 300, true);
});

test('redact: credentials, fragments, any scheme, emails, key=value secrets', () => {
  assert.equal(redact('see https://user:pass@h.test/p?x=1#t ok'), 'see https://…@h.test/p?… ok');
  assert.equal(redact('https://user:pass@host.test/p'), 'https://…@host.test/p');
  assert.equal(redact('https://x.test/cb#access_token=abc'), 'https://x.test/cb#…');
  assert.equal(redact('https://x.test/cb?q=1#frag'), 'https://x.test/cb?…');
  assert.equal(redact('wss://h.test/s?token=abc'), 'wss://h.test/s?…');
  assert.equal(redact('contact a.b+c@ex.com now'), 'contact …@… now');
  assert.equal(redact('password=hunter2 token: abc'), 'password=… token: …');
  assert.equal(consoleEntryFrom('Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'x', url: 'https://user:pass@h.test/p?x=1' } }).url, 'https://h.test/p');
});

test('consoleEntryFrom: exceptions, console errors/warnings, log entries, issues; others null', () => {
  assert.deepEqual(consoleEntryFrom('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', lineNumber: 4, url: 'https://s.test/a.js?v=1', exception: { description: 'Error: boom\n    at f (a.js:5)' } } }),
    { kind: 'exception', text: 'Error: boom', url: 'https://s.test/a.js', line: 5 });
  assert.deepEqual(consoleEntryFrom('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'bad' }, { type: 'number', value: 3 }], stackTrace: { callFrames: [{ url: 'https://s.test/m.js', lineNumber: 9 }] } }),
    { kind: 'console-error', text: 'bad 3', url: 'https://s.test/m.js', line: 10 });
  assert.equal(consoleEntryFrom('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'object', description: 'Object' }] }).kind, 'console-warn');
  assert.equal(consoleEntryFrom('Runtime.consoleAPICalled', { type: 'log', args: [] }), null);
  assert.deepEqual(consoleEntryFrom('Log.entryAdded', { entry: { source: 'security', level: 'error', text: "Refused to load the image because it violates the following Content Security Policy directive: \"img-src 'self'\"", url: 'https://o.test/i.png?x=1' } }),
    { kind: 'log', source: 'security', level: 'error', text: "Refused to load the image because it violates the following Content Security Policy directive: \"img-src 'self'\"", url: 'https://o.test/i.png' });
  assert.equal(consoleEntryFrom('Log.entryAdded', { entry: { source: 'network', level: 'info', text: 'x' } }), null);
  assert.deepEqual(consoleEntryFrom('Audits.issueAdded', { issue: { code: 'ContentSecurityPolicyIssue', details: { contentSecurityPolicyIssueDetails: { violatedDirective: 'img-src', blockedURL: 'https://o.test/i.png?q=1' } } } }),
    { kind: 'issue', code: 'ContentSecurityPolicyIssue', text: 'img-src blocked https://o.test/i.png?…' });
  assert.equal(consoleEntryFrom('Audits.issueAdded', { issue: { code: 'DeprecationIssue', details: { deprecationIssueDetails: { type: 'NoSysexWebMIDIWithoutPermission' } } } }).text, 'NoSysexWebMIDIWithoutPermission');
  assert.equal(consoleEntryFrom('Network.requestWillBeSent', {}), null);
});

test('addConsoleEntry: dedupes with count, caps at 100, redacts text', () => {
  const store = { entries: [], dropped: 0 };
  addConsoleEntry(store, { kind: 'console-error', text: 'x', url: 'u', line: 1 });
  addConsoleEntry(store, { kind: 'console-error', text: 'x', url: 'u', line: 1 });
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0].count, 2);
  for (let i = 0; i < 150; i++) addConsoleEntry(store, { kind: 'console-error', text: `e${i}` });
  assert.equal(store.entries.length, CONSOLE_MAX);
  assert.equal(store.dropped, 51);
  addConsoleEntry(store, { kind: 'log', text: 'see https://a.test/p?secret=1' });
  assert.equal(store.dropped, 52);
});

test('stripForSharing removes console text and console finding details by default', () => {
  const r = { log: { entries: [], _harplus: { screenshots: [], capture: { console: { entries: [{ kind: 'exception', text: 'Error: secret', url: 'https://s.test/a.js', line: 3, count: 1 }], dropped: 0 } },
    plugins: { console: { status: 'ok', findings: [{ title: '1 uncaught JavaScript errors', detail: 'Error: secret' }], data: { entries: [{ kind: 'exception', text: 'Error: secret' }] } } } } } };
  const s = stripForSharing(r);
  assert.equal(s.log._harplus.capture.console.entries[0].text, '');
  assert.equal(s.log._harplus.capture.console.entries[0].line, 3);
  assert.equal(s.log._harplus.plugins.console.findings[0].detail, undefined);
  assert.equal(s.log._harplus.plugins.console.data.entries[0].text, '');
  assert.equal(s.log._harplus.stripped.console, 'counts');
  assert.equal(stripForSharing(r, { console: 'keep' }).log._harplus.capture.console.entries[0].text, 'Error: secret');
  assert.equal(r.log._harplus.capture.console.entries[0].text, 'Error: secret', 'original untouched');
});
