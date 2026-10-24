# Language & Text Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** add a "Language & text" plugin to the International area. It checks:
- that the declared language matches the text;
- untagged passages in another language;
- attribute text in another language;
- encoding consistency;
- garbled characters;
- hard-coded formats;
- text in images.

**Architecture:**
- **`extension/core/language.js`:** pure helpers, namely script detection, subtag comparison, charset normalisation, the shared pattern sources, and the Chrome detector wrapper.
- **`extension/plugins/language.js`:** a page-phase plugin with three parts:
  - `collect()` runs in the page and builds its regular expressions from pattern sources passed in through `collectArgs`, because it cannot import;
  - `run()` turns the collected data into findings, using `ctx.detectLanguage`;
  - `glance()` renders the checklist card.
- **Detector wiring:** `capture.js` passes `env.detectLanguage`, and `plugin-host.js` exposes it to plugins as `ctx.detectLanguage`.

**Tech Stack:** vanilla ES modules, the `html` tagged templates (`h.html`), `chrome.i18n.detectLanguage`, `Intl.DisplayNames`, `node --test`, and Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-23-language-text-checks-design.md`

## Global Constraints

- **Dependencies:** no new runtime dependency and no new manifest permission.
- **Collection budget:** at most 20,000 text nodes or 1.5 s. No network requests.
- **Escaping:** untrusted page text stays escaped through `html` in every finding, evidence item and glance.
- **Output:** no `NaN`, `undefined` or `Infinity`.
- **Detector:** everything works without it, using the script fallback. Every finding's `evidence.method` is `'detector'` or `'script'`.
- **Category:** every finding has `category: 'international'`.
- **Commits:** each message ends with `Co-Authored-By: <model that wrote it> <noreply@anthropic.com>`.
- **Commands:** run `npm test` and `npm run test:e2e` from the repo or worktree root (baseline 548, e2e green).
- **Worktree guard:** it rejects compound shell commands involving git; run git commands plain and separately. Do not commit a `package-lock.json`.

## Rulings made while planning

- **Detector wiring is in `capture.js` only.** Page-phase plugins run only during capture; the viewer's re-run and HAR import run `analyze`/`enrich`, and the CLI never runs `page`. This replaces the spec's "each call site of runPlugins".
- **Pattern sources are shared through `collectArgs`.** The format, mojibake and replacement patterns live once, as source strings in `core/language.js` (`PATTERNS`). `collectArgs` passes them to `collect()`, which compiles them. The pure helpers compile the same sources, so nothing is duplicated.

## Review Focus

1. **Very short pages, or pages that are nearly all navigation.** No language claims are made from too little text, and nothing fires below the thresholds (200 characters for the page, 60 for a block). Pinned in Task 2.
2. **Pages that legitimately mix languages:**
   - correctly tagged passages, such as the fixture's `<p lang="ar">`, raise no L3 or L4;
   - a language switcher listing "Deutsch · Français · 日本語" raises no L3, because each link is under 60 characters and is not a block.

   Pinned in Task 2 (unit) and Task 3 (e2e).
3. **`chrome.i18n.detectLanguage` returning `und` or an empty list, or throwing.** The plugin falls back to the script check, with no error and no finding from `und`. Pinned in Task 2.
4. **Code-like text.** Version numbers (`1.2.3`), file paths and `10/20/30`-style tables in visible text. Only `d/d/yyyy`-shaped strings with both leading parts ≤ 12 count as dates; `1.2.3` and `10/20/30` do not. Pinned in Task 1.
5. **Charset spellings:** `UTF-8`, `utf8`, `"utf-8"` with quotes, and `ISO-8859-1` compared with `windows-1252`. Spellings normalise as equal. `ISO-8859-1`/`windows-1252` is treated as consistent, because browsers decode `ISO-8859-1` as `windows-1252`. Pinned in Task 1.

---

### Task 1: Pure language helpers and detector plumbing

**Files:**
- Create: `extension/core/language.js`
- Modify: `extension/core/plugin-host.js` (the context object: add `detectLanguage: env.detectLanguage`, next to `whois` and `cache`)
- Test: `test/language.test.mjs` (new)

**Interfaces (all exported from `extension/core/language.js`):**
- **`PATTERNS`:** `{ date, time, money, mojibake, replacement }`, each a `{ source, flags }` pair. The values are the spec's regexes, with the `g` flag. `date` captures the two leading parts so callers can apply the "both parts ≤ 12" rule.
- **`countMatches(text, kind, { max = 10 } = {}) → { count, examples: string[] }`:**
  - For `date`, it counts only ambiguous dates, where both leading parts are ≤ 12.
  - For `mojibake` and `replacement`, each example is about 20 characters of context around the match.
- **`scriptOf(text) → { script: string | null, share: number }`:**
  - Counts letters by script (Latin, Cyrillic, Greek, Arabic, Hebrew, Han, Kana, Hangul, Devanagari, Thai, Other) using Unicode `\p{Script=…}`.
  - `share` is the dominant script's share of all letters.
  - Returns `{ script: null, share: 0 }` when the text has no letters.
- **`SCRIPT_OF_LANG`:** about 40 entries mapping a primary subtag to an array of scripts. `ja` maps to `['Han', 'Kana']`, `zh` to `['Han']` and `ko` to `['Hangul', 'Han']`.
- **`primary(tag) → string`:** the lower-cased primary subtag, or `''`.
- **`sameLanguage(a, b) → boolean`:** compares primary subtags.
- **`normCharset(s) → string | null`:**
  - lower-cases, trims, strips quotes, and maps `utf8` to `utf-8`;
  - maps `iso-8859-1`, `latin1` and `us-ascii` to `windows-1252`, as the WHATWG Encoding spec does;
  - returns `null` for empty input.
- **`languageName(code) → string`:** uses `Intl.DisplayNames(['en'], {type: 'language'})`, falling back to the code itself.
- **`chromeDetector() → ((text) => Promise<{code, share, reliable} | null>) | undefined`:**
  - Returns `undefined` when `globalThis.chrome?.i18n?.detectLanguage` is missing.
  - Otherwise returns a function that resolves the top entry as `{ code: primary(language), share: percentage / 100, reliable: isReliable }`.
  - It resolves `null` on an empty list, on `und`, or on an error.

- [ ] **Step 1: Write the failing tests** in `test/language.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countMatches, scriptOf, primary, sameLanguage, normCharset, languageName, chromeDetector } from '../extension/core/language.js';

