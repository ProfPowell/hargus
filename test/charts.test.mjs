import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html, raw, esc, isRaw } from '../extension/ui/html.js';
import * as render from '../extension/ui/render.js';

test('html tag escapes values and passes raw through', () => {
  const out = html`<p title="${'"x"'}">${'<b>'}${raw('<i>ok</i>')}${['a', '&']}${null}${false}${0}</p>`;
  assert.ok(isRaw(out));
  assert.equal(String(out), '<p title="&quot;x&quot;">&lt;b&gt;<i>ok</i>a&amp;0</p>');
  assert.equal(esc("'"), '&#39;');
});

test('render.js re-exports the html helpers', () => {
  assert.equal(render.html, html);
  assert.equal(render.raw, raw);
  assert.equal(render.esc, esc);
});

import { textWidth, fitFont, RING, DONUT, innerDiameter, ring, donut, legend, foldSegments, safeColor } from '../extension/ui/charts.js';

test('ring labels fit inside 80% of the inner diameter', () => {
  for (const text of ['7', '57', '100']) {
    const fs = fitFont(text, innerDiameter(RING), 13);
    assert.ok(textWidth(text, fs) <= 0.8 * innerDiameter(RING) + 1e-9, `${text} at ${fs}`);
  }
  const fs = fitFont('1,284', innerDiameter(DONUT), 9);
  assert.ok(textWidth('1,284', fs) <= 0.8 * innerDiameter(DONUT) + 1e-9);
  assert.ok(fitFont('7', innerDiameter(RING), 13) === 13, 'short labels keep the base size');
});

test('ring markup: progress, label, status, not measured', () => {
  const s = String(ring({ value: 57, status: 'serious', label: 'Accessibility' }));
  assert.match(s, /role="img"/);
  assert.match(s, /aria-label="Accessibility: 57 of 100"/);
  assert.match(s, /stroke="var\(--st-serious\)"/);
  assert.match(s, /stroke-dasharray="57 100"/);
  assert.match(s, />57<\/text>/);
  const none = String(ring({ value: null, label: 'Security' }));
  assert.match(none, /aria-label="Security: not measured"/);
  assert.match(none, />—<\/text>/);
  assert.doesNotMatch(none, /stroke-dasharray/);
  assert.doesNotMatch(String(ring({ value: 80, showValue: false })), /<text/);
  assert.match(String(ring({ value: 50, status: 'bogus"><script>' })), /var\(--st-none\)/);
  assert.match(String(ring({ value: 1, label: '<b>' })), /&lt;b&gt;/);
});

