import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsFiles, cssFiles, summarize, buildCoverage, COVERAGE_CAP, SKIP } from '../extension/core/coverage.js';

const DOC = 'https://www.example.com/page';
const fn = (...ranges) => ({ functionName: '', isBlockCoverage: true, ranges: ranges.map(([startOffset, endOffset, count]) => ({ startOffset, endOffset, count })) });
const script = (url, ...functions) => ({ scriptId: String(Math.random()), url, functions });

test('jsFiles: nested ranges', () => {
  const files = jsFiles([script('https://www.example.com/app.js', fn([0, 1000, 1]), fn([100, 400, 0], [200, 300, 1]))], { documentUrl: DOC });
  assert.deepEqual(files, [{ url: 'https://www.example.com/app.js', bytes: 1000, unusedBytes: 200 }]);
});

test('jsFiles: script length is the largest endOffset', () => {
  const [f] = jsFiles([script('https://www.example.com/a.js', fn([10, 50, 0]), fn([0, 700, 1]), fn([600, 650, 1]))], { documentUrl: DOC });
  assert.equal(f.bytes, 700);
  assert.equal(f.unusedBytes, 40);
});

test('jsFiles: document-URL scripts become one inline row', () => {
  const files = jsFiles([
    script(DOC, fn([0, 100, 1], [0, 30, 0])),
    script(DOC, fn([0, 200, 0])),
    script('https://cdn.other.net/lib.js', fn([0, 50, 1])),
  ], { documentUrl: DOC });
  assert.deepEqual(files.find((f) => f.inline), { url: '', bytes: 300, unusedBytes: 230, inline: true });
  assert.equal(files.length, 2);
});

test('jsFiles: drops data:, blob:, chrome-extension: and empty URLs', () => {
  const files = jsFiles([
    script('', fn([0, 100, 0])),
    script('data:text/javascript,1', fn([0, 100, 0])),
    script('blob:https://www.example.com/abc', fn([0, 100, 0])),
    script('chrome-extension://abcdef/content.js', fn([0, 100, 0])),
    script('https://www.example.com/keep.js', fn([0, 100, 1])),
  ], { documentUrl: DOC });
  assert.deepEqual(files.map((f) => f.url), ['https://www.example.com/keep.js']);
});

test('jsFiles: a script with 250,000 ranges still gets a summary', () => {
  const ranges = [{ startOffset: 0, endOffset: 500000, count: 1 }];
  for (let i = 0; i < 249999; i++) ranges.push({ startOffset: i * 2, endOffset: i * 2 + 1, count: 0 });
  const [f] = jsFiles([script('https://www.example.com/huge.js', { functionName: '', isBlockCoverage: true, ranges })], { documentUrl: DOC });
  assert.equal(f.bytes, 500000);
  assert.equal(f.unusedBytes, 249999);
});

test('jsFiles: same URL twice is one row', () => {
  const url = 'https://www.example.com/dup.js?v=1';
  const files = jsFiles([script(url, fn([0, 800, 1], [0, 500, 0])), script(url, fn([0, 1000, 1], [0, 300, 0]))], { documentUrl: DOC });
  assert.deepEqual(files, [{ url, bytes: 1000, unusedBytes: 300 }]);
});

const header = (styleSheetId, extra) => [styleSheetId, { styleSheetId, frameId: 'main', sourceURL: '', isInline: false, isConstructed: false, length: 0, ...extra }];

test('cssFiles: unused = length − union of used ranges', () => {
  const headers = new Map([header('s1', { sourceURL: 'https://www.example.com/site.css', length: 1000 })]);
  const usage = [
    { styleSheetId: 's1', startOffset: 0, endOffset: 300, used: true },
    { styleSheetId: 's1', startOffset: 200, endOffset: 400, used: true },
    { styleSheetId: 's1', startOffset: 400, endOffset: 900, used: false },
    { styleSheetId: 's1', startOffset: 350, endOffset: 380, used: true },
  ];
  assert.deepEqual(cssFiles(usage, headers, { documentUrl: DOC }), [{ url: 'https://www.example.com/site.css', bytes: 1000, unusedBytes: 600 }]);
});

test('cssFiles: inline and constructed sheets are one "inline styles" row', () => {
  const headers = new Map([
    header('a', { sourceURL: DOC, isInline: true, length: 100 }),
    header('b', { isConstructed: true, length: 50 }),
    header('c', { sourceURL: '', length: 20 }),
    header('d', { sourceURL: 'https://www.example.com/x.css', length: 10 }),
  ]);
  const usage = [
    { styleSheetId: 'a', startOffset: 0, endOffset: 40, used: true },
    { styleSheetId: 'b', startOffset: 0, endOffset: 50, used: false },
    { styleSheetId: 'c', startOffset: 0, endOffset: 20, used: true },
    { styleSheetId: 'd', startOffset: 0, endOffset: 10, used: true },
  ];
  const files = cssFiles(usage, headers, { documentUrl: DOC });
  assert.deepEqual(files.find((f) => f.inline), { url: '', bytes: 170, unusedBytes: 110, inline: true });
  assert.equal(files.length, 2);
});

