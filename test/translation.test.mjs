import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSLATED_VIEWS, classifyError, sameAsPage, needsFallback } from '../extension/core/translation.js';
import { INTERNATIONAL_VIEWS, VIEW_LABELS } from '../extension/core/views.js';
import { DEFAULTS } from '../extension/browser/settings.js';

test('TRANSLATED_VIEWS lists German, Arabic, Japanese', () => {
  assert.deepEqual(TRANSLATED_VIEWS, [
    { id: 'translated-de', lang: 'de', label: 'German' },
    { id: 'translated-ar', lang: 'ar', label: 'Arabic' },
    { id: 'translated-ja', lang: 'ja', label: 'Japanese' },
  ]);
});
test('classifyError: page-wide vs per-language', () => {
  assert.deepEqual(classifyError('NotAllowedError: Access denied because the Permission Policy is not enabled.'), { reason: "blocked by the site's Permissions-Policy", scope: 'all' });
  assert.equal(classifyError('ReferenceError: Translator is not defined').scope, 'all');
  assert.equal(classifyError('create timed out after 60 s').reason, 'the translation model did not load in time');
  assert.deepEqual(classifyError('NotSupportedError: Unable to create translator for the given source and target language.'), { reason: 'translation failed: NotSupportedError: Unable to create translator for the given source and target l', scope: 'one' });
});
test('sameAsPage compares primary subtags', () => {
  assert.ok(sameAsPage('de', 'de-AT'));
  assert.ok(!sameAsPage('de', 'en'));
  assert.ok(!sameAsPage('ja', ''));
});
test('needsFallback: only failures count, and pseudo can be turned off', () => {
  const ok = { status: 'ok' }; const off = { status: 'skipped', reason: 'turned off' }; const same = { status: 'skipped', reason: 'page is already in German' };
  const bad = { status: 'failed', reason: 'blocked' };
  assert.equal(needsFallback({ 'translated-de': ok, 'translated-ar': ok, 'translated-ja': ok }, {}), false);
  assert.equal(needsFallback({ 'translated-de': same, 'translated-ar': off, 'translated-ja': ok }, {}), false);
  assert.equal(needsFallback({ 'translated-de': ok, 'translated-ar': bad, 'translated-ja': ok }, {}), true);
  assert.equal(needsFallback({ 'translated-de': bad }, { pseudo: false }), false);
});
test('views: translated views registered between rtl and pseudo, labelled, on by default', () => {
  assert.deepEqual(INTERNATIONAL_VIEWS, ['rtl', 'translated-de', 'translated-ar', 'translated-ja', 'pseudo']);
  assert.equal(VIEW_LABELS['translated-ar'], 'Arabic');
  for (const t of TRANSLATED_VIEWS) {
    assert.equal(VIEW_LABELS[t.id], t.label);
    assert.equal(DEFAULTS.capture.views[t.id], true);
  }
});
test('viewBudget: each translated view gets min(per-view, shared left); too little left is none', async () => {
  const { viewBudget, TRANSLATED_BUDGET_MS, TRANSLATED_VIEW_MS, TRANSLATED_RESERVE_MS, TRANSLATED_MIN_MS } = await import('../extension/core/translation.js');
  assert.equal(TRANSLATED_BUDGET_MS, 300_000);
  assert.equal(TRANSLATED_VIEW_MS, 180_000);
  assert.deepEqual(viewBudget(300_000), { runMs: 180_000, timeoutMs: 60_000, budgetMs: 100_000, totalMs: 160_000 });
  assert.deepEqual(viewBudget(100_000), { runMs: 100_000, timeoutMs: 60_000, budgetMs: 80_000, totalMs: 80_000 });
  assert.deepEqual(viewBudget(50_000), { runMs: 50_000, timeoutMs: 30_000, budgetMs: 30_000, totalMs: 30_000 });
  assert.deepEqual(viewBudget(TRANSLATED_MIN_MS), { runMs: TRANSLATED_MIN_MS, timeoutMs: TRANSLATED_MIN_MS - TRANSLATED_RESERVE_MS, budgetMs: TRANSLATED_MIN_MS - TRANSLATED_RESERVE_MS, totalMs: TRANSLATED_MIN_MS - TRANSLATED_RESERVE_MS });
  assert.equal(viewBudget(TRANSLATED_MIN_MS - 1), null);
  assert.equal(viewBudget(0), null);
  assert.equal(viewBudget(-5), null);
  assert.equal(viewBudget(200_000, 60_000).runMs, 60_000, 'a smaller per-view cap wins');
});
test('the translated views alone cannot outlast the views wait', async () => {
  const { TRANSLATED_BUDGET_MS, TRANSLATED_VIEWS: tv } = await import('../extension/core/translation.js');
  const { VIEWS_HARD_MS } = await import('../extension/core/views-wait.js');
  // Worst case: the shared budget, plus for each view the 45 s wait for a run that overran, its 20 s restore and the 3 s language read.
  assert.ok(TRANSLATED_BUDGET_MS + tv.length * (45_000 + 20_000) + 3000 < VIEWS_HARD_MS, `${TRANSLATED_BUDGET_MS} vs ${VIEWS_HARD_MS}`);
});
test('the page functions canonicalise language codes with the same aliases as core/language.js', async () => {
  const { ALIAS } = await import('../extension/core/language.js');
  const { translatePage, leftoverText } = await import('../extension/browser/translate-view.js');
  for (const fn of [translatePage, leftoverText]) {
    const m = /const ALIAS = (\{[^}]*\})/.exec(fn.toString());
    assert.ok(m, `${fn.name} has an ALIAS literal`);
    assert.deepEqual(Function(`return ${m[1]}`)(), ALIAS, fn.name);
  }
});
