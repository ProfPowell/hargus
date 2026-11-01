import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCompare, compareDocument, ordinal } from '../extension/ui/compare-view.js';
import { compareReadings, conditions, compareRounds } from '../extension/core/compare.js';
import { AREAS } from '../extension/core/score.js';
import { getPlugins } from '../extension/plugins/index.js';

const plugins = getPlugins();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const text = (raw) => String(raw).replace(/<\/?(p|li|h3|section|header|td|th|tr|ul|ol|footer)\b[^>]*>/g, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// A reading fixture for compareReadings.
const result = (id, data) => ({ id, name: id, status: 'ok', data, findings: [], summary: [] });
function mk(url, { lcp = 2000, ratings = { lcp: 'good' }, host, title } = {}) {
  return {
    log: {
      entries: [{ request: { url }, response: { _transferSize: 1000, content: {} } }],
      _harplus: {
        id: url, capturedAt: '2026-10-31T10:00:00.000Z',
        target: { url, finalUrl: url, host: host || new URL(url).hostname, title },
        screenshots: [{ kind: 'viewport', mimeType: 'image/png', encoding: 'base64', data: PNG }],
        plugins: { vitals: result('vitals', { lcp: { time: lcp }, fcp: 500, cls: 0, blockingTime: 0, navigation: { ttfb: 100, load: 3000 }, ratings }) },
      },
    },
  };
}

// A hand-made model, in the shape compareReadings returns.
const site = (key, o = {}) => ({
  key, host: key, label: key, url: `https://${key}/`, score: 80, grade: 'B', status: 'warning', thumb: '', favicon: null,
  capturedAt: '2026-10-31T10:00:00.000Z', strengths: [], weaknesses: [], ...o,
});
function model({ sites, overall, areas, metrics = [], faceoff, singleRunNote = false, layout } = {}) {
  const keys = sites.filter((s) => !s.gap).map((s) => s.key);
  const zero = Object.fromEntries(keys.map((k) => [k, 0]));
  return {
    profile: { id: 'general', label: 'General' },
    sites,
    overall: overall || { winners: [keys[0]], tie: false, areaWins: zero, ties: 0 },
    areas: areas || AREAS.map((a) => ({ id: a.id, label: a.label, winners: [], tie: false, scores: Object.fromEntries(keys.map((k) => [k, null])), why: '' })),
    metrics,
    faceoff: faceoff || { wins: zero, ties: 0, total: metrics.length },
    singleRunNote,
    layout: layout || (sites.length >= 5 ? 'strip' : 'columns'),
  };
}
const three = () => model({
  sites: [
    site('a.com', { score: 91, grade: 'A', status: 'good', favicon: `data:image/png;base64,${PNG}`, thumb: `data:image/png;base64,${PNG}`,
      strengths: [{ label: 'Fastest LCP', value: '1.20 s' }, { label: 'Lightest page', value: '300 KB' }],
      weaknesses: [{ label: 'Most requests', value: '120' }, { label: 'Most JavaScript', value: '900 KB' }] }),
    site('b.com', { score: 80 }),
    site('c.com', { score: 70, grade: 'C', status: 'warning' }),
  ],
  overall: { winners: ['a.com'], tie: false, areaWins: { 'a.com': 4, 'b.com': 2, 'c.com': 2 }, ties: 1 },
  areas: AREAS.map((a, i) => ({
    id: a.id, label: a.label,
    winners: i === 1 ? ['a.com', 'b.com'] : ['a.com'], tie: i === 1,
    scores: { 'a.com': 90, 'b.com': 85, 'c.com': i === 2 ? null : 60 },
    why: i === 0 ? 'LCP 2.00 s vs 3.40 s' : '',
  })),
  metrics: [
    { id: 'lcp', area: 'performance', label: 'LCP', best: 'a.com', worst: 'c.com', winners: ['a.com'], tie: false,
      values: { 'a.com': { value: 2000, text: '2.00 s' }, 'b.com': { value: 2500, text: '2.50 s' }, 'c.com': { value: 3400, text: '3.40 s' } } },
    { id: 'contrastFailures', area: 'accessibility', label: 'Contrast failures', best: null, worst: null, winners: ['a.com', 'b.com'], tie: true,
      values: { 'a.com': { value: 1, text: '1' }, 'b.com': { value: 1, text: '1' }, 'c.com': { value: null, text: '—' } } },
  ],
  faceoff: { wins: { 'a.com': 1, 'b.com': 0, 'c.com': 0 }, ties: 1, total: 2 },
});
const opts = (o = {}) => ({ conditions: [], interactive: true, ...o });

test('ordinal', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
});

