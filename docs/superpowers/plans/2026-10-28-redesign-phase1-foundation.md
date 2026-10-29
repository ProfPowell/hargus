# Report redesign, phase 1: foundation — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New design tokens, component CSS and `h` helpers from the redesign. Every page takes the new look, and no pane changes its layout yet.

**Architecture:**
- New tokens go into the `tokens` layer of `extension/ui/theme.css`. Today's token names stay as aliases of the new ones, so existing CSS and JS restyle without being rewritten.
- New helpers go in `extension/ui/render.js` (shell and plugin kit) and `extension/ui/charts.js` (graphics). Each emits one class shape from the design's component sheet.
- Existing helper names and call shapes keep working.

**Tech Stack:** plain ES modules, CSS `@layer` and `light-dark()`, `node --test`, and Playwright e2e (`npm run test:e2e`, run from the worktree directory).

**Spec:** `docs/superpowers/specs/2026-10-28-report-redesign-design.md`, sections F and H.1.

**Design references:**
- `docs/design/2026-10-28-proposed.css`: the design session's token and component CSS. Copy rules from here rather than inventing values.
- `docs/design/2026-10-28-report-redesign.html`: the boards. Open it in Chrome; it needs JS.

## Global Constraints

- Scores and findings are unchanged; this phase touches only rendering.
- The standalone export (`standaloneDocument` in `extension/ui/report.js`) contains no `<script>`.
- Every closed `<details>` the new helpers emit opens for print.
- `theme.css` keeps `@layer reset, tokens, base, components, pages;` and uses `light-dark()` for every colour token.
- Fonts stay as they are: Instrument Sans and IBM Plex Mono.
- No colour carries meaning without a word or glyph beside it.
- Every interpolated value goes through `html```, which escapes it. `raw()` is only for constant markup.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings made while planning

1. **The light `--band-fair` is `#9c5f00`, not the design's `#b26b00`.** The design's value is 3.78:1 on `--bg`, below the 4.5:1 the spec requires. `#9c5f00` gives 4.66 on `--bg` and 5.18 on `--surface`. All other design values pass.
2. **Name clash on `--band-*`.** Today's `--band-good`, `--band-warning` and `--band-poor` are pastel fills behind `h.meter`. They become `--zone-good`, `--zone-fair` and `--zone-poor`, and the `--band-*` names take the design's strong colours.
3. **The score ring stays SVG.** The design's conic-gradient ring is not adopted. `h.ring` keeps its markup and gets its colour from `--st-<status>`, which now aliases the bands:

   | `--st-*` | becomes |
   |---|---|
   | `good` | `--band-good` |
   | `warning` | `--band-fair` |
   | `serious`, `critical` | `--band-poor` |
   | `none` | `--line` |

4. **The design's `.meter` (a plain score bar) becomes `h.scoreBar` with class `.score-bar`.** `h.meter` and `.chart.meter` (the banded rating meter) already exist and stay.
5. **`h.sub` keeps an `<h4>` title**, so existing tests and the heading outline hold. It now emits the panel shape. A panel nested inside `.plugin` or another `.panel` draws flat: no border, no background, no padding of its own.
6. **Base font size is 13px everywhere.** It is set in the unlayered `body` rule. Today Chrome's own sheet makes extension pages 12px while the export gets the layered 14px.

## Review Focus

1. **A token renamed or removed while CSS or JS still uses it.** The colour silently becomes transparent or inherited. Task 1 adds a test that every `var(--x)` in `extension/ui/**/*.{css,js}` and `extension/plugins/*.js` is declared somewhere.
2. **Dark-mode contrast.** Both halves of each `light-dark()` pair must pass. Task 1's contrast test checks both modes.
3. **Two-argument `h.sub(title, content)` calls with empty content.** There are 90 such calls in plugins, and they must still return `''`. Pinned in Task 3.
4. **`h.mix` with all-zero or missing counts.** It must render nothing, with no `NaN` and no `flex-grow:0` spans. Pinned in Task 2.
5. **Untrusted text in new helpers.** Labels and notes containing `<` must come out escaped. Pinned in Tasks 2 and 3.

---

### Task 1: Tokens, scales, base size, and the token tests

**Files:**
- Modify: `extension/ui/theme.css`: the unlayered `body` rule at line 23, `@layer tokens` at lines 35–113, and `@layer base` at lines 115–132. Also any rule using `var(--band-good)`, `var(--band-warning)` or `var(--band-poor)`; there is one of each today, for the `h.meter` bands.
- Create: `test/tokens.test.mjs`

