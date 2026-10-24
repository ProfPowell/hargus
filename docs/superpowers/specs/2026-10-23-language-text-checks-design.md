# Language & text checks

**Status:** approved design (brainstorm 2026-10-23).

**Follow-up already agreed:** a spike on Chrome's on-device Translator API, to replace pseudo-localisation with a real translated view.

## Why

Today the International area checks two things:
- **Layout under stress:** a long-text (pseudo) view and a right-to-left view.
- **Syntax:** a valid `lang` tag, `hreflang` codes, `dir` on Hebrew or Arabic text, and logical CSS.

It never asks whether:
- the declared language is the language of the text;
- the encoding is consistent;
- the text survives translation (untagged passages, untranslated attributes, hard-coded formats, garbled characters).

Every finding is medium or low, so the area can lose at most 45 points.

**Goal:** an honest readiness verdict for any page, single-language sites first. Checks for multilingual wiring and locale runs are out of scope here.

## Decisions (from the brainstorm)

- **Check families included:**
  - language truth;
  - encoding and text integrity;
  - translatability.
  - Excluded: locale runs, meaning re-running the page under another Accept-Language, locale or timezone, plus `hreflang` reachability.
- **Structure:** a new page-phase plugin, approach A. The existing `international` plugin stays the layout stress test.
- **Detection:** `chrome.i18n.detectLanguage`, passed in through `env`. Where it is unavailable, a writing-system fallback is used.
- **Missing `<html lang>`:** reported in International too. Accessibility keeps its own finding.
- **Mojibake:** high severity.

## Global constraints

- **No new runtime dependency and no new manifest permission.** `chrome.i18n` needs none.
- **Collection is bounded:** at most 20,000 text nodes or 1.5 s, matching the right-to-left scan in `capture.js`. No network requests.
- **Untrusted page text stays escaped** through `html` in every finding, evidence item and glance.
- **No `NaN`, `undefined` or `Infinity` in output.**
- **Works without the detector** (Node CLI and unit tests). Findings say which method decided them.

## 1. The plugin

`extension/plugins/language.js` has these properties:

| Property | Value |
|---|---|
| `id` | `language` |
| `name` | `Language & text` |
| `phase` | `page` |
| `world` | `isolated` |
| `area` | `international` |
| `group` | `other` |
| `tags` | `['i18n']` |

It is registered in `extension/plugins/index.js` next to `international`. All of its findings use `category: 'international'`.

### 1.1 `collect()`, in the page

It walks visible text under `<body>`.
- **Skips:** `script`, `style`, `noscript`, `template`, `code`, `pre`, `kbd`, `samp`, `textarea` and `svg`, plus anything that has `hidden`, `aria-hidden="true"` or `translate="no"`, or that is not rendered (`checkVisibility()` where available).
- **Effective language** of a text node: the nearest ancestor `lang`, else `<html lang>`, else `''`.

It returns:

**Text samples**
- **`regions`:** one entry per effective language, as `{ lang, chars, sample }`. `sample` holds up to 4,000 characters of the language's text, with whitespace collapsed.
- **`blocks`:** up to 200 entries of `{ sel, lang, text }`.
  - Taken from `p`, `li`, `h1`–`h6`, `td`, `th`, `blockquote`, `figcaption`, `label`, `button`, `dd` and `dt` elements whose own visible text is at least 60 characters.
  - `text` is capped at 400 characters, and `sel` is a short CSS selector.
  - Every element carrying a `lang` attribute that differs from `<html lang>` is included, whatever its length.
- **`attrs`:** up to 300 entries of `{ sel, name, lang, text }`, for `alt`, `title`, `aria-label`, `placeholder`, and `value` on `input[type=submit|button|reset]`. Values of at least 2 words only.

**Formats.** `formats` is `{ dates, times, money }`. Each is `{ count, examples: string[≤10] }`, counting only matches outside `<time datetime>`.
- **`dates`:** numeric dates of the form `\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b`, counted only when both of the first two parts are ≤ 12, so the date is ambiguous.
- **`times`:** 12-hour times, `\b\d{1,2}:\d{2}\s?(am|pm|a\.m\.|p\.m\.)`, matched case-insensitively.
- **`money`:** a currency symbol next to a number: `[$€£¥₹]\s?\d` or `\d\s?[$€£¥₹]`.

