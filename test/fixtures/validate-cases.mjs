// Fixtures for the validator plugins (html-validate, css-validate): readings and mocked validator replies.
// Shared by test/validate.test.mjs and validate-findings-baseline.json, which was taken from the plugins before
// places were added. score-check cannot replay enrich plugins, so this is what proves every finding field but
// `places` (and the summary) is unchanged.
import { ensureHarPlus } from '../../extension/core/harplus.js';
import { runPlugins } from '../../extension/core/plugin-host.js';
import { getPlugins } from '../../extension/plugins/index.js';
import { mockFetch } from '../helpers.mjs';

const entry = (url, type, mimeType, text) => ({
  startedDateTime: '2026-10-01T00:00:00.000Z', time: 10, _resourceType: type,
  request: { method: 'GET', url, httpVersion: 'h2', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
  response: { status: 200, statusText: '', httpVersion: 'h2', headers: [], cookies: [], content: { size: text ? text.length : 0, mimeType, ...(text ? { text } : {}) }, redirectURL: '', headersSize: -1, bodySize: -1 },
  cache: {}, timings: { send: 0, wait: 5, receive: 5 },
});

/** A reading of https://www.site.test/ with the page HTML and the given first- and third-party stylesheets. */
export function reading({ html = '<!doctype html><title>x</title>', sheets = [] } = {}) {
  return ensureHarPlus({ log: { version: '1.2', creator: { name: 'test' }, pages: [], entries: [
    entry('https://www.site.test/', 'document', 'text/html', html),
    ...sheets.map(([url, text]) => entry(url, 'stylesheet', 'text/css', text)),
  ] } });
}

const nu = (messages) => ({ body: { messages } });
const err = (lastLine, message, extract, firstColumn = 1) => ({ type: 'error', lastLine, firstColumn, message, extract });

/** Nu checker replies by name. */
export const NU = {
  few: nu([
    err(10, 'Stray end tag “div”.', '</div>'),
    err(12, 'Stray end tag “div”.', '</div>\n</div>'),
    err(30, 'Element “li” not allowed as child of element “div” in this context.', '<div><li>x'),
    { type: 'info', subType: 'warning', lastLine: 1, message: 'Consider adding a “lang” attribute.' },
    { type: 'info', message: 'Trailing slash on void elements has no effect.' },
  ]),
  // 30 errors: medium severity; odd values: markup in the extract, a missing line, a long message, a line-0 error.
  odd: nu([
    err(5, 'Bad value “<script>alert(1)</script>” for attribute “href”.', '<a href="<script>alert(1)</script>">'),
    { type: 'error', message: 'No line at all.', extract: '' },
    err(0, 'Line zero.', 'x'),
    err(7, 'M'.repeat(700), 'y'.repeat(300)),
    ...Array.from({ length: 26 }, (_, i) => err(100 + i, `Duplicate ID “a${i % 3}”.`, `<p id="a${i % 3}">`)),
  ]),
  many: nu(Array.from({ length: 250 }, (_, i) => err(i + 1, i % 2 ? 'Odd error.' : 'Even error.', `<x${i}>`))),
  clean: nu([{ type: 'info', subType: 'warning', lastLine: 2, message: 'Only a warning.' }]),
};

const jigsaw = (errors, warnings = []) => ({ body: JSON.stringify({ cssvalidation: { csslevel: 'css3', errors, warnings } }) });
const cerr = (line, message, context = ' a ') => ({ line, message, context, type: 'value' });

/** Run one validator plugin on a reading with a mocked service; returns the plugin's normalized result. */
export async function runValidator(id, r, reply, options = {}) {
  const settings = { plugins: { [id]: { enabled: true, options } } };
  const route = id === 'html-validate' ? /validator\.w3\.org\/nu/ : /jigsaw\.w3\.org/;
  const handler = typeof reply === 'function' ? reply : () => reply;
  await runPlugins(r, getPlugins(settings), { phases: ['enrich'], only: [id], settings, fetch: mockFetch([[route, handler]]) });
  return r.log._harplus.plugins[id];
}

/** The validator cases: name → () => Promise<result>. */
export const CASES = {
  'html few': () => runValidator('html-validate', reading(), NU.few),
  'html odd': () => runValidator('html-validate', reading(), NU.odd),
  'html many': () => runValidator('html-validate', reading(), NU.many),
  'html clean': () => runValidator('html-validate', reading(), NU.clean),
  'css two sheets': () => runValidator('css-validate', reading({ sheets: [
    ['https://www.site.test/a.css', 'a { colr: red }'], ['https://www.site.test/b.css', 'b { color: blue }'], ['https://cdn.other.test/c.css', 'c{}'],
  ] }), (url, init) => {
    const text = init.body?.get?.('text') || '';
    return /colr/.test(text)
      ? jigsaw([cerr(1, 'Property “colr” doesn’t exist'), cerr(4, 'Value Error : color only 0 can be a unit.', ' .b '), cerr(9, 'Property “colr” doesn’t exist')], [{ line: 2, message: 'w', level: 0 }])
      : jigsaw([]);
  }),
  // 60 errors: medium; odd values: markup in the message and context, a missing line, a long context.
  'css odd': () => runValidator('css-validate', reading({ sheets: [['https://www.site.test/s.css?v=<b>"1"', 'x{}']] }), jigsaw([
    cerr(3, 'Value Error : <img src=x onerror=alert(1)>', ' <b>ctx</b> '),
    { message: 'No line', context: '' },
    cerr(8, 'Long', ` ${'c'.repeat(700)} `),
    ...Array.from({ length: 57 }, (_, i) => cerr(20 + i, `Unknown pseudo-element “::x${i % 4}”`)),
  ])),
  'css page mode': () => runValidator('css-validate', reading(), jigsaw([cerr(2, 'Parse Error', ' body ')])),
  'css one failed sheet': () => runValidator('css-validate', reading({ sheets: [['https://www.site.test/ok.css', 'colr'], ['https://www.site.test/bad.css', 'fails']] }),
    (url, init) => (/fails/.test(init.body?.get?.('text') || '') ? { status: 503, body: 'down' } : jigsaw([cerr(1, 'Property “colr” doesn’t exist')]))),
  'css clean': () => runValidator('css-validate', reading({ sheets: [['https://www.site.test/a.css', 'a{}']] }), jigsaw([], [{ line: 1, message: 'only a warning', level: 1 }])),
};
