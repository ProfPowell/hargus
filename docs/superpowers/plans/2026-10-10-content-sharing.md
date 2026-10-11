# Content and sharing: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add:
- a per-crawler indexing verdict with Google-compatible robots.txt matching and `X-Robots-Tag`;
- metadata extras and a missing-tags snippet;
- an `og:image` thumbnail and size check;
- seven share and search previews;
- readability in every language (ARI, AARI, CJK) with the hardest sentences;
- line length.

**Architecture:**
- **Pure helpers live where they're used:**
  - robots parsing and matching in `well-known.js`;
  - `missingTags` in `meta.js`;
  - `previewModel` and `renderPreviews` in a new `extension/ui/previews.js`;
  - `scriptOf`, `ari`, `aari` and `hardest` in `content.js`.
- `links.js` records the `og:image` bytes and a 600 px WebP thumbnail.
- The `meta` plugin gains a glance that renders the previews.
- `content`'s page collect gains `lineLengths`.

**Tech Stack:** Vanilla ES modules with no dependencies. `OffscreenCanvas` and `createImageBitmap` in extension pages. `node --test` for unit tests and Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-10-10-content-sharing-design.md`

## Global Constraints

- No dependencies. Page `collect()` functions are self-contained.
- **Crawlers, as `[label, token]`:**
  - `['Googlebot','googlebot']`, `['Bingbot','bingbot']`;
  - `['GPTBot','gptbot']`, `['ClaudeBot','claudebot']`;
  - `['Google-Extended','google-extended']`, `['CCBot','ccbot']`;
  - `['PerplexityBot','perplexitybot']`, `['Applebot-Extended','applebot-extended']`.

  The AI crawlers are the last six.
- **Robots matching:**
  - the agent group is the longest product-token prefix match, falling back to `*`, and groups for the same agent merge;
  - `*` is a wildcard and a trailing `$` anchors;
  - the longest pattern wins, with `allow` winning ties;
  - an empty `disallow` matches nothing;
  - paths include the query string;
  - matching is case-sensitive.
- **Preview truncation lengths:**

  | Card | Lengths |
  |---|---|
  | Google | title 60, description 155 |
  | X large | title 70 |
  | X summary | description 125 |
  | Facebook | title 88, description 110 |
  | LinkedIn | title 70 |
  | Slack | description 150 |
  | Discord | description 350 |
  | Bluesky | title 70, description 150 |

- **Thumbnail:** at most 600 px wide, `image/webp` at quality 0.7.
- **Share image size:** the finding fires above 5 242 880 bytes.
- **ARI** = `4.71·(letters/words) + 0.5·(words/sentences) − 21.43`. A grade above 16 is medium; above 12 is low.
- **Line length:** a median above 80 is low; a median between 0 and 35 is info; 45–75 is the ideal band.
- **Finding titles:** exactly as in the spec, except where a ruling below changes them.
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The harness's line is accepted if it differs.
- **Tests:** run `npm test` before every commit. Task 7 runs `npm run test:e2e`, never two runs at once.

## Rulings made while planning (deviations from the spec)

1. **Duplicate `og:image`, `og:image:*`, `og:locale:alternate` and `article:tag` are allowed.** The Open Graph protocol permits arrays, so these are excluded from duplicate detection.
2. **AARI uses letters per sentence instead of total letters:** `3.28·(letters/sentences) + 1.43·(letters/words) + 1.24·(words/sentences)`. The total-letters form grows with page length, so it means nothing for a whole page. AARI is shown only, never scored.
3. **X card default:** when `twitter:card` is missing, the X preview uses `summary`, which is X's documented default.
4. **New robots helpers, not a rewrite.** The old `parseRobots()` stays unchanged, because the existing tests and the stored readings use its fields. The new helpers sit alongside it: `parseRobotsFile`, `groupFor`, `robotsAllowed` and `xRobots`.
5. **The site-wide AI finding is replaced** by the per-page one, as the spec says.
6. **Shared share-image size:** the `og:image` thumbnail is also used for X when `twitter:image` equals `og:image`. Otherwise X shows the remote image (interactive report only) or a placeholder.

## Review Focus

1. **Robots.txt edge cases:**
   - a UTF-8 BOM;
   - CRLF line endings;
   - comments after values;
   - `User-agent` lines after rules (a new group);
   - an empty `Disallow:`;
   - a `Sitemap:` between groups.

   The verdict must still match Google's behaviour. Task 1 tests the BOM, CRLF, empty-disallow and group-split cases.
2. **Pages with no tags at all.** The previews fall back to the host and title, the missing-tags snippet lists everything, and there's no `undefined`. Tasks 2 and 4 test this.
3. **Huge or odd `og:image` files:** SVG, an animated GIF, a 10 000 px image. No thumbnail where decoding fails, the thumbnail encode doesn't blow the stack, and the size finding uses the real bytes. Task 3 tests a big buffer through the chunked base64 helper.
4. **Mixed-script pages,** for example an English page with an Arabic paragraph. The dominant script decides the formula, and English pages keep Flesch. Task 5 tests this.
5. **Readings made before this batch.** They have no `lineLengths`, no thumbnail and no verdict, so every new piece must be missing gracefully, with no NaN. Tasks 4–6 test this.

---

### Task 1: Robots.txt verdict, `X-Robots-Tag` and `ai.txt` (`well-known`)

**Files:**
- Modify: `extension/plugins/well-known.js`
- Test: `test/robots.test.mjs` (new); `test/plugins.test.mjs` (adjust the AI finding, if one is asserted)

**Interfaces:**
- Produces:
  - `parseRobotsFile(text) → { groups: [{ agents, rules: [{ type, path }] }], sitemaps, unknown: string[], crawlDelay: string|null, noindex: number, duplicates: string[] }`;
  - `groupFor(groups, token) → { agents, rules } | null`;
  - `robotsAllowed(group, path) → { allowed, rule }`;
  - `xRobots(values) → { all: string[], byAgent: { [agent]: string[] } }`;
  - `CRAWLERS`;
  - `well-known` `data.indexing = [{ name, token, crawl, rule, index, indexSource }]`, plus `data.aiTxt`.

- [ ] **Step 1: Write the failing tests** in `test/robots.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { parseRobotsFile, groupFor, robotsAllowed, xRobots, CRAWLERS } from '../extension/plugins/well-known.js';

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
  ```

  Append a plugin-level test to the same file. It drives `well-known`'s `run` with a mocked fetch: a robots.txt that blocks this page for Googlebot and GPTBot, an `ai.txt`, and an `X-Robots-Tag: noindex` header on the main document.

  ```js
  import wellKnown from '../extension/plugins/well-known.js';
  import * as util from '../extension/core/har-util.js';
  import { mockFetch } from './helpers.mjs';

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
  ```

  Check how `well-known`'s `run` reaches `fetch`: it calls a local `get(ctx, url)`, which uses `ctx.fetch`. Adapt the `ctx` to what `get` needs, for example `ctx.signal`. Check that `mockFetch` returns 404 HTML for the other files. The plugin throws "site unreachable" only when robots, security, sitemap and favicon *all* error; a 404 is not an error.

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/robots.test.mjs`

  Expected: FAIL, because the exports are missing.