test('countMatches: ambiguous numeric dates only', () => {
  assert.equal(countMatches('on 03/04/2025 and 4.5.25', 'date').count, 2);
  assert.equal(countMatches('13/04/2025, 1.2.3, 10/20/30, v2.10.4', 'date').count, 0);
});
test('countMatches: 12-hour times and money', () => {
  assert.equal(countMatches('opens 3:00 PM, closes 9:30 p.m.; 14:00', 'time').count, 2);
  assert.equal(countMatches('€12, 12 €, $5, £ 3, 12 apples', 'money').count, 4);
});
test('countMatches: mojibake and replacement with context examples', () => {
  const m = countMatches('a cafÃ© here, itâ€™s, Â fine', 'mojibake'); // Â + no-break space = a mis-decoded U+00A0
  assert.equal(m.count, 3);
  assert.ok(m.examples[0].includes('cafÃ©'));
  assert.equal(countMatches('a�b�', 'replacement').count, 2);
});
test('scriptOf picks the dominant script', () => {
  assert.deepEqual(scriptOf('Привет мир'), { script: 'Cyrillic', share: 1 });
  assert.equal(scriptOf('日本語のテキスト').script, 'Kana'); // or Han — assert it is one of ['Han','Kana']
  assert.deepEqual(scriptOf('123 !!'), { script: null, share: 0 });
});
test('subtags and charsets', () => {
  assert.equal(primary('en-GB'), 'en');
  assert.ok(sameLanguage('zh-Hant', 'zh'));
  assert.ok(!sameLanguage('en', 'fr'));
  assert.equal(normCharset(' "UTF8" '), 'utf-8');
  assert.equal(normCharset('ISO-8859-1'), normCharset('windows-1252'));
  assert.equal(normCharset(''), null);
  assert.equal(languageName('de'), 'German');
});
test('chromeDetector: absent without chrome; maps the top result; null on und/errors', async () => {
  assert.equal(chromeDetector(), undefined);
  globalThis.chrome = { i18n: { detectLanguage: (t, cb) => cb({ isReliable: true, languages: [{ language: 'fr-FR', percentage: 92 }] }) } };
  try {
    assert.deepEqual(await chromeDetector()('x'), { code: 'fr', share: 0.92, reliable: true });
    globalThis.chrome.i18n.detectLanguage = (t, cb) => cb({ isReliable: false, languages: [{ language: 'und', percentage: 100 }] });
    assert.equal(await chromeDetector()('x'), null);
    globalThis.chrome.i18n.detectLanguage = () => { throw new Error('boom'); };
    assert.equal(await chromeDetector()('x'), null);
  } finally { delete globalThis.chrome; }
});
```

  Make the `scriptOf` Japanese assertion concrete: assert the script is one of `['Han', 'Kana']`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --test test/language.test.mjs`
