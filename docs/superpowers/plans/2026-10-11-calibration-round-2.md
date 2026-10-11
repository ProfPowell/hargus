# Calibration Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the false findings found in calibration round 2, and make the link checker check every link it can, with browser-like requests.

**Architecture:** Each fix stays in the plugin or capture helper that produced the finding. Page-phase `collect()` functions and the in-page helpers in `capture.js` are serialised into the page, so they stay self-contained. One shared constant (`A11Y_MIN_OVERFLOW`) goes in `extension/core/views.js`.

**Tech Stack:** Plain ES modules, `node --test` (`npm test`), and the Playwright e2e (`npm run test:e2e`, run from the repo or worktree root).

**Spec:** `docs/superpowers/specs/2026-10-11-calibration-round-2-design.md`

## Global Constraints

- Page-phase `collect()` functions and the in-page helpers in `extension/browser/capture.js` (`measureView` and others) must be self-contained: no imports, module constants or closures.
- Link request header, verbatim:
  `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`
- Link checker:
  - `CONCURRENCY = 12`, `PER_HOST = 4`, and `BUDGET_MS = 150_000` (unchanged);
  - option defaults: `external: true`, `max: 0` (0 means unlimited);
  - a HEAD result with a status of 400 or above, or a non-timeout network error, is retried with GET. A HEAD timeout or abort is not retried;
  - results carry `method: 'HEAD' | 'GET'`.
- `A11Y_MIN_OVERFLOW = 8` (px), exported from `extension/core/views.js`.
- Copy, verbatim:
  - `${n} links not checked (time budget)`, with the detail sentence `Raise the time budget or check again; they were not tested.`
  - the summary row `${ran} of ${total} checked · ${broken} broken · ${redirects} redirects`
  - the disclosure `Requests every link on the page, on this site and elsewhere (HEAD, then GET if HEAD fails; no cookies), and the page's Open Graph image.`
  - `robots.txt blocks crawlers from most of the site (Disallow: /), but allows this page`
  - `Page scrolls sideways with WCAG text spacing`, with the detail `Content is ${overflow} px wider than the viewport.`
  - the right-to-left offscreen detail `${selector} sits ${over} px off-screen (positioned with left/right). In a right-to-left page it pushes the layout sideways — position it with inset-inline-start instead.`
- Carbon grading is unchanged. GitHub-style script-handled anchors are **not** exempted.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A page whose links are almost all on one host** (a news homepage with 500+ same-site links). The checker must still finish within the budget and not starve, at 4 in flight for that host. Test: Task 2 (200 links on one host all run to completion).
2. **A GET retry on a large file** (a PDF or ZIP link whose HEAD fails). The retry must not download the body. Test: Task 1 (the GET-retry response body is cancelled, read zero times).
3. **A right-to-left page with a horizontally scrolling carousel** (`overflow-x: auto`). Children scrolled out to the left are clipped by the carousel and must not be reported as culprits. Test: Task 6 (e2e fixture carousel in the right-to-left view).
4. **An element hidden only by `visibility: hidden` on an ancestor.** It must not count as a visible unnamed control. Test: Task 3 (e2e fixture).
5. **robots.txt with no `*` group but a Googlebot group** that disallows `/` and allows the page. The page is allowed, so this must give the low finding, not the medium one. Test: Task 4.

---

### Task 1: Browser-like link requests

**Files:**
- Modify: `extension/plugins/links.js` (`request` and `check`, around lines 12–40)
- Test: `test/links.test.mjs`

**Interfaces:**
- Produces: each checked result is `{ url, status, finalUrl, redirected, ms, method }`, plus `error` on failure.

- [ ] **Step 1: Write the failing tests** (append to `test/links.test.mjs`)

The existing `stub` records `"METHOD url"` in `calls`. Add a variant that also records headers, and counts body reads:

