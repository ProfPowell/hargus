import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { LANG_TAG, cssDirection } from '../extension/plugins/international.js';
import { getPlugins } from '../extension/plugins/index.js';
import { h } from '../extension/ui/render.js';

const reading = (views) => ({ log: { entries: [], _harplus: { capture: { device: 'desktop', views } } } });
const ctx = ({ props, meta } = {}) => ({
  results: {
    ...(props ? { css: { status: 'ok', data: { usage: { properties: props } } } } : {}),
    ...(meta ? { meta: { status: 'ok', data: meta } } : {}),
  },
  target: { finalUrl: 'https://s.test/' },
  skip: (m) => { throw new Error(m); },
});
const base = { overflowX: 0, clipped: 1, rtlUnmarked: 0, dir: 'ltr' };
const titles = (out) => out.findings.map((f) => `${f.severity}:${f.title}`);

test('registered in the analyze phase, International area', () => {
  const ids = getPlugins().map((p) => p.id);
  assert.equal(ids.indexOf('international'), ids.indexOf('a11y-views') + 1);
  assert.equal(plugin.area, 'international');
});

test('language tags', () => {
  for (const ok of ['en', 'en-US', 'zh-Hant', 'zh-Hant-TW', 'es-419', 'de-CH-1996']) assert.ok(LANG_TAG.test(ok), ok);
  for (const bad of ['english', 'en_US', 'e', 'de-XX-bad!', '']) assert.ok(!LANG_TAG.test(bad), bad);
});

test('css direction counts', () => {
  assert.deepEqual(cssDirection({ 'margin-left': 15, 'padding-right': 10, left: 2, 'border-top-left-radius': 1, 'margin-inline-start': 2, 'inset-inline-end': 1, 'border-start-end-radius': 1, color: 9 }), { physical: 28, logical: 4 });
});

test('long text: clipping boundary and sideways scroll; RTL sideways', () => {
  assert.deepEqual(titles(plugin.run(reading({ desktop: base, pseudo: { ...base, clipped: 3 } }), ctx())), []);
  const out = plugin.run(reading({ desktop: base, pseudo: { ...base, clipped: 4, overflowX: 40 }, rtl: { ...base, overflowX: 12 } }), ctx());
  assert.deepEqual(titles(out), [
    'medium:Text gets cut off when translated',
    'medium:Longer text makes the page scroll sideways',
    'medium:Right-to-left layout scrolls sideways',
  ]);
  assert.deepEqual(out.summary[0], { label: 'Long text', value: '3 clipped · scrolls sideways', rating: 'poor', headline: true });
  assert.deepEqual(out.summary[1], { label: 'Right-to-left', value: 'scrolls sideways' });
});

test('RTL text without dir: boundary 0.05', () => {
  assert.deepEqual(titles(plugin.run(reading({ desktop: { ...base, rtlUnmarked: 0.049 } }), ctx())), []);
  assert.deepEqual(titles(plugin.run(reading({ desktop: { ...base, rtlUnmarked: 0.05 } }), ctx())), ['medium:Right-to-left text without dir="rtl"']);
});

test('physical CSS boundary, invalid lang, hreflang issues', () => {
  assert.deepEqual(titles(plugin.run(reading({}), ctx({ props: { 'margin-left': 19 } }))), []);
  const out = plugin.run(reading({}), ctx({
    props: { 'margin-left': 15, 'padding-right': 10, 'margin-inline-start': 2 },
    meta: {
      lang: 'english', dir: null, canonical: 'https://s.test/',
      hreflang: [{ hreflang: 'en', href: 'https://s.test/' }, { hreflang: 'fr', href: 'https://s.test/fr/' }, { hreflang: 'de-XX-bad!', href: 'https://s.test/de/' }],
    },
  }));
  assert.deepEqual(titles(out), [
    'low:Layout CSS uses left/right instead of logical properties',
    'low:lang "english" is not a valid language tag',
    'low:hreflang problems',
  ]);
  assert.equal(out.findings[2].detail, 'invalid codes: de-XX-bad!; no x-default');
});