test('cssFiles: injected and inspector sheets are left out; regular or missing origin kept', () => {
  const headers = new Map([
    header('r', { origin: 'regular', isInline: true, length: 10 }),
    header('n', { isInline: true, length: 20 }),
    header('i', { origin: 'injected', length: 100 }),
    header('d', { origin: 'inspector', length: 100 }),
  ]);
  const usage = ['r', 'n', 'i', 'd'].map((styleSheetId) => ({ styleSheetId, startOffset: 0, endOffset: 5, used: true }));
  assert.deepEqual(cssFiles(usage, headers, { documentUrl: DOC }), [{ url: '', bytes: 30, unusedBytes: 20, inline: true }]);
});

test('cssFiles: drops sheets from other frames when mainFrameId is given', () => {
  const headers = new Map([
    header('m', { sourceURL: 'https://www.example.com/m.css', length: 100 }),
    header('f', { sourceURL: 'https://ads.other.net/f.css', length: 100, frameId: 'iframe' }),
  ]);
  const usage = [
    { styleSheetId: 'm', startOffset: 0, endOffset: 10, used: true },
    { styleSheetId: 'f', startOffset: 0, endOffset: 10, used: true },
  ];
  assert.deepEqual(cssFiles(usage, headers, { documentUrl: DOC, mainFrameId: 'main' }).map((f) => f.url), ['https://www.example.com/m.css']);
  assert.equal(cssFiles(usage, headers, { documentUrl: DOC }).length, 2);
});

test('cssFiles: same URL twice is one row', () => {
  const url = 'https://www.example.com/s.css';
  const headers = new Map([header('x', { sourceURL: url, length: 100 }), header('y', { sourceURL: url, length: 120 })]);
  const usage = [
    { styleSheetId: 'x', startOffset: 0, endOffset: 30, used: true },
    { styleSheetId: 'y', startOffset: 0, endOffset: 60, used: true },
  ];
  assert.deepEqual(cssFiles(usage, headers, { documentUrl: DOC }), [{ url, bytes: 120, unusedBytes: 60 }]);
});

test('summarize: caps to 100 by unusedBytes, totals are true counts', () => {
  const files = Array.from({ length: 150 }, (_, i) => ({ url: `https://www.example.com/${i}.js`, bytes: 1000, unusedBytes: i }));
  const s = summarize(files, { site: 'example.com' });
  assert.equal(COVERAGE_CAP, 100);
  assert.equal(s.files.length, 100);
  assert.equal(s.fileCount, 150);
  assert.equal(s.totalBytes, 150000);
  assert.equal(s.unusedBytes, (149 * 150) / 2);
  assert.equal(s.files[0].unusedBytes, 149);
  assert.equal(s.files[99].unusedBytes, 50);
});

test('summarize: thirdParty from the site', () => {
  const s = summarize([
    { url: 'https://static.example.com/a.js', bytes: 10, unusedBytes: 3 },
    { url: 'https://cdn.other.net/b.js', bytes: 10, unusedBytes: 2 },
    { url: '', bytes: 10, unusedBytes: 1, inline: true },
  ], { site: 'example.com' });
  assert.deepEqual(s.files.map((f) => f.thirdParty), [false, true, false]);
  assert.equal(s.files[2].inline, true);
});

test('buildCoverage with nothing loaded', () => {
  const c = buildCoverage({ profile: [], ruleUsage: [], headers: new Map(), documentUrl: DOC, idle: true });
  assert.deepEqual(c, {
    window: 'load',
    idle: true,
    js: { files: [], totalBytes: 0, unusedBytes: 0, fileCount: 0 },
    css: { files: [], totalBytes: 0, unusedBytes: 0, fileCount: 0 },
  });
});

test('buildCoverage: idle false and third-party marking end to end', () => {
  const c = buildCoverage({
    profile: [script('https://cdn.other.net/lib.js', fn([0, 100, 1], [50, 100, 0])), script(DOC, fn([0, 10, 1]))],
    ruleUsage: [{ styleSheetId: 's', startOffset: 0, endOffset: 5, used: true }],
    headers: new Map([header('s', { sourceURL: 'https://www.example.com/s.css', length: 20 })]),
    documentUrl: DOC,
    idle: false,
  });
  assert.equal(c.idle, false);
  assert.deepEqual(c.js.files[0], { url: 'https://cdn.other.net/lib.js', bytes: 100, unusedBytes: 50, thirdParty: true });
  assert.deepEqual(c.css.files, [{ url: 'https://www.example.com/s.css', bytes: 20, unusedBytes: 15, thirdParty: false }]);
});

test('SKIP reasons', () => {
  assert.equal(SKIP.snapshot, 'needs a reload: the page was already loaded');
  assert.equal(SKIP.record, 'a recording spans several pages');
  assert.equal(SKIP.off, 'turned off in Options');
});
