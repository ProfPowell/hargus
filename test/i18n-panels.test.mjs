import { test } from 'node:test';
import assert from 'node:assert/strict';
import international from '../extension/plugins/international.js';
import language from '../extension/plugins/language.js';
import carbon from '../extension/plugins/carbon.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';
import { h } from '../extension/ui/render.js';
import {
  LANGUAGE, CARBON, INTERNATIONAL, ODD_SEL, LONG_SEL, GERMAN, SPANISH, col, doc, lctx, blk, deDet, views, ictx, base, runCase,
} from './fixtures/i18n-cases.mjs';
import BASELINE from './fixtures/i18n-findings-baseline.json' with { type: 'json' };

const PLUGINS = { language: [language, LANGUAGE], carbon: [carbon, CARBON], international: [international, INTERNATIONAL] };
const draw = (plugin, out) => String(plugin.render({ status: 'ok', ...out }, h));
const heads = (out) => out.summary.filter((x) => x.headline).map((x) => `${x.label} ${x.value}`);
const find = (out, re) => out.findings.find((f) => re.test(f.title));

/** Pass one plugin result through normalize(), as a real run does. */
async function normalized(out) {
  const reading = createReading({ entries: [], target: makeTarget('https://www.example.com/', 'E', 'https://www.example.com/') });
  await runPlugins(reading, [{ id: 'n', name: 'N', phase: 'analyze', run: async () => out }], {});
  return reading.log._harplus.plugins.n;
}

test('findings: every field but places is unchanged from before places (score-check replays neither language nor carbon)', async () => {
  for (const [id, [plugin, cases]] of Object.entries(PLUGINS)) {
    for (const [name, make] of Object.entries(cases)) {
      const out = await runCase(plugin, make);
      assert.deepEqual(JSON.parse(JSON.stringify(out.findings.map(({ places, ...f }) => f))), BASELINE[id][name], `${id}: ${name}`);
    }
  }
});

test('which findings carry places: elements, quotes, hosts and alternates; never page-wide findings', async () => {
  const WITH = /passages? in|is on text that reads as|alt texts are in|label texts are in|garbled characters|replacement characters|one region's format|large images? may contain|isn't on green hosting|Right-to-left layout scrolls|hreflang problems/;
  for (const [id, [plugin, cases]] of Object.entries(PLUGINS)) {
    for (const [name, make] of Object.entries(cases)) {
      const r = await normalized(await runCase(plugin, make));
      for (const f of r.findings) {
        // Exceptions with no location to give: no example quotes, or no culprit element.
        const none = (name === 'garbled without examples') || (name === 'rtl no culprit');
        assert.equal(!!f.places, WITH.test(f.title) && !none, `${id}: ${name}: ${f.title}`);
        if (f.places) assert.ok(f.places.length <= 200);
      }
    }
  }
});

/* ---------------------------------------------------------------- language */

test('language: untagged passages are places (selector + quote); evidence keeps its first 5 selectors', async () => {
  const r = await normalized(await runCase(language, LANGUAGE['untagged passages']));
  const f = find(r, /passages in German/);
  assert.equal(f.places.length, 7);
  assert.deepEqual(f.places[0], { selector: 'p.1', text: GERMAN });
  assert.deepEqual(f.evidence, { selectors: ['p.1', 'p.2', 'p.3', ODD_SEL, LONG_SEL], method: 'detector' });
  // Odd values: markup in a selector is kept as given and escaped when drawn; a ~700-character selector is cut to 500.
  assert.equal(f.places[3].selector, ODD_SEL);
  assert.equal(f.places[4].selector.length, 500);
  const drawn = String(h.places(f.places));
  assert.ok(!drawn.includes('<b>') && drawn.includes('p.&lt;b&gt;&amp;&quot;x&quot;'));
});

test('language: places cover every passage up to 200 while the title keeps the true count', async () => {
  const blocks = Array.from({ length: 230 }, (_, i) => blk(`p.n${i}`, GERMAN));
  const out = await language.run(doc(), lctx(col({ regions: [{ lang: 'en', chars: 50000, sample: 'x' }], blocks }), deDet));
  const f = find(out, /passages in German/);
  assert.match(f.title, /^230 passages/);
  assert.equal(f.places.length, 200);
  assert.equal(f.evidence.selectors.length, 5);
  const long = await language.run(doc(), lctx(col({ blocks: [blk('p.q', `${GERMAN} ${'Wort '.repeat(80)}`)] }), det2(`${GERMAN} ${'Wort '.repeat(80)}`, 'de')));
  assert.ok(find(long, /passage in German/).places[0].text.endsWith('…'), 'long passages are quoted short');
});
const det2 = (text, code) => async (t) => (t === text ? { code, share: 0.95, reliable: true } : { code: 'en', share: 0.98, reliable: true });

