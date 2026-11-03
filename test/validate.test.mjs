import { test } from 'node:test';
import assert from 'node:assert/strict';
import htmlValidate from '../extension/plugins/html-validate.js';
import cssValidate from '../extension/plugins/css-validate.js';
import { h } from '../extension/ui/render.js';
import { CASES, reading, runValidator } from './fixtures/validate-cases.mjs';
import BASELINE from './fixtures/validate-findings-baseline.json' with { type: 'json' };

const html = (x) => String(x);
const noHeadline = (summary) => summary.map(({ headline, ...s }) => s);

test('validators: every finding field but places is unchanged from before places (score-check cannot replay enrich plugins)', async () => {
  for (const [name, run] of Object.entries(CASES)) {
    const r = await run();
    assert.equal(r.status, 'ok', `${name}: ${r.error}`);
    assert.deepEqual(JSON.parse(JSON.stringify(r.findings.map(({ places, ...f }) => f))), BASELINE[name].findings, name);
    for (const f of r.findings) assert.ok(f.id, `${name}: no rule id`);
    // The summary only gains the headline flag.
    assert.deepEqual(noHeadline(r.summary), BASELINE[name].summary, name);
    assert.equal(r.summary.find((s) => s.headline)?.label, 'Errors', name);
  }
});

test('html-validate: each error is a place with its line, the quoted source and the message', async () => {
  const r = await CASES['html few']();
  assert.deepEqual(r.findings[0].places, [
    { line: 10, text: '</div>', note: 'Stray end tag “div”.' },
    { line: 12, text: '</div>\n</div>', note: 'Stray end tag “div”.' },
    { line: 30, text: '<div><li>x', note: 'Element “li” not allowed as child of element “div” in this context.' },
  ]);
  assert.equal(r.summary[0].value, '3 (2 kinds)');
});

