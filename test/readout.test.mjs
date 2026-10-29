import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreReading, AREAS } from '../extension/core/score.js';
import { getPlugins } from '../extension/plugins/index.js';
import { viewLabel } from '../extension/core/views.js';
import { verdictSentence, readingStatus, plainReason, notApplicableWhy, notASkip } from '../extension/core/readout.js';

const f = (severity, category, title = `${severity} ${category}`) => ({ severity, category, title });
const ok = (id, findings = []) => ({ id, name: id, status: 'ok', findings, summary: [], data: {} });
const reading = (plugins, capture) => ({ log: { entries: [], _harplus: { plugins, ...(capture ? { capture } : {}) } } });

// Hand-built scores: { id: [score, highCount] }.
const mk = (spec, overall = {}) => {
  const areas = {};
  for (const a of AREAS) {
    const [score, high] = spec[a.id] ?? [null, 0];
    const status = score == null ? 'none' : score >= 85 ? 'good' : score >= 70 ? 'warning' : score >= 50 ? 'serious' : 'critical';
    areas[a.id] = { id: a.id, label: a.label, score, status, measured: score != null, counts: { high, medium: 0, low: 0, info: 0 }, deductions: [] };
  }
  return { areas, overall: { capped: null, failingCritical: [], profile: { label: 'General' }, ...overall }, weights: {} };
};

test('verdict: strong pair, failing area holding every high issue', () => {
  const s = mk({ infrastructure: [100, 0], performance: [96, 0], content: [88, 0], accessibility: [37, 6] });
  assert.equal(verdictSentence(s), 'Strong on infrastructure and performance. Accessibility is failing: all 6 high-severity issues are there.');
});

test('verdict: single strong area; weakest has no high issues', () => {
  const s = mk({ security: [95, 0], content: [60, 0] });
  assert.equal(verdictSentence(s), 'Strong on security. Content is poor.');
});

test('verdict: no strong area, weakest poor with some highs', () => {
  const s = mk({ content: [84, 1], security: [60, 2], build: [80, 0] });
  assert.equal(verdictSentence(s), 'Best area: content (84). Security is poor: 2 of 3 high-severity issues are there.');
});

test('verdict: everything fine', () => {
  const s = mk({ security: [98, 0], performance: [92, 0], content: [88, 0] });
  assert.equal(verdictSentence(s), 'Strong on security and performance. No area below 88.');
});

test('verdict: one measured, healthy area has no closing clause', () => {
  assert.equal(verdictSentence(mk({ security: [80, 0] })), 'Best area: security (80).');
});

test('verdict: cap text first, unchanged', () => {
  const highs = Array(4).fill(0).map((_, i) => f('high', 'accessibility', `h${i}`));
  const r = reading({
    'a11y-basics': ok('a11y-basics', [...highs, ...Array(5).fill(0).map(() => f('medium', 'accessibility'))]),
    security: ok('security'), dns: ok('dns'), international: ok('international', []),
    html: ok('html'), meta: ok('meta'), vitals: ok('vitals'),
  });
  const s = scoreReading(r, getPlugins(), { profile: 'public' });
  assert.ok(s.overall.capped);
  const v = verdictSentence(s);
  assert.match(v, /^Capped at D: Accessibility is failing \(critical for Public sector \/ education\)\. /);
  assert.equal((v.match(/accessibility is/gi) || []).length, 1, v);
});

test('verdict: nothing measured', () => {
  assert.equal(verdictSentence(scoreReading(reading({}), [])), 'No areas measured yet — enable plugins and re-run analysis.');
});

test('readingStatus: complete / partial (skipped view, plugin error) / failed', () => {
  const okr = reading({ a: ok('a') }, { views: [{}, {}], warnings: ['w1'] });
  const c = readingStatus(okr);
  assert.deepEqual([c.state, c.views, c.skipped, c.failedChecks, c.warnings], ['complete', 2, [], [], ['w1']]);

  const withSkip = reading({ a: ok('a') }, { views: [{}], viewsSkipped: [{ view: 'translated-de', reason: 'TimeoutError: Translator create timed out after 60s' }] });
  const p = readingStatus(withSkip);
  assert.equal(p.state, 'partial');
  assert.deepEqual(p.skipped[0], { view: 'translated-de', label: viewLabel('translated-de'), why: "the on-device translator didn't load in time" });

  const withErr = readingStatus(reading({ a: ok('a'), b: { id: 'b', name: 'Bee', status: 'error' } }, { views: [] }));
  assert.equal(withErr.state, 'partial');
  assert.deepEqual(withErr.failedChecks, ['Bee']);
  assert.equal(withErr.views, 0);

  assert.equal(readingStatus(reading({ b: { id: 'b', status: 'error' } })).state, 'failed');
  assert.equal(readingStatus(reading({})).state, 'failed');
});

