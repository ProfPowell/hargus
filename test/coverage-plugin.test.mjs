import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../extension/plugins/coverage.js';
import { getPlugins } from '../extension/plugins/index.js';
import { h } from '../extension/ui/render.js';
import { SkipError } from '../extension/core/plugin-host.js';

const KB = 1024;
const entry = (url, transfer) => ({ request: { url }, response: { status: 200, _transferSize: transfer, content: { size: 0 } } });
const kind = (files) => ({
  files,
  totalBytes: files.reduce((n, f) => n + f.bytes, 0),
  unusedBytes: files.reduce((n, f) => n + f.unusedBytes, 0),
  fileCount: files.length,
});
const reading = (coverage, entries = []) => ({ log: { entries, _harplus: { coverage } } });
const cov = ({ js = [], css = [], idle = true } = {}) => ({ window: 'load', idle, js: kind(js), css: kind(css) });
const file = (url, bytes, unusedBytes, thirdParty = false) => ({ url, bytes, unusedBytes, thirdParty });
const ctx = {};
const run = (r) => plugin.run(r, ctx);

test('registered as an analyze plugin in the Performance area, after network', () => {
  const ids = getPlugins().map((p) => p.id);
  assert.equal(ids.indexOf('coverage'), ids.indexOf('network') + 1);
  assert.equal(plugin.phase, 'analyze');
  assert.equal(plugin.group, 'quality');
  assert.equal(plugin.area, 'performance');
  assert.equal(plugin.name, 'Code coverage');
});

test('skips without data', () => {
  assert.throws(() => run(reading(undefined)), (e) => e instanceof SkipError && /not measured in this reading/.test(e.message));
  assert.throws(() => run({ log: { entries: [] } }), /not measured in this reading/);
});

test('skips with stored reason', () => {
  assert.throws(() => run(reading({ skipped: 'turned off in Options' })), (e) => e instanceof SkipError && e.message === 'turned off in Options');
  assert.throws(() => run(reading({ skipped: 'coverage failed: boom' })), /coverage failed: boom/);
});

test('waste uses transfer share', () => {
  const url = 'https://s.test/app.js';
  const r = run(reading(cov({ js: [file(url, 100 * KB, 60 * KB)] }), [entry(url, 0), entry(url, 30 * KB)]));
  const f = r.data.js.files[0];
  assert.equal(f.waste, 18 * KB);
  assert.equal(f.decodedOnly, false);
  assert.equal(f.kind, 'js');
  assert.equal(f.pct, 60);
  assert.equal(r.data.js.waste, 18 * KB);
});

test('waste falls back to decoded when transfer is 0', () => {
  const url = 'https://s.test/app.css';
  const r = run(reading(cov({ css: [file(url, 20 * KB, 8 * KB), { url: '', bytes: 4 * KB, unusedBytes: 3 * KB, thirdParty: false, inline: true }] }), [entry(url, 0)]));
  const [a, b] = r.data.css.files;
  assert.equal(a.waste, 8 * KB);
  assert.equal(a.decodedOnly, true);
  assert.equal(b.waste, 3 * KB);
  assert.equal(b.decodedOnly, true);
  assert.equal(b.inline, true);
});

test('JS thresholds', () => {
  const sev = (files) => run(reading(cov({ js: files }))).findings.map((f) => f.severity);
  assert.deepEqual(sev([file('https://s.test/a.js', 100 * KB, 39 * KB)]), []);
  assert.deepEqual(sev([file('https://s.test/a.js', 100 * KB, 40 * KB)]), ['low']);
  assert.deepEqual(sev([file('https://s.test/a.js', 200 * KB, 149 * KB)]), ['low']);
  assert.deepEqual(sev([file('https://s.test/a.js', 300 * KB, 150 * KB)]), ['medium']);
  // under 10 KB of waste each: 30 + 9 + 9 KB counts as 30, no finding
  assert.deepEqual(sev([file('https://s.test/a.js', 100 * KB, 30 * KB), file('https://s.test/b.js', 20 * KB, 9 * KB), file('https://s.test/c.js', 20 * KB, 9 * KB)]), []);
  // exactly 10 KB counts: 30 + 10 = 40
  assert.deepEqual(sev([file('https://s.test/a.js', 100 * KB, 30 * KB), file('https://s.test/b.js', 20 * KB, 10 * KB)]), ['low']);
});