Expected: the module is not found.

- [ ] **Step 3: Implement** `extension/core/language.js` as in Interfaces. Add `detectLanguage: env.detectLanguage` to the plugin context in `plugin-host.js`, with a one-line comment in the style of the `whois` and `cache` entries.

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/language.test.mjs`, then `npm test`.
Expected: all pass.

- [ ] **Step 5: Commit**

`git add extension/core/language.js extension/core/plugin-host.js test/language.test.mjs`, then `git commit -m "Language helpers: scripts, subtags, charsets, shared text patterns, Chrome detector wrapper"`, with the trailer.

---

### Task 2: The plugin's analysis, findings, summary and glance

**Files:**
- Create: `extension/plugins/language.js` (metadata, `collectArgs`, `run`, `glance`; `collect` is added in Task 3)
- Modify: `extension/plugins/index.js` (import it and register it right after `international`)
- Test: `test/language.test.mjs` (append)

**Interfaces:**
- **Consumes:** everything Task 1 exports.
- **Produces:** the default export `{ id: 'language', name: 'Language & text', version: '0.1.0', phase: 'page', world: 'isolated', area: 'international', group: 'other', tags: ['i18n'], description, collectArgs: () => ({ patterns: PATTERNS }), run, glance }`.
- **`run(reading, ctx)` reads:**
  - `ctx.collected`, in the shape of spec §1.1: `regions`, `blocks`, `attrs`, `formats`, `mojibake`, `replacement`, `metaCharset`, `docCharset`, `htmlLang`, `textImages`, `truncated`;
  - `ctx.detectLanguage`, which may be undefined;
  - the HAR main document's headers, chosen as in spec §1.3.
- **`run` returns** `{ data, findings, summary }`.
  - `data` holds `{ method, declared, detected: {code, share} | null, headerCharset, contentLanguage, metaCharset, docCharset, counts }` plus whatever `glance` needs.
- **Internal helper:** `detect(text, minChars)` tries the detector, falls back to `scriptOf`, and applies the counted-detection rule from spec §1.2: reliable, at least `minChars` characters, and a share of at least 0.6.
- **Findings:** L1–L12 and "Text sampling stopped early", with the exact titles, conditions and severities in spec §2, and `evidence.method` set on each.
- **Summary rows:** `Language`, `Encoding` and `Formats`, as in spec §3.
- **Glance:** a card headed "Language and text" containing `h.checklist(items)`, with the six items in spec §3.

**Test fixture helpers.** These go in the test file:
- `col(over)` builds a clean `collected` object for an English page: `htmlLang: 'en'`, one region with an English sample of 400+ characters, a few blocks, no attrs, zero counts, and `metaCharset` and `docCharset` both `utf-8`. It merges in `over`.
- `det(map)` builds a fake detector that returns `map[text]`, or by default `{ code: 'en', share: 0.98, reliable: true }`.
- `rd(headers)` builds a reading whose single document entry has those response headers.

- [ ] **Step 1: Write the failing tests** (append):
  - **Registration:** `getPlugins()` ids put `language` at `indexOf('international') + 1`; `area` is `'international'`; `phase` is `'page'`.
  - **Clean page:** `col()`, `det({})` and `rd({ 'content-type': 'text/html; charset=utf-8', 'content-language': 'en' })` give **no** findings, a `data.method` of `'detector'`, and a `Language` summary row whose value contains `English`.
  - **Exact titles at each threshold,** and quiet just below each:
    - **L1:** `htmlLang: null` gives `medium:The page doesn't say which language it is in`.
    - **L2:**
      - A detector returning fr at 0.92 on the region sample gives ``high:Page says lang="en" but its text is mostly French (92%)``.
      - A share of 0.55 gives nothing.
      - `reliable: false` gives nothing.
      - A sample of 150 characters gives nothing.
    - **L2 under the fallback** (no detector): a Cyrillic region sample of 300 characters on `lang="en"` gives ``high:Page says lang="en" but its text is mostly Cyrillic script``. A French sample gives nothing.
    - **L3:**
      - Three German blocks without their own `lang` give `medium:3 passages in German have no lang attribute`.
      - One German block gives `low:1 passage in German has no lang attribute`.
      - A German block of 55 characters gives nothing.
    - **L4:** a block with its own `lang: 'fr'` detected as es gives ``medium:lang="fr" is on text that reads as Spanish``. The fixture-like `{ lang: 'ar', text: <Arabic> }`, with the detector returning ar, gives nothing.
    - **L5:** four alt entries detected as English on a `de` page give `medium:4 alt texts are in English on a German page`. Two entries give nothing.
    - **L6:** `content-language: fr` on `en` gives the low title. `content-language: fr, en` gives nothing.
    - **L7:** a header charset of `iso-8859-1` with `metaCharset: 'utf-8'` gives `medium:Character encoding is declared inconsistently`. `utf8` against `UTF-8` gives nothing. `iso-8859-1` against `windows-1252` gives nothing.
    - **L8:** no header charset and `metaCharset: null` give `low:No character encoding is declared`. A reading with no document entry gives no L8.
    - **L9:** `mojibake: {count: 3, examples: ['cafÃ©']}` gives `high:Text shows garbled characters such as "cafÃ©"`. A count of 2 gives nothing.
    - **L10:** a count of 3 gives `medium:3 replacement characters (�) appear in the text`.
    - **L11:** counts of 1+1+1 give `low:Dates, times or prices are written in one region's format`. Counts of 1+1+0 give nothing.
    - **L12:** one image gives `info:1 large image may contain text that can't be translated`.
    - **Truncation:** `truncated: true` gives `info:Text sampling stopped early`.
  - **Detector failure:** a detector that throws, or resolves `null`, falls back to the script check with no error, and gives no L2 for a Latin page (Review Focus 3).
  - **Escaping:** a block text and a mojibake example containing `<script>x</script>` never appear unescaped in `String(plugin.glance(out, h))` or in the stringified findings. Assert `&lt;script&gt;` appears wherever the text is shown.
  - **Every finding:** `category === 'international'`, and `evidence.method` is in `['detector', 'script']`.
  - **No bad values:** `JSON.stringify(out)` contains no `NaN`, `Infinity` or `undefined`.
  - **Performance:** 200 blocks and 300 attrs with a synchronous-resolving fake detector finish `run()` in under 50 ms.

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --test test/language.test.mjs`
Expected: the new tests fail because the plugin module is not found.

- [ ] **Step 3: Implement** `extension/plugins/language.js` (metadata, `collectArgs`, `run`, `glance`) and register it in `index.js`. For the glance, follow the structure of `extension/plugins/international.js`'s `glance` (`h.html`, `h.checklist`).

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test test/language.test.mjs`, then `npm test`.
Expected: all pass. Some tests check the full plugin list or the order of plugins, such as `test/views-patch.test.mjs` and the plugin-list tests. If any of them now fail because `language` is new, update them and list each one in your report.