test('readingStatus: views as the recorder saves them (keyed object); an unneeded fallback is not a skip', () => {
  const s = readingStatus(reading({ a: ok('a') }, { views: { desktop: {}, mobile: {}, dark: {} }, viewsSkipped: [{ view: 'pseudo', reason: 'not needed' }] }));
  assert.equal(s.views, 3);
  assert.deepEqual(s.skipped, []);
  assert.equal(s.state, 'complete');
  const all = readingStatus(reading({ a: ok('a') }, { viewsSkipped: [{ view: 'all', reason: 'views did not finish' }] }));
  assert.equal(all.skipped[0].label, 'All views');
});

test('readingStatus: views switched off in settings are not skips', () => {
  const s = readingStatus(reading({ a: ok('a') }, { views: { desktop: {} }, viewsSkipped: [{ view: 'dark', reason: 'disabled' }, { view: 'protanopia', reason: 'disabled' }] }));
  assert.deepEqual(s.skipped, []);
  assert.equal(s.state, 'complete');
});

test('readingStatus: views counts screenshot-only views (vision) as captured', () => {
  const r = reading({ a: ok('a') }, { views: { desktop: {}, mobile: {} } });
  r.log._harplus.screenshots = [
    { kind: 'viewport', view: 'desktop' }, { kind: 'fullpage', view: 'desktop' }, { kind: 'viewport', view: 'mobile' },
    { kind: 'viewport', view: 'protanopia' }, { kind: 'viewport', view: 'deuteranopia' },
  ];
  assert.equal(readingStatus(r).views, 4);
});

// Every skip reason capture.js writes, with how the Overview reads it: [reason, 'na' | 'failure' | 'off', plain why].
const CAPTURE_REASONS = [
  ['disabled', 'off', null],
  ['not needed', 'off', null],
  ['not in reload mode', 'na', 'not available in snapshot mode'],
  ['page is already in German', 'na', 'the page is already in German'],
  ['page is already in Arabic', 'na', 'the page is already in Arabic'],
  ['page is already in Japanese', 'na', 'the page is already in Japanese'],
  ['no px breakpoints', 'na', 'the page has no width breakpoints'],
  ['css plugin not ok', 'failure', "the CSS check didn't finish, so no breakpoints were found"],
  ['could not read default font sizes', 'failure', "the browser's default text size couldn't be read"],
  ['out of time for translated views', 'failure', 'it took too long'],
  ["blocked by the site's Permissions-Policy", 'failure', 'the site blocks the on-device translator'],
  ['translation unavailable in this browser', 'failure', "this browser can't produce it"],
  ['the translation model did not load in time', 'failure', "the on-device translator didn't load in time"],
  ['debugger detached (target_closed)', 'failure', 'the page changed while it was being captured'],
  ['tab hidden or not painting — screenshots timed out', 'failure', 'it took too long'],
  ['German view timed out after 180s', 'failure', 'it took too long'],
  ['page did not finish loading without images', 'failure', "it couldn't be captured"],
  ['views did not finish', 'failure', "it couldn't be captured"],
];

test('every capture skip reason: classification and plain text', () => {
  for (const [reason, kind, why] of CAPTURE_REASONS) {
    const st = readingStatus(reading({ a: ok('a') }, { mode: 'snapshot', views: { desktop: {} }, viewsSkipped: [{ view: 'noimages', reason }] }));
    if (kind === 'off') {
      assert.ok(notASkip(reason), reason);
      assert.deepEqual([st.skipped, st.notApplicable, st.state], [[], [], 'complete'], reason);
    } else if (kind === 'na') {
      assert.equal(notApplicableWhy(reason, 'snapshot'), why, reason);
      assert.deepEqual(st.skipped, [], reason);
      assert.deepEqual(st.notApplicable, [{ view: 'noimages', label: 'No images', why }], reason);
      assert.equal(st.state, 'complete', reason);
    } else {
      assert.equal(notApplicableWhy(reason), null, reason);
      assert.deepEqual(st.skipped, [{ view: 'noimages', label: 'No images', why }], reason);
      assert.equal(st.state, 'partial', reason);
    }
  }
});

test('readingStatus: a snapshot reading with only not-applicable views is complete', () => {
  const st = readingStatus(reading({ a: ok('a') }, { mode: 'snapshot', views: { desktop: {}, mobile: {} }, viewsSkipped: [
    { view: 'noimages', reason: 'not in reload mode' }, { view: 'nojs', reason: 'not in reload mode' },
    { view: 'translated-de', reason: 'page is already in German' }, { view: 'breakpoints', reason: 'no px breakpoints' },
    { view: 'dark', reason: 'disabled' }, { view: 'pseudo', reason: 'not needed' },
  ] }));
  assert.equal(st.state, 'complete');
  assert.deepEqual(st.skipped, []);
  assert.deepEqual(st.notApplicable.map((x) => `${x.label} (${x.why})`), [
    'No images (not available in snapshot mode)', 'No JavaScript (not available in snapshot mode)',
    'German (the page is already in German)', 'Breakpoints (the page has no width breakpoints)',
  ]);
  const rec = readingStatus(reading({ a: ok('a') }, { mode: 'record', viewsSkipped: [{ view: 'nojs', reason: 'not in reload mode' }] }));
  assert.equal(rec.notApplicable[0].why, 'not available in record mode');
});

