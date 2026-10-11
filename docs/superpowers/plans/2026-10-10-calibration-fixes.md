# Calibration Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the false and inflated findings found by the real-site calibration run, and flag readings of bot-check pages.

**Architecture:** Each fix stays inside the plugin or capture helper that produced the bad finding. Page-phase `collect()` functions are serialised into the page, so they must stay self-contained, with no imports and no module-level helpers. One new pure module, `extension/core/interstitial.js`, is read by the report and by the calibration runner.

**Tech Stack:** Plain ES modules, the `node --test` unit tests (`npm test`), and the Playwright e2e (`npm run test:e2e`) against `test/e2e/site`.

**Spec:** `docs/superpowers/specs/2026-10-10-calibration-fixes-design.md`

## Global Constraints

- **Page-phase `collect()` functions and in-page capture helpers** (`scrollPage`, `measureView`, `settleLayout`) are serialised into the page. They must not reference imports, module constants or closures. Everything they use is defined inside the function.
- **Mark name:** `harplus:scroll-start`, verbatim.
- **Prose thresholds:** a fragment is prose if it has 4 or more words (non-CJK) or 10 or more non-space characters (CJK). There is enough prose with 5 or more prose sentences and 100 or more prose words.
- **Same-colour cut:** a contrast ratio below `1.1` counts as unknown.
- **Settle loop:** poll every 250 ms; stop when two consecutive `scrollWidth` reads match and at least 600 ms have passed; give up at 3000 ms.
- **Line-length findings** need `lineLength.count >= 5`.
- **Interstitial thin page:** fewer than 300 words. Error statuses: 403, 429 and 503.
- **Older readings keep their old behaviour:** a missing `cutAt`, `scrollsX` or `proseSentences` must never create or remove a finding on its own.
- **Copy, verbatim:**
  - `Measured up to <sec>, before HAR-PLUS scrolled the page.`
  - `Not enough prose to score`
  - `Page scrolls sideways at 200% text size`
  - `No single element was found wider than the viewport; the extra width may come from margins or transforms.`
  - `could not be checked (over images, gradients or layered backgrounds)`
  - `This looks like a bot check or waiting page`
- **Commits:** end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **`scroll-behavior: smooth` on `html`:** an animated `scrollTo` leaves `scrollX` at 0 for the scroll test, which would hide real overflow. The scroll test must use `behavior: 'instant'`. Task 7 sets smooth scrolling in the fixture CSS, and the existing "Page scrolls horizontally at 320 px" e2e assertion must still pass.
2. **Vendor scripts on normal protected pages** (Imperva `_Incapsula_Resource`, the Queue-it client, the PerimeterX sensor, Cloudflare Turnstile) must not flag a full-length page as an interstitial. Task 5 has unit tests for this.
3. **A page-controlled `<title>` is shown in the interstitial banner** and must be HTML-escaped. Task 5 has a report test for this.
4. **A reading with no content plugin data** (plugin disabled or errored) must not throw in `detectInterstitial`. Signals that depend on the page being thin are simply skipped. Task 5 has a unit test.
5. **A page whose only LCP entries come after the scroll** gets `lcp: null`. The summary shows `—`, there is no LCP finding, and nothing renders as `NaN` or `undefined`. Task 1 has a unit test.

---

### Task 1: Vitals and LCP image stop at the scroll start

**Files:**
- Modify: `extension/browser/capture.js:71-80` (`scrollPage`)
- Modify: `extension/plugins/vitals.js` (`collect`, `run`)
- Modify: `extension/plugins/images.js:28-35` (LCP in `collect`)
- Create: `test/vitals.test.mjs`

**Interfaces:**
- Produces: `vitals` collected data gains `cutAt: number | null`.
- Produces: the page has a performance mark named `harplus:scroll-start`.

- [ ] **Step 1: Write the failing test** in `test/vitals.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../extension/plugins/vitals.js';
import { h } from '../extension/ui/render.js';

const c = (over = {}) => ({
  visibility: 'visible', navigation: { ttfb: 100, domContentLoaded: 400, load: 900, serverTiming: [] }, fcp: 500,
  lcp: { time: 5000, size: 1, element: 'img.hero' }, cls: 0.3, clsSources: [], longAnimationFrames: 3, blockingTime: 400,
  resources: 1, renderBlocking: [], domElements: 10, ...over,
});
const ctx = (collected) => ({ collected, skip: (m) => { throw new Error(m); } });
const run = (col) => plugin.run({ log: { entries: [], _harplus: {} } }, ctx(col));
const NOTE = 'Measured up to 1.8 s, before HAR-PLUS scrolled the page.';

test('cutAt: LCP, CLS and blocking findings note they stop at the scroll', () => {
  const r = run(c({ cutAt: 1800 }));
  for (const re of [/^Largest contentful paint/, /^Cumulative layout shift/, /^Main thread blocked/]) {
    const f = r.findings.find((x) => re.test(x.title));
    assert.ok(f, `${re} present`);
    assert.ok(f.detail.endsWith(NOTE), f.detail);
  }
});

test('CLS detail keeps the shifted elements before the note', () => {
  const r = run(c({ cutAt: 1800, clsSources: [{ value: 0.3, sources: [{ node: 'div.ad' }] }] }));
  assert.equal(r.findings.find((x) => /^Cumulative/.test(x.title)).detail, `Shifted: div.ad ${NOTE}`);
});

test('no cutAt (older readings): no note', () => {
  const r = run(c());
  assert.ok(r.findings.every((f) => !String(f.detail || '').includes('Measured up to')));
});

test('LCP only after the scroll → lcp null: no LCP finding, summary dash, clean render', () => {
  const r = run(c({ cutAt: 1800, lcp: null }));
  assert.ok(!r.findings.some((f) => /^Largest contentful paint/.test(f.title)));
  assert.equal(r.summary.find((s) => s.label === 'LCP').value, '—');
  const out = String(plugin.render({ data: r.data }, h)) + String(plugin.glance?.({ data: r.data }, h) ?? '');
  assert.doesNotMatch(out, /NaN|undefined/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/vitals.test.mjs`
