import { test } from 'node:test';
import assert from 'node:assert/strict';
import meta from '../extension/plugins/meta.js';
import wellKnown, { parseRobotsFile, groupFor, robotsAllowed, xRobots, CRAWLERS } from '../extension/plugins/well-known.js';
import * as util from '../extension/core/har-util.js';
import { mockFetch } from './helpers.mjs';

const allow = (txt, ua, path) => robotsAllowed(groupFor(parseRobotsFile(txt).groups, ua), path).allowed;

test('Google matching examples', () => {
  const fish = 'User-agent: *\nDisallow: /fish\n';
  for (const p of ['/fish', '/fish.html', '/fish/salmon.html', '/fishheads']) assert.equal(allow(fish, 'googlebot', p), false, p);
  for (const p of ['/Fish.asp', '/catfish', '/?id=fish']) assert.equal(allow(fish, 'googlebot', p), true, p);
  const php = 'User-agent: *\nDisallow: /*.php$\n';
  assert.equal(allow(php, 'googlebot', '/filename.php'), false);
  assert.equal(allow(php, 'googlebot', '/folder/filename.php'), false);
  assert.equal(allow(php, 'googlebot', '/filename.php?parameters'), true);
  assert.equal(allow(php, 'googlebot', '/filename.php/'), true);
  assert.equal(allow('User-agent: *\nAllow: /p\nDisallow: /\n', 'googlebot', '/page'), true, 'longest match wins');
  assert.equal(allow('User-agent: *\nAllow: /folder\nDisallow: /folder\n', 'googlebot', '/folder/page'), true, 'allow wins a tie');
  assert.equal(allow('User-agent: *\nAllow: /$\nDisallow: /\n', 'googlebot', '/'), true);
  assert.equal(allow('User-agent: *\nAllow: /$\nDisallow: /\n', 'googlebot', '/page.htm'), false);
  assert.equal(allow('User-agent: *\nDisallow:\n', 'googlebot', '/anything'), true, 'empty disallow matches nothing');
  assert.equal(allow('User-agent: *\nDisallow: /*?\n', 'googlebot', '/a?b=1'), false, 'query string is part of the path');
});

test('group selection: most specific token, * fallback, same-agent groups merge, none → allowed', () => {
  const txt = 'User-agent: googlebot-news\nDisallow: /news\n\nUser-agent: googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /all\n\nUser-agent: googlebot\nDisallow: /g2\n';
  const groups = parseRobotsFile(txt).groups;
  assert.deepEqual(groupFor(groups, 'googlebot-news').rules.map((r) => r.path), ['/news']);
  assert.deepEqual(groupFor(groups, 'googlebot').rules.map((r) => r.path), ['/g', '/g2']);
  assert.deepEqual(groupFor(groups, 'bingbot').rules.map((r) => r.path), ['/all']);
  assert.equal(groupFor(parseRobotsFile('User-agent: gptbot\nDisallow: /\n').groups, 'bingbot'), null);
  assert.equal(robotsAllowed(null, '/x').allowed, true);
});

test('parsing: BOM, CRLF, comments, unknown, crawl-delay, noindex, duplicates, sitemaps', () => {
  const r = parseRobotsFile('﻿User-agent: *\r\nDisallow: /a # comment\r\nCrawl-delay: 5\r\nNoindex: /b\r\nFoo: bar\r\nSitemap: https://s.test/sm.xml\r\n\r\nUser-agent: *\r\nDisallow: /c\r\n');
  assert.deepEqual(r.groups[0].rules, [{ type: 'disallow', path: '/a' }]);
  assert.equal(r.crawlDelay, '5');
  assert.equal(r.noindex, 1);
  assert.deepEqual(r.unknown, ['Foo']);
  assert.deepEqual(r.sitemaps, ['https://s.test/sm.xml']);
  assert.deepEqual(r.duplicates, ['*']);
  assert.deepEqual(groupFor(r.groups, 'googlebot').rules.map((x) => x.path), ['/a', '/c']);
});