test('clean page: no findings; skip only without any input', () => {
  const clean = plugin.run(reading({ desktop: base, pseudo: { ...base }, rtl: { ...base } }), ctx({
    props: { 'margin-inline-start': 4 },
    meta: { lang: 'en', canonical: 'https://s.test/', hreflang: [{ hreflang: 'en', href: 'https://s.test' }] },
  }));
  assert.deepEqual(clean.findings, []);
  assert.equal(clean.summary[0].value, 'fits');
  assert.throws(() => plugin.run(reading(undefined), ctx()), /no view measurements, CSS or page metadata/);
});

test('glance checklist', () => {
  const out = plugin.run(reading({ desktop: base, pseudo: { ...base, clipped: 5 }, rtl: { ...base } }), ctx({ props: { 'margin-left': 30 }, meta: { lang: 'en', hreflang: [] } }));
  const g = String(plugin.glance({ status: 'ok', ...out }, h));
  assert.match(g, /Long text fits/);
  assert.match(g, /Right-to-left fits/);
  assert.match(g, /Physical \(left\/right\)/);
});

test('hreflang: without a canonical the page URL is compared without its query string', () => {
  const run = (finalUrl) => plugin.run(reading({ desktop: base }), { ...ctx({ meta: { lang: 'en', hreflang: [{ hreflang: 'en', href: 'https://s.test/page' }] } }), target: { finalUrl } });
  assert.deepEqual(titles(run('https://s.test/page?utm_source=x')), []);
  assert.deepEqual(titles(run('https://s.test/other?utm_source=x')), ['low:hreflang problems']);
});

test('hreflang: codes are compared case-insensitively (X-Default is valid)', () => {
  const out = plugin.run(reading({ desktop: base }), ctx({ meta: { lang: 'en', canonical: 'https://s.test/', hreflang: [
    { hreflang: 'en', href: 'https://s.test/' }, { hreflang: 'fr', href: 'https://s.test/fr' }, { hreflang: 'X-Default', href: 'https://s.test/' }] } }));
  assert.deepEqual(titles(out), []);
});

test('direction row only appears when direction was measured', () => {
  const meta = { lang: 'en', hreflang: [] };
  const withDir = plugin.run(reading({ desktop: base }), ctx({ meta }));
  assert.equal(withDir.data.dirMeasured, true);
  assert.match(String(plugin.glance({ status: 'ok', ...withDir }, h)), /Text direction matches the script/);
  const without = plugin.run(reading({ desktop: { overflowX: 0, clipped: 0 } }), ctx({ meta }));
  assert.equal(without.data.dirMeasured, false);
  assert.doesNotMatch(String(plugin.glance({ status: 'ok', ...without }, h)), /Text direction matches the script/);
});

test('pseudo: sideways scroll needs ≥ 8 px and a real scroll', () => {
  assert.deepEqual(titles(plugin.run(reading({ desktop: base, pseudo: { ...base, overflowX: 2, scrollsX: true } }), ctx())), []);
  assert.deepEqual(titles(plugin.run(reading({ desktop: base, pseudo: { ...base, overflowX: 40, scrollsX: false } }), ctx())), []);
  assert.deepEqual(titles(plugin.run(reading({ desktop: base, pseudo: { ...base, overflowX: 40, scrollsX: true } }), ctx())), ['medium:Longer text makes the page scroll sideways']);
  assert.deepEqual(titles(plugin.run(reading({ desktop: base, pseudo: { ...base, overflowX: 40 } }), ctx())), ['medium:Longer text makes the page scroll sideways'], 'older readings without scrollsX');
});

