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

test('stat tile shows rating icon and word', () => {
  const s = String(stat({ label: 'LCP', value: '3.1 s', rating: 'needs improvement', note: 'p75' }));
  assert.match(s, /class="stat card"/);
  assert.match(s, /class="delta rating-needs-improvement"/);
  assert.match(s, /Needs improvement/);
  assert.match(s, /p75/);
  assert.doesNotMatch(String(stat({ label: 'x', value: 1 })), /rating-/);
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
});
test('status escapes text and note; none carries hidden unknown', () => {
  const s = String(h.status('poor', '<b>', 'n<'));
  assert.match(s, /data-status="poor"/); assert.ok(s.includes('&lt;b&gt;') && s.includes('n&lt;'));
  assert.match(String(h.status('none', 'x')), /sr-only">\(unknown\)/);
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

test('theme.css: new .sev base is scoped to [data-sev]; legacy .sev-high colour is not overridden', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../extension/ui/theme.css', import.meta.url), 'utf8');
  assert.deepEqual(css.split('\n').filter((l) => /^\s*\.sev\s*\{/.test(l)), [], 'no bare .sev rule (would out-rank legacy .sev-high colour)');
  assert.match(css, /^\s*\.sev-high \{ color: var\(--high\); \}/m);
  assert.match(css, /^\s*\.sev\[data-sev\] \{/m);
});

