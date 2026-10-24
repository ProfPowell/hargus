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

// ---------------------------------------------------------------- plugin (Task 2)
import plugin from '../extension/plugins/language.js';
import { getPlugins } from '../extension/plugins/index.js';
import { h } from '../extension/ui/render.js';

const EN = 'The quick brown fox jumps over the lazy dog while the sun sets over the quiet hills and the farmers walk home. '.repeat(4);
const col = (over = {}) => ({
  htmlLang: 'en',
  regions: [{ lang: 'en', chars: EN.length, sample: EN }],
  blocks: [{ sel: 'p.a', lang: '', text: 'English paragraph number one that is certainly long enough to count as a block.' }],
  attrs: [],
  formats: { dates: { count: 0, examples: [] }, times: { count: 0, examples: [] }, money: { count: 0, examples: [] } },
  mojibake: { count: 0, examples: [] },
  replacement: { count: 0, examples: [] },
  metaCharset: 'utf-8',
  docCharset: 'utf-8',
  textImages: [],
  truncated: false,
  ...over,
});
const det = (map = {}) => async (text) => (text in map ? map[text] : { code: 'en', share: 0.98, reliable: true });
const rd = (headers = { 'content-type': 'text/html; charset=utf-8', 'content-language': 'en' }) => ({
  log: { entries: [{ _resourceType: 'document', request: { url: 'https://s.test/' }, response: { status: 200, headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } }], _harplus: { target: { url: 'https://s.test/', finalUrl: 'https://s.test/' } } },
});
const mk = (collected, detectLanguage) => ({ collected, detectLanguage, target: { url: 'https://s.test/', finalUrl: 'https://s.test/' }, skip: (m) => { throw new Error(m); } });
const go = (collected, { detector = det(), headers } = {}) => plugin.run(rd(headers), mk(collected, detector));
const titles = (out) => out.findings.map((f) => `${f.severity}:${f.title}`);
const GERMAN = 'Das ist ein deutscher Absatz, der lang genug ist, um als eigener Abschnitt gezählt zu werden, ganz sicher.';
const SPANISH = 'Este es un párrafo en español que es lo bastante largo como para contarse como un bloque propio, sin duda.';
const blk = (sel, text, lang = '') => ({ sel, lang, text });

test('registered right after international; page phase, international area', () => {
  const ids = getPlugins().map((p) => p.id);
  assert.equal(ids.indexOf('language'), ids.indexOf('international') + 1);
  assert.equal(plugin.area, 'international');
  assert.equal(plugin.phase, 'page');
  assert.ok(plugin.collectArgs().patterns.date);
});

test('clean page: no findings, detector method, Language row', async () => {
  const out = await go(col());
  assert.deepEqual(titles(out), []);
  assert.equal(out.data.method, 'detector');
  assert.ok(out.summary.find((r) => r.label === 'Language').value.includes('English'));
});

test('L1 missing lang', async () => {
  assert.ok(titles(await go(col({ htmlLang: null }))).includes("medium:The page doesn't say which language it is in"));
});

test('L2 declared vs detected, thresholds', async () => {
  const fr = (o) => go(col(), { detector: det({ [EN]: { code: 'fr', share: 0.92, reliable: true, ...o } }) });
  assert.ok(titles(await fr()).includes('high:Page says lang="en" but its text is mostly French (92%)'));
  assert.deepEqual(titles(await fr({ share: 0.55 })), []);
  assert.deepEqual(titles(await fr({ reliable: false })), []);
  const short = col({ regions: [{ lang: 'en', chars: 150, sample: 'x'.repeat(150) }] });
  assert.deepEqual(titles(await go(short, { detector: det({ ['x'.repeat(150)]: { code: 'fr', share: 0.9, reliable: true } }) })), []);
  assert.deepEqual(titles(await go(col({ htmlLang: 'en-GB', regions: [{ lang: 'en-GB', chars: EN.length, sample: EN }] }))), []);
});