test('X-Robots-Tag: unscoped, agent-scoped, unavailable_after not mistaken for an agent', () => {
  assert.deepEqual(xRobots(['noindex, nofollow']), { all: ['noindex', 'nofollow'], byAgent: {} });
  assert.deepEqual(xRobots(['googlebot: noindex', 'otherbot: nofollow']), { all: [], byAgent: { googlebot: ['noindex'], otherbot: ['nofollow'] } });
  assert.deepEqual(xRobots(['unavailable_after: 25 Jun 2030 15:00:00 PST']).byAgent, {});
});

test('crawler list', () => {
  assert.deepEqual(CRAWLERS.map((c) => c[1]), ['googlebot', 'bingbot', 'gptbot', 'claudebot', 'google-extended', 'ccbot', 'perplexitybot', 'applebot-extended']);
});

test('well-known: indexing verdict findings', async () => {
  const robots = 'User-agent: googlebot\nDisallow: /shop\n\nUser-agent: gptbot\nDisallow: /\n\nUser-agent: *\nCrawl-delay: 2\nNoindex: /x\nFoo: 1\n';
  const fetch = mockFetch([
    [/\/robots\.txt$/, { body: robots, headers: { 'content-type': 'text/plain' } }],
    [/\/ai\.txt$/, { body: 'User-Agent: *\nDisallowed: /\n', headers: { 'content-type': 'text/plain' } }],
  ]);
  const reading = { log: { entries: [{ request: { url: 'https://s.test/shop/item?id=1' }, response: { status: 200, headers: [{ name: 'X-Robots-Tag', value: 'noindex' }], content: { mimeType: 'text/html' } }, _resourceType: 'document' }],
    _harplus: { target: { finalUrl: 'https://s.test/shop/item?id=1', origin: 'https://s.test' } } } };
  const ctx = { target: reading.log._harplus.target, results: { meta: { status: 'ok', data: { robots: '', googlebot: '' } } }, util, fetch,
    skip: (m) => { throw new Error(m); } };
  const out = await wellKnown.run(reading, ctx);
  const t = out.findings.map((f) => `${f.severity}:${f.title}`);
  assert.ok(t.includes('medium:This page is blocked for Googlebot by robots.txt'), t.join(' | '));
  assert.ok(!t.some((x) => /blocked for Bingbot/.test(x)));
  assert.ok(t.includes('medium:X-Robots-Tag header asks search engines not to index this page'));
  assert.ok(t.includes('low:robots.txt uses noindex, which search engines ignore'));
  assert.ok(t.includes('info:robots.txt sets crawl-delay (Google ignores it)'));
  assert.ok(t.includes('info:robots.txt has 1 unrecognised directives'));
  assert.ok(t.includes('info:robots.txt blocks 1 AI crawlers from this page'));
  assert.ok(t.includes('info:Publishes ai.txt'));
  const g = out.data.indexing.find((r) => r.token === 'googlebot');
  assert.deepEqual([g.crawl, g.rule, g.index], [false, 'Disallow: /shop', false]);
  assert.equal(out.data.indexing.find((r) => r.token === 'bingbot').crawl, true);
});

test('percent-encoding is normalised on rules and paths', () => {
  assert.equal(allow('User-agent: *\nDisallow: /café\n', 'googlebot', '/caf%C3%A9'), false);
  assert.equal(allow('User-agent: *\nDisallow: /caf%c3%a9\n', 'googlebot', '/caf%C3%A9'), false);
  assert.equal(allow('User-agent: *\nDisallow: /%7Euser\n', 'googlebot', '/~user'), false);
});

test('agent matching is exact on the product token', () => {
  assert.equal(allow('User-agent: g\nDisallow: /\n', 'googlebot', '/x'), true);
  assert.equal(allow('User-agent: Googlebot/2.1\nDisallow: /\n', 'googlebot', '/x'), false);
});

test('tie order, Sitemap between groups, User-agent after a rule', () => {
  assert.equal(allow('User-agent: *\nDisallow: /folder\nAllow: /folder\n', 'googlebot', '/folder/x'), true);
  const r = parseRobotsFile('User-agent: a\nUser-agent: googlebot\nSitemap: https://s.test/x.xml\nDisallow: /one\n');
  assert.equal(r.groups.length, 1);
  assert.deepEqual(groupFor(r.groups, 'googlebot').rules.map((x) => x.path), ['/one']);
  const g = parseRobotsFile('User-agent: a\nAllow: /x\nUser-agent: b\nDisallow: /y\n').groups;
  assert.equal(g.length, 2);
  assert.deepEqual(g[1].agents, ['b']);
});