```js
function stubH(routes, seen = []) {
  return async (url, init = {}) => {
    seen.push({ method: init.method || 'GET', url, accept: new Headers(init.headers).get('accept') });
    const r = routes[url];
    if (!r) throw new TypeError('network');
    const status = init.method === 'HEAD' ? (r.headStatus ?? r.status) : r.status;
    let reads = 0;
    const body = init.method === 'HEAD' ? null : new ReadableStream({ pull(c) { reads++; c.enqueue(new Uint8Array(10)); }, cancel() { r.cancelled = true; } });
    const res = new Response(body, { status });
    Object.defineProperty(res, 'url', { value: url });
    Object.defineProperty(res, 'redirected', { value: false });
    r.reads = () => reads;
    return res;
  };
}
const ctxH = (routes, internal, seen) => ({ ...ctx({ internal }), fetch: stubH(routes, seen) });

test('every request sends a browser-like Accept header', async () => {
  const seen = [];
  await plugin.run({}, ctxH({ 'https://s.test/a': { status: 200 } }, ['https://s.test/a'], seen));
  assert.ok(seen.length && seen.every((s) => s.accept === 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'), JSON.stringify(seen));
});

test('HEAD 400 or 503 → GET decides; GET status and method recorded', async () => {
  const routes = {
    'https://s.test/gh': { headStatus: 400, status: 200 },
    'https://s.test/as': { headStatus: 503, status: 200 },
    'https://s.test/gone': { headStatus: 404, status: 404 },
  };
  const out = await plugin.run({}, ctxH(routes, Object.keys(routes), []));
  const by = Object.fromEntries(out.data.checked.map((c) => [c.url, c]));
  assert.deepEqual([by['https://s.test/gh'].status, by['https://s.test/gh'].method], [200, 'GET']);
  assert.deepEqual([by['https://s.test/as'].status, by['https://s.test/as'].method], [200, 'GET']);
  assert.deepEqual([by['https://s.test/gone'].status, by['https://s.test/gone'].method], [404, 'GET']);
  const t = titles(out);
  assert.ok(t.some((x) => /Broken link: 404 \/gone/.test(x)));
  assert.ok(!t.some((x) => /\/gh|\/as/.test(x)), t.join(' | '));
});

test('a HEAD that succeeds is not retried; method HEAD', async () => {
  const seen = [];
  const out = await plugin.run({}, ctxH({ 'https://s.test/ok': { status: 200 } }, ['https://s.test/ok'], seen));
  assert.deepEqual(seen.map((s) => s.method), ['HEAD']);
  assert.equal(out.data.checked[0].method, 'HEAD');
});

test('GET retry does not download the body (Review Focus 2)', async () => {
  const routes = { 'https://s.test/big.pdf': { headStatus: 403, status: 404 } };
  await plugin.run({}, ctxH(routes, ['https://s.test/big.pdf'], []));
  assert.equal(routes['https://s.test/big.pdf'].reads(), 0, 'body never read');
});
```

Update the existing test `'HEAD first, GET fallback on 405; …'` and `'401/403/429 are refusals, not broken links'` only where they now assert behaviour this task changes on purpose. For example, a route whose HEAD returns 404 now makes a GET call. Keep their intent and list each change in the report.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/links.test.mjs`
Expected: FAIL. The `Accept` header is missing and HEAD 400/503 isn't retried.

- [ ] **Step 3: Implement** (`extension/plugins/links.js`)

```js
const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

async function request(ctx, url, method) {
  /* keep the existing signal/timeout lines */
  return ctx.fetch(url, { method, credentials: 'omit', redirect: 'follow', signal, headers: { Accept: ACCEPT } });
}

async function check(ctx, url) {
  const t0 = Date.now();
  let res;
  let method = 'HEAD';
  try {
    res = await request(ctx, url, 'HEAD');
    // Many servers answer HEAD differently from a browser's GET (GitHub 400, some CDNs 503): let GET decide.
    if (res.status >= 400) res = null;
  } catch (e) {
    // a timed-out or aborted HEAD is not retried; other network errors fall back to GET
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return { url, status: 0, finalUrl: url, redirected: false, ms: Date.now() - t0, method, error: String(e?.message || e) };
    }
    res = null;
  }
  try {
    if (!res) {
      method = 'GET';
      res = await request(ctx, url, 'GET');
      cancel(res);
    }
    return { url, status: res.status, finalUrl: res.url || url, redirected: !!res.redirected, ms: Date.now() - t0, method };
  } catch (e) {
    return { url, status: 0, finalUrl: url, redirected: false, ms: Date.now() - t0, method, error: String(e?.message || e) };
  }
}
```

Keep `cancel(res)` as defined in the file. Confirm it cancels the body without reading it, which is what Review Focus 2 needs; if it reads first, change it to `res.body?.cancel()`. In `render`, add a `Method` column (`key: 'method'`) to the checked-links table.

- [ ] **Step 4: Run the tests**

Run: `node --test test/links.test.mjs`, then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/plugins/links.js test/links.test.mjs
git commit -m "Links: browser-like Accept header; any HEAD failure is retried with GET, which decides

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Check every link, with per-host limits, and report what wasn't verified

**Files:**
- Modify: `extension/plugins/links.js` (constants, `run`, the summary, `options`, `disclosure`)
- Test: `test/links.test.mjs`

**Interfaces:**
- Consumes: `check(ctx, url)` from Task 1.
- Produces: options `external` (default `true`) and `max` (default `0`, unlimited), plus the info finding `${n} links not checked (time budget)`.

- [ ] **Step 1: Write the failing tests**

Update the registration test's expectations to:

```js
  assert.deepEqual(plugin.options.map((o) => [o.key, o.default]), [['external', true], ['max', 0]]);
  assert.match(plugin.disclosure, /every link on the page, on this site and elsewhere/);