test('L2 under the script fallback', async () => {
  const ru = 'Привет мир это длинный русский текст. '.repeat(10);
  const out = await go(col({ regions: [{ lang: 'en', chars: ru.length, sample: ru }] }), { detector: null });
  assert.ok(titles(out).includes('high:Page says lang="en" but its text is mostly Cyrillic script'));
  assert.equal(out.data.method, 'script');
  assert.ok(out.findings.every((f) => f.evidence.method === 'script'));
  const fr = 'Ceci est un long texte français pour le test, avec des accents é è à. '.repeat(6);
  assert.deepEqual(titles(await go(col({ regions: [{ lang: 'en', chars: fr.length, sample: fr }] }), { detector: null })), []);
});

test('L3 untagged passages', async () => {
  const d = det({ [GERMAN]: { code: 'de', share: 0.95, reliable: true } });
  const three = col({ blocks: [blk('p.1', GERMAN), blk('p.2', GERMAN), blk('p.3', GERMAN)] });
  const out = await go(three, { detector: d });
  assert.ok(titles(out).includes('medium:3 passages in German have no lang attribute'));
  assert.ok(out.findings[0].detail.includes('p.1'));
  const big = [{ lang: 'en', chars: 5000, sample: EN }];
  assert.ok(titles(await go(col({ regions: big, blocks: [blk('p.1', GERMAN)] }), { detector: d })).includes('low:1 passage in German has no lang attribute'));
  const short = GERMAN.slice(0, 55);
  assert.deepEqual(titles(await go(col({ blocks: [blk('p.1', short)] }), { detector: det({ [short]: { code: 'de', share: 0.95, reliable: true } }) })), []);
});

test('L4 wrong lang attribute; right one is quiet', async () => {
  const d = det({ [SPANISH]: { code: 'es', share: 0.9, reliable: true } });
  assert.ok(titles(await go(col({ blocks: [blk('p.x', SPANISH, 'fr')] }), { detector: d })).includes('medium:lang="fr" is on text that reads as Spanish'));
  const ar = 'نص عربي طويل بما يكفي ليحتسب كفقرة مستقلة في هذه الصفحة التجريبية بكل تأكيد وبلا شك.';
  const d2 = det({ [ar]: { code: 'ar', share: 0.97, reliable: true } });
  assert.deepEqual(titles(await go(col({ blocks: [blk('p.ar', ar, 'ar')] }), { detector: d2 })), []);
});

test('L5 attribute text', async () => {
  const mkAttrs = (n) => Array.from({ length: n }, (_, i) => ({ sel: `img.${i}`, name: 'alt', lang: '', text: `A friendly dog running across a green field number ${i}` }));
  const de = (n) => col({ htmlLang: 'de', blocks: [], regions: [{ lang: 'de', chars: 400, sample: GERMAN.repeat(4) }], attrs: mkAttrs(n) });
  const d = det({ [GERMAN.repeat(4)]: { code: 'de', share: 0.97, reliable: true } });
  const hd = { 'content-type': 'text/html; charset=utf-8' };
  assert.ok(titles(await go(de(4), { detector: d, headers: hd })).includes('medium:4 alt texts are in English on a German page'));
  assert.deepEqual(titles(await go(de(2), { detector: d, headers: hd })), []);
});

test('L6 Content-Language', async () => {
  const h6 = (cl) => ({ 'content-type': 'text/html; charset=utf-8', 'content-language': cl });
  assert.ok(titles(await go(col(), { headers: h6('fr') })).includes('low:Content-Language says "fr" but the page says lang="en"'));
  assert.deepEqual(titles(await go(col(), { headers: h6('fr, en') })), []);
});

test('L7 / L8 encoding', async () => {
  const hdr = (cs) => ({ 'content-type': cs ? `text/html; charset=${cs}` : 'text/html' });
  assert.ok(titles(await go(col(), { headers: hdr('iso-8859-1') })).includes('medium:Character encoding is declared inconsistently'));
  assert.deepEqual(titles(await go(col({ metaCharset: 'UTF-8' }), { headers: hdr('utf8') })), []);
  assert.deepEqual(titles(await go(col({ metaCharset: 'windows-1252', docCharset: 'windows-1252' }), { headers: hdr('iso-8859-1') })), []);
  assert.ok(titles(await go(col({ metaCharset: null }), { headers: hdr(null) })).includes('low:No character encoding is declared'));
  const noDoc = await plugin.run({ log: { entries: [], _harplus: {} } }, mk(col({ metaCharset: null })));
  assert.ok(!titles(noDoc).includes('low:No character encoding is declared'));
});

