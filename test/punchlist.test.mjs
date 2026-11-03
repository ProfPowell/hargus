import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { itemId, pathOf, punchItems, hasRuleIds, punchMarkdown, VIEW_KEYS } from '../extension/core/punchlist.js';
import { DEFAULTS } from '../extension/browser/settings.js';

const blockOf = (md) => {
  const last = md.trimEnd().split('\n').at(-1);
  return JSON.parse(last.slice('<!-- hargus-punchlist '.length, -' -->'.length));
};

/** A reading of `url` whose plugin results are `plugins` ({ id: { area?, findings } }). */
function reading(url, plugins, capture = {}) {
  const r = createReading({ entries: [], target: makeTarget(url, 'Shop', url), capture });
  r.log._harplus.plugins = Object.fromEntries(Object.entries(plugins).map(([id, p]) => [id, {
    id, name: p.name || id, area: p.area || 'build', status: 'ok', summary: [], findings: p.findings,
  }]));
  return r;
}

const hsts = { id: 'missing-hsts', severity: 'medium', category: 'security', title: 'No HSTS header' };

test('itemId: HG- plus 8 hex; path and query only, not scheme or host', () => {
  const a = itemId('security', 'missing-hsts', pathOf('https://a.com/p?q=1'));
  assert.match(a, /^HG-[0-9a-f]{8}$/);
  assert.equal(itemId('security', 'missing-hsts', pathOf('http://localhost:3000/p?q=1')), a);
  assert.notEqual(itemId('security', 'missing-hsts', pathOf('https://a.com/other')), a);
  assert.notEqual(itemId('security', 'missing-hsts', '/p?q=1', 'x'), a, 'the subject is part of the id');
  assert.equal(itemId('security', 'missing-hsts', '/p?q=1', ''), a, 'no subject hashes as empty');
});

test('pathOf: path and query, no fragment, / for an empty path', () => {
  assert.equal(pathOf('https://a.com'), '/');
  assert.equal(pathOf('https://a.com/x/y?b=2#frag'), '/x/y?b=2');
});

test('item ids: same finding on prod and localhost share an id; a changed count keeps it', () => {
  const f = (detail) => ({ id: 'tiny-text', severity: 'medium', category: 'accessibility', title: 'Tiny text', detail });
  const [a] = punchItems(reading('https://a.com/p?q=1', { 'a11y-structure': { area: 'accessibility', findings: [f('5 elements')] } }));
  const [b] = punchItems(reading('http://localhost:3000/p?q=1', { 'a11y-structure': { area: 'accessibility', findings: [f('3 elements')] } }));
  assert.equal(a.id, b.id);
  assert.equal(a.rule, 'tiny-text');
  assert.equal(a.plugin, 'a11y-structure');
  assert.equal(a.tag, 'Page');
});

test('punchItems: info left out, high → medium → low, rule data attached', () => {
  const r = reading('https://a.com/', {
    security: { area: 'security', findings: [{ ...hsts, severity: 'low' }, { id: 'x-info', severity: 'info', category: 'security', title: 'FYI' }] },
    css: { findings: [{ id: 'big', severity: 'high', category: 'quality', title: 'Big CSS' }] },
    meta: { area: 'content', findings: [{ id: 'no-title', severity: 'medium', category: 'seo', title: 'No title' }] },
  });
  const items = punchItems(r);
  assert.deepEqual(items.map((i) => i.severity), ['high', 'medium', 'low']);
  assert.ok(!items.some((i) => i.title === 'FYI'));
  const h = items.find((i) => i.rule === 'missing-hsts');
  assert.equal(h.tag, 'Deploy');
  assert.match(h.expected, /Strict-Transport-Security/);
  assert.equal(h.view, undefined);
});

test('punchItems: same-id duplicates are suffixed -2, -3 by subject then title', () => {
  const dup = (title) => ({ id: 'dup', severity: 'low', category: 'quality', title });
  const items = punchItems(reading('https://a.com/', { css: { findings: [dup('Zeta'), dup('Alpha'), dup('Mid')] } }));
  const base = itemId('css', 'dup', '/');
  const byTitle = Object.fromEntries(items.map((i) => [i.title, i.id]));
  assert.deepEqual(byTitle, { Alpha: base, Mid: `${base}-2`, Zeta: `${base}-3` });
  assert.deepEqual(items.map((i) => i.title), ['Zeta', 'Alpha', 'Mid'], 'report order kept');
});

