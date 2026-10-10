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