test('donut folds small segments, labels centre, empty is blank', () => {
  const segs = 'abcdefgh'.split('').map((l, i) => ({ label: l, value: 10 - i }));
  const folded = foldSegments(segs);
  assert.equal(folded.length, 6);
  assert.deepEqual(folded.map((s) => s.label), ['a', 'b', 'c', 'd', 'e', 'Other']);
  assert.equal(folded[5].value, 5 + 4 + 3);
  const s = String(donut({ segments: segs, center: { value: '2.4', unit: 'MB' }, label: 'Page weight' }));
  assert.match(s, /aria-label="Page weight: a 10, b 9/);
  assert.match(s, />2\.4<\/text>/);
  assert.match(s, /class="unit"[^>]*>MB<\/text>/);
  assert.match(s, /<ul class="legend">/);
  assert.equal(donut({ segments: [{ label: 'x', value: 0 }] }), '');
});

test('legend escapes labels and rejects unsafe colours', () => {
  const s = String(legend([{ label: '<x>', value: 3, color: 'red;background:url(x)' }, { label: 'ok', color: 'var(--c2)' }]));
  assert.match(s, /&lt;x&gt;/);
  assert.match(s, /background:var\(--c-other\)/);
  assert.match(s, /background:var\(--c2\)/);
  assert.equal(safeColor('#abc'), '#abc');
  assert.equal(legend([]), '');
});

import { stackBar, hbars, meter, stat, spark, rate } from '../extension/ui/charts.js';

test('stackBar sizes segments by share and keeps a legend with values', () => {
  const s = String(stackBar({ label: 'Requests', segments: [{ label: 'First party', value: 86 }, { label: 'Third party', value: 62, display: '62 req' }] }));
  assert.match(s, /aria-label="Requests: First party 86, Third party 62 req"/);
  assert.match(s, /flex:58\.1;background:var\(--c1\)/);
  assert.match(s, /flex:41\.9;background:var\(--c2\)/);
  assert.match(s, /<em>62 req<\/em>/);
  assert.doesNotMatch(String(stackBar({ segments: [{ label: 'a', value: 1 }], legend: false })), /class="legend"/);
  assert.equal(stackBar({ segments: [] }), '');
});

test('hbars scale to the max and show values', () => {
  const s = String(hbars({ label: 'Hosts', rows: [{ label: 'a.com', value: 86 }, { label: 'b.com', value: 21, color: 'var(--c2)' }] }));
  assert.match(s, /width:100%;background:var\(--c1\)/);
  assert.match(s, /width:24\.4%;background:var\(--c2\)/);
  assert.match(s, /<b>86<\/b>/);
  assert.equal(hbars({ rows: [] }), '');
});

test('meter places bands, ticks and marker', () => {
  assert.equal(rate(3100, 2500, 4000), 'needs-improvement');
  assert.equal(rate(2500, 2500, 4000), 'good');
  assert.equal(rate(4001, 2500, 4000), 'poor');
  const s = String(meter({ value: 3100, good: 2500, poor: 4000, format: (v) => `${v / 1000} s`, label: 'LCP' }));
  assert.match(s, /aria-label="LCP: 3\.1 s, needs improvement \(good ≤ 2\.5 s, poor &gt; 4 s\)"/);
  assert.match(s, /class="marker" style="left:51\.7%"/);
  assert.match(s, /<span style="left:41\.7%">2\.5 s<\/span>/);
  assert.match(s, /<span style="left:66\.7%">4 s<\/span>/);
  assert.match(String(meter({ value: 99999, good: 1, poor: 2 })), /left:100%/);
  assert.equal(meter({ value: null, good: 1, poor: 2 }), '');
});

test('stat tile shows rating as a status word', () => {
  const s = String(stat({ label: 'LCP', value: '3.1 s', rating: 'needs improvement', note: 'p75' }));
  assert.match(s, /^<div class="stat">/);
  assert.doesNotMatch(s, /card|delta/);
  assert.match(s, /data-status="fair">Needs improvement/);
  assert.match(s, /<span class="stat-note">.*Needs improvement.*p75/);
  assert.doesNotMatch(String(stat({ label: 'x', value: 1 })), /status/);
});

test('spark bars scale to the tallest', () => {
  const s = String(spark([0, 5, 10], { label: 'Requests over time' }));
  assert.equal((s.match(/<i /g) || []).length, 3);
  assert.match(s, /height:100%/);
  assert.match(s, /height:4%/);
  assert.equal(spark([]), '');
});

import { icon, checklist, flow, timeline, badges } from '../extension/ui/charts.js';
import { h, renderGlance } from '../extension/ui/render.js';

test('icons: decorative by default, labelled with a title, unknown is blank', () => {
  assert.match(String(icon('high')), /aria-hidden="true"/);
  assert.match(String(icon('ok', { title: 'pass' })), /role="img" aria-label="pass"/);
  assert.equal(icon('nope'), '');
  for (const n of ['medium', 'low', 'info', 'fail', 'up', 'down', 'arrow', 'overview', 'performance', 'accessibility', 'security', 'build', 'infrastructure', 'globe', 'leaf', 'findings', 'network', 'screens', 'notes']) {
    assert.match(String(icon(n)), /<svg/, n);
  }
});

test('checklist, flow, timeline, badges', () => {
  const c = String(checklist([{ label: 'HSTS', ok: true }, { label: '<CSP>', ok: false, note: 'missing' }]));
  assert.equal((c.match(/data-status="good"/g) || []).length, 1);
  assert.equal((c.match(/data-status="poor"/g) || []).length, 1);
  assert.match(c, /&lt;CSP&gt;/);
  const f = String(flow([{ title: 'a.com', sub: 'DNS' }, { title: 'CDN' }, null, { title: 'Origin' }]));
  assert.equal((f.match(/class="arrow"/g) || []).length, 2);
  const t = String(timeline({ start: '2020-01-01', end: '2030-01-01', now: Date.parse('2025-01-01'), startLabel: 'Registered 2020', endLabel: 'Expires 2030', label: 'Domain' }));
  assert.match(t, /width:50%/);
  assert.match(t, /aria-label="Domain: Registered 2020 to Expires 2030, 50% elapsed"/);
  assert.equal(timeline({ start: 'x', end: 'y' }), '');
  const b = String(badges([{ name: 'Google Tag Manager', category: 'Tags' }, { name: 'Shopify', version: '2' }, { name: 'X' }], { limit: 2 }));
  assert.match(b, />GT<\/i>Google Tag Manager<em>Tags<\/em>/);
  assert.match(b, />S<\/i>Shopify 2/);
  assert.match(b, /\+1<\/i>more/);
});

test('h exposes the chart kit; renderGlance contains failures', () => {
  for (const k of ['ring', 'donut', 'stackBar', 'hbars', 'meter', 'stat', 'spark', 'legend', 'checklist', 'flow', 'timeline', 'icon', 'badges', 'rate']) {
    assert.equal(typeof h[k], 'function', k);
  }
  const ok = renderGlance({ name: 'P', glance: (r, hh, ctx) => hh.html`<b>${r.data.x}${ctx.target.host}</b>` }, { data: { x: 1 } }, { target: { host: 'h' } });
  assert.equal(String(ok), '<b>1h</b>');
  assert.match(String(renderGlance({ name: 'P', glance: () => { throw new Error('boom'); } }, {})), /P: chart failed — boom/);
  assert.equal(String(renderGlance({ name: 'R', remote: true, glance: () => 'x' }, {})), '');
  assert.equal(String(renderGlance({ name: 'N' }, {})), '');
});

test('checklist unknown state', () => {
  const s = String(checklist([{ label: 'cdn.test', ok: null, note: 'unknown' }]));
  assert.match(s, /data-status="none"/);
  assert.match(s, /\(unknown\)/);
});

test('sev: glyph span, data-sev, word; unknown → info; pill', () => {
  assert.match(String(h.sev('high')), /class="sev" data-sev="high"><span class="sev-ico" aria-hidden="true"><\/span>High</);
  assert.match(String(h.sev('bogus')), /data-sev="info".*Info/);
  assert.match(String(h.sev('low', { pill: true })), /class="sev sev-pill"/);
  // glyph only: the word hidden, the sr text (or the level) for screen readers
  assert.equal(String(h.sev('high', { word: false, sr: 'includes high severity' })),
    '<span class="sev" data-sev="high"><span class="sev-ico" aria-hidden="true"></span><span class="sr-only">includes high severity</span></span>');
  assert.match(String(h.sev('medium', { word: false })), /<span class="sr-only">Medium<\/span><\/span>$/);
  assert.match(String(h.sev('low', { word: false, sr: '<b>' })), /<span class="sr-only">&lt;b&gt;<\/span>/);
});
test('status escapes text and note; the word is the state, with no hidden prefix', () => {
  const s = String(h.status('poor', '<b>', 'n<'));
  assert.match(s, /data-status="poor"/); assert.ok(s.includes('&lt;b&gt;') && s.includes('n&lt;'));
  assert.equal(String(h.status('none', 'skipped')), '<span class="status" data-status="none">skipped</span>');
});
test('checks maps ok to status; checklist is the same function', () => {
  const c = String(h.checks([{ label: 'HSTS', ok: true }, { label: 'CSP', ok: false }, { label: 'cdn', ok: null }]));
  assert.match(c, /<ul class="checks">/);
  assert.deepEqual([...c.matchAll(/data-status="(\w+)"/g)].map((m) => m[1]), ['good', 'poor', 'none']);
  assert.equal(h.checklist, h.checks);
  assert.equal(checklist, h.checks);
});
test('mix: text equivalent, zero counts dropped, all-zero renders nothing', () => {
  const m = String(h.mix({ high: 6, medium: 0, low: 37, info: 35 }));
  assert.match(m, /aria-label="6 high, 37 low, 35 info"/);
  assert.ok(!m.includes('class="m"') && !m.includes('NaN'));
  assert.equal(String(h.mix({})), ''); assert.equal(String(h.mix({ high: 0 })), '');
});

test('foldSegments merges the remainder into the existing other slice and formats it', () => {
  const fmt = (n) => `${n} B`;
  const segs = [...'abcdefg'].map((l, i) => ({ label: l, value: 100 - i * 10 }));
  segs.splice(2, 0, { label: 'Other', value: 85, other: true }); // a 100, b 90, Other 85, c 80, d 70, e 60, f 50, g 40
  const out = foldSegments(segs, 6, fmt);
  assert.deepEqual(out.map((s) => s.label), ['a', 'b', 'Other', 'c', 'd', 'e']);
  const other = out.find((s) => s.other);
  assert.equal(other.value, 85 + 50 + 40); // f 50, g 40 folded in
  assert.equal(other.display, '175 B');
});

test('foldSegments with no other slice appends one formatted Other', () => {
  const segs = 'abcdefgh'.split('').map((l, i) => ({ label: l, value: 10 - i }));
  const out = foldSegments(segs, 6, (n) => `${n} B`);
  assert.deepEqual(out.map((s) => s.label), ['a', 'b', 'c', 'd', 'e', 'Other']);
  assert.equal(out[5].display, '12 B');
});

test('donut passes format to the fold: the legend never shows a bare number', () => {
  const segs = 'abcdefgh'.split('').map((l, i) => ({ label: l, value: 1000 - i, display: `${1000 - i} B` }));
  const s = String(donut({ segments: segs, format: (n) => `${n} B` }));
  assert.match(s, /<span>Other<\/span><em>2982 B<\/em>/); // f 995 + g 994 + h 993
});

test('theme.css: .sev base is scoped to [data-sev]; the legacy .sev-high rules are gone', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  assert.deepEqual(css.split('\n').filter((l) => /^\s*\.sev\s*\{/.test(l)), [], 'no bare .sev rule');
  assert.doesNotMatch(css, /^\s*\.sev-(high|medium|low|info) \{/m);
  assert.doesNotMatch(css, /\.status-dot/);
  assert.match(css, /^\s*\.sev\[data-sev\] \{/m);
});


test('sub: two-arg calls unchanged in meaning; empty content → ""; options add head parts', () => {
  assert.equal(String(h.sub('T', '')), ''); assert.equal(String(h.sub('T', [])), '');
  const s = String(h.sub('Read<', h.html`<p>x</p>`, { sub: 'Flesch 38', link: { href: '#issues', text: '2 issues' }, foot: 'f' }));
  assert.match(s, /<section class="panel sub"><div class="panel-head"><h4>Read&lt;<\/h4><span class="panel-sub">Flesch 38<\/span><a class="panel-link" href="#issues">2 issues<\/a><\/div><div class="panel-body"><p>x<\/p><\/div><div class="panel-foot">f<\/div><\/section>/);
  assert.ok(!String(h.sub('T', 'x')).includes('panel-foot'));
  assert.match(String(h.sub('T', 'x', { flush: true })), /class="panel-body flush"/);
});
test('stat: label/value/note shape with rating as status word', () => {
  const s = String(h.stat({ label: 'LCP', value: '2.6 s', rating: 'needs-improvement', note: 'p75<' }));
  assert.match(s, /<div class="stat"><span class="stat-label">LCP<\/span><div class="stat-value">2.6 s<\/div>/);
  assert.match(s, /data-status="fair">Needs improvement/); assert.ok(s.includes('p75&lt;'));
  assert.equal(String(h.stats([])), '');
  assert.match(String(h.stats([h.stat({ label: "L", value: 1 })])), /^<div class="stats"><div class="stat">/);
});
test('more: details.disclosure, empty body → ""', () => {
  assert.match(String(h.more('Hosts', 'b', '41 hosts')), /<details class="disclosure"><summary>Hosts<span class="disclosure-meta">41 hosts<\/span><\/summary><div class="disclosure-body">b<\/div><\/details>/);
  assert.equal(String(h.more('x', '')), '');
});
test('notice: paragraph, optional status glyph', () => {
  assert.equal(String(h.notice('Hi<')), '<p class="notice">Hi&lt;</p>');
  assert.match(String(h.notice('t', { state: 'fair' })), /^<p class="notice"><span class="status" data-status="fair">/);
});
test('scoreBar: band from status, clamped, null not measured', () => {
  assert.match(String(h.scoreBar({ value: 140, status: 'critical', label: 'A' })), /data-band="poor".*aria-label="A: 100 of 100".*--v:100/);
  assert.match(String(h.scoreBar({ value: null, label: 'A' })), /data-band="none".*not measured/);
});

test('checks: hidden pass/fail/unknown word per state, no doubled unknown', () => {
  const c = String(h.checks([{ label: 'HSTS', ok: true }, { label: 'CSP', ok: false }, { label: 'cdn', ok: null }]));
  assert.match(c, /sr-only">\(pass\)<\/span>HSTS/);
  assert.match(c, /sr-only">\(fail\)<\/span>CSP/);
  assert.equal((c.match(/\(unknown\)/g) || []).length, 1);
  assert.equal((c.match(/\(pass\)/g) || []).length, 1);
  assert.ok(!String(h.status('good', 'x')).includes('sr-only'));
});
test('theme.css: generated glyphs carry empty alt text so screen readers skip them', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  const decls = [...css.matchAll(/\.(?:status|sev)[^{]*(?:::before|::after)\s*\{[^}]*?content:\s*([^;}]+)/g)].map((m) => m[1].trim()).filter((d) => d !== '""');
  assert.equal(decls.length, 7, `status ×4 + sev-ico ×2 + status-strip separator, found ${decls.length}`);
  for (const d of decls) assert.match(d, /^"[^"]*" \/ ""$/, d);
});
test('theme.css: flush panel body keeps its disclosure padding; no duplicate print details-content rule', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.panel-body:not(.flush) > details.disclosure'));
  assert.ok(!css.includes('details.disclosure::details-content'));
});
test('icons use the surface token for the inner mark, not hard-coded white', () => {
  for (const n of ['high', 'medium', 'low', 'info', 'ok', 'fail']) {
    const s = String(h.icon(n));
    assert.ok(!s.includes('#fff'), n); assert.ok(s.includes('var(--surface)'), n);
  }
});
test('sub: link href restricted to #, http(s); others render text only', () => {
  const bad = String(h.sub('T', 'x', { link: { href: 'javascript:alert(1)', text: 'go' } }));
  assert.ok(!bad.includes('<a') && !bad.includes('javascript') && bad.includes('go'));
  assert.ok(!String(h.sub('T', 'x', { link: { href: ' JaVaScRiPt:1', text: 'go' } })).includes('<a'));
  assert.match(String(h.sub('T', 'x', { link: { href: 'HTTPS://a.b/', text: 'go' } })), /<a class="panel-link" href="HTTPS:\/\/a.b\/">/);
});

test('issue row: link to its key, sev word, count only when > 1, area optional, escaped', () => {
  const i = { key: 'links-broken-internal', severity: 'medium', title: '7 <broken>', count: 7, area: 'content', pluginName: 'Link check' };
  const s = String(h.issue(i));
  assert.match(s, /^<a class="issue" href="#issue-links-broken-internal">/); assert.match(s, /data-sev="medium"/);
  assert.ok(s.includes('7 &lt;broken&gt;') && s.includes('<span class="issue-count">7</span>') && s.includes('Content'));
  assert.ok(!String(h.issue({ ...i, count: 1 })).includes('>1<'));
  assert.ok(!String(h.issue(i, { showArea: false })).includes('Content'));
  assert.ok(String(h.issue(i, { current: true })).includes('aria-current="true"'));
  assert.equal(String(h.issues([])), '<p class="muted">No issues.</p>');
  assert.match(String(h.issues([i])), /^<ul class="issues"><li><a class="issue"/);
});

test('places: URL split, entry link only when interactive, bad URLs whole, escaped', () => {
  const p = String(h.places([{ status: 404, url: 'https://en.wikipedia.org/wiki/X?action=edit&redlink=1', text: 'X', region: 'main', line: 1242, selector: '#a', entry: 5 }], { interactive: true }));
  assert.match(p, /<a class="place-code" href="#network" data-entry="5"[^>]*>404<span class="sr-only"> — open request in Network<\/span><\/a>/);
  assert.ok(p.includes('<span class="url-host">en.wikipedia.org</span>') && p.includes('<span class="url-path">/wiki/X</span>') && p.includes('<span class="url-query">?action=edit&amp;redlink=1</span>'));
  assert.ok(p.includes('data-copy=') && p.includes('aria-label="Copy URL: en.wikipedia.org/wiki/X"') && p.includes('data-status-class="error"'));
  // Each copy button names its own URL; a long one is cut with an ellipsis.
  const long = String(h.places([{ url: `https://x.test/${'a'.repeat(100)}` }], { interactive: true }));
  assert.match(long, /aria-label="Copy URL: x\.test\/a{52}…"/);
  // The fragment is its own span (on-page broken links are the page URL plus a missing fragment).
  const frag = String(h.places([{ url: 'https://x.test/page?q=1#frag' }]));
  assert.ok(frag.includes('<span class="url-query">?q=1</span><span class="url-hash">#frag</span>'));
  assert.ok(!String(h.places([{ url: 'https://x.test/page' }])).includes('url-hash'));
  assert.ok(!String(h.places([{ status: 404, url: 'https://a/b', entry: 5 }])).includes('<a class="place-code"'));
  assert.ok(!String(h.places([{ url: 'https://a/b' }])).includes('class="copy"'));
  for (const url of ['/rel/path', 'data:text/html,<b>', 'x'.repeat(2000), 'http://[bad']) assert.doesNotThrow(() => String(h.places([{ url }])));
  assert.ok(String(h.places([{ url: 'data:text/html,<b>' }])).includes('&lt;b&gt;'));
  assert.equal(String(h.places([])), '');
});

test('h.sev maps critical to high and serious to medium', () => {
  assert.match(String(h.sev('critical')), /data-sev="high"/);
  assert.match(String(h.sev('serious')), /data-sev="medium"/);
  assert.match(String(h.sev('warning')), /data-sev="info"/);
});

test('table folds past 8 rows: first 8 shown, the rest under "N more" with the same header; fold:false opts out', () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ a: i }));
  const s = String(h.table(rows, ['a']));
  assert.equal((s.match(/<tr><td>/g) || []).length, 11);
  assert.match(s, /<details class="disclosure fold"><summary>3 more<\/summary>[^]*<thead>/);
  assert.equal((s.match(/<thead>/g) || []).length, 2, 'the folded rows keep the same header');
  assert.ok(s.indexOf('<td>7</td>') < s.indexOf('class="disclosure fold"') && s.indexOf('<td>8</td>') > s.indexOf('class="disclosure fold"'));
  assert.ok(!String(h.table(rows, ['a'], { fold: false })).includes('class="disclosure fold"'));
  assert.ok(!String(h.table(rows.slice(0, 8), ['a'])).includes('fold'));
  assert.match(String(h.table(rows, ['a'], { fold: 4 })), /<summary>7 more<\/summary>/);
  // Only a positive integer sets the fold; anything else (true, 0, 2.5, "3") is the default 8.
  for (const fold of [true, 0, -1, 2.5, '3', null]) assert.match(String(h.table(rows, ['a'], { fold })), /<summary>3 more<\/summary>/, String(fold));
  assert.match(String(h.list(rows.map((r) => r.a), { fold: true })), /<summary>3 more<\/summary>/);
});

