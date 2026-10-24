import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFormat, hasGarbled, stripGarbled, countMatches, scriptOf, primary, sameLanguage, normCharset, languageName, chromeDetector } from '../extension/core/language.js';

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
  blocks: [{ sel: 'p.a', own: null, lang: 'en', text: 'English paragraph number one that is certainly long enough to count as a block.' }],
  attrs: [],
  formats: { candidates: [] },
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
const blk = (sel, text, own = null, lang = own ?? 'en') => ({ sel, own, lang, text });

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
  const fr = (o) => go(col({ blocks: [] }), { detector: det({ [EN]: { code: 'fr', share: 0.92, reliable: true, ...o } }) });
  assert.ok(titles(await fr()).includes('high:Page says lang="en" but its text is mostly French (92%)'));
  assert.deepEqual(titles(await fr({ share: 0.55 })), []);
  assert.deepEqual(titles(await fr({ reliable: false })), []);
  const short = col({ blocks: [], regions: [{ lang: 'en', chars: 150, sample: 'x'.repeat(150) }] });
  assert.deepEqual(titles(await go(short, { detector: det({ ['x'.repeat(150)]: { code: 'fr', share: 0.9, reliable: true } }) })), []);
  assert.deepEqual(titles(await go(col({ blocks: [], htmlLang: 'en-GB', regions: [{ lang: 'en-GB', chars: EN.length, sample: EN }] }))), []);
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
  const cand = (kind, n, match) => Array.from({ length: n }, () => ({ kind, match, before: ' ', after: ' ' }));
  const f = (d, t, m) => col({ formats: { candidates: [...cand('date', d, '03/04/2025'), ...cand('time', t, '3:00 pm'), ...cand('money', m, '$5')] } });
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
  assert.ok(performance.now() - t < 50); // 50 ms held (2 ms measured)
});

test('und / mul / zxx are never compared', async () => {
  const d = det({ [EN]: { code: 'fr', share: 0.92, reliable: true } });
  // und declares nothing usable (L1 fires) but is never compared (no L2).
  assert.deepEqual(titles(await go(col({ htmlLang: 'und', blocks: [], regions: [{ lang: 'und', chars: EN.length, sample: EN }] }), { detector: d })), ["medium:The page doesn't say which language it is in"]);
  const es = det({ [SPANISH]: { code: 'es', share: 0.9, reliable: true } });
  assert.deepEqual(titles(await go(col({ blocks: [blk('p.z', SPANISH, 'zxx')] }), { detector: es })), []);
  assert.deepEqual(titles(await go(col({ blocks: [blk('p.z', SPANISH, null, 'mul')] }), { detector: es })), []);
  assert.deepEqual(titles(await go(col(), { headers: { 'content-type': 'text/html; charset=utf-8', 'content-language': 'und' } })), []);
});

test('L3 compares against the inherited language; L4 names the most common detection', async () => {
  const d = det({ [GERMAN]: { code: 'de', share: 0.95, reliable: true } });
  assert.deepEqual(titles(await go(col({ blocks: [blk('p.1', GERMAN, null, 'de')] }), { detector: d })), []);
  assert.ok(titles(await go(col({ regions: [{ lang: 'en', chars: 5000, sample: EN }], blocks: [blk('p.1', GERMAN, null, 'en')] }), { detector: d })).some((t) => t.startsWith('low:1 passage in German')));
  const dd = det({ [GERMAN]: { code: 'de', share: 0.95, reliable: true }, [SPANISH]: { code: 'es', share: 0.9, reliable: true } });
  const out = await go(col({ blocks: [blk('a', GERMAN, 'fr'), blk('b', SPANISH, 'fr'), blk('c', SPANISH, 'fr')] }), { detector: dd });
  assert.ok(titles(out).includes('medium:lang="fr" is on text that reads as Spanish'));
});

test('script-fallback mismatch shows in glance and summary', async () => {
  const ru = 'Привет мир это длинный русский текст. '.repeat(10);
  const out = await go(col({ regions: [{ lang: 'en', chars: ru.length, sample: ru }] }), { detector: null });
  assert.equal(out.summary.find((r) => r.label === 'Language').value, 'en · Cyrillic script');
  const g = String(plugin.glance(out, h));
  assert.ok(g.includes('Declared language matches the text'));
  assert.ok(g.includes('Cyrillic script'));
});