- [ ] **Step 3: Implement.** In `extension/plugins/well-known.js`, add after `parseRobots`:

  ```js
  export const CRAWLERS = [['Googlebot', 'googlebot'], ['Bingbot', 'bingbot'], ['GPTBot', 'gptbot'], ['ClaudeBot', 'claudebot'],
    ['Google-Extended', 'google-extended'], ['CCBot', 'ccbot'], ['PerplexityBot', 'perplexitybot'], ['Applebot-Extended', 'applebot-extended']];
  const AI_TOKENS = new Set(CRAWLERS.slice(2).map((c) => c[1]));
  const KNOWN_DIRECTIVES = new Set(['user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay', 'host', 'noindex']);

  /** Google-compatible robots.txt parse: groups (agents + rules), sitemaps, and directives Google ignores. */
  export function parseRobotsFile(text = '') {
    const groups = [];
    let cur = null;
    const unknown = new Set();
    const sitemaps = [];
    let crawlDelay = null;
    let noindex = 0;
    for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim();
      const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (!KNOWN_DIRECTIVES.has(key)) { unknown.add(m[1]); continue; }
      if (key === 'user-agent') {
        if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); }
        cur.agents.push(value.toLowerCase());
      } else if (key === 'allow' || key === 'disallow') cur?.rules.push({ type: key, path: value });
      else if (key === 'sitemap') sitemaps.push(value);
      else if (key === 'crawl-delay') crawlDelay = value;
      else if (key === 'noindex') noindex++;
    }
    const seen = new Map();
    for (const g of groups) for (const a of new Set(g.agents)) seen.set(a, (seen.get(a) || 0) + 1);
    return { groups, sitemaps, unknown: [...unknown], crawlDelay, noindex, duplicates: [...seen].filter(([, n]) => n > 1).map(([a]) => a) };
  }

  /** The rules that apply to a crawler token: the longest matching agent token (groups merged), else '*', else null. */
  export function groupFor(groups = [], token = '') {
    const t = String(token).toLowerCase();
    let agent = null;
    for (const g of groups) for (const a of g.agents) if (a !== '*' && t.startsWith(a) && (!agent || a.length > agent.length)) agent = a;
    const pick = agent ?? (groups.some((g) => g.agents.includes('*')) ? '*' : null);
    if (pick == null) return null;
    return { agents: [pick], rules: groups.filter((g) => g.agents.includes(pick)).flatMap((g) => g.rules) };
  }

  function patternRe(p) {
    const anchored = p.endsWith('$');
    const body = (anchored ? p.slice(0, -1) : p).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${body}${anchored ? '$' : ''}`);
  }

  /** Google's rule: longest matching pattern wins; allow wins ties; empty disallow matches nothing. */
  export function robotsAllowed(group, path) {
    if (!group) return { allowed: true, rule: null };
    let best = null;
    for (const r of group.rules) {
      if (!r.path || !patternRe(r.path).test(path)) continue;
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.type === 'allow')) best = r;
    }
    return { allowed: !best || best.type === 'allow', rule: best ? `${best.type === 'allow' ? 'Allow' : 'Disallow'}: ${best.path}` : null };
  }

  const XR_DIRECTIVE = /^(noindex|nofollow|none|all|noarchive|nocache|nosnippet|max-snippet|max-image-preview|max-video-preview|unavailable_after|noimageindex|notranslate|indexifembedded)$/i;
  /** X-Robots-Tag header values → directives for everyone, and per named user agent. */
  export function xRobots(values = []) {
    const out = { all: [], byAgent: {} };
    const split = (s) => String(s).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    for (const v of values) {
      const m = String(v).match(/^\s*([a-z][\w-]*)\s*:\s*(.+)$/i);
      if (m && !XR_DIRECTIVE.test(m[1])) (out.byAgent[m[1].toLowerCase()] ||= []).push(...split(m[2]));
      else out.all.push(...split(v));
    }
    return out;
  }
  ```

  In `run`:
  - Add `get(ctx, at('/ai.txt'))` to the `Promise.all` list, as a new `aiR` at the end, and adjust the destructuring.
  - Add `const aiTxt = isText(aiR) ? { bytes: aiR.text.length } : null;`.
  - After `robots` is computed, add:

    ```js
      const file = isText(robotsR) ? parseRobotsFile(robotsR.text) : null;
      let path = '/';
      try { const u = new URL(ctx.target.finalUrl || ctx.target.url || origin); path = u.pathname + u.search; } catch { /* keep / */ }
      const doc = ctx.util?.mainEntry?.(reading);
      const headerVals = (doc?.response?.headers || []).filter((x) => /^x-robots-tag$/i.test(x.name)).map((x) => x.value);
      const xr = xRobots(headerVals);
      const metaD = ctx.results?.meta?.data || {};
      const noindexIn = (list = []) => list.some((d) => d === 'noindex' || d === 'none');
      const indexing = CRAWLERS.map(([name, token]) => {
        const v = file ? robotsAllowed(groupFor(file.groups, token), path) : { allowed: true, rule: null };
        let indexSource = null;
        if (/noindex|none/i.test(metaD.robots || '')) indexSource = 'meta robots';
        else if (token === 'googlebot' && /noindex|none/i.test(metaD.googlebot || '')) indexSource = 'meta googlebot';
        else if (noindexIn(xr.all) || noindexIn(xr.byAgent[token])) indexSource = 'X-Robots-Tag';
        return { name, token, crawl: v.allowed, rule: v.rule, index: !indexSource, indexSource };
      });
    ```

  - **Replace** the old AI finding (`blockedAi` … `robots.txt blocks N AI crawlers`). Keep the `blockedAi` variable only if something else uses it. Add:

    ```js
      for (const r of indexing.filter((x) => (x.token === 'googlebot' || x.token === 'bingbot') && !x.crawl)) add('medium', 'seo', `This page is blocked for ${r.name} by robots.txt`, r.rule);
      if (noindexIn(xr.all) || noindexIn(xr.byAgent.googlebot)) add('medium', 'seo', 'X-Robots-Tag header asks search engines not to index this page');
      if (file?.noindex) add('low', 'seo', 'robots.txt uses noindex, which search engines ignore');
      if (file?.crawlDelay != null) add('info', 'seo', 'robots.txt sets crawl-delay (Google ignores it)');
      if (file?.unknown.length) add('info', 'seo', `robots.txt has ${file.unknown.length} unrecognised directives`, file.unknown.join(', '));
      if (file?.duplicates.length) add('info', 'seo', `robots.txt lists ${file.duplicates.join(', ')} in more than one group`);
      const aiBlocked = indexing.filter((r) => AI_TOKENS.has(r.token) && !r.crawl);
      if (aiBlocked.length) add('info', 'intel', `robots.txt blocks ${aiBlocked.length} AI crawlers from this page`, aiBlocked.map((r) => r.name).join(', '));
      if (aiTxt) add('info', 'intel', 'Publishes ai.txt');
    ```

  - Add `indexing` and `aiTxt` to `data`.
  - In `render`, add an "Indexing" table:

    ```js
      ${d.indexing?.length ? h.sub('Indexing (this page)', h.table(d.indexing.map((r) => ({
        crawler: r.name, crawl: r.crawl ? 'allowed' : `blocked (${r.rule})`, index: r.index ? 'allowed' : `noindex (${r.indexSource})`,
      })), [{ key: 'crawler', label: 'Crawler' }, { key: 'crawl', label: 'Crawl' }, { key: 'index', label: 'Index' }])) : ''}
    ```

    Put it inside `render`'s existing `h.html` template; `render` names its data `d`.

  If `test/plugins.test.mjs` or the e2e asserts the old title `robots.txt blocks N AI crawlers` (without "from this page"), update it to the new title and the per-page count, and say so.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `node --test test/robots.test.mjs`, then `npm test`.

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/well-known.js test/robots.test.mjs test/plugins.test.mjs
  git commit -m "Well-known: Google-compatible robots matching, per-crawler indexing verdict, X-Robots-Tag, ai.txt

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 2: Metadata extras and the missing-tags snippet (`meta`)

**Files:**
- Modify: `extension/plugins/meta.js` (`collect`, `run`, `render`; new export `missingTags`)
- Modify: `extension/ui/reading.js` (the `data-copy` click handler)
- Test: `test/plugins.test.mjs` (append)

**Interfaces:**
- Produces:
  - `missingTags(metaData, target) → { tags: [{ tag, html }], snippet }`;
  - meta `data.counts = { title, description, viewport }`;
  - meta `data.dupProps: string[]`.

- [ ] **Step 1: Write the failing tests.** Append to `test/plugins.test.mjs`. The existing meta test there already defines a `collected()` stub and `run()`; reuse them if they're in scope. Otherwise copy the stub from that test.

  ```js
  import { missingTags } from '../extension/plugins/meta.js';

  test('meta: og:url vs canonical, relative share images, duplicates', () => {
    const base = {
      url: 'https://s.test/a', title: 'A good page title here', description: 'A long enough description of the page for search.', canonical: 'https://s.test/a',
      robots: '', googlebot: '', viewport: 'width=device-width', og: { 'og:title': 'x', 'og:image': 'https://s.test/i.png', 'og:url': 'https://s.test/a/?utm_source=x#top' },
      twitter: { 'twitter:card': 'summary' }, icons: ['/f.ico'], jsonld: [{ '@type': 'Organization' }], jsonldErrors: [], compatMode: 'CSS1Compat', charset: 'UTF-8',
      images: { noDimensions: 0, total: 0 }, forms: [], headings: [{ level: 1, text: 'H' }], links: { externalUrls: [] }, generator: [], emails: [], phones: [],
      words: 10, domElements: 10, customElements: [], counts: { title: 1, description: 1, viewport: 1 }, dupProps: [],
    };
    const t = (c) => meta.run({}, { collected: c, util: hu, target: { site: 's.test' }, skip: (m) => { throw new Error(m); } }).findings.map((f) => f.title);
    assert.ok(!t(base).includes('og:url differs from the canonical URL'), 'trailing slash, utm and hash are ignored');
    assert.ok(t({ ...base, og: { ...base.og, 'og:url': 'https://s.test/b' } }).includes('og:url differs from the canonical URL'));
    assert.ok(t({ ...base, og: { ...base.og, 'og:image': '/i.png' } }).includes('Share image URL is relative (og:image / twitter:image must be absolute)'));
    assert.ok(t({ ...base, counts: { title: 1, description: 1, viewport: 2 }, dupProps: ['og:title ×2'] }).includes('Duplicate meta tags: 2 viewport, og:title ×2'));
    assert.ok(!t(base).some((x) => x.startsWith('Duplicate meta tags')));
  });

  test('missingTags: fills known values, escapes, lists everything for a bare page', () => {
    const bare = missingTags({ title: 'Tents & "Stoves"', description: '', og: {}, twitter: {} }, { finalUrl: 'https://s.test/p', host: 's.test' });
    assert.deepEqual(bare.tags.map((x) => x.tag), ['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'og:site_name', 'twitter:card', 'description', 'canonical']);
    assert.match(bare.snippet, /<meta property="og:title" content="Tents &amp; &quot;Stoves&quot;">/);
    assert.match(bare.snippet, /<meta property="og:url" content="https:\/\/s\.test\/p">/);
    assert.match(bare.snippet, /<meta property="og:site_name" content="s\.test">/);
    assert.match(bare.snippet, /<meta name="twitter:card" content="summary">/);
    assert.doesNotMatch(bare.snippet, /undefined/);
    const full = missingTags({ title: 'T', description: 'D', canonical: 'https://s.test/p', og: { 'og:title': 1, 'og:description': 1, 'og:image': 1, 'og:url': 1, 'og:type': 1, 'og:site_name': 1 }, twitter: { 'twitter:card': 'summary' } }, {});
    assert.deepEqual(full.tags, []);
    assert.equal(full.snippet, '');
  });
  ```

  Ensure `meta` and `hu` are imported. The earlier meta test in this file imported them mid-file; reuse those bindings, and don't import them twice.

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/plugins.test.mjs`

  Expected: FAIL, because `missingTags` doesn't exist and the findings are missing.

- [ ] **Step 3: Implement.**

  In `meta.js` `collect()`, add these to the returned object. Use the existing `$$` helper.

  ```js
      counts: { title: document.querySelectorAll('title').length, description: $$('meta[name="description" i]').length, viewport: $$('meta[name="viewport" i]').length },
      dupProps: (() => {
        const seen = new Map();
        for (const m of $$('meta[property^="og:" i], meta[name^="og:" i], meta[property^="twitter:" i], meta[name^="twitter:" i]')) {
          const k = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
          if (/^og:image(:|$)|^og:locale:alternate$|^article:tag$/.test(k)) continue; // arrays are allowed
          seen.set(k, (seen.get(k) || 0) + 1);
        }
        return [...seen].filter(([, n]) => n > 1).slice(0, 10).map(([k, n]) => `${k} ×${n}`);
      })(),
  ```

  In `run()`, after the Open Graph findings, add:

  ```js
    const normUrl = (u) => {
      try {
        const x = new URL(u, c.url);
        x.hash = '';
        for (const k of [...x.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(k)) x.searchParams.delete(k);
        return x.href.replace(/\/$/, '');
      } catch { return String(u); }
    };
    if (c.og['og:url'] && c.canonical && normUrl(c.og['og:url']) !== normUrl(c.canonical)) add('low', 'seo', 'og:url differs from the canonical URL', `${c.og['og:url']} vs ${c.canonical}`);
    const relImages = [c.og['og:image'], c.twitter?.['twitter:image']].filter((v) => v && !/^https?:\/\//i.test(v));
    if (relImages.length) add('low', 'seo', 'Share image URL is relative (og:image / twitter:image must be absolute)', relImages.join(', '));
    const dups = [
      c.counts?.title > 1 && `${c.counts.title} title`, c.counts?.description > 1 && `${c.counts.description} description`,
      c.counts?.viewport > 1 && `${c.counts.viewport} viewport`, ...(c.dupProps || []),
    ].filter(Boolean);
    if (dups.length) add('low', 'seo', `Duplicate meta tags: ${dups.join(', ')}`);
  ```

  Export `missingTags`:

  ```js
  /** Recommended tags the page lacks, with a paste-ready snippet filled from what the page already has. */
  export function missingTags(d = {}, target = {}) {
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const og = d.og || {};
    const tw = d.twitter || {};
    const url = d.canonical || target.finalUrl || target.url || '…';
    let host = target.host || '…';
    try { host = new URL(url).host || host; } catch { /* keep */ }
    const want = [
      ['og:title', !og['og:title'], `<meta property="og:title" content="${esc(d.title || '…')}">`],
      ['og:description', !og['og:description'], `<meta property="og:description" content="${esc(d.description || '…')}">`],
      ['og:image', !og['og:image'], '<meta property="og:image" content="https://…">'],
      ['og:url', !og['og:url'], `<meta property="og:url" content="${esc(url)}">`],
      ['og:type', !og['og:type'], '<meta property="og:type" content="website">'],
      ['og:site_name', !og['og:site_name'], `<meta property="og:site_name" content="${esc(host)}">`],
      ['twitter:card', !tw['twitter:card'], `<meta name="twitter:card" content="${og['og:image'] ? 'summary_large_image' : 'summary'}">`],
      ['description', !d.description, '<meta name="description" content="…">'],
      ['canonical', !d.canonical, `<link rel="canonical" href="${esc(target.finalUrl || target.url || '…')}">`],
    ].filter(([, missing]) => missing).map(([tag, , html]) => ({ tag, html }));
    return { tags: want, snippet: want.map((w) => w.html).join('\n') };
  }
  ```

  In `render(r, h)`, add a section at the end. `render` has no `target`, so use `d.url`, which `collect` records.

  ```js
      ${(() => {
        const m = missingTags(d, { finalUrl: d.url });
        return m.tags.length ? h.sub(`Missing tags (${m.tags.length})`, h.html`<pre class="snippet">${m.snippet}</pre><button class="btn" type="button" data-copy="${m.snippet}">Copy tags</button>`) : '';
      })()}
  ```

  In `extension/ui/reading.js`, add a delegated click handler next to the other document-level handlers:

  ```js
  document.addEventListener('click', async (e) => {
    const b = e.target.closest?.('[data-copy]');
    if (!b) return;
    await navigator.clipboard.writeText(b.getAttribute('data-copy')).then(() => toast('Copied'), () => toast('Copy failed'));
  });
  ```

  Check whether a similar delegated handler already exists; if so, extend it instead.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS. If an existing meta test counts findings exactly, update it, and give the reason.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/meta.js extension/ui/reading.js test/plugins.test.mjs
  git commit -m "Meta: og:url vs canonical, relative share images, duplicate tags, missing-tags snippet with copy

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 3: `og:image` bytes, thumbnail and size finding (`links`)

**Files:**
- Modify: `extension/plugins/links.js` (`ogImage`, `run`; new export `toDataUrl`)
- Test: `test/links.test.mjs` (append)

**Interfaces:**
- Produces:
  - `links` `data.ogImage = { url, status, bytes?, width?, height?, thumb?, tooLarge?, error? }`, where `thumb` is a `data:image/webp;base64,…` string;
  - `toDataUrl(bytes: Uint8Array, type) → string`, a chunked base64 encoder.

- [ ] **Step 1: Write the failing tests.** Append to `test/links.test.mjs`. It already has a `ctx(...)` helper and a stubbed `fetch`.

  ```js
  import { toDataUrl } from '../extension/plugins/links.js';

  test('toDataUrl: chunked base64, no stack overflow on large buffers', () => {
    assert.equal(toDataUrl(new Uint8Array([104, 105]), 'image/webp'), 'data:image/webp;base64,aGk=');
    const big = new Uint8Array(300_000).fill(65);
    const out = toDataUrl(big, 'image/webp');
    assert.ok(out.startsWith('data:image/webp;base64,QUFB'));
    assert.equal(out.length, 'data:image/webp;base64,'.length + 400_000);
  });

  test('og:image: bytes recorded; >5 MB gives a low finding; thumbnail when canvas exists; none in Node', async () => {
    const big = await plugin.run({}, ctx({ og: 'https://s.test/og.png', routes: { 'https://s.test/og.png': { status: 200, body: 'x'.repeat(10), headers: { 'content-length': String(6 * 1024 * 1024) } } } }));
    assert.ok(big.findings.some((f) => f.title === 'Share image is 6.0 MB (X limits images to 5 MB)'), big.findings.map((f) => f.title).join(' | '));
    const plain = await plugin.run({}, ctx({ og: 'https://s.test/og.png', routes: { 'https://s.test/og.png': { status: 200, body: 'xx' } } }));
    assert.equal(plain.data.ogImage.thumb, undefined, 'no decoder in Node');
    const saved = { cib: globalThis.createImageBitmap, oc: globalThis.OffscreenCanvas };
    globalThis.createImageBitmap = async () => ({ width: 1200, height: 630, close() {} });
    globalThis.OffscreenCanvas = class { constructor(w, h) { this.w = w; this.h = h; } getContext() { return { drawImage() {} }; } async convertToBlob() { return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }); } };
    try {
      const r = await plugin.run({}, ctx({ og: 'https://s.test/og.png', routes: { 'https://s.test/og.png': { status: 200, body: 'xxxx' } } }));
      assert.equal(r.data.ogImage.width, 1200);
      assert.equal(r.data.ogImage.bytes, 4);
      assert.equal(r.data.ogImage.thumb, 'data:image/webp;base64,AQID');
    } finally {
      if (saved.cib) globalThis.createImageBitmap = saved.cib; else delete globalThis.createImageBitmap;
      if (saved.oc) globalThis.OffscreenCanvas = saved.oc; else delete globalThis.OffscreenCanvas;
    }
  });
  ```

  The links test's `stub()` builds `Response` objects. If it doesn't pass `headers` through, extend it to accept `headers`, so the `content-length` test works. Response bodies are strings; `blob().size` gives their byte length.

  For the >5 MB case:
  - `content-length` is 6 MB, which is under the 10 MB "too large" cap, so the image is still fetched;
  - `bytes` is taken from `content-length` when the blob is smaller, here 10 bytes. **Rule:** `bytes = Math.max(content-length || 0, blob.size)`;
  - 6 291 456 / 1 048 576 = **6.0** MB.

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/links.test.mjs`

  Expected: FAIL.

- [ ] **Step 3: Implement** in `links.js`.

  Add:

  ```js
  /** Bytes → data URL, base64-encoded in 32 KB chunks (no argument-count limits). */
  export function toDataUrl(bytes, type) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(bin)}`;
  }
  ```

  Replace the body of `ogImage()` after the `tooLarge` check with:

  ```js
      const declared = Number(res.headers?.get('content-length')) || 0;
      if (typeof globalThis.createImageBitmap !== 'function') { cancel(res); return { ...out, bytes: declared || undefined }; }
      const blob = await res.blob();
      out.bytes = Math.max(declared, blob.size);
      try {
        const bmp = await globalThis.createImageBitmap(blob);
        out.width = bmp.width;
        out.height = bmp.height;
        if (typeof globalThis.OffscreenCanvas === 'function' && bmp.width > 0) {
          const scale = Math.min(1, 600 / bmp.width);
          const w = Math.max(1, Math.round(bmp.width * scale));
          const hh = Math.max(1, Math.round(bmp.height * scale));
          const canvas = new globalThis.OffscreenCanvas(w, hh);
          canvas.getContext('2d').drawImage(bmp, 0, 0, w, hh);
          const t = await canvas.convertToBlob({ type: 'image/webp', quality: 0.7 });
          out.thumb = toDataUrl(new Uint8Array(await t.arrayBuffer()), t.type || 'image/webp');
        }
        bmp.close?.();
      } catch { /* SVG or undecodable: no size, no thumbnail */ }
      return out;
  ```

  In `run`, after the existing `og` size finding (the "Open Graph image is W×H" check), add:

  ```js
    if (og?.bytes > 5_242_880) add('low', `Share image is ${(og.bytes / 1_048_576).toFixed(1)} MB (X limits images to 5 MB)`, ogUrl);
  ```

  `add` in `links.js` uses category `content`. The spec lists this finding under the meta section with category `seo`. Use `seo` by passing it explicitly if `add` allows; otherwise push the finding object directly with category `seo`.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/links.js test/links.test.mjs
  git commit -m "Links: og:image bytes and size finding, 600 px WebP thumbnail for share previews

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 4: Share previews (`ui/previews.js` plus the meta glance)

**Files:**
- Create: `extension/ui/previews.js`
- Modify: `extension/plugins/meta.js` (add `glance`)
- Modify: `extension/ui/report.js` (`glances` passes `interactive` in its ctx)
- Modify: `extension/ui/theme.css` (`.previews`, `.pv-*`)
- Test: `test/previews.test.mjs` (new)

**Interfaces:**
- Consumes:
  - meta `data`: `title`, `description`, `canonical`, `og`, `twitter`, `themeColor`, `url`;
  - `ctx.results.links.data.ogImage` (Task 3);
  - `ctx.target`.
- Produces:
  - `previewModel(metaData, { target, ogImage, interactive }) → model`;
  - `renderPreviews(model, h) → html` with 7 `figure.pv-card` elements.

- [ ] **Step 1: Write the failing tests** in `test/previews.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { previewModel, renderPreviews } from '../extension/ui/previews.js';
  import { h } from '../extension/ui/render.js';
  import meta from '../extension/plugins/meta.js';

  const target = { finalUrl: 'https://www.s.test/shop/tents?x=1', host: 'www.s.test' };
  const full = {
    title: 'Tents for every trail and every weather condition you might face', description: 'D'.repeat(200), canonical: 'https://www.s.test/shop/tents',
    og: { 'og:title': 'OG title', 'og:description': 'OG description', 'og:image': '/img/og.jpg', 'og:site_name': 'Terra' },
    twitter: { 'twitter:card': 'summary_large_image', 'twitter:title': 'TW title' }, themeColor: '#2a7',
  };

  test('model: platform fallbacks and image choice', () => {
    const m = previewModel(full, { target, ogImage: { thumb: 'data:image/webp;base64,AAAA' }, interactive: true });
    assert.equal(m.siteName, 'Terra');
    assert.equal(m.google.title, full.title);
    assert.equal(m.og.title, 'OG title');
    assert.equal(m.x.title, 'TW title');
    assert.equal(m.x.description, 'OG description');
    assert.equal(m.x.card, 'summary_large_image');
    assert.equal(m.og.image, 'data:image/webp;base64,AAAA');
    assert.equal(m.themeColor, '#2a7');
    const bare = previewModel({ og: {}, twitter: {} }, { target, interactive: false });
    assert.equal(bare.og.title, 'www.s.test');
    assert.equal(bare.x.card, 'summary');
    assert.equal(bare.og.image, '');
    assert.equal(previewModel({ ...full, themeColor: 'red;}' }, { target }).themeColor, '');
    const remote = previewModel({ ...full, og: { ...full.og, 'og:image': 'https://cdn.s.test/og.jpg' } }, { target, interactive: true });
    assert.equal(remote.og.image, 'https://cdn.s.test/og.jpg');
    assert.equal(previewModel({ ...full, og: { ...full.og, 'og:image': 'https://cdn.s.test/og.jpg' } }, { target, interactive: false }).og.image, '', 'export never loads remote images');
  });

  test('render: seven cards, truncation, escaping, no undefined', () => {
    const out = String(renderPreviews(previewModel({ ...full, title: '<b>x</b> ' + 'y'.repeat(80) }, { target, ogImage: null, interactive: false }), h));
    assert.equal((out.match(/class="pv-card /g) || []).length, 7);
    for (const name of ['Google', 'X', 'Facebook', 'LinkedIn', 'Slack', 'Discord', 'Bluesky']) assert.match(out, new RegExp(`<figcaption>${name}</figcaption>`));
    assert.match(out, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.match(out, /D{154}…/, 'Google description cut to 155 with an ellipsis');
    assert.match(out, /WWW\.S\.TEST/, 'Facebook domain upper-cased');
    assert.match(out, /border-left-color:#2a7/);
    assert.match(out, /pv-noimg/);
    assert.doesNotMatch(out, /undefined|NaN/);
  });

  test('meta glance renders the previews from ctx', () => {
    const out = String(meta.glance({ status: 'ok', data: { ...full, url: target.finalUrl } }, h, { target, results: { links: { data: { ogImage: { thumb: 'data:image/webp;base64,AAAA' } } } }, interactive: true }));
    assert.match(out, /Share previews/);
    assert.match(out, /src="data:image\/webp;base64,AAAA"/);
  });
  ```

  Arithmetic for the Google description:
  - the description is 200 `D`s and the Google limit is 155;
  - `cut` keeps 154 characters and adds `…`, so the output contains exactly 154 `D`s followed by `…`.

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/previews.test.mjs`

  Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `extension/ui/previews.js`:**

  ```js
  // Share and search previews drawn from a page's tags. Pure: a model from metadata, then h.html markup.
  // Approximations of each platform's layout — no brand assets.

  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  const cut = (s, n) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
  };

  export function previewModel(d = {}, { target = {}, ogImage = null, interactive = true } = {}) {
    const og = d.og || {};
    const tw = d.twitter || {};
    const page = target.finalUrl || target.url || d.url || '';
    const url = d.canonical || page;
    let host = target.host || '';
    try { host = new URL(url || page).host || host; } catch { /* keep */ }
    const abs = (u) => { try { return u ? new URL(u, page || url).href : ''; } catch { return ''; } };
    const ogImg = abs(og['og:image']);
    const twImg = abs(tw['twitter:image']) || ogImg;
    const src = (u) => (ogImage?.thumb && u && u === ogImg ? ogImage.thumb : interactive && /^https?:\/\//.test(u) ? u : '');
    let path = '';
    try { path = new URL(url).pathname.split('/').filter(Boolean).join(' › '); } catch { /* none */ }
    return {
      host, url, path,
      siteName: og['og:site_name'] || host,
      themeColor: HEX.test(String(d.themeColor || '')) ? d.themeColor : '',
      google: { title: d.title || og['og:title'] || host, description: d.description || og['og:description'] || '' },
      og: { title: og['og:title'] || d.title || host, description: og['og:description'] || d.description || '', image: src(ogImg) },
      x: {
        card: tw['twitter:card'] === 'summary_large_image' ? 'summary_large_image' : 'summary',
        title: tw['twitter:title'] || og['og:title'] || d.title || host,
        description: tw['twitter:description'] || og['og:description'] || d.description || '',
        image: src(twImg),
      },
    };
  }

  export function renderPreviews(m, h) {
    const img = (s, cls = '') => (s ? h.html`<img class="pv-img ${cls}" src="${s}" alt="" loading="lazy">` : h.html`<div class="pv-img pv-noimg ${cls}">no image</div>`);
    const card = (name, body, style = '') => h.html`<figure class="pv-card pv-${name.toLowerCase()}"${style ? h.raw(` style="${style}"`) : ''}><figcaption>${name}</figcaption>${body}</figure>`;
    const google = card('Google', h.html`<div class="pv-site"><span class="pv-fav">${(m.siteName || '?').slice(0, 1).toUpperCase()}</span><span><b>${m.siteName}</b><small>${m.host}${m.path ? ` › ${m.path}` : ''}</small></span></div>
      <div class="pv-gtitle">${cut(m.google.title, 60)}</div><p>${cut(m.google.description, 155)}</p>`);
    const x = m.x.card === 'summary_large_image'
      ? card('X', h.html`${img(m.x.image, 'pv-wide')}<div class="pv-body"><small>${m.host}</small><b>${cut(m.x.title, 70)}</b></div>`)
      : card('X', h.html`<div class="pv-row">${img(m.x.image, 'pv-square')}<div class="pv-body"><small>${m.host}</small><b>${cut(m.x.title, 70)}</b><p>${cut(m.x.description, 125)}</p></div></div>`);
    const facebook = card('Facebook', h.html`${img(m.og.image, 'pv-wide')}<div class="pv-body"><small>${m.host.toUpperCase()}</small><b>${cut(m.og.title, 88)}</b><p>${cut(m.og.description, 110)}</p></div>`);
    const linkedin = card('LinkedIn', h.html`${img(m.og.image, 'pv-wide')}<div class="pv-body"><b>${cut(m.og.title, 70)}</b><small>${m.host}</small></div>`);
    const slack = card('Slack', h.html`<div class="pv-body pv-slack"><small><b>${m.siteName}</b></small><a class="pv-link">${m.og.title}</a><p>${cut(m.og.description, 150)}</p>${img(m.og.image, 'pv-small')}</div>`);
    const discord = card('Discord', h.html`<div class="pv-body"><small>${m.siteName}</small><a class="pv-link">${m.og.title}</a><p>${cut(m.og.description, 350)}</p>${img(m.og.image, 'pv-wide')}</div>`,
      m.themeColor ? `border-left-color:${m.themeColor}` : '');
    const bluesky = card('Bluesky', h.html`${img(m.og.image, 'pv-wide')}<div class="pv-body"><b>${cut(m.og.title, 70)}</b><p>${cut(m.og.description, 150)}</p><small>${m.host}</small></div>`);
    return h.html`${google}${x}${facebook}${linkedin}${slack}${discord}${bluesky}`;
  }
  ```

  - Check that `h.raw` exists; `render.js` exports `raw` in `h`. `themeColor` is validated against `HEX` before it reaches the raw style.
  - `img` src values are always a `data:image/…` thumbnail, an `https?:` URL, or nothing, and `h.html` escapes them.

  In `meta.js`, import `previewModel` and `renderPreviews` from `'../ui/previews.js'` and add:

  ```js
  function glance(r, h, ctx = {}) {
    const m = previewModel(r.data, { target: ctx.target || { finalUrl: r.data.url }, ogImage: ctx.results?.links?.data?.ogImage, interactive: ctx.interactive !== false });
    return h.html`<section class="card previews"><h4>Share previews</h4><div class="pv-grid">${renderPreviews(m, h)}</div></section>`;
  }
  ```

  Add `glance,` to the export.

  - The plugin module imports a UI module. That's acceptable here: `previews.js` is pure, with no DOM or chrome APIs.
  - Check that the CLI still loads: `node cli/harplus.mjs plugins`. The `meta` plugin is imported there through the registry.

  In `report.js`:
  - change `glances(ran, plugins, reading)` to take `interactive`, and set `ctx.interactive = interactive`;
  - pass `interactive` from `areaPane`, which already has it.

  In `theme.css`, add:

  ```css
    .pv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr)); gap: 0.9rem; }
    .pv-card { margin: 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--surface, #fff); font-size: 0.82rem; }
    .pv-card figcaption { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--line); }
    .pv-img { display: block; width: 100%; object-fit: cover; background: var(--line); }
    .pv-wide { aspect-ratio: 1.91 / 1; }
    .pv-square { width: 6rem; aspect-ratio: 1; flex: none; }
    .pv-small { max-width: 8rem; margin-top: 0.4rem; border-radius: 6px; }
    .pv-noimg { display: grid; place-items: center; color: var(--muted); font-size: 0.75rem; min-height: 4rem; }
    .pv-body { display: grid; gap: 0.2rem; padding: 0.55rem 0.65rem; }
    .pv-body p, .pv-card > p { margin: 0; color: var(--muted); }
    .pv-row { display: flex; gap: 0.6rem; }
    .pv-site { display: flex; gap: 0.5rem; align-items: center; padding: 0.55rem 0.65rem 0; }
    .pv-site small { display: block; color: var(--muted); }
    .pv-fav { display: grid; place-items: center; width: 1.6rem; height: 1.6rem; border-radius: 50%; background: var(--line); font-weight: 700; }
    .pv-gtitle { color: #1a0dab; font-size: 1rem; padding: 0.2rem 0.65rem; }
    .pv-card > p { padding: 0 0.65rem 0.6rem; }
    .pv-link { color: #1d9bd1; font-weight: 600; }
    .pv-discord { border-left: 4px solid #1e1f22; }
    .snippet { white-space: pre-wrap; font-size: 0.78rem; }
  ```

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS. If a report test now counts glances or matches strings the new meta glance changes, update it, and say why.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/ui/previews.js extension/plugins/meta.js extension/ui/report.js extension/ui/theme.css test/previews.test.mjs
  git commit -m "Share previews: Google, X, Facebook, LinkedIn, Slack, Discord and Bluesky cards from the page's tags

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 5: Readability in every language (`content`)

**Files:**
- Modify: `extension/plugins/content.js` (new exports `scriptOf`, `ari`, `aari`, `hardest`; `analyze`, `glance`, `render`)
- Test: `test/content.test.mjs`

**Interfaces:**
- Produces: `data.reading` gains `script`, `ari`, `aari`, `cjkCharsPerSentence`, `hardest: [{ text, words, chars }]`, and `readability` ∈ `'flesch' | 'ari' | 'aari' | 'cjk' | 'not enough text' | 'not applicable: <script>'`.

- [ ] **Step 1: Write the failing tests.** Update and append to `test/content.test.mjs`, adding `scriptOf`, `ari`, `aari` and `hardest` to its import from `content.js`.

  Replace the existing test `readability skipped for non-English pages` with:

  ```js
  test('French page: ARI instead of Flesch, with grade findings', () => {
    const r = analyze(base({ lang: 'fr', text: `${words(300, 'extraordinairement')}.` }), { meta: {}, url: 'https://www.site.test/' });
    assert.equal(r.data.reading.english, false);
    assert.equal(r.data.reading.flesch, null);
    assert.equal(r.data.reading.readability, 'ari');
    assert.ok(r.data.reading.ari > 16);
    assert.ok(titles(r).includes(`Hard to read (ARI grade ${Math.round(r.data.reading.ari)})`));
    assert.equal(r.findings.find((f) => f.title.startsWith('Hard to read (ARI')).severity, 'medium');
  });
  ```

  The text is one sentence of 300 words, each 18 letters. ARI = 4.71·18 + 0.5·300 − 21.43 = 84.78 + 150 − 21.43 = 213.35, which is above 16, so medium.

  Append:

  ```js
  test('scriptOf: dominant script', () => {
    assert.equal(scriptOf('Hello world'), 'latin');
    assert.equal(scriptOf('Привет мир'), 'cyrillic');
    assert.equal(scriptOf('Γειά σου'), 'greek');
    assert.equal(scriptOf('مرحبا بكم في متجرنا'), 'arabic');
    assert.equal(scriptOf('日本語の文章です'), 'cjk');
    assert.equal(scriptOf('שלום עולם'), 'hebrew');
    assert.equal(scriptOf('Hello world. مرحبا'), 'latin', 'dominant wins');
    assert.equal(scriptOf(''), 'other');
  });

  test('ARI and AARI arithmetic', () => {
    assert.equal(ari({ letters: 31, words: 10, sentences: 2 }).toFixed(2), '-4.33');
    assert.equal(ari({ letters: 0, words: 0, sentences: 0 }), null);
    assert.equal(aari({ letters: 40, words: 10, sentences: 2 }).toFixed(2), '77.52');
  });

  test('ARI thresholds: >12 low, >16 medium, ≤12 none (German page)', () => {
    const mk = (wordLen, perSentence, n = 20) => Array.from({ length: n }, () => `${words(perSentence, 'a'.repeat(wordLen))}.`).join(' ');
    const g = (t) => analyze(base({ lang: 'de', text: t }), { meta: {}, url: 'https://www.site.test/' });
    assert.equal(g(mk(5, 10)).findings.filter((f) => f.title.startsWith('Hard to read')).length, 0);
    assert.equal(g(mk(6, 15)).findings.find((f) => f.title.startsWith('Hard to read')).severity, 'low');
    assert.equal(g(mk(7, 15)).findings.find((f) => f.title.startsWith('Hard to read')).severity, 'medium');
  });

  test('Arabic: AARI shown, not scored; CJK chars per sentence; hardest sentences in any language', () => {
    const ar = analyze(base({ lang: 'ar', text: 'مرحبا بكم في متجرنا. نقدم الشحن المجاني على جميع الطلبات.' }), { meta: {}, url: 'https://www.site.test/' });
    assert.equal(ar.data.reading.readability, 'aari');
    assert.ok(ar.data.reading.aari > 0);
    assert.ok(!titles(ar).some((t) => t.startsWith('Hard to read')));
    const ja = analyze(base({ lang: 'ja', text: '今日はいい天気です。明日も晴れるでしょう。' }), { meta: {}, url: 'https://www.site.test/' });
    assert.equal(ja.data.reading.readability, 'cjk');
    assert.equal(ja.data.reading.cjkCharsPerSentence, 10);
    const hs = hardest(['short one', 'a much longer sentence with many more words in it', 'mid length sentence here'], 'latin');
    assert.equal(hs[0].words, 10);
    assert.equal(hs.length, 3);
  });
  ```

  Arithmetic:
  - **ARI** `{31, 10, 2}`: 4.71·3.1 = 14.601, plus 0.5·5 = 2.5, minus 21.43, gives −4.329, which prints as −4.33.
  - **AARI** `{40, 10, 2}` (per-sentence ruling): 3.28·(40/2) = 65.6, plus 1.43·4 = 5.72, plus 1.24·5 = 6.2, gives 77.52.
  - **German thresholds:** `mk(5, 10)`: 23.55 + 5 − 21.43 = 7.12, no finding. `mk(6, 15)`: 28.26 + 7.5 − 21.43 = 14.33, low. `mk(7, 15)`: 32.97 + 7.5 − 21.43 = 19.04, medium.

    The `letters` count uses `[\p{L}\p{N}]`, and the `.` and spaces are excluded.
  - **CJK:** 今日はいい天気です is 9 characters, 明日も晴れるでしょう is 10. The sentence splitter strips the `。`, so the average of 9 and 10 is 9.5, which rounds to **10**.

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/content.test.mjs`

  Expected: FAIL.

- [ ] **Step 3: Implement** in `content.js`:

  ```js
  export function scriptOf(text = '') {
    const counts = { latin: 0, cyrillic: 0, greek: 0, arabic: 0, cjk: 0, hebrew: 0, other: 0 };
    let seen = 0;
    for (const ch of String(text)) {
      if (++seen > 20000) break;
      if (!/\p{L}/u.test(ch)) continue;
      if (/\p{Script=Latin}/u.test(ch)) counts.latin++;
      else if (/\p{Script=Cyrillic}/u.test(ch)) counts.cyrillic++;
      else if (/\p{Script=Greek}/u.test(ch)) counts.greek++;
      else if (/\p{Script=Arabic}/u.test(ch)) counts.arabic++;
      else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)) counts.cjk++;
      else if (/\p{Script=Hebrew}/u.test(ch)) counts.hebrew++;
      else counts.other++;
    }
    const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return n ? best : 'other';
  }

  export const ari = ({ letters, words, sentences }) => (words && sentences ? 4.71 * (letters / words) + 0.5 * (words / sentences) - 21.43 : null);
  // AARI per sentence (ruling): the published form multiplies total letters, which grows with page length.
  export const aari = ({ letters, words, sentences }) => (words && sentences ? 3.28 * (letters / sentences) + 1.43 * (letters / words) + 1.24 * (words / sentences) : null);

  export function hardest(sentences = [], script = 'latin') {
    const cjk = script === 'cjk';
    return sentences
      .map((s) => ({ text: s.length > 120 ? `${s.slice(0, 120)}…` : s, words: countWords(s), chars: [...s.replace(/\s/g, '')].length }))
      .sort((a, b) => (cjk ? b.chars - a.chars : b.words - a.words))
      .slice(0, 5);
  }
  ```

  In `analyze()`, after the existing Flesch computation, add:

  ```js
    const script = scriptOf(c.text);
    const letterCount = (String(c.text).match(/[\p{L}\p{N}]/gu) || []).length;
    const counts = { letters: letterCount, words, sentences: sentences.length };
    const ariVal = !english && ['latin', 'cyrillic', 'greek'].includes(script) ? ari(counts) : null;
    const aariVal = !english && script === 'arabic' ? aari(counts) : null;
    const cjkCps = !english && script === 'cjk' && sentences.length
      ? Math.round(sentences.reduce((n, s) => n + [...s.replace(/\s/g, '')].length, 0) / sentences.length) : null;
  ```

  Add `script`, `ari: ariVal == null ? null : Math.round(ariVal * 10) / 10`, `aari: aariVal == null ? null : Math.round(aariVal)`, `cjkCharsPerSentence: cjkCps` and `hardest: hardest(sentences, script)` to the `reading` object.

  Change `readability` to:

  ```js
      readability: english ? (f ? 'flesch' : 'not enough text') : ariVal != null ? 'ari' : aariVal != null ? 'aari' : cjkCps != null ? 'cjk' : `not applicable: ${script}`,
  ```

  After the Flesch finding, add:

  ```js
    if (ariVal != null && ariVal > 12) add(ariVal > 16 ? 'medium' : 'low', `Hard to read (ARI grade ${Math.round(ariVal)})`);
  ```

  In `glance`:
  - when `rd.flesch == null` and `rd.ari != null`, show the ARI ring with `h.ring({ value: Math.max(0, Math.min(100, Math.round(100 - (rd.ari - 6) * 8))), size: 72, status: rd.ari > 16 ? 'critical' : rd.ari > 12 ? 'serious' : 'good', label: 'ARI grade' })` and the note `ARI grade ${Math.round(rd.ari)}`;
  - otherwise, when `rd.aari != null` or `rd.cjkCharsPerSentence != null`, show an `h.stat` tile with `AARI ${rd.aari}` or `${rd.cjkCharsPerSentence} characters per sentence`.

  In `render`:
  - make the Readability row show the formula and value;
  - add a "Hardest sentences" sub-section: `h.list(d.reading.hardest.map((s) => \`${s.text} (${s.words} words)\`))`.

  Check the existing `English` detection. If `lang` is empty and the text is mostly ASCII, it treats the page as English; keep that.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/content.js test/content.test.mjs
  git commit -m "Content: readability in every language (ARI, AARI, CJK) and the hardest sentences

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 6: Line length (`content`)

**Files:**
- Modify: `extension/plugins/content.js` (`collect` gains `lineLengths`; `analyze`; `glance`)
- Test: `test/content.test.mjs`

**Interfaces:**
- Produces: `data.lineLength = { median, ideal, count }`.

- [ ] **Step 1: Write the failing tests.** Append:

  ```js
  test('line length: median (lower), ideal share, thresholds, missing data', () => {
    const at = (ll) => analyze(base({ text: words(300), lineLengths: ll }), { meta: {}, url: 'https://www.site.test/' });
    const long = at([90, 100, 40, 95]);
    assert.deepEqual(long.data.lineLength, { median: 90, ideal: 0, count: 4 });
    assert.ok(titles(long).includes('Lines are long (median 90 characters)'));
    assert.equal(long.findings.find((f) => f.title.startsWith('Lines are long')).severity, 'low');
    const ok = at([50, 60, 70]);
    assert.deepEqual(ok.data.lineLength, { median: 60, ideal: 100, count: 3 });
    assert.ok(!titles(ok).some((t) => t.startsWith('Lines are')));
    assert.ok(titles(at([20, 30])).includes('Lines are short (median 20 characters)'));
    const none = at(undefined);
    assert.deepEqual(none.data.lineLength, { median: 0, ideal: 0, count: 0 });
    assert.ok(!titles(none).some((t) => t.startsWith('Lines are')));
  });
  ```

  Medians, worked through:
  - `[90, 100, 40, 95]` sorts to `[40, 90, 95, 100]`. The lower median is at index `floor((4−1)/2) = 1`, which is **90**. 90 is above 80, so long.
  - `[50, 60, 70]` gives a median at index 1, which is 60, with 100% in the 45–75 band.
  - `[20, 30]` gives index 0, which is 20.

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/content.test.mjs`

  Expected: FAIL.

- [ ] **Step 3: Implement.** In `content.js` `collect()`, before the `return`, add. It must be self-contained, and it uses the existing `shown` helper.

  ```js
      const lineLengths = [];
      const pool = [...document.querySelectorAll('main p, [role="main"] p, article p')];
      const paras = pool.length ? pool : [...document.querySelectorAll('body p')].filter((p) => !p.closest('nav, header, footer, aside'));
      for (const p of paras) {
        if (lineLengths.length >= 200) break;
        if (!shown(p)) continue;
        const text = (p.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length < 80) continue;
        const range = document.createRange();
        range.selectNodeContents(p);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map((r) => Math.round(r.top)));
        if (tops.size) lineLengths.push(Math.round(text.length / tops.size));
      }
  ```

  Add `lineLengths` to the returned object. Also add `lineLengths: []` to the early return used when `document.body` is null.

  In `analyze()`, add:

  ```js
    const ll = (c.lineLengths || []).filter((n) => n > 0).sort((a, b) => a - b);
    const lineLength = {
      median: ll.length ? ll[Math.floor((ll.length - 1) / 2)] : 0,
      ideal: ll.length ? Math.round((ll.filter((n) => n >= 45 && n <= 75).length / ll.length) * 100) : 0,
      count: ll.length,
    };
    if (lineLength.median > 80) add('low', `Lines are long (median ${lineLength.median} characters)`);
    else if (lineLength.median > 0 && lineLength.median < 35) add('info', `Lines are short (median ${lineLength.median} characters)`);
  ```

  Add `lineLength` to `data`.

  In `glance`, add a stat tile when `d.lineLength?.count`: `h.stat({ label: 'Line length', value: \`${d.lineLength.median} characters\`, note: \`${d.lineLength.ideal}% in 45–75\` })`.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/content.js test/content.test.mjs
  git commit -m "Content: line length (characters per rendered line), long/short findings

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 7: End-to-end checks and the fixture refresh

**Files:**
- Modify: `test/e2e/site/robots.txt`
- Modify: `test/e2e/run.mjs`
- Modify: `test/fixtures/local-site.har` (regenerated)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Extend the site.**

  In `test/e2e/site/robots.txt`, add `Crawl-delay: 5` under `User-agent: *`. Keep the existing GPTBot and CCBot block.

  The test site already has `og:image` set to `/img/big.jpg` (1600×1000) from an earlier batch, so a thumbnail will be produced.

- [ ] **Step 2: Add the assertions** in `test/e2e/run.mjs`, next to the other `r1` plugin checks:

  ```js
      const wk = r1.log._harplus.plugins['well-known'];
      const ix = Object.fromEntries((wk.data.indexing || []).map((r) => [r.token, r]));
      assert.equal(ix.googlebot?.crawl, true, JSON.stringify(wk.data.indexing));
      assert.equal(ix.gptbot?.crawl, false);
      assert.ok(wk.findings.some((f) => f.title === 'robots.txt sets crawl-delay (Google ignores it)'));
      assert.ok(wk.findings.some((f) => /^robots\.txt blocks \d+ AI crawlers from this page$/.test(f.title)));
      const og = r1.log._harplus.plugins.links.data.ogImage;
      assert.match(og?.thumb || '', /^data:image\/webp;base64,/, 'og:image thumbnail');
      const rd = r1.log._harplus.plugins.content.data;
      assert.equal(rd.reading.readability, 'flesch');
      assert.ok(rd.reading.hardest.length >= 1);
      assert.ok(rd.lineLength.count >= 1 && rd.lineLength.median > 0, JSON.stringify(rd.lineLength));
      log('content and sharing passed');
  ```

  Where the report is opened on `page2`, add:

  ```js
      await page2.evaluate(() => { location.hash = 'area-content'; });
      assert.equal(await page2.locator('#area-content .pv-card').count(), 7, 'seven share previews');
      assert.ok(await page2.locator('#area-content .pv-card img[src^="data:image/webp"]').count() >= 1, 'previews use the thumbnail');
  ```

  - If the existing e2e asserts the old `robots.txt blocks N AI crawlers` title, update it to the new per-page title.
  - Check the line-length assertion against the test site. The Arabic paragraph and the link paragraph are each over 80 characters, so at least one paragraph qualifies. If none do, report it rather than weakening the assertion.

- [ ] **Step 3: Run the e2e**

  Run: `npm run test:e2e`

  Expected: `all e2e checks passed`. If it passes on the first run, prove one assertion can fail: temporarily expect 8 cards, run once, see the failure, and revert.

- [ ] **Step 4: Refresh the fixture**

  Run `cp test/e2e/out/local-site.har test/fixtures/local-site.har`, then `npm test`.

  Expected: PASS. Update only expectations the new data legitimately changes, and list each one. Watch the `noData` test helper in `test/report.test.mjs`: the thumbnail is a `data:` URL, which that helper already strips.

- [ ] **Step 5: Commit**

  ```bash
  git add test/e2e/site/robots.txt test/e2e/run.mjs test/fixtures/local-site.har
  git commit -m "E2E: indexing verdict, crawl-delay, og:image thumbnail, share previews, readability and line length; refreshed fixture

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```