**Text integrity**
- **`mojibake`:** `{ count, examples ≤5 }` for matches of `Ã[\u0080-¿]`, `â€[\u0080-¿™œ"“”–—˜]` and `Â[ -¿]`. Each example is about 20 characters of context.
- **`replacement`:** `{ count, examples ≤5 }` for U+FFFD.

**Declarations**
- **`metaCharset`:** from `meta[charset]`, or from the `http-equiv=content-type` meta's `charset=`, else `null`.
- **`docCharset`:** `document.characterSet`.
- **`htmlLang`:** the raw `<html lang>` value, or `null`.

**Images.** `textImages` holds up to 10 entries of `{ sel, alt }`, for `img` elements displayed at least 200×60 px whose `alt` has 6 or more words.

**Bookkeeping.** `truncated: boolean`, which is `true` when a budget was hit.

### 1.2 Detection

- **`ctx.detectLanguage(text) → Promise<{ code, share, reliable } | null>`:**
  - It comes from a new optional `env.detectLanguage` in `plugin-host.js`, alongside `whois` and `cache`.
  - In the extension it wraps `chrome.i18n.detectLanguage`. Each call site of `runPlugins` (`capture.js`, `ui/reading.js` and `ui/library.js`) sets it up the same way, through one shared helper.
  - `code` is the top language's primary subtag, `share` is its percentage divided by 100, and `reliable` is Chrome's `isReliable`.
- **Fallback when the detector is missing or throws:** `scriptOf(text) → { script, share }` counts letters by Unicode script.
  - Scripts: Latin, Cyrillic, Greek, Arabic, Hebrew, Han, Hiragana/Katakana, Hangul, Devanagari, Thai and others.
  - `SCRIPT_OF_LANG` maps about 40 primary subtags to their expected scripts, for example `ru → Cyrillic` and `ja → Han, Hiragana or Katakana`.
  - A mismatch is reported only when the dominant script holds ≥ 80% of the letters and is not among the declared language's scripts.
  - The fallback cannot distinguish languages that share a script, so those findings never fire under it.
- **A detection counts only when** `reliable` is true, the text has at least 200 characters (60 for one block), and `share` is ≥ 0.6. Otherwise there is no finding.
- **Comparison** uses primary subtags in lower case, so `en-GB` equals `en`. `zh-Hant` and `zh-Hans` both compare as `zh`.
- **Labelling:** language names come from `Intl.DisplayNames(['en'], { type: 'language' })`. If that fails, the code is shown.
- **Recorded method:** every finding's `evidence` includes `method: 'detector' | 'script'`.

### 1.3 HAR inputs

The main document is the first `document` entry whose URL equals `target.finalUrl` or `target.url`; failing that, the first `document` entry. From its response headers:
- **`headerCharset`:** the `charset=` parameter of `Content-Type`, lower-cased.
- **`contentLanguage`:** the `Content-Language` header value.

## 2. Findings

In the wording below:
- **Declared** means `<html lang>`.
- **Primary** means the primary subtag.
- **Name** means the display name.

| # | Title (exact wording) | Condition | Severity |
|---|---|---|---|
| L1 | `The page doesn't say which language it is in` | `htmlLang` is null or empty | medium |
| L2 | `Page says lang="${declared}" but its text is mostly ${Name} (${pct}%)` | The whole-page sample of the declared region gives a counted detection whose primary differs from declared. Under the fallback: a script mismatch, worded `…but its text is mostly ${Script} script`. | high |
| L3 | `${n} passage${s} in ${Name} ${have\|has} no lang attribute` | Blocks whose own `lang` is unset and whose counted detection differs from their effective language, grouped by detected language. Detail lists up to 5 selectors. | medium if n ≥ 3 or those blocks hold ≥ 15% of the page's text, else low |
| L4 | `lang="${x}" is on text that reads as ${Name}` | Blocks with their own `lang` whose counted detection differs from that `lang`. One finding per value of `x`. | medium |
| L5 | `${n} ${alt/label} text${s} ${are\|is} in ${Name} on a ${DeclaredName} page` | Attribute texts are detected as one batch per attribute group: alt; label (`aria-label`, `title`, `placeholder`, `value`). Fires when the concatenated text of at least 3 entries gives a counted detection unlike declared. | medium |
| L6 | `Content-Language says "${cl}" but the page says lang="${declared}"` | Both present, and the primaries differ. A comma-separated `Content-Language` passes if any of its entries matches. | low |
| L7 | `Character encoding is declared inconsistently` | Any two of `headerCharset`, `metaCharset` and `docCharset` differ after normalisation, for example `utf8 = utf-8`. Detail names each value. | medium |
| L8 | `No character encoding is declared` | `headerCharset` and `metaCharset` are both null | low |
| L9 | `Text shows garbled characters such as "${example}"` | `mojibake.count ≥ 3` | high |
| L10 | `${n} replacement characters (�) appear in the text` | `replacement.count ≥ 3` | medium |
| L11 | `Dates, times or prices are written in one region's format` | `dates.count + times.count + money.count ≥ 3`. Detail gives each count and up to 3 examples of each. | low |
| L12 | `${n} large image${s} may contain text that can't be translated` | `textImages.length ≥ 1`. Detail: "If the words are part of the image, translators can't reach them." | info |
| — | `Text sampling stopped early` | `truncated` is true | info |