**Interfaces:**
- Produces, for all later tasks, these tokens in `:root`:
  - colours: `--bg --surface --surface-sunk --line --line-strong --ink --ink-2 --ink-3 --accent --accent-ink --accent-soft --focus --sev-high --sev-high-soft --sev-medium --sev-medium-soft --sev-low --sev-low-soft --sev-info --sev-info-soft --band-good --band-fair --band-poor --zone-good --zone-fair --zone-poor`;
  - type: `--font-sans --font-mono --fs-2xs --fs-xs --fs-sm --fs-md --fs-lg --fs-xl --fs-2xl --fs-3xl`;
  - spacing: `--sp-1 … --sp-7`;
  - radius: `--r-1 --r-2 --r-pill`.

- [ ] **Step 1: Write `test/tokens.test.mjs`**

  The test reads `extension/ui/theme.css` as text and parses every `--name: light-dark(#xxxxxx, #yyyyyy)` declaration in the `@layer tokens` `:root` block. It computes WCAG relative-luminance contrast; write a small helper in the test.

  ```js
  test('ink, accent, severity and band tokens pass 4.5:1 on bg, surface and surface-sunk in both modes', () => {
    for (const fg of ['ink','ink-2','ink-3','accent','sev-high','sev-medium','sev-low','sev-info','band-good','band-fair','band-poor'])
      for (const bg of ['bg','surface','surface-sunk']) for (const mode of [0, 1])
        assert.ok(ratio(tok[fg][mode], tok[bg][mode]) >= 4.5, `${fg} on ${bg} (${mode ? 'dark' : 'light'})`);
  });
  test('severity ink passes 4.5:1 on its own soft fill in both modes', () => { /* sev-X on sev-X-soft, and accent on accent-soft */ });
  test('every var(--x) used is declared', () => {
    // Uses: every var(--name) in extension/ui/*.css, extension/ui/*.js and extension/plugins/*.js.
    // Declared: every `--name:` in theme.css, plus custom properties set inline from JS (style="--v:…", "--level:…").
    // Collect those by scanning the same JS files for /--([a-z0-9-]+)\s*:/.
    assert.deepEqual(undeclared, []);
  });
  test('scale tokens exist', () => {
    // --fs-2xs 11px, --fs-xs 12px, --fs-sm 13px, --fs-md 15px, --fs-lg 18px, --fs-xl 24px, --fs-2xl 32px, --fs-3xl 44px
    // --sp-1 4px, --sp-2 8px, --sp-3 12px, --sp-4 16px, --sp-5 24px, --sp-6 32px, --sp-7 48px
    // --r-1 6px, --r-2 10px, --r-pill 999px
  });
  ```

- [ ] **Step 2: Run the test and check that it fails**

  Run `node --test test/tokens.test.mjs`.

  Expected: the contrast and scale tests FAIL because the tokens are missing. The undeclared-var test may already pass; that's fine.

- [ ] **Step 3: Add the new tokens and alias the old ones**

  New token values come from the `@layer tokens` block of `docs/design/2026-10-28-proposed.css`, with these changes:
  - `--band-fair` is `light-dark(#9c5f00, #f2b54d)` (ruling 1);
  - `--fs-2xs`, `--fs-2xl` and `--fs-3xl` are added at 11, 32 and 44px;
  - `--font-sans` is the existing `--font` stack, and `--font-mono` the existing `--mono` stack.

  `--zone-good`, `--zone-fair` and `--zone-poor` take today's `--band-good`, `--band-warning` and `--band-poor` values. Update their three uses.

  Every other existing token name becomes an alias:

  | Existing token | Alias of |
  |---|---|
  | `--panel` | `var(--surface)` |
  | `--panel-2` | `var(--surface-sunk)` |
  | `--text`, `--primary` | `var(--ink)` |
  | `--muted` | `var(--ink-2)` |
  | `--high`, `--medium`, `--low`, `--info` | `var(--sev-…)` |
  | `--ok`, `--ink-good` | `var(--band-good)` |
  | `--ink-warning`, `--amber` | `var(--band-fair)` |
  | `--ink-serious`, `--ink-critical` | `var(--band-poor)` |
  | `--track` | `var(--line)` |
  | `--font` | `var(--font-sans)` |
  | `--mono` | `var(--font-mono)` |
  | `--radius` | `var(--r-1)` |
  | `--radius-lg` | `var(--r-2)` |
  | `--st-*` | as in ruling 3 |

  Keep unchanged:
  - the chart (`--c1…--c8`, `--c-other`), waterfall (`--ph-*`), page map (`--pm-*`) and brand mark (`--mark-*`) tokens;
  - `--segment` and `--gap`.

