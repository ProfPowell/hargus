import { test } from 'node:test';
import assert from 'node:assert/strict';
import html from '../extension/plugins/html.js';
import { h } from '../extension/ui/render.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';

const collected = (over = {}) => ({
  total: 400, elements: { div: 200, span: 60, main: 1, header: 1, nav: 1, footer: 1, p: 40, center: 2, font: 1, 'x-card': 3 },
  attrPairs: { 'td.align': 4, 'img.border': 1, 'img.loading': 3 }, globalAttrs: {}, handlers: { onclick: 3, onload: 1 },
  dataAttrs: [['data-x', 5]], dataAttrCount: 5, roles: { button: 2 }, aria: 12, inlineStyles: 7, lang: 0,
  classes: ['a', 'b'], classAttrs: 10, classTokens: 20, ids: 4, inputTypes: {}, linkRels: { icon: 1 }, scriptTypes: { classic: 2 },
  imgExt: { png: 2 }, media: { img: 2, picture: 0, srcset: 0, sizes: 0, lazy: 0, decodingAsync: 0, fetchpriority: 0, sized: 0, svgInline: 0, video: 0, audio: 0, track: 0, canvas: 0, iframe: 0, iframeLazy: 0, iframeSandbox: 0 },
  forms: { count: 0, autocomplete: 0, validation: 0, novalidate: 0, fieldset: 0, labels: 0 },
  components: { customTags: ['x-card'], defined: 1, undefinedCount: 0, shadowRoots: 2, shadowHosts: ['x-card'], templates: 0, slots: 0, dsd: 0, customizedBuiltins: 0 },
  a11yHints: { blankNoOpener: 0, fakeButtons: 0, clickDivs: 0, tabindex: 0, ariaHidden: 0 },
  doctype: '<!DOCTYPE html>', vueScoped: 0, angularScoped: 0, astroScoped: 0, errors: [], ...over,
});
const run = (c) => html.run({}, { collected: c, skip: (m) => { throw new Error(m); } });
const find = (r, re) => r.findings.find((f) => re.test(f.title));

/** A plugin's output as the saved reading keeps it (through normalize). */
const saved = async (out) => {
  const reading = createReading({ entries: [], target: makeTarget('https://s.test/', 'S', 'https://s.test/') });
  await runPlugins(reading, [{ id: 'n', name: 'N', phase: 'analyze', run: async () => out }], {});
  return reading.log._harplus.plugins.n;
};

test('places: obsolete elements, presentational attributes and inline handlers as selectors with counts; evidence unchanged', () => {
  const r = run(collected());
  const obsolete = find(r, /^Obsolete HTML elements$/);
  assert.equal(obsolete.evidence, '<center> ×2, <font> ×1');
  assert.deepEqual(obsolete.places, [{ selector: 'center', note: '×2' }, { selector: 'font', note: '×1' }]);
  const pres = find(r, /^Presentational HTML attributes/);
  assert.equal(pres.evidence, 'td.align ×4, img.border ×1');
  assert.deepEqual(pres.places, [{ selector: 'td[align]', note: '×4' }, { selector: 'img[border]', note: '×1' }]);
  const handlers = find(r, /inline event-handler attributes$/);
  assert.equal(handlers.title, '4 inline event-handler attributes');
  assert.equal(handlers.evidence, 'onclick ×3, onload ×1');
  assert.equal(handlers.detail, 'on* attributes mix behaviour into markup and block a strict CSP.');
  assert.deepEqual(handlers.places, [{ selector: '[onclick]', note: '×3' }, { selector: '[onload]', note: '×1' }]);
  for (const f of r.findings.filter((x) => !/Obsolete|Presentational|event-handler/.test(x.title))) assert.equal(f.places, undefined, f.title);
});