test('language: a wrong lang attribute names each element with what it reads as', async () => {
  const r = await normalized(await runCase(language, LANGUAGE['wrong lang']));
  const f = find(r, /reads as Spanish/);
  assert.deepEqual(f.places.map((p) => [p.selector, p.note]), [['p.x', 'reads as Spanish'], ['p.y', 'reads as Spanish'], ['p.z', 'reads as German']]);
  // Odd value: a selector that isn't a string (a broken collector) is dropped, the quote still places it.
  const odd = await language.run(doc(), lctx(col({ blocks: [blk(null, SPANISH, 'fr'), blk('p.<i>', `<script>${SPANISH}`, 'fr')] }), det2(`<script>${SPANISH}`, 'es')));
  const g = await normalized(odd);
  const places = find(g, /reads as/).places;
  assert.ok(places.every((p) => p.text));
  assert.ok(!String(h.places(places)).includes('<script>'));
});

test('language: alt and label texts are places with the attribute named', async () => {
  const alt = find(await normalized(await runCase(language, LANGUAGE['alt texts'])), /alt texts/);
  assert.equal(alt.places.length, 7);
  assert.deepEqual(alt.places[0], { selector: 'img.0', text: 'A friendly dog running across a green field number 0', note: 'alt attribute' });
  const labels = find(await normalized(await runCase(language, LANGUAGE.labels)), /label texts/);
  assert.deepEqual(labels.places.map((p) => p.note), ['title attribute', 'title attribute', 'title attribute', 'aria-label attribute', 'aria-label attribute']);
  // Odd value: markup in alt text is escaped when drawn.
  const attrs = Array.from({ length: 3 }, (_, i) => ({ sel: `img[alt="<b>${i}"]`, name: 'alt', lang: '', text: `A friendly <b>dog</b> & "cat" running across a field ${i}` }));
  const out = await language.run(doc({ 'content-type': 'text/html; charset=utf-8' }), lctx(col({ htmlLang: 'de', blocks: [], regions: [{ lang: 'de', chars: 400, sample: GERMAN.repeat(4) }], attrs }), deDet));
  const drawn = String(h.places(find(out, /alt texts/).places));
  assert.ok(!drawn.includes('<b>'));
  assert.match(drawn, /&lt;b&gt;dog&lt;\/b&gt; &amp; &quot;cat&quot;/);
});

test('language: garbled and replacement characters are quoted places; no examples, no places', async () => {
  const r = await normalized(await runCase(language, LANGUAGE.garbled));
  assert.deepEqual(find(r, /garbled/).places, [{ text: 'cafÃ© here' }, { text: 'itâ€™s fine' }, { text: 'Â x' }, { text: '<b>Ã©</b>' }]);
  assert.deepEqual(find(r, /replacement/).places, [{ text: 'a�b' }, { text: 'c�d' }]);
  assert.ok(!String(h.places(find(r, /garbled/).places)).includes('<b>'), 'markup in an example is escaped');
  const none = await normalized(await runCase(language, LANGUAGE['garbled without examples']));
  assert.ok(none.findings.every((f) => !f.places));
  // Odd values: blank and non-string examples are skipped or stringified.
  const odd = await language.run(doc(), lctx(col({ mojibake: { count: 3, examples: ['', '  ', 42, null] } })));
  assert.deepEqual(find(odd, /garbled/).places, [{ text: '42' }]);
});