test('html-validate odd values: no location → no place, line 0 kept, long values cut, markup escaped when drawn', async () => {
  const r = await CASES['html odd']();
  const places = r.findings[0].places;
  assert.equal(places.length, 29, 'the error with neither a line nor a quote has no place');
  assert.ok(!places.some((p) => p.note === 'No line at all.'));
  assert.deepEqual(places.find((p) => p.note === 'Line zero.'), { line: 0, text: 'x', note: 'Line zero.' });
  const long = places.find((p) => p.line === 7);
  assert.equal(long.note.length, 500, 'normalize cuts the message');
  assert.equal(long.text.length, 160, 'the quote is already cut to 160');
  const drawn = html(h.places(places));
  assert.doesNotMatch(drawn, /<script>|<a href="</);
  assert.match(drawn, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('html-validate: places stop at 200 while the title and counts keep the true number', async () => {
  const r = await CASES['html many']();
  assert.equal(r.findings[0].places.length, 200);
  assert.deepEqual(r.findings[0].places[199], { line: 200, text: '<x199>', note: 'Odd error.' });
  assert.match(r.findings[0].title, /^250 HTML validation errors/);
  assert.deepEqual(r.data.counts, { errors: 250, warnings: 0, kinds: 2 });
});

test('html-validate: a numeric-string line becomes a place line; other odd lines do not', async () => {
  const reply = { body: { messages: [
    { type: 'error', lastLine: '12', message: 'a', extract: 'q' },
    { type: 'error', lastLine: 'x', message: 'b', extract: 'r' },
    { type: 'error', lastLine: -3, message: 'c', extract: 's' },
    { type: 'error', lastLine: 2.5, message: 'd', extract: '' },
  ] } };
  const r = await runValidator('html-validate', reading(), reply);
  assert.deepEqual(r.findings[0].places, [{ line: 12, text: 'q', note: 'a' }, { text: 'r', note: 'b' }, { text: 's', note: 'c' }]);
});

test('html-validate render: answer first (true counts), kinds and warnings; error locations are the issue\'s places', async () => {
  const r = await CASES['html few']();
  const out = html(htmlValidate.render(r, h));
  assert.ok(out.trimStart().startsWith('<div class="stats">'), 'stats come first');
  assert.match(out, /Errors<\/span><div class="stat-value">3</);
  assert.match(out, /Kinds of error<\/span><div class="stat-value">2</);
  assert.match(out, /Warnings<\/span><div class="stat-value">1</);
  assert.match(out, /Errors by kind/);
  assert.match(out, /Consider adding a “lang” attribute/);
  assert.doesNotMatch(out, /Error locations|<\/div>\n<\/div>/);
  // A reading from before `counts`: falls back to the lists.
  const old = { ...r, data: { ...r.data, counts: undefined } };
  assert.match(html(htmlValidate.render(old, h)), /Errors<\/span><div class="stat-value">3</);
  const clean = await CASES['html clean']();
  assert.match(html(htmlValidate.render(clean, h)), /Errors<\/span><div class="stat-value">0</);
});

test('css-validate: each error is a place with its stylesheet, line, CSS context and message', async () => {
  const r = await CASES['css two sheets']();
  assert.deepEqual(r.findings[0].places, [
    { url: 'https://www.site.test/a.css', line: 1, text: 'a', note: 'Property “colr” doesn’t exist' },
    { url: 'https://www.site.test/a.css', line: 4, text: '.b', note: 'Value Error : color only 0 can be a unit.' },
    { url: 'https://www.site.test/a.css', line: 9, text: 'a', note: 'Property “colr” doesn’t exist' },
  ]);
  const page = await CASES['css page mode']();
  assert.deepEqual(page.findings[0].places, [{ url: 'https://www.site.test/', line: 2, text: 'body', note: 'Parse Error' }], 'validator fetched the page: the page is the place');
  const failed = await CASES['css one failed sheet']();
  assert.deepEqual(failed.findings[0].places, [{ url: 'https://www.site.test/ok.css', line: 1, text: 'a', note: 'Property “colr” doesn’t exist' }]);
});

test('css-validate odd values: no line keeps the sheet, long context cut, markup escaped when drawn', async () => {
  const r = await CASES['css odd']();
  const places = r.findings[0].places;
  assert.equal(places.length, 60);
  const url = 'https://www.site.test/s.css?v=<b>"1"';
  assert.ok(places.every((p) => p.url === url));
  assert.deepEqual(places[1], { url, note: 'No line' });
  assert.equal(places[2].text.length, 500);
  const drawn = html(h.places(places.slice(0, 3)));
  assert.doesNotMatch(drawn, /<b>|<img/);
  assert.match(drawn, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(drawn, /title="https:\/\/www\.site\.test\/s\.css\?v=&lt;b&gt;&quot;1&quot;"/);
});

test('css-validate: places stop at 200 across sheets, sheet by sheet', async () => {
  const errs = (n, tag) => Array.from({ length: n }, (_, i) => ({ line: i + 1, message: `${tag}${i}`, context: '' }));
  const r = await runValidator('css-validate', reading({ sheets: [['https://www.site.test/1.css', 'one'], ['https://www.site.test/2.css', 'two']] }),
    (url, init) => ({ body: JSON.stringify({ cssvalidation: { errors: errs(150, init.body.get('text')) } }) }));
  const places = r.findings[0].places;
  assert.equal(places.length, 200);
  assert.equal(places.filter((p) => p.url.endsWith('/1.css')).length, 150);
  assert.deepEqual(places[199], { url: 'https://www.site.test/2.css', line: 50, note: 'two49' });
  assert.match(r.findings[0].title, /^300 CSS validation errors in 2 stylesheets/);
});

test('css-validate render: answer first, sheets as URL parts, kinds, errors by line closed', async () => {
  const r = await CASES['css two sheets']();
  const out = html(cssValidate.render(r, h));
  assert.ok(out.trimStart().startsWith('<div class="stats">'), 'stats come first');
  assert.match(out, /Errors<\/span><div class="stat-value">3</);
  assert.match(out, /Kinds of error<\/span><div class="stat-value">2</);
  assert.match(out, /Stylesheets checked<\/span><div class="stat-value">2</);
  assert.match(out, /<a href="https:\/\/www\.site\.test\/a\.css"[^>]*><span class="url"/);
  assert.match(out, /<details class="disclosure"><summary>Errors by line<span class="disclosure-meta">1 stylesheet<\/span>/);
  assert.doesNotMatch(out, /<details class="disclosure" open/);
  // A reading from before `kinds`.
  const old = { ...r, data: { ...r.data, kinds: undefined } };
  assert.match(html(cssValidate.render(old, h)), /Kinds of error<\/span><div class="stat-value">2</);
  const page = await CASES['css page mode']();
  assert.match(html(cssValidate.render(page, h)), /validator fetched the page/);
  const clean = await CASES['css clean']();
  const c = html(cssValidate.render(clean, h));
  assert.doesNotMatch(c, /Errors by line|undefined|NaN/);
  assert.match(c, /Warnings<\/span><div class="stat-value">1</);
});

test('html-validate render: capped kinds and warnings say "first N of M"', async () => {
  const r = await CASES['html few']();
  assert.doesNotMatch(html(htmlValidate.render(r, h)), /first \d+ of/, 'nothing capped');
  const capped = { ...r, data: { ...r.data, counts: { ...r.data.counts, kinds: 75, warnings: 400 } } };
  const out = html(htmlValidate.render(capped, h));
  assert.match(out, /<h4>Errors by kind<\/h4><span class="panel-sub">first 2 of 75<\/span>/);
  assert.match(out, /<h4>Warnings<\/h4><span class="panel-sub">first 1 of 400<\/span>/);
});

test('css-validate render: capped kinds and a sheet\'s errors past 60 say "first N of M"', async () => {
  const r = await CASES['css two sheets']();
  assert.doesNotMatch(html(cssValidate.render(r, h)), /first \d+ of/, 'nothing capped');
  const sheets = r.data.sheets.map((x) => (x.errors.length ? { ...x, errors: Array.from({ length: 70 }, (_, i) => ({ ...x.errors[0], line: i + 1 })) } : x));
  const out = html(cssValidate.render({ ...r, data: { ...r.data, kinds: 90, sheets } }, h));
  assert.match(out, /<h4>Errors by kind<\/h4><span class="panel-sub">first 2 of 90<\/span>/);
  assert.match(out, /<span class="panel-sub">first 60 of 70<\/span>/);
  assert.doesNotMatch(out, /disclosure fold/, 'errors by line are closed already: not folded again');
});
