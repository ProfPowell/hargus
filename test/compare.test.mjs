import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIE_POINTS, TIE_PCT, FLOOR, MAX_SITES, STRIP_AT, rankScores, rankMetric, compareReadings, siteLabel, DATE_SPREAD_DAYS, conditions, compareRounds,
} from '../extension/core/compare.js';
import { METRICS, formatMetric } from '../extension/core/metrics.js';
import { getPlugins } from '../extension/plugins/index.js';

const plugins = getPlugins();
const M = (id) => METRICS.find((m) => m.id === id);
const result = (id, data, findings = []) => ({ id, name: id, status: 'ok', data, findings, summary: [] });
const entry = (url, bytes = 1000) => ({ request: { url }, response: { _transferSize: bytes, content: {} } });

// A reading with vitals timings, optional Lighthouse lab scores and run samples.
function mk(url, { lcp = 2000, fcp = 500, ttfb = 100, cls = 0, tbt = 0, load = 3000, ratings = { lcp: 'good' }, lab, samples, extra = {} } = {}) {
  const ps = lab ? { pagespeed: result('pagespeed', { lab: { scores: lab } }), axe: result('axe', {}) } : {};
  return {
    log: {
      entries: [entry(url), entry(`${url}app.js`)],
      _harplus: {
        id: url, capturedAt: '2026-10-31T10:00:00.000Z',
        target: { url, finalUrl: url, host: new URL(url).hostname },
        screenshots: [],
        plugins: {
          vitals: result('vitals', { lcp: { time: lcp }, fcp, cls, blockingTime: tbt, navigation: { ttfb, load }, ratings }),
          ...ps,
          ...extra,
        },
        ...(samples ? { runs: { samples } } : {}),
      },
    },
  };
}
const sites = (...readings) => readings.map((reading, i) => ({ key: 'abcdefgh'[i], reading }));
const sample = (o) => ({ lcp: 2000, fcp: 500, ttfb: 100, cls: 0, blockingTime: 0, load: 3000, ...o });

test('constants', () => {
  assert.equal(TIE_POINTS, 3);
  assert.equal(TIE_PCT, 0.10);
  assert.deepEqual(FLOOR, { ms: 100, cls: 0.02, count: 1, bytes: 10240, grams: 0.02 });
  assert.equal(MAX_SITES, 8);
  assert.equal(STRIP_AT, 5);
});

test('rankScores: within 3 points is a tie', () => {
  const r = rankScores([{ key: 'a', score: 90 }, { key: 'b', score: 88 }, { key: 'c', score: 70 }]);
  assert.deepEqual(r.winners, ['a', 'b']);
  assert.equal(r.tie, true);
  assert.deepEqual(r.order, ['a', 'b', 'c']);
  const s = rankScores([{ key: 'a', score: 90 }, { key: 'b', score: 86 }]);
  assert.deepEqual(s.winners, ['a']);
  assert.equal(s.tie, false);
  const n = rankScores([{ key: 'a', score: null }, { key: 'b', score: 50 }]);
  assert.deepEqual(n.winners, ['b']);
  assert.deepEqual(n.order, ['b']);
});

test('rankMetric: run ranges that overlap tie', () => {
  const lcp = M('lcp');
  const r = rankMetric(lcp, [
    { key: 'a', value: 2100, range: { min: 1900, max: 2300, n: 3 } },
    { key: 'b', value: 2350, range: { min: 2100, max: 2600, n: 3 } },
  ]);
  assert.equal(r.tie, true);
  assert.deepEqual(r.winners, ['a', 'b']);
  assert.equal(r.best, null);
  assert.equal(r.worst, null);
  assert.equal(r.shown, true);
  assert.equal(rankMetric(lcp, [{ key: 'a', value: 2000 }, { key: 'b', value: 2150 }]).tie, true);
  const far = rankMetric(lcp, [{ key: 'a', value: 2000 }, { key: 'b', value: 2400 }]);
  assert.equal(far.tie, false);
  assert.deepEqual(far.winners, ['a']);
  assert.equal(far.best, 'a');
  assert.equal(far.worst, 'b');
});