test('CSS thresholds', () => {
  const sev = (files) => run(reading(cov({ css: files }))).findings.map((f) => f.severity);
  assert.deepEqual(sev([file('https://s.test/a.css', 100 * KB, 14 * KB)]), []);
  assert.deepEqual(sev([file('https://s.test/a.css', 100 * KB, 15 * KB)]), ['low']);
  assert.deepEqual(sev([file('https://s.test/a.css', 100 * KB, 50 * KB)]), ['medium']);
  assert.deepEqual(sev([file('https://s.test/a.css', 100 * KB, 12 * KB), file('https://s.test/b.css', 10 * KB, 4 * KB)]), []);
  assert.deepEqual(sev([file('https://s.test/a.css', 100 * KB, 10 * KB), file('https://s.test/b.css', 10 * KB, 5 * KB)]), ['low']);
});

test('at most one finding per kind', () => {
  const r = run(reading(cov({
    js: [file('https://s.test/a.js', 400 * KB, 200 * KB), file('https://s.test/b.js', 100 * KB, 50 * KB)],
    css: [file('https://s.test/a.css', 100 * KB, 60 * KB)],
  })));
  assert.deepEqual(r.findings.map((f) => `${f.severity}:${f.category}`), ['medium:performance', 'medium:performance']);
});

test('finding wording and places', () => {
  const a = 'https://s.test/a.js';
  const b = 'https://cdn.other.test/b.js?v=2';
  const r = run(reading(cov({ js: [
    file(a, 100 * KB, 30 * KB),
    file(b, 200 * KB, 100 * KB, true),
    file('https://s.test/tiny.js', 10 * KB, 5 * KB),
    { url: '', bytes: 40 * KB, unusedBytes: 20 * KB, thirdParty: false, inline: true },
  ] })));
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.match(f.title, /not used during load/);
  assert.match(f.title, /JavaScript/);
  assert.deepEqual(f.places, [{ url: b }, { url: a }]);
  for (const p of f.places) assert.deepEqual(Object.keys(p), ['url']);
  assert.match(f.evidence, /100\.0 KB/);
  assert.match(f.evidence, /30\.0 KB/);
  assert.match(f.evidence, /inline scripts/);
  assert.ok(f.evidence.indexOf(b) < f.evidence.indexOf(a));
  assert.doesNotMatch(f.evidence, /tiny\.js/);
  assert.match(f.detail, /first party/);
  assert.match(f.detail, /third party/);
  for (const s of [f.title, f.detail, f.evidence]) assert.doesNotMatch(s, /unused code/i);
});

test('places capped at 200', () => {
  const files = Array.from({ length: 100 }, (_, i) => file(`https://s.test/${i}.js`, 50 * KB, 20 * KB));
  const r = run(reading(cov({ js: files })));
  assert.equal(r.findings[0].places.length, 100);
});

test('summary', () => {
  const r = run(reading(cov({ js: [file('https://s.test/a.js', 100 * KB, 62 * KB)], css: [file('https://s.test/a.css', 10 * KB, 4 * KB)] })));
  const js = r.summary.find((s) => s.label === 'JS not used');
  const css = r.summary.find((s) => s.label === 'CSS not used');
  assert.equal(js.value, '62%');
  assert.equal(js.headline, true);
  assert.equal(css.value, '40%');
  assert.equal(css.headline, true);
});

test('first- and third-party split', () => {
  const r = run(reading(cov({ js: [file('https://s.test/a.js', 100 * KB, 60 * KB), file('https://x.test/b.js', 50 * KB, 10 * KB, true)] })));
  assert.deepEqual(r.data.js.first, { bytes: 100 * KB, unusedBytes: 60 * KB });
  assert.deepEqual(r.data.js.third, { bytes: 50 * KB, unusedBytes: 10 * KB });
  assert.equal(r.data.idle, true);
});

const draw = (r) => String(plugin.render({ status: 'ok', ...r }, h));

