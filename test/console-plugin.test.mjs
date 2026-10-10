import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../extension/plugins/console.js';
import { getPlugins } from '../extension/plugins/index.js';
import { h } from '../extension/ui/render.js';

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
    'medium:security:2 Content-Security-Policy violations',
    'medium:security:1 mixed-content requests blocked or upgraded',
    'info:quality:3 deprecated features used',
    'low:quality:1 cookie issues reported by the browser',
    'info:quality:4 failed requests logged by the browser',
  ]);
  assert.equal(r.findings[0].detail, 'Error: a (https://s.test/a.js:3)');
  assert.equal(r.summary[0].value, '2 exceptions · 3 errors · 1 warnings · 5 issues'); // issues = kind 'issue' only: 1+1+2+1
  assert.equal(r.summary[0].rating, 'poor');
});

test('clean console: no findings, good rating; stripped text renders as —', () => {
  const r = plugin.run(reading({ dropped: 0, entries: [{ kind: 'console-warn', text: '', count: 1 }] }), ctx);
  assert.deepEqual(r.findings, []);
  assert.equal(r.summary[0].rating, 'needs-improvement');
  const clean = plugin.run(reading({ dropped: 0, entries: [] }), ctx);
  assert.equal(clean.summary[0].rating, 'good');
  assert.match(String(plugin.render({ status: 'ok', ...r }, h)), /—/);
});