Expected: the first two tests FAIL (no `Measured up to` detail). The last two pass.

- [ ] **Step 3: Add the note in `vitals.run`**

In `run()`, after `const findings = [];`, add:

```js
  const measured = c.cutAt != null ? `Measured up to ${sec(c.cutAt)}, before HAR-PLUS scrolled the page.` : '';
  const withNote = (...parts) => parts.filter(Boolean).join(' ');
```

In the ratings loop, replace the `...(shifted.length ? { detail: … } : {})` spread with:

```js
    const detail = withNote(shifted.length ? `Shifted: ${shifted.join(', ')}` : '', k === 'lcp' || k === 'cls' ? measured : '');
    findings.push({
      severity: r === 'poor' ? 'medium' : 'low',
      category: 'performance',
      title: `${names[k]} ${r}: ${v}`,
      ref: `https://web.dev/articles/${k}`,
      ...(detail ? { detail } : {}),
    });
```

Replace the blocking-time finding with:

```js
  if (c.blockingTime > 300) findings.push({ severity: 'low', category: 'performance', title: `Main thread blocked for ${formatMs(c.blockingTime)} by long animation frames`, ...(measured ? { detail: measured } : {}) });
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/vitals.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Mark the scroll start in `scrollPage`** (`extension/browser/capture.js`)

Make this the first statement inside `async function scrollPage(maxMs) {`:

```js
  if (!performance.getEntriesByName('harplus:scroll-start').length) performance.mark('harplus:scroll-start');
```

- [ ] **Step 6: Cut the vitals entries at the mark** (`extension/plugins/vitals.js` `collect`)

Replace:

```js
  const [lcpEntries, shifts, loafs] = await Promise.all([
    observe('largest-contentful-paint'), observe('layout-shift'), observe('long-animation-frame'),
  ]);
```

with:

```js
  // HAR-PLUS scrolls the page to load lazy content; entries after that are caused by us, not the page.
  const mark = performance.getEntriesByName('harplus:scroll-start')[0];
  const cut = mark ? mark.startTime : Infinity;
  const before = (xs) => xs.filter((e) => e.startTime < cut);
  const [lcpEntries, shifts, loafs] = (await Promise.all([
    observe('largest-contentful-paint'), observe('layout-shift'), observe('long-animation-frame'),
  ])).map(before);
```

In the returned object, add after `domElements`:

```js
    cutAt: Number.isFinite(cut) ? Math.round(cut) : null,
```

- [ ] **Step 7: Cut the LCP image at the mark** (`extension/plugins/images.js` `collect`)

Replace the `lcp` promise with:

```js
  const lcp = await new Promise((resolve) => {
    const mark = performance.getEntriesByName('harplus:scroll-start')[0];
    const cut = mark ? mark.startTime : Infinity;
    let last = null;
    try {
      new PerformanceObserver((list) => { const xs = list.getEntries().filter((e) => e.startTime < cut); if (xs.length) last = xs[xs.length - 1]; })
        .observe({ type: 'largest-contentful-paint', buffered: true });
    } catch { /* not supported */ }
    setTimeout(() => resolve(last ? (last.element?.currentSrc || last.element?.src || last.url || null) : null), 60);
  });
```

- [ ] **Step 8: Run the full unit suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add extension/browser/capture.js extension/plugins/vitals.js extension/plugins/images.js test/vitals.test.mjs
git commit -m "Vitals: LCP, CLS and blocking time stop where HAR-PLUS starts scrolling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Readability over prose only, and line-length minimum

**Files:**
- Modify: `extension/plugins/content.js` (`splitSentences`, new `proseSentences`, `analyze`, `readabilityCard`)
- Modify: `test/content.test.mjs`

**Interfaces:**
- Produces: `export function proseSentences(sentences: string[], script: string): string[]`.
- Produces: `reading.proseSentences` (number), and `reading.readability === 'not enough prose'`.
- `reading.sentences` becomes the count of all fragments; `proseSentences` is the prose count.

- [ ] **Step 1: Update the existing tests whose fixtures are too short to count as prose, and add new tests** (`test/content.test.mjs`)

Change the import line to add `proseSentences`:

```js
import plugin, { countWords, syllables, flesch, splitSentences, proseSentences, analyze, scriptOf, ari, aari, hardest } from '../extension/plugins/content.js';
```

After the `titles` helper, add these shared fixtures:

```js
const sentencesOf = (n, perSentence, w = 'word') => Array.from({ length: n }, () => `${words(perSentence, w)}.`).join(' ');
const FR = sentencesOf(6, 50, 'extraordinairement'); // 300 words, 6 sentences
const EN = sentencesOf(6, 50); // 300 words, 6 sentences
const AR = Array(10).fill('مرحبا بكم في متجرنا. نقدم الشحن المجاني على جميع الطلبات.').join(' '); // 100 words, 20 sentences
const JA = `${Array(10).fill('今日はとてもいい天気なので公園まで歩いて行きました').join('。')}。`; // 25 chars × 10
```

Make these replacements throughout the file:
- every `` `${words(300, 'extraordinairement')}.` `` → `FR`
- every `'مرحبا بكم في متجرنا. نقدم الشحن المجاني على جميع الطلبات.'` (as an analyze `text`) → `AR`
- every `'今日はいい天気です。明日も晴れるでしょう。'` → `JA`
- `` `${words(300)}.` `` (in the summary test) → `EN`
- `` `${words(300)}. مرحبا.` `` → `` `${EN} مرحبا.` ``

Expected values change as follows:
- `assert.equal(ja.data.reading.cjkCharsPerSentence, 10);` → `25`
- in the summary test, `/· 10 chars\/sentence$/` → `/· 25 chars\/sentence$/`

In the `reading findings` test, replace the `text` line with:

```js
  const text = `${long} ${long} ${long} ${long} ${long} ${long} Short one is here. Another short one here.`;
```

The expected `Many long sentences (75% over 25 words)` stays: 6 of 8 prose sentences.

In the `Flesch on a known passage` test, keep the comment but make the text 5 repeats, so the ratios (and Flesch) are unchanged:

