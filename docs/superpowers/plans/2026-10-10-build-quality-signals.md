# Build and quality signals: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record console errors, exceptions and DevTools Issues during load. Add:
- overflow culprits and a `100vw` check;
- a Capo-style `<head>` order check;
- breakpoint-edge views;
- layout-shift culprits;
- PageSpeed `auto` strategy.

**Architecture:**
- Pure helpers in `extension/core/console.js` (`redact`, event → entry, deduplication) and `extension/core/views.js` (`pickBreakpoints`, `breakpointFindings`, `viewLabel`).
- Capture enables `Runtime`, `Log` and `Audits` and records entries until the views start. `measureView()` gains `overflowers`. Two breakpoints × two edge views run in `captureViews()`.
- Three new analyze plugins: `console`, `head-order` and `layout`. Changes to `vitals`, `pagespeed`, `css`, `a11y-views`, `report.js` and `stripForSharing`.

**Tech Stack:** Vanilla ES modules with no dependencies. Chrome DevTools Protocol through `chrome.debugger`. `node --test` for unit tests and Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-10-10-build-quality-signals-design.md`

## Global Constraints

- No dependencies. Page functions passed to `evaluate` are self-contained.
- **Console store:** `hp.capture.console = { entries, dropped }`. At most 100 distinct entries; text up to 300 characters; deduplicated by `kind|code|text|url|line`, with `count`.
- **Redaction:**
  - URLs keep scheme, host and path, and the query becomes `?…`;
  - runs of 24 or more characters from `[A-Za-z0-9_\-+=]` become `…`.
  - The token class leaves out `/` (see Rulings).
- **Breakpoints:** the top 2 by rule count, kept within 320–1920 px, ties going to the larger value. Views are named `bp<b>-below` (`b−1` px) and `bp<b>-at` (`b` px). Each is a viewport-only shot with `runMs` 30 000 and `restoreMs` 10 000. They run after the accessibility views and before `nojs`.
- **Settings:** `capture.views.breakpoints: true`, with a chip labelled "Breakpoint edges".
- **Finding titles:** exactly as in the spec.
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. If the harness's attribution line names a different model, that line is accepted.
- **Tests:** run `npm test` before every commit. Tasks 3 and 8 run `npm run test:e2e`, never two runs at once.

## Rulings made while planning (deviations from the spec)

1. **Redaction class without `/`.** With `/`, ordinary URL paths such as `/assets/javascripts/application` would be masked. JWTs and API keys are still caught.
2. **Breakpoint values are normalised to the first width of the new layout.**
   - `min-width: v` → `v`;
   - `max-width: v` → `floor(v)+1`, so `max-width: 899px` → 900;
   - `width >= v` → `ceil(v)`;
   - `width > v` → `floor(v)+1`;
   - `width <= v` → `floor(v)+1`;
   - `width < v` → `ceil(v)`.
   
   Without this, `max-width: 899px` would give the edge views 898 and 899, which sit on the same side of the break.
3. **Inline synchronous `<script>` weighs 5 (blocking),** following Capo.js. The spec said "src".
4. **The "scrolls sideways" culprit naming applies to the a11y-views reflow finding, the reflow chip and the breakpoint chips.** The existing international chips are unchanged, so their tests stay stable.

## Review Focus

1. **Readings without the new data** (old readings, imported HARs, the CLI). The `console` and `layout` plugins skip cleanly. `head-order` runs whenever document HTML exists, including in the CLI. Tasks 4–6 test the skips.
2. **A noisy page:** thousands of console messages or a looping error. The store stays capped at 100 entries plus `dropped`, and recording stops when the views start. Task 1 tests the cap.
3. **A page with no px breakpoints, or a `css` plugin that errored.** No breakpoint views and no `layout` findings; nothing throws. Tasks 2 and 6 test this.
4. **Documents served gzip/base64, or truncated over the body limit.** `head-order` decodes base64 and copes with a missing `</head>`. Task 5 tests this.
5. **Share export.** No console text survives `stripForSharing` by default; counts and locations do. Task 1 tests this.

---

### Task 1: Console helpers and share stripping

**Files:**
- Create: `extension/core/console.js`
- Modify: `extension/core/harplus.js` (`stripForSharing`)
- Test: `test/console.test.mjs`

**Interfaces:**
- Produces, used by Tasks 3 and 4:
  - `redact(text) → string`;
  - `consoleEntryFrom(method, params) → entry | null`;
  - `addConsoleEntry(store, entry)`, where `store = { entries: [], dropped: 0 }`;
  - `CONSOLE_MAX = 100`, `TEXT_MAX = 300`.
- An entry is `{ kind: 'exception'|'console-error'|'console-warn'|'log'|'issue', text, url?, line?, source?, level?, code?, count }`.
- `stripForSharing(reading, { screenshots, bodies, console: 'counts'|'keep' = 'counts' })`.

- [ ] **Step 1: Write the failing tests** in `test/console.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { redact, consoleEntryFrom, addConsoleEntry, CONSOLE_MAX } from '../extension/core/console.js';
  import { stripForSharing } from '../extension/core/harplus.js';

  test('redact: query strings, long tokens; short text and paths untouched', () => {
    assert.equal(redact('GET https://api.x.com/v1/users?token=abc&id=5 failed'), 'GET https://api.x.com/v1/users?… failed');
    assert.equal(redact('Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijkl'), 'Bearer …');
    assert.equal(redact('Uncaught TypeError: x is undefined'), 'Uncaught TypeError: x is undefined');
    assert.equal(redact('at https://cdn.example.com/assets/javascripts/application.js:12'), 'at https://cdn.example.com/assets/javascripts/application.js:12');
    assert.equal(redact('x'.repeat(10) + ' ' + 'y'.repeat(400)).length <= 300, true);
  });

  test('consoleEntryFrom: exceptions, console errors/warnings, log entries, issues; others null', () => {
    assert.deepEqual(consoleEntryFrom('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', lineNumber: 4, url: 'https://s.test/a.js?v=1', exception: { description: 'Error: boom\n    at f (a.js:5)' } } }),
      { kind: 'exception', text: 'Error: boom', url: 'https://s.test/a.js', line: 5 });
    assert.deepEqual(consoleEntryFrom('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'bad' }, { type: 'number', value: 3 }], stackTrace: { callFrames: [{ url: 'https://s.test/m.js', lineNumber: 9 }] } }),
      { kind: 'console-error', text: 'bad 3', url: 'https://s.test/m.js', line: 10 });
    assert.equal(consoleEntryFrom('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'object', description: 'Object' }] }).kind, 'console-warn');
    assert.equal(consoleEntryFrom('Runtime.consoleAPICalled', { type: 'log', args: [] }), null);
    assert.deepEqual(consoleEntryFrom('Log.entryAdded', { entry: { source: 'security', level: 'error', text: "Refused to load the image because it violates the following Content Security Policy directive: \"img-src 'self'\"", url: 'https://o.test/i.png?x=1' } }),
      { kind: 'log', source: 'security', level: 'error', text: "Refused to load the image because it violates the following Content Security Policy directive: \"img-src 'self'\"", url: 'https://o.test/i.png' });
    assert.equal(consoleEntryFrom('Log.entryAdded', { entry: { source: 'network', level: 'info', text: 'x' } }), null);
    assert.deepEqual(consoleEntryFrom('Audits.issueAdded', { issue: { code: 'ContentSecurityPolicyIssue', details: { contentSecurityPolicyIssueDetails: { violatedDirective: 'img-src', blockedURL: 'https://o.test/i.png?q=1' } } } }),
      { kind: 'issue', code: 'ContentSecurityPolicyIssue', text: 'img-src blocked https://o.test/i.png?…' });
    assert.equal(consoleEntryFrom('Audits.issueAdded', { issue: { code: 'DeprecationIssue', details: { deprecationIssueDetails: { type: 'NoSysexWebMIDIWithoutPermission' } } } }).text, 'NoSysexWebMIDIWithoutPermission');
    assert.equal(consoleEntryFrom('Network.requestWillBeSent', {}), null);
  });

  test('addConsoleEntry: dedupes with count, caps at 100, redacts text', () => {
    const store = { entries: [], dropped: 0 };
    addConsoleEntry(store, { kind: 'console-error', text: 'x', url: 'u', line: 1 });
    addConsoleEntry(store, { kind: 'console-error', text: 'x', url: 'u', line: 1 });
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].count, 2);
    for (let i = 0; i < 150; i++) addConsoleEntry(store, { kind: 'console-error', text: `e${i}` });
    assert.equal(store.entries.length, CONSOLE_MAX);
    assert.equal(store.dropped, 51);
    addConsoleEntry(store, { kind: 'log', text: 'see https://a.test/p?secret=1' });
    assert.equal(store.dropped, 52);
  });

  test('stripForSharing removes console text and console finding details by default', () => {
    const r = { log: { entries: [], _harplus: { screenshots: [], capture: { console: { entries: [{ kind: 'exception', text: 'Error: secret', url: 'https://s.test/a.js', line: 3, count: 1 }], dropped: 0 } },
      plugins: { console: { status: 'ok', findings: [{ title: '1 uncaught JavaScript errors', detail: 'Error: secret' }], data: { entries: [{ kind: 'exception', text: 'Error: secret' }] } } } } } };
    const s = stripForSharing(r);
    assert.equal(s.log._harplus.capture.console.entries[0].text, '');
    assert.equal(s.log._harplus.capture.console.entries[0].line, 3);
    assert.equal(s.log._harplus.plugins.console.findings[0].detail, undefined);
    assert.equal(s.log._harplus.plugins.console.data.entries[0].text, '');
    assert.equal(s.log._harplus.stripped.console, 'counts');
    assert.equal(stripForSharing(r, { console: 'keep' }).log._harplus.capture.console.entries[0].text, 'Error: secret');
    assert.equal(r.log._harplus.capture.console.entries[0].text, 'Error: secret', 'original untouched');
  });
  ```

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/console.test.mjs`

  Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `extension/core/console.js`:**

  ```js
  // Console and DevTools Issues recorded during capture: redaction, CDP event → entry, de-duplicated store.
  // Pure: used by capture (recording) and the console plugin.

  export const CONSOLE_MAX = 100;
  export const TEXT_MAX = 300;

  export function redact(text = '') {
    return String(text)
      .replace(/\b(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/g, '$1?…')
      .replace(/[A-Za-z0-9_\-+=]{24,}/g, '…')
      .slice(0, TEXT_MAX);
  }

  const noQuery = (u) => (u ? String(u).split(/[?#]/)[0] : undefined);
  const frame = (st) => st?.callFrames?.[0];

  function issueText(issue) {
    const d = issue?.details || {};
    const csp = d.contentSecurityPolicyIssueDetails;
    if (csp) return `${csp.violatedDirective || 'CSP'} blocked ${csp.blockedURL || 'inline content'}`;
    const mixed = d.mixedContentIssueDetails;
    if (mixed) return `${mixed.resolutionStatus || 'mixed content'} ${mixed.insecureURL || ''}`.trim();
    const dep = d.deprecationIssueDetails;
    if (dep) return String(dep.type || 'deprecation');
    const cookie = d.cookieIssueDetails;
    if (cookie) return `${cookie.cookie?.name || 'cookie'}: ${[...(cookie.cookieWarningReasons || []), ...(cookie.cookieExclusionReasons || [])].join(', ')}`;
    return String(issue?.code || 'issue');
  }

  /** A CDP event → a console entry (unredacted except URLs), or null for events we don't record. */
  export function consoleEntryFrom(method, params = {}) {
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails || {};
      const f = frame(d.stackTrace);
      const text = String(d.exception?.description || d.text || 'Uncaught exception').split('\n')[0];
      const line = d.lineNumber ?? f?.lineNumber;
      return { kind: 'exception', text: redact(text), url: noQuery(d.url || f?.url), line: line == null ? undefined : line + 1 };
    }
    if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'warning')) {
      const f = frame(params.stackTrace);
      const text = (params.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');
      return { kind: params.type === 'error' ? 'console-error' : 'console-warn', text: redact(text), url: noQuery(f?.url), line: f?.lineNumber == null ? undefined : f.lineNumber + 1 };
    }
    if (method === 'Log.entryAdded') {
      const e = params.entry || {};
      if (e.level !== 'error' && e.level !== 'warning') return null;
      return { kind: 'log', source: e.source, level: e.level, text: redact(e.text || ''), url: noQuery(e.url) };
    }
    if (method === 'Audits.issueAdded') {
      const issue = params.issue || {};
      return { kind: 'issue', code: issue.code, text: redact(issueText(issue)) };
    }
    return null;
  }

  const keyOf = (e) => [e.kind, e.code || '', e.text, e.url || '', e.line ?? ''].join('|');

  /** Add an entry to { entries, dropped }: redact, de-duplicate (count), cap at CONSOLE_MAX. */
  export function addConsoleEntry(store, e) {
    const entry = Object.fromEntries(Object.entries({ ...e, text: redact(e.text), url: e.url ? noQuery(e.url) : undefined }).filter(([, v]) => v !== undefined));
    const k = keyOf(entry);
    const same = store.entries.find((x) => keyOf(x) === k);
    if (same) { same.count += 1; return; }
    if (store.entries.length >= CONSOLE_MAX) { store.dropped += 1; return; }
    store.entries.push({ ...entry, count: 1 });
  }
  ```

  `consoleEntryFrom` redacts every `text` it returns, and `addConsoleEntry` redacts again. That's idempotent: `?…` stays `?…`.

  In `extension/core/harplus.js`, change `stripForSharing`:

  ```js
  export function stripForSharing(reading, { screenshots = 'thumbnail', bodies = false, console: cons = 'counts' } = {}) {
    const copy = structuredClone(reading);
    const hp = copy.log._harplus;
    if (screenshots === 'none') hp.screenshots = [];
    else if (screenshots === 'thumbnail') hp.screenshots = hp.screenshots.filter((s) => s.kind === 'thumbnail');
    if (!bodies) for (const e of copy.log.entries) { delete e.response.content.text; delete e.response.content.encoding; }
    if (cons === 'counts') {
      for (const e of hp.capture?.console?.entries || []) e.text = '';
      const pr = hp.plugins?.console;
      if (pr) {
        for (const f of pr.findings || []) delete f.detail;
        for (const e of pr.data?.entries || []) e.text = '';
      }
    }
    if (hp.analysis === 'pending') hp.analysis = 'done';
    hp.stripped = { screenshots, bodies, console: cons };
    return copy;
  }
  ```

  If an existing test deep-equals `hp.stripped`, update it to include `console: 'counts'`.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `node --test test/console.test.mjs`, then `npm test`.

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/core/console.js extension/core/harplus.js test/console.test.mjs
  git commit -m "Console helpers: redaction, CDP event entries, de-duplicated capped store; share export strips console text

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 2: Breakpoint and label helpers (`views.js`)