```

Update `'external only when enabled; max caps the list'` so it passes `options: { external: false }` explicitly where it tests "only internal", and keeps `max: 2` where it tests the cap. Then append:

```js
test('defaults: external links included, no cap', async () => {
  const internal = Array.from({ length: 160 }, (_, i) => `https://s.test/p${i}`);
  const external = ['https://other.test/x'];
  const routes = Object.fromEntries([...internal, ...external].map((u) => [u, { status: 200 }]));
  const c = ctx({ routes, internal, external, options: { external: undefined, max: undefined } });
  c.options = {}; // plugin defaults apply
  const out = await plugin.run({}, c);
  assert.equal(out.data.checked.filter((x) => !x.skipped).length, 161);
  assert.equal(out.summary.find((s) => s.label === 'Link check').value, '161 of 161 checked · 0 broken · 0 redirects');
});

test('per-host limit: never more than 4 in flight to one host; other hosts proceed (Review Focus 1)', async () => {
  const inflight = new Map();
  let peakA = 0;
  let otherDone = 0;
  const a = Array.from({ length: 200 }, (_, i) => `https://a.test/${i}`);
  const b = Array.from({ length: 10 }, (_, i) => `https://b.test/${i}`);
  const c = ctx({ internal: a, external: b, options: { external: true } });
  c.fetch = async (url, init = {}) => {
    const host = new URL(url).host;
    inflight.set(host, (inflight.get(host) || 0) + 1);
    if (host === 'a.test') peakA = Math.max(peakA, inflight.get(host));
    await new Promise((r) => setTimeout(r, 2));
    inflight.set(host, inflight.get(host) - 1);
    if (host === 'b.test') otherDone++;
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'url', { value: url });
    Object.defineProperty(res, 'redirected', { value: false });
    return res;
  };
  const out = await plugin.run({}, c);
  assert.ok(peakA <= 4, `peak for one host ${peakA}`);
  assert.equal(otherDone, 10);
  assert.equal(out.data.checked.filter((x) => !x.skipped).length, 210, 'all 210 finished');
});

test('links not reached in the time budget get an info finding and the summary shows N of M', async () => {
  const internal = Array.from({ length: 50 }, (_, i) => `https://s.test/p${i}`);
  const c = ctx({ internal, options: { budgetMs: 1 } });
  c.fetch = async (url) => { await new Promise((r) => setTimeout(r, 20)); const res = new Response(null, { status: 200 }); Object.defineProperty(res, 'url', { value: url }); Object.defineProperty(res, 'redirected', { value: false }); return res; };
  const out = await plugin.run({}, c);
  const f = out.findings.find((x) => /links not checked \(time budget\)$/.test(x.title));
  assert.ok(f, titles(out).join(' | '));
  assert.equal(f.severity, 'info');
  assert.match(f.detail, /Raise the time budget or check again; they were not tested\./);
  assert.match(out.summary.find((s) => s.label === 'Link check').value, /^\d+ of 50 checked · /);
});
```

The existing `'time budget: unstarted URLs are skipped and reported'` test may now overlap. Keep it, and update its title expectations only if it asserted the old summary text.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/links.test.mjs`
Expected: FAIL (old defaults, no per-host limit, no finding).

- [ ] **Step 3: Implement** (`extension/plugins/links.js`)

Constants:

```js
const CONCURRENCY = 12;
const PER_HOST = 4;
```

In `run`, build the list:

```js
  const all = [...targets.internal, ...(ctx.options.external !== false ? targets.external : [])];
  const cap = Number(ctx.options.max) > 0 ? Number(ctx.options.max) : Infinity;
  const list = all.slice(0, cap);
```

Replace the worker loop with a host-aware queue:

```js
  const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
  const busy = new Map();
  const queue = todo.slice();
  const take = () => {
    const i = queue.findIndex((u) => (busy.get(hostOf(u)) || 0) < PER_HOST);
    return i < 0 ? null : queue.splice(i, 1)[0];
  };
  let wake = () => {};
  const worker = async () => {
    while (queue.length) {
      if (ctx.signal?.aborted || Date.now() > deadline) break;
      const url = take();
      if (!url) { await new Promise((r) => { const prev = wake; wake = () => { prev(); r(); }; }); continue; }
      const host = hostOf(url);
      busy.set(host, (busy.get(host) || 0) + 1);
      try { checked.push(await check(ctx, url)); } finally { busy.set(host, busy.get(host) - 1); const w = wake; wake = () => {}; w(); }
      done++;
      if (!ctx.signal?.aborted) ctx.progress?.(`Checking links ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array(Math.min(CONCURRENCY, todo.length)).fill(0).map(worker));
  for (const url of queue) checked.push({ url, skipped: 'time budget' });
