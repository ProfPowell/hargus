import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countMatches, scriptOf, primary, sameLanguage, normCharset, languageName, chromeDetector } from '../extension/core/language.js';

test('countMatches: ambiguous numeric dates only', () => {
  assert.equal(countMatches('on 03/04/2025 and 4.5.25', 'date').count, 2);
  assert.equal(countMatches('13/04/2025, 1.2.3, 10/20/30, v2.10.4', 'date').count, 0);
});
test('countMatches: 12-hour times and money', () => {
  assert.equal(countMatches('opens 3:00 PM, closes 9:30 p.m.; 14:00', 'time').count, 2);
  assert.equal(countMatches('€12, 12 €, $5, £ 3, 12 apples', 'money').count, 4);
});
test('countMatches: mojibake and replacement with context examples', () => {
  const m = countMatches('a cafÃ© here, itâ€™s, Â fine', 'mojibake'); // Â + no-break space = a mis-decoded U+00A0
  assert.equal(m.count, 3);
  assert.ok(m.examples[0].includes('cafÃ©'));
  assert.equal(countMatches('a�b�', 'replacement').count, 2);
});
test('scriptOf picks the dominant script', () => {
  assert.deepEqual(scriptOf('Привет мир'), { script: 'Cyrillic', share: 1 });
  assert.ok(['Han', 'Kana'].includes(scriptOf('日本語のテキスト').script));
  assert.deepEqual(scriptOf('123 !!'), { script: null, share: 0 });
});
test('subtags and charsets', () => {
  assert.equal(primary('en-GB'), 'en');
  assert.ok(sameLanguage('zh-Hant', 'zh'));
  assert.ok(!sameLanguage('en', 'fr'));
  assert.equal(normCharset(' "UTF8" '), 'utf-8');
  assert.equal(normCharset('ISO-8859-1'), normCharset('windows-1252'));
  assert.equal(normCharset(''), null);
  assert.equal(languageName('de'), 'German');
});
test('chromeDetector: absent without chrome; maps the top result; null on und/errors', async () => {
  assert.equal(chromeDetector(), undefined);
  globalThis.chrome = { i18n: { detectLanguage: (t, cb) => cb({ isReliable: true, languages: [{ language: 'fr-FR', percentage: 92 }] }) } };
  try {
    assert.deepEqual(await chromeDetector()('x'), { code: 'fr', share: 0.92, reliable: true });
    globalThis.chrome.i18n.detectLanguage = (t, cb) => cb({ isReliable: false, languages: [{ language: 'und', percentage: 100 }] });
    assert.equal(await chromeDetector()('x'), null);
    globalThis.chrome.i18n.detectLanguage = () => { throw new Error('boom'); };
    assert.equal(await chromeDetector()('x'), null);
  } finally { delete globalThis.chrome; }
});