**Files:**
- Modify: `extension/core/views.js`
- Test: `test/views.test.mjs`

**Interfaces:**
- Produces, used by Tasks 3, 6 and 8:
  - `BREAKPOINT_VIEW` (RegExp) and `isBreakpointView(id)`;
  - `viewLabel(id)`;
  - `pickBreakpoints(media) → number[]`;
  - `breakpointFindings(views, breakpoints, baseM) → finding[]`;
  - `shotView` accepts breakpoint ids.

- [ ] **Step 1: Write the failing tests.** Append to `test/views.test.mjs`, adding the new names to its import from `../extension/core/views.js`:

  ```js
  test('breakpoint view ids and labels', () => {
    assert.ok(isBreakpointView('bp768-below'));
    assert.ok(isBreakpointView('bp1024-at'));
    assert.ok(!isBreakpointView('bp-at'));
    assert.equal(viewLabel('bp768-below'), '767 px');
    assert.equal(viewLabel('bp768-at'), '768 px');
    assert.equal(viewLabel('dark'), 'Dark mode');
    assert.equal(viewLabel('zzz'), 'zzz');
    assert.equal(shotView({ view: 'bp900-at' }, 'desktop'), 'bp900-at');
  });

  test('pickBreakpoints: normalises min/max/range, em, clamps 320–1920, top 2 with larger on ties', () => {
    assert.deepEqual(pickBreakpoints([['(max-width: 899px)', 3], ['(min-width: 600px)', 2], ['(min-width: 1200px)', 2]]), [900, 1200]);
    assert.deepEqual(pickBreakpoints([['(min-width: 48em)', 1], ['screen and (max-width: 47.99em)', 1]]), [768]);
    assert.deepEqual(pickBreakpoints([['(width >= 1024px)', 1], ['(width < 640px)', 1], ['(width <= 639px)', 1]]), [640, 1024]);
    assert.deepEqual(pickBreakpoints([['(min-width: 200px)', 9], ['(min-width: 4000px)', 9], ['print', 9]]), []);
    assert.deepEqual(pickBreakpoints([]), []);
    assert.deepEqual(pickBreakpoints(undefined), []);
  });

  test('breakpointFindings: edge-only overflow (medium, with culprits) and clipping (low)', () => {
    const base = { overflowX: 0, clipped: 1 };
    const views = {
      'bp900-below': { overflowX: 40, clipped: 1, overflowers: [{ selector: 'div.edge', width: 920, over: 40 }] },
      'bp900-at': { overflowX: 0, clipped: 5 },
    };
    const f = breakpointFindings(views, [900], base);
    assert.deepEqual(f.map((x) => `${x.severity}:${x.title}`), [
      'medium:Layout breaks at 899 px (just below the 900 px breakpoint)',
      'low:Text clips at 900 px near the 900 px breakpoint',
    ]);
    assert.equal(f[0].detail, 'Wider than the viewport: div.edge (920 px)');
    assert.ok(f.every((x) => x.category === 'quality'));
    assert.deepEqual(breakpointFindings({ 'bp900-below': { overflowX: 40 }, 'bp900-at': { overflowX: 40 } }, [900], base), [], 'both edges overflow → not an edge break');
    assert.deepEqual(breakpointFindings({ 'bp900-below': { overflowX: 40 } }, [900], { overflowX: 10 }), [], 'base already overflows');
    assert.deepEqual(breakpointFindings({}, [], base), []);
  });
  ```

  Arithmetic for the second `pickBreakpoints` case: `max-width: 47.99em` = 767.84 px, floor + 1 = 768; `min-width: 48em` = 768. Both total 768, so the result is `[768]`.

  For the range case:
  - `width >= 1024px` → 1024;
  - `width < 640px` → 640;
  - `width <= 639px` → 640.
  
  So 640 has count 2 and 1024 has count 1, and the order is `[640, 1024]`.

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/views.test.mjs`

  Expected: FAIL, because the exports are missing.

- [ ] **Step 3: Implement.** Add these to `extension/core/views.js`:

  ```js
  /** Breakpoint-edge views are named bp<b>-below (b−1 px) and bp<b>-at (b px). */
  export const BREAKPOINT_VIEW = /^bp(\d+)-(below|at)$/;
  export const isBreakpointView = (id) => BREAKPOINT_VIEW.test(String(id ?? ''));

  export function viewLabel(id) {
    const m = String(id ?? '').match(BREAKPOINT_VIEW);
    if (m) { const b = Number(m[1]); return `${m[2] === 'below' ? b - 1 : b} px`; }
    return VIEW_LABELS[id] || String(id);
  }

  /** [[mediaQuery, ruleCount], …] → up to 2 breakpoints (first px width of the new layout), busiest first. */
  export function pickBreakpoints(media = []) {
    const totals = new Map();
    const px = (n, unit) => n * (/^r?em$/i.test(unit) ? 16 : 1);
    for (const [q, count] of media || []) {
      const n = Number(count) || 1;
      const add = (v) => { if (v >= 320 && v <= 1920) totals.set(v, (totals.get(v) || 0) + n); };
      for (const m of String(q).matchAll(/(min|max)-width\s*:\s*([\d.]+)(px|em|rem)/gi)) {
        const v = px(parseFloat(m[2]), m[3]);
        add(m[1].toLowerCase() === 'min' ? Math.ceil(v) : Math.floor(v) + 1);
      }
      for (const m of String(q).matchAll(/width\s*(>=|<=|>|<)\s*([\d.]+)(px|em|rem)/gi)) {
        const v = px(parseFloat(m[2]), m[3]);
        add(m[1] === '>=' || m[1] === '<' ? Math.ceil(v) : Math.floor(v) + 1);
      }
    }
    return [...totals].sort((a, b) => b[1] - a[1] || b[0] - a[0]).slice(0, 2).map(([v]) => v);
  }

  /** Overflow or clipping that appears only on one side of a breakpoint. */
  export function breakpointFindings(views = {}, breakpoints = [], baseM = {}) {
    const out = [];
    const ox = (v) => Number(v?.overflowX) || 0;
    const cl = (v) => Number(v?.clipped) || 0;
    for (const b of breakpoints || []) {
      const below = views[`bp${b}-below`];
      const at = views[`bp${b}-at`];
      for (const [v, other, w, where] of [[below, at, b - 1, 'below'], [at, below, b, 'at']]) {
        if (!v) continue;
        if (ox(v) > 0 && ox(other) === 0 && ox(baseM) === 0) {
          const culprits = (v.overflowers || []).map((o) => `${o.selector} (${Math.round(o.width)} px)`).join(', ');
          out.push({ severity: 'medium', category: 'quality', title: `Layout breaks at ${w} px (just ${where} the ${b} px breakpoint)`, ...(culprits ? { detail: `Wider than the viewport: ${culprits}` } : {}) });
        }
        if (cl(v) - Math.max(cl(other), cl(baseM)) >= 3) {
          out.push({ severity: 'low', category: 'quality', title: `Text clips at ${w} px near the ${b} px breakpoint` });
        }
      }
    }
    return out;
  }
  ```

  Change `shotView` to:

  ```js
  export const shotView = (shot, base) => (VIEWS.includes(shot?.view) || isBreakpointView(shot?.view) ? shot.view : base);
  ```

  `shotView` is declared above the new helpers. `isBreakpointView` is a `const` arrow function, so define it **above** `shotView` to avoid a temporal-dead-zone error at call time. In fact calls only happen after module load, so either order works; place it above for clarity.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/core/views.js test/views.test.mjs
  git commit -m "Views: breakpoint view ids, labels, breakpoint picking and edge findings

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 3: Capture: console recording, overflow culprits, breakpoint-edge views

**Files:**
- Modify: `extension/browser/capture.js`
- Modify: `extension/browser/settings.js`, `extension/ui/options.html`, `extension/ui/popup.html`
- Modify: `test/e2e/site/index.html`, `test/e2e/run.mjs`
- Test: `test/views.test.mjs` (settings default); the rest is covered by the e2e.

**Interfaces:**
- Consumes: `consoleEntryFrom` and `addConsoleEntry` (Task 1); `pickBreakpoints`, `viewLabel` and `isBreakpointView` (Task 2).
- Produces:
  - `hp.capture.console = { entries, dropped }`;
  - `measureView()`'s `overflowers: [{ selector, width, over }]`;
  - `hp.capture.breakpoints: number[]`;
  - views `bp<b>-below` and `bp<b>-at` in `hp.capture.views`, each with a viewport screenshot.

- [ ] **Step 1: Write the failing tests and extend the site.**

  Append to `test/views.test.mjs`:

  ```js
  test('settings: breakpoint views on by default', () => {
    assert.equal(DEFAULTS.capture.views.breakpoints, true);
  });
  ```

  In `test/e2e/site/index.html`:
  - Add `<meta http-equiv="Content-Security-Policy" content="img-src 'self'">` right after `<meta charset="utf-8">`.
  - Add to the existing `<style>` block:

    ```css
      @media (min-width: 880px) and (max-width: 899px) { .edge { min-width: 920px; } }
      @media (min-width: 880px) and (max-width: 899px) { .edge { color: #123; } }
      @media (min-width: 880px) and (max-width: 899px) { .edge { padding: 0; } }
    ```

  - Add `<div class="edge">Edge box</div>` inside `<main>`.
  - Add `<img src="http://localhost:__PORT__/img/hero.svg" alt="Cross-origin hero" width="40" height="20">`. The CSP blocks it: different origin, same server.
  - Add an inline script at the end of `<body>`:

    ```html
      <script>console.error('e2e console error'); setTimeout(() => { throw new Error('e2e uncaught'); }, 0);</script>
    ```

  In `test/e2e/run.mjs`:
  - Where page errors are collected, `page.on('pageerror', …)` for the site, ignore `e2e uncaught`: `if (!/e2e uncaught/.test(e.message)) errors.push(...)`.
  - Add the new views to the `shotViews(r1)` expected list: `'bp880-at', 'bp880-below', 'bp900-at', 'bp900-below'`. The list is sorted.

    Breakpoints are picked from the three `min-width: 880px` and three `max-width: 899px` queries: 880 → 880, and 899 → 900, each with count 3. Ties go to the larger value, so the result is `[900, 880]`. Plus the existing `@media print` and `prefers-color-scheme`, which aren't widths.
  - After the existing `mv` assertions, add:

    ```js
        assert.deepEqual(hp.capture.breakpoints, [900, 880]);
        for (const id of ['bp900-below', 'bp900-at', 'bp880-below', 'bp880-at']) {
          assert.deepEqual(hp.screenshots.filter((s) => s.view === id).map((s) => s.kind), ['viewport'], `${id} viewport only`);
          assert.ok(mv[id], `${id} measured`);
        }
        assert.ok(mv['bp900-below'].overflowX > 0 && mv['bp900-at'].overflowX === 0, 'overflows only at 899');
        assert.ok(mv['bp900-below'].overflowers.some((o) => /edge/.test(o.selector)), JSON.stringify(mv['bp900-below'].overflowers));
        assert.ok(mv.reflow.overflowers.some((o) => /promo/.test(o.selector)), 'reflow culprit is the promo box');
        const con = hp.capture.console;
        assert.ok(con?.entries.some((e) => e.kind === 'console-error' && /e2e console error/.test(e.text)), JSON.stringify(con));
        assert.ok(con.entries.some((e) => e.kind === 'exception' && /e2e uncaught/.test(e.text)), 'uncaught exception recorded');
        assert.ok(con.entries.some((e) => (e.kind === 'issue' && e.code === 'ContentSecurityPolicyIssue') || (e.kind === 'log' && /Content Security Policy/.test(e.text))), 'CSP violation recorded');
    ```

  Note the `.edge` rule only applies between 880 and 899 px:
  - the 899 view overflows and the 900 view doesn't;
  - 880 overflows and 879 doesn't.

  The desktop (1280), tablet (820), mobile (390) and reflow (320) views are unaffected, because 820 < 880.

- [ ] **Step 2: Run the e2e to watch it fail**

  Run: `npm test` (expected to fail on the settings default), then `npm run test:e2e` (expected to fail on `shotViews`).

- [ ] **Step 3: Implement.**

  **Settings and toggles.**
  - In `DEFAULTS.capture.views`, add `breakpoints: true`.
  - In `options.html`, add the chip `<label class="chip"><input type="checkbox" data-path="capture.views.breakpoints"> Breakpoint edges</label>`.
  - In `popup.html`, add `<label><input type="checkbox" name="views.breakpoints"> Breakpoint edges</label>`.

  **Console recording**, in `capture.js`:
  - Import `{ consoleEntryFrom, addConsoleEntry }` from `'../core/console.js'`.
  - In the constructor, or wherever `this.warnings` is initialised, add `this.console = { entries: [], dropped: 0 };`.
  - After `await this.send('Network.enable', NET_ENABLE);` (~line 505), add:

    ```js
        await this.send('Runtime.enable').catch(() => {});
        await this.send('Log.enable').catch(() => {});
        await this.send('Audits.enable').catch(() => {});
    ```

  - In `onEvent`, before `const rec = this.recorder.handle(...)`, add:

    ```js
        if (!sid && !this.viewsRunning) {
          const entry = consoleEntryFrom(method, params);
          if (entry) addConsoleEntry(this.console, entry);
        }
    ```

  - Where the reading's `capture` object is built (the `createReading({ … capture: { …, warnings: this.warnings } })` call in `finish()`), add `console: this.console`.
  - `Runtime.enable` makes Chrome emit `Runtime.executionContextCreated` events. The recorder ignores unknown methods; check that `this.recorder.handle` returns harmlessly for them.

  **`measureView()` overflowers.** Inside `measureView` (self-contained), before the `return`, add:

  ```js
    const vpath = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
        let p = n.localName;
        if (n.id) { parts.unshift(`${p}#${n.id}`); break; }
        if (n.classList.length) p += `.${[...n.classList].slice(0, 2).join('.')}`;
        parts.unshift(p);
      }
      return parts.join(' > ');
    };
    const overflowers = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) {
      const cands = [];
      let seen = 0;
      for (const el of root.querySelectorAll('*')) {
        if (++seen > 3000 || cands.length >= 300 || performance.now() - t0 > 1500) { truncated = true; break; }
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > innerWidth + 1) cands.push({ el, r });
      }
      const inner = cands.filter((c) => !cands.some((o) => o !== c && c.el.contains(o.el)));
      inner.sort((a, b) => b.r.right - a.r.right);
      for (const c of inner.slice(0, 5)) overflowers.push({ selector: vpath(c.el), width: Math.round(c.r.width), over: Math.round(c.r.right - innerWidth) });
    }
  ```

  Add `overflowers,` to the returned object. `root`, `t0` and `truncated` already exist in `measureView`; reuse them. `truncated` must be a `let`.

  **Breakpoint views.**
  - In `captureViews`, import `pickBreakpoints`, `viewLabel` and `isBreakpointView`.
  - Change the `view()` helper's label line from `const label = \`${VIEW_LABELS[id]} view\`;` to `const label = \`${viewLabel(id)} view\`;`.
  - After the accessibility views' combined reset (`if (a11yWanted) await this.resetA11y(base)`) and before the `nojs` block, add:

    ```js
        if (want.breakpoints !== false) {
          const css = hp.plugins?.css;
          const bps = css?.status === 'ok' ? pickBreakpoints(css.data?.media || []) : [];
          if (bps.length) {
            hp.capture.breakpoints = bps;
            const height = await withTimeout(this.evaluate(() => innerHeight, null, 'main'), 3000, 'viewport height').catch(() => 800);
            for (const b of bps) {
              for (const [id, width] of [[`bp${b}-below`, b - 1], [`bp${b}-at`, b]]) {
                await view(id, {
                  runMs: 30_000,
                  restoreMs: 10_000,
                  run: async () => {
                    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
                    await sleep(600);
                    return grabFold(id, true);
                  },
                  restore: () => this.applyDevice(base),
                });
              }
            }
          }
        }
    ```

  - `grabFold(id, measured)` already exists from the accessibility views. Check its signature in the file: it was extended with a third `scale` argument. Pass `true` for measured.
  - **If `hp.plugins` isn't yet populated** when `captureViews` runs (the page-phase plugins run before it in `finish()`), read `reading.log._harplus.plugins`. `hp` is `reading.log._harplus`, so these are the same object.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`, then `npm run test:e2e`.

  Expected: PASS.

  If the CSP violation arrives only as a `Log.entryAdded` with source `security`, or only as an Audits issue, the assertion accepts either. If neither arrives, report the raw `hp.capture.console` in NEEDS_CONTEXT.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/browser/capture.js extension/browser/settings.js extension/ui/options.html extension/ui/popup.html test/views.test.mjs test/e2e/site/index.html test/e2e/run.mjs
  git commit -m "Capture: console/Issues recording, overflow culprits, breakpoint-edge views

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 4: The `console` plugin