test('RTL: offscreen culprit gets the inset-inline-start detail; floor and scroll test apply', () => {
  const rtl = { ...base, dir: 'rtl', overflowX: 9999, scrollsX: true, overflowers: [{ selector: 'a.skip-link', width: 120, over: 9999, side: 'left', offscreen: true }] };
  const out = plugin.run(reading({ desktop: base, rtl }), ctx());
  const f = out.findings.find((x) => x.title === 'Right-to-left layout scrolls sideways');
  assert.equal(f.severity, 'medium');
  assert.equal(f.detail, 'a.skip-link sits 9999 px off-screen. In a right-to-left page it pushes the layout sideways — position or move it with logical properties (inset-inline-start, translate with the inline direction) instead.');
  const wide = { ...rtl, overflowers: [{ selector: 'div.banner', width: 1400, over: 120, side: 'left', offscreen: false }] };
  assert.match(plugin.run(reading({ desktop: base, rtl: wide }), ctx()).findings.find((x) => /Right-to-left/.test(x.title)).detail, /^div\.banner is 1400 px wide/);
  assert.deepEqual(titles(plugin.run(reading({ desktop: base, rtl: { ...base, overflowX: 5, scrollsX: true } }), ctx())), []);
  assert.deepEqual(titles(plugin.run(reading({ desktop: base, rtl: { ...base, overflowX: 500, scrollsX: false } }), ctx())), []);
});

test('a failed rtl check: no sideways finding, an info note instead', () => {
  const r = reading({ desktop: base, rtl: { ...base, overflowX: 500, scrollsX: true } });
  r.log._harplus.capture.viewChecks = { rtl: { ok: false, detail: 'page is not right-to-left' } };
  const out = plugin.run(r, ctx());
  assert.deepEqual(titles(out), ['info:Right-to-left view could not be verified — page is not right-to-left']);
  assert.equal(out.findings[0].category, 'international');
  assert.ok(!out.summary.some((s) => s.label === 'Right-to-left'));
});

test('a failed pseudo check: no long-text findings, an info note instead', () => {
  const r = reading({ desktop: base, pseudo: { ...base, clipped: 9, overflowX: 400, scrollsX: true } });
  r.log._harplus.capture.viewChecks = { pseudo: { ok: false, detail: 'text not longer' } };
  const out = plugin.run(r, ctx());
  assert.deepEqual(titles(out), ['info:Long text view could not be verified — text not longer']);
  assert.ok(!out.summary.some((s) => s.label === 'Long text'));
});

// Translated views
const withTr = (views, translation) => { const r = reading(views); r.log._harplus.capture.translation = translation; return r; };
const ok = { status: 'ok' };

test('translated views: clipping is one finding naming each language at or above 3, quiet just below', () => {
  for (const [id, label] of [['translated-de', 'German'], ['translated-ar', 'Arabic'], ['translated-ja', 'Japanese']]) {
    const at = plugin.run(withTr({ desktop: base, [id]: { ...base, clipped: 4 } }, { [id]: ok }), ctx());
    assert.deepEqual(titles(at), [`medium:Text gets cut off when translated (${label}): up to 3 more text boxes clip`]);
    const below = plugin.run(withTr({ desktop: base, [id]: { ...base, clipped: 3 } }, { [id]: ok }), ctx());
    assert.deepEqual(titles(below), []);
  }
  // Three languages, one below threshold: one finding, two languages named, the max in the title, each count in the detail.
  const all = plugin.run(withTr({ desktop: base, 'translated-de': { ...base, clipped: 7 }, 'translated-ar': { ...base, clipped: 3 }, 'translated-ja': { ...base, clipped: 5 } },
    { 'translated-de': ok, 'translated-ar': ok, 'translated-ja': ok }), ctx());
  assert.deepEqual(titles(all), ['medium:Text gets cut off when translated (German, Japanese): up to 6 more text boxes clip']);
  assert.match(all.findings[0].detail, /German 6; Japanese 4\./);
  assert.doesNotMatch(all.findings[0].detail, /Arabic/);
});

test('translated views: sideways scroll is one finding, 8 px rule per language', () => {
  const t = { 'translated-de': ok, 'translated-ja': ok };
  const out = plugin.run(withTr({ desktop: base, 'translated-de': { ...base, overflowX: 40, scrollsX: true }, 'translated-ja': { ...base, overflowX: 12, scrollsX: true } }, t), ctx());
  assert.deepEqual(titles(out), ['medium:Translated text makes the page scroll sideways (German, Japanese)']);
  assert.match(out.findings[0].detail, /German by 40px; Japanese by 12px/);
  assert.deepEqual(titles(plugin.run(withTr({ desktop: base, 'translated-de': { ...base, overflowX: 7, scrollsX: true } }, t), ctx())), []);
  assert.deepEqual(titles(plugin.run(withTr({ desktop: base, 'translated-de': { ...base, overflowX: 40, scrollsX: false } }, t), ctx())), []);
});

