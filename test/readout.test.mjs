import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreReading, AREAS } from '../extension/core/score.js';
import { getPlugins } from '../extension/plugins/index.js';
import { viewLabel } from '../extension/core/views.js';
import { verdictSentence, readingStatus, plainReason } from '../extension/core/readout.js';

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
  assert.match(verdictSentence(s), /^Capped at D: Accessibility is failing \(critical for Public sector \/ education\)\. /);
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
  assert.equal(verdictSentence(s), 'Content is failing (critical for Brochure / content site). Strong on security. Content is poor.');
});

test('verdict: tied scores follow area order', () => {
  // Ties sort stably in AREAS order: the first two tied lead "Strong on", the last tied is the weak one.
  const top = mk({ performance: [95, 0], security: [95, 0], content: [95, 0] });
  assert.equal(verdictSentence(top), 'Strong on performance and security. No area below 95.');
  const low = mk({ performance: [80, 0], accessibility: [40, 0], build: [40, 2] });
  assert.equal(verdictSentence(low), 'Best area: performance (80). Build is failing: all 2 high-severity issues are there.');
});