**Files:**
- Create: `extension/plugins/console.js`
- Modify: `extension/plugins/index.js` (add `consolePlugin` after `resilience`, before `a11yViews`)
- Test: `test/console-plugin.test.mjs`

**Interfaces:**
- Consumes: `hp.capture.console` (Tasks 1 and 3).
- Produces: plugin `console`; `data = { entries, dropped, counts: { exceptions, errors, warnings, issues } }`.

- [ ] **Step 1: Write the failing tests** in `test/console-plugin.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import plugin from '../extension/plugins/console.js';
  import { getPlugins } from '../extension/plugins/index.js';
  import { h } from '../extension/ui/render.js';

  const reading = (con) => ({ log: { entries: [], _harplus: { capture: { console: con } } } });
  const ctx = { skip: (m) => { const e = new Error(m); e.name = 'SkipError'; throw e; } };
  const t = (r) => r.findings.map((f) => `${f.severity}:${f.category}:${f.title}`);

  test('registered as an analyze plugin in the Build area', () => {
    assert.ok(getPlugins().some((p) => p.id === 'console'));
    assert.equal(plugin.phase, 'analyze');
    assert.equal(plugin.area, 'build');
  });

  test('skips without a console recording', () => {
    assert.throws(() => plugin.run(reading(undefined), ctx), /no console recording/);
  });

  test('findings with counts summed; security for CSP and mixed content', () => {
    const r = plugin.run(reading({ dropped: 0, entries: [
      { kind: 'exception', text: 'Error: a', url: 'https://s.test/a.js', line: 3, count: 2 },
      { kind: 'console-error', text: 'bad', count: 3 },
      { kind: 'console-warn', text: 'meh', count: 1 },
      { kind: 'issue', code: 'ContentSecurityPolicyIssue', text: 'img-src blocked x', count: 1 },
      { kind: 'log', source: 'security', level: 'error', text: "Refused to load … Content Security Policy directive", count: 1 },
      { kind: 'issue', code: 'MixedContentIssue', text: 'x', count: 1 },
      { kind: 'issue', code: 'DeprecationIssue', text: 'y', count: 2 },
      { kind: 'log', source: 'deprecation', level: 'warning', text: 'z', count: 1 },
      { kind: 'issue', code: 'CookieIssue', text: 'c', count: 1 },
      { kind: 'log', source: 'network', level: 'error', text: 'Failed to load resource: 404', count: 4 },
    ] }), ctx);
    assert.deepEqual(t(r), [
      'medium:quality:2 uncaught JavaScript errors',
      'low:quality:3 console errors',
      'medium:security:2 Content-Security-Policy violations',
      'medium:security:1 mixed-content requests blocked or upgraded',
      'info:quality:3 deprecated features used',
      'low:quality:1 cookie issues reported by the browser',
      'info:quality:4 failed requests logged by the browser',
    ]);
    assert.equal(r.findings[0].detail, 'Error: a (https://s.test/a.js:3)');
    assert.equal(r.summary[0].value, '2 exceptions · 3 errors · 1 warnings · 5 issues'); // issues = kind 'issue' only: 1+1+2+1
    assert.equal(r.summary[0].rating, 'poor');
  });

  test('clean console: no findings, good rating; stripped text renders as —', () => {
    const r = plugin.run(reading({ dropped: 0, entries: [{ kind: 'console-warn', text: '', count: 1 }] }), ctx);
    assert.deepEqual(r.findings, []);
    assert.equal(r.summary[0].rating, 'needs-improvement');
    const clean = plugin.run(reading({ dropped: 0, entries: [] }), ctx);
    assert.equal(clean.summary[0].rating, 'good');
    assert.match(String(plugin.render({ status: 'ok', ...r }, h)), /—/);
  });
  ```

  "Issues" means DevTools Issues only (`kind === 'issue'`): CSP 1, mixed 1, deprecation 2 and cookie 1, so 5.

  Rating rules:
  - **poor** when exceptions ≥ 1;
  - **needs-improvement** when errors, warnings or issues are ≥ 1;
  - **good** otherwise.

  The clean-console test's warning-only case therefore gives needs-improvement.

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/console-plugin.test.mjs`

  Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `extension/plugins/console.js`:**

  ```js
  // Console: uncaught errors, console errors, CSP and mixed-content violations, deprecations and browser
  // Issues recorded during the load (capture.console). Offline — re-runs in the CLI on readings that have it.

  const sum = (xs) => xs.reduce((n, e) => n + (Number(e.count) || 1), 0);
  const where = (e) => (e.url ? ` (${e.url}${e.line ? `:${e.line}` : ''})` : '');

  function run(reading, ctx) {
    const con = reading.log._harplus?.capture?.console;
    if (!con) ctx.skip('no console recording in this reading — take a new reading');
    const entries = con.entries || [];
    const of = (fn) => entries.filter(fn);
    const exceptions = of((e) => e.kind === 'exception');
    const errors = of((e) => e.kind === 'console-error');
    const warnings = of((e) => e.kind === 'console-warn');
    const csp = of((e) => (e.kind === 'issue' && e.code === 'ContentSecurityPolicyIssue') || (e.kind === 'log' && e.source === 'security' && /Content Security Policy/i.test(e.text || '')));
    const mixed = of((e) => e.kind === 'issue' && e.code === 'MixedContentIssue');
    const deprecated = of((e) => (e.kind === 'issue' && e.code === 'DeprecationIssue') || (e.kind === 'log' && e.source === 'deprecation'));
    const cookies = of((e) => e.kind === 'issue' && /^Cookie/.test(e.code || ''));
    const failed = of((e) => e.kind === 'log' && e.source === 'network' && e.level === 'error');
    const issues = of((e) => e.kind === 'issue');
    const findings = [];
    const add = (severity, category, title, detail) => findings.push({ severity, category, title, ...(detail ? { detail } : {}) });
    if (exceptions.length) add('medium', 'quality', `${sum(exceptions)} uncaught JavaScript errors`, exceptions.slice(0, 3).map((e) => `${e.text}${where(e)}`).join('; '));
    if (errors.length) add('low', 'quality', `${sum(errors)} console errors`, errors.slice(0, 3).map((e) => `${e.text}${where(e)}`).join('; '));
    if (csp.length) add('medium', 'security', `${sum(csp)} Content-Security-Policy violations`, csp.slice(0, 3).map((e) => e.text).join('; '));
    if (mixed.length) add('medium', 'security', `${sum(mixed)} mixed-content requests blocked or upgraded`);
    if (deprecated.length) add('info', 'quality', `${sum(deprecated)} deprecated features used`, deprecated.slice(0, 3).map((e) => e.text).join('; '));
    if (cookies.length) add('low', 'quality', `${sum(cookies)} cookie issues reported by the browser`);
    if (failed.length) add('info', 'quality', `${sum(failed)} failed requests logged by the browser`);
    // "issues" = DevTools Issues (kind 'issue') only.
    const counts = { exceptions: sum(exceptions), errors: sum(errors), warnings: sum(warnings), issues: sum(issues) };
    return {
      data: { entries, dropped: con.dropped || 0, counts },
      findings,
      summary: [{
        label: 'Console', headline: true,
        value: `${counts.exceptions} exceptions · ${counts.errors} errors · ${counts.warnings} warnings · ${counts.issues} issues`,
        rating: counts.exceptions ? 'poor' : counts.errors || counts.warnings || counts.issues ? 'needs-improvement' : 'good',
      }],
    };
  }

  function render(r, h) {
    return h.html`${h.table(r.data.entries.map((e) => ({
      kind: e.code || e.kind, text: e.text || '—', where: e.url ? `${e.url}${e.line ? `:${e.line}` : ''}` : '', count: String(e.count || 1),
    })), [{ key: 'kind', label: 'Kind' }, { key: 'text', label: 'Message' }, { key: 'where', label: 'Location' }, { key: 'count', label: 'Count' }])}
    ${r.data.dropped ? h.html`<p class="note">${r.data.dropped} more entries not kept.</p>` : ''}`;
  }

  export default {
    id: 'console',
    name: 'Console',
    version: '0.1.0',
    phase: 'analyze',
    group: 'build',
    area: 'build',
    description: 'Uncaught errors, console errors, CSP and mixed-content violations, deprecations and browser Issues during the load.',
    tags: ['quality'],
    run,
    render,
  };
  ```

  In `index.js`:
  - add `import consolePlugin from './console.js';`;
  - change the second row to `tech, javascript, baseline, resilience, consolePlugin, a11yViews, international, network, security,`.

  If a test asserts that `a11y-views` comes right after `resilience`, update it to come right after `console`, and say why.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/console.js extension/plugins/index.js test/console-plugin.test.mjs
  git commit -m "Console plugin: uncaught errors, console errors, CSP, mixed content, deprecations, cookie issues

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 5: The `head-order` plugin

**Files:**
- Create: `extension/plugins/head-order.js`
- Modify: `extension/plugins/index.js` (add `headOrder` after `network` in the second row)
- Test: `test/head-order.test.mjs`

**Interfaces:**
- Produces:
  - `parseHead(html) → [{ tag, attrs, content, offset, weight, label }]`;
  - `analyzeHead(html) → { data, findings, summary }`;
  - plugin `head-order` (analyze, `area: 'performance'`).

- [ ] **Step 1: Write the failing tests** in `test/head-order.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import plugin, { parseHead, analyzeHead } from '../extension/plugins/head-order.js';
  import { h } from '../extension/ui/render.js';

  const doc = (head) => `<!doctype html><html><head>${head}</head><body><p>x</p></body></html>`;
  const t = (r) => r.findings.map((f) => `${f.severity}:${f.title}`);

  test('weights (Capo.js)', () => {
    const els = parseHead(doc(`<meta charset="utf-8"><meta name="viewport" content="w"><title>T</title>
      <link rel="preconnect" href="https://cdn.test"><script async src="a.js"></script><style>@import url(x.css);</style>
      <script src="sync.js"></script><script>var inline = 1;</script><link rel="stylesheet" href="app.css"><style>p{}</style>
      <link rel="preload" href="f.woff2" as="font"><script defer src="d.js"></script><script type="module" src="m.js"></script>
      <link rel="prefetch" href="next.html"><link rel="icon" href="i.png"><script type="application/ld+json">{}</script>
      <link rel="stylesheet" href="print.css" media="print"><!-- <script src="commented.js"></script> -->
      <template><link rel="stylesheet" href="t.css"></template>`));
    assert.deepEqual(els.map((e) => e.weight), [10, 10, 9, 8, 7, 6, 5, 5, 4, 4, 3, 2, 2, 1, 0, 0, 0]);
    assert.equal(els.find((e) => e.weight === 7).label, 'script async a.js');
  });

  test('in optimal order: no findings', () => {
    assert.deepEqual(t(analyzeHead(doc('<meta charset="utf-8"><title>T</title><link rel="stylesheet" href="a.css"><script defer src="d.js"></script>'))), []);
  });

  test('inversions, blocking script before CSS, late charset', () => {
    const r = analyzeHead(doc(`<title>T</title><script src="sync.js"></script><link rel="preconnect" href="https://cdn.test"><link rel="stylesheet" href="app.css"><meta charset="utf-8">`));
    assert.deepEqual(t(r), [
      'low:2 <head> elements out of optimal order', // preconnect after script; meta charset after everything
      'low:A blocking script delays the CSS',
    ]);
    assert.match(r.findings[0].detail, /link preconnect cdn\.test after script sync\.js/);
    const late = analyzeHead(doc(`<title>${'x'.repeat(1100)}</title><meta charset="utf-8">`));
    assert.ok(t(late).includes('low:<meta charset> is not in the first 1024 bytes'));
    assert.ok(t(analyzeHead(doc('<title>T</title>'))).includes('low:<meta charset> is not in the first 1024 bytes'), 'missing charset');
    assert.ok(!t(analyzeHead(doc('<meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>T</title>'))).includes('low:<meta charset> is not in the first 1024 bytes'), 'http-equiv charset counts');
  });

  test('missing </head> and run(): base64 body, skip without HTML; glance has no NaN', () => {
    assert.equal(parseHead('<html><head><title>T</title><body>x').length, 1);
    const html = doc('<meta charset="utf-8"><title>T</title>');
    const entry = { request: { url: 'https://s.test/' }, response: { status: 200, content: { mimeType: 'text/html', size: html.length, text: Buffer.from(html).toString('base64'), encoding: 'base64' }, headers: [] }, _resourceType: 'document' };
    const reading = { log: { entries: [entry], _harplus: { target: { finalUrl: 'https://s.test/' } } } };
    const util = { mainEntry: (r) => r.log.entries[0] };
    const out = plugin.run(reading, { util, skip: (m) => { throw new Error(m); } });
    assert.deepEqual(out.findings, []);
    assert.doesNotMatch(String(plugin.glance({ status: 'ok', ...out }, h)), /NaN|undefined/);
    assert.throws(() => plugin.run({ log: { entries: [], _harplus: {} } }, { util: { mainEntry: () => undefined }, skip: (m) => { throw new Error(m); } }), /no document HTML/);
  });
  ```

  Inversions, worked through:
  - The order is title(9), script(5), preconnect(8), stylesheet(4), meta charset(10).
  - An element counts when some earlier element has a lower weight:
    - preconnect (8) comes after script (5): yes;
    - stylesheet (4): the earlier weights are 9, 5 and 8, none lower than 4, so no;
    - meta charset (10): the earlier weights include 9, 5, 8 and 4, so yes.
  - That's 2. The detail's first entry is "link preconnect cdn.test after script sync.js".

  The meta charset sits at a small offset, under 1024 bytes, so there's no charset finding in that case. The blocking script (weight 5) comes before the stylesheet (weight 4), so that finding is raised.

  The weights list in the first test excludes the commented-out script and the template contents, giving 17 elements.

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/head-order.test.mjs`

  Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `extension/plugins/head-order.js`:**

  ```js
  // <head> order: Capo.js weights over the document HTML as the server sent it. Offline (works in the CLI).

  const blank = (m) => ' '.repeat(m.length);

  function weightOf({ tag, attrs, content }) {
    const rel = String(attrs.rel || '').toLowerCase().split(/\s+/);
    const type = String(attrs.type || '').toLowerCase();
    if (tag === 'meta' && ('charset' in attrs || 'http-equiv' in attrs || String(attrs.name || '').toLowerCase() === 'viewport')) return 10;
    if (tag === 'base') return 10;
    if (tag === 'title') return 9;
    if (tag === 'link' && rel.includes('preconnect')) return 8;
    if (tag === 'script') {
      if (/json/.test(type)) return 0;
      if ('async' in attrs && 'src' in attrs) return 7;
      if (type === 'module' || ('defer' in attrs && 'src' in attrs)) return 2;
      return 5; // synchronous: blocks parsing (inline or src), per Capo.js
    }
    if (tag === 'style') return /@import/i.test(content) ? 6 : 4;
    if (tag === 'link' && rel.includes('stylesheet')) return /\bprint\b/i.test(attrs.media || '') ? 0 : 4;
    if (tag === 'link' && (rel.includes('preload') || rel.includes('modulepreload'))) return 3;
    if (tag === 'link' && rel.some((r) => ['prefetch', 'dns-prefetch', 'prerender'].includes(r))) return 1;
    return 0;
  }

  const base = (u) => String(u || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  const host = (u) => { try { return new URL(u).host; } catch { return base(u); } };

  function labelOf({ tag, attrs }) {
    if (tag === 'meta') return attrs.charset != null ? 'meta charset' : attrs['http-equiv'] ? `meta http-equiv ${attrs['http-equiv']}` : `meta ${attrs.name || attrs.property || ''}`.trim();
    if (tag === 'link') {
      const rel = String(attrs.rel || '').toLowerCase();
      return `link ${rel} ${rel.includes('preconnect') || rel.includes('dns-prefetch') ? host(attrs.href) : base(attrs.href)}`.trim();
    }
    if (tag === 'script') {
      const kind = 'async' in attrs ? 'script async' : 'defer' in attrs ? 'script defer' : String(attrs.type || '') === 'module' ? 'script module' : 'script';
      return attrs.src ? `${kind} ${base(attrs.src)}` : `inline ${kind}`;
    }
    return tag;
  }

  export function parseHead(html = '') {
    const s = String(html);
    const stops = [s.search(/<\/head\s*>/i), s.search(/<body[\s>]/i)].filter((x) => x >= 0);
    const end = stops.length ? Math.min(...stops) : s.length;
    const src = s.slice(0, end).replace(/<!--[\s\S]*?-->/g, blank).replace(/<template[\s\S]*?<\/template\s*>/gi, blank);
    const lower = src.toLowerCase();
    const out = [];
    const re = /<(meta|title|base|link|script|style|noscript)\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(src))) {
      const tag = m[1].toLowerCase();
      const attrs = {};
      for (const a of m[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
      let content = '';
      if (['script', 'style', 'title', 'noscript'].includes(tag)) {
        const close = lower.indexOf(`</${tag}`, re.lastIndex);
        if (close >= 0) { content = src.slice(re.lastIndex, close); re.lastIndex = close; }
      }
      const el = { tag, attrs, content, offset: m.index };
      out.push({ ...el, weight: weightOf(el), label: labelOf(el) });
    }
    return out;
  }

  export function analyzeHead(html) {
    const els = parseHead(html);
    const findings = [];
    const add = (title, detail) => findings.push({ severity: 'low', category: 'performance', title, ...(detail ? { detail } : {}) });
    const inversions = [];
    els.forEach((e, i) => {
      const j = els.slice(0, i).findIndex((p) => p.weight < e.weight);
      if (j >= 0) inversions.push(`${e.label} after ${els[j].label}`);
    });
    if (inversions.length) add(`${inversions.length} <head> elements out of optimal order`, inversions.slice(0, 3).join('; '));
    const charset = els.find((e) => e.tag === 'meta' && (e.attrs.charset != null || /charset=/i.test(e.attrs.content || '')));
    const bytesBefore = charset ? new TextEncoder().encode(String(html).slice(0, charset.offset)).length : Infinity;
    if (bytesBefore > 1024) add('<meta charset> is not in the first 1024 bytes');
    const firstScript = els.findIndex((e) => e.weight === 5);
    const firstCss = els.findIndex((e) => e.weight === 4);
    if (firstScript >= 0 && firstCss >= 0 && firstScript < firstCss) add('A blocking script delays the CSS');
    return {
      data: { elements: els.map(({ tag, label, weight }, i) => ({ tag, label, weight, late: els.slice(0, i).some((p) => p.weight < weight) })) },
      findings,
      summary: [{ label: '<head> order', value: inversions.length ? `${inversions.length} out of order` : 'optimal', rating: inversions.length ? 'needs-improvement' : 'good' }],
    };
  }

  function run(reading, ctx) {
    const e = ctx.util?.mainEntry?.(reading);
    const c = e?.response?.content;
    if (!c?.text) ctx.skip('no document HTML in this reading — capture with response bodies');
    const html = c.encoding === 'base64' ? new TextDecoder().decode(Uint8Array.from(atob(c.text), (ch) => ch.charCodeAt(0))) : c.text;
    return analyzeHead(html);
  }

  function glance(r, h) {
    const rows = r.data.elements.slice(0, 30);
    return h.html`<section class="card"><h4>&lt;head&gt; order (Capo weights)</h4>${h.hbars({
      label: 'Head elements by weight', max: 10,
      rows: rows.map((e) => ({ label: `${e.late ? '⚠ ' : ''}${e.label}`, value: e.weight, display: String(e.weight), color: e.late ? 'var(--st-serious)' : 'var(--c1)' })),
    })}</section>`;
  }

  function render(r, h) {
    return h.table(r.data.elements.map((e, i) => ({ n: String(i + 1), el: e.label, weight: String(e.weight), late: e.late ? 'out of order' : '' })),
      [{ key: 'n', label: '#' }, { key: 'el', label: 'Element' }, { key: 'weight', label: 'Weight' }, { key: 'late', label: '' }]);
  }

  export default {
    id: 'head-order',
    name: '<head> order',
    version: '0.1.0',
    phase: 'analyze',
    group: 'build',
    area: 'performance',
    description: 'Orders the <head> by Capo.js weights from the HTML as served and flags elements that delay rendering.',
    tags: ['performance'],
    run,
    glance,
    render,
  };
  ```

  - `atob` and `TextDecoder` are available in Node 20+ and in extension pages.
  - `h.hbars` uses `safeColor`; `var(--st-serious)` must pass its `COLOR_RE`. Check `charts.js`, and if it doesn't pass, use `'var(--c2)'`.
  - If `h.table` rejects an empty column label, use `'Note'`.
  - In `index.js`, add `import headOrder from './head-order.js';` and put `headOrder` after `network` in the second row.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `node --test test/head-order.test.mjs`, then `npm test`.

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/head-order.js extension/plugins/index.js test/head-order.test.mjs
  git commit -m "Head order plugin: Capo.js weights over the served HTML, inversions, late charset, blocking script before CSS

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 6: The `layout` plugin and the `css` `vwRules` count

