import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { itemId, pathOf, punchItems, hasRuleIds, punchMarkdown, VIEW_KEYS, parsePunchList, isLocalUrl, recheckList } from '../extension/core/punchlist.js';
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

// ---- Recheck ----

const NOW = new Date(2026, 10, 3, 15, 30);
const tiny = { id: 'tiny-text', severity: 'medium', category: 'accessibility', title: 'Tiny text', detail: '5 elements' };
const slow = { id: 'slow-metric', subject: 'lcp', severity: 'medium', category: 'performance', title: 'Slow LCP' };
const base = () => ({
  security: { area: 'security', findings: [hsts] },
  'a11y-structure': { area: 'accessibility', findings: [tiny] },
  vitals: { area: 'performance', findings: [slow] },
});
/** Export a list from `r`, then parse it back. */
const listOf = (r) => parsePunchList(punchMarkdown(r, punchItems(r)));
const idOf = (items, rule) => items.find((i) => i.rule === rule).id;

test('parsePunchList: block meta, visible ids from checkbox lines; null when missing or corrupt', () => {
  const r = reading('https://a.com/pricing', base());
  const items = punchItems(r);
  const md = punchMarkdown(r, items);
  const list = parsePunchList(md);
  assert.equal(list.meta.url, 'https://a.com/pricing');
  assert.deepEqual([...list.visibleIds].sort(), items.map((i) => i.id).sort());
  assert.equal(parsePunchList(md.split('\n').slice(0, -2).join('\n')), null, 'block missing');
  assert.equal(parsePunchList(md.replace('"v":1', '"v":1,,')), null, 'JSON corrupt');
  assert.equal(parsePunchList(''), null);
});

test('isLocalUrl', () => {
  for (const u of ['http://localhost:8080/', 'http://127.0.0.1/', 'http://[::1]/', 'http://shop.localhost/', 'http://site.test/']) assert.equal(isLocalUrl(u), true, u);
  assert.equal(isLocalUrl('https://staging.example.com/'), false);
  assert.equal(isLocalUrl('https://staging.example.com/', true), true);
  assert.equal(isLocalUrl('not a url'), false);
});

test('recheck: unchanged reading → all still there, nothing new, exit 1', () => {
  const r = reading('https://a.com/pricing', base());
  const out = recheckList(listOf(r), reading('https://a.com/pricing', base()), { url: 'https://a.com/pricing', now: NOW });
  assert.equal(out.items.length, 3);
  for (const it of out.items) assert.equal(out.statuses[it.id].status, 'still');
  assert.deepEqual(out.added, []);
  assert.equal(out.summary, '3 items: 0 fixed, 3 still there, 0 verify after deploy; 0 new');
  assert.equal(out.exitCode, 1);
});

test('recheck: a Page item gone is fixed with today\'s date; Markdown ticks it', () => {
  const r = reading('https://a.com/pricing', base());
  const list = listOf(r);
  const next = reading('https://a.com/pricing', { ...base(), 'a11y-structure': { area: 'accessibility', findings: [] } });
  const out = recheckList(list, next, { url: 'https://a.com/pricing', now: NOW });
  const id = idOf(punchItems(r), 'tiny-text');
  assert.deepEqual(out.statuses[id], { status: 'fixed', since: '2026-11-03' });
  const md = punchMarkdown(next, out.items, { statuses: out.statuses, added: out.added, checkedAt: NOW });
  const line = md.split('\n').find((l) => l.includes(id));
  assert.match(line, /^- \[x\] \*\*Tiny text\*\*/);
  assert.match(line, /fixed 2026-11-03/);
  assert.equal(blockOf(md).items[id].status, 'fixed');
  assert.equal(blockOf(md).items[id].since, '2026-11-03');
  assert.equal(out.summary, '3 items: 1 fixed, 2 still there, 0 verify after deploy; 0 new');
});