test('rankMetric: ranges that do not overlap decide alone', () => {
  const r = rankMetric(M('lcp'), [
    { key: 'a', value: 2000, range: { min: 1990, max: 2010, n: 3 } },
    { key: 'b', value: 2100, range: { min: 2090, max: 2110, n: 3 } },
  ]);
  assert.equal(r.tie, false);
  assert.equal(r.best, 'a');
});

test('rankMetric: floor beats pct for small values', () => {
  assert.equal(rankMetric(M('ttfb'), [{ key: 'a', value: 50 }, { key: 'b', value: 120 }]).tie, true);
  assert.equal(rankMetric(M('cls'), [{ key: 'a', value: 0.01 }, { key: 'b', value: 0.025 }]).tie, true);
  assert.equal(rankMetric(M('requests'), [{ key: 'a', value: 3 }, { key: 'b', value: 5 }]).tie, false);
});

test('rankMetric: higher is better for securityHeaders', () => {
  const r = rankMetric(M('securityHeaders'), [{ key: 'a', value: 3 }, { key: 'b', value: 6 }]);
  assert.deepEqual(r.winners, ['b']);
  assert.equal(r.best, 'b');
  assert.equal(r.worst, 'a');
});

test('rankMetric: fewer than 2 values is not shown; missing values are left out', () => {
  const r = rankMetric(M('lcp'), [{ key: 'a', value: 2000 }, { key: 'b', value: null }, { key: 'c', value: NaN }]);
  assert.deepEqual(r, { winners: [], tie: false, best: null, worst: null, shown: false });
});

test('rankMetric: a tie at the top still names an outright last place, and vice versa', () => {
  const r = rankMetric(M('requests'), [{ key: 'a', value: 10 }, { key: 'b', value: 10 }, { key: 'c', value: 30 }]);
  assert.deepEqual(r.winners, ['a', 'b']);
  assert.equal(r.best, null);
  assert.equal(r.worst, 'c');
  const s = rankMetric(M('requests'), [{ key: 'a', value: 5 }, { key: 'b', value: 30 }, { key: 'c', value: 30 }]);
  assert.equal(s.best, 'a');
  assert.equal(s.worst, null);
});

test('the why names the biggest relative gap between winner and last place', () => {
  const a = mk('https://a.test/', { lcp: 2000, fcp: 500, ratings: { lcp: 'good' } });
  const b = mk('https://b.test/', { lcp: 3400, fcp: 600, ratings: { lcp: 'poor' } });
  const model = compareReadings(sites(a, b), plugins, {});
  const perf = model.areas.find((x) => x.id === 'performance');
  assert.deepEqual(perf.winners, ['a']);
  assert.equal(perf.why, `LCP ${formatMetric('lcp', 2000)} vs ${formatMetric('lcp', 3400)}`);
  assert.equal(perf.why, 'LCP 2.00 s vs 3.40 s');
});

test('strengths are outright wins ordered by margin, then area wins fill in', () => {
  const a = mk('https://a.test/', { lcp: 2000, lab: { accessibility: 0.85 } });
  const b = mk('https://b.test/', { lcp: 3400, lab: { accessibility: 0.70 } });
  const model = compareReadings(sites(a, b), plugins, {});
  const [sa, sb] = model.sites;
  assert.equal(model.areas.find((x) => x.id === 'accessibility').scores.a, 90);
  assert.deepEqual(sa.strengths, [{ label: 'Fastest LCP', value: formatMetric('lcp', 2000) }, { label: 'Best Accessibility', value: '90' }]);
  assert.deepEqual(sa.weaknesses, []);
  assert.deepEqual(sb.strengths, []);
  assert.deepEqual(sb.weaknesses, [{ label: 'Slowest LCP', value: formatMetric('lcp', 3400) }, { label: 'Worst Accessibility', value: '80' }]);
});