- [ ] **Step 5: Commit**

`git add extension/plugins/language.js extension/plugins/index.js test/language.test.mjs` (plus any updated list tests), then `git commit -m "Language & text plugin: declared vs detected language, untagged passages, attribute text, encoding, garbled text, formats"`, with the trailer.

---

### Task 3: Page collection, detector wiring and e2e

**Files:**
- Modify: `extension/plugins/language.js` (add `collect(args)`)
- Modify: `extension/browser/capture.js` (the `runPlugins` call for `phases: ['page']`, around line 1707: add `detectLanguage: chromeDetector()`, imported from `../core/language.js`)
- Modify: `test/e2e/site/index.html` (fixture additions)
- Modify: `test/e2e/run.mjs` (assertions next to the existing `international` checks, around line 496)

**Interfaces:**
- **Consumes:** `PATTERNS` (received as `args.patterns`), `chromeDetector()`, and the plugin from Task 2.
- **Produces:** `collect({ patterns }) → collected`, in the exact shape of spec §1.1.
  - It must be self-contained: no imports, and no references outside the function, because `evaluate()` serialises it.
  - It compiles `new RegExp(p.source, p.flags)` from `args.patterns`.
  - **Rules:**
    - walk visible text with the skip list in spec §1.1;
    - assign effective language as `closest('[lang]')`, else `<html lang>`, else `''`;
    - collect blocks, attrs and text images as in the spec;
    - keep formats counted outside `<time datetime>`;
    - give mojibake and replacement examples about 20 characters of context;
    - stop at 20,000 text nodes or 1.5 s and set `truncated`;
    - build a short selector: tag, plus `#id` or the first class, plus `:nth-of-type` when needed.