**Files:**
- Create: `extension/plugins/layout.js`
- Modify: `extension/plugins/css.js` (count `vwRules` in `collect`; expose it in `data`)
- Modify: `extension/plugins/index.js` (add `layout` after `consolePlugin`)
- Test: `test/layout.test.mjs`

**Interfaces:**
- Consumes:
  - `breakpointFindings`, `baseView`, `viewLabel` and `isBreakpointView` (Task 2);
  - `hp.capture.views`, including breakpoint views and `overflowers`, and `hp.capture.breakpoints` (Task 3);
  - `results.css.data.vwRules`.
- Produces: plugin `layout`, with `data = { breakpoints, views: { [id]: { overflowX, clipped, overflowers } }, vwRules }`.

- [ ] **Step 1: Write the failing tests** in `test/layout.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import plugin from '../extension/plugins/layout.js';
  import { getPlugins } from '../extension/plugins/index.js';
  import { h } from '../extension/ui/render.js';

  const reading = (capture) => ({ log: { entries: [], _harplus: { capture: { device: 'desktop', ...capture } } } });
  const ctx = (css) => ({ results: css ? { css: { status: 'ok', data: css } } : {}, skip: (m) => { const e = new Error(m); e.name = 'SkipError'; throw e; } });
  const t = (r) => r.findings.map((f) => `${f.severity}:${f.title}`);
  const B = { overflowX: 0, clipped: 0, cssHeight: 3000 };

  test('registered as a Build analyze plugin', () => {
    assert.ok(getPlugins().some((p) => p.id === 'layout'));
    assert.equal(plugin.area, 'build');
    assert.equal(plugin.phase, 'analyze');
  });

  test('skips with neither breakpoint views nor a css result', () => {
    assert.throws(() => plugin.run(reading({ views: { desktop: B } }), ctx()), /no breakpoint views or CSS data/);
  });

  test('breakpoint findings and 100vw', () => {
    const r = plugin.run(reading({
      breakpoints: [900],
      views: { desktop: B, 'bp900-below': { overflowX: 20, clipped: 0, overflowers: [{ selector: 'div.edge', width: 920, over: 20 }] }, 'bp900-at': { overflowX: 0, clipped: 0 } },
    }), ctx({ vwRules: 2 }));
    assert.deepEqual(t(r), [
      'medium:Layout breaks at 899 px (just below the 900 px breakpoint)',
      'low:2 rules use width: 100vw (adds horizontal scroll when a vertical scrollbar is present)',
    ]);
  });

  test('100vw only when the page scrolls vertically; render without NaN', () => {
    const short = plugin.run(reading({ views: { desktop: { ...B, cssHeight: 500 } } }), ctx({ vwRules: 2 }));
    assert.deepEqual(t(short), []);
    assert.doesNotMatch(String(plugin.glance({ status: 'ok', ...short }, h)) + String(plugin.render({ status: 'ok', ...short }, h)), /NaN|undefined/);
  });
  ```

  "Scrolls vertically" means the base view's `cssHeight` is greater than its viewport height. The viewport height isn't in `measureView` today. Use the base view's viewport screenshot `cssHeight` when available; otherwise compare against 900 px. For `cssHeight` 3000 that's true, and for 500 it's false.

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/layout.test.mjs`

  Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement.**

  In `extension/plugins/css.js` `collect()`:
  - add `vwRules: 0` to the stats object `S`, the one with `atRules: {}, media: {}, mediaFeatures: {}…`;
  - inside the `declarations(style)` helper, add:

    ```js
        for (const prop of ['width', 'min-width']) if (/100vw/.test(style.getPropertyValue(prop) || '')) S.vwRules++;
    ```

  - Add `vwRules: S.vwRules` to the object `collect()` returns. It flows into `data` through `{ ...c }`.

  Create `extension/plugins/layout.js`:

  ```js
  // Layout: breakage at the edges of the site's busiest breakpoints, and 100vw widths.
  // Offline — compares the breakpoint-edge views measured during capture.

  import { baseView, breakpointFindings, isBreakpointView, viewLabel } from '../core/views.js';

  function run(reading, ctx) {
    const cap = reading.log._harplus?.capture || {};
    const views = cap.views || {};
    const css = ctx.results?.css?.status === 'ok' ? ctx.results.css.data || {} : null;
    const bps = cap.breakpoints || [];
    const edgeIds = Object.keys(views).filter(isBreakpointView);
    if (!edgeIds.length && !css) ctx.skip('no breakpoint views or CSS data in this reading');
    const baseId = baseView(reading);
    const baseM = views[baseId] || {};
    const findings = breakpointFindings(views, bps, baseM);
    const vw = Number(css?.vwRules) || 0;
    const shot = (reading.log._harplus?.screenshots || []).find((s) => s.kind === 'viewport' && (s.view || baseId) === baseId);
    const vh = Number(shot?.cssHeight) || 900;
    if (vw >= 1 && (Number(baseM.cssHeight) || 0) > vh) {
      findings.push({ severity: 'low', category: 'quality', title: `${vw} rules use width: 100vw (adds horizontal scroll when a vertical scrollbar is present)` });
    }
    const pick = (v) => ({ overflowX: Number(v?.overflowX) || 0, clipped: Number(v?.clipped) || 0, overflowers: v?.overflowers || [] });
    return {
      data: { breakpoints: bps, views: Object.fromEntries(edgeIds.map((id) => [id, pick(views[id])])), vwRules: vw },
      findings,
      summary: [{ label: 'Breakpoints', value: bps.length ? bps.map((b) => `${b} px`).join(', ') : 'none detected' }],
    };
  }

  function glance(r, h) {
    const ids = Object.keys(r.data.views);
    return ids.length ? h.html`<section class="card"><h4>Breakpoint edges</h4>${h.checklist(ids.map((id) => {
      const v = r.data.views[id];
      return { label: viewLabel(id), ok: v.overflowX === 0, note: v.overflowX ? `${v.overflowers[0]?.selector || 'overflow'} +${v.overflowX} px` : 'fits' };
    }))}</section>` : '';
  }

  function render(r, h) {
    return h.table(Object.entries(r.data.views).map(([id, v]) => ({
      view: viewLabel(id), overflow: `${v.overflowX} px`, clipped: String(v.clipped), culprits: v.overflowers.map((o) => `${o.selector} (${o.width} px)`).join(', '),
    })), [{ key: 'view', label: 'Width' }, { key: 'overflow', label: 'Overflow' }, { key: 'clipped', label: 'Clipped' }, { key: 'culprits', label: 'Wider than the viewport' }]);
  }

  export default {
    id: 'layout',
    name: 'Layout',
    version: '0.1.0',
    phase: 'analyze',
    group: 'build',
    area: 'build',
    description: 'Layout breakage at the edges of the busiest CSS breakpoints, and 100vw widths.',
    tags: ['quality'],
    run,
    glance,
    render,
  };
  ```

  In `index.js`, add `import layout from './layout.js';` and change the second row to `tech, javascript, baseline, resilience, consolePlugin, layout, a11yViews, international, network, headOrder, security,`. Keep `headOrder` where Task 5 put it.

  Check `h.checklist` accepts `note`; it does, see `carbon.js`.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/layout.js extension/plugins/css.js extension/plugins/index.js test/layout.test.mjs
  git commit -m "Layout plugin: breakpoint-edge breakage and 100vw widths; css counts 100vw rules

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 7: Layout-shift culprits (`vitals`) and PageSpeed `auto`

**Files:**
- Modify: `extension/plugins/vitals.js`
- Modify: `extension/plugins/pagespeed.js`
- Test: `test/plugins.test.mjs` or `test/glance.test.mjs` (append)

**Interfaces:**
- Produces:
  - `vitals` `data.clsSources = [{ value, sources: [{ node, previous, current }] }]`;
  - the CLS finding's `detail` "Shifted: …";
  - `pagespeed` option `strategy`, default `'auto'`, and `data.strategy` set to the strategy actually used.

- [ ] **Step 1: Write the failing tests.** Append to `test/plugins.test.mjs`:

  ```js
  import vitalsPlugin from '../extension/plugins/vitals.js';
  import pagespeedPlugin from '../extension/plugins/pagespeed.js';

  test('vitals: CLS finding names the shifted elements; render lists shifts', async () => {
    const { h } = await import('../extension/ui/render.js');
    const collected = { visibility: 'visible', navigation: { ttfb: 100 }, fcp: 500, lcp: { time: 1000 }, cls: 0.3, blockingTime: 0, renderBlocking: [], domElements: 10, resources: 1,
      clsSources: [{ value: 0.2, sources: [{ node: 'div.ad', previous: { x: 0, y: 0, w: 300, h: 0 }, current: { x: 0, y: 0, w: 300, h: 250 } }] }, { value: 0.1, sources: [{ node: 'img.hero', previous: null, current: { x: 0, y: 0, w: 10, h: 10 } }] }] };
    const out = vitalsPlugin.run({}, { collected, skip: () => {} });
    const f = out.findings.find((x) => /Cumulative layout shift/.test(x.title));
    assert.equal(f.detail, 'Shifted: div.ad, img.hero');
    const html = String(vitalsPlugin.render({ status: 'ok', ...out }, h));
    assert.match(html, /div\.ad/);
    assert.doesNotMatch(html, /NaN|undefined/);
  });

  test('pagespeed: strategy auto follows the reading base view', async () => {
    const urls = [];
    const mk = (device) => ({
      reading: { log: { entries: [], _harplus: { capture: { device } } } },
      ctx: { keys: { pagespeed: 'k' }, options: { strategy: 'auto' }, target: { finalUrl: 'https://s.test/', host: 's.test' }, util: { isIP: () => false },
        fetch: async (u) => { urls.push(String(u)); return new Response(JSON.stringify({}), { status: 200 }); }, skip: (m) => { throw new Error(m); } },
    });
    const m = mk('mobile');
    const outM = await pagespeedPlugin.run(m.reading, m.ctx);
    const d = mk('desktop');
    const outD = await pagespeedPlugin.run(d.reading, d.ctx);
    assert.match(urls[0], /strategy=mobile/);
    assert.match(urls[1], /strategy=desktop/);
    assert.equal(outM.data.strategy, 'mobile');
    assert.equal(outD.data.strategy, 'desktop');
    assert.equal(pagespeedPlugin.options.find((o) => o.key === 'strategy').default, 'auto');
    assert.deepEqual(pagespeedPlugin.options.find((o) => o.key === 'strategy').choices, ['auto', 'mobile', 'desktop']);
  });
  ```

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/plugins.test.mjs`

  Expected: FAIL. There's no CLS detail yet, and the strategy is still mobile for desktop readings.