test('L9 / L10 text integrity', async () => {
  const m = (count) => col({ mojibake: { count, examples: ['cafÃ©'] } });
  assert.ok(titles(await go(m(3))).includes('high:Text shows garbled characters such as "cafÃ©"'));
  assert.deepEqual(titles(await go(m(2))), []);
  assert.ok(titles(await go(col({ replacement: { count: 3, examples: ['a�b'] } }))).includes('medium:3 replacement characters (�) appear in the text'));
  assert.deepEqual(titles(await go(col({ replacement: { count: 2, examples: [] } }))), []);
});

test('L11 formats, L12 images, truncation', async () => {
  const f = (d, t, m) => col({ formats: { dates: { count: d, examples: ['03/04/2025'] }, times: { count: t, examples: [] }, money: { count: m, examples: [] } } });
  assert.ok(titles(await go(f(1, 1, 1))).includes("low:Dates, times or prices are written in one region's format"));
  assert.deepEqual(titles(await go(f(1, 1, 0))), []);
  assert.ok(titles(await go(col({ textImages: [{ sel: 'img.hero', alt: 'one two three four five six' }] }))).includes("info:1 large image may contain text that can't be translated"));
  assert.ok(titles(await go(col({ textImages: [{ sel: 'a', alt: 'x' }, { sel: 'b', alt: 'y' }] }))).includes("info:2 large images may contain text that can't be translated"));
  assert.ok(titles(await go(col({ truncated: true }))).includes('info:Text sampling stopped early'));
});

test('detector failure falls back quietly', async () => {
  for (const detector of [async () => { throw new Error('boom'); }, async () => null, () => { throw new Error('sync'); }]) {
    const out = await go(col(), { detector });
    assert.deepEqual(titles(out), []);
    assert.equal(out.data.method, 'script');
  }
});

test('untrusted text is escaped when rendered', async () => {
  const evil = '<script>x</script>';
  const d = det({ [GERMAN + evil]: { code: 'de', share: 0.95, reliable: true } });
  const out = await go(col({ mojibake: { count: 3, examples: [`cafÃ©${evil}`] }, blocks: [blk('p.1', GERMAN + evil)] }), { detector: d });
  const shown = String(plugin.glance(out, h));
  assert.ok(!shown.includes('<script>'));
  assert.ok(shown.includes('&lt;script&gt;'));
  for (const f of out.findings) {
    const rendered = String(h.html`${f.title}${f.detail || ''}${typeof f.evidence === 'string' ? f.evidence : JSON.stringify(f.evidence)}`);
    assert.ok(!rendered.includes('<script>'));
  }
  assert.ok(out.findings.some((f) => f.title.includes(evil)));
});

test('every finding is international with a method; no bad values', async () => {
  const c = col({ htmlLang: null, mojibake: { count: 3, examples: ['x'] }, replacement: { count: 3, examples: [] }, truncated: true, textImages: [{ sel: 'i', alt: 'a b c d e f' }], metaCharset: null });
  const out = await go(c, { headers: { 'content-type': 'text/html' } });
  assert.ok(out.findings.length >= 5);
  for (const f of out.findings) {
    assert.equal(f.category, 'international');
    assert.ok(['detector', 'script'].includes(f.evidence.method), f.title);
  }
  const s = JSON.stringify(out);
  assert.ok(!/NaN|Infinity|undefined/.test(s));
});

test('performance: 200 blocks, 300 attrs', async () => {
  const blocks = Array.from({ length: 200 }, (_, i) => blk(`p.${i}`, `${EN.slice(0, 80)} ${i}`));
  const attrs = Array.from({ length: 300 }, (_, i) => ({ sel: `a.${i}`, name: 'title', lang: '', text: `Some title words here ${i}` }));
  const t = performance.now();
  await go(col({ blocks, attrs }));
  assert.ok(performance.now() - t < 50);
});