test('language: format examples are quoted places with their kind', async () => {
  const f = find(await normalized(await runCase(language, LANGUAGE.formats)), /one region's format/);
  assert.equal(f.places.length, 4 + 2 + 10, 'examples stop at 10 per kind');
  assert.deepEqual(f.places[0], { text: '03/04/2025', note: 'date' });
  assert.deepEqual(f.places.at(-1).note, 'price');
  assert.match(f.detail, /^dates: 4 \(03\/04\/2025, 03\/04\/2025 1, 03\/04\/2025 2\)/);
  // Odd value: a match carrying markup.
  const odd = await language.run(doc(), lctx(col({ formats: { candidates: [{ kind: 'money', match: '$5<b>', before: ' ', after: ' ' }, { kind: 'money', match: '€5', before: ' ', after: ' ' }, { kind: 'money', match: '£5', before: ' ', after: ' ' }] } })));
  const p = find(odd, /one region's format/).places;
  assert.deepEqual(p[0], { text: '$5<b>', note: 'price' });
  assert.ok(!String(h.places(p)).includes('<b>'));
});

test('language: text images are places with their alt text', async () => {
  const r = await normalized(await runCase(language, LANGUAGE['text images and truncated']));
  const f = find(r, /large images/);
  assert.deepEqual(f.places[0], { selector: 'img.hero', text: 'one two three four five six', note: 'alt text' });
  assert.equal(f.places[1].selector, ODD_SEL);
  const drawn = String(h.places(f.places));
  assert.ok(!drawn.includes('<b>50%</b>'));
  assert.equal(find(r, /sampling stopped/).places, undefined);
});

test('language: render opens with stats, then passages by language and the declarations; headline reads alone', async () => {
  const out = await runCase(language, LANGUAGE['untagged passages']);
  const html = draw(language, out);
  assert.ok(html.trimStart().startsWith('<div class="stats">'));
  assert.match(html, /Declared<\/span><div class="stat-value">en/);
  assert.match(html, /Detected<\/span><div class="stat-value">English 98%/);
  assert.match(html, /Chrome&#39;s language detector/);
  assert.match(html, /Passages judged<\/span><div class="stat-value">7 of 7/);
  assert.match(html, /<td>German \(de\)<\/td><td>7<\/td>/);
  assert.match(html, /Content-Type charset<\/dt><dd>utf-8/);
  assert.deepEqual(heads(out), ['Language en · English 98%']);
  const script = await runCase(language, LANGUAGE['mismatch (script)']);
  assert.match(draw(language, script), /Cyrillic script[\s\S]*writing-system check/);
  assert.deepEqual(heads(script), ['Language en · Cyrillic script']);
  const none = await runCase(language, LANGUAGE['no document']);
  assert.match(draw(language, none), /Encoding<\/span><div class="stat-value">UTF-8/);
  assert.ok(draw(language, { data: {} }).includes('Declared'), 'an empty data object still renders');
});

/* ---------------------------------------------------------------- carbon */

test('carbon: the main host is a place, as a URL when it is a hostname and as text otherwise', async () => {
  const r = await normalized(await runCase(carbon, CARBON['grey main, rating C']));
  assert.deepEqual(find(r, /green hosting/).places, [{ url: 'https://s.test/' }]);
  assert.equal(find(r, /Carbon rating/).places, undefined, 'the rating is page-wide');
  const odd = await normalized(await runCase(carbon, CARBON['odd main host']));
  assert.deepEqual(find(odd, /green hosting/).places, [{ text: 'weird_host' }]);
});

test('carbon: render opens with stats, folds the host table and keeps grams and rating data', async () => {
  const out = await runCase(carbon, CARBON['heavy, rating F']);
  assert.ok(Number.isFinite(out.data.grams) && out.data.rating === 'F', 'score.js reads data.grams and data.rating');
  const html = draw(carbon, out);
  assert.ok(html.trimStart().startsWith('<div class="stats">'));
  assert.match(html, /Hosts<\/span><div class="stat-value">13/);
  assert.match(html, /Green hosts<\/span><div class="stat-value">0 of 1/);
  assert.match(html, /1 of 13 checked/);
  assert.match(html, /<details class="disclosure fold"><summary>5 more<\/summary>/);
  assert.ok(html.indexOf('class="stats"') < html.indexOf('SWDM v4'));
  const off = draw(carbon, await runCase(carbon, CARBON['no green check']));
  assert.match(off, /Green hosts<\/span><div class="stat-value">not checked/);
  assert.deepEqual(heads(out).map((x) => x.split(' ')[0]), ['CO₂', 'Green']);
});

/* ---------------------------------------------------------------- international */

test('international: the right-to-left culprit is a place; no culprit, no place', async () => {
  const off = await normalized(await runCase(international, INTERNATIONAL['rtl offscreen']));
  assert.deepEqual(off.findings[0].places, [{ selector: 'div.drawer', note: '30 px off-screen' }]);
  const wide = await normalized(await runCase(international, INTERNATIONAL['rtl wide']));
  assert.deepEqual(wide.findings[0].places, [{ selector: ODD_SEL, note: '1400 px wide' }]);
  assert.ok(!String(h.places(wide.findings[0].places)).includes('<b>'), 'odd selector escaped');
  const none = await normalized(await runCase(international, INTERNATIONAL['rtl no culprit']));
  assert.equal(none.findings[0].places, undefined);
});

test('international: each alternate with an invalid hreflang code is a place; non-http hrefs stay text', async () => {
  const r = await normalized(await runCase(international, INTERNATIONAL.hreflang));
  const f = find(r, /hreflang problems/);
  assert.deepEqual(f.places, [
    { url: 'https://s.test/us/', note: 'hreflang="en_US"' },
    { text: 'javascript:alert(1)', note: 'hreflang="de-XX-bad!"' },
    { url: 'https://s.test/?q=<b>&r="1"', note: 'hreflang="<b>"' },
  ]);
  const drawn = String(h.places(f.places, { interactive: true }));
  assert.ok(!drawn.includes('<b>') && !/href="javascript/i.test(drawn));
  // Only "no hreflang entry points at this page" (no invalid code): an absence has no place.
  const quiet = international.run(views({}), ictx({ meta: { lang: 'en', canonical: 'https://s.test/', hreflang: [{ hreflang: 'fr', href: 'https://s.test/fr/' }] } }));
  assert.equal(find(quiet, /hreflang problems/).places, undefined);
});

test('international: render opens with stats, then translated views and hreflang alternates as links', async () => {
  const r = views({ desktop: base, pseudo: { ...base, clipped: 2 }, 'translated-de': { ...base, overflowX: 40, scrollsX: true } });
  r.log._harplus.capture.translation = { 'translated-de': { status: 'ok' }, 'translated-ar': { status: 'failed', reason: 'no <b>model</b>' }, 'translated-ja': { status: 'skipped', reason: 'page is already in Japanese' } };
  const out = international.run(r, ictx({ meta: { lang: 'en', dir: 'ltr', canonical: 'https://s.test/', hreflang: [{ hreflang: 'en', href: 'https://s.test/' }, { hreflang: 'x-default', href: 'https://s.test/' }, { hreflang: 'de_DE', href: 'javascript:alert(1)' }] } }));
  const html = draw(international, out);
  assert.ok(html.trimStart().startsWith('<div class="stats">'));
  assert.match(html, /Longer text<\/span><div class="stat-value">1 more clipped/);
  assert.match(html, /Translated views<\/span><div class="stat-value">1 of 3 ran/);
  assert.match(html, /Page language<\/span><div class="stat-value">en<\/div><span class="stat-note">dir=&quot;ltr&quot;/);
  assert.match(html, /<td>German<\/td><td>ran<\/td><td>40 px<\/td>/);
  assert.match(html, /<td>Arabic<\/td><td>could not run — no &lt;b&gt;model&lt;\/b&gt;<\/td>/);
  assert.match(html, /<td>Japanese<\/td><td>skipped — page is already in Japanese<\/td>/);
  assert.match(html, /<a href="https:\/\/s\.test\/"[^>]*><span class="url"/);
  assert.match(html, /<td>x-default<\/td>[\s\S]*?<td>default<\/td>/);
  assert.match(html, /<td>javascript:alert\(1\)<\/td><td>invalid code<\/td>/);
  assert.ok(!/href="javascript/i.test(html));
  assert.deepEqual(heads(out), ['Long text 1 clipped']);
});

test('international: without the long-text view the first summary row is the headline', () => {
  const rtl = international.run(views({ desktop: base, rtl: { ...base } }), ictx({ meta: { lang: 'en', hreflang: [] } }));
  assert.deepEqual(heads(rtl), ['Right-to-left fits']);
  const metaOnly = international.run(views({}), ictx({ meta: { lang: 'en', hreflang: [] } }));
  assert.deepEqual(heads(metaOnly), ['Language en · ltr · 0 hreflang']);
  assert.ok(draw(international, metaOnly).trimStart().startsWith('<div class="stats">'));
});