```

This replaces the old `next` index and `notStarted` lines. A worker blocked on `wake` must not hang when the queue empties or the deadline passes: every finishing request calls `wake`, which releases all waiters, and they re-check the loop condition.

Findings and summary:

```js
  const budgetSkipped = checked.filter((x) => x.skipped === 'time budget');
  if (budgetSkipped.length) add('info', `${budgetSkipped.length} links not checked (time budget)`,
    `Raise the time budget or check again; they were not tested. ${budgetSkipped.slice(0, 10).map((x) => x.url).join(', ')}`);
  const total = checked.filter((x) => x.skipped !== 'not http(s)' && x.skipped !== 'not a valid URL').length;
```

The summary value becomes `` `${ran.length} of ${total} checked · ${broken.length} broken · ${redirects.length + insecure.length} redirects` ``.

Options and disclosure:

```js
    { key: 'external', label: 'Also check external links', type: 'checkbox', default: true },
    { key: 'max', label: 'Most links to check (0 = all)', type: 'number', default: 0 },
```

`disclosure: 'Requests every link on the page, on this site and elsewhere (HEAD, then GET if HEAD fails; no cookies), and the page\'s Open Graph image.'`

Also update `description` if it says "the page's links on this site".

- [ ] **Step 4: Run the tests**

Run: `node --test test/links.test.mjs`, then `npm test`
Expected: PASS. Settings migration needs no change: users who saved `external: false` keep it.

- [ ] **Step 5: Commit**

```bash
git add extension/plugins/links.js test/links.test.mjs
git commit -m "Links: check every link by default (external on, no cap), 12 at a time with 4 per host; report links not reached

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Ancestor-aware visibility and labelled-descendant names (a11y-basics)

**Files:**
- Modify: `extension/plugins/a11y-basics.js` (`visible` around line 6, `name` around line 23; both inside `collect`)

These are in-page helpers with no unit harness, so they are verified in Task 7's e2e. It's a mechanical, single-file change.

- [ ] **Step 1: Replace `visible`**

```js
  const visible = (el) => {
    if (el.closest('[hidden],[aria-hidden="true"]')) return false;
    // checkVisibility covers display:none and visibility:hidden on any ancestor.
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
```

- [ ] **Step 2: Extend `name`'s descendant step**

Replace the line:

```js
    [...el.querySelectorAll('img[alt], svg title')].map((i) => i.getAttribute('alt') || i.textContent).join(' ').trim() ||
```

with:

```js
    [...el.querySelectorAll('img[alt], svg title, [role="img"][aria-label], svg[aria-label], [aria-labelledby]')]
      .filter((i) => !i.closest('[aria-hidden="true"]') || el.closest('[aria-hidden="true"]'))
      .map((i) => i.getAttribute('alt') ?? i.getAttribute('aria-label') ??
        (i.hasAttribute('aria-labelledby') ? byIds(i.getAttribute('aria-labelledby')).map(text).join(' ') : i.textContent))
      .join(' ').trim() ||
```

Check that `byIds` and `text` are defined above `name` inside `collect`. They are used by `name` already.

- [ ] **Step 3: Unit suite**

Run: `npm test`
Expected: PASS. Nothing in the unit suite runs `collect`.

- [ ] **Step 4: Commit**

```bash
git add extension/plugins/a11y-basics.js
git commit -m "a11y-basics: hidden ancestors hide an element; names include labelled SVG/role=img descendants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: robots.txt: a page allowed under `Disallow: /`

**Files:**
- Modify: `extension/plugins/well-known.js` (findings around lines 245–251)
- Test: `test/robots.test.mjs`

- [ ] **Step 1: Write the failing tests** (append; `wkRun` is defined in the file)

```js
test('Disallow: / with Allow: /$ on the homepage → low "allows this page", no medium', async () => {
  const out = await wkRun('User-agent: *\nDisallow: /\nAllow: /$\n');
  const t = out.findings.map((f) => `${f.severity}:${f.title}`);
  assert.ok(t.includes('low:robots.txt blocks crawlers from most of the site (Disallow: /), but allows this page'), t.join(' | '));
  assert.ok(!t.some((x) => /^medium:robots\.txt blocks all crawlers/.test(x)));
  assert.equal(out.findings.find((f) => /allows this page/.test(f.title)).detail, 'Allow: /$');
});

test('the same file on another path → medium "blocks all crawlers"', async () => {
  const out = await wkRun('User-agent: *\nDisallow: /\nAllow: /$\n', { path: '/news/a' });
  assert.ok(out.findings.some((f) => f.severity === 'medium' && /blocks all crawlers/.test(f.title)));
});