test('meta noindex is an exact token', async () => {
  const run = async (robots) => {
    const reading = { log: { entries: [], _harplus: { target: { finalUrl: 'https://s.test/', origin: 'https://s.test' } } } };
    const ctx = { target: reading.log._harplus.target, results: { meta: { data: { robots } } }, util, fetch: mockFetch([]), skip: () => {} };
    return (await wellKnown.run(reading, ctx)).data.indexing[0].index;
  };
  assert.equal(await run('nonexistent'), true);
  assert.equal(await run('NoIndex, nofollow'), false);
});

const wkRun = async (robotsTxt, { metaData = {}, xrt, path = '/' } = {}) => {
  const fetch = mockFetch([[/\/robots\.txt$/, { body: robotsTxt, headers: { 'content-type': 'text/plain' } }]]);
  const reading = { log: { entries: [{ request: { url: `https://s.test${path}` }, response: { status: 200, headers: xrt ? [{ name: 'X-Robots-Tag', value: xrt }] : [], content: { mimeType: 'text/html' } }, _resourceType: 'document' }],
    _harplus: { target: { finalUrl: `https://s.test${path}`, origin: 'https://s.test' } } } };
  const ctx = { target: reading.log._harplus.target, results: { meta: { data: metaData } }, util, fetch, skip: () => {} };
  return wellKnown.run(reading, ctx);
};

test('site-wide Disallow: / raises one finding; a more specific rule still gets its own', async () => {
  const out = await wkRun('User-agent: *\nDisallow: /\n');
  const seo = out.findings.filter((f) => f.severity === 'medium' && f.category === 'seo');
  assert.equal(seo.length, 1, seo.map((f) => f.title).join(' | '));
  assert.match(seo[0].title, /blocks all crawlers/);
  const mixed = await wkRun('User-agent: *\nDisallow: /\n\nUser-agent: googlebot\nDisallow: /shop\n', { path: '/shop/a' });
  const t = mixed.findings.map((f) => f.title);
  assert.ok(t.includes('This page is blocked for Googlebot by robots.txt'));
  assert.ok(!t.includes('This page is blocked for Bingbot by robots.txt'));
});

test('X-Robots-Tag finding is skipped when meta robots already says noindex or none', async () => {
  const withMeta = await wkRun('', { metaData: { robots: 'none' }, xrt: 'noindex' });
  assert.ok(!withMeta.findings.some((f) => /X-Robots-Tag/.test(f.title)));
  assert.equal(withMeta.data.indexing[0].indexSource, 'meta robots');
  const without = await wkRun('', { xrt: 'noindex' });
  assert.ok(without.findings.some((f) => /X-Robots-Tag/.test(f.title)));
});

test('AI crawlers summary row reflects the per-page verdict', async () => {
  const out = await wkRun('User-agent: gptbot\nDisallow: /docs/\n', { path: '/docs/a' });
  assert.equal(out.summary.find((s) => s.label === 'AI crawlers').value, '1 of 6 blocked from this page');
});

test('meta: noindex matches the exact noindex or none token', () => {
  const c = (over) => ({
    url: 'https://s.test/', title: 'A good page title here', description: 'A properly long description that says what the page offers to readers.', canonical: 'https://s.test/',
    robots: '', googlebot: '', viewport: 'width=device-width', og: { 'og:title': 'x', 'og:image': 'https://s.test/i.png' }, twitter: {}, icons: ['/f.ico'],
    jsonld: [], jsonldErrors: [], compatMode: 'CSS1Compat', charset: 'UTF-8', images: { noDimensions: 0, total: 0 }, forms: [],
    headings: [{ level: 1, text: 'H' }], links: { externalUrls: [] }, generator: [], emails: [], phones: [], words: 10, domElements: 10, customElements: [], ...over,
  });
  const has = (over) => meta.run({}, { collected: c(over), util, target: { site: 's.test' }, skip: () => {} }).findings.some((f) => /not to index it/.test(f.title));
  assert.equal(has({ robots: 'none' }), true);
  assert.equal(has({ googlebot: 'NoIndex, nofollow' }), true);
  assert.equal(has({ robots: 'nonexistent' }), false);
});
