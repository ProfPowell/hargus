# Accessibility views: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every reading also captures 13 accessibility views:
- 6 colour-vision simulations;
- dark mode, forced colours, more contrast and print;
- the WCAG text-spacing, 320 px reflow and 200% text conditions.

A new `a11y-views` plugin turns the measurable views into findings, and the Screens pane shows them all.

**Architecture:**
- The views slot into the existing `captureViews()` loop in `extension/browser/capture.js`. Each one changes the live page through CDP or injected CSS, takes a viewport-only screenshot, optionally measures, then restores the page. None of them reloads.
- `measureView()` gains five fields, and a one-time `prefsProbe()` records the page's colour scheme, print styles and media features.
- The `a11y-views` analyze-phase plugin compares the measurements with the base view, the same way `resilience` does.
- `report.js` gets an "Accessibility views" section on the Screens pane.

**Tech Stack:** Vanilla ES modules, no dependencies. Chrome DevTools Protocol through `chrome.debugger`. `node --test` for unit tests and Playwright for e2e (`npm run test:e2e`).

**Spec:** `docs/superpowers/specs/2026-10-10-accessibility-views-design.md`

## Global Constraints

- **View ids**, in order:
  - vision: `protanopia`, `deuteranopia`, `tritanopia`, `achromatopsia`, `blurred`, `lowcontrast`;
  - display: `dark`, `forced`, `morecontrast`, `print`;
  - WCAG: `spacing`, `reflow`, `text200`.
- **Labels:** "Protanopia", "Deuteranopia", "Tritanopia", "Achromatopsia", "Blurred vision", "Reduced contrast", "Dark mode", "Forced colours", "More contrast", "Print", "Text spacing", "320 px reflow", "200% text".
- **Defaults:** all 13 new views are on by default (`capture.views.<id>: true`), plus `capture.views.vision: true`. When `vision` is false, the six vision views are skipped.
- **Screenshots:** the new views keep a **viewport screenshot only**, never a full-page one.
- **Order and timing:** the new views run after `pseudo` and before `nojs`. Each has `runMs` 20 000 and `restoreMs` 10 000. Each waits 300 ms (vision and display) or 600 ms (spacing, reflow, text200) before its screenshot.
- **Finding titles and severities:** exactly as in the spec's table, with category `accessibility` except the three print findings, which use `content`.
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Tests:** run `npm test` before every commit. Tasks 2 and 5 also run `npm run test:e2e`, never two runs at once.

## Review Focus

1. **Old readings** have none of the new fields (`bodyFont`, `bg`, `fixed` and so on) and no `prefs`. The plugin must skip or stay silent, with no NaN and no false findings. Task 3 tests this.
2. **A vision screenshot that looks unchanged.** If CDP's vision emulation doesn't reach `Page.captureScreenshot`, the six shots would silently equal the base shot. The e2e in Task 2 asserts that the achromatopsia data differs from the base viewport data.
3. **The restore after each view fails or times out.** Later views and the no-JavaScript reload must not inherit dark media, the 320 px metrics, the 32 px font or the spacing stylesheet. The e2e in Task 2 asserts that the tab ends at its original width and font size, with no `#harplus-spacing` element.
4. **A page whose base view already overflows or clips.** Findings must compare against the base view, so a page that is wide everywhere doesn't get "new" spacing or 200% findings. Task 3 tests this.
5. **The text200 view on a page with px-only fonts.** The body font doesn't change, which gives the low "ignores font-size" finding but no medium clip finding. Task 3 tests this.

---

### Task 1: View registry, settings and view toggles

**Files:**
- Modify: `extension/core/views.js`
- Modify: `extension/browser/settings.js` (`DEFAULTS.capture.views`)
- Modify: `extension/ui/options.html` (view chips)
- Modify: `extension/ui/popup.html` (view checkboxes)
- Modify: `extension/plugins/resilience.js` (keep its glance and table to the layout views)
- Test: `test/views.test.mjs`, `test/resilience.test.mjs`

**Interfaces:**
- Produces, consumed by Tasks 2–4. `views.js` exports:
  - `VISION_VIEWS`, `DISPLAY_VIEWS`, `WCAG_VIEWS`, `A11Y_VIEWS`, `LAYOUT_VIEWS` (the pre-existing 8);
  - `VIEWS` (all 21);
  - `VIEW_LABELS` (with the 13 new labels);
  - `VISION_DEFICIENCY: { [id]: cdpType }`;
  - `MEDIA_EMULATION: { [id]: setEmulatedMediaParams }`;
  - `SPACING_CSS` (string).