test('no * group: Googlebot group with Disallow: / and Allow for the page → low (Review Focus 5)', async () => {
  const out = await wkRun('User-agent: googlebot\nDisallow: /\nAllow: /$\n');
  assert.ok(!out.findings.some((f) => f.severity === 'medium' && /blocked for Googlebot|blocks all crawlers/.test(f.title)), out.findings.map((f) => f.title).join(' | '));
});
```

Check how `statusFor('*')` decides `everyone` when there is no `*` group. If it isn't `'blocked'` in the Review Focus 5 case, the third test passes already. That's fine: it pins the behaviour.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/robots.test.mjs`
Expected: the first test FAILS.

- [ ] **Step 3: Implement** (`extension/plugins/well-known.js`)

Replace:

```js
  else if (robots.everyone === 'blocked') add('medium', 'seo', 'robots.txt blocks all crawlers (Disallow: /)');
```

with:

```js
  else if (robots.everyone === 'blocked') {
    // A more specific Allow (e.g. Allow: /$ for the homepage) can still let crawlers reach this page.
    const row = indexing.find((x) => x.token === '*') || indexing.find((x) => x.token === 'googlebot');
    if (row?.crawl) add('low', 'seo', 'robots.txt blocks crawlers from most of the site (Disallow: /), but allows this page', row.rule);
    else add('medium', 'seo', 'robots.txt blocks all crawlers (Disallow: /)');
  }
```

`indexing` must be computed before this line. If it's defined later in `run`, move this block below it, keeping finding order stable where tests depend on it. Leave the `siteBlocked` line as it is: it only suppresses per-crawler findings whose rule is `Disallow: /`, and an allowed page has `crawl: true`, so it raises none.

- [ ] **Step 4: Run the tests**

Run: `node --test test/robots.test.mjs`, then `npm test`
Expected: PASS. The existing `'site-wide Disallow: / raises one finding…'` test still passes, because its page is blocked.

- [ ] **Step 5: Commit**