- [ ] **Step 1: Add the fixture content and e2e assertions first**
  - **Fixture** (`test/e2e/site/index.html`), placed with the other content near the Arabic paragraph:
    - a German paragraph with no `lang`, about 200 characters (for example a short paragraph about hiking boots);
    - an `<img src="/img/hero.svg" alt="Una mochila roja para caminar por la montaña" width="60" height="20">`;
    - a `<p>` containing `cafÃ© con leche` three times;
    - a `<p>` with three ambiguous dates, such as `03/04/2025`, `05/06/2025` and `07/08/2025`.
  - **E2E assertions** (`run.mjs`, after the international assertions):
    - `p.language?.status === 'ok'`;
    - `p.language.data.method === 'detector'`, so the Chrome detector is wired in the real extension;
    - a finding title matches `/passages? in German ha(s|ve) no lang attribute|but its text is mostly German/`;
    - one title matches `/garbled characters such as "/`;
    - one title is exactly `Dates, times or prices are written in one region's format`;
    - **no** title matches `/lang="ar" is on text/` (Review Focus 2).
  - **Side effects:** the new content may change other e2e expectations on the fixture, such as text or clipping counts and the long-text finding. Keep their intent, adjust any counts that legitimately change, and list each one in the report.

- [ ] **Step 2: Run the e2e and see it fail**

Run: `npm run test:e2e`
Expected: it fails at `p.language` having no `collect`, and no data.

- [ ] **Step 3: Implement** `collect(args)` in `extension/plugins/language.js`, and pass `detectLanguage: chromeDetector()` in `capture.js`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npm test`, then `npm run test:e2e` three times.
Expected: green each time.
- If headless Chrome lacks `chrome.i18n.detectLanguage` in the service worker, so `method` is `'script'`, stop and report NEEDS_CONTEXT with what you saw. Do not weaken the assertion.
- Read the screenshot of the International area pane and describe the new "Language and text" card in your report. If no shot shows it, add one named `reading-international.png`.

- [ ] **Step 5: Commit**

`git add extension/plugins/language.js extension/browser/capture.js test/e2e/site/index.html test/e2e/run.mjs`, then `git commit -m "Language & text: collect page text, wire Chrome's language detector, e2e on the fixture"`, with the trailer.

---

## Self-review notes

- **Spec coverage:**

  | Spec section | Task |
  |---|---|
  | §1.2 helpers and detector | Task 1 |
  | §1.2 counted rule | Task 2 |
  | §1.3, §2, §3, error handling | Task 2 |
  | §1.1 collection | Task 3 |
  | Unit tests | Tasks 1 and 2 |
  | E2E | Task 3 |

  - The rulings above replace the spec's "each runPlugins call site" with `capture.js` only.
  - The plan explains how patterns are shared.
- **Names:** `PATTERNS`, `countMatches`, `scriptOf`, `SCRIPT_OF_LANG`, `primary`, `sameLanguage`, `normCharset`, `languageName`, `chromeDetector` and `ctx.detectLanguage` are defined in Task 1. Tasks 2 and 3 use them unchanged.
