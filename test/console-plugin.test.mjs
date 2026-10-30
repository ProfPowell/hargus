import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../extension/plugins/console.js';
import { getPlugins } from '../extension/plugins/index.js';
import { h } from '../extension/ui/render.js';
import { createReading, makeTarget, issueMarkdown } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';

const reading = (con) => ({ log: { entries: [], _harplus: { capture: { console: con } } } });
const ctx = { skip: (m) => { const e = new Error(m); e.name = 'SkipError'; throw e; } };
const t = (r) => r.findings.map((f) => `${f.severity}:${f.category}:${f.title}`);

test('registered as an analyze plugin in the Build area', () => {
  assert.ok(getPlugins().some((p) => p.id === 'console'));
  assert.equal(plugin.phase, 'analyze');
  assert.equal(plugin.area, 'build');
});

test('skips without a console recording', () => {
  assert.throws(() => plugin.run(reading(undefined), ctx), /no console recording/);
});

test('findings with counts summed; security for CSP and mixed content', () => {
  const r = plugin.run(reading({ dropped: 0, entries: [
    { kind: 'exception', text: 'Error: a', url: 'https://s.test/a.js', line: 3, count: 2 },
    { kind: 'console-error', text: 'bad', count: 3 },
    { kind: 'console-warn', text: 'meh', count: 1 },
    { kind: 'issue', code: 'ContentSecurityPolicyIssue', text: 'img-src blocked x', count: 1 },
    { kind: 'log', source: 'security', level: 'error', text: 'Refused to load … Content Security Policy directive', count: 1 },
    { kind: 'issue', code: 'MixedContentIssue', text: 'x', count: 1 },
    { kind: 'issue', code: 'DeprecationIssue', text: 'y', count: 2 },
    { kind: 'log', source: 'deprecation', level: 'warning', text: 'z', count: 1 },
    { kind: 'issue', code: 'CookieIssue', text: 'c', count: 1 },
    { kind: 'log', source: 'network', level: 'error', text: 'Failed to load resource: 404', count: 4 },
  ] }), ctx);
  assert.deepEqual(t(r), [
    'medium:quality:2 uncaught JavaScript errors',
    'low:quality:3 console errors',
    'medium:security:1 Content-Security-Policy violations',
    'info:security:1 mixed-content requests blocked or upgraded',
    'info:quality:2 deprecated features used',
    'low:quality:1 cookie issues reported by the browser',
    'info:quality:4 failed requests logged by the browser',
  ]);
  assert.equal(r.findings[0].detail, 'Error: a (https://s.test/a.js:3)');
  assert.equal(r.summary[0].value, '2 exceptions · 3 errors · 1 warnings · 5 issues'); // issues = kind 'issue' only: 1+1+2+1
  assert.equal(r.summary[0].rating, 'poor');
});

test('CSP and deprecations fall back to log entries when there are no Issues; not double counted', () => {
  const r = plugin.run(reading({ dropped: 0, entries: [
    { kind: 'log', source: 'security', level: 'error', text: 'Refused to load the script because it violates the Content Security Policy directive', count: 1 },
    { kind: 'log', source: 'deprecation', level: 'warning', text: 'z', count: 1 },
  ] }), ctx);
  assert.deepEqual(t(r), [
    'medium:security:1 Content-Security-Policy violations',
    'info:quality:1 deprecated features used',
  ]);
});

test('clean console: no findings, good rating; stripped text renders as —', () => {
  const r = plugin.run(reading({ dropped: 0, entries: [{ kind: 'console-warn', text: '', count: 1 }] }), ctx);
  assert.deepEqual(r.findings, []);
  assert.equal(r.summary[0].rating, 'needs-improvement');
  const clean = plugin.run(reading({ dropped: 0, entries: [] }), ctx);
  assert.equal(clean.summary[0].rating, 'good');
  assert.match(String(plugin.render({ status: 'ok', ...r }, h)), /—/);
});

/** Pass one plugin result through normalize(), as a real run does. */
async function normalized(out) {
  const r = createReading({ entries: [], target: makeTarget('https://www.example.com/', 'E', 'https://www.example.com/') });
  await runPlugins(r, [{ id: 'console', name: 'Console', phase: 'analyze', run: async () => out }], {});
  return r.log._harplus.plugins.console;
}

test('places: exceptions and console errors carry their lines only, never message text or URLs', async () => {
  const r = await normalized(plugin.run(reading({ dropped: 0, entries: [
    { kind: 'exception', text: 'TypeError: user jane@x.test', url: 'https://s.test/account/123/app.js', line: 3, count: 2 },
    { kind: 'exception', text: 'no line', url: 'https://s.test/b.js' },
    { kind: 'console-error', text: 'card 4111', url: 'https://s.test/c.js', line: 0 },
    { kind: 'console-error', text: 'odd line', url: 'https://s.test/d.js', line: '7' },
    { kind: 'issue', code: 'ContentSecurityPolicyIssue', text: 'img-src blocked https://s.test/x', count: 1 },
    { kind: 'log', source: 'network', level: 'error', text: 'Failed to load resource: 404', url: 'https://s.test/y', count: 1 },
  ] }), ctx));
  const by = (re) => r.findings.find((f) => re.test(f.title));
  assert.deepEqual(by(/uncaught/).places, [{ line: 3 }], 'an entry without a line has no place');
  assert.deepEqual(by(/console errors/).places, [{ line: 0 }], 'a line that is not a whole number has no place');
  for (const f of r.findings) {
    for (const p of f.places || []) assert.deepEqual(Object.keys(p), ['line']);
    if (!/uncaught|console errors/.test(f.title)) assert.equal(f.places, undefined, f.title);
  }
  assert.equal(by(/uncaught/).detail, 'TypeError: user jane@x.test (https://s.test/account/123/app.js:3); no line (https://s.test/b.js)', 'detail unchanged');
  // The brief and Copy as Markdown show the line only.
  const md = issueMarkdown({ ...by(/uncaught/), plugin: 'console', pluginName: 'Console' });
  assert.equal(md, '- **MEDIUM** · quality · 3 uncaught JavaScript errors _(Console)_\n  - line 3');
});

test('places: at most 200', () => {
  const entries = Array.from({ length: 250 }, (_, i) => ({ kind: 'exception', text: `e${i}`, url: 'https://s.test/a.js', line: i + 1 }));
  const r = plugin.run(reading({ dropped: 0, entries }), ctx);
  assert.equal(r.findings[0].places.length, 200);
  assert.equal(r.findings[0].title, '250 uncaught JavaScript errors');
});

test('render: the four counts first, then entries with the location as URL parts', () => {
  const r = plugin.run(reading({ dropped: 2, entries: [
    { kind: 'exception', text: 'Error: <b>a</b>', url: 'https://s.test/a.js', line: 3, count: 2 },
    { kind: 'console-warn', text: 'meh', count: 1 },
  ] }), ctx);
  const out = String(plugin.render({ status: 'ok', ...r }, h));
  assert.ok(out.startsWith('<div class="stats">'), 'stats come first');
  assert.match(out, /Exceptions<\/span><div class="stat-value">2</);
  assert.match(out, /Warnings<\/span><div class="stat-value">1</);
  assert.match(out, /<span class="url" title="https:\/\/s\.test\/a\.js"><span class="url-host">s\.test<\/span><span class="url-path">\/a\.js<\/span><\/span> line 3/);
  assert.match(out, /Error: &lt;b&gt;a&lt;\/b&gt;/);
  assert.match(out, /2 more entries not kept/);
  assert.doesNotMatch(out, /undefined|NaN/);
});
