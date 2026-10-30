// Representative inputs for the International and Sustainability plugins (international, language, carbon), shared by
// test/i18n-panels.test.mjs and i18n-findings-baseline.json, which was taken from the plugins before places were added.
// score-check cannot replay language (it saves analysis, not the collected input) or carbon (enrich, needs the
// network), so this is what proves every finding field but `places` is unchanged. international is replayed by
// score-check too; its cases here cover the findings the calibration readings never raise.

import * as util from '../../extension/core/har-util.js';

const skip = (m) => { throw new Error(`skip: ${m}`); };

/* ---------------------------------------------------------------- language */

export const EN = 'The quick brown fox jumps over the lazy dog while the sun sets over the quiet hills and the farmers walk home. '.repeat(4);
export const GERMAN = 'Das ist ein deutscher Absatz, der lang genug ist, um als eigener Abschnitt gezählt zu werden, ganz sicher.';
export const SPANISH = 'Este es un párrafo en español que es lo bastante largo como para contarse como un bloque propio, sin duda.';
export const ODD_SEL = 'p.<b>&"x"';
export const LONG_SEL = `div.${'a'.repeat(700)}`;

export const col = (over = {}) => ({
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
export const det = (map = {}) => async (text) => (text in map ? map[text] : { code: 'en', share: 0.98, reliable: true });
export const doc = (headers = { 'content-type': 'text/html; charset=utf-8', 'content-language': 'en' }) => ({
  log: { entries: [{ _resourceType: 'document', request: { url: 'https://s.test/' }, response: { status: 200, headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } }], _harplus: {} },
});
export const lctx = (collected, detectLanguage = det()) => ({ collected, detectLanguage, target: { url: 'https://s.test/', finalUrl: 'https://s.test/' }, skip });
export const blk = (sel, text, own = null, lang = own ?? 'en') => ({ sel, own, lang, text });
const cand = (kind, n, match) => Array.from({ length: n }, (_, i) => ({ kind, match: `${match}${i ? ` ${i}` : ''}`.trim(), before: ' ', after: ' ' }));
const alts = (n, lang = '', name = 'alt', sel = (i) => `img.${i}`) => Array.from({ length: n }, (_, i) => ({ sel: sel(i), name, lang, text: `A friendly dog running across a green field number ${i}` }));
export const deDet = det({ [GERMAN]: { code: 'de', share: 0.95, reliable: true }, [GERMAN.repeat(4)]: { code: 'de', share: 0.97, reliable: true }, [SPANISH]: { code: 'es', share: 0.9, reliable: true } });

/** name → () => [reading, ctx] for language.run */
export const LANGUAGE = {
  clean: () => [doc(), lctx(col())],
  'no lang': () => [doc(), lctx(col({ htmlLang: null }))],
  'mismatch (detector)': () => [doc(), lctx(col({ blocks: [] }), det({ [EN]: { code: 'fr', share: 0.92, reliable: true } }))],
  'mismatch (script)': () => {
    const ru = 'Привет мир это длинный русский текст. '.repeat(10);
    return [doc(), lctx(col({ regions: [{ lang: 'en', chars: ru.length, sample: ru }] }), null)];
  },
  'untagged passages': () => [doc(), lctx(col({ blocks: [blk('p.1', GERMAN), blk('p.2', GERMAN), blk('p.3', GERMAN), blk(ODD_SEL, GERMAN), blk(LONG_SEL, GERMAN), blk('p.6', GERMAN), blk('p.7', GERMAN)] }), deDet)],
  'one untagged passage': () => [doc(), lctx(col({ regions: [{ lang: 'en', chars: 5000, sample: EN }], blocks: [blk('p.1', GERMAN)] }), deDet)],
  'wrong lang': () => [doc(), lctx(col({ blocks: [blk('p.x', SPANISH, 'fr'), blk('p.y', SPANISH, 'FR'), blk('p.z', GERMAN, 'fr')] }), deDet)],
  'alt texts': () => [doc({ 'content-type': 'text/html; charset=utf-8' }), lctx(col({ htmlLang: 'de', blocks: [], regions: [{ lang: 'de', chars: 400, sample: GERMAN.repeat(4) }], attrs: alts(7) }), deDet)],
  'labels': () => [doc({ 'content-type': 'text/html; charset=utf-8' }), lctx(col({ htmlLang: 'de', blocks: [], regions: [{ lang: 'de', chars: 400, sample: GERMAN.repeat(4) }], attrs: [...alts(3, '', 'title', (i) => `a.t${i}`), ...alts(2, '', 'aria-label', (i) => `button.b${i}`)] }), deDet)],
  'content-language': () => [doc({ 'content-type': 'text/html; charset=utf-8', 'content-language': 'fr' }), lctx(col())],
  'inconsistent encoding': () => [doc({ 'content-type': 'text/html; charset=iso-8859-1' }), lctx(col())],
  'undeclared encoding': () => [doc({ 'content-type': 'text/html' }), lctx(col({ metaCharset: null }))],
  'garbled': () => [doc(), lctx(col({ mojibake: { count: 4, examples: ['cafÃ© here', 'itâ€™s fine', 'Â x', '<b>Ã©</b>'] }, replacement: { count: 3, examples: ['a�b', 'c�d'] } }))],
  'garbled without examples': () => [doc(), lctx(col({ mojibake: { count: 3, examples: [] }, replacement: { count: 5 } }))],
  'formats': () => [doc(), lctx(col({ formats: { candidates: [...cand('date', 4, '03/04/2025'), ...cand('time', 2, '3:00 pm'), ...cand('money', 12, '$5')] } }))],
  'text images and truncated': () => [doc(), lctx(col({ textImages: [{ sel: 'img.hero', alt: 'one two three four five six' }, { sel: ODD_SEL, alt: 'Sale <b>50%</b> off "today" & tomorrow only' }], truncated: true }))],
  'no document': () => [{ log: { entries: [], _harplus: {} } }, lctx(col({ metaCharset: null }))],
};

/* ---------------------------------------------------------------- carbon */

const entry = (url, bytes) => ({
  request: { url, method: 'GET', headers: [] },
  response: { status: 200, headers: [], bodySize: bytes, headersSize: 0, _transferSize: bytes, content: { size: bytes } },
  timings: {}, time: 1, startedDateTime: new Date(0).toISOString(),
});
const har = (entries) => ({ log: { entries, _harplus: {} } });
const cctx = (answers, host = 's.test', options = {}) => ({
  util, target: { host }, options: { greenCheck: true, ...options }, skip,
  fetchJSON: async (url) => {
    const h = decodeURIComponent(url.split('/').pop());
    if (!(h in answers)) throw new Error('HTTP 503');
    return answers[h];
  },
});

/** name → () => [reading, ctx] for carbon.run */
export const CARBON = {
  'green and light': () => [har([entry('https://s.test/', 2e5)]), cctx({ 's.test': { green: true, hosted_by: 'Green Co' } })],
  'grey main, rating C': () => [har([entry('https://s.test/', 1.1e6), entry('https://cdn.other/x.js', 1e5)]), cctx({ 's.test': { green: false }, 'cdn.other': { green: true } })],
  'heavy, rating F': () => [har([entry('https://s.test/', 3e6), ...Array.from({ length: 12 }, (_, i) => entry(`https://h${i}.cdn.test/a.js`, 1e5))]), cctx({ 's.test': { green: false } })],
  'lookups fail': () => [har([entry('https://s.test/', 8e5)]), cctx({})],
  'no green check': () => [har([entry('https://s.test/', 8e5)]), cctx({}, 's.test', { greenCheck: false })],
  // A host that is not a hostname (URL parsing never gives one; a custom hostOf stands in): it must stay text.
  'odd main host': () => {
    const ctx = cctx({ weird_host: { green: false } }, 'weird_host', { endpoint: 'https://green.test/' });
    ctx.util = { ...util, hostOf: () => 'weird_host' };
    return [har([entry('https://s.test/', 1e5)]), ctx];
  },
};

/* ---------------------------------------------------------------- international */

export const views = (v, extra = {}) => ({ log: { entries: [], _harplus: { capture: { device: 'desktop', views: v, ...extra } } } });
export const ictx = ({ props, meta } = {}) => ({
  results: {
    ...(props ? { css: { status: 'ok', data: { usage: { properties: props } } } } : {}),
    ...(meta ? { meta: { status: 'ok', data: meta } } : {}),
  },
  target: { finalUrl: 'https://s.test/' },
  skip,
});
export const base = { overflowX: 0, clipped: 1, rtlUnmarked: 0, dir: 'ltr' };

/** name → () => [reading, ctx] for international.run */
export const INTERNATIONAL = {
  'rtl offscreen': () => [views({ desktop: base, rtl: { ...base, overflowX: 30, overflowers: [{ selector: 'div.drawer', offscreen: true, over: 30 }] } }), ictx()],
  'rtl wide': () => [views({ desktop: base, rtl: { ...base, overflowX: 30, overflowers: [{ selector: ODD_SEL, width: 1400 }] } }), ictx()],
  'rtl no culprit': () => [views({ desktop: base, rtl: { ...base, overflowX: 30 } }), ictx()],
  'long text and rtl unmarked': () => [views({ desktop: { ...base, rtlUnmarked: 0.2 }, pseudo: { ...base, clipped: 6, overflowX: 40 } }), ictx()],
  'hreflang': () => [views({}), ictx({
    props: { 'margin-left': 25, 'margin-inline-start': 2 },
    meta: {
      lang: 'english', dir: null, canonical: 'https://s.test/',
      hreflang: [{ hreflang: 'en_US', href: 'https://s.test/us/' }, { hreflang: 'fr', href: 'https://s.test/fr/' }, { hreflang: 'de-XX-bad!', href: 'javascript:alert(1)' }, { hreflang: '<b>', href: 'https://s.test/?q=<b>&r="1"' }],
    },
  })],
};

export async function runCase(plugin, make) {
  const [reading, ctx] = make();
  return plugin.run(reading, ctx);
}