test('translated views: Arabic is compared with the right-to-left view when it ran', () => {
  const t = { 'translated-ar': ok };
  const run = (ar, rtl) => plugin.run(withTr({ desktop: base, ...(rtl ? { rtl } : {}), 'translated-ar': { ...base, clipped: ar } }, t), ctx());
  assert.deepEqual(titles(run(7, { ...base, clipped: 5 })), []);
  assert.deepEqual(titles(run(8, { ...base, clipped: 5 })), ['medium:Text gets cut off when translated (Arabic): up to 3 more text boxes clip']);
  const noRtl = run(4);
  assert.match(noRtl.findings[0].detail, /Arabic 3 \(compared with the original layout; the right-to-left view did not run\)/);
});

test('translated views: leftovers are one finding naming the source language and each language over threshold', () => {
  const lo = (count, causes, extra = {}) => ({ status: 'ok', leftovers: { count, examples: ['Sale today', 'a', 'b', 'c'], causes, ...extra } });
  const out = plugin.run(withTr({ desktop: base, 'translated-de': { ...base }, 'translated-ar': { ...base }, 'translated-ja': { ...base } }, {
    'translated-de': lo(4, { iframe: 1, cssContent: 3 }), 'translated-ar': lo(3, { iframe: 1, late: 2 }), 'translated-ja': lo(8, { iframe: 3, budget: 5 }),
  }), ctx());
  assert.deepEqual(titles(out), ['low:Up to 5 pieces of text stayed in English when translated (German, Japanese)']);
  assert.match(out.findings[0].detail, /German: 1 in an embedded frame, 3 CSS-generated\./);
  assert.match(out.findings[0].detail, /Japanese: 3 in an embedded frame, 5 not translated in time\. For example: "Sale today", "a", "b"\./);
  assert.doesNotMatch(out.findings[0].detail, /Arabic|"c"/);
  assert.deepEqual(titles(plugin.run(withTr({ desktop: base, 'translated-de': { ...base } }, { 'translated-de': lo(2, { cssContent: 2 }) }), ctx())), []);
  // The source language is the page's: from the leftovers (what the view translated from), else the page's lang.
  const fr = plugin.run(withTr({ desktop: base, 'translated-de': { ...base } }, { 'translated-de': lo(3, { late: 3 }, { source: 'fr' }) }), ctx());
  assert.deepEqual(titles(fr), ['low:Up to 3 pieces of text stayed in French when translated (German)']);
  const he = plugin.run(withTr({ desktop: base, 'translated-de': { ...base } }, { 'translated-de': lo(3, { late: 3 }) }), ctx({ meta: { lang: 'iw', hreflang: [] } }));
  assert.match(titles(he).join(), /stayed in Hebrew when translated \(German\)/);
});

test('translated views: frames and canvases are not text — one grouped info note, never the 3-piece threshold', () => {
  const lo = (count, causes) => ({ status: 'ok', leftovers: { count, examples: ['frame.test'], causes } });
  const out = plugin.run(withTr({ desktop: base, 'translated-de': { ...base }, 'translated-ar': { ...base } }, {
    'translated-de': lo(4, { iframe: 3, canvas: 1 }), 'translated-ar': lo(2, { iframe: 1, late: 1 }),
  }), ctx());
  assert.deepEqual(titles(out), ["info:4 embedded areas can't be translated (German, Arabic)"]);
  assert.match(out.findings[0].detail, /German: 3 in an embedded frame, 1 drawn on a canvas\. Arabic: 1 in an embedded frame\.$/);
  assert.deepEqual(titles(plugin.run(withTr({ desktop: base, 'translated-de': { ...base } }, { 'translated-de': lo(1, { canvas: 1 }) }), ctx())), ["info:1 embedded area can't be translated (German)"]);
  // With a text finding, the frames are only part of its detail.
  const both = plugin.run(withTr({ desktop: base, 'translated-de': { ...base } }, { 'translated-de': lo(6, { iframe: 2, svg: 4 }) }), ctx());
  assert.deepEqual(titles(both), ['low:Up to 4 pieces of text stayed in English when translated (German)']);
  assert.match(both.findings[0].detail, /2 in an embedded frame, 4 inside an SVG/);
});