- [ ] **Step 4: Set the base size and text tokens**

  - The unlayered rule becomes `body { font-family: var(--font); font-size: 13px; }`. Rewrite its comment to say that the size is set here so extension pages and the export match.
  - In `@layer base`, the `body` rule uses `line-height: 1.5` and no longer sets a size.
  - `h1`, `h2`, `h3` and `h4` take sizes from `--fs-*`, using the design's `@layer base` rules as the guide.
  - `:focus-visible` uses `var(--focus)`.

- [ ] **Step 5: Run the tests and check that they pass**

  Run `npm test`.

  Expected: all pass, including the 4 new tests (919 or more).

- [ ] **Step 6: Commit**

  `git add extension/ui/theme.css test/tokens.test.mjs`, then commit with the message "Redesign tokens: surfaces, ink, severity, bands, scales; old names alias the new; 13px base".

---

### Task 2: Severity, status, checks and severity mix

**Files:**
- Modify: `extension/ui/render.js` (`sev`, at line 68)
- Modify: `extension/ui/charts.js` (`checklist`, at line 178)
- Modify: `extension/ui/theme.css` (`@layer components`)
- Test: `test/charts.test.mjs`

**Interfaces:**
- Consumes the Task 1 tokens.
- Produces:
  - `h.sev(level: 'high'|'medium'|'low'|'info', { pill = false } = {}) → html`. The output is `<span class="sev[ sev-pill]" data-sev="high"><span class="sev-ico" aria-hidden="true"></span>High</span>`. An unknown level becomes `info`. The word is the level, capitalised.
  - `h.status(state: 'good'|'fair'|'poor'|'none', text: string, note?: string) → html`. The output is `<span class="status" data-status="good">text<small>note</small></span>`. The glyph is drawn by CSS `::before`. The word is always `text`, and for `none` it gets a visually hidden "(unknown)" prefix.
  - `h.checks(items: {label, ok: true|false|null, note?}[]) → html`. The output is `<ul class="checks">`, with each `<li>` holding `h.status(ok ? 'good' : ok === false ? 'poor' : 'none', label, note)`. `h.checklist` becomes an alias of `checks`, and the charts.js export `checklist` stays, also as an alias.
  - `h.mix(counts: {high, medium, low, info}) → html`. The output is `<span class="mix" role="img" aria-label="6 high, 9 medium, 37 low, 35 info">`, with one `<span class="h|m|l|i" style="flex-grow:n">` per non-zero count. It returns `''` when every count is 0 or missing.

- [ ] **Step 1: Write the failing tests in `test/charts.test.mjs`**

  ```js
  test('sev: glyph span, data-sev, word; unknown → info; pill', () => {
    assert.match(String(h.sev('high')), /class="sev" data-sev="high"><span class="sev-ico" aria-hidden="true"><\/span>High</);
    assert.match(String(h.sev('bogus')), /data-sev="info".*Info/);
    assert.match(String(h.sev('low', { pill: true })), /class="sev sev-pill"/);
  });
  test('status escapes text and note; none carries hidden unknown', () => {
    const s = String(h.status('poor', '<b>', 'n<'));
    assert.match(s, /data-status="poor"/); assert.ok(s.includes('&lt;b&gt;') && s.includes('n&lt;'));
    assert.match(String(h.status('none', 'x')), /visually-hidden">\(unknown\)/);
  });
  test('checks maps ok to status; checklist is the same function', () => {
    const c = String(h.checks([{ label: 'HSTS', ok: true }, { label: 'CSP', ok: false }, { label: 'cdn', ok: null }]));
    assert.match(c, /<ul class="checks">/);
    assert.deepEqual([...c.matchAll(/data-status="(\w+)"/g)].map((m) => m[1]), ['good', 'poor', 'none']);
    assert.equal(h.checklist, h.checks);
  });
  test('mix: text equivalent, zero counts dropped, all-zero renders nothing', () => {
    const m = String(h.mix({ high: 6, medium: 0, low: 37, info: 35 }));
    assert.match(m, /aria-label="6 high, 37 low, 35 info"/);
    assert.ok(!m.includes('class="m"') && !m.includes('NaN'));
    assert.equal(String(h.mix({})), ''); assert.equal(String(h.mix({ high: 0 })), '');
  });
  ```

  Update the existing `checklist` tests at `charts.test.mjs:132` and `:160` so they assert on `data-status` instead of icons. Keep what they check: pass, fail, unknown, and escaped label and note.