test('L9 without examples; zh-Hant vs zh; L5 labels; share-based L3; unreliable block; redirected main document', async () => {
  assert.ok(titles(await go(col({ mojibake: { count: 3, examples: [] } }))).includes('high:Text shows garbled characters such as "…"'));
  const zh = '这是一个足够长的中文段落用来测试语言检测是否能够正确地识别出来。'.repeat(8);
  assert.deepEqual(titles(await go(col({ htmlLang: 'zh', regions: [{ lang: 'zh', chars: zh.length, sample: zh }] }), { detector: det({ [zh]: { code: 'zh-Hant', share: 0.9, reliable: true } }), headers: { 'content-type': 'text/html; charset=utf-8' } })), []);
  const labels = Array.from({ length: 3 }, (_, i) => ({ sel: `input.${i}`, name: 'placeholder', lang: 'de', text: `Please type your full name and address here ${i}` }));
  const f = await go(col({ htmlLang: 'de', blocks: [], regions: [{ lang: 'de', chars: 400, sample: GERMAN.repeat(4) }], attrs: labels }), { detector: det({ [GERMAN.repeat(4)]: { code: 'de', share: 0.97, reliable: true } }), headers: { 'content-type': 'text/html; charset=utf-8' } });
  assert.deepEqual(titles(f), ['medium:3 label texts are in English on a German page']);
  const share = await go(col({ regions: [{ lang: 'en', chars: 500, sample: EN }], blocks: [blk('p.1', GERMAN, null, 'en')] }), { detector: det({ [GERMAN]: { code: 'de', share: 0.95, reliable: true } }) });
  assert.ok(titles(share).includes('medium:1 passage in German has no lang attribute'));
  assert.deepEqual(titles(await go(col({ blocks: [blk('p.1', GERMAN)] }), { detector: det({ [GERMAN]: { code: 'de', share: 0.95, reliable: false } }) })), []);
  const doc = (url, cs) => ({ _resourceType: 'document', request: { url }, response: { status: 200, headers: [{ name: 'content-type', value: `text/html; charset=${cs}` }, { name: 'content-language', value: 'en' }] } });
  const redirected = { log: { entries: [doc('https://s.test/old', 'iso-8859-1'), doc('https://s.test/new', 'utf-8')], _harplus: {} } };
  const ctx = { ...mk(col(), det()), target: { url: 'https://s.test/old', finalUrl: 'https://s.test/new' } };
  assert.deepEqual(titles(await plugin.run(redirected, { ...ctx, target: { url: 'https://s.test/x', finalUrl: 'https://s.test/new' } })), []);
});