```js
  const text = Array(5).fill('The cat sat on the warm mat. It was a quiet morning in the village. Children walked to school along the river. The teacher greeted every student with a smile.').join(' ');
```

Its asserts become `r.words === 150`, `r.sentences === 20`, `r.proseSentences === 20`, with Flesch still within 2 of 83.6.

Replace the `splitSentences` test with:

```js
test('splitSentences: latin punctuation before space/end, CJK full stops, line breaks', () => {
  assert.deepEqual(splitSentences('One two. Three? Four!'), ['One two', 'Three', 'Four']);
  assert.equal(splitSentences('Version 2.5 is out. Yes.').length, 2);
  assert.equal(splitSentences('今日は。明日は。').length, 2);
  assert.deepEqual(splitSentences('Headline one\nHeadline two\n\nA third line'), ['Headline one', 'Headline two', 'A third line']);
});

test('proseSentences: ≥ 4 words, or ≥ 10 non-space characters for CJK', () => {
  assert.deepEqual(proseSentences(['Home', 'World news', 'This one has four', 'and this has five words'], 'latin'), ['This one has four', 'and this has five words']);
  assert.deepEqual(proseSentences(['今日は', '今日はとてもいい天気です'], 'cjk'), ['今日はとてもいい天気です']);
});

test('headline list: not enough prose — no score, no hard-to-read or long-sentence finding', () => {
  const list = Array.from({ length: 240 }, (_, i) => `Minister announces extraordinarily comprehensive infrastructure investment programme ${i}`).join('\n');
  const r = analyze(base({ text: `${list}\nHome\nNews` }), { meta: {}, url: 'https://www.gov.test/' });
  // Line breaks split the headlines; the 1-word nav labels are fragments but not prose.
  assert.equal(r.data.reading.sentences, 242);
  assert.equal(r.data.reading.proseSentences, 240);
  const short = analyze(base({ text: 'Home\nNews\nSport\nWeather\nA short line of four\nContact us' }), { meta: {}, url: 'https://www.gov.test/' });
  assert.equal(short.data.reading.readability, 'not enough prose');
  for (const k of ['flesch', 'grade', 'ari', 'aari', 'cjkCharsPerSentence']) assert.equal(short.data.reading[k], null, k);
  assert.ok(!titles(short).some((t) => /^Hard to read|^Many long sentences/.test(t)));
  assert.match(String(plugin.glance(short, h)), /Not enough prose to score/);
  assert.ok(titles(short).some((t) => t.startsWith('Thin content')), 'thin content still uses all words');
});

test('enough sentences but under 100 prose words → not enough prose', () => {
  const r = analyze(base({ text: sentencesOf(8, 10) }), { meta: {}, url: 'https://www.site.test/' }); // 80 words
  assert.equal(r.data.reading.readability, 'not enough prose');
});

test('long headline list without sentence punctuation no longer reads as one giant sentence', () => {
  const list = Array.from({ length: 40 }, () => 'Council approves the new library budget for next year').join('\n');
  const r = analyze(base({ text: list }), { meta: {}, url: 'https://www.gov.test/' });
  assert.equal(r.data.reading.proseSentences, 40);
  assert.ok(r.data.reading.flesch > 30, `Flesch ${r.data.reading.flesch}`);
  assert.ok(!titles(r).some((t) => t.startsWith('Hard to read')));
});
```

In the `line length` test, change the arrays:
- `at([90, 100, 40, 95])` → `at([90, 100, 40, 95, 85])`, expecting `{ median: 90, ideal: 0, count: 5 }`;
- `at([50, 60, 70])` stays and still expects no finding;
- `at([20, 30])` → `at([20, 30, 25, 22, 28])`, expecting `'Lines are short (median 25 characters)'`.

Then add:

```js
test('line length: fewer than 5 measured paragraphs → no finding, row still shown', () => {
  const r = analyze(base({ text: words(300), lineLengths: [20, 22, 25, 30] }), { meta: {}, url: 'https://www.site.test/' });
  assert.ok(!titles(r).some((t) => t.startsWith('Lines are')));
  assert.equal(r.summary.find((x) => x.label === 'Line length').value, 'median 22 chars · 0% in 45–75');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/content.test.mjs`
Expected: FAIL. `proseSentences` is not exported, the line-break split is missing, and the "not enough prose" tests fail.

- [ ] **Step 3: Implement in `extension/plugins/content.js`**

Replace `splitSentences` and add `proseSentences` after it:

```js
export function splitSentences(text = '') {
  return text.split(/[.!?]+(?=\s|$)|[。！？]+|\n+/).map((s) => s.trim()).filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/** Fragments that read as prose: headlines, nav labels and buttons are shorter. */
export function proseSentences(sentences = [], script = 'latin') {
  return sentences.filter((s) => (script === 'cjk' ? [...s.replace(/\s/g, '')].length >= 10 : countWords(s) >= 4));
}
```

In `analyze`, replace the block from `const words = countWords(c.text);` through `const cjkCps = …;` with:

```js
  const words = countWords(c.text);
  const script = scriptOf(c.text);
  const english = englishText(c.lang, c.text);
  const fragments = splitSentences(c.text);
  const sentences = proseSentences(fragments, script);
  const prose = sentences.join(' ');
  const proseWords = countWords(prose);
  const enough = sentences.length >= 5 && proseWords >= 100;
  const lens = sentences.map((s) => countWords(s));
  const longShare = lens.length ? lens.filter((n) => n > 25).length / lens.length : 0;
  const paraWords = c.paragraphs.map((p) => countWords(p.text));
  const walls = c.paragraphs.filter((_, i) => paraWords[i] > 150);
  const syl = english && enough ? (prose.match(/[A-Za-z]+/g) || []).reduce((n, w) => n + syllables(w), 0) : 0;
  const f = english && enough ? flesch({ words: proseWords, sentences: sentences.length, syllables: syl }) : null;
  const letterCount = enough ? (prose.match(/[\p{L}\p{N}]/gu) || []).length : 0;
  const counts = { letters: letterCount, words: proseWords, sentences: sentences.length };
  const ariVal = enough && !english && ['latin', 'cyrillic', 'greek'].includes(script) ? ari(counts) : null;
  const aariVal = enough && !english && script === 'arabic' ? aari(counts) : null;
  const cjkCps = enough && !english && script === 'cjk'
    ? Math.round(sentences.reduce((n, x) => n + [...x.replace(/\s/g, '')].length, 0) / sentences.length) : null;
```