test('translated views: the node cap is a detail line, not a separate title', () => {
  const capped = { status: 'ok', leftovers: { count: 1, examples: [], causes: { cap: 1 }, cap: 5000 } };
  const out = plugin.run(withTr({ desktop: base, 'translated-de': { ...base } }, { 'translated-de': capped }), ctx());
  assert.deepEqual(titles(out), ['low:Text stayed in English when translated (German)']);
  assert.match(out.findings[0].detail, /German: page too long: only the first 5,000 text blocks were translated\./);
  // Alongside a language over threshold: still one finding, the capped language as a detail line.
  const mixed = plugin.run(withTr({ desktop: base, 'translated-de': { ...base }, 'translated-ja': { ...base } }, {
    'translated-de': capped, 'translated-ja': { status: 'ok', leftovers: { count: 3, examples: [], causes: { late: 3 } } },
  }), ctx());
  assert.deepEqual(titles(mixed), ['low:Up to 3 pieces of text stayed in English when translated (Japanese)']);
  assert.match(mixed.findings[0].detail, /German: page too long/);
});

test('translated views: glance has one "All text translated" item, red only when the leftovers finding fires', () => {
  const lo = (count, causes) => ({ status: 'ok', leftovers: { count, examples: [], causes } });
  const run = (tr) => plugin.run(withTr({ desktop: base, 'translated-de': { ...base }, 'translated-ar': { ...base }, 'translated-ja': { ...base } }, tr), ctx());
  const red = run({ 'translated-de': lo(3, { late: 3 }), 'translated-ar': lo(2, { late: 1, iframe: 1 }), 'translated-ja': ok });
  const g = String(plugin.glance({ status: 'ok', ...red }, h));
  assert.equal((g.match(/All text translated/g) || []).length, 1);
  assert.doesNotMatch(g, /All text translated in/);
  assert.match(g, /data-status="poor"><span class="sr-only">\(fail\)<\/span>All text translated<small>German: 3 pieces of text left; Arabic: 1 piece of text left · 1 embedded<\/small>/);
  const green = String(plugin.glance({ status: 'ok', ...run({ 'translated-de': lo(2, { late: 2 }), 'translated-ar': ok, 'translated-ja': ok }) }, h));
  assert.match(green, /data-status="good"><span class="sr-only">\(pass\)<\/span>All text translated<small>German: 2 pieces of text left<\/small>/);
  for (const l of ['German', 'Arabic', 'Japanese']) assert.match(g, new RegExp(`Fits in ${l}`));
});

test('translated views: a failed self-check reads "could not be verified"; other failures "could not run"', () => {
  const r = withTr({ desktop: base }, {
    'translated-de': { status: 'failed', reason: '40% not translated in time' },
    'translated-ar': { status: 'failed', reason: 'translation failed: boom' },
    'translated-ja': { status: 'failed' },
  });
  r.log._harplus.capture.viewChecks = { 'translated-de': { ok: false, detail: '40% not translated in time' } };
  assert.deepEqual(titles(plugin.run(r, ctx())), [
    'info:German view could not be verified — 40% not translated in time',
    'info:Arabic view could not run — translation failed: boom',
    'info:Japanese view could not run — unknown reason',
  ]);
});

test('translated views: all three failing for one page-wide reason give one note', () => {
  const fail = { status: 'failed', reason: "blocked by the site's Permissions-Policy" };
  const out = plugin.run(withTr({ desktop: base }, { 'translated-de': fail, 'translated-ar': fail, 'translated-ja': fail }), ctx());
  assert.deepEqual(titles(out), ["info:Translated views could not run — blocked by the site's Permissions-Policy"]);
});