- [ ] **Step 3: Implement.**

  In `vitals.js` `collect()`, replace the CLS loop with:

  ```js
    let cls = 0; let session = 0; let first = 0; let last = 0; let win = []; let best = [];
    for (const s of shifts) {
      if (s.hadRecentInput) continue;
      if (session && s.startTime - last < 1000 && s.startTime - first < 5000) { session += s.value; win.push(s); }
      else { session = s.value; first = s.startTime; win = [s]; }
      last = s.startTime;
      if (session > cls) { cls = session; best = win.slice(); }
    }
  ```

  After the existing `describe` helper is defined, add:

  ```js
    const rect = (r) => (r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null);
    const clsSources = best.sort((a, b) => b.value - a.value).slice(0, 3).map((s) => ({
      value: Math.round(s.value * 1000) / 1000,
      sources: (s.sources || []).slice(0, 3).map((x) => ({ node: describe(x.node) || '(removed)', previous: rect(x.previousRect), current: rect(x.currentRect) })),
    }));
  ```

  Add `clsSources,` to the returned object.

  In `run()`, inside the findings loop, when `k === 'cls'`, attach the detail:

  ```js
      const shifted = k === 'cls' ? [...new Set((c.clsSources || []).flatMap((s) => s.sources.map((x) => x.node)))].slice(0, 3) : [];
      findings.push({
        severity: r === 'poor' ? 'medium' : 'low',
        category: 'performance',
        title: `${names[k]} ${r}: ${v}`,
        ref: `https://web.dev/articles/${k}`,
        ...(shifted.length ? { detail: `Shifted: ${shifted.join(', ')}` } : {}),
      });
  ```

  In `render()`, append:

  ```js
      ${(d.clsSources || []).length ? h.sub('Layout shifts', h.table(d.clsSources.flatMap((s) => s.sources.map((x) => ({
        value: String(s.value), node: x.node,
        move: `${x.previous ? `${x.previous.w}×${x.previous.h} @${x.previous.x},${x.previous.y}` : '—'} → ${x.current ? `${x.current.w}×${x.current.h} @${x.current.x},${x.current.y}` : '—'}`,
      }))), [{ key: 'value', label: 'Shift' }, { key: 'node', label: 'Element' }, { key: 'move', label: 'Before → after' }])) : ''}
  ```

  Put it inside the existing `h.html` template of `render`, at the end. Note that `render`'s data variable is `d`.

  In `pagespeed.js`:
  - add `import { baseView } from '../core/views.js';`;
  - in `run`, before building the URL, add:

    ```js
      const chosen = ctx.options.strategy;
      const strategy = chosen === 'mobile' || chosen === 'desktop' ? chosen : (baseView(reading) === 'mobile' ? 'mobile' : 'desktop');
    ```

  - use `strategy` in `url.searchParams.set('strategy', strategy)` and in `data: { strategy, … }`;
  - change the option to `{ key: 'strategy', label: 'Device', type: 'select', default: 'auto', choices: ['auto', 'mobile', 'desktop'] }`;
  - the glance and render already read `d.strategy`.

  If the existing `enrich plugins with mocked services` test asserts `strategy: 'mobile'` for a desktop reading, update it to `desktop`, and say why.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/vitals.js extension/plugins/pagespeed.js test/plugins.test.mjs
  git commit -m "Vitals names layout-shift culprits; PageSpeed strategy auto follows the reading's device

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 8: Report (Breakpoints section, culprit naming), e2e and fixture refresh

**Files:**
- Modify: `extension/ui/report.js` (Breakpoints section; reflow chip names its culprit)
- Modify: `extension/plugins/a11y-views.js` (reflow finding detail names the culprit)
- Modify: `test/report.test.mjs`, `test/a11y-views.test.mjs`, `test/e2e/run.mjs`, `test/fixtures/local-site.har`

**Interfaces:**
- Consumes: `isBreakpointView` and `viewLabel` (Task 2); `overflowers` (Task 3); the titles from Tasks 4–7.

- [ ] **Step 1: Write the failing tests.**

  Append to `test/a11y-views.test.mjs`:

  ```js
  test('reflow finding names the widest culprit', () => {
    const out = run({ reflow: { ...B, overflowX: 44, overflowers: [{ selector: 'p.promo', width: 364, over: 44 }] } });
    const f = out.findings.find((x) => /320 px/.test(x.title));
    assert.match(f.detail, /^p\.promo is 364 px wide in a 320 px view\./);
  });
  ```

  Use that file's existing `run`/`B` helpers. If its helper names differ, adapt to them.

  Append to `test/report.test.mjs`:

  ```js
  test('screens pane: Breakpoints section with edge shots and overflow chips', () => {
    const r = withViews();
    const hp = r.log._harplus;
    for (const v of ['bp900-below', 'bp900-at']) hp.screenshots.push({ kind: 'viewport', view: v, mimeType: 'image/png', encoding: 'base64', data: PNG, cssWidth: v.endsWith('below') ? 899 : 900, cssHeight: 800, dpr: 1 });
    hp.capture.views['bp900-below'] = { overflowX: 20, clipped: 0, overflowers: [{ selector: 'div.edge', width: 920, over: 20 }] };
    hp.capture.views['bp900-at'] = { overflowX: 0, clipped: 0 };
    hp.capture.breakpoints = [900];
    const s = screens(renderReport(r, getPlugins()));
    assert.match(s, /<h2>Breakpoints<\/h2>/);
    assert.match(s, /<b>899 px<\/b>[\s\S]*?div\.edge/);
    assert.match(s, /<b>900 px<\/b>[\s\S]*?fits/);
    assert.doesNotMatch(screens(renderReport(withViews(), getPlugins())), /<h2>Breakpoints<\/h2>/);
  });
  ```

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/a11y-views.test.mjs test/report.test.mjs`

  Expected: FAIL.