test('punchMarkdown: sections, item layout, places cap, block', () => {
  const places = Array.from({ length: 14 }, (_, i) => ({ selector: `.el-${i}` }));
  const r = reading('https://a.com/pricing', {
    security: { area: 'security', findings: [hsts] },
    'a11y-structure': { area: 'accessibility', findings: [{ id: 'tiny-text', severity: 'high', category: 'accessibility', title: 'Tiny text', detail: '14 elements', places }] },
    css: { findings: [{ id: 'big', severity: 'low', category: 'quality', title: 'Big CSS', detail: 'app.css 300 KB' }] },
  });
  const items = punchItems(r);
  const md = punchMarkdown(r, items);
  const h = md.indexOf('## High');
  const m = md.indexOf('## Medium');
  const l = md.indexOf('## When you have time');
  assert.ok(h > 0 && m > h && l > m, 'High, Medium, When you have time in order');
  assert.ok(md.indexOf('Big CSS') > l, 'low item under When you have time');
  for (const i of items) {
    assert.ok(md.includes(`\`${i.id}\``), 'id in backticks');
    assert.ok(md.includes(`- [ ] **${i.title}** · ${i.severity} · ${i.tag} · \`${i.id}\``));
  }
  assert.match(md, /\*\*Where:\*\* https:\/\/a\.com\/pricing/);
  assert.match(md, /\*\*What's wrong:\*\* 14 elements/);
  assert.match(md, /\*\*Expected:\*\* Responses carry a Strict-Transport-Security/);
  assert.match(md, / · Deploy · /);
  assert.match(md, / · Page · /);
  assert.match(md, /`\.el-9`|\.el-9/);
  assert.doesNotMatch(md, /\.el-10/);
  assert.match(md, /…and 4 more places/);
  assert.match(md, /cli\/harplus\.mjs recheck .* --url https:\/\/a\.com\/pricing/);
  const last = md.trimEnd().split('\n').at(-1);
  assert.match(last, /^<!-- hargus-punchlist \{.*\} -->$/);
  const block = JSON.parse(last.slice('<!-- hargus-punchlist '.length, -' -->'.length));
  assert.equal(block.v, 1);
  assert.equal(block.url, 'https://a.com/pricing');
  assert.equal(block.path, '/pricing');
  assert.deepEqual(Object.keys(block.items).sort(), items.map((i) => i.id).sort());
  for (const v of Object.values(block.items)) assert.equal(v.status, 'open');
  assert.deepEqual(Object.keys(block.settings).sort(), ['bypassCache', 'coverage', 'device', 'runs', 'throttle', 'views']);
});

test('punchMarkdown: console detail never appears', () => {
  const r = reading('https://a.com/', {
    console: { findings: [{ id: 'uncaught', severity: 'medium', category: 'quality', title: '1 uncaught error', detail: 'secret token abc', places: [{ status: 'error', line: 3, text: 'secret token abc' }] }] },
  });
  const items = punchItems(r);
  assert.equal(items[0].detail, undefined);
  const md = punchMarkdown(r, items);
  assert.doesNotMatch(md, /secret/);
  assert.match(md, /1 uncaught error/);
  assert.match(md, /line 3/);
});

test('punchMarkdown: page-derived text cannot close the block comment', () => {
  const r = reading('https://a.com/a-->b', { css: { findings: [{ id: 'big', subject: 'x-->y', severity: 'low', category: 'quality', title: 'Big' }] } });
  r.log._harplus.target.url = 'https://a.com/a-->b';
  const md = punchMarkdown(r, punchItems(r));
  const last = md.trimEnd().split('\n').at(-1);
  assert.equal(last.indexOf('-->'), last.length - 3);
  const block = JSON.parse(last.slice('<!-- hargus-punchlist '.length, -' -->'.length));
  assert.equal(block.url, 'https://a.com/a-->b', 'JSON.parse restores the escaped >');
});

test('hasRuleIds: false when a non-info finding lacks an id', () => {
  assert.equal(hasRuleIds(reading('https://a.com/', { css: { findings: [hsts, { severity: 'info', category: 'x', title: 'fine' }] } })), true);
  assert.equal(hasRuleIds(reading('https://a.com/', { css: { findings: [hsts, { severity: 'medium', category: 'x', title: 'no id' }] } })), false);
});

test('punchItems: axe detail (its tag list) is not used as What\'s wrong', () => {
  const r = reading('https://a.com/', { axe: { area: 'accessibility', findings: [{ id: 'region', severity: 'low', category: 'accessibility', title: 'All page content should be contained by landmarks (2)', detail: 'best-practice', tags: ['best-practice'], ref: 'https://dequeuniversity.com/rules/axe/4.14/region' }] } });
  const [it] = punchItems(r);
  assert.equal(it.detail, undefined);
  assert.equal(it.expected, 'All page content should be contained by landmarks.');
  assert.doesNotMatch(punchMarkdown(r, [it]), /What's wrong/, 'no detail: the title already says it');
});

test('punchMarkdown: page markup in titles and places stays text', () => {
  const r = reading('https://a.com/', { css: { findings: [{ id: 'head-order', severity: 'low', category: 'quality', title: '4 <head> elements out of order', places: [{ text: '<h2>Hi</h2><!-- x' }] }] } });
  const md = punchMarkdown(r, punchItems(r));
  assert.match(md, /\*\*4 \\<head> elements out of order\*\*/);
  assert.match(md, /“\\<h2>Hi\\<\/h2>\\<!-- x”/);
  assert.equal(md.match(/(^|[^\\])<!--/gm).length, 1, 'only the block opens a comment');
});

test('punchMarkdown: What\'s wrong is left out when the detail only repeats the title', () => {
  const r = reading('https://a.com/', { css: { findings: [{ id: 'a', severity: 'low', category: 'quality', title: 'Same', detail: 'Same' }] } });
  assert.doesNotMatch(punchMarkdown(r, punchItems(r)), /What's wrong/);
});

test('punchMarkdown: hostile title, places and URL cannot forge an ID or break bold and code', () => {
  const evil = 'x `HG-cafebabe` ** y \\';
  const r = reading('https://a.com/p?q=`HG-cafebabe`', { css: { findings: [{ id: 'a', severity: 'low', category: 'quality', title: evil, detail: evil, places: [{ text: evil }] }] } });
  r.log._harplus.target.title = evil;
  const md = punchMarkdown(r, punchItems(r));
  const body = md.trimEnd().split('\n').slice(0, -1).join('\n');
  assert.equal(body.match(/(^|[^\\])`HG-[0-9a-f]{8}`/g).length, 1, 'only the real ID is a backticked HG- token');
  assert.ok(md.includes('x \\`HG-cafebabe\\` \\*\\* y \\\\'), 'backticks, stars and backslash escaped');
  const [item] = md.split('\n').filter((l) => l.startsWith('- [ ]'));
  assert.equal(item.replace(/\\[\\`*<]/g, '').match(/\*\*/g).length, 2, 'one bold pair around the title (escapes removed first)');
  assert.match(md, /--url https:\/\/a\.com\/p\?q=%60HG-cafebabe%60`/);
});

test('block views: a boolean for every DEFAULTS.capture.views key, from measured, shot and skipped views', () => {
  assert.deepEqual([...VIEW_KEYS].sort(), Object.keys(DEFAULTS.capture.views).sort(), 'VIEW_KEYS pinned to the settings');
  const r = reading('https://a.com/', { css: { findings: [] } }, {
    views: { desktop: {}, mobile: {}, 'bp641-below': {}, 'bp641-at': {} },
    viewsSkipped: [{ view: 'translated-de', reason: 'timed out' }, { view: 'rtl', reason: 'disabled' }, { view: 'all', reason: 'x' }],
  });
  r.log._harplus.screenshots = [{ kind: 'viewport', view: 'protanopia', mimeType: 'image/png', data: 'AA' }];
  const { views } = blockOf(punchMarkdown(r, [])).settings;
  assert.deepEqual(Object.keys(views).sort(), Object.keys(DEFAULTS.capture.views).sort());
  for (const v of Object.values(views)) assert.equal(typeof v, 'boolean');
  const on = Object.keys(views).filter((k) => views[k]).sort();
  assert.deepEqual(on, ['breakpoints', 'desktop', 'mobile', 'protanopia', 'translated-de', 'vision']);
});