test('render', () => {
  const js = Array.from({ length: 10 }, (_, i) => file(`https://s.test/${i}.js`, 50 * KB, (20 + i) * KB, i % 2 === 1));
  const r = run(reading(cov({ js, css: [file('https://s.test/a.css', 30 * KB, 12 * KB)] }), [entry('https://s.test/0.js', 10 * KB)]));
  const out = draw(r);
  assert.match(out, /class="stats"/);
  assert.match(out, /JS not used during load/);
  assert.match(out, /CSS not used during load/);
  assert.match(out, /Files measured/);
  assert.match(out, /First party/);
  assert.match(out, /Third party/);
  assert.match(out, /3 more/); // 11 files, folded past 8
  assert.match(out, /size before compression/);
  assert.match(out, /url-host/);
  assert.doesNotMatch(out, /still loading/);
  assert.match(out, /\d+%/, 'percentages have no space before the sign');
  assert.doesNotMatch(out, /\d(&nbsp;| | )%/);
});

test('render: nothing measured', () => {
  const out = draw(run(reading(cov())));
  assert.match(out, /No scripts or stylesheets measured/);
});

test('render: taken before idle', () => {
  const out = draw(run(reading(cov({ js: [file('https://s.test/a.js', 10 * KB, 2 * KB)], idle: false }))));
  assert.match(out, /taken while the page was still loading/);
});

test('render escapes page-derived URLs', () => {
  const out = draw(run(reading(cov({ js: [file('https://s.test/"><img src=x>.js', 100 * KB, 50 * KB)] }))));
  assert.doesNotMatch(out, /<img src=x>/);
});

test('render never says "unused code"', () => {
  const js = [file('https://s.test/a.js', 400 * KB, 300 * KB), { url: '', bytes: 4 * KB, unusedBytes: 3 * KB, thirdParty: false, inline: true }];
  const css = [file('https://x.test/a.css', 100 * KB, 60 * KB, true)];
  const r = run(reading(cov({ js, css, idle: false })));
  const text = [draw(r), ...r.findings.flatMap((f) => [f.title, f.detail, f.evidence]), ...r.summary.map((s) => `${s.label} ${s.value}`)].join('\n');
  assert.doesNotMatch(text, /unused code/i);
  assert.doesNotMatch(text, /\bunused\b/i);
});

const JS_SKIP = "JavaScript coverage isn't available to Chrome extensions";

test('JS skipped: CSS finding and headline only; the panel says not measured, with the reason once', () => {
  const r = run(reading({ window: 'load', idle: true, js: { skipped: JS_SKIP }, css: kind([file('https://s.test/a.css', 100 * KB, 60 * KB)]) }));
  assert.deepEqual(r.findings.map((f) => f.title.split(':')[0]), ['CSS not used during load']);
  assert.deepEqual(r.summary.filter((s) => s.headline).map((s) => s.label), ['CSS not used']);
  assert.ok(!r.summary.some((s) => /JS/.test(`${s.label} ${s.value}`)), JSON.stringify(r.summary));
  assert.equal(r.summary.find((s) => s.label === 'Files measured').value, '1 stylesheet');
  assert.deepEqual(r.data.js, { skipped: JS_SKIP });
  const out = draw(r);
  assert.match(out, /not measured/);
  assert.equal(out.match(/available to Chrome extensions/g)?.length, 1, 'the reason is shown once');
  assert.doesNotMatch(out, /<td>JavaScript<\/td>/, 'the tables hold only measured kinds');
});

test('CSS skipped: JS finding and headline only', () => {
  const r = run(reading({ window: 'load', idle: true, js: kind([file('https://s.test/a.js', 300 * KB, 200 * KB)]), css: { skipped: 'coverage failed: nope' } }));
  assert.deepEqual(r.findings.map((f) => f.title.split(':')[0]), ['JavaScript not used during load']);
  assert.deepEqual(r.summary.filter((s) => s.headline).map((s) => s.label), ['JS not used']);
});

test('both kinds skipped: the plugin skips', () => {
  assert.throws(() => run(reading({ window: 'load', idle: true, js: { skipped: JS_SKIP }, css: { skipped: 'coverage failed: nope' } })),
    (e) => e instanceof SkipError && e.message === `${JS_SKIP}; coverage failed: nope`);
});