- [ ] **Step 2: Run the tests and check that they fail**

  Run `node --test test/charts.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement the helpers and their CSS**

  CSS for `.sev`, `.sev-ico`, `.sev-pill`, `.status`, `.checks` and `.mix` comes from the proposed.css sections headed "severity", "status" and "horizontal bars" (the `.mix` rules), in `@layer components`. Add `.visually-hidden` if theme.css does not have it.

  Keep the old `.sev.sev-high`-style rules until phase 2. `findingsTable` in report.js still emits them.

  Where a plugin glance test asserts the old checklist icon markup, update its assertion to `data-status`. The glance tests are at `glance.test.mjs:54`, `:72` and `:127`, plus `carbon.test.mjs:79`.

- [ ] **Step 4: Run the tests and check that they pass**

  Run `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

  The message is "h.sev, h.status, h.checks (checklist alias), h.mix: glyph + word, text equivalents".

---

### Task 3: Panel, stats, disclosure, notice, score bar, and print

**Files:**
- Modify: `extension/ui/render.js` (`sub`, at line 56; add `more`, `notice` and `stats`)
- Modify: `extension/ui/charts.js` (`stat`, at line 129; add `scoreBar`)
- Modify: `extension/ui/theme.css`: components, the existing `.stat` rules at lines 278–284 and `section.sub` at line 221, plus an `@media print` block.
- Modify: `extension/ui/reading.js:774` (the beforeprint selector)
- Test: `test/charts.test.mjs`

**Interfaces:**
- Consumes the Task 1 tokens and `h.status` from Task 2.
- Produces:
  - **`h.sub(title, content, { sub, link, foot, flush } = {}) → html | ''`.**
    - It returns `''` when `content` is empty, as now.
    - The output is `<section class="panel sub"><div class="panel-head"><h4>title</h4><span class="panel-sub">sub</span><a class="panel-link" href=link.href>link.text</a></div><div class="panel-body[ flush]">content</div><div class="panel-foot">foot</div></section>`. The sub, link and foot parts appear only when given.
    - `link` is `{ href, text }`.
  - **`h.stat({ label, value, rating, note, meter }) → html`.**
    - The output is `<div class="stat"><span class="stat-label">…</span><span class="stat-value">…</span>[meter]<span class="stat-note">…</span></div>`.
    - The rating shows inside `.stat-note` as `h.status(band, word)`, mapping `good` → good "Good", `needs-improvement` → fair "Needs improvement" and `poor` → poor "Poor".
    - `note` follows the rating in the same `.stat-note`.
    - The class `card` is gone.
  - **`h.stats(stats: html[]) → html`.** The output is `<div class="stats">…</div>`, or `''` when the list is empty.
  - **`h.more(summary, body, meta?) → html | ''`.** The output is `<details class="disclosure"><summary>summary<span class="disclosure-meta">meta</span></summary><div class="disclosure-body">body</div></details>`. It returns `''` when `body` is empty.
  - **`h.notice(text, { state } = {}) → html`.** The output is `<p class="notice">`, starting with `h.status(state, '')` when `state` is given.
  - **`h.scoreBar({ value, status, label }) → html`.** The output is `<span class="score-bar" data-band="good|fair|poor|none" role="img" aria-label="label: 37 of 100"><span style="--v:37"></span></span>`.
    - Statuses map to bands as in ruling 3.
    - The value is clamped to 0–100.
    - A null value gives `data-band="none"` and an `aria-label` ending "not measured".

