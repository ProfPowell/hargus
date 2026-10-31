import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, percentChange, gradeSteps, GRADE_STEPS, verdict, timings, performance, compareRuns, counts, passMedian, LCP_FLOOR, BLOCKING_FLOOR } from '../scripts/coverage-overhead.mjs';
import { grade } from '../extension/core/score.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';

test('median: odd, even, ignores missing values, null when empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([null, 5, undefined, NaN, 1]), 3);
  assert.equal(median([]), null);
  assert.equal(median([null]), null);
});

test('percentChange: relative to off, 0 for 0→0, null when off is 0 or a value is missing', () => {
  assert.equal(percentChange(110, 100), 10);
  assert.equal(percentChange(90, 100), -10);
  assert.equal(percentChange(0, 0), 0);
  assert.equal(percentChange(50, 0), null);
  assert.equal(percentChange(null, 100), null);
  assert.equal(percentChange(100, undefined), null);
});

test('gradeSteps: every grade() value is on the ladder; signed steps, positive is worse', () => {
  for (let s = 0; s <= 100; s++) assert.ok(GRADE_STEPS.includes(grade(s)), `grade(${s}) = ${grade(s)}`);
  assert.equal(gradeSteps('A', 'A'), 0);
  assert.equal(gradeSteps(grade(95), grade(88)), 2); // A+ → B+
  assert.equal(gradeSteps(grade(85), grade(92)), -2);
  assert.equal(gradeSteps('D−', 'F'), 1);
  assert.equal(gradeSteps(null, 'A'), null);
});

test('verdict: grade shift beats overhead; above 5% median is off; otherwise on', () => {
  assert.equal(verdict([{ steps: 2 }], { lcp: 0, blocking: 0 }), 'revisit thresholds');
  assert.equal(verdict([{ steps: -2 }], { lcp: 50, blocking: 0 }), 'revisit thresholds');
  assert.equal(verdict([{ steps: 1 }], { lcp: 5.1, blocking: 0 }), 'default off');
  assert.equal(verdict([{ steps: 0 }], { lcp: 2, blocking: 6 }), 'default off');
  assert.equal(verdict([{ steps: 1 }], { lcp: 5, blocking: -20 }), 'default on');
  assert.equal(verdict([{ steps: null }], { lcp: null, blocking: null }), 'default on');
});

const reading = ({ lcp, blocking, coverageFindings }) => {
  const r = createReading({ entries: [], target: makeTarget('https://s.test/', 'S', 'https://s.test/') });
  r.log._harplus.plugins = {
    vitals: { id: 'vitals', name: 'Vitals', status: 'ok', summary: [], findings: [], data: { lcp: { time: lcp }, blockingTime: blocking, ratings: {} } },
    ...(coverageFindings ? { coverage: { id: 'coverage', name: 'Coverage', status: 'ok', summary: [], findings: coverageFindings } } : {}),
  };
  return r;
};
const plugins = [{ id: 'vitals', area: 'performance' }, { id: 'coverage', area: 'performance' }];

test('timings and performance with and without one plugin', () => {
  const r = reading({ lcp: 1200, blocking: 80, coverageFindings: [{ severity: 'medium', category: 'performance', title: 'x' }, { severity: 'medium', category: 'performance', title: 'y' }] });
  assert.deepEqual(timings(r), { lcp: 1200, blocking: 80 });
  assert.deepEqual(timings({ log: { _harplus: {} } }), { lcp: null, blocking: null });
  assert.equal(performance(r, plugins).score, 88);
  assert.equal(performance(r, plugins, { without: 'coverage' }).score, 100);
  assert.ok(r.log._harplus.plugins.coverage, 'the reading is not changed');
});

test('compareRuns: sites in both runs only, medians and verdict', () => {
  const cov = [{ severity: 'medium', category: 'performance', title: 'x' }];
  const on = new Map([['a', reading({ lcp: 1100, blocking: 100, coverageFindings: cov })], ['b', reading({ lcp: 2000, blocking: 0 })], ['c', reading({ lcp: 1, blocking: 1 })]]);
  const off = new Map([['a', reading({ lcp: 1000, blocking: 100 })], ['b', reading({ lcp: 2000, blocking: 0 })]]);
  const { rows, medians, verdict: v } = compareRuns(on, off, plugins);
  assert.deepEqual(rows.map((r) => r.site), ['a', 'b']);
  assert.equal(rows[0].lcpPct, 10);
  assert.equal(rows[0].steps, 1); // 100 → 94: A+ → A
  assert.deepEqual(medians, { lcp: 5, blocking: 0, lcpSites: 2, blockingSites: 1 }); // b's 0/0 blocking is under the floor
  assert.equal(v, 'default on');
});

test('counts: left out only when both values are under the floor, or one is missing', () => {
  assert.equal(counts(400, 450, LCP_FLOOR), false);
  assert.equal(counts(400, 600, LCP_FLOOR), true);
  assert.equal(counts(500, 100, LCP_FLOOR), true);
  assert.equal(counts(49, 0, BLOCKING_FLOOR), false);
  assert.equal(counts(60, 0, BLOCKING_FLOOR), true);
  assert.equal(counts(null, 600, LCP_FLOOR), false);
  assert.equal(LCP_FLOOR, 500);
  assert.equal(BLOCKING_FLOOR, 50);
});

test('passMedian: the median of a site across passes; passes missing the site are ignored', () => {
  const p1 = new Map([['a', reading({ lcp: 1000, blocking: 100 })]]);
  const p2 = new Map([['a', reading({ lcp: 2000, blocking: 300 })]]);
  const p3 = new Map();
  assert.deepEqual(passMedian([p1, p2, p3], 'a'), { lcp: 1500, blocking: 200, passes: 2 });
  assert.deepEqual(passMedian([p3], 'a'), { lcp: null, blocking: null, passes: 0 });
});

test('compareRuns with two passes per state: per-site medians, floors, worst grade shift across on passes', () => {
  const big = [{ severity: 'high', category: 'performance', title: 'x' }, { severity: 'medium', category: 'performance', title: 'y' }];
  const on = [
    new Map([['a', reading({ lcp: 1000, blocking: 100 })], ['s', reading({ lcp: 100, blocking: 10 })]]),
    new Map([['a', reading({ lcp: 1400, blocking: 300, coverageFindings: big })], ['s', reading({ lcp: 300, blocking: 30 })]]),
  ];
  const off = [
    new Map([['a', reading({ lcp: 1000, blocking: 100 })], ['s', reading({ lcp: 100, blocking: 10 })]]),
    new Map([['a', reading({ lcp: 1000, blocking: 100 })]]),
  ];
  const { rows, medians, verdict: v } = compareRuns(on, off, plugins);
  const a = rows.find((r) => r.site === 'a');
  assert.deepEqual([a.lcpOn, a.lcpOff, a.lcpPct], [1200, 1000, 20]);
  assert.deepEqual([a.blockingOn, a.blockingOff, a.blockingPct], [200, 100, 100]);
  assert.equal(a.grades.length, 2);
  assert.equal(a.steps, 6, 'the worst on pass: 100 → 79 is A+ → C+');
  const s = rows.find((r) => r.site === 's');
  assert.deepEqual([s.passesOn, s.passesOff, s.lcpCounts, s.blockingCounts], [2, 1, false, false]);
  assert.deepEqual(medians, { lcp: 20, blocking: 100, lcpSites: 1, blockingSites: 1 });
  assert.equal(v, 'revisit thresholds');
});