test('recheck: a fixed item that stays gone keeps its date; one that reappears is still there, not new', () => {
  const r = reading('https://a.com/', base());
  const gone = reading('https://a.com/', { ...base(), 'a11y-structure': { area: 'accessibility', findings: [] } });
  const first = recheckList(listOf(r), gone, { url: 'https://a.com/', now: NOW });
  const md1 = punchMarkdown(gone, first.items, { statuses: first.statuses, added: first.added });
  const id = idOf(punchItems(r), 'tiny-text');
  const later = recheckList(parsePunchList(md1), gone, { url: 'https://a.com/', now: new Date(2026, 10, 9) });
  assert.equal(later.statuses[id].since, '2026-11-03');
  assert.match(punchMarkdown(gone, later.items, { statuses: later.statuses }), /\*\*Tiny text\*\*.*fixed 2026-11-03/, 'the fixed item keeps its layout');
  const back = recheckList(parsePunchList(md1), reading('https://a.com/', base()), { url: 'https://a.com/', now: NOW });
  assert.equal(back.statuses[id].status, 'still');
  assert.deepEqual(back.added, []);
});

test('recheck: Deploy item gone on a local URL → verify after deploy; on a public URL → fixed', () => {
  const r = reading('https://example.com/', base());
  const id = idOf(punchItems(r), 'missing-hsts');
  const next = (u) => reading(u, { ...base(), security: { area: 'security', findings: [] } });
  const local = recheckList(listOf(r), next('http://localhost:3000/'), { url: 'http://localhost:3000/', now: NOW });
  assert.equal(local.statuses[id].status, 'deploy');
  const pub = recheckList(listOf(r), next('https://example.com/'), { url: 'https://example.com/', now: NOW });
  assert.equal(pub.statuses[id].status, 'fixed');
  const md = punchMarkdown(next('http://localhost:3000/'), local.items, { statuses: local.statuses });
  assert.match(md.split('\n').find((l) => l.includes(id)), /^- \[ \] .*verify after deploy/);
});

test('recheck: Timing item present on a local URL → verify after deploy; new Deploy/Timing findings left out locally', () => {
  const r = reading('https://example.com/', base());
  const id = idOf(punchItems(r), 'slow-metric');
  assert.equal(punchItems(r).find((i) => i.id === id).tag, 'Timing');
  const more = base();
  more.security.findings = [hsts, { id: 'no-csp', severity: 'medium', category: 'security', title: 'No CSP' }];
  more.vitals.findings = [slow, { ...slow, subject: 'ttfb', title: 'Slow TTFB' }];
  more.meta = { area: 'content', findings: [{ id: 'no-title', severity: 'low', category: 'seo', title: 'No title' }] };
  const out = recheckList(listOf(r), reading('http://localhost:3000/', more), { url: 'http://localhost:3000/', now: NOW });
  assert.equal(out.statuses[id].status, 'deploy');
  assert.deepEqual(out.added.map((i) => i.title), ['No title'], 'only the Page finding is new');
  assert.equal(out.summary, '3 items: 0 fixed, 1 still there, 2 verify after deploy; 1 new');
  const pub = recheckList(listOf(r), reading('https://example.com/', more), { url: 'https://example.com/', now: NOW });
  assert.equal(pub.added.length, 3, 'public URL: every new finding counts');
});