test('strengths order by margin and stop at two', () => {
  const a = mk('https://a.test/', { lcp: 2000, fcp: 500, load: 2000 });
  const b = mk('https://b.test/', { lcp: 2500, fcp: 1500, load: 6000 });
  const model = compareReadings(sites(a, b), plugins, {});
  // margins: fcp 67%, load 67% (tied; display order keeps fcp first), lcp 20%
  assert.deepEqual(model.sites[0].strengths.map((s) => s.label), ['Fastest FCP', 'Fastest load']);
  assert.equal(model.sites[0].strengths.length, 2);
  assert.equal(model.faceoff.wins.a, 3);
  assert.equal(model.faceoff.wins.b ?? 0, 0);
});

test('all tied: no winner, no strengths', () => {
  const model = compareReadings(sites(mk('https://a.test/'), mk('https://b.test/'), mk('https://c.test/')), plugins, {});
  assert.equal(model.overall.tie, true);
  assert.deepEqual(model.overall.winners, ['a', 'b', 'c']);
  for (const s of model.sites) {
    assert.deepEqual(s.strengths, []);
    assert.deepEqual(s.weaknesses, []);
  }
  assert.equal(model.faceoff.ties, model.faceoff.total);
  assert.ok(model.metrics.every((m) => m.tie && m.best === null && m.worst === null));
});

test('unmeasured and missing values never win or lose', () => {
  const a = mk('https://a.test/', { lcp: 2000, lab: { accessibility: 0.85 } });
  const b = mk('https://b.test/', { lcp: 3000, lab: { accessibility: 0.70 } });
  const c = { log: { entries: [entry('https://c.test/')], _harplus: { id: 'c', target: { url: 'https://c.test/', finalUrl: 'https://c.test/', host: 'c.test' }, screenshots: [], plugins: { axe: result('axe', {}) } } } };
  const model = compareReadings(sites(a, b, c), plugins, {});
  const perf = model.areas.find((x) => x.id === 'performance');
  assert.equal(perf.scores.c, null);
  assert.ok(!perf.winners.includes('c'));
  const sc = model.sites[2];
  assert.ok(!sc.weaknesses.some((w) => /Slowest/.test(w.label)));
  const lcp = model.metrics.find((m) => m.id === 'lcp');
  assert.deepEqual(lcp.values.c, { value: null, text: '—' });
  assert.notEqual(lcp.worst, 'c');
  assert.ok(!JSON.stringify(model).includes('NaN'));
});

test('an area only one site measured has no winner', () => {
  const a = mk('https://a.test/', { lab: { accessibility: 0.85 } });
  const b = mk('https://b.test/');
  const model = compareReadings(sites(a, b), plugins, {});
  const acc = model.areas.find((x) => x.id === 'accessibility');
  assert.deepEqual(acc.winners, []);
  assert.equal(acc.why, '');
  assert.ok(!model.sites[0].strengths.some((s) => s.label === 'Best Accessibility'));
});

test('gaps take no part', () => {
  const a = mk('https://a.test/', { lcp: 2000 });
  const b = mk('https://b.test/', { lcp: 3400 });
  const model = compareReadings([...sites(a, b), { key: 'z', gap: 'reading deleted' }], plugins, {});
  const z = model.sites.find((s) => s.key === 'z');
  assert.equal(z.gap, 'reading deleted');
  assert.equal(z.score, null);
  assert.deepEqual(z.strengths, []);
  assert.deepEqual(z.weaknesses, []);
  assert.ok(!model.overall.winners.includes('z'));
  assert.ok(!('z' in model.overall.areaWins));
  for (const ar of model.areas) {
    assert.ok(!ar.winners.includes('z'));
    assert.ok(!('z' in ar.scores));
  }
  for (const m of model.metrics) {
    assert.ok(!m.winners.includes('z'));
    assert.ok(!('z' in m.values));
    assert.notEqual(m.best, 'z');
    assert.notEqual(m.worst, 'z');
  }
  assert.ok(!('z' in model.faceoff.wins));
});