The old separate `const script = scriptOf(c.text);` and `const english = …` lines further down are now duplicates; delete them.

In the `reading` object:
- set `sentences: fragments.length,` and add `proseSentences: sentences.length,` after it;
- replace the `readability:` line with:

```js
    readability: !enough ? 'not enough prose' : english ? (f ? 'flesch' : 'not enough text') : ariVal != null ? 'ari' : aariVal != null ? 'aari' : cjkCps != null ? 'cjk' : `not applicable: ${script}`,
```

Make the long-sentence finding conditional on `enough`:

```js
  if (enough && lens.length && longShare > 0.3) add('low', `Many long sentences (${Math.round(longShare * 100)}% over 25 words)`);
```

Gate the line-length findings on the count:

```js
  if (lineLength.count >= 5 && lineLength.median > 80) add('low', `Lines are long (median ${lineLength.median} characters)`);
  else if (lineLength.count >= 5 && lineLength.median > 0 && lineLength.median < 35) add('info', `Lines are short (median ${lineLength.median} characters)`);
```

In `readabilityCard`, replace the final `return '';` with:

```js
  if (rd.readability === 'not enough prose') return h.html`<section class="card"><h4>Readability</h4><p class="note">Not enough prose to score${rd.proseSentences != null ? ` (${rd.proseSentences} of ${rd.sentences} lines are prose)` : ''}</p></section>`;
  return '';
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/content.test.mjs` and then `npm test`
Expected: PASS. If another test file (`glance`, `score`, `report` or `international`) asserts a Flesch or ARI value from a short synthetic text, lengthen that fixture in the same way (repeat it to 5 or more sentences and 100 or more words). Do not loosen the assertion.

- [ ] **Step 5: Commit**