**Score effect.** The existing caps apply: high 60, medium 30, low 15. The area can now lose up to 105 points, where today it can lose 45. No scoring changes are needed.

## 3. Summary and glance

**Summary rows**
- `Language`: the declared tag and the detected name, for example `en · English 96%`, with a rating of good or poor.
- `Encoding`: for example `UTF-8`, rated poor when L7 or L9 fires.
- `Formats`: the count from L11.

**Glance:** a checklist card headed "Language and text", with these items:
- Declared language matches the text
- No untagged passages in other languages
- Labels and alt text in the page language
- Encoding declared and consistent
- No garbled characters
- Dates and prices in a neutral format

Each item appears only when its data exists. Items take a `note` with counts.

## Error handling

- **No `<body>`, or no text:** `ctx.skip('No visible text to check')`.
- **Detector errors:** caught per call, falling back to `scriptOf`.
- **HAR without a document entry:** L6, L7 and L8 use only the page-side values. L8 is not reported, because a missing header can't be told apart from a missing entry.

## Testing

### Unit (`test/language.test.mjs`)

These call `run()` directly, with fake `collected` data and a fake `detectLanguage`.
- **L1–L12** each fire at their threshold and stay quiet just below it.
- **L2 under the fallback:** a Cyrillic sample on `lang="en"` fires L2. A French sample on `lang="en"` does not.
- **Low-confidence detections:** unreliable, too short, or a share below 0.6 give no finding.
- **Subtag comparison:** `en-GB` against `en` gives no finding, and `zh-Hant` against `zh` gives none.
- **Charset normalisation:** `utf8` against `UTF-8` gives no L7.
- **Wording:** singular and plural forms are both checked.
- **Escaping:** untrusted text in titles, evidence and glance stays escaped, checked with a `<script>` sample.
- **No input:** the plugin skips cleanly.
- **Performance:** with 200 blocks and 300 attributes and the fake detector, `run()` finishes in under 50 ms.

### Collector (`test/language.test.mjs`, JSDOM-free)

The format, mojibake and replacement-character regexes are exported as pure helpers and tested on strings:
- `03/04/2025` counts as a date; `13/04/2025` does not.
- `3:00 PM` counts as a time.
- `€12` and `12 €` both count as money.
- `cafÃ©` and `â€™` count as mojibake.

### E2E (`test/e2e/run.mjs` and the fixture site)

The fixture `test/e2e/site/index.html` gains:
- a German paragraph of about 200 characters with no `lang`;
- an `alt` text in Spanish;
- one mojibake string (`cafÃ© con leche` ×3);
- three ambiguous dates.

After a reading, these findings are present:
- `passage in German has no lang attribute`, or L2 if detection treats the whole page differently. Match L3 by regex.
- `garbled characters`.
- `region's format`.

The existing Arabic `<p lang="ar">` must **not** produce L4.

## Out of scope

- Locale runs (Accept-Language, browser locale, timezone).
- `hreflang` reachability and reciprocity.
- Translation views. These come next, after the Translator API spike.
- Font glyph coverage.
- Text inside images, beyond the alt-text hint.