test('no undefined / NaN / Infinity anywhere in the output', async () => {
  const bad = [];
  const walk = (v, path) => {
    if (v === undefined || (typeof v === 'number' && !Number.isFinite(v))) bad.push(path);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  const c = col({ htmlLang: null, mojibake: { count: 3, examples: [] }, replacement: { count: 3 }, truncated: true, textImages: [{ sel: 'i', alt: 'a b c d e f' }], metaCharset: null });
  walk(await go(c, { headers: { 'content-type': 'text/html' } }), 'out');
  assert.deepEqual(bad, []);
});

test('classifyFormat is the single date/version rule', () => {
  assert.equal(classifyFormat('date', '03/04/2025', ' ', ' '), true);
  assert.equal(classifyFormat('date', '13/04/2025', ' ', ' '), false);
  assert.equal(classifyFormat('date', '2.10.4', '1.', ''), false);
  assert.equal(classifyFormat('date', '1.2.10', 'v', ''), false);
  assert.equal(classifyFormat('date', '1.2.10', '', '.4'), false);
  assert.equal(classifyFormat('time', '3:00 pm', '', ''), true);
  assert.equal(classifyFormat('money', '$5', '', ''), true);
});

test('run() classifies raw candidates; non-dates and versions are dropped', async () => {
  const c = [
    { kind: 'date', match: '03/04/2025', before: ' ', after: ' ' },
    { kind: 'date', match: '13/04/2025', before: ' ', after: ' ' },
    { kind: 'date', match: '1.2.10', before: 'v', after: '' },
    { kind: 'time', match: '3:00 pm', before: '', after: '' },
    { kind: 'money', match: '$5', before: '', after: '' },
  ];
  const out = await go(col({ formats: { candidates: c } }));
  assert.equal(out.data.counts.dates, 1);
  assert.equal(out.data.counts.times, 1);
  assert.equal(out.data.counts.money, 1);
});

test('garbled helpers', () => {
  assert.equal(hasGarbled('un cafÃ© con leche'), true);
  assert.equal(hasGarbled('a\uFFFDb'), true);
  assert.equal(hasGarbled('un café con leche'), false);
  assert.ok(!hasGarbled(stripGarbled('un cafÃ© con leche y a\uFFFDb')));
});

test('blocks and region samples with mojibake never reach the detector', async () => {
  const garbled = 'Nuestro cafÃ© con leche, otro cafÃ© con leche y un tercer cafÃ© con leche para todos hoy.';
  const seen = [];
  const d = async (text) => { seen.push(text); return { code: /^The quick/.test(text) ? 'en' : 'it', share: 0.95, reliable: true }; };
  const out = await go(col({ blocks: [blk('p.g', garbled)], regions: [{ lang: 'en', chars: EN.length, sample: `${EN} ${garbled}` }] }), { detector: d });
  assert.ok(!seen.some((t) => /Ã/.test(t)), JSON.stringify(seen));
  assert.ok(!titles(out).some((t) => /Italian/.test(t)), JSON.stringify(titles(out)));
});

test('detectedBlocks and detectedCodes are exposed', async () => {
  const d = det({ [GERMAN]: { code: 'de', share: 0.95, reliable: true } });
  const out = await go(col({ blocks: [blk('p.1', GERMAN)] }), { detector: d });
  assert.equal(out.data.detectedBlocks, 1);
  assert.equal(out.data.detectedCodes.de, 1);
});

test('glance: undetermined language match is neutral, not hidden', async () => {
  const d = det({ [EN]: { code: 'en', share: 0.4, reliable: true } });
  const out = await go(col({ blocks: [] }), { detector: d });
  const g = String(plugin.glance(out, h));
  assert.ok(g.includes('Declared language matches the text'));
  assert.ok(g.includes('couldn&#39;t determine') || g.includes("couldn't determine") || g.includes('couldn&#x27;t determine'), g);
  assert.ok(g.includes('title="unknown"') || g.includes('unknown'), g);
});

test('Â + no-break space in a block is garbled (and is not detected)', async () => {
  const text = 'Nuestro precio es 5\u00c2\u00a0euros por persona, con desayuno incluido todos los dias de la semana.';
  assert.equal(hasGarbled(text), true);
  const seen = [];
  const d = async (t) => { seen.push(t); return { code: 'it', share: 0.95, reliable: true }; };
  await go(col({ blocks: [blk('p.n', text)] }), { detector: d });
  assert.ok(!seen.includes(text));
});

// ---------------------------------------------------------------- final fix wave
const HEBREW = 'ברוכים הבאים לחנות שלנו. אנו מציעים משלוח חינם על כל ההזמנות בעיר. גלו את ציוד הקמפינג והטיולים שלנו.';
const NORSK = 'Dette er et norsk avsnitt som er langt nok til å telle som en egen blokk på siden, uten tvil.';
const UTF8 = { 'content-type': 'text/html; charset=utf-8' };

test('language aliases canonicalise in one place', () => {
  assert.ok(sameLanguage('he', 'iw'));
  assert.ok(sameLanguage('nb', 'no'));
  assert.ok(sameLanguage('nn', 'no'));
  assert.ok(sameLanguage('tl', 'fil'));
  assert.ok(sameLanguage('hr', 'sr'));
  assert.ok(sameLanguage('bs', 'sh'));
  assert.ok(!sameLanguage('hr', 'sl'));
  assert.equal(primary('iw'), 'he');
  assert.equal(primary('in-ID'), 'id');
  assert.equal(languageName(primary('iw')), 'Hebrew');
  assert.equal(languageName(primary('nb')), 'Norwegian');
});

test('detector returning iw / no / fil on matching lang attributes is quiet (L2, L3, L4)', async () => {
  const cases = [['he', 'iw', HEBREW], ['nb', 'no', NORSK], ['no', 'no', NORSK], ['fil', 'tl', NORSK]];
  for (const [declared, code, text] of cases) {
    const d = async () => ({ code: primary(code), share: 0.95, reliable: true });
    const out = await go(col({
      htmlLang: declared,
      regions: [{ lang: declared, chars: 400, sample: text.repeat(4) }],
      blocks: [blk('p.a', text, null, declared), blk('p.b', text, declared, declared)],
    }), { detector: d, headers: UTF8 });
    assert.deepEqual(titles(out), [], declared);
  }
  const hr = async () => ({ code: 'sr', share: 0.9, reliable: true });
  assert.deepEqual(titles(await go(col({ htmlLang: 'hr', regions: [{ lang: 'hr', chars: 400, sample: NORSK.repeat(4) }], blocks: [] }), { detector: hr, headers: UTF8 })), []);
});

test('normCharset: WHATWG labels collapse to one name', () => {
  const groups = [
    ['utf-8', 'utf8', 'unicode-1-1-utf-8', 'UTF-8'],
    ['gbk', 'gb2312', 'gb_2312-80', 'chinese', 'csgb2312', 'x-gbk', 'gbk'],
    ['euc-kr', 'ks_c_5601-1987', 'korean', 'windows-949', 'euc-kr'],
    ['shift_jis', 'shift_jis', 'sjis', 'x-sjis', 'ms_kanji', 'windows-31j', 'csshiftjis'],
    ['euc-jp', 'x-euc-jp', 'euc-jp'],
    ['big5', 'big5-hkscs', 'cn-big5', 'x-x-big5', 'big5'],
    ['windows-1254', 'iso-8859-9', 'latin5', 'windows-1254'],
    ['windows-874', 'tis-620', 'iso-8859-11', 'windows-874'],
    ['windows-1252', 'iso-8859-1', 'latin1', 'us-ascii', 'windows-1252'],
  ];
  for (const [canon, ...labels] of groups) for (const l of labels) assert.equal(normCharset(l), canon, l);
  assert.notEqual(normCharset('big5'), normCharset('gbk'));
});

test('L2 sample is built from the declared-language blocks first', async () => {
  const FR = 'Ceci est un long paragraphe en français qui compte bien plus de soixante caractères au total.';
  const nav = 'Home About Contact Shop Help Login Search Cart Account Orders Returns Stores Careers Press';
  const det2 = async (t) => (/français/.test(t) ? { code: 'fr', share: 0.95, reliable: true } : { code: 'en', share: 0.95, reliable: true });
  const frBlocks = Array.from({ length: 4 }, (_, i) => blk(`p.${i}`, FR, null, 'fr'));
  const regionsEn = [{ lang: 'fr', chars: 3000, sample: nav.repeat(3) }, { lang: 'en', chars: 4000, sample: EN }];
  assert.deepEqual(titles(await go(col({ htmlLang: 'fr', regions: regionsEn, blocks: frBlocks }), { detector: det2, headers: UTF8 })), []);
  const revSample = `${nav.repeat(3)} ${FR} ${FR} ${FR} ${FR}`;
  const rev = await go(col({ htmlLang: 'en', regions: [{ lang: 'en', chars: revSample.length, sample: revSample }], blocks: frBlocks.map((b) => ({ ...b, lang: 'en' })) }), { detector: det2, headers: UTF8 });
  assert.ok(titles(rev).includes('high:Page says lang="en" but its text is mostly French (95%)'), JSON.stringify(titles(rev)));
  // (b) the French passages are most of the block text: the page is mislabelled, L2 fires, L3 stays quiet.
  assert.deepEqual(titles(rev), ['high:Page says lang="en" but its text is mostly French (95%)']);
});

test('one passage in another language is an L3 finding, not an L2 mismatch', async () => {
  const ui = 'Home Shop Cart Account Orders Returns Stores Careers Press Help Contact About Search Login Wishlist Gift cards Deals Sale New Brands. ';
  const de = `${GERMAN} ${GERMAN}`;
  const sample = `${ui.repeat(2)}${de} ${ui}`;
  const d = async (t) => ({ code: t.includes('deutscher') ? 'de' : 'en', share: 0.97, reliable: true });
  const out = await go(col({
    regions: [{ lang: 'en', chars: sample.length, sample }],
    blocks: [blk('p.de', de), blk('p.en', 'A short English intro paragraph that is just long enough to count as a block here.')],
  }), { detector: d, headers: UTF8 });
  assert.equal(titles(out).length, 1, JSON.stringify(titles(out)));
  assert.match(titles(out)[0], /^(low|medium):1 passage in German has no lang attribute$/);
  assert.ok(!titles(out).some((t) => t.startsWith('high:Page says')));
  // The German block is part of the sample only when it is the page: not here.
  assert.equal(out.data.detected?.code, 'en');
});

test('no visible text skips the check', async () => {
  await assert.rejects(go(col({ regions: [] })), /No visible text to check/);
  await assert.rejects(go(col({ regions: [{ lang: 'en', chars: 0, sample: '' }] })), /No visible text to check/);
});

test('glance: undetected blocks / attrs are neutral, not green', async () => {
  const weak = async () => ({ code: 'de', share: 0.3, reliable: true });
  const labels = Array.from({ length: 3 }, (_, i) => ({ sel: `i.${i}`, name: 'title', lang: '', text: `Some words to read here ${i}` }));
  const out = await go(col({ blocks: [blk('p.1', GERMAN)], attrs: labels }), { detector: weak });
  assert.equal(out.data.detectedBlocks, 0);
  const g = String(plugin.glance(out, h));
  const row = (label) => { const i = g.indexOf(label); return g.slice(i, g.indexOf('</li>', i)); };
  assert.ok(/couldn(&#39;|&#x27;|')t determine/.test(row('No untagged passages')), row('No untagged passages'));
  assert.ok(/couldn(&#39;|&#x27;|')t determine/.test(row('Labels and alt text')), row('Labels and alt text'));
});

test('mojibake: Ã followed by windows-1252 punctuation letters counts', () => {
  assert.equal(countMatches('StraÃŸe und Ãœber alles', 'mojibake').count, 2);
  assert.ok(hasGarbled('Ãœber'));
  assert.ok(!hasGarbled('Ãn'));
});

test('L3 is suppressed for a block inside an element already reported by L4', async () => {
  const d = det({ [SPANISH]: { code: 'es', share: 0.9, reliable: true } });
  const out = await go(col({ blocks: [blk('div.fr', SPANISH, 'fr'), blk('p.inner', SPANISH, null, 'fr')] }), { detector: d });
  assert.deepEqual(titles(out), ['medium:lang="fr" is on text that reads as Spanish']);
  const other = await go(col({ blocks: [blk('div.fr', SPANISH, 'fr'), blk('p.in', GERMAN, null, 'fr')] }), { detector: det({ [SPANISH]: { code: 'es', share: 0.9, reliable: true }, [GERMAN]: { code: 'de', share: 0.9, reliable: true } }) });
  assert.ok(titles(other).some((t) => /passage in German/.test(t)), JSON.stringify(titles(other)));
});

test('L4 groups lang values case-insensitively', async () => {
  const d = det({ [SPANISH]: { code: 'es', share: 0.9, reliable: true } });
  const out = await go(col({ blocks: [blk('a', SPANISH, 'DE'), blk('b', SPANISH, 'de')] }), { detector: d });
  assert.equal(titles(out).filter((t) => /is on text that reads as/.test(t)).length, 1, JSON.stringify(titles(out)));
});

test('html lang und / mul / zxx declares nothing usable: L1 fires', async () => {
  for (const l of ['und', 'mul', 'zxx']) {
    assert.ok(titles(await go(col({ htmlLang: l }))).includes("medium:The page doesn't say which language it is in"), l);
  }
});