test('recheck: plugin errored, skipped or absent → can\'t check with its reason, never fixed', () => {
  const r = reading('https://a.com/', base());
  const id = idOf(punchItems(r), 'tiny-text');
  for (const [status, error] of [['error', 'timed out after 30s'], ['skipped', 'needs a visible tab']]) {
    const next = reading('https://a.com/', base());
    Object.assign(next.log._harplus.plugins['a11y-structure'], { status, error, findings: [] });
    const out = recheckList(listOf(r), next, { url: 'https://a.com/', now: NOW });
    assert.equal(out.statuses[id].status, 'cantcheck');
    assert.match(out.statuses[id].reason, /a11y-structure/);
    assert.ok(out.statuses[id].reason.includes(error));
    const line = punchMarkdown(next, out.items, { statuses: out.statuses }).split('\n').find((l) => l.includes(id));
    assert.match(line, /^- \[ \] .*can't check: /);
  }
  const missing = reading('https://a.com/', base());
  delete missing.log._harplus.plugins['a11y-structure'];
  const out = recheckList(listOf(r), missing, { url: 'https://a.com/', now: NOW });
  assert.equal(out.statuses[id].status, 'cantcheck');
  assert.match(out.statuses[id].reason, /a11y-structure did not run/);
  assert.match(out.summary, /1 can't check/);
});

test('recheck: an item whose view was skipped or not recorded → can\'t check naming the view', () => {
  const pseudo = { id: 'pseudo-text-clipped', subject: 'translated-de', severity: 'medium', category: 'international', title: 'Text gets cut off when translated' };
  const r = reading('https://a.com/', { international: { area: 'international', findings: [pseudo] } }, { views: { 'translated-de': {} } });
  const [item] = punchItems(r);
  const next = reading('https://a.com/', { international: { area: 'international', findings: [] } },
    { views: {}, viewsSkipped: [{ view: 'translated-de', reason: 'Translator API unavailable headlessly' }] });
  const out = recheckList(listOf(r), next, { url: 'https://a.com/', now: NOW });
  assert.equal(out.statuses[item.id].status, 'cantcheck');
  assert.match(out.statuses[item.id].reason, /translated-de/);
  assert.match(out.statuses[item.id].reason, /Translator API unavailable/);
  const notRun = reading('https://a.com/', { international: { area: 'international', findings: [] } }, { views: {} });
  const out2 = recheckList(listOf(r), notRun, { url: 'https://a.com/', now: NOW });
  assert.equal(out2.statuses[item.id].status, 'cantcheck');
  assert.match(out2.statuses[item.id].reason, /translated-de/);
  const ran = reading('https://a.com/', { international: { area: 'international', findings: [] } }, { views: { 'translated-de': {} } });
  assert.equal(recheckList(listOf(r), ran, { url: 'https://a.com/', now: NOW }).statuses[item.id].status, 'fixed');
});

test('recheck: a new Page finding is added under New since last check; exit 1; a clean recheck exits 0', () => {
  const r = reading('https://a.com/', { meta: { area: 'content', findings: [] } });
  const next = reading('https://a.com/', { meta: { area: 'content', findings: [{ id: 'no-title', severity: 'low', category: 'seo', title: 'No title' }] } });
  const out = recheckList(listOf(r), next, { url: 'https://a.com/', now: NOW });
  assert.equal(out.items.length, 0);
  assert.equal(out.added.length, 1);
  assert.equal(out.exitCode, 1);
  assert.equal(out.summary, '0 items: 0 fixed, 0 still there, 0 verify after deploy; 1 new');
  const md = punchMarkdown(next, out.items, { statuses: out.statuses, added: out.added });
  const at = md.indexOf('## New since last check');
  assert.ok(at > 0 && md.indexOf('No title') > at);
  assert.equal(blockOf(md).items[out.added[0].id].status, 'open');
  assert.ok(parsePunchList(md).visibleIds.has(out.added[0].id));
  assert.equal(recheckList(listOf(r), r, { url: 'https://a.com/', now: NOW }).exitCode, 0);
});

test('recheck: deleted visible entries stay deleted; hand-ticked but still found comes back unticked', () => {
  const r = reading('https://a.com/', base());
  const items = punchItems(r);
  const tinyId = idOf(items, 'tiny-text');
  const hstsId = idOf(items, 'missing-hsts');
  const lines = punchMarkdown(r, items).split('\n');
  const start = lines.findIndex((l) => l.includes(tinyId));
  let end = start + 1;
  while (lines[end]?.startsWith('  ')) end++;
  lines.splice(start, end - start);
  const edited = lines.join('\n').replace('- [ ] **No HSTS header**', '- [x] **No HSTS header**');
  const out = recheckList(parsePunchList(edited), reading('https://a.com/', base()), { url: 'https://a.com/', now: NOW });
  assert.ok(!out.items.some((i) => i.id === tinyId));
  assert.ok(!out.added.some((i) => i.id === tinyId), 'a deleted item is not new either');
  assert.equal(out.statuses[hstsId].status, 'still');
  const md = punchMarkdown(r, out.items, { statuses: out.statuses, added: out.added });
  assert.ok(!(tinyId in blockOf(md).items));
  assert.ok(!md.includes(tinyId));
  assert.match(md.split('\n').find((l) => l.includes(hstsId)), /^- \[ \] .*still there/);
});

test('recheck: ids use the rechecked URL\'s path, not the reading\'s', () => {
  const r = reading('https://a.com/pricing', base());
  const next = reading('http://localhost:3000/elsewhere', base());
  const out = recheckList(listOf(r), next, { url: 'http://localhost:3000/pricing', now: NOW });
  assert.equal(out.statuses[idOf(punchItems(r), 'tiny-text')].status, 'still');
});

test('punchMarkdown: the block keeps the list URL given, not the rechecked one', () => {
  const r = reading('http://localhost:3000/pricing', base());
  assert.equal(blockOf(punchMarkdown(r, punchItems(r), { url: 'https://a.com/pricing' })).url, 'https://a.com/pricing');
});

/** Recheck `md` against `next` and write the new list, as the CLI will. */
const recheckMd = (md, next, opts) => {
  const out = recheckList(parsePunchList(md), next, { url: next.log._harplus.target.url, now: NOW, ...opts });
  return { out, md: punchMarkdown(next, out.items, { statuses: out.statuses, added: out.added, dismissed: out.dismissed }) };
};

test('block: U+2028 / U+2029 in page text are escaped and the list still parses', () => {
  const r = reading('https://a.com/', { meta: { area: 'content', findings: [{ id: 'no-title', severity: 'low', category: 'seo', title: 'A\u2028B\u2029C', places: [{ text: 'x\u2028y' }] }] } });
  const md = punchMarkdown(r, punchItems(r));
  const last = md.trimEnd().split('\n').at(-1);
  assert.ok(!/[\u2028\u2029]/.test(last), 'no raw separators in the block line');
  assert.match(last, /\\u2028/);
  const list = parsePunchList(md);
  assert.ok(list, 'parses');
  const [id] = Object.keys(list.meta.items);
  assert.equal(list.meta.items[id].item.title, 'A\u2028B\u2029C');
  assert.ok(list.visibleIds.has(id));
});

test('recheck: a deleted entry stays dismissed across rechecks — never still, never new, not in the exit code', () => {
  const page = () => reading('https://a.com/', { meta: { area: 'content', findings: [{ id: 'no-title', severity: 'low', category: 'seo', title: 'No title' }] }, 'a11y-structure': { area: 'accessibility', findings: [tiny] } });
  const r = page();
  const tinyId = idOf(punchItems(r), 'tiny-text');
  const lines = punchMarkdown(r, punchItems(r)).split('\n');
  const start = lines.findIndex((l) => l.includes(tinyId));
  let end = start + 1;
  while (lines[end]?.startsWith('  ')) end++;
  lines.splice(start, end - start);
  // The remaining item is fixed, so the only thing that could make the exit 1 is the deleted one coming back.
  const fixedPage = () => reading('https://a.com/', { meta: { area: 'content', findings: [] }, 'a11y-structure': { area: 'accessibility', findings: [tiny] } });
  const one = recheckMd(lines.join('\n'), fixedPage());
  assert.equal(one.out.exitCode, 0);
  assert.deepEqual(one.out.dismissed, [tinyId]);
  assert.deepEqual(blockOf(one.md).dismissed, [tinyId]);
  const two = recheckMd(one.md, fixedPage());
  assert.equal(two.out.exitCode, 0);
  assert.equal(two.out.summary, '1 item: 1 fixed, 0 still there, 0 verify after deploy; 0 new');
  assert.ok(!two.md.trimEnd().split('\n').slice(0, -1).join('\n').includes(tinyId), 'never shown again');
  assert.deepEqual(blockOf(two.md).dismissed, [tinyId]);
});

test('recheck: a fixed item keeps its date through a can\'t-check recheck', () => {
  const r = reading('https://a.com/', base());
  const id = idOf(punchItems(r), 'tiny-text');
  const gone = () => reading('https://a.com/', { ...base(), 'a11y-structure': { area: 'accessibility', findings: [] } });
  const one = recheckMd(punchMarkdown(r, punchItems(r)), gone());
  assert.equal(one.out.statuses[id].since, '2026-11-03');
  const broken = gone();
  Object.assign(broken.log._harplus.plugins['a11y-structure'], { status: 'error', error: 'boom' });
  const two = recheckMd(one.md, broken, { now: new Date(2026, 10, 5) });
  assert.deepEqual(two.out.statuses[id], { status: 'cantcheck', reason: 'a11y-structure error: boom', since: '2026-11-03' });
  const three = recheckMd(two.md, gone(), { now: new Date(2026, 10, 9) });
  assert.deepEqual(three.out.statuses[id], { status: 'fixed', since: '2026-11-03' });
});

test('recheck: a damaged block entry is kept as can\'t check, not dropped or thrown', () => {
  const r = reading('https://a.com/', base());
  const items = punchItems(r);
  const id = idOf(items, 'tiny-text');
  const md = punchMarkdown(r, items);
  const block = blockOf(md);
  block.items[id].item.places = 'oops';
  const damaged = md.replace(/<!-- hargus-punchlist .* -->/, `<!-- hargus-punchlist ${JSON.stringify(block)} -->`);
  const gone = reading('https://a.com/', { ...base(), 'a11y-structure': { area: 'accessibility', findings: [] } });
  const out = recheckList(parsePunchList(damaged), gone, { url: 'https://a.com/', now: NOW });
  assert.deepEqual(out.statuses[id], { status: 'cantcheck', reason: 'list entry damaged' });
  assert.equal(out.items.find((i) => i.id === id).title, 'Tiny text');
  block.items[id] = null;
  const nulled = md.replace(/<!-- hargus-punchlist .* -->/, `<!-- hargus-punchlist ${JSON.stringify(block)} -->`);
  const out2 = recheckList(parsePunchList(nulled), gone, { url: 'https://a.com/', now: NOW });
  assert.equal(out2.statuses[id].status, 'cantcheck');
  assert.match(punchMarkdown(gone, out2.items, { statuses: out2.statuses }), /Damaged list entry.*can't check: list entry damaged/);
  const found = recheckList(parsePunchList(nulled), reading('https://a.com/', base()), { url: 'https://a.com/', now: NOW });
  assert.equal(found.statuses[id].status, 'still', 'found again: the new reading supplies the item');
});

test('parsePunchList: null when the block has no url', () => {
  const r = reading('https://a.com/', base());
  const md = punchMarkdown(r, punchItems(r));
  const block = blockOf(md);
  for (const url of [undefined, 42, '']) {
    const b = { ...block, url };
    assert.equal(parsePunchList(md.replace(/<!-- hargus-punchlist .* -->/, `<!-- hargus-punchlist ${JSON.stringify(b)} -->`)), null, String(url));
  }
});

test('recheck: a rule that now emits a different subject reads as fixed plus new (IDs include the subject)', () => {
  const r = reading('https://a.com/', base());
  const lcpId = idOf(punchItems(r), 'slow-metric');
  const next = reading('https://a.com/', { ...base(), vitals: { area: 'performance', findings: [{ ...slow, subject: 'ttfb', title: 'Slow TTFB' }] } });
  const out = recheckList(listOf(r), next, { url: 'https://a.com/', now: NOW });
  assert.equal(out.statuses[lcpId].status, 'fixed');
  assert.deepEqual(out.added.map((i) => i.title), ['Slow TTFB']);
});