- [ ] **Step 3: Implement.**

  **`a11y-views.js` reflow block.** Build the detail:

  ```js
      const o = (reflow.overflowers || [])[0];
      const lead = o ? `${o.selector} is ${o.width} px wide in a 320 px view. ` : '';
  ```

  and prefix the existing detail with `lead`. If the existing detail text is `Content is ${over} px wider than a 320 px viewport.`, the new detail is `${lead}Content is …`.

  **`report.js`.**
  - Import `isBreakpointView` and `viewLabel` from `../core/views.js`.
  - In `screensPane`, after the Accessibility views section, add:

    ```js
        ${bpIds.length ? html`<section class="card views">
          <header class="views-head"><h2>Breakpoints</h2></header>
          <div class="resilience">${bpIds.map((v) => html`<figure>${foldImage(by[v], viewLabel(v))}<figcaption><b>${viewLabel(v)}</b>${bpChip(mv[v])}</figcaption></figure>`)}</div>
        </section>` : ''}
    ```

    with:

    ```js
      const bpIds = Object.keys(by).filter(isBreakpointView).sort((a, b) => {
        const n = (id) => Number(id.match(/\d+/)[0]);
        return n(a) - n(b) || (a.endsWith('below') ? -1 : 1);
      });
    ```

    and a helper next to `a11yChips`:

    ```js
    function bpChip(m) {
      if (!m) return '';
      const over = Number(m.overflowX) || 0;
      const o = (m.overflowers || [])[0];
      return over > 0 ? ratingChip(`scrolls sideways${o ? ` · ${o.selector}` : ''}`, 'poor') : ratingChip('fits', 'good');
    }
    ```

  - `mv` and `by` already exist in `screensPane`, from the previous batch.
  - In the reflow branch of `a11yChips` (the overflow case), append the culprit the same way, `` `${over} px overflow${o ? ` · ${o.selector}` : ''}` ``, without changing the existing "fits" branch. Check the existing a11y report test still passes. It matches `/40 px overflow/`, which is still a prefix.

  **E2E**, in `test/e2e/run.mjs`, next to the other `r1` plugin checks:

  ```js
      const P = r1.log._harplus.plugins;
      const titles = (id) => (P[id]?.findings || []).map((f) => f.title);
      assert.equal(P.console?.status, 'ok', `console: ${P.console?.error}`);
      assert.ok(titles('console').some((x) => /^\d+ uncaught JavaScript errors$/.test(x)), titles('console').join(' | '));
      assert.ok(titles('console').some((x) => /^\d+ console errors$/.test(x)));
      assert.ok(titles('console').some((x) => /^\d+ Content-Security-Policy violations$/.test(x)));
      assert.equal(P['head-order']?.status, 'ok', `head-order: ${P['head-order']?.error}`);
      assert.equal(P.layout?.status, 'ok', `layout: ${P.layout?.error}`);
      const lb = P.layout.findings.find((f) => f.title === 'Layout breaks at 899 px (just below the 900 px breakpoint)');
      assert.ok(lb && /edge/.test(lb.detail || ''), JSON.stringify(P.layout.findings));
      log('build signals passed');
  ```

  Where the report's Screens pane is checked on `page2`, add:

  ```js
      assert.equal(await page2.locator('#screens h2', { hasText: 'Breakpoints' }).count(), 1, 'breakpoints section');
  ```

  The head-order plugin has no deliberate inversion on the test site. Add one: put `<link rel="preconnect" href="http://localhost:__PORT__">` in `<head>` **after** `<script type="importmap">` (an inline sync script, weight 5). Then assert:

  ```js
      assert.ok(titles('head-order').some((x) => /<head> elements out of optimal order$/.test(x)), titles('head-order').join(' | '));
  ```

  If the document HTML isn't stored in the reading (check `capture.bodies` defaults; `'text'` includes the document), report it rather than weakening the assertion.

- [ ] **Step 4: Run all tests and refresh the fixture**

  Run: `npm test`, then `npm run test:e2e`, then `cp test/e2e/out/local-site.har test/fixtures/local-site.har`, then `npm test` again.

  Expected: PASS throughout. If the new e2e assertions pass on the first run, prove one can fail: temporarily expect "Layout breaks at 900 px", run once, see the failure, and revert. Update only the expectations the refreshed fixture legitimately changes, and list each one.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/ui/report.js extension/plugins/a11y-views.js test/report.test.mjs test/a11y-views.test.mjs test/e2e/run.mjs test/e2e/site/index.html test/fixtures/local-site.har
  git commit -m "Report: Breakpoints section, reflow culprits; e2e for console, head order and layout; refreshed fixture

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```