test('the model carries the profile, overall wins and each site header', () => {
  const a = mk('https://a.test/', { lcp: 2000, ratings: { lcp: 'good' } });
  a.log._harplus.screenshots = [{ kind: 'thumbnail', mimeType: 'image/png', data: 'AAAA' }];
  const b = mk('https://b.test/', { lcp: 3400, ratings: { lcp: 'poor' } });
  const model = compareReadings(sites(a, b), plugins, { profile: 'public' });
  assert.deepEqual(model.profile, { id: 'public', label: 'Public sector / education' });
  assert.deepEqual(model.overall.winners, ['a']);
  assert.equal(model.overall.tie, false);
  assert.equal(model.overall.areaWins.a, 1);
  assert.equal(model.overall.areaWins.b, 0);
  const [sa] = model.sites;
  assert.equal(sa.host, 'a.test');
  assert.equal(sa.label, 'a.test');
  assert.equal(sa.url, 'https://a.test/');
  assert.equal(sa.thumb, 'data:image/png;base64,AAAA');
  assert.equal(sa.capturedAt, '2026-10-31T10:00:00.000Z');
  assert.equal(typeof sa.score, 'number');
  assert.ok(sa.grade);
  assert.ok(sa.status);
  assert.equal(sa.favicon, null);
  assert.ok(!('gap' in sa));
  assert.deepEqual(Object.keys(model.areas[0].scores), ['a', 'b']);
});

test('the favicon is the first declared icon with an image body', () => {
  const a = mk('https://a.test/', {
    extra: { meta: result('meta', { icons: [{ rel: 'icon', href: 'https://a.test/missing.ico' }, { rel: 'icon', href: 'https://a.test/f.png' }] }) },
  });
  a.log.entries.push({ request: { url: 'https://a.test/missing.ico' }, response: { content: { mimeType: 'text/html', text: '<p>404' } } });
  a.log.entries.push({ request: { url: 'https://a.test/f.png' }, response: { content: { mimeType: 'image/png', text: 'iVBO', encoding: 'base64' } } });
  const model = compareReadings(sites(a, mk('https://b.test/')), plugins, {});
  assert.equal(model.sites[0].favicon, 'data:image/png;base64,iVBO');
  assert.equal(model.sites[1].favicon, null);
  const svg = mk('https://c.test/', { extra: { meta: result('meta', { icons: [{ rel: 'icon', href: 'https://c.test/i.svg' }] }) } });
  svg.log.entries.push({ request: { url: 'https://c.test/i.svg' }, response: { content: { mimeType: 'image/svg+xml', text: '<svg/>' } } });
  const fav = compareReadings(sites(svg, mk('https://b.test/')), plugins, {}).sites[0].favicon;
  assert.equal(fav, `data:image/svg+xml;base64,${btoa('<svg/>')}`);
});

test('compareReadings does not mutate readings', () => {
  const a = mk('https://a.test/', { lcp: 2000 });
  const b = mk('https://b.test/', { lcp: 3400 });
  const before = JSON.stringify([a, b]);
  compareReadings(sites(a, b), plugins, {});
  assert.equal(JSON.stringify([a, b]), before);
});

test('metric rows: only shown metrics, with values and text', () => {
  const model = compareReadings(sites(mk('https://a.test/', { lcp: 2000 }), mk('https://b.test/', { lcp: 3400 })), plugins, {});
  const lcp = model.metrics.find((m) => m.id === 'lcp');
  assert.deepEqual(lcp.values.a, { value: 2000, text: formatMetric('lcp', 2000) });
  assert.equal(lcp.area, 'performance');
  assert.equal(lcp.label, 'LCP');
  assert.deepEqual(lcp.winners, ['a']);
  assert.ok(!model.metrics.some((m) => m.id === 'carbon')); // neither reading has it
  assert.equal(model.faceoff.total, model.metrics.length);
  assert.equal(model.faceoff.wins.a + (model.faceoff.wins.b || 0) + model.faceoff.ties, model.faceoff.total);
});

test('layout switches at 5 sites', () => {
  const list = (n) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, reading: mk(`https://s${i}.test/`) }));
  assert.equal(compareReadings(list(4), plugins, {}).layout, 'columns');
  assert.equal(compareReadings(list(5), plugins, {}).layout, 'strip');
});