```bash
git add extension/plugins/well-known.js test/robots.test.mjs
git commit -m "Well-known: Disallow: / with an Allow for this page is a low finding, not 'blocks all crawlers'

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Text spacing and pseudo-localisation: clipping vs sideways scrolling

**Files:**
- Modify: `extension/core/views.js` (export `A11Y_MIN_OVERFLOW = 8`)
- Modify: `extension/plugins/a11y-views.js` (the spacing block, around lines 55–62)
- Modify: `extension/plugins/international.js` (pseudo-localisation, around lines 37–42)
- Test: `test/a11y-views.test.mjs`, `test/international.test.mjs`

- [ ] **Step 1: Write the failing tests**

In `test/a11y-views.test.mjs` (where `B`, `run` and `t` exist), update the existing spacing test. Its new-overflow case `{ ...B, overflowX: 10 }` now expects the low scroll finding. Then append:

```js
test('spacing: scroll-only overflow is low and passes the check; clipping stays medium; tiny overflow ignored', () => {
  const s = run({ spacing: { ...B, overflowX: 81, scrollsX: true } });
  assert.deepEqual(t(s), ['low:Page scrolls sideways with WCAG text spacing']);
  assert.equal(s.findings[0].detail, 'Content is 81 px wider than the viewport.');
  assert.equal(s.data.checks.find((c) => c.id === 'spacing').ok, true);
  assert.equal(s.summary.find((x) => x.label === 'Text spacing').rating, 'needs-improvement');
  assert.deepEqual(t(run({ spacing: { ...B, overflowX: 5, scrollsX: true } })), []);
  assert.deepEqual(t(run({ spacing: { ...B, overflowX: 81, scrollsX: false } })), []);
  const c = run({ spacing: { ...B, clipped: 5, overflowX: 81 } });
  assert.deepEqual(t(c), ['medium:Text clips with WCAG text spacing (1.4.12)']);
  assert.equal(c.findings[0].detail, '3 more clipped text boxes.');
  assert.equal(c.data.checks.find((x) => x.id === 'spacing').ok, false);
});
```

The `checks` location is `data.checks`, as established in round 1; adjust if this file's `run` returns it differently.

In `test/international.test.mjs` (where `base`, `reading`, `ctx` and `titles` exist), append:

```js
test('pseudo: sideways scroll needs ≥ 8 px and a real scroll', () => {
  assert.deepEqual(titles(plugin.run(reading({ desktop: base, pseudo: { ...base, overflowX: 2, scrollsX: true } }), ctx())), []);
  assert.deepEqual(titles(plugin.run(reading({ desktop: base, pseudo: { ...base, overflowX: 40, scrollsX: false } }), ctx())), []);
  assert.deepEqual(titles(plugin.run(reading({ desktop: base, pseudo: { ...base, overflowX: 40, scrollsX: true } }), ctx())), ['medium:Longer text makes the page scroll sideways']);
  assert.deepEqual(titles(plugin.run(reading({ desktop: base, pseudo: { ...base, overflowX: 40 } }), ctx())), ['medium:Longer text makes the page scroll sideways'], 'older readings without scrollsX');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/a11y-views.test.mjs test/international.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `extension/core/views.js`:

```js
/** Horizontal overflow smaller than this (px) is scrollbar or sub-pixel noise, not a finding. */
export const A11Y_MIN_OVERFLOW = 8;
```

In `a11y-views.js`, import `A11Y_MIN_OVERFLOW` and replace the spacing block body:

```js
  const spacing = views.spacing;
  if (spacing) {
    const extra = extraClipped(spacing);
    const clips = extra >= A11Y_CLIP_EXTRA;
    const grew = num(spacing.overflowX) - num(base.overflowX);
    const scrolls = !clips && grew >= A11Y_MIN_OVERFLOW && spacing.scrollsX !== false;
    if (clips) add('medium', 'Text clips with WCAG text spacing (1.4.12)', `${extra} more clipped text boxes.`);
    else if (scrolls) add('low', 'Page scrolls sideways with WCAG text spacing', `Content is ${num(spacing.overflowX)} px wider than the viewport.`);
    summary.push({ label: 'Text spacing', value: clips ? `${extra} more clipped` : scrolls ? `${num(spacing.overflowX)} px overflow` : 'ok', rating: clips ? 'poor' : scrolls ? 'needs-improvement' : 'good' });
    checks.push({ id: 'spacing', ok: !clips });
  }
```

In `international.js`, import `A11Y_MIN_OVERFLOW` from `'../core/views.js'` and change `longSideways`:

```js
    longSideways = views.pseudo.scrollsX !== false && (views.pseudo.overflowX || 0) - (base.overflowX || 0) >= A11Y_MIN_OVERFLOW && !(base.overflowX > 0);
```

Keep the existing `!(base.overflowX > 0)` condition.

- [ ] **Step 4: Run the tests**

Run: `node --test test/a11y-views.test.mjs test/international.test.mjs`, then `npm test`
Expected: PASS. If the existing international test at line ~36 used `rtl: { overflowX: 12 }` or `pseudo.overflowX: 40`, it still passes: both are ≥ 8 with `scrollsX` undefined.

- [ ] **Step 5: Commit**

```bash
git add extension/core/views.js extension/plugins/a11y-views.js extension/plugins/international.js test/a11y-views.test.mjs test/international.test.mjs
git commit -m "Views: text spacing splits clipping (medium) from sideways scrolling (low); 8 px floor and scroll test for spacing and pseudo-localisation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Right-to-left culprits

**Files:**
- Modify: `extension/browser/capture.js` (`measureView` overflow walk, around lines 170–200)
- Modify: `extension/plugins/international.js` (the right-to-left finding, around lines 43–45)
- Test: `test/international.test.mjs`

**Interfaces:**
- Produces: `measured.overflowers[i]` gains `side: 'right' | 'left'` and `offscreen: boolean`.

- [ ] **Step 1: Write the failing tests** (`test/international.test.mjs`)

```js
test('RTL: offscreen culprit gets the inset-inline-start detail; floor and scroll test apply', () => {
  const rtl = { ...base, dir: 'rtl', overflowX: 9999, scrollsX: true, overflowers: [{ selector: 'a.skip-link', width: 120, over: 9999, side: 'left', offscreen: true }] };
  const out = plugin.run(reading({ desktop: base, rtl }), ctx());
  const f = out.findings.find((x) => x.title === 'Right-to-left layout scrolls sideways');
  assert.equal(f.severity, 'medium');
  assert.equal(f.detail, 'a.skip-link sits 9999 px off-screen (positioned with left/right). In a right-to-left page it pushes the layout sideways — position it with inset-inline-start instead.');
  const wide = { ...rtl, overflowers: [{ selector: 'div.banner', width: 1400, over: 120, side: 'right', offscreen: false }] };
  assert.match(plugin.run(reading({ desktop: base, rtl: wide }), ctx()).findings.find((x) => /Right-to-left/.test(x.title)).detail, /^div\.banner is 1400 px wide/);
  assert.deepEqual(titles(plugin.run(reading({ desktop: base, rtl: { ...base, overflowX: 5, scrollsX: true } }), ctx())), []);
  assert.deepEqual(titles(plugin.run(reading({ desktop: base, rtl: { ...base, overflowX: 500, scrollsX: false } }), ctx())), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/international.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the finding** (`international.js`)

```js
  const rtlMeasured = !!(base && views.rtl);
  const rtlGrew = rtlMeasured ? (views.rtl.overflowX || 0) - (base.overflowX || 0) : 0;
  const rtlSideways = rtlMeasured && views.rtl.scrollsX !== false && rtlGrew >= A11Y_MIN_OVERFLOW && !(base.overflowX > 0);
  if (rtlSideways) {
    const o = (views.rtl.overflowers || [])[0];
    const detail = o?.offscreen
      ? `${o.selector} sits ${o.over} px off-screen (positioned with left/right). In a right-to-left page it pushes the layout sideways — position it with inset-inline-start instead.`
      : o ? `${o.selector} is ${o.width} px wide; with dir="rtl" the page becomes ${views.rtl.overflowX}px wider than the window.`
      : `With dir="rtl" the page becomes ${views.rtl.overflowX}px wider than the window.`;
    add('medium', 'Right-to-left layout scrolls sideways', detail);
  }
```

- [ ] **Step 4: Implement the culprit walk** (`capture.js` `measureView`)

Inside the existing `if (document.documentElement.scrollWidth > innerWidth + 1)` block, make these changes:

```js
    const rtlDoc = getComputedStyle(document.documentElement).direction === 'rtl';
    // Content clipped by an ancestor, or position: fixed, does not add to scrollWidth.
    const clipped = (el, side) => {
      if (getComputedStyle(el).position === 'fixed') return true;
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        if (a === document.body) break;
        if (getComputedStyle(a).overflowX === 'visible') continue;
        const ar = a.getBoundingClientRect();
        if (side === 'right' ? ar.right <= innerWidth + 1 : ar.left >= -1) return true;
      }
      return false;
    };
```

In the candidate loop:

```js
      const r = el.getBoundingClientRect();
      if (r.width <= 0) continue;
      const side = r.right > innerWidth + 1 ? 'right' : rtlDoc && r.left < -1 ? 'left' : null;
      if (side && !clipped(el, side)) cands.push({ el, r, side });
```

In the push:

```js
    inner.sort((a, b) => (b.side === 'left' ? -b.r.left : b.r.right - innerWidth) - (a.side === 'left' ? -a.r.left : a.r.right - innerWidth));
    for (const c of inner.slice(0, 5)) overflowers.push({
      selector: vpath(c.el), width: Math.round(c.r.width),
      over: Math.round(c.side === 'left' ? -c.r.left : c.r.right - innerWidth),
      side: c.side, offscreen: c.r.right <= 0 || c.r.left >= innerWidth,
    });
```

Keep the existing truncation guards (`seen > 3000`, `cands.length >= 300`, the time cap). The reflow consumers read `o.selector`, `o.width` and `o.over`, which are unchanged.

- [ ] **Step 5: Run the tests**

Run: `node --test test/international.test.mjs`, then `npm test`
Expected: PASS. Browser behaviour is checked by Task 7's e2e, including Review Focus 3.

- [ ] **Step 6: Commit**

```bash
git add extension/browser/capture.js extension/plugins/international.js test/international.test.mjs
git commit -m "International: right-to-left overflow names its culprit, including off-screen helpers on the left

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: E2E fixture, assertions and calibration site lists

**Files:**
- Modify: `test/e2e/site/index.html`, `test/e2e/site/app.css`, `test/e2e/server.mjs`, `test/e2e/run.mjs`
- Modify: `scripts/calibrate.mjs` (`SITES_2`, `--round`, `--all`)

- [ ] **Step 1: Fixture elements.** In `index.html`, before `<div style="height:2400px"></div>`, add:

```html
    <div style="display:none"><button type="button" class="hidden-arrow"><svg width="8" height="8"><path d="M0 0h8v8z"/></svg></button></div>
    <div style="visibility:hidden"><button type="button" class="invisible-arrow"></button></div>
    <a href="/page2.html" class="svg-logo"><svg role="img" aria-label="Partner" width="40" height="20"><rect width="40" height="20"/></svg></a>
    <a class="skip-link" href="#main-start">Skip to content</a>
    <div class="carousel"><div class="carousel-track"><span>Slide one</span><span>Slide two</span><span>Slide three</span></div></div>
    <p><a href="/head-400">A page that dislikes HEAD</a></p>
```

In `app.css`, add:

```css
.skip-link { position: absolute; left: -9999px; }
.carousel { width: 200px; overflow-x: auto; }
.carousel-track { display: flex; width: 900px; }
```

- [ ] **Step 2: Server route.** In `test/e2e/server.mjs`, next to the `/old` redirect, add:

```js
    if (path === '/head-400') {
      if (req.method === 'HEAD') { res.writeHead(400); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Dislikes HEAD</title><p>ok</p>');
    }
```

- [ ] **Step 3: Assertions.** In `run.mjs`, near the existing `a11y-basics` assertions for reading 1:

```js
    const ab = p['a11y-basics'].data.rules;
    const btn = ab.find((r) => r.id === 'button-name');
    assert.ok(!(btn?.samples || []).some((s) => /hidden-arrow|invisible-arrow/.test(s.html)), `hidden buttons not counted: ${JSON.stringify(btn?.samples)}`);
    const lnk = ab.find((r) => r.id === 'link-name');
    assert.ok(!(lnk?.samples || []).some((s) => /svg-logo/.test(s.html)), 'SVG role=img aria-label names the link');
```

Near the existing links assertions:

```js
    const chk = pc.links.data.checked.find((x) => x.url.endsWith('/head-400'));
    assert.deepEqual([chk?.status, chk?.method], [200, 'GET'], JSON.stringify(chk));
    assert.ok(!pc.links.findings.some((f) => /head-400/.test(f.title)), 'HEAD-hostile page not reported broken');
    assert.match(pc.links.summary.find((s) => s.label === 'Link check').value, /^\d+ of \d+ checked · /);
```

Near the international assertions:

```js
    const intl = p.international.findings.find((f) => f.title === 'Right-to-left layout scrolls sideways');
    assert.ok(intl && /skip-link sits \d+ px off-screen/.test(intl.detail) && /inset-inline-start/.test(intl.detail), intl?.detail);
    const rtlOver = r1.log._harplus.capture.views.rtl.overflowers || [];
    assert.ok(!rtlOver.some((o) => /carousel/.test(o.selector)), `carousel children are clipped, not culprits (Review Focus 3): ${JSON.stringify(rtlOver)}`);
```

The fixture already has external links, such as a cross-origin `localhost` image page, and the existing tests may assert link counts or "external not checked". Update those counts to the new defaults and note each change in the report. Don't loosen any other assertion.

- [ ] **Step 4: Calibration lists** (`scripts/calibrate.mjs`)

Add after `SITES`:

```js
const SITES_2 = [
  'https://www.usa.gov/',                       // US government
  'https://www.ikea.com/us/en/',                // commerce
  'https://stripe.com/',                        // SaaS marketing
  'https://github.com/microsoft/vscode',        // app-like
  'https://www.ynet.co.il/',                    // Hebrew, RTL
  'https://habr.com/ru/articles/',              // Russian
  'https://www.naver.com/',                     // Korean
  'https://www.smashingmagazine.com/2024/05/modern-guide-making-css-shapes/', // blog article
  'https://docs.python.org/3/library/asyncio.html', // docs
  'https://www.spiegel.de/',                    // German news
];
```

Replace `const urls = process.argv.slice(2).length ? process.argv.slice(2) : SITES;` with:

```js
  const args = process.argv.slice(2);
  const round = args.includes('--all') ? [...SITES, ...SITES_2] : args.includes('--round') && args[args.indexOf('--round') + 1] === '2' ? SITES_2 : SITES;
  const given = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--round');
  const urls = given.length ? given : round;
```

Update the usage comment: `node scripts/calibrate.mjs [--round 2 | --all] [url …]`. Run `node --check scripts/calibrate.mjs`.

- [ ] **Step 5: Run everything**

Run: `npm test`, then `npm run test:e2e` three times.
Expected: all pass, 3 of 3. Run them from the repo or worktree root. `npm --prefix` can't find the global Playwright.

- [ ] **Step 6: Commit**

```bash
git add test/e2e scripts/calibrate.mjs
git commit -m "E2E: hidden buttons, SVG-labelled link, off-screen skip link, RTL carousel, HEAD-hostile route; calibration --round 2 / --all

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Calibration run (controller, not a subagent)

- [ ] Copy the current digests aside: the round-1 baseline digest from the reading-speed batch, and `scratchpad/round2/digest.json` plus the re-run digest for ynet, habr and asahi.
- [ ] Run `node scripts/calibrate.mjs --all` from the worktree in the background.
- [ ] Compare against the spec's expected outcomes:
  - no GitHub `/marketplace` or `/projects` broken links, and no asahi.com 503 broken links;
  - Spiegel's hidden-button and Stripe's logo-link counts are gone;
  - naver.com's robots.txt finding is low;
  - ynet's text-spacing finding is low or absent, and its 2 px pseudo-localisation finding is gone;
  - the right-to-left findings on usa.gov, IKEA and Smashing Magazine name their culprits;
  - every site's `Link check` row reads "N of M checked", with external links included.
- [ ] Any other finding change gets a root cause before merging. Record each in the ledger.