test('odd values: page-made attribute names never become selectors; 20 presentational pairs give 20 places past the 15 in evidence; escaped when drawn', async () => {
  const pairs = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`t${i}.align`, 1]));
  const r = run(collected({ attrPairs: { ...pairs, 'x-a.color': 2 }, handlers: { 'onclick': 1, 'on"x]<b>': 2, 'onfoo:bar': 1 } }));
  const pres = find(r, /^Presentational/);
  assert.equal(pres.evidence.split(', ').length, 15, 'evidence still names 15');
  assert.equal(pres.places.length, 21);
  assert.deepEqual(pres.places.at(-1), { selector: 'x-a[color]', note: '×2' });
  const handlers = find(r, /event-handler/);
  assert.equal(handlers.evidence, 'onclick ×1, on"x]<b> ×2, onfoo:bar ×1', 'evidence keeps every name');
  assert.deepEqual(handlers.places, [{ selector: '[onclick]', note: '×1' }]);
  const s = await saved(r);
  // Drawn from the plugin's own saved places: the page-made names never reach them, raw or escaped.
  const drawn = String(h.places(s.findings.flatMap((f) => f.places || [])));
  assert.match(drawn, /<code>t0\[align\]<\/code>/);
  assert.match(drawn, /<code>\[onclick\]<\/code>/);
  assert.equal((drawn.match(/<li class="place">/g) || []).length, 24, '21 presentational, 1 handler, 2 obsolete');
  assert.doesNotMatch(drawn, /<b>|&lt;b&gt;|onfoo|on&quot;x/);
});

test('headline: Elements reads on its own', () => {
  const r = run(collected());
  const head = r.summary.filter((x) => x.headline);
  assert.equal(head.length, 1);
  assert.equal(`${head[0].label} ${head[0].value}`, 'Elements 400 · 11% semantic · 65% div/span');
});

test('render: stats first; no glance repeats; handlers and obsolete only in findings; dumps closed; chips fold', () => {
  const tags = Array.from({ length: 11 }, (_, i) => `x-${i}`);
  const r = run(collected({ components: { ...collected().components, customTags: tags } }));
  const s = String(html.render({ status: 'ok', ...r }, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('class="kv"'), 'stats first');
  assert.match(s, /Inline styles<\/span><div class="stat-value">7/);
  assert.match(s, /Inline handlers<\/span><div class="stat-value">4/);
  assert.match(s, /ARIA attributes<\/span><div class="stat-value">12/);
  assert.match(s, /Custom elements<\/span><div class="stat-value">11<\/div><span class="stat-note">2 shadow roots/);
  assert.doesNotMatch(s, /<dt>Elements<\/dt>|Semantic \/ generic|<dt>ARIA attributes/, 'the glance and stats carry these');
  assert.doesNotMatch(s, /Inline event handlers|Obsolete elements/, 'in the findings');
  assert.match(s, /<summary>Element usage<span class="disclosure-meta">10 element types<\/span><\/summary>/);
  assert.match(s, /<summary>Sample classes<span class="disclosure-meta">2 of 2<\/span>/);
  assert.match(s, /<summary>Top data-\* attributes<span class="disclosure-meta">1 names/);
  assert.doesNotMatch(s, /<details class="disclosure" open/);
  assert.equal((s.match(/<span class="tag">x-\d+<\/span>/g) || []).length, 11);
  assert.match(s, /<summary>3 more<\/summary>/);
});

test('render: no web components, no section; an older reading without inlineHandlers sums the handlers', () => {
  const r = run(collected({ components: { customTags: [], defined: 0, undefinedCount: 0, shadowRoots: 0, shadowHosts: [], templates: 0, slots: 0, dsd: 0, customizedBuiltins: 0 } }));
  const { inlineHandlers, ...old } = r.data;
  const s = String(html.render({ status: 'ok', ...r, data: old }, h));
  assert.doesNotMatch(s, /Web components/);
  assert.match(s, /Inline handlers<\/span><div class="stat-value">4/);
});