test('siteLabel adds the path only when hosts repeat', () => {
  const all = ['https://a.test/', 'https://a.test/about', 'https://b.test/x'];
  assert.equal(siteLabel('https://a.test/', all), 'a.test/');
  assert.equal(siteLabel('https://a.test/about', all), 'a.test/about');
  assert.equal(siteLabel('https://b.test/x', all), 'b.test');
  assert.equal(siteLabel('https://a.test/', ['https://a.test/', 'https://a.test/']), 'a.test');
  const model = compareReadings(sites(mk('https://a.test/'), mk('https://a.test/about')), plugins, {});
  assert.deepEqual(model.sites.map((s) => s.label), ['a.test/', 'a.test/about']);
});

test('singleRunNote is true when any timing comes from a 1-run reading', () => {
  const runs = [sample({ lcp: 1900 }), sample({ lcp: 2100 })];
  const multi = () => mk('https://a.test/', { samples: runs });
  assert.equal(compareReadings(sites(multi(), mk('https://b.test/', { samples: runs })), plugins, {}).singleRunNote, false);
  assert.equal(compareReadings(sites(multi(), mk('https://b.test/')), plugins, {}).singleRunNote, true);
  assert.equal(compareReadings([...sites(multi(), multi()), { key: 'z', gap: 'not recorded: timed out' }], plugins, {}).singleRunNote, false);
});

test('rankMetric: a last place that is also a winner is not the worst', () => {
  const r = rankMetric(M('lcp'), [
    { key: 'a', value: 2000, range: { min: 1000, max: 3000 } },
    { key: 'b', value: 2100, range: { min: 2090, max: 2110 } },
    { key: 'c', value: 2200, range: { min: 2190, max: 2210 } },
  ]);
  assert.deepEqual(r.winners, ['a', 'b', 'c']);
  assert.equal(r.worst, null);
});

// A reading with a given date and capture settings.
function dated(url, at, capture, runs) {
  const r = mk(url);
  r.log._harplus.capturedAt = at;
  if (capture) r.log._harplus.capture = capture;
  if (runs) r.log._harplus.runs = runs;
  return r;
}
const cs = (...rs) => rs.map((reading, i) => ({ key: 'abc'[i], reading }));
const T = '2026-10-31T10:00:00Z';

test('DATE_SPREAD_DAYS is 7', () => {
  assert.equal(DATE_SPREAD_DAYS, 7);
});

test('conditions: a single mobile site is named', () => {
  const m = dated('https://ucsd.edu/', T, { device: 'mobile' });
  const l = conditions(cs(m, dated('https://b.test/', T), dated('https://c.test/', T, { device: 'desktop' })));
  assert.deepEqual(l, ['ucsd.edu was recorded on mobile, the others on desktop']);
});

test('conditions: no single minority lists every value', () => {
  const l = conditions(cs(dated('https://a.test/', T, { device: 'mobile' }), dated('https://b.test/', T, { device: 'desktop' }), dated('https://c.test/', T, { device: 'tablet' })));
  assert.deepEqual(l, ['Devices differ: a.test mobile, b.test desktop, c.test tablet']);
});

test('conditions: runs, coverage and mode differences each give one line', () => {
  const base = { runs: 3, coverage: false, mode: 'reload' };
  const odd = { runs: 1, coverage: true, mode: 'snapshot' };
  const l = conditions(cs(dated('https://a.test/', T, base), dated('https://b.test/', T, base), dated('https://harvard.edu/', T, odd)));
  assert.deepEqual(l, [
    'harvard.edu used 1 run, the others 3',
    'harvard.edu was recorded with coverage on, the others off',
    'harvard.edu was recorded in snapshot mode, the others in reload',
  ]);
});

test('conditions: dates more than 7 days apart', () => {
  const l = conditions(cs(dated('https://a.test/', '2026-10-03T10:00:00Z'), dated('https://b.test/', '2026-10-30T10:00:00Z')));
  assert.deepEqual(l, ['Recorded between 3 Oct and 30 Oct']);
  assert.deepEqual(conditions(cs(dated('https://a.test/', '2026-10-03T10:00:00Z'), dated('https://b.test/', '2026-10-09T10:00:00Z'))), []);
});