- [ ] **Step 1: Write the failing tests**

  ```js
  test('sub: two-arg calls unchanged in meaning; empty content → ""; options add head parts', () => {
    assert.equal(String(h.sub('T', '')), ''); assert.equal(String(h.sub('T', [])), '');
    const s = String(h.sub('Read<', h.html`<p>x</p>`, { sub: 'Flesch 38', link: { href: '#issues', text: '2 issues' }, foot: 'f' }));
    assert.match(s, /<section class="panel sub"><div class="panel-head"><h4>Read&lt;<\/h4><span class="panel-sub">Flesch 38<\/span><a class="panel-link" href="#issues">2 issues<\/a><\/div><div class="panel-body"><p>x<\/p><\/div><div class="panel-foot">f<\/div><\/section>/);
    assert.ok(!String(h.sub('T', 'x')).includes('panel-foot'));
  });
  test('stat: label/value/note shape with rating as status word', () => {
    const s = String(h.stat({ label: 'LCP', value: '2.6 s', rating: 'needs-improvement', note: 'p75<' }));
    assert.match(s, /<div class="stat"><span class="stat-label">LCP<\/span><span class="stat-value">2.6 s<\/span>/);
    assert.match(s, /data-status="fair">Needs improvement/); assert.ok(s.includes('p75&lt;'));
    assert.equal(String(h.stats([])), '');
  });
  test('more: details.disclosure, empty body → ""', () => {
    assert.match(String(h.more('Hosts', 'b', '41 hosts')), /<details class="disclosure"><summary>Hosts<span class="disclosure-meta">41 hosts<\/span><\/summary><div class="disclosure-body">b<\/div><\/details>/);
    assert.equal(String(h.more('x', '')), '');
  });
  test('scoreBar: band from status, clamped, null not measured', () => {
    assert.match(String(h.scoreBar({ value: 140, status: 'critical', label: 'A' })), /data-band="poor".*aria-label="A: 100 of 100".*--v:100/);
    assert.match(String(h.scoreBar({ value: null, label: 'A' })), /data-band="none".*not measured/);
  });
  ```

  Replace the old assertion `class="stat card"` and `delta rating-…` at `charts.test.mjs:105–106` with the new shape.

- [ ] **Step 2: Run the tests and check that they fail**

  Run `node --test test/charts.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement the helpers and CSS**

  CSS for `.panel*`, `.stats`, `.stat*`, `.disclosure*`, `.notice` and `.score-bar` comes from the proposed.css sections headed "panel", "stat row", "disclosure", "notice" and "score ring + meter"; the `.meter` rules there become `.score-bar`.

  Restyle `.chart.badges` to look like the design's `.chips`/`.chip` (section "chips"), changing CSS only; `h.badges` keeps its markup.

  - Replace the old `.stat .k/.v/.delta` rules. Glance tiles that relied on `.stat.card` for a box now get it from `.stats`. Where `glances()` in report.js puts loose stats in `div.tiles`, render `.tiles` as the `.stats` grid. That is a CSS-only change.
  - Nested panels draw flat (ruling 5): `:is(.plugin, .panel) .panel { border: 0; background: none; } :is(.plugin, .panel) .panel > :is(.panel-head, .panel-body) { padding-inline: 0; }`.
  - Add an `@media print` block:
    - `details.disclosure::details-content { content-visibility: visible; display: contents; }`;
    - hide the disclosure's summary marker;
    - `break-inside: avoid` on `.panel` and `.stat`.
  - In `reading.js:774`, add `details.disclosure:not([open])` to the beforeprint selector.

- [ ] **Step 4: Run the tests and check that they pass**

  Run `npm test`. Expected: all pass. The glance and plugin tests that assert `<h4>` still pass (ruling 5).

- [ ] **Step 5: Commit**

  The message is "Panel-shaped h.sub, h.stat/h.stats, h.more, h.notice, h.scoreBar; disclosures print open".

---

### Task 4: Look at it, then fix what the new look broke

**Files:**
- Modify: `scripts/screens.mjs`: add `--out <dir>`, defaulting to `screens`. Only a default run clears the folder.
- Modify: `extension/ui/theme.css`, for fixes found in this task only.

**Interfaces:** consumes everything above and produces nothing new.

- [ ] **Step 1: Add `--out` to `scripts/screens.mjs`**

  `OUT` is `resolve(process.cwd(), value)` when the flag is given, and the script creates that folder. The clean-up line (`readdir(OUT)` … `rm`) stays, but now runs on whichever `OUT` is in use. `OVERVIEW.md` is still kept.

- [ ] **Step 2: Capture after shots to a scratch folder**

  Run `node scripts/screens.mjs --out test/e2e/out/screens-phase1`; `test/e2e/out` is gitignored.

  Expected: the same file list as `screens/manifest.json`.

- [ ] **Step 3: Compare against `screens/` by eye, light and dark, at 1280 and 390**

  Look for these, and fix each in `theme.css`:
  - text or glyphs that vanished: transparent or undefined colours;
  - nested boxes doubling up;
  - stat tiles without a box;
  - severity, status or ring colours that disagree with their word;
  - horizontal scroll at 390px;
  - popup, library or options broken by the 13px base or the token aliases.

  Layout changes are out of scope. Write each fix into the commit message.

- [ ] **Step 4: Run the full test suites**

  Run `npm test`, then `npm run test:e2e` from the worktree directory. Don't run e2e at the same time as screens or calibration.

  Expected: all pass. The e2e suite includes the check that the export has no `<script>`.

- [ ] **Step 5: Commit**

  The message is "screens.mjs --out; phase 1 visual fixes".
