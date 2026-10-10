import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, labelFor, badgeFor, addStep, elapsed, formatElapsed } from '../extension/core/progress.js';

test('stage table: labels and 4-character badge codes', () => {
  const codes = Object.fromEntries(Object.entries(STAGES).map(([k, v]) => [k, v.badge]));
  assert.deepEqual(codes, {
    loading: 'LOAD', scrolling: 'SCRL', collecting: 'READ', screenshot: 'SHOT', bodies: 'BODY', sensing: 'PAGE',
    views: 'VIEW', saving: 'SAVE', analyzing: 'LOOK', done: '✓', error: '!', recording: 'REC',
  });
  for (const v of Object.values(STAGES)) assert.ok(v.badge.length <= 4);
  assert.equal(labelFor('views'), 'Extra views');
  assert.equal(labelFor('mystery'), 'mystery');
  assert.equal(badgeFor('mystery'), '…');
});

test('addStep closes the previous step, ignores duplicates, plugin events only update text', () => {
  let s = addStep([], { stage: 'loading', text: 'Reloading the page', at: 1000 });
  s = addStep(s, { stage: 'loading', text: 'Reloading the page', at: 1500 });
  assert.equal(s.length, 1);
  s = addStep(s, { stage: 'views', text: 'Tablet view', at: 4000 });
  s = addStep(s, { stage: 'views', text: 'Phone view', at: 6000 });
  assert.deepEqual(s.map((x) => [x.stage, x.text, x.start, x.end]), [
    ['loading', 'Reloading the page', 1000, 4000],
    ['views', 'Tablet view', 4000, 6000],
    ['views', 'Phone view', 6000, undefined],
  ]);
  s = addStep(s, { stage: 'plugin', text: 'Web vitals — ok', at: 6500 });
  assert.equal(s.length, 3);
  assert.equal(s[2].text, 'Web vitals — ok');
  assert.deepEqual(addStep([], { stage: 'plugin', text: 'x', at: 1 }), []);
  s = addStep(s, { stage: 'done', text: '', at: 9000 });
  assert.equal(s[2].end, 9000);
  assert.equal(s[3].end, 9000, 'done is closed immediately');
});

test('elapsed and formatting', () => {
  assert.equal(elapsed({ start: 1000, end: 4000 }, 99999), 3000);
  assert.equal(elapsed({ start: 1000 }, 6500), 5500);
  assert.equal(formatElapsed(4400), '4 s');
  assert.equal(formatElapsed(65_000), '1 min 5 s');
  assert.equal(formatElapsed(0), '0 s');
});

import { renderProgress } from '../extension/ui/progress-view.js';

test('renderProgress: capture steps, running timer, plugin rows, escaping', () => {
  const steps = [
    { stage: 'loading', text: 'Reloading the page', start: 0, end: 15_000 },
    { stage: 'views', text: '<b>No JavaScript</b> view', start: 15_000 },
  ];
  const plugins = [
    { id: 'dns', name: 'DNS', status: 'ok', start: 20_000, end: 21_000 },
    { id: 'history', name: 'Wayback history', status: 'running', start: 20_000 },
    { id: 'css-validate', name: 'CSS validation', status: 'error', error: 'timed out <script>', start: 20_000, end: 50_000 },
  ];
  const s = String(renderProgress({ host: 'ucsd.edu', steps, plugins, startedAt: 0, now: 41_000 }));
  assert.match(s, /Reading ucsd\.edu/);
  assert.match(s, /· <span data-start="0">41 s<\/span>/);
  assert.match(s, /prog-time" data-start="15000">26 s/);
  assert.match(s, /prog-time" data-start="20000">21 s/);
  assert.match(s, /prog-time">15 s/);
  assert.match(s, /prog-row prog-ok[\s\S]*?Reloading the page[\s\S]*?15 s/);
  assert.match(s, /prog-row prog-running[\s\S]*?Extra views[\s\S]*?&lt;b&gt;No JavaScript&lt;\/b&gt; view[\s\S]*?26 s/);
  assert.match(s, /<h2>Analysis and lookups<\/h2>/);
  assert.match(s, /prog-row prog-running[\s\S]*?Wayback history[\s\S]*?21 s/);
  assert.match(s, /prog-row prog-error[\s\S]*?timed out &lt;script&gt;/);
  assert.doesNotMatch(s, /<script>|<b>No/);
  assert.match(s, /You can switch tabs/);
});

test('renderProgress: error with retry; empty is safe', () => {
  const s = String(renderProgress({ host: 'x.test', steps: [{ stage: 'error', text: 'Cannot inspect this tab', start: 5, end: 5 }], error: 'Cannot inspect this tab', retry: true, now: 10 }));
  assert.match(s, /class="error"/);
  assert.match(s, /id="retry"/);
  assert.match(s, /prog-row prog-error/);
  assert.doesNotMatch(String(renderProgress({ now: 0 })), /undefined|NaN/);
});

test('renderProgress: custom note replaces the default and is escaped', () => {
  const s = String(renderProgress({ note: 'Other tab <i>busy</i>', now: 0 }));
  assert.match(s, /Other tab &lt;i&gt;busy&lt;\/i&gt;/);
  assert.doesNotMatch(s, /You can switch tabs|<i>/);
});

test('renderProgress: step text equal to the stage label is not repeated', () => {
  const s = String(renderProgress({ steps: [{ stage: 'saving', text: 'Saving', start: 0, end: 1000 }, { stage: 'views', text: 'Mobile view', start: 1000 }], now: 2000 }));
  assert.doesNotMatch(s, /prog-text">Saving</);
  assert.match(s, /prog-text">Mobile view</);
});