test('list folds the same way', () => {
  const items = Array.from({ length: 10 }, (_, i) => `x${i}`);
  const s = String(h.list(items));
  assert.equal((s.match(/<li>/g) || []).length, 10);
  assert.match(s, /^<ul class="plain">(<li>x\d<\/li>){8}<\/ul><details class="disclosure fold"><summary>2 more<\/summary>[^]*<ul class="plain"><li>x8<\/li><li>x9<\/li><\/ul>/);
  assert.ok(!String(h.list(items, { fold: false })).includes('fold'));
  assert.ok(!String(h.list(items.slice(0, 8))).includes('fold'));
  assert.ok(!String(h.list([...items.slice(0, 8), '', null])).includes('fold'), 'empties are dropped before counting');
});

test('link with no text renders URL parts; with text, plain', () => {
  assert.match(String(h.link('https://a.test/p?q=1')), /<a [^>]*><span class="url"[^>]*><span class="url-host">a\.test<\/span>/);
  assert.match(String(h.link('https://a.test/p?q=1', 'https://a.test/p?q=1')), /<span class="url-query">\?q=1<\/span>/);
  assert.ok(!String(h.link('https://a.test/', 'Home')).includes('url-host'));
  assert.match(String(h.link('https://a.test/', 'Home')), /<a href="https:\/\/a\.test\/"[^>]*>Home<\/a>/);
  assert.equal(String(h.link('javascript:alert(1)')), 'javascript:alert(1)', 'non-http URLs are never linked');
  assert.match(String(h.url('https://a.test/p#h')), /^<span class="url" title="https:\/\/a\.test\/p#h"><span class="url-host">a\.test<\/span><span class="url-path">\/p<\/span><span class="url-hash">#h<\/span><\/span>$/);
  assert.ok(String(h.url('/rel?<x>')).includes('&lt;x&gt;'));
});

test('theme.css: smart URL rules reach panels, not the hero or the network table; fold styled', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  assert.match(css, /:is\(\.panel, details\.plugin, \.places\) span\.url \{/);
  assert.match(css, /\.hero \.url \{ font: 0\.85rem var\(--font-mono\); overflow-wrap: anywhere; \}/);
  assert.match(css, /\.net td\.url \{/);
  assert.match(css, /details\.disclosure\.fold/);
  assert.ok(!css.replace(/\/\*[^]*?\*\//g, '').includes('<'));
});
