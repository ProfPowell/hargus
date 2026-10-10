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