test('columns: favicon or initial, thumbnail, score, grade, star, two strengths and two weaknesses per column', () => {
  const out = String(renderCompare(three(), opts()));
  assert.match(out, /class="cmp-sites"/);
  assert.equal(out.match(/<section class="cmp-site( |")/g).length, 3);
  assert.match(out, /<img class="cmp-fav" src="data:image\/png;base64,/);
  assert.match(out, /<span class="cmp-fav" aria-hidden="true">B<\/span>/);
  assert.match(out, /<img class="cmp-thumb" src="data:image\/png/);
  const a = text(out.split('<section class="cmp-site')[1]);
  assert.match(a, /91/);
  assert.match(a, /A/);
  assert.match(a, /★/);
  assert.match(a, /Fastest LCP \(1\.20 s\)/);
  assert.match(a, /Lightest page \(300 KB\)/);
  assert.match(a, /Most requests \(120\)/);
  assert.match(a, /Most JavaScript \(900 KB\)/);
  assert.match(out, /class="cmp-good"/);
  assert.match(out, /class="cmp-bad"/);
  assert.match(text(out), /No clear strengths in this group/);
  assert.match(text(out), /No clear weaknesses in this group/);
  assert.equal(out.match(/class="cmp-star"/g).length >= 1, true);
  assert.doesNotMatch(out, /class="cmp-strip"/);
});

test('strip at 5 sites: chips, and strengths and weaknesses in a block after the area table', () => {
  const m = model({ sites: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'].map((k) => site(k, { strengths: [{ label: 'Fastest LCP', value: '1.20 s' }] })) });
  const out = String(renderCompare(m, opts()));
  assert.match(out, /class="cmp-strip"/);
  assert.equal(out.match(/class="cmp-chip( |")/g).length, 5);
  assert.doesNotMatch(out, /class="cmp-sites"/);
  const table = out.indexOf('class="cmp-areas');
  const sw = out.indexOf('Strengths and weaknesses');
  assert.ok(table > 0 && sw > table, 'the block follows the area table');
  assert.ok(out.indexOf('Fastest LCP') > table);
});

test('verdict line', () => {
  assert.match(text(renderCompare(three(), opts())), /Overall: a\.com · wins 4 areas · b\.com 2 · c\.com 2 · 1 tie/);
  const tie = three();
  tie.overall = { winners: ['a.com', 'c.com'], tie: true, areaWins: { 'a.com': 1, 'b.com': 0, 'c.com': 1 }, ties: 0 };
  assert.match(text(renderCompare(tie, opts())), /Overall: tie between a\.com and c\.com/);
});

test('area table: score bars, a star on the winner, "tie", and the why', () => {
  const out = String(renderCompare(three(), opts()));
  const t = out.slice(out.indexOf('class="cmp-areas'), out.indexOf('</table>', out.indexOf('class="cmp-areas')));
  assert.equal(t.match(/class="score-bar"/g).length, 8 * 3 - 1);
  assert.match(t, /Performance/);
  assert.match(text(t), /tie/);
  assert.match(text(t), /LCP 2\.00 s vs 3\.40 s/);
  assert.match(text(t), /not measured/);
  assert.match(t, /cmp-star/);
});

test('face-off: the summary count line, best in green and worst in red via classes, grouped by area, and the single-run note when flagged', () => {
  const m = three();
  const out = String(renderCompare(m, opts()));
  assert.match(text(out), /2 metrics: a\.com wins 1, 1 tie/);
  assert.match(out, /<td class="best">2\.00 s<\/td>/);
  assert.match(out, /<td class="worst">3\.40 s<\/td>/);
  assert.match(out, /class="cmp-group"[^>]*>.*Performance/s);
  assert.ok(out.indexOf('>Accessibility<', out.indexOf('class="cmp-faceoff')) > out.indexOf('>Performance<', out.indexOf('class="cmp-faceoff')));
  assert.doesNotMatch(out, /Some timings are single runs/);
  m.singleRunNote = true;
  assert.match(String(renderCompare(m, opts())), /Some timings are single runs; record with 3 runs for firmer results\./);
  assert.doesNotMatch(out, /<details/);
});

test('conditions lines render above the verdict', () => {
  const out = text(renderCompare(three(), opts({ conditions: ['b.com was recorded on mobile, the others on desktop', 'Recorded between 3 Oct and 30 Oct'] })));
  const c = out.indexOf('b.com was recorded on mobile, the others on desktop');
  assert.ok(c >= 0 && c < out.indexOf('Overall:'));
  assert.match(out, /Recorded between 3 Oct and 30 Oct/);
});

test('before and after: "88 ▲14", "no change", "3rd → 1st", and the verdict line', () => {
  const area = (scores) => AREAS.map((a) => ({ id: a.id, label: a.label, winners: [], tie: false, scores, why: '' }));
  const before = model({
    sites: [site('a.com', { score: 60, grade: 'D' }), site('b.com', { score: 70 }), site('c.com', { score: 80 })],
    areas: area({ 'a.com': 74, 'b.com': 70, 'c.com': 80 }),
  });
  const after = model({
    sites: [site('a.com', { score: 90, grade: 'A' }), site('b.com', { score: 71 }), site('c.com', { score: 75 })],
    areas: area({ 'a.com': 88, 'b.com': 71, 'c.com': 75 }),
  });
  const delta = compareRounds(before, after);
  const out = text(renderCompare(after, opts({ delta })));
  assert.match(out, /88 ▲14/);
  assert.match(out, /no change/);
  assert.match(out, /3rd → 1st/);
  assert.match(out, /D → A/);
  assert.match(out, /a\.com improved most \(\+30\); c\.com fell \(−5\)/);
});

test('before and after: sites in one round only', () => {
  const before = model({ sites: [site('a.com'), site('gone.com')] });
  const after = model({ sites: [site('a.com'), site('new.com')] });
  const out = text(renderCompare(after, opts({ delta: compareRounds(before, after) })));
  assert.match(out, /new in this round/);
  assert.match(out, /not in this round/);
});

test('round picker: two selects when interactive, plain text in the export', () => {
  const rounds = { list: [{ at: Date.UTC(2026, 9, 1), state: 'done' }, { at: Date.UTC(2026, 9, 30), state: 'incomplete' }], before: 0, after: 1 };
  const out = String(renderCompare(three(), opts({ rounds })));
  assert.match(out, /<select id="round-after"/);
  assert.match(out, /<select id="round-before"/);
  assert.match(out, /Compare round/);
  assert.match(out, /incomplete/);
  const doc = compareDocument(three(), opts({ rounds }), { css: '' });
  assert.doesNotMatch(doc, /<select/);
  assert.match(text(doc), /Round 2 .*against round 1/);
});

test('progress: each site and its state, and the keep-visible line', () => {
  const progress = { state: 'running', readings: [
    { url: 'https://a.com/', state: 'done' }, { url: 'https://b.com/', state: 'analysing' },
    { url: 'https://c.com/', state: 'failed', error: 'timed out' }, { url: 'https://d.com/', state: 'waiting' },
  ] };
  const out = text(renderCompare(three(), opts({ progress })));
  assert.match(out, /Site 2 of 4: b\.com, analysing/);
  assert.match(out, /Site 3 of 4: c\.com, failed: timed out/);
  assert.match(out, /Site 4 of 4: d\.com, waiting/);
  assert.match(out, /Keep the recording window visible until the round ends/);
});

test('progress: a Stop button on screen; the export has no progress card at all', () => {
  const progress = { state: 'running', readings: [{ url: 'https://a.com/', state: 'recording' }, { url: 'https://b.com/', state: 'waiting' }] };
  const page = String(renderCompare(three(), opts({ progress })));
  assert.match(page, /<button[^>]*data-stop-set[^>]*>Stop<\/button>/);
  const doc = compareDocument(three(), opts({ progress }));
  assert.doesNotMatch(doc, /cmp-progress|Keep the recording window visible|<button/);
});

test('before and after: an unchanged grade or rank shows once', () => {
  const before = model({ sites: [site('a.com', { score: 80, grade: 'B' }), site('b.com', { score: 60 })] });
  const after = model({ sites: [site('a.com', { score: 82, grade: 'B' }), site('b.com', { score: 61 })] });
  const out = text(renderCompare(after, opts({ delta: compareRounds(before, after) })));
  assert.doesNotMatch(out, /B → B|1st → 1st|2nd → 2nd/);
  assert.match(out, /B · 1st/);
});

test('gaps render in place', () => {
  const m = compareReadings([
    { key: 'https://a.com/', reading: mk('https://a.com/') },
    { key: 'https://b.com/', url: 'https://b.com/', gap: 'reading deleted' },
    { key: 'https://c.com/', url: 'https://c.com/', gap: 'not recorded: timed out' },
    { key: 'https://d.com/', reading: mk('https://d.com/', { lcp: 4000, ratings: { lcp: 'poor' } }) },
  ], plugins);
  const out = String(renderCompare(m, opts()));
  const cols = out.split('<section class="cmp-site').slice(1);
  const b = text(cols[1].slice(0, cols[1].indexOf('</section>')));
  assert.match(b, /b\.com/);
  assert.match(b, /reading deleted/);
  assert.doesNotMatch(b, /No clear|★|\d/);
  assert.match(text(cols[2]), /not recorded: timed out/);
  assert.match(cols[1], /^ gap"/);
});

test('a reading still analysing renders as a gap with that word', () => {
  const m = compareReadings([
    { key: 'https://a.com/', reading: mk('https://a.com/') },
    { key: 'https://b.com/', url: 'https://b.com/', gap: 'analysing' },
  ], plugins);
  assert.match(text(renderCompare(m, opts())), /b\.com analysing/);
});

test('site strings are escaped in page and export', () => {
  const evil = '<img src=x onerror=1>';
  const m = three();
  m.sites[0].label = evil;
  m.sites[0].host = evil;
  m.areas[0].why = evil;
  const page = String(renderCompare(m, opts({ conditions: [evil], links: { 'a.com': '"><script>' } })));
  const doc = compareDocument(m, opts({ conditions: [evil] }), { css: '' });
  for (const out of [page, doc]) {
    assert.doesNotMatch(out, /<img src=x/);
    assert.match(out, /&lt;img src=x onerror=1&gt;/);
  }
  assert.doesNotMatch(page, /"><script>/);
});

test('fixture models from compareReadings render cleanly', () => {
  const sites = [
    { key: 'https://a.com/', reading: mk('https://a.com/') },
    { key: 'https://b.com/', reading: mk('https://b.com/', { lcp: 4000, ratings: { lcp: 'poor' } }) },
  ];
  const m = compareReadings(sites, plugins);
  const out = String(renderCompare(m, opts({ conditions: conditions(sites), links: { 'https://a.com/': 'id-a' } })));
  assert.doesNotMatch(out, /undefined|NaN|\[object/);
  assert.match(out, /<a href="reading\.html\?id=id-a">a\.com<\/a>/);
  assert.match(text(out), /Overall: a\.com/);
});

test('export: no <script, no http(s) url( or src= requests, fonts inlined, links to reports are plain text', () => {
  const css = '@font-face { font-family: X; src: url("fonts/instrument-sans-latin-wght.woff2") format("woff2"); }\n@font-face { font-family: Y; src: url("fonts/missing.woff2"); }\n.x{color:red}';
  const m = three();
  const doc = compareDocument(m, opts({ links: { 'a.com': 'id-a' } }), { css, fonts: { 'fonts/instrument-sans-latin-wght.woff2': 'AAAA' } });
  assert.match(doc, /^<!doctype html>/);
  assert.doesNotMatch(doc, /<script/i);
  assert.doesNotMatch(doc, /url\(\s*["']?https?:/i);
  assert.doesNotMatch(doc, /url\(\s*["']?fonts\//);
  for (const [, src] of doc.matchAll(/src="([^"]*)"/g)) assert.match(src, /^data:/);
  assert.match(doc, /url\("data:font\/woff2;base64,AAAA"\)/);
  assert.doesNotMatch(doc, /<a /);
  assert.doesNotMatch(doc, /reading\.html/);
  assert.match(doc, /class="compare standalone"/);
  assert.doesNotMatch(doc, /<select|<button/);
  assert.match(doc, /\.x\{color:red\}/);
});

test('the profile note', () => {
  assert.match(text(renderCompare(three(), opts())), /Scored with the General profile/);
  const m = three();
  m.profile = { id: 'public', label: 'Public sector / education' };
  assert.match(text(compareDocument(m, opts(), { css: '' })), /Scored with the Public sector \/ education profile/);
});

test('notes render above the comparison', () => {
  assert.match(text(renderCompare(three(), opts({ notes: ['Showing the first 8 of 10 readings'] }))), /Showing the first 8 of 10 readings/);
});