test('readingStatus: checks that skipped are listed with their reason and do not make a reading partial', () => {
  const st = readingStatus(reading({ a: ok('a'), p: { id: 'p', name: 'Page check', status: 'skipped', error: 'needs a live page — take a new reading' } }));
  assert.equal(st.state, 'complete');
  assert.deepEqual(st.skippedChecks, [{ name: 'Page check', why: 'needs a live page — take a new reading' }]);
  assert.deepEqual(st.failedChecks, []);
});

test('plainReason: first matching rule, fallback', () => {
  assert.equal(plainReason('Translator create timed out'), "the on-device translator didn't load in time");
  assert.equal(plainReason('Navigation timeout of 15000 ms exceeded'), 'it took too long');
  assert.equal(plainReason('Not supported'), "this browser can't produce it");
  assert.equal(plainReason('Target closed'), 'the page changed while it was being captured');
  assert.equal(plainReason('views could not be merged'), "the views couldn't be saved with the reading");
  assert.equal(plainReason('weird'), "it couldn't be captured");
  assert.equal(plainReason(undefined), "it couldn't be captured");
});

test('verdict: weak area holding the only high issue', () => {
  const s = mk({ security: [95, 0], content: [60, 1] });
  assert.equal(verdictSentence(s), 'Strong on security. Content is poor: the only high-severity issue is there.');
});

test('verdict: weak area holding 1 of M high issues', () => {
  const s = mk({ security: [80, 2], content: [60, 1] });
  assert.equal(verdictSentence(s), 'Best area: security (80). Content is poor: 1 of 3 high-severity issues are there.');
});

test('verdict: critical weak area is failing', () => {
  const s = mk({ performance: [72, 0], build: [30, 0] });
  assert.equal(verdictSentence(s), 'Best area: performance (72). Build is failing.');
});

test('verdict: failingCritical lead-in without a cap', () => {
  const s = mk({ security: [92, 0], content: [55, 0] }, { failingCritical: ['content'], profile: { label: 'Brochure / content site' } });
  assert.equal(verdictSentence(s), 'Content is failing (critical for Brochure / content site). Strong on security.');
});

test('verdict: an area the lead calls failing keeps only its high-issue fact', () => {
  const fc = (spec) => mk(spec, { failingCritical: ['accessibility'], profile: { label: 'General' } });
  assert.equal(verdictSentence(fc({ security: [95, 0], accessibility: [37, 6] })),
    'Accessibility is failing (critical for General). Strong on security. All 6 high-severity issues are in accessibility.');
  assert.equal(verdictSentence(fc({ security: [95, 0], accessibility: [55, 1] })),
    'Accessibility is failing (critical for General). Strong on security. The only high-severity issue is in accessibility.');
  assert.equal(verdictSentence(fc({ security: [80, 1], accessibility: [55, 2] })),
    'Accessibility is failing (critical for General). Best area: security (80). 2 of 3 high-severity issues are in accessibility.');
});

test('verdict: full cap names the capped area once', () => {
  const s = mk({ security: [95, 0], performance: [91, 0], accessibility: [42, 4] },
    { capped: { areas: ['accessibility'], from: 74 }, failingCritical: ['accessibility'], profile: { label: 'Public sector / education' } });
  const v = verdictSentence(s);
  assert.equal(v, 'Capped at D: Accessibility is failing (critical for Public sector / education). Strong on security and performance. All 4 high-severity issues are in accessibility.');
  assert.equal(v.match(/accessibility is/gi).length, 1);
  assert.doesNotMatch(v, /is (poor|failing)\./);
});

test('verdict: one measured area that is weak is not also the best', () => {
  assert.equal(verdictSentence(mk({ content: [40, 2] })), 'Content is failing: all 2 high-severity issues are there.');
  assert.equal(verdictSentence(mk({ content: [55, 0] }, { failingCritical: ['content'] })), 'Content is failing (critical for General).');
  assert.equal(verdictSentence(mk({ content: [55, 1] }, { failingCritical: ['content'] })),
    'Content is failing (critical for General). The only high-severity issue is in content.');
  assert.equal(verdictSentence(mk({ security: [95, 0] })), 'Strong on security.');
});

test('verdict: tied scores follow area order', () => {
  // Ties sort stably in AREAS order: the first two tied lead "Strong on", the last tied is the weak one.
  const top = mk({ performance: [95, 0], security: [95, 0], content: [95, 0] });
  assert.equal(verdictSentence(top), 'Strong on performance and security. No area below 95.');
  const low = mk({ performance: [80, 0], accessibility: [40, 0], build: [40, 2] });
  assert.equal(verdictSentence(low), 'Best area: performance (80). Build is failing: all 2 high-severity issues are there.');
});
