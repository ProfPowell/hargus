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

test('countMatches date: dotted versions and IPs are not dates; real dates still count', () => {
  assert.equal(countMatches('1.2.11.35', 'date').count, 0);
  assert.equal(countMatches('ip 10.1.12.30', 'date').count, 0);
  assert.equal(countMatches('v1.2.10 and V2.11.35', 'date').count, 0);
  assert.equal(countMatches('build 1.2.10.4', 'date').count, 0);
  assert.equal(countMatches('4.5.25', 'date').count, 1);
  assert.equal(countMatches('03/04/2025', 'date').count, 1);
});
test('countMatches stringifies its input', () => {
  assert.equal(countMatches(new String('a\uFFFDb'), 'replacement').examples[0], 'a\uFFFDb');
});
test('scriptOf: prolonged sound mark counts as Kana', () => {
  assert.equal(scriptOf('日本語のテキスト').script, 'Kana');
  assert.deepEqual(scriptOf('カレー'), { script: 'Kana', share: 1 });
});
test('chromeDetector: bad payloads, promise API and timeout', async () => {
  const set = (fn) => { globalThis.chrome = { i18n: { detectLanguage: fn } }; };
  try {
    set((t, cb) => cb({ isReliable: true, languages: [{ language: 'fr' }] }));
    assert.equal(await chromeDetector()('x'), null); // missing percentage
    set((t, cb) => cb({ isReliable: true, languages: [{ language: 'fr', percentage: 'lots' }] }));
    assert.equal(await chromeDetector()('x'), null); // non-numeric percentage
    set((t, cb) => cb({ isReliable: true, languages: [] }));
    assert.equal(await chromeDetector()('x'), null); // empty list
    set((t, cb) => cb({ isReliable: true, languages: [{ language: '', percentage: 90 }] }));
    assert.equal(await chromeDetector()('x'), null); // no primary subtag
    set(async () => ({ isReliable: true, languages: [{ language: 'de-AT', percentage: 80 }] }));
    assert.deepEqual(await chromeDetector()('x'), { code: 'de', share: 0.8, reliable: true }); // promise API
    set(() => {}); // never answers
    const t0 = Date.now();
    assert.equal(await chromeDetector({ timeoutMs: 20 })('x'), null);
    assert.ok(Date.now() - t0 < 1000);
  } finally { delete globalThis.chrome; }
});
