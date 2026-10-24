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
