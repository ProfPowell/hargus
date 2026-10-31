import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureSession, coverageSkip } from '../extension/browser/capture.js';
import { SKIP, JS_UNAVAILABLE } from '../extension/core/coverage.js';

// A session with no constructor side effects: just the fields the coverage methods use and a scripted `send`.
const fakeSession = (replies = {}) => {
  const s = Object.create(CaptureSession.prototype);
  s.tabId = 1;
  s.mainFrameId = 'F1';
  s.initialUrl = 'https://example.com/';
  s.sent = [];
  s.send = async (method, params) => {
    s.sent.push(method);
    const r = replies[method];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(params) : r ?? {};
  };
  return s;
};

test('coverageSkip: snapshot, record and off skip; reload with coverage on measures', () => {
  assert.equal(coverageSkip({ mode: 'snapshot' }, {}), SKIP.snapshot);
  assert.equal(coverageSkip({ mode: 'record' }, { capture: { coverage: true } }), SKIP.record);
  assert.equal(coverageSkip({ mode: 'reload' }, { capture: { coverage: false } }), SKIP.off);
  assert.equal(coverageSkip({ mode: 'reload' }, { capture: { coverage: true } }), null);
  assert.equal(coverageSkip({ mode: 'reload' }, {}), null, 'missing setting counts as on');
  assert.equal(coverageSkip({ mode: 'reload' }, undefined), null);
});

const refused = (m) => new Error(JSON.stringify({ code: -32601, message: `'${m}' wasn't found` }));
const cssReplies = {
  'CSS.stopRuleUsageTracking': { ruleUsage: [{ styleSheetId: 'S1', startOffset: 0, endOffset: 30, used: true }, { styleSheetId: 'S1', startOffset: 30, endOffset: 50, used: false }] },
  'Page.getFrameTree': { frameTree: { frame: { id: 'F1', url: 'https://example.com/' } } },
};
const sheet = (s) => s.onEvent({ tabId: 1 }, 'CSS.styleSheetAdded', { header: { styleSheetId: 'S1', frameId: 'F1', sourceURL: 'https://example.com/a.css', origin: 'regular', length: 50 } });

test('Profiler refused: CSS is still collected, JS is stored as skipped with the reason', async () => {
  const s = fakeSession({ ...cssReplies, 'Profiler.enable': refused('Profiler.enable') });
  await s.startCoverage();
  assert.ok(!s.coverage?.skipped, 'not a whole skip');
  assert.ok(s.sent.includes('CSS.startRuleUsageTracking'), 'CSS tracking starts');
  sheet(s);
  await s.takeCoverage(true);
  assert.deepEqual(s.coverage.js, { skipped: JS_UNAVAILABLE });
  assert.equal(JS_UNAVAILABLE, "JavaScript coverage isn't available to Chrome extensions");
  assert.equal(s.coverage.css.fileCount, 1);
  assert.equal(s.coverage.css.unusedBytes, 20);
  assert.ok(!s.coverage.skipped);
  assert.ok(!s.sent.includes('Profiler.takePreciseCoverage'), 'JS is not taken');
});

test('startPreciseCoverage refused also skips JS only', async () => {
  const s = fakeSession({ ...cssReplies, 'Profiler.startPreciseCoverage': refused('Profiler.startPreciseCoverage') });
  await s.startCoverage();
  sheet(s);
  await s.takeCoverage(true);
  assert.deepEqual(s.coverage.js, { skipped: JS_UNAVAILABLE });
  assert.equal(s.coverage.css.fileCount, 1);
});

test('takePreciseCoverage failing skips JS only; CSS is kept', async () => {
  const s = fakeSession({ ...cssReplies, 'Profiler.takePreciseCoverage': new Error('Target closed') });
  await s.startCoverage();
  sheet(s);
  await s.takeCoverage(true);
  assert.deepEqual(s.coverage.js, { skipped: 'coverage failed: Target closed' });
  assert.equal(s.coverage.css.fileCount, 1);
  assert.equal(s.coverageSheets, null, 'headers stop being collected');
});

test('CSS tracking failing skips CSS only; JS is kept', async () => {
  const s = fakeSession({
    'CSS.startRuleUsageTracking': new Error('nope'),
    'Profiler.takePreciseCoverage': { result: [{ url: 'https://example.com/app.js', functions: [{ ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] }] }] },
  });
  await s.startCoverage();
  await s.takeCoverage(true);
  assert.deepEqual(s.coverage.css, { skipped: 'coverage failed: nope' });
  assert.equal(s.coverage.js.fileCount, 1);
  assert.ok(!s.sent.includes('CSS.stopRuleUsageTracking'));
});

test('both halves failing at start is a whole skip, and takeCoverage keeps it', async () => {
  const s = fakeSession({ 'Profiler.enable': refused('Profiler.enable'), 'CSS.startRuleUsageTracking': new Error('nope') });
  await s.startCoverage();
  assert.deepEqual(s.coverage, { skipped: 'coverage failed: nope' });
  await s.takeCoverage(true);
  assert.deepEqual(s.coverage, { skipped: 'coverage failed: nope' });
  assert.ok(!s.sent.includes('Profiler.takePreciseCoverage') && !s.sent.includes('CSS.stopRuleUsageTracking'));
});

test('both halves failing at take is a whole skip', async () => {
  const s = fakeSession({ 'Profiler.takePreciseCoverage': new Error('Target closed'), 'CSS.stopRuleUsageTracking': new Error('Target closed') });
  await s.startCoverage();
  await s.takeCoverage(true);
  assert.deepEqual(s.coverage, { skipped: 'coverage failed: Target closed' });
});

test('startCoverage enables in order; takeCoverage summarises main-frame sheets and scripts', async () => {
  const s = fakeSession({
    'Profiler.takePreciseCoverage': {
      result: [{ url: 'https://example.com/app.js', functions: [{ ranges: [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 60, endOffset: 100, count: 0 }] }] }],
    },
    'CSS.stopRuleUsageTracking': { ruleUsage: [{ styleSheetId: 'S1', startOffset: 0, endOffset: 30, used: true }, { styleSheetId: 'S1', startOffset: 30, endOffset: 50, used: false }] },
    'Page.getFrameTree': { frameTree: { frame: { id: 'F1', url: 'https://example.com/' } } },
  });
  await s.startCoverage();
  assert.deepEqual(s.sent, ['Profiler.enable', 'Profiler.startPreciseCoverage', 'DOM.enable', 'CSS.enable', 'CSS.startRuleUsageTracking']);
  s.onEvent({ tabId: 1 }, 'CSS.styleSheetAdded', { header: { styleSheetId: 'S1', frameId: 'F1', sourceURL: 'https://example.com/a.css', origin: 'regular', length: 50 } });
  s.onEvent({ tabId: 1, sessionId: 'child' }, 'CSS.styleSheetAdded', { header: { styleSheetId: 'S2', frameId: 'F2', sourceURL: 'https://x.com/b.css', origin: 'regular', length: 50 } });
  await s.takeCoverage(false);
  assert.equal(s.coverage.window, 'load');
  assert.equal(s.coverage.idle, false);
  assert.equal(s.coverage.js.fileCount, 1);
  assert.equal(s.coverage.js.unusedBytes, 40);
  assert.equal(s.coverage.css.fileCount, 1);
  assert.ok(!s.coverage.skipped);
  assert.ok(s.sent.includes('CSS.disable') && s.sent.includes('Profiler.stopPreciseCoverage'), 'domains are dropped after taking');
});