- [ ] **Step 1: Write the failing tests.**

  In `test/views.test.mjs`, change the import to:

  ```js
  import {
    VIEWS, VIEW_LABELS, LAYOUT_VIEWS, VISION_VIEWS, DISPLAY_VIEWS, WCAG_VIEWS, A11Y_VIEWS, VISION_DEFICIENCY, MEDIA_EMULATION, SPACING_CSS,
    baseView, shotView, shotsByView, ratio, compareViews, ratingFor,
  } from '../extension/core/views.js';
  ```

  Replace the first assertion of `view ids and labels` with:

  ```js
    assert.deepEqual(LAYOUT_VIEWS, ['desktop', 'tablet', 'mobile', 'nojs', 'nocss', 'noimages', 'rtl', 'pseudo']);
    assert.deepEqual(VIEWS, [...LAYOUT_VIEWS, 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred', 'lowcontrast',
      'dark', 'forced', 'morecontrast', 'print', 'spacing', 'reflow', 'text200']);
  ```

  Append:

  ```js
  test('accessibility view groups, labels and emulation parameters', () => {
    assert.deepEqual(VISION_VIEWS, ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred', 'lowcontrast']);
    assert.deepEqual(DISPLAY_VIEWS, ['dark', 'forced', 'morecontrast', 'print']);
    assert.deepEqual(WCAG_VIEWS, ['spacing', 'reflow', 'text200']);
    assert.deepEqual(A11Y_VIEWS, [...VISION_VIEWS, ...DISPLAY_VIEWS, ...WCAG_VIEWS]);
    assert.deepEqual(A11Y_VIEWS.map((v) => VIEW_LABELS[v]), ['Protanopia', 'Deuteranopia', 'Tritanopia', 'Achromatopsia', 'Blurred vision',
      'Reduced contrast', 'Dark mode', 'Forced colours', 'More contrast', 'Print', 'Text spacing', '320 px reflow', '200% text']);
    assert.deepEqual(VISION_DEFICIENCY, { protanopia: 'protanopia', deuteranopia: 'deuteranopia', tritanopia: 'tritanopia',
      achromatopsia: 'achromatopsia', blurred: 'blurredVision', lowcontrast: 'reducedContrast' });
    assert.deepEqual(MEDIA_EMULATION.dark, { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    assert.deepEqual(MEDIA_EMULATION.forced, { features: [{ name: 'forced-colors', value: 'active' }] });
    assert.deepEqual(MEDIA_EMULATION.morecontrast, { features: [{ name: 'prefers-contrast', value: 'more' }] });
    assert.deepEqual(MEDIA_EMULATION.print, { media: 'print' });
    assert.match(SPACING_CSS, /line-height: 1\.5 !important/);
    assert.match(SPACING_CSS, /letter-spacing: 0\.12em !important/);
    assert.match(SPACING_CSS, /word-spacing: 0\.16em !important/);
    assert.match(SPACING_CSS, /p \{ margin-bottom: 2em !important; \}/);
    assert.equal(shotView({ view: 'dark' }, 'desktop'), 'dark');
  });

  test('settings: every accessibility view and the vision group default on', () => {
    for (const id of [...A11Y_VIEWS, 'vision']) assert.equal(DEFAULTS.capture.views[id], true, id);
    assert.equal(merge(DEFAULTS, { capture: { views: { vision: false } } }).capture.views.dark, true);
  });
  ```

  Append to `test/resilience.test.mjs`:

  ```js
  test('accessibility views are not part of the resilience comparison', () => {
    const out = run({ desktop: base, nojs: { ...base, text: 900 }, dark: { ...base, text: 1000 }, reflow: { ...base } });
    const g = String(plugin.glance({ status: 'ok', ...out }, h));
    assert.doesNotMatch(g, /Dark mode|320 px reflow/);
    assert.doesNotMatch(String(plugin.render({ status: 'ok', ...out }, h)), /Dark mode/);
  });
  ```

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/views.test.mjs test/resilience.test.mjs`

  Expected: FAIL, because the exports `LAYOUT_VIEWS` and the others don't exist yet.

- [ ] **Step 3: Implement.**

  In `extension/core/views.js`, replace the `VIEWS` and `VIEW_LABELS` lines with:

  ```js
  export const VISION_VIEWS = ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred', 'lowcontrast'];
  export const DISPLAY_VIEWS = ['dark', 'forced', 'morecontrast', 'print'];
  export const WCAG_VIEWS = ['spacing', 'reflow', 'text200'];
  export const A11Y_VIEWS = [...VISION_VIEWS, ...DISPLAY_VIEWS, ...WCAG_VIEWS];
  export const LAYOUT_VIEWS = [...DEVICE_VIEWS, ...RESILIENCE_VIEWS, ...INTERNATIONAL_VIEWS];
  export const VIEWS = [...LAYOUT_VIEWS, ...A11Y_VIEWS];
  export const VIEW_LABELS = {
    desktop: 'Desktop', tablet: 'Tablet', mobile: 'Phone', nojs: 'No JavaScript', nocss: 'No CSS', noimages: 'No images',
    rtl: 'Right-to-left', pseudo: 'Long text',
    protanopia: 'Protanopia', deuteranopia: 'Deuteranopia', tritanopia: 'Tritanopia', achromatopsia: 'Achromatopsia',
    blurred: 'Blurred vision', lowcontrast: 'Reduced contrast',
    dark: 'Dark mode', forced: 'Forced colours', morecontrast: 'More contrast', print: 'Print',
    spacing: 'Text spacing', reflow: '320 px reflow', text200: '200% text',
  };
  /** Emulation.setEmulatedVisionDeficiency types per vision view. */
  export const VISION_DEFICIENCY = {
    protanopia: 'protanopia', deuteranopia: 'deuteranopia', tritanopia: 'tritanopia',
    achromatopsia: 'achromatopsia', blurred: 'blurredVision', lowcontrast: 'reducedContrast',
  };
  /** Emulation.setEmulatedMedia parameters per display view. */
  export const MEDIA_EMULATION = {
    dark: { features: [{ name: 'prefers-color-scheme', value: 'dark' }] },
    forced: { features: [{ name: 'forced-colors', value: 'active' }] },
    morecontrast: { features: [{ name: 'prefers-contrast', value: 'more' }] },
    print: { media: 'print' },
  };
  /** WCAG 1.4.12 text-spacing overrides. */
  export const SPACING_CSS = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }\np { margin-bottom: 2em !important; }';
  ```

  In `extension/browser/settings.js`, change the `views` line to:

  ```js
      views: {
        desktop: true, tablet: true, mobile: true, nojs: true, nocss: true, noimages: true, rtl: true, pseudo: true,
        vision: true, protanopia: true, deuteranopia: true, tritanopia: true, achromatopsia: true, blurred: true, lowcontrast: true,
        dark: true, forced: true, morecontrast: true, print: true, spacing: true, reflow: true, text200: true,
      },
  ```

  In `extension/ui/options.html`, after the `capture.views.pseudo` chip, add:

  ```html
          <label class="chip"><input type="checkbox" data-path="capture.views.vision"> Vision simulations</label>
          <label class="chip"><input type="checkbox" data-path="capture.views.dark"> Dark mode</label>
          <label class="chip"><input type="checkbox" data-path="capture.views.forced"> Forced colours</label>
          <label class="chip"><input type="checkbox" data-path="capture.views.morecontrast"> More contrast</label>
          <label class="chip"><input type="checkbox" data-path="capture.views.print"> Print</label>
          <label class="chip"><input type="checkbox" data-path="capture.views.spacing"> Text spacing</label>
          <label class="chip"><input type="checkbox" data-path="capture.views.reflow"> 320 px reflow</label>
          <label class="chip"><input type="checkbox" data-path="capture.views.text200"> 200% text</label>
  ```

  In `extension/ui/popup.html`, after the `views.pseudo` label, add the same eight, popup style:

  ```html
            <label><input type="checkbox" name="views.vision"> Vision simulations</label>
            <label><input type="checkbox" name="views.dark"> Dark mode</label>
            <label><input type="checkbox" name="views.forced"> Forced colours</label>
            <label><input type="checkbox" name="views.morecontrast"> More contrast</label>
            <label><input type="checkbox" name="views.print"> Print</label>
            <label><input type="checkbox" name="views.spacing"> Text spacing</label>
            <label><input type="checkbox" name="views.reflow"> 320 px reflow</label>
            <label><input type="checkbox" name="views.text200"> 200% text</label>
  ```

  The popup and options pages already bind these generically: the popup calls `setIn(s.capture, el.name, …)`, and options binds every `[data-path]`. Check that the popup's initial `checked` binding reads `getIn(settings.capture, name)` for every `views.*` input. If it only handles a fixed list, extend it.

  In `extension/plugins/resilience.js`, change the import to include `LAYOUT_VIEWS`, and change `present` to:

  ```js
  const present = (r) => LAYOUT_VIEWS.filter((id) => r.data?.views?.[id]);
  ```

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/core/views.js extension/browser/settings.js extension/ui/options.html extension/ui/popup.html extension/plugins/resilience.js test/views.test.mjs test/resilience.test.mjs
  git commit -m "Accessibility views: registry, defaults and toggles

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 2: Capture the 13 views (measurements, prefs probe, viewport-only shots)

**Files:**
- Modify: `extension/browser/capture.js`. The changes are in `measureView`, a new `prefsProbe`, a new `textSpacing`, `shoot`, and `captureViews`.
- Modify: `test/e2e/site/index.html`
- Modify: `test/e2e/run.mjs`

**Interfaces:**
- Consumes from Task 1: `VISION_VIEWS`, `DISPLAY_VIEWS`, `VISION_DEFICIENCY`, `MEDIA_EMULATION`, `SPACING_CSS`, `VIEW_LABELS`.
- Produces, consumed by Tasks 3–5:
  - `hp.capture.views[id]` for the 7 measured views. Each holds `measureView()`'s existing fields plus `bodyFont` (number, px), `bg` (luminance, 0–1), `fixed` (an array of `{ tag, w, h }`), `chrome` (boolean), `forcedNone` (number) and `iconOnly` (number).
  - The base view's measurement gains the same fields.
  - `hp.capture.prefs = { colorScheme: string, mediaPrint: boolean, mediaFeatures: { [feature]: count } }`.
  - `hp.screenshots` gains one `{ kind: 'viewport', view: <id> }` per new view, with no `fullpage`.

This task's code runs in the page or through CDP, so the e2e is its test. Only `capture.js` and the e2e change.

- [ ] **Step 1: Extend the e2e site and assertions first** (they fail before the implementation).

  In `test/e2e/site/index.html`, add this inside `<head>` after the existing stylesheet links:

  ```html
    <style>
      .promo { min-width: 300px; } /* + body margin 2×2rem: 364 px — fits the 390 px phone, overflows 320 px */
      .cookie-banner { position: fixed; left: 0; right: 0; bottom: 0; height: 120px; background: #222; color: #fff; }
      @media print { header { display: none; } }
    </style>
  ```

  Add `<div class="cookie-banner">We use cookies to keep the test site honest.</div>` just before `</body>`.

  In `test/e2e/run.mjs`, change the `shotViews(r1)` assertion to include the new views, sorted:

  ```js
      assert.deepEqual(shotViews(r1), ['achromatopsia', 'blurred', 'dark', 'desktop', 'deuteranopia', 'forced', 'lowcontrast', 'mobile', 'morecontrast',
        'nocss', 'noimages', 'nojs', 'print', 'protanopia', 'pseudo', 'reflow', 'rtl', 'spacing', 'tablet', 'text200', 'tritanopia']);
  ```

  If the existing `shotViews` helper doesn't sort, sort both sides.

  After the existing `mv` assertions, add:

  ```js
      const A11Y = ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred', 'lowcontrast', 'dark', 'forced', 'morecontrast', 'print', 'spacing', 'reflow', 'text200'];
      for (const id of A11Y) {
        const kinds = hp.screenshots.filter((s) => s.view === id).map((s) => s.kind);
        assert.deepEqual(kinds, ['viewport'], `${id}: viewport only, got ${kinds}`);
      }
      for (const id of ['dark', 'forced', 'morecontrast', 'print', 'spacing', 'reflow', 'text200']) assert.ok(mv[id], `${id} measured`);
      for (const id of ['protanopia', 'achromatopsia']) assert.equal(mv[id], undefined, `${id} not measured`);
      const baseShot = hp.screenshots.find((s) => s.view === 'desktop' && s.kind === 'viewport').data;
      assert.notEqual(hp.screenshots.find((s) => s.view === 'achromatopsia').data, baseShot, 'vision emulation reaches the screenshot');
      assert.ok(mv.reflow.overflowX > 0, `promo overflows at 320 px (overflowX ${mv.reflow.overflowX})`);
      // The test site sets body { font: 16px … } in px, so doubling the default font size does not grow it —
      // exactly the case the plugin flags. The root font does grow (rem-based margins), proving the emulation ran.
      assert.equal(mv.text200.bodyFont, mv.desktop.bodyFont, 'px-sized body text does not follow the browser font size');
      assert.ok(mv.print.fixed.length >= 1, 'cookie banner is a fixed overlay in print');
      assert.equal(mv.print.chrome, false, 'header hidden in print; the page has no nav or footer');
      assert.ok(typeof mv.dark.bg === 'number' && typeof mv.desktop.bg === 'number');
      assert.equal(hp.capture.prefs?.mediaPrint, true, 'print media rule detected');
      assert.ok(hp.capture.viewsMs < 120_000, `views took ${hp.capture.viewsMs} ms`);
      // Restores: the tab is back to normal after the accessibility views.
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).fontSize), '16px');
      assert.equal(await page.evaluate(() => !!document.getElementById('harplus-spacing')), false);
      assert.equal(await page.evaluate(() => matchMedia('print').matches || matchMedia('(prefers-color-scheme: dark)').matches), false);
  ```

  These run before the existing `assert.equal(await page.evaluate(() => innerWidth), widthBefore)`, which stays.

  The test site's `app.css` sets `body { font: 16px/1.5 … }`, so the restored body font is `16px`.

- [ ] **Step 2: Run the e2e to watch it fail**

  Run: `npm run test:e2e`

  Expected: FAIL on the `shotViews` list, because the new views aren't captured yet.

- [ ] **Step 3: Implement in `extension/browser/capture.js`.**

  Import `VISION_VIEWS`, `DISPLAY_VIEWS`, `VISION_DEFICIENCY`, `MEDIA_EMULATION` and `SPACING_CSS` from `../core/views.js`. Extend the existing import line.

  **3a. `measureView()`.**
  - Replace the clipped loop with one that also collects fixed overlays and `forced-color-adjust`.
  - Add the new fields to the returned object. Everything inside `measureView` must stay self-contained (no outer references).

  ```js
    let clipped = 0;
    let walked = 0;
    let forcedNone = 0;
    const fixed = [];
    const vpArea = innerWidth * innerHeight;
    for (const el of root.querySelectorAll('*')) {
      if (++walked > 3000 || performance.now() - t0 > 1500) { truncated = true; break; }
      const cs = getComputedStyle(el);
      if (cs.forcedColorAdjust === 'none') forcedNone++;
      if ((cs.position === 'fixed' || cs.position === 'sticky') && fixed.length < 20 && cs.visibility !== 'hidden') {
        const r = el.getBoundingClientRect();
        if (r.width * r.height >= 0.1 * vpArea) fixed.push({ tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) });
      }
      if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
      const x = el.scrollWidth > el.clientWidth + 1 && (/hidden|clip/.test(cs.overflowX) || cs.textOverflow === 'ellipsis');
      const y = el.scrollHeight > el.clientHeight + 1 && /hidden|clip/.test(cs.overflowY);
      if (x || y) clipped++;
    }
    const lum = (c) => {
      const m = String(c).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      if (!a) return null;
      const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return Math.round((0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)) * 1000) / 1000;
    };
    let bg = null;
    for (let el = document.body; el && bg == null; el = el.parentElement) bg = lum(getComputedStyle(el).backgroundColor);
    const chromeEl = [...document.querySelectorAll('nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]')].some(shown);
    const iconOnly = [...document.querySelectorAll('a, button')].filter((el) => shown(el) && !el.textContent.trim()
      && !el.getAttribute('aria-label') && !el.querySelector('img, svg') && getComputedStyle(el).backgroundImage !== 'none').length;
  ```

  Add these to the returned object:

  ```js
      bodyFont: parseFloat(getComputedStyle(document.body || document.documentElement).fontSize) || 0,
      bg: bg ?? 1,
      fixed,
      chrome: chromeEl,
      forcedNone,
      iconOnly,
  ```

  (`clipped`, `walked` and `truncated` keep their existing meaning.)

  **3b. New page functions.** Put them next to `pseudoText`.

  ```js
  /** The page's own colour-scheme and print/media-feature styles (readable stylesheets only). */
  function prefsProbe() {
    const meta = document.querySelector('meta[name="color-scheme" i]')?.getAttribute('content') || '';
    const colorScheme = `${meta} ${getComputedStyle(document.documentElement).colorScheme || ''}`.trim();
    const mediaFeatures = {};
    let mediaPrint = !!document.querySelector('link[media*="print" i], style[media*="print" i]');
    const walk = (rules, depth) => {
      for (const r of rules || []) {
        const text = r.conditionText || r.media?.mediaText || '';
        if (text) {
          if (/\bprint\b/i.test(text)) mediaPrint = true;
          for (const m of text.matchAll(/\(\s*(?:not\s+)?([a-z-]+)\s*[:)]/gi)) {
            const k = m[1].toLowerCase();
            mediaFeatures[k] = (mediaFeatures[k] || 0) + 1;
          }
        }
        if (r.cssRules && depth < 4) walk(r.cssRules, depth + 1);
      }
    };
    for (const s of document.styleSheets) { try { walk(s.cssRules, 0); } catch { /* cross-origin sheet */ } }
    return { colorScheme, mediaPrint, mediaFeatures };
  }

  /** Inject (on=true) or remove (on=false) the WCAG 1.4.12 text-spacing stylesheet. */
  function textSpacing(css) {
    const old = document.getElementById('harplus-spacing');
    if (css == null) { old?.remove(); return; }
    const s = old || document.createElement('style');
    s.id = 'harplus-spacing';
    s.textContent = css;
    (document.head || document.documentElement).append(s);
  }
  ```

  `textSpacing` takes the CSS text as its argument, because page functions can't reference module constants. Call it as `this.evaluate(textSpacing, SPACING_CSS, 'main')`, and with `null` to remove.

  **3c. `shoot()`.**
  - Change the signature to `async shoot(view, { thumb = false, fullPage = true } = {})`.
  - Change `if (this.opts.fullPage) {` to `if (this.opts.fullPage && fullPage) {`.

  **3d. `captureViews()`.**
  - Change the `view()` helper's skip check to:

    ```js
        if (want[id] === false || (VISION_VIEWS.includes(id) && want.vision === false)) { skipped.push({ view: id, reason: 'disabled' }); return; }
    ```

  - Change its commit line to `if (got.measured) views[id] = got.measured;`.
  - Add two grab variants next to `grab`:

    ```js
        const grabFold = async (id, measured) => ({ id, shots: await this.shoot(id, { fullPage: false }), measured: measured ? await measure() : null });
    ```

  - Immediately after the `pseudo` view and before the `nojs` block, add:

    ```js
        const a11yWanted = [...VISION_VIEWS, ...DISPLAY_VIEWS, 'spacing', 'reflow', 'text200'].some((id) => want[id] !== false);
        if (a11yWanted) {
          hp.capture.prefs = await withTimeout(this.evaluate(prefsProbe, null, 'main'), 5000, 'prefs probe')
            .catch((e) => { this.warnings.push(`preferences probe failed: ${e.message}`); return undefined; });
        }
        for (const id of VISION_VIEWS) {
          await view(id, {
            runMs: 20_000,
            restoreMs: 10_000,
            run: async () => {
              await this.send('Emulation.setEmulatedVisionDeficiency', { type: VISION_DEFICIENCY[id] });
              await sleep(300);
              return grabFold(id, false);
            },
            restore: () => this.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' }),
          });
        }
        for (const id of DISPLAY_VIEWS) {
          await view(id, {
            runMs: 20_000,
            restoreMs: 10_000,
            run: async () => {
              await this.send('Emulation.setEmulatedMedia', MEDIA_EMULATION[id]);
              await sleep(300);
              return grabFold(id, true);
            },
            restore: () => this.send('Emulation.setEmulatedMedia', { media: '', features: [] }),
          });
        }
        await view('spacing', {
          runMs: 20_000,
          restoreMs: 10_000,
          run: async () => {
            await this.evaluate(textSpacing, SPACING_CSS, 'main');
            await sleep(600);
            return grabFold('spacing', true);
          },
          restore: () => this.evaluate(textSpacing, null, 'main'),
        });
        await view('reflow', {
          runMs: 20_000,
          restoreMs: 10_000,
          run: async () => {
            await this.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
            await sleep(600);
            return grabFold('reflow', true);
          },
          restore: () => this.applyDevice(base),
        });
        await view('text200', {
          runMs: 20_000,
          restoreMs: 10_000,
          run: async () => {
            await this.send('Page.setFontSizes', { fontSizes: { standard: 32, fixed: 26 } });
            await sleep(600);
            return grabFold('text200', true);
          },
          restore: () => this.send('Page.setFontSizes', { fontSizes: { standard: 16, fixed: 13 } }),
        });
    ```

  - If `Page.setFontSizes` isn't available in this Chrome, CDP rejects the call, and the view is skipped with a warning by the existing machinery. That's acceptable. Report it as a concern if the e2e shows it.

- [ ] **Step 4: Run the e2e to watch it pass**

  Run: `npm run test:e2e`

  Expected: `all e2e checks passed`.

  If the vision assertion fails because the achromatopsia data equals the base shot, CDP's vision emulation doesn't reach `captureScreenshot`. In that case, report NEEDS_CONTEXT with the evidence; don't paper over it. Then run `npm test`; expect PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/browser/capture.js test/e2e/site/index.html test/e2e/run.mjs
  git commit -m "Capture: 13 accessibility views with viewport shots, extra measurements and a preferences probe

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 3: The `a11y-views` plugin

**Files:**
- Create: `extension/plugins/a11y-views.js`
- Modify: `extension/plugins/index.js` (import it; place it right after `resilience` in `BUILTIN`)
- Test: `test/a11y-views.test.mjs` (new)

**Interfaces:**
- Consumes:
  - `hp.capture.views` (Task 2 fields) and `hp.capture.prefs`;
  - `ctx.results.css.data.mediaFeatures` (`{ [feature]: count }`) and `.media` (`{ [conditionText]: count }`);
  - `baseView`, `VIEW_LABELS`, `DISPLAY_VIEWS` and `WCAG_VIEWS` from `views.js`.
- Produces: the plugin result `{ data: { base, views: { [id]: measurement }, prefs, printStyles }, findings, summary }`. Task 4's report section reads only `hp.capture.views`, not this result.

- [ ] **Step 1: Write the failing tests** in `test/a11y-views.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import plugin from '../extension/plugins/a11y-views.js';
  import { getPlugins } from '../extension/plugins/index.js';
  import { h } from '../extension/ui/render.js';

  const B = { text: 1000, links: 20, clipped: 2, overflowX: 0, bodyFont: 16, bg: 1, fixed: [], chrome: true, forcedNone: 0, iconOnly: 0 };
  const reading = (views, prefs) => ({ log: { entries: [], _harplus: { capture: { device: 'desktop', views, prefs } } } });
  const ctx = (css) => ({ results: css ? { css: { status: 'ok', data: css } } : {}, skip: (m) => { const e = new Error(m); e.name = 'SkipError'; throw e; } });
  const run = (views, { prefs, css } = {}) => plugin.run(reading({ desktop: B, ...views }, prefs), ctx(css));
  const t = (out) => out.findings.map((f) => `${f.severity}:${f.title}`);

  test('registered after resilience; Accessibility area, analyze phase', () => {
    const ids = getPlugins().map((p) => p.id);
    assert.equal(ids.indexOf('a11y-views'), ids.indexOf('resilience') + 1);
    assert.equal(plugin.area, 'accessibility');
    assert.equal(plugin.phase, 'analyze');
  });

  test('skips without accessibility views (old readings)', () => {
    assert.throws(() => plugin.run(reading({ desktop: B }), ctx()), /no accessibility views/);
    assert.throws(() => plugin.run(reading(undefined), ctx()), /no accessibility views/);
  });

  test('reflow: overflow and extra clipping are medium; base clipping is not counted', () => {
    assert.deepEqual(t(run({ reflow: { ...B, overflowX: 40 } })), ['medium:Page scrolls horizontally at 320 px (WCAG 1.4.10)']);
    assert.deepEqual(t(run({ reflow: { ...B, clipped: 5 } })), ['medium:3 more text boxes clip at 320 px (WCAG 1.4.10)']);
    assert.deepEqual(t(run({ reflow: { ...B, clipped: 4 } })), []);
  });

  test('spacing: clips or new overflow → medium; same overflow as base → nothing', () => {
    assert.deepEqual(t(run({ spacing: { ...B, clipped: 5 } })), ['medium:Text clips with WCAG text spacing (1.4.12)']);
    assert.deepEqual(t(run({ spacing: { ...B, overflowX: 10 } })), ['medium:Text clips with WCAG text spacing (1.4.12)']);
    const wide = { ...B, overflowX: 200 };
    assert.deepEqual(t(plugin.run(reading({ desktop: wide, spacing: { ...wide } }), ctx())), []);
  });

  test('200% text: ignores font size → low; grows and clips → medium; grows cleanly → nothing', () => {
    assert.deepEqual(t(run({ text200: { ...B, bodyFont: 16, clipped: 9 } })), ['low:Text ignores the browser\'s font-size setting']);
    assert.deepEqual(t(run({ text200: { ...B, bodyFont: 32, clipped: 5 } })), ['medium:Text clips at 200% size (WCAG 1.4.4)']);
    assert.deepEqual(t(run({ text200: { ...B, bodyFont: 32 } })), []);
    assert.deepEqual(t(plugin.run(reading({ desktop: { ...B, bodyFont: undefined }, text200: { ...B, bodyFont: undefined } }), ctx())), [], 'old measurement: no false finding');
  });

  test('dark mode: no change and no dark styles → info; declared dark but light → low; dark styles in css → no info', () => {
    assert.deepEqual(t(run({ dark: { ...B, bg: 0.98 } })), ['info:No dark mode']);
    assert.deepEqual(t(run({ dark: { ...B, bg: 0.98 } }, { prefs: { colorScheme: 'light dark', mediaFeatures: {} } })), ['info:No dark mode', 'low:Declares dark color-scheme but stays light']);
    assert.deepEqual(t(run({ dark: { ...B, bg: 0.98 } }, { css: { mediaFeatures: { 'prefers-color-scheme': 2 }, media: {} } })), []);
    assert.deepEqual(t(run({ dark: { ...B, bg: 0.05 } })), []);
  });

  test('forced colours: opt-outs ≥ 20 and icon-only controls → low', () => {
    assert.deepEqual(t(run({ forced: { ...B, forcedNone: 20, iconOnly: 2 } })), ['low:20 elements opt out of forced colours', 'low:2 icon-only controls may vanish in forced colours']);
    assert.deepEqual(t(run({ forced: { ...B, forcedNone: 19 } })), []);
  });

  test('more contrast: info without prefers-contrast styles', () => {
    assert.deepEqual(t(run({ morecontrast: { ...B } })), ['info:No high-contrast styles']);
    assert.deepEqual(t(run({ morecontrast: { ...B } }, { prefs: { mediaFeatures: { 'prefers-contrast': 1 } } })), []);
  });

  test('print: chrome, overlays, no print styles — category content', () => {
    const out = run({ print: { ...B, chrome: true, fixed: [{ tag: 'div', w: 1280, h: 120 }] } });
    assert.deepEqual(t(out), ['low:Navigation and site chrome still print', 'low:1 fixed or sticky overlays print over content', 'info:No print styles']);
    assert.ok(out.findings.every((f) => f.category === 'content'));
    assert.deepEqual(t(run({ print: { ...B, chrome: false } }, { css: { mediaFeatures: {}, media: { print: 1 } } })), []);
    assert.deepEqual(t(run({ print: { ...B, chrome: false } }, { prefs: { mediaPrint: true } })), []);
  });

  test('summary rows, glance and render without NaN', () => {
    const out = run({ reflow: { ...B, overflowX: 40 }, spacing: { ...B }, text200: { ...B, bodyFont: 32 }, dark: { ...B, bg: 0.05 }, print: { ...B, chrome: false } }, { prefs: { mediaPrint: true } });
    const labels = out.summary.map((s) => s.label);
    for (const l of ['Reflow 320 px', 'Text spacing', '200% text', 'Dark mode', 'Print']) assert.ok(labels.includes(l), l);
    assert.equal(out.summary.find((s) => s.label === '200% text').value, '16 → 32 px');
    const html = String(plugin.glance({ status: 'ok', ...out }, h)) + String(plugin.render({ status: 'ok', ...out }, h));
    assert.doesNotMatch(html, /NaN|undefined/);
    assert.match(html, /320 px reflow/);
  });
  ```

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/a11y-views.test.mjs`

  Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `extension/plugins/a11y-views.js`:**

  ```js
  // Accessibility views: findings from the display-preference, print and WCAG views measured during
  // capture (capture.views), compared against the base view. Offline — works in the CLI on any reading
  // that has them.

  import { baseView, VIEW_LABELS, DISPLAY_VIEWS, WCAG_VIEWS } from '../core/views.js';

  const MEASURED = [...DISPLAY_VIEWS, ...WCAG_VIEWS];
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const has = (v) => Number.isFinite(Number(v)) && v !== null && v !== undefined;

  function run(reading, ctx) {
    const cap = reading.log._harplus?.capture || {};
    const views = cap.views || {};
    const baseId = baseView(reading);
    const base = views[baseId];
    const present = MEASURED.filter((id) => views[id]);
    if (!base || !present.length) ctx.skip('no accessibility views in this reading — take a new reading');
    const prefs = cap.prefs || {};
    const css = ctx.results?.css?.status === 'ok' ? ctx.results.css.data || {} : {};
    const feature = (name) => !!(prefs.mediaFeatures?.[name] || css.mediaFeatures?.[name]);
    const printStyles = !!prefs.mediaPrint || Object.keys(css.media || {}).some((k) => /\bprint\b/i.test(k));
    const findings = [];
    const summary = [];
    const checks = [];
    const add = (severity, title, detail, category = 'accessibility') => findings.push({ severity, category, title, ...(detail ? { detail } : {}) });
    const extraClipped = (v) => num(v.clipped) - num(base.clipped);
    const newOverflow = (v) => num(v.overflowX) > num(base.overflowX);

    const reflow = views.reflow;
    if (reflow) {
      const over = num(reflow.overflowX);
      const extra = extraClipped(reflow);
      if (over > 0) add('medium', 'Page scrolls horizontally at 320 px (WCAG 1.4.10)', `Content is ${over} px wider than a 320 px viewport.`);
      if (extra >= 3) add('medium', `${extra} more text boxes clip at 320 px (WCAG 1.4.10)`);
      const ok = over === 0 && extra < 3;
      summary.push({ label: 'Reflow 320 px', value: ok ? 'fits' : [over ? `${over} px overflow` : '', extra >= 3 ? `${extra} more clipped` : ''].filter(Boolean).join(' · '), rating: ok ? 'good' : 'poor' });
      checks.push({ id: 'reflow', ok });
    }

    const spacing = views.spacing;
    if (spacing) {
      const extra = extraClipped(spacing);
      const bad = extra >= 3 || newOverflow(spacing);
      if (bad) add('medium', 'Text clips with WCAG text spacing (1.4.12)', `${Math.max(0, extra)} more clipped text boxes; ${num(spacing.overflowX)} px horizontal overflow.`);
      summary.push({ label: 'Text spacing', value: bad ? `${Math.max(0, extra)} more clipped` : 'ok', rating: bad ? 'poor' : 'good' });
      checks.push({ id: 'spacing', ok: !bad });
    }

    const big = views.text200;
    if (big && has(big.bodyFont) && has(base.bodyFont) && num(base.bodyFont) > 0) {
      const grew = num(big.bodyFont) > num(base.bodyFont);
      const clips = extraClipped(big) >= 3 || newOverflow(big);
      if (!grew) add('low', 'Text ignores the browser\'s font-size setting', `Body text stays ${num(big.bodyFont)} px when the default font size doubles.`);
      else if (clips) add('medium', 'Text clips at 200% size (WCAG 1.4.4)', `${Math.max(0, extraClipped(big))} more clipped text boxes; ${num(big.overflowX)} px horizontal overflow.`);
      summary.push({ label: '200% text', value: `${num(base.bodyFont)} → ${num(big.bodyFont)} px`, rating: !grew ? 'needs-improvement' : clips ? 'poor' : 'good' });
      checks.push({ id: 'text200', ok: grew && !clips });
    }

    const dark = views.dark;
    if (dark && has(dark.bg) && has(base.bg)) {
      const same = Math.abs(num(dark.bg) - num(base.bg)) < 0.1;
      if (same && !feature('prefers-color-scheme')) add('info', 'No dark mode');
      if (same && /\bdark\b/i.test(prefs.colorScheme || '')) add('low', 'Declares dark color-scheme but stays light');
      summary.push({ label: 'Dark mode', value: same ? 'no change' : 'changes' });
      checks.push({ id: 'dark', ok: !same });
    }

    const forced = views.forced;
    if (forced) {
      const optOut = num(forced.forcedNone);
      const icons = num(forced.iconOnly);
      if (optOut >= 20) add('low', `${optOut} elements opt out of forced colours`);
      if (icons >= 1) {
        add('low', `${icons} icon-only controls may vanish in forced colours`,
          'Forced colours replace the page\'s colours but not image content, so a background-image icon can disappear against the system background. Use an SVG with currentColor, or visible text.');
      }
      checks.push({ id: 'forced', ok: optOut < 20 && icons === 0 });
    }

    if (views.morecontrast) {
      const styled = feature('prefers-contrast');
      if (!styled) add('info', 'No high-contrast styles');
      checks.push({ id: 'morecontrast', ok: styled });
    }

    const print = views.print;
    if (print) {
      const issues = [];
      if (print.chrome) { add('low', 'Navigation and site chrome still print', undefined, 'content'); issues.push('site chrome'); }
      const overlays = Array.isArray(print.fixed) ? print.fixed.length : 0;
      if (overlays >= 1) { add('low', `${overlays} fixed or sticky overlays print over content`, undefined, 'content'); issues.push(`${overlays} overlays`); }
      if (!printStyles) { add('info', 'No print styles', undefined, 'content'); issues.push('no print styles'); }
      summary.push({ label: 'Print', value: issues.length ? issues.join(', ') : 'clean', rating: issues.length ? 'needs-improvement' : 'good' });
      checks.push({ id: 'print', ok: !issues.length });
    }

    return {
      data: { base: baseId, views: Object.fromEntries([[baseId, base], ...present.map((id) => [id, views[id]])]), prefs, printStyles, checks },
      findings,
      summary,
    };
  }

  function glance(r, h) {
    return h.html`<section class="card"><h4>Accessibility views</h4>${h.checklist((r.data.checks || []).map((c) => ({ label: VIEW_LABELS[c.id], ok: c.ok })))}</section>`;
  }

  function render(r, h) {
    const rows = Object.entries(r.data.views).map(([id, v]) => ({
      view: VIEW_LABELS[id] || id,
      overflow: `${num(v.overflowX)} px`,
      clipped: String(num(v.clipped)),
      font: has(v.bodyFont) ? `${num(v.bodyFont)} px` : '—',
      bg: has(v.bg) ? num(v.bg).toFixed(2) : '—',
      fixed: String(Array.isArray(v.fixed) ? v.fixed.length : 0),
      chrome: v.chrome ? 'yes' : 'no',
    }));
    return h.table(rows, [
      { key: 'view', label: 'View' }, { key: 'overflow', label: 'Overflow' }, { key: 'clipped', label: 'Clipped' },
      { key: 'font', label: 'Body font' }, { key: 'bg', label: 'Background luminance' }, { key: 'fixed', label: 'Fixed overlays' },
      { key: 'chrome', label: 'Site chrome' },
    ]);
  }

  export default {
    id: 'a11y-views',
    name: 'Accessibility views',
    version: '0.1.0',
    phase: 'analyze',
    group: 'quality',
    area: 'accessibility',
    after: ['css'],
    description: 'Reflow, text spacing, 200% text, dark mode, forced colours, contrast preference and print, from the views measured during capture.',
    tags: ['accessibility'],
    run,
    glance,
    render,
  };
  ```

  - `h.checklist` takes `[{ label, ok, note? }]`. Check the signature in `extension/ui/charts.js` and match it.
  - The `css` plugin runs in the page phase, so `after: ['css']` only orders plugins within a phase and is harmless here. Keep it for clarity.

  In `extension/plugins/index.js`:
  - add `import a11yViews from './a11y-views.js';`;
  - change the second `BUILTIN` row to `tech, javascript, baseline, resilience, a11yViews, international, network, security,`.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `node --test test/a11y-views.test.mjs`, then `npm test`.

  Expected: PASS. If an existing test asserts the exact `BUILTIN` order or count, update it, and note why.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/plugins/a11y-views.js extension/plugins/index.js test/a11y-views.test.mjs
  git commit -m "Accessibility views plugin: reflow, text spacing, 200% text, dark, forced colours, contrast and print findings

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 4: Report: "Accessibility views" on the Screens pane

**Files:**
- Modify: `extension/ui/report.js` (`screensPane`, plus a new helper)
- Modify: `extension/ui/theme.css` (vision grid)
- Test: `test/report.test.mjs`

**Interfaces:**
- Consumes:
  - `VISION_VIEWS`, `DISPLAY_VIEWS`, `WCAG_VIEWS` and `VIEW_LABELS` from `views.js`;
  - `shotsByView(reading)`;
  - `hp.capture.views` (Task 2 fields).

- [ ] **Step 1: Write the failing tests.** Append to `test/report.test.mjs`. It already has `withViews()`, `PNG`, `screens()` and `renderReport`.

  ```js
  const withA11yViews = () => {
    const r = withViews();
    const hp = r.log._harplus;
    const shot = (view) => ({ kind: 'viewport', view, mimeType: 'image/png', encoding: 'base64', data: PNG, cssWidth: view === 'reflow' ? 320 : 1280, cssHeight: 800, dpr: 1 });
    for (const v of ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred', 'lowcontrast', 'dark', 'forced', 'morecontrast', 'print', 'spacing', 'reflow', 'text200']) hp.screenshots.push(shot(v));
    const m = { text: 1000, links: 20, clipped: 2, overflowX: 0, bodyFont: 16, bg: 1, fixed: [], chrome: true, forcedNone: 0, iconOnly: 0 };
    Object.assign(hp.capture.views, {
      dark: { ...m, bg: 0.04 }, forced: { ...m }, morecontrast: { ...m }, print: { ...m, chrome: false, fixed: [{ tag: 'div', w: 1280, h: 120 }] },
      spacing: { ...m, clipped: 6 }, reflow: { ...m, overflowX: 40 }, text200: { ...m, bodyFont: 32 },
    });
    hp.capture.views.desktop = { ...hp.capture.views.desktop, ...m };
    return r;
  };

  test('screens pane: accessibility views section with vision grid and measured rows', () => {
    const s = screens(renderReport(withA11yViews(), getPlugins()));
    assert.match(s, /<h2>Accessibility views<\/h2>/);
    assert.match(s, /<h3>Vision<\/h3>/);
    for (const label of ['Protanopia', 'Deuteranopia', 'Tritanopia', 'Achromatopsia', 'Blurred vision', 'Reduced contrast']) assert.match(s, new RegExp(`<b>${label}</b>`));
    assert.match(s, /<h3>Display and WCAG<\/h3>/);
    assert.match(s, /<b>320 px reflow<\/b>[\s\S]*?40 px overflow/);
    assert.match(s, /<b>200% text<\/b>[\s\S]*?16 → 32 px/);
    assert.match(s, /<b>Text spacing<\/b>[\s\S]*?\+4 clipped/);
    assert.match(s, /<b>Dark mode<\/b>[\s\S]*?changes/);
    assert.match(s, /<b>Print<\/b>[\s\S]*?1 overlay/);
    assert.doesNotMatch(s, /undefined|NaN/);
  });

  test('screens pane: no accessibility section for readings without those views', () => {
    assert.doesNotMatch(screens(renderReport(withViews(), getPlugins())), /Accessibility views/);
  });
  ```

- [ ] **Step 2: Run them to watch them fail**

  Run: `node --test test/report.test.mjs`

  Expected: FAIL, because the section is missing.

- [ ] **Step 3: Implement in `extension/ui/report.js`.**
  - Add `VISION_VIEWS`, `DISPLAY_VIEWS` and `WCAG_VIEWS` to the `views.js` import.
  - Add these helpers next to `intlChips`:

  ```js
  /** One above-the-fold image (accessibility views keep no full-page shot). */
  function foldImage(entry, label) {
    const e = entry.viewport || entry.fullpage;
    return html`<div class="frame"><img src="${screenshotURL(e.shot)}" alt="${label} — above the fold" data-zoom="${e.index}" loading="lazy"></div>`;
  }

  function a11yChips(id, m, baseM) {
    if (!m || !baseM) return '';
    const extra = Math.max(0, (Number(m.clipped) || 0) - (Number(baseM.clipped) || 0));
    const over = Number(m.overflowX) || 0;
    if (id === 'reflow') return over > 0 ? ratingChip(`${over} px overflow`, 'poor') : ratingChip('fits', 'good');
    if (id === 'spacing') return ratingChip(`+${extra} clipped`, extra === 0 ? 'good' : extra < 3 ? 'needs-improvement' : 'poor');
    if (id === 'text200') {
      const grew = (Number(m.bodyFont) || 0) > (Number(baseM.bodyFont) || 0);
      return ratingChip(`${Number(baseM.bodyFont) || 0} → ${Number(m.bodyFont) || 0} px`, grew ? (extra >= 3 ? 'poor' : 'good') : 'needs-improvement');
    }
    if (id === 'dark') {
      const changes = Math.abs((Number(m.bg) || 0) - (Number(baseM.bg) || 0)) >= 0.1;
      return ratingChip(changes ? 'changes' : 'no change', changes ? 'good' : 'needs-improvement');
    }
    if (id === 'print') {
      const n = Array.isArray(m.fixed) ? m.fixed.length : 0;
      return html`${m.chrome ? ratingChip('site chrome prints', 'needs-improvement') : ''}${n ? ratingChip(`${n} overlay${n === 1 ? '' : 's'}`, 'needs-improvement') : ''}${!m.chrome && !n ? ratingChip('clean', 'good') : ''}`;
    }
    if (id === 'forced') return Number(m.iconOnly) > 0 ? ratingChip(`${m.iconOnly} icon-only controls`, 'needs-improvement') : '';
    return '';
  }
  ```

  - In `screensPane`, compute these after `intl`:

  ```js
    const vision = VISION_VIEWS.filter((v) => by[v]);
    const measuredA11y = [...DISPLAY_VIEWS, ...WCAG_VIEWS].filter((v) => by[v]);
    const mv = hp(reading).capture?.views || {};
  ```

  - Append this section after the International section, inside the pane:

  ```js
      ${vision.length || measuredA11y.length ? html`<section class="card views a11y-views">
        <header class="views-head"><h2>Accessibility views</h2></header>
        ${vision.length && by[base] ? html`<h3>Vision</h3><div class="resilience vision-grid">
          <figure>${foldImage(by[base], 'As designed')}<figcaption><b>As designed</b></figcaption></figure>
          ${vision.map((v) => html`<figure>${foldImage(by[v], VIEW_LABELS[v])}<figcaption><b>${VIEW_LABELS[v]}</b></figcaption></figure>`)}
        </div>` : ''}
        ${measuredA11y.length ? html`<h3>Display and WCAG</h3><div class="resilience">
          ${measuredA11y.map((v) => html`<figure>${foldImage(by[v], VIEW_LABELS[v])}<figcaption><b>${VIEW_LABELS[v]}</b>${a11yChips(v, mv[v], mv[base])}</figcaption></figure>`)}
        </div>` : ''}
      </section>` : ''}
  ```

  - In `extension/ui/theme.css`, next to the `.resilience` rules, add:

  ```css
    .vision-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr)); }
    .a11y-views h3 { margin: 0.75rem 0 0.4rem; font-size: 0.9rem; }
  ```

  The test expects "+4 clipped" for spacing (6 − 2), "40 px overflow" for reflow, "16 → 32 px" for 200% text, "changes" for dark (|0.04 − 1| ≥ 0.1), and "1 overlay" for print. The controller worked these out by hand.

- [ ] **Step 4: Run the tests to watch them pass**

  Run: `npm test`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add extension/ui/report.js extension/ui/theme.css test/report.test.mjs
  git commit -m "Report: Accessibility views section on the Screens pane

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 5: End-to-end: plugin findings, report section, fixture refresh

**Files:**
- Modify: `test/e2e/run.mjs`
- Modify: `test/fixtures/local-site.har` (regenerated from `test/e2e/out/local-site.har`)

**Interfaces:**
- Consumes:
  - `p['a11y-views']` result titles from Task 3;
  - the `Accessibility views` heading from Task 4;
  - the test site from Task 2 (promo overflow at 320 px, fixed cookie banner, print hides the header).

- [ ] **Step 1: Add the assertions.**

  In `test/e2e/run.mjs`, next to the other checks on `r1` plugin results (where `pc`, the content and links checks, live), add:

  ```js
      const av = r1.log._harplus.plugins['a11y-views'];
      assert.equal(av?.status, 'ok', `a11y-views: ${av?.error}`);
      const avTitles = av.findings.map((f) => f.title);
      assert.ok(avTitles.includes('Page scrolls horizontally at 320 px (WCAG 1.4.10)'), avTitles.join(' | '));
      assert.ok(avTitles.includes('1 fixed or sticky overlays print over content'), avTitles.join(' | '));
      assert.ok(!avTitles.includes('No print styles'), 'the site has a print rule');
      assert.ok(avTitles.includes('Text ignores the browser\'s font-size setting'), 'px-sized body text flagged');
      log('accessibility views passed');
  ```

  Where the e2e opens the reading's report on `page2` and checks the panes, add:

  ```js
      await page2.evaluate(() => { location.hash = 'screens'; });
      assert.ok(await page2.locator('#screens h2', { hasText: 'Accessibility views' }).count() === 1, 'accessibility views section');
      assert.ok(await page2.locator('#screens .vision-grid figure').count() === 7, '6 vision views + as designed');
  ```

  If the cookie banner contributes more than one overlay at print (for example, the banner and a wrapper both count), report the actual count in the report. Change the assertion to `/^\d+ fixed or sticky overlays print over content$/` only if the extra element is legitimate.

- [ ] **Step 2: Run the e2e**

  Run: `npm run test:e2e`

  Expected: `all e2e checks passed`. These are new assertions over features that already exist after Tasks 2–4, so they may pass on the first run. If so, prove they can fail: temporarily change the expected title, run once, see the failure, and revert.

- [ ] **Step 3: Refresh the fixture**

  Run `cp test/e2e/out/local-site.har test/fixtures/local-site.har`, then `npm test`.

  Expected: PASS. The fixture now carries the accessibility views and the `a11y-views` result. If report or CLI tests change because of that, update only the expectations the new data legitimately changes, and list each one in the report.

- [ ] **Step 4: Commit**

  ```bash
  git add test/e2e/run.mjs test/fixtures/local-site.har
  git commit -m "E2E: accessibility views plugin findings and Screens section; refreshed fixture

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```
