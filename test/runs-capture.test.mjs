import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../extension/browser/settings.js';
import { CaptureSession, runsWanted, takeReading } from '../extension/browser/capture.js';
import { HarRecorder } from '../extension/core/recorder.js';

const vitalsOf = (lcp) => ({ visibility: 'visible', lcp: { time: lcp }, fcp: lcp / 2, cls: 0.01, blockingTime: 10, navigation: { ttfb: 100, domContentLoaded: 500, load: 900 } });

// A session with only the fields timingRuns uses; reload, idle and evaluate are scripted and logged in `calls`.
const fakeSession = (evaluate, opts = {}) => {
  const s = Object.create(CaptureSession.prototype);
  s.tabId = 1;
  s.opts = { idleMs: 10, maxWaitSec: 1, bypassCache: true, bodies: 'text', ...opts };
  s.recorder = new HarRecorder();
  s.console = { entries: [], dropped: 0 };
  s.bodyJobs = [];
  s.mainContexts = new Set();
  s.calls = [];
  s.reports = [];
  s.report = (stage, detail) => s.reports.push([stage, detail]);
  s.reloadQuiet = async (o) => { s.calls.push(['reload', o]); };
  s.loaded = true;
  s.waitForIdle = async (o) => { s.calls.push(['idle', o]); return true; };
  s.evaluate = async (...a) => { s.calls.push(['evaluate']); return evaluate(...a); };
  return s;
};

test('runsWanted: 3 or 5 in reload mode, otherwise 1', () => {
  assert.equal(runsWanted({ mode: 'reload', runs: 3 }), 3);
  assert.equal(runsWanted({ mode: 'reload', runs: 5 }), 5);
  assert.equal(runsWanted({ mode: 'snapshot', runs: 3 }), 1);
  assert.equal(runsWanted({ mode: 'record', runs: 5 }), 1);
  assert.equal(runsWanted({ mode: 'reload', runs: 4 }), 1);
  assert.equal(runsWanted({ mode: 'reload', runs: '3' }), 1);
  assert.equal(runsWanted({ mode: 'reload' }), 1);
});

test('the default is one run', () => assert.equal(DEFAULTS.capture.runs, 1));

test('timingRuns(3): two timing samples numbered 1 and 2, nothing skipped', async () => {
  let k = 0;
  const s = fakeSession(() => vitalsOf(1000 + 100 * ++k));
  const r = await s.timingRuns(3);
  assert.equal(r.requested, 3);
  assert.deepEqual(r.samples.map((x) => x.run), [1, 2]);
  assert.equal(r.samples[0].lcp, 1100);
  assert.equal(r.samples[1].ttfb, 100);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(s.reports, [['loading', 'Timing run 1 of 3'], ['loading', 'Timing run 2 of 3']]);
  assert.deepEqual(s.calls.find((c) => c[0] === 'reload')[1], { ignoreCache: true });
  assert.equal(s.calls.find((c) => c[0] === 'idle')[1].quiet, true);
  assert.equal(s.runs, r);
});

test('a run that fails is skipped with its reason; no throw', async () => {
  let k = 0;
  const s = fakeSession(() => { if (++k === 2) throw new Error('page error'); return vitalsOf(1000); });
  const r = await s.timingRuns(5);
  assert.deepEqual(r.samples.map((x) => x.run), [1, 3, 4]);
  assert.deepEqual(r.skipped, [{ run: 2, reason: 'page error' }]);
});

test('a run whose page never finished loading is skipped, not sampled', async () => {
  let k = 0;
  const s = fakeSession(() => vitalsOf(1000));
  s.waitForIdle = async () => { s.loaded = ++k !== 1; return false; };
  const r = await s.timingRuns(3);
  assert.deepEqual(r.samples.map((x) => x.run), [2]);
  assert.deepEqual(r.skipped, [{ run: 1, reason: 'page did not finish loading' }]);
});

test('a run in a hidden tab is skipped', async () => {
  let k = 0;
  const s = fakeSession(() => ({ ...vitalsOf(1000), visibility: ++k === 1 ? 'hidden' : 'visible' }));
  const r = await s.timingRuns(3);
  assert.deepEqual(r.samples.map((x) => x.run), [2]);
  assert.deepEqual(r.skipped, [{ run: 1, reason: 'tab was hidden' }]);
});

test('traffic and console during timing runs never reach the reading', async () => {
  const s = fakeSession(async () => {
    assert.equal(s.timingRunning, true);
    s.onEvent({ tabId: 1 }, 'Network.requestWillBeSent', { requestId: 'r1', loaderId: 'L', request: { url: 'https://example.com/a.js', method: 'GET', headers: {} }, timestamp: 1, wallTime: 1, type: 'Script' });
    s.onEvent({ tabId: 1 }, 'Network.loadingFinished', { requestId: 'r1', timestamp: 2, encodedDataLength: 10 });
    return vitalsOf(1000);
  });
  s.fromMainWorld = () => true;
  s.onEvent({ tabId: 1 }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'hi' }], executionContextId: 1, timestamp: 1 });
  await s.timingRuns(3);
  assert.equal(s.timingRunning, false);
  assert.deepEqual(s.recorder.build().entries, []);
  assert.deepEqual(s.console, { entries: [], dropped: 0 });
  assert.deepEqual(s.bodyJobs, []);
});

// takeReading with the session's heavy steps replaced by loggers: the order of calls, and when fullRunAt is set.
const stubTake = async (opts, settings = { capture: { coverage: true } }) => {
  const P = CaptureSession.prototype;
  const names = ['attach', 'detach', 'timingRuns', 'startCoverage', 'takeCoverage', 'reload', 'waitForIdle', 'scrollThrough', 'finish'];
  const saved = Object.fromEntries(names.map((n) => [n, Object.getOwnPropertyDescriptor(P, n)]));
  const log = [];
  let at;
  P.attach = async () => {};
  P.detach = async () => {};
  P.timingRuns = async function (n) { log.push(`timing ${n}`); };
  P.startCoverage = async function () { log.push('startCoverage'); };
  P.takeCoverage = async function () {};
  P.reload = async function () { log.push('reload'); at = this.fullRunAt; };
  P.waitForIdle = async () => true;
  P.scrollThrough = async () => {};
  P.finish = async function () { return this; };
  try {
    const s = await takeReading(7, opts, { report() {}, settings });
    return { log, at, s };
  } finally {
    for (const n of names) { if (saved[n]) Object.defineProperty(P, n, saved[n]); else delete P[n]; }
  }
};

test('takeReading: timing runs, then coverage, then the full reload; fullRunAt is set before it', async () => {
  const before = Date.now();
  const { log, at } = await stubTake({ mode: 'reload', runs: 3, idleMs: 1, maxWaitSec: 1, scroll: false });
  assert.deepEqual(log, ['timing 3', 'startCoverage', 'reload']);
  assert.match(at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.ok(Date.parse(at) >= before - 1);
});

test('takeReading: one run takes no timing runs', async () => {
  const { log, at } = await stubTake({ mode: 'reload', runs: 1, idleMs: 1, maxWaitSec: 1, scroll: false });
  assert.deepEqual(log, ['startCoverage', 'reload']);
  assert.ok(at);
});