```bash
git add extension/plugins/content.js test/
git commit -m "Content: readability over prose sentences only, line breaks end sentences; line-length findings need 5 paragraphs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Contrast — same-colour pairs and pseudo-element backgrounds are unknown

**Files:**
- Modify: `extension/plugins/contrast.js` (`collect` `background()`, `analyzeContrast`, `glance`)
- Modify: `test/contrast.test.mjs:64,91`

**Interfaces:**
- Produces: `analyzeContrast(c).data.totals.unknown`, which now includes same-colour pairs.

- [ ] **Step 1: Write the failing tests** (`test/contrast.test.mjs`)

Update the two existing wording asserts:
- line 64: `'info:1 text elements could not be checked (over images, gradients or layered backgrounds)'`
- line 91: `/1 could not be checked/`

Add:

```js
test('same-colour pairs (< 1.1:1) are unknown, not failing; 1.2:1 still fails', () => {
  const r = analyzeContrast({ elements: [el('#ffffff', '#ffffff', true, 'h2.a'), el('#fefefe', '#ffffff'), el('#dddddd', '#ffffff')] });
  const t = titles(r);
  assert.ok(!t.some((x) => /#ffffff on #ffffff|#fefefe on #ffffff/.test(x)), t.join(' | '));
  assert.ok(t.some((x) => /^(low|medium):Text contrast 1\.\d:1 \(#dddddd on #ffffff\)/.test(x)), t.join(' | '));
  assert.ok(t.includes('info:2 text elements could not be checked (over images, gradients or layered backgrounds)'), t.join(' | '));
  assert.equal(r.data.totals.unknown, 2);
  assert.equal(r.data.totals.checked, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/contrast.test.mjs`
Expected: FAIL (old wording; the white-on-white pair reported as failing).

- [ ] **Step 3: Implement `analyzeContrast`**

Replace the opening `const unknown = …` line, and the `const pairs = …` line further down, so the start of the function reads:

```js
export function analyzeContrast(c) {
  const els = c?.elements || [];
  const map = new Map();
```

(The loop stays as it is.) After the loop:

```js
  // A ratio this close to 1 means the text sits over something we cannot see (an image, canvas or another layer).
  const all = [...map.values()];
  const same = all.filter((p) => p.ratio < 1.1);
  const unknown = els.filter((e) => e.unknown).length + same.reduce((n, p) => n + p.count, 0);
  const pairs = all.filter((p) => p.ratio >= 1.1).map((p) => ({ ...p, pass: p.ratio >= (p.large ? 3 : 4.5), apcaPass: Math.abs(p.lc) >= (p.large ? 60 : 75) }));
```

Change the unknown finding title to:

```js
  if (unknown) findings.push({ severity: 'info', category: 'accessibility', title: `${unknown} text elements could not be checked (over images, gradients or layered backgrounds)` });
```

In `glance`, change `${t.unknown} over images or gradients not checked` to `${t.unknown} could not be checked`.

- [ ] **Step 4: Detect pseudo-element background images in `collect`'s `background()`**

Replace the `background` arrow function inside `collect` with:

```js
  const pseudoImage = (n) => ['::before', '::after'].some((p) => {
    const s = getComputedStyle(n, p);
    return s.backgroundImage && s.backgroundImage !== 'none' && s.content !== 'none' && s.content !== 'normal';
  });
  const background = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if ((cs.backgroundImage && cs.backgroundImage !== 'none') || pseudoImage(n)) return null;
      const c = rgba(cs.backgroundColor);
      if (c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
```

(This is verified in the browser by Task 7's e2e.)

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/plugins/contrast.js test/contrast.test.mjs
git commit -m "Contrast: same-colour pairs and pseudo-element background images count as unknown

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Reflow settle and scroll test; 200% text split

**Files:**
- Modify: `extension/browser/capture.js`: a new `settleLayout` after `scrollPage`; `measureView` adds `scrollsX`; the reflow and text200 views
- Modify: `extension/plugins/a11y-views.js:34-67`
- Modify: `test/a11y-views.test.mjs`

**Interfaces:**
- Produces: the `measured` view object gains `scrollsX: boolean`. Older readings have no `scrollsX`; treat `undefined` as "may scroll".

- [ ] **Step 1: Write the failing tests** (`test/a11y-views.test.mjs`)

Append:

```js
test('reflow: overflow the page cannot actually scroll is not reported; old readings still are', () => {
  assert.deepEqual(t(run({ reflow: { ...B, overflowX: 408, scrollsX: false } })), []);
  assert.deepEqual(t(run({ reflow: { ...B, overflowX: 40, scrollsX: true } })), ['medium:Page scrolls horizontally at 320 px (WCAG 1.4.10)']);
  const out = run({ reflow: { ...B, overflowX: 408, scrollsX: false } });
  assert.equal(out.checks.find((c) => c.id === 'reflow').ok, true);
});

test('reflow: real overflow with no culprit says so', () => {
  const f = run({ reflow: { ...B, overflowX: 40, scrollsX: true, overflowers: [], overflowTruncated: false } }).findings[0];
  assert.match(f.detail, /^No single element was found wider than the viewport; the extra width may come from margins or transforms\. /);
});

test('200% text: sideways scrolling alone is low and passes the 1.4.4 check; clipping stays medium', () => {
  const s = run({ text200: { ...B, bodyFont: 32, overflowX: 120, scrollsX: true } });
  assert.deepEqual(t(s), ['low:Page scrolls sideways at 200% text size']);
  assert.equal(s.findings[0].detail, 'Content is 120 px wider than the viewport.');
  assert.equal(s.checks.find((c) => c.id === 'text200').ok, true);
  assert.equal(s.summary.find((x) => x.label === '200% text').rating, 'needs-improvement');
  assert.deepEqual(t(run({ text200: { ...B, bodyFont: 32, overflowX: 120, scrollsX: false } })), []);
  const c = run({ text200: { ...B, bodyFont: 32, clipped: 5, overflowX: 120 } });
  assert.deepEqual(t(c), ['medium:Text clips at 200% size (WCAG 1.4.4)']);
  assert.equal(c.findings[0].detail, '3 more clipped text boxes.');
  assert.equal(c.checks.find((x) => x.id === 'text200').ok, false);
});
```

Check the shape: if `run()` in this file doesn't return `checks`, or `summary` entries are shaped differently, read the plugin's return value and adjust the property access only. The asserted values stay.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/a11y-views.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement in `extension/plugins/a11y-views.js`**

Replace the reflow block's `if (over > 0) { … }`, and the `ok` line, with:

```js
    // scrollsX is false when the page could not actually be scrolled sideways (stale width); undefined on older readings.
    const scrolls = over > 0 && reflow.scrollsX !== false;
    if (scrolls) {
      const own = num(base.overflowX);
      const o = (reflow.overflowers || [])[0];
      const none = !o && Array.isArray(reflow.overflowers) && !reflow.overflowTruncated;
      const lead = o ? `${o.selector} is ${o.width} px wide in a 320 px view. `
        : none ? 'No single element was found wider than the viewport; the extra width may come from margins or transforms. ' : '';
      add('medium', 'Page scrolls horizontally at 320 px (WCAG 1.4.10)',
        `${lead}Content is ${over} px wider than a 320 px viewport${own ? `, beyond the ${own} px the ${VIEW_LABELS[baseId] || baseId} view already overflows` : ''}.`);
    }
    if (extra >= A11Y_CLIP_EXTRA) add('medium', `${extra} more text boxes clip at 320 px (WCAG 1.4.10)`);
    const ok = !scrolls && extra < A11Y_CLIP_EXTRA;
    summary.push({ label: 'Reflow 320 px', value: ok ? 'fits' : [scrolls ? `${over} px overflow` : '', extra >= A11Y_CLIP_EXTRA ? `${extra} more clipped` : ''].filter(Boolean).join(' · '), rating: ok ? 'good' : 'poor' });
```

Replace the text200 block's body, from `const grew` to the `checks.push`, with:

```js
    const grew = num(big.bodyFont) > num(base.bodyFont);
    const extraBig = extraClipped(big);
    const clips = extraBig >= A11Y_CLIP_EXTRA;
    const scrolls = !clips && newOverflow(big) && big.scrollsX !== false;
    if (!grew) add('low', 'Text ignores the browser\'s font-size setting', `Body text stays ${num(big.bodyFont)} px when the default font size doubles.`);
    else if (clips) add('medium', 'Text clips at 200% size (WCAG 1.4.4)', `${extraBig} more clipped text boxes.`);
    else if (scrolls) add('low', 'Page scrolls sideways at 200% text size', `Content is ${num(big.overflowX)} px wider than the viewport.`);
    summary.push({ label: '200% text', value: `${num(base.bodyFont)} → ${num(big.bodyFont)} px`, rating: !grew || scrolls ? 'needs-improvement' : clips ? 'poor' : 'good' });
    checks.push({ id: 'text200', ok: grew && !clips });
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/a11y-views.test.mjs`
Expected: PASS. The existing `200% text` test still passes, since `clipped: 5` gives 3 more clipped boxes, which is medium.

- [ ] **Step 5: Add `settleLayout` and the scroll test in `extension/browser/capture.js`**

After `scrollPage`, add:

```js
/** Wait until the page width stops changing after a resize or font change. Runs in the page (main world). */
async function settleLayout(maxMs) {
  const start = performance.now();
  let last = -1;
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const w = document.documentElement.scrollWidth;
    const elapsed = performance.now() - start;
    if ((w === last && elapsed >= 600) || elapsed >= maxMs) return;
    last = w;
  }
}
```

In `measureView`, before the `return {`, add:

```js
  // Confirm the page really scrolls sideways: a stale scrollWidth from before a resize can over-report.
  let scrollsX = false;
  if (document.documentElement.scrollWidth > innerWidth) {
    const x0 = scrollX;
    const y0 = scrollY;
    scrollTo({ left: document.documentElement.scrollWidth, top: y0, behavior: 'instant' });
    scrollsX = scrollX > 0;
    scrollTo({ left: x0, top: y0, behavior: 'instant' });
  }
```

Add `scrollsX,` after the `rootClipX` property in the returned object.

In the `reflow` view's `run`, and in the `text200` view's `run`, replace `await sleep(600);` with:

```js
        await withTimeout(this.evaluate(settleLayout, 3000, 'main'), 5000, 'settle').catch(() => {});
```

Leave the other views' `sleep(600)` as they are.

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: PASS. Browser behaviour is verified in Task 7.

- [ ] **Step 7: Commit**

```bash
git add extension/browser/capture.js extension/plugins/a11y-views.js test/a11y-views.test.mjs
git commit -m "Views: settle layout before measuring reflow and 200% text, confirm sideways scrolling; 200% scroll-only is low

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Interstitial detection, report banner, calibration runner

**Files:**
- Create: `extension/core/interstitial.js`
- Create: `test/interstitial.test.mjs`
- Modify: `extension/ui/report.js` (`overviewPane`, plus the import)
- Modify: `extension/ui/theme.css` (`.card.alert`)
- Modify: `test/report.test.mjs`
- Modify: `scripts/calibrate.mjs`

**Interfaces:**
- Consumes: `mainEntry(har)` from `extension/core/har-util.js`.
- Produces: `export function detectInterstitial(reading): { vendor: string, reason: string } | null`.

- [ ] **Step 1: Write the failing tests** in `test/interstitial.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectInterstitial } from '../extension/core/interstitial.js';

const doc = (url, status = 200, headers = {}) => ({
  request: { url, method: 'GET' }, _resourceType: 'document',
  response: { status, headers: Object.entries(headers).map(([name, value]) => ({ name, value })), content: { mimeType: 'text/html' } },
});
const sub = (url) => ({ request: { url, method: 'GET' }, _resourceType: 'script', response: { status: 200, headers: [], content: { mimeType: 'text/javascript' } } });
const reading = ({ url = 'https://shop.test/', status = 200, headers = {}, more = [], title = 'Shop', words = 2000, content = true } = {}) => ({
  log: {
    entries: [doc(url, status, headers), ...more.map(sub)],
    _harplus: {
      target: { url, finalUrl: url, title },
      plugins: content ? { content: { status: 'ok', data: { reading: { words } } } } : {},
    },
  },
});

test('Akamai failover page (Patagonia shape) → Akamai, from the request URL', () => {
  const r = detectInterstitial(reading({ title: 'Hang Tight! Routing to checkout...', words: 210, headers: { server: 'AkamaiNetStorage' }, more: ['https://shop.test/home/botfailoveroriginal_files/spin.min.js'] }));
  assert.equal(r.vendor, 'Akamai');
  assert.match(r.reason, /^a request to …\/home\/botfailoveroriginal_files\//);
});

test('cf-mitigated: challenge → Cloudflare, whatever the length', () => {
  assert.equal(detectInterstitial(reading({ status: 403, headers: { 'cf-mitigated': 'challenge' }, words: 5000 })).vendor, 'Cloudflare');
});

test('DataDome: x-datadome with 403, or captcha-delivery request', () => {
  assert.equal(detectInterstitial(reading({ status: 403, headers: { 'x-datadome': 'protected' } })).vendor, 'DataDome');
  assert.equal(detectInterstitial(reading({ more: ['https://geo.captcha-delivery.com/captcha/?x=1'] })).vendor, 'DataDome');
  assert.equal(detectInterstitial(reading({ headers: { 'x-datadome': 'protected' } })), null, '200 with the header is a normal protected page');
});

test('title + thin page → detected; same title on a long page → null', () => {
  const r = detectInterstitial(reading({ title: 'Just a moment...', words: 40, headers: { server: 'cloudflare' } }));
  assert.deepEqual(r, { vendor: 'Cloudflare', reason: 'the title “Just a moment...”' });
  assert.equal(detectInterstitial(reading({ title: 'Just a moment...', words: 2000 })), null);
});

test('error status + thin page → detected; error status on a full page → null', () => {
  assert.deepEqual(detectInterstitial(reading({ status: 403, words: 50 })), { vendor: 'unknown', reason: 'a 403 response with only 50 words' });
  assert.equal(detectInterstitial(reading({ status: 403, words: 1000 })), null);
});

test('vendor scripts on normal protected pages are hints only (Review Focus 2)', () => {
  const more = [
    'https://challenges.cloudflare.com/turnstile/v0/api.js', 'https://shop.test/cdn-cgi/challenge-platform/h/b/scripts/x.js',
    'https://shop.test/_Incapsula_Resource?SWJIYLWA=abc', 'https://static.queue-it.net/script/queueclient.min.js',
    'https://client.perimeterx.net/PXabc/main.min.js',
  ];
  assert.equal(detectInterstitial(reading({ more, words: 2000 })), null);
  assert.equal(detectInterstitial(reading({ more: [more[2]], title: 'Request unsuccessful', words: 30 })).vendor, 'Imperva');
});

test('no content data, no log, empty reading → never throws (Review Focus 4)', () => {
  assert.equal(detectInterstitial(reading({ title: 'Just a moment...', content: false })), null);
  assert.equal(detectInterstitial(reading({ status: 403, content: false })), null);
  assert.equal(detectInterstitial({}), null);
  assert.equal(detectInterstitial(null), null);
  assert.equal(detectInterstitial({ log: { entries: [] } }), null);
});
```

Note: `mainEntry` uses `resourceType(e)`. Check how `resourceType` in `har-util.js` decides an entry is a document (for example `_resourceType` or the MIME type), and shape the `doc()` and `sub()` fixtures to match. Do not change `har-util.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/interstitial.test.mjs`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `extension/core/interstitial.js`**

```js
// Bot-check and waiting-room pages: a reading of one of these audits the gate, not the site.
// Pure: works from data every HAR already has, so imported and older readings are covered too.

import { mainEntry } from './har-util.js';

// Only ever served as part of a challenge or failover page.
const STRONG_URLS = [
  [/botfailover|sitefailover/i, 'Akamai'],
  [/captcha-delivery\.com/i, 'DataDome'],
  [/px-captcha/i, 'HUMAN'],
];
// Also loaded by normal protected pages: they name the vendor, never trigger detection.
const HINT_URLS = [
  [/_Incapsula_Resource/i, 'Imperva'],
  [/queue-it\.net/i, 'Queue-it'],
  [/perimeterx\.net/i, 'HUMAN'],
  [/challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform/i, 'Cloudflare'],
];
const TITLE = /just a moment|attention required|access denied|are you a (robot|human)|verify(ing)? you are (a )?human|security check|hang tight|you are (now )?in (the )?(queue|line)|waiting room|pardon our interruption|request unsuccessful/i;
const THIN = 300;
const ERRORS = [403, 429, 503];

const header = (entry, name) => (entry?.response?.headers || []).find((h) => String(h.name).toLowerCase() === name)?.value;
const shortUrl = (u) => { try { return `…${new URL(u).pathname.slice(0, 60)}`; } catch { return String(u).slice(0, 60); } };
const match = (urls, table) => { for (const u of urls) for (const [re, vendor] of table) if (re.test(u)) return { vendor, url: u }; return null; };

function vendorHint(doc, urls) {
  const server = String(header(doc, 'server') || '').toLowerCase();
  if (header(doc, 'cf-ray') || server === 'cloudflare') return 'Cloudflare';
  if (header(doc, 'x-datadome')) return 'DataDome';
  if (server.includes('akamai')) return 'Akamai';
  return match(urls, [...STRONG_URLS, ...HINT_URLS])?.vendor || 'unknown';
}

/** @returns {{ vendor: string, reason: string } | null} */
export function detectInterstitial(reading) {
  const log = reading?.log;
  if (!log?.entries?.length) return null;
  const doc = mainEntry(reading);
  const urls = log.entries.map((e) => e?.request?.url || '');
  const status = doc?.response?.status || 0;
  if (/^challenge$/i.test(String(header(doc, 'cf-mitigated') || '').trim())) return { vendor: 'Cloudflare', reason: 'a cf-mitigated: challenge response header' };
  if (header(doc, 'x-datadome') && status === 403) return { vendor: 'DataDome', reason: 'a 403 response with an x-datadome header' };
  const strong = match(urls, STRONG_URLS);
  if (strong) return { vendor: strong.vendor, reason: `a request to ${shortUrl(strong.url)}` };
  const words = log._harplus?.plugins?.content?.data?.reading?.words;
  if (!Number.isFinite(words) || words >= THIN) return null;
  const title = String(log._harplus?.target?.title || '');
  if (TITLE.test(title)) return { vendor: vendorHint(doc, urls), reason: `the title “${title.slice(0, 80)}”` };
  if (ERRORS.includes(status)) return { vendor: vendorHint(doc, urls), reason: `a ${status} response with only ${words} words` };
  return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/interstitial.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing report tests** (append to `test/report.test.mjs`)

```js
test('interstitial reading shows the bot-check banner; normal reading does not', async () => {
  const { detectInterstitial } = await import('../extension/core/interstitial.js');
  const normal = load();
  assert.equal(detectInterstitial(normal), null);
  assert.doesNotMatch(renderReport(normal, getPlugins()), /bot check or waiting page/);
  const gate = load();
  gate.log.entries.push({ ...gate.log.entries[0], request: { ...gate.log.entries[0].request, url: 'https://www.example.com/home/botfailoveroriginal_files/spin.min.js' } });
  const out = renderReport(gate, getPlugins());
  assert.match(out, /class="card alert"/);
  assert.match(out, /This looks like a bot check or waiting page \(Akamai\), not the real page\./);
});

test('interstitial banner escapes the page title (Review Focus 3)', () => {
  const r = load();
  r.log._harplus.target.title = 'Just a moment <img src=x onerror=alert(1)>';
  r.log._harplus.plugins.content = { ...(r.log._harplus.plugins.content || {}), status: 'ok', data: { ...(r.log._harplus.plugins.content?.data || {}), reading: { ...(r.log._harplus.plugins.content?.data?.reading || {}), words: 20 } } };
  const out = renderReport(r, getPlugins());
  assert.match(out, /class="card alert"/);
  assert.doesNotMatch(out, /<img src=x onerror/);
});
```

If the content plugin's `glance` or `render` throws on that minimal `content.data`, adjust only the fixture surgery so the report renders (for example, keep the existing data and set `reading.words`). The banner asserts stay.

- [ ] **Step 6: Run the tests to verify they fail**

Run: `node --test test/report.test.mjs`
Expected: the two new tests FAIL.

- [ ] **Step 7: Render the banner** (`extension/ui/report.js`)

Add the import beside the other `../core/` imports:

```js
import { detectInterstitial } from '../core/interstitial.js';
```

Add before `function overviewPane`:

```js
function interstitialCard(reading) {
  const hit = detectInterstitial(reading);
  if (!hit) return '';
  const vendor = hit.vendor !== 'unknown' ? ` (${hit.vendor})` : '';
  return html`<div class="card alert" role="note"><p><strong>This looks like a bot check or waiting page${vendor}, not the real page.</strong> The findings and scores describe that page. Detected from ${hit.reason}.</p></div>`;
}
```

In `overviewPane`'s returned template, insert `${interstitialCard(reading)}` directly before `<div class="card hero">`.

Add to `extension/ui/theme.css`, near the other `.card` rules:

```css
  .card.alert { border-left: 4px solid var(--st-warning); }
```

- [ ] **Step 8: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Update `scripts/calibrate.mjs`**

- Replace the NHK line with: `'https://www.asahi.com/',                     // Japanese`
- Add an import: `import { detectInterstitial } from '../extension/core/interstitial.js';`
- In the `digest.push({ … })` for a successful reading, add `interstitial: detectInterstitial(reading),` after `areas`.
- In the markdown builder, add this line after the `Areas:` line:
  ```js
  d.interstitial ? `**Interstitial:** ${d.interstitial.vendor} — ${d.interstitial.reason}` : '',
  ```

Run `node --check scripts/calibrate.mjs`. Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add extension/core/interstitial.js test/interstitial.test.mjs extension/ui/report.js extension/ui/theme.css test/report.test.mjs scripts/calibrate.mjs
git commit -m "Interstitial detection: bot-check and waiting-room readings get a report banner; calibration digest records it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Document titles only; really-focusable elements in aria-hidden

**Files:**
- Modify: `extension/plugins/meta.js:117` (`counts.title`)
- Modify: `extension/plugins/a11y-basics.js:75-76` (`focusable-hidden`)

Both are in-page `collect()` code with no unit harness. They are verified by Task 7's e2e. This task is a small, mechanical edit.

- [ ] **Step 1: Count only the document's own titles** (`meta.js`)

Replace `title: document.querySelectorAll('title').length` with:

```js
title: [...document.querySelectorAll('title')].filter((t) => !t.closest('svg')).length
```

- [ ] **Step 2: Filter to really-focusable elements** (`a11y-basics.js`)

Replace the `focusable-hidden` check with:

```js
  check('focusable-hidden', 'serious', 'Focusable elements inside aria-hidden',
    () => $$('[aria-hidden="true"] :is(a[href], area[href], button, input, select, textarea, summary, iframe, [contenteditable=""], [contenteditable="true"], [tabindex])').filter((el) => {
      const ti = el.getAttribute('tabindex');
      if (ti !== null && ti.trim() !== '' && Number(ti) < 0) return false;
      if (el.matches(':disabled, input[type="hidden" i]') || el.closest('[inert]')) return false;
      if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
      return el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
    }));
```

(`$$` returns an array in this file; check its definition, and wrap in `[...]` if it doesn't.)

- [ ] **Step 3: Run the unit suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add extension/plugins/meta.js extension/plugins/a11y-basics.js
git commit -m "Meta: SVG titles are not duplicate document titles; a11y-basics: only really-focusable elements inside aria-hidden

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: E2E fixture and assertions

**Files:**
- Modify: `test/e2e/site/index.html` (inside `<main>`, before `<div style="height:2400px"></div>`)
- Modify: `test/e2e/site/app.css`
- Modify: `test/e2e/run.mjs` (after the existing contrast assertions, around line 146, and in the plugin checks around line 286)

- [ ] **Step 1: Add the fixture elements** to `index.html`, before `<div style="height:2400px"></div>`:

```html
    <svg width="16" height="16" aria-hidden="true"><title>Decorative icon</title><circle cx="8" cy="8" r="6"/></svg>
    <div aria-hidden="true"><input type="text" name="hp-trap" tabindex="-1" aria-label="Leave empty"><a href="/page2.html" style="visibility:hidden">Hidden link</a></div>
    <div aria-hidden="true" class="decor"><a href="/page2.html">Visible but hidden from assistive tech</a></div>
    <p class="over-art">Night sale on headlamps</p>
```

- [ ] **Step 2: Add the fixture CSS** to `app.css`:

```css
html { scroll-behavior: smooth; }
.over-art { position: relative; color: #ddd; }
.over-art::before { content: ''; position: absolute; inset: 0; z-index: -1; background-image: url(/img/hero.svg); }
```

- [ ] **Step 3: Add the e2e assertions** to `test/e2e/run.mjs`

After `assert.equal(faint.severity, 'low', 'a pair on one element is low');`:

```js
    assert.ok(!pcx.findings.some((f) => /#dddddd on/.test(f.title)), 'text over a ::before background image is unknown, not failing');
    assert.ok(pcx.findings.some((f) => /could not be checked \(over images, gradients or layered backgrounds\)$/.test(f.title)), 'unknown count reported');
```

After the `for (const id of ['meta', 'vitals', …])` status loop:

```js
    assert.ok(!p.meta.findings.some((f) => /Duplicate meta tags:.*\btitle\b/.test(f.title)), 'SVG <title> is not a duplicate document title');
    const fh = p['a11y-basics'].data.rules.find((r) => r.id === 'focusable-hidden');
    assert.equal(fh?.count, 1, `only the visible link counts: ${JSON.stringify(fh?.samples)}`);
    assert.equal(typeof p.vitals.data.cutAt, 'number', 'scroll-start mark seen by vitals');
    if (p.vitals.data.lcp) assert.ok(p.vitals.data.lcp.time < p.vitals.data.cutAt, 'LCP before the scroll');
    assert.equal(typeof hp.capture.views.reflow.scrollsX, 'boolean', 'reflow view records the scroll test');
```

The existing assertion that `Page scrolls horizontally at 320 px (WCAG 1.4.10)` is present must still pass, now with `scroll-behavior: smooth` on the page (Review Focus 1). If `hp.capture.views.reflow` isn't the path to the measured view, find it with the existing `mv[id]` usage near line 237, and use the same lookup.

- [ ] **Step 4: Run the e2e**

Run: `npm run test:e2e`
Expected: PASS. If an existing e2e assertion fails because of the new fixture elements (for example a link or image count), update that count to match. If it fails because of the behaviour change (for example the reflow finding disappears), stop and investigate. Do not loosen it.

- [ ] **Step 5: Run the unit suite**

Run: `npm test`
Expected: PASS. If `test/fixtures/local-site.har` is regenerated by the e2e and changed, include it in the commit.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/ test/fixtures/
git commit -m "E2E: SVG title, aria-hidden focus traps, pseudo-element background, smooth scrolling, vitals cut, reflow scroll test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Calibration re-run (controller, not a subagent)

- [ ] **Step 1:** Run `node scripts/calibrate.mjs` from the worktree. It takes about 10–20 minutes, so run it in the background.
- [ ] **Step 2:** Compare `test/e2e/out/calibrate/digest.md` with the spec's expected outcomes:
  - no duplicate-title finding on BBC, MDN, gov.uk or Al Jazeera;
  - no medium hard-to-read finding on gov.uk or Le Monde;
  - no focusable-hidden finding on gov.uk or Wikipedia;
  - no 1.0:1 contrast pair on Al Jazeera;
  - LCP below `cutAt` on every site;
  - no reflow finding on MDN;
  - no medium text200 finding on MDN or Wikipedia;
  - Patagonia flagged as an interstitial, if it still serves one.
- [ ] **Step 3:** For any site still showing a targeted false finding, open its `.har`, find the root cause (systematic debugging), fix it with a test in the owning task's files, and commit. Record each one in the ledger.