test('conditions: alike readings give [] and gaps and missing settings are fine', () => {
  const full = { device: 'desktop', throttle: 'none', bypassCache: true, runs: 1, coverage: false, mode: 'reload' };
  assert.deepEqual(conditions([...cs(dated('https://a.test/', T), dated('https://b.test/', T, full)), { key: 'z', gap: 'not recorded: x' }]), []);
});

test('conditions: skipped runs are named', () => {
  const skipped = [{ run: 2, reason: 'tab was hidden' }, { run: 3, reason: 'tab was hidden' }];
  const l = conditions(cs(dated('https://a.test/', T, { runs: 3 }), dated('https://stanford.edu/', T, { runs: 1 }, { skipped })));
  assert.deepEqual(l, ['stanford.edu: 1 of 3 runs']);
});

// A hand-built Model with the given overall scores, area scores and LCP values; labels equal keys.
function model(scores, { perf = scores, lcp = {} } = {}) {
  return {
    sites: Object.keys(scores).map((key) => ({ key, label: key, score: scores[key], grade: 'B' })),
    areas: [{ id: 'performance', scores: perf }],
    metrics: Object.keys(lcp).length ? [{ id: 'lcp', values: Object.fromEntries(Object.entries(lcp).map(([k, v]) => [k, { value: v }])) }] : [],
  };
}

test('compareRounds: change, rank and verdict', () => {
  const d = compareRounds(model({ a: 70, b: 80 }), model({ a: 79, b: 75 }));
  const a = d.sites.find((s) => s.key === 'a');
  assert.equal(a.score.change, 9);
  assert.deepEqual(a.rank, { before: 2, after: 1 });
  assert.equal(a.status, 'both');
  assert.equal(d.verdict, 'a improved most (+9); b fell (−5)');
});

test('compareRounds: within 3 points is no change', () => {
  const d = compareRounds(model({ a: 70, b: 80 }), model({ a: 72, b: 78 }, { perf: { a: 73, b: 77 } }));
  assert.equal(d.verdict, 'No site changed by more than 3 points');
  assert.equal(d.areas[0].changes.a.same, true);
  assert.equal(d.areas[0].changes.a.change, 3);
});

test('compareRounds: metrics use the tie rule', () => {
  const d = compareRounds(model({ a: 70, b: 70 }, { lcp: { a: 2000, b: 2000 } }), model({ a: 70, b: 70 }, { lcp: { a: 2050, b: 3000 } }));
  const m = d.metrics.find((x) => x.id === 'lcp');
  assert.deepEqual(m.changes.a, { before: 2000, after: 2050, same: true });
  assert.equal(m.changes.b.same, false);
});

test('compareRounds: new and gone sites', () => {
  const d = compareRounds(model({ a: 70, b: 80 }), model({ a: 70, c: 60 }));
  const by = Object.fromEntries(d.sites.map((s) => [s.key, s]));
  assert.equal(by.b.status, 'gone');
  assert.equal(by.c.status, 'new');
  assert.equal(by.c.score.change, null);
  assert.equal(by.c.rank.before, null);
  assert.equal(by.b.rank.after, null);
});

test('compareRounds: one site, two rounds works', () => {
  const d = compareRounds(model({ a: 60 }), model({ a: 70 }));
  assert.equal(d.sites[0].score.change, 10);
  assert.deepEqual(d.sites[0].rank, { before: 1, after: 1 });
  assert.equal(d.verdict, 'a improved most (+10)');
});

test('the why prefers a metric the winner took outright', () => {
  // a wins performance; b has the best LCP by far, so a is only better than c there, but a is best on FCP.
  const a = mk('https://a.test/', { lcp: 2500, fcp: 200, ttfb: 140, ratings: { lcp: 'good' } });
  const b = mk('https://b.test/', { lcp: 1000, fcp: 450, ttfb: 100, tbt: 900, cls: 0.4, ratings: { lcp: 'poor' } });
  const c = mk('https://c.test/', { lcp: 9000, fcp: 600, ttfb: 400, ratings: { lcp: 'poor' } });
  const m = compareReadings(sites(a, b, c), plugins, {});
  const perf = m.areas.find((x) => x.id === 'performance');
  assert.deepEqual(perf.winners, ['a']);
  assert.match(perf.why, /^FCP /);
});