test('translation failures with one reason make one note', () => {
  const fail = { status: 'failed', reason: 'timed out' };
  const out = plugin.run(withTr({ desktop: base, 'translated-ja': { ...base } }, { 'translated-de': fail, 'translated-ar': fail, 'translated-ja': ok }), ctx());
  assert.deepEqual(titles(out), ['info:German, Arabic views could not run — timed out']);
  // One turned off: the two that failed still share one note.
  const two = plugin.run(withTr({ desktop: base }, { 'translated-de': fail, 'translated-ar': fail, 'translated-ja': { status: 'skipped', reason: 'turned off' } }), ctx());
  assert.deepEqual(titles(two), ['info:German, Arabic views could not run — timed out']);
  // A failed self-check stays apart.
  const r = withTr({ desktop: base }, { 'translated-de': fail, 'translated-ar': fail, 'translated-ja': fail });
  r.log._harplus.capture.viewChecks = { 'translated-ja': { ok: false, detail: 'timed out' } };
  assert.deepEqual(titles(plugin.run(r, ctx())), ['info:German, Arabic views could not run — timed out', 'info:Japanese view could not be verified — timed out']);
});

test('embedded note names only frames and canvases', () => {
  const out = plugin.run(withTr({ desktop: base, 'translated-de': { ...base } }, {
    'translated-de': { status: 'ok', leftovers: { count: 4, examples: ['x'], causes: { iframe: 2, cssContent: 2 } } },
  }), ctx());
  assert.deepEqual(titles(out), ["info:2 embedded areas can't be translated (German)"]);
  assert.match(out.findings[0].detail, /2 in an embedded frame/);
  assert.doesNotMatch(out.findings[0].detail, /CSS-generated|For example/);
});

test('translated views and Long text: truncated walks never count as extra clipping', () => {
  const t = { 'translated-de': ok };
  assert.deepEqual(titles(plugin.run(withTr({ desktop: base, 'translated-de': { ...base, clipped: 40, truncated: true } }, t), ctx())), []);
  assert.deepEqual(titles(plugin.run(withTr({ desktop: { ...base, truncated: true }, pseudo: { ...base, clipped: 40 } }, {}), ctx())), []);
});

test('translated views: failed gives an info finding only, never measurements', () => {
  const out = plugin.run(withTr({ desktop: base, 'translated-de': { ...base, clipped: 20, overflowX: 300, scrollsX: true } },
    { 'translated-de': { status: 'failed', reason: 'translation unavailable in this browser' } }), ctx());
  assert.deepEqual(titles(out), ['info:German view could not run — translation unavailable in this browser']);
  assert.doesNotMatch(String(plugin.glance({ status: 'ok', ...out }, h)), /Fits in German/);
});

test('translated views: page already in German is neutral in the glance and gives no finding', () => {
  const out = plugin.run(withTr({ desktop: base }, { 'translated-de': { status: 'skipped', reason: 'page is already in German' } }), ctx());
  assert.deepEqual(titles(out), []);
  const g = String(plugin.glance({ status: 'ok', ...out }, h));
  assert.match(g, /Fits in German/);
  assert.match(g, /page is already in German/);
});

test('translated views: glance fits items with the clipped note', () => {
  const out = plugin.run(withTr({ desktop: base, 'translated-de': { ...base, clipped: 2 }, 'translated-ja': { ...base } }, { 'translated-de': ok, 'translated-ja': ok }), ctx());
  const g = String(plugin.glance({ status: 'ok', ...out }, h));
  assert.match(g, /Fits in German[\s\S]*1 more clipped/);
  assert.match(g, /Fits in Japanese/);
});

test('translated views: leftover examples stay out of the glance (counts only); the finding carries them', () => {
  const out = plugin.run(withTr({ desktop: base, 'translated-de': { ...base } }, {
    'translated-de': { status: 'ok', leftovers: { count: 3, examples: ['<script>alert(1)</script>'], causes: { svg: 3 } } },
  }), ctx());
  const g = String(plugin.glance({ status: 'ok', ...out }, h));
  assert.doesNotMatch(g, /<script>|alert/);
  assert.match(g, /All text translated<small>German: 3 pieces of text left<\/small>/);
  assert.match(out.findings[0].detail, /German: 3 inside an SVG\. For example: "<script>alert\(1\)<\/script>"/);
});
